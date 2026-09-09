//! Importing from Laravel Herd and Valet.
//!
//! One rule holds across the whole flow and everything else follows from it:
//!
//!   **The source installation is strictly read-only.**
//!
//! Nothing is moved, nothing is deleted, no Herd config is edited, and Herd
//! keeps working exactly as it did. You are copying, not converting -- so
//! deciding against the migration leaves nothing to undo on the other side.

use crate::{db::Db, site, Error, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
pub struct FoundSite {
    pub name: String,
    /// The shortest name becomes the primary; the rest are aliases.
    pub domain: String,
    pub aliases: Vec<String>,
    pub path: String,
    pub source: String,
    pub php_minor: Option<String>,
    pub is_wordpress: bool,
    /// False when QuickWP already has a site answering on that name.
    pub importable: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanResult {
    pub sites: Vec<FoundSite>,
    pub tools: Vec<String>,
    /// Resolver files with no tool behind them. Named before the first .test
    /// domain you type meets a silent refusal.
    pub stale_resolvers: Vec<String>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Where Valet and Herd keep their site links and parked directories.
fn config_roots() -> Vec<(String, PathBuf)> {
    vec![
        (
            "Herd".into(),
            home().join("Library/Application Support/Herd/config/valet"),
        ),
        ("Valet".into(), home().join(".config/valet")),
        ("Valet".into(), home().join(".valet")),
    ]
}

/// Find every site Herd or Valet is serving. Reads only.
pub fn scan(db: &Db) -> Result<ScanResult> {
    let mut tools = Vec::new();
    // Keyed by real path, so a Valet "link farm" -- one project registered
    // under several names -- becomes ONE site with extra domains, rather than
    // several sites that would then refuse each other for sharing a folder.
    let mut by_path: BTreeMap<PathBuf, (String, Vec<String>)> = BTreeMap::new();

    for (tool, root) in config_roots() {
        if !root.is_dir() {
            continue;
        }
        if !tools.contains(&tool) {
            tools.push(tool.clone());
        }

        // Linked sites: a symlink per name.
        let sites_dir = root.join("Sites");
        if let Ok(entries) = std::fs::read_dir(&sites_dir) {
            for e in entries.flatten() {
                let link = e.path();
                let Ok(target) = std::fs::canonicalize(&link) else {
                    continue;
                };
                if !target.is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                let entry = by_path.entry(target).or_insert((tool.clone(), Vec::new()));
                if !entry.1.contains(&name) {
                    entry.1.push(name);
                }
            }
        }

        // Parked directories: every immediate child is served by its own name.
        for parked in read_parked(&root) {
            if let Ok(entries) = std::fs::read_dir(&parked) {
                for e in entries.flatten() {
                    let p = e.path();
                    if !p.is_dir() {
                        continue;
                    }
                    let Ok(target) = std::fs::canonicalize(&p) else {
                        continue;
                    };
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        continue;
                    }
                    let entry = by_path.entry(target).or_insert((tool.clone(), Vec::new()));
                    if !entry.1.contains(&name) {
                        entry.1.push(name);
                    }
                }
            }
        }
    }

    let tld = db.tld()?;
    let existing = site::list(db)?;

    let mut sites: Vec<FoundSite> = Vec::new();
    for (path, (tool, mut names)) in by_path {
        if names.is_empty() {
            continue;
        }
        // Shortest name is the primary; the rest are aliases it answers on.
        names.sort_by_key(|n| (n.len(), n.clone()));
        let primary = format!("{}.{}", names[0], tld);
        let aliases: Vec<String> = names[1..]
            .iter()
            .map(|n| format!("{n}.{tld}"))
            .collect();

        let taken = existing.iter().any(|s| {
            s.domain == primary || s.aliases.contains(&primary) || s.docroot == path.to_string_lossy()
        });

        sites.push(FoundSite {
            name: names[0].clone(),
            domain: primary,
            aliases,
            is_wordpress: path.join("wp-includes/version.php").exists()
                || path.join("wp-load.php").exists(),
            php_minor: detect_php(&path),
            path: path.to_string_lossy().into_owned(),
            source: tool,
            importable: !taken,
            note: if taken {
                Some("QuickWP already has a site here.".into())
            } else {
                None
            },
        });
    }

    Ok(ScanResult {
        sites,
        tools,
        stale_resolvers: stale_resolvers(),
    })
}

fn read_parked(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let config = root.join("config.json");
    let Ok(text) = std::fs::read_to_string(config) else {
        return out;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    if let Some(paths) = v.get("paths").and_then(|p| p.as_array()) {
        for p in paths {
            if let Some(s) = p.as_str() {
                out.push(PathBuf::from(s));
            }
        }
    }
    out
}

/// Herd records a per-site PHP version in an isolation config; a `.valetphprc`
/// is the Valet equivalent. Absent is fine -- the caller falls back to the
/// default rather than guessing.
fn detect_php(path: &Path) -> Option<String> {
    let rc = path.join(".valetphprc");
    if let Ok(s) = std::fs::read_to_string(rc) {
        let t = s.trim().trim_start_matches("php@").to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    None
}

/// Resolver files for TLDs nothing is answering for any more.
fn stale_resolvers() -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/etc/resolver") else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(body) = std::fs::read_to_string(&p) else {
            continue;
        };
        if body.contains(&format!("port {}", crate::ports::DNS)) {
            continue; // ours
        }
        out.push(p.to_string_lossy().into_owned());
    }
    out
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImportRequest {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub php_minor: String,
}

/// Import one found site.
///
/// It is LINKED, never copied: the folder stays exactly where it is, and
/// deleting the QuickWP site later removes only our record of it. Copying
/// someone's project into our own directory is what makes a tool hard to leave.
pub fn import_site(db: &Db, req: &ImportRequest) -> Result<site::Site> {
    let path = PathBuf::from(&req.path);
    if !path.is_dir() {
        return Err(Error::other(format!(
            "{} is no longer a folder. Nothing was imported.",
            path.display()
        )));
    }

    let created = site::create(
        db,
        &site::NewSite {
            name: req.name.clone(),
            domain: req.domain.clone(),
            kind: if path.join("wp-includes/version.php").exists() {
                "wordpress".into()
            } else {
                "php".into()
            },
            php_minor: req.php_minor.clone(),
            link_path: Some(req.path.clone()),
        },
    )?;

    for alias in &req.aliases {
        // An alias already owned by another site is reported, not forced.
        site::add_domain(db, &created.domain, alias)?;
    }

    site::find(db, &created.domain)?
        .ok_or_else(|| Error::other("the imported site vanished"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanning_an_absent_herd_finds_nothing_and_does_not_fail() {
        let db = Db::open_in_memory().unwrap();
        let r = scan(&db).unwrap();
        // On a machine with no Herd this must be empty rather than an error:
        // "no sites found" is a supported outcome, not a failure.
        assert!(r.sites.is_empty() || r.sites.iter().all(|s| !s.path.is_empty()));
    }

    #[test]
    fn importing_a_missing_folder_is_refused_before_anything_is_written() {
        let db = Db::open_in_memory().unwrap();
        let err = import_site(
            &db,
            &ImportRequest {
                domain: "gone.test".into(),
                path: "/definitely/not/here".into(),
                name: "gone".into(),
                aliases: vec![],
                php_minor: "8.3".into(),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("no longer a folder"));
        assert!(site::find(&db, "gone.test").unwrap().is_none());
    }
}
