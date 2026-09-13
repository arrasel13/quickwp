//! The local certificate authority.
//!
//! Nexora generates a CA on your machine and asks, once, for permission to
//! trust it. Every site then gets a leaf signed by that CA, so the browser
//! shows a real green lock -- not a bypassed warning, not an exception you
//! clicked through.
//!
//! Three properties, each deliberate:
//!
//!   * The CA signs only your local sites. It is not a general-purpose
//!     authority for your machine.
//!   * The private key never leaves this Mac and is not shared between
//!     machines.
//!   * Trust lives in your LOGIN keychain, not the System keychain. That is a
//!     limit on blast radius: the trust is yours rather than the machine's, and
//!     removing it needs no admin rights.

use crate::{paths, Error, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType,
};
use std::path::PathBuf;

/// Safari and WebKit reject certificates valid for longer than 398 days
/// outright. A 10-year leaf would work in Chrome and fail in Safari with the CA
/// perfectly trusted, which is the most confusing failure in this whole area.
const LEAF_DAYS: i64 = 397;
const CA_YEARS: i64 = 10;

pub fn ca_dir() -> PathBuf {
    paths::config().join("ca")
}
pub fn ca_cert_path() -> PathBuf {
    ca_dir().join("nexora-ca.pem")
}
pub fn ca_key_path() -> PathBuf {
    ca_dir().join("nexora-ca.key")
}
/// Where leaf certificates live.
///
/// The shared location when it exists, because that is the only place the root
/// edge can read from. Falls back to the app's own directory before the system
/// install has run -- and for tests, which never involve a root daemon.
pub fn certs_dir() -> PathBuf {
    if paths::shared_certs_usable() {
        return paths::shared_certs();
    }
    local_certs_dir()
}

pub fn local_certs_dir() -> PathBuf {
    paths::config().join("certs")
}

/// Copy any certificates issued before the shared location existed.
///
/// Without this, every site created before turning on HTTPS would have a
/// certificate the edge cannot see, and would fail its TLS handshake with no
/// explanation.
pub fn migrate_to_shared() -> Result<usize> {
    if !paths::shared_certs_usable() {
        return Ok(0);
    }
    let from = local_certs_dir();
    let to = paths::shared_certs();
    if from == to || !from.is_dir() {
        return Ok(0);
    }
    let mut n = 0;
    for entry in std::fs::read_dir(&from).into_iter().flatten().flatten() {
        let p = entry.path();
        let Some(name) = p.file_name() else { continue };
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "pem" && ext != "key" {
            continue;
        }
        let dest = to.join(name);
        if std::fs::copy(&p, &dest).is_ok() {
            if ext == "key" {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600));
            }
            n += 1;
        }
    }
    Ok(n)
}

pub fn site_cert_path(domain: &str) -> PathBuf {
    certs_dir().join(format!("{domain}.pem"))
}
pub fn site_key_path(domain: &str) -> PathBuf {
    certs_dir().join(format!("{domain}.key"))
}

pub fn ca_exists() -> bool {
    ca_cert_path().exists() && ca_key_path().exists()
}

/// Create the CA if it does not exist. Idempotent.
pub fn ensure_ca() -> Result<()> {
    if ca_exists() {
        return Ok(());
    }
    paths::mkdir_p(&ca_dir())?;

    let key = KeyPair::generate().map_err(|e| Error::other(format!("CA key: {e}")))?;

    let mut params = CertificateParams::new(Vec::<String>::new())
        .map_err(|e| Error::other(format!("CA params: {e}")))?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Nexora Local CA");
    dn.push(DnType::OrganizationName, "Nexora");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.not_before = now_minus_a_day();
    params.not_after = days_from_now(CA_YEARS * 365);

    let cert = params
        .self_signed(&key)
        .map_err(|e| Error::other(format!("CA self-sign: {e}")))?;

    write_private(&ca_key_path(), &key.serialize_pem())?;
    std::fs::write(ca_cert_path(), cert.pem()).map_err(|e| Error::Io {
        path: ca_cert_path(),
        source: e,
    })?;
    Ok(())
}

fn load_issuer() -> Result<(Issuer<'static, KeyPair>, String)> {
    let key_pem = std::fs::read_to_string(ca_key_path()).map_err(|e| Error::Io {
        path: ca_key_path(),
        source: e,
    })?;
    let cert_pem = std::fs::read_to_string(ca_cert_path()).map_err(|e| Error::Io {
        path: ca_cert_path(),
        source: e,
    })?;
    let key = KeyPair::from_pem(&key_pem).map_err(|e| Error::other(format!("CA key: {e}")))?;
    let issuer = Issuer::from_ca_cert_pem(&cert_pem, key)
        .map_err(|e| Error::other(format!("CA cert: {e}")))?;
    Ok((issuer, cert_pem))
}

/// Issue one leaf covering every name a site answers on.
///
/// The whole name set goes on one certificate. Issuing per-name would mean a
/// browser hitting an alias gets a certificate that does not cover it, which
/// is the interstitial this system exists to prevent.
pub fn issue_for(domain: &str, names: &[String]) -> Result<()> {
    ensure_ca()?;
    paths::mkdir_p(&certs_dir())?;
    let (issuer, _) = load_issuer()?;

    let key = KeyPair::generate().map_err(|e| Error::other(format!("leaf key: {e}")))?;
    let mut params = CertificateParams::new(Vec::<String>::new())
        .map_err(|e| Error::other(format!("leaf params: {e}")))?;

    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, domain);
    params.distinguished_name = dn;

    let mut sans = Vec::new();
    for n in names {
        sans.push(
            SanType::DnsName(
                n.clone()
                    .try_into()
                    .map_err(|_| Error::other(format!("`{n}` is not a valid DNS name")))?,
            ),
        );
        // A subdomain multisite network serves sub.network.test, and each of
        // those needs to be trusted. One wildcard SAN covers the whole network
        // rather than a certificate per subsite.
        let wildcard = format!("*.{n}");
        sans.push(SanType::DnsName(wildcard.try_into().map_err(|_| {
            Error::other(format!("`*.{n}` is not a valid DNS name"))
        })?));
    }
    params.subject_alt_names = sans;
    params.not_before = now_minus_a_day();
    params.not_after = days_from_now(LEAF_DAYS);
    params.use_authority_key_identifier_extension = true;

    let cert = params
        .signed_by(&key, &issuer)
        .map_err(|e| Error::other(format!("leaf sign: {e}")))?;

    write_private(&site_key_path(domain), &key.serialize_pem())?;
    std::fs::write(site_cert_path(domain), cert.pem()).map_err(|e| Error::Io {
        path: site_cert_path(domain),
        source: e,
    })?;
    Ok(())
}

/// Whether the certificate on disk covers exactly this name set.
///
/// Compared against the recorded NAME SET rather than "do the files exist".
/// "The files exist" leaves a valid certificate for yesterday's names while the
/// browser warns on the alias added a minute ago.
pub fn covers(domain: &str, names: &[String]) -> bool {
    let Ok(pem) = std::fs::read_to_string(site_cert_path(domain)) else {
        return false;
    };
    let Some(der) = rustls_pemfile::certs(&mut pem.as_bytes()).next().and_then(|c| c.ok()) else {
        return false;
    };
    let Ok((_, parsed)) = x509_parser::parse_x509_certificate(&der) else {
        return false;
    };
    let Ok(Some(san)) = parsed.subject_alternative_name() else {
        return false;
    };
    let present: Vec<String> = san
        .value
        .general_names
        .iter()
        .filter_map(|g| match g {
            x509_parser::extensions::GeneralName::DNSName(n) => Some(n.to_string()),
            _ => None,
        })
        .collect();
    names.iter().all(|n| present.iter().any(|p| p == n))
}

/// Is the CA trusted in the login keychain?
pub fn is_trusted() -> bool {
    if !ca_exists() {
        return false;
    }
    std::process::Command::new("/usr/bin/security")
        .args(["verify-cert", "-c"])
        .arg(ca_cert_path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Trust the CA in the LOGIN keychain.
///
/// macOS asks for the login password here rather than an admin one, because a
/// user keychain is a user-level store -- which is exactly why it is used.
pub fn trust() -> Result<()> {
    ensure_ca()?;
    let keychain = dirs::home_dir()
        .ok_or_else(|| Error::other("no home directory"))?
        .join("Library/Keychains/login.keychain-db");

    let out = std::process::Command::new("/usr/bin/security")
        .arg("add-trusted-cert")
        .arg("-r")
        .arg("trustRoot")
        .arg("-k")
        .arg(&keychain)
        .arg(ca_cert_path())
        .output()
        .map_err(|e| Error::Io {
            path: "/usr/bin/security".into(),
            source: e,
        })?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("User canceled") || err.contains("UserCanceled") {
            return Err(Error::other(
                "Trusting the certificate authority was cancelled. \
                 Sites will still serve, but the browser will warn until you trust it. \
                 You can run this again from General → HTTPS.",
            ));
        }
        return Err(Error::other(format!(
            "Could not trust the certificate authority: {}",
            err.trim()
        )));
    }
    Ok(())
}

/// Let Firefox trust the CA as well.
///
/// Firefox keeps its own certificate store and ignores the macOS keychain
/// unless told otherwise. Its supported enterprise policy, `Certificates` ->
/// `ImportEnterpriseRoots`, tells it to import the roots trusted in the
/// keychain. Written to the user's own `org.mozilla.firefox` preferences: no
/// admin rights, and nothing inside the Firefox app is touched. Returns false
/// when Firefox is not installed, which is not an error.
pub fn trust_in_firefox() -> Result<bool> {
    let installed = ["/Applications/Firefox.app", "/Applications/Firefox Developer Edition.app"]
        .iter()
        .any(|p| std::path::Path::new(p).is_dir())
        || dirs::home_dir().map_or(false, |h| h.join("Applications/Firefox.app").is_dir());
    if !installed {
        return Ok(false);
    }
    for args in [
        vec!["write", "org.mozilla.firefox", "EnterprisePoliciesEnabled", "-bool", "true"],
        vec!["write", "org.mozilla.firefox", "Certificates", "-dict", "ImportEnterpriseRoots", "-bool", "true"],
    ] {
        let out = std::process::Command::new("/usr/bin/defaults")
            .args(&args)
            .output()
            .map_err(|e| Error::Io { path: "/usr/bin/defaults".into(), source: e })?;
        if !out.status.success() {
            return Err(Error::other(format!(
                "Could not set Firefox to trust the certificate authority: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
    }
    Ok(true)
}

/// Remove the CA trust. Part of "Remove system changes".
pub fn untrust() -> Result<()> {
    if !ca_cert_path().exists() {
        return Ok(());
    }
    let _ = std::process::Command::new("/usr/bin/security")
        .arg("remove-trusted-cert")
        .arg(ca_cert_path())
        .output();
    Ok(())
}

fn write_private(path: &std::path::Path, pem: &str) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    paths::mkdir_p(path.parent().unwrap())?;
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600) // a private key is readable by its owner and nobody else
        .open(path)
        .map_err(|e| Error::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
    f.write_all(pem.as_bytes()).map_err(|e| Error::Io {
        path: path.to_path_buf(),
        source: e,
    })
}

fn days_from_now(days: i64) -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc() + time::Duration::days(days)
}

fn now_minus_a_day() -> time::OffsetDateTime {
    days_from_now(-1)
}
