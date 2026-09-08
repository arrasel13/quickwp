//! Runtime supply: fetch a pinned component, verify it, make it runnable.
//!
//! The order of operations is the whole point and is not negotiable:
//!
//!   download -> hash while streaming -> compare to the pin -> only then extract
//!
//! A failed or cancelled download must leave the previous version exactly where
//! it was. Extracting first and verifying after would mean a corrupt or hostile
//! tarball had already touched the tree.

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
        .user_agent(concat!("QuickWP/", env!("CARGO_PKG_VERSION")))
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

fn extract_tar_gz(archive: &Path, into: &Path) -> Result<()> {
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
        let dir = std::env::temp_dir().join("quickwp-test-digest");
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
