//! QuickWP core.
//!
//! The domain layer. Tauri commands and (later) the `quickwp` CLI are both thin
//! shells over this crate, so the app and the terminal cannot drift: the create
//! dialog and `quickwp site create` run the same code.

pub mod ca;
pub mod database;
pub mod db;
pub mod dns;
pub mod error;
pub mod exec;
pub mod fastcgi;
pub mod log;
pub mod mail;
pub mod migrate;
pub mod paths;
pub mod php;
pub mod ports;
pub mod privileged;
pub mod server;
pub mod site;
pub mod runtime;
pub mod supervisor;
pub mod tunnel;
pub mod wordpress;

pub use error::{Error, Result};

use std::sync::{Arc, Mutex};
use supervisor::Supervisor;

/// The app's long-lived handle. One per process.
#[derive(Clone)]
pub struct Quickwp {
    pub db: db::Db,
    pub sup: Supervisor,
    dns: Arc<Mutex<Option<dns::DnsServer>>>,
}

impl Quickwp {
    pub fn new() -> Result<Self> {
        paths::ensure_dirs()?;
        Ok(Self {
            db: db::Db::open()?,
            sup: Supervisor::new(),
            dns: Arc::new(Mutex::new(None)),
        })
    }

    /// Every TLD any site answers on, so DNS and the resolver files agree.
    pub fn tlds(&self) -> Result<Vec<String>> {
        let mut set: Vec<String> = vec![self.db.tld()?];
        for s in site::list(&self.db)? {
            for name in std::iter::once(&s.domain).chain(s.aliases.iter()) {
                if let Some(tld) = name.rsplit('.').next() {
                    if !set.iter().any(|t| t == tld) {
                        set.push(tld.to_string());
                    }
                }
            }
        }
        Ok(set)
    }

    pub fn dns_running(&self) -> bool {
        self.dns.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn start_dns(&self) -> Result<u16> {
        let mut guard = self.dns.lock().map_err(|_| Error::other("dns lock poisoned"))?;
        if guard.is_some() {
            return Ok(ports::DNS);
        }
        let server = dns::start(ports::DNS, self.tlds()?)?;
        let port = server.port;
        *guard = Some(server);
        Ok(port)
    }

    pub fn stop_dns(&self) {
        if let Ok(mut g) = self.dns.lock() {
            if let Some(s) = g.take() {
                s.stop();
            }
        }
    }

    /// Restart DNS so a newly added TLD is answered without a relaunch.
    pub fn reload_dns(&self) -> Result<()> {
        if self.dns_running() {
            self.stop_dns();
            self.start_dns()?;
        }
        Ok(())
    }

    /// Issue a certificate for a site if the one on disk does not already cover
    /// every name it answers on. Compared against the name SET, not file
    /// existence -- see `ca::covers`.
    pub fn ensure_cert(&self, s: &site::Site) -> Result<bool> {
        let mut names = vec![s.domain.clone()];
        names.extend(s.aliases.iter().cloned());
        if ca::covers(&s.domain, &names) {
            return Ok(false);
        }
        ca::issue_for(&s.domain, &names)?;
        Ok(true)
    }

    /// Re-issue anything whose name set has drifted. Cheap and idempotent.
    pub fn ensure_all_certs(&self) -> Result<usize> {
        let mut n = 0;
        for s in site::list(&self.db)? {
            if self.ensure_cert(&s)? {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Diagnostics. Reports what is true rather than what should be true.
    pub fn doctor(&self) -> Vec<Finding> {
        let mut out = Vec::new();

        for (label, port) in [
            ("Edge (HTTPS)", ports::EDGE_HTTPS),
            ("Edge (HTTP)", ports::EDGE_HTTP),
            ("Shared nginx", ports::NGINX),
        ] {
            if !ports::is_free(port) && !self.sup.is_running(label) {
                out.push(Finding {
                    level: "warn".into(),
                    title: format!("Port {port} is in use"),
                    detail: format!(
                        "{label} needs port {port}, and it is held by {}.",
                        ports::holder(port).unwrap_or_else(|| "an unknown process".into())
                    ),
                });
            }
        }

        let installed = runtime::PHP_MINORS
            .iter()
            .filter(|m| runtime::is_installed(m, "fpm"))
            .count();
        if installed == 0 {
            out.push(Finding {
                level: "info".into(),
                title: "No PHP installed yet".into(),
                detail: "Install a version from the PHP tab. The first one downloads ~30MB."
                    .into(),
            });
        }

        let tld = self.db.tld().unwrap_or_else(|_| "test".into());

        // A resolver file that is not ours is why a .test domain meets a silent
        // refusal later. Name it, and never treat it as "we are installed".
        if let Some(msg) = privileged::resolver_conflict(&tld) {
            out.push(Finding {
                level: "warn".into(),
                title: format!("Something else owns .{tld}"),
                detail: msg,
            });
        } else if !privileged::resolver_is_ours(&tld) {
            out.push(Finding {
                level: "info".into(),
                title: format!(".{tld} does not resolve here yet"),
                detail: "Turn on HTTPS in General to write the DNS resolver and start the edge. It asks for your password once."
                    .into(),
            });
        }

        if !ca::ca_exists() {
            out.push(Finding {
                level: "info".into(),
                title: "No certificate authority yet".into(),
                detail: "QuickWP will generate one and ask to trust it in your login keychain, so sites open on a real green lock."
                    .into(),
            });
        } else if !ca::is_trusted() {
            out.push(Finding {
                level: "warn".into(),
                title: "The certificate authority is not trusted".into(),
                detail: "Sites will serve, but the browser will warn until you trust it. Trust it from General."
                    .into(),
            });
        }

        if privileged::daemon_installed_but_stopped() {
            out.push(Finding {
                level: "warn".into(),
                title: "The edge service is installed but not running".into(),
                detail: "Something may be holding port 443. See logs/edge.log.".into(),
            });
        }

        if out.is_empty() {
            out.push(Finding {
                level: "ok".into(),
                title: "No problems found".into(),
                detail: "Ports are free and nothing is contending for a TLD.".into(),
            });
        }
        out
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Finding {
    pub level: String,
    pub title: String,
    pub detail: String,
}
