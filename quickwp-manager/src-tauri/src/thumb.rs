//! A picture of a site's front page.
//!
//! Taken while a site is running and kept, so a site that is not running still
//! has something to show: its preview pane, and Overview beside the theme it
//! runs. A site that is not being served cannot be asked for a picture, so the
//! time to take one is while it is up.
//!
//! Not taken from the preview itself. The preview is logged in, so its page
//! wears the admin bar, and it has only just finished loading when the app
//! hears about it -- a picture then is a page that has not drawn yet. This
//! loads the front page again, out of sight, in a webview of its own with no
//! cookies: what a visitor sees, at the width a visitor sees it, given a
//! moment to finish drawing.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use nexora_core::log as qlog;
use tauri::webview::PageLoadEvent;
use tauri::{LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl, Window};

/// Retaken at most this often: a site's front page loads on every visit to it.
const STALE: Duration = Duration::from_secs(10 * 60);

/// The window the page is drawn in. Wide enough for a desktop layout, so the
/// picture is not a phone's view of the site.
const PAGE: (f64, f64) = (1200.0, 900.0);

/// Out of sight, inside the window: a webview that is hidden is not drawn.
const OFFSCREEN: f64 = -30000.0;

/// After the page reports itself loaded, for images, fonts and whatever the
/// theme does on the way in.
const SETTLE: Duration = Duration::from_millis(1500);

/// A page that has not loaded by now is not going to, and one that has not
/// drawn shortly after is not drawing either.
const LOAD_TIMEOUT: Duration = Duration::from_secs(25);
const DRAW_TIMEOUT: Duration = Duration::from_secs(8);

fn key(domain: &str) -> String {
    domain
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

/// Where one site's picture lives.
pub fn path(domain: &str) -> PathBuf {
    nexora_core::paths::root().join("thumbs").join(format!("{}.png", key(domain)))
}

fn fresh(p: &PathBuf) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|age| age < STALE)
        .unwrap_or(false)
}

/// Sites being drawn right now, so a second visit does not start a second one.
fn busy() -> &'static Mutex<HashSet<String>> {
    static BUSY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    BUSY.get_or_init(Default::default)
}

/// Take a picture of `base`'s front page unless the last one is recent.
/// Returns at once; the work happens on a thread of its own.
pub fn refresh(window: &Window, domain: &str, base: &str) {
    if fresh(&path(domain)) || !busy().lock().unwrap().insert(domain.to_string()) {
        return;
    }
    let (window, domain, base) = (window.clone(), domain.to_string(), base.to_string());
    std::thread::spawn(move || {
        if let Err(e) = draw(&window, &domain, &base) {
            qlog::warn("preview", &format!("{domain}: no picture of the front page: {e}"));
        }
        busy().lock().unwrap().remove(&domain);
    });
}

/// Load the front page out of sight, keep what it drew, and close it again.
/// Runs off the main thread: making a webview waits on the main thread, which
/// cannot wait on itself.
fn draw(window: &Window, domain: &str, base: &str) -> Result<(), String> {
    let out = path(domain);
    let part = out.with_extension("part");
    let label = format!("thumb-{}", key(domain));
    if let Some(old) = window.get_webview(&label) {
        let _ = old.close();
    }
    let url = Url::parse(&format!("{base}/")).map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::channel();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        // No cookies: the front page as a visitor gets it, without the admin
        // bar the preview's own login puts on top.
        .incognito(true)
        .focused(false)
        .on_page_load(move |_wv, p| {
            if matches!(p.event(), PageLoadEvent::Finished) {
                let _ = tx.send(());
            }
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(OFFSCREEN, OFFSCREEN),
            LogicalSize::new(PAGE.0, PAGE.1),
        )
        .map_err(|e| e.to_string())?;

    let loaded = rx.recv_timeout(LOAD_TIMEOUT).is_ok();
    if loaded {
        std::thread::sleep(SETTLE);
        let _ = std::fs::remove_file(&part);
        take(&webview, part.clone());
        // WebKit draws the picture on its own time; it is done when the file
        // is there. Written beside the last one and moved over it, so a
        // capture that fails leaves the picture that worked.
        let deadline = Instant::now() + DRAW_TIMEOUT;
        while !part.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = webview.close();

    if !loaded {
        return Err("the front page did not load".into());
    }
    if !part.exists() {
        return Err("the page did not draw".into());
    }
    std::fs::rename(&part, &out).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn take(webview: &Webview, out: PathBuf) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    // with_webview hands the page over on the main thread, which is where
    // WebKit wants to be asked.
    let _ = webview.with_webview(move |platform| unsafe {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let view: &WKWebView = &*(platform.inner() as *mut WKWebView);
        let config = WKSnapshotConfiguration::new(mtm);
        // Wide enough to read at the size it is shown, small enough to keep.
        config.setSnapshotWidth(Some(&NSNumber::new_f64(640.0)));
        let done = block2::RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
            if image.is_null() {
                return;
            }
            let png = (*image).TIFFRepresentation().and_then(|tiff| {
                NSBitmapImageRep::imageRepWithData(&tiff).and_then(|rep| {
                    rep.representationUsingType_properties(
                        NSBitmapImageFileType::PNG,
                        &NSDictionary::new(),
                    )
                })
            });
            let Some(png) = png else {
                return;
            };
            if let Some(dir) = out.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&out, png.to_vec());
        });
        view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done);
    });
}

#[cfg(not(target_os = "macos"))]
fn take(_webview: &Webview, _out: PathBuf) {}

/// The picture as a data URI, for an `<img>` in the app's own page. None when
/// the site has not been seen running yet.
#[tauri::command(async)]
pub fn site_thumbnail(domain: String) -> Option<String> {
    use base64::Engine as _;
    let bytes = std::fs::read(path(&domain)).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
