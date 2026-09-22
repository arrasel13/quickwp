//! Homebrew, for the one service that has no official macOS build: MariaDB.
//!
//! Everything else Nexora runs is downloaded from its vendor and checked by
//! checksum. MariaDB publishes Linux, Windows and source only, so its macOS
//! builds come from Homebrew's bottles. When Homebrew is not on the Mac yet,
//! Nexora installs it the official way -- Homebrew's own install script,
//! non-interactively -- rather than sending someone off to a terminal.
//!
//! Homebrew is an implementation detail here. The window says "Configuring
//! environment" and "Installing MariaDB"; what ran, and its full output, go to
//! logs/environment.log for anyone who needs to look.
//!
//! The install script needs an administrator's password once, for
//! /opt/homebrew and, on a Mac without them, the Command Line Tools. It asks
//! through `SUDO_ASKPASS`: a small script that shows a macOS password dialog
//! naming Nexora. The password goes from that dialog straight to sudo; Nexora
//! never sees or stores it.

use crate::{paths, Error, Result};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const INSTALL_SCRIPT: &str = "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh";

/// Where Homebrew lives: Apple silicon, then Intel.
pub fn prefix() -> Option<PathBuf> {
    ["/opt/homebrew", "/usr/local"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.join("bin/brew").is_file())
}

pub fn binary() -> Option<PathBuf> {
    prefix().map(|p| p.join("bin/brew"))
}

pub fn is_installed() -> bool {
    binary().is_some()
}

fn log_path() -> PathBuf {
    paths::logs().join("environment.log")
}

/// Append a command's output to logs/environment.log.
fn log_output(what: &str, out: &std::process::Output) {
    let _ = paths::mkdir_p(&paths::logs());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "==> {what} (exit {:?})", out.status.code());
        let _ = f.write_all(&out.stdout);
        let _ = f.write_all(&out.stderr);
        let _ = writeln!(f);
    }
}

/// A command told to do only what was asked: no auto-update, no clean-up of
/// other formulae, no analytics, no hints.
pub fn command(args: &[&str]) -> Result<Command> {
    let brew = binary().ok_or_else(|| Error::other("The environment is not configured yet."))?;
    let mut c = Command::new(brew);
    c.args(args)
        .stdin(Stdio::null())
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
        .env("HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK", "1")
        // `install` of something already here must never upgrade it.
        .env("HOMEBREW_NO_INSTALL_UPGRADE", "1")
        .env("HOMEBREW_NO_ANALYTICS", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .env("HOMEBREW_NO_EMOJI", "1");
    Ok(c)
}

/// Run a command to completion, logging it. `failed` is what the window is
/// told when it does not succeed.
pub fn run(args: &[&str], failed: &str) -> Result<()> {
    let out = command(args)?
        .output()
        .map_err(|e| Error::Io { path: PathBuf::from("brew"), source: e })?;
    log_output(&format!("brew {}", args.join(" ")), &out);
    if !out.status.success() {
        return Err(Error::other(format!(
            "{failed} Details are in {}.",
            log_path().display()
        )));
    }
    Ok(())
}

/// Make sure Homebrew is here and knows the current releases: install it when
/// it is missing, then update its formula list. `stage` is told what to show.
pub fn prepare(stage: &dyn Fn(&str)) -> Result<()> {
    stage("Configuring environment");
    if !is_installed() {
        install()?;
    }
    // Only the formula list: nothing already installed is upgraded by this.
    let _ = command(&["update", "--quiet"]).and_then(|mut c| {
        c.env_remove("HOMEBREW_NO_AUTO_UPDATE");
        let out = c.output().map_err(|e| Error::Io { path: PathBuf::from("brew"), source: e })?;
        log_output("brew update", &out);
        Ok(())
    });
    Ok(())
}

/// Install Homebrew with its official script, non-interactively.
fn install() -> Result<()> {
    let askpass = write_askpass()?;
    crate::log::info("environment", "configuring the environment");
    let out = Command::new("/bin/bash")
        .arg("-c")
        .arg(format!("/bin/bash -c \"$(/usr/bin/curl -fsSL {INSTALL_SCRIPT})\""))
        .stdin(Stdio::null())
        .env("NONINTERACTIVE", "1")
        .env("SUDO_ASKPASS", &askpass)
        .env("HOMEBREW_NO_ANALYTICS", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .output()
        .map_err(|e| Error::Io { path: PathBuf::from("/bin/bash"), source: e })?;
    let _ = std::fs::remove_file(&askpass);
    log_output("install the environment", &out);
    if !out.status.success() || !is_installed() {
        let text = String::from_utf8_lossy(&out.stderr);
        crate::log::warn("environment", "configuring the environment failed; see logs/environment.log");
        if text.contains("incorrect password") || text.contains("a password is required") || text.contains("no password was provided") {
            return Err(Error::other(
                "Configuring the environment needs your Mac password, and it was not given. Try again.",
            ));
        }
        return Err(Error::other(format!(
            "Nexora could not configure the environment. Details are in {}.",
            log_path().display()
        )));
    }
    crate::log::info("environment", "environment configured");
    Ok(())
}

/// The program sudo runs to ask for the password: a macOS dialog, in
/// Nexora's name. Mode 0700 in Nexora's own run directory.
fn write_askpass() -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = paths::run();
    paths::mkdir_p(&dir)?;
    let path = dir.join("askpass.sh");
    let icon = std::env::current_exe()
        .ok()
        .and_then(|exe| crate::selfupdate::bundle_of(&exe))
        .map(|b| b.join("Contents/Resources/icon.icns"))
        .filter(|p| p.is_file());
    let icon_clause = match icon {
        Some(p) => format!("with icon POSIX file \"{}\"", p.display()),
        None => "with icon caution".into(),
    };
    let script = format!(
        "#!/bin/sh\nexec /usr/bin/osascript -e 'text returned of (display dialog \"Nexora needs your password to configure the development environment.\" default answer \"\" with hidden answer with title \"Nexora\" {icon_clause} buttons {{\"Cancel\", \"OK\"}} default button \"OK\")'\n"
    );
    std::fs::write(&path, script).map_err(|e| Error::Io { path: path.clone(), source: e })?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| Error::Io { path: path.clone(), source: e })?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    /// The stages and commands a MariaDB install runs, on a Mac that already
    /// has Homebrew and the series: nothing is installed or upgraded.
    /// `cargo test -p nexora-core live_brew_prepare -- --ignored --nocapture`
    #[test]
    #[ignore = "runs Homebrew on this Mac"]
    fn live_brew_prepare() {
        let stages = std::sync::Mutex::new(Vec::new());
        super::prepare(&|s| stages.lock().unwrap().push(s.to_string())).unwrap();
        super::run(&["install", "--quiet", "mariadb@11.4"], "install failed.").unwrap();
        println!("stages: {:?}", stages.lock().unwrap());
    }
}
