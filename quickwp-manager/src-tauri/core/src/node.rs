//! Node versions already installed on this machine.
//!
//! QuickWP does not install Node. People arrive with one already managed by
//! nvm, fnm, Volta, asdf, n or Homebrew, and a second copy owned by us would
//! be the one thing on the machine their `package.json` scripts do not use.
//! So this only reports what is there.
//!
//! Discovery is by directory name wherever the manager encodes the version in
//! its layout, because that costs a readdir; only loose binaries are executed
//! to ask their version, and only once each.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct NodeVersion {
    /// Full version, no leading v: "22.19.0".
    pub version: String,
    /// Major on its own, for the compact label a site row shows: "22".
    pub major: String,
    /// The node binary itself.
    pub path: String,
    /// Which manager it came from, for the UI to attribute it.
    pub source: String,
}

/// Newest first. Deduplicated by version, keeping the first source that
/// reported it, so one install surfaced by two managers is listed once.
pub fn list() -> Vec<NodeVersion> {
    let mut found: BTreeMap<(u64, u64, u64), NodeVersion> = BTreeMap::new();

    for candidate in discover() {
        if let Some(key) = sort_key(&candidate.version) {
            found.entry(key).or_insert(candidate);
        }
    }

    found.into_values().rev().collect()
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn discover() -> Vec<NodeVersion> {
    let mut out = Vec::new();
    let home = home();

    // Version-per-directory managers. Each entry is a root plus the path from
    // a version directory down to the binary.
    let mut roots: Vec<(PathBuf, &str, &str)> = Vec::new();
    if let Some(h) = &home {
        roots.push((h.join(".nvm/versions/node"), "bin/node", "nvm"));
        roots.push((h.join(".fnm/node-versions"), "installation/bin/node", "fnm"));
        roots.push((
            h.join("Library/Application Support/fnm/node-versions"),
            "installation/bin/node",
            "fnm",
        ));
        roots.push((h.join(".volta/tools/image/node"), "bin/node", "Volta"));
        roots.push((h.join(".asdf/installs/nodejs"), "bin/node", "asdf"));
        roots.push((h.join(".nodenv/versions"), "bin/node", "nodenv"));
    }
    roots.push((PathBuf::from("/usr/local/n/versions/node"), "bin/node", "n"));

    for (root, suffix, source) in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(version) = clean_version(&name) else {
                continue;
            };
            let bin = entry.path().join(suffix);
            if bin.exists() {
                out.push(make(version, bin, source));
            }
        }
    }

    // Loose binaries: Homebrew's versioned formulae, its unversioned one, and
    // whatever a plain PATH lookup finds. These have to be asked.
    let mut binaries: Vec<(PathBuf, &str)> = Vec::new();
    for prefix in ["/opt/homebrew/opt", "/usr/local/opt"] {
        if let Ok(entries) = std::fs::read_dir(prefix) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "node" || name.starts_with("node@") {
                    binaries.push((entry.path().join("bin/node"), "Homebrew"));
                }
            }
        }
    }
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        binaries.push((PathBuf::from(p), "system"));
    }

    for (bin, source) in binaries {
        if !bin.exists() {
            continue;
        }
        if let Some(version) = ask_version(&bin) {
            out.push(make(version, bin, source));
        }
    }

    out
}

fn make(version: String, bin: PathBuf, source: &str) -> NodeVersion {
    let major = version.split('.').next().unwrap_or(&version).to_string();
    NodeVersion {
        version,
        major,
        path: bin.to_string_lossy().to_string(),
        source: source.to_string(),
    }
}

/// "v22.19.0" and "22.19.0" both mean 22.19.0. Anything else is not a version
/// directory -- nvm keeps aliases like "lts/*" alongside the real ones.
fn clean_version(raw: &str) -> Option<String> {
    let v = raw.strip_prefix('v').unwrap_or(raw);
    sort_key(v)?;
    Some(v.to_string())
}

fn sort_key(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let patch = parts.next().unwrap_or("0").parse().unwrap_or(0);
    Some((major, minor, patch))
}

fn ask_version(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    clean_version(text.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_directory_spellings() {
        assert_eq!(clean_version("v22.19.0").as_deref(), Some("22.19.0"));
        assert_eq!(clean_version("18.20.8").as_deref(), Some("18.20.8"));
    }

    #[test]
    fn rejects_nvm_aliases() {
        assert_eq!(clean_version("lts/hydrogen"), None);
        assert_eq!(clean_version("system"), None);
    }

    #[test]
    fn orders_numerically_not_lexically() {
        // The bug a string sort would introduce: "9" above "22".
        assert!(sort_key("22.19.0") > sort_key("9.11.2"));
        assert!(sort_key("22.19.0") > sort_key("22.9.0"));
    }
}
