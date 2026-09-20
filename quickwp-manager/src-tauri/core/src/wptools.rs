//! The maintenance drawer for one WordPress site.
//!
//! Everything here is a thin, typed wrapper over a WP-CLI subcommand. It is
//! deliberately not a "run any wp command" pipe: the UI can only reach the
//! operations named here, so a bug in the front end cannot turn into arbitrary
//! command execution against someone's site.

use crate::site::Site;
use crate::wordpress::{run, run_with_stdin, wp};
use crate::{Error, Result};

// ------------------------------------------------------------------ config

/// The wp-config.php constants worth a switch. Anything not on this list is
/// refused rather than written: wp-config.php is the one file that can take a
/// site offline completely.
const KNOWN_CONSTANTS: &[&str] = &[
    "WP_DEBUG",
    "WP_DEBUG_LOG",
    "WP_DEBUG_DISPLAY",
    "SCRIPT_DEBUG",
    "WP_CACHE",
    "DISALLOW_FILE_EDIT",
    "WP_ENVIRONMENT_TYPE",
    // Off for a site created on a chosen WordPress version, so it stays there.
    "WP_AUTO_UPDATE_CORE",
];

fn check_constant(key: &str) -> Result<()> {
    if KNOWN_CONSTANTS.contains(&key) {
        Ok(())
    } else {
        Err(Error::other(format!(
            "{key} is not one of the constants Nexora will edit."
        )))
    }
}

/// Read a constant. `None` when it is not defined at all, which is different
/// from being defined as false.
pub fn config_get(site: &Site, key: &str) -> Result<Option<String>> {
    check_constant(key)?;
    let mut c = wp(site)?;
    c.args(["config", "get", key, "--type=constant"]);
    match run(c, "Reading wp-config.php") {
        Ok(v) => Ok(Some(v.trim().to_string())),
        // WP-CLI exits non-zero for "not defined", which is an answer here.
        Err(_) => Ok(None),
    }
}

/// Write a boolean constant as a real PHP literal, not the string "true".
/// Set a wp-config.php constant to a string. For the keys Nexora writes
/// itself; the value goes to WP-CLI as an argument, never through a shell.
pub fn config_set(site: &Site, key: &str, value: &str) -> Result<()> {
    let mut c = wp(site)?;
    c.args(["config", "set", key, value, "--type=constant"]);
    run(c, "Writing wp-config.php")?;
    Ok(())
}

pub fn config_set_bool(site: &Site, key: &str, on: bool) -> Result<String> {
    check_constant(key)?;
    let mut c = wp(site)?;
    c.args([
        "config",
        "set",
        key,
        if on { "true" } else { "false" },
        "--raw",
        "--type=constant",
    ]);
    run(c, "Writing wp-config.php")?;
    Ok(format!("{key} is now {}.", if on { "on" } else { "off" }))
}

// ----------------------------------------------------------------- options

/// The options Nexora will edit.
///
/// Curated on purpose. Site URLs are excluded because changing one without the
/// matching search-replace leaves a site that redirects to an address it no
/// longer answers on, and serialized options are excluded because a plain
/// string write corrupts them.
const KNOWN_OPTIONS: &[&str] = &[
    "blogname",
    "blogdescription",
    "admin_email",
    "timezone_string",
    "gmt_offset",
    "date_format",
    "time_format",
    "start_of_week",
    "posts_per_page",
    "default_role",
    "users_can_register",
    "blog_public",
    "permalink_structure",
    "WPLANG",
];

fn check_option(key: &str) -> Result<()> {
    if KNOWN_OPTIONS.contains(&key) {
        Ok(())
    } else {
        Err(Error::other(format!(
            "{key} is not one of the options Nexora will edit."
        )))
    }
}

/// A core release newer than what the site runs.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CoreUpdate {
    pub version: String,
    /// "minor", "major" or "development", as WordPress classes it.
    pub update_type: String,
}

/// What WordPress itself offers the dashboard: the newest release for this
/// site, or `None` when it is up to date.
///
/// Asks wordpress.org, so it is slow enough to be worth reading once and
/// remembering.
pub fn core_update_check(site: &Site) -> Result<Option<CoreUpdate>> {
    let mut c = wp(site)?;
    c.args(["core", "check-update", "--format=json", "--fields=version,update_type"]);
    let out = run(c, "Checking for a WordPress update")?;
    Ok(newest_update(&out))
}

/// The first row of `wp core check-update`. Up to date, WP-CLI prints a
/// success line rather than a list, which is no update.
fn newest_update(out: &str) -> Option<CoreUpdate> {
    let start = out.find('[')?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(out[start..].trim()).ok()?;
    let row = rows.into_iter().next()?;
    let get = |k: &str| row.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let version = get("version");
    (!version.is_empty()).then(|| CoreUpdate { version, update_type: get("update_type") })
}

/// Everything the Settings tab reads, in two WP-CLI runs side by side rather
/// than one per field: wp-config.php's switches, the options asked for, and
/// the site's locale.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SettingsSnapshot {
    /// Each known constant: true only when wp-config.php defines it true.
    pub constants: std::collections::BTreeMap<String, bool>,
    pub options: std::collections::BTreeMap<String, String>,
    /// get_locale(), e.g. "en_US". Empty when WordPress could not load.
    pub locale: String,
}

/// Whether a `wp config list` value is a true literal. WP-CLI reports
/// `define('X', true)` as JSON true, and older releases as "1" or "true".
fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        serde_json::Value::String(s) => matches!(s.trim(), "true" | "1" | "TRUE"),
        _ => false,
    }
}

/// Only the constants on [`KNOWN_CONSTANTS`] are kept: the rest of the list is
/// the database password and the salts, which have no business in the UI.
fn known_constants(json: &str) -> std::collections::BTreeMap<String, bool> {
    let mut out: std::collections::BTreeMap<String, bool> =
        KNOWN_CONSTANTS.iter().map(|k| (k.to_string(), false)).collect();
    let rows: Vec<serde_json::Value> = serde_json::from_str(json.trim()).unwrap_or_default();
    for row in rows {
        let (Some(name), Some(kind)) = (row.get("name").and_then(|v| v.as_str()), row.get("type").and_then(|v| v.as_str())) else {
            continue;
        };
        if kind == "constant" && KNOWN_CONSTANTS.contains(&name) {
            out.insert(name.to_string(), row.get("value").is_some_and(truthy));
        }
    }
    out
}

/// PHP that prints the named options and the locale as JSON.
///
/// The names are written into the code because `wp eval` takes no arguments
/// of its own -- it answers "Too many positional arguments" -- and each is
/// checked against [`KNOWN_OPTIONS`] first, so only bare names get there.
fn snapshot_php(options: &[String]) -> Result<String> {
    let mut list = String::new();
    for key in options {
        check_option(key)?;
        // Belt and braces: everything on the list is a plain name already.
        if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(Error::other(format!("`{key}` is not a name Nexora will read")));
        }
        if !list.is_empty() {
            list.push_str(", ");
        }
        list.push('\'');
        list.push_str(key);
        list.push('\'');
    }
    Ok(format!(
        "$o = array();
foreach ( array( {list} ) as $k ) {{ $v = get_option( $k ); $o[ $k ] = is_scalar( $v ) ? (string) $v : ''; }}
echo wp_json_encode( array( 'options' => (object) $o, 'locale' => get_locale() ) );"
    ))
}

pub fn settings_snapshot(site: &Site, options: &[String]) -> Result<SettingsSnapshot> {
    let php = snapshot_php(options)?;
    let (constants, loaded) = std::thread::scope(|s| {
        let constants = s.spawn(|| -> Result<_> {
            let mut c = wp(site)?;
            c.args(["config", "list", "--format=json", "--fields=name,value,type"]);
            Ok(known_constants(&run(c, "Reading wp-config.php")?))
        });
        let loaded = s.spawn(|| -> Result<String> {
            let mut c = wp(site)?;
            c.args(["eval", &php]);
            run(c, "Reading the site's options")
        });
        (constants.join(), loaded.join())
    });
    let constants = constants.map_err(|_| Error::other("reading wp-config.php panicked"))??;
    // WordPress may not load (its database stopped): the switches in
    // wp-config.php are still worth showing, so this half is allowed to fail.
    let mut snapshot = SettingsSnapshot { constants, ..Default::default() };
    if let Ok(Ok(out)) = loaded {
        // Anything a plugin prints while WordPress boots comes first.
        let json = out.find("{\"options\"").map(|i| &out[i..]).unwrap_or(&out);
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json.trim()) {
            if let Some(map) = v.get("options").and_then(|m| m.as_object()) {
                for (k, val) in map {
                    snapshot.options.insert(k.clone(), val.as_str().unwrap_or("").to_string());
                }
            }
            snapshot.locale = v.get("locale").and_then(|l| l.as_str()).unwrap_or("").to_string();
        }
    }
    Ok(snapshot)
}

pub fn option_get(site: &Site, key: &str) -> Result<String> {
    check_option(key)?;
    let mut c = wp(site)?;
    c.args(["option", "get", key]);
    // A missing option is empty, not an error: permalink_structure is unset on
    // a fresh install and that is the "Plain" setting.
    Ok(run(c, "Reading an option").unwrap_or_default().trim().to_string())
}

pub fn option_set(site: &Site, key: &str, value: &str) -> Result<String> {
    check_option(key)?;
    let mut c = wp(site)?;
    // The value on stdin, not as an argument: WP-CLI counts `--` itself as an
    // argument ("Too many positional arguments"), and a value like the "-5"
    // of a UTC offset would otherwise read as a flag.
    c.args(["option", "update", key]);
    run_with_stdin(c, value, "Saving an option")?;
    Ok(format!("{key} saved."))
}

// --------------------------------------------------------------- permalinks

/// Set the permalink structure and flush the rewrite rules.
///
/// The flush is the half people forget: without it WordPress keeps serving the
/// old rules and every new URL 404s.
pub fn set_permalinks(site: &Site, structure: &str) -> Result<String> {
    let mut c = wp(site)?;
    // No `--`: WP-CLI counts it as an argument of its own.
    c.args(["rewrite", "structure", structure]);
    run(c, "Setting the permalink structure")?;
    flush_rewrites(site)?;
    Ok("Permalinks saved and rewrite rules flushed.".into())
}

pub fn flush_rewrites(site: &Site) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["rewrite", "flush", "--hard"]);
    run(c, "Flushing rewrite rules")?;
    Ok("Rewrite rules regenerated.".into())
}

// -------------------------------------------------------------- maintenance

pub fn maintenance_status(site: &Site) -> Result<bool> {
    let mut c = wp(site)?;
    c.args(["maintenance-mode", "status"]);
    let out = run(c, "Reading maintenance mode")?;
    Ok(out.to_lowercase().contains("active")
        && !out.to_lowercase().contains("not active"))
}

pub fn set_maintenance(site: &Site, on: bool) -> Result<String> {
    let mut c = wp(site)?;
    c.args([
        "maintenance-mode",
        if on { "activate" } else { "deactivate" },
    ]);
    run(c, "Changing maintenance mode")?;
    Ok(if on {
        "Maintenance mode on — visitors see \"briefly unavailable\".".into()
    } else {
        "Maintenance mode off.".into()
    })
}

pub fn flush_cache(site: &Site) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["cache", "flush"]);
    run(c, "Flushing the object cache")?;
    Ok("Object cache flushed.".into())
}

pub fn delete_transients(site: &Site) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["transient", "delete", "--all"]);
    let out = run(c, "Deleting transients")?;
    Ok(if out.trim().is_empty() {
        "Transients deleted.".into()
    } else {
        out.trim().to_string()
    })
}

/// Drop every table and rebuild an empty WordPress.
///
/// The most destructive thing in this module: the caller must have asked twice.
pub fn reset_site(site: &Site) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["db", "reset", "--yes"]);
    run(c, "Resetting the database")?;
    Ok("Database erased. Re-install WordPress to use this site again.".into())
}

// -------------------------------------------------------------------- core

pub fn core_update(site: &Site, version: Option<&str>) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["core", "update"]);
    if let Some(v) = version {
        c.arg(format!("--version={v}"));
        // Downgrading needs --force; WP-CLI refuses to move backwards without it.
        c.arg("--force");
    }
    let out = run(c, "Updating core")?;
    Ok(out.trim().to_string())
}

pub fn core_reinstall(site: &Site) -> Result<String> {
    let version = crate::wordpress::core_version(site)?;
    let mut c = wp(site)?;
    c.args(["core", "download", "--force", "--skip-content"]);
    c.arg(format!("--version={version}"));
    run(c, "Re-installing core")?;
    Ok(format!("Core {version} re-downloaded. wp-content was left alone."))
}

pub fn verify_checksums(site: &Site) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["core", "verify-checksums"]);
    match run(c, "Verifying checksums") {
        Ok(out) => Ok(if out.trim().is_empty() {
            "Core files match the official checksums.".into()
        } else {
            out.trim().to_string()
        }),
        // A mismatch is a non-zero exit and the finding is the point.
        Err(e) => Ok(e.to_string()),
    }
}

// --------------------------------------------------------------- languages

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpLanguage {
    pub language: String,
    pub english_name: String,
    pub native_name: String,
    pub status: String,
}

pub fn languages(site: &Site) -> Result<Vec<WpLanguage>> {
    let mut c = wp(site)?;
    c.args([
        "language",
        "core",
        "list",
        "--format=json",
        "--fields=language,english_name,native_name,status",
    ]);
    let json = run(c, "Listing languages")?;
    let parsed: Vec<serde_json::Value> = serde_json::from_str(json.trim())
        .map_err(|e| Error::other(format!("bad language list: {e}")))?;
    Ok(parsed
        .into_iter()
        .map(|v| {
            let g = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            WpLanguage {
                language: g("language"),
                english_name: g("english_name"),
                native_name: g("native_name"),
                status: g("status"),
            }
        })
        .collect())
}

/// Install the pack if needed, then switch to it.
pub fn set_language(site: &Site, locale: &str) -> Result<String> {
    if locale != "en_US" {
        let mut install = wp(site)?;
        install.args(["language", "core", "install", locale]);
        // Already-installed is not a failure worth stopping for.
        let _ = run(install, "Installing a language");
    }
    let mut c = wp(site)?;
    c.args(["language", "core", "activate", locale]);
    run(c, "Switching language")?;
    Ok(format!("Language set to {locale}."))
}

// -------------------------------------------------------------------- cron

#[derive(Debug, Clone, serde::Serialize)]
pub struct CronEvent {
    pub hook: String,
    pub args: String,
    pub next_run_relative: String,
    pub recurrence: String,
}

pub fn cron_events(site: &Site) -> Result<Vec<CronEvent>> {
    let mut c = wp(site)?;
    c.args([
        "cron",
        "event",
        "list",
        "--format=json",
        "--fields=hook,args,next_run_relative,recurrence",
    ]);
    // A site with nothing scheduled makes WP-CLI exit non-zero with
    // "no scheduled events", which is an answer rather than a failure -- and
    // showing it as a red error would be wrong.
    let json = match run(c, "Listing cron events") {
        Ok(v) => v,
        Err(e) => {
            let text = e.to_string().to_lowercase();
            if text.contains("no scheduled") || text.contains("no events") {
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(json.trim())
        .map_err(|e| Error::other(format!("bad cron list: {e}")))?;
    Ok(parsed
        .into_iter()
        .map(|v| {
            let g = |k: &str| match v.get(k) {
                Some(serde_json::Value::String(s)) => s.clone(),
                // Most hooks take no arguments and WP-CLI sends `[]` for them.
                // Rendering that literally puts "[]" in every row.
                Some(serde_json::Value::Array(a)) if a.is_empty() => String::new(),
                Some(serde_json::Value::Array(a)) => a
                    .iter()
                    .map(|x| match x {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            CronEvent {
                hook: g("hook"),
                args: g("args"),
                next_run_relative: g("next_run_relative"),
                recurrence: g("recurrence"),
            }
        })
        .collect())
}

/// Run one hook, or everything that is due.
pub fn cron_run(site: &Site, hook: Option<&str>) -> Result<String> {
    let mut c = wp(site)?;
    c.args(["cron", "event", "run"]);
    match hook {
        Some(h) => {
            c.arg(h);
        }
        None => {
            c.arg("--due-now");
        }
    }
    let out = run(c, "Running cron")?;
    Ok(out.trim().to_string())
}

// ---------------------------------------------------------------- backups

fn downloads_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Downloads")
}

/// Export the database to ~/Downloads and return the file path.
pub fn export_database(site: &Site) -> Result<String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = downloads_dir().join(format!("{}-{stamp}.sql", site.domain));
    let mut c = wp(site)?;
    c.args(["db", "export"]);
    c.arg(&file);
    run(c, "Exporting the database")?;
    Ok(file.to_string_lossy().to_string())
}

pub fn import_database(site: &Site, file: &str) -> Result<String> {
    if !std::path::Path::new(file).exists() {
        return Err(Error::other(format!("{file} is not there.")));
    }
    let mut c = wp(site)?;
    c.args(["db", "import", file]);
    run(c, "Importing the database")?;
    Ok(format!("Imported {file}."))
}

/// WordPress's own WXR content export.
pub fn export_content(site: &Site) -> Result<String> {
    let dir = downloads_dir();
    let mut c = wp(site)?;
    c.args(["export"]);
    c.arg(format!("--dir={}", dir.display()));
    let out = run(c, "Exporting content")?;
    // WP-CLI prints the filename it wrote; hand back the folder either way.
    Ok(if out.trim().is_empty() {
        format!("Exported to {}", dir.display())
    } else {
        out.trim().to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_constants_are_writable() {
        assert!(check_constant("WP_DEBUG").is_ok());
        // The one that would matter: a constant that can break the site.
        assert!(check_constant("DB_PASSWORD").is_err());
        assert!(check_constant("ABSPATH").is_err());
    }

    #[test]
    fn only_curated_options_are_writable() {
        assert!(check_option("blogname").is_ok());
        // Changing these without a search-replace breaks the site's addresses.
        assert!(check_option("siteurl").is_err());
        assert!(check_option("home").is_err());
        assert!(check_option("active_plugins").is_err());
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    #[test]
    fn only_known_constants_leave_wp_config_and_only_true_is_on() {
        let json = r#"[{"name":"DB_PASSWORD","value":"secret","type":"constant"},
            {"name":"WP_DEBUG","value":true,"type":"constant"},
            {"name":"WP_DEBUG_LOG","value":"1","type":"constant"},
            {"name":"WP_DEBUG_DISPLAY","value":false,"type":"constant"},
            {"name":"SCRIPT_DEBUG","value":"","type":"constant"},
            {"name":"table_prefix","value":"wp_","type":"variable"}]"#;
        let c = known_constants(json);
        assert!(!c.contains_key("DB_PASSWORD"));
        assert_eq!(c.get("WP_DEBUG"), Some(&true));
        assert_eq!(c.get("WP_DEBUG_LOG"), Some(&true));
        assert_eq!(c.get("WP_DEBUG_DISPLAY"), Some(&false));
        assert_eq!(c.get("SCRIPT_DEBUG"), Some(&false));
        // Not in the file at all reads as off, and is still listed.
        assert_eq!(c.get("WP_CACHE"), Some(&false));
        assert_eq!(c.len(), KNOWN_CONSTANTS.len());
    }

    #[test]
    fn an_update_is_read_from_the_list_and_nothing_else() {
        let out = r#"[{"version":"7.1.1","update_type":"minor"}]"#;
        let up = newest_update(out).expect("an update");
        assert_eq!(up.version, "7.1.1");
        assert_eq!(up.update_type, "minor");
        // Up to date: WP-CLI says so in words, or lists nothing.
        assert!(newest_update("Success: WordPress is at the latest version.").is_none());
        assert!(newest_update("[]").is_none());
        // A plugin printing before the list does not hide it.
        assert!(newest_update("Notice: something\n[{\"version\":\"7.2\"}]").is_some());
    }

    #[test]
    fn snapshot_php_writes_the_names_into_the_code() {
        // `wp eval` takes no arguments, so the names have to be in the code.
        let php = snapshot_php(&["blogname".into(), "gmt_offset".into()]).unwrap();
        assert!(php.contains("array( 'blogname', 'gmt_offset' )"), "{php}");
        assert!(php.contains("get_locale()"));
        assert!(snapshot_php(&["siteurl".into()]).is_err());
    }

    /// End to end against a real site, for the paths WP-CLI decides:
    /// `NEXORA_LIVE_SITE=~/Nexora/Sites/example cargo test -p nexora-core
    /// live_ -- --ignored --nocapture`. Writes each option back as it is, so
    /// the site is left as it was found.
    #[test]
    #[ignore = "needs a real site and a running database"]
    fn live_reads_and_writes_a_site_s_options() {
        let Ok(docroot) = std::env::var("NEXORA_LIVE_SITE") else {
            panic!("set NEXORA_LIVE_SITE to a site's docroot");
        };
        let site = Site {
            id: 0,
            name: "live".into(),
            domain: "live.test".into(),
            docroot,
            kind: "wordpress".into(),
            php_minor: std::env::var("NEXORA_LIVE_PHP").unwrap_or_else(|_| "8.3".into()),
            server: String::new(),
            enabled: true,
            is_linked: false,
            db_name: None,
            db_engine: None,
            xdebug: false,
            aliases: vec![],
        };

        let keys: Vec<String> = ["blogname", "admin_email", "gmt_offset", "timezone_string", "start_of_week", "posts_per_page", "blog_public"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let snap = settings_snapshot(&site, &keys).expect("snapshot");
        println!("locale: {:?}", snap.locale);
        println!("options: {:?}", snap.options);
        println!("constants: {:?}", snap.constants);
        assert_eq!(snap.options.len(), keys.len(), "every option comes back");
        assert!(!snap.locale.is_empty(), "the locale comes back");

        // Written straight back, so nothing about the site changes.
        for key in ["blogname", "gmt_offset"] {
            let value = snap.options.get(key).cloned().unwrap_or_default();
            option_set(&site, key, &value).unwrap_or_else(|e| panic!("writing {key}: {e}"));
        }
        let again = settings_snapshot(&site, &keys).expect("snapshot again");
        assert_eq!(again.options, snap.options, "the site is as it was");
    }

    #[test]
    fn snapshot_refuses_options_off_the_list() {
        let site = Site {
            id: 0,
            name: "x".into(),
            domain: "x.test".into(),
            docroot: "/nonexistent".into(),
            kind: "wordpress".into(),
            php_minor: "8.3".into(),
            server: String::new(),
            enabled: false,
            is_linked: false,
            db_name: None,
            db_engine: None,
            xdebug: false,
            aliases: vec![],
        };
        assert!(settings_snapshot(&site, &["siteurl".to_string()]).is_err());
    }
}
