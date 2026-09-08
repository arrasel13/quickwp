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

pub fn sites() -> PathBuf {
    root().join("Sites")
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
