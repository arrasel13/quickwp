//! MariaDB, installed through Homebrew.
//!
//! MariaDB publishes no macOS builds -- its downloads are Linux, Windows and
//! source -- so it cannot be pinned and verified the way MySQL is. Homebrew
//! builds it, and Nexora runs that build against a data directory and a port
//! of its own, exactly as it runs MySQL: nothing Homebrew's own service would
//! use is touched, and uninstalling the formula later leaves Nexora's data in
//! place.
//!
//! Only long-term-support series are offered, newest first, as MariaDB's own
//! release list names them. Each is a Homebrew formula (`mariadb@11.4`), and a
//! series Homebrew has no formula for yet is listed but cannot be installed.
//! Every series answers on the one MariaDB port, so one runs at a time --
//! beside MySQL, which has its own.

use crate::{paths, ports, supervisor::Supervisor, Error, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::database::EngineStatus;

/// A MariaDB series and the formula that provides it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Series {
    /// How the app names it: "mariadb-11.4".
    pub id: String,
    /// "11.4".
    pub series: String,
    /// What Homebrew calls it: "mariadb@11.4".
    pub formula: String,
    /// When MariaDB stops supporting it: "2029-05-29".
    pub eol: Option<String>,
    /// Whether Homebrew has a formula for it to install.
    pub available: bool,
}

/// How many LTS series are offered.
const OFFERED: usize = 3;

/// MariaDB's long-term releases as of this build, for when its release list
/// cannot be reached. The live list replaces this whenever it can be read.
const KNOWN_LTS: [(&str, &str); 4] = [
    ("12.3", "2029-06-12"),
    ("11.8", "2030-02-13"),
    ("11.4", "2029-05-29"),
    ("10.11", "2028-02-16"),
];

/// Series Homebrew had a formula for as of this build.
const KNOWN_FORMULAS: [&str; 3] = ["11.8", "11.4", "10.11"];

pub fn is_mariadb(series: &str) -> bool {
    series.starts_with("mariadb")
}

/// "11.4" is a series name only if it is digits and dots: it becomes a
/// formula name and a directory name, so nothing else may.
fn valid_series(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 8
        && v.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// The series named by an id ("mariadb-11.4").
pub fn series(id: &str) -> Result<Series> {
    let v = id
        .strip_prefix("mariadb-")
        .filter(|v| valid_series(v))
        .ok_or_else(|| Error::other(format!("unknown MariaDB series `{id}`")))?;
    let known = catalog_cached().into_iter().find(|s| s.series == v);
    Ok(known.unwrap_or_else(|| make(v, None, KNOWN_FORMULAS.contains(&v))))
}

fn make(v: &str, eol: Option<String>, available: bool) -> Series {
    Series {
        id: format!("mariadb-{v}"),
        series: v.to_string(),
        formula: format!("mariadb@{v}"),
        eol,
        available,
    }
}

// ------------------------------------------------------------- the catalog

static CATALOG: Mutex<Option<(Instant, Vec<Series>)>> = Mutex::new(None);

/// The offered series from the last read, or the built-in list.
pub fn catalog_cached() -> Vec<Series> {
    if let Some((_, list)) = CATALOG.lock().unwrap().as_ref() {
        return list.clone();
    }
    fallback()
}

fn fallback() -> Vec<Series> {
    KNOWN_LTS
        .iter()
        .take(OFFERED)
        .map(|(v, eol)| make(v, Some(eol.to_string()), KNOWN_FORMULAS.contains(v)))
        .collect()
}

/// The newest LTS series MariaDB still supports, and whether Homebrew can
/// install each. Read at most once a day; the built-in list when offline.
pub async fn catalog() -> Vec<Series> {
    {
        let held = CATALOG.lock().unwrap();
        if let Some((at, list)) = held.as_ref() {
            if at.elapsed() < Duration::from_secs(24 * 3600) {
                return list.clone();
            }
        }
    }
    let list = match read_catalog().await {
        Some(list) if !list.is_empty() => list,
        _ => return catalog_cached(),
    };
    *CATALOG.lock().unwrap() = Some((Instant::now(), list.clone()));
    list
}

fn http() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Nexora")
        .build()
        .ok()
}

async fn read_catalog() -> Option<Vec<Series>> {
    let client = http()?;
    let body = client
        .get("https://downloads.mariadb.org/rest-api/mariadb/")
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let mut lts = parse_releases(&body, &today());
    lts.truncate(OFFERED);
    // Homebrew's own index says which of them it builds.
    for s in &mut lts {
        s.available = formula_exists(&client, &s.formula).await;
    }
    Some(lts)
}

/// LTS series MariaDB still supports, newest first.
fn parse_releases(body: &str, today: &str) -> Vec<Series> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let mut out: Vec<Series> = root
        .get("major_releases")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter(|r| {
            r.get("release_support_type").and_then(|t| t.as_str()) == Some("Long Term Support")
                && r.get("release_status").and_then(|t| t.as_str()) == Some("Stable")
        })
        .filter_map(|r| {
            let v = r.get("release_id")?.as_str()?;
            let eol = r.get("release_eol_date").and_then(|e| e.as_str()).map(String::from);
            // Past its end of life: not offered for anything new.
            if eol.as_deref().is_some_and(|e| e < today) || !valid_series(v) {
                return None;
            }
            Some(make(v, eol, false))
        })
        .collect();
    out.sort_by(|a, b| version_key(&b.series).cmp(&version_key(&a.series)));
    out
}

async fn formula_exists(client: &reqwest::Client, formula: &str) -> bool {
    let url = format!("https://formulae.brew.sh/api/formula/{formula}.json");
    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            let text = r.text().await.unwrap_or_default();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            // A disabled formula cannot be installed any more.
            !v.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false)
        }
        _ => false,
    }
}

/// What Homebrew currently builds for a formula: "11.4.13".
pub async fn homebrew_version(formula: &str) -> Option<String> {
    let client = http()?;
    let url = format!("https://formulae.brew.sh/api/formula/{formula}.json");
    let text = client.get(&url).send().await.ok()?.text().await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("versions")?.get("stable")?.as_str().map(String::from)
}

pub fn today_utc() -> String {
    today()
}

fn today() -> String {
    // UTC is close enough for a date that is only compared to the day.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    civil_from_days(days)
}

/// Days since 1970-01-01 to "YYYY-MM-DD" (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn version_key(v: &str) -> Vec<u32> {
    v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

// ------------------------------------------------------------- the server

/// Where Homebrew lives: Apple silicon, then Intel.
fn brew_prefix() -> Option<PathBuf> {
    ["/opt/homebrew", "/usr/local"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.join("bin/brew").is_file())
}

pub fn brew() -> Option<PathBuf> {
    brew_prefix().map(|p| p.join("bin/brew"))
}

/// The formula's stable path, which survives `brew upgrade`.
fn opt_dir(s: &Series) -> Option<PathBuf> {
    brew_prefix().map(|p| p.join("opt").join(&s.formula))
}

/// A tool inside the formula. MariaDB puts the server in `bin` on some
/// releases and `sbin` on others.
fn tool(s: &Series, name: &str) -> Option<PathBuf> {
    let dir = opt_dir(s)?;
    ["bin", "sbin"].iter().map(|d| dir.join(d).join(name)).find(|p| p.is_file())
}

fn server(s: &Series) -> Option<PathBuf> {
    tool(s, "mariadbd").or_else(|| tool(s, "mysqld"))
}

fn client(s: &Series) -> Result<PathBuf> {
    tool(s, "mariadb")
        .or_else(|| tool(s, "mysql"))
        .ok_or_else(|| Error::NotInstalled { component: format!("MariaDB ({})", s.formula) })
}

pub fn is_installed(s: &Series) -> bool {
    server(s).is_some()
}

/// Every `mariadb@X.Y` Homebrew has installed, so one that has dropped off the
/// offered list is still shown and can still be stopped.
fn installed_series() -> Vec<String> {
    let Some(opt) = brew_prefix().map(|p| p.join("opt")) else { return Vec::new() };
    std::fs::read_dir(opt)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_prefix("mariadb@").map(String::from))
        .filter(|v| valid_series(v))
        .collect()
}

pub fn data_dir(s: &Series) -> PathBuf {
    paths::root().join("databases").join(&s.id)
}

fn socket(s: &Series) -> PathBuf {
    data_dir(s).join("mariadb.sock")
}

pub fn service_name(s: &Series) -> String {
    s.id.clone()
}

/// "11.4.13", from the server itself.
pub fn installed_version(s: &Series) -> Option<String> {
    let out = Command::new(server(s)?).arg("--version").output().ok()?;
    version_in(&String::from_utf8_lossy(&out.stdout))
}

/// `mariadbd  Ver 11.4.13-MariaDB for osx10.20 on arm64` -> "11.4.13".
fn version_in(text: &str) -> Option<String> {
    let after = text.split("Ver ").nth(1)?;
    let v: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    (!v.is_empty()).then_some(v)
}

/// A row for the Database section, with what makes it differ from MySQL's.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MariadbStatus {
    #[serde(flatten)]
    pub engine: EngineStatus,
    pub eol: Option<String>,
    /// Homebrew can install it.
    pub available: bool,
}

pub fn status(sup: &Supervisor, s: &Series) -> MariadbStatus {
    let installed = is_installed(s);
    MariadbStatus {
        engine: EngineStatus {
            engine: "mariadb".into(),
            series: s.id.clone(),
            version: installed_version(s).unwrap_or_else(|| s.series.clone()),
            running: sup.is_running(&service_name(s)) || (installed && adopt_if_ours(s)),
            installed,
            port: ports::MARIADB,
            data_dir: data_dir(s).to_string_lossy().into(),
        },
        eol: s.eol.clone(),
        available: s.available || installed,
    }
}

/// The offered series, plus any installed one that is not among them.
pub fn list(sup: &Supervisor, offered: &[Series]) -> Vec<MariadbStatus> {
    let mut all: Vec<Series> = offered.to_vec();
    for v in installed_series() {
        if !all.iter().any(|s| s.series == v) {
            all.push(make(&v, None, true));
        }
    }
    all.iter().map(|s| status(sup, s)).collect()
}

/// Homebrew, told to do only what was asked: no auto-update, no clean-up of
/// other formulae, no checking what else depends on what.
fn brew_cmd(args: &[&str]) -> Result<Command> {
    let brew = brew().ok_or_else(|| {
        Error::other(
            "MariaDB comes from Homebrew, which is not installed. Install it from https://brew.sh, \
             then try again.",
        )
    })?;
    let mut c = Command::new(brew);
    c.args(args)
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
        .env("HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK", "1")
        .env("HOMEBREW_NO_ANALYTICS", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1");
    Ok(c)
}

fn run_brew(args: &[&str], what: &str) -> Result<()> {
    let out = brew_cmd(args)?
        .output()
        .map_err(|e| Error::Io { path: PathBuf::from("brew"), source: e })?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "{what} failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// `brew install`: a prebuilt bottle, so this is a download rather than a
/// build -- MariaDB and the few libraries it links against.
pub fn install(s: &Series) -> Result<String> {
    if !s.available {
        return Err(Error::other(format!(
            "Homebrew has no {} formula yet, so MariaDB {} cannot be installed here. It will \
             appear once Homebrew publishes it.",
            s.formula, s.series
        )));
    }
    run_brew(&["install", &s.formula], &format!("brew install {}", s.formula))?;
    let version = installed_version(s).unwrap_or_default();
    crate::log::info("mariadb", &format!("installed {} {version} with Homebrew", s.formula));
    Ok(format!("MariaDB {version} installed with Homebrew."))
}

/// Move a series to Homebrew's current release of it, restarting it if it
/// was running. The data directory is kept: a patch release reads it as is.
pub fn upgrade(sup: &Supervisor, s: &Series) -> Result<String> {
    let was_running = status(sup, s).engine.running;
    let before = installed_version(s).unwrap_or_default();
    if was_running {
        stop(sup, s)?;
    }
    // The local formula list has to know the new release before it can
    // install it: the one step that does reach beyond this formula.
    let _ = brew_cmd(&["update"]).and_then(|mut c| {
        c.env_remove("HOMEBREW_NO_AUTO_UPDATE");
        c.output().map_err(|e| Error::Io { path: PathBuf::from("brew"), source: e })
    });
    let result = run_brew(&["upgrade", &s.formula], &format!("brew upgrade {}", s.formula));
    if was_running {
        start(sup, s)?;
    }
    result?;
    let after = installed_version(s).unwrap_or_default();
    crate::log::info("mariadb", &format!("upgraded {} {before} -> {after}", s.formula));
    Ok(format!("MariaDB updated from {before} to {after}."))
}

/// A data directory of Nexora's own, made once.
///
/// Root gets a normal, passwordless login rather than MariaDB's default of
/// matching the Mac user: Nexora connects as root, as it does to MySQL, and
/// the server only listens on loopback.
fn initialize(s: &Series) -> Result<()> {
    let dir = data_dir(s);
    if dir.join("mysql").is_dir() {
        return Ok(());
    }
    paths::mkdir_p(&dir)?;
    let install_db = tool(s, "mariadb-install-db")
        .or_else(|| tool(s, "mysql_install_db"))
        .ok_or_else(|| Error::NotInstalled { component: format!("MariaDB ({})", s.formula) })?;
    let base = opt_dir(s).unwrap_or_default();
    let out = Command::new(&install_db)
        .arg(format!("--datadir={}", dir.display()))
        .arg(format!("--basedir={}", base.display()))
        .arg("--auth-root-authentication-method=normal")
        .arg("--skip-test-db")
        .output()
        .map_err(|e| Error::Io { path: install_db.clone(), source: e })?;
    if !out.status.success() || !dir.join("mysql").is_dir() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(Error::other(format!(
            "MariaDB could not create its data directory:\n{}{}",
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Is a MariaDB on our port serving our data directory?
fn adopt_if_ours(s: &Series) -> bool {
    if std::net::TcpStream::connect(("127.0.0.1", ports::MARIADB)).is_err() {
        return false;
    }
    match sql(s, "SELECT @@datadir;") {
        Ok(out) => {
            let reported = out.trim().trim_end_matches('/').to_string();
            let ours = data_dir(s);
            reported == ours.to_string_lossy().trim_end_matches('/') && ours.join("mysql").is_dir()
        }
        Err(_) => false,
    }
}

/// Start a series -- installing it first when it is not here yet, so Start is
/// the one button there is to press. Idempotent, and waits until it accepts.
pub fn start(sup: &Supervisor, s: &Series) -> Result<u16> {
    let name = service_name(s);
    if is_installed(s) && (sup.is_running(&name) || adopt_if_ours(s)) {
        return Ok(ports::MARIADB);
    }
    if !is_installed(s) {
        install(s)?;
    }
    // The port is shared by every series: whichever else is running goes.
    for v in installed_series() {
        if v != s.series {
            let _ = stop(sup, &make(&v, None, true));
        }
    }
    if std::net::TcpStream::connect(("127.0.0.1", ports::MARIADB)).is_ok() {
        return Err(Error::other(format!(
            "Something else is using port {} already, so MariaDB cannot start there.",
            ports::MARIADB
        )));
    }
    let server = server(s)
        .ok_or_else(|| Error::NotInstalled { component: format!("MariaDB ({})", s.formula) })?;
    initialize(s)?;

    let dir = data_dir(s);
    crate::log::info("mariadb", &format!("starting {} on port {}", s.formula, ports::MARIADB));
    sup.start(
        &name,
        &server,
        &[
            // No my.cnf from Homebrew or anywhere else: this server is Nexora's.
            "--no-defaults".into(),
            format!("--datadir={}", dir.display()),
            format!("--basedir={}", opt_dir(s).unwrap_or_default().display()),
            format!("--port={}", ports::MARIADB),
            format!("--socket={}", socket(s).display()),
            "--bind-address=127.0.0.1".into(),
            format!("--log-error={}", paths::logs().join(format!("{}.log", s.id)).display()),
        ],
        Some(ports::MARIADB),
        Some(paths::logs().join(format!("{}.out.log", s.id))),
    )?;

    for _ in 0..150 {
        if std::net::TcpStream::connect(("127.0.0.1", ports::MARIADB)).is_ok() {
            // Root over TCP as well as the socket, so Adminer and sites can
            // reach it the way they reach MySQL.
            let _ = sql_socket(
                s,
                "CREATE USER IF NOT EXISTS 'root'@'127.0.0.1'; \
                 GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION; \
                 FLUSH PRIVILEGES;",
            );
            return Ok(ports::MARIADB);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = sup.stop(&name);
    Err(Error::other(format!(
        "MariaDB started but never accepted a connection on port {}. See logs/{}.log",
        ports::MARIADB,
        s.id
    )))
}

pub fn stop(sup: &Supervisor, s: &Series) -> Result<bool> {
    if sup.stop(&service_name(s))? {
        return Ok(true);
    }
    if is_installed(s) && adopt_if_ours(s) {
        let _ = sql_socket(s, "SHUTDOWN;");
        return Ok(true);
    }
    Ok(false)
}

/// SQL as root over TCP.
fn sql(s: &Series, statement: &str) -> Result<String> {
    run_client(
        s,
        &["--protocol=TCP", "-h", "127.0.0.1", "-P", &ports::MARIADB.to_string()],
        statement,
    )
}

/// SQL as root over the socket: works before root has a TCP login.
fn sql_socket(s: &Series, statement: &str) -> Result<String> {
    let sock = socket(s);
    run_client(s, &["--protocol=SOCKET", &format!("--socket={}", sock.display())], statement)
}

fn run_client(s: &Series, how: &[&str], statement: &str) -> Result<String> {
    let out = Command::new(client(s)?)
        .arg("--no-defaults")
        .args(how)
        .args(["-u", "root", "--batch", "--skip-column-names", "-e", statement])
        .output()
        .map_err(|e| Error::Io { path: Path::new("mariadb").to_path_buf(), source: e })?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "MariaDB rejected a statement: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_is_read_from_the_server_s_banner() {
        assert_eq!(
            version_in("mariadbd  Ver 11.4.13-MariaDB for osx10.20 on arm64 (Homebrew)").as_deref(),
            Some("11.4.13")
        );
        assert_eq!(version_in("mysqld  Ver 13.0.2-MariaDB-log").as_deref(), Some("13.0.2"));
        assert_eq!(version_in("nothing useful"), None);
    }

    #[test]
    fn ids_become_formulas_and_nothing_else_does() {
        assert!(is_mariadb("mariadb-11.4"));
        assert!(!is_mariadb("8.4"));
        assert_eq!(series("mariadb-11.4").unwrap().formula, "mariadb@11.4");
        assert_eq!(series("mariadb-12.3").unwrap().formula, "mariadb@12.3");
        // A name that would reach Homebrew or the filesystem as anything else.
        assert!(series("mariadb-11.4; rm -rf").is_err());
        assert!(series("mariadb-../x").is_err());
        assert!(series("mariadb-").is_err());
    }

    #[test]
    fn only_supported_lts_series_are_offered_newest_first() {
        let body = r#"{"major_releases":[
            {"release_id":"13.1","release_status":"RC","release_support_type":"Rolling","release_eol_date":null},
            {"release_id":"13.0","release_status":"Stable","release_support_type":"Rolling","release_eol_date":null},
            {"release_id":"12.3","release_status":"Stable","release_support_type":"Long Term Support","release_eol_date":"2029-06-12"},
            {"release_id":"11.4","release_status":"Stable","release_support_type":"Long Term Support","release_eol_date":"2029-05-29"},
            {"release_id":"11.8","release_status":"Stable","release_support_type":"Long Term Support","release_eol_date":"2030-02-13"},
            {"release_id":"10.6","release_status":"Stable","release_support_type":"Long Term Support","release_eol_date":"2026-07-06"}
        ]}"#;
        let got: Vec<String> =
            parse_releases(body, "2026-09-21").into_iter().map(|s| s.series).collect();
        // 13.x is rolling, not LTS; 10.6 ended in July.
        assert_eq!(got, vec!["12.3", "11.8", "11.4"]);
    }

    #[test]
    fn days_become_dates() {
        assert_eq!(civil_from_days(0), "1970-01-01");
        assert_eq!(civil_from_days(20_717), "2026-09-21");
    }

    #[test]
    fn each_series_keeps_its_own_data_directory() {
        let a = data_dir(&make("11.8", None, true));
        let b = data_dir(&make("11.4", None, true));
        assert_ne!(a, b);
        assert!(a.ends_with("mariadb-11.8") && b.ends_with("mariadb-11.4"));
    }

    /// Against the real release list and Homebrew:
    /// `cargo test -p nexora-core live_mariadb_catalog -- --ignored --nocapture`.
    #[test]
    #[ignore = "asks mariadb.org and Homebrew"]
    fn live_mariadb_catalog_reads_the_lts_series() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let list = rt.block_on(catalog());
        for s in &list {
            println!("{} ({}) eol {:?} — Homebrew: {}", s.series, s.formula, s.eol, s.available);
        }
        assert!(!list.is_empty());
        println!("mariadb@11.4 on Homebrew: {:?}", rt.block_on(homebrew_version("mariadb@11.4")));
    }

    /// The whole path against a real MariaDB, as the buttons drive it:
    /// `NEXORA_LIVE_MARIADB=mariadb-11.4 cargo test -p nexora-core
    /// live_mariadb_installs -- --ignored --nocapture`.
    #[test]
    #[ignore = "installs MariaDB with Homebrew and runs it"]
    fn live_mariadb_installs_starts_answers_and_stops() {
        let id = std::env::var("NEXORA_LIVE_MARIADB").unwrap_or_else(|_| "mariadb-11.4".into());
        let s = series(&id).unwrap();
        println!("version before: {:?}", installed_version(&s));

        // Start installs when it has to: the one button.
        let sup = Supervisor::new();
        let port = start(&sup, &s).expect("start");
        assert_eq!(port, ports::MARIADB);
        let st = status(&sup, &s);
        println!("status: running={} installed={} version={}", st.engine.running, st.engine.installed, st.engine.version);
        assert!(st.engine.running && st.engine.installed);

        let who = sql(&s, "SELECT VERSION(), CURRENT_USER(), @@port;").expect("TCP login as root");
        println!("over TCP: {}", who.trim());
        assert!(who.contains("MariaDB") && who.contains(&ports::MARIADB.to_string()));

        assert!(stop(&sup, &s).expect("stop"));
        std::thread::sleep(Duration::from_millis(1500));
        assert!(std::net::TcpStream::connect(("127.0.0.1", ports::MARIADB)).is_err(), "the port is free again");
        println!("stopped cleanly");
    }
}
