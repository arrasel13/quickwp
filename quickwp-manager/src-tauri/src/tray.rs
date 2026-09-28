//! Nexora in the menu bar: what is running, and the way into everything else.
//!
//! The menu is rebuilt from the real state -- the sites in the database, the
//! services the supervisor holds -- rather than from anything cached, so it
//! says what is true when it opens. Rebuilding is cheap (one SQLite read and a
//! walk of the supervisor's children), so a small timer keeps it current,
//! including for changes made by the CLI.
//!
//! Every item either acts here or asks the window to show a screen, through
//! the `menu-open` event the frontend listens for.

use crate::{catch_all_on, offer_of, open_url, request_quit, start_stack, AppState};
use nexora_core as core;
use nexora_core::{mail, ports};
use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub const ID: &str = "nexora-menu-bar";

/// The setting that decides whether it is there at all. On unless turned off.
pub fn wanted(state: &AppState) -> bool {
    state
        .app
        .db
        .setting("menu_bar")
        .ok()
        .flatten()
        .map(|v| v != "off")
        .unwrap_or(true)
}

/// Services Nexora is running now, and how many it could be running.
fn services(state: &AppState) -> (usize, usize) {
    let names = state.app.sup.names();
    let mut total = names.len();
    let mut running = names.iter().filter(|n| state.app.sup.is_running(n)).count();
    // The web server and the DNS server are Nexora's own, not children of the
    // supervisor, but they are services like any other to whoever is reading.
    total += 2;
    if state.edge.lock().unwrap().is_some() {
        running += 1;
    }
    if state.app.dns_running() {
        running += 1;
    }
    (running, total)
}

/// What the menu says at the top, and the signature the timer compares.
fn summary(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let (running, total) = services(&state);
    let sites = core::site::list(&state.app.db).unwrap_or_default();
    let serving = sites.iter().filter(|s| s.enabled).count();
    let head = if running == 0 {
        "Nothing running".to_string()
    } else if running == total {
        format!("All running · {running} service{}", plural(running))
    } else {
        format!("{running} of {total} services running")
    };
    if sites.is_empty() {
        head
    } else {
        format!("{head} · {serving}/{} site{}", sites.len(), plural(sites.len()))
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// Everything the menu shows, built from the state as it is now.
fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let (running, _) = services(&state);
    let sites = core::site::list(&state.app.db).unwrap_or_default();

    // The sites, each with a tick while it is being served; opening one shows
    // it in the window.
    let mut list = SubmenuBuilder::new(app, "Sites");
    if sites.is_empty() {
        list = list.item(&MenuItemBuilder::with_id("none", "No sites yet").enabled(false).build(app)?);
    }
    for s in &sites {
        list = list.item(
            &CheckMenuItemBuilder::with_id(format!("site:{}", s.domain), &s.domain)
                .checked(s.enabled)
                .build(app)?,
        );
    }
    let sites_menu = list.build()?;

    let mut m = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("summary", summary(app)).enabled(false).build(app)?)
        .separator();

    // Only when there is one waiting: an update offer that is not there is not
    // a menu item that does nothing.
    if state.update.lock().unwrap().offer.is_some() {
        m = m
            .item(&MenuItemBuilder::with_id("update", "Update Nexora…").build(app)?)
            .separator();
    }

    let m = m
        .item(
            &MenuItemBuilder::with_id("start-all", "Start all")
                .enabled(running == 0 || state.edge.lock().unwrap().is_none())
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("stop-all", "Stop all").enabled(running > 0).build(app)?)
        .separator()
        .item(&sites_menu)
        .item(&MenuItemBuilder::with_id("all-sites", "All sites…").build(app)?)
        .item(&MenuItemBuilder::with_id("services", "Services").build(app)?)
        .item(&MenuItemBuilder::with_id("databases", "Databases").build(app)?)
        .item(&MenuItemBuilder::with_id("mail", "Mail").build(app)?)
        .item(&MenuItemBuilder::with_id("tunnels", "Tunnels").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("about", "About Nexora").build(app)?)
        .item(&MenuItemBuilder::with_id("open", "Open Nexora").build(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit Nexora").build(app)?)
        .build()?;
    Ok(m)
}

/// Bring the window up, and tell it which screen to show.
fn open(app: &AppHandle, screen: &str, domain: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit(
        "menu-open",
        serde_json::json!({ "screen": screen, "domain": domain }),
    );
}

fn on_event(app: &AppHandle, id: &str) {
    match id {
        "start-all" => {
            let state = app.state::<AppState>();
            if let Err(e) = start_stack(&state.app, &state.edge) {
                core::log::warn("tray", &format!("Start all: {e}"));
            }
            refresh(app);
        }
        "stop-all" => {
            let state = app.state::<AppState>();
            if let Some(e) = state.edge.lock().unwrap().take() {
                e.stop();
            }
            state.app.stop_dns();
            state.app.sup.stop_all();
            core::log::info("stack", "stopped from the menu bar");
            drop(state);
            refresh(app);
        }
        // Adminer on the database itself, which is what "Databases" is for;
        // the Services screen is where they are installed and switched.
        "databases" => {
            // Adminer needs to be fetched and MySQL started, so it is done off
            // this thread: the menu closes rather than hanging on it.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let nexora = app.state::<AppState>().app.clone();
                match nexora.adminer_server_url(ports::MYSQL).await {
                    Ok(url) => {
                        let state = app.state::<AppState>();
                        if let Err(e) = open_url(&state, &url) {
                            core::log::warn("tray", &format!("Databases: {e}"));
                        }
                    }
                    Err(e) => {
                        core::log::warn("tray", &format!("Databases: {e}"));
                        open(&app, "services", None);
                    }
                }
            });
        }
        "mail" => {
            let state = app.state::<AppState>();
            let st = mail::status(&state.app.sup, catch_all_on(&state));
            if let Err(e) = open_url(&state, &st.ui_url) {
                core::log::warn("tray", &format!("Mail: {e}"));
                drop(state);
                open(app, "services", None);
            }
        }
        // The window already knows what to do with an offer; this is the
        // same one it would have been told about.
        "update" => {
            let state = app.state::<AppState>();
            let offer = state.update.lock().unwrap().offer.as_ref().map(offer_of);
            drop(state);
            open(app, "window", None);
            if let Some(o) = offer {
                let _ = app.emit("update-available", o);
            }
        }
        "all-sites" => open(app, "sites", None),
        "services" => open(app, "services", None),
        "tunnels" => open(app, "expose", None),
        "about" => open(app, "about", None),
        "open" => open(app, "window", None),
        "quit" => request_quit(app),
        other => {
            if let Some(domain) = other.strip_prefix("site:") {
                open(app, "site", Some(domain));
            }
        }
    }
}

/// Put Nexora in the menu bar, or leave it there if it already is.
pub fn show(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(ID).is_some() {
        return refresh_now(app);
    }
    let icon = Image::from_bytes(include_bytes!("../icons/menubar.png"))?;
    TrayIconBuilder::with_id(ID)
        .icon(icon)
        // Black with alpha: macOS tints it for the light or dark menu bar,
        // and inverts it when the menu is open.
        .icon_as_template(true)
        .tooltip("Nexora")
        .show_menu_on_left_click(true)
        .menu(&menu(app)?)
        .on_menu_event(|app, event| on_event(app, event.id().as_ref()))
        .build(app)?;
    Ok(())
}

/// Take it out of the menu bar.
pub fn hide(app: &AppHandle) {
    app.remove_tray_by_id(ID);
}

fn refresh_now(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(ID) else { return Ok(()) };
    tray.set_menu(Some(menu(app)?))
}

/// Build the menu again, if it is showing.
pub fn refresh(app: &AppHandle) {
    if let Err(e) = refresh_now(app) {
        core::log::warn("tray", &format!("could not rebuild the menu: {e}"));
    }
}

/// Follow the state while Nexora runs, so the menu is right when it opens --
/// including after a change made from the CLI. The menu is only rebuilt when
/// what it says would differ.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            if app.tray_by_id(ID).is_none() {
                last.clear();
                continue;
            }
            let state = app.state::<AppState>();
            let sites = core::site::list(&state.app.db).unwrap_or_default();
            let now = format!(
                "{}|{}",
                summary(&app),
                sites
                    .iter()
                    .map(|s| format!("{}{}", s.domain, s.enabled))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            drop(state);
            if now != last {
                last = now;
                refresh(&app);
            }
        }
    });
}
