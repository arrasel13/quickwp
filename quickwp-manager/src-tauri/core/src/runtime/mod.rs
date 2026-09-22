//! Runtime supply: fetch a pinned component, verify it, make it runnable.
//!
//! The order of operations is the whole point and is not negotiable:
//!
//!   download -> hash while streaming -> compare to the pin -> only then extract
//!
//! A failed or cancelled download must leave the previous version exactly where
//! it was. Extracting first and verifying after would mean a corrupt or hostile
//! tarball had already touched the tree.

pub mod latest;
pub mod pins;

use crate::{paths, Error, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

pub use pins::{PhpPin, PHP_EOL, PHP_MINORS, PHP_PINS, XDEBUG_MIN_MINOR};

/// The architecture this build is running as.
pub fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}

/// Progress on a download, streamed to the UI so a 600MB cold start is legible.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Progress {
    pub component: String,
    pub received: u64,
    /// None when the server sends no content-length. The UI must then show an
    /// indeterminate bar -- a clamped, plausible, false percentage is worse
    /// than no percentage.
    pub total: Option<u64>,
}

pub fn php_pin(minor: &str, kind: &str) -> Result<&'static PhpPin> {
    let a = arch();
    PHP_PINS
        .iter()
        .find(|p| p.minor == minor && p.kind == kind && p.arch == a)
        .ok_or_else(|| Error::UnknownPhpVersion(format!("{minor} ({kind}, {a})")))
}

/// Where a verified PHP tree lives once installed.
pub fn php_dir(minor: &str, kind: &str) -> Result<PathBuf> {
    let pin = php_pin(minor, kind)?;
    Ok(paths::runtime_dir(
        "php",
        &format!("{}-{}-{}", pin.patch, pin.kind, pin.arch),
    ))
}

/// The php-fpm binary for a minor, if it is installed.
pub fn fpm_binary(minor: &str) -> Result<PathBuf> {
    let p = php_dir(minor, "fpm")?.join("php-fpm");
    if p.exists() {
        Ok(p)
    } else {
        Err(Error::NotInstalled {
            component: format!("PHP {minor} (fpm)"),
        })
    }
}

/// The php CLI binary for a minor, if it is installed.
pub fn php_binary(minor: &str) -> Result<PathBuf> {
    let p = php_dir(minor, "cli")?.join("php");
    if p.exists() {
        Ok(p)
    } else {
        Err(Error::NotInstalled {
            component: format!("PHP {minor} (cli)"),
        })
    }
}

pub fn is_installed(minor: &str, kind: &str) -> bool {
    match (php_dir(minor, kind), kind) {
        (Ok(d), "fpm") => d.join("php-fpm").exists(),
        (Ok(d), _) => d.join("php").exists(),
        _ => false,
    }
}

/// Install one pinned PHP component. Idempotent: an already-installed tree is
/// left alone and reported as such.
pub async fn install_php(
    minor: &str,
    kind: &str,
    on_progress: impl Fn(Progress) + Send + 'static,
) -> Result<PathBuf> {
    let pin = php_pin(minor, kind)?;
    let dest = php_dir(minor, kind)?;
    let marker = if kind == "fpm" { "php-fpm" } else { "php" };
    if dest.join(marker).exists() {
        return Ok(dest);
    }

    paths::ensure_dirs()?;
    let label = format!("PHP {} ({})", pin.patch, pin.kind);
    let tmp = paths::downloads_cache().join(format!("{}-{}-{}.tar.gz", pin.patch, pin.kind, pin.arch));

    let actual = download_verified(&label, pin.url, pin.sha256, &tmp, on_progress).await?;
    debug_assert_eq!(actual, pin.sha256);

    // Verified. Only now does anything touch the runtime tree.
    let staging = dest.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    paths::mkdir_p(&staging)?;
    extract_tar_gz(&tmp, &staging)?;

    // static-php tarballs put the binary at the root; some layouts nest it.
    let found = find_file(&staging, marker)
        .ok_or_else(|| Error::other(format!("{label}: no `{marker}` in the extracted archive")))?;
    let bin_root = found.parent().unwrap().to_path_buf();

    let _ = std::fs::remove_dir_all(&dest);
    paths::mkdir_p(dest.parent().unwrap())?;
    std::fs::rename(&bin_root, &dest).map_err(|e| Error::Io {
        path: dest.clone(),
        source: e,
    })?;
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&tmp);

    make_executable(&dest.join(marker))?;
    Ok(dest)
}

/// Stream a URL to disk, hashing as it goes, and refuse it unless the digest
/// matches. Returns the digest on success.
pub async fn download_verified(
    label: &str,
    url: &str,
    expected_sha256: &str,
    dest: &Path,
    on_progress: impl Fn(Progress) + Send + 'static,
) -> Result<String> {
    paths::mkdir_p(dest.parent().unwrap())?;

    let client = reqwest::Client::builder()
        .user_agent(concat!("Nexora/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| Error::Download {
            url: url.into(),
            source: e,
        })?;

    let resp = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| Error::Download {
            url: url.into(),
            source: e,
        })?;

    let total = resp.content_length();
    // Write beside the target and rename only after the digest matches, so an
    // interrupted download can never be mistaken for a complete one.
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part).map_err(|e| Error::Io {
        path: part.clone(),
        source: e,
    })?;

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Error::Download {
            url: url.into(),
            source: e,
        })?;
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| Error::Io {
            path: part.clone(),
            source: e,
        })?;
        received += chunk.len() as u64;
        on_progress(Progress {
            component: label.to_string(),
            received,
            total,
        });
    }
    file.flush().ok();
    drop(file);

    let actual = hex::encode(hasher.finalize());
    if actual != expected_sha256 {
        // Discard it. A mismatched artefact is never kept for inspection.
        let _ = std::fs::remove_file(&part);
        return Err(Error::ChecksumMismatch {
            component: label.to_string(),
            expected: expected_sha256.to_string(),
            actual,
        });
    }

    std::fs::rename(&part, dest).map_err(|e| Error::Io {
        path: dest.to_path_buf(),
        source: e,
    })?;
    Ok(actual)
}

pub(crate) fn extract_tar_gz(archive: &Path, into: &Path) -> Result<()> {
    let f = std::fs::File::open(archive).map_err(|e| Error::Io {
        path: archive.to_path_buf(),
        source: e,
    })?;
    let dec = flate2::read::GzDecoder::new(f);
    let mut tar = tar::Archive::new(dec);
    tar.set_preserve_permissions(true);
    tar.unpack(into).map_err(|e| Error::Io {
        path: into.to_path_buf(),
        source: e,
    })?;
    Ok(())
}

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = std::fs::read_dir(&dir).ok()?;
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().map(|n| n == name).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

fn make_executable(p: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = std::fs::metadata(p)
        .map_err(|e| Error::Io {
            path: p.to_path_buf(),
            source: e,
        })?
        .permissions();
    perm.set_mode(0o755);
    std::fs::set_permissions(p, perm).map_err(|e| Error::Io {
        path: p.to_path_buf(),
        source: e,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_minor_has_both_kinds_for_this_arch() {
        for m in PHP_MINORS {
            assert!(php_pin(m, "fpm").is_ok(), "no fpm pin for {m}");
            assert!(php_pin(m, "cli").is_ok(), "no cli pin for {m}");
        }
    }

    #[test]
    fn pins_are_https_and_look_like_digests() {
        for p in PHP_PINS {
            assert!(p.url.starts_with("https://"), "{} is not https", p.url);
            assert_eq!(p.sha256.len(), 64, "{} is not a sha256", p.sha256);
            assert!(p.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[tokio::test]
    async fn a_bad_digest_is_refused_and_writes_nothing() {
        let dir = std::env::temp_dir().join("nexora-test-digest");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.bin");

        let err = download_verified(
            "test asset",
            "https://dl.static-php.dev/static-php-cli/common/",
            &"0".repeat(64),
            &dest,
            |_| {},
        )
        .await
        .unwrap_err();

        assert!(matches!(err, Error::ChecksumMismatch { .. }), "got {err:?}");
        assert!(!dest.exists(), "a refused download must leave nothing behind");
        assert!(!dest.with_extension("part").exists(), "the partial must be discarded");
    }
}

pub use pins::{MysqlPin, WpCliPin, MYSQL_PINS, MYSQL_SERIES, WPCLI_PIN};

pub fn mysql_pin(series: &str) -> Result<&'static MysqlPin> {
    let a = arch();
    MYSQL_PINS
        .iter()
        .find(|p| p.series == series && p.arch == a)
        .ok_or_else(|| Error::other(format!("no MySQL {series} build pinned for {a}")))
}

/// Install a pinned MySQL. Same order as everything else: verify, then extract.
pub async fn install_mysql(
    series: &str,
    on_progress: impl Fn(Progress) + Send + 'static,
) -> Result<PathBuf> {
    let pin = mysql_pin(series)?;
    let dest = paths::runtime_dir("mysql", &format!("{}-{}", pin.version, pin.arch));
    if dest.join("bin/mysqld").exists() {
        return Ok(dest);
    }

    paths::ensure_dirs()?;
    let label = format!("MySQL {}", pin.version);
    let tmp = paths::downloads_cache().join(format!("mysql-{}-{}.tar.gz", pin.version, pin.arch));
    download_verified(&label, pin.url, pin.sha256, &tmp, on_progress).await?;

    let staging = dest.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    paths::mkdir_p(&staging)?;
    extract_tar_gz(&tmp, &staging)?;

    // The vendor tarball nests everything under mysql-<version>-<os>-<arch>/.
    let found = find_file(&staging, "mysqld")
        .ok_or_else(|| Error::other(format!("{label}: no `mysqld` in the extracted archive")))?;
    // bin/mysqld -> the tree root is two levels up.
    let root = found
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| Error::other(format!("{label}: unexpected archive layout")))?
        .to_path_buf();

    let _ = std::fs::remove_dir_all(&dest);
    paths::mkdir_p(dest.parent().unwrap())?;
    std::fs::rename(&root, &dest).map_err(|e| Error::Io {
        path: dest.clone(),
        source: e,
    })?;
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&tmp);
    let freed = trim_mysql(&dest);
    crate::log::info("mysql", &format!("{label} installed; {} MB of unused files removed", freed / 1_048_576));
    Ok(dest)
}

pub use latest::Release;
pub use pins::{AdminerPin, ToolPin, ADMINER_PIN, CLOUDFLARED_PINS, MAILPIT_PINS};

fn tool_pin(pins: &'static [ToolPin], name: &str) -> Result<&'static ToolPin> {
    let a = arch();
    pins.iter()
        .find(|p| p.arch == a)
        .ok_or_else(|| Error::other(format!("no {name} build pinned for {a}")))
}

pub fn mailpit_pin() -> Result<&'static ToolPin> {
    tool_pin(&MAILPIT_PINS, "Mailpit")
}
pub fn cloudflared_pin() -> Result<&'static ToolPin> {
    tool_pin(&CLOUDFLARED_PINS, "cloudflared")
}

/// The newest release of a single-binary tool: GitHub's latest, checked by
/// GitHub's digest, or this build's pin when GitHub cannot be asked.
pub async fn latest_tool(name: &str) -> Result<Release> {
    let (source, pin) = match name {
        "mailpit" => (latest::MAILPIT, mailpit_pin()?),
        "cloudflared" => (latest::CLOUDFLARED, cloudflared_pin()?),
        other => return Err(Error::other(format!("no release source for {other}"))),
    };
    Ok(latest::release(source, Release::from_pin(pin)).await)
}

/// The newest release of Adminer, the same way.
pub async fn latest_adminer() -> Release {
    latest::release(
        latest::ADMINER,
        Release {
            version: ADMINER_PIN.version.into(),
            url: ADMINER_PIN.url.into(),
            sha256: ADMINER_PIN.sha256.into(),
        },
    )
    .await
}

pub fn tool_binary(name: &str, version: &str) -> PathBuf {
    paths::runtime_dir(name, version).join(name)
}

/// The installed copies of a tool, newest first: `runtimes/<name>/<version>/<name>`.
pub fn installed_tools(name: &str) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = std::fs::read_dir(paths::runtimes().join(name))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let version = e.file_name().to_string_lossy().to_string();
            if !version.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return None; // "x.staging" and the like
            }
            let bin = e.path().join(name);
            bin.is_file().then_some((version, bin))
        })
        .filter(|(v, _)| v.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .collect();
    out.sort_by(|a, b| {
        if crate::updates::newer(&a.0, &b.0) {
            std::cmp::Ordering::Less
        } else if crate::updates::newer(&b.0, &a.0) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    out
}

/// The newest installed copy of a tool, whichever release that is.
pub fn installed_tool(name: &str) -> Option<(String, PathBuf)> {
    installed_tools(name).into_iter().next()
}

/// Remove every copy of a tool but `keep`, once a newer one is in place: old
/// releases are only ever disk space.
pub fn remove_other_tools(name: &str, keep: &str) {
    for (version, bin) in installed_tools(name) {
        if version != keep {
            if let Some(dir) = bin.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Install one release of a single-binary tool. Idempotent.
pub async fn install_tool(
    name: &str,
    release: &Release,
    on_progress: impl Fn(Progress) + Send + 'static,
) -> Result<PathBuf> {
    let dest_dir = paths::runtime_dir(name, &release.version);
    let bin = dest_dir.join(name);
    if bin.exists() {
        return Ok(bin);
    }
    paths::ensure_dirs()?;

    let label = format!("{name} {}", release.version);
    let tmp = paths::downloads_cache().join(format!("{name}-{}-{}.tgz", release.version, arch()));
    download_verified(&label, &release.url, &release.sha256, &tmp, on_progress).await?;

    let staging = dest_dir.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    paths::mkdir_p(&staging)?;
    let extracted = extract_tar_gz(&tmp, &staging);
    let _ = std::fs::remove_file(&tmp);
    extracted?;

    let found = find_file(&staging, name)
        .ok_or_else(|| Error::other(format!("{label}: no `{name}` in the archive")))?;
    paths::mkdir_p(&dest_dir)?;
    let _ = std::fs::remove_file(&bin);
    std::fs::rename(&found, &bin).map_err(|e| Error::Io {
        path: bin.clone(),
        source: e,
    })?;
    let _ = std::fs::remove_dir_all(&staging);
    make_executable(&bin)?;
    Ok(bin)
}

// ------------------------------------------------------------ mysql trim
//
// Oracle's macOS tarball is 639 MB unpacked, and more than half of it is
// never run by Nexora: a debug build of the server, the dictionaries of the
// Japanese full-text parser, a static client library, the debug plugins and
// the man pages and headers. They go as soon as the tree is installed; the
// server, the client tools, and the plugins MySQL actually loads stay.

/// What is removed from an installed MySQL, relative to its root.
const MYSQL_UNUSED: [&str; 7] = [
    "bin/mysqld-debug",
    "lib/mecab",
    "lib/libmysqlclient.a",
    "lib/plugin/debug",
    "man",
    "include",
    "docs",
];

/// Drop what Nexora never runs from a MySQL tree. Returns the bytes freed.
pub fn trim_mysql(root: &Path) -> u64 {
    // Only a tree that is recognisably MySQL's, with its server in place.
    if !root.join("bin/mysqld").is_file() {
        return 0;
    }
    let mut freed = 0;
    for rel in MYSQL_UNUSED {
        let p = root.join(rel);
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        let size = if meta.is_dir() { dir_size(&p) } else { meta.len() };
        let gone = if meta.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        if gone.is_ok() {
            freed += size;
        }
    }
    freed
}

/// Trim every MySQL already installed -- ones from before trimming existed.
/// Nothing a site uses is touched: data lives elsewhere, and the server
/// binary stays.
pub fn trim_installed_mysql() -> u64 {
    std::fs::read_dir(paths::runtimes().join("mysql"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().ends_with(".staging"))
        .map(|e| trim_mysql(&e.path()))
        .sum()
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => stack.push(e.path()),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}

#[cfg(test)]
mod trim_tests {
    use super::*;

    #[test]
    fn a_mysql_tree_loses_only_what_nexora_never_runs() {
        let root = std::env::temp_dir().join(format!("nexora-trim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["bin", "lib/mecab/dic", "lib/plugin/debug", "man/man1", "share"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        for f in ["bin/mysqld", "bin/mysql", "bin/mysqld-debug", "lib/libmysqlclient.a",
                  "lib/libmysqlclient.24.dylib", "lib/mecab/dic/x", "lib/plugin/auth.so",
                  "lib/plugin/debug/auth.so", "man/man1/mysqld.1", "share/errmsg.sys"] {
            std::fs::write(root.join(f), b"12345").unwrap();
        }
        assert_eq!(trim_mysql(&root), 25);
        for kept in ["bin/mysqld", "bin/mysql", "lib/libmysqlclient.24.dylib", "lib/plugin/auth.so", "share/errmsg.sys"] {
            assert!(root.join(kept).exists(), "{kept} must stay");
        }
        for gone in ["bin/mysqld-debug", "lib/mecab", "lib/libmysqlclient.a", "lib/plugin/debug", "man"] {
            assert!(!root.join(gone).exists(), "{gone} must go");
        }
        // A second pass has nothing left to do.
        assert_eq!(trim_mysql(&root), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_tree_without_a_server_is_left_alone() {
        let root = std::env::temp_dir().join(format!("nexora-trim-none-{}", std::process::id()));
        std::fs::create_dir_all(root.join("man")).unwrap();
        assert_eq!(trim_mysql(&root), 0);
        assert!(root.join("man").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    fn size_mb(p: &Path) -> u64 {
        let m = std::fs::symlink_metadata(p).map(|m| if m.is_dir() { dir_size(p) } else { m.len() }).unwrap_or(0);
        m / 1_048_576
    }

    /// Everything first-run setup installs, on a Mac that has none of it,
    /// and then a Mailpit update over an older release.
    /// `HOME=$(mktemp -d) cargo test -p nexora-core live_fresh_install -- --ignored --nocapture`
    #[test]
    #[ignore = "downloads PHP, MySQL, Mailpit, cloudflared, Adminer and WP-CLI"]
    fn live_fresh_install() {
        let home = std::env::var("HOME").unwrap();
        assert!(home.contains("tmp") || home.contains("/T/"), "run this with HOME set to a temporary directory, not {home}");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let minor = crate::db::DEFAULT_PHP;
        for kind in ["fpm", "cli"] {
            rt.block_on(install_php(minor, kind, |_| {})).expect("php");
        }
        let mysql = rt.block_on(install_mysql("8.4", |_| {})).expect("mysql");
        assert!(!mysql.join("bin/mysqld-debug").exists() && mysql.join("bin/mysqld").exists());
        rt.block_on(crate::mail::install(|_| {})).expect("mailpit");
        rt.block_on(crate::tunnel::install(|_| {})).expect("cloudflared");
        rt.block_on(crate::adminer::ensure(|_| {})).expect("adminer");
        rt.block_on(crate::wordpress::ensure_wp_cli(|_| {})).expect("wp-cli");

        let out = std::process::Command::new(mysql.join("bin/mysqld")).arg("--version").output().unwrap();
        println!("{}", String::from_utf8_lossy(&out.stdout).trim());
        let out = std::process::Command::new(crate::mail::binary().unwrap()).arg("version").output().unwrap();
        println!("{}", String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or(""));
        println!("mailpit {:?}, cloudflared {:?}, adminer {:?}, php {}",
            crate::mail::installed_version(), crate::tunnel::installed_version(),
            crate::adminer::installed_version(), php_pin(minor, "fpm").unwrap().patch);
        for c in ["php", "mysql", "mailpit", "cloudflared", "wp-cli"] {
            println!("  {c:12} {:>4} MB", size_mb(&paths::runtimes().join(c)));
        }
        println!("  {:12} {:>4} MB", "adminer", size_mb(&crate::adminer::dir()));
        println!("  {:12} {:>4} MB", "TOTAL", size_mb(&paths::root()));
        println!("  leftover downloads: {} MB", size_mb(&paths::downloads_cache()));

        // An older Mailpit, updated in place: the link moves, the old one goes.
        let latest = crate::mail::installed_version().unwrap();
        let old = Release::from_pin(&pins::ToolPin {
            version: "1.31.1",
            arch: "aarch64",
            url: "https://github.com/axllent/mailpit/releases/download/v1.31.1/mailpit-darwin-arm64.tar.gz",
            sha256: "71c10f33f36c78a2864c4df906f11736b092a80ad1371742bd4e90e65d778e1b",
        });
        rt.block_on(install_tool("mailpit", &old, |_| {})).unwrap();
        let sup = crate::supervisor::Supervisor::new();
        let latest_release = rt.block_on(latest_tool("mailpit")).unwrap();
        println!("{}", rt.block_on(crate::mail::update(&sup, &latest_release, |_| {})).unwrap());
        assert_eq!(crate::mail::installed_version().as_deref(), Some(latest.as_str()));
        assert_eq!(installed_tools("mailpit").len(), 1, "the old release is removed");
        assert!(crate::mail::binary().unwrap().ends_with("mailpit/current/mailpit"));
    }
}
