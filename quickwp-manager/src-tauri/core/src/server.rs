//! The edge: a hostname-routing HTTP server that speaks FastCGI to PHP pools.
//!
//! QuickWP serves sites itself rather than downloading nginx and Caddy and
//! generating config for both. That removes two pinned binaries, two config
//! generators and the class of bug where a site is in the database but missing
//! from a server block.
//!
//! Routing is by Host header, and every name QuickWP knows answers for itself:
//! a stopped site returns its own 503 page rather than falling through to
//! whichever site happens to be first. Falling through is how a stopped site
//! ends up serving a neighbour's content.

use crate::{db::Db, fastcgi, ports, site, Result};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

    let Some(site) = site::find(&db, &host).ok().flatten() else {
        return respond(&mut stream, 404, "text/html; charset=utf-8", &unknown_host(&host));
    };

    if !site.enabled {
        // The site names itself, never the address the request arrived on, so a
        // stopped site reached through a tunnel does not offer a command that
        // only works locally.
        return respond(&mut stream, 503, "text/html; charset=utf-8", &stopped_page(&site));
    }

    let Ok(pool_port) = ports::fpm_port(&site.php_minor) else {
        return respond(&mut stream, 500, "text/plain", "bad PHP version on this site");
    };

    // Static files are served directly; everything else goes to PHP.
    let docroot = std::path::PathBuf::from(&site.docroot);
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
                site.docroot
            ),
        );
    }

    let script_s = script.to_string_lossy().to_string();
    let docroot_s = site.docroot.clone();
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
        ("SERVER_SOFTWARE", "QuickWP"),
        ("REMOTE_ADDR", "127.0.0.1"),
        ("SERVER_NAME", &host),
        ("CONTENT_LENGTH", &cl),
        ("HTTPS", ""),
    ];
    if !content_type.is_empty() {
        params.push(("CONTENT_TYPE", &content_type));
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
            // php-fpm returns CGI headers then the body; pass both through.
            let raw = if resp.stdout.contains("\r\n\r\n") || resp.stdout.contains("\n\n") {
                format!("HTTP/1.1 200 OK\r\nConnection: close\r\n{}", resp.stdout.replacen('\n', "\r\n", 0))
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/html\r\n\r\n{}",
                    resp.stdout
                )
            };
            stream.write_all(raw.as_bytes())?;
            stream.flush()
        }
        Err(e) => respond(
            &mut stream,
            502,
            "text/html; charset=utf-8",
            &format!(
                "<h1>502</h1><p>The PHP {} pool did not answer.</p><pre>{}</pre>\
                 <p>Start it from the PHP tab.</p>",
                site.php_minor, e
            ),
        ),
    }
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
<p>Nothing is broken. You stopped <strong>{name}</strong> in QuickWP, so it is served by
nothing — every other site on this machine is still running.</p>
<p>Start it again from the Sites tab, or run <code>quickwp site start {domain}</code>.</p>"#,
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
<p>QuickWP has no site with that hostname. Create one in the Sites tab.</p>"#,
        host = html_escape(host)
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
