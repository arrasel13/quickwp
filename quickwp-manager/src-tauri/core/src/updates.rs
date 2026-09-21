//! Newer releases of what Nexora runs: PHP, MySQL, MariaDB, Node and Adminer.
//!
//! Where an update can come from differs by service, and says what "newer"
//! can honestly mean:
//!
//! - **PHP, MySQL, Adminer** install from builds Nexora pins by checksum. An
//!   update is an installed copy older than the pin -- which a Nexora update
//!   brings. A release upstream that has no pinned, verified build yet is not
//!   offered: there would be nothing to check it against.
//! - **MariaDB** comes from Homebrew, so its update is Homebrew's current
//!   release of the installed series.
//! - **Node** comes from nodejs.org with published checksums, so its update is
//!   the newest release on an installed LTS line.

use crate::{mariadb, node, paths, runtime};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Update {
    /// "php", "mysql", "mariadb", "node" or "adminer".
    pub service: String,
    /// What to update, as its own commands name it: "8.3", "8.4",
    /// "mariadb-11.4", "22", "adminer".
    pub id: String,
    /// For people: "PHP 8.3".
    pub name: String,
    pub installed: String,
    pub latest: String,
}

impl Update {
    /// One key per release, so the same update is announced once.
    pub fn key(&self) -> String {
        format!("{}:{}@{}", self.service, self.id, self.latest)
    }
}

/// `a` is a later release than `b`: 8.3.10 after 8.3.9.
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Versions of a runtime on disk, from directory names like
/// "8.3.31-fpm-aarch64" or "8.4.8-aarch64".
fn versions_on_disk(component: &str, prefix: &str, kind: Option<&str>) -> Vec<String> {
    std::fs::read_dir(paths::runtimes().join(component))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let mut parts = name.split('-');
            let version = parts.next()?.to_string();
            if let Some(k) = kind {
                if parts.next()? != k {
                    return None;
                }
            }
            version.starts_with(prefix).then_some(version)
        })
        .collect()
}

/// PHP minors installed at an older patch than Nexora now pins.
pub fn php() -> Vec<Update> {
    let mut out = Vec::new();
    for minor in runtime::PHP_MINORS {
        let Ok(pin) = runtime::php_pin(minor, "fpm") else { continue };
        if runtime::is_installed(minor, "fpm") {
            continue; // the pinned build is already here
        }
        let prefix = format!("{minor}.");
        if let Some(old) = versions_on_disk("php", &prefix, Some("fpm"))
            .into_iter()
            .filter(|v| newer(pin.patch, v))
            .max_by(|a, b| if newer(a, b) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less })
        {
            out.push(Update {
                service: "php".into(),
                id: minor.to_string(),
                name: format!("PHP {minor}"),
                installed: old,
                latest: pin.patch.to_string(),
            });
        }
    }
    out
}

/// MySQL series installed at an older release than Nexora now pins.
pub fn mysql() -> Vec<Update> {
    let mut out = Vec::new();
    for series in runtime::MYSQL_SERIES {
        let Ok(pin) = runtime::mysql_pin(series) else { continue };
        if crate::database::is_installed(series) {
            continue;
        }
        let prefix = format!("{series}.");
        if let Some(old) = versions_on_disk("mysql", &prefix, None)
            .into_iter()
            .find(|v| newer(pin.version, v))
        {
            out.push(Update {
                service: "mysql".into(),
                id: series.to_string(),
                name: format!("MySQL {series}"),
                installed: old,
                latest: pin.version.to_string(),
            });
        }
    }
    out
}

pub fn adminer() -> Vec<Update> {
    match crate::adminer::installed_version() {
        Some(v) if crate::adminer::update_available() => vec![Update {
            service: "adminer".into(),
            id: "adminer".into(),
            name: "Adminer".into(),
            installed: v,
            latest: runtime::ADMINER_PIN.version.to_string(),
        }],
        _ => Vec::new(),
    }
}

/// Installed MariaDB series Homebrew has a newer release of.
pub async fn mariadb() -> Vec<Update> {
    let mut out = Vec::new();
    let offered = mariadb::catalog().await;
    let installed: Vec<mariadb::Series> = mariadb::list(&crate::supervisor::Supervisor::new(), &offered)
        .into_iter()
        .filter(|s| s.engine.installed)
        .filter_map(|s| mariadb::series(&s.engine.series).ok())
        .collect();
    for s in installed {
        let (Some(have), Some(latest)) =
            (mariadb::installed_version(&s), mariadb::homebrew_version(&s.formula).await)
        else {
            continue;
        };
        if newer(&latest, &have) {
            out.push(Update {
                service: "mariadb".into(),
                name: format!("MariaDB {}", s.series),
                id: s.id.clone(),
                installed: have,
                latest,
            });
        }
    }
    out
}

/// Node lines Nexora installed that have a newer release.
pub async fn node() -> Vec<Update> {
    let Ok(lines) = node::lines().await else { return Vec::new() };
    lines
        .into_iter()
        .filter_map(|l| {
            let have = l.installed?;
            newer(&l.latest, &have).then(|| Update {
                service: "node".into(),
                id: l.major.clone(),
                name: format!("Node {}", l.major),
                installed: have,
                latest: l.latest,
            })
        })
        .collect()
}

/// Everything, in the order the Services screen shows it.
pub async fn check() -> Vec<Update> {
    let mut out = php();
    out.extend(mysql());
    out.extend(mariadb().await);
    out.extend(node().await);
    out.extend(adminer());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_release_is_newer_including_double_digits() {
        assert!(newer("8.3.10", "8.3.9"));
        assert!(newer("11.4.13", "11.4.12"));
        assert!(!newer("8.4.9", "8.4.9"));
        assert!(!newer("8.4.8", "8.4.9"));
    }

    /// What this Mac would be told today:
    /// `cargo test -p nexora-core live_updates -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads the installed runtimes and asks nodejs.org, mariadb.org and Homebrew"]
    fn live_updates_checks_everything() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let lines = rt.block_on(node::lines()).expect("node lines");
        for l in &lines {
            println!("node {} ({}) {} until {} latest {} installed {:?}", l.major, l.codename, l.phase, l.end, l.latest, l.installed);
        }
        let found = rt.block_on(check());
        println!("updates found: {}", found.len());
        for u in &found {
            println!("  {} {} -> {}", u.name, u.installed, u.latest);
        }
    }

    /// The whole path for a real update: install an older Node, see it
    /// flagged, update it, and leave nothing behind.
    /// `cargo test -p nexora-core live_node_update -- --ignored --nocapture`.
    #[test]
    #[ignore = "downloads two Node releases from nodejs.org"]
    fn live_node_update_is_found_and_applied() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let old = "22.23.1";
        rt.block_on(node::install(old, |_| {})).expect("install the older release");
        println!("installed Node {old}; Nexora's installs: {:?}", node::managed());

        let found = rt.block_on(node());
        println!("flagged: {:?}", found.iter().map(|u| format!("{} {} -> {}", u.name, u.installed, u.latest)).collect::<Vec<_>>());
        let u = found.iter().find(|u| u.id == "22").expect("Node 22 flagged");
        assert_eq!(u.installed, old);

        let msg = rt.block_on(node::update(&u.installed, &u.latest, |_| {})).expect("update");
        println!("{msg}");
        let now = node::managed();
        println!("after: {now:?}");
        assert!(now.contains(&u.latest) && !now.contains(&old.to_string()), "the old one went");
        assert!(rt.block_on(node()).iter().all(|u| u.id != "22"), "nothing left to update");

        // Leave the machine as it was.
        node::remove(&u.latest).unwrap();
        assert!(node::managed().is_empty());
        println!("cleaned up");
    }

    #[test]
    fn an_update_is_announced_once_per_release() {
        let u = Update {
            service: "node".into(),
            id: "22".into(),
            name: "Node 22".into(),
            installed: "22.23.1".into(),
            latest: "22.23.2".into(),
        };
        assert_eq!(u.key(), "node:22@22.23.2");
    }
}
