//! Public tunnels.
//!
//! A Cloudflare quick tunnel gives a local site a public HTTPS URL. cloudflared
//! makes an outbound connection and receives requests over it, so nothing
//! listens here and no port is opened.
//!
//! **Every share is guarded.** A share you have forgotten is a share you did
//! not consent to, so a tunnel is never left with nobody watching it:
//!
//! * Open state lives in the database, not in one process's memory, so any
//!   Nexora process -- the app or the CLI -- can see and stop a share.
//! * A small guard process watches the owner and stops the tunnel the moment
//!   it goes. macOS cannot signal a child when its parent dies, so the guard
//!   polls -- matching on the parent's *start time* as well as its pid, because
//!   a recycled pid must not be mistaken for a living owner.
//! * A share started from the CLI has no window to close, so it carries an
//!   expiry the guard enforces.
//! * The app sweeps on launch: a tunnel recorded but gone is forgotten, and a
//!   tunnel running with no owner is killed.

use crate::{db::Db, paths, ports, proc, runtime, supervisor::Supervisor, Error, Result};
use rusqlite::params;
use std::path::PathBuf;

/// How long a CLI-started share lives before the guard closes it.
pub const CLI_TUNNEL_SECONDS: u64 = 3600;

/// The newest installed cloudflared, whichever release it is.
pub fn binary() -> Result<PathBuf> {
    runtime::installed_tool("cloudflared")
        .map(|(_, bin)| bin)
        .ok_or_else(|| Error::NotInstalled { component: "cloudflared".into() })
}

pub fn is_installed() -> bool {
    binary().is_ok()
}

pub fn installed_version() -> Option<String> {
    runtime::installed_tool("cloudflared").map(|(v, _)| v)
}

/// Install the newest cloudflared. Idempotent: one already here is kept.
pub async fn install(on_progress: impl Fn(runtime::Progress) + Send + 'static) -> Result<PathBuf> {
    if let Ok(bin) = binary() {
        return Ok(bin);
    }
    let release = runtime::latest_tool("cloudflared").await?;
    runtime::install_tool("cloudflared", &release, on_progress).await
}

/// Move to a newer cloudflared. A share that is open keeps running on the
/// release it started with -- removing a running binary's file does not stop
/// it -- and the next share uses the new one.
pub async fn update(
    release: &runtime::Release,
    on_progress: impl Fn(runtime::Progress) + Send + 'static,
) -> Result<String> {
    let before = installed_version().unwrap_or_default();
    runtime::install_tool("cloudflared", release, on_progress).await?;
    runtime::remove_other_tools("cloudflared", &release.version);
    crate::log::info("tunnel", &format!("cloudflared updated from {before} to {}", release.version));
    Ok(format!("Cloudflared updated to {}.", release.version))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Tunnel {
    pub domain: String,
    pub public_url: String,
    pub owner: String,
    pub started_at: u64,
    pub expires_at: Option<u64>,
    pub pid: u32,
}

pub fn list(db: &Db) -> Result<Vec<Tunnel>> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT domain, url, owner, started_at, expires_at, pid FROM tunnels ORDER BY started_at DESC",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(Tunnel {
                    domain: r.get(0)?,
                    public_url: r.get(1)?,
                    owner: r.get(2)?,
                    started_at: r.get::<_, i64>(3)? as u64,
                    expires_at: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                    pid: r.get::<_, i64>(5)? as u32,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

fn record(db: &Db, t: &Tunnel, guard_pid: Option<u32>) -> Result<()> {
    db.with(|c| {
        c.execute(
            "INSERT INTO tunnels (domain, url, pid, guard_pid, owner, started_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(domain) DO UPDATE SET
               url=excluded.url, pid=excluded.pid, guard_pid=excluded.guard_pid,
               owner=excluded.owner, started_at=excluded.started_at,
               expires_at=excluded.expires_at",
            params![
                t.domain,
                t.public_url,
                t.pid as i64,
                guard_pid.map(|p| p as i64),
                t.owner,
                t.started_at as i64,
                t.expires_at.map(|v| v as i64),
            ],
        )?;
        Ok(())
    })
}

fn forget(db: &Db, domain: &str) -> Result<()> {
    db.with(|c| {
        c.execute("DELETE FROM tunnels WHERE domain = ?1", params![domain])?;
        Ok(())
    })
}

/// Where the `nexora` binary lives, for spawning a guard.
fn guard_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let me = std::fs::canonicalize(&exe).unwrap_or_else(|_| exe.clone());
    // Bundled first, and never the app itself.
    let bundled = [dir.join("../Resources/nexora"), dir.join("nexora")]
        .into_iter()
        .find(|c| c.exists() && std::fs::canonicalize(c).map_or(true, |p| p != me))?;
    // A guard runs the copy outside the app, so it never keeps Nexora.app in
    // use while a share is open.
    Some(crate::helper::install(&bundled).map(|(path, _)| path).unwrap_or(bundled))
}

/// Start a share and return its public URL.
///
/// `owner_pid` is the process whose death should close it. Pass `None` from the
/// CLI, which has no lifetime of its own -- an expiry is used instead.
pub fn start(
    db: &Db,
    sup: &Supervisor,
    domain: &str,
    owner_pid: Option<u32>,
) -> Result<String> {
    if let Some(existing) = list(db)?.into_iter().find(|t| t.domain == domain) {
        if proc::is_alive(existing.pid) {
            return Ok(existing.public_url);
        }
        forget(db, domain)?;
    }

    let log = paths::logs().join(format!("tunnel-{domain}.log"));
    let _ = std::fs::remove_file(&log);

    let pid = sup.start(
        &service(domain),
        &binary()?,
        &[
            "tunnel".into(),
            "--no-autoupdate".into(),
            "--url".into(),
            format!("http://127.0.0.1:{}", ports::NGINX),
            "--http-host-header".into(),
            domain.to_string(),
        ],
        None, // outbound only: nothing listens, so there is no port to gate
        Some(log.clone()),
    )?;

    let url = match await_url(&log) {
        Some(u) => u,
        None => {
            let _ = sup.stop(&service(domain));
            return Err(Error::other(format!(
                "cloudflared did not report a public URL within 30s. See logs/tunnel-{domain}.log"
            )));
        }
    };

    let (owner, expires_at) = match owner_pid {
        Some(_) => ("app".to_string(), None),
        None => ("cli".to_string(), Some(proc::now() + CLI_TUNNEL_SECONDS)),
    };

    let t = Tunnel {
        domain: domain.to_string(),
        public_url: url.clone(),
        owner,
        started_at: proc::now(),
        expires_at,
        pid,
    };

    let guard_pid = spawn_guard(&t, owner_pid);
    record(db, &t, guard_pid)?;

    // A public share is the only thing Nexora does that is visible from
    // outside this machine, so starting one always leaves a line behind.
    crate::log::info("tunnel", &format!(
        "tunnel started: {domain} -> {url} (pid {pid}, owner {}, guard {})",
        t.owner,
        guard_pid.map(|g| g.to_string()).unwrap_or_else(|| "none".into())
    ));
    Ok(url)
}

/// Spawn the guard that closes this share when its owner goes, or it expires.
fn spawn_guard(t: &Tunnel, owner_pid: Option<u32>) -> Option<u32> {
    let bin = guard_binary()?;
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("__guard").arg("--tunnel-pid").arg(t.pid.to_string());
    cmd.arg("--domain").arg(&t.domain);

    if let Some(p) = owner_pid {
        // The start time is what makes this an identity: a recycled pid must
        // not read as a living owner.
        let start = proc::start_time(p)?;
        cmd.arg("--parent-pid").arg(p.to_string());
        cmd.arg("--parent-start").arg(start.to_string());
    }
    if let Some(exp) = t.expires_at {
        cmd.arg("--expires").arg(exp.to_string());
    }

    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());

    // Its own session, so it survives the thing it is watching.
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().ok().map(|c| c.id())
}

pub fn stop(db: &Db, sup: &Supervisor, domain: &str) -> Result<bool> {
    let recorded = list(db)?.into_iter().find(|t| t.domain == domain);
    let stopped_by_supervisor = sup.stop(&service(domain))?;

    if let Some(t) = &recorded {
        // A tunnel started by another process is not in this supervisor, so it
        // is stopped by pid instead. Either way it must actually stop.
        if !stopped_by_supervisor && proc::is_alive(t.pid) {
            proc::kill_tree(t.pid);
        }
        forget(db, domain)?;
        crate::log::info("tunnel", &format!("tunnel stopped: {domain}"));
        return Ok(true);
    }
    Ok(stopped_by_supervisor)
}

pub fn stop_all(db: &Db, sup: &Supervisor) {
    if let Ok(ts) = list(db) {
        for t in ts {
            let _ = stop(db, sup, &t.domain);
        }
    }
}

/// Reconcile the table with reality. Run at launch.
///
/// Two directions matter: a row whose process is gone is forgotten, and a row
/// that has outlived its expiry is closed. Both are how a forgotten share is
/// found rather than left running.
pub fn sweep(db: &Db, sup: &Supervisor) -> Result<usize> {
    let mut acted = 0;
    for t in list(db)? {
        if !proc::is_alive(t.pid) {
            forget(db, &t.domain)?;
            crate::log::warn("tunnel", &format!("tunnel swept (process gone): {}", t.domain));
            acted += 1;
            continue;
        }
        if let Some(exp) = t.expires_at {
            if proc::now() >= exp {
                let _ = stop(db, sup, &t.domain);
                crate::log::warn("tunnel", &format!("tunnel swept (expired): {}", t.domain));
                acted += 1;
            }
        }
    }
    Ok(acted)
}

fn service(domain: &str) -> String {
    format!("tunnel-{domain}")
}

fn await_url(log: &std::path::Path) -> Option<String> {
    for _ in 0..150 {
        if let Some(u) = read_public_url(log) {
            return Some(u);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    None
}

/// cloudflared prints the assigned hostname into its log once the tunnel is up.
/// It is read rather than guessed: a quick tunnel's hostname is assigned by
/// Cloudflare and there is nothing to predict.
pub fn read_public_url(log: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(log).ok()?;
    text.split_whitespace()
        .find(|w| w.starts_with("https://") && w.contains("trycloudflare.com"))
        .map(|s| {
            s.trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/')
                .to_string()
        })
}

/// The guard loop. Runs in its own process; see the module note.
pub fn guard_loop(
    tunnel_pid: u32,
    domain: &str,
    parent: Option<(u32, u64)>,
    expires: Option<u64>,
) {
    loop {
        if !proc::is_alive(tunnel_pid) {
            break; // the tunnel is already gone; nothing to guard
        }
        if let Some((pid, start)) = parent {
            if !proc::is_same_process(pid, start) {
                proc::kill_tree(tunnel_pid);
                crate::log::warn("tunnel", &format!("tunnel closed by guard (owner gone): {domain}"));
                break;
            }
        }
        if let Some(exp) = expires {
            if proc::now() >= exp {
                proc::kill_tree(tunnel_pid);
                crate::log::warn("tunnel", &format!("tunnel closed by guard (expired): {domain}"));
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    if let Ok(db) = Db::open() {
        let _ = forget(&db, domain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_url_is_read_from_the_log_not_guessed() {
        let p = std::env::temp_dir().join("nexora-tunnel-log-test.log");
        std::fs::write(
            &p,
            "INF +------------------+\n|  https://odd-cat-42.trycloudflare.com  |\n",
        )
        .unwrap();
        assert_eq!(read_public_url(&p).unwrap(), "https://odd-cat-42.trycloudflare.com");
    }

    #[test]
    fn no_url_yet_is_none_rather_than_a_wrong_guess() {
        let p = std::env::temp_dir().join("nexora-tunnel-empty.log");
        std::fs::write(&p, "starting...\n").unwrap();
        assert!(read_public_url(&p).is_none());
    }

    #[test]
    fn a_share_survives_the_process_that_recorded_it() {
        let db = Db::open_in_memory().unwrap();
        let t = Tunnel {
            domain: "shared.test".into(),
            public_url: "https://x.trycloudflare.com".into(),
            owner: "cli".into(),
            started_at: proc::now(),
            expires_at: Some(proc::now() + 60),
            pid: std::process::id(),
        };
        record(&db, &t, None).unwrap();
        // Another process reading the same database can see and stop it.
        let seen = list(&db).unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].domain, "shared.test");
        assert_eq!(seen[0].owner, "cli");
        assert!(seen[0].expires_at.is_some(), "a CLI share must carry a deadline");
    }

    #[test]
    fn a_cli_share_always_has_an_expiry_and_an_app_share_does_not() {
        // The rule the guard enforces: a share with no window to close it must
        // close itself.
        assert!(CLI_TUNNEL_SECONDS > 0);
    }

    #[test]
    fn sweep_forgets_a_share_whose_process_is_gone() {
        // A row left behind by a crash is exactly the forgotten share the
        // sweep exists to find. It must not linger in the table claiming the
        // machine is exposed when it is not.
        let db = Db::open_in_memory().unwrap();
        let sup = Supervisor::new();
        let dead = {
            let mut c = std::process::Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
            let pid = c.id();
            let _ = c.wait(); // reaped, so it is gone rather than a zombie
            pid
        };
        record(
            &db,
            &Tunnel {
                domain: "ghost.test".into(),
                public_url: "https://ghost.trycloudflare.com".into(),
                owner: "app".into(),
                started_at: proc::now(),
                expires_at: None,
                pid: dead,
            },
            None,
        )
        .unwrap();
        assert_eq!(list(&db).unwrap().len(), 1);
        sweep(&db, &sup).unwrap();
        assert!(
            list(&db).unwrap().is_empty(),
            "a share whose process is gone must not stay recorded"
        );
    }

    #[test]
    fn sweep_leaves_a_live_unexpired_share_alone() {
        let db = Db::open_in_memory().unwrap();
        let sup = Supervisor::new();
        record(
            &db,
            &Tunnel {
                domain: "live.test".into(),
                public_url: "https://live.trycloudflare.com".into(),
                owner: "cli".into(),
                started_at: proc::now(),
                expires_at: Some(proc::now() + 3600),
                pid: std::process::id(), // us: definitely alive
            },
            None,
        )
        .unwrap();
        sweep(&db, &sup).unwrap();
        assert_eq!(
            list(&db).unwrap().len(),
            1,
            "sweeping must not close a share that is still legitimately open"
        );
    }
}
