//! The newest release of a tool that publishes its own macOS builds on GitHub:
//! Adminer, Mailpit and cloudflared.
//!
//! GitHub records a SHA-256 for every release asset, so the newest release can
//! be installed and still be checked before anything is extracted -- without
//! a Nexora release for every upstream one. The asset is downloaded from the
//! vendor's own release, and its digest is GitHub's, never computed from what
//! was downloaded.
//!
//! When GitHub cannot be asked -- offline, rate-limited, or a release without
//! digests -- the release pinned into this build is used instead, so a first
//! run never depends on the API answering.

use super::{arch, pins::ToolPin};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One installable release: where it is and what it must hash to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    /// Without a leading "v": "1.31.2".
    pub version: String,
    pub url: String,
    pub sha256: String,
}

impl Release {
    pub fn from_pin(pin: &ToolPin) -> Self {
        Self {
            version: pin.version.to_string(),
            url: pin.url.to_string(),
            sha256: pin.sha256.to_string(),
        }
    }
}

/// What GitHub said, kept for an hour: a day's checks and installs ask once,
/// well inside the unauthenticated limit of 60 an hour.
static CACHE: Mutex<Option<HashMap<&'static str, (Instant, Release)>>> = Mutex::new(None);
const FRESH: Duration = Duration::from_secs(3600);

/// The GitHub repository and the asset a tool is installed from.
#[derive(Debug, Clone, Copy)]
pub struct Source {
    pub repo: &'static str,
    /// The asset's name, with `{v}` for the version and `{arch}` for
    /// GitHub-style architecture names ("arm64", "amd64").
    pub asset: &'static str,
}

pub const ADMINER: Source = Source { repo: "vrana/adminer", asset: "adminer-{v}-mysql-en.php" };
pub const MAILPIT: Source = Source { repo: "axllent/mailpit", asset: "mailpit-darwin-{arch}.tar.gz" };
pub const CLOUDFLARED: Source =
    Source { repo: "cloudflare/cloudflared", asset: "cloudflared-darwin-{arch}.tgz" };

fn github_arch() -> &'static str {
    if arch() == "aarch64" {
        "arm64"
    } else {
        "amd64"
    }
}

/// The newest release of `source`, or `fallback` when GitHub has no usable
/// answer.
pub async fn release(source: Source, fallback: Release) -> Release {
    if let Some((at, r)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(source.repo)).cloned() {
        if at.elapsed() < FRESH {
            return r;
        }
    }
    match ask_github(source).await {
        Some(r) => {
            // Never offer something older than what this build already pins.
            let r = if crate::updates::newer(&fallback.version, &r.version) { fallback } else { r };
            CACHE
                .lock()
                .unwrap()
                .get_or_insert_with(HashMap::new)
                .insert(source.repo, (Instant::now(), r.clone()));
            r
        }
        None => fallback,
    }
}

/// What the last lookup found, without asking again. For the places that
/// cannot wait on the network, like a status read.
pub fn cached(source: Source) -> Option<Release> {
    CACHE.lock().unwrap().as_ref()?.get(source.repo).map(|(_, r)| r.clone())
}

async fn ask_github(source: Source) -> Option<Release> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("Nexora/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let body = client
        .get(format!("https://api.github.com/repos/{}/releases/latest", source.repo))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    parse(&body, source, github_arch())
}

fn parse(body: &str, source: Source, arch: &str) -> Option<Release> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    if root.get("draft").and_then(|d| d.as_bool()) == Some(true)
        || root.get("prerelease").and_then(|d| d.as_bool()) == Some(true)
    {
        return None;
    }
    let tag = root.get("tag_name")?.as_str()?;
    let version = tag.trim_start_matches('v').to_string();
    if !version.chars().next().is_some_and(|c| c.is_ascii_digit())
        || !version.chars().all(|c| c.is_ascii_digit() || c == '.')
    {
        return None;
    }
    let name = source.asset.replace("{v}", &version).replace("{arch}", arch);
    let asset = root.get("assets")?.as_array()?.iter().find(|a| a.get("name").and_then(|n| n.as_str()) == Some(&name))?;
    let url = asset.get("browser_download_url")?.as_str()?;
    // Only the vendor's own release downloads, over HTTPS.
    let expected_prefix = format!("https://github.com/{}/releases/download/", source.repo);
    if !url.starts_with(&expected_prefix) {
        return None;
    }
    let sha256 = asset.get("digest")?.as_str()?.strip_prefix("sha256:")?.to_ascii_lowercase();
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(Release { version, url: url.to_string(), sha256 })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAILPIT_JSON: &str = r#"{
      "tag_name": "v1.31.2", "draft": false, "prerelease": false,
      "assets": [
        {"name": "mailpit-darwin-amd64.tar.gz",
         "browser_download_url": "https://github.com/axllent/mailpit/releases/download/v1.31.2/mailpit-darwin-amd64.tar.gz",
         "digest": "sha256:fba0c113a784573f4475e672a772cf00acc46ca68d7aa34fec28929b30c09df5"},
        {"name": "mailpit-darwin-arm64.tar.gz",
         "browser_download_url": "https://github.com/axllent/mailpit/releases/download/v1.31.2/mailpit-darwin-arm64.tar.gz",
         "digest": "sha256:d0180f1fc6e47908e80657dcf2aa1a3186c70ec45ae20a18243a3a46f618d3c6"}
      ]}"#;

    #[test]
    fn the_asset_for_this_mac_is_found_with_its_digest() {
        let r = parse(MAILPIT_JSON, MAILPIT, "arm64").unwrap();
        assert_eq!(r.version, "1.31.2");
        assert!(r.url.ends_with("mailpit-darwin-arm64.tar.gz"));
        assert_eq!(r.sha256, "d0180f1fc6e47908e80657dcf2aa1a3186c70ec45ae20a18243a3a46f618d3c6");
        assert_eq!(parse(MAILPIT_JSON, MAILPIT, "amd64").unwrap().sha256[..8], *"fba0c113");
    }

    #[test]
    fn a_release_without_a_digest_or_off_the_vendors_repo_is_refused() {
        let no_digest = MAILPIT_JSON.replace("\"digest\": \"sha256:d0180f1fc6e47908e80657dcf2aa1a3186c70ec45ae20a18243a3a46f618d3c6\"", "\"digest\": null");
        assert!(parse(&no_digest, MAILPIT, "arm64").is_none());
        let elsewhere = MAILPIT_JSON.replace("https://github.com/axllent/mailpit/releases/download/v1.31.2/mailpit-darwin-arm64", "https://example.com/mailpit-darwin-arm64");
        assert!(parse(&elsewhere, MAILPIT, "arm64").is_none());
        let pre = MAILPIT_JSON.replace("\"prerelease\": false", "\"prerelease\": true");
        assert!(parse(&pre, MAILPIT, "arm64").is_none());
    }

    #[test]
    fn adminer_names_its_asset_by_version() {
        let json = r#"{"tag_name": "v6.1.0", "assets": [{"name": "adminer-6.1.0-mysql-en.php",
          "browser_download_url": "https://github.com/vrana/adminer/releases/download/v6.1.0/adminer-6.1.0-mysql-en.php",
          "digest": "sha256:56fcf9374c2a858a7b9c7b283a251bea5dfc5c4b848fff3a803f7d3305383c8c"}]}"#;
        let r = parse(json, ADMINER, "arm64").unwrap();
        assert_eq!(r.version, "6.1.0");
    }

    /// `cargo test -p nexora-core live_latest -- --ignored --nocapture`
    #[test]
    #[ignore = "asks GitHub"]
    fn live_latest_releases() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for s in [ADMINER, MAILPIT, CLOUDFLARED] {
            println!("{} -> {:?}", s.repo, rt.block_on(ask_github(s)));
        }
    }
}
