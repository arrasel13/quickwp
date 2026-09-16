//! Does the HTTPS edge on 443 actually serve a site?
//!
//! `https_ready` says Nexora's HTTPS pieces are installed, not who holds the
//! port. Another local tool's server can sit on 443 with no certificate for a
//! name Nexora made -- rexenv's Caddy does -- and every https link to the site
//! then dies in its handshake. In a browser that is an error page; in the app's
//! preview it is a blank pane. A real handshake with the site's name, checked
//! against Nexora's own CA, is the only answer that cannot be wrong that way.

use std::io;
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;

use crate::ca;

/// True when 127.0.0.1:443 completes a TLS handshake for `host` with a
/// certificate Nexora issued. Answers within a couple of seconds either way.
pub fn https_serves(host: &str) -> bool {
    handshake(host).is_ok()
}

fn handshake(host: &str) -> io::Result<()> {
    let other = |e: &dyn std::fmt::Display| io::Error::new(io::ErrorKind::Other, e.to_string());

    let mut roots = rustls::RootCertStore::empty();
    let pem = std::fs::read(ca::ca_cert_path())?;
    for cert in rustls_pemfile::certs(&mut pem.as_slice()) {
        roots.add(cert?).map_err(|e| other(&e))?;
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| other(&e))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_string()).map_err(|e| other(&e))?;
    let mut conn = rustls::ClientConnection::new(Arc::new(config), name).map_err(|e| other(&e))?;

    let addr = SocketAddr::from(([127, 0, 0, 1], 443));
    let mut sock = TcpStream::connect_timeout(&addr, Duration::from_millis(600))?;
    sock.set_read_timeout(Some(Duration::from_millis(1500)))?;
    sock.set_write_timeout(Some(Duration::from_millis(1500)))?;
    while conn.is_handshaking() {
        conn.complete_io(&mut sock)?;
    }
    Ok(())
}
