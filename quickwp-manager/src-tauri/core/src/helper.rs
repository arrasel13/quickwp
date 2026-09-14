//! The `nexora` tool that runs in the background, kept outside the app.
//!
//! The DNS agent (launchd), the keep-running server and the tunnel guard all
//! outlive the app's window. Run from inside Nexora.app, they keep the bundle
//! in use, and Finder then refuses to replace the app with a newer one: "The
//! operation can't be completed because the item Nexora is in use." So they
//! run a copy in the data folder, refreshed from the bundle whenever the app
//! changes. Replacing the app never touches that folder.

use crate::{paths, Error, Result};
use std::path::{Path, PathBuf};

/// Where the copy lives.
pub fn path() -> PathBuf {
    paths::root().join("helper").join("nexora")
}

/// Refresh the copy at the usual place from the app's own. Returns the path,
/// and whether it changed -- after an app update, a helper still running the
/// old copy should be restarted.
pub fn install(bundled: &Path) -> Result<(PathBuf, bool)> {
    let dest = path();
    let changed = install_to(bundled, &dest)?;
    Ok((dest, changed))
}

/// Make `dest` a byte-for-byte copy of `bundled`. Returns whether it changed.
pub fn install_to(bundled: &Path, dest: &Path) -> Result<bool> {
    let current = std::fs::read(bundled).map_err(|e| Error::Io { path: bundled.into(), source: e })?;
    if std::fs::read(dest).map(|existing| existing == current).unwrap_or(false) {
        return Ok(false);
    }
    let dir = dest.parent().ok_or_else(|| Error::other("the helper path has no folder"))?;
    paths::mkdir_p(dir)?;
    // Written beside it, then renamed over it: a helper that is running keeps
    // its own copy of the old file, and nothing ever runs a half-written one.
    // Written fresh rather than copied, so the app's quarantine flag does not
    // follow it -- launchd would refuse to start a quarantined helper.
    let tmp = dir.join(format!(".nexora.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &current).map_err(|e| Error::Io { path: tmp.clone(), source: e })?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| Error::Io { path: tmp.clone(), source: e })?;
    std::fs::rename(&tmp, dest).map_err(|e| Error::Io { path: dest.into(), source: e })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn the_copy_follows_the_app_and_is_only_rewritten_when_it_differs() {
        let dir = std::env::temp_dir().join(format!("nexora-helper-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bundled = dir.join("bundled-nexora");
        let dest = dir.join("data/helper/nexora");

        std::fs::write(&bundled, b"version one").unwrap();
        assert!(install_to(&bundled, &dest).unwrap(), "a missing copy is written");
        assert_eq!(std::fs::read(&dest).unwrap(), b"version one");
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "the copy must be executable");

        assert!(!install_to(&bundled, &dest).unwrap(), "an identical copy is left alone");

        std::fs::write(&bundled, b"version two, after an update").unwrap();
        assert!(install_to(&bundled, &dest).unwrap(), "an app update refreshes the copy");
        assert_eq!(std::fs::read(&dest).unwrap(), b"version two, after an update");
        let leftovers: Vec<_> = std::fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temporary file is left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
