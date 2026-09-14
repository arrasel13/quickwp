//! Site passwords, kept in the login keychain.
//!
//! Nexora sets a site's admin password at install, and again when it is
//! changed from here. Remembering it means "copy password" can copy the real
//! one instead of offering to reset it. The login keychain rather than the
//! app's database: it is encrypted at rest, unlocked with the user's login,
//! and shows up -- and can be removed -- in Keychain Access like any other
//! saved password.
//!
//! One item per site, whose account is the domain, holding each user's
//! password as a small JSON map; deleting a site forgets them all in one go.
//! The secret reaches `security` on stdin, never on its command line, where
//! any process on the machine could read it.

use crate::{Error, Result};
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

const SECURITY: &str = "/usr/bin/security";
const SERVICE: &str = "Nexora site passwords";

fn read_map(domain: &str) -> BTreeMap<String, String> {
    let map = read_service(SERVICE, domain);
    if !map.is_empty() {
        return map;
    }
    // Saved by an earlier build under its own name: moved across on first read.
    let old = read_service(crate::legacy::OLD_KEYCHAIN_SERVICE, domain);
    if !old.is_empty() && write_map(domain, &old).is_ok() {
        delete_service(crate::legacy::OLD_KEYCHAIN_SERVICE, domain);
    }
    old
}

fn read_service(service: &str, domain: &str) -> BTreeMap<String, String> {
    let Ok(out) = Command::new(SECURITY)
        .args(["find-generic-password", "-s", service, "-a", domain, "-w"])
        .stderr(Stdio::null())
        .output()
    else {
        return BTreeMap::new();
    };
    if !out.status.success() {
        return BTreeMap::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(text.strip_suffix('\n').unwrap_or(&text)).unwrap_or_default()
}

fn write_map(domain: &str, map: &BTreeMap<String, String>) -> Result<()> {
    if map.is_empty() {
        forget_site(domain);
        return Ok(());
    }
    // JSON escapes any newline in a password, so the one-line prompt that
    // `security` reads from stdin is safe for every value.
    let secret = serde_json::to_string(map).map_err(|e| Error::other(e.to_string()))?;
    let io = |e| Error::Io { path: SECURITY.into(), source: e };
    let mut child = Command::new(SECURITY)
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", domain])
        .arg("-l")
        .arg(format!("Nexora — {domain}"))
        // Last and without a value: `security` then reads the password from
        // stdin, entered twice, instead of from its arguments.
        .arg("-w")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(io)?;
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(format!("{secret}\n{secret}\n").as_bytes())
        .map_err(io)?;
    let out = child.wait_with_output().map_err(io)?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "Could not save the password to the keychain: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// The logins with a password saved for a site. Names only.
pub fn logins(domain: &str) -> Vec<String> {
    read_map(domain).into_keys().collect()
}

/// The password Nexora saved for `login` on `domain`, if it set one.
pub fn password(domain: &str, login: &str) -> Option<String> {
    read_map(domain).remove(login)
}

/// Save, or replace, the password Nexora just set for `login` on `domain`.
pub fn remember(domain: &str, login: &str, password: &str) -> Result<()> {
    let mut map = read_map(domain);
    map.insert(login.to_string(), password.to_string());
    write_map(domain, &map)
}

/// Forget every password saved for a site. Nothing saved is not an error.
pub fn forget_site(domain: &str) {
    delete_service(SERVICE, domain);
    delete_service(crate::legacy::OLD_KEYCHAIN_SERVICE, domain);
}

fn delete_service(service: &str, domain: &str) {
    let _ = Command::new(SECURITY)
        .args(["delete-generic-password", "-s", service, "-a", domain])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Carry a site's saved passwords over to its new domain.
pub fn rename_site(old: &str, new: &str) -> Result<()> {
    let map = read_map(old);
    if map.is_empty() {
        return Ok(());
    }
    write_map(new, &map)?;
    forget_site(old);
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_the_login_keychain_and_cleans_up() {
        let old = format!("nexora-secrets-test-{}.invalid", std::process::id());
        let new = format!("renamed-{old}");
        // A quote, a backslash, a space and a newline: the awkward cases for
        // anything passed through a prompt.
        let tricky = "Pa\"ss \\w0rd\nnext";

        remember(&old, "admin", tricky).unwrap();
        remember(&old, "editor", "second").unwrap();
        assert_eq!(password(&old, "admin").as_deref(), Some(tricky));
        assert_eq!(password(&old, "editor").as_deref(), Some("second"));
        assert_eq!(password(&old, "nobody"), None);

        rename_site(&old, &new).unwrap();
        assert_eq!(password(&old, "admin"), None);
        assert_eq!(password(&new, "admin").as_deref(), Some(tricky));

        forget_site(&new);
        assert_eq!(password(&new, "admin"), None);
    }
}
