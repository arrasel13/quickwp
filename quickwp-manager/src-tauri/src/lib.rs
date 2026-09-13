//! Tauri shell.
//!
//! Deliberately thin: every command here delegates to `quickwp_core`. The UI
//! and a future `quickwp` CLI both sit on that crate, so the New Site dialog
//! and `quickwp site create` cannot drift apart -- they are the same code.

use quickwp_core as core;
use quickwp_core::{
    ca, database, exec, log as qlog, mail, migrate, php, ports, privileged, pty, runtime, server,
    site, tunnel, wordpress, wptools, Finding, Quickwp,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    app: Quickwp,
    edge: Mutex<Option<server::Edge>>,
    ptys: pty::Ptys,
    /// Set once a quit has been decided, so the exit it triggers is let through
    /// instead of asking again.
    quitting: AtomicBool,
    /// Set once the shutdown has run, so the window's Destroyed cannot run it
    /// a second time and undo a "keep running".
    down: AtomicBool,
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

#[tauri::command(async)]
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

/// Bring the stack up. Shared by the Start button and by a launch that resumes
/// what the last quit stopped.
fn start_stack(app: &Quickwp, edge: &Mutex<Option<server::Edge>>) -> core::Result<()> {
    // Start the default pool first: an edge with no PHP behind it serves 502s
    // that look like the edge failing.
    let default = app.db.default_php()?;
    if runtime::is_installed(&default, "fpm") {
        php::start_pool(&app.sup, &default)?;
    }
    let mut edge = edge.lock().unwrap();
    if edge.is_none() {
        *edge = Some(server::start(app.db.clone(), ports::NGINX)?);
    }
    drop(edge);

    // DNS is ours and unprivileged, so it starts with the stack rather than
    // waiting on an admin prompt.
    let _ = app.start_dns();
    let _ = app.ensure_all_certs();
    Ok(())
}

#[tauri::command(async)]
fn stack_start(state: State<'_, AppState>) -> Res<String> {
    start_stack(&state.app, &state.edge)?;
    Ok(format!("Serving on port {}", ports::NGINX))
}

#[tauri::command(async)]
fn stack_stop(state: State<'_, AppState>) -> Res<()> {
    if let Some(e) = state.edge.lock().unwrap().take() {
        e.stop();
    }
    state.app.stop_dns();
    state.app.sup.stop_all();
    Ok(())
}

#[tauri::command(async)]
fn doctor(state: State<'_, AppState>) -> Res<Vec<Finding>> {
    Ok(state.app.doctor())
}

// ------------------------------------------------------------------ php

/// Node versions already on this machine. QuickWP installs none of its own:
/// a second copy would be the one thing the user's npm scripts do not use.
#[tauri::command(async)]
fn node_list() -> Res<Vec<core::node::NodeVersion>> {
    Ok(core::node::list())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
fn php_uninstall(minor: String) -> Res<()> {
    for kind in ["fpm", "cli"] {
        if let Ok(d) = runtime::php_dir(&minor, kind) {
            let _ = std::fs::remove_dir_all(d);
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn php_start(state: State<'_, AppState>, minor: String) -> Res<u16> {
    Ok(php::start_pool(&state.app.sup, &minor)?)
}

#[tauri::command(async)]
fn php_stop(state: State<'_, AppState>, minor: String) -> Res<bool> {
    Ok(php::stop_pool(&state.app.sup, &minor)?)
}

/// The honest health check: ask the pool to execute PHP and report what it says.
/// "Running" and "serving" are different facts.
#[tauri::command(async)]
fn php_health(minor: String) -> Res<String> {
    Ok(php::health(&minor)?)
}

#[tauri::command(async)]
fn php_set_default(state: State<'_, AppState>, minor: String) -> Res<()> {
    if !runtime::PHP_MINORS.contains(&minor.as_str()) {
        return Err(format!("unknown PHP version {minor}"));
    }
    state.app.db.set_setting("default_php", &minor)?;
    Ok(())
}

#[tauri::command(async)]
fn php_ini_get(minor: String) -> Res<Vec<(String, String)>> {
    Ok(php::ini_settings(&minor))
}

/// Set a whitelisted directive, then restart that version's pool so it takes
/// effect. Every site on that version restarts with it.
#[tauri::command(async)]
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
/// The bundled `quickwp` CLI, which the DNS agent and the tunnel guard run.
fn cli_binary() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    for c in [dir.join("quickwp"), dir.join("../Resources/quickwp")] {
        if c.exists() {
            return c;
        }
    }
    dir.join("quickwp")
}

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
/// Everything checked before a password is asked for.
#[tauri::command(async)]
fn https_preflight(state: State<'_, AppState>, takeover: Option<bool>) -> Res<Vec<privileged::Check>> {
    let tld = state.app.db.tld()?;
    Ok(privileged::preflight(&tld, &edge_binary(), takeover.unwrap_or(false)))
}

/// Would claiming the current TLD take it from another tool?
#[tauri::command(async)]
fn https_tld_is_foreign(state: State<'_, AppState>) -> Res<bool> {
    Ok(privileged::tld_is_foreign(&state.app.db.tld()?))
}

/// Measured facts about the installed system state, after the fact.
#[tauri::command(async)]
fn https_verify(state: State<'_, AppState>) -> Res<privileged::VerifyReport> {
    let tld = state.app.db.tld()?;
    Ok(privileged::verify(&tld))
}

#[tauri::command(async)]
fn https_enable(state: State<'_, AppState>, takeover: Option<bool>) -> Res<String> {
    let takeover = takeover.unwrap_or(false);
    let tld = state.app.db.tld()?;

    // The CA and the certificates cost nothing and need no privilege, so they
    // are done first: if the prompt is then cancelled, nothing is half-done.
    ca::ensure_ca()?;
    let issued = state.app.ensure_all_certs()?;

    if !ca::is_trusted() {
        ca::trust()?;
    }

    // DNS first: the resolver file is useless if nothing is answering, and a
    // verify immediately after the install would fail on a race we created.
    let _ = state.app.start_dns();

    let mut edge = state.edge.lock().unwrap();
    if edge.is_none() {
        *edge = Some(server::start(state.app.db.clone(), ports::NGINX)?);
    }
    drop(edge);

    privileged::install_system(&tld, &edge_binary(), takeover)?;

    // A user agent, so no second password. It is installed after the resolver
    // exists, because the resolver is what makes running it necessary: from
    // that moment, a .{tld} lookup that our DNS does not answer hangs.
    privileged::install_dns_agent(&cli_binary())?;

    // The shared certificate directory exists now, so move everything issued
    // before it did -- otherwise every site created before this moment fails
    // its handshake.
    let migrated = ca::migrate_to_shared()?;
    if migrated > 0 {
        quickwp_core::log::write(&format!("migrated {migrated} certificate file(s) to the shared store"));
    }
    state.app.ensure_all_certs()?;

    // Do not claim success until it is measured. launchd needs a moment.
    let mut report = privileged::verify(&tld);
    for _ in 0..20 {
        if report.all_ok {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        report = privileged::verify(&tld);
    }

    if !report.all_ok {
        let failed: Vec<String> = report
            .items
            .iter()
            .filter(|i| !i.ok)
            .map(|i| format!("• {} — {}", i.label, i.detail))
            .collect();
        return Err(format!(
            "The install ran, but not everything came up:\n{}\n\nNothing was rolled back — \
             use Remove system changes to undo it, or check logs/edge.log.",
            failed.join("\n")
        ));
    }

    // Every WordPress site was installed against http://<domain>; now that the
    // address has a scheme change, they would redirect visitors back to http
    // forever unless their stored URL moves with it.
    let mut moved = 0;
    for s in site::list(&state.app.db)? {
        if !wordpress::is_wordpress(&s) {
            continue;
        }
        if wordpress::set_site_url(&s, &format!("https://{}", s.domain)).is_ok() {
            moved += 1;
        }
    }

    Ok(format!(
        "HTTPS is on, and verified.\n{issued} certificate(s) issued.\n\
         {moved} WordPress site(s) moved to https.\nYour sites are now at https://<name>.{tld}"
    ))
}

/// Trust (or re-trust) the CA. Login password, no admin.
#[tauri::command(async)]
fn https_trust_ca() -> Res<String> {
    ca::ensure_ca()?;
    ca::trust()?;
    Ok("The certificate authority is trusted. Reload any open tab.".into())
}

/// Re-issue every site certificate, whatever the cache thinks.
#[tauri::command(async)]
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
#[tauri::command(async)]
fn remove_system_changes(state: State<'_, AppState>) -> Res<String> {
    let tlds = state.app.tlds()?;
    privileged::remove_system_changes(&tlds)?;
    state.app.stop_dns();

    // Prove it reversed, rather than trusting the script ran.
    let report = privileged::verify_removed(&tlds);
    if !report.all_ok {
        let left: Vec<String> = report
            .items
            .iter()
            .filter(|i| !i.ok)
            .map(|i| format!("• {} — {}", i.label, i.detail))
            .collect();
        return Err(format!(
            "Removal ran, but some of it is still there:\n{}\n\nTry again, or remove those \
             by hand.",
            left.join("\n")
        ));
    }

    Ok("Removed and verified: the DNS resolver, the edge service and the certificate trust \
        are gone. Your sites, their files and their databases are untouched."
        .into())
}

#[tauri::command(async)]
fn dns_start(state: State<'_, AppState>) -> Res<u16> {
    Ok(state.app.start_dns()?)
}

#[tauri::command(async)]
fn dns_stop(state: State<'_, AppState>) -> Res<()> {
    state.app.stop_dns();
    Ok(())
}

// ---------------------------------------------------------------- sites

#[tauri::command(async)]
fn site_list(state: State<'_, AppState>) -> Res<Vec<site::Site>> {
    Ok(site::list(&state.app.db)?)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
fn site_delete(state: State<'_, AppState>, domain: String) -> Res<Vec<String>> {
    Ok(state.app.delete_site(&domain)?)
}

#[tauri::command(async)]
fn site_set_enabled(state: State<'_, AppState>, domain: String, enabled: bool) -> Res<()> {
    Ok(site::set_enabled(&state.app.db, &domain, enabled)?)
}

#[tauri::command(async)]
fn site_set_php(state: State<'_, AppState>, domain: String, minor: String) -> Res<()> {
    site::set_php(&state.app.db, &domain, &minor)?;
    if runtime::is_installed(&minor, "fpm") {
        let _ = php::start_pool(&state.app.sup, &minor);
    }
    Ok(())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
fn site_logs(state: State<'_, AppState>, domain: String) -> Res<Vec<qlog::SiteLog>> {
    let s = site_by_domain(&state, &domain)?;
    // Only asked for a WordPress site: `wp config get` on a plain PHP folder
    // spawns a process to answer a question that does not apply.
    let wp_logging = if wordpress::is_wordpress(&s) {
        Some(matches!(
            wptools::config_get(&s, "WP_DEBUG_LOG").ok().flatten().as_deref(),
            Some("true") | Some("1")
        ))
    } else {
        None
    };
    Ok(qlog::for_site(&s, wp_logging))
}

#[tauri::command(async)]
fn site_log_tail(
    state: State<'_, AppState>,
    domain: String,
    id: String,
    lines: Option<usize>,
) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    let path = qlog::site_log_path(&s, &id)
        .ok_or_else(|| format!("No log called {id}."))?;
    if !path.exists() {
        return Ok(String::new());
    }
    Ok(qlog::tail_path(&path, lines.unwrap_or(500))?)
}

#[tauri::command(async)]
fn site_log_clear(state: State<'_, AppState>, domain: String, id: String) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    let path = qlog::site_log_path(&s, &id)
        .ok_or_else(|| format!("No log called {id}."))?;
    qlog::clear(&path)?;
    Ok(format!("{} emptied.", path.display()))
}

/// Copy a log to ~/Downloads, stamped so repeated saves do not overwrite.
#[tauri::command(async)]
fn site_log_download(state: State<'_, AppState>, domain: String, id: String) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    let path = qlog::site_log_path(&s, &id)
        .ok_or_else(|| format!("No log called {id}."))?;
    if !path.exists() {
        return Err("That log does not exist yet.".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = core::paths::downloads()
        .join(format!("{}-{id}-{stamp}.log", s.domain));
    std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
struct SiteInfo {
    kind: String,
    db_name: Option<String>,
    db_engine: Option<String>,
    db_host: Option<String>,
    multisite: bool,
}

/// The read-only facts panel: what this site is and what it sits on.
#[tauri::command(async)]
fn site_info(state: State<'_, AppState>, domain: String) -> Res<SiteInfo> {
    let s = site_by_domain(&state, &domain)?;
    let db_host = s.db_engine.as_ref().and_then(|e| {
        database::list(&state.app.sup)
            .into_iter()
            .find(|x| &x.engine == e)
            .map(|x| format!("127.0.0.1:{}", x.port))
    });
    // Multisite is a wp-config constant; a site without WordPress has none.
    let multisite = wordpress::is_wordpress(&s)
        && matches!(
            wptools::config_get(&s, "WP_ALLOW_MULTISITE").ok().flatten().as_deref(),
            Some("true") | Some("1")
        );
    Ok(SiteInfo {
        kind: s.kind.clone(),
        db_name: s.db_name.clone(),
        db_engine: s.db_engine.clone(),
        db_host,
        multisite,
    })
}

#[derive(serde::Serialize)]
struct CertInfo {
    issued_at: Option<String>,
    expires_at: Option<String>,
    names: Vec<String>,
    path: String,
    exists: bool,
}

#[tauri::command(async)]
fn site_cert_info(state: State<'_, AppState>, domain: String) -> Res<CertInfo> {
    let s = site_by_domain(&state, &domain)?;
    let dates = state.app.db.cert_dates(s.id)?;
    let path = ca::site_cert_path(&s.domain);
    // The wildcard is what the certificate actually covers, so it is listed
    // rather than implied.
    let mut names = vec![s.domain.clone(), format!("*.{}", s.domain)];
    names.extend(s.aliases.iter().cloned());
    Ok(CertInfo {
        issued_at: dates.as_ref().map(|d| d.0.clone()),
        expires_at: dates.as_ref().map(|d| d.1.clone()),
        names,
        exists: path.exists(),
        path: path.to_string_lossy().to_string(),
    })
}

/// Re-issue from the local CA and reload the edge so it picks the new file up.
#[tauri::command(async)]
fn site_regenerate_cert(state: State<'_, AppState>, domain: String) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    state.app.ensure_cert(&s)?;
    state.app.reload_dns()?;
    Ok(format!("Certificate re-issued for {}.", s.domain))
}

#[tauri::command(async)]
fn site_set_name(state: State<'_, AppState>, domain: String, name: String) -> Res<String> {
    site::set_name(&state.app.db, &domain, &name)?;
    Ok(format!("Renamed to {}.", name.trim()))
}

#[tauri::command(async)]
fn site_set_xdebug(state: State<'_, AppState>, domain: String, on: bool) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    if on && !php::xdebug_supported(&s.php_minor) {
        return Err(format!(
            "Xdebug is not offered for PHP {}.",
            s.php_minor
        ));
    }
    site::set_xdebug(&state.app.db, &domain, on)?;
    Ok(if on {
        "Xdebug on — this site moves to a debug pool.".into()
    } else {
        "Xdebug off — back on the shared pool.".into()
    })
}

#[tauri::command(async)]
fn site_remove_domain(state: State<'_, AppState>, domain: String, alias: String) -> Res<String> {
    site::remove_domain(&state.app.db, &domain, &alias)?;
    if let Some(s) = site::find(&state.app.db, &domain)? {
        state.app.ensure_cert(&s)?;
    }
    state.app.reload_dns()?;
    Ok(format!("{alias} removed."))
}

#[tauri::command(async)]
fn site_env_get(state: State<'_, AppState>, domain: String) -> Res<Vec<(String, String)>> {
    let s = site_by_domain(&state, &domain)?;
    Ok(state.app.db.site_env(s.id)?)
}

#[tauri::command(async)]
fn site_env_set(
    state: State<'_, AppState>,
    domain: String,
    entries: Vec<(String, String)>,
) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    state.app.db.set_site_env(s.id, &entries)?;
    Ok(format!("{} variable(s) saved.", entries.len()))
}

/// Rename the site's primary domain, and everything that has to move with it.
///
/// The order matters: back up before touching anything, rewrite the database
/// while the old name is still what is inside it, then rename and re-issue.
/// A failure part-way leaves the steps before it done and nothing half-applied.
#[tauri::command(async)]
fn site_change_domain(
    state: State<'_, AppState>,
    domain: String,
    new_domain: String,
) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    let new_domain = new_domain.trim().to_lowercase();
    if new_domain == s.domain {
        return Err("That is already the domain.".into());
    }

    let mut steps: Vec<String> = Vec::new();
    let is_wp = wordpress::is_wordpress(&s);

    if is_wp {
        let backup = wptools::export_database(&s)?;
        steps.push(format!("Database exported to {backup}"));

        // Both schemes: a site installed over http still has http URLs in it.
        for scheme in ["https", "http"] {
            let from = format!("{scheme}://{}", s.domain);
            let to = format!("{scheme}://{new_domain}");
            let _ = wordpress::search_replace(&s, &from, &to, false);
        }
        // And the bare hostname, for anything stored without a scheme.
        let _ = wordpress::search_replace(&s, &s.domain, &new_domain, false);
        steps.push("URLs rewritten in the database".into());
    }

    site::rename_domain(&state.app.db, &s.domain, &new_domain)?;
    steps.push(format!("Renamed to {new_domain}"));

    if let Some(renamed) = site::find(&state.app.db, &new_domain)? {
        state.app.ensure_cert(&renamed)?;
        steps.push("Certificate re-issued".into());
    }
    state.app.reload_dns()?;

    Ok(steps.join("\n"))
}

/// Move the site's files. The domain, database and certificate do not change.
#[tauri::command(async)]
fn site_move(state: State<'_, AppState>, domain: String, new_path: String) -> Res<String> {
    let s = site_by_domain(&state, &domain)?;
    let target = std::path::PathBuf::from(new_path.trim());
    if target.exists() {
        return Err(format!("{} already exists.", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // A rename is atomic and instant within a volume. Across volumes it fails
    // with EXDEV, and a half-finished recursive copy of someone's site is a
    // worse outcome than a clear refusal.
    std::fs::rename(&s.docroot, &target).map_err(|e| {
        format!(
            "Could not move {} to {}: {e}. If they are on different disks, copy \
             the folder yourself and link the site to its new home.",
            s.docroot,
            target.display()
        )
    })?;

    site::set_docroot(&state.app.db, &s.domain, &target.to_string_lossy())?;
    Ok(format!("Moved to {}", target.display()))
}

/// The URL that actually reaches a site today.
///
/// Until the edge holds 443 with a trusted certificate, that is a loopback URL
/// with a port. Reporting `https://<domain>` before that is true would be a
/// link that goes nowhere.
/// The URL that opens this site's database in Adminer, already logged in.
///
/// Async because the first call fetches Adminer. Everything after that is a
/// path check and a string.
#[tauri::command]
async fn site_adminer_url(state: State<'_, AppState>, domain: String) -> Res<String> {
    let app = state.app.clone();
    Ok(app.adminer_url(&domain).await?)
}

#[tauri::command(async)]
fn site_url(state: State<'_, AppState>, _domain: String) -> Res<String> {
    Ok(format!("{}/", canonical_url(&state, &_domain)?))
}

/// The address a site should believe it lives at.
///
/// Always the site's own hostname, never a loopback address with a port.
/// WordPress writes this into its database at install time and serves
/// redirects to it forever, so installing with `http://127.0.0.1:18089` bakes
/// in an address that breaks the moment the site is reached by name.
fn canonical_url(state: &State<'_, AppState>, domain: &str) -> Res<String> {
    let tld = state.app.db.tld()?;
    let sys = privileged::state(&tld);
    let scheme = if sys.resolver_installed && sys.daemon_running && sys.ca_trusted {
        "https"
    } else {
        "http"
    };
    Ok(format!("{scheme}://{domain}"))
}

/// Reveal a path in Finder. Takes the path rather than a domain so it serves
/// a docroot, a wp-config.php or a log file equally.
#[tauri::command(async)]
fn path_open(path: String) -> Res<()> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("{path} is not there any more."));
    }
    // `-R` reveals the item with its parent open and it selected, which is
    // what you want for a file; a directory opens as itself.
    let mut c = std::process::Command::new("/usr/bin/open");
    if p.is_file() {
        c.arg("-R");
    }
    c.arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// The editor chosen in App settings, or else the first installed one QuickWP
/// knows. By bundle, because `code` on PATH is a shell-init detail we cannot
/// rely on from a GUI process.
fn preferred_editor(db: &core::db::Db) -> Option<std::path::PathBuf> {
    db.setting("editor")
        .ok()
        .flatten()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| core::apps::editors().first().map(|a| a.path.clone().into()))
}

/// The terminal chosen in App settings, or Terminal.app.
fn preferred_terminal(db: &core::db::Db) -> std::path::PathBuf {
    db.setting("terminal")
        .ok()
        .flatten()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| core::apps::TERMINAL_APP.into())
}

/// The browser chosen in App settings. None means the system default, so a
/// change of default in System Settings is followed rather than overridden.
fn preferred_browser(db: &core::db::Db) -> Option<std::path::PathBuf> {
    db.setting("browser")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
}

/// Open a web page -- a site, wp-admin, Adminer, Mailpit -- in the preferred
/// browser.
fn open_url(state: &AppState, url: &str) -> Res<()> {
    Ok(core::apps::open_url(preferred_browser(&state.app.db).as_deref(), url)?)
}

/// Open a path in the preferred editor.
#[tauri::command(async)]
fn path_open_in_editor(state: State<'_, AppState>, path: String) -> Res<()> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{path} is not there any more."));
    }
    let editor = preferred_editor(&state.app.db)
        .ok_or("No code editor QuickWP recognises is installed.")?;
    Ok(core::apps::open_in_editor(&editor, std::path::Path::new(&path))?)
}

/// Open this site's database browser in the real browser.
///
/// The URL is rebuilt here rather than passed in from the webview: it carries
/// the token that gates Adminer, and a command that opens whatever URL it is
/// handed is a wider door than this feature needs.
#[tauri::command]
async fn site_adminer_open(state: State<'_, AppState>, domain: String) -> Res<()> {
    let app = state.app.clone();
    let url = app.adminer_url(&domain).await?;
    open_url(&state, &url)
}

#[tauri::command(async)]
fn site_open(state: State<'_, AppState>, domain: String) -> Res<()> {
    // Read before `site_url`, which takes the state by value.
    let browser = preferred_browser(&state.app.db);
    let url = site_url(state, domain)?;
    Ok(core::apps::open_url(browser.as_deref(), &url)?)
}


// ------------------------------------------------------------ databases

#[tauri::command(async)]
fn db_list(state: State<'_, AppState>) -> Res<Vec<database::EngineStatus>> {
    Ok(database::list(&state.app.sup))
}

#[tauri::command]
async fn db_install(app: tauri::AppHandle, series: String) -> Res<String> {
    let handle = app.clone();
    let label = series.clone();
    runtime::install_mysql(&series, move |p| {
        let _ = handle.emit(
            "download-progress",
            serde_json::json!({
                "id": format!("mysql-{label}"),
                "component": p.component,
                "received": p.received,
                "total": p.total,
            }),
        );
    })
    .await?;
    Ok(format!("MySQL {series} installed"))
}

#[tauri::command(async)]
fn db_start(state: State<'_, AppState>, series: String) -> Res<u16> {
    Ok(database::start(&state.app.sup, &series)?)
}

#[tauri::command(async)]
fn db_stop(state: State<'_, AppState>, series: String) -> Res<bool> {
    Ok(database::stop(&state.app.sup, &series)?)
}

#[tauri::command(async)]
fn db_databases(series: String) -> Res<Vec<String>> {
    Ok(database::databases(&series)?)
}

#[tauri::command(async)]
fn db_export(series: String, db_name: String) -> Res<String> {
    Ok(database::export(&series, &db_name)?.to_string_lossy().into())
}

/// Import OVERWRITES the target's tables, so the caller confirms first.
#[tauri::command(async)]
fn db_import(series: String, db_name: String, file: String) -> Res<String> {
    database::import(&series, &db_name, std::path::Path::new(&file))?;
    Ok(format!("Imported into `{db_name}`."))
}

/// Bytes under a site's docroot, for the size readout on Overview.
#[tauri::command(async)]
fn site_disk_usage(state: State<'_, AppState>, domain: String) -> Res<u64> {
    let site = site_by_domain(&state, &domain)?;
    Ok(site::disk_usage(&site.docroot))
}

/// Files and database in one archive in ~/Downloads. Returns where it landed.
#[tauri::command(async)]
fn site_export_all(state: State<'_, AppState>, domain: String) -> Res<String> {
    Ok(state
        .app
        .export_site(&domain)?
        .to_string_lossy()
        .into_owned())
}

/// Open wp-admin already logged in, optionally at a particular screen.
///
/// `adminPath` is relative to wp-admin -- "site-editor.php", "edit.php" -- and
/// the mu-plugin that consumes the token keeps the redirect inside this site's
/// admin, so a path from the UI cannot be turned into an open redirect.
#[tauri::command(async)]
fn wp_open_admin(
    state: State<'_, AppState>,
    domain: String,
    admin_path: Option<String>,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    let url = canonical_url(&state, &site.domain)?;
    let link = wordpress::magic_login_to(&site, &url, "", admin_path.as_deref())?;
    open_url(&state, &link)?;
    Ok(link)
}

// ------------------------------------------------------------ onboarding

/// One component the first run offers to install.
///
/// `size_mb` is the download, not the installed size, because the number a
/// person is deciding about is the one that costs them time.
#[derive(serde::Serialize)]
struct SetupComponent {
    id: String,
    name: String,
    detail: String,
    version: String,
    size_mb: u32,
    installed: bool,
}

#[derive(serde::Serialize)]
struct SetupStatus {
    /// Has someone already been through the first run?
    done: bool,
    /// The PHP the wizard would install, from settings.
    default_php: String,
    default_mysql: String,
    tld: String,
    components: Vec<SetupComponent>,
    /// Are the system changes (resolver, root edge, trusted CA) already made?
    https_ready: bool,
}

/// What the first run would do, and how much of it is already true.
///
/// Recomputed rather than remembered: someone can install PHP from the PHP tab
/// and then open onboarding, and a wizard that offers to download it again is
/// a wizard that has stopped telling the truth.
#[tauri::command(async)]
fn setup_status(state: State<'_, AppState>) -> Res<SetupStatus> {
    let default_php = state.app.db.default_php()?;
    let default_mysql = runtime::MYSQL_SERIES
        .first()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "8.4".into());
    let tld = state.app.db.tld()?;

    let php_pin = runtime::php_pin(&default_php, "fpm").ok();
    let components = vec![
        SetupComponent {
            id: "php".into(),
            name: "PHP".into(),
            detail: "A static build with mysqli, intl, imagick, sodium and OPcache -- the set a \
                     real WordPress site expects. Installed per version, so a site on 8.1 is \
                     served by 8.1."
                .into(),
            version: php_pin.map(|p| p.patch.to_string()).unwrap_or(default_php.clone()),
            size_mb: 30,
            installed: runtime::is_installed(&default_php, "fpm")
                && runtime::is_installed(&default_php, "cli"),
        },
        SetupComponent {
            id: "mysql".into(),
            name: "MySQL".into(),
            detail: "Runs on port 13316 so it cannot collide with a MySQL you already have. \
                     The root account is loopback-only and has no password."
                .into(),
            version: default_mysql.clone(),
            size_mb: 320,
            installed: database::is_installed(&default_mysql),
        },
        SetupComponent {
            id: "wp-cli".into(),
            name: "WP-CLI".into(),
            detail: "Bundled rather than required. Every site is managed by its own PHP, so \
                     `wp` in a site's terminal is that site's `wp`."
                .into(),
            version: runtime::WPCLI_PIN.version.into(),
            size_mb: 7,
            installed: wordpress::is_installed(),
        },
        SetupComponent {
            id: "mailpit".into(),
            name: "Mailpit".into(),
            detail: "Catches mail your sites send instead of delivering it, so a password \
                     reset in development never reaches a real inbox."
                .into(),
            version: "1.31.1".into(),
            size_mb: 25,
            installed: mail::is_installed(),
        },
        SetupComponent {
            id: "adminer".into(),
            name: "Adminer".into(),
            detail: "The database browser in each site's Database tab. One PHP file, run by \
                     the PHP that is already here."
                .into(),
            version: runtime::ADMINER_PIN.version.into(),
            size_mb: 1,
            installed: core::adminer::is_installed(),
        },
    ];

    let report = privileged::verify(&tld);

    let installed = |id: &str| components.iter().any(|c| c.id == id && c.installed);
    let flag = state.app.db.setting("onboarding_done")?;
    let done = onboarding_done(
        flag.as_deref(),
        !site::list(&state.app.db)?.is_empty(),
        installed("php") && installed("mysql") && installed("wp-cli"),
    );
    // Decided once. Writing it here means a setup that predates the flag --
    // or one whose wizard was always skipped -- settles the question on the
    // next launch instead of re-deriving it forever.
    if done && flag.as_deref() != Some("1") {
        let _ = state.app.db.set_setting("onboarding_done", "1");
    }

    Ok(SetupStatus {
        done,
        default_php,
        default_mysql,
        tld,
        components,
        https_ready: report.all_ok,
    })
}

/// Whether the first run is behind us.
///
/// The flag alone is not enough: it is only written when the wizard is seen
/// through to its last step, so someone who skips it every time would be
/// greeted forever -- on a machine with sites on it. A machine that has sites,
/// or that already has the runtimes the wizard installs, has plainly been set
/// up, whoever set it up.
fn onboarding_done(flag: Option<&str>, has_sites: bool, runtimes_ready: bool) -> bool {
    flag == Some("1") || has_sites || runtimes_ready
}

#[cfg(test)]
mod onboarding_tests {
    use super::onboarding_done;

    #[test]
    fn a_fresh_machine_is_greeted_and_nothing_else_is() {
        // Nothing installed, no sites, wizard never finished: the first run.
        assert!(!onboarding_done(None, false, false));
        // Skipped the wizard, but has been using the app since.
        assert!(onboarding_done(None, true, false));
        // Set up before the flag existed, or by the CLI.
        assert!(onboarding_done(None, false, true));
        // Finished the wizard, on a machine with nothing else yet.
        assert!(onboarding_done(Some("1"), false, false));
        // Explicitly not done, and no evidence otherwise.
        assert!(!onboarding_done(Some("0"), false, false));
    }
}

/// Fetch Adminer on its own, so the first run can install it up front rather
/// than making the first visit to a Database tab wait for a download.
#[tauri::command]
async fn setup_install_adminer(app: tauri::AppHandle) -> Res<String> {
    let handle = app.clone();
    core::adminer::ensure(move |p| {
        let _ = handle.emit(
            "download-progress",
            serde_json::json!({ "id": "adminer", "component": p.component,
                                "received": p.received, "total": p.total }),
        );
    })
    .await?;
    Ok(format!("Adminer {} ready", runtime::ADMINER_PIN.version))
}

/// Remember that the first run happened, so it does not greet them again.
#[tauri::command(async)]
fn setup_finish(state: State<'_, AppState>, done: bool) -> Res<()> {
    state
        .app
        .db
        .set_setting("onboarding_done", if done { "1" } else { "0" })?;
    Ok(())
}

// ----------------------------------------------------------- wordpress

#[tauri::command]
async fn wp_ensure_cli(app: tauri::AppHandle) -> Res<String> {
    let handle = app.clone();
    wordpress::ensure_wp_cli(move |p| {
        let _ = handle.emit(
            "download-progress",
            serde_json::json!({
                "id": "wp-cli",
                "component": p.component,
                "received": p.received,
                "total": p.total,
            }),
        );
    })
    .await?;
    Ok(format!("WP-CLI {} ready", runtime::WPCLI_PIN.version))
}

fn site_by_domain(state: &State<'_, AppState>, domain: &str) -> Res<site::Site> {
    site::find(&state.app.db, domain)?
        .ok_or_else(|| format!("no site answers on `{domain}`"))
}

#[derive(serde::Serialize)]
struct WpStatus {
    is_wordpress: bool,
    version: String,
}

#[tauri::command(async)]
fn wp_status(state: State<'_, AppState>, domain: String) -> Res<WpStatus> {
    let site = site_by_domain(&state, &domain)?;
    let is_wordpress = wordpress::is_wordpress(&site);
    Ok(WpStatus {
        version: if is_wordpress {
            wordpress::core_version(&site).unwrap_or_default()
        } else {
            String::new()
        },
        is_wordpress,
    })
}

/// Install WordPress into an existing site: database, config, core, admin.
#[tauri::command(async)]
fn wp_install(
    state: State<'_, AppState>,
    domain: String,
    req: wordpress::WpInstallRequest,
) -> Res<wordpress::WpInstallResult> {
    let site = site_by_domain(&state, &domain)?;
    let series = default_db_series(&state);

    if !database::is_installed(&series) {
        return Err(format!(
            "MySQL {series} is not installed yet. Install it from the Services tab first —              WordPress needs a database."
        ));
    }
    database::start(&state.app.sup, &series)?;
    php::start_pool(&state.app.sup, &site.php_minor)?;

    let creds = database::create_for_site(&series, &site.domain)?;
    let url = canonical_url(&state, &site.domain)?;

    let res = wordpress::install(&site, &req, &series, &creds, &url)?;

    site::set_database(&state.app.db, site.id, &series, &creds.name)?;
    Ok(res)
}

fn default_db_series(state: &State<'_, AppState>) -> String {
    state
        .app
        .db
        .setting("db_series")
        .ok()
        .flatten()
        .unwrap_or_else(|| runtime::MYSQL_SERIES[0].to_string())
}

#[tauri::command(async)]
fn wp_magic_login(state: State<'_, AppState>, domain: String, user: String) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    let url = canonical_url(&state, &site.domain)?;
    let link = wordpress::magic_login(&site, &url, &user)?;
    open_url(&state, &link)?;
    Ok(link)
}

/// Install a plugin or theme by cloning a git repository into wp-content.
///
/// Not WP-CLI's job: `plugin install` takes a zip, not a working tree. A clone
/// is what you want for something you are developing -- the folder stays a git
/// checkout you can pull and commit from.
#[tauri::command(async)]
fn wp_install_from_git(
    state: State<'_, AppState>,
    domain: String,
    kind: String,
    url: String,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    if kind != "plugin" && kind != "theme" {
        return Err(format!("unknown kind {kind}"));
    }

    let raw = url.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("Give a repository URL or owner/repo.".into());
    }

    // `owner/repo` is the shorthand people actually type; anything with a
    // scheme or an SSH prefix is passed through untouched, so GitLab, a
    // private host and git@github.com all still work.
    let looks_like_shorthand = !raw.contains("://")
        && !raw.starts_with("git@")
        && raw.matches('/').count() == 1;
    let clone_url = if looks_like_shorthand {
        format!("https://github.com/{raw}.git")
    } else {
        raw.to_string()
    };

    let folder = clone_url
        .trim_end_matches(".git")
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Could not read a folder name from that URL.".to_string())?
        .to_string();

    let target = std::path::Path::new(&site.docroot)
        .join("wp-content")
        .join(format!("{kind}s"))
        .join(&folder);
    if target.exists() {
        return Err(format!(
            "{folder} is already in wp-content/{kind}s. Delete it first, or pull inside it."
        ));
    }

    // Shallow by default: a plugin checkout is for running, and full history
    // on a large repo turns a click into a long wait with no progress shown.
    let out = std::process::Command::new("/usr/bin/git")
        .args(["clone", "--depth", "1", &clone_url])
        .arg(&target)
        .output()
        .map_err(|e| format!("git could not be run: {e}. Install the Xcode command line tools."))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git clone failed:\n{}", err.trim()));
    }

    Ok(format!("Cloned {clone_url} into wp-content/{kind}s/{folder}."))
}

#[tauri::command(async)]
fn wp_roles(state: State<'_, AppState>, domain: String) -> Res<Vec<String>> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::roles(&site)?)
}

#[tauri::command(async)]
fn wp_create_user(
    state: State<'_, AppState>,
    domain: String,
    login: String,
    email: String,
    password: String,
    role: String,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::create_user(&site, &login, &email, &password, &role)?)
}

#[tauri::command(async)]
fn wp_set_user_role(
    state: State<'_, AppState>,
    domain: String,
    login: String,
    role: String,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::set_user_role(&site, &login, &role)?)
}

#[tauri::command(async)]
fn wp_set_user_password(
    state: State<'_, AppState>,
    domain: String,
    login: String,
    password: String,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::set_user_password(&site, &login, &password)?)
}

#[tauri::command(async)]
fn wp_delete_user(
    state: State<'_, AppState>,
    domain: String,
    login: String,
    reassign_to: Option<String>,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::delete_user(&site, &login, reassign_to.as_deref())?)
}

// ---------------------------------------------------------- wordpress tools

macro_rules! site_cmd {
    ($name:ident, $ret:ty, |$site:ident $(, $arg:ident : $ty:ty)*| $body:expr) => {
        #[tauri::command]
        fn $name(state: State<'_, AppState>, domain: String $(, $arg: $ty)*) -> Res<$ret> {
            let $site = site_by_domain(&state, &domain)?;
            Ok($body?)
        }
    };
}

site_cmd!(wp_config_get, Option<String>, |site, key: String| wptools::config_get(&site, &key));
site_cmd!(wp_config_set_bool, String, |site, key: String, on: bool| wptools::config_set_bool(&site, &key, on));
site_cmd!(wp_option_get, String, |site, key: String| wptools::option_get(&site, &key));
site_cmd!(wp_option_set, String, |site, key: String, value: String| wptools::option_set(&site, &key, &value));
site_cmd!(wp_set_permalinks, String, |site, structure: String| wptools::set_permalinks(&site, &structure));
site_cmd!(wp_flush_rewrites, String, |site| wptools::flush_rewrites(&site));
site_cmd!(wp_maintenance_status, bool, |site| wptools::maintenance_status(&site));
site_cmd!(wp_set_maintenance, String, |site, on: bool| wptools::set_maintenance(&site, on));
site_cmd!(wp_flush_cache, String, |site| wptools::flush_cache(&site));
site_cmd!(wp_delete_transients, String, |site| wptools::delete_transients(&site));
site_cmd!(wp_reset_site, String, |site| wptools::reset_site(&site));
site_cmd!(wp_core_reinstall, String, |site| wptools::core_reinstall(&site));
site_cmd!(wp_verify_checksums, String, |site| wptools::verify_checksums(&site));
site_cmd!(wp_languages, Vec<wptools::WpLanguage>, |site| wptools::languages(&site));
site_cmd!(wp_set_language, String, |site, locale: String| wptools::set_language(&site, &locale));
site_cmd!(wp_cron_events, Vec<wptools::CronEvent>, |site| wptools::cron_events(&site));
site_cmd!(wp_export_database, String, |site| wptools::export_database(&site));
site_cmd!(wp_import_database, String, |site, file: String| wptools::import_database(&site, &file));
site_cmd!(wp_export_content, String, |site| wptools::export_content(&site));

/// Core version currently on disk.
#[tauri::command(async)]
fn wp_core_version(state: State<'_, AppState>, domain: String) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::core_version(&site)?)
}

/// Update core, optionally to a named version (which may be a downgrade).
#[tauri::command(async)]
fn wp_core_update(
    state: State<'_, AppState>,
    domain: String,
    version: Option<String>,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wptools::core_update(&site, version.as_deref())?)
}

/// Run one cron hook, or everything due when `hook` is absent.
#[tauri::command(async)]
fn wp_cron_run(state: State<'_, AppState>, domain: String, hook: Option<String>) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wptools::cron_run(&site, hook.as_deref())?)
}

/// A theme or plugin's screenshot, as a data URI. `null` when it has none.
#[tauri::command(async)]
fn wp_item_screenshot(
    state: State<'_, AppState>,
    domain: String,
    kind: String,
    name: String,
) -> Res<Option<String>> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::item_screenshot(&site, &kind, &name)?)
}

/// Update one plugin or theme in place.
#[tauri::command(async)]
fn wp_update_item(
    state: State<'_, AppState>,
    domain: String,
    kind: String,
    name: String,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::update_item(&site, &kind, &name)?)
}

/// A shell in one folder inside a site, with that site's `wp` and PHP on PATH.
///
/// The path is checked to be inside the docroot: this opens a terminal, so an
/// arbitrary path arriving from the UI is worth refusing rather than trusting.
#[tauri::command(async)]
fn site_terminal_at(state: State<'_, AppState>, domain: String, path: String) -> Res<()> {
    let site = site_by_domain(&state, &domain)?;
    let root = std::fs::canonicalize(&site.docroot).map_err(|e| e.to_string())?;
    let target = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !target.starts_with(&root) {
        return Err("That folder is not inside this site.".into());
    }
    Ok(exec::open_terminal_in(&site, &target, &preferred_terminal(&state.app.db))?)
}

#[tauri::command(async)]
fn wp_users(state: State<'_, AppState>, domain: String) -> Res<Vec<wordpress::WpUser>> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::users(&site)?)
}

#[tauri::command(async)]
fn wp_items(
    state: State<'_, AppState>,
    domain: String,
    kind: String,
    // false skips the wordpress.org round trip so the list can show at once;
    // the UI asks again with it for the update badges. Absent means true.
    updates: Option<bool>,
) -> Res<Vec<wordpress::WpItem>> {
    let site = site_by_domain(&state, &domain)?;
    let kind = if kind == "theme" { "theme" } else { "plugin" };
    Ok(wordpress::items(&site, kind, updates.unwrap_or(true))?)
}

#[tauri::command(async)]
fn wp_install_item(
    state: State<'_, AppState>,
    domain: String,
    kind: String,
    source: String,
    activate: bool,
    force: bool,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::install_item(&site, &kind, &source, activate, force)?)
}

#[tauri::command(async)]
fn wp_set_item_state(
    state: State<'_, AppState>,
    domain: String,
    kind: String,
    name: String,
    activate: bool,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::set_item_state(&site, &kind, &name, activate)?)
}

#[tauri::command(async)]
fn wp_delete_item(
    state: State<'_, AppState>,
    domain: String,
    kind: String,
    name: String,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::delete_item(&site, &kind, &name)?)
}

/// Defaults to a dry run: the operation most likely to be right in intent and
/// wrong in scope.
#[tauri::command(async)]
fn wp_search_replace(
    state: State<'_, AppState>,
    domain: String,
    from: String,
    to: String,
    dry_run: bool,
) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    Ok(wordpress::search_replace(&site, &from, &to, dry_run)?)
}

// ----------------------------------------------------------- migration

#[tauri::command(async)]
fn migrate_scan(state: State<'_, AppState>) -> Res<migrate::ScanResult> {
    Ok(migrate::scan(&state.app.db)?)
}

/// Import found sites. The source installation is never written to.
#[tauri::command(async)]
fn migrate_import(
    state: State<'_, AppState>,
    requests: Vec<migrate::ImportRequest>,
) -> Res<Vec<String>> {
    let mut done = Vec::new();
    for req in &requests {
        match migrate::import_site(&state.app.db, req) {
            Ok(s) => {
                let _ = state.app.ensure_cert(&s);
                done.push(format!("Imported {}", s.domain));
            }
            // One refusal must not abandon the rest: report it and continue.
            Err(e) => done.push(format!("Skipped {}: {e}", req.domain)),
        }
    }
    let _ = state.app.reload_dns();
    Ok(done)
}


// ----------------------------------------------------------------- mail

fn catch_all_on(state: &State<'_, AppState>) -> bool {
    // Absent is ON deliberately: a site created before the switch existed is
    // caught too, because "every site's mail is caught" must not quietly mean
    // "every site created after you found the switch".
    state
        .app
        .db
        .setting("catch_all")
        .ok()
        .flatten()
        .map(|v| v != "0")
        .unwrap_or(true)
}

#[tauri::command(async)]
fn mail_status(state: State<'_, AppState>) -> Res<mail::MailStatus> {
    Ok(mail::status(&state.app.sup, catch_all_on(&state)))
}

#[tauri::command]
async fn mail_install(app: tauri::AppHandle) -> Res<String> {
    let handle = app.clone();
    mail::install(move |p| {
        let _ = handle.emit(
            "download-progress",
            serde_json::json!({ "id": "mailpit", "component": p.component,
                                "received": p.received, "total": p.total }),
        );
    })
    .await?;
    Ok("Mailpit installed".into())
}

#[tauri::command(async)]
fn mail_start(state: State<'_, AppState>) -> Res<u16> {
    let port = mail::start(&state.app.sup)?;
    apply_catch_all(&state, catch_all_on(&state))?;
    Ok(port)
}

#[tauri::command(async)]
fn mail_stop(state: State<'_, AppState>) -> Res<bool> {
    Ok(mail::stop(&state.app.sup)?)
}

#[tauri::command(async)]
fn mail_open(state: State<'_, AppState>) -> Res<()> {
    let st = mail::status(&state.app.sup, catch_all_on(&state));
    open_url(&state, &st.ui_url)
}

/// Flipping the switch installs or removes the mu-plugin on every WordPress
/// site and restarts the running pools, so the toggle stays pending until that
/// is true of the machine rather than only of the setting.
fn apply_catch_all(state: &State<'_, AppState>, on: bool) -> Res<()> {
    for s in site::list(&state.app.db)? {
        let _ = mail::set_site_catch(&s.docroot, on);
    }
    for m in runtime::PHP_MINORS {
        if state.app.sup.is_running(&php::pool_name(m)) {
            let _ = php::stop_pool(&state.app.sup, m);
            let _ = php::start_pool(&state.app.sup, m);
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn mail_set_catch_all(state: State<'_, AppState>, on: bool) -> Res<String> {
    state.app.db.set_setting("catch_all", if on { "1" } else { "0" })?;
    apply_catch_all(&state, on)?;
    Ok(if on {
        "Every site's mail now goes to Mailpit.".into()
    } else {
        "Mail leaves as each site is configured. Turn this off only to test a live provider on purpose.".to_string()
    })
}

// -------------------------------------------------------------- tunnels

#[tauri::command(async)]
fn tunnel_status(state: State<'_, AppState>) -> Res<serde_json::Value> {
    // Sweeping on read is what makes a forgotten share findable: a row whose
    // process is gone, or one past its deadline, is reconciled here.
    let _ = tunnel::sweep(&state.app.db, &state.app.sup);
    Ok(serde_json::json!({
        "installed": tunnel::is_installed(),
        "tunnels": tunnel::list(&state.app.db)?,
    }))
}

#[tauri::command]
async fn tunnel_install(app: tauri::AppHandle) -> Res<String> {
    let handle = app.clone();
    tunnel::install(move |p| {
        let _ = handle.emit(
            "download-progress",
            serde_json::json!({ "id": "cloudflared", "component": p.component,
                                "received": p.received, "total": p.total }),
        );
    })
    .await?;
    Ok("cloudflared installed".into())
}

#[tauri::command(async)]
fn tunnel_start(state: State<'_, AppState>, domain: String) -> Res<String> {
    // A tunnel with no stack behind it publishes a 502 to the internet.
    if state.edge.lock().unwrap().is_none() {
        return Err("Start the stack first — a share with nothing behind it publishes an error page.".into());
    }
    // The app owns this share, so the guard watches THIS process and closes
    // the tunnel the moment it goes -- crash included.
    Ok(tunnel::start(
        &state.app.db,
        &state.app.sup,
        &domain,
        Some(std::process::id()),
    )?)
}

#[tauri::command(async)]
fn tunnel_stop(state: State<'_, AppState>, domain: String) -> Res<bool> {
    Ok(tunnel::stop(&state.app.db, &state.app.sup, &domain)?)
}

// ----------------------------------------------------------------- logs

#[tauri::command(async)]
fn logs_sources() -> Res<Vec<qlog::LogSource>> {
    Ok(qlog::sources())
}

#[tauri::command(async)]
fn logs_tail(id: String, lines: Option<usize>) -> Res<String> {
    Ok(qlog::tail(&id, lines.unwrap_or(400))?)
}

// ------------------------------------------------------------- terminal

/// Run a command in the site's docroot, streaming output as `exec-line`.
#[tauri::command]
async fn site_exec(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    domain: String,
    command: String,
) -> Res<i32> {
    let site = site_by_domain(&state, &domain)?;
    let handle = app.clone();
    let id = domain.clone();
    let code = exec::run_streaming(&site, &command, move |line| {
        let _ = handle.emit(
            "exec-line",
            serde_json::json!({ "domain": id, "stream": line.stream, "text": line.text }),
        );
    })?;
    Ok(code)
}

/// Open the preferred terminal in the docroot, for anything interactive the
/// runner cannot host.
#[tauri::command(async)]
fn site_terminal(state: State<'_, AppState>, domain: String) -> Res<()> {
    let site = site_by_domain(&state, &domain)?;
    Ok(exec::open_terminal(&site, &preferred_terminal(&state.app.db))?)
}


// ------------------------------------------------------------ terminal

/// Open a real shell in a site's docroot.
///
/// A PTY, not a pipe: the child gets a TTY, so it line-edits, paints colour and
/// can be answered. Output arrives as `pty-output` events keyed by session id.
#[tauri::command]
fn pty_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    domain: String,
    cols: u16,
    rows: u16,
) -> Res<()> {
    let site = site_by_domain(&state, &domain)?;
    let out_handle = app.clone();
    let out_id = id.clone();
    let exit_handle = app.clone();
    let exit_id = id.clone();

    state.ptys.open(
        &id,
        &site,
        cols.max(20),
        rows.max(5),
        move |chunk| {
            let _ = out_handle.emit(
                "pty-output",
                serde_json::json!({ "id": out_id, "data": chunk }),
            );
        },
        move || {
            let _ = exit_handle.emit("pty-exit", serde_json::json!({ "id": exit_id }));
        },
    )?;
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Res<()> {
    Ok(state.ptys.write(&id, &data)?)
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Res<()> {
    Ok(state.ptys.resize(&id, cols.max(20), rows.max(5))?)
}

#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: String) -> Res<bool> {
    Ok(state.ptys.close(&id)?)
}

// -------------------------------------------------- migration stages 2/3

#[tauri::command(async)]
fn migrate_copy_database(state: State<'_, AppState>, domain: String) -> Res<migrate::DbCopyResult> {
    let site = site_by_domain(&state, &domain)?;
    let series = default_db_series(&state);
    if !database::is_installed(&series) {
        return Err(format!("MySQL {series} is not installed. Install it in Services first."));
    }
    database::start(&state.app.sup, &series)?;
    Ok(migrate::copy_database(&series, &site)?)
}

/// What the rewrite WOULD change. Writes nothing.
#[tauri::command(async)]
fn migrate_preview_config(state: State<'_, AppState>, domain: String) -> Res<migrate::ConfigDiff> {
    let site = site_by_domain(&state, &domain)?;
    let target = site
        .db_name
        .clone()
        .ok_or("Copy the database first — there is nothing to point the config at.")?;
    Ok(migrate::preview_config_rewrite(&site, &target)?)
}

#[tauri::command(async)]
fn migrate_apply_config(state: State<'_, AppState>, domain: String) -> Res<String> {
    let site = site_by_domain(&state, &domain)?;
    let target = site
        .db_name
        .clone()
        .ok_or("Copy the database first — there is nothing to point the config at.")?;
    Ok(migrate::apply_config_rewrite(&site, &target)?)
}

// ------------------------------------------------------------- settings

#[tauri::command(async)]
fn settings_get(state: State<'_, AppState>) -> Res<serde_json::Value> {
    Ok(serde_json::json!({
        "tld": state.app.db.tld()?,
        "default_php": state.app.db.default_php()?,
        "root": core::paths::root().to_string_lossy(),
        "sites_dir": state.app.db.sites_dir()?.to_string_lossy(),
        "default_sites_dir": core::paths::default_sites().to_string_lossy(),
        "logs_dir": core::paths::logs().to_string_lossy(),
        "editor": preferred_editor(&state.app.db).map(|p| p.display().to_string()),
        "terminal": preferred_terminal(&state.app.db).display().to_string(),
        // Nothing chosen means the system default, shown as that browser.
        "browser": preferred_browser(&state.app.db)
            .or_else(core::apps::default_browser)
            .map(|p| p.display().to_string()),
        "quit_behavior": state.app.db.setting("quit_behavior")?.unwrap_or_else(|| "ask".into()),
        "language": state.app.db.setting("language")?.unwrap_or_else(|| "en".into()),
    }))
}

#[tauri::command(async)]
fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Res<String> {
    if key == "tld" {
        if value.contains('.') || value.trim().is_empty() {
            return Err("A TLD is a single label, like `test` — no dots.".into());
        }
        state.app.db.set_setting(&key, value.trim())?;
        state.app.reload_dns()?;
        return Ok(format!(
            "New sites will use .{}. Existing sites keep the names they have.",
            value.trim()
        ));
    }

    if key == "quit_behavior" && !QUIT_CHOICES.contains(&value.as_str()) {
        return Err(format!("Unknown choice for quitting: {value}"));
    }

    if key == "editor" || key == "terminal" || key == "browser" {
        let app = std::path::Path::new(&value);
        if !(value.ends_with(".app") && app.is_dir()) {
            return Err(format!("{value} is not an installed app."));
        }
        // Choosing the system's default browser stores nothing, so a later
        // change of default in System Settings is followed, not overridden.
        let follows_system =
            key == "browser" && core::apps::default_browser().as_deref() == Some(app);
        state.app.db.set_setting(&key, if follows_system { "" } else { value.as_str() })?;
        return Ok(format!("Sites now open in {}.", core::apps::name_of(app)));
    }

    if key == "sites_dir" {
        // Validated and created here rather than on first use, so a folder that
        // cannot be written to is refused now instead of failing every future
        // site creation.
        let path = state.app.db.set_sites_dir(&value)?;
        return Ok(format!(
            "New sites will be created in {}. Existing sites stay where they are — \
             QuickWP does not move your code because a preference changed.",
            path.display()
        ));
    }

    state.app.db.set_setting(&key, &value)?;
    Ok("Saved.".into())
}

#[derive(serde::Serialize)]
struct InstalledApps {
    editors: Vec<core::apps::InstalledApp>,
    terminals: Vec<core::apps::InstalledApp>,
    browsers: Vec<core::apps::InstalledApp>,
}

/// Editors, terminals and browsers on this Mac, for the pickers in App
/// settings. Off the main thread: finding browsers asks macOS.
#[tauri::command]
async fn apps_installed() -> Res<InstalledApps> {
    tauri::async_runtime::spawn_blocking(|| InstalledApps {
        editors: core::apps::editors(),
        terminals: core::apps::terminals(),
        browsers: core::apps::browsers(),
    })
    .await
    .map_err(|e| e.to_string())
}

/// PHP installed outside QuickWP. Every binary is asked for its version, so
/// this runs off the main thread.
#[tauri::command]
async fn php_system_list() -> Res<Vec<core::phpscan::SystemPhp>> {
    tauri::async_runtime::spawn_blocking(core::phpscan::list)
        .await
        .map_err(|e| e.to_string())
}

// ----------------------------------------------------------------- quit

const QUIT_CHOICES: &[&str] = &["ask", "keep", "restart", "stop"];

#[derive(Clone, Copy, PartialEq)]
enum QuitMode {
    /// Sites keep answering; the next launch takes them back.
    Keep,
    /// Stop now, start the same services on the next launch.
    Restart,
    Stop,
}

impl QuitMode {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "keep" => Some(Self::Keep),
            "restart" => Some(Self::Restart),
            "stop" => Some(Self::Stop),
            _ => None,
        }
    }
}

/// Anything worth asking about: the edge, or a pool, database or mail server
/// QuickWP started.
fn anything_running(state: &AppState) -> bool {
    state.edge.lock().unwrap().is_some() || !core::handoff::resumable(&state.app.sup).is_empty()
}

/// Every way of quitting lands here: the close button, Cmd+Q, the Dock.
fn request_quit(handle: &AppHandle) {
    let state = handle.state::<AppState>();
    if !anything_running(&state) {
        return finish_quit(handle, QuitMode::Stop);
    }
    let choice = state.app.db.setting("quit_behavior").ok().flatten().unwrap_or_default();
    if let Some(mode) = QuitMode::parse(&choice) {
        return finish_quit(handle, mode);
    }
    // "Ask every time": the window asks, and answers through `app_quit`.
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = handle.emit("quit-requested", ());
}

fn finish_quit(handle: &AppHandle, mode: QuitMode) {
    let state = handle.state::<AppState>();
    state.quitting.store(true, Ordering::SeqCst);
    shutdown(&state, mode);
    handle.exit(0);
}

fn shutdown(state: &AppState, mode: QuitMode) {
    if state.down.swap(true, Ordering::SeqCst) {
        return;
    }
    let serving = match state.edge.lock().unwrap().take() {
        Some(e) => {
            e.stop();
            true
        }
        None => false,
    };
    // A public URL still up because you forgot about it is not a convenience:
    // a share you have forgotten is a share you did not consent to. Tunnels
    // close whatever the choice.
    state.ptys.close_all();
    tunnel::stop_all(&state.app.db, &state.app.sup);
    state.app.stop_dns();

    let services = core::handoff::resumable(&state.app.sup);
    let record = match mode {
        QuitMode::Stop => None,
        QuitMode::Restart => Some(core::handoff::Handoff { services, edge: serving, orphans: vec![] }),
        QuitMode::Keep => match core::handoff::keep_running(&state.app.sup, &cli_binary(), serving) {
            // The services stay up: that is the choice.
            Ok(h) => {
                let _ = core::handoff::save(&h);
                return;
            }
            Err(e) => {
                qlog::write(&format!("could not keep sites running, stopping them instead: {e}"));
                Some(core::handoff::Handoff { services, edge: serving, orphans: vec![] })
            }
        },
    };
    state.app.sup.stop_all();
    match record {
        Some(h) if h.edge || !h.services.is_empty() => {
            let _ = core::handoff::save(&h);
        }
        _ => core::handoff::clear(),
    }
}

/// The answer to "quit-requested", from the window's dialog.
#[tauri::command]
fn app_quit(app: AppHandle, state: State<'_, AppState>, mode: String, remember: bool) -> Res<()> {
    let m = QuitMode::parse(&mode).ok_or_else(|| format!("Unknown choice for quitting: {mode}"))?;
    if remember {
        state.app.db.set_setting("quit_behavior", &mode)?;
    }
    finish_quit(&app, m);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Commands run on this runtime's workers (`#[tauri::command(async)]`) --
    // not the main thread, which would freeze the window and run them one at
    // a time. One can sit on a WP-CLI process for a second or more and a
    // single screen fires a dozen, so there are enough workers that they
    // never queue behind each other or starve the async commands.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(32)
        .enable_all()
        .build()
        .expect("QuickWP could not start its async runtime");
    tauri::async_runtime::set(runtime.handle().clone());

    let app = Quickwp::new().expect("QuickWP could not open its data directory");

    // Reconcile shares before the window opens. A tunnel left running by a
    // previous crash is exactly the forgotten share this sweeps up.
    if let Err(e) = tunnel::sweep(&app.db, &app.sup) {
        quickwp_core::log::write(&format!("tunnel sweep failed at launch: {e}"));
    }

    // If our resolver is installed, .test lookups go to our DNS and nowhere
    // else -- so a machine with the resolver but no server has names that hang.
    // Repair that on launch rather than waiting for someone to press Start.
    if let Ok(tld) = app.db.tld() {
        if privileged::resolver_is_ours(&tld) && !privileged::dns_agent_running() {
            let _ = privileged::install_dns_agent(&cli_binary());
            if !privileged::dns_agent_running() {
                let _ = app.start_dns();
            }
        }
    }

    // Take back what the last quit handed over, before the window opens: stop
    // the background edge, then bring the same services up under this process.
    let edge = Mutex::new(None);
    if let Some(h) = core::handoff::take() {
        core::handoff::reclaim(&h);
        for name in &h.services {
            if let Err(e) = core::handoff::start_service(&app.sup, name) {
                qlog::write(&format!("could not resume {name}: {e}"));
            }
        }
        if h.edge {
            // The background edge has only just let go of the port.
            for attempt in 0..10 {
                match start_stack(&app, &edge) {
                    Ok(()) => break,
                    Err(e) if attempt == 9 => qlog::write(&format!("could not resume the stack: {e}")),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(200)),
                }
            }
        }
    }

    tauri::Builder::default()
        // One instance only. Two copies would share one SQLite database and
        // race for the same ports, and the second would half-start: its edge
        // cannot bind, its DNS cannot bind, but its pools would still spawn.
        // Focus the window that already exists instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            app,
            edge,
            ptys: pty::Ptys::new(),
            quitting: AtomicBool::new(false),
            down: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            stack_status,
            stack_start,
            stack_stop,
            doctor,
            https_enable,
            https_preflight,
            https_tld_is_foreign,
            https_verify,
            https_trust_ca,
            https_regenerate_certs,
            remove_system_changes,
            dns_start,
            dns_stop,
            php_list,
            node_list,
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
            site_info,
            site_logs,
            site_log_tail,
            site_log_clear,
            site_log_download,
            site_cert_info,
            site_regenerate_cert,
            site_set_name,
            site_set_xdebug,
            site_remove_domain,
            site_env_get,
            site_env_set,
            site_change_domain,
            site_move,
            site_url,
            site_adminer_url,
            site_adminer_open,
            site_disk_usage,
            site_export_all,
            wp_open_admin,
            setup_status,
            setup_install_adminer,
            setup_finish,
            site_open,
            path_open,
            path_open_in_editor,
            db_list,
            db_install,
            db_start,
            db_stop,
            db_databases,
            db_export,
            db_import,
            wp_ensure_cli,
            wp_status,
            wp_install,
            wp_magic_login,
            wp_items,
            wp_users,
            wp_config_get,
            wp_config_set_bool,
            wp_option_get,
            wp_option_set,
            wp_set_permalinks,
            wp_flush_rewrites,
            wp_maintenance_status,
            wp_set_maintenance,
            wp_flush_cache,
            wp_delete_transients,
            wp_reset_site,
            wp_core_version,
            wp_core_update,
            wp_core_reinstall,
            wp_verify_checksums,
            wp_languages,
            wp_set_language,
            wp_cron_events,
            wp_cron_run,
            wp_export_database,
            wp_import_database,
            wp_export_content,
            wp_roles,
            wp_create_user,
            wp_set_user_password,
            wp_set_user_role,
            wp_delete_user,
            wp_update_item,
            wp_item_screenshot,
            site_terminal_at,
            wp_install_from_git,
            wp_install_item,
            wp_set_item_state,
            wp_delete_item,
            wp_search_replace,
            migrate_scan,
            migrate_import,
            migrate_copy_database,
            migrate_preview_config,
            migrate_apply_config,
            mail_status,
            mail_install,
            mail_start,
            mail_stop,
            mail_open,
            mail_set_catch_all,
            tunnel_status,
            tunnel_install,
            tunnel_start,
            tunnel_stop,
            logs_sources,
            logs_tail,
            site_exec,
            site_terminal,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            settings_get,
            settings_set,
            apps_installed,
            php_system_list,
            app_quit,
        ])
        .on_window_event(|window, event| match event {
            // Closing the window is quitting: it goes through the same choice
            // as Cmd+Q rather than letting the window vanish with sites up.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let handle = window.app_handle();
                if !handle.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_quit(handle);
                }
            }
            // The backstop for an exit that skipped both paths: services outlive
            // the app only where that was chosen, never by accident.
            tauri::WindowEvent::Destroyed => {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    shutdown(&state, QuitMode::Stop);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building QuickWP")
        .run(|handle, event| {
            // Cmd+Q, Quit from the Dock, logging out.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !handle.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_quit(handle);
                }
            }
        });
}
