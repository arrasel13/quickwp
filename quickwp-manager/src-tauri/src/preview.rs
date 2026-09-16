//! The live preview beside a site's details.
//!
//! A webview of its own laid over the pane the UI leaves for it, not an
//! iframe. A frame is a different site from the window around it and is sent
//! no cookies (see adminer.rs), so WordPress in a frame is always logged out:
//! no admin bar, and wp-admin turns you away. A child webview is a top-level
//! page with its own cookies, the way a browser tab is.
//!
//! A site's preview has three views -- the site, WordPress admin and the
//! database -- and each is a webview of its own, kept loaded while another is
//! on screen. Switching views is then showing a page that is already there,
//! not loading one. The UI preloads the other two, hidden, once the site's
//! first page is in.
//!
//! The UI owns the layout. It measures the pane and says where each frame goes
//! -- one, or a desktop and a phone side by side -- and at what zoom. This side
//! creates, places, shows and hides, and decides the address a site is reached
//! on.
//!
//! Remote pages cannot reach Nexora's commands: Tauri refuses a custom command
//! from a non-local origin unless a capability names that origin, and none do.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use nexora_core::{adminer, log as qlog, ports, probe, site::Site, wordpress};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl,
    Window,
};

use super::{AppState, Res};

const PREFIX: &str = "preview-";

const VIEWS: &[&str] = &["site", "admin", "database"];

/// Sites whose preview stays loaded while hidden. Going back to one of them
/// is instant; past this many, the least recently shown is closed, since
/// every view of every site is a web content process of its own.
const KEEP: usize = 3;

/// Where a view waits while another view of its site is on screen: outside
/// the window, but not hidden. WebKit stops painting a hidden web view and
/// throws its picture away, so showing one again flashes white until it has
/// repainted. One parked out of sight keeps its page drawn, and switching to
/// it is moving it back in -- no flash, no reload.
const OFFSCREEN: f64 = -30000.0;

#[derive(Default)]
struct Inner {
    /// Domains, most recently shown first.
    recent: VecDeque<String>,
    /// The domain each preview webview belongs to, by label.
    domain_of: HashMap<String, String>,
    /// The address each domain's preview was opened on, without a trailing
    /// slash, so every view and button stays on it.
    base: HashMap<String, String>,
    /// The zoom each webview was last given, so a resize does not set it again.
    zoom: HashMap<String, f64>,
    /// Labels in their frame, on screen.
    in_frame: HashSet<String>,
    /// Labels hidden outright: the views of sites other than the one in the
    /// preview. Anything neither in its frame nor hidden is parked offscreen.
    hidden: HashSet<String>,
}

/// Held across a whole command: two calls racing would both try to create
/// the same webview, and the second would fail on the label.
#[derive(Default)]
pub struct Previews(Mutex<Inner>);

/// One webview's place in the window, in logical pixels.
#[derive(serde::Deserialize)]
pub struct Frame {
    slot: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    zoom: f64,
}

#[derive(Clone, serde::Serialize)]
struct PageEvent {
    domain: String,
    view: String,
    slot: String,
    url: String,
    loading: bool,
}

/// Every label of one view of one site starts with this. Labels take letters,
/// digits, `-`, `/`, `:` and `_`; hostnames have no `_`, so the dots can
/// become one without two sites meeting on a label.
fn view_prefix(domain: &str, view: &str) -> String {
    let d: String = domain
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    format!("{PREFIX}{d}/{view}/")
}

fn label(domain: &str, view: &str, slot: &str) -> String {
    format!("{}{slot}", view_prefix(domain, view))
}

fn check(view: &str, slot: &str) -> Res<()> {
    if !VIEWS.contains(&view) {
        return Err(format!("`{view}` is not a preview view"));
    }
    if slot.is_empty() || !slot.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(format!("`{slot}` is not a preview slot"));
    }
    Ok(())
}

fn parse(url: &str) -> Res<Url> {
    Url::parse(url).map_err(|e| format!("`{url}` is not an address: {e}"))
}

/// The database view only ever shows Adminer: the preview is logged in as the
/// administrator, and is not a browser for anywhere else.
fn adminer_address(state: &State<'_, AppState>, url: Option<&str>) -> Res<Url> {
    let url = parse(url.ok_or_else(|| "no address for the database".to_string())?)?;
    let host = adminer::host(&state.app.db.tld()?);
    if !matches!(url.scheme(), "http" | "https") || url.host_str() != Some(host.as_str()) {
        return Err(format!("the database view does not open {url}"));
    }
    Ok(url)
}

/// Where the preview reaches a site.
///
/// Its own https address when 443 really serves it with Nexora's certificate.
/// Otherwise Nexora's own server, on its port: the stored address goes through
/// whatever holds 80 and 443, and when that is not Nexora -- HTTPS not set up,
/// or another local tool's server on the ports -- it never loads, and a webview
/// shows that as a blank page rather than an error. The port mu-plugin makes
/// WordPress follow that address instead of redirecting back.
fn base_url(state: &State<'_, AppState>, site: &Site) -> Res<String> {
    let tld = state.app.db.tld()?;
    if nexora_core::https_ready(&tld) && probe::https_serves(&site.domain) {
        return super::canonical_url(state, &site.domain);
    }
    wordpress::ensure_port_mu_plugin(site)?;
    Ok(format!("http://{}:{}", site.domain, ports::NGINX))
}

fn close(window: &Window, inner: &mut Inner, domain: &str) {
    let labels: Vec<String> = inner
        .domain_of
        .iter()
        .filter(|(_, d)| d.as_str() == domain)
        .map(|(l, _)| l.clone())
        .collect();
    for l in labels {
        if let Some(wv) = window.get_webview(&l) {
            let _ = wv.close();
        }
        inner.domain_of.remove(&l);
        inner.zoom.remove(&l);
        inner.in_frame.remove(&l);
        inner.hidden.remove(&l);
    }
    inner.base.remove(domain);
    inner.recent.retain(|d| d != domain);
}

/// Open one view's webview for one frame. `offscreen` parks it, for a preload:
/// loading and drawn, out of sight. `url` is Adminer's address, for the
/// database view.
fn create(
    window: &Window,
    state: &State<'_, AppState>,
    inner: &mut Inner,
    domain: &str,
    view: &str,
    f: &Frame,
    url: Option<&str>,
    offscreen: bool,
) -> Res<Webview> {
    let site = super::site_by_domain(state, domain)?;
    // A preview of a stack that is not up is a connection error page.
    super::ensure_serving(state)?;
    // Every view of a site, and a phone beside the desktop frame, stays on
    // the address its first view chose, and shares the login it made.
    let base = match inner.base.get(domain) {
        Some(b) => b.clone(),
        None => {
            let b = base_url(state, &site)?;
            inner.base.insert(domain.to_string(), b.clone());
            b
        }
    };
    let home = parse(&format!("{base}/"))?;
    let l = label(domain, view, &f.slot);

    let start = match view {
        // The site opens logged in, on the front page: the admin bar is part
        // of how it looks to the person building it. Anything that cannot make
        // a login -- not WordPress, WP-CLI failing -- opens logged out rather
        // than not at all.
        "site" if f.slot == "main" && site.kind == "wordpress" => {
            match wordpress::magic_login_front(&site, &base)
                .map_err(|e| e.to_string())
                .and_then(|l| parse(&l))
            {
                Ok(link) => link,
                Err(e) => {
                    qlog::warn("preview", &format!("{domain}: opening logged out, no login link: {e}"));
                    home.clone()
                }
            }
        }
        "site" => home.clone(),
        // With the login the site view made. If there is none, WordPress shows
        // its login form, and the UI asks for a login link then.
        "admin" => parse(&format!("{base}/wp-admin/"))?,
        _ => adminer_address(state, url)?,
    };
    qlog::info(
        "preview",
        &format!("{domain}: opening the {view} view ({}) on {base}", f.slot),
    );

    let page = {
        let (domain, view, slot) = (domain.to_string(), view.to_string(), f.slot.clone());
        move |wv: Webview, p: tauri::webview::PageLoadPayload<'_>| {
            let _ = wv.app_handle().emit_to(
                "main",
                "preview-page",
                PageEvent {
                    domain: domain.clone(),
                    view: view.clone(),
                    slot: slot.clone(),
                    url: p.url().to_string(),
                    loading: matches!(p.event(), PageLoadEvent::Started),
                },
            );
        }
    };

    // A link that asks for a new tab -- wp-admin's "Visit site", say -- stays
    // in the preview when it is this site, where the login is. Anywhere else
    // goes to the browser.
    let new_window = {
        let app = window.app_handle().clone();
        let (l, host) = (l.clone(), home.host_str().map(str::to_owned));
        move |target: Url, _| {
            if target.host_str() == host.as_deref() {
                if let Some(wv) = app.get_webview(&l) {
                    let _ = wv.navigate(target);
                }
            } else if matches!(target.scheme(), "http" | "https") {
                let _ = super::open_url(app.state::<AppState>().inner(), target.as_str());
            }
            NewWindowResponse::Deny
        }
    };

    // Never focused on creation: a preload must not take the keyboard from
    // whatever is being typed into.
    let builder = WebviewBuilder::new(&l, WebviewUrl::External(start))
        .focused(false)
        .on_page_load(page)
        .on_new_window(new_window);
    let (x, y) = if offscreen { (OFFSCREEN, OFFSCREEN) } else { (f.x, f.y) };
    let wv = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(f.width, f.height))
        .map_err(|e| e.to_string())?;
    let zoom = f.zoom.clamp(0.1, 1.0);
    if zoom != 1.0 {
        let _ = wv.set_zoom(zoom);
    }
    inner.domain_of.insert(l.clone(), domain.to_string());
    inner.zoom.insert(l, zoom);
    Ok(wv)
}

/// Put one view of `domain`'s preview where `frames` say, and hide every other
/// one. No domain, or no frames, hides them all: a dialog is open, the site is
/// stopped, or the pane is closed. `url` is Adminer's address, needed the
/// first time the database view is shown.
#[tauri::command(async)]
pub fn preview_layout(
    window: Window,
    state: State<'_, AppState>,
    previews: State<'_, Previews>,
    domain: Option<String>,
    view: Option<String>,
    frames: Vec<Frame>,
    url: Option<String>,
) -> Res<()> {
    let mut inner = previews.0.lock().unwrap();
    let mut shown = HashSet::new();
    // The site whose views stay drawn, parked, while not in their frame: the
    // one laid out now, or -- when everything is put away for a dialog -- the
    // one that was on screen, so closing the dialog brings it straight back.
    let mut keep_drawn = inner.recent.front().cloned();

    if let (Some(domain), Some(view)) = (domain, view) {
        for f in &frames {
            check(&view, &f.slot)?;
            let l = label(&domain, &view, &f.slot);
            let wv = match window.get_webview(&l) {
                Some(wv) => {
                    let _ = wv.set_position(LogicalPosition::new(f.x, f.y));
                    let _ = wv.set_size(LogicalSize::new(f.width, f.height));
                    wv
                }
                None => create(&window, &state, &mut inner, &domain, &view, f, url.as_deref(), false)?,
            };
            let zoom = f.zoom.clamp(0.1, 1.0);
            if inner.zoom.get(&l).copied() != Some(zoom) {
                let _ = wv.set_zoom(zoom);
                inner.zoom.insert(l.clone(), zoom);
            }
            if inner.hidden.remove(&l) {
                let _ = wv.show();
            }
            shown.insert(l);
        }

        if !frames.is_empty() {
            keep_drawn = Some(domain.clone());
            inner.recent.retain(|d| d != &domain);
            inner.recent.push_front(domain);
            while inner.recent.len() > KEEP {
                if let Some(old) = inner.recent.pop_back() {
                    close(&window, &mut inner, &old);
                }
            }
        }
    }

    // Everything else leaves only now, after what replaces it is in place, so
    // no frame ever shows the pane with nothing in it. This site's other views
    // are parked, still drawn; other sites' are hidden.
    let rest: Vec<(String, String)> = inner
        .domain_of
        .iter()
        .filter(|(l, _)| !shown.contains(*l))
        .map(|(l, d)| (l.clone(), d.clone()))
        .collect();
    for (l, d) in rest {
        let Some(wv) = window.get_webview(&l) else { continue };
        if keep_drawn.as_deref() == Some(d.as_str()) {
            if inner.in_frame.contains(&l) || inner.hidden.contains(&l) {
                let _ = wv.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
                if inner.hidden.remove(&l) {
                    let _ = wv.show();
                }
            }
        } else if inner.hidden.insert(l) {
            let _ = wv.hide();
        }
    }
    inner.in_frame = shown;
    Ok(())
}

/// Load a view of a site that is open in the preview, hidden, so switching to
/// it shows a page that is already there. Nothing to do when it is loaded, or
/// the site is not one the preview has shown.
#[tauri::command(async)]
pub fn preview_preload(
    window: Window,
    state: State<'_, AppState>,
    previews: State<'_, Previews>,
    domain: String,
    view: String,
    frame: Frame,
    url: Option<String>,
) -> Res<()> {
    let mut inner = previews.0.lock().unwrap();
    check(&view, &frame.slot)?;
    if !inner.recent.contains(&domain) || window.get_webview(&label(&domain, &view, &frame.slot)).is_some() {
        return Ok(());
    }
    create(&window, &state, &mut inner, &domain, &view, &frame, url.as_deref(), true)?;
    Ok(())
}

/// Drive one view of `domain`'s preview: reload, back, forward, go to where
/// the view starts (`home`), or `login` to wp-admin. Nothing to do when the
/// view has not been opened.
#[tauri::command(async)]
pub fn preview_go(
    window: Window,
    state: State<'_, AppState>,
    previews: State<'_, Previews>,
    domain: String,
    view: String,
    action: String,
    url: Option<String>,
) -> Res<()> {
    check(&view, "main")?;
    let inner = previews.0.lock().unwrap();
    let prefix = view_prefix(&domain, &view);
    let mut views: Vec<(String, Webview)> = inner
        .domain_of
        .keys()
        .filter(|l| l.starts_with(&prefix))
        .filter_map(|l| window.get_webview(l).map(|wv| (l.clone(), wv)))
        .collect();
    let base = inner.base.get(&domain).cloned();
    drop(inner);
    let Some(base) = base.filter(|_| !views.is_empty()) else {
        return Ok(());
    };
    // The main frame first: it is the one a login link is spent on.
    views.sort_by_key(|(l, _)| !l.ends_with("/main"));

    let each = |f: &dyn Fn(&Webview) -> tauri::Result<()>| {
        views.iter().try_for_each(|(_, wv)| f(wv)).map_err(|e| e.to_string())
    };
    match action.as_str() {
        "reload" => each(&|wv| wv.reload())?,
        "back" => each(&|wv| wv.eval("history.back()"))?,
        "forward" => each(&|wv| wv.eval("history.forward()"))?,
        "home" => {
            let to = match view.as_str() {
                "site" => parse(&format!("{base}/"))?,
                "admin" => parse(&format!("{base}/wp-admin/"))?,
                _ => adminer_address(&state, url.as_deref())?,
            };
            each(&|wv| wv.navigate(to.clone()))?
        }
        "login" => {
            // One-time: spent by the main frame. A phone beside it shares the
            // cookie the login sets and only needs wp-admin once that is there.
            let site = super::site_by_domain(&state, &domain)?;
            super::ensure_serving(&state)?;
            let link = parse(&wordpress::magic_login_to(&site, &base, "", None)?)?;
            views[0].1.navigate(link).map_err(|e| e.to_string())?;
            for (_, wv) in &views[1..] {
                let _ = wv.eval("setTimeout(function(){location.href='/wp-admin/'},1500)");
            }
        }
        other => return Err(format!("`{other}` is not something a preview does")),
    }
    Ok(())
}

/// Close the previews of sites that are no longer listed -- deleted, or given
/// another domain.
#[tauri::command(async)]
pub fn preview_prune(window: Window, previews: State<'_, Previews>, domains: Vec<String>) -> Res<()> {
    let mut inner = previews.0.lock().unwrap();
    let gone: HashSet<String> = inner
        .domain_of
        .values()
        .filter(|d| !domains.contains(d))
        .cloned()
        .collect();
    for d in gone {
        close(&window, &mut inner, &d);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check, label, view_prefix};

    #[test]
    fn a_label_is_one_tauri_accepts_and_names_the_site_view_and_slot() {
        let l = label("my-site.test", "admin", "main");
        assert_eq!(l, "preview-my-site_test/admin/main");
        assert!(l.chars().all(|c| c.is_ascii_alphanumeric() || "-/:_".contains(c)));
        assert!(l.starts_with(&view_prefix("my-site.test", "admin")));
        assert!(!label("my-site.test", "site", "main").starts_with(&view_prefix("my-site.test", "admin")));
    }

    #[test]
    fn only_known_views_and_plain_slots_are_accepted() {
        assert!(check("database", "mobile").is_ok());
        assert!(check("files", "main").is_err());
        assert!(check("site", "../x").is_err());
    }
}
