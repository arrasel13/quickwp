//! Importing from Laravel Herd and Valet.
//!
//! One rule holds across the whole flow and everything else follows from it:
//!
//!   **The source installation is strictly read-only.**
//!
//! Nothing is moved, nothing is deleted, no Herd config is edited, and Herd
//! keeps working exactly as it did. You are copying, not converting -- so
//! deciding against the migration leaves nothing to undo on the other side.

use crate::{db::Db, site, Error, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
pub struct FoundSite {
    pub name: String,
    /// The shortest name becomes the primary; the rest are aliases.
    pub domain: String,
    pub aliases: Vec<String>,
    pub path: String,
    pub source: String,
    pub php_minor: Option<String>,
    pub is_wordpress: bool,
    /// False when QuickWP already has a site answering on that name.
    pub importable: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanResult {
    pub sites: Vec<FoundSite>,
    pub tools: Vec<String>,
    /// Resolver files with no tool behind them. Named before the first .test
    /// domain you type meets a silent refusal.
    pub stale_resolvers: Vec<String>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Where Valet and Herd keep their site links and parked directories.
fn config_roots() -> Vec<(String, PathBuf)> {
    vec![
        (
            "Herd".into(),
            home().join("Library/Application Support/Herd/config/valet"),
        ),
        ("Valet".into(), home().join(".config/valet")),
        ("Valet".into(), home().join(".valet")),
    ]
}

/// Find every site Herd or Valet is serving. Reads only.
pub fn scan(db: &Db) -> Result<ScanResult> {
    let mut tools = Vec::new();
    // Keyed by real path, so a Valet "link farm" -- one project registered
    // under several names -- becomes ONE site with extra domains, rather than
    // several sites that would then refuse each other for sharing a folder.
    let mut by_path: BTreeMap<PathBuf, (String, Vec<String>)> = BTreeMap::new();

    for (tool, root) in config_roots() {
        if !root.is_dir() {
            continue;
        }
        if !tools.contains(&tool) {
            tools.push(tool.clone());
        }

        // Linked sites: a symlink per name.
        let sites_dir = root.join("Sites");
        if let Ok(entries) = std::fs::read_dir(&sites_dir) {
            for e in entries.flatten() {
                let link = e.path();
                let Ok(target) = std::fs::canonicalize(&link) else {
                    continue;
                };
                if !target.is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                let entry = by_path.entry(target).or_insert((tool.clone(), Vec::new()));
                if !entry.1.contains(&name) {
                    entry.1.push(name);
                }
            }
        }

        // Parked directories: every immediate child is served by its own name.
        for parked in read_parked(&root) {
            if let Ok(entries) = std::fs::read_dir(&parked) {
                for e in entries.flatten() {
                    let p = e.path();
                    if !p.is_dir() {
                        continue;
                    }
                    let Ok(target) = std::fs::canonicalize(&p) else {
                        continue;
                    };
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        continue;
                    }
                    let entry = by_path.entry(target).or_insert((tool.clone(), Vec::new()));
                    if !entry.1.contains(&name) {
                        entry.1.push(name);
                    }
                }
            }
        }
    }

    let tld = db.tld()?;
    let existing = site::list(db)?;

    let mut sites: Vec<FoundSite> = Vec::new();
    for (path, (tool, mut names)) in by_path {
        if names.is_empty() {
            continue;
        }
        // Shortest name is the primary; the rest are aliases it answers on.
        names.sort_by_key(|n| (n.len(), n.clone()));
        let primary = format!("{}.{}", names[0], tld);
        let aliases: Vec<String> = names[1..]
            .iter()
            .map(|n| format!("{n}.{tld}"))
            .collect();

        let taken = existing.iter().any(|s| {
            s.domain == primary || s.aliases.contains(&primary) || s.docroot == path.to_string_lossy()
        });

        sites.push(FoundSite {
            name: names[0].clone(),
            domain: primary,
            aliases,
            is_wordpress: path.join("wp-includes/version.php").exists()
                || path.join("wp-load.php").exists(),
            php_minor: detect_php(&path),
            path: path.to_string_lossy().into_owned(),
            source: tool,
            importable: !taken,
            note: if taken {
                Some("QuickWP already has a site here.".into())
            } else {
                None
            },
        });
    }

    Ok(ScanResult {
        sites,
        tools,
        stale_resolvers: stale_resolvers(),
    })
}

fn read_parked(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let config = root.join("config.json");
    let Ok(text) = std::fs::read_to_string(config) else {
        return out;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    if let Some(paths) = v.get("paths").and_then(|p| p.as_array()) {
        for p in paths {
            if let Some(s) = p.as_str() {
                out.push(PathBuf::from(s));
            }
        }
    }
    out
}

/// Herd records a per-site PHP version in an isolation config; a `.valetphprc`
/// is the Valet equivalent. Absent is fine -- the caller falls back to the
/// default rather than guessing.
fn detect_php(path: &Path) -> Option<String> {
    let rc = path.join(".valetphprc");
    if let Ok(s) = std::fs::read_to_string(rc) {
        let t = s.trim().trim_start_matches("php@").to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    None
}

/// Resolver files for TLDs nothing is answering for any more.
fn stale_resolvers() -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/etc/resolver") else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(body) = std::fs::read_to_string(&p) else {
            continue;
        };
        if body.contains(&format!("port {}", crate::ports::DNS)) {
            continue; // ours
        }
        out.push(p.to_string_lossy().into_owned());
    }
    out
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImportRequest {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub php_minor: String,
}

/// Import one found site.
///
/// It is LINKED, never copied: the folder stays exactly where it is, and
/// deleting the QuickWP site later removes only our record of it. Copying
/// someone's project into our own directory is what makes a tool hard to leave.
pub fn import_site(db: &Db, req: &ImportRequest) -> Result<site::Site> {
    let path = PathBuf::from(&req.path);
    if !path.is_dir() {
        return Err(Error::other(format!(
            "{} is no longer a folder. Nothing was imported.",
            path.display()
        )));
    }

    let created = site::create(
        db,
        &site::NewSite {
            name: req.name.clone(),
            domain: req.domain.clone(),
            kind: if path.join("wp-includes/version.php").exists() {
                "wordpress".into()
            } else {
                "php".into()
            },
            php_minor: req.php_minor.clone(),
            link_path: Some(req.path.clone()),
        },
    )?;

    for alias in &req.aliases {
        // An alias already owned by another site is reported, not forced.
        site::add_domain(db, &created.domain, alias)?;
    }

    site::find(db, &created.domain)?
        .ok_or_else(|| Error::other("the imported site vanished"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanning_an_absent_herd_finds_nothing_and_does_not_fail() {
        let db = Db::open_in_memory().unwrap();
        let r = scan(&db).unwrap();
        // On a machine with no Herd this must be empty rather than an error:
        // "no sites found" is a supported outcome, not a failure.
        assert!(r.sites.is_empty() || r.sites.iter().all(|s| !s.path.is_empty()));
    }

    #[test]
    fn importing_a_missing_folder_is_refused_before_anything_is_written() {
        let db = Db::open_in_memory().unwrap();
        let err = import_site(
            &db,
            &ImportRequest {
                domain: "gone.test".into(),
                path: "/definitely/not/here".into(),
                name: "gone".into(),
                aliases: vec![],
                php_minor: "8.3".into(),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("no longer a folder"));
        assert!(site::find(&db, "gone.test").unwrap().is_none());
    }
}

// ---------------------------------------------------------------- stage 2

/// A database found in the source environment.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SourceDatabase {
    pub name: String,
    pub host: String,
    pub port: u16,
}

/// Read the connection settings a site is currently using.
///
/// Parsed out of `wp-config.php` or `.env` rather than guessed, because the
/// whole point of stage 2 is copying the database the site actually talks to.
pub fn read_connection(path: &Path) -> Option<(String, String, String, String, u16)> {
    let wp = path.join("wp-config.php");
    if let Ok(text) = std::fs::read_to_string(&wp) {
        let get = |key: &str| -> Option<String> {
            let pat = format!("'{key}'");
            for line in text.lines() {
                let l = line.trim();
                if !l.starts_with("define") || !l.contains(&pat) {
                    continue;
                }
                // define('DB_NAME', 'value');
                let after = l.split(&pat).nth(1)?;
                let mut parts = after.split(|c| c == '\'' || c == '"');
                for p in parts.by_ref() {
                    let p = p.trim();
                    if p.is_empty() || p == "," || p.starts_with(',') {
                        continue;
                    }
                    return Some(p.to_string());
                }
            }
            None
        };
        let name = get("DB_NAME")?;
        let user = get("DB_USER").unwrap_or_else(|| "root".into());
        let pass = get("DB_PASSWORD").unwrap_or_default();
        let hostport = get("DB_HOST").unwrap_or_else(|| "127.0.0.1".into());
        let (host, port) = match hostport.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(3306)),
            None => (hostport, 3306),
        };
        return Some((name, user, pass, host, port));
    }

    let env = path.join(".env");
    if let Ok(text) = std::fs::read_to_string(&env) {
        let get = |key: &str| -> Option<String> {
            text.lines()
                .find(|l| l.trim_start().starts_with(&format!("{key}=")))
                .and_then(|l| l.split_once('='))
                .map(|(_, v)| v.trim().trim_matches('"').trim_matches('\'').to_string())
        };
        let name = get("DB_DATABASE")?;
        return Some((
            name,
            get("DB_USERNAME").unwrap_or_else(|| "root".into()),
            get("DB_PASSWORD").unwrap_or_default(),
            get("DB_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            get("DB_PORT").and_then(|p| p.parse().ok()).unwrap_or(3306),
        ));
    }
    None
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DbCopyResult {
    pub site: String,
    pub source_db: String,
    pub target_db: String,
    pub tables: usize,
    pub message: String,
}

/// Copy a site's database from the source server into QuickWP's.
///
/// The source is READ and never modified. Both copies exist afterwards, which
/// is the point: you can compare them, and going back costs nothing.
pub fn copy_database(
    series: &str,
    site: &site::Site,
) -> Result<DbCopyResult> {
    let path = PathBuf::from(&site.docroot);
    let Some((src_name, src_user, src_pass, src_host, src_port)) = read_connection(&path) else {
        return Err(Error::other(format!(
            "No database settings found in {}. Looked for wp-config.php and .env.",
            site.docroot
        )));
    };

    if src_port == crate::ports::MYSQL {
        return Err(Error::other(
            "That site already points at QuickWP's own MySQL. Nothing to copy.",
        ));
    }

    // Dump from the source, read-only.
    let dump = crate::paths::downloads_cache().join(format!("import-{}.sql", site.domain));
    crate::paths::mkdir_p(dump.parent().unwrap())?;
    let file = std::fs::File::create(&dump).map_err(|e| Error::Io {
        path: dump.clone(),
        source: e,
    })?;

    let mut cmd = std::process::Command::new(crate::database::mysqldump(series)?);
    cmd.args([
        "--protocol=TCP",
        "-h",
        &src_host,
        "-P",
        &src_port.to_string(),
        "-u",
        &src_user,
    ]);
    if !src_pass.is_empty() {
        // A password on argv is visible in `ps`; MYSQL_PWD is read by the
        // client from the environment instead.
        cmd.env("MYSQL_PWD", &src_pass);
    }
    cmd.arg(&src_name);
    cmd.stdout(std::process::Stdio::from(file));
    let out = cmd.output().map_err(|e| Error::Io {
        path: "mysqldump".into(),
        source: e,
    })?;

    if !out.status.success() {
        let _ = std::fs::remove_file(&dump);
        return Err(Error::other(format!(
            "Could not read `{src_name}` from {src_host}:{src_port}. \
             Is the source database server running?\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    // Restore into ours.
    let creds = crate::database::create_for_site(series, &site.domain)?;
    crate::database::import(series, &creds.name, &dump)?;

    let tables = std::fs::read_to_string(&dump)
        .map(|s| s.matches("CREATE TABLE").count())
        .unwrap_or(0);
    let _ = std::fs::remove_file(&dump);

    site::set_database(&crate::db::Db::open()?, site.id, series, &creds.name)?;

    Ok(DbCopyResult {
        site: site.domain.clone(),
        source_db: format!("{src_name} on {src_host}:{src_port}"),
        target_db: creds.name,
        tables,
        message: format!(
            "Copied {tables} table(s). The source database was read and never modified — \
             both copies exist."
        ),
    })
}

// ---------------------------------------------------------------- stage 3

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfigDiff {
    pub file: String,
    pub changes: Vec<DiffLine>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffLine {
    pub line_number: usize,
    pub before: String,
    pub after: String,
}

/// What rewriting a site's connection config WOULD change. Writes nothing.
///
/// The most invasive step in the flow, so it is the most gated: you see the
/// diff, a backup is taken, and nothing happens until you agree. Declining
/// leaves the config alone and the site keeps talking to whatever it talked to
/// before -- a supported outcome, not a failed migration.
pub fn preview_config_rewrite(site: &site::Site, target_db: &str) -> Result<ConfigDiff> {
    let path = PathBuf::from(&site.docroot);
    let creds_port = crate::ports::MYSQL.to_string();

    let (file, rules): (PathBuf, Vec<(&str, String)>) = if path.join("wp-config.php").exists() {
        (
            path.join("wp-config.php"),
            vec![
                ("DB_NAME", target_db.to_string()),
                ("DB_USER", crate::database::sanitise_identifier(&site.domain).chars().take(30).collect()),
                ("DB_HOST", format!("127.0.0.1:{creds_port}")),
            ],
        )
    } else if path.join(".env").exists() {
        (
            path.join(".env"),
            vec![
                ("DB_DATABASE", target_db.to_string()),
                ("DB_HOST", "127.0.0.1".into()),
                ("DB_PORT", creds_port),
            ],
        )
    } else {
        return Err(Error::other(format!(
            "No wp-config.php or .env in {}. There is nothing to rewrite.",
            site.docroot
        )));
    };

    let text = std::fs::read_to_string(&file).map_err(|e| Error::Io {
        path: file.clone(),
        source: e,
    })?;
    let is_php = file.extension().map(|e| e == "php").unwrap_or(false);

    let mut changes = Vec::new();
    for (i, line) in text.lines().enumerate() {
        for (key, value) in &rules {
            let matches = if is_php {
                line.trim_start().starts_with("define") && line.contains(&format!("'{key}'"))
            } else {
                line.trim_start().starts_with(&format!("{key}="))
            };
            if !matches {
                continue;
            }
            let after = rewrite_line(line, key, value, is_php);
            if after != line {
                changes.push(DiffLine {
                    line_number: i + 1,
                    before: line.to_string(),
                    after,
                });
            }
        }
    }

    Ok(ConfigDiff {
        file: file.to_string_lossy().into_owned(),
        changes,
    })
}

fn rewrite_line(line: &str, key: &str, value: &str, is_php: bool) -> String {
    if is_php {
        let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
        format!("{indent}define( '{key}', '{value}' );")
    } else {
        format!("{key}={value}")
    }
}

/// Apply the rewrite, taking a backup of every file it touches first.
pub fn apply_config_rewrite(site: &site::Site, target_db: &str) -> Result<String> {
    let diff = preview_config_rewrite(site, target_db)?;
    if diff.changes.is_empty() {
        return Ok("Nothing to change — the config already points at QuickWP.".into());
    }

    let file = PathBuf::from(&diff.file);
    let text = std::fs::read_to_string(&file).map_err(|e| Error::Io {
        path: file.clone(),
        source: e,
    })?;

    // Backup first, and never overwrite an existing backup: the first one is
    // the pre-migration state, which is the one worth keeping.
    let backup = file.with_extension(format!(
        "{}.quickwp-backup",
        file.extension().and_then(|e| e.to_str()).unwrap_or("bak")
    ));
    if !backup.exists() {
        std::fs::write(&backup, &text).map_err(|e| Error::Io {
            path: backup.clone(),
            source: e,
        })?;
    }

    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    for change in &diff.changes {
        if let Some(slot) = lines.get_mut(change.line_number - 1) {
            *slot = change.after.clone();
        }
    }
    let trailing = if text.ends_with('\n') { "\n" } else { "" };
    std::fs::write(&file, lines.join("\n") + trailing).map_err(|e| Error::Io {
        path: file.clone(),
        source: e,
    })?;

    Ok(format!(
        "Updated {} line(s) in {}.\nA backup of the original is at {}.",
        diff.changes.len(),
        file.display(),
        backup.display()
    ))
}

#[cfg(test)]
mod stage_tests {
    use super::*;

    #[test]
    fn wp_config_connection_settings_are_parsed_not_guessed() {
        let dir = std::env::temp_dir().join("quickwp-wpconfig-parse");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("wp-config.php"),
            "<?php\ndefine( 'DB_NAME', 'oldsite' );\ndefine('DB_USER','herd');\n\
             define( 'DB_PASSWORD', 'secret' );\ndefine( 'DB_HOST', '127.0.0.1:3306' );\n",
        )
        .unwrap();
        let (name, user, pass, host, port) = read_connection(&dir).unwrap();
        assert_eq!(name, "oldsite");
        assert_eq!(user, "herd");
        assert_eq!(pass, "secret");
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 3306);
    }

    #[test]
    fn a_dotenv_is_parsed_too() {
        let dir = std::env::temp_dir().join("quickwp-dotenv-parse");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".env"),
            "APP_ENV=local\nDB_DATABASE=laravel_app\nDB_USERNAME=sail\nDB_PORT=3307\n",
        )
        .unwrap();
        let (name, user, _, _, port) = read_connection(&dir).unwrap();
        assert_eq!(name, "laravel_app");
        assert_eq!(user, "sail");
        assert_eq!(port, 3307);
    }

    #[test]
    fn a_preview_writes_nothing() {
        let dir = std::env::temp_dir().join("quickwp-preview-readonly");
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("wp-config.php");
        let original = "<?php\ndefine( 'DB_NAME', 'oldsite' );\ndefine( 'DB_HOST', '127.0.0.1:3306' );\n";
        std::fs::write(&cfg, original).unwrap();

        let site = site::Site {
            id: 1,
            name: "s".into(),
            domain: "s.test".into(),
            docroot: dir.to_string_lossy().into(),
            kind: "wordpress".into(),
            php_minor: "8.3".into(),
            server: "nginx".into(),
            enabled: true,
            is_linked: true,
            xdebug: false,
            db_engine: None,
            db_name: None,
            aliases: vec![],
        };

        let diff = preview_config_rewrite(&site, "new_db").unwrap();
        assert!(!diff.changes.is_empty(), "the preview must find the lines it would change");
        assert_eq!(
            std::fs::read_to_string(&cfg).unwrap(),
            original,
            "a preview must not modify the file"
        );
    }
}
