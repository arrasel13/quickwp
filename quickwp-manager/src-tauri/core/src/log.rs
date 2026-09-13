//! The app's own log, and reading everyone else's.
//!
//! Nexora's log is first in the viewer's list because when a service did not
//! start, the reason is in *our* log and not in that service's empty file.
//! It lives beside every other log rather than in ~/Library/Logs: one directory
//! beats the platform convention when the convention splits a diagnosis across
//! two places.

use crate::paths;
use std::io::Write;

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const KEEP: usize = 3;

/// Append a line to the app log, rotating at 2MB.
pub fn write(message: &str) {
    // Unit tests must not write into the real app log: a test asserting on
    // tunnel sweeping was leaving `ghost.test` in a user's diagnostics.
    if cfg!(test) {
        return;
    }
    let path = paths::app_log();
    if paths::mkdir_p(path.parent().unwrap()).is_err() {
        return;
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        for i in (1..KEEP).rev() {
            let _ = std::fs::rename(
                path.with_extension(format!("log.{i}")),
                path.with_extension(format!("log.{}", i + 1)),
            );
        }
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {message}", timestamp());
    }
}

fn timestamp() -> String {
    // Seconds since the epoch is enough to order events and needs no dependency.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("[{secs}]")
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LogSource {
    pub id: String,
    pub label: String,
    pub path: String,
    pub bytes: u64,
    /// True for Nexora's own log, which sorts first.
    pub is_app: bool,
}

/// Every log the viewer can show, app log first.
/// One of the four log streams that can explain a single site.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SiteLog {
    pub id: String,
    pub label: String,
    pub path: String,
    pub exists: bool,
    pub bytes: u64,
    /// Only meaningful for the WordPress debug log: whether WP is writing to
    /// it at all. `None` for the streams Nexora always writes.
    pub logging: Option<bool>,
}

/// Resolve a stream id to the file behind it.
///
/// The UI names a stream, never a path -- clearing and downloading act on
/// whatever this returns, so a path arriving from the front end is not
/// something to trust.
pub fn site_log_path(site: &crate::site::Site, id: &str) -> Option<std::path::PathBuf> {
    let dir = paths::logs();
    match id {
        "wp-debug" => Some(
            std::path::Path::new(&site.docroot)
                .join("wp-content")
                .join("debug.log"),
        ),
        "app" => Some(paths::app_log()),
        "server" => Some(dir.join(format!("php-fpm-{}.log", site.php_minor))),
        // `db_engine` on a site row holds the SERIES ("8.4"), not an engine
        // name -- both callers of set_database pass the series. The file that
        // mysqld is started with is always mysql-<series>.log.
        "database" => site
            .db_engine
            .as_deref()
            .map(|series| dir.join(format!("mysql-{series}.log"))),
        _ => None,
    }
}

/// The four streams, in the order they are worth reading.
pub fn for_site(site: &crate::site::Site, wp_logging: Option<bool>) -> Vec<SiteLog> {
    let mut out = Vec::new();
    for (id, label) in [
        ("wp-debug", "WordPress debug log"),
        ("app", "Nexora (app)"),
        ("server", "Server (edge/PHP)"),
        ("database", "Database"),
    ] {
        let Some(path) = site_log_path(site, id) else {
            continue;
        };
        let meta = std::fs::metadata(&path);
        out.push(SiteLog {
            id: id.into(),
            label: label.into(),
            exists: meta.is_ok(),
            bytes: meta.map(|m| m.len()).unwrap_or(0),
            path: path.to_string_lossy().into(),
            logging: if id == "wp-debug" { wp_logging } else { None },
        });
    }
    out
}

/// Empty a log without deleting it.
///
/// Truncated rather than removed: the writer holds the file open, and deleting
/// it leaves that process writing to an inode nothing can read any more.
pub fn clear(path: &std::path::Path) -> crate::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    std::fs::write(path, b"").map_err(|e| crate::Error::Io {
        path: path.to_path_buf(),
        source: e,
    })
}

pub fn sources() -> Vec<LogSource> {
    let mut out = Vec::new();
    let dir = paths::logs();

    let app = paths::app_log();
    out.push(LogSource {
        id: "nexora".into(),
        label: "Nexora".into(),
        bytes: std::fs::metadata(&app).map(|m| m.len()).unwrap_or(0),
        path: app.to_string_lossy().into(),
        is_app: true,
    });

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    let mut rest: Vec<LogSource> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().map(|x| x != "log").unwrap_or(true) {
                return None;
            }
            let name = p.file_stem()?.to_string_lossy().into_owned();
            if name == "nexora" {
                return None;
            }
            Some(LogSource {
                bytes: e.metadata().map(|m| m.len()).unwrap_or(0),
                label: pretty(&name),
                id: name,
                path: p.to_string_lossy().into(),
                is_app: false,
            })
        })
        .collect();
    rest.sort_by(|a, b| a.label.cmp(&b.label));
    out.extend(rest);
    out
}

fn pretty(id: &str) -> String {
    // Two logs per service is normal -- the service's own file and the
    // supervisor's capture of its stdout -- so the suffix has to survive into
    // the label. Two rows both reading "MySQL 8.4" is a list you cannot use.
    if let Some(v) = id.strip_prefix("php-fpm-") {
        return match v.strip_suffix(".access") {
            Some(ver) => format!("PHP {ver} · access"),
            None => format!("PHP {v}"),
        };
    }
    if let Some(v) = id.strip_prefix("mysql-") {
        return match v.strip_suffix(".out") {
            Some(ver) => format!("MySQL {ver} · stdout"),
            None => format!("MySQL {v}"),
        };
    }
    if let Some(v) = id.strip_prefix("tunnel-") {
        return format!("Tunnel · {v}");
    }
    match id {
        "edge" => "Edge (443)".into(),
        "mailpit" => "Mailpit".into(),
        other => other.to_string(),
    }
}

/// The last `lines` lines of one log.
pub fn tail(id: &str, lines: usize) -> crate::Result<String> {
    let path = if id == "nexora" {
        paths::app_log()
    } else {
        paths::logs().join(format!("{id}.log"))
    };
    tail_path(&path, lines)
}

/// The last `lines` of a file named directly, for logs that do not live in
/// Nexora's own directory -- a site's wp-content/debug.log, say.
pub fn tail_path(path: &std::path::Path, lines: usize) -> crate::Result<String> {
    // A log that does not exist yet is not an error: nothing has written to it.
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(String::new());
    };
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    Ok(all[start..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_site(db_engine: Option<&str>) -> crate::site::Site {
        crate::site::Site {
            id: 1,
            name: "t".into(),
            domain: "t.test".into(),
            docroot: "/tmp/t".into(),
            kind: "wordpress".into(),
            php_minor: "8.3".into(),
            server: "edge".into(),
            enabled: true,
            is_linked: false,
            xdebug: false,
            db_engine: db_engine.map(String::from),
            db_name: Some("t".into()),
            aliases: vec![],
        }
    }

    #[test]
    fn the_database_log_is_named_from_the_series_in_db_engine() {
        // db_engine holds "8.4", not "mysql" -- reading it as an engine name
        // built "8.4-<series>.log" and the stream vanished from the list.
        let p = site_log_path(&a_site(Some("8.4")), "database").unwrap();
        assert!(
            p.ends_with("mysql-8.4.log"),
            "expected mysql-8.4.log, got {}",
            p.display()
        );
    }

    #[test]
    fn a_site_with_no_database_offers_no_database_log() {
        assert!(site_log_path(&a_site(None), "database").is_none());
        let streams = for_site(&a_site(None), None);
        assert!(!streams.iter().any(|s| s.id == "database"));
    }

    #[test]
    fn a_site_with_a_database_lists_all_four_streams() {
        let streams = for_site(&a_site(Some("8.4")), Some(false));
        assert_eq!(streams.len(), 4);
        assert!(streams.iter().any(|s| s.id == "database"));
    }

    #[test]
    fn the_app_log_sorts_first_because_it_answers_why_nothing_happened() {
        let s = sources();
        assert!(s[0].is_app);
        assert_eq!(s[0].id, "nexora");
    }

    #[test]
    fn a_log_that_does_not_exist_yet_is_empty_not_an_error() {
        assert_eq!(tail("definitely-not-a-service", 10).unwrap(), "");
    }

    #[test]
    fn service_ids_render_as_names_people_recognise() {
        assert_eq!(pretty("php-fpm-8.3"), "PHP 8.3");
        assert_eq!(pretty("edge"), "Edge (443)");
        assert_eq!(pretty("tunnel-shop.test"), "Tunnel · shop.test");
    }

    #[test]
    fn a_services_two_logs_do_not_share_one_label() {
        assert_ne!(pretty("mysql-8.4"), pretty("mysql-8.4.out"));
        assert_ne!(pretty("php-fpm-8.3"), pretty("php-fpm-8.3.access"));
    }
}
