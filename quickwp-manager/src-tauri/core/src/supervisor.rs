//! Process supervision.
//!
//! Two properties matter here and both are learned-the-hard-way rather than
//! obvious:
//!
//! 1. Nothing starts without its port being free first. A service that fails to
//!    bind after spawning leaves a half-started stack and a log nobody reads.
//!
//! 2. Children are spawned into their own process group. php-fpm forks workers;
//!    killing only the master leaves those workers holding the port, so the
//!    next start fails with "address in use" against a process the user cannot
//!    see in the app.

use crate::{ports, Error, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, serde::Serialize)]
pub struct ServiceState {
    pub name: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
}

struct Running {
    child: Child,
    port: Option<u16>,
}

#[derive(Clone, Default)]
pub struct Supervisor {
    procs: Arc<Mutex<HashMap<String, Running>>>,
}

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a service, gating on its port.
    ///
    /// `name` is the supervision key: starting a name that is already running
    /// is a no-op rather than a second process.
    pub fn start(
        &self,
        name: &str,
        program: &PathBuf,
        args: &[String],
        port: Option<u16>,
        log: Option<PathBuf>,
    ) -> Result<u32> {
        let mut procs = self
            .procs
            .lock()
            .map_err(|_| Error::other("supervisor lock poisoned"))?;

        if let Some(r) = procs.get_mut(name) {
            match r.child.try_wait() {
                Ok(None) => return Ok(r.child.id()), // already up
                _ => {
                    procs.remove(name);
                }
            }
        }

        if let Some(p) = port {
            ports::gate(p)?;
        }

        let mut cmd = Command::new(program);
        cmd.args(args);

        if let Some(logfile) = log {
            crate::paths::mkdir_p(logfile.parent().unwrap())?;
            let out = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&logfile)
                .map_err(|e| Error::Io {
                    path: logfile.clone(),
                    source: e,
                })?;
            let err = out.try_clone().map_err(|e| Error::Io {
                path: logfile.clone(),
                source: e,
            })?;
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        } else {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }

        // Own process group, so stop() can take the whole tree.
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }

        let child = cmd.spawn().map_err(|e| Error::Io {
            path: program.clone(),
            source: e,
        })?;
        let pid = child.id();
        procs.insert(name.to_string(), Running { child, port });
        Ok(pid)
    }

    /// Stop a service and every process it forked.
    ///
    /// SIGTERM to the group, a grace period, then SIGKILL. Waiting on the child
    /// afterwards is what stops it becoming a zombie.
    pub fn stop(&self, name: &str) -> Result<bool> {
        let mut procs = self
            .procs
            .lock()
            .map_err(|_| Error::other("supervisor lock poisoned"))?;
        let Some(mut r) = procs.remove(name) else {
            return Ok(false);
        };
        let pid = r.child.id() as i32;

        unsafe {
            // Negative pid addresses the process group.
            libc::kill(-pid, libc::SIGTERM);
        }

        for _ in 0..50 {
            match r.child.try_wait() {
                Ok(Some(_)) => return Ok(true),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => break,
            }
        }

        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = r.child.wait();
        Ok(true)
    }

    pub fn is_running(&self, name: &str) -> bool {
        let mut procs = match self.procs.lock() {
            Ok(p) => p,
            Err(_) => return false,
        };
        match procs.get_mut(name) {
            Some(r) => matches!(r.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn state(&self, name: &str) -> ServiceState {
        let mut procs = self.procs.lock().ok();
        let (running, pid, port) = match procs.as_mut().and_then(|p| p.get_mut(name)) {
            Some(r) => (
                matches!(r.child.try_wait(), Ok(None)),
                Some(r.child.id()),
                r.port,
            ),
            None => (false, None, None),
        };
        ServiceState {
            name: name.to_string(),
            running,
            pid: if running { pid } else { None },
            port,
        }
    }

    pub fn names(&self) -> Vec<String> {
        self.procs
            .lock()
            .map(|p| p.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Stop everything. Called on app quit.
    pub fn stop_all(&self) {
        for name in self.names() {
            let _ = self.stop(&name);
        }
    }
}
