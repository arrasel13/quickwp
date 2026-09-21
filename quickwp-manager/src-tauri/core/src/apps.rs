//! Editors and terminals installed on this Mac, and opening things in them.
//!
//! Found by bundle on disk rather than by `code` or `cursor` on PATH: a GUI
//! process does not see the PATH the user's shell builds, so a CLI shim that
//! works in their terminal is invisible from here.

use crate::{Error, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, serde::Serialize)]
pub struct InstalledApp {
    pub name: String,
    /// The bundle, e.g. `/Applications/Cursor.app`. This is what is stored as
    /// the preference, so two apps with one name cannot be confused.
    pub path: String,
    /// Terminals only: whether it can be handed a command, so the site's PHP
    /// and `wp` end up on PATH. The rest can only be pointed at a folder.
    pub commands: bool,
    /// The one macOS uses by default: Terminal.app, the default browser.
    pub default: bool,
}

/// Editors, in the order one is picked when nothing has been chosen yet.
const EDITORS: &[&str] = &[
    "Visual Studio Code",
    "Cursor",
    "Windsurf",
    "Zed",
    "Zed Preview",
    "Sublime Text",
    "PhpStorm",
    "WebStorm",
    "IntelliJ IDEA",
    "IntelliJ IDEA CE",
    "Fleet",
    "Nova",
    "BBEdit",
    "VSCodium",
    "Visual Studio Code - Insiders",
    "Kiro",
    "Trae",
    "Void",
    "TextMate",
    "CotEditor",
];

/// macOS's own terminal: always there, and the default when nothing is chosen.
pub const TERMINAL_APP: &str = "/System/Applications/Utilities/Terminal.app";

const TERMINALS: &[&str] = &[
    "Terminal", "iTerm", "iTerm2", "Warp", "Ghostty", "kitty", "Kitty", "Alacritty", "WezTerm",
    "Hyper", "Tabby", "Rio", "Wave", "Terminus", "Contour", "Konsole", "Cool Retro Term",
];

fn app_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [
        "/Applications",
        "/Applications/Utilities",
        "/System/Applications/Utilities",
        "/Applications/Setapp",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Applications"));
        // Where JetBrains Toolbox puts the IDEs it manages.
        dirs.push(home.join("Applications/JetBrains Toolbox"));
    }
    dirs
}

fn find(names: &[&str]) -> Vec<InstalledApp> {
    let dirs = app_dirs();
    names
        .iter()
        .filter_map(|name| {
            bundle_named(&dirs, name).map(|p| InstalledApp {
                name: name_of(&p),
                commands: runs_commands(&p),
                default: p == Path::new(TERMINAL_APP),
                path: p.display().to_string(),
            })
        })
        .collect()
}

/// `<name>.app`, or a version of it: JetBrains and others ship
/// "PhpStorm 2024.3.app", which is still PhpStorm.
fn bundle_named(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    let exact: Vec<PathBuf> = dirs.iter().map(|d| d.join(format!("{name}.app"))).collect();
    if let Some(p) = exact.into_iter().find(|p| p.is_dir()) {
        return Some(p);
    }
    let prefix = format!("{} ", name.to_lowercase());
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().is_some_and(|x| x == "app") && path.is_dir() {
                let stem = name_of(&path).to_lowercase();
                if stem.starts_with(&prefix) {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Whether the app says it *edits* files of this sort, rather than merely
/// opening them: the difference between VS Code and a browser, both of which
/// macOS will happily hand a .php file to.
fn edits_source(app: &Path) -> bool {
    let out = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(app.join("Contents/Info.plist"))
        .output()
        .ok();
    let Some(out) = out else { return false };
    let Ok(info) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { return false };
    let Some(types) = info.get("CFBundleDocumentTypes").and_then(|t| t.as_array()) else {
        return false;
    };
    types.iter().any(|t| {
        let role = t.get("CFBundleTypeRole").and_then(|r| r.as_str()).unwrap_or("");
        if !role.eq_ignore_ascii_case("Editor") {
            return false;
        }
        let list = |key: &str| -> Vec<String> {
            t.get(key)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_lowercase()).collect())
                .unwrap_or_default()
        };
        let utis = list("LSItemContentTypes");
        let exts = list("CFBundleTypeExtensions");
        // Code, specifically. "public.data" and "public.item" are what a
        // notes app claims, and it is not what anyone means by an editor.
        utis.iter().any(|u| u.contains("source-code") || u.contains("plain-text") || u == "public.text")
            || exts.iter().any(|e| {
                matches!(
                    e.as_str(),
                    "php" | "js" | "ts" | "jsx" | "tsx" | "html" | "css" | "scss" | "json"
                        | "py" | "rb" | "go" | "rs" | "sh" | "md" | "yml" | "yaml"
                )
            })
    })
}

/// What macOS would open a PHP file with. Asked of the system rather than
/// guessed, so an editor no list here has heard of is still offered.
fn source_handlers() -> Vec<PathBuf> {
    let probe = std::env::temp_dir().join("nexora-open-with-probe.php");
    if !probe.exists() && std::fs::write(&probe, "<?php\n").is_err() {
        return Vec::new();
    }
    // The path reaches JXA as a JSON string, so a quote in it cannot end the
    // literal and become code.
    let quoted = serde_json::to_string(&probe.display().to_string()).unwrap_or_default();
    let script = format!(
        r#"ObjC.import("AppKit");
const ws = $.NSWorkspace.sharedWorkspace;
const out = [];
if (ws.URLsForApplicationsToOpenURL) {{
  const all = ws.URLsForApplicationsToOpenURL($.NSURL.fileURLWithPath({quoted}));
  for (let i = 0; i < all.count; i++) out.push(all.objectAtIndex(i).path.js);
}}
JSON.stringify(out);"#
    );
    let out = Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", &script]).output();
    let Ok(out) = out else { return Vec::new() };
    serde_json::from_slice::<Vec<String>>(&out.stdout)
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| is_listed_browser(p))
        .collect()
}

/// Every editor installed: the ones named above, in the order one is picked,
/// then anything else macOS says edits source files -- minus the terminals
/// and browsers, which also offer to open a .php.
pub fn editors() -> Vec<InstalledApp> {
    let mut out = find(EDITORS);
    let taken: Vec<String> = terminals()
        .into_iter()
        .chain(browsers())
        .map(|a| a.path)
        .chain(out.iter().map(|a| a.path.clone()))
        .collect();

    let mut extra: Vec<InstalledApp> = source_handlers()
        .into_iter()
        .filter(|p| !taken.iter().any(|t| t == &p.display().to_string()))
        .filter(|p| edits_source(p))
        .map(|p| InstalledApp {
            name: name_of(&p),
            commands: runs_commands(&p),
            default: false,
            path: p.display().to_string(),
        })
        .collect();
    extra.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    // One per name: an app can sit in two places.
    for app in extra {
        if !out.iter().any(|a| a.name == app.name) {
            out.push(app);
        }
    }
    out
}

pub fn terminals() -> Vec<InstalledApp> {
    find(TERMINALS)
}

/// Only a fallback: macOS is asked first, and knows every browser installed,
/// including ones this list has never heard of.
const BROWSERS: &[&str] = &[
    "Safari", "Google Chrome", "Firefox", "Microsoft Edge", "Brave Browser", "Arc", "Opera",
    "Vivaldi", "Chromium", "Orion", "Zen", "DuckDuckGo", "LibreWolf", "Tor Browser",
];

/// Ask Launch Services -- the part of macOS that decides what opens a link --
/// which app opens `https` by default, and which apps can. The same answer
/// System Settings shows, rather than a guess from bundle names.
fn ask_launch_services() -> Option<(Option<String>, Vec<String>)> {
    const SCRIPT: &str = r#"
ObjC.import("AppKit");
const ws = $.NSWorkspace.sharedWorkspace;
const url = $.NSURL.URLWithString("https://example.com");
const def = ws.URLForApplicationToOpenURL(url);
const out = [];
// Listing every handler needs macOS 12; older systems still get the default.
if (ws.URLsForApplicationsToOpenURL) {
  const all = ws.URLsForApplicationsToOpenURL(url);
  for (let i = 0; i < all.count; i++) out.push(all.objectAtIndex(i).path.js);
}
JSON.stringify({ default: def.isNil() ? null : def.path.js, all: out });
"#;
    let out = Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", SCRIPT]).output().ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let default = v["default"].as_str().map(String::from);
    let all = v["all"]
        .as_array()
        .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
        .unwrap_or_default();
    Some((default, all))
}

/// A browser someone would pick: a real app bundle, not a helper nested in
/// another app and not a test build cached under a Library folder.
fn is_listed_browser(p: &Path) -> bool {
    let s = p.to_string_lossy();
    s.ends_with(".app") && !s.contains("/Library/") && !s.contains(".app/") && p.is_dir()
}

/// The browser macOS opens links in.
pub fn default_browser() -> Option<PathBuf> {
    ask_launch_services()?.0.map(PathBuf::from).filter(|p| p.is_dir())
}

/// Every browser installed, the default first.
pub fn browsers() -> Vec<InstalledApp> {
    let (default, all) = ask_launch_services().unwrap_or_default();
    let default = default.map(PathBuf::from);
    let mut paths: Vec<PathBuf> =
        all.into_iter().map(PathBuf::from).filter(|p| is_listed_browser(p)).collect();
    if paths.is_empty() {
        paths = find(BROWSERS).into_iter().map(|a| PathBuf::from(a.path)).collect();
    }
    if let Some(d) = &default {
        if !paths.contains(d) && d.is_dir() {
            paths.push(d.clone());
        }
    }

    let mut out: Vec<InstalledApp> = Vec::new();
    for p in paths {
        let name = name_of(&p);
        // Safari can be reported from two places; one entry per name.
        if out.iter().any(|a| a.name == name) {
            continue;
        }
        out.push(InstalledApp {
            default: default.as_deref() == Some(p.as_path()),
            commands: false,
            path: p.display().to_string(),
            name,
        });
    }
    out.sort_by(|a, b| b.default.cmp(&a.default).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// Open a web page in `browser`, or in the system default when none is chosen.
pub fn open_url(browser: Option<&Path>, url: &str) -> Result<()> {
    let mut cmd = Command::new("/usr/bin/open");
    if let Some(app) = browser.filter(|a| a.is_dir()) {
        cmd.arg("-a").arg(app);
    }
    spawn(cmd.arg(url), Path::new("/usr/bin/open"))
}

/// How a browser opens a private window from the command line: its flag,
/// and what it calls that window. None for a browser with no such switch --
/// Safari, Arc, Orion -- which then offers only a normal window.
pub fn private_window(app: &Path) -> Option<(&'static str, &'static str)> {
    match name_of(app).as_str() {
        "Google Chrome" | "Google Chrome Beta" | "Google Chrome Canary" | "Chromium"
        | "Brave Browser" | "Vivaldi" => Some(("--incognito", "Incognito window")),
        "Microsoft Edge" => Some(("--inprivate", "InPrivate window")),
        "Firefox" | "Firefox Developer Edition" | "Firefox Nightly" | "LibreWolf" | "Zen"
        | "Zen Browser" | "Tor Browser" => Some(("--private-window", "Private window")),
        "Opera" | "Opera GX" => Some(("--private", "Private window")),
        _ => None,
    }
}

/// A browser to open a site in.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Browser {
    pub name: String,
    pub path: String,
    pub default: bool,
    /// What it calls a private window ("Incognito window"), when Nexora can
    /// open one in it.
    pub private_window: Option<String>,
    /// The browser's own icon, as a PNG data URI.
    pub icon: Option<String>,
}

/// Every browser installed, the default first, with its private window.
pub fn browser_choices() -> Vec<Browser> {
    browsers()
        .into_iter()
        .map(|b| Browser {
            private_window: private_window(Path::new(&b.path)).map(|(_, label)| label.to_string()),
            icon: icon_data_uri(Path::new(&b.path)),
            name: b.name,
            path: b.path,
            default: b.default,
        })
        .collect()
}

/// An app's own icon as a small PNG data URI, for showing it in a list.
///
/// Read from the bundle's .icns, which every browser ships. An app that keeps
/// its icon only in an asset catalog gets none and is shown with a generic
/// one: asking macOS to draw the icon from outside a running app hands back an
/// empty outline, which is worse than no icon.
///
/// Kept on disk, keyed by the app's Info.plist modification time, so an app
/// update refreshes it and every other time it is a file read. A conversion
/// that fails leaves nothing behind, so the next look tries again.
pub fn icon_data_uri(app: &Path) -> Option<String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    let info = app.join("Contents/Info.plist");
    let stamp = std::fs::metadata(&info)
        .and_then(|m| m.modified())
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let dir = crate::paths::downloads_cache().join("icons");
    let key: String = name_of(app)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // "-64" marks icons read from the .icns alone; names without it may hold
    // the empty outlines an earlier fallback saved.
    let png = dir.join(format!("{key}-{stamp}-64.png"));
    if !png.is_file() {
        std::fs::create_dir_all(&dir).ok()?;
        // Written aside and moved into place, so two windows asking at once
        // never read a half-written file.
        let part = dir.join(format!(
            ".{key}-{}-{}.png",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        if !icon_from_icns(app, &part) || std::fs::rename(&part, &png).is_err() {
            let _ = std::fs::remove_file(&part);
            return None;
        }
    }
    let bytes = std::fs::read(&png).ok()?;
    Some(format!("data:image/png;base64,{}", crate::wordpress::b64(&bytes)))
}

/// Convert any image macOS can read to a 64-pixel PNG, keeping transparency.
fn sips_png(src: &Path, out: &Path) -> bool {
    Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-Z", "64"])
        .arg(src)
        .arg("--out")
        .arg(out)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
        && out.is_file()
}

fn icon_from_icns(app: &Path, out: &Path) -> bool {
    let named = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIconFile", "raw"])
        .arg(app.join("Contents/Info.plist"))
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if named.is_empty() {
        return false;
    }
    let file = if named.ends_with(".icns") { named } else { format!("{named}.icns") };
    let icns = app.join("Contents/Resources").join(file);
    icns.is_file() && sips_png(&icns, out)
}

/// Open a page in a private window of `app`.
///
/// The browser's own executable is run with its private flag, not `open`:
/// `open` drops the arguments when the browser is already running. A running
/// browser hands the request to itself and opens the window there.
pub fn open_url_private(app: &Path, url: &str) -> Result<()> {
    check(app)?;
    let (flag, _) = private_window(app).ok_or_else(|| {
        Error::other(format!("{} cannot open a private window from Nexora.", name_of(app)))
    })?;
    let exe = executable_of(app)?;
    let mut cmd = Command::new(&exe);
    cmd.arg(flag)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Its own session, so a browser Nexora started outlives Nexora.
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    spawn(&mut cmd, &exe)
}

/// The executable inside an app bundle, as its Info.plist names it.
fn executable_of(app: &Path) -> Result<PathBuf> {
    let info = app.join("Contents/Info.plist");
    let named = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleExecutable", "raw"])
        .arg(&info)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let name = if named.is_empty() { name_of(app) } else { named };
    let exe = app.join("Contents/MacOS").join(name);
    if exe.is_file() {
        Ok(exe)
    } else {
        Err(Error::other(format!("{} has no executable at {}.", name_of(app), exe.display())))
    }
}

/// The bundle's name without `.app`: "Cursor", "iTerm".
pub fn name_of(app: &Path) -> String {
    app.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

fn spawn(cmd: &mut Command, what: &Path) -> Result<()> {
    cmd.spawn().map(|_| ()).map_err(|e| Error::Io { path: what.to_path_buf(), source: e })
}

fn check(app: &Path) -> Result<()> {
    if app.is_dir() {
        Ok(())
    } else {
        Err(Error::other(format!("{} is not installed any more.", app.display())))
    }
}

pub fn open_in_editor(app: &Path, target: &Path) -> Result<()> {
    check(app)?;
    spawn(Command::new("/usr/bin/open").arg("-a").arg(app).arg(target), Path::new("/usr/bin/open"))
}

fn osascript(script: String) -> Result<()> {
    spawn(Command::new("/usr/bin/osascript").arg("-e").arg(script), Path::new("/usr/bin/osascript"))
}

fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Percent-encode a path for a URL query, leaving `/` readable.
fn url_path(p: &Path) -> String {
    p.display()
        .to_string()
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Whether `app` can be handed a command to run, so the site's PHP and `wp`
/// end up on PATH. The others can only be pointed at a folder.
pub fn runs_commands(app: &Path) -> bool {
    matches!(
        name_of(app).as_str(),
        "Terminal" | "iTerm" | "Ghostty" | "kitty" | "Alacritty" | "WezTerm"
    )
}

/// Open a terminal in `dir` and run `script` there (a `cd` and a PATH export).
pub fn run_in_terminal(app: &Path, script: &str, dir: &Path) -> Result<()> {
    check(app)?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // A login shell first, so the user's own environment is loaded; then the
    // PATH export on top; then an interactive shell that keeps that order.
    let chained = format!("{script} && exec {shell} -i");
    let open = || {
        let mut c = Command::new("/usr/bin/open");
        c.arg("-na").arg(app).arg("--args");
        c
    };

    match name_of(app).as_str() {
        "Terminal" => osascript(format!(
            "tell application \"Terminal\"\n activate\n do script {}\nend tell",
            applescript_string(script)
        )),
        "iTerm" => osascript(format!(
            "tell application \"iTerm\"\n activate\n set w to (create window with default profile)\n \
             tell current session of w to write text {}\nend tell",
            applescript_string(script)
        )),
        "Ghostty" => spawn(
            open().arg(format!("--working-directory={}", dir.display())).arg("-e").args([&shell, "-l", "-c", &chained]),
            app,
        ),
        "kitty" => spawn(open().arg("--directory").arg(dir).args([&shell, "-l", "-c", &chained]), app),
        "Alacritty" => spawn(
            open().arg("--working-directory").arg(dir).arg("-e").args([&shell, "-l", "-c", &chained]),
            app,
        ),
        "WezTerm" => spawn(
            open().arg("start").arg("--cwd").arg(dir).arg("--").args([&shell, "-l", "-c", &chained]),
            app,
        ),
        // Warp takes a folder through its URI scheme but no command.
        "Warp" => spawn(
            Command::new("/usr/bin/open").arg(format!("warp://action/new_window?path={}", url_path(dir))),
            app,
        ),
        _ => spawn(Command::new("/usr/bin/open").arg("-a").arg(app).arg(dir), app),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_app_is_always_found_and_takes_commands() {
        let found = terminals();
        eprintln!("terminals: {found:?}\neditors: {:?}", editors());
        if cfg!(target_os = "macos") {
            assert!(found.iter().any(|a| a.path == TERMINAL_APP && a.commands));
        }
    }

    #[test]
    fn installed_browsers_show_their_own_icons() {
        for b in browsers() {
            let uri = icon_data_uri(Path::new(&b.path))
                .unwrap_or_else(|| panic!("no icon for {}", b.name));
            assert!(uri.starts_with("data:image/png;base64,") && uri.len() > 200, "{}", b.name);
        }
    }

    #[test]
    fn private_windows_use_each_browsers_own_switch() {
        let flag = |app: &str| private_window(Path::new(app)).map(|(f, _)| f);
        assert_eq!(flag("/Applications/Google Chrome.app"), Some("--incognito"));
        assert_eq!(flag("/Applications/Brave Browser.app"), Some("--incognito"));
        assert_eq!(flag("/Applications/Firefox.app"), Some("--private-window"));
        assert_eq!(flag("/Applications/Microsoft Edge.app"), Some("--inprivate"));
        assert_eq!(flag("/Applications/Safari.app"), None, "Safari has no private-window switch");
    }

    #[test]
    fn installed_browsers_have_an_executable_to_run() {
        for b in browser_choices().into_iter().filter(|b| b.private_window.is_some()) {
            let exe = executable_of(Path::new(&b.path)).expect("an executable");
            assert!(exe.is_file(), "{} -> {}", b.name, exe.display());
        }
    }

    #[test]
    fn browsers_are_listed_with_the_system_default_first() {
        let found = browsers();
        eprintln!("browsers: {found:?}\ndefault: {:?}", default_browser());
        if let Some(d) = default_browser() {
            let first = found.first().expect("the default browser is listed");
            assert!(first.default && Path::new(&first.path) == d, "{first:?}");
        }
        assert!(found.iter().all(|a| !a.path.contains("/Library/")));
    }

    #[test]
    fn folder_paths_are_percent_encoded_for_warp() {
        assert_eq!(url_path(Path::new("/Users/me/My Sites/a&b")), "/Users/me/My%20Sites/a%26b");
    }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;

    /// What this Mac actually has:
    /// `cargo test -p nexora-core live_apps -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads the machine's applications"]
    fn live_apps_lists_what_is_installed() {
        let show = |what: &str, apps: Vec<InstalledApp>| {
            println!("{what}:");
            for a in &apps {
                println!("  {} — {}{}", a.name, a.path, if a.default { " (default)" } else { "" });
            }
            apps
        };
        let editors = show("editors", editors());
        let browsers = show("browsers", browsers());
        let terminals = show("terminals", terminals());

        assert!(!browsers.is_empty(), "a Mac always has Safari");
        assert!(terminals.iter().any(|t| t.name == "Terminal"), "Terminal.app is always there");
        // No app is offered twice, and no terminal or browser is called an editor.
        for e in &editors {
            assert!(!terminals.iter().any(|t| t.path == e.path), "{} is a terminal", e.name);
            assert!(!browsers.iter().any(|b| b.path == e.path), "{} is a browser", e.name);
        }
    }
}
