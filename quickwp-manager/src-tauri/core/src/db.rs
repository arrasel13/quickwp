//! App state.
//!
//! The important property: a site's enabled flag lives here, not in memory.
//! Services outlive the app, so a site you stopped on Tuesday must still be
//! stopped after a relaunch.

use crate::Result;
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};

/// The PHP a new install defaults to.
pub const DEFAULT_PHP: &str = "8.4";

/// How every connection to Nexora's database is set up -- the app's, the
/// DNS agent's, the background server's and the tunnel guard's.
///
/// A rollback journal, not WAL. In WAL mode each connection memory-maps the
/// `-shm` index, and when another process shrinks or recreates that file the
/// app is killed outright with SIGBUS -- which is how a first-run setup ended
/// in a crash report instead of its success page. This database is a few
/// dozen rows written a few times a minute at most; WAL's concurrency buys
/// nothing here, and the rollback journal has no mapped file to lose.
///
/// Switching needs the database to itself, so while another process still
/// has it open in WAL the switch simply waits for a later open. A busy
/// timeout makes processes wait for each other's writes instead of failing.
pub(crate) fn configure(conn: &Connection) {
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let _ = conn.pragma_update(None, "journal_mode", "DELETE");
}

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open() -> Result<Self> {
        crate::paths::ensure_dirs()?;
        Self::open_or_replace(&crate::paths::db_file())
    }

    /// Open this file, and replace it if SQLite cannot read it.
    pub(crate) fn open_or_replace(file: &std::path::Path) -> Result<Self> {
        match Self::open_file(file) {
            Ok(db) => Ok(db),
            // A file SQLite cannot read is not something to hand the window as
            // "database disk image is malformed": that leaves an app that will
            // not open and, because uninstalling leaves this folder behind, a
            // fresh install that meets the same broken file. The damaged one is
            // kept beside the new one, so nothing is destroyed and it can still
            // be looked at.
            Err(e) if is_corrupt(&e) => {
                let _ = Self::replace_damaged(file, &e)?;
                Self::open_file(file)
            }
            Err(e) => Err(e),
        }
    }

    /// One connection, set up the way every Nexora process sets one up.
    fn connect(file: &std::path::Path) -> Result<Connection> {
        let conn = Connection::open(file)?;
        configure(&conn);
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    fn open_file(file: &std::path::Path) -> Result<Self> {
        let conn = Self::connect(file)?;
        // Reading a page is what finds a damaged file: opening one only reads
        // its header, so a broken page would surface later, on a screen.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
        let db = Db(Arc::new(Mutex::new(conn)));
        db.migrate()?;
        Ok(db)
    }

    /// Move a file SQLite cannot read out of the way and answer with a
    /// connection to the empty one that replaces it. The damaged file is kept:
    /// it is the only copy of whatever was in it.
    fn replace_damaged(file: &std::path::Path, why: &crate::Error) -> Result<Connection> {
        let aside = file.with_extension(format!(
            "sqlite3.damaged-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        ));
        crate::log::warn(
            "db",
            &format!("{} is damaged ({why}); kept as {}", file.display(), aside.display()),
        );
        std::fs::rename(file, &aside).map_err(|e| crate::Error::Io {
            path: file.to_path_buf(),
            source: e,
        })?;
        // Whatever the journal held belonged to the file just moved.
        let _ = std::fs::remove_file(file.with_extension("sqlite3-journal"));
        let _ = std::fs::remove_file(file.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(file.with_extension("sqlite3-shm"));
        Self::connect(file)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db(Arc::new(Mutex::new(conn)));
        db.migrate()?;
        Ok(db)
    }

    /// Run one piece of work against the database.
    ///
    /// A connection can report a damaged file while the file on disk is
    /// perfectly readable -- seen in the wild during a first run, where it
    /// left Nexora saying "could not read your sites" until it was restarted.
    /// Rather than pass that on, the file itself is checked: when it is sound
    /// the connection is thrown away, opened again and the work retried, and
    /// when it is not the damaged file is kept aside and a new one takes its
    /// place. Either way it is written to the log, because a connection that
    /// goes bad for no visible reason is worth knowing about.
    pub fn with<T>(&self, f: impl Fn(&Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.0.lock().map_err(|_| crate::Error::other("db lock poisoned"))?;
        match f(&guard) {
            Err(e) if is_corrupt(&e) => {
                let file = crate::paths::db_file();
                let verdict = integrity_of(&file);
                crate::log::warn(
                    "db",
                    &format!("a read reported \"{e}\"; the file itself says: {verdict}"),
                );
                if verdict == "ok" {
                    *guard = Self::connect(&file)?;
                } else {
                    *guard = Self::replace_damaged(&file, &e)?;
                    // The new file is empty: it needs its tables before use.
                    let fresh = Db(Arc::new(Mutex::new(Self::connect(&file)?)));
                    fresh.migrate()?;
                }
                f(&guard)
            }
            other => other,
        }
    }

    fn migrate(&self) -> Result<()> {
        self.with(|c| {
            c.execute_batch(
                r#"
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sites (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  domain        TEXT NOT NULL UNIQUE,
  docroot       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'wordpress',
  php_minor     TEXT NOT NULL,
  server        TEXT NOT NULL DEFAULT 'nginx',
  db_engine     TEXT,
  db_name       TEXT,
  -- Serving state, deliberately persisted: services outlive the app.
  enabled       INTEGER NOT NULL DEFAULT 1,
  -- A linked site's folder is the user's. Never copied, never deleted.
  is_linked     INTEGER NOT NULL DEFAULT 0,
  xdebug        INTEGER NOT NULL DEFAULT 0,
  multisite     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A unique index here is what enforces "one hostname reaches exactly one site".
-- Without it, two sites can claim a name and nginx picks by block order.
CREATE TABLE IF NOT EXISTS site_domains (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  hostname   TEXT NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS site_env (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (site_id, key)
);

-- Knowing a plugin directory is a git checkout is what makes a --force
-- confirmation able to name what is actually at risk.
CREATE TABLE IF NOT EXISTS repos (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  dir        TEXT NOT NULL,
  url        TEXT,
  kind       TEXT NOT NULL DEFAULT 'plugin',
  is_symlink INTEGER NOT NULL DEFAULT 0,
  UNIQUE (site_id, dir)
);

-- Keyed on the recorded NAME SET, not on files existing. "The files exist"
-- leaves a valid certificate for yesterday's names while the browser warns on
-- the alias added a minute ago.
CREATE TABLE IF NOT EXISTS certs (
  site_id       INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  name_set_hash TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- macos_floor is what stops an Intel user installing a build that cannot run.
CREATE TABLE IF NOT EXISTS runtimes (
  component   TEXT NOT NULL,
  version     TEXT NOT NULL,
  arch        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  path        TEXT NOT NULL,
  macos_floor TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (component, version, arch)
);

-- Open public shares, recorded so ANY Nexora process can see and stop one.
-- A share held only in the memory of a process that has since died is a share
-- nobody can find, which is the state this table exists to prevent.
CREATE TABLE IF NOT EXISTS tunnels (
  domain     TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  guard_pid  INTEGER,
  owner      TEXT NOT NULL DEFAULT 'app',
  started_at INTEGER NOT NULL,
  -- NULL for an app-owned share (it dies with the app); a deadline for a
  -- CLI-owned one, which has no window to close.
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#,
            )?;
            let v: i64 = c
                .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))
                .unwrap_or(0);
            if v < 1 {
                c.execute("INSERT INTO schema_version (version) VALUES (1)", [])?;
            }
            Ok(())
        })
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT value FROM settings WHERE key = ?1")?;
            let mut rows = st.query(params![key])?;
            Ok(match rows.next()? {
                Some(r) => Some(r.get(0)?),
                None => None,
            })
        })
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    /// Where new sites are provisioned. Empty means the default.
    pub fn sites_dir(&self) -> Result<std::path::PathBuf> {
        Ok(match self.setting("sites_dir")? {
            Some(v) if !v.trim().is_empty() => std::path::PathBuf::from(v.trim()),
            _ => crate::paths::default_sites(),
        })
    }

    /// Move the folder new sites are created in.
    ///
    /// Existing sites are NOT moved: each one records its own docroot, so they
    /// keep serving from where they are. Moving someone's code because they
    /// changed a preference is not a thing a tool should do quietly.
    pub fn set_sites_dir(&self, dir: &str) -> Result<std::path::PathBuf> {
        let dir = dir.trim();
        let path = if dir.is_empty() {
            crate::paths::default_sites()
        } else {
            let expanded = match dir.strip_prefix("~/") {
                Some(rest) => dirs::home_dir()
                    .map(|h| h.join(rest))
                    .unwrap_or_else(|| std::path::PathBuf::from(dir)),
                None => std::path::PathBuf::from(dir),
            };
            if !expanded.is_absolute() {
                return Err(crate::Error::other(
                    "Give a full path, starting with / or ~/.",
                ));
            }
            expanded
        };

        std::fs::create_dir_all(&path).map_err(|e| crate::Error::Io {
            path: path.clone(),
            source: e,
        })?;
        // Refuse a folder we cannot write into, before it becomes the place
        // every future site fails to be created in.
        let probe = path.join(".nexora-write-test");
        std::fs::write(&probe, b"ok").map_err(|e| crate::Error::Io {
            path: path.clone(),
            source: e,
        })?;
        let _ = std::fs::remove_file(&probe);

        self.set_setting("sites_dir", &path.to_string_lossy())?;
        Ok(path)
    }

    /// The default TLD for new sites. `.test` is reserved by RFC 6761 for
    /// exactly this, which is why it is the default rather than a brand.
    /// Per-site environment variables, in a stable order.
    pub fn site_env(&self, site_id: i64) -> Result<Vec<(String, String)>> {
        self.with(|c| {
            let mut q = c.prepare(
                "SELECT key, value FROM site_env WHERE site_id = ?1 ORDER BY key",
            )?;
            let rows = q
                .query_map(params![site_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Replace the whole set for one site. Whole-set rather than per-key so
    /// removing a variable is expressible at all.
    pub fn set_site_env(&self, site_id: i64, entries: &[(String, String)]) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM site_env WHERE site_id = ?1", params![site_id])?;
            for (k, v) in entries {
                let k = k.trim();
                if k.is_empty() {
                    continue;
                }
                c.execute(
                    "INSERT INTO site_env (site_id, key, value) VALUES (?1, ?2, ?3)",
                    params![site_id, k, v],
                )?;
            }
            Ok(())
        })
    }

    /// When this site's certificate was issued and when it runs out.
    pub fn cert_dates(&self, site_id: i64) -> Result<Option<(String, String)>> {
        self.with(|c| {
            let mut q = c.prepare(
                "SELECT issued_at, expires_at FROM certs WHERE site_id = ?1",
            )?;
            let mut rows = q.query_map(params![site_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(match rows.next() {
                Some(r) => Some(r?),
                None => None,
            })
        })
    }

    pub fn tld(&self) -> Result<String> {
        Ok(self.setting("tld")?.unwrap_or_else(|| "test".into()))
    }

    /// The PHP new sites get. 8.4 on a new install; an install from before
    /// 8.4 was the default keeps the 8.3 it had (see `keep_earlier_default_php`).
    pub fn default_php(&self) -> Result<String> {
        Ok(self.setting("default_php")?.unwrap_or_else(|| DEFAULT_PHP.into()))
    }

    /// An install that has already been used, but never chose a default PHP,
    /// was on 8.3 -- the default before 8.4. It is written down, so moving the
    /// default for new installs never moves an existing one.
    pub fn keep_earlier_default_php(&self, used: bool) -> Result<()> {
        if used && self.setting("default_php")?.is_none() {
            self.set_setting("default_php", "8.3")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hostname_reaches_exactly_one_site() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO sites (id, name, domain, docroot, php_minor) VALUES (1,'A','a.test','/a','8.3')",
                [],
            )?;
            c.execute(
                "INSERT INTO sites (id, name, domain, docroot, php_minor) VALUES (2,'B','b.test','/b','8.3')",
                [],
            )?;
            c.execute("INSERT INTO site_domains (site_id, hostname) VALUES (1,'shop.test')", [])?;
            // Site B may not claim a name site A already answers on.
            let clash = c.execute("INSERT INTO site_domains (site_id, hostname) VALUES (2,'shop.test')", []);
            assert!(clash.is_err(), "a duplicate hostname must be refused by the schema");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn defaults_are_test_tld_and_php_84() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.tld().unwrap(), "test");
        assert_eq!(db.default_php().unwrap(), "8.4");
    }

    #[test]
    fn an_install_already_in_use_keeps_the_php_it_defaulted_to() {
        let db = Db::open_in_memory().unwrap();
        db.keep_earlier_default_php(false).unwrap();
        assert_eq!(db.default_php().unwrap(), "8.4", "a new install gets 8.4");

        let used = Db::open_in_memory().unwrap();
        used.keep_earlier_default_php(true).unwrap();
        assert_eq!(used.default_php().unwrap(), "8.3", "an existing one stays on 8.3");

        let chose = Db::open_in_memory().unwrap();
        chose.set_setting("default_php", "8.2").unwrap();
        chose.keep_earlier_default_php(true).unwrap();
        assert_eq!(chose.default_php().unwrap(), "8.2", "a choice is never overwritten");
    }

    #[test]
    fn sites_default_somewhere_a_person_can_find() {
        let db = Db::open_in_memory().unwrap();
        let d = db.sites_dir().unwrap();
        assert!(d.ends_with("Nexora/Sites"), "got {}", d.display());
        assert!(
            !d.to_string_lossy().contains("Application Support"),
            "a user's own code does not belong buried in Application Support"
        );
    }

    #[test]
    fn a_relative_sites_dir_is_refused() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.set_sites_dir("some/relative/path").is_err());
    }

    #[test]
    fn a_tilde_path_is_expanded_and_created() {
        let db = Db::open_in_memory().unwrap();
        let p = db.set_sites_dir("~/Nexora/SitesTest").unwrap();
        assert!(p.is_absolute());
        assert!(p.exists(), "the folder must exist before sites are put in it");
        let _ = std::fs::remove_dir_all(&p);
    }
}

#[cfg(test)]
mod journal_tests {
    #[test]
    fn a_wal_database_is_moved_to_a_rollback_journal() {
        let dir = std::env::temp_dir().join(format!("nexora-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("db.sqlite3");
        {
            let c = rusqlite::Connection::open(&file).unwrap();
            c.pragma_update(None, "journal_mode", "WAL").unwrap();
            c.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);").unwrap();
        }
        let c = rusqlite::Connection::open(&file).unwrap();
        super::configure(&c);
        let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "delete");
        let x: i64 = c.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 1, "the data survives the switch");
        drop(c);
        assert!(!dir.join("db.sqlite3-shm").exists(), "no shared-memory file is left to map");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod recovery_tests {
    use std::cell::Cell;

    /// The error a connection gives when it decides the file is damaged.
    fn corrupt_error() -> crate::Error {
        crate::Error::Db(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(11), // SQLITE_CORRUPT
            Some("database disk image is malformed".into()),
        ))
    }

    /// A connection that says the file is damaged when it is not: the work is
    /// done again on a new connection rather than failing the screen that
    /// asked for it. This is what left "could not read your sites" on screen
    /// for the rest of a session.
    #[test]
    fn a_connection_that_goes_bad_is_replaced_and_the_work_retried() {
        let dir = std::env::temp_dir().join(format!("nexora-db-retry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("nexora.sqlite3");
        let db = super::Db::open_or_replace(&file).expect("open");

        let calls = Cell::new(0);
        let answer: i64 = db
            .with(|c| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    return Err(corrupt_error());
                }
                Ok(c.query_row("SELECT 42", [], |r| r.get(0))?)
            })
            .expect("the retry answers");
        assert_eq!(answer, 42);
        assert_eq!(calls.get(), 2, "it was tried again, once");
        // The file was sound, so nothing was moved aside.
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("damaged-"))
            .count();
        assert_eq!(kept, 0, "a sound file is left where it is");
        assert!(db.tld().is_ok(), "and the database still works afterwards");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod damage_tests {
    /// A file SQLite cannot read is moved aside and replaced, rather than
    /// stopping Nexora from opening at all.
    #[test]
    fn a_damaged_database_is_kept_and_replaced() {
        // Its own file, not NEXORA_HOME: the tests share one process, and a
        // test that moved the real database aside would be a test that ate a
        // developer's sites.
        let dir = std::env::temp_dir().join(format!("nexora-db-damage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("nexora.sqlite3");
        // A real header, then rubbish where the first page's rows belong.
        {
            let c = rusqlite::Connection::open(&file).unwrap();
            c.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);").unwrap();
        }
        let mut bytes = std::fs::read(&file).unwrap();
        for b in bytes.iter_mut().skip(100).take(400) {
            *b = 0x7f;
        }
        std::fs::write(&file, &bytes).unwrap();

        let db = super::Db::open_or_replace(&file).expect("Nexora opens on a fresh database");
        assert!(db.tld().is_ok(), "and the new one works");
        let kept: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("damaged-"))
            .collect();
        assert_eq!(kept.len(), 1, "the damaged file is kept beside it");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// SQLite could not read the file: damaged, or not a database at all.
fn is_corrupt(e: &crate::Error) -> bool {
    let text = e.to_string().to_lowercase();
    text.contains("malformed") || text.contains("not a database") || text.contains("file is encrypted")
}

/// What SQLite says about the file itself, read through a new connection so a
/// connection gone bad cannot answer for it.
fn integrity_of(file: &std::path::Path) -> String {
    match Connection::open(file).and_then(|c| {
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
    }) {
        Ok(verdict) => verdict,
        Err(e) => format!("could not be checked: {e}"),
    }
}
