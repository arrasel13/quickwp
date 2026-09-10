//! PHP installed elsewhere on this Mac: Homebrew, Herd, MAMP, Local and the
//! version managers.
//!
//! Listed so the settings can show everything that is on the machine. Sites
//! still run on QuickWP's own pinned builds -- a Homebrew PHP has its own ini,
//! its own extensions and its own upgrade schedule, none of which QuickWP
//! controls -- so these are reported, never used.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, serde::Serialize)]
pub struct SystemPhp {
    /// Full version, as the binary reports it: "8.4.12".
    pub version: String,
    /// "8.4".
    pub minor: String,
    /// Where it came from: "Homebrew", "Herd", "MAMP"...
    pub source: String,
    pub path: String,
}

pub fn list() -> Vec<SystemPhp> {
    // Keyed by the resolved path: /opt/homebrew/bin/php and the versioned
    // formula it links to are one install, not two.
    let mut found: BTreeMap<PathBuf, SystemPhp> = BTreeMap::new();
    for (bin, source) in candidates() {
        let Ok(real) = std::fs::canonicalize(&bin) else { continue };
        if found.contains_key(&real) {
            continue;
        }
        if let Some(version) = version_of(&bin) {
            let minor = version.split('.').take(2).collect::<Vec<_>>().join(".");
            found.insert(
                real,
                SystemPhp { version, minor, source: source.into(), path: bin.display().to_string() },
            );
        }
    }
    let mut out: Vec<SystemPhp> = found.into_values().collect();
    out.sort_by(|a, b| key(&b.version).cmp(&key(&a.version)));
    out
}

fn key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter_map(|p| p.parse().ok()).collect()
}

/// Binaries under `dir/*/rel`, for layouts with one directory per version.
fn each(dir: &Path, rel: &str, source: &'static str, out: &mut Vec<(PathBuf, &'static str)>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            out.push((e.path().join(rel), source));
        }
    }
}

fn candidates() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();

    // Versioned Homebrew formulae first, so a linked `php` resolves to the
    // same key and is skipped rather than listed twice.
    for prefix in ["/opt/homebrew/opt", "/usr/local/opt"] {
        if let Ok(entries) = std::fs::read_dir(prefix) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == "php" || name.starts_with("php@") {
                    out.push((e.path().join("bin/php"), "Homebrew"));
                }
            }
        }
    }
    for p in ["/opt/homebrew/bin/php", "/usr/local/bin/php"] {
        out.push((PathBuf::from(p), "Homebrew"));
    }
    out.push((PathBuf::from("/usr/bin/php"), "macOS"));

    each(Path::new("/Applications/MAMP/bin/php"), "bin/php", "MAMP", &mut out);
    each(Path::new("/Applications/XAMPP/xamppfiles/bin"), "", "XAMPP", &mut out);

    if let Some(home) = dirs::home_dir() {
        // Herd ships one binary per minor: php82, php83...
        if let Ok(entries) = std::fs::read_dir(home.join("Library/Application Support/Herd/bin")) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("php") && name[3..].chars().all(|c| c.is_ascii_digit()) {
                    out.push((e.path(), "Herd"));
                }
            }
        }
        out.push((home.join(".config/herd-lite/bin/php"), "Herd Lite"));
        each(&home.join(".phpenv/versions"), "bin/php", "phpenv", &mut out);
        each(&home.join(".asdf/installs/php"), "bin/php", "asdf", &mut out);
        each(&home.join(".local/share/mise/installs/php"), "bin/php", "mise", &mut out);
        each(
            &home.join("Library/Application Support/Local/lightning-services"),
            "bin/darwin-arm64/bin/php",
            "Local",
            &mut out,
        );
    }

    out.retain(|(p, _)| p.file_name().map_or(false, |n| n.to_string_lossy().starts_with("php")) && p.is_file());
    out
}

/// Ask the binary itself. `-n` skips every ini file, so a broken extension
/// line cannot make a working PHP look missing; the timeout keeps one wedged
/// shim from stalling the settings screen.
fn version_of(bin: &Path) -> Option<String> {
    let mut child = Command::new(bin)
        .args(["-n", "-r", "echo PHP_VERSION;"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut s = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut s).ok()?;
    let v = s.trim().to_string();
    v.chars().next().filter(|c| c.is_ascii_digit()).map(|_| v)
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_install_reports_a_version_matching_its_minor() {
        let found = super::list();
        eprintln!("{found:#?}");
        for p in &found {
            assert!(p.version.starts_with(&format!("{}.", p.minor)), "{p:?}");
        }
    }
}
