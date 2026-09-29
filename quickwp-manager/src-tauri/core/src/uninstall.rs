//! Taking Nexora off this Mac, in the order that makes each step safe to stop
//! at.
//!
//! The order matters. Sites stop serving first, so nothing is written while
//! the databases are read. The databases are dumped next, while MySQL is still
//! up -- once it is stopped and its files are gone, there is nothing left to
//! dump. Only then do the services stop, the runtimes go, and the system
//! changes come out.
//!
//! **Your site folders are never touched.** They are your code; Nexora keeps
//! its own things -- runtimes, database files, certificates, logs -- inside its
//! data folder, and that is what goes. The databases leave as .sql files you
//! can load into anything.
//!
//! The app bundle itself is removed by whoever calls this: the app cannot
//! delete itself while it is running (see the script in `src/uninstall.rs` of
//! the app crate), and the CLI simply deletes it.

use crate::{database, log, mariadb, paths, privileged, site, tunnel, Nexora, Result};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Options {
    /// Dump every site's database to `~/Downloads` first.
    pub back_up_databases: bool,
    /// Remove the DNS resolver, the edge service and the certificate trust.
    /// Asks for a password.
    pub remove_system_changes: bool,
    /// Forget the saved site passwords and the local CA.
    pub remove_keychain: bool,
    /// Remove the data folder: runtimes, databases, certificates, logs.
    pub remove_data: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            back_up_databases: true,
            remove_system_changes: true,
            remove_keychain: true,
            remove_data: true,
        }
    }
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Report {
    /// The .sql files written, in the order they were made.
    pub backups: Vec<String>,
    /// Where they went, when any were made.
    pub backup_dir: Option<String>,
    /// Sites left alone, by folder: what is still on this Mac afterwards.
    pub sites_kept: Vec<String>,
    /// What was removed, for the log and for the screen that asked.
    pub removed: Vec<String>,
    /// Anything that did not work, said plainly rather than swallowed.
    pub problems: Vec<String>,
}

/// Where the dumps go: one folder per uninstall, in Downloads, where the rest
/// of Nexora's exports land.
pub fn backup_dir() -> PathBuf {
    paths::downloads().join(format!("Nexora databases {}", stamp()))
}

fn stamp() -> String {
    // Local date and time, without a dependency: seconds since the epoch read
    // through `date`, which every Mac has.
    std::process::Command::new("/bin/date")
        .arg("+%Y-%m-%d %H.%M")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "backup".into())
}

/// Everything except the app bundle itself.
///
/// `step` is told what is happening, in words meant for a person watching.
pub fn run(app: &Nexora, options: &Options, step: impl Fn(&str)) -> Result<Report> {
    let mut report = Report::default();
    let sites = site::list(&app.db).unwrap_or_default();

    // 1. Stop serving. A site being written to is a database being written to.
    step("Stopping your sites…");
    for s in &sites {
        report.sites_kept.push(s.docroot.clone());
        if s.enabled {
            if let Err(e) = site::set_enabled(&app.db, &s.domain, false) {
                report.problems.push(format!("{} could not be stopped: {e}", s.domain));
            }
        }
    }
    // A public address for a site that is going away stays up otherwise.
    tunnel::stop_all(&app.db, &app.sup);

    // 2. The databases, while their server is still running.
    if options.back_up_databases {
        step("Backing up your databases…");
        back_up(app, &sites, &mut report);
    }

    // 3. Everything Nexora runs.
    step("Stopping services…");
    app.stop_dns();
    app.sup.stop_all();
    report.removed.push("the services Nexora was running".into());

    // 4. The runtimes and the rest of the data folder. PHP, MySQL, MariaDB,
    // Node, Adminer, Mailpit and cloudflared all live under it, so this is
    // what "uninstall the services" means.
    if options.remove_data {
        step("Removing PHP, MySQL and the other runtimes…");
        let data = paths::root();
        match std::fs::remove_dir_all(&data) {
            Ok(()) => report.removed.push(data.display().to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => report.problems.push(format!("{} could not be removed: {e}", data.display())),
        }
    }

    // 5. The parts of this Mac outside Nexora's own folder.
    if options.remove_system_changes {
        step("Removing the DNS resolver and the edge service…");
        let tlds = tlds_to_clean(app);
        match privileged::remove_system_changes(&tlds) {
            Ok(()) => report
                .removed
                .push("the DNS resolver, the edge service and the certificate trust".into()),
            Err(e) => report.problems.push(format!(
                "the system changes are still in place ({e}). Remove them by hand with: \
                 sudo rm -f /etc/resolver/{} /usr/local/libexec/nexora-edge && sudo rm -rf /usr/local/etc/nexora",
                tlds.first().map(String::as_str).unwrap_or("test")
            )),
        }
    }

    if options.remove_keychain {
        step("Forgetting the saved passwords…");
        let (passwords, certs) = clear_keychain();
        report
            .removed
            .push(format!("{passwords} saved site password(s) and {certs} certificate(s)"));
    }

    // Only while there is somewhere to write: the log lives in the folder
    // this just removed, and writing to it would build the folder again.
    if paths::logs().exists() {
        for line in &report.removed {
            log::info("uninstall", &format!("removed {line}"));
        }
        for line in &report.problems {
            log::warn("uninstall", line);
        }
    }
    Ok(report)
}

/// Dump every database Nexora holds for a site. MySQL is started if it is not
/// running: it is the only thing that can read its own files.
fn back_up(app: &Nexora, sites: &[site::Site], report: &mut Report) {
    let wanted: Vec<&site::Site> = sites.iter().filter(|s| s.db_name.is_some()).collect();
    if wanted.is_empty() {
        return;
    }
    let dir = backup_dir();
    if let Err(e) = paths::mkdir_p(&dir) {
        report.problems.push(format!("no backup folder ({e}); databases were not saved"));
        return;
    }
    report.backup_dir = Some(dir.display().to_string());

    for s in wanted {
        let Some(name) = s.db_name.as_deref() else { continue };
        let series = s.db_engine.clone().unwrap_or_else(|| "8.4".into());
        // MariaDB keeps its own series and port; MySQL is the default.
        let started = if mariadb::is_mariadb(&series) {
            mariadb::series(&series)
                .and_then(|ser| mariadb::start(&app.sup, &ser).map(|_| ()))
                .is_ok()
        } else {
            database::start(&app.sup, &series).is_ok()
        };
        if !started {
            report
                .problems
                .push(format!("{name}: its database server would not start, so it was not saved"));
            continue;
        }
        let dest = dir.join(format!("{name}.sql"));
        match database::dump_to(&series, name, &dest) {
            Ok(()) => report.backups.push(dest.display().to_string()),
            Err(e) => report.problems.push(format!("{name} was not saved: {e}")),
        }
    }
}

/// The TLDs whose system changes are Nexora's: what the database says, plus
/// any resolver file pointing at Nexora's DNS port, so a database that cannot
/// be read costs nothing here.
pub fn tlds_to_clean(app: &Nexora) -> Vec<String> {
    let mut tlds = app.tlds().unwrap_or_default();
    if let Ok(dir) = std::fs::read_dir("/etc/resolver") {
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let ours = std::fs::read_to_string(entry.path())
                .map(|s| s.contains(&format!("port {}", crate::ports::DNS)))
                .unwrap_or(false);
            if ours && !tlds.contains(&name) {
                tlds.push(name);
            }
        }
    }
    if tlds.is_empty() {
        tlds.push("test".into());
    }
    tlds
}

/// The login keychain: the site passwords Nexora saved, and every copy of its
/// local CA. Returns how many of each went.
pub fn clear_keychain() -> (usize, usize) {
    let mut passwords = 0;
    while std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", crate::secrets::SERVICE])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        passwords += 1;
    }

    // By fingerprint: `security delete-certificate -c` refuses a name that
    // matches more than once, which it does after a few installs.
    let mut certs = 0;
    let keychain = dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Keychains/login.keychain-db");
    if let Ok(out) = std::process::Command::new("/usr/bin/security")
        .args(["find-certificate", "-a", "-c", crate::ca::CA_NAME, "-Z"])
        .arg(&keychain)
        .output()
    {
        let listing = String::from_utf8_lossy(&out.stdout).to_string();
        for hash in listing
            .lines()
            .filter_map(|l| l.strip_prefix("SHA-1 hash: "))
            .map(str::trim)
        {
            let gone = std::process::Command::new("/usr/bin/security")
                .args(["delete-certificate", "-Z", hash])
                .arg(&keychain)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if gone {
                certs += 1;
            }
        }
    }
    (passwords, certs)
}

/// Everything Nexora leaves in `~/Library` besides its data folder.
pub fn support_files() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    [
        "Library/Caches/com.nexora.app",
        "Library/WebKit/com.nexora.app",
        "Library/HTTPStorages/com.nexora.app",
        "Library/Saved Application State/com.nexora.app.savedState",
        "Library/Preferences/com.nexora.app.plist",
        "Library/Logs/Nexora",
    ]
    .iter()
    .map(|p| home.join(p))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backups_go_to_downloads_in_a_folder_of_their_own() {
        let dir = backup_dir();
        assert!(dir.starts_with(paths::downloads()), "beside Nexora's other exports");
        assert!(
            dir.file_name().unwrap().to_string_lossy().starts_with("Nexora databases "),
            "named for what is in it, {dir:?}"
        );
    }

    /// The real thing, in a data folder of its own: what goes, and what must
    /// not. Ignored because it sets NEXORA_HOME, which the other tests in this
    /// binary share.
    /// `cargo test -p nexora-core uninstall_removes -- --ignored --nocapture`
    #[test]
    #[ignore = "sets NEXORA_HOME for the whole process"]
    fn uninstall_removes_nexoras_own_things_and_keeps_the_sites() {
        let base = std::env::temp_dir().join(format!("nexora-uninstall-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let site_folder = base.join("Sites/keepme.test");
        std::fs::create_dir_all(data.join("runtimes/php/8.4-fpm")).unwrap();
        std::fs::create_dir_all(data.join("databases/mysql-8.4")).unwrap();
        std::fs::create_dir_all(&site_folder).unwrap();
        std::fs::write(site_folder.join("index.php"), "<?php // the user's code").unwrap();
        std::env::set_var("NEXORA_HOME", &data);

        let app = crate::Nexora::new().expect("a data folder of its own");
        site::create(
            &app.db,
            &site::NewSite {
                name: "keepme".into(),
                domain: "keepme.test".into(),
                kind: "php".into(),
                php_minor: "8.4".into(),
                link_path: Some(site_folder.display().to_string()),
            },
        )
        .expect("a site to keep");

        let steps = std::sync::Mutex::new(Vec::new());
        let report = run(
            &app,
            // No password prompt and no keychain in a test; those are the two
            // steps that reach outside this folder.
            &Options {
                back_up_databases: false,
                remove_system_changes: false,
                remove_keychain: false,
                remove_data: true,
            },
            |s| steps.lock().unwrap().push(s.to_string()),
        )
        .expect("uninstall");

        assert!(!data.exists(), "PHP, MySQL and the rest of the data folder are gone");
        assert!(site_folder.join("index.php").exists(), "the site's code is untouched");
        assert!(
            report.sites_kept.iter().any(|p| p.contains("keepme.test")),
            "and it is named as kept: {:?}",
            report.sites_kept
        );
        let said = steps.lock().unwrap().join(" | ");
        assert!(said.contains("Stopping"), "it says what it is doing: {said}");

        std::env::remove_var("NEXORA_HOME");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_support_files_are_nexoras_own_and_nothing_else() {
        for p in support_files() {
            let text = p.display().to_string();
            assert!(
                text.contains("com.nexora.app") || text.ends_with("Logs/Nexora"),
                "{text} is not Nexora's"
            );
        }
    }
}
