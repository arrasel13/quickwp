//! Tauri shell.
//!
//! Deliberately thin: every command here delegates to `quickwp_core`. The UI
//! and a future `quickwp` CLI both sit on that crate, so the New Site dialog
//! and `quickwp site create` cannot drift apart -- they are the same code.

use quickwp_core as core;
use quickwp_core::{php, ports, runtime, server, site, Finding, Quickwp};
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
}

#[tauri::command]
fn stack_status(state: State<'_, AppState>) -> Res<StackStatus> {
    let pools = runtime::PHP_MINORS
        .iter()
        .filter(|m| runtime::is_installed(m, "fpm"))
        .map(|m| state.app.sup.state(&php::pool_name(m)))
        .collect();
    Ok(StackStatus {
        edge_running: state.edge.lock().unwrap().is_some(),
        edge_port: ports::NGINX,
        pools,
        site_count: site::list(&state.app.db)?.len(),
        tld: state.app.db.tld()?,
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
    Ok(format!("Serving on port {}", ports::NGINX))
}

#[tauri::command]
fn stack_stop(state: State<'_, AppState>) -> Res<()> {
    if let Some(e) = state.edge.lock().unwrap().take() {
        e.stop();
    }
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
    Ok(site::add_domain(&state.app.db, &domain, &alias)?)
}

/// The URL that actually reaches a site today.
///
/// Until the edge holds 443 with a trusted certificate, that is a loopback URL
/// with a port. Reporting `https://<domain>` before that is true would be a
/// link that goes nowhere.
#[tauri::command]
fn site_url(state: State<'_, AppState>, _domain: String) -> Res<String> {
    let _ = state;
    Ok(format!("http://127.0.0.1:{}/", ports::NGINX))
}

#[tauri::command]
fn site_open(state: State<'_, AppState>, domain: String) -> Res<()> {
    // Host-based routing needs the Host header, which a browser derives from
    // the URL, so this needs DNS. Until then, open the edge and say so.
    let _ = (&state, &domain);
    std::process::Command::new("/usr/bin/open")
        .arg(format!("http://127.0.0.1:{}/", ports::NGINX))
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
                    state.app.sup.stop_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running QuickWP");
}
