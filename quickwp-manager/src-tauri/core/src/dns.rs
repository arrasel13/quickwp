//! A minimal DNS server answering one thing: your dev TLD, at 127.0.0.1.
//!
//! This is deliberately not a general resolver. It answers A queries for
//! `*.<tld>` with the loopback address and refuses everything else, which is
//! the entire job: macOS is pointed at it by `/etc/resolver/<tld>`, and only
//! ever asks it about that TLD.
//!
//! Writing it here rather than embedding a full DNS stack keeps the dependency
//! surface small and the behaviour obvious -- there is no zone file, no cache
//! and no recursion to reason about.

use crate::{Error, Result};
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const TYPE_A: u16 = 1;
const TYPE_AAAA: u16 = 28;
const CLASS_IN: u16 = 1;
const TTL: u32 = 60;

pub struct DnsServer {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl DnsServer {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Nudge the blocking recv so the loop notices.
        if let Ok(s) = UdpSocket::bind(("127.0.0.1", 0)) {
            let _ = s.send_to(&[0u8; 12], ("127.0.0.1", self.port));
        }
    }
}

/// Start the DNS server. `tlds` is the set it answers for, without dots.
pub fn start(port: u16, tlds: Vec<String>) -> Result<DnsServer> {
    let sock = UdpSocket::bind(("127.0.0.1", port)).map_err(|e| Error::Io {
        path: format!("udp 127.0.0.1:{port}").into(),
        source: e,
    })?;
    sock.set_read_timeout(Some(std::time::Duration::from_millis(500)))
        .ok();

    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        loop {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            let (n, from) = match sock.recv_from(&mut buf) {
                Ok(v) => v,
                Err(_) => continue, // timeout: loop so the stop flag is checked
            };
            if n < 12 {
                continue;
            }
            if let Some(reply) = answer(&buf[..n], &tlds) {
                let _ = sock.send_to(&reply, from);
            }
        }
    });

    Ok(DnsServer { port, stop })
}

/// Build a response for a query, or None if it is not something we answer.
fn answer(query: &[u8], tlds: &[String]) -> Option<Vec<u8>> {
    let id = u16::from_be_bytes([query[0], query[1]]);
    let flags = u16::from_be_bytes([query[2], query[3]]);
    let qdcount = u16::from_be_bytes([query[4], query[5]]);

    // Only standard queries with exactly one question.
    if flags & 0x8000 != 0 || qdcount != 1 {
        return None;
    }

    let (name, after) = read_name(query, 12)?;
    if after + 4 > query.len() {
        return None;
    }
    let qtype = u16::from_be_bytes([query[after], query[after + 1]]);
    let qclass = u16::from_be_bytes([query[after + 2], query[after + 3]]);
    if qclass != CLASS_IN {
        return None;
    }

    let lower = name.to_ascii_lowercase();
    let ours = tlds.iter().any(|t| {
        let t = t.trim_matches('.').to_ascii_lowercase();
        lower == t || lower.ends_with(&format!(".{t}"))
    });

    let mut out = Vec::with_capacity(query.len() + 16);
    out.extend_from_slice(&id.to_be_bytes());

    if !ours {
        // NXDOMAIN. Saying "no" for a name we do not own is honest and lets the
        // resolver move on rather than hanging.
        out.extend_from_slice(&0x8183u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes()); // qdcount
        out.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&query[12..after + 4]);
        return Some(out);
    }

    // AAAA gets NOERROR with no answers (NODATA) rather than NXDOMAIN --
    // an NXDOMAIN here tells the client the name does not exist at all, and
    // some clients then stop trying A.
    let answers: u16 = if qtype == TYPE_A { 1 } else { 0 };
    if qtype != TYPE_A && qtype != TYPE_AAAA {
        return None;
    }

    out.extend_from_slice(&0x8180u16.to_be_bytes()); // response, authoritative
    out.extend_from_slice(&1u16.to_be_bytes()); // qdcount
    out.extend_from_slice(&answers.to_be_bytes()); // ancount
    out.extend_from_slice(&[0, 0, 0, 0]); // ns, ar
    out.extend_from_slice(&query[12..after + 4]); // echo the question

    if answers == 1 {
        out.extend_from_slice(&[0xC0, 0x0C]); // pointer to the question name
        out.extend_from_slice(&TYPE_A.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        out.extend_from_slice(&TTL.to_be_bytes());
        out.extend_from_slice(&4u16.to_be_bytes()); // rdlength
        out.extend_from_slice(&[127, 0, 0, 1]);
    }
    Some(out)
}

/// Read a QNAME. No compression pointers: a question never uses them.
fn read_name(buf: &[u8], mut at: usize) -> Option<(String, usize)> {
    let mut labels = Vec::new();
    loop {
        if at >= buf.len() {
            return None;
        }
        let len = buf[at] as usize;
        if len == 0 {
            at += 1;
            break;
        }
        if len & 0xC0 != 0 {
            return None; // a pointer in a question: refuse rather than guess
        }
        at += 1;
        if at + len > buf.len() {
            return None;
        }
        labels.push(String::from_utf8_lossy(&buf[at..at + len]).into_owned());
        at += len;
    }
    Some((labels.join("."), at))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query_for(name: &str, qtype: u16) -> Vec<u8> {
        let mut q = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in name.split('.') {
            q.push(label.len() as u8);
            q.extend_from_slice(label.as_bytes());
        }
        q.push(0);
        q.extend_from_slice(&qtype.to_be_bytes());
        q.extend_from_slice(&CLASS_IN.to_be_bytes());
        q
    }

    #[test]
    fn a_site_in_our_tld_resolves_to_loopback() {
        let r = answer(&query_for("shop.test", TYPE_A), &["test".into()]).unwrap();
        assert_eq!(u16::from_be_bytes([r[6], r[7]]), 1, "one answer");
        assert_eq!(&r[r.len() - 4..], &[127, 0, 0, 1]);
    }

    #[test]
    fn a_subdomain_resolves_too_so_multisite_works() {
        // No /etc/hosts entry per subsite: a new subsite resolves the moment
        // WordPress creates it.
        let r = answer(&query_for("sub.network.test", TYPE_A), &["test".into()]).unwrap();
        assert_eq!(&r[r.len() - 4..], &[127, 0, 0, 1]);
    }

    #[test]
    fn aaaa_is_nodata_not_nxdomain() {
        let r = answer(&query_for("shop.test", TYPE_AAAA), &["test".into()]).unwrap();
        assert_eq!(u16::from_be_bytes([r[2], r[3]]) & 0x000F, 0, "rcode NOERROR");
        assert_eq!(u16::from_be_bytes([r[6], r[7]]), 0, "no answers");
    }

    #[test]
    fn a_name_outside_our_tld_is_nxdomain() {
        let r = answer(&query_for("example.com", TYPE_A), &["test".into()]).unwrap();
        assert_eq!(u16::from_be_bytes([r[2], r[3]]) & 0x000F, 3, "NXDOMAIN");
    }

    #[test]
    fn the_tld_itself_resolves() {
        let r = answer(&query_for("test", TYPE_A), &["test".into()]).unwrap();
        assert_eq!(&r[r.len() - 4..], &[127, 0, 0, 1]);
    }
}
