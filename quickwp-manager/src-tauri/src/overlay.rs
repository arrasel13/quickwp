//! A see-through layer over the whole window, for the preview's menus.
//!
//! The site preview is a native view above the app's page, so a menu drawn in
//! that page opens underneath it, and a native macOS menu is drawn outside the
//! app in the system's own style. This layer is a second webview of the app
//! itself -- `index.html?overlay=1` -- kept loaded and hidden, and raised above
//! the previews while a menu is open. It is transparent everywhere but the
//! menu, and a click anywhere else closes the menu, as a menu should.
//!
//! The page asks for a menu with `overlay_show`; the overlay reports the choice
//! with an `overlay-result` event and puts itself away with `overlay_hide`.

use std::sync::Mutex;

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewBuilder, WebviewUrl, Window};

use super::Res;

const LABEL: &str = "overlay";

/// The menu on screen, for an overlay that loads after it was asked for.
#[derive(Default)]
pub struct Overlay(Mutex<Option<serde_json::Value>>);

fn ensure(window: &Window) -> Res<Webview> {
    if let Some(wv) = window.get_webview(LABEL) {
        return Ok(wv);
    }
    // Transparent: a webview paints white behind its page unless told not to,
    // and a white page over the whole window hides the app.
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::App("index.html?overlay=1".into()))
        .transparent(true)
        .focused(false);
    // Loaded outside the window, then hidden, so it never flashes up.
    let wv = window
        .add_child(builder, LogicalPosition::new(-30000.0, -30000.0), LogicalSize::new(800.0, 600.0))
        .map_err(|e| e.to_string())?;
    let _ = wv.hide();
    Ok(wv)
}

/// Load the overlay ahead of the first menu, so that one opens at once.
#[tauri::command(async)]
pub fn overlay_prepare(window: Window, overlay: State<'_, Overlay>) -> Res<()> {
    let _held = overlay.0.lock().unwrap();
    ensure(&window).map(|_| ())
}

/// Show `menu` over a window `width` by `height` logical pixels.
#[tauri::command(async)]
pub fn overlay_show(
    window: Window,
    overlay: State<'_, Overlay>,
    menu: serde_json::Value,
    width: f64,
    height: f64,
) -> Res<()> {
    let mut current = overlay.0.lock().unwrap();
    let wv = ensure(&window)?;
    *current = Some(menu.clone());
    let _ = window.app_handle().emit_to(LABEL, "overlay-menu", &menu);
    // Raised above every other webview: macOS stacks a window's views in the
    // order they were added, so a preview opened since would cover it.
    wv.reparent(&window).map_err(|e| e.to_string())?;
    let _ = wv.set_position(LogicalPosition::new(0.0, 0.0));
    let _ = wv.set_size(LogicalSize::new(width, height));
    wv.show().map_err(|e| e.to_string())?;
    // The keyboard follows the menu: arrows, Return and Escape.
    let _ = wv.set_focus();
    Ok(())
}

/// Put the overlay away and give the keyboard back to the app.
#[tauri::command(async)]
pub fn overlay_hide(window: Window, overlay: State<'_, Overlay>) -> Res<()> {
    *overlay.0.lock().unwrap() = None;
    if let Some(wv) = window.get_webview(LABEL) {
        let _ = wv.hide();
        let _ = window.app_handle().emit_to(LABEL, "overlay-menu", serde_json::Value::Null);
    }
    if let Some(main) = window.get_webview("main") {
        let _ = main.set_focus();
    }
    Ok(())
}

/// The menu on screen, if there is one.
#[tauri::command]
pub fn overlay_current(overlay: State<'_, Overlay>) -> Option<serde_json::Value> {
    overlay.0.lock().unwrap().clone()
}
