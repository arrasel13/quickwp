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
pub const DNS_AGENT_LABEL: &str = "com.quickwp.manager.dns";

pub fn resolver_path(tld: &str) -> PathBuf {
    PathBuf::from(format!("/etc/resolver/{tld}"))
}

/// The DNS agent's plist. A per-user LaunchAgent, so it needs no admin rights.
pub fn dns_agent_plist_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/LaunchAgents")
        .join(format!("{DNS_AGENT_LABEL}.plist"))
}

pub fn dns_agent_running() -> bool {
    // A user agent lives in the GUI domain for this uid.
    let uid = unsafe { libc::getuid() };
    std::process::Command::new("/bin/launchctl")
        .args(["print", &format!("gui/{uid}/{DNS_AGENT_LABEL}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Install the DNS agent, so names keep resolving after QuickWP is closed.
///
/// This is not a convenience. Once /etc/resolver/<tld> points at our DNS, a
/// lookup for that TLD goes nowhere else -- so if our server is not running,
/// every such name HANGS rather than failing. Tying that to an app window
/// would mean closing the window breaks name resolution machine-wide.
///
/// A user agent needs no password, which is why it is not batched into the
/// admin prompt.
pub fn install_dns_agent(cli_binary: &std::path::Path) -> Result<()> {
    if !cli_binary.exists() {
        return Err(Error::other(format!(
            "The quickwp binary is missing at {}. The DNS agent would have nothing to run.",
            cli_binary.display()
        )));
    }
    let plist = dns_agent_plist_path();
    paths::mkdir_p(plist.parent().unwrap())?;

    let body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{cli}</string>
    <string>__dns</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{logs}/dns.log</string>
  <key>StandardErrorPath</key><string>{logs}/dns.log</string>
</dict>
</plist>
"#,
        label = DNS_AGENT_LABEL,
        cli = cli_binary.display(),
        logs = paths::logs().display(),
    );
    std::fs::write(&plist, body).map_err(|e| Error::Io {
        path: plist.clone(),
        source: e,
    })?;

    let uid = unsafe { libc::getuid() };
    let _ = std::process::Command::new("/bin/launchctl")
        .args(["bootout", &format!("gui/{uid}/{DNS_AGENT_LABEL}")])
        .output();
    let out = std::process::Command::new("/bin/launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist)
        .output()
        .map_err(|e| Error::Io {
            path: "/bin/launchctl".into(),
            source: e,
        })?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "Could not start the DNS agent: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

pub fn remove_dns_agent() {
    let uid = unsafe { libc::getuid() };
    let _ = std::process::Command::new("/bin/launchctl")
        .args(["bootout", &format!("gui/{uid}/{DNS_AGENT_LABEL}")])
        .output();
    let _ = std::fs::remove_file(dns_agent_plist_path());
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
    // Be precise about what quitting does and does not fix. rexenv's DNS runs
    // from a LaunchAgent that deliberately outlives its app, so "quit it first"
    // is advice that cannot work -- and telling someone to do a thing they have
    // already done is worse than saying nothing.
    let owner = match crate::ports::running_dev_tool() {
        Some(tool) => format!(
            "{tool} owns it. Its DNS keeps answering after you quit the app — that is by \
             design, not a leftover — so quitting does not release it. Remove {tool}'s \
             system changes from its own settings, pick a different TLD in Settings, or \
             take .{tld} over deliberately."
        ),
        None => format!(
            "Nothing running claims it, so a tool that was uninstalled left it behind and \
             .{tld} currently resolves nowhere. Pick a different TLD in Settings, or take \
             it over deliberately."
        ),
    };
    Some(format!("{} points somewhere else. {owner}", p.display()))
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

/// The LaunchDaemon plist. Pure text, so it can be linted before it is ever
/// written to a root-owned path.
pub fn plist_body(edge: &std::path::Path, certs: &std::path::Path, logs: &std::path::Path) -> String {
    format!(
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
        edge = edge.display(),
        certs = certs.display(),
        upstream = ports::NGINX,
        logs = logs.display(),
    )
}

/// The script the admin prompt runs. Returned rather than run, so its syntax
/// can be checked and a human can read exactly what they are approving.
pub fn install_script(tld: &str, edge_binary: &std::path::Path) -> String {
    let resolver = resolver_path(tld);
    let plist = daemon_plist_path();
    let installed_edge = edge_install_path();
    let body = plist_body(&installed_edge, &paths::shared_certs(), &paths::logs());

    format!(
        "set -e
mkdir -p /etc/resolver /usr/local/libexec {certs}
# Handed to the user so issuing a certificate later needs no password. Root
# only ever READS these; it never executes anything from here.
chown -R {user} {certs}
chmod 700 {certs}
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
        certs = shell_quote(&paths::shared_certs().to_string_lossy()),
        user = shell_quote(&current_user()),
        dns = ports::DNS,
        resolver = shell_quote(&resolver.to_string_lossy()),
        src_edge = shell_quote(&edge_binary.to_string_lossy()),
        dst_edge = shell_quote(&installed_edge.to_string_lossy()),
        plist = shell_quote(&plist.to_string_lossy()),
        plist_body = body,
        label = DAEMON_LABEL,
    )
}

/// One reason the install could fail, checked BEFORE any password is asked for.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Check {
    pub id: String,
    pub label: String,
    pub ok: bool,
    /// What to do about it. Empty when `ok`.
    pub fix: String,
    /// A failed blocking check means the install cannot succeed, so it is not
    /// attempted -- a password prompt for an operation that will fail is worse
    /// than no prompt.
    pub blocking: bool,
}

/// Everything that must hold before the admin prompt appears.
pub fn preflight(tld: &str, edge_binary: &std::path::Path, takeover: bool) -> Vec<Check> {
    let mut out = Vec::new();
    let mut add = |id: &str, label: &str, ok: bool, fix: &str, blocking: bool| {
        out.push(Check {
            id: id.into(),
            label: label.into(),
            ok,
            fix: if ok { String::new() } else { fix.into() },
            blocking,
        })
    };

    let edge_ok = edge_binary.exists();
    add(
        "edge-binary",
        "The edge binary is present",
        edge_ok,
        "Build it with `cargo build --release -p quickwp-edge`. Without it the daemon would be installed pointing at nothing.",
        true,
    );

    // Occupancy is measured, never inferred from a process existing. A tool's
    // name is only used to EXPLAIN a port that is genuinely taken.
    let mut taken: Vec<u16> = Vec::new();
    for (port, label) in [
        (ports::EDGE_HTTP, "Port 80 is free"),
        (ports::EDGE_HTTPS, "Port 443 is free"),
    ] {
        let free = crate::ports::is_free(port);
        if !free {
            taken.push(port);
        }
        add(
            &format!("port-{port}"),
            label,
            free,
            &format!(
                "Held by {}.",
                crate::ports::holder(port).unwrap_or_else(|| "another process".into())
            ),
            true,
        );
    }

    let rival = crate::ports::running_dev_tool();
    let rival_holds_ports = !taken.is_empty() && rival.is_some();
    add(
        "no-rival",
        "No other local environment is serving on 80/443",
        !rival_holds_ports,
        &match (&rival, taken.first()) {
            (Some(t), Some(_)) => format!(
                "{t} is serving on {}. Quit it first — only one tool can serve https://name.{tld} with no port number.",
                taken.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" and ")
            ),
            _ => String::new(),
        },
        true,
    );

    let conflict = resolver_conflict(tld);
    add(
        "resolver-free",
        &format!("Nothing else owns .{tld}"),
        conflict.is_none(),
        &conflict.clone().unwrap_or_default(),
        // Blocking, but answerable: the user can choose a different TLD, or
        // deliberately take this one over. Taking over another tool's resolver
        // is never done silently, which is why it is a separate decision rather
        // than something the install just does.
        !takeover,
    );

    add(
        "ca",
        "A certificate authority exists",
        ca::ca_exists(),
        "One will be generated before the prompt; nothing to do.",
        false,
    );

    // The plist has to be valid before it is written somewhere only root can
    // repair. plutil reads it from a temporary copy.
    add(
        "plist-valid",
        "The generated LaunchDaemon is valid",
        plist_is_valid(edge_binary),
        "The generated plist did not lint. This is a bug — do not proceed.",
        true,
    );

    add(
        "script-valid",
        "The privileged script parses",
        script_is_valid(tld, edge_binary),
        "The generated script has a syntax error. This is a bug — do not proceed.",
        true,
    );

    out
}

pub fn preflight_blocks(checks: &[Check]) -> bool {
    checks.iter().any(|c| c.blocking && !c.ok)
}

fn current_user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "root".into())
}

/// A temp path unique to this call.
///
/// A fixed name is shared state: two preflights running at once clobber each
/// other's file, and one of them validates something it did not write.
fn scratch(suffix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "quickwp-preflight-{}-{}-{}",
        std::process::id(),
        n,
        suffix
    ))
}

fn plist_is_valid(edge_binary: &std::path::Path) -> bool {
    let body = plist_body(edge_binary, &paths::shared_certs(), &paths::logs());
    let tmp = scratch("plist");
    if std::fs::write(&tmp, body).is_err() {
        return false;
    }
    let ok = std::process::Command::new("/usr/bin/plutil")
        .arg("-lint")
        .arg(&tmp)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&tmp);
    ok
}

fn script_is_valid(tld: &str, edge_binary: &std::path::Path) -> bool {
    let script = install_script(tld, edge_binary);
    let tmp = scratch("sh");
    if std::fs::write(&tmp, script).is_err() {
        return false;
    }
    // -n parses without executing a single line of it.
    let ok = std::process::Command::new("/bin/sh")
        .arg("-n")
        .arg(&tmp)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&tmp);
    ok
}

/// Install the resolver file and the edge daemon. One prompt for both.
///
/// Refuses before prompting if the preflight blocks: asking for a password to
/// perform an operation that cannot succeed is the worst of both outcomes.
pub fn install_system(tld: &str, edge_binary: &std::path::Path, takeover: bool) -> Result<()> {
    let checks = preflight(tld, edge_binary, takeover);
    if preflight_blocks(&checks) {
        let reasons: Vec<String> = checks
            .iter()
            .filter(|c| c.blocking && !c.ok)
            .map(|c| format!("• {}: {}", c.label, c.fix))
            .collect();
        return Err(Error::other(format!(
            "Not asking for your password, because this could not succeed:\n{}",
            reasons.join("\n")
        )));
    }

    run_as_root(
        &install_script(tld, edge_binary),
        &format!(
            "QuickWP needs your password once to route .{tld} to your Mac and let it serve on port 443."
        ),
    )
}

/// Is claiming this TLD a takeover from another tool, rather than a fresh
/// install? The UI asks for that consent explicitly.
pub fn tld_is_foreign(tld: &str) -> bool {
    resolver_conflict(tld).is_some()
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
        format!("rm -rf {}", shell_quote(&paths::shared_certs().to_string_lossy())),
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

    // Both of these are user-level and need no admin.
    remove_dns_agent();
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

// ------------------------------------------------------------- verification

/// One measured fact about the installed system state.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VerifyItem {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VerifyReport {
    pub items: Vec<VerifyItem>,
    pub all_ok: bool,
}

/// Prove the install actually works, rather than that files were written.
///
/// Writing a plist and reporting success is the failure mode this exists to
/// prevent: the daemon can be installed and still not be serving, and the
/// resolver can exist and still not resolve. Each item here is measured.
pub fn verify(tld: &str) -> VerifyReport {
    let mut items = Vec::new();
    let mut add = |id: &str, label: &str, ok: bool, detail: String| {
        items.push(VerifyItem { id: id.into(), label: label.into(), ok, detail })
    };

    let resolver_ours = resolver_is_ours(tld);
    add(
        "resolver",
        &format!("/etc/resolver/{tld} points at QuickWP"),
        resolver_ours,
        if resolver_ours {
            format!("port {}", ports::DNS)
        } else {
            "missing, or pointing somewhere else".into()
        },
    );

    // The file existing is not the same as the name resolving. Ask the system.
    let probe = format!("verify-quickwp.{tld}");
    let resolved = resolves_to_loopback(&probe);
    add(
        "dns",
        &format!("A .{tld} name actually resolves to 127.0.0.1"),
        resolved,
        if resolved {
            format!("{probe} -> 127.0.0.1")
        } else {
            "the resolver file is there but the name does not resolve; is the DNS server running?"
                .into()
        },
    );

    let agent = dns_agent_running();
    add(
        "dns-agent",
        "The DNS agent is running (survives closing the app)",
        agent,
        if agent {
            "loaded in launchd".into()
        } else {
            "not loaded — .{tld} names will hang whenever QuickWP is closed".replace("{tld}", tld)
        },
    );

    let plist = daemon_plist_path().exists();
    add("daemon-file", "The edge daemon is installed", plist,
        daemon_plist_path().to_string_lossy().into_owned());

    let running = daemon_running();
    add("daemon-running", "The edge daemon is running", running,
        if running { "loaded in launchd".into() } else { "not loaded — see logs/edge.log".into() });

    // The honest check: is something actually accepting TLS on 443?
    let listening = !crate::ports::is_free(ports::EDGE_HTTPS);
    add("port-443", "Something is listening on 443", listening,
        if listening { "bound".into() } else { "nothing is bound".into() });

    // Listening is not serving. An edge with no readable certificates accepts
    // the connection and closes it with no bytes, which reads as a network
    // fault; this names it for what it is.
    let shared = paths::shared_certs_usable();
    add("certs-readable", "The edge can read the certificates", shared,
        if shared {
            paths::shared_certs().to_string_lossy().into_owned()
        } else {
            format!(
                "{} is missing. Certificates in your home directory are invisible to a root \
                 daemon, so TLS would fail with no explanation.",
                paths::shared_certs().display()
            )
        });

    let trusted = ca::is_trusted();
    add("ca-trust", "The certificate authority is trusted", trusted,
        if trusted { "in your login keychain".into() } else { "not trusted; browsers will warn".into() });

    let all_ok = items.iter().all(|i| i.ok);
    VerifyReport { items, all_ok }
}

fn resolves_to_loopback(host: &str) -> bool {
    let Ok(out) = std::process::Command::new("/usr/bin/dscacheutil")
        .args(["-q", "host", "-a", "name", host])
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout).contains("127.0.0.1")
}

/// What `remove_system_changes` should leave behind: nothing of ours.
///
/// Run after removal to prove it actually reversed, rather than trusting that
/// the script ran. An app that can install privileged things and cannot show
/// they are gone is one people are right to be wary of.
pub fn verify_removed(tlds: &[String]) -> VerifyReport {
    let mut items = Vec::new();
    let mut add = |id: &str, label: &str, ok: bool, detail: String| {
        items.push(VerifyItem { id: id.into(), label: label.into(), ok, detail })
    };

    let plist_gone = !daemon_plist_path().exists();
    add("daemon-file", "The LaunchDaemon plist is gone", plist_gone,
        daemon_plist_path().to_string_lossy().into_owned());

    let not_loaded = !daemon_running();
    add("daemon-running", "The edge daemon is not loaded", not_loaded, String::new());

    let bin_gone = !edge_install_path().exists();
    add("edge-binary", "The installed edge binary is gone", bin_gone,
        edge_install_path().to_string_lossy().into_owned());

    let agent_gone = !dns_agent_running() && !dns_agent_plist_path().exists();
    add("dns-agent", "The DNS agent is gone", agent_gone,
        dns_agent_plist_path().to_string_lossy().into_owned());

    for tld in tlds {
        let ours_gone = !resolver_is_ours(tld);
        add(
            &format!("resolver-{tld}"),
            &format!("/etc/resolver/{tld} is no longer ours"),
            ours_gone,
            // A file another tool owns is deliberately left alone, so its
            // presence is not a failure to remove.
            if resolver_path(tld).exists() {
                "still present, but not pointing at QuickWP — left alone on purpose".into()
            } else {
                "removed".into()
            },
        );
    }

    let untrusted = !ca::is_trusted();
    add("ca-trust", "The certificate authority is no longer trusted", untrusted, String::new());

    let all_ok = items.iter().all(|i| i.ok);
    VerifyReport { items, all_ok }
}

#[cfg(test)]
mod artifact_tests {
    use super::*;

    #[test]
    fn the_generated_plist_is_valid_property_list() {
        // It gets written to a root-owned path where a normal user cannot
        // repair it, so it must be valid before it is ever installed.
        assert!(plist_is_valid(std::path::Path::new("/usr/local/libexec/quickwp-edge")));
    }

    #[test]
    fn the_privileged_script_parses() {
        // This text runs as root. A syntax error part-way through would leave
        // the system half-configured.
        assert!(script_is_valid("test", std::path::Path::new("/tmp/quickwp-edge")));
    }

    #[test]
    fn a_path_with_spaces_survives_the_script() {
        // QuickWP lives under "Application Support"; an unquoted path there
        // becomes two arguments and the script does the wrong thing.
        let weird = std::path::PathBuf::from("/tmp/with space/quickwp-edge");
        let script = install_script("test", &weird);
        assert!(script.contains("'/tmp/with space/quickwp-edge'"));
        assert!(script_is_valid("test", &weird));
    }

    #[test]
    fn preflight_blocks_when_the_edge_binary_is_missing() {
        // The worst outcome is a password prompt for an install that installs
        // a daemon pointing at nothing.
        let checks = preflight("test", std::path::Path::new("/definitely/not/here"), false);
        let edge = checks.iter().find(|c| c.id == "edge-binary").unwrap();
        assert!(!edge.ok);
        assert!(edge.blocking);
        assert!(preflight_blocks(&checks));
    }

    #[test]
    fn install_refuses_without_prompting_when_preflight_blocks() {
        let err =
            install_system("test", std::path::Path::new("/definitely/not/here"), false).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Not asking for your password"), "got: {msg}");
    }
}
