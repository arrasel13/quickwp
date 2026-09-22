//! Everything Nexora owns lives under one directory.
//!
//! Deliberately one tree rather than the platform convention of splitting logs
//! into ~/Library/Logs: when a service fails to start, the reason is in our own
//! log and not in that service's empty one, and a diagnosis that spans two
//! directories is a diagnosis people give up on.

use std::path::{Path, PathBuf};

pub const BUNDLE_ID: &str = "com.nexora.app";

/// ~/Library/Application Support/com.nexora.app
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

/// The user's Downloads folder: where exports and saved logs land, because it
/// is somewhere they can actually find them.
pub fn downloads() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Downloads")
}

pub fn downloads_cache() -> PathBuf {
    root().join("cache")
}

/// Where new sites are provisioned.
///
/// Default is `~/Nexora/Sites`: somewhere a person can actually find, open in
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
        .join("Nexora")
        .join("Sites")
}

/// Read straight from the settings table rather than through `Db`, so paths
/// stay usable from code that has no handle -- and so a missing database is
/// simply "no override" instead of an error.
fn sites_override() -> Option<PathBuf> {
    // Read-only, and never creating the file: this runs before the database
    // exists on a first launch.
    let conn = rusqlite::Connection::open_with_flags(
        db_file(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
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
    PathBuf::from("/usr/local/etc/nexora/certs")
}

/// Is the shared location present and ours to write?
pub fn shared_certs_usable() -> bool {
    let d = shared_certs();
    if !d.is_dir() {
        return false;
    }
    let probe = d.join(".nexora-write-test");
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
    root().join("nexora.sqlite3")
}

/// The app's own log, first in the log viewer's list.
pub fn app_log() -> PathBuf {
    logs().join("nexora.log")
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

/// Copy a folder and everything in it into `to`, which is made if need be.
///
/// Symbolic links are copied as links rather than followed: a site folder can
/// hold links to places outside it that a copy must not swallow whole.
pub fn copy_tree(from: &Path, to: &Path) -> crate::Result<()> {
    let io = |path: &Path, e: std::io::Error| crate::Error::Io {
        path: path.to_path_buf(),
        source: e,
    };
    mkdir_p(to)?;
    for entry in std::fs::read_dir(from).map_err(|e| io(from, e))? {
        let entry = entry.map_err(|e| io(from, e))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| io(&src, e))?;
        if kind.is_symlink() {
            #[cfg(unix)]
            {
                let target = std::fs::read_link(&src).map_err(|e| io(&src, e))?;
                let _ = std::fs::remove_file(&dst);
                std::os::unix::fs::symlink(&target, &dst).map_err(|e| io(&dst, e))?;
            }
        } else if kind.is_dir() {
            copy_tree(&src, &dst)?;
        } else if kind.is_file() {
            std::fs::copy(&src, &dst).map_err(|e| io(&src, e))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod copy_tree_tests {
    use super::copy_tree;

    #[test]
    fn a_folder_is_copied_whole_and_links_stay_links() {
        let root = std::env::temp_dir().join(format!("nexora-copy-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let from = root.join("from");
        std::fs::create_dir_all(from.join("wp-content/uploads")).unwrap();
        std::fs::write(from.join("index.php"), "<?php // site").unwrap();
        std::fs::write(from.join("wp-content/uploads/a.txt"), "upload").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/definitely/elsewhere", from.join("linked")).unwrap();

        let to = root.join("to");
        copy_tree(&from, &to).unwrap();

        assert_eq!(std::fs::read_to_string(to.join("index.php")).unwrap(), "<?php // site");
        assert_eq!(std::fs::read_to_string(to.join("wp-content/uploads/a.txt")).unwrap(), "upload");
        #[cfg(unix)]
        {
            let meta = std::fs::symlink_metadata(to.join("linked")).unwrap();
            assert!(meta.file_type().is_symlink(), "a link is copied as a link, not followed");
            assert_eq!(std::fs::read_link(to.join("linked")).unwrap().to_str(), Some("/definitely/elsewhere"));
        }
        // The original is only read.
        assert_eq!(std::fs::read_to_string(from.join("index.php")).unwrap(), "<?php // site");
        let _ = std::fs::remove_dir_all(&root);
    }
}
