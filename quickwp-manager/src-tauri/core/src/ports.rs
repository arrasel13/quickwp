//! Port allocation.
//!
//! Every number here is offset from its stock default on purpose. The offsets
//! are the difference between QuickWP coexisting with a MySQL, a Mailpit or a
//! Herd you already run, and demanding you dismantle them first.
//!
//! They are also offset from rexenv's, so both can be installed at once while
//! you evaluate. 80 and 443 are the exception -- `https://site.test` with no
//! port number *means* 443, so only one tool can serve at a time.

use std::net::{SocketAddr, TcpListener};

pub const EDGE_HTTP: u16 = 80;
pub const EDGE_HTTPS: u16 = 443;
pub const DNS: u16 = 15354;
pub const NGINX: u16 = 18089;
pub const MYSQL: u16 = 13316;
pub const MARIADB: u16 = 13317;
pub const POSTGRES: u16 = 15433;
pub const REDIS: u16 = 16380;
pub const MAILPIT_SMTP: u16 = 11026;
pub const MAILPIT_UI: u16 = 18026;

/// Xdebug's DBGp port. The only port in this file QuickWP does NOT bind:
/// PHP connects outward to your IDE, so your editor is the listener.
pub const XDEBUG_DBGP: u16 = 9003;

pub const FRANKENPHP_RANGE: (u16, u16) = (8400, 8499);
pub const APACHE_RANGE: (u16, u16) = (8500, 8599);

/// php-fpm pool port for a PHP minor, as `9800 + major*10 + minor`.
///
/// The formula is not a tidy contiguous range and that is the point: 7.4 lands
/// at 9874, *below* the 8.x block, because the port tells you which version is
/// on the other end of it. That stays true when a version is added or removed.
pub fn fpm_port(minor: &str) -> crate::Result<u16> {
    let (maj, min) = split_minor(minor)?;
    Ok(9800 + maj * 10 + min)
}

/// Xdebug-enabled pools run separately so untoggled sites pay none of the
/// overhead. 8.1-8.5 only -- see `php::xdebug_supported`.
pub fn xdebug_port(minor: &str) -> crate::Result<u16> {
    let (maj, min) = split_minor(minor)?;
    Ok(9890 + maj * 10 + min - 80)
}

fn split_minor(minor: &str) -> crate::Result<(u16, u16)> {
    let mut it = minor.split('.');
    let maj: u16 = it
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| crate::Error::UnknownPhpVersion(minor.into()))?;
    let min: u16 = it
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| crate::Error::UnknownPhpVersion(minor.into()))?;
    if it.next().is_some() {
        // A patch was passed where a minor belongs. Sites store a minor and
        // never a patch, so this is a programming error worth naming.
        return Err(crate::Error::UnknownPhpVersion(format!(
            "{minor} (expected a minor like \"8.3\", not a patch)"
        )));
    }
    Ok((maj, min))
}

/// True when nothing holds the port on loopback.
pub fn is_free(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpListener::bind(addr).is_ok()
}

/// Who holds a port, for the message when a start is refused.
///
/// A generic "failed to start" sends people to Google; naming the process and
/// its pid sends them to the thing actually in the way.
pub fn holder(port: u16) -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-F", "cp"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut pid = None;
    let mut cmd = None;
    for line in text.lines() {
        match line.as_bytes().first() {
            Some(b'p') => pid = Some(line[1..].to_string()),
            Some(b'c') => cmd = Some(line[1..].to_string()),
            _ => {}
        }
    }
    match (cmd, pid) {
        (Some(c), Some(p)) => Some(format!("{c} (pid {p})")),
        _ => None,
    }
}

/// Gate a start on its port being free.
///
/// Nothing in QuickWP starts without this check. A service that fails to bind
/// after spawning leaves a half-started stack and a log nobody reads.
pub fn gate(port: u16) -> crate::Result<()> {
    if is_free(port) {
        return Ok(());
    }
    Err(crate::Error::PortInUse {
        port,
        holder: holder(port).unwrap_or_else(|| "an unknown process".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fpm_formula_puts_74_below_the_8x_block() {
        assert_eq!(fpm_port("7.4").unwrap(), 9874);
        assert_eq!(fpm_port("8.0").unwrap(), 9880);
        assert_eq!(fpm_port("8.3").unwrap(), 9883);
        assert_eq!(fpm_port("8.5").unwrap(), 9885);
        assert!(fpm_port("7.4").unwrap() < fpm_port("8.0").unwrap());
    }

    #[test]
    fn a_patch_where_a_minor_belongs_is_refused() {
        assert!(fpm_port("8.3.32").is_err());
    }

    #[test]
    fn xdebug_pools_do_not_collide_with_normal_pools() {
        for m in ["8.1", "8.2", "8.3", "8.4", "8.5"] {
            assert_ne!(fpm_port(m).unwrap(), xdebug_port(m).unwrap());
        }
        assert_eq!(xdebug_port("8.3").unwrap(), 9893);
    }
}
