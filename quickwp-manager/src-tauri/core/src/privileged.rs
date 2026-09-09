//! The four things QuickWP touches outside its own directory.
//!
//! Each is asked for once, at the moment it is first needed, and each is undone
//! by `remove_system_changes`. That function is written in the same file as the
//! code that installs them on purpose: an app that can install privileged
//! things and cannot remove them is one people are right to be afraid of.
//!
//!   /etc/resolver/<tld>   admin   sends the TLD to our DNS
//!   LaunchDaemon          admin   lets the edge bind 80 and 443
//!   login keychain        login   trusts our CA          (see `ca`)
//!   LaunchAgent           none    keeps DNS answering    (not yet built)

use crate::{ca, paths, ports, Error, Result};
use std::path::PathBuf;

pub const DAEMON_LABEL: &str = "com.quickwp.manager.edge";

pub fn resolver_path(tld: &str) -> PathBuf {
    PathBuf::from(format!("/etc/resolver/{tld}"))
}

pub fn daemon_plist_path() -> PathBuf {
    PathBuf::from(format!("/Library/LaunchDaemons/{DAEMON_LABEL}.plist"))
}

/// Where the edge binary is copied so root runs it from a stable, root-owned
/// path rather than out of a user-writable build directory.
pub fn edge_install_path() -> PathBuf {
    PathBuf::from("/usr/local/libexec/quickwp-edge")
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SystemState {
    pub resolver_installed: bool,
    pub resolver_path: String,
    pub daemon_installed: bool,
    pub daemon_running: bool,
    pub ca_exists: bool,
    pub ca_trusted: bool,
    pub tld: String,
}

pub fn state(tld: &str) -> SystemState {
    SystemState {
        resolver_installed: resolver_is_ours(tld),
        resolver_path: resolver_path(tld).to_string_lossy().into(),
        daemon_installed: daemon_plist_path().exists(),
        daemon_running: daemon_running(),
        ca_exists: ca::ca_exists(),
        ca_trusted: ca::is_trusted(),
        tld: tld.to_string(),
    }
}

/// True only when the resolver file exists AND points at our DNS port.
///
/// A file left behind by Valet or Herd also exists, and treating that as "we
/// are installed" is how a `.test` domain silently resolves to the wrong tool.
pub fn resolver_is_ours(tld: &str) -> bool {
    std::fs::read_to_string(resolver_path(tld))
        .map(|s| s.contains(&format!("port {}", ports::DNS)))
        .unwrap_or(false)
}

/// Someone else's resolver file for this TLD, if there is one.
pub fn resolver_conflict(tld: &str) -> Option<String> {
    let p = resolver_path(tld);
    if !p.exists() || resolver_is_ours(tld) {
        return None;
    }
    // Name the tool when it is running, rather than listing suspects. The
    // resolver file itself cannot say who wrote it, so a running process is
    // the best evidence available -- and when there is none, the honest answer
    // is that something uninstalled left it behind.
    let owner = match crate::ports::running_dev_tool() {
        Some(tool) => format!("{tool} owns .{tld} on this Mac"),
        None => format!(
            "nothing is running that claims it, so a tool you uninstalled \
             probably left it behind — .{tld} currently resolves nowhere"
        ),
    };
    Some(format!("{} already exists and does not point at QuickWP. {owner}.", p.display()))
}

pub fn daemon_running() -> bool {
    std::process::Command::new("/bin/launchctl")
        .args(["print", &format!("system/{DAEMON_LABEL}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a script as root through one authentication prompt.
///
/// Everything privileged is batched into a single call so the user is asked
/// once rather than once per file. The prompt text says what it is for --
/// an unexplained password box is one people are right to refuse.
fn run_as_root(script: &str, reason: &str) -> Result<()> {
    let wrapped = format!(
        "do shell script {} with prompt {} with administrator privileges",
        applescript_quote(script),
        applescript_quote(reason)
    );
    let out = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&wrapped)
        .output()
        .map_err(|e| Error::Io {
            path: "/usr/bin/osascript".into(),
            source: e,
        })?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("-128") || err.to_lowercase().contains("user canceled") {
            return Err(Error::other(
                "Cancelled. Nothing was changed — QuickWP will ask again the next \
                 time it needs this.",
            ));
        }
        return Err(Error::other(format!(
            "The privileged step failed: {}",
            err.trim()
        )));
    }
    Ok(())
}

fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Install the resolver file and the edge daemon. One prompt for both.
pub fn install_system(tld: &str, edge_binary: &std::path::Path) -> Result<()> {
    if !edge_binary.exists() {
        return Err(Error::other(format!(
            "The edge binary is missing at {}. Build it with `cargo build -p quickwp-edge`.",
            edge_binary.display()
        )));
    }

    let resolver = resolver_path(tld);
    let plist = daemon_plist_path();
    let installed_edge = edge_install_path();
    let certs = ca::certs_dir();
    let logs = paths::logs();

    let plist_body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{edge}</string>
    <string>{certs}</string>
    <string>{upstream}</string>
    <string>443</string>
    <string>80</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{logs}/edge.log</string>
  <key>StandardErrorPath</key><string>{logs}/edge.log</string>
</dict>
</plist>
"#,
        label = DAEMON_LABEL,
        edge = installed_edge.display(),
        certs = certs.display(),
        upstream = ports::NGINX,
        logs = logs.display(),
    );

    let script = format!(
        "set -e
mkdir -p /etc/resolver /usr/local/libexec
printf '%s\\n' 'nameserver 127.0.0.1' 'port {dns}' > {resolver}
chmod 644 {resolver}
cp {src_edge} {dst_edge}
chown root:wheel {dst_edge}
chmod 755 {dst_edge}
cat > {plist} <<'QUICKWP_PLIST'
{plist_body}
QUICKWP_PLIST
chown root:wheel {plist}
chmod 644 {plist}
launchctl bootout system/{label} 2>/dev/null || true
launchctl bootstrap system {plist}
launchctl enable system/{label}",
        dns = ports::DNS,
        resolver = shell_quote(&resolver.to_string_lossy()),
        src_edge = shell_quote(&edge_binary.to_string_lossy()),
        dst_edge = shell_quote(&installed_edge.to_string_lossy()),
        plist = shell_quote(&plist.to_string_lossy()),
        plist_body = plist_body,
        label = DAEMON_LABEL,
    );

    run_as_root(
        &script,
        &format!(
            "QuickWP needs your password once to route .{tld} to your Mac and let it serve on port 443."
        ),
    )
}

/// Install a resolver file for an additional TLD.
pub fn install_resolver(tld: &str) -> Result<()> {
    let resolver = resolver_path(tld);
    let script = format!(
        "set -e
mkdir -p /etc/resolver
printf '%s\\n' 'nameserver 127.0.0.1' 'port {dns}' > {resolver}
chmod 644 {resolver}",
        dns = ports::DNS,
        resolver = shell_quote(&resolver.to_string_lossy()),
    );
    run_as_root(
        &script,
        &format!("QuickWP needs your password to route .{tld} to your Mac."),
    )
}

/// Undo everything above. One prompt.
///
/// Deliberately does not touch your sites, your databases or the app's data
/// directory: this removes the system changes, not your work.
pub fn remove_system_changes(tlds: &[String]) -> Result<()> {
    let plist = daemon_plist_path();
    let installed_edge = edge_install_path();

    let mut lines = vec![
        format!("launchctl bootout system/{DAEMON_LABEL} 2>/dev/null || true"),
        format!("rm -f {}", shell_quote(&plist.to_string_lossy())),
        format!("rm -f {}", shell_quote(&installed_edge.to_string_lossy())),
    ];
    for tld in tlds {
        // Only remove a resolver file that is actually ours.
        let p = resolver_path(tld);
        lines.push(format!(
            "if grep -q 'port {}' {} 2>/dev/null; then rm -f {}; fi",
            ports::DNS,
            shell_quote(&p.to_string_lossy()),
            shell_quote(&p.to_string_lossy())
        ));
    }
    let script = format!("set -e\n{}", lines.join("\n"));

    run_as_root(
        &script,
        "QuickWP needs your password to remove the DNS resolver and the edge service.",
    )?;

    // Keychain trust is user-level and needs no admin.
    ca::untrust()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quoting_survives_a_quote() {
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn a_foreign_resolver_file_is_not_mistaken_for_ours() {
        // resolver_is_ours reads the file; with no file it must be false rather
        // than defaulting to true and claiming a TLD we do not answer for.
        assert!(!resolver_is_ours("definitely-not-a-real-tld-xyz"));
    }
}

/// Installed, but not up. Usually means something else holds 443.
pub fn daemon_installed_but_stopped() -> bool {
    daemon_plist_path().exists() && !daemon_running()
}
