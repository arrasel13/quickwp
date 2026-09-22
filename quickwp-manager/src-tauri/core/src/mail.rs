//! Mail catching.
//!
//! Every message a site sends is caught and none are delivered. Local
//! development that *can* send real mail eventually does -- usually a password
//! reset to a client's address still sitting in a test order.
//!
//! Three carriers have to be intercepted, because each is a different way an
//! application escapes:
//!
//! 1. PHP's own `mail()` -- caught by the pool's `sendmail_path`.
//! 2. A WordPress SMTP plugin -- WP Mail SMTP, FluentSMTP and every plugin of
//!    that shape hook `phpmailer_init` and call `isSMTP()`, after which
//!    PHPMailer opens its own socket and the shim never sees the message. A
//!    mu-plugin hooking the same filter *last* points it back at Mailpit.
//! 3. Laravel -- ignores php.ini entirely, so the pool carries `MAIL_*` in the
//!    process environment, which outranks `.env`.

use crate::{paths, ports, runtime, supervisor::Supervisor, Error, Result};
use std::path::PathBuf;

pub const SERVICE: &str = "mailpit";

/// Where Mailpit is run from: a link that always points at the installed
/// release. PHP pools write this path into `sendmail_path`, so it has to stay
/// the same when Mailpit is updated underneath it.
fn current_link() -> PathBuf {
    paths::runtimes().join("mailpit").join("current")
}

pub fn binary() -> Result<PathBuf> {
    let link = current_link().join("mailpit");
    if link.is_file() {
        return Ok(link);
    }
    // Installed by a Nexora from before the link, or the link went missing.
    match runtime::installed_tool("mailpit") {
        Some((version, bin)) => Ok(point_current_at(&version).map(|_| current_link().join("mailpit")).unwrap_or(bin)),
        None => Err(Error::NotInstalled {
            component: "Mailpit".into(),
        }),
    }
}

/// Point `current` at an installed release, replacing the link in one step.
fn point_current_at(version: &str) -> Result<()> {
    let link = current_link();
    let tmp = link.with_extension("new");
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(version, &tmp).map_err(|e| Error::Io { path: tmp.clone(), source: e })?;
    std::fs::rename(&tmp, &link).map_err(|e| Error::Io { path: link.clone(), source: e })
}

pub fn is_installed() -> bool {
    binary().is_ok()
}

/// The release that is installed: "1.31.2".
pub fn installed_version() -> Option<String> {
    let target = std::fs::read_link(current_link()).ok()?;
    let v = target.to_string_lossy().to_string();
    if runtime::installed_tools("mailpit").iter().any(|(have, _)| *have == v) {
        Some(v)
    } else {
        runtime::installed_tool("mailpit").map(|(v, _)| v)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MailStatus {
    pub installed: bool,
    pub running: bool,
    pub smtp_port: u16,
    pub ui_port: u16,
    pub ui_url: String,
    pub catch_all: bool,
}

pub fn status(sup: &Supervisor, catch_all: bool) -> MailStatus {
    MailStatus {
        installed: is_installed(),
        running: sup.is_running(SERVICE) || running_unsupervised().is_some(),
        smtp_port: ports::MAILPIT_SMTP,
        ui_port: ports::MAILPIT_UI,
        ui_url: format!("http://127.0.0.1:{}", ports::MAILPIT_UI),
        catch_all,
    }
}

/// Install the newest Mailpit. Idempotent: one already here is kept.
pub async fn install(on_progress: impl Fn(runtime::Progress) + Send + 'static) -> Result<PathBuf> {
    if is_installed() {
        return binary();
    }
    let release = runtime::latest_tool("mailpit").await?;
    runtime::install_tool("mailpit", &release, on_progress).await?;
    point_current_at(&release.version)?;
    crate::log::info("mail", &format!("Mailpit {} installed", release.version));
    binary()
}

/// Move to a newer Mailpit: install it beside the old one, switch the link,
/// restart Mailpit if it was running, and only then remove the old release.
/// The inbox is kept -- it lives in mailpit.db, outside the release.
pub async fn update(
    sup: &Supervisor,
    release: &runtime::Release,
    on_progress: impl Fn(runtime::Progress) + Send + 'static,
) -> Result<String> {
    let before = installed_version().unwrap_or_default();
    runtime::install_tool("mailpit", release, on_progress).await?;
    let was_running = sup.is_running(SERVICE) || running_unsupervised().is_some();
    if was_running {
        stop(sup)?;
    }
    point_current_at(&release.version)?;
    runtime::remove_other_tools("mailpit", &release.version);
    if was_running {
        start(sup)?;
    }
    crate::log::info("mail", &format!("Mailpit updated from {before} to {}", release.version));
    Ok(format!("Mailpit updated to {}.", release.version))
}

/// A Mailpit this Nexora did not start but can use: this install's own binary
/// listening on this install's inbox port. A Nexora that quit or was replaced
/// without stopping it leaves one behind, and refusing to start next to it
/// showed "Mailpit stopped" over a Mailpit that was running fine. Its pid.
pub fn running_unsupervised() -> Option<u32> {
    if !ports::is_listening(ports::MAILPIT_UI) {
        return None;
    }
    let pid = ports::holder_pid(ports::MAILPIT_UI)?;
    // Any release of this install's Mailpit, by the link or by a versioned
    // path an older Nexora started it from.
    let ours = paths::runtimes().join("mailpit");
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .contains(&*ours.to_string_lossy())
        .then_some(pid)
}

pub fn start(sup: &Supervisor) -> Result<u16> {
    if sup.is_running(SERVICE) {
        return Ok(ports::MAILPIT_UI);
    }
    if let Some(pid) = running_unsupervised() {
        crate::log::info("mail", &format!("Mailpit already running (pid {pid}); using it"));
        return Ok(ports::MAILPIT_UI);
    }
    let db = paths::root().join("mailpit.db");
    sup.start(
        SERVICE,
        &binary()?,
        &[
            "--smtp".into(),
            format!("127.0.0.1:{}", ports::MAILPIT_SMTP),
            "--listen".into(),
            format!("127.0.0.1:{}", ports::MAILPIT_UI),
            "--database".into(),
            db.to_string_lossy().into_owned(),
        ],
        Some(ports::MAILPIT_UI),
        Some(paths::logs().join("mailpit.log")),
    )?;

    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", ports::MAILPIT_UI)).is_ok() {
            crate::log::info(
                "mail",
                &format!("Mailpit started: SMTP on {}, inbox on {}", ports::MAILPIT_SMTP, ports::MAILPIT_UI),
            );
            return Ok(ports::MAILPIT_UI);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = sup.stop(SERVICE);
    Err(Error::other(
        "Mailpit started but never answered on its web port. See logs/mailpit.log",
    ))
}

/// Stop Mailpit: the one this Nexora started, or one it is using that an
/// earlier Nexora left running.
pub fn stop(sup: &Supervisor) -> Result<bool> {
    let stopped = sup.stop(SERVICE)?;
    if let Some(pid) = running_unsupervised() {
        crate::proc::kill_tree(pid);
        crate::log::info("mail", &format!("stopped the Mailpit an earlier Nexora left running (pid {pid})"));
        return Ok(true);
    }
    Ok(stopped)
}

/// The `sendmail_path` a pool uses when the catch-all is on.
///
/// PHP hands this to popen, so the binary path is single-quoted: Nexora lives
/// under "Application Support", and an unquoted path with a space becomes two
/// arguments and a mail that silently never sends.
pub fn sendmail_path() -> Result<String> {
    Ok(format!(
        "'{}' sendmail -t --smtp-addr 127.0.0.1:{}",
        binary()?.display(),
        ports::MAILPIT_SMTP
    ))
}

/// The same environment, encoded for a php-fpm pool.
///
/// php-fpm refuses `env[X] = ` *and* `env[X] = ""` with "empty value", and then
/// will not start at all -- so an unset MAIL_USERNAME would take every pool
/// down with it. Laravel reads `(null)` as an explicit null, which is exactly
/// what an absent username means, and keeps the precedence that makes this work
/// at all: a variable present in the environment is never overwritten by .env.
pub fn fpm_env() -> Vec<(String, String)> {
    laravel_env()
        .into_iter()
        .map(|(k, v)| {
            let v = if v.is_empty() { "(null)".to_string() } else { v };
            (k, v)
        })
        .collect()
}

/// The environment a pool carries so Laravel is caught too.
///
/// Laravel's sendmail transport does not consult php.ini -- `MAIL_MAILER=sendmail`
/// exits 0, reports success and delivers nothing. The lever that works is
/// Laravel's own precedence: a variable already in the process environment is
/// never overwritten by `.env`.
pub fn laravel_env() -> Vec<(String, String)> {
    let host = "127.0.0.1".to_string();
    let port = ports::MAILPIT_SMTP.to_string();
    vec![
        ("MAIL_MAILER".into(), "smtp".into()),
        ("MAIL_DRIVER".into(), "smtp".into()),
        ("MAIL_HOST".into(), host.clone()),
        ("MAIL_PORT".into(), port.clone()),
        ("MAIL_USERNAME".into(), String::new()),
        ("MAIL_PASSWORD".into(), String::new()),
        ("MAIL_ENCRYPTION".into(), String::new()),
        ("MAIL_SCHEME".into(), "smtp".into()),
        ("MAIL_URL".into(), format!("smtp://{host}:{port}")),
    ]
}

/// The mu-plugin that catches SMTP plugins.
///
/// Hooks `phpmailer_init` at the lowest possible priority so it runs *after*
/// a plugin has called `isSMTP()` and pointed PHPMailer at a real provider.
pub const MU_PLUGIN: &str = r#"<?php
/**
 * Plugin Name: Nexora Mail Catcher
 * Description: Routes every message this site sends to Mailpit instead of the internet.
 *
 * Written by Nexora. Removing the catch-all switch removes this file.
 */
add_action('phpmailer_init', function ($phpmailer) {
    // Runs last on purpose: an SMTP plugin has already called isSMTP() and
    // pointed PHPMailer at a real provider by now, and this puts it back.
    $phpmailer->isSMTP();
    $phpmailer->Host       = '127.0.0.1';
    $phpmailer->Port       = NEXORA_MAILPIT_PORT;
    $phpmailer->SMTPAuth   = false;
    $phpmailer->SMTPSecure = '';
    $phpmailer->SMTPAutoTLS = false;
    // Tags the message with this site, so the site's Mail tab finds it
    // whatever address it was sent from or to.
    $phpmailer->addCustomHeader('X-Tags', 'NEXORA_SITE_TAG');
}, PHP_INT_MAX);
"#;

fn mu_plugin_path(docroot: &str) -> PathBuf {
    PathBuf::from(docroot).join("wp-content/mu-plugins/nexora-mail.php")
}

/// Install or remove the mu-plugin for one site.
///
/// Absent is treated as ON deliberately: a site created before the switch
/// existed is caught too, because "every site's mail is caught" must not
/// quietly mean "every site created after you found the switch".
pub fn set_site_catch(docroot: &str, domain: &str, on: bool) -> Result<()> {
    crate::legacy::remove_old_mu_plugins(docroot);
    let path = mu_plugin_path(docroot);
    if !on {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if !PathBuf::from(docroot).join("wp-content").is_dir() {
        return Ok(()); // not a WordPress site; the sendmail shim covers it
    }
    paths::mkdir_p(path.parent().unwrap())?;
    // A domain is letters, digits, dots and dashes; anything else is dropped
    // rather than written into PHP.
    let tag: String = domain
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    let body = MU_PLUGIN
        .replace("NEXORA_MAILPIT_PORT", &ports::MAILPIT_SMTP.to_string())
        .replace("NEXORA_SITE_TAG", &tag);
    std::fs::write(&path, body).map_err(|e| Error::Io { path, source: e })
}

// ------------------------------------------------------------------ reading

/// One address on a message, as Mailpit reports it.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct MailAddress {
    #[serde(rename = "Name", default)]
    pub name: String,
    #[serde(rename = "Address", default)]
    pub address: String,
}

/// A message in a list: enough to show it, not its body.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct MailSummary {
    #[serde(rename = "ID")]
    pub id: String,
    #[serde(rename = "From", default)]
    pub from: Option<MailAddress>,
    #[serde(rename = "To", default)]
    pub to: Option<Vec<MailAddress>>,
    #[serde(rename = "Subject", default)]
    pub subject: String,
    #[serde(rename = "Created", default)]
    pub created: String,
    #[serde(rename = "Read", default)]
    pub read: bool,
    #[serde(rename = "Snippet", default)]
    pub snippet: String,
    #[serde(rename = "Attachments", default)]
    pub attachments: u32,
    #[serde(rename = "Tags", default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MailList {
    pub messages: Vec<MailSummary>,
    pub total: usize,
    pub unread: usize,
}

/// One message, whole.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct MailMessage {
    #[serde(rename = "ID")]
    pub id: String,
    #[serde(rename = "From", default)]
    pub from: Option<MailAddress>,
    #[serde(rename = "To", default)]
    pub to: Option<Vec<MailAddress>>,
    #[serde(rename = "Cc", default)]
    pub cc: Option<Vec<MailAddress>>,
    #[serde(rename = "Subject", default)]
    pub subject: String,
    #[serde(rename = "Date", default)]
    pub date: String,
    #[serde(rename = "HTML", default)]
    pub html: String,
    #[serde(rename = "Text", default)]
    pub text: String,
    #[serde(rename = "Attachments", default)]
    pub attachments: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct Listing {
    #[serde(default)]
    messages: Vec<MailSummary>,
}

fn api(path: &str) -> String {
    format!("http://127.0.0.1:{}/api/v1/{path}", ports::MAILPIT_UI)
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| Error::other(format!("could not make a mail client: {e}")))
}

async fn fetch(req: reqwest::RequestBuilder) -> Result<String> {
    let resp = req
        .send()
        .await
        .map_err(|e| Error::other(format!("Mailpit did not answer: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| Error::other(format!("Mailpit's answer was cut off: {e}")))?;
    if !status.is_success() {
        return Err(Error::other(format!("Mailpit answered {status}: {}", body.trim())));
    }
    Ok(body)
}

/// Mailpit ids are letters and digits; anything else never reaches a URL.
fn check_id(id: &str) -> Result<()> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(Error::other("that is not a Mailpit message id"))
    }
}

async fn search(c: &reqwest::Client, query: &str) -> Result<Vec<MailSummary>> {
    let req = if query.is_empty() {
        c.get(api("messages")).query(&[("limit", "500")])
    } else {
        c.get(api("search")).query(&[("query", query), ("limit", "500")])
    };
    let body = fetch(req).await?;
    serde_json::from_str::<Listing>(&body)
        .map(|l| l.messages)
        .map_err(|e| Error::other(format!("Mailpit's list could not be read: {e}")))
}

/// The search words that find one site's mail: tagged with its name by the
/// mail plugin, or sent from or to its domain -- plain `mail()` and
/// non-WordPress sites carry no tag.
fn site_terms(name: &str) -> [String; 3] {
    [format!("tag:\"{name}\""), format!("from:{name}"), format!("to:{name}")]
}

/// A site's messages -- `names` is its domain and aliases -- or every message
/// when `names` is empty, newest first. `query` narrows it with Mailpit's own
/// search words.
pub async fn list(names: &[String], query: &str) -> Result<MailList> {
    let c = client()?;
    let query = query.trim();
    let mut messages: Vec<MailSummary> = Vec::new();
    if names.is_empty() {
        messages = search(&c, query).await?;
    } else {
        let mut seen = std::collections::HashSet::new();
        for name in names {
            for term in site_terms(name) {
                let q = if query.is_empty() { term } else { format!("{term} {query}") };
                for m in search(&c, &q).await? {
                    if seen.insert(m.id.clone()) {
                        messages.push(m);
                    }
                }
            }
        }
        // Mailpit stamps every message in this machine's zone, so the
        // timestamps order as text.
        messages.sort_by(|a, b| b.created.cmp(&a.created));
    }
    let unread = messages.iter().filter(|m| !m.read).count();
    Ok(MailList { total: messages.len(), unread, messages })
}

pub async fn message(id: &str) -> Result<MailMessage> {
    check_id(id)?;
    let body = fetch(client()?.get(api(&format!("message/{id}")))).await?;
    serde_json::from_str(&body).map_err(|e| Error::other(format!("the message could not be read: {e}")))
}

pub async fn raw(id: &str) -> Result<String> {
    check_id(id)?;
    fetch(client()?.get(api(&format!("message/{id}/raw")))).await
}

pub async fn headers(id: &str) -> Result<std::collections::BTreeMap<String, Vec<String>>> {
    check_id(id)?;
    let body = fetch(client()?.get(api(&format!("message/{id}/headers")))).await?;
    serde_json::from_str(&body).map_err(|e| Error::other(format!("the headers could not be read: {e}")))
}

/// Mark messages read. An empty list means every message, as Mailpit reads it.
pub async fn mark_read(ids: &[String]) -> Result<()> {
    for id in ids {
        check_id(id)?;
    }
    let body = serde_json::json!({ "IDs": ids, "Read": true }).to_string();
    fetch(client()?.put(api("messages")).header("Content-Type", "application/json").body(body))
        .await
        .map(|_| ())
}

/// Delete messages. An empty list means every message, as Mailpit reads it.
pub async fn delete(ids: &[String]) -> Result<()> {
    for id in ids {
        check_id(id)?;
    }
    let body = serde_json::json!({ "IDs": ids }).to_string();
    fetch(client()?.delete(api("messages")).header("Content-Type", "application/json").body(body))
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_site_is_found_by_its_tag_and_by_its_address() {
        let terms = super::site_terms("wpdev.test");
        assert_eq!(terms[0], "tag:\"wpdev.test\"");
        assert_eq!(terms[1], "from:wpdev.test");
        assert_eq!(terms[2], "to:wpdev.test");
    }

    #[test]
    fn only_a_mailpit_id_reaches_a_url() {
        assert!(super::check_id("5LCey2CnRDIrLprRYPkEVs").is_ok());
        assert!(super::check_id("../messages").is_err());
        assert!(super::check_id("").is_err());
    }

    #[test]
    fn the_plugin_tags_mail_with_the_site_and_nothing_unsafe() {
        let dir = std::env::temp_dir().join(format!("nexora-mail-tag-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("wp-content")).unwrap();
        super::set_site_catch(&dir.to_string_lossy(), "wp-dev.test'); evil(", true).unwrap();
        let body = std::fs::read_to_string(dir.join("wp-content/mu-plugins/nexora-mail.php")).unwrap();
        assert!(body.contains("addCustomHeader('X-Tags', 'wp-dev.testevil')"), "{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    #[test]
    fn the_mu_plugin_hooks_last_so_it_beats_smtp_plugins() {
        assert!(MU_PLUGIN.contains("phpmailer_init"));
        assert!(
            MU_PLUGIN.contains("PHP_INT_MAX"),
            "it must run after a plugin's own isSMTP() call, or the message escapes"
        );
    }

    #[test]
    fn the_sendmail_path_quotes_a_binary_path_containing_spaces() {
        // Only meaningful once Mailpit is installed; the shape is the point.
        if let Ok(p) = sendmail_path() {
            assert!(p.starts_with('\''), "the binary path must be quoted for popen");
            assert!(p.contains("sendmail -t"));
        }
    }

    #[test]
    fn laravel_env_carries_every_key_that_outranks_dotenv() {
        let env = laravel_env();
        for key in ["MAIL_MAILER", "MAIL_HOST", "MAIL_PORT", "MAIL_URL", "MAIL_SCHEME"] {
            assert!(env.iter().any(|(k, _)| k == key), "missing {key}");
        }
    }

    #[test]
    fn the_fpm_encoding_never_emits_an_empty_value() {
        // php-fpm refuses one and then fails to start, taking every site on
        // that version with it.
        for (k, v) in fpm_env() {
            assert!(!v.is_empty(), "{k} would be an empty value php-fpm refuses");
        }
        assert!(
            fpm_env().iter().any(|(k, v)| k == "MAIL_USERNAME" && v == "(null)"),
            "an absent username must be an explicit null Laravel understands"
        );
        // The process environment keeps real empties: that is a raw env var,
        // not a config file, and "(null)" there would be a literal string.
        assert!(laravel_env().iter().any(|(k, v)| k == "MAIL_USERNAME" && v.is_empty()));
    }

    #[test]
    fn removing_the_catch_on_a_non_wordpress_site_is_not_an_error() {
        let dir = std::env::temp_dir().join("nexora-mail-nonwp");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(set_site_catch(&dir.to_string_lossy(), "t.test", true).is_ok());
        assert!(set_site_catch(&dir.to_string_lossy(), "t.test", false).is_ok());
    }
}
