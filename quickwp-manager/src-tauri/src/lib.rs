//! Tauri shell.
//!
//! Deliberately thin: every command here delegates to `quickwp_core`. The UI
//! and a future `quickwp` CLI both sit on that crate, so the New Site dialog
//! and `quickwp site create` cannot drift apart -- they are the same code.

use quickwp_core as core;
use quickwp_core::{ca, php, ports, privileged, runtime, server, site, Finding, Quickwp};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct AppState {
    app: Quickwp,
    edge: Mutex<Option<server::Edge>>,
}

type Res<T> = Result<T, String>;

// ---------------------------------------------------------------- stack

#[derive(serde::Serialize)]
struct StackStatus {
    edge_running: bool,
    edge_port: u16,
    pools: Vec<core::supervisor::ServiceState>,
    site_count: usize,
    tld: String,
    dns_running: bool,
    https_ready: bool,
    system: privileged::SystemState,
}

#[tauri::command]
fn stack_status(state: State<'_, AppState>) -> Res<StackStatus> {
    let pools = runtime::PHP_MINORS
        .iter()
        .filter(|m| runtime::is_installed(m, "fpm"))
        .map(|m| state.app.sup.state(&php::pool_name(m)))
        .collect();
    let tld = state.app.db.tld()?;
    let system = privileged::state(&tld);
    Ok(StackStatus {
        edge_running: state.edge.lock().unwrap().is_some(),
        edge_port: ports::NGINX,
        pools,
        site_count: site::list(&state.app.db)?.len(),
        dns_running: state.app.dns_running(),
        // The green lock needs all four legs. Reporting fewer as "ready" is the
        // lie this field exists to avoid.
        https_ready: system.resolver_installed
            && system.daemon_running
            && system.ca_trusted
            && state.app.dns_running(),
        system,
        tld,
    })
}

#[tauri::command]
fn stack_start(state: State<'_, AppState>) -> Res<String> {
    // Start the default pool first: an edge with no PHP behind it serves 502s
    // that look like the edge failing.
    let default = state.app.db.default_php()?;
    if runtime::is_installed(&default, "fpm") {
        php::start_pool(&state.app.sup, &default)?;
    }
    let mut edge = state.edge.lock().unwrap();
    if edge.is_none() {
        *edge = Some(server::start(state.app.db.clone(), ports::NGINX)?);
    }
    drop(edge);

    // DNS is ours and unprivileged, so it starts with the stack rather than
    // waiting on an admin prompt.
    let _ = state.app.start_dns();
    let _ = state.app.ensure_all_certs();

    Ok(format!("Serving on port {}", ports::NGINX))
}

#[tauri::command]
fn stack_stop(state: State<'_, AppState>) -> Res<()> {
    if let Some(e) = state.edge.lock().unwrap().take() {
        e.stop();
    }
    state.app.stop_dns();
    state.app.sup.stop_all();
    Ok(())
}

#[tauri::command]
fn doctor(state: State<'_, AppState>) -> Res<Vec<Finding>> {
    Ok(state.app.doctor())
}

// ------------------------------------------------------------------ php

#[tauri::command]
fn php_list(state: State<'_, AppState>) -> Res<Vec<php::PhpVersion>> {
    let default = state.app.db.default_php()?;
    Ok(php::list(&state.app.sup, &default))
}

/// Install a PHP minor. Progress is streamed as `php-install-progress`, so a
/// ~30MB download is legible rather than a frozen button.
#[tauri::command]
async fn php_install(app: tauri::AppHandle, minor: String) -> Res<String> {
    for kind in ["fpm", "cli"] {
        let handle = app.clone();
        let label = minor.clone();
        runtime::install_php(&minor, kind, move |p| {
            let _ = handle.emit(
                "php-install-progress",
                serde_json::json!({
                    "minor": label,
                    "component": p.component,
                    "received": p.received,
                    "total": p.total,
                }),
            );
        })
        .await?;
    }
    Ok(format!("PHP {minor} installed"))
}

#[tauri::command]
fn php_uninstall(minor: String) -> Res<()> {
    for kind in ["fpm", "cli"] {
        if let Ok(d) = runtime::php_dir(&minor, kind) {
            let _ = std::fs::remove_dir_all(d);
        }
    }
    Ok(())
}

#[tauri::command]
fn php_start(state: State<'_, AppState>, minor: String) -> Res<u16> {
    Ok(php::start_pool(&state.app.sup, &minor)?)
}

#[tauri::command]
fn php_stop(state: State<'_, AppState>, minor: String) -> Res<bool> {
    Ok(php::stop_pool(&state.app.sup, &minor)?)
}

/// The honest health check: ask the pool to execute PHP and report what it says.
/// "Running" and "serving" are different facts.
#[tauri::command]
fn php_health(minor: String) -> Res<String> {
    Ok(php::health(&minor)?)
}

#[tauri::command]
fn php_set_default(state: State<'_, AppState>, minor: String) -> Res<()> {
    if !runtime::PHP_MINORS.contains(&minor.as_str()) {
        return Err(format!("unknown PHP version {minor}"));
    }
    state.app.db.set_setting("default_php", &minor)?;
    Ok(())
}

#[tauri::command]
fn php_ini_get(minor: String) -> Res<Vec<(String, String)>> {
    Ok(php::ini_settings(&minor))
}

/// Set a whitelisted directive, then restart that version's pool so it takes
/// effect. Every site on that version restarts with it.
#[tauri::command]
fn php_ini_set(state: State<'_, AppState>, minor: String, key: String, value: String) -> Res<String> {
    php::set_ini(&minor, &key, &value)?;
    let was_running = state.app.sup.is_running(&php::pool_name(&minor));
    if was_running {
        php::stop_pool(&state.app.sup, &minor)?;
        php::start_pool(&state.app.sup, &minor)?;
        Ok(format!("{key} set. PHP {minor} pool restarted."))
    } else {
        Ok(format!(
            "{key} set. PHP {minor} will use it — nothing was running to restart."
        ))
    }
}


// ---------------------------------------------------------------- https

/// Where the edge binary sits, in a dev checkout or a bundled app.
///
/// Resolution is explicit rather than a single guess, because the failure mode
/// otherwise is an admin prompt followed by "file not found" -- a password
/// asked for nothing.
fn edge_binary() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    for candidate in [
        dir.join("quickwp-edge"),                    // dev: target/debug beside the app
        dir.join("../Resources/quickwp-edge"),       // bundled: Contents/Resources
        dir.join(format!("quickwp-edge-{}", std::env::consts::ARCH)),
    ] {
        if candidate.exists() {
            return candidate;
        }
    }
    dir.join("quickwp-edge")
}

/// Turn on real HTTPS.
///
/// Three things happen, in the order that makes each safe to abandon:
/// generate the CA (no privilege), trust it (login password), then write the
/// resolver and load the edge daemon (admin password). Cancelling any step
/// leaves the ones before it intact and nothing half-applied.
#[tauri::command]
fn https_enable(state: State<'_, AppState>) -> Res<String> {
    let tld = state.app.db.tld()?;

    if let Some(conflict) = privileged::resolver_conflict(&tld) {
        return Err(format!(
            "{conflict}\n\nQuit that tool, or choose a different TLD in Settings, \
             then try again. QuickWP will not overwrite it without you deciding."
        ));
    }

    ca::ensure_ca()?;
    let issued = state.app.ensure_all_certs()?;

    if !ca::is_trusted() {
        ca::trust()?;
    }

    privileged::install_system(&tld, &edge_binary())?;

    state.app.start_dns()?;

    let mut edge = state.edge.lock().unwrap();
    if edge.is_none() {
        *edge = Some(server::start(state.app.db.clone(), ports::NGINX)?);
    }

    Ok(format!(
        "HTTPS is on. {issued} certificate(s) issued.\nYour sites are now at https://<name>.{tld}"
    ))
}

/// Trust (or re-trust) the CA. Login password, no admin.
#[tauri::command]
fn https_trust_ca() -> Res<String> {
    ca::ensure_ca()?;
    ca::trust()?;
    Ok("The certificate authority is trusted. Reload any open tab.".into())
}

/// Re-issue every site certificate, whatever the cache thinks.
#[tauri::command]
fn https_regenerate_certs(state: State<'_, AppState>) -> Res<String> {
    let sites = site::list(&state.app.db)?;
    for s in &sites {
        let mut names = vec![s.domain.clone()];
        names.extend(s.aliases.iter().cloned());
        ca::issue_for(&s.domain, &names)?;
    }
    Ok(format!("Re-issued {} certificate(s).", sites.len()))
}

/// Undo every system-level change. Sites and databases are untouched.
#[tauri::command]
fn remove_system_changes(state: State<'_, AppState>) -> Res<String> {
    let tlds = state.app.tlds()?;
    privileged::remove_system_changes(&tlds)?;
    state.app.stop_dns();
    Ok("Removed the DNS resolver, the edge service and the certificate trust. \
        Your sites and their files are untouched."
        .into())
}

#[tauri::command]
fn dns_start(state: State<'_, AppState>) -> Res<u16> {
    Ok(state.app.start_dns()?)
}

#[tauri::command]
fn dns_stop(state: State<'_, AppState>) -> Res<()> {
    state.app.stop_dns();
    Ok(())
}

// ---------------------------------------------------------------- sites

#[tauri::command]
fn site_list(state: State<'_, AppState>) -> Res<Vec<site::Site>> {
    Ok(site::list(&state.app.db)?)
}

#[tauri::command]
fn site_create(state: State<'_, AppState>, new: site::NewSite) -> Res<site::Site> {
    let mut new = new;
    if new.php_minor.is_empty() {
        new.php_minor = state.app.db.default_php()?;
    }
    if !new.domain.contains('.') {
        new.domain = format!("{}.{}", new.domain, state.app.db.tld()?);
    }
    let s = site::create(&state.app.db, &new)?;
    // A site is useless without its pool up.
    if runtime::is_installed(&s.php_minor, "fpm") {
        let _ = php::start_pool(&state.app.sup, &s.php_minor);
    }
    // Issue before the first request rather than on demand: a site whose
    // certificate appears late shows an interstitial exactly once, which is
    // the one time a person decides whether to trust the tool.
    let _ = state.app.ensure_cert(&s);
    // A site on a TLD we were not answering for needs DNS to learn it.
    let _ = state.app.reload_dns();
    Ok(s)
}

#[tauri::command]
fn site_delete(state: State<'_, AppState>, domain: String) -> Res<()> {
    Ok(site::delete(&state.app.db, &domain)?)
}

#[tauri::command]
fn site_set_enabled(state: State<'_, AppState>, domain: String, enabled: bool) -> Res<()> {
    Ok(site::set_enabled(&state.app.db, &domain, enabled)?)
}

#[tauri::command]
fn site_set_php(state: State<'_, AppState>, domain: String, minor: String) -> Res<()> {
    site::set_php(&state.app.db, &domain, &minor)?;
    if runtime::is_installed(&minor, "fpm") {
        let _ = php::start_pool(&state.app.sup, &minor);
    }
    Ok(())
}

#[tauri::command]
fn site_add_domain(state: State<'_, AppState>, domain: String, alias: String) -> Res<()> {
    site::add_domain(&state.app.db, &domain, &alias)?;
    // Every path that changes the name set re-issues. Forgetting one leaves a
    // valid certificate for yesterday's names and a warning on the new one.
    if let Some(s) = site::find(&state.app.db, &domain)? {
        state.app.ensure_cert(&s)?;
    }
    state.app.reload_dns()?;
    Ok(())
}

/// The URL that actually reaches a site today.
///
/// Until the edge holds 443 with a trusted certificate, that is a loopback URL
/// with a port. Reporting `https://<domain>` before that is true would be a
/// link that goes nowhere.
#[tauri::command]
fn site_url(state: State<'_, AppState>, _domain: String) -> Res<String> {
    let tld = state.app.db.tld()?;
    let sys = privileged::state(&tld);
    if sys.resolver_installed && sys.daemon_running {
        Ok(format!("https://{_domain}/"))
    } else {
        // Reporting https://<domain> before that resolves would be a link that
        // goes nowhere.
        Ok(format!("http://127.0.0.1:{}/", ports::NGINX))
    }
}

#[tauri::command]
fn site_open(state: State<'_, AppState>, domain: String) -> Res<()> {
    let url = site_url(state, domain)?;
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------- settings

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Res<serde_json::Value> {
    Ok(serde_json::json!({
        "tld": state.app.db.tld()?,
        "default_php": state.app.db.default_php()?,
        "root": core::paths::root().to_string_lossy(),
        "sites_dir": core::paths::sites().to_string_lossy(),
        "logs_dir": core::paths::logs().to_string_lossy(),
    }))
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Res<()> {
    if key == "tld" && (value.contains('.') || value.trim().is_empty()) {
        return Err("A TLD is a single label, like `test` — no dots.".into());
    }
    state.app.db.set_setting(&key, &value)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = Quickwp::new().expect("QuickWP could not open its data directory");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            app,
            edge: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            stack_status,
            stack_start,
            stack_stop,
            doctor,
            https_enable,
            https_trust_ca,
            https_regenerate_certs,
            remove_system_changes,
            dns_start,
            dns_stop,
            php_list,
            php_install,
            php_uninstall,
            php_start,
            php_stop,
            php_health,
            php_set_default,
            php_ini_get,
            php_ini_set,
            site_list,
            site_create,
            site_delete,
            site_set_enabled,
            site_set_php,
            site_add_domain,
            site_url,
            site_open,
            settings_get,
            settings_set,
        ])
        .on_window_event(|window, event| {
            // Services outlive the app only where that is deliberate. Pools and
            // the edge are ours, so quitting takes them down rather than
            // leaving ports held by something with no window.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if let Some(e) = state.edge.lock().unwrap().take() {
                        e.stop();
                    }
                    state.app.stop_dns();
                    state.app.sup.stop_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running QuickWP");
}
