//! The last two steps of an uninstall, which the app cannot do while it runs:
//! delete its own bundle, and take its tile out of the Dock.
//!
//! Both are left to a small script that waits for the app to quit first. It
//! runs in its own process group, so it outlives the app, and writes to the
//! app log in the same format as everything else.

use std::path::Path;
use std::process::{Command, Stdio};

/// Waits for Nexora (pid $1) to quit, then removes the bundle at $2 and the
/// Dock tile that points at it. Nothing here touches a site folder.
const SCRIPT: &str = r#"#!/bin/sh
# Written by Nexora: finishes an uninstall once the app has quit.
pid="$1"; app="$2"
stamp() { date '+%Y-%m-%d][%H:%M:%S'; }
log() { printf '[%s][INFO][uninstall] %s\n' "$(stamp)" "$*"; }
warn() { printf '[%s][WARN][uninstall] %s\n' "$(stamp)" "$*"; }

waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 300 ]; then
    warn "Nexora did not quit within 30 seconds; it was not removed"
    exit 1
  fi
  sleep 0.1
done

# The Dock keeps its own copy of what is pinned to it. A tile whose app is
# gone shows as a question mark, so it goes with the app.
plist="$HOME/Library/Preferences/com.apple.dock.plist"
buddy=/usr/libexec/PlistBuddy
removed_tile=no
if [ -f "$plist" ]; then
  i=0
  while url=$("$buddy" -c "Print :persistent-apps:$i:tile-data:file-data:_CFURLString" "$plist" 2>/dev/null); do
    case "$url" in
      *Nexora.app*)
        if "$buddy" -c "Delete :persistent-apps:$i" "$plist" 2>/dev/null; then
          removed_tile=yes
          continue
        fi
        ;;
    esac
    i=$((i + 1))
  done
fi

if ! rm -rf "$app"; then
  warn "could not remove $app; drag it to the Bin"
  exit 1
fi
log "removed $app"
if [ "$removed_tile" = yes ]; then
  /usr/bin/killall cfprefsd >/dev/null 2>&1 || true
  /usr/bin/killall Dock >/dev/null 2>&1 || true
  log "removed Nexora from the Dock"
fi
"#;

/// Start the script that removes `app` once this process (`pid`) has quit.
///
/// Returns once it is running: the app is expected to quit straight after.
pub fn finish_after_quit(app_bundle: &Path) -> std::io::Result<()> {
    let script = nexora_core::paths::run().join("uninstall.sh");
    nexora_core::paths::mkdir_p(script.parent().unwrap()).ok();
    std::fs::write(&script, SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
    }

    // The log the app writes, so the last lines of an uninstall land with the
    // rest of it rather than nowhere.
    let log = nexora_core::paths::logs().join("nexora.log");
    let out = std::fs::OpenOptions::new().create(true).append(true).open(&log);

    let mut cmd = Command::new("/bin/sh");
    cmd.arg(&script)
        .arg(std::process::id().to_string())
        .arg(app_bundle)
        .stdin(Stdio::null());
    if let Ok(file) = out {
        let err = file.try_clone()?;
        cmd.stdout(Stdio::from(file)).stderr(Stdio::from(err));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: the app quitting must not take it with it.
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ())
}

/// Where this app is installed, when it is installed at all.
pub fn bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // …/Nexora.app/Contents/MacOS/nexora-app
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension().map(|e| e == "app").unwrap_or(false) && bundle.exists())
        .then(|| bundle.to_path_buf())
}
