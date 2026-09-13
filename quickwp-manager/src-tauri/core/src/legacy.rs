//! Carrying over an install made before the app was called Nexora.
//!
//! Earlier builds were named QuickWP (and, briefly, AJURO) and kept everything
//! under `com.quickwp.manager`. Upgrading moves that install into place once,
//! so sites, databases, settings, certificates and saved passwords survive the
//! rename. The old names live in this file and nowhere else.

use crate::proc;
use std::path::{Path, PathBuf};

pub const OLD_BUNDLE_ID: &str = "com.quickwp.manager";
pub const OLD_DAEMON_LABEL: &str = "com.quickwp.manager.edge";
pub const OLD_DNS_AGENT_LABEL: &str = "com.quickwp.manager.dns";
pub const OLD_EDGE_PATH: &str = "/usr/local/libexec/quickwp-edge";
pub const OLD_SHARED_DIR: &str = "/usr/local/etc/quickwp";
pub const OLD_KEYCHAIN_SERVICE: &str = "QuickWP site passwords";
const OLD_MU_PLUGINS: &[&str] = &["quickwp-mail.php", "quickwp-login.php"];

/// Files inside the data directory whose names carried the old name.
const RENAMED_FILES: &[(&str, &str)] = &[
    ("quickwp.sqlite3", "nexora.sqlite3"),
    ("quickwp.sqlite3-wal", "nexora.sqlite3-wal"),
    ("quickwp.sqlite3-shm", "nexora.sqlite3-shm"),
    ("logs/quickwp.log", "logs/nexora.log"),
    ("config/ca/quickwp-ca.pem", "config/ca/nexora-ca.pem"),
    ("config/ca/quickwp-ca.key", "config/ca/nexora-ca.key"),
];

pub fn old_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(OLD_BUNDLE_ID)
}

/// Run once at launch, before anything opens the data directory.
pub fn migrate_data_dir() {
    migrate_between(&old_root(), &crate::paths::root());
}

fn migrate_between(old: &Path, new: &Path) {
    // Services the old app left running hold the ports Nexora needs and write
    // into the folder about to move. They are stopped even when that folder is
    // already gone: a database left running from a deleted install still
    // holds its port.
    stop_processes_under(old);
    if !old.is_dir() || new.exists() {
        return;
    }
    // Same volume, so this is a rename: nothing is copied, nothing half-done.
    if let Err(e) = std::fs::rename(old, new) {
        eprintln!("could not move {} to {}: {e}", old.display(), new.display());
        return;
    }
    for (from, to) in RENAMED_FILES {
        let (from, to) = (new.join(from), new.join(to));
        if from.exists() && !to.exists() {
            let _ = std::fs::rename(from, to);
        }
    }
    crate::log::write(&format!("moved the data directory from {}", old.display()));
}

/// Stop every process running from under `dir` -- its PHP pools, database
/// and Mailpit -- by the path in its command line.
fn stop_processes_under(dir: &Path) {
    let needle = format!("{}/", dir.display());
    // -ww: a command line truncated to the terminal width would hide the path.
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-axwwo", "pid=,command="])
        .output()
    else {
        return;
    };
    let me = std::process::id();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((pid, command)) = line.trim_start().split_once(' ') else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        if pid != me && command.contains(&needle) {
            proc::kill_tree(pid);
        }
    }
}

/// Root-script lines that take down the old edge daemon and delete what it
/// installed. Part of the install, so the old edge never holds 443 against
/// the new one, and of Remove system changes.
pub fn system_cleanup_script() -> String {
    format!(
        "launchctl bootout system/{OLD_DAEMON_LABEL} 2>/dev/null || true\n\
         rm -f /Library/LaunchDaemons/{OLD_DAEMON_LABEL}.plist {OLD_EDGE_PATH}\n\
         rm -rf {OLD_SHARED_DIR}\n"
    )
}

/// The old edge daemon, still loaded and serving.
pub fn old_edge_serving() -> bool {
    let loaded = std::process::Command::new("/bin/launchctl")
        .args(["print", &format!("system/{OLD_DAEMON_LABEL}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    loaded
        && std::process::Command::new("/bin/ps")
            .args(["-axwwo", "command="])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().any(|l| l.starts_with(OLD_EDGE_PATH)))
            .unwrap_or(false)
}

/// Remove the old per-user DNS agent; it would answer on the same port.
pub fn remove_old_dns_agent() {
    let uid = unsafe { libc::getuid() };
    let _ = std::process::Command::new("/bin/launchctl")
        .args(["bootout", &format!("gui/{uid}/{OLD_DNS_AGENT_LABEL}")])
        .output();
    if let Some(home) = dirs::home_dir() {
        let _ = std::fs::remove_file(
            home.join("Library/LaunchAgents").join(format!("{OLD_DNS_AGENT_LABEL}.plist")),
        );
    }
}

/// Remove the mu-plugins an earlier build wrote into a site, so the site does
/// not run both its old copy and the current one.
pub fn remove_old_mu_plugins(docroot: &str) {
    let dir = Path::new(docroot).join("wp-content/mu-plugins");
    for name in OLD_MU_PLUGINS {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_install_moves_into_place_with_its_files_renamed() {
        let base = std::env::temp_dir().join(format!("nexora-legacy-{}", std::process::id()));
        let (old, new) = (base.join("old"), base.join("new"));
        std::fs::create_dir_all(old.join("logs")).unwrap();
        std::fs::create_dir_all(old.join("config/ca")).unwrap();
        std::fs::create_dir_all(old.join("databases/mysql-8.4")).unwrap();
        std::fs::write(old.join("quickwp.sqlite3"), b"db").unwrap();
        std::fs::write(old.join("config/ca/quickwp-ca.pem"), b"ca").unwrap();
        std::fs::write(old.join("databases/mysql-8.4/ibdata1"), b"data").unwrap();

        migrate_between(&old, &new);

        assert!(!old.exists(), "the old folder is moved, not copied");
        assert_eq!(std::fs::read(new.join("nexora.sqlite3")).unwrap(), b"db");
        assert_eq!(std::fs::read(new.join("config/ca/nexora-ca.pem")).unwrap(), b"ca");
        assert!(new.join("databases/mysql-8.4/ibdata1").exists(), "databases come along");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_existing_new_install_is_never_overwritten() {
        let base = std::env::temp_dir().join(format!("nexora-legacy-keep-{}", std::process::id()));
        let (old, new) = (base.join("old"), base.join("new"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("quickwp.sqlite3"), b"old").unwrap();
        std::fs::write(new.join("nexora.sqlite3"), b"new").unwrap();

        migrate_between(&old, &new);

        assert_eq!(std::fs::read(new.join("nexora.sqlite3")).unwrap(), b"new");
        assert!(old.exists(), "left alone when there is already a Nexora install");
        let _ = std::fs::remove_dir_all(&base);
    }
}
