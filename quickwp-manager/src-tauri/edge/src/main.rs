//! QuickWP's privileged edge.
//!
//! Runs as root for exactly one reason: on macOS only root may bind a port
//! below 1024, and `https://yoursite.test` with no port number *means* 443.
//!
//! It does the smallest job that requires that privilege and nothing else:
//!
//!   * 443 — terminate TLS with the site's certificate, forward the plaintext
//!     to QuickWP's own router on loopback.
//!   * 80  — redirect to https.
//!
//! It never talks to a database, never reaches the network, and reads nothing
//! but the certificate directory it is pointed at. Everything else in QuickWP
//! runs unprivileged.
//!
//! Usage: quickwp-edge <certs-dir> <upstream-port> [https-port] [http-port]

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::ServerConfig;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: quickwp-edge <certs-dir> <upstream-port> [https-port] [http-port]");
        std::process::exit(2);
    }
    let certs_dir = PathBuf::from(&args[1]);
    let upstream: u16 = args[2].parse().expect("upstream port");
    let https_port: u16 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(443);
    let http_port: u16 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(80);

    let _ = rustls::crypto::ring::default_provider().install_default();

    let resolver = Arc::new(SniResolver::new(certs_dir.clone()));
    resolver.reload();

    // Certificates appear when sites are created, so the set is reloaded rather
    // than read once at boot. Root never re-reads anything else.
    {
        let r = resolver.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            r.reload_if_changed();
        });
    }

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(resolver.clone());
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let config = Arc::new(config);

    // 80 -> 443, so a typed hostname without a scheme still lands on TLS.
    std::thread::spawn(move || {
        let Ok(l) = TcpListener::bind(("0.0.0.0", http_port)) else {
            eprintln!("edge: could not bind port {http_port}");
            return;
        };
        for s in l.incoming().flatten() {
            std::thread::spawn(move || redirect_to_https(s));
        }
    });

    let listener = match TcpListener::bind(("0.0.0.0", https_port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("edge: could not bind port {https_port}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("edge: listening on {https_port} (tls) and {http_port}, forwarding to 127.0.0.1:{upstream}");

    for stream in listener.incoming().flatten() {
        let config = config.clone();
        std::thread::spawn(move || {
            let _ = serve(stream, config, upstream);
        });
    }
}

fn serve(mut stream: TcpStream, config: Arc<ServerConfig>, upstream: u16) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut conn = rustls::ServerConnection::new(config)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut tls = rustls::Stream::new(&mut conn, &mut stream);

    // Forward the decrypted bytes to QuickWP's router and stream the reply back.
    let mut up = TcpStream::connect(("127.0.0.1", upstream))?;
    up.set_read_timeout(Some(Duration::from_secs(60)))?;

    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    // Read up to the end of the request head so the upstream sees a full
    // request even if the client trickles it.
    while !head.ends_with(b"\r\n\r\n") {
        match tls.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => head.push(byte[0]),
            Err(_) => break,
        }
        if head.len() > 64 * 1024 {
            break;
        }
    }
    if head.is_empty() {
        return Ok(());
    }

    // Tell the origin this arrived over TLS, so PHP sets HTTPS and WordPress
    // builds https:// URLs instead of redirecting to http and looping.
    let head = String::from_utf8_lossy(&head).replacen(
        "\r\n",
        "\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Port: 443\r\n",
        1,
    );
    up.write_all(head.as_bytes())?;

    // Body, if the client announced one.
    if let Some(len) = content_length(&head) {
        let mut remaining = len;
        let mut buf = [0u8; 8192];
        while remaining > 0 {
            let want = remaining.min(buf.len());
            match tls.read(&mut buf[..want]) {
                Ok(0) => break,
                Ok(n) => {
                    up.write_all(&buf[..n])?;
                    remaining -= n;
                }
                Err(_) => break,
            }
        }
    }
    up.flush()?;

    let mut buf = [0u8; 16384];
    loop {
        match up.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tls.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = tls.flush();
    Ok(())
}

fn content_length(head: &str) -> Option<usize> {
    head.lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
}

fn redirect_to_https(mut s: TcpStream) {
    let mut buf = [0u8; 2048];
    let n = s.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");
    let host = req
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("host:"))
        .and_then(|l| l.split(':').nth(1))
        .map(|h| h.trim().to_string())
        .unwrap_or_default();
    let body = format!(
        "HTTP/1.1 301 Moved Permanently\r\nLocation: https://{host}{path}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = s.write_all(body.as_bytes());
}

/// Picks the certificate by SNI hostname.
struct SniResolver {
    dir: PathBuf,
    certs: RwLock<HashMap<String, Arc<CertifiedKey>>>,
    stamp: RwLock<Option<SystemTime>>,
}

impl SniResolver {
    fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            certs: RwLock::new(HashMap::new()),
            stamp: RwLock::new(None),
        }
    }

    fn reload_if_changed(&self) {
        let current = std::fs::metadata(&self.dir).and_then(|m| m.modified()).ok();
        let changed = { *self.stamp.read().unwrap() != current };
        if changed {
            self.reload();
            *self.stamp.write().unwrap() = current;
        }
    }

    fn reload(&self) {
        let mut map = HashMap::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "pem").unwrap_or(true) {
                continue;
            }
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let key_path = p.with_extension("key");
            let Some(ck) = load_pair(&p, &key_path) else {
                eprintln!("edge: could not load {} (+ .key)", p.display());
                continue;
            };
            let ck = Arc::new(ck);
            map.insert(stem.to_ascii_lowercase(), ck.clone());
            // Also index every SAN, so an alias picks the same certificate.
            for name in sans_of(&p) {
                map.insert(name.to_ascii_lowercase(), ck.clone());
            }
        }
        // Worth a line: a resolver with no certificates accepts TLS
        // connections and then closes them with no bytes, which looks like a
        // network fault rather than a missing file.
        eprintln!("edge: loaded {} certificate name(s) from {}", map.len(), self.dir.display());
        *self.certs.write().unwrap() = map;
    }
}

impl std::fmt::Debug for SniResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SniResolver")
    }
}

impl ResolvesServerCert for SniResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let map = self.certs.read().ok()?;
        let name = hello.server_name()?.to_ascii_lowercase();
        if let Some(ck) = map.get(&name) {
            return Some(ck.clone());
        }
        // A wildcard leaf covers sub.network.test for a multisite network.
        let parent = name.split_once('.').map(|(_, rest)| rest.to_string())?;
        map.get(&parent).cloned()
    }
}

fn load_pair(cert: &Path, key: &Path) -> Option<CertifiedKey> {
    let cert_pem = std::fs::read(cert).ok()?;
    let key_pem = std::fs::read(key).ok()?;
    let chain: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_pem.as_slice())
        .filter_map(|c| c.ok())
        .collect();
    if chain.is_empty() {
        return None;
    }
    let k: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_pem.as_slice())
        .ok()
        .flatten()?;
    let signing = rustls::crypto::ring::sign::any_supported_type(&k).ok()?;
    Some(CertifiedKey::new(chain, signing))
}

/// Read DNS SANs out of a certificate so aliases resolve to the same key.
fn sans_of(cert: &Path) -> Vec<String> {
    // Kept dependency-free: scan the DER for the SAN extension's DNS entries is
    // more machinery than this needs, so the filename plus a wildcard parent
    // lookup covers it. Aliases are written as their own .pem by the app.
    let _ = cert;
    Vec::new()
}
