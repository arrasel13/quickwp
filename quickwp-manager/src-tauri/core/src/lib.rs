//! QuickWP core.
//!
//! The domain layer. Tauri commands and (later) the `quickwp` CLI are both thin
//! shells over this crate, so the app and the terminal cannot drift: the create
//! dialog and `quickwp site create` run the same code.

pub mod db;
pub mod error;
pub mod fastcgi;
pub mod paths;
pub mod php;
pub mod ports;
pub mod server;
pub mod site;
pub mod runtime;
pub mod supervisor;

pub use error::{Error, Result};

use supervisor::Supervisor;

/// The app's long-lived handle. One per process.
#[derive(Clone)]
pub struct Quickwp {
    pub db: db::Db,
    pub sup: Supervisor,
}

impl Quickwp {
    pub fn new() -> Result<Self> {
        paths::ensure_dirs()?;
        Ok(Self {
            db: db::Db::open()?,
            sup: Supervisor::new(),
        })
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

        // A leftover resolver file with no tool behind it is why a .test domain
        // meets a silent refusal later. Name it now.
        for tld in ["test", "localhost"] {
            let p = std::path::PathBuf::from(format!("/etc/resolver/{tld}"));
            if p.exists() {
                out.push(Finding {
                    level: "info".into(),
                    title: format!("/etc/resolver/{tld} already exists"),
                    detail: "Another tool (Valet, Herd, or an uninstalled one) owns this TLD. \
                             QuickWP will ask before taking it over."
                        .into(),
                });
            }
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
