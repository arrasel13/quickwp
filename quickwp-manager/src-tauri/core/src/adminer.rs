//! Adminer: a database browser on its own hostname.
//!
//! One pinned PHP file plus a small wrapper, served by the edge at
//! `adminer.nexora.<tld>` through a PHP pool that already exists. There is no
//! second web server and no site record -- Adminer is not a site, and giving it
//! one would put it in the sites list, in the sites directory, and in every
//! count of "how many sites do I have".
//!
//! Two things about that wrapper are load-bearing, and both are worked around
//! rather than patched into Adminer itself, so the pinned file stays byte-for-
//! byte what upstream published:
//!
//!   * Nexora's MySQL root account has no password by design (see
//!     `database::initialize`), and Adminer refuses an empty one. Its auth gate
//!     only attempts a connection when `is_string(get_password())`, which reads
//!     the *session*, not the URL -- so the wrapper seeds the session and
//!     overrides `login()`.
//!
//!   * Adminer sends `X-Frame-Options: deny`. The Database tab shows it in a
//!     frame, so the wrapper drops that header through Adminer's own
//!     `headers()` extension point.
//!
//! Reachable at a real hostname means any page in the browser could point a
//! form at it, so a token is required. It arrives once in the URL Nexora
//! builds and is kept in a cookie afterwards, because Adminer's own links do
//! not carry query parameters it does not know about.

use crate::{db::Db, paths, runtime, Error, Result};
use std::path::PathBuf;

/// The hostname Adminer answers on, under whichever TLD is configured.
///
/// Under `nexora.<tld>` rather than `adminer.<tld>` so the name cannot collide
/// with a site someone actually wants to call "adminer".
pub fn host(tld: &str) -> String {
    format!("adminer.nexora.{tld}")
}

pub fn dir() -> PathBuf {
    paths::root().join("adminer")
}

pub fn php_path() -> PathBuf {
    dir().join("adminer.php")
}

fn index_path() -> PathBuf {
    dir().join("index.php")
}

fn token_path() -> PathBuf {
    dir().join("token")
}

pub fn is_installed() -> bool {
    php_path().exists()
}

/// Fetch and verify Adminer, and write the wrapper beside it. Idempotent.
///
/// The wrapper is rewritten every time rather than only when missing: it is
/// generated code, and a stale copy from an older Nexora is a bug that would
/// otherwise survive an upgrade.
pub async fn ensure(on_progress: impl Fn(runtime::Progress) + Send + 'static) -> Result<PathBuf> {
    let dest = php_path();
    paths::mkdir_p(&dir())?;
    if !dest.exists() {
        runtime::download_verified(
            "Adminer",
            runtime::ADMINER_PIN.url,
            runtime::ADMINER_PIN.sha256,
            &dest,
            on_progress,
        )
        .await?;
    }
    write_wrapper()?;
    token()?;
    Ok(dest)
}

fn write_wrapper() -> Result<()> {
    let path = index_path();
    std::fs::write(&path, WRAPPER).map_err(|e| Error::Io {
        path: path.clone(),
        source: e,
    })
}

/// The token that gates every request, created once and kept.
///
/// Persistent rather than per-run so a URL someone copied into a browser still
/// works after a restart. Mode 0600: it is the only thing standing between a
/// stray web page and the databases.
pub fn token() -> Result<String> {
    let path = token_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if existing.len() >= 32 {
            return Ok(existing);
        }
    }
    paths::mkdir_p(&dir())?;
    let token = random_hex(32);
    std::fs::write(&path, &token).map_err(|e| Error::Io {
        path: path.clone(),
        source: e,
    })?;
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(&path) {
        let mut perm = meta.permissions();
        perm.set_mode(0o600);
        let _ = std::fs::set_permissions(&path, perm);
    }
    Ok(token)
}

/// 2 * `bytes` hex characters from the OS random source.
fn random_hex(bytes: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    // Never silently produce a weak token: a predictable one is worse than an
    // error, because it looks like it is protecting something.
    format!(
        "{:016x}{:016x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
        std::process::id() as u64,
    )
}

/// Where the edge should send a request for the Adminer host.
pub struct Target {
    pub docroot: PathBuf,
    pub php_minor: String,
}

pub fn target(db: &Db) -> Result<Target> {
    if !is_installed() {
        return Err(Error::NotInstalled {
            component: "Adminer".into(),
        });
    }
    Ok(Target {
        docroot: dir(),
        php_minor: db.default_php()?,
    })
}

/// The URL that opens one database, already logged in.
pub fn url(tld: &str, mysql_port: u16, database: &str, token: &str) -> String {
    // `server` carries the port, so it needs the colon percent-encoded or
    // Adminer reads the query string as ending at the port.
    let server = format!("127.0.0.1%3A{mysql_port}");
    format!(
        "https://{}/?server={}&username=root&db={}&nexora_auth={}",
        host(tld),
        server,
        urlencode(database),
        token,
    )
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The wrapper. See the module docs for why each override exists.
const WRAPPER: &str = r#"<?php
// Generated by Nexora. Edits are overwritten -- change core/src/adminer.rs.

// Adminer answers on a real hostname, so any page in the browser could point a
// form at it. The token is what stops that. It arrives once in the URL Nexora
// builds, then lives in a cookie, because Adminer's own links do not carry
// query parameters it does not know about.
$expected = @file_get_contents(__DIR__ . '/token');
$expected = ($expected === false) ? '' : trim($expected);
$given = '';
if (isset($_GET['nexora_auth'])) {
    $given = $_GET['nexora_auth'];
} elseif (isset($_COOKIE['nexora_auth'])) {
    $given = $_COOKIE['nexora_auth'];
}
if ($expected === '' || !hash_equals($expected, (string) $given)) {
    header('HTTP/1.1 403 Forbidden');
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><title>Not for this tab</title>';
    echo '<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:34rem;color:#1f2937}</style>';
    echo '<h1 style="font-size:1.1rem">Not for this tab</h1>';
    echo '<p>This database browser only opens from Nexora, which puts a one-time key in the address. ';
    echo 'Open it from a site&rsquo;s <b>Database</b> tab.</p>';
    exit;
}
if (isset($_GET['nexora_auth'])) {
    setcookie('nexora_auth', $expected, [
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function adminer_object() {
    // Adminer has started its session by this point and has not yet reached its
    // auth gate. That gate only attempts a connection when
    // is_string(get_password()), and get_password() reads the session rather
    // than the URL -- so seeding it here is what turns "show a login form" into
    // "connect as root". Nexora's MySQL root has no password by design: the
    // socket is loopback-only.
    $server   = isset($_GET['server']) ? $_GET['server'] : '';
    $username = isset($_GET['username']) ? $_GET['username'] : 'root';
    $_SESSION['pwds']['server'][$server][$username] = '';

    class QuickWpAdminer extends \Adminer\Adminer {
        function credentials() {
            return array(\Adminer\SERVER, $_GET['username'], '');
        }

        function login($login, $password) {
            return true;
        }

        function headers() {
            // page_headers() sends "X-Frame-Options: deny" and then calls this.
            // Nexora shows Adminer inside its own Database tab, so the frame
            // ban has to go. Nothing here is reachable off this machine.
            header_remove('X-Frame-Options');
        }
    }

    return new QuickWpAdminer;
}

include __DIR__ . '/adminer.php';
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_cannot_collide_with_a_site_called_adminer() {
        assert_eq!(host("test"), "adminer.nexora.test");
        assert_ne!(host("test"), "adminer.test");
    }

    #[test]
    fn the_url_encodes_the_port_colon_and_the_database_name() {
        let u = url("test", 13316, "wp_my-site", "abc123");
        assert!(u.contains("server=127.0.0.1%3A13316"), "{u}");
        assert!(u.contains("db=wp_my-site"), "{u}");
        assert!(u.contains("nexora_auth=abc123"), "{u}");
        assert!(u.starts_with("https://adminer.nexora.test/"), "{u}");
    }

    #[test]
    fn a_database_name_with_odd_characters_survives_the_query_string() {
        let u = url("test", 13316, "a b&c", "t");
        assert!(u.contains("db=a%20b%26c"), "{u}");
    }

    #[test]
    fn tokens_are_long_and_not_repeated() {
        let a = random_hex(32);
        let b = random_hex(32);
        assert_eq!(a.len(), 64);
        assert_ne!(a, b, "two tokens in a row must not match");
    }
}
