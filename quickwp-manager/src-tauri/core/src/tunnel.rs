//! Public tunnels.
//!
//! A Cloudflare quick tunnel gives a local site a public HTTPS URL. cloudflared
//! makes an outbound connection and receives requests over it, so nothing
//! listens here, no port is opened and no router configuration is involved --
//! which is also why it works behind NAT.
//!
//! **Tunnels die with the app, deliberately.** A public URL serving your
//! development machine, still up because you forgot about it, is not a
//! convenience: a share you have forgotten is a share you did not consent to.

use crate::{paths, ports, runtime, supervisor::Supervisor, Error, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub fn binary() -> Result<PathBuf> {
    let pin = runtime::cloudflared_pin()?;
    let p = runtime::tool_binary("cloudflared", pin.version);
    if p.exists() {
        Ok(p)
    } else {
        Err(Error::NotInstalled {
            component: "cloudflared".into(),
        })
    }
}

pub fn is_installed() -> bool {
    binary().is_ok()
}

pub async fn install(on_progress: impl Fn(runtime::Progress) + Send + 'static) -> Result<PathBuf> {
    let pin = runtime::cloudflared_pin()?;
    runtime::install_tool("cloudflared", pin, on_progress).await
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Tunnel {
    pub domain: String,
    pub public_url: String,
}

#[derive(Clone, Default)]
pub struct Tunnels {
    open: Arc<Mutex<HashMap<String, String>>>,
}

impl Tunnels {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<Tunnel> {
        self.open
            .lock()
            .map(|m| {
                m.iter()
                    .map(|(domain, url)| Tunnel {
                        domain: domain.clone(),
                        public_url: url.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn service(domain: &str) -> String {
        format!("tunnel-{domain}")
    }

    /// Open a tunnel for a site and return its public URL.
    ///
    /// The URL is read out of cloudflared's own log rather than guessed: a
    /// quick tunnel's hostname is assigned by Cloudflare and there is nothing
    /// to predict.
    pub fn start(&self, sup: &Supervisor, domain: &str) -> Result<String> {
        if let Some(existing) = self.open.lock().ok().and_then(|m| m.get(domain).cloned()) {
            return Ok(existing);
        }

        let log = paths::logs().join(format!("tunnel-{domain}.log"));
        let _ = std::fs::remove_file(&log);

        sup.start(
            &Self::service(domain),
            &binary()?,
            &[
                "tunnel".into(),
                "--no-autoupdate".into(),
                "--url".into(),
                // Point at the shared router, with the Host header preserved so
                // the right site answers.
                format!("http://127.0.0.1:{}", ports::NGINX),
                "--http-host-header".into(),
                domain.to_string(),
            ],
            None, // outbound only: nothing listens, so there is no port to gate
            Some(log.clone()),
        )?;

        for _ in 0..150 {
            if let Some(url) = read_public_url(&log) {
                if let Ok(mut m) = self.open.lock() {
                    m.insert(domain.to_string(), url.clone());
                }
                // A public share is the only thing QuickWP does that is visible
                // from outside this machine, so it is always logged.
                crate::log::write(&format!(
                    "tunnel started: {domain} -> {url} (origin 127.0.0.1:{})",
                    ports::NGINX
                ));
                return Ok(url);
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        let _ = sup.stop(&Self::service(domain));
        Err(Error::other(format!(
            "cloudflared did not report a public URL within 30s. See logs/tunnel-{domain}.log"
        )))
    }

    pub fn stop(&self, sup: &Supervisor, domain: &str) -> Result<bool> {
        let stopped = sup.stop(&Self::service(domain))?;
        if let Ok(mut m) = self.open.lock() {
            m.remove(domain);
        }
        if stopped {
            crate::log::write(&format!("tunnel stopped: {domain}"));
        }
        Ok(stopped)
    }

    /// Close every tunnel. Called when the app quits -- see the module note.
    pub fn stop_all(&self, sup: &Supervisor) {
        for t in self.list() {
            let _ = self.stop(sup, &t.domain);
        }
    }
}

/// cloudflared prints the assigned hostname into its log once the tunnel is up.
fn read_public_url(log: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(log).ok()?;
    text.split_whitespace()
        .find(|w| w.starts_with("https://") && w.contains("trycloudflare.com"))
        .map(|s| s.trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_url_is_read_from_the_log_not_guessed() {
        let p = std::env::temp_dir().join("quickwp-tunnel-log-test.log");
        std::fs::write(
            &p,
            "2026-09-09T02:00:00Z INF +----------------------------------+\n\
             |  https://odd-cat-42.trycloudflare.com  |\n",
        )
        .unwrap();
        assert_eq!(
            read_public_url(&p).unwrap(),
            "https://odd-cat-42.trycloudflare.com"
        );
    }

    #[test]
    fn no_url_yet_is_none_rather_than_a_wrong_guess() {
        let p = std::env::temp_dir().join("quickwp-tunnel-empty.log");
        std::fs::write(&p, "starting...\n").unwrap();
        assert!(read_public_url(&p).is_none());
    }
}
