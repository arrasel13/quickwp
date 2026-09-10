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
    "Terminal", "iTerm", "Warp", "Ghostty", "kitty", "Alacritty", "WezTerm", "Hyper", "Tabby", "Rio",
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
            dirs.iter().map(|d| d.join(format!("{name}.app"))).find(|p| p.is_dir()).map(|p| {
                InstalledApp {
                    name: (*name).to_string(),
                    commands: runs_commands(&p),
                    default: p == Path::new(TERMINAL_APP),
                    path: p.display().to_string(),
                }
            })
        })
        .collect()
}

pub fn editors() -> Vec<InstalledApp> {
    find(EDITORS)
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
