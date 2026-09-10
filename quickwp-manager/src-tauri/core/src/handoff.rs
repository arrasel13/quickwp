//! Quitting without stopping the sites, and taking them back afterwards.
//!
//! The edge lives inside the app process, so "keep sites running" cannot just
//! skip the cleanup: the moment the app exits, nothing answers on the edge
//! port. Instead the app hands the edge to a small background `quickwp
//! __serve` and leaves the pools and databases where they are -- they run in
//! their own sessions and log to files, so they outlive the app on their own.
//!
//! The next launch reads what was handed over, stops the background edge and
//! brings the same services back under the app. Pools and databases are
//! adopted by port and health rather than restarted; Mailpit cannot be, so it
//! is stopped by pid and started again.
//!
//! "Stop, restart on next launch" uses the same record with nothing left
//! running: the list of services is all the next launch needs.

use crate::{database, mail, paths, php, ports, proc, server, supervisor::Supervisor, Error, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Handoff {
    /// Supervisor names to bring back: `php-fpm-8.3`, `mysql-8.4`, `mailpit`.
    pub services: Vec<String>,
    /// Whether the edge was serving when the app quit.
    pub edge: bool,
    /// Processes left running that the next launch has to stop, as (pid, start
    /// time). A pid alone may have been recycled by then.
    pub orphans: Vec<(u32, u64)>,
}

fn file() -> PathBuf {
    paths::run().join("handoff.json")
}

/// The services worth bringing back. Tunnels are never among them: a share
/// does not outlive the app that started it.
pub fn resumable(sup: &Supervisor) -> Vec<String> {
    let mut names: Vec<String> = sup
        .names()
        .into_iter()
        .filter(|n| n.starts_with("php-fpm-") || n.starts_with("mysql-") || n == mail::SERVICE)
        .collect();
    names.sort();
    names
}

pub fn save(h: &Handoff) -> Result<()> {
    let body = serde_json::to_vec_pretty(h).map_err(|e| Error::other(e.to_string()))?;
    paths::mkdir_p(&paths::run())?;
    std::fs::write(file(), body).map_err(|e| Error::Io { path: file(), source: e })
}

pub fn clear() {
    let _ = std::fs::remove_file(file());
}

/// Read the record and delete it, so a launch that fails half-way is not
/// replayed on every launch after it.
pub fn take() -> Option<Handoff> {
    let body = std::fs::read(file()).ok()?;
    clear();
    serde_json::from_slice(&body).ok()
}

/// Stop whatever was left running on the app's behalf.
pub fn reclaim(h: &Handoff) {
    for &(pid, start) in &h.orphans {
        if proc::is_same_process(pid, start) {
            proc::kill_tree(pid);
        }
    }
}

/// Start one resumable service by its supervisor name.
pub fn start_service(sup: &Supervisor, name: &str) -> Result<()> {
    if let Some(minor) = name.strip_prefix("php-fpm-") {
        php::start_pool(sup, minor)?;
    } else if let Some(series) = name.strip_prefix("mysql-") {
        database::start(sup, series)?;
    } else if name == mail::SERVICE {
        mail::start(sup)?;
    }
    Ok(())
}

/// Leave the stack running after the app exits, with a background edge if one
/// was serving. The caller must have stopped its own edge first, or the
/// background one cannot bind.
pub fn keep_running(sup: &Supervisor, cli: &Path, edge: bool) -> Result<Handoff> {
    let services = resumable(sup);
    let mut orphans = Vec::new();
    // Pools are stopped by pid too, then started again under the app: one
    // adopted by port alone would sit outside the supervisor, and the next
    // "Stop sites" would leave it running. php-fpm stops in well under a
    // second. MySQL is left to the adoption its own module already handles --
    // a database is the one thing not worth killing to tidy up.
    for name in &services {
        if name.starts_with("mysql-") {
            continue;
        }
        if let Some(pid) = sup.state(name).pid {
            if let Some(t) = proc::start_time(pid) {
                orphans.push((pid, t));
            }
        }
    }
    if edge {
        let pid = spawn_serve(cli)?;
        if let Some(t) = proc::start_time(pid) {
            orphans.push((pid, t));
        }
    }
    Ok(Handoff { services, edge, orphans })
}

fn spawn_serve(cli: &Path) -> Result<u32> {
    let log = paths::logs().join("serve.log");
    paths::mkdir_p(&paths::logs())?;
    let io = |e| Error::Io { path: log.clone(), source: e };
    let out = std::fs::OpenOptions::new().create(true).append(true).open(&log).map_err(io)?;
    let err = out.try_clone().map_err(io)?;

    let mut cmd = Command::new(cli);
    cmd.arg("__serve")
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    // Its own session, so it is not taken down with the app's process group.
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| Error::Io { path: cli.to_path_buf(), source: e })?;
    Ok(child.id())
}

/// What `quickwp __serve` runs: the edge, and DNS unless its LaunchAgent is
/// already answering. Never returns while serving.
pub fn serve(app: &crate::Quickwp) -> Result<()> {
    // The app has just released the port; give the socket a moment to close.
    let mut edge = None;
    let mut last = None;
    for _ in 0..20 {
        match server::start(app.db.clone(), ports::NGINX) {
            Ok(e) => {
                edge = Some(e);
                break;
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }
    let Some(_edge) = edge else {
        return Err(last.unwrap_or_else(|| Error::other("the edge did not start")));
    };
    let _ = app.start_dns();
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
