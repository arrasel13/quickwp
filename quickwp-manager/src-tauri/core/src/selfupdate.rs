//! Installing a new Nexora over the one that is running.
//!
//! Finder will not copy over an app that is open -- "The operation can't be
//! completed because the item "Nexora" is in use" -- and nothing inside the
//! app can change that. So the running app does the replacing itself: when a
//! Nexora installer is opened, a mounted disk image holding a newer build, it
//! hands its sites to the background and quits, and a small script outside
//! the bundle swaps the new copy in, ejects the installer and opens Nexora
//! again. That launch takes the sites back, as after any "keep sites running"
//! quit.
//!
//! Every build is version 0.1.1, so a version number cannot tell builds
//! apart. The app binary can: a different binary that is also newer is an
//! update; the same binary, or an older one, is left alone.

use crate::{paths, Error, Result};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

const BUNDLE_ID: &str = "com.nexora.app";

/// A Nexora installer that is open: the app on it and the volume to eject.
#[derive(Debug, Clone, PartialEq)]
pub struct Installer {
    pub app: PathBuf,
    pub volume: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Verdict {
    Same,
    Older,
    Newer,
    NotNexora,
}

/// A binary's size, modification time and SHA-256.
type Print = (u64, SystemTime, String);

/// The `.app` bundle an executable runs from; none for a development build.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

/// Whether this copy can replace itself: a bundle outside any installer, in
/// a folder this user can write to -- /Applications, for an admin.
pub fn can_replace(bundle: &Path) -> bool {
    if bundle.starts_with("/Volumes") {
        return false;
    }
    let Some(parent) = bundle.parent() else {
        return false;
    };
    let probe = parent.join(format!(".nexora-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Looks through mounted volumes for a newer Nexora. Each installer is
/// fingerprinted once and remembered, so a disk image left open costs a
/// directory listing a second, not a 20 MB hash.
#[derive(Default)]
pub struct Watcher {
    seen: HashMap<PathBuf, (u64, SystemTime, Verdict)>,
    current: Option<Print>,
}

impl Watcher {
    /// A mounted Nexora newer than the running `exe`, if one is open.
    pub fn newer_installer(&mut self, exe: &Path, volumes: &Path) -> Option<Installer> {
        let exe_name = exe.file_name()?.to_owned();
        let bundle = bundle_of(exe)?;
        let entries = std::fs::read_dir(volumes).ok()?;
        for entry in entries.flatten() {
            let volume = entry.path();
            let app = volume.join("Nexora.app");
            let bin = app.join("Contents/MacOS").join(&exe_name);
            let Ok(meta) = std::fs::metadata(&bin) else { continue };
            if same_path(&app, &bundle) {
                continue;
            }
            let size = meta.len();
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let verdict = match self.seen.get(&app) {
                Some((s, m, v)) if *s == size && *m == mtime => *v,
                _ => {
                    let v = self.judge(exe, &app, &bin, size, mtime);
                    self.seen.insert(app.clone(), (size, mtime, v));
                    if v == Verdict::Older {
                        crate::log::info(
                            "update",
                            &format!(
                                "an older Nexora installer is open at {}; it is not installed over this one",
                                volume.display()
                            ),
                        );
                    }
                    v
                }
            };
            if verdict == Verdict::Newer {
                return Some(Installer { app, volume });
            }
        }
        None
    }

    fn judge(&mut self, exe: &Path, app: &Path, bin: &Path, size: u64, mtime: SystemTime) -> Verdict {
        if !is_nexora(app) {
            return Verdict::NotNexora;
        }
        if self.current.is_none() {
            let Some(print) = fingerprint(exe) else {
                return Verdict::NotNexora;
            };
            self.current = Some(print);
        }
        let Ok(hash) = sha256(bin) else {
            return Verdict::NotNexora;
        };
        compare(self.current.as_ref().unwrap(), &(size, mtime, hash))
    }
}

fn compare(current: &Print, candidate: &Print) -> Verdict {
    if current.2 == candidate.2 {
        Verdict::Same
    } else if candidate.1 > current.1 {
        Verdict::Newer
    } else {
        Verdict::Older
    }
}

fn fingerprint(path: &Path) -> Option<Print> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?, sha256(path).ok()?))
}

fn sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn is_nexora(app: &Path) -> bool {
    Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw"])
        .arg(app.join("Contents/Info.plist"))
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == BUNDLE_ID)
        .unwrap_or(false)
}

/// Waits for Nexora (pid $1) to quit, swaps the app at $3 for the one at $2,
/// ejects $4 and opens Nexora again. The new copy is made beside the old one
/// first and the old one only removed once the new one is in place, so any
/// failure leaves a working Nexora. Lines go to the app log in its format.
const SCRIPT: &str = r#"#!/bin/sh
# Written by Nexora: installs a new Nexora once the running one has quit.
pid="$1"; src="$2"; dest="$3"; volume="$4"
open_app="${NEXORA_OPEN:-/usr/bin/open}"
stamp() { date '+%Y-%m-%d][%H:%M:%S'; }
log() { printf '[%s][INFO][update] %s\n' "$(stamp)" "$*"; }
warn() { printf '[%s][WARN][update] %s\n' "$(stamp)" "$*"; }

waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 300 ]; then
    warn "Nexora did not quit within 30 seconds; the update was not installed"
    exit 1
  fi
  sleep 0.1
done

new="$dest.nexora-update"
old="$dest.nexora-previous"
rm -rf "$new" "$old"
if ! /usr/bin/ditto "$src" "$new"; then
  warn "could not copy the new Nexora from $src; the installed one is unchanged"
  rm -rf "$new"
  "$open_app" "$dest"
  exit 1
fi
if ! mv "$dest" "$old"; then
  warn "could not move the installed Nexora aside; it is unchanged"
  rm -rf "$new"
  "$open_app" "$dest"
  exit 1
fi
if ! mv "$new" "$dest"; then
  warn "could not put the new Nexora in place; the previous one is restored"
  mv "$old" "$dest"
  "$open_app" "$dest"
  exit 1
fi
rm -rf "$old"
log "installed the new Nexora from $volume"
/usr/bin/hdiutil detach "$volume" -quiet >/dev/null 2>&1 || true
"$open_app" "$dest"
"#;

/// Start the script that installs `installer` over `dest` once the process
/// `pid` -- this app -- has quit. It runs in its own process group, so it
/// outlives the app, and writes to the app log.
pub fn start_install(pid: u32, installer: &Installer, dest: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let is_app = |p: &Path| p.extension().is_some_and(|e| e == "app");
    if !is_app(&installer.app) || !is_app(dest) {
        return Err(Error::other("an update installs one Nexora.app over another"));
    }
    paths::mkdir_p(&paths::run())?;
    let script = paths::run().join("install-update.sh");
    std::fs::write(&script, SCRIPT).map_err(|e| Error::Io { path: script.clone(), source: e })?;
    paths::mkdir_p(&paths::logs())?;
    let log_path = paths::app_log();
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| Error::Io { path: log_path.clone(), source: e })?;
    let log_err = log.try_clone().map_err(|e| Error::Io { path: log_path, source: e })?;
    Command::new("/bin/sh")
        .arg(&script)
        .arg(pid.to_string())
        .arg(&installer.app)
        .arg(dest)
        .arg(&installer.volume)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err)
        .process_group(0)
        .spawn()
        .map_err(|e| Error::other(format!("could not start the update: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nexora-selfupdate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A minimal Nexora.app: an Info.plist and a binary with the given bytes.
    fn fake_app(at: &Path, id: &str, binary: &[u8], age: Duration) -> PathBuf {
        let app = at.join("Nexora.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string></dict></plist>\n"
            ),
        )
        .unwrap();
        let bin = app.join("Contents/MacOS/nexora-app");
        std::fs::write(&bin, binary).unwrap();
        let f = std::fs::File::options().write(true).open(&bin).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
        app
    }

    #[test]
    fn an_executable_inside_a_bundle_knows_its_bundle() {
        let exe = Path::new("/Applications/Nexora.app/Contents/MacOS/nexora-app");
        assert_eq!(bundle_of(exe), Some(PathBuf::from("/Applications/Nexora.app")));
        assert_eq!(bundle_of(Path::new("/Users/me/target/debug/nexora-app")), None);
    }

    #[test]
    fn only_a_different_newer_binary_is_an_update() {
        let now = SystemTime::now();
        let earlier = now - Duration::from_secs(60);
        let running: Print = (10, earlier, "aaa".into());
        assert_eq!(compare(&running, &(10, now, "aaa".into())), Verdict::Same);
        assert_eq!(compare(&running, &(12, now, "bbb".into())), Verdict::Newer);
        assert_eq!(compare(&running, &(12, earlier - Duration::from_secs(60), "bbb".into())), Verdict::Older);
    }

    #[test]
    fn a_mounted_newer_nexora_is_found_and_others_are_not() {
        let root = tmp("watch");
        let installed = fake_app(&root.join("Applications"), BUNDLE_ID, b"old build", Duration::from_secs(3600));
        let exe = installed.join("Contents/MacOS/nexora-app");
        let volumes = root.join("Volumes");

        // Not an installer at all, another app called Nexora, and the same build.
        std::fs::create_dir_all(volumes.join("Photos")).unwrap();
        fake_app(&volumes.join("Impostor"), "com.example.other", b"new build", Duration::ZERO);
        fake_app(&volumes.join("Same"), BUNDLE_ID, b"old build", Duration::ZERO);
        let mut w = Watcher::default();
        assert_eq!(w.newer_installer(&exe, &volumes), None);

        // An older build is not installed over a newer one.
        fake_app(&volumes.join("Old"), BUNDLE_ID, b"ancient", Duration::from_secs(7200));
        assert_eq!(w.newer_installer(&exe, &volumes), None);

        // A newer build is.
        let newer = fake_app(&volumes.join("Nexora 2"), BUNDLE_ID, b"new build", Duration::ZERO);
        let found = w.newer_installer(&exe, &volumes).expect("the newer installer is found");
        assert_eq!(found.app, newer);
        assert_eq!(found.volume, volumes.join("Nexora 2"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn run_script(pid: u32, src: &Path, dest: &Path, volume: &Path) -> (bool, String) {
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(SCRIPT)
            .arg("install-update.sh")
            .arg(pid.to_string())
            .arg(src)
            .arg(dest)
            .arg(volume)
            .env("NEXORA_OPEN", "/usr/bin/true")
            .output()
            .unwrap();
        (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())
    }

    #[test]
    fn the_script_waits_for_the_app_then_swaps_the_new_copy_in() {
        let root = tmp("swap");
        let dest = fake_app(&root.join("Applications"), BUNDLE_ID, b"old build", Duration::ZERO);
        let src = fake_app(&root.join("Volumes/Nexora"), BUNDLE_ID, b"new build", Duration::ZERO);
        // A process that is still running when the script starts. Reaped as
        // soon as it ends, as the system reaps a quit app: an unreaped child
        // stays visible to `kill -0` and the script would wait it out.
        let mut app = Command::new("/bin/sleep").arg("0.5").spawn().unwrap();
        let pid = app.id();
        let reaper = std::thread::spawn(move || {
            let _ = app.wait();
        });
        let started = std::time::Instant::now();
        let (ok, out) = run_script(pid, &src, &dest, &root.join("Volumes/Nexora"));
        let _ = reaper.join();
        assert!(ok, "{out}");
        assert!(started.elapsed() >= Duration::from_millis(400), "it waited for the app to quit");
        assert_eq!(std::fs::read(dest.join("Contents/MacOS/nexora-app")).unwrap(), b"new build");
        assert!(!root.join("Applications/Nexora.app.nexora-update").exists());
        assert!(!root.join("Applications/Nexora.app.nexora-previous").exists());
        assert!(out.contains("[INFO][update] installed the new Nexora"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_copy_leaves_the_installed_app_untouched() {
        let root = tmp("fail");
        let dest = fake_app(&root.join("Applications"), BUNDLE_ID, b"old build", Duration::ZERO);
        let missing = root.join("Volumes/Gone/Nexora.app");
        let (ok, out) = run_script(999_999, &missing, &dest, &root.join("Volumes/Gone"));
        assert!(!ok);
        assert_eq!(std::fs::read(dest.join("Contents/MacOS/nexora-app")).unwrap(), b"old build");
        assert!(!root.join("Applications/Nexora.app.nexora-update").exists());
        assert!(out.contains("[WARN][update] could not copy"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
