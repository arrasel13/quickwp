//! WordPress debug logging, switched from Nexora's Logs tab.
//!
//! Nexora writes one marked block into wp-config.php, right after `<?php`, so
//! its definitions come before any in the file: in PHP the first `define` of
//! a constant wins. The block holds the two standard lines, the site's own
//! custom debug code, or both. A definition of the same constant further down
//! -- the stock `define( 'WP_DEBUG', false );` -- is commented out with a
//! marker while the block is there, because a second `define` would warn on
//! every request, and restored when it goes. Turning everything off leaves
//! wp-config.php byte for byte as it was.
//!
//! Every change is checked with `php -l` before it is written, and written by
//! replacing the file whole, so a typo in custom code can never leave a site
//! that does not load.

use crate::{db::Db, runtime, site::Site, Error, Result};
use std::io::Write;
use std::path::{Path, PathBuf};

const BEGIN: &str = "/* BEGIN Nexora debug: managed from Nexora's Logs tab */";
const BEGIN_PREFIX: &str = "/* BEGIN Nexora debug";
const END: &str = "/* END Nexora debug */";
const STANDARD: &str = "/* Nexora: debug logging */";
const CUSTOM: &str = "/* Nexora: custom debug code */";
const PARKED: &str = "// Nexora debug (restored when turned off): ";

/// The two lines "Enable debug log" adds.
pub const STANDARD_CODE: &str = "define( 'WP_DEBUG', true );\ndefine( 'WP_DEBUG_LOG', true );";

#[derive(Debug, Clone, serde::Serialize)]
pub struct DebugState {
    /// Whether WordPress writes a debug log now, however that was set up.
    pub logging: bool,
    /// Nexora's two standard lines are in wp-config.php.
    pub standard: bool,
    /// The custom code is in wp-config.php.
    pub custom_active: bool,
    /// The custom code in the file, or the last one saved for this site.
    pub custom_code: String,
    pub standard_code: String,
    pub config_path: String,
}

/// The state of a site's debug logging, read from its wp-config.php.
pub fn state(db: &Db, site: &Site) -> Result<DebugState> {
    let path = config_path(site)?;
    let content = read(&path)?;
    Ok(describe(db, site, &path, &content))
}

/// Just whether the site logs, for the Logs tab's list of streams.
pub fn logging(site: &Site) -> bool {
    config_path(site)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|c| logging_on(&c))
        .unwrap_or(false)
}

/// Turn Nexora's two standard lines on or off; custom code stays as it is.
pub fn set_logging(db: &Db, site: &Site, on: bool) -> Result<DebugState> {
    let path = config_path(site)?;
    let content = read(&path)?;
    let (_, custom) = parse(&content);
    let next = rewrite(&content, on, custom.as_deref())?;
    commit(site, &path, &content, &next)?;
    crate::log::info(
        "wordpress",
        &format!("debug logging turned {} for {}", if on { "on" } else { "off" }, site.domain),
    );
    Ok(describe(db, site, &path, &next))
}

/// Put custom debug code into wp-config.php, replacing any there before.
pub fn insert_custom(db: &Db, site: &Site, code: &str) -> Result<DebugState> {
    let code = clean_custom(code)?;
    let path = config_path(site)?;
    let content = read(&path)?;
    let (standard, _) = parse(&content);
    let next = rewrite(&content, standard, Some(&code))?;
    commit(site, &path, &content, &next)?;
    db.set_setting(&custom_key(site), &code)?;
    crate::log::info("wordpress", &format!("custom debug code inserted for {}", site.domain));
    Ok(describe(db, site, &path, &next))
}

/// Take the custom code out of wp-config.php. It stays saved to insert again.
pub fn remove_custom(db: &Db, site: &Site) -> Result<DebugState> {
    let path = config_path(site)?;
    let content = read(&path)?;
    let (standard, custom) = parse(&content);
    if let Some(code) = &custom {
        db.set_setting(&custom_key(site), code)?;
    }
    let next = rewrite(&content, standard, None)?;
    commit(site, &path, &content, &next)?;
    crate::log::info("wordpress", &format!("custom debug code removed for {}", site.domain));
    Ok(describe(db, site, &path, &next))
}

fn custom_key(site: &Site) -> String {
    format!("wp_debug_custom:{}", site.domain)
}

fn describe(db: &Db, site: &Site, path: &Path, content: &str) -> DebugState {
    let (standard, custom) = parse(content);
    let saved = db.setting(&custom_key(site)).ok().flatten().unwrap_or_default();
    DebugState {
        logging: logging_on(content),
        standard,
        custom_active: custom.is_some(),
        custom_code: custom.unwrap_or(saved),
        standard_code: STANDARD_CODE.to_string(),
        config_path: path.to_string_lossy().into_owned(),
    }
}

/// wp-config.php in the docroot, or one level up where WordPress also looks
/// -- unless that folder is another WordPress install.
fn config_path(site: &Site) -> Result<PathBuf> {
    let root = Path::new(&site.docroot);
    let here = root.join("wp-config.php");
    if here.is_file() {
        return Ok(here);
    }
    if let Some(parent) = root.parent() {
        let up = parent.join("wp-config.php");
        if up.is_file() && !parent.join("wp-settings.php").is_file() {
            return Ok(up);
        }
    }
    Err(Error::other(format!(
        "{} has no wp-config.php, so there is nowhere to turn debug logging on",
        site.domain
    )))
}

fn read(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(|e| Error::Io { path: path.to_path_buf(), source: e })
}

/// Check the new file with the site's PHP, then swap it in whole.
fn commit(site: &Site, path: &Path, before: &str, after: &str) -> Result<()> {
    if before == after {
        return Ok(());
    }
    lint(site, after)?;
    let tmp = path.with_file_name(".wp-config.php.nexora-tmp");
    std::fs::write(&tmp, after).map_err(|e| Error::Io { path: tmp.clone(), source: e })?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        Error::Io { path: path.to_path_buf(), source: e }
    })
}

/// `php -l` on the new contents, read from stdin so nothing is written first.
fn lint(site: &Site, content: &str) -> Result<()> {
    let Ok(php) = runtime::php_binary(&site.php_minor) else {
        return Ok(()); // no PHP to check with; the site could not run either
    };
    let mut child = std::process::Command::new(php)
        .args(["-n", "-l"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| Error::other(format!("could not check wp-config.php: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(content.as_bytes());
    }
    let out = child
        .wait_with_output()
        .map_err(|e| Error::other(format!("could not check wp-config.php: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let reason = text
        .lines()
        .map(str::trim)
        .find(|l| l.contains("error"))
        .unwrap_or("PHP reported a syntax error")
        .replace(" in Standard input code", "");
    Err(Error::other(format!(
        "Not saved: that would break wp-config.php. {reason}"
    )))
}

// ------------------------------------------------------------------ editing

/// Custom code as it goes into the block: no PHP tags, no Nexora markers.
fn clean_custom(code: &str) -> Result<String> {
    let mut code = code.trim();
    if let Some(rest) = code.strip_prefix("<?php") {
        code = rest.trim();
    }
    if let Some(rest) = code.strip_suffix("?>") {
        code = rest.trim();
    }
    if code.is_empty() {
        return Err(Error::other("Add some debug code to insert."));
    }
    if code.contains("?>") || code.contains("<?") {
        return Err(Error::other(
            "Leave out PHP open and close tags: the code goes inside wp-config.php's own.",
        ));
    }
    if code.contains(BEGIN_PREFIX) || code.contains(END) {
        return Err(Error::other("The code cannot contain Nexora's own markers."));
    }
    Ok(code.lines().map(str::trim_end).collect::<Vec<_>>().join("\n"))
}

/// Whether Nexora's standard lines are in the file, and the custom code if any.
fn parse(content: &str) -> (bool, Option<String>) {
    let Some(inner) = split_block(content).1 else {
        return (false, None);
    };
    let standard = inner.iter().any(|l| l.trim() == STANDARD);
    let custom = inner
        .iter()
        .position(|l| l.trim() == CUSTOM)
        .map(|at| inner[at + 1..].join("\n"))
        .filter(|c| !c.trim().is_empty());
    (standard, custom)
}

/// The file without Nexora's block, with parked lines restored -- the file as
/// it was before Nexora touched it -- and the block's inner lines if found.
fn split_block(content: &str) -> (String, Option<Vec<String>>) {
    let mut out = String::with_capacity(content.len());
    let mut inner: Vec<String> = Vec::new();
    let mut found = false;
    let mut in_block = false;
    for line in content.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let t = bare.trim();
        if !in_block && !found && t.starts_with(BEGIN_PREFIX) {
            in_block = true;
            continue;
        }
        if in_block {
            if t == END {
                in_block = false;
                found = true;
            } else {
                inner.push(bare.to_string());
            }
            continue;
        }
        let indent_len = bare.len() - bare.trim_start().len();
        if bare.trim_start().starts_with(PARKED) {
            let ending = &line[bare.len()..];
            out.push_str(&bare[..indent_len]);
            out.push_str(&bare.trim_start()[PARKED.len()..]);
            out.push_str(ending);
        } else {
            out.push_str(line);
        }
    }
    if in_block {
        // A block with no end was edited by hand: leave the file alone.
        return (content.to_string(), None);
    }
    (out, found.then_some(inner))
}

/// The whole new file for the chosen state.
fn rewrite(content: &str, standard: bool, custom: Option<&str>) -> Result<String> {
    let nl = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let (base, _) = split_block(content);
    let Some(block) = render(standard, custom, nl) else {
        return Ok(base);
    };
    let names = constants_in(&block);
    let parked = park(&base, &names);
    insert_after_open_tag(&parked, &block, nl)
}

fn render(standard: bool, custom: Option<&str>, nl: &str) -> Option<String> {
    if !standard && custom.is_none() {
        return None;
    }
    let custom_names = custom.map(constants_in).unwrap_or_default();
    let mut lines: Vec<String> = vec![BEGIN.into()];
    if standard {
        lines.push(STANDARD.into());
        for l in STANDARD_CODE.lines() {
            // Custom code that sets the same constant decides it: two defines
            // of one constant warn on every request.
            let clash = defines_in(l).iter().any(|(n, _)| custom_names.contains(n));
            if !clash {
                lines.push(l.into());
            }
        }
    }
    if let Some(code) = custom {
        lines.push(CUSTOM.into());
        lines.extend(code.lines().map(String::from));
    }
    lines.push(END.into());
    Some(lines.join(nl) + nl)
}

/// Comment out active `define`s of the block's constants elsewhere in the file.
fn park(content: &str, names: &[String]) -> String {
    let mut out = String::with_capacity(content.len() + 256);
    for line in content.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let code = bare.trim_start();
        let clashes = code.starts_with("define")
            && defines_in(code).iter().any(|(n, _)| names.contains(n));
        if clashes {
            let indent = &bare[..bare.len() - code.len()];
            out.push_str(indent);
            out.push_str(PARKED);
            out.push_str(code);
            out.push_str(&line[bare.len()..]);
        } else {
            out.push_str(line);
        }
    }
    out
}

fn insert_after_open_tag(content: &str, block: &str, nl: &str) -> Result<String> {
    let mut out = String::with_capacity(content.len() + block.len());
    let mut done = false;
    for line in content.split_inclusive('\n') {
        if !done {
            let bare = line.trim_end_matches(['\r', '\n']);
            if let Some(rest) = bare.trim_start().strip_prefix("<?php") {
                done = true;
                if rest.trim().is_empty() {
                    out.push_str(line);
                    if !line.ends_with('\n') {
                        out.push_str(nl);
                    }
                    out.push_str(block);
                } else {
                    // Code on the same line as the tag: the tag keeps its line.
                    let at = bare.len() - rest.len();
                    out.push_str(&bare[..at]);
                    out.push_str(nl);
                    out.push_str(block);
                    out.push_str(rest.trim_start());
                    out.push_str(&line[bare.len()..]);
                }
                continue;
            }
        }
        out.push_str(line);
    }
    if !done {
        return Err(Error::other("wp-config.php has no <?php tag to put the debug settings after"));
    }
    Ok(out)
}

// ------------------------------------------------------------------ reading

/// Constant names a piece of PHP defines.
fn constants_in(code: &str) -> Vec<String> {
    code.lines().flat_map(|l| defines_in(l).into_iter().map(|(n, _)| n)).collect()
}

/// Every `define( 'NAME', value )` on one line, with the value as written.
fn defines_in(line: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut rest = line;
    while let Some(at) = rest.find("define") {
        let after = &rest[at + "define".len()..];
        rest = after;
        // `defined(` is the check, not the definition.
        if after.starts_with('d') {
            continue;
        }
        let Some(args) = after.trim_start().strip_prefix('(') else { continue };
        let args = args.trim_start();
        let Some(quote) = args.chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
        let Some(end) = args[1..].find(quote) else { continue };
        let name = args[1..1 + end].to_string();
        let tail = args[1 + end + 1..].trim_start();
        let Some(value) = tail.strip_prefix(',') else { continue };
        let value = value.trim_start();
        let close = value.find(')').unwrap_or(value.len());
        found.push((name, value[..close].trim().to_string()));
    }
    found
}

/// Whether WordPress logs with this wp-config.php: WP_DEBUG and WP_DEBUG_LOG
/// both on, reading each constant's first definition as PHP would.
fn logging_on(content: &str) -> bool {
    let mut debug: Option<bool> = None;
    let mut log: Option<bool> = None;
    let mut in_comment = false;
    for line in content.lines() {
        let t = line.trim();
        if in_comment {
            if t.contains("*/") {
                in_comment = false;
            }
            continue;
        }
        if t.starts_with("/*") && !t.contains("*/") {
            in_comment = true;
            continue;
        }
        if t.starts_with("//") || t.starts_with('#') || t.starts_with('*') {
            continue;
        }
        for (name, value) in defines_in(t) {
            let on = truthy(&value);
            match name.as_str() {
                "WP_DEBUG" if debug.is_none() => debug = Some(on),
                "WP_DEBUG_LOG" if log.is_none() => log = Some(on),
                _ => {}
            }
        }
    }
    debug.unwrap_or(false) && log.unwrap_or(false)
}

fn truthy(value: &str) -> bool {
    let v = value.trim().trim_end_matches(';').trim();
    match v.to_ascii_lowercase().as_str() {
        "true" | "1" => true,
        "false" | "0" | "null" | "''" | "\"\"" => false,
        // A path string sends the log there; that is on.
        other => other.starts_with('\'') || other.starts_with('"'),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STOCK: &str = "<?php\n/**\n * The base configuration for WordPress\n */\ndefine( 'DB_NAME', 'wp' );\n\n/* Add any custom values between this line and the \"stop editing\" line. */\n\n/**\n * It is strongly recommended that plugin and theme developers use WP_DEBUG\n */\nif ( ! defined( 'WP_DEBUG' ) ) {\n\tdefine( 'WP_DEBUG', false );\n}\n\n/* That's all, stop editing! Happy publishing. */\nrequire_once ABSPATH . 'wp-settings.php';\n";

    #[test]
    fn enabling_puts_both_lines_first_and_parks_the_old_definition() {
        let on = rewrite(STOCK, true, None).unwrap();
        assert!(on.starts_with(&format!("<?php\n{BEGIN}\n{STANDARD}\n{STANDARD_CODE}\n{END}\n")));
        assert!(on.contains(&format!("\t{PARKED}define( 'WP_DEBUG', false );")));
        assert_eq!(on.matches("define( 'WP_DEBUG',").count(), 2, "one active, one parked");
        assert!(logging_on(&on));
        assert!(!logging_on(STOCK));
        assert_eq!(parse(&on), (true, None));
    }

    #[test]
    fn disabling_leaves_the_file_exactly_as_it_was() {
        let on = rewrite(STOCK, true, None).unwrap();
        let off = rewrite(&on, false, None).unwrap();
        assert_eq!(off, STOCK);
    }

    #[test]
    fn custom_code_goes_in_and_comes_out_cleanly() {
        let code = "define( 'SCRIPT_DEBUG', true );\ndefine( 'SAVEQUERIES', true );";
        let with = rewrite(STOCK, false, Some(code)).unwrap();
        assert_eq!(parse(&with), (false, Some(code.to_string())));
        assert!(!logging_on(&with), "custom code alone did not turn logging on");
        assert_eq!(rewrite(&with, false, None).unwrap(), STOCK);
    }

    #[test]
    fn custom_code_setting_a_standard_constant_is_defined_once() {
        let code = "define( 'WP_DEBUG', true );\ndefine( 'WP_DEBUG_DISPLAY', false );";
        let both = rewrite(STOCK, true, Some(code)).unwrap();
        let active: Vec<_> = both
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .filter(|l| l.contains("define( 'WP_DEBUG',"))
            .collect();
        assert_eq!(active.len(), 1, "{both}");
        assert!(logging_on(&both));
        // Custom out, standard stays; then standard off restores the original.
        let standard_only = rewrite(&both, true, None).unwrap();
        assert_eq!(parse(&standard_only), (true, None));
        assert_eq!(rewrite(&standard_only, false, None).unwrap(), STOCK);
    }

    #[test]
    fn a_crlf_file_round_trips_with_its_line_endings() {
        let crlf = STOCK.replace('\n', "\r\n");
        let on = rewrite(&crlf, true, Some("define( 'SAVEQUERIES', true );")).unwrap();
        assert!(!on.replace("\r\n", "").contains('\n'), "no bare LF was introduced");
        assert_eq!(rewrite(&on, false, None).unwrap(), crlf);
    }

    #[test]
    fn logging_is_read_from_the_first_definition() {
        assert!(logging_on("<?php\ndefine('WP_DEBUG', true);\ndefine('WP_DEBUG_LOG', '/tmp/wp.log');\n"));
        assert!(!logging_on("<?php\ndefine('WP_DEBUG', true);\n// define('WP_DEBUG_LOG', true);\n"));
        assert!(!logging_on("<?php\n/*\ndefine('WP_DEBUG', true);\ndefine('WP_DEBUG_LOG', true);\n*/\n"));
        assert!(!logging_on("<?php\ndefine('WP_DEBUG', false);\ndefine('WP_DEBUG', true);\ndefine('WP_DEBUG_LOG', true);\n"));
    }

    #[test]
    fn custom_code_is_cleaned_and_checked() {
        assert_eq!(clean_custom("<?php\ndefine('A', 1);  \n?>").unwrap(), "define('A', 1);");
        assert!(clean_custom("   ").is_err());
        assert!(clean_custom("define('A', 1); ?> <?php echo 1;").is_err());
        assert!(clean_custom(&format!("{END}")).is_err());
    }

    #[test]
    fn a_hand_broken_block_is_left_alone() {
        let broken = format!("<?php\n{BEGIN}\ndefine( 'WP_DEBUG', true );\nrequire 'x.php';\n");
        let (base, inner) = split_block(&broken);
        assert_eq!(base, broken);
        assert!(inner.is_none());
    }
}
