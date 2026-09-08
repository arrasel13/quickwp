//! Sites.
//!
//! A site is a domain, a docroot, a PHP version and (usually) a database.
//! Nothing here is decided permanently: PHP version, domain, display name and
//! docroot can all change on an existing site without recreating it.

use crate::{db::Db, paths, Error, Result};
use rusqlite::params;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Site {
    pub id: i64,
    pub name: String,
    pub domain: String,
    pub docroot: String,
    pub kind: String,
    pub php_minor: String,
    pub server: String,
    pub enabled: bool,
    /// A linked site's folder is the user's. Never copied, never deleted --
    /// not even when the site is deleted. That guarantee is the whole reason
    /// linking exists: an environment that relocates your work into its own
    /// directory makes itself hard to leave.
    pub is_linked: bool,
    pub xdebug: bool,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NewSite {
    pub name: String,
    pub domain: String,
    pub kind: String,
    pub php_minor: String,
    /// Some(path) links an existing folder in place instead of provisioning one.
    pub link_path: Option<String>,
}

fn row_to_site(r: &rusqlite::Row) -> rusqlite::Result<Site> {
    Ok(Site {
        id: r.get("id")?,
        name: r.get("name")?,
        domain: r.get("domain")?,
        docroot: r.get("docroot")?,
        kind: r.get("kind")?,
        php_minor: r.get("php_minor")?,
        server: r.get("server")?,
        enabled: r.get::<_, i64>("enabled")? != 0,
        is_linked: r.get::<_, i64>("is_linked")? != 0,
        xdebug: r.get::<_, i64>("xdebug")? != 0,
        aliases: Vec::new(),
    })
}

pub fn list(db: &Db) -> Result<Vec<Site>> {
    db.with(|c| {
        let mut st = c.prepare("SELECT * FROM sites ORDER BY name")?;
        let mut sites: Vec<Site> = st
            .query_map([], row_to_site)?
            .collect::<rusqlite::Result<_>>()?;
        for s in sites.iter_mut() {
            let mut a = c.prepare(
                "SELECT hostname FROM site_domains WHERE site_id = ?1 AND is_primary = 0 ORDER BY hostname",
            )?;
            s.aliases = a
                .query_map(params![s.id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        }
        Ok(sites)
    })
}

pub fn find(db: &Db, domain: &str) -> Result<Option<Site>> {
    Ok(list(db)?
        .into_iter()
        .find(|s| s.domain == domain || s.aliases.iter().any(|a| a == domain)))
}

/// Create a site. Provisions a docroot unless `link_path` adopts one.
pub fn create(db: &Db, new: &NewSite) -> Result<Site> {
    let domain = normalise_domain(&new.domain);
    if find(db, &domain)?.is_some() {
        return Err(Error::other(format!(
            "`{domain}` is already in use by another site. A hostname reaches exactly one site."
        )));
    }

    let (docroot, is_linked) = match &new.link_path {
        Some(p) => {
            let path = std::path::PathBuf::from(shellexpand_tilde(p));
            if !path.is_dir() {
                return Err(Error::other(format!(
                    "{} is not a folder. Pick the directory the site should serve from.",
                    path.display()
                )));
            }
            (path, true)
        }
        None => {
            let dir = paths::sites().join(domain.split('.').next().unwrap_or(&domain));
            paths::mkdir_p(&dir)?;
            seed_index(&dir, &domain, &new.php_minor)?;
            (dir, false)
        }
    };

    let id = db.with(|c| {
        c.execute(
            "INSERT INTO sites (name, domain, docroot, kind, php_minor, is_linked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                new.name,
                domain,
                docroot.to_string_lossy(),
                new.kind,
                new.php_minor,
                is_linked as i64
            ],
        )?;
        let id = c.last_insert_rowid();
        c.execute(
            "INSERT INTO site_domains (site_id, hostname, is_primary) VALUES (?1, ?2, 1)",
            params![id, domain],
        )?;
        Ok(id)
    })?;

    Ok(find_by_id(db, id)?.ok_or_else(|| Error::other("site vanished after insert"))?)
}

pub fn find_by_id(db: &Db, id: i64) -> Result<Option<Site>> {
    Ok(list(db)?.into_iter().find(|s| s.id == id))
}

/// Delete a site.
///
/// A linked site loses only QuickWP's record of it. The folder stays exactly
/// where it was, with exactly what was in it.
pub fn delete(db: &Db, domain: &str) -> Result<()> {
    let Some(site) = find(db, domain)? else {
        return Err(Error::other(format!("no site answers on `{domain}`")));
    };
    if !site.is_linked {
        let _ = std::fs::remove_dir_all(&site.docroot);
    }
    db.with(|c| {
        c.execute("DELETE FROM sites WHERE id = ?1", params![site.id])?;
        Ok(())
    })
}

/// Stop serving one site. Recorded in the database, not in memory: a site you
/// stopped on Tuesday is still stopped after a relaunch.
pub fn set_enabled(db: &Db, domain: &str, enabled: bool) -> Result<()> {
    let Some(site) = find(db, domain)? else {
        return Err(Error::other(format!("no site answers on `{domain}`")));
    };
    db.with(|c| {
        c.execute(
            "UPDATE sites SET enabled = ?1 WHERE id = ?2",
            params![enabled as i64, site.id],
        )?;
        Ok(())
    })
}

pub fn set_php(db: &Db, domain: &str, minor: &str) -> Result<()> {
    if !crate::runtime::PHP_MINORS.contains(&minor) {
        return Err(Error::UnknownPhpVersion(minor.into()));
    }
    let Some(site) = find(db, domain)? else {
        return Err(Error::other(format!("no site answers on `{domain}`")));
    };
    db.with(|c| {
        c.execute(
            "UPDATE sites SET php_minor = ?1 WHERE id = ?2",
            params![minor, site.id],
        )?;
        Ok(())
    })
}

/// Add an extra hostname. One certificate will cover every name the site has.
pub fn add_domain(db: &Db, domain: &str, alias: &str) -> Result<()> {
    let alias = normalise_domain(alias);
    if let Some(owner) = find(db, &alias)? {
        return Err(Error::other(format!(
            "`{alias}` is already a name of the site \"{}\".",
            owner.name
        )));
    }
    let Some(site) = find(db, domain)? else {
        return Err(Error::other(format!("no site answers on `{domain}`")));
    };
    db.with(|c| {
        c.execute(
            "INSERT INTO site_domains (site_id, hostname, is_primary) VALUES (?1, ?2, 0)",
            params![site.id, alias],
        )?;
        Ok(())
    })
}

fn normalise_domain(d: &str) -> String {
    d.trim().trim_end_matches('.').to_lowercase()
}

fn shellexpand_tilde(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => dirs::home_dir()
            .map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string()),
        None => p.to_string(),
    }
}

/// The page a new blank site opens on.
///
/// Not a phpinfo() dump. It answers the questions a first page load is actually
/// asked: what is serving this, and where are the files. Written once and never
/// overwritten, so a retry leaves an edited page alone.
fn seed_index(dir: &std::path::Path, domain: &str, minor: &str) -> Result<()> {
    let index = dir.join("index.php");
    if index.exists() {
        return Ok(());
    }
    let body = format!(
        r#"<?php
$domain = {domain:?};
$docroot = __DIR__;
?><!doctype html>
<title><?= htmlspecialchars($domain) ?></title>
<style>
  body {{ font: 16px/1.6 -apple-system, system-ui, sans-serif; max-width: 42rem;
         margin: 12vh auto; padding: 0 1.5rem; color: #1a1f27; background: #f7f8fa; }}
  h1 {{ font-size: 1.6rem; margin: 0 0 .25rem; }}
  p.sub {{ color: #6b7686; margin: 0 0 2rem; }}
  dl {{ display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1.5rem;
        background: #fff; border: 1px solid #dfe4ea; padding: 1.25rem 1.5rem; }}
  dt {{ color: #6b7686; font-size: .8rem; text-transform: uppercase;
        letter-spacing: .06em; align-self: center; }}
  dd {{ margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: .9rem; word-break: break-all; }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #e7eaf0; background: #0f1217; }}
    dl {{ background: #161a21; border-color: #293039; }}
    p.sub, dt {{ color: #7c8698; }}
  }}
</style>
<h1><?= htmlspecialchars($domain) ?></h1>
<p class="sub">Served by QuickWP.</p>
<dl>
  <dt>PHP</dt><dd><?= PHP_VERSION ?></dd>
  <dt>SAPI</dt><dd><?= PHP_SAPI ?></dd>
  <dt>Docroot</dt><dd><?= htmlspecialchars($docroot) ?></dd>
  <dt>Pool port</dt><dd><?= htmlspecialchars($_SERVER['SERVER_PORT'] ?? '?') ?></dd>
</dl>
<p>Edit <code>index.php</code> in the docroot above. This file is written once and
never overwritten by QuickWP.</p>
"#,
        domain = domain
    );
    let _ = minor;
    std::fs::write(&index, body).map_err(|e| Error::Io {
        path: index,
        source: e,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_normalise_and_cannot_be_claimed_twice() {
        let db = Db::open_in_memory().unwrap();
        let tmp = std::env::temp_dir().join("quickwp-site-test");
        std::fs::create_dir_all(&tmp).unwrap();

        let a = create(
            &db,
            &NewSite {
                name: "Shop".into(),
                domain: "Shop.Test.".into(),
                kind: "php".into(),
                php_minor: "8.3".into(),
                link_path: Some(tmp.to_string_lossy().into()),
            },
        )
        .unwrap();
        assert_eq!(a.domain, "shop.test");
        assert!(a.is_linked);

        let clash = create(
            &db,
            &NewSite {
                name: "Other".into(),
                domain: "shop.test".into(),
                kind: "php".into(),
                php_minor: "8.3".into(),
                link_path: Some(tmp.to_string_lossy().into()),
            },
        );
        assert!(clash.is_err());
    }

    #[test]
    fn deleting_a_linked_site_leaves_the_folder_alone() {
        let db = Db::open_in_memory().unwrap();
        let tmp = std::env::temp_dir().join("quickwp-linked-keep");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("mine.txt"), "my work").unwrap();

        create(
            &db,
            &NewSite {
                name: "Linked".into(),
                domain: "linked.test".into(),
                kind: "php".into(),
                php_minor: "8.3".into(),
                link_path: Some(tmp.to_string_lossy().into()),
            },
        )
        .unwrap();
        delete(&db, "linked.test").unwrap();

        assert!(tmp.join("mine.txt").exists(), "a linked folder is the user's");
        assert!(find(&db, "linked.test").unwrap().is_none());
    }

    #[test]
    fn an_alias_cannot_be_stolen_from_another_site() {
        let db = Db::open_in_memory().unwrap();
        let tmp = std::env::temp_dir().join("quickwp-alias-test");
        std::fs::create_dir_all(&tmp).unwrap();
        for d in ["one.test", "two.test"] {
            create(
                &db,
                &NewSite {
                    name: d.into(),
                    domain: d.into(),
                    kind: "php".into(),
                    php_minor: "8.3".into(),
                    link_path: Some(tmp.to_string_lossy().into()),
                },
            )
            .unwrap();
        }
        add_domain(&db, "one.test", "shared.test").unwrap();
        let err = add_domain(&db, "two.test", "shared.test").unwrap_err();
        assert!(err.to_string().contains("already a name of the site"));
    }
}
