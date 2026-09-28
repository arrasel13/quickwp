//! WordPress itself: fetched from wordpress.org, kept, and unpacked into a
//! new site.
//!
//! WP-CLI can download core on its own, but it does it through PHP's cURL with
//! one long timeout and no way back: a connection that stalls half way through
//! the 35 MB archive fails the whole site creation ten minutes later, with
//! nothing kept. This module does the download itself, so that:
//!
//! - a stalled transfer is noticed in seconds, not minutes, and **resumed**
//!   from where it stopped (wordpress.org serves ranges);
//! - the archive is **kept**, so every site after the first unpacks from disk
//!   and is ready at once;
//! - it is **checked** against the SHA-1 wordpress.org publishes beside it.
//!
//! The archive is fetched in the background at launch, so by the time anyone
//! creates a site it is usually already here.

use crate::{paths, runtime, Error, Result};
use futures_util::StreamExt;
use sha1::{Digest, Sha1};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where releases are kept, one archive per version.
pub fn cache_dir() -> PathBuf {
    paths::runtimes().join("wordpress")
}

fn archive_path(version: &str) -> PathBuf {
    cache_dir().join(format!("wordpress-{version}.tar.gz"))
}

fn url_for(version: &str) -> String {
    format!("https://downloads.wordpress.org/release/wordpress-{version}.tar.gz")
}

/// A version is `6`, `6.8` or `6.8.1`, and nothing else: it goes into a URL.
pub fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 16
        && v.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("Nexora/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| Error::Download {
            url: "wordpress.org".into(),
            source: e,
        })
}

/// The release wordpress.org offers now, from its version-check API.
pub async fn latest_version() -> Result<String> {
    let body = client()?
        .get("https://api.wordpress.org/core/version-check/1.7/")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| Error::Download {
            url: "api.wordpress.org".into(),
            source: e,
        })?
        .text()
        .await
        .map_err(|e| Error::Download {
            url: "api.wordpress.org".into(),
            source: e,
        })?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| Error::other(format!("wordpress.org sent no version: {e}")))?;
    let v = json["offers"]
        .as_array()
        .and_then(|offers| offers.iter().find_map(|o| o["current"].as_str()))
        .ok_or_else(|| Error::other("wordpress.org named no current release"))?;
    if !valid_version(v) {
        return Err(Error::other(format!("wordpress.org named release {v:?}")));
    }
    Ok(v.to_string())
}

/// The digest published beside the archive. None when it cannot be read: a
/// missing checksum file is not a reason to refuse a release.
async fn published_sha1(version: &str) -> Option<String> {
    let text = client()
        .ok()?
        .get(format!("{}.sha1", url_for(version)))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    let sum = text.split_whitespace().next()?.to_lowercase();
    (sum.len() == 40 && sum.chars().all(|c| c.is_ascii_hexdigit())).then_some(sum)
}

fn sha1_of(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path).map_err(|e| Error::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let mut hasher = Sha1::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| Error::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    Ok(hex::encode(hasher.finalize()))
}

/// No byte for this long means the transfer has stalled: it is dropped and
/// picked up again from where it stopped, rather than waited out.
const STALL: Duration = Duration::from_secs(30);
const ATTEMPTS: usize = 4;

/// This release's archive, downloaded if it is not here already.
///
/// `version` is a release, or None for the newest one. Progress is reported
/// while it downloads; nothing is reported when it is already on disk.
pub async fn ensure(
    version: Option<&str>,
    on_progress: impl Fn(runtime::Progress) + Send + Sync + 'static,
) -> Result<PathBuf> {
    let version = match version.map(str::trim).filter(|v| !v.is_empty() && *v != "latest") {
        Some(v) if valid_version(v) => v.to_string(),
        Some(v) => return Err(Error::other(format!("{v} is not a WordPress version"))),
        None => latest_version().await?,
    };
    let dest = archive_path(&version);
    if dest.exists() {
        return Ok(dest);
    }
    paths::mkdir_p(&cache_dir())?;

    let url = url_for(&version);
    let part = dest.with_extension("part");
    let expected = published_sha1(&version).await;
    let label = format!("WordPress {version}");
    let mut last: Option<Error> = None;

    for attempt in 0..ATTEMPTS {
        // Whatever the last attempt got stays on disk and is asked for again
        // from that byte on.
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        match fetch(&url, &part, have, &label, &on_progress).await {
            Ok(()) => {
                if let Some(want) = &expected {
                    let got = sha1_of(&part)?;
                    if &got != want {
                        // Kept nothing: a half-written archive that is wrong
                        // must not be resumed into looking right.
                        let _ = std::fs::remove_file(&part);
                        last = Some(Error::other(format!(
                            "The WordPress {version} download did not match wordpress.org's checksum."
                        )));
                        continue;
                    }
                }
                std::fs::rename(&part, &dest).map_err(|e| Error::Io {
                    path: dest.clone(),
                    source: e,
                })?;
                return Ok(dest);
            }
            Err(e) => {
                last = Some(e);
                if attempt + 1 < ATTEMPTS {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| Error::other("WordPress could not be downloaded")))
}

/// One try at the rest of the archive, appending to `part`.
async fn fetch(
    url: &str,
    part: &Path,
    have: u64,
    label: &str,
    on_progress: &(impl Fn(runtime::Progress) + Send + Sync + 'static),
) -> Result<()> {
    let mut req = client()?.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let down = |e: reqwest::Error| Error::Download {
        url: url.into(),
        source: e,
    };
    let resp = req.send().await.and_then(|r| r.error_for_status()).map_err(down)?;

    // Asked to continue and answered with the whole file: start over rather
    // than append the beginning to the middle.
    let resuming = have > 0 && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut received = if resuming { have } else { 0 };
    let total = resp.content_length().map(|len| received + len);

    let mut file = if resuming {
        std::fs::OpenOptions::new().append(true).open(part)
    } else {
        std::fs::File::create(part)
    }
    .map_err(|e| Error::Io {
        path: part.to_path_buf(),
        source: e,
    })?;

    let mut stream = resp.bytes_stream();
    loop {
        let next = tokio::time::timeout(STALL, stream.next())
            .await
            .map_err(|_| Error::other(format!("{label}: the download stopped responding")))?;
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(down)?;
        file.write_all(&chunk).map_err(|e| Error::Io {
            path: part.to_path_buf(),
            source: e,
        })?;
        received += chunk.len() as u64;
        on_progress(runtime::Progress {
            component: label.to_string(),
            received,
            total,
        });
    }
    file.flush().ok();
    Ok(())
}

/// Unpack a release into a site's folder.
///
/// The archive holds one `wordpress/` directory; its contents -- not the
/// directory -- become the site.
pub fn unpack(archive: &Path, docroot: &Path) -> Result<()> {
    let staging = cache_dir().join(format!(
        "unpack-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&staging);
    paths::mkdir_p(&staging)?;
    let result = (|| {
        runtime::extract_tar_gz(archive, &staging)?;
        let root = staging.join("wordpress");
        if !root.join("wp-settings.php").exists() {
            return Err(Error::other("the WordPress archive held no wp-settings.php"));
        }
        paths::mkdir_p(docroot)?;
        for entry in std::fs::read_dir(&root).map_err(|e| Error::Io {
            path: root.clone(),
            source: e,
        })? {
            let entry = entry.map_err(|e| Error::Io {
                path: root.clone(),
                source: e,
            })?;
            let to = docroot.join(entry.file_name());
            // Replaced, like `wp core download --force`: wp-content included,
            // so a half-finished attempt cannot leave a mixed tree behind.
            let _ = std::fs::remove_dir_all(&to);
            let _ = std::fs::remove_file(&to);
            std::fs::rename(entry.path(), &to).map_err(|e| Error::Io {
                path: to.clone(),
                source: e,
            })?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Fetch the newest release into the cache, quietly. Called at launch, so
/// creating the first site does not wait on 35 MB.
pub async fn warm() {
    if let Err(e) = ensure(None, |_| {}).await {
        crate::log::info("wordpress", &format!("release not fetched ahead of time: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_digits_and_dots() {
        assert!(valid_version("6"));
        assert!(valid_version("6.8.1"));
        assert!(!valid_version("6.8.1; rm -rf /"));
        assert!(!valid_version("../../etc"));
        assert!(!valid_version("latest"));
        assert!(!valid_version(""));
    }

    #[test]
    fn a_release_has_one_url_and_one_place_on_disk() {
        assert_eq!(
            url_for("6.8.1"),
            "https://downloads.wordpress.org/release/wordpress-6.8.1.tar.gz"
        );
        assert!(archive_path("6.8.1").ends_with("wordpress/wordpress-6.8.1.tar.gz"));
    }

    /// A download that stopped half way is continued, not started again.
    /// `cargo test -p nexora-core live_wordpress_resumes -- --ignored --nocapture`
    #[test]
    #[ignore = "downloads WordPress from wordpress.org"]
    fn live_wordpress_resumes_a_half_finished_download() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let version = rt.block_on(latest_version()).expect("latest");
        let dest = archive_path(&version);
        let whole = rt.block_on(ensure(None, |_| {})).expect("first download");
        let want = sha1_of(&whole).expect("digest");
        let size = std::fs::metadata(&whole).unwrap().len();

        // Half of it, left behind as an interrupted attempt would.
        let part = dest.with_extension("part");
        let bytes = std::fs::read(&whole).unwrap();
        let half = (size / 2) as usize;
        std::fs::write(&part, &bytes[..half]).unwrap();
        std::fs::remove_file(&dest).unwrap();

        let from = std::sync::Arc::new(std::sync::Mutex::new(u64::MAX));
        let seen = from.clone();
        let again = rt
            .block_on(ensure(None, move |p| {
                let mut f = seen.lock().unwrap();
                *f = (*f).min(p.received);
            }))
            .expect("resumed download");
        let first = *from.lock().unwrap();
        println!("kept {half} bytes, carried on from {first} of {size}");
        assert!(first >= half as u64, "it started again from the beginning");
        assert_eq!(sha1_of(&again).unwrap(), want, "the resumed archive is the release");
    }

    /// `cargo test -p nexora-core live_wordpress -- --ignored --nocapture`
    #[test]
    #[ignore = "downloads WordPress from wordpress.org"]
    fn live_wordpress_downloads_and_unpacks() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let latest = rt.block_on(latest_version()).expect("latest");
        println!("latest is {latest}");
        let archive = rt.block_on(ensure(None, |p| {
            if p.received % (4 * 1024 * 1024) < 65536 {
                println!("  {} MB", p.received / 1_048_576);
            }
        }))
        .expect("download");
        println!("archive: {}", archive.display());
        let into = std::env::temp_dir().join("nexora-wpcore-test");
        let _ = std::fs::remove_dir_all(&into);
        unpack(&archive, &into).expect("unpack");
        assert!(into.join("wp-settings.php").exists());
        assert!(into.join("wp-content/themes").exists());
        println!("unpacked into {}", into.display());
        let _ = std::fs::remove_dir_all(&into);
    }
}
