//! The app's own log, and reading everyone else's.
//!
//! QuickWP's log is first in the viewer's list because when a service did not
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
    /// True for QuickWP's own log, which sorts first.
    pub is_app: bool,
}

/// Every log the viewer can show, app log first.
pub fn sources() -> Vec<LogSource> {
    let mut out = Vec::new();
    let dir = paths::logs();

    let app = paths::app_log();
    out.push(LogSource {
        id: "quickwp".into(),
        label: "QuickWP".into(),
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
            if name == "quickwp" {
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
    let path = if id == "quickwp" {
        paths::app_log()
    } else {
        paths::logs().join(format!("{id}.log"))
    };
    // A log that does not exist yet is not an error: nothing has written to it.
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(String::new());
    };
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    Ok(all[start..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_log_sorts_first_because_it_answers_why_nothing_happened() {
        let s = sources();
        assert!(s[0].is_app);
        assert_eq!(s[0].id, "quickwp");
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
