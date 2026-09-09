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

pub fn binary() -> Result<PathBuf> {
    let pin = runtime::mailpit_pin()?;
    let p = runtime::tool_binary("mailpit", pin.version);
    if p.exists() {
        Ok(p)
    } else {
        Err(Error::NotInstalled {
            component: "Mailpit".into(),
        })
    }
}

pub fn is_installed() -> bool {
    binary().is_ok()
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
        running: sup.is_running(SERVICE),
        smtp_port: ports::MAILPIT_SMTP,
        ui_port: ports::MAILPIT_UI,
        ui_url: format!("http://127.0.0.1:{}", ports::MAILPIT_UI),
        catch_all,
    }
}

pub async fn install(on_progress: impl Fn(runtime::Progress) + Send + 'static) -> Result<PathBuf> {
    let pin = runtime::mailpit_pin()?;
    runtime::install_tool("mailpit", pin, on_progress).await
}

pub fn start(sup: &Supervisor) -> Result<u16> {
    if sup.is_running(SERVICE) {
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
            return Ok(ports::MAILPIT_UI);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = sup.stop(SERVICE);
    Err(Error::other(
        "Mailpit started but never answered on its web port. See logs/mailpit.log",
    ))
}

pub fn stop(sup: &Supervisor) -> Result<bool> {
    sup.stop(SERVICE)
}

/// The `sendmail_path` a pool uses when the catch-all is on.
pub fn sendmail_path() -> Result<String> {
    Ok(format!(
        "{} sendmail -t --smtp-addr 127.0.0.1:{}",
        binary()?.display(),
        ports::MAILPIT_SMTP
    ))
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
 * Plugin Name: QuickWP Mail Catcher
 * Description: Routes every message this site sends to Mailpit instead of the internet.
 *
 * Written by QuickWP. Removing the catch-all switch removes this file.
 */
add_action('phpmailer_init', function ($phpmailer) {
    // Runs last on purpose: an SMTP plugin has already called isSMTP() and
    // pointed PHPMailer at a real provider by now, and this puts it back.
    $phpmailer->isSMTP();
    $phpmailer->Host       = '127.0.0.1';
    $phpmailer->Port       = QUICKWP_MAILPIT_PORT;
    $phpmailer->SMTPAuth   = false;
    $phpmailer->SMTPSecure = '';
    $phpmailer->SMTPAutoTLS = false;
}, PHP_INT_MAX);
"#;

fn mu_plugin_path(docroot: &str) -> PathBuf {
    PathBuf::from(docroot).join("wp-content/mu-plugins/quickwp-mail.php")
}

/// Install or remove the mu-plugin for one site.
///
/// Absent is treated as ON deliberately: a site created before the switch
/// existed is caught too, because "every site's mail is caught" must not
/// quietly mean "every site created after you found the switch".
pub fn set_site_catch(docroot: &str, on: bool) -> Result<()> {
    let path = mu_plugin_path(docroot);
    if !on {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if !PathBuf::from(docroot).join("wp-content").is_dir() {
        return Ok(()); // not a WordPress site; the sendmail shim covers it
    }
    paths::mkdir_p(path.parent().unwrap())?;
    let body = MU_PLUGIN.replace("QUICKWP_MAILPIT_PORT", &ports::MAILPIT_SMTP.to_string());
    std::fs::write(&path, body).map_err(|e| Error::Io { path, source: e })
}

#[cfg(test)]
mod tests {
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
    fn laravel_env_carries_every_key_that_outranks_dotenv() {
        let env = laravel_env();
        for key in ["MAIL_MAILER", "MAIL_HOST", "MAIL_PORT", "MAIL_URL", "MAIL_SCHEME"] {
            assert!(env.iter().any(|(k, _)| k == key), "missing {key}");
        }
    }

    #[test]
    fn removing_the_catch_on_a_non_wordpress_site_is_not_an_error() {
        let dir = std::env::temp_dir().join("quickwp-mail-nonwp");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(set_site_catch(&dir.to_string_lossy(), true).is_ok());
        assert!(set_site_catch(&dir.to_string_lossy(), false).is_ok());
    }
}
