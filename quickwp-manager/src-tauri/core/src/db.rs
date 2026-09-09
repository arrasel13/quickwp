//! App state.
//!
//! The important property: a site's enabled flag lives here, not in memory.
//! Services outlive the app, so a site you stopped on Tuesday must still be
//! stopped after a relaunch.

use crate::Result;
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open() -> Result<Self> {
        crate::paths::ensure_dirs()?;
        let conn = Connection::open(crate::paths::db_file())?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db(Arc::new(Mutex::new(conn)));
        db.migrate()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db(Arc::new(Mutex::new(conn)));
        db.migrate()?;
        Ok(db)
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.0.lock().map_err(|_| crate::Error::other("db lock poisoned"))?;
        f(&guard)
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

-- Open public shares, recorded so ANY QuickWP process can see and stop one.
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

    /// The default TLD for new sites. `.test` is reserved by RFC 6761 for
    /// exactly this, which is why it is the default rather than a brand.
    pub fn tld(&self) -> Result<String> {
        Ok(self.setting("tld")?.unwrap_or_else(|| "test".into()))
    }

    pub fn default_php(&self) -> Result<String> {
        Ok(self.setting("default_php")?.unwrap_or_else(|| "8.3".into()))
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
    fn defaults_are_test_tld_and_php_83() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.tld().unwrap(), "test");
        assert_eq!(db.default_php().unwrap(), "8.3");
    }
}
