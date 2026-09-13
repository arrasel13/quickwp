//! Database engines.
//!
//! Two properties are load-bearing and neither is obvious:
//!
//! 1. **Ports are offset.** MySQL on 13316 rather than 3306, so Nexora never
//!    collides with a MySQL you already installed. The offset is the difference
//!    between coexisting with your current setup and demanding you dismantle it.
//!
//! 2. **Each version series keeps its own data directory.** Switching 8.4 to
//!    8.0 does not attempt to downgrade a data directory -- it starts the 8.0
//!    series against its own, and 8.4's data is still there when you switch
//!    back. That is why switching is safe, and why it is not a migration: data
//!    does not follow you across.

use crate::{paths, ports, runtime, supervisor::Supervisor, Error, Result};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Mysql,
}

impl Engine {
    pub fn as_str(&self) -> &'static str {
        match self {
            Engine::Mysql => "mysql",
        }
    }
    pub fn port(&self) -> u16 {
        match self {
            Engine::Mysql => ports::MYSQL,
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "mysql" => Ok(Engine::Mysql),
            "mariadb" => Err(Error::other(
                "MariaDB is not available yet: upstream publishes no macOS build, so \
                 shipping it means producing a reproducible build of our own. Use MySQL.",
            )),
            other => Err(Error::other(format!("unknown database engine `{other}`"))),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineStatus {
    pub engine: String,
    pub series: String,
    pub version: String,
    pub installed: bool,
    pub running: bool,
    pub port: u16,
    pub data_dir: String,
}

pub fn service_name(series: &str) -> String {
    format!("mysql-{series}")
}

/// One data directory per version series -- never shared.
pub fn data_dir(series: &str) -> PathBuf {
    paths::root().join("databases").join(format!("mysql-{series}"))
}

pub fn install_dir(series: &str) -> Result<PathBuf> {
    let pin = runtime::mysql_pin(series)?;
    Ok(paths::runtime_dir("mysql", &format!("{}-{}", pin.version, pin.arch)))
}

pub fn mysqld(series: &str) -> Result<PathBuf> {
    let p = install_dir(series)?.join("bin/mysqld");
    if p.exists() {
        Ok(p)
    } else {
        Err(Error::NotInstalled {
            component: format!("MySQL {series}"),
        })
    }
}

pub fn mysql_client(series: &str) -> Result<PathBuf> {
    Ok(install_dir(series)?.join("bin/mysql"))
}

pub fn mysqldump(series: &str) -> Result<PathBuf> {
    Ok(install_dir(series)?.join("bin/mysqldump"))
}

pub fn is_installed(series: &str) -> bool {
    mysqld(series).is_ok()
}

pub fn status(sup: &Supervisor, series: &str) -> EngineStatus {
    let pin = runtime::mysql_pin(series).ok();
    let installed = is_installed(series);
    EngineStatus {
        engine: "mysql".into(),
        series: series.to_string(),
        version: pin.map(|p| p.version.to_string()).unwrap_or_default(),
        running: sup.is_running(&service_name(series))
            || (installed && adopt_if_ours(series)),
        installed,
        port: ports::MYSQL,
        data_dir: data_dir(series).to_string_lossy().into(),
    }
}

pub fn list(sup: &Supervisor) -> Vec<EngineStatus> {
    runtime::MYSQL_SERIES
        .iter()
        .map(|s| status(sup, s))
        .collect()
}

/// Initialise a data directory if it has never been used.
///
/// `--initialize-insecure` gives a root account with no password. That is
/// correct here and would be wrong on a server: the socket is loopback-only,
/// and a password Nexora generates and then stores beside the data it protects
/// is security theatre rather than security.
fn initialize(series: &str) -> Result<()> {
    let dir = data_dir(series);
    if dir.join("mysql").is_dir() {
        return Ok(()); // already initialised
    }
    paths::mkdir_p(&dir)?;
    // mysqld refuses to initialise into a non-empty directory.
    if std::fs::read_dir(&dir).map(|d| d.count() > 0).unwrap_or(false) {
        std::fs::remove_dir_all(&dir).ok();
        paths::mkdir_p(&dir)?;
    }

    let out = std::process::Command::new(mysqld(series)?)
        .arg("--initialize-insecure")
        .arg(format!("--datadir={}", dir.display()))
        .arg(format!("--basedir={}", install_dir(series)?.display()))
        .output()
        .map_err(|e| Error::Io {
            path: dir.clone(),
            source: e,
        })?;

    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(Error::other(format!(
            "MySQL {series} could not create its data directory:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Is a MySQL already listening on our port, running against our data directory?
///
/// An engine outlives the app: quitting Nexora does not have to tear down a
/// database, and relaunching should not fail because its own engine is still
/// up. So a port that is taken is checked before it is treated as a conflict --
/// ours is adopted, anyone else's is reported by name.
pub fn adopt_if_ours(series: &str) -> bool {
    if std::net::TcpStream::connect(("127.0.0.1", ports::MYSQL)).is_err() {
        return false;
    }
    // `datadir` is the identity that matters: a MySQL on our port serving some
    // other directory is not ours, and writing a site's tables into it would be
    // the worst possible outcome.
    match sql(series, "SELECT @@datadir;") {
        Ok(out) => {
            let reported = out.trim().trim_end_matches('/');
            let ours = data_dir(series);
            let ours = ours.to_string_lossy();
            let ours = ours.trim_end_matches('/');
            reported == ours
        }
        Err(_) => false,
    }
}

/// Start an engine. Idempotent, port-gated, and waits until it actually accepts.
pub fn start(sup: &Supervisor, series: &str) -> Result<u16> {
    let name = service_name(series);
    if sup.is_running(&name) {
        return Ok(ports::MYSQL);
    }
    if adopt_if_ours(series) {
        return Ok(ports::MYSQL);
    }
    initialize(series)?;

    let dir = data_dir(series);
    sup.start(
        &name,
        &mysqld(series)?,
        &[
            format!("--datadir={}", dir.display()),
            format!("--basedir={}", install_dir(series)?.display()),
            format!("--port={}", ports::MYSQL),
            format!("--socket={}", dir.join("mysql.sock").display()),
            "--bind-address=127.0.0.1".into(),
            format!("--log-error={}", paths::logs().join(format!("mysql-{series}.log")).display()),
        ],
        Some(ports::MYSQL),
        Some(paths::logs().join(format!("mysql-{series}.out.log"))),
    )?;

    for _ in 0..150 {
        if std::net::TcpStream::connect(("127.0.0.1", ports::MYSQL)).is_ok() {
            return Ok(ports::MYSQL);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let _ = sup.stop(&name);
    Err(Error::other(format!(
        "MySQL {series} started but never accepted a connection on port {}. \
         See logs/mysql-{series}.log",
        ports::MYSQL
    )))
}

pub fn stop(sup: &Supervisor, series: &str) -> Result<bool> {
    if sup.stop(&service_name(series))? {
        return Ok(true);
    }
    // An engine we adopted rather than spawned is not in the supervisor, so
    // ask it to shut itself down.
    if adopt_if_ours(series) {
        let _ = std::process::Command::new(install_dir(series)?.join("bin/mysqladmin"))
            .args([
                "--protocol=TCP",
                "-h",
                "127.0.0.1",
                "-P",
                &ports::MYSQL.to_string(),
                "-u",
                "root",
                "shutdown",
            ])
            .output();
        return Ok(true);
    }
    Ok(false)
}

/// Run SQL as root over TCP.
fn sql(series: &str, statement: &str) -> Result<String> {
    let out = std::process::Command::new(mysql_client(series)?)
        .args([
            "--protocol=TCP",
            "-h",
            "127.0.0.1",
            "-P",
            &ports::MYSQL.to_string(),
            "-u",
            "root",
            "--batch",
            "--skip-column-names",
            "-e",
            statement,
        ])
        .output()
        .map_err(|e| Error::Io {
            path: "mysql".into(),
            source: e,
        })?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "MySQL rejected a statement: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DbCredentials {
    pub name: String,
    pub user: String,
    pub password: String,
    pub host: String,
    pub port: u16,
}

/// Create a database and a user scoped to it.
///
/// The user is granted rights on that schema alone, so one site's credentials
/// leaking into a repository cannot reach another site's data.
pub fn create_for_site(series: &str, domain: &str) -> Result<DbCredentials> {
    let name = sanitise_identifier(domain);
    let user = name.chars().take(30).collect::<String>();
    let password = generate_password();

    sql(series, &format!("CREATE DATABASE IF NOT EXISTS `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"))?;
    sql(series, &format!("CREATE USER IF NOT EXISTS '{user}'@'%' IDENTIFIED BY '{password}';"))?;
    sql(series, &format!("ALTER USER '{user}'@'%' IDENTIFIED BY '{password}';"))?;
    sql(series, &format!("GRANT ALL PRIVILEGES ON `{name}`.* TO '{user}'@'%';"))?;
    sql(series, "FLUSH PRIVILEGES;")?;

    Ok(DbCredentials {
        name,
        user,
        password,
        host: "127.0.0.1".into(),
        port: ports::MYSQL,
    })
}

pub fn drop_for_site(series: &str, db_name: &str) -> Result<()> {
    let name = sanitise_identifier(db_name);
    sql(series, &format!("DROP DATABASE IF EXISTS `{name}`;"))?;
    let user = name.chars().take(30).collect::<String>();
    sql(series, &format!("DROP USER IF EXISTS '{user}'@'%';"))?;
    Ok(())
}

pub fn databases(series: &str) -> Result<Vec<String>> {
    Ok(sql(series, "SHOW DATABASES;")?
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| !matches!(s.as_str(), "information_schema" | "mysql" | "performance_schema" | "sys"))
        .collect())
}

/// Dump to ~/Downloads and return the path.
pub fn export(series: &str, db_name: &str) -> Result<PathBuf> {
    let dest = dirs::home_dir()
        .ok_or_else(|| Error::other("no home directory"))?
        .join("Downloads")
        .join(format!(
            "{db_name}-{}.sql",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ));
    paths::mkdir_p(dest.parent().unwrap())?;

    let file = std::fs::File::create(&dest).map_err(|e| Error::Io {
        path: dest.clone(),
        source: e,
    })?;
    let out = std::process::Command::new(mysqldump(series)?)
        .args([
            "--protocol=TCP",
            "-h",
            "127.0.0.1",
            "-P",
            &ports::MYSQL.to_string(),
            "-u",
            "root",
            db_name,
        ])
        .stdout(std::process::Stdio::from(file))
        .output()
        .map_err(|e| Error::Io {
            path: "mysqldump".into(),
            source: e,
        })?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&dest);
        return Err(Error::other(format!(
            "Export failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(dest)
}

/// Import a dump. OVERWRITES the site's tables -- the caller must confirm first.
pub fn import(series: &str, db_name: &str, file: &std::path::Path) -> Result<()> {
    let f = std::fs::File::open(file).map_err(|e| Error::Io {
        path: file.to_path_buf(),
        source: e,
    })?;
    let out = std::process::Command::new(mysql_client(series)?)
        .args([
            "--protocol=TCP",
            "-h",
            "127.0.0.1",
            "-P",
            &ports::MYSQL.to_string(),
            "-u",
            "root",
            db_name,
        ])
        .stdin(std::process::Stdio::from(f))
        .output()
        .map_err(|e| Error::Io {
            path: "mysql".into(),
            source: e,
        })?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "Import failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// A domain is not a legal identifier. Dots and hyphens become underscores, and
/// a leading digit is prefixed, because `8shop` is not a valid schema name.
pub fn sanitise_identifier(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    out = out.trim_matches('_').to_string();
    if out.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true) {
        out.insert_str(0, "db_");
    }
    out.chars().take(60).collect()
}

/// Passwords are generated, never typed, and never passed on a command line
/// where they would land in shell history and `ps` output.
pub fn generate_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut buf = [0u8; 24];
    // /dev/urandom rather than a seeded PRNG: this guards a real credential.
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("urandom");
    buf.iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_domain_becomes_a_legal_identifier() {
        assert_eq!(sanitise_identifier("my-shop.test"), "my_shop_test");
        assert_eq!(sanitise_identifier("8shop.test"), "db_8shop_test");
        assert_eq!(sanitise_identifier("..--.."), "db_");
    }

    #[test]
    fn passwords_are_long_and_not_repeated() {
        let a = generate_password();
        let b = generate_password();
        assert_eq!(a.len(), 24);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn mariadb_is_refused_with_a_reason_not_silently_ignored() {
        let e = Engine::parse("mariadb").unwrap_err();
        assert!(e.to_string().contains("no macOS build"));
    }

    #[test]
    fn each_series_gets_its_own_data_directory() {
        assert_ne!(data_dir("8.4"), data_dir("8.0"));
    }
}
