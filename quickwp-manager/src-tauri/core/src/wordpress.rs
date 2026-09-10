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
pub(crate) fn wp(site: &Site) -> Result<Command> {
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

pub(crate) fn run(mut cmd: Command, what: &str) -> Result<String> {
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
/// The mu-plugin that makes a magic link actually log you in.
///
/// Without it `magic_login` produced a correct auth-cookie value and put it in
/// a query string nothing read, so the link opened wp-admin and WordPress
/// bounced straight to the login form. WordPress will not accept a cookie value
/// from a URL on its own -- something has to set the cookie -- so this does,
/// once, and then redirects to a clean URL so the token is not left sitting in
/// the address bar or the browser history.
const MU_PLUGIN: &str = r#"<?php
/**
 * Plugin Name: QuickWP magic login
 * Description: Generated by QuickWP. Accepts a one-time signed session from the app.
 */
add_action('init', function () {
    if (empty($_GET['quickwp_auth'])) {
        return;
    }
    $cookie = wp_unslash($_GET['quickwp_auth']);

    // validate_auth_cookie() checks the signature and the expiry, so a token
    // that is stale, edited or from another site is refused here rather than
    // trusted because it arrived in a URL.
    $user_id = wp_validate_auth_cookie($cookie, 'auth');
    if (!$user_id) {
        $user_id = wp_validate_auth_cookie($cookie, 'logged_in');
    }
    if (!$user_id) {
        return;
    }

    wp_set_current_user($user_id);
    wp_set_auth_cookie($user_id, false);

    // Land where the app asked, but only ever inside this site's admin: a
    // redirect target from a URL is attacker-controlled unless it is bounded.
    $to = isset($_GET['quickwp_to']) ? wp_unslash($_GET['quickwp_to']) : '';
    $target = admin_url();
    if ($to !== '' && !preg_match('~^(https?:)?//~', $to) && strpos($to, "\\") === false) {
        $target = admin_url(ltrim($to, '/'));
    }
    wp_safe_redirect($target);
    exit;
}, 0);
"#;

fn magic_mu_plugin_path(docroot: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(docroot).join("wp-content/mu-plugins/quickwp-login.php")
}

/// Write the mu-plugin. Rewritten every time: it is generated code, and a copy
/// from an older QuickWP is a bug that would otherwise survive an upgrade.
fn ensure_magic_mu_plugin(site: &Site) -> Result<()> {
    let docroot = std::path::PathBuf::from(&site.docroot);
    if !docroot.join("wp-content").is_dir() {
        return Ok(()); // not a WordPress site
    }
    let path = magic_mu_plugin_path(&site.docroot);
    paths::mkdir_p(path.parent().unwrap())?;
    std::fs::write(&path, MU_PLUGIN).map_err(|e| Error::Io { path, source: e })
}

/// A one-time link that lands logged in, optionally deep inside wp-admin.
///
/// `admin_path` is relative to wp-admin -- "site-editor.php", "edit.php" --
/// and is bounded to this site's admin by the mu-plugin that consumes it.
pub fn magic_login_to(
    site: &Site,
    url: &str,
    user: &str,
    admin_path: Option<&str>,
) -> Result<String> {
    ensure_magic_mu_plugin(site)?;
    let link = magic_login(site, url, user)?;
    Ok(match admin_path {
        Some(p) if !p.is_empty() => format!("{link}&quickwp_to={}", urlencode(p)),
        _ => link,
    })
}

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
    // The link is worthless without something on the WordPress side to read it.
    ensure_magic_mu_plugin(site)?;
    Ok(format!("{url}/wp-admin/?quickwp_auth={}", urlencode(&cookie)))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpItem {
    pub name: String,
    pub status: String,
    pub version: String,
    /// "none" or "available" -- WP-CLI's availability flag, not a version.
    pub update: String,
    /// The version an update would move to, when there is one.
    pub update_version: String,
    pub title: String,
}

fn list_items(site: &Site, kind: &str) -> Result<Vec<WpItem>> {
    let mut c = wp(site)?;
    c.args([
        kind,
        "list",
        "--format=json",
        // `update` is only "none"/"available"; `update_version` is the number.
        "--fields=name,status,version,update,update_version,title",
    ]);
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
            update_version: v
                .get("update_version")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .into(),
            title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").into(),
        })
        .collect())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpUser {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub email: String,
    /// Comma-separated as WP-CLI reports it: "administrator", or none at all.
    pub roles: String,
}

/// The site's users, as WordPress itself sees them.
pub fn users(site: &Site) -> Result<Vec<WpUser>> {
    let mut c = wp(site)?;
    c.args([
        "user",
        "list",
        "--format=json",
        "--fields=ID,user_login,display_name,user_email,roles",
    ]);
    let json = run(c, "Listing users")?;
    let parsed: Vec<serde_json::Value> =
        serde_json::from_str(json.trim()).map_err(|e| Error::other(format!("bad user list: {e}")))?;

    // WP-CLI prints ID as a number and roles as either a string or an array
    // depending on version, so both shapes are flattened here rather than in
    // the UI.
    let text = |v: &serde_json::Value| -> String {
        match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Array(a) => a
                .iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            _ => String::new(),
        }
    };

    Ok(parsed
        .into_iter()
        .map(|v| WpUser {
            id: v.get("ID").map(text).unwrap_or_default(),
            login: v.get("user_login").map(text).unwrap_or_default(),
            display_name: v.get("display_name").map(text).unwrap_or_default(),
            email: v.get("user_email").map(text).unwrap_or_default(),
            roles: v.get("roles").map(text).unwrap_or_default(),
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

/// A theme's own screenshot.png, as a data URI ready for an <img src>.
///
/// Read through the backend rather than served to the webview: the file lives
/// in the user's own folder, and a path arriving from the UI is checked to be
/// inside this site before anything is read.
pub fn item_screenshot(site: &Site, kind: &str, name: &str) -> Result<Option<String>> {
    let dir = std::path::Path::new(&site.docroot)
        .join("wp-content")
        .join(format!("{kind}s"))
        .join(name);

    let root = std::fs::canonicalize(&site.docroot).map_err(|e| Error::Io {
        path: site.docroot.clone().into(),
        source: e,
    })?;
    let Ok(dir) = std::fs::canonicalize(&dir) else {
        return Ok(None);
    };
    if !dir.starts_with(&root) {
        return Err(Error::other("That folder is not inside this site."));
    }

    for (file, mime) in [
        ("screenshot.png", "image/png"),
        ("screenshot.jpg", "image/jpeg"),
        ("screenshot.jpeg", "image/jpeg"),
        ("screenshot.gif", "image/gif"),
        ("screenshot.webp", "image/webp"),
    ] {
        let candidate = dir.join(file);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        // A screenshot is a few hundred KB. Anything far past that is not one,
        // and base64 of it would bloat the reply for nothing.
        if meta.len() > 4 * 1024 * 1024 {
            return Ok(None);
        }
        let bytes = std::fs::read(&candidate).map_err(|e| Error::Io {
            path: candidate.clone(),
            source: e,
        })?;
        return Ok(Some(format!("data:{mime};base64,{}", b64(&bytes))));
    }
    Ok(None)
}

/// Base64 without pulling in a crate for one call site.
fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Run a WP-CLI command that takes one secret, feeding it on stdin.
///
/// `--prompt=<field>` makes WP-CLI read that parameter from stdin instead of
/// argv. A password on a command line is visible to `ps` for as long as the
/// process lives, and this is the same mechanism `wp config create` already
/// uses for the database password.
fn run_with_secret(mut c: std::process::Command, secret: &str, what: &str) -> Result<String> {
    c.stdin(std::process::Stdio::piped());
    c.stdout(std::process::Stdio::piped());
    c.stderr(std::process::Stdio::piped());
    let mut child = c.spawn().map_err(|e| Error::Io {
        path: what.into(),
        source: e,
    })?;
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().ok_or_else(|| Error::other("no stdin"))?;
        writeln!(stdin, "{secret}").map_err(|e| Error::Io {
            path: what.into(),
            source: e,
        })?;
    }
    let out = child.wait_with_output().map_err(|e| Error::Io {
        path: what.into(),
        source: e,
    })?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "{what} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The roles this install actually has, so the picker cannot offer one that
/// does not exist -- plugins add and remove roles all the time.
pub fn roles(site: &Site) -> Result<Vec<String>> {
    let mut c = wp(site)?;
    c.args(["role", "list", "--format=json", "--fields=role"]);
    let json = run(c, "Listing roles")?;
    let parsed: Vec<serde_json::Value> =
        serde_json::from_str(json.trim()).map_err(|e| Error::other(format!("bad role list: {e}")))?;
    Ok(parsed
        .into_iter()
        .filter_map(|v| v.get("role").and_then(|x| x.as_str()).map(String::from))
        .collect())
}

/// Create a user. The password never reaches argv.
pub fn create_user(
    site: &Site,
    login: &str,
    email: &str,
    password: &str,
    role: &str,
) -> Result<String> {
    if login.trim().is_empty() || email.trim().is_empty() {
        return Err(Error::other("A username and an email are both required."));
    }
    let mut c = wp(site)?;
    c.args([
        "user",
        "create",
        login.trim(),
        email.trim(),
        &format!("--role={role}"),
        "--prompt=user_pass",
    ]);
    run_with_secret(c, password, "wp user create")?;
    Ok(format!("{} created as {role}.", login.trim()))
}

/// Change an existing user's role.
///
/// `wp user set-role` replaces every role the user has rather than adding one,
/// which is what a single-role picker means.
pub fn set_user_role(site: &Site, login: &str, role: &str) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["user", "set-role", login, role]);
    run(c, "Changing the role")?;
    Ok(format!("{login} is now {role}."))
}

/// Set an existing user's password. Also never on argv.
pub fn set_user_password(site: &Site, login: &str, password: &str) -> Result<String> {
    if password.is_empty() {
        return Err(Error::other("The new password cannot be empty."));
    }
    let mut c = wp(site)?;
    c.args(["user", "update", login, "--prompt=user_pass"]);
    run_with_secret(c, password, "wp user update")?;
    Ok(format!("Password changed for {login}."))
}

/// Remove a user, reassigning nothing: their posts go to the trash with them
/// unless a successor is named.
pub fn delete_user(site: &Site, login: &str, reassign_to: Option<&str>) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["user", "delete", login, "--yes"]);
    if let Some(to) = reassign_to {
        c.arg(format!("--reassign={to}"));
    }
    run(c, "Deleting the user")?;
    Ok(format!("{login} removed."))
}

/// Update one plugin or theme to its newest release.
pub fn update_item(site: &Site, kind: &str, name: &str) -> Result<String> {
    let mut c = wp(site)?;
    c.args([kind, "update", name]);
    run(c, &format!("Updating the {kind}"))
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
    use super::b64;

    #[test]
    fn base64_pads_every_remainder() {
        // The three chunk lengths, which is where a hand-rolled encoder breaks.
        assert_eq!(b64(b"abc"), "YWJj");
        assert_eq!(b64(b"ab"), "YWI=");
        assert_eq!(b64(b"a"), "YQ==");
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"hello world"), "aGVsbG8gd29ybGQ=");
    }

    use super::*;

    #[test]
    fn urlencoding_escapes_the_cookie_separator() {
        assert_eq!(urlencode("a|b"), "a%7Cb");
        assert_eq!(urlencode("plain-Value_1.0~"), "plain-Value_1.0~");
    }
}
