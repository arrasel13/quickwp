//! A minimal FastCGI client.
//!
//! This is not test scaffolding: it is how QuickWP answers "is this pool
//! actually serving?" without standing up a web server. A pool that is running
//! and a pool that is serving are different facts, and reporting the first as
//! the second is the kind of lie that makes a status light worthless.
//!
//! Implements just enough of the FastCGI 1.0 record protocol to run one
//! responder request: BEGIN_REQUEST, PARAMS, STDIN, then read STDOUT/STDERR
//! until END_REQUEST.

use crate::{Error, Result};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const FCGI_VERSION: u8 = 1;
const BEGIN_REQUEST: u8 = 1;
const END_REQUEST: u8 = 3;
const PARAMS: u8 = 4;
const STDIN: u8 = 5;
const STDOUT: u8 = 6;
const STDERR: u8 = 7;
const RESPONDER: u8 = 1;

#[derive(Debug)]
pub struct FcgiResponse {
    pub stdout: String,
    pub stderr: String,
}

impl FcgiResponse {
    /// The body after the CGI headers.
    pub fn body(&self) -> &str {
        match self.stdout.find("\r\n\r\n") {
            Some(i) => &self.stdout[i + 4..],
            None => match self.stdout.find("\n\n") {
                Some(i) => &self.stdout[i + 2..],
                None => &self.stdout,
            },
        }
    }
}

fn record(kind: u8, req_id: u16, content: &[u8]) -> Vec<u8> {
    let len = content.len();
    let mut v = Vec::with_capacity(8 + len);
    v.push(FCGI_VERSION);
    v.push(kind);
    v.extend_from_slice(&req_id.to_be_bytes());
    v.extend_from_slice(&(len as u16).to_be_bytes());
    v.push(0); // padding length
    v.push(0); // reserved
    v.extend_from_slice(content);
    v
}

fn name_value(k: &str, val: &str) -> Vec<u8> {
    let mut v = Vec::new();
    for len in [k.len(), val.len()] {
        if len < 128 {
            v.push(len as u8);
        } else {
            v.extend_from_slice(&((len as u32) | 0x8000_0000).to_be_bytes());
        }
    }
    v.extend_from_slice(k.as_bytes());
    v.extend_from_slice(val.as_bytes());
    v
}

/// Run one FastCGI responder request against a php-fpm pool.
pub fn request(addr: &str, params: &[(&str, &str)], body: &[u8]) -> Result<FcgiResponse> {
    let mut sock = TcpStream::connect(addr).map_err(|e| Error::Io {
        path: addr.into(),
        source: e,
    })?;
    sock.set_read_timeout(Some(Duration::from_secs(10))).ok();
    sock.set_write_timeout(Some(Duration::from_secs(10))).ok();

    let id: u16 = 1;

    // BEGIN_REQUEST: role responder, no keep-alive.
    let mut begin = Vec::new();
    begin.extend_from_slice(&(RESPONDER as u16).to_be_bytes());
    begin.push(0);
    begin.extend_from_slice(&[0u8; 5]);
    let mut out = record(BEGIN_REQUEST, id, &begin);

    let mut p = Vec::new();
    for (k, v) in params {
        p.extend_from_slice(&name_value(k, v));
    }
    out.extend_from_slice(&record(PARAMS, id, &p));
    out.extend_from_slice(&record(PARAMS, id, &[])); // end of params

    if !body.is_empty() {
        out.extend_from_slice(&record(STDIN, id, body));
    }
    out.extend_from_slice(&record(STDIN, id, &[])); // end of stdin

    sock.write_all(&out).map_err(|e| Error::Io {
        path: addr.into(),
        source: e,
    })?;
    sock.flush().ok();

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut header = [0u8; 8];

    loop {
        if sock.read_exact(&mut header).is_err() {
            break;
        }
        let kind = header[1];
        let content_len = u16::from_be_bytes([header[4], header[5]]) as usize;
        let padding = header[6] as usize;

        let mut content = vec![0u8; content_len];
        if content_len > 0 && sock.read_exact(&mut content).is_err() {
            break;
        }
        if padding > 0 {
            let mut pad = vec![0u8; padding];
            let _ = sock.read_exact(&mut pad);
        }

        match kind {
            STDOUT => stdout.extend_from_slice(&content),
            STDERR => stderr.extend_from_slice(&content),
            END_REQUEST => break,
            _ => {}
        }
    }

    Ok(FcgiResponse {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Execute a PHP script through a pool and return its output.
pub fn run_script(port: u16, script: &std::path::Path) -> Result<FcgiResponse> {
    let s = script.to_string_lossy().to_string();
    request(
        &format!("127.0.0.1:{port}"),
        &[
            ("GATEWAY_INTERFACE", "FastCGI/1.0"),
            ("REQUEST_METHOD", "GET"),
            ("SCRIPT_FILENAME", &s),
            ("SCRIPT_NAME", "/index.php"),
            ("REQUEST_URI", "/"),
            ("DOCUMENT_ROOT", script.parent().unwrap().to_str().unwrap_or("/")),
            ("SERVER_PROTOCOL", "HTTP/1.1"),
            ("SERVER_SOFTWARE", "QuickWP"),
            ("REMOTE_ADDR", "127.0.0.1"),
            ("CONTENT_LENGTH", "0"),
        ],
        &[],
    )
}
