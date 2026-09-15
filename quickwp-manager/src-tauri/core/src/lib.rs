//! Nexora core.
//!
//! The domain layer. Tauri commands and (later) the `nexora` CLI are both thin
//! shells over this crate, so the app and the terminal cannot drift: the create
//! dialog and `nexora site create` run the same code.

pub mod adminer;
pub mod apps;
pub mod ca;
pub mod database;
pub mod db;
pub mod dns;
pub mod error;
pub mod exec;
pub mod fastcgi;
pub mod handoff;
pub mod helper;
pub mod log;
pub mod mail;
pub mod node;
pub mod migrate;
pub mod paths;
pub mod php;
pub mod phpscan;
pub mod ports;
pub mod proc;
pub mod pty;
pub mod privileged;
pub mod legacy;
pub mod secrets;
pub mod server;
pub mod site;
pub mod runtime;
pub mod supervisor;
pub mod tunnel;
pub mod wordpress;
pub mod wptools;

pub use error::{Error, Result};

/// Whether sites are served over HTTPS: names resolve here, the helper that
/// listens on 443 runs, and the browser trusts Nexora's certificates.
pub fn https_ready(tld: &str) -> bool {
    let sys = privileged::state(tld);
    sys.resolver_installed && sys.daemon_running && sys.ca_trusted
}

use std::sync::{Arc, Mutex};
use supervisor::Supervisor;

/// The app's long-lived handle. One per process.
#[derive(Clone)]
pub struct Nexora {
    pub db: db::Db,
    pub sup: Supervisor,
    dns: Arc<Mutex<Option<dns::DnsServer>>>,
}

impl Nexora {
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
        if privileged::dns_agent_running() {
            return true;
        }
        self.dns.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn start_dns(&self) -> Result<u16> {
        let mut guard = self.dns.lock().map_err(|_| Error::other("dns lock poisoned"))?;
        if guard.is_some() {
            return Ok(ports::DNS);
        }
        // The LaunchAgent owns DNS when it is installed. Starting a second
        // server would just lose the port race and report a failure that is
        // actually the correct state.
        if privileged::dns_agent_running() {
            return Ok(ports::DNS);
        }
        let server = dns::start(ports::DNS, self.tlds()?)?;
        let port = server.port;
        log::info("dns", &format!("DNS serving on port {port}"));
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
        if privileged::dns_agent_running() {
            // The agent reads the TLD set at startup, so bouncing it is how a
            // new TLD becomes answerable. launchd brings it straight back.
            let uid = unsafe { libc::getuid() };
            let _ = std::process::Command::new("/bin/launchctl")
                .args(["kickstart", "-k", &format!("gui/{uid}/{}", privileged::DNS_AGENT_LABEL)])
                .output();
            return Ok(());
        }
        if self.dns_running() {
            self.stop_dns();
            self.start_dns()?;
        }
        Ok(())
    }

    /// The MySQL series sites are created on.
    pub fn db_series(&self) -> String {
        self.db
            .setting("db_series")
            .ok()
            .flatten()
            .unwrap_or_else(|| runtime::MYSQL_SERIES[0].to_string())
    }

    /// List again every site whose folder is in the sites directory but whose
    /// record is gone, with the database its wp-config.php names.
    pub fn recover_sites(&self) -> Result<Vec<site::Site>> {
        let tld = self.db.tld()?;
        let php = self.db.default_php()?;
        let series = self.db_series();
        let mut listed = Vec::new();
        for found in site::unlisted(&self.db, &paths::sites(), &tld)? {
            match site::adopt(&self.db, &found, &php) {
                Ok(s) => {
                    if let Some((name, ..)) = migrate::read_connection(&found.docroot) {
                        let _ = site::set_database(&self.db, s.id, &series, &name);
                    }
                    log::info("sites", &format!(
                        "listed {} again: its folder {} had no record",
                        s.domain, s.docroot
                    ));
                    listed.push(s);
                }
                Err(e) => log::warn("sites", &format!("could not list {} again: {e}", found.domain)),
            }
        }
        Ok(listed)
    }

    /// Create, empty, any database a WordPress site's wp-config.php expects
    /// on Nexora's MySQL and cannot find. The site then loads WordPress's
    /// installer instead of a database connection error. Databases that
    /// exist are never touched. Needs MySQL running.
    pub fn ensure_site_databases(&self, series: &str) {
        let (Ok(sites), Ok(existing)) = (site::list(&self.db), database::databases(series)) else {
            return;
        };
        for s in sites.iter().filter(|s| s.kind == "wordpress") {
            let Some((name, user, password, host, port)) =
                migrate::read_connection(std::path::Path::new(&s.docroot))
            else {
                continue;
            };
            let local = host == "127.0.0.1" || host == "localhost";
            if !local || port != ports::MYSQL || existing.contains(&name) {
                continue;
            }
            match database::ensure_database(series, &name, &user, &password) {
                Ok(()) => log::info("sites", &format!(
                    "created the missing database {name} for {}; it starts empty",
                    s.domain
                )),
                Err(e) => log::warn("sites", &format!("could not create the database for {}: {e}", s.domain)),
            }
        }
    }

    /// Delete a site: its record, its docroot, its database and its certificate.
    ///
    /// Lives here rather than in the Tauri layer because the app and the CLI
    /// must mean the same thing by "delete". They did not: the app dropped the
    /// database and the CLI left it behind, so the next site with that name
    /// silently adopted the old one's tables.
    ///
    /// A LINKED site is the exception the whole feature rests on: its folder is
    /// the user's, so only our record of it goes.
    pub fn delete_site(&self, domain: &str) -> Result<Vec<String>> {
        let Some(s) = site::find(&self.db, domain)? else {
            return Err(Error::other(format!("no site answers on `{domain}`")));
        };
        let mut removed = Vec::new();

        if let Some(name) = s.db_name.clone() {
            let series = s
                .db_engine
                .clone()
                .unwrap_or_else(|| runtime::MYSQL_SERIES[0].to_string());
            if database::is_installed(&series) && database::adopt_if_ours(&series) {
                match database::drop_for_site(&series, &name) {
                    Ok(()) => removed.push(format!("database `{name}`")),
                    // A database we cannot reach is reported, not swallowed:
                    // silently leaving one behind is how the next site with
                    // this name inherits its tables.
                    Err(e) => removed.push(format!("database `{name}` NOT dropped: {e}")),
                }
            } else {
                removed.push(format!(
                    "database `{name}` left behind — MySQL is not running, so it could not be dropped"
                ));
            }
        }

        for p in [ca::site_cert_path(&s.domain), ca::site_key_path(&s.domain)] {
            if p.exists() && std::fs::remove_file(&p).is_ok() {
                removed.push(format!("certificate {}", p.display()));
            }
        }

        if s.is_linked {
            removed.push(format!("kept your folder at {}", s.docroot));
        } else {
            removed.push(format!("docroot {}", s.docroot));
        }

        site::delete(&self.db, &s.domain)?;
        removed.push(format!("site record for {}", s.domain));
        // Its saved passwords go with it, so a later site on the same domain
        // does not inherit them.
        secrets::forget_site(&s.domain);
        log::info("sites", &format!("site deleted: {} ({})", s.domain, removed.join("; ")));
        Ok(removed)
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

    /// The URL that opens one site's database in Adminer, already logged in.
    ///
    /// Fetches Adminer on first use and issues its certificate the same way a
    /// site gets one -- the edge picks certificates by SNI out of one
    /// directory, so a hostname with a certificate in there simply works.
    pub async fn adminer_url(&self, domain: &str) -> Result<String> {
        let site = site::find(&self.db, domain)?
            .ok_or_else(|| Error::other(format!("no site called {domain}")))?;
        let Some(db_name) = site.db_name.clone().filter(|n| !n.is_empty()) else {
            return Err(Error::other(format!(
                "{domain} has no database recorded, so there is nothing to browse"
            )));
        };

        adminer::ensure(|_| {}).await?;

        let tld = self.db.tld()?;
        let host = adminer::host(&tld);
        self.ensure_adminer_cert()?;

        // A site records the MySQL series it runs on ("8.4"), not an engine
        // name, and every series Nexora runs answers on the one MySQL port.
        // Parsing that series as an engine refused every site.
        let port = ports::MYSQL;
        let url = adminer::url(&tld, port, &db_name, &adminer::token()?);
        if https_ready(&tld) {
            return Ok(url);
        }
        // Without the HTTPS helper nothing answers on 443, and an https link
        // fails its handshake. The edge Nexora runs itself always answers.
        Ok(url.replacen(
            &format!("https://{host}/"),
            &format!("http://{host}:{}/", ports::NGINX),
            1,
        ))
    }

    /// Make Adminer's certificate if HTTPS is set up and it has none. True
    /// when one was made just now: the HTTPS edge looks for new certificates
    /// every two seconds, so a page loaded straight after cannot use it yet.
    pub fn ensure_adminer_cert(&self) -> Result<bool> {
        let tld = self.db.tld()?;
        if !https_ready(&tld) {
            return Ok(false);
        }
        let host = adminer::host(&tld);
        let names = vec![host.clone()];
        if ca::covers(&host, &names) {
            return Ok(false);
        }
        ca::issue_for(&host, &names)?;
        Ok(true)
    }

    /// Everything needed to rebuild this site elsewhere: its files and its
    /// database, in one archive in ~/Downloads.
    ///
    /// The dump goes in beside the docroot rather than inside it. Writing it
    /// into the site first would mean a crash mid-export leaves a copy of the
    /// database sitting in a web-served directory, which is a way to hand out a
    /// site's credentials by accident.
    pub fn export_site(&self, domain: &str) -> Result<std::path::PathBuf> {
        let site = site::find(&self.db, domain)?
            .ok_or_else(|| Error::other(format!("no site called {domain}")))?;
        let docroot = std::path::PathBuf::from(&site.docroot);
        if !docroot.is_dir() {
            return Err(Error::other(format!(
                "{}'s folder is missing, so there is nothing to export",
                site.domain
            )));
        }

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let dest = paths::downloads().join(format!("{}-{stamp}.zip", site.domain));
        paths::mkdir_p(&dest.parent().unwrap().to_path_buf())?;

        let parent = docroot
            .parent()
            .ok_or_else(|| Error::other("the docroot has no parent directory"))?;
        let folder = docroot
            .file_name()
            .ok_or_else(|| Error::other("the docroot has no name"))?;

        let zip = |args: &[&std::ffi::OsStr], cwd: &std::path::Path| -> Result<()> {
            let out = std::process::Command::new("/usr/bin/zip")
                .args(args)
                .current_dir(cwd)
                .output()
                .map_err(|e| Error::Io { path: "zip".into(), source: e })?;
            if !out.status.success() {
                return Err(Error::other(format!(
                    "zip failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )));
            }
            Ok(())
        };

        use std::ffi::OsStr;
        zip(
            &[
                OsStr::new("-r"),
                OsStr::new("-q"),
                OsStr::new("-X"),
                dest.as_os_str(),
                folder,
            ],
            parent,
        )?;

        // The database, when there is one. A site without one still exports.
        if let Some(name) = site.db_name.as_deref() {
            if !name.is_empty() {
                // The same setting the rest of the app resolves the series
                // from, so an export uses the engine the site actually runs on.
                let series = self
                    .db
                    .setting("db_series")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| runtime::MYSQL_SERIES[0].to_string());
                match database::export(&series, name) {
                    Ok(sql) => {
                        // -j so it lands at the archive root rather than under
                        // whatever path Downloads happens to have.
                        let r = zip(
                            &[OsStr::new("-j"), OsStr::new("-q"), dest.as_os_str(), sql.as_os_str()],
                            parent,
                        );
                        let _ = std::fs::remove_file(&sql);
                        r?;
                    }
                    Err(e) => {
                        // Say so rather than shipping a files-only archive that
                        // looks complete.
                        let _ = std::fs::remove_file(&dest);
                        return Err(Error::other(format!(
                            "the files were archived but the database dump failed, so nothing was \
                             kept: {e}"
                        )));
                    }
                }
            }
        }

        log::info("sites", &format!("site exported: {} -> {}", site.domain, dest.display()));
        Ok(dest)
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

        // One conflict explains most of the others, so it is reported once and
        // first rather than as three separate port warnings the user has to
        // piece together.
        let rival = ports::running_dev_tool();
        if let Some(tool) = &rival {
            out.push(Finding {
                level: "warn".into(),
                title: format!("{tool} is running and owns the ports Nexora needs"),
                detail: format!(
                    "Only one local environment can serve https://name.test with no port \
                     number, because only one thing can hold ports 80 and 443. Quit {tool} \
                     before turning on HTTPS here, and start it again when you want it back. \
                     Everything else is offset so both can stay installed."
                ),
            });
        }

        for (label, port) in [
            ("Edge (HTTPS)", ports::EDGE_HTTPS),
            ("Edge (HTTP)", ports::EDGE_HTTP),
            ("Shared nginx", ports::NGINX),
        ] {
            if !ports::is_free(port) && !self.sup.is_running(label) {
                // Already explained above; do not repeat it per port.
                if rival.is_some() && (port == ports::EDGE_HTTP || port == ports::EDGE_HTTPS) {
                    continue;
                }
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
                detail: "Nexora will generate one and ask to trust it in your login keychain, so sites open on a real green lock."
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
