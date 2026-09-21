//! Node versions on this machine, and the ones Nexora installs.
//!
//! People often arrive with Node managed by nvm, fnm, Volta, asdf, n or
//! Homebrew, and those are found and offered as they are. Nexora can also
//! install the supported LTS lines itself, from nodejs.org's own builds,
//! checked against the SHA-256 sums nodejs.org publishes beside them.
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
    roots.push((managed_root(), "bin/node", "Nexora"));

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


// ------------------------------------------------------ Nexora's own installs

/// Where Nexora keeps the Node it installs: one directory per version.
pub fn managed_root() -> PathBuf {
    crate::paths::runtimes().join("node")
}

/// nodejs.org's name for this machine's build.
fn platform() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "darwin-arm64"
    } else {
        "darwin-x64"
    }
}

fn managed_dir(version: &str) -> PathBuf {
    managed_root().join(format!("{version}-{}", platform()))
}

/// The versions Nexora has installed, newest first: "22.23.2".
pub fn managed() -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(managed_root())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("bin/node").is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            clean_version(name.split('-').next()?)
        })
        .collect();
    out.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));
    out
}

/// One LTS line: its major, how long it is supported, and its newest release.
#[derive(Debug, Clone, Serialize)]
pub struct NodeLine {
    pub major: String,
    /// "Jod".
    pub codename: String,
    /// "active" while it gets features and fixes, "maintenance" after.
    pub phase: String,
    /// When Node stops supporting it: "2027-04-30".
    pub end: String,
    /// Its newest release on nodejs.org: "22.23.2".
    pub latest: String,
    /// The version Nexora has installed on this line, if any.
    pub installed: Option<String>,
}

/// How many LTS lines are offered.
const OFFERED: usize = 3;

async fn get_text(url: &str) -> crate::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Nexora")
        .build()
        .map_err(|e| crate::Error::other(format!("no HTTP client: {e}")))?;
    client
        .get(url)
        .send()
        .await
        .map_err(|e| crate::Error::other(format!("{url} could not be reached: {e}")))?
        .text()
        .await
        .map_err(|e| crate::Error::other(format!("{url} sent nothing readable: {e}")))
}

/// The LTS lines Node still supports, newest first, from Node's own release
/// schedule and its list of releases.
pub async fn lines() -> crate::Result<Vec<NodeLine>> {
    let schedule = get_text("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json").await?;
    let index = get_text("https://nodejs.org/dist/index.json").await?;
    Ok(parse_lines(&schedule, &index, &crate::mariadb_today(), &managed()))
}

fn parse_lines(schedule: &str, index: &str, today: &str, installed: &[String]) -> Vec<NodeLine> {
    let Ok(schedule) = serde_json::from_str::<serde_json::Value>(schedule) else {
        return Vec::new();
    };
    let releases: Vec<serde_json::Value> = serde_json::from_str(index).unwrap_or_default();
    let Some(majors) = schedule.as_object() else { return Vec::new() };

    let mut out: Vec<NodeLine> = majors
        .iter()
        .filter_map(|(key, v)| {
            let major = key.strip_prefix('v')?.to_string();
            major.parse::<u32>().ok()?;
            let lts = v.get("lts")?.as_str()?;
            let end = v.get("end")?.as_str()?.to_string();
            // An LTS line that has started and not ended.
            if lts > today || end.as_str() < today {
                return None;
            }
            let maintenance = v.get("maintenance").and_then(|m| m.as_str()).unwrap_or("9999");
            let phase = if maintenance <= today { "maintenance" } else { "active" };
            // index.json is newest first; the first of this major that has a
            // macOS build is its latest.
            let prefix = format!("v{major}.");
            let latest = releases
                .iter()
                .filter_map(|r| r.get("version")?.as_str())
                .find(|ver| ver.starts_with(&prefix))?
                .trim_start_matches('v')
                .to_string();
            let installed = installed
                .iter()
                .find(|i| i.split('.').next() == Some(major.as_str()))
                .cloned();
            Some(NodeLine {
                codename: v.get("codename").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                phase: phase.into(),
                end,
                latest,
                installed,
                major,
            })
        })
        .collect();
    out.sort_by(|a, b| b.major.parse::<u32>().unwrap_or(0).cmp(&a.major.parse::<u32>().unwrap_or(0)));
    out.truncate(OFFERED);
    out
}

/// Exactly "22.23.2": three runs of digits. Stricter than `clean_version`,
/// because this string becomes a download URL and a directory name.
fn strict_version(raw: &str) -> Option<String> {
    let v = raw.strip_prefix('v').unwrap_or(raw);
    let parts: Vec<&str> = v.split('.').collect();
    (parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.chars().all(|c| c.is_ascii_digit())))
        .then(|| v.to_string())
}

/// The SHA-256 nodejs.org publishes for a file of a release.
fn sum_for(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sum = parts.next()?;
        (parts.next()? == file && sum.len() == 64).then(|| sum.to_string())
    })
}

/// Install one release from nodejs.org, checked against its published sum.
/// Returns where it landed. Idempotent.
pub async fn install(
    version: &str,
    on_progress: impl Fn(crate::runtime::Progress) + Send + 'static,
) -> crate::Result<PathBuf> {
    let version = strict_version(version)
        .ok_or_else(|| crate::Error::other(format!("`{version}` is not a Node version")))?;
    let dest = managed_dir(&version);
    if dest.join("bin/node").is_file() {
        return Ok(dest);
    }
    let file = format!("node-v{version}-{}.tar.gz", platform());
    let base = format!("https://nodejs.org/dist/v{version}");
    let sums = get_text(&format!("{base}/SHASUMS256.txt")).await?;
    let sha = sum_for(&sums, &file)
        .ok_or_else(|| crate::Error::other(format!("nodejs.org lists no checksum for {file}")))?;

    crate::paths::ensure_dirs()?;
    let tmp = crate::paths::downloads_cache().join(&file);
    crate::runtime::download_verified(&format!("Node {version}"), &format!("{base}/{file}"), &sha, &tmp, on_progress)
        .await?;

    let staging = dest.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    crate::paths::mkdir_p(&staging)?;
    crate::runtime::extract_tar_gz(&tmp, &staging)?;
    // The tarball nests everything under node-v<version>-<platform>/.
    let root = staging.join(format!("node-v{version}-{}", platform()));
    if !root.join("bin/node").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(crate::Error::other(format!("Node {version}: unexpected archive layout")));
    }
    let _ = std::fs::remove_dir_all(&dest);
    crate::paths::mkdir_p(dest.parent().unwrap())?;
    std::fs::rename(&root, &dest).map_err(|e| crate::Error::Io { path: dest.clone(), source: e })?;
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&tmp);
    crate::log::info("node", &format!("installed Node {version}"));
    Ok(dest)
}

/// Remove a version Nexora installed. Never touches anyone else's.
pub fn remove(version: &str) -> crate::Result<()> {
    let version = strict_version(version)
        .ok_or_else(|| crate::Error::other(format!("`{version}` is not a Node version")))?;
    let dir = managed_dir(&version);
    if dir.starts_with(managed_root()) && dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| crate::Error::Io { path: dir.clone(), source: e })?;
    }
    Ok(())
}

/// Move an installed line to its newest release: install that, then drop the
/// older one Nexora had.
pub async fn update(
    from: &str,
    to: &str,
    on_progress: impl Fn(crate::runtime::Progress) + Send + 'static,
) -> crate::Result<String> {
    install(to, on_progress).await?;
    if from != to {
        remove(from)?;
    }
    Ok(format!("Node updated from {from} to {to}."))
}

#[cfg(test)]
mod lines_tests {
    use super::*;

    const SCHEDULE: &str = r#"{
        "v20": {"start":"2023-04-18","lts":"2023-10-24","maintenance":"2024-10-22","end":"2026-04-30","codename":"Iron"},
        "v22": {"start":"2024-04-24","lts":"2024-10-29","maintenance":"2025-10-21","end":"2027-04-30","codename":"Jod"},
        "v24": {"start":"2025-05-06","lts":"2025-10-28","maintenance":"2026-10-20","end":"2028-04-30","codename":"Krypton"},
        "v26": {"start":"2026-05-05","lts":"2026-10-28","maintenance":"2027-10-20","end":"2029-04-30","codename":""},
        "v25": {"start":"2025-10-15","maintenance":"2026-04-01","end":"2026-06-01"}
    }"#;
    const INDEX: &str = r#"[
        {"version":"v26.9.0"},{"version":"v24.21.0"},{"version":"v24.20.0"},
        {"version":"v22.23.2"},{"version":"v22.23.1"},{"version":"v20.19.9"}
    ]"#;

    #[test]
    fn only_supported_lts_lines_newest_first_with_their_latest() {
        let got = parse_lines(SCHEDULE, INDEX, "2026-09-21", &["22.23.1".into()]);
        let majors: Vec<&str> = got.iter().map(|l| l.major.as_str()).collect();
        // 26 is not LTS until October; 20 ended in April; 25 was never LTS.
        assert_eq!(majors, vec!["24", "22"]);
        assert_eq!(got[0].latest, "24.21.0");
        assert_eq!(got[0].phase, "active");
        assert_eq!(got[1].phase, "maintenance");
        assert_eq!(got[1].installed.as_deref(), Some("22.23.1"));
        assert_eq!(got[1].end, "2027-04-30");
    }

    #[test]
    fn a_new_lts_line_joins_on_its_day() {
        let got = parse_lines(SCHEDULE, INDEX, "2026-10-28", &[]);
        assert_eq!(got.iter().map(|l| l.major.as_str()).collect::<Vec<_>>(), vec!["26", "24", "22"]);
    }

    #[test]
    fn the_published_sum_is_found_for_exactly_that_file() {
        let sums = "aaaa  other.tar.gz\n\
                    0000000000000000000000000000000000000000000000000000000000000001  node-v22.23.2-darwin-arm64.tar.gz\n\
                    0000000000000000000000000000000000000000000000000000000000000002  node-v22.23.2-darwin-arm64.tar.xz";
        assert_eq!(
            sum_for(sums, "node-v22.23.2-darwin-arm64.tar.gz").as_deref(),
            Some("0000000000000000000000000000000000000000000000000000000000000001")
        );
        assert_eq!(sum_for(sums, "node-v1.0.0-darwin-arm64.tar.gz"), None);
    }

    #[test]
    fn nothing_but_a_version_reaches_the_filesystem() {
        assert!(remove("../../etc").is_err());
        assert!(remove("22.23.2; rm").is_err());
        assert!(remove("22.23").is_err());
        assert_eq!(strict_version("v22.23.2").as_deref(), Some("22.23.2"));
    }
}
