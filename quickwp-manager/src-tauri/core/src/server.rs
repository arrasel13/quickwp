//! The edge: a hostname-routing HTTP server that speaks FastCGI to PHP pools.
//!
//! Nexora serves sites itself rather than downloading nginx and Caddy and
//! generating config for both. That removes two pinned binaries, two config
//! generators and the class of bug where a site is in the database but missing
//! from a server block.
//!
//! Routing is by Host header, and every name Nexora knows answers for itself:
//! a stopped site returns its own 503 page rather than falling through to
//! whichever site happens to be first. Falling through is how a stopped site
//! ends up serving a neighbour's content.

use crate::{adminer, db::Db, fastcgi, ports, site, Result};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What a request resolves to: a docroot, a pool, and -- for a real site --
/// the row whose environment variables belong on the request.
struct Target {
    docroot: std::path::PathBuf,
    php_minor: String,
    site_id: Option<i64>,
}

pub struct Edge {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Edge {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unblock the accept loop.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

/// Start the edge on `port`. Returns once it is accepting.
pub fn start(db: Db, port: u16) -> Result<Edge> {
    ports::gate(port)?;
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| crate::Error::Io {
        path: format!("127.0.0.1:{port}").into(),
        source: e,
    })?;
    crate::log::info("edge", &format!("web server listening on 127.0.0.1:{port}"));

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop_thread.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = conn else { continue };
            let db = db.clone();
            std::thread::spawn(move || {
                let _ = handle(db, stream);
            });
        }
    });

    Ok(Edge { port, stop })
}

fn handle(db: Db, mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(15)))?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut host = String::new();
    let mut content_length = 0usize;
    let mut content_type = String::new();
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let (k, v) = (k.trim(), v.trim());
            match k.to_ascii_lowercase().as_str() {
                "host" => host = v.split(':').next().unwrap_or(v).to_string(),
                "content-length" => content_length = v.parse().unwrap_or(0),
                "content-type" => content_type = v.to_string(),
                _ => {}
            }
            headers.push((k.to_string(), v.to_string()));
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };

    // Adminer answers on its own hostname, resolved ahead of the site lookup.
    // It is not a site: it has no record, no docroot under the sites directory
    // and no place in the sites list -- so it cannot be found by `site::find`,
    // and must not be shadowed by a site that happens to share the name.
    let adminer_host = db.tld().map(|t| adminer::host(&t)).unwrap_or_default();
    let route = if !adminer_host.is_empty() && host.eq_ignore_ascii_case(&adminer_host) {
        match adminer::target(&db) {
            Ok(t) => Target {
                docroot: t.docroot,
                php_minor: t.php_minor,
                site_id: None,
            },
            Err(_) => {
                return respond(
                    &mut stream,
                    503,
                    "text/html; charset=utf-8",
                    "<h1>503</h1><p>The database browser is not installed yet. \
                     Open a site's Database tab once and Nexora will fetch it.</p>",
                )
            }
        }
    } else {
        let Some(site) = site::find(&db, &host).ok().flatten() else {
            return respond(&mut stream, 404, "text/html; charset=utf-8", &unknown_host(&host));
        };

        if !site.enabled {
            // The site names itself, never the address the request arrived on, so a
            // stopped site reached through a tunnel does not offer a command that
            // only works locally.
            return respond(&mut stream, 503, "text/html; charset=utf-8", &stopped_page(&site));
        }

        Target {
            docroot: std::path::PathBuf::from(&site.docroot),
            php_minor: site.php_minor,
            site_id: Some(site.id),
        }
    };

    let Ok(pool_port) = ports::fpm_port(&route.php_minor) else {
        return respond(&mut stream, 500, "text/plain", "bad PHP version on this site");
    };

    // Static files are served directly; everything else goes to PHP.
    let docroot = route.docroot.clone();
    let rel = path.trim_start_matches('/');
    let candidate = docroot.join(rel);
    if !rel.is_empty() && candidate.is_file() && candidate.extension().map(|e| e != "php").unwrap_or(true) {
        let data = std::fs::read(&candidate)?;
        let ct = mime_for(&candidate);
        return respond_bytes(&mut stream, 200, ct, &data);
    }

    let script = if candidate.is_file() && candidate.extension().map(|e| e == "php").unwrap_or(false) {
        candidate
    } else {
        docroot.join("index.php")
    };

    if !script.is_file() {
        return respond(
            &mut stream,
            404,
            "text/html; charset=utf-8",
            &format!(
                "<h1>404</h1><p>No <code>index.php</code> in <code>{}</code>.</p>",
                docroot.display()
            ),
        );
    }

    // The edge terminates TLS and forwards plaintext, so the only evidence a
    // request arrived over HTTPS is the header it sets. Without translating
    // that into the CGI variable PHP actually reads, WordPress calls is_ssl()
    // false and redirects /wp-admin to http:// -- dropping TLS on every admin
    // request, and breaking the login cookie with it.
    let via_tls = headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("x-forwarded-proto") && v.eq_ignore_ascii_case("https")
    });
    let server_port = if via_tls {
        "443".to_string()
    } else {
        ports::NGINX.to_string()
    };

    let script_s = script.to_string_lossy().to_string();
    let docroot_s = docroot.to_string_lossy().to_string();
    let cl = content_length.to_string();
    let mut params: Vec<(&str, &str)> = vec![
        ("GATEWAY_INTERFACE", "FastCGI/1.0"),
        ("REQUEST_METHOD", &method),
        ("SCRIPT_FILENAME", &script_s),
        ("SCRIPT_NAME", &path),
        ("REQUEST_URI", &target),
        ("QUERY_STRING", &query),
        ("DOCUMENT_ROOT", &docroot_s),
        ("SERVER_PROTOCOL", "HTTP/1.1"),
        ("SERVER_SOFTWARE", "Nexora"),
        ("REMOTE_ADDR", "127.0.0.1"),
        ("SERVER_NAME", &host),
        ("SERVER_PORT", &server_port),
        ("CONTENT_LENGTH", &cl),
    ];
    if via_tls {
        // PHP treats any non-empty, non-"off" value as on. WordPress reads it
        // through is_ssl().
        params.push(("HTTPS", "on"));
        params.push(("REQUEST_SCHEME", "https"));
    } else {
        params.push(("REQUEST_SCHEME", "http"));
    }
    if !content_type.is_empty() {
        params.push(("CONTENT_TYPE", &content_type));
    }

    // Per-site environment variables.
    //
    // Sent as FastCGI params rather than set on the pool: the pools are shared
    // between sites, so a variable set on one would leak into every other. As
    // params they reach PHP through $_SERVER and getenv() for this request
    // only, and the pool stays untouched.
    let site_env = match route.site_id {
        Some(id) => db.site_env(id).unwrap_or_default(),
        None => Vec::new(),
    };
    for (k, v) in &site_env {
        params.push((k.as_str(), v.as_str()));
    }
    // Forward request headers as HTTP_* so WordPress sees them.
    let forwarded: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| {
            (
                format!("HTTP_{}", k.to_uppercase().replace('-', "_")),
                v.clone(),
            )
        })
        .collect();
    for (k, v) in &forwarded {
        params.push((k.as_str(), v.as_str()));
    }

    match fastcgi::request(&format!("127.0.0.1:{pool_port}"), &params, &body) {
        Ok(resp) => {
            let raw = cgi_to_http(&resp.stdout);
            stream.write_all(&raw)?;
            stream.flush()
        }
        Err(e) => respond(
            &mut stream,
            502,
            "text/html; charset=utf-8",
            &format!(
                "<h1>502</h1><p>The PHP {} pool did not answer.</p><pre>{}</pre>\
                 <p>Start it from the PHP tab.</p>",
                route.php_minor, e
            ),
        ),
    }
}

/// Turn a CGI response into a well-formed HTTP/1.1 one.
///
/// php-fpm terminates its headers with bare LF. Emitting a CRLF status line and
/// then passing those through unchanged produces a response with mixed line
/// endings: curl and browsers tolerate it, but a strict intermediary does not --
/// a Cloudflare tunnel returned an empty body for exactly this, while the same
/// page was fine locally. So every header is normalised to CRLF here, and the
/// CGI `Status:` header becomes the status line rather than being sent on as a
/// header nobody reads.
///
/// Bytes in, bytes out. Only the header block is text; the body goes through
/// untouched. Read as a string, every byte that is not UTF-8 became U+FFFD --
/// so a gzipped page (Adminer compresses whenever the browser accepts gzip, as
/// every browser does), an image or a download served through PHP arrived
/// corrupt, and the browser showed nothing.
fn cgi_to_http(stdout: &[u8]) -> Vec<u8> {
    let find = |needle: &[u8]| stdout.windows(needle.len()).position(|w| w == needle);
    let (head, body) = match find(b"\r\n\r\n") {
        Some(i) => (&stdout[..i], &stdout[i + 4..]),
        None => match find(b"\n\n") {
            Some(i) => (&stdout[..i], &stdout[i + 2..]),
            // No header block at all: treat the whole thing as a body rather
            // than sending headerless bytes and letting the client guess.
            None => (&stdout[..0], stdout),
        },
    };
    let head = String::from_utf8_lossy(head);

    let mut status = "200 OK".to_string();
    let mut headers: Vec<String> = Vec::new();
    let mut has_type = false;

    for line in head.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let (name, value) = (name.trim(), value.trim());
        if name.eq_ignore_ascii_case("Status") {
            status = value.to_string();
            continue;
        }
        if name.eq_ignore_ascii_case("Content-Type") {
            has_type = true;
        }
        // Never forward a length or a connection header from PHP: we set both
        // ourselves, and a stale Content-Length truncates the response.
        if name.eq_ignore_ascii_case("Content-Length")
            || name.eq_ignore_ascii_case("Connection")
            || name.eq_ignore_ascii_case("Transfer-Encoding")
        {
            continue;
        }
        headers.push(format!("{name}: {value}"));
    }

    if !has_type {
        headers.push("Content-Type: text/html; charset=UTF-8".into());
    }
    headers.push(format!("Content-Length: {}", body.len()));
    headers.push("Connection: close".into());

    let mut out = format!("HTTP/1.1 {status}\r\n{}\r\n\r\n", headers.join("\r\n")).into_bytes();
    out.extend_from_slice(body);
    out
}

fn mime_for(p: &std::path::Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "html" | "htm" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(s: &mut TcpStream, code: u16, ct: &str, body: &str) -> std::io::Result<()> {
    respond_bytes(s, code, ct, body.as_bytes())
}

fn respond_bytes(s: &mut TcpStream, code: u16, ct: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes())?;
    s.write_all(body)?;
    s.flush()
}

fn stopped_page(site: &site::Site) -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>This site is stopped</title>
<style>body{{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:38rem;margin:14vh auto;
padding:0 1.5rem;color:#1a1f27;background:#f7f8fa}}code{{background:#e9edf2;padding:1px 5px}}
@media(prefers-color-scheme:dark){{body{{color:#e7eaf0;background:#0f1217}}code{{background:#1e242e}}}}</style>
<h1>This site is stopped</h1>
<p>Nothing is broken. You stopped <strong>{name}</strong> in Nexora, so it is served by
nothing — every other site on this machine is still running.</p>
<p>Start it again from the Sites tab, or run <code>nexora site start {domain}</code>.</p>"#,
        name = html_escape(&site.name),
        domain = html_escape(&site.domain),
    )
}

fn unknown_host(host: &str) -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>No site here</title>
<style>body{{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:38rem;margin:14vh auto;
padding:0 1.5rem;color:#1a1f27;background:#f7f8fa}}code{{background:#e9edf2;padding:1px 5px}}
@media(prefers-color-scheme:dark){{body{{color:#e7eaf0;background:#0f1217}}code{{background:#1e242e}}}}</style>
<h1>No site answers on {host}</h1>
<p>Nexora has no site with that hostname. Create one in the Sites tab.</p>"#,
        host = html_escape(host)
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The header the edge sets, and the variable PHP reads, must line up.
    #[test]
    fn a_forwarded_https_header_is_recognised_case_insensitively() {
        let headers = vec![("X-Forwarded-Proto".to_string(), "https".to_string())];
        let via = headers.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("x-forwarded-proto") && v.eq_ignore_ascii_case("https")
        });
        assert!(via);

        let lower = vec![("x-forwarded-proto".to_string(), "HTTPS".to_string())];
        assert!(lower.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("x-forwarded-proto") && v.eq_ignore_ascii_case("https")
        }));

        let plain = vec![("X-Forwarded-Proto".to_string(), "http".to_string())];
        assert!(!plain.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("x-forwarded-proto") && v.eq_ignore_ascii_case("https")
        }));
    }

    #[test]
    fn lf_only_cgi_headers_become_crlf() {
        // php-fpm emits bare LF. A response mixing CRLF and LF is tolerated by
        // curl and rejected by a strict proxy -- a tunnel served an empty body
        // for exactly this.
        let out = text(cgi_to_http(b"Content-type: text/html\nX-Powered-By: PHP\n\n<h1>hi</h1>"));
        assert!(out.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(!out.trim_end().contains("\n\n"), "no bare LF may survive");
        for line in out.split("\r\n").take_while(|l| !l.is_empty()) {
            assert!(!line.contains('\n'), "header `{line}` still holds a bare LF");
        }
        assert!(out.ends_with("<h1>hi</h1>"));
        assert!(out.contains("Content-Length: 11"));
    }

    #[test]
    fn a_cgi_status_header_becomes_the_status_line() {
        let out = text(cgi_to_http(b"Status: 404 Not Found\nContent-type: text/html\n\nnope"));
        assert!(out.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(!out.contains("Status:"), "Status is a CGI header, not an HTTP one");
    }

    #[test]
    fn a_stale_content_length_from_php_is_not_forwarded() {
        // Forwarding PHP's own length truncates the body when anything else
        // has touched it.
        let out = text(cgi_to_http(b"Content-type: text/html\nContent-Length: 99999\n\nshort"));
        assert!(out.contains("Content-Length: 5"));
        assert!(!out.contains("99999"));
    }

    #[test]
    fn a_body_with_no_headers_still_gets_a_content_type() {
        let out = text(cgi_to_http(b"just bytes"));
        assert!(out.contains("Content-Type: text/html"));
        assert!(out.ends_with("just bytes"));
    }

    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).expect("a text response stays valid UTF-8")
    }

    #[test]
    fn a_binary_body_passes_through_byte_for_byte() {
        // The start of a gzip stream: 0x8b and 0xff are not UTF-8. Read as a
        // string they became U+FFFD, and a compressed page could not be read.
        let body: &[u8] = &[0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0xfe, 0x0a, 0x0a, 0x80];
        let mut stdout = b"Content-Type: text/html\r\nContent-Encoding: gzip\r\n\r\n".to_vec();
        stdout.extend_from_slice(body);
        let out = cgi_to_http(&stdout);
        assert!(out.ends_with(body), "the body must arrive exactly as PHP sent it");
        let head = String::from_utf8_lossy(&out[..out.len() - body.len()]);
        assert!(head.contains("Content-Encoding: gzip"));
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
    }
}
