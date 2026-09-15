//! PHP version fleet: one php-fpm pool per minor, not one per site.
//!
//! A site stores a *minor* and never a patch. That is what makes switching a
//! patch a pool restart rather than a migration: no config is regenerated, no
//! certificate is touched, nothing about the site changes.

use crate::{fastcgi, paths, ports, runtime, supervisor::Supervisor, Error, Result};
use std::path::PathBuf;

/// The php.ini directives Nexora exposes.
///
/// A whitelist, not a passthrough. Directives that would break the pool or
/// silently disable something the app depends on are not offered -- a setting
/// whose only possible outcome is a broken pool is not a choice.
pub const INI_WHITELIST: [(&str, &str); 6] = [
    ("memory_limit", "512M"),
    ("upload_max_filesize", "64M"),
    ("post_max_size", "64M"),
    ("max_execution_time", "120"),
    ("display_errors", "On"),
    ("error_reporting", "E_ALL"),
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct PhpVersion {
    pub minor: String,
    pub patch: String,
    pub installed: bool,
    pub running: bool,
    pub port: u16,
    pub is_default: bool,
    pub eol: bool,
    pub xdebug_capable: bool,
}

pub fn xdebug_supported(minor: &str) -> bool {
    // Xdebug is a shared object that must dlopen into the running PHP. The
    // static 8.0 build does not export the Zend symbols it needs, so the toggle
    // is not offered there rather than offered and then failing at spawn time.
    minor >= runtime::XDEBUG_MIN_MINOR
}

pub fn is_eol(minor: &str) -> bool {
    runtime::PHP_EOL.contains(&minor)
}

/// Every minor this build ships, with live state.
pub fn list(sup: &Supervisor, default_minor: &str) -> Vec<PhpVersion> {
    runtime::PHP_MINORS
        .iter()
        .map(|m| {
            let minor = m.to_string();
            let patch = runtime::php_pin(m, "fpm")
                .map(|p| p.patch.to_string())
                .unwrap_or_default();
            PhpVersion {
                installed: runtime::is_installed(m, "fpm"),
                running: sup.is_running(&pool_name(m))
                    || (runtime::is_installed(m, "fpm") && adopt_if_ours(m)),
                port: ports::fpm_port(m).unwrap_or(0),
                is_default: *m == default_minor,
                eol: is_eol(m),
                xdebug_capable: xdebug_supported(m),
                minor,
                patch,
            }
        })
        .collect()
}

pub fn pool_name(minor: &str) -> String {
    format!("php-fpm-{minor}")
}

fn ini_path(minor: &str) -> PathBuf {
    paths::config().join("php").join(minor).join("php.ini")
}

fn pool_conf_path(minor: &str) -> PathBuf {
    paths::config().join("php").join(minor).join("php-fpm.conf")
}

/// Read the effective ini values for a minor: whitelist defaults, overridden by
/// anything the user has set.
pub fn ini_settings(minor: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = INI_WHITELIST
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if let Ok(text) = std::fs::read_to_string(ini_path(minor)) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with(';') || line.is_empty() {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let (k, v) = (k.trim(), v.trim());
                if let Some(slot) = out.iter_mut().find(|(ek, _)| ek == k) {
                    slot.1 = v.to_string();
                }
            }
        }
    }
    out
}

/// Set one whitelisted directive. Restarts the pool so the change takes effect
/// -- and every site on that version restarts with it, which the caller must
/// say before doing.
pub fn set_ini(minor: &str, key: &str, value: &str) -> Result<()> {
    if !INI_WHITELIST.iter().any(|(k, _)| *k == key) {
        return Err(Error::other(format!(
            "`{key}` is not an editable directive. Nexora exposes: {}",
            INI_WHITELIST
                .iter()
                .map(|(k, _)| *k)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    // post_max_size >= upload_max_filesize, or uploads fail with a message that
    // names neither: PHP discards the whole request body before WordPress runs.
    let mut current = ini_settings(minor);
    if let Some(s) = current.iter_mut().find(|(k, _)| k == key) {
        s.1 = value.to_string();
    }
    let get = |k: &str| {
        current
            .iter()
            .find(|(ek, _)| ek == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let (post, upload) = (bytes(&get("post_max_size")), bytes(&get("upload_max_filesize")));
    if post < upload {
        return Err(Error::other(format!(
            "post_max_size ({}) must be at least upload_max_filesize ({}). \
             PHP discards the whole request body before WordPress sees it, so an upload \
             would fail with a message naming neither setting.",
            get("post_max_size"),
            get("upload_max_filesize")
        )));
    }

    let p = ini_path(minor);
    paths::mkdir_p(p.parent().unwrap())?;
    let body: String = current
        .iter()
        .map(|(k, v)| format!("{k} = {v}\n"))
        .collect();
    std::fs::write(&p, body).map_err(|e| Error::Io { path: p, source: e })?;
    Ok(())
}

/// Parse a PHP shorthand byte value ("64M") into bytes.
fn bytes(s: &str) -> u64 {
    let s = s.trim();
    let (num, mult) = match s.chars().last() {
        Some('K') | Some('k') => (&s[..s.len() - 1], 1024),
        Some('M') | Some('m') => (&s[..s.len() - 1], 1024 * 1024),
        Some('G') | Some('g') => (&s[..s.len() - 1], 1024 * 1024 * 1024),
        _ => (s, 1),
    };
    num.trim().parse::<u64>().unwrap_or(0) * mult
}

fn write_pool_config(minor: &str, port: u16, catch_all: bool) -> Result<PathBuf> {
    let conf = pool_conf_path(minor);
    paths::mkdir_p(conf.parent().unwrap())?;
    paths::mkdir_p(&paths::logs())?;
    paths::mkdir_p(&paths::run())?;

    let mut ini = ini_settings(minor)
        .into_iter()
        .map(|(k, v)| format!("php_admin_value[{k}] = {v}"))
        .collect::<Vec<_>>();

    // Mail catching, leg 1 of 3: PHP's own mail(). The shim is what catches a
    // plain WordPress site. Legs 2 and 3 -- the mu-plugin for SMTP plugins and
    // the MAIL_* environment for Laravel -- live in `mail`.
    if catch_all && crate::mail::is_installed() {
        if let Ok(path) = crate::mail::sendmail_path() {
            ini.push(format!("php_admin_value[sendmail_path] = \"{path}\""));
        }
        for (k, v) in crate::mail::fpm_env() {
            // A variable already in the process environment is never
            // overwritten by Laravel's .env -- that is the lever that works,
            // because its sendmail transport does not consult php.ini at all.
            //
            // Quoted without exception: php-fpm refuses a bare empty value with
            // "empty value" and then fails to start at all, so an unset MAIL_*
            // key would take every pool down with it.
            ini.push(format!("env[{k}] = \"{v}\""));
        }
    }
    let ini = ini.join("\n");

    let body = format!(
        r#"; Generated by Nexora. Edits here are overwritten.
[global]
pid = {run}/php-fpm-{minor}.pid
error_log = {logs}/php-fpm-{minor}.log
daemonize = no

[www]
listen = 127.0.0.1:{port}
listen.allowed_clients = 127.0.0.1
pm = dynamic
pm.max_children = 10
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.status_path = /fpm-status
catch_workers_output = yes
access.log = {logs}/php-fpm-{minor}.access.log
{ini}
"#,
        run = paths::run().display(),
        logs = paths::logs().display(),
        minor = minor,
        port = port,
        ini = ini,
    );

    std::fs::write(&conf, body).map_err(|e| Error::Io {
        path: conf.clone(),
        source: e,
    })?;
    Ok(conf)
}

/// Is a pool already listening on this minor's port, and is it actually this
/// minor?
///
/// Pools outlive the app, so relaunching Nexora should adopt its own pool
/// rather than refusing to start because the port is taken. The check is the
/// honest one: ask the pool to execute PHP and compare the version it reports.
/// A pool that answers with a different version is somebody else's.
pub fn adopt_if_ours(minor: &str) -> bool {
    let Ok(port) = ports::fpm_port(minor) else {
        return false;
    };
    if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        return false;
    }
    match health(minor) {
        Ok(v) => v.starts_with(&format!("{minor}.")),
        Err(_) => false,
    }
}

/// Is the mail catch-all on? Absent means on -- see `mail`.
fn catch_all() -> bool {
    crate::db::Db::open()
        .ok()
        .and_then(|d| d.setting("catch_all").ok().flatten())
        .map(|v| v != "0")
        .unwrap_or(true)
}

/// Start the pool for a minor. Idempotent.
pub fn start_pool(sup: &Supervisor, minor: &str) -> Result<u16> {
    let port = ports::fpm_port(minor)?;
    let name = pool_name(minor);
    if sup.is_running(&name) {
        return Ok(port);
    }
    if adopt_if_ours(minor) {
        crate::log::info("php", &format!("PHP {minor} pool already running on port {port}; using it"));
        return Ok(port);
    }
    let bin = runtime::fpm_binary(minor)?;
    let conf = write_pool_config(minor, port, catch_all())?;

    sup.start(
        &name,
        &bin,
        &[
            "--nodaemonize".into(),
            "--fpm-config".into(),
            conf.to_string_lossy().into_owned(),
        ],
        Some(port),
        Some(paths::logs().join(format!("php-fpm-{minor}.log"))),
    )?;

    // Wait for the socket to actually accept. "Spawned" and "serving" are
    // different facts and the caller is asking for the second.
    for _ in 0..60 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            crate::log::info("php", &format!("PHP {minor} pool started on port {port}"));
            return Ok(port);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = sup.stop(&name);
    Err(Error::other(format!(
        "PHP {minor} started but never accepted a connection on port {port}. \
         See logs/php-fpm-{minor}.log"
    )))
}

pub fn stop_pool(sup: &Supervisor, minor: &str) -> Result<bool> {
    if sup.stop(&pool_name(minor))? {
        return Ok(true);
    }
    // A pool we adopted rather than spawned is not in the supervisor. Find it
    // by the port it holds and signal its process group.
    if let Ok(port) = ports::fpm_port(minor) {
        if adopt_if_ours(minor) {
            if let Some(pid) = ports::holder_pid(port) {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                    libc::kill(pid as i32, libc::SIGTERM);
                }
                for _ in 0..30 {
                    if ports::is_free(port) {
                        return Ok(true);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
    }
    Ok(false)
}

/// Ask the pool to execute a script. This is the honest health check.
pub fn health(minor: &str) -> Result<String> {
    let port = ports::fpm_port(minor)?;
    let probe = paths::run().join(format!("probe-{minor}.php"));
    paths::mkdir_p(probe.parent().unwrap())?;
    std::fs::write(&probe, "<?php echo PHP_VERSION;").map_err(|e| Error::Io {
        path: probe.clone(),
        source: e,
    })?;
    let resp = fastcgi::run_script(port, &probe)?;
    let _ = std::fs::remove_file(&probe);
    let body = resp.body().trim().to_string();
    if body.is_empty() {
        return Err(Error::other(format!(
            "PHP {minor} pool answered with no body. stderr: {}",
            resp.stderr
        )));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdebug_is_not_offered_on_80() {
        assert!(!xdebug_supported("8.0"));
        assert!(xdebug_supported("8.1"));
        assert!(xdebug_supported("8.5"));
    }

    #[test]
    fn shorthand_bytes_parse() {
        assert_eq!(bytes("64M"), 64 * 1024 * 1024);
        assert_eq!(bytes("512M"), 512 * 1024 * 1024);
        assert_eq!(bytes("1G"), 1024 * 1024 * 1024);
        assert_eq!(bytes("120"), 120);
    }

    #[test]
    fn every_generated_env_line_is_quoted_even_when_empty() {
        // php-fpm rejects `env[X] = ` outright and then will not start, so an
        // empty MAIL_USERNAME must not be emitted bare.
        for (k, v) in crate::mail::fpm_env() {
            let line = format!("env[{k}] = \"{v}\"");
            assert!(line.ends_with('"'), "{line} must end quoted");
            assert!(
                !line.trim_end().ends_with("= "),
                "{line} would be an empty value php-fpm refuses"
            );
        }
    }

    #[test]
    fn a_directive_outside_the_whitelist_is_refused() {
        let err = set_ini("8.3", "disable_functions", "exec").unwrap_err();
        assert!(err.to_string().contains("not an editable directive"));
    }
}
