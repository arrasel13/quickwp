//! Everything QuickWP owns lives under one directory.
//!
//! Deliberately one tree rather than the platform convention of splitting logs
//! into ~/Library/Logs: when a service fails to start, the reason is in our own
//! log and not in that service's empty one, and a diagnosis that spans two
//! directories is a diagnosis people give up on.

use std::path::{Path, PathBuf};

pub const BUNDLE_ID: &str = "com.quickwp.manager";

/// ~/Library/Application Support/com.quickwp.manager
pub fn root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(BUNDLE_ID)
}

pub fn runtimes() -> PathBuf {
    root().join("runtimes")
}

/// Where a verified component tree lands: runtimes/php/8.3.32-fpm-aarch64/
pub fn runtime_dir(component: &str, version: &str) -> PathBuf {
    runtimes().join(component).join(version)
}

pub fn downloads_cache() -> PathBuf {
    root().join("cache")
}

/// Where new sites are provisioned.
///
/// Default is `~/QuickWP/Sites`: somewhere a person can actually find, open in
/// an editor and back up. Burying a user's own code inside
/// ~/Library/Application Support is the kind of choice that makes a tool hard
/// to leave. Configurable, because whose folder this is is not our call.
pub fn sites() -> PathBuf {
    if let Some(custom) = sites_override() {
        return custom;
    }
    default_sites()
}

pub fn default_sites() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("QuickWP")
        .join("Sites")
}

/// Read straight from the settings table rather than through `Db`, so paths
/// stay usable from code that has no handle -- and so a missing database is
/// simply "no override" instead of an error.
fn sites_override() -> Option<PathBuf> {
    let conn = rusqlite::Connection::open(db_file()).ok()?;
    let value: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'sites_dir'", [], |r| r.get(0))
        .ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

/// The old location, kept only so existing sites can still be found.
pub fn legacy_sites() -> PathBuf {
    root().join("Sites")
}

/// Certificates the ROOT edge daemon reads.
///
/// Deliberately outside the user's home. `~/Library` is drwx------ and macOS
/// stops daemons reading user Library data, so an edge running as root loads
/// zero certificates from there and then closes every TLS connection with no
/// bytes -- which looks like a network fault rather than a permissions one.
///
/// Created and handed to the user at install time, so issuing a certificate
/// later needs no password.
pub fn shared_certs() -> PathBuf {
    PathBuf::from("/usr/local/etc/quickwp/certs")
}

/// Is the shared location present and ours to write?
pub fn shared_certs_usable() -> bool {
    let d = shared_certs();
    if !d.is_dir() {
        return false;
    }
    let probe = d.join(".quickwp-write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn config() -> PathBuf {
    root().join("config")
}

pub fn logs() -> PathBuf {
    root().join("logs")
}

pub fn run() -> PathBuf {
    root().join("run")
}

pub fn db_file() -> PathBuf {
    root().join("quickwp.sqlite3")
}

/// The app's own log, first in the log viewer's list.
pub fn app_log() -> PathBuf {
    logs().join("quickwp.log")
}

pub fn ensure_dirs() -> crate::Result<()> {
    for d in [
        root(),
        runtimes(),
        downloads_cache(),
        sites(),
        config(),
        logs(),
        run(),
    ] {
        mkdir_p(&d)?;
    }
    Ok(())
}

pub fn mkdir_p(p: &Path) -> crate::Result<()> {
    std::fs::create_dir_all(p).map_err(|e| crate::Error::Io {
        path: p.to_path_buf(),
        source: e,
    })
}
