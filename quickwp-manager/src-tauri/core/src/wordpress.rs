//! The WordPress layer.
//!
//! WP-CLI is bundled rather than required: asking a user to install WP-CLI and
//! Composer before a WordPress tool works is asking them to do the tool's job.
//!
//! Everything here runs WP-CLI through the *site's own* PHP, so a site on 8.1
//! is managed by 8.1 and a site on 8.4 by 8.4. Running one bundled PHP against
//! every site would report the wrong version and hide version-specific breakage
//! -- exactly the breakage a local environment exists to surface.

use crate::{database, paths, runtime, site::Site, Error, Result};
use std::path::PathBuf;
use std::process::Command;

pub fn wp_cli_path() -> PathBuf {
    paths::runtimes().join("wp-cli").join("wp-cli.phar")
}

pub fn is_installed() -> bool {
    wp_cli_path().exists()
}

/// Fetch and verify WP-CLI. Idempotent.
pub async fn ensure_wp_cli(on_progress: impl Fn(runtime::Progress) + Send + 'static) -> Result<PathBuf> {
    let dest = wp_cli_path();
    if dest.exists() {
        return Ok(dest);
    }
    paths::mkdir_p(dest.parent().unwrap())?;
    runtime::download_verified(
        "WP-CLI",
        runtime::WPCLI_PIN.url,
        runtime::WPCLI_PIN.sha256,
        &dest,
        on_progress,
    )
    .await?;
    Ok(dest)
}

/// Build a WP-CLI invocation for a site, using that site's PHP.
fn wp(site: &Site) -> Result<Command> {
    let php = runtime::php_binary(&site.php_minor)?;
    let phar = wp_cli_path();
    if !phar.exists() {
        return Err(Error::NotInstalled {
            component: "WP-CLI".into(),
        });
    }
    let mut c = Command::new(php);
    // allow_url_fopen is what WP-CLI uses to reach wordpress.org.
    c.arg("-d").arg("allow_url_fopen=1");
    c.arg("-d").arg("memory_limit=512M");
    c.arg(phar);
    c.arg(format!("--path={}", site.docroot));
    // WP-CLI refuses to run as root by default; we never are, but sites linked
    // from odd locations trip its check.
    c.env("WP_CLI_CACHE_DIR", paths::root().join("cache/wp-cli"));
    Ok(c)
}

fn run(mut cmd: Command, what: &str) -> Result<String> {
    let out = cmd.output().map_err(|e| Error::Io {
        path: what.into(),
        source: e,
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // WP-CLI's own summary line is usually the useful part.
        let msg = stderr
            .lines()
            .find(|l| l.starts_with("Error:"))
            .map(|s| s.to_string())
            .unwrap_or_else(|| stderr.trim().to_string());
        return Err(Error::other(format!("{what} failed: {msg}")));
    }
    Ok(stdout)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct WpInstallRequest {
    pub title: String,
    pub admin_user: String,
    pub admin_email: String,
    /// Optional. When absent one is generated and returned once.
    pub admin_password: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpInstallResult {
    pub url: String,
    pub admin_user: String,
    /// Shown once. Never stored in the clear and never put on a command line.
    pub admin_password: String,
    pub db: database::DbCredentials,
}

/// The full install: core, database, wp-config.php, admin user.
pub fn install(
    site: &Site,
    req: &WpInstallRequest,
    db_series: &str,
    creds: &database::DbCredentials,
    url: &str,
) -> Result<WpInstallResult> {
    let _ = db_series;

    // 1. core
    // NOT --skip-content: that omits wp-content, leaving a site with no theme
    // that renders an empty page and reports zero plugins. The default themes
    // are what makes a fresh install look like WordPress.
    let mut c = wp(site)?;
    c.args(["core", "download", "--force"]);
    if let Some(v) = &req.version {
        if v != "latest" {
            c.arg(format!("--version={v}"));
        }
    }
    run(c, "Downloading WordPress")?;

    // 2. wp-config.php
    //
    // The password reaches PHP on stdin rather than argv: anything on a command
    // line is visible in `ps` and lands in shell history.
    let mut c = wp(site)?;
    c.args([
        "config",
        "create",
        "--force",
        &format!("--dbname={}", creds.name),
        &format!("--dbuser={}", creds.user),
        &format!("--dbhost={}:{}", creds.host, creds.port),
        "--skip-check",
        "--prompt=dbpass",
    ]);
    c.stdin(std::process::Stdio::piped());
    c.stdout(std::process::Stdio::piped());
    c.stderr(std::process::Stdio::piped());
    let mut child = c.spawn().map_err(|e| Error::Io {
        path: "wp config create".into(),
        source: e,
    })?;
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().ok_or_else(|| Error::other("no stdin"))?;
        writeln!(stdin, "{}", creds.password).map_err(|e| Error::Io {
            path: "wp config create".into(),
            source: e,
        })?;
    }
    let out = child.wait_with_output().map_err(|e| Error::Io {
        path: "wp config create".into(),
        source: e,
    })?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "Writing wp-config.php failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    // 3. install
    let password = req
        .admin_password
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(database::generate_password);

    let mut c = wp(site)?;
    c.args([
        "core",
        "install",
        &format!("--url={url}"),
        &format!("--title={}", req.title),
        &format!("--admin_user={}", req.admin_user),
        &format!("--admin_email={}", req.admin_email),
        "--skip-email",
    ]);
    c.arg(format!("--admin_password={password}"));
    run(c, "Installing WordPress")?;

    Ok(WpInstallResult {
        url: url.to_string(),
        admin_user: req.admin_user.clone(),
        admin_password: password,
        db: creds.clone(),
    })
}

/// Point an installed WordPress at a new address.
///
/// WordPress writes its own URL into the database and into generated markup,
/// so a site installed at one address serves redirects to it forever. Turning
/// on HTTPS changes the address, and without this every site would bounce
/// visitors back to the URL it was born with.
pub fn set_site_url(site: &Site, new_url: &str) -> Result<String> {
    let new_url = new_url.trim_end_matches('/');
    let mut c = wp(site)?;
    c.args(["option", "get", "home"]);
    let old = run(c, "Reading the site URL")?.trim().to_string();
    if old.is_empty() || old == new_url {
        return Ok(format!("Already at {new_url}"));
    }

    for key in ["home", "siteurl"] {
        let mut c = wp(site)?;
        c.args(["option", "update", key, new_url]);
        run(c, &format!("Setting {key}"))?;
    }
    // Content holds absolute URLs too -- a redirect alone leaves images and
    // links pointing at the old address.
    let mut c = wp(site)?;
    c.args(["search-replace", &old, new_url, "--all-tables", "--report-changed-only"]);
    let report = run(c, "Rewriting URLs in content")?;
    Ok(format!("{old} -> {new_url}\n{}", report.trim()))
}

pub fn is_wordpress(site: &Site) -> bool {
    PathBuf::from(&site.docroot).join("wp-includes/version.php").exists()
}

pub fn core_version(site: &Site) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["core", "version"]);
    Ok(run(c, "Reading the WordPress version")?.trim().to_string())
}

/// A one-click login link for wp-admin.
///
/// Creates a short-lived auth cookie through WordPress's own API rather than
/// inventing a token: the session is exactly as valid, and expires the way
/// WordPress expects.
pub fn magic_login(site: &Site, url: &str, user: &str) -> Result<String> {
    let php_snippet = format!(
        r#"$u = get_user_by('login', {user:?}) ?: get_users(['role'=>'administrator','number'=>1])[0] ?? null;
if (!$u) {{ WP_CLI::error('no administrator on this site'); }}
wp_set_current_user($u->ID);
$expiry = time() + 3600;
$token  = wp_generate_password(43, false, false);
$scheme = 'auth';
$pass_frag = substr($u->user_pass, 8, 4);
$key  = wp_hash($u->user_login . '|' . $pass_frag . '|' . $expiry . '|' . $token, $scheme);
$hash = hash_hmac('sha256', $u->user_login . '|' . $expiry . '|' . $token, $key);
WP_CLI::print_value($u->user_login . '|' . $expiry . '|' . $token . '|' . $hash);"#,
        user = user
    );
    let mut c = wp(site)?;
    c.args(["eval", &php_snippet]);
    let cookie = run(c, "Creating a login link")?.trim().to_string();
    if cookie.is_empty() {
        return Err(Error::other("WordPress returned no session"));
    }
    Ok(format!("{url}/wp-admin/?quickwp_auth={}", urlencode(&cookie)))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpItem {
    pub name: String,
    pub status: String,
    pub version: String,
    pub update: String,
    pub title: String,
}

fn list_items(site: &Site, kind: &str) -> Result<Vec<WpItem>> {
    let mut c = wp(site)?;
    c.args([kind, "list", "--format=json", "--fields=name,status,version,update,title"]);
    let json = run(c, &format!("Listing {kind}s"))?;
    let parsed: Vec<serde_json::Value> =
        serde_json::from_str(json.trim()).map_err(|e| Error::other(format!("bad {kind} list: {e}")))?;
    Ok(parsed
        .into_iter()
        .map(|v| WpItem {
            name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").into(),
            status: v.get("status").and_then(|x| x.as_str()).unwrap_or("").into(),
            version: v.get("version").and_then(|x| x.as_str()).unwrap_or("").into(),
            update: v.get("update").and_then(|x| x.as_str()).unwrap_or("none").into(),
            title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").into(),
        })
        .collect())
}

pub fn plugins(site: &Site) -> Result<Vec<WpItem>> {
    list_items(site, "plugin")
}
pub fn themes(site: &Site) -> Result<Vec<WpItem>> {
    list_items(site, "theme")
}

/// Install a plugin or theme from wp.org, a zip path, or a URL.
///
/// `--force` is never the default at any layer. When the folder is already
/// there WP-CLI's own summary is `Error: No plugins installed.` -- true,
/// unactionable, and the last thing you would see. So the caller is told what
/// is in the way and offers to replace it, rather than showing a red cross.
pub fn install_item(site: &Site, kind: &str, source: &str, activate: bool, force: bool) -> Result<String> {
    let mut c = wp(site)?;
    c.args([kind, "install", source]);
    if activate {
        c.arg("--activate");
    }
    if force {
        c.arg("--force");
    }
    match run(c, &format!("Installing the {kind}")) {
        Ok(o) => Ok(o),
        Err(e) => {
            let msg = e.to_string();
            if !force && (msg.contains("No plugins installed") || msg.contains("No themes installed")) {
                Err(Error::other(format!(
                    "`{source}` looks like it is already in wp-content. \
                     Replace it to overwrite what is there."
                )))
            } else {
                Err(e)
            }
        }
    }
}

pub fn set_item_state(site: &Site, kind: &str, name: &str, activate: bool) -> Result<String> {
    let mut c = wp(site)?;
    c.args([kind, if activate { "activate" } else { "deactivate" }, name]);
    run(c, &format!("Changing the {kind}"))
}

pub fn delete_item(site: &Site, kind: &str, name: &str) -> Result<String> {
    let mut c = wp(site)?;
    c.args([kind, "delete", name]);
    run(c, &format!("Deleting the {kind}"))
}

/// Search-replace, defaulting to a dry run.
///
/// The operation most likely to be right in intent and wrong in scope, so the
/// caller sees what it would do before it does it.
pub fn search_replace(site: &Site, from: &str, to: &str, dry_run: bool) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["search-replace", from, to, "--report-changed-only"]);
    if dry_run {
        c.arg("--dry-run");
    }
    run(c, "Search-replace")
}

/// Build a distributable zip into ~/Downloads.
pub fn dist_archive(site: &Site, dir: &str) -> Result<PathBuf> {
    let downloads = dirs::home_dir()
        .ok_or_else(|| Error::other("no home directory"))?
        .join("Downloads");
    paths::mkdir_p(&downloads)?;
    let mut c = wp(site)?;
    c.args(["package", "install", "wp-cli/dist-archive-command"]);
    let _ = c.output(); // best effort; already-installed is fine

    let mut c = wp(site)?;
    c.args(["dist-archive", dir]);
    c.arg(&downloads);
    run(c, "Building the zip")?;
    Ok(downloads)
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_escapes_the_cookie_separator() {
        assert_eq!(urlencode("a|b"), "a%7Cb");
        assert_eq!(urlencode("plain-Value_1.0~"), "plain-Value_1.0~");
    }
}
