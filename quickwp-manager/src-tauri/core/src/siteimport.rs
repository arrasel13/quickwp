//! Importing sites, with their databases, from other local environments:
//! Laravel Herd and Valet, LocalWP, rexenv -- and any folder, with or without
//! a `.sql` file, for everything else.
//!
//! One rule holds across all of it:
//!
//!   **The other tool is never written to.**
//!
//! Site files are COPIED into Nexora's sites folder, as an APFS clone where the
//! disk allows it -- instant, and taking no extra space until a file changes.
//! Databases are READ: from the tool's own server when it is running, and when
//! it is not, from a temporary server started on a clone of its data directory,
//! so its files are never opened for writing. Only the copy's `wp-config.php`
//! or `.env` is pointed at Nexora. The original keeps working in its own tool,
//! and deciding against the import leaves nothing to undo there.

use crate::{db::Db, paths, ports, site, Error, Result};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

// ------------------------------------------------------------ what is found

/// A database a found site uses, as the window shows it. No credentials: the
/// import reads them again from the source when it runs.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DbInfo {
    /// "mysql", "mariadb", "pgsql" or "sqlite".
    pub engine: String,
    pub name: String,
    /// "rexenv's MySQL on port 13306".
    pub location: String,
    /// Whether Nexora can import it.
    pub supported: bool,
    /// Whether its server answers now. When it does not, a stopped server of
    /// a known tool is read through a temporary copy.
    pub running: bool,
    /// Why it cannot be imported, when it cannot.
    pub note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Found {
    /// "Herd", "Valet", "LocalWP", "rexenv".
    pub source: String,
    pub name: String,
    /// What the site answers on in Nexora: its name under Nexora's TLD.
    pub domain: String,
    /// What it answered on in the other tool, when that differs.
    pub source_domain: Option<String>,
    /// The folder the site is served from, which is what is copied.
    pub path: String,
    pub php_minor: Option<String>,
    pub is_wordpress: bool,
    pub database: Option<DbInfo>,
    pub importable: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Scan {
    pub sites: Vec<Found>,
    /// Every tool found on this Mac, with or without sites.
    pub tools: Vec<String>,
}

/// Where a database lives and how to read it. Stays in the backend.
#[derive(Debug, Clone)]
pub struct SourceDb {
    pub engine: String,
    pub name: String,
    pub user: String,
    pub password: String,
    pub host: String,
    pub port: u16,
    pub socket: Option<PathBuf>,
    /// The tool's own server and its data directory, to read a copy of the
    /// data through when the server is not running.
    pub offline: Option<(PathBuf, PathBuf)>,
    /// "rexenv's MySQL".
    pub label: String,
}

impl SourceDb {
    fn supported(&self) -> bool {
        matches!(self.engine.as_str(), "mysql" | "mariadb")
    }

    /// Whether its server answers now.
    fn running(&self) -> bool {
        if let Some(sock) = &self.socket {
            if std::os::unix::net::UnixStream::connect(sock).is_ok() {
                return true;
            }
        }
        let addr = if self.host == "localhost" { "127.0.0.1" } else { self.host.as_str() };
        let Ok(ip) = addr.parse::<std::net::IpAddr>() else { return false };
        std::net::TcpStream::connect_timeout(&(ip, self.port).into(), std::time::Duration::from_millis(400)).is_ok()
    }

    fn info(&self) -> DbInfo {
        let supported = self.supported();
        let running = supported && self.running();
        let where_ = if let Some(s) = &self.socket {
            if self.port == 0 { format!("{} ({})", self.label, s.display()) } else { format!("{} on port {}", self.label, self.port) }
        } else {
            format!("{} on port {}", self.label, self.port)
        };
        let note = match self.engine.as_str() {
            "pgsql" => Some("PostgreSQL isn't supported yet. The site's files are imported; its database stays where it is.".into()),
            "sqlite" => Some("SQLite lives in the site's folder, so it comes across with the files.".into()),
            _ if !running && self.offline.is_none() => Some(format!("Start {} to import this database.", self.label)),
            _ => None,
        };
        DbInfo {
            engine: self.engine.clone(),
            name: self.name.clone(),
            location: where_,
            supported,
            running,
            note,
        }
    }
}

/// The first label of a domain, as a site name Nexora can use: "my-shop" from
/// "my-shop.local".
fn label_of(domain: &str) -> String {
    let first = domain.split('.').next().unwrap_or(domain).to_ascii_lowercase();
    let cleaned: String = first
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    cleaned.trim_matches('-').to_string()
}

/// "8.3" from "8.3", "8.3.12", "php@8.3" or "php-8.3".
fn minor_of(v: &str) -> Option<String> {
    let v = v.trim().trim_start_matches("php@").trim_start_matches("php-").trim_start_matches("php");
    let mut parts = v.split('.');
    let (a, b) = (parts.next()?, parts.next()?);
    (a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit()) && !a.is_empty() && !b.is_empty())
        .then(|| format!("{a}.{b}"))
}

fn is_wordpress(path: &Path) -> bool {
    path.join("wp-includes/version.php").exists() || path.join("wp-load.php").exists()
}

// ----------------------------------------------------------- config parsing

/// A value out of `define( 'KEY', 'value' );`, either quote style.
fn wp_define(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let l = line.trim();
        if !l.starts_with("define") {
            continue;
        }
        let (Some(open), Some(_)) = (l.find('('), l.rfind(')')) else { continue };
        let args = &l[open + 1..];
        let mut quoted = Vec::new();
        let mut chars = args.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' || c == '"' {
                let mut s = String::new();
                while let Some(d) = chars.next() {
                    if d == '\\' {
                        if let Some(e) = chars.next() {
                            s.push(e);
                        }
                    } else if d == c {
                        break;
                    } else {
                        s.push(d);
                    }
                }
                quoted.push(s);
                if quoted.len() == 2 {
                    break;
                }
            }
        }
        if quoted.first().map(|k| k == key).unwrap_or(false) {
            return quoted.get(1).cloned();
        }
    }
    None
}

fn env_value(text: &str, key: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| l.starts_with(&format!("{key}=")))
        .and_then(|l| l.split_once('='))
        .map(|(_, v)| v.trim().trim_matches('"').trim_matches('\'').to_string())
}

/// The database a site's own config names, whichever tool serves it.
pub fn config_db(path: &Path, label: &str) -> Option<SourceDb> {
    if let Ok(text) = std::fs::read_to_string(path.join("wp-config.php")) {
        let name = wp_define(&text, "DB_NAME")?;
        let host_raw = wp_define(&text, "DB_HOST").unwrap_or_else(|| "localhost".into());
        let (host, port, socket) = split_host(&host_raw);
        return Some(SourceDb {
            engine: "mysql".into(),
            name,
            user: wp_define(&text, "DB_USER").unwrap_or_else(|| "root".into()),
            password: wp_define(&text, "DB_PASSWORD").unwrap_or_default(),
            host,
            port,
            socket,
            offline: None,
            label: label.to_string(),
        });
    }
    let text = std::fs::read_to_string(path.join(".env")).ok()?;
    let engine = match env_value(&text, "DB_CONNECTION").as_deref() {
        Some("pgsql") | Some("postgres") | Some("postgresql") => "pgsql",
        Some("sqlite") => "sqlite",
        Some("mariadb") => "mariadb",
        _ => "mysql",
    };
    let default_port = if engine == "pgsql" { 5432 } else { 3306 };
    Some(SourceDb {
        engine: engine.into(),
        name: env_value(&text, "DB_DATABASE").unwrap_or_default(),
        user: env_value(&text, "DB_USERNAME").unwrap_or_else(|| "root".into()),
        password: env_value(&text, "DB_PASSWORD").unwrap_or_default(),
        host: env_value(&text, "DB_HOST").unwrap_or_else(|| "127.0.0.1".into()),
        port: env_value(&text, "DB_PORT").and_then(|p| p.parse().ok()).unwrap_or(default_port),
        socket: env_value(&text, "DB_SOCKET").filter(|s| !s.is_empty()).map(PathBuf::from),
        offline: None,
        label: label.to_string(),
    })
    .filter(|d| d.engine == "sqlite" || !d.name.is_empty())
}

/// "127.0.0.1:13306", "localhost", "localhost:/tmp/mysql.sock".
fn split_host(raw: &str) -> (String, u16, Option<PathBuf>) {
    match raw.split_once(':') {
        Some((h, rest)) if rest.starts_with('/') => (h.to_string(), 0, Some(PathBuf::from(rest))),
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(3306), None),
        None => (raw.to_string(), 3306, None),
    }
}

// ------------------------------------------------------------------ scanning

/// Every site Herd, Valet, LocalWP and rexenv serve on this Mac. Reads only.
pub fn scan(db: &Db) -> Result<Scan> {
    let tld = db.tld()?;
    let existing = site::list(db)?;
    let mut tools = Vec::new();
    let mut sites = Vec::new();

    // Herd and Valet, through the scan that already knows their layout.
    if let Ok(herd) = crate::migrate::scan(db) {
        for t in herd.tools {
            if !tools.contains(&t) {
                tools.push(t);
            }
        }
        for s in herd.sites {
            let path = PathBuf::from(&s.path);
            let label = format!("{}'s database", s.source);
            sites.push(Found {
                source: s.source,
                name: s.name.clone(),
                domain: s.domain,
                source_domain: None,
                php_minor: s.php_minor.as_deref().and_then(minor_of),
                is_wordpress: s.is_wordpress,
                database: config_db(&path, &label).map(|d| d.info()),
                path: s.path,
                importable: true,
                note: None,
            });
        }
    }

    if let Some((found, present)) = localwp(&tld) {
        if present {
            tools.push("LocalWP".into());
        }
        sites.extend(found);
    }
    if let Some((found, present)) = rexenv(&tld) {
        if present {
            tools.push("rexenv".into());
        }
        sites.extend(found);
    }

    // What cannot come across, and why.
    for s in &mut sites {
        let dest = paths::sites().join(label_of(&s.domain));
        let taken = existing.iter().any(|e| e.domain == s.domain || e.aliases.contains(&s.domain));
        let copied_here = existing.iter().any(|e| Path::new(&e.docroot) == Path::new(&s.path));
        if taken || copied_here {
            s.importable = false;
            s.note = Some("Nexora already has this site.".into());
        } else if dest.exists() {
            s.importable = false;
            s.note = Some(format!("{} already exists.", dest.display()));
        } else if !Path::new(&s.path).is_dir() {
            s.importable = false;
            s.note = Some("Its folder is missing.".into());
        }
    }
    sites.sort_by(|a, b| (a.source.clone(), a.domain.clone()).cmp(&(b.source.clone(), b.domain.clone())));
    Ok(Scan { sites, tools })
}

// -------------------------------------------------------------------- LocalWP
//
// LocalWP lists its sites in sites.json, keyed by site id. Each is served from
// `<path>/app/public`, and runs its own MySQL or MariaDB -- a socket in
// `run/<id>/mysql/mysqld.sock` while the site is started in LocalWP, with its
// data in `run/<id>/mysql/data`. The server binaries are LocalWP's
// "lightning services".

fn localwp_root() -> PathBuf {
    home().join("Library/Application Support/Local")
}

fn localwp_sites() -> Option<serde_json::Map<String, serde_json::Value>> {
    let text = std::fs::read_to_string(localwp_root().join("sites.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.as_object().cloned()
}

fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(p),
    }
}

fn localwp(tld: &str) -> Option<(Vec<Found>, bool)> {
    let present = localwp_root().join("sites.json").is_file();
    let sites = localwp_sites()?;
    let mut out = Vec::new();
    for (id, s) in &sites {
        let Some(path) = s.get("path").and_then(|p| p.as_str()).map(expand) else { continue };
        let public = path.join("app/public");
        let domain_src = s.get("domain").and_then(|d| d.as_str()).unwrap_or_default().to_string();
        let name = s.get("name").and_then(|d| d.as_str()).unwrap_or(&domain_src).to_string();
        let label = label_of(if domain_src.is_empty() { &name } else { &domain_src });
        if label.is_empty() {
            continue;
        }
        let php = s
            .pointer("/services/php/version")
            .and_then(|v| v.as_str())
            .and_then(minor_of);
        out.push(Found {
            source: "LocalWP".into(),
            name,
            domain: format!("{label}.{tld}"),
            source_domain: Some(domain_src),
            php_minor: php,
            is_wordpress: is_wordpress(&public),
            database: localwp_db(id, s).map(|d| d.info()),
            path: public.to_string_lossy().into_owned(),
            importable: true,
            note: None,
        });
    }
    Some((out, present))
}

fn localwp_db(id: &str, s: &serde_json::Value) -> Option<SourceDb> {
    let engine = s.pointer("/services/mysql/name").and_then(|v| v.as_str()).unwrap_or("mysql");
    let engine = if engine.contains("maria") { "mariadb" } else { "mysql" };
    let version = s.pointer("/services/mysql/version").and_then(|v| v.as_str()).unwrap_or("");
    let port = s
        .pointer("/services/mysql/ports/MYSQL/0")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u16;
    let run = localwp_root().join("run").join(id).join("mysql");
    let server = lightning_server(engine, version);
    Some(SourceDb {
        engine: engine.into(),
        name: s.pointer("/mysql/database").and_then(|v| v.as_str()).unwrap_or("local").into(),
        user: s.pointer("/mysql/user").and_then(|v| v.as_str()).unwrap_or("root").into(),
        password: s.pointer("/mysql/password").and_then(|v| v.as_str()).unwrap_or("root").into(),
        host: "127.0.0.1".into(),
        port,
        socket: Some(run.join("mysqld.sock")),
        offline: server.zip(Some(run.join("data")).filter(|d| d.is_dir())),
        label: format!("LocalWP's {}", if engine == "mariadb" { "MariaDB" } else { "MySQL" }),
    })
}

/// LocalWP's own server binary for an engine and version:
/// `lightning-services/mysql-8.0.35+4/bin/darwin-arm64/bin/mysqld`.
fn lightning_server(engine: &str, version: &str) -> Option<PathBuf> {
    let root = localwp_root().join("lightning-services");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            n.starts_with(&format!("{engine}-")) && (version.is_empty() || n.contains(version))
        })
        .collect();
    dirs.sort();
    for d in dirs.iter().rev() {
        if let Some(bin) = find_named(&d.join("bin"), &["mysqld", "mariadbd"], 4) {
            return Some(bin);
        }
    }
    None
}

fn find_named(dir: &Path, names: &[&str], depth: usize) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        let n = e.file_name().to_string_lossy().to_string();
        if p.is_file() && names.contains(&n.as_str()) {
            return Some(p);
        }
        if p.is_dir() && depth > 0 {
            if let Some(found) = find_named(&p, names, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

// --------------------------------------------------------------------- rexenv
//
// rexenv keeps its sites in its own SQLite database. It is read from a copy,
// so rexenv's files -- and its write-ahead log -- are never opened here.

fn rexenv_root() -> PathBuf {
    home().join("Library/Application Support/dev.rexenv.rexenv")
}

fn rexenv(tld: &str) -> Option<(Vec<Found>, bool)> {
    let root = rexenv_root();
    let dbfile = root.join("rexenv.db");
    if !dbfile.is_file() {
        return None;
    }
    let tmp = paths::downloads_cache().join(format!("rexenv-scan-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    paths::mkdir_p(&tmp).ok()?;
    for suffix in ["", "-wal", "-shm"] {
        let from = root.join(format!("rexenv.db{suffix}"));
        if from.exists() {
            let _ = std::fs::copy(&from, tmp.join(format!("rexenv.db{suffix}")));
        }
    }
    let rows = (|| -> rusqlite::Result<Vec<(String, String, String, String, String, String, String)>> {
        let c = rusqlite::Connection::open(tmp.join("rexenv.db"))?;
        let mut st = c.prepare(
            "SELECT name, domain, php_version, path, COALESCE(docroot_subdir, ''), COALESCE(db_name, ''), COALESCE(db_engine, 'mysql') FROM sites",
        )?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    let rows = rows.ok()?;

    let server = newest_rexenv_mysqld();
    let mut out = Vec::new();
    for (name, domain, php, path, subdir, db_name, engine) in rows {
        let project = PathBuf::from(&path);
        let served = if subdir.is_empty() { project.clone() } else { project.join(&subdir) };
        let label = label_of(&domain);
        if label.is_empty() {
            continue;
        }
        let mut db = config_db(&served, "rexenv's MySQL");
        if let Some(d) = db.as_mut() {
            if !db_name.is_empty() {
                d.name = db_name.clone();
            }
            if engine == "mysql" {
                d.offline = server.clone().zip(Some(root.join("mysql/data")).filter(|p| p.is_dir()));
            } else {
                d.engine = engine.clone();
            }
        }
        let domain_here = format!("{label}.{tld}");
        out.push(Found {
            source: "rexenv".into(),
            name,
            source_domain: (domain != domain_here).then_some(domain),
            domain: domain_here,
            php_minor: minor_of(&php),
            is_wordpress: is_wordpress(&served),
            database: db.map(|d| d.info()),
            path: served.to_string_lossy().into_owned(),
            importable: true,
            note: None,
        });
    }
    Some((out, true))
}

fn newest_rexenv_mysqld() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(rexenv_root().join("bin"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("mysql-")))
        .collect();
    dirs.sort();
    dirs.into_iter().rev().map(|d| d.join("bin/mysqld")).find(|p| p.is_file())
}

/// The database a found site uses, with its credentials, read again at import.
pub fn source_db(source: &str, path: &Path) -> Option<SourceDb> {
    match source {
        "LocalWP" => {
            let sites = localwp_sites()?;
            sites.iter().find_map(|(id, s)| {
                let p = s.get("path").and_then(|p| p.as_str()).map(expand)?;
                (p.join("app/public") == path).then(|| localwp_db(id, s)).flatten()
            })
        }
        "rexenv" => {
            let mut db = config_db(path, "rexenv's MySQL")?;
            if db.engine == "mysql" {
                db.offline = newest_rexenv_mysqld().zip(Some(rexenv_root().join("mysql/data")).filter(|p| p.is_dir()));
            }
            Some(db)
        }
        "Folder" => config_db(path, "the database in its config"),
        other => config_db(path, &format!("{other}'s database")),
    }
}

// --------------------------------------------------------------- the import

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Request {
    /// "Herd", "Valet", "LocalWP", "rexenv" or "Folder".
    pub source: String,
    /// The folder the site is served from.
    pub path: String,
    pub name: String,
    pub domain: String,
    pub php_minor: String,
    /// Bring the database across too.
    pub include_database: bool,
    /// A dump to import instead of reading a server: `.sql` or `.sql.gz`.
    pub sql_file: Option<String>,
}

/// What an import did, for the window.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Outcome {
    pub domain: String,
    pub path: String,
    /// "Copied 1,204 MB of database into wpdev_test", or why not.
    pub database: Option<String>,
    pub notes: Vec<String>,
}

/// Copy a folder, as an APFS clone when the volume supports it: instant, and
/// no extra space until a file is changed.
pub fn clone_folder(from: &Path, to: &Path) -> Result<()> {
    if to.exists() {
        return Err(Error::other(format!("{} already exists.", to.display())));
    }
    paths::mkdir_p(to.parent().unwrap())?;
    for args in [&["-c", "-R", "-p"][..], &["-R", "-p"][..]] {
        let out = Command::new("/bin/cp")
            .args(args)
            .arg(from)
            .arg(to)
            .output()
            .map_err(|e| Error::Io { path: to.to_path_buf(), source: e })?;
        if out.status.success() {
            return Ok(());
        }
        let _ = std::fs::remove_dir_all(to);
    }
    Err(Error::other(format!("{} could not be copied.", from.display())))
}

/// Step one: copy the files and create the site. The caller brings the
/// database across afterwards, and removes the site again if that fails.
pub fn copy_site(db: &Db, req: &Request) -> Result<(site::Site, PathBuf)> {
    let from = PathBuf::from(&req.path);
    if !from.is_dir() {
        return Err(Error::other(format!("{} is no longer a folder.", from.display())));
    }
    let dest = paths::sites().join(label_of(&req.domain));
    clone_folder(&from, &dest)?;
    let created = site::create(
        db,
        &site::NewSite {
            name: req.name.clone(),
            domain: req.domain.clone(),
            kind: if is_wordpress(&dest) { "wordpress".into() } else { "php".into() },
            php_minor: req.php_minor.clone(),
            link_path: Some(dest.to_string_lossy().into_owned()),
        },
    );
    let created = match created {
        Ok(s) => s,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(e);
        }
    };
    // A copy in Nexora's own folder is Nexora's, not a link to someone's code.
    db.with(|c| {
        c.execute("UPDATE sites SET is_linked = 0 WHERE id = ?1", [created.id])?;
        Ok(())
    })?;
    let site = site::find(db, &created.domain)?.ok_or_else(|| Error::other("the imported site vanished"))?;
    Ok((site, dest))
}

/// Progress through a database copy: bytes so far.
pub type OnBytes<'a> = &'a dyn Fn(u64);

/// Stream a source database into a Nexora database: mysqldump from the
/// source, straight into mysql -- no dump file on disk however large it is.
pub fn copy_database(series: &str, src: &SourceDb, target: &str, on_bytes: OnBytes) -> Result<u64> {
    if !src.supported() {
        return Err(Error::other(format!("{} databases can't be imported yet.", engine_name(&src.engine))));
    }
    if src.running() {
        return stream(series, &connection_args(src), Some(&src.password), &src.name, target, on_bytes);
    }
    let Some((server, data)) = &src.offline else {
        return Err(Error::other(format!("{} is not running. Start it, then import again.", src.label)));
    };
    let temp = TempServer::start(server, data)?;
    let args = vec!["--protocol=SOCKET".into(), "-S".into(), temp.socket.to_string_lossy().into_owned(), "-u".into(), "root".into()];
    stream(series, &args, None, &src.name, target, on_bytes)
}

fn engine_name(e: &str) -> &str {
    match e {
        "pgsql" => "PostgreSQL",
        "sqlite" => "SQLite",
        "mariadb" => "MariaDB",
        _ => "MySQL",
    }
}

fn connection_args(src: &SourceDb) -> Vec<String> {
    if let Some(sock) = src.socket.as_ref().filter(|s| std::os::unix::net::UnixStream::connect(s).is_ok()) {
        return vec!["--protocol=SOCKET".into(), "-S".into(), sock.to_string_lossy().into_owned(), "-u".into(), src.user.clone()];
    }
    let host = if src.host == "localhost" { "127.0.0.1".to_string() } else { src.host.clone() };
    vec!["--protocol=TCP".into(), "-h".into(), host, "-P".into(), src.port.to_string(), "-u".into(), src.user.clone()]
}

fn stream(series: &str, conn: &[String], password: Option<&str>, source_db: &str, target: &str, on_bytes: OnBytes) -> Result<u64> {
    let logs = paths::downloads_cache();
    paths::mkdir_p(&logs)?;
    let dump_err = logs.join(format!("import-dump-{}.err", std::process::id()));
    let load_err = logs.join(format!("import-load-{}.err", std::process::id()));
    let file = |p: &Path| std::fs::File::create(p).map_err(|e| Error::Io { path: p.to_path_buf(), source: e });

    let mut dump = Command::new(crate::database::mysqldump(series)?);
    dump.args(conn)
        .args([
            "--single-transaction",
            "--quick",
            "--routines",
            "--triggers",
            "--no-tablespaces",
            "--set-gtid-purged=OFF",
            "--column-statistics=0",
            "--default-character-set=utf8mb4",
            source_db,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(file(&dump_err)?));
    // A password on argv shows in `ps`; the client reads MYSQL_PWD instead.
    match password {
        Some(p) if !p.is_empty() => {
            dump.env("MYSQL_PWD", p);
        }
        _ => {
            dump.env_remove("MYSQL_PWD");
        }
    }
    let mut dump = dump.spawn().map_err(|e| Error::Io { path: "mysqldump".into(), source: e })?;

    let mut load = Command::new(crate::database::mysql_client(series)?)
        .args([
            "--protocol=TCP",
            "-h",
            "127.0.0.1",
            "-P",
            &ports::MYSQL.to_string(),
            "-u",
            "root",
            "--default-character-set=utf8mb4",
            target,
        ])
        .env_remove("MYSQL_PWD")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(file(&load_err)?))
        .spawn()
        .map_err(|e| Error::Io { path: "mysql".into(), source: e })?;

    let copied = pump(dump.stdout.take().unwrap(), load.stdin.take().unwrap(), on_bytes);
    let dumped = dump.wait();
    let loaded = load.wait();
    let read_err = |p: &Path| std::fs::read_to_string(p).unwrap_or_default().trim().to_string();
    let (dump_msg, load_msg) = (read_err(&dump_err), read_err(&load_err));
    let _ = std::fs::remove_file(&dump_err);
    let _ = std::fs::remove_file(&load_err);

    if !dumped.map(|s| s.success()).unwrap_or(false) {
        return Err(Error::other(format!("The source database could not be read: {}", first_line(&dump_msg))));
    }
    if !loaded.map(|s| s.success()).unwrap_or(false) {
        return Err(Error::other(format!("The database could not be imported: {}", first_line(&load_msg))));
    }
    copied.map_err(|e| Error::other(format!("The database copy was interrupted: {e}")))
}

fn first_line(s: &str) -> String {
    s.lines()
        .find(|l| !l.contains("Using a password") && !l.trim().is_empty())
        .unwrap_or(s)
        .chars()
        .take(400)
        .collect()
}

/// Copy the dump into the client line by line, making MariaDB-only collations
/// something MySQL knows. Data rows are passed through untouched.
fn pump(from: impl Read, mut to: impl Write, on_bytes: OnBytes) -> std::io::Result<u64> {
    let mut reader = BufReader::with_capacity(1 << 20, from);
    let mut line = Vec::with_capacity(1 << 16);
    let mut total = 0u64;
    let mut reported = 0u64;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if line.starts_with(b"INSERT INTO") {
            to.write_all(&line)?;
        } else {
            to.write_all(fix_collations(&String::from_utf8_lossy(&line)).as_bytes())?;
        }
        if total - reported >= 4 << 20 {
            reported = total;
            on_bytes(total);
        }
    }
    to.flush()?;
    on_bytes(total);
    Ok(total)
}

/// MariaDB's newer collations have no MySQL name. The closest MySQL 8
/// equivalents keep the sort order a site expects.
pub fn fix_collations(line: &str) -> String {
    if !line.contains("uca1400") && !line.contains("utf8mb4_nopad") {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    for token in split_keep(line) {
        if token.starts_with("utf8mb4_uca1400") {
            out.push_str("utf8mb4_0900_ai_ci");
        } else if token.starts_with("utf8mb3_uca1400") || token.starts_with("utf8_uca1400") {
            out.push_str("utf8mb3_general_ci");
        } else if token.starts_with("uca1400") {
            out.push_str("utf8mb4_0900_ai_ci");
        } else if token.starts_with("utf8mb4_nopad") {
            out.push_str("utf8mb4_bin");
        } else {
            out.push_str(token);
        }
    }
    out
}

/// Split into identifier-like tokens and everything between, keeping both.
fn split_keep(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_word = false;
    for (i, c) in s.char_indices() {
        let w = c.is_ascii_alphanumeric() || c == '_';
        if w != in_word {
            if i > start {
                out.push(&s[start..i]);
            }
            start = i;
            in_word = w;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// Import a dump file -- `.sql` or `.sql.gz` -- into a Nexora database.
pub fn load_dump_file(series: &str, file: &Path, target: &str, on_bytes: OnBytes) -> Result<u64> {
    let f = std::fs::File::open(file).map_err(|e| Error::Io { path: file.to_path_buf(), source: e })?;
    let reader: Box<dyn Read> = if file.extension().is_some_and(|e| e == "gz") {
        Box::new(flate2::read::GzDecoder::new(f))
    } else {
        Box::new(f)
    };
    let err = paths::downloads_cache().join(format!("import-file-{}.err", std::process::id()));
    paths::mkdir_p(&paths::downloads_cache())?;
    let mut load = Command::new(crate::database::mysql_client(series)?)
        .args(["--protocol=TCP", "-h", "127.0.0.1", "-P", &ports::MYSQL.to_string(), "-u", "root", "--default-character-set=utf8mb4", target])
        .env_remove("MYSQL_PWD")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(std::fs::File::create(&err).map_err(|e| Error::Io { path: err.clone(), source: e })?))
        .spawn()
        .map_err(|e| Error::Io { path: "mysql".into(), source: e })?;
    let copied = pump(reader, load.stdin.take().unwrap(), on_bytes);
    let status = load.wait();
    let msg = std::fs::read_to_string(&err).unwrap_or_default();
    let _ = std::fs::remove_file(&err);
    if !status.map(|s| s.success()).unwrap_or(false) {
        return Err(Error::other(format!("The dump could not be imported: {}", first_line(msg.trim()))));
    }
    copied.map_err(|e| Error::other(format!("Reading {} failed: {e}", file.display())))
}

/// The site's own config, pointed at Nexora's database. Only the COPY is ever
/// passed here; the original stays as its tool wrote it.
pub fn point_config_at(dir: &Path, creds: &crate::database::DbCredentials) -> Result<Option<PathBuf>> {
    let host = format!("{}:{}", creds.host, creds.port);
    let wp = dir.join("wp-config.php");
    if wp.is_file() {
        let text = std::fs::read_to_string(&wp).map_err(|e| Error::Io { path: wp.clone(), source: e })?;
        let esc = |v: &str| v.replace('\\', "\\\\").replace('\'', "\\'");
        let values = [
            ("DB_NAME", esc(&creds.name)),
            ("DB_USER", esc(&creds.user)),
            ("DB_PASSWORD", esc(&creds.password)),
            ("DB_HOST", esc(&host)),
        ];
        let mut done = [false; 4];
        let mut out: Vec<String> = Vec::new();
        for line in text.lines() {
            let mut replaced = None;
            if line.trim_start().starts_with("define") {
                for (i, (key, value)) in values.iter().enumerate() {
                    if !done[i] && (line.contains(&format!("'{key}'")) || line.contains(&format!("\"{key}\""))) {
                        let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                        replaced = Some(format!("{indent}define( '{key}', '{value}' );"));
                        done[i] = true;
                        break;
                    }
                }
            }
            out.push(replaced.unwrap_or_else(|| line.to_string()));
        }
        let trailing = if text.ends_with('\n') { "\n" } else { "" };
        write_atomic(&wp, &(out.join("\n") + trailing))?;
        return Ok(Some(wp));
    }
    let env = dir.join(".env");
    if env.is_file() {
        let text = std::fs::read_to_string(&env).map_err(|e| Error::Io { path: env.clone(), source: e })?;
        let values = [
            ("DB_CONNECTION", "mysql".to_string()),
            ("DB_HOST", creds.host.clone()),
            ("DB_PORT", creds.port.to_string()),
            ("DB_DATABASE", creds.name.clone()),
            ("DB_USERNAME", creds.user.clone()),
            ("DB_PASSWORD", creds.password.clone()),
        ];
        let mut done = vec![false; values.len()];
        let mut out: Vec<String> = text
            .lines()
            .map(|line| {
                for (i, (key, value)) in values.iter().enumerate() {
                    if line.trim_start().starts_with(&format!("{key}=")) {
                        done[i] = true;
                        return format!("{key}={value}");
                    }
                }
                line.to_string()
            })
            .collect();
        for (i, (key, value)) in values.iter().enumerate() {
            if !done[i] {
                out.push(format!("{key}={value}"));
            }
        }
        write_atomic(&env, &(out.join("\n") + "\n"))?;
        return Ok(Some(env));
    }
    Ok(None)
}

fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let tmp = path.with_extension("nexora-tmp");
    std::fs::write(&tmp, text).map_err(|e| Error::Io { path: tmp.clone(), source: e })?;
    std::fs::rename(&tmp, path).map_err(|e| Error::Io { path: path.to_path_buf(), source: e })
}

// ------------------------------------------------------------ temporary server

/// A tool's own MySQL or MariaDB, started on a clone of its data directory,
/// for reading a database whose server is not running. Nothing it does can
/// reach the original data. Stopped and removed when dropped.
struct TempServer {
    child: std::process::Child,
    dir: PathBuf,
    socket: PathBuf,
}

impl TempServer {
    fn start(server: &Path, data: &Path) -> Result<Self> {
        let dir = paths::downloads_cache().join(format!(
            "import-server-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
        ));
        let copy = dir.join("data");
        clone_folder(data, &copy)?;
        // What belonged to the tool's own server run, not to the data.
        for stale in ["mysqld.pid", "mysql.sock", "mysql.sock.lock", "mysqld.sock", "mysqld.sock.lock"] {
            let _ = std::fs::remove_file(copy.join(stale));
        }
        if let Ok(entries) = std::fs::read_dir(&copy) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().ends_with(".pid") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        // A Unix socket path must be short; the cache folder's is not.
        let socket = PathBuf::from(format!("/tmp/nexora-import-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let base = server.parent().and_then(|b| b.parent()).map(Path::to_path_buf).unwrap_or_default();
        let version = Command::new(server).arg("--version").output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        let mut cmd = Command::new(server);
        cmd.arg("--no-defaults")
            .arg(format!("--basedir={}", base.display()))
            .arg(format!("--datadir={}", copy.display()))
            .arg(format!("--socket={}", socket.display()))
            .arg(format!("--pid-file={}", dir.join("server.pid").display()))
            .arg(format!("--log-error={}", dir.join("server.err").display()))
            .arg("--skip-grant-tables")
            .arg("--skip-networking");
        if !version.contains("MariaDB") {
            cmd.arg("--mysqlx=OFF");
        }
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Io { path: server.to_path_buf(), source: e })?;
        let mut me = TempServer { child, dir, socket };
        for _ in 0..240 {
            if std::os::unix::net::UnixStream::connect(&me.socket).is_ok() {
                return Ok(me);
            }
            if let Ok(Some(_)) = me.child.try_wait() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let log = std::fs::read_to_string(me.dir.join("server.err")).unwrap_or_default();
        let reason = log.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("it did not start").to_string();
        let _ = me.child.kill();
        Err(Error::other(format!("The stopped database could not be opened: {reason}")))
    }
}

impl Drop for TempServer {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        for _ in 0..80 {
            if let Ok(Some(_)) = self.child.try_wait() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wp_config_values_are_read_whatever_the_quoting() {
        let text = "<?php\ndefine( 'DB_NAME', 'local' );\ndefine(\"DB_USER\", \"root\");\ndefine('DB_PASSWORD','it\\'s');\ndefine( 'DB_HOST', 'localhost:/tmp/mysql.sock' );\n";
        assert_eq!(wp_define(text, "DB_NAME").as_deref(), Some("local"));
        assert_eq!(wp_define(text, "DB_USER").as_deref(), Some("root"));
        assert_eq!(wp_define(text, "DB_PASSWORD").as_deref(), Some("it's"));
        let (h, p, s) = split_host(&wp_define(text, "DB_HOST").unwrap());
        assert_eq!((h.as_str(), p, s), ("localhost", 0, Some(PathBuf::from("/tmp/mysql.sock"))));
        assert_eq!(split_host("127.0.0.1:13306"), ("127.0.0.1".into(), 13306, None));
    }

    #[test]
    fn a_laravel_env_names_its_engine() {
        let dir = std::env::temp_dir().join(format!("nexora-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "DB_CONNECTION=pgsql\nDB_DATABASE=app\nDB_USERNAME=me\n").unwrap();
        let db = config_db(&dir, "Herd").unwrap();
        assert_eq!((db.engine.as_str(), db.port, db.supported()), ("pgsql", 5432, false));
        assert!(db.info().note.unwrap().contains("PostgreSQL"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_and_php_versions_are_normalised() {
        assert_eq!(label_of("My_Shop.local"), "my-shop");
        assert_eq!(minor_of("8.2.10").as_deref(), Some("8.2"));
        assert_eq!(minor_of("php@8.1").as_deref(), Some("8.1"));
        assert_eq!(minor_of("latest"), None);
    }

    #[test]
    fn mariadb_collations_become_mysql_ones_and_data_is_untouched() {
        assert_eq!(
            fix_collations(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;"),
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;"
        );
        assert_eq!(fix_collations("  `a` text COLLATE utf8mb4_unicode_520_ci,"), "  `a` text COLLATE utf8mb4_unicode_520_ci,");
        let mut out = Vec::new();
        let dump = "CREATE TABLE t (x text) COLLATE=utf8mb4_uca1400_as_cs;\nINSERT INTO t VALUES ('utf8mb4_uca1400_ai_ci');\n";
        pump(dump.as_bytes(), &mut out, &|_| {}).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("COLLATE=utf8mb4_0900_ai_ci"));
        assert!(out.contains("VALUES ('utf8mb4_uca1400_ai_ci')"), "row data is never rewritten");
    }

    #[test]
    fn the_copy_is_pointed_at_nexora_and_nothing_else_changes() {
        let dir = std::env::temp_dir().join(format!("nexora-point-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("wp-config.php"),
            "<?php\ndefine('DB_NAME', 'local');\n  define( \"DB_USER\", \"root\" );\ndefine('DB_PASSWORD', 'root');\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
        )
        .unwrap();
        let creds = crate::database::DbCredentials {
            name: "shop_test".into(),
            user: "shop_test".into(),
            password: "p'w".into(),
            host: "127.0.0.1".into(),
            port: 13316,
        };
        point_config_at(&dir, &creds).unwrap();
        let text = std::fs::read_to_string(dir.join("wp-config.php")).unwrap();
        assert_eq!(wp_define(&text, "DB_NAME").as_deref(), Some("shop_test"));
        assert_eq!(wp_define(&text, "DB_PASSWORD").as_deref(), Some("p'w"));
        assert_eq!(wp_define(&text, "DB_HOST").as_deref(), Some("127.0.0.1:13316"));
        assert!(text.contains("  define( 'DB_USER', 'shop_test' );"), "indentation is kept");
        assert!(text.contains("$table_prefix = 'wp_';"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_is_cloned_not_moved() {
        let base = std::env::temp_dir().join(format!("nexora-clone-{}", std::process::id()));
        let (from, to) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(from.join("wp-content")).unwrap();
        std::fs::write(from.join("wp-content/x.txt"), "hi").unwrap();
        clone_folder(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(to.join("wp-content/x.txt")).unwrap(), "hi");
        assert!(from.join("wp-content/x.txt").exists(), "the original stays");
        assert!(clone_folder(&from, &to).is_err(), "never over an existing folder");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// `cargo test -p nexora-core live_scan_sources -- --ignored --nocapture`
    #[test]
    #[ignore = "reads this Mac's Herd, LocalWP and rexenv"]
    fn live_scan_sources() {
        let db = Db::open_in_memory().unwrap();
        let s = scan(&db).unwrap();
        println!("tools: {:?}", s.tools);
        for f in &s.sites {
            println!("{} {} <- {} php {:?} wp {} db {:?} importable {} {:?}", f.source, f.domain, f.path, f.php_minor, f.is_wordpress, f.database, f.importable, f.note);
        }
    }

    /// A real database, copied two ways into a Nexora of its own: from
    /// rexenv's running MySQL, and from a clone of rexenv's data directory
    /// through rexenv's own server. rexenv is only read.
    /// `HOME=$(mktemp -d) cargo test -p nexora-core live_copy_from_rexenv -- --ignored --nocapture`
    #[test]
    #[ignore = "installs MySQL into a temporary HOME and reads rexenv's databases"]
    fn live_copy_from_rexenv() {
        let real_home = "/Users/rasel";
        let home = std::env::var("HOME").unwrap();
        assert!(home.contains("/T/") || home.contains("tmp"), "run with a temporary HOME");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(crate::runtime::install_mysql("8.4", |_| {})).unwrap();
        let sup = crate::supervisor::Supervisor::new();
        crate::database::start(&sup, "8.4").unwrap();
        let count = |db: &str| -> String {
            crate::database::sql("8.4", &format!("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='{db}';")).unwrap().trim().to_string()
        };

        let src = SourceDb {
            engine: "mysql".into(),
            name: "wp_wpdev_test".into(),
            user: "root".into(),
            password: String::new(),
            host: "127.0.0.1".into(),
            port: 13306,
            socket: None,
            offline: None,
            label: "rexenv's MySQL".into(),
        };
        let t = std::time::Instant::now();
        let creds = crate::database::create_for_site("8.4", "wpdev.test").unwrap();
        let bytes = copy_database("8.4", &src, &creds.name, &|_| {}).unwrap();
        println!("running server: {} MB, {} tables, {:?}", bytes / 1_048_576, count(&creds.name), t.elapsed());

        // The same database through the stopped-server path.
        let root = PathBuf::from(real_home).join("Library/Application Support/dev.rexenv.rexenv");
        let server = std::fs::read_dir(root.join("bin")).unwrap().flatten().map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("mysql-"))
            .map(|d| d.join("bin/mysqld")).find(|p| p.is_file()).unwrap();
        let offline = SourceDb { port: 1, offline: Some((server, root.join("mysql/data"))), ..src };
        let t = std::time::Instant::now();
        let creds2 = crate::database::create_for_site("8.4", "offline.test").unwrap();
        let bytes = copy_database("8.4", &offline, &creds2.name, &|_| {}).unwrap();
        println!("stopped-server path: {} MB, {} tables, {:?}", bytes / 1_048_576, count(&creds2.name), t.elapsed());
        assert_eq!(count(&creds.name), count(&creds2.name));
        let leftovers: Vec<_> = std::fs::read_dir(paths::downloads_cache()).unwrap().flatten().map(|e| e.file_name()).collect();
        println!("left in the cache: {leftovers:?}");
        let _ = crate::database::stop(&sup, "8.4");
    }

    /// The whole import of a real rexenv site into a Nexora of its own.
    /// `HOME=/tmp/nxh cargo test -p nexora-core live_import_rexenv_site -- --ignored --nocapture`
    #[test]
    #[ignore = "copies a rexenv site and its database into a temporary HOME"]
    fn live_import_rexenv_site() {
        let src_dir = PathBuf::from("/Users/rasel/Mine/wordpress_sites/wpdevplugins.test");
        let before = std::fs::read(src_dir.join("wp-config.php")).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(crate::runtime::install_mysql("8.4", |_| {})).unwrap();
        let sup = crate::supervisor::Supervisor::new();
        crate::database::start(&sup, "8.4").unwrap();
        let db = Db::open().unwrap();

        let req = Request {
            source: "rexenv".into(),
            path: src_dir.to_string_lossy().into(),
            name: "wpdevplugins".into(),
            domain: "wpdevplugins.test".into(),
            php_minor: "8.4".into(),
            include_database: true,
            sql_file: None,
        };
        let src = source_db(&req.source, &src_dir).expect("rexenv database found");
        println!("source: {} {}@{}:{} offline={}", src.name, src.user, src.host, src.port, src.offline.is_some());
        let t = std::time::Instant::now();
        let (site, dest) = copy_site(&db, &req).unwrap();
        println!("files cloned to {} in {:?}; linked={}", dest.display(), t.elapsed(), site.is_linked);
        let creds = crate::database::create_for_site("8.4", &site.domain).unwrap();
        let bytes = copy_database("8.4", &src, &creds.name, &|_| {}).unwrap();
        point_config_at(&dest, &creds).unwrap();
        let tables = crate::database::sql("8.4", &format!("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='{}';", creds.name)).unwrap();
        let home = crate::database::sql("8.4", &format!("SELECT option_value FROM `{}`.wp_options WHERE option_name='home';", creds.name)).unwrap();
        let copy_cfg = std::fs::read_to_string(dest.join("wp-config.php")).unwrap();
        println!("{} KB, {} tables, home={}", bytes / 1024, tables.trim(), home.trim());
        println!("copy DB_HOST={:?} DB_NAME={:?}", wp_define(&copy_cfg, "DB_HOST"), wp_define(&copy_cfg, "DB_NAME"));
        assert_eq!(std::fs::read(src_dir.join("wp-config.php")).unwrap(), before, "the original wp-config.php is untouched");
        assert_eq!(wp_define(&copy_cfg, "DB_NAME").as_deref(), Some(creds.name.as_str()));
        let _ = crate::database::stop(&sup, "8.4");
    }
}
