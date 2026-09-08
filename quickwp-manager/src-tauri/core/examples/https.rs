//! End-to-end proof of the green lock, without touching anything privileged.
//!
//! Runs the real edge binary on unprivileged ports, so it exercises exactly the
//! code that runs as root on 443 -- same TLS, same SNI resolution, same
//! forwarding -- while proving the certificate chain verifies against our CA.
use quickwp_core as core;
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let minor = "8.3";
    let app = core::Quickwp::new()?;
    let tld = "test";
    let domain = format!("lock.{tld}");

    println!("QuickWP HTTPS spike\n");

    print!("[1/7] certificate authority ... ");
    std::io::stdout().flush().ok();
    core::ca::ensure_ca()?;
    println!("ok  ({})", core::ca::ca_cert_path().display());

    print!("[2/7] site + leaf certificate ... ");
    std::io::stdout().flush().ok();
    let _ = core::site::delete(&app.db, &domain);
    let site = core::site::create(
        &app.db,
        &core::site::NewSite {
            name: "Lock".into(),
            domain: domain.clone(),
            kind: "php".into(),
            php_minor: minor.into(),
            link_path: None,
        },
    )?;
    app.ensure_cert(&site)?;
    let names = vec![domain.clone()];
    assert!(core::ca::covers(&domain, &names), "cert must cover the site name");
    println!("ok");

    print!("[3/7] name-set check catches a new alias ... ");
    std::io::stdout().flush().ok();
    let with_alias = vec![domain.clone(), format!("alias.{tld}")];
    assert!(
        !core::ca::covers(&domain, &with_alias),
        "an uncovered alias must be detected, not assumed covered because files exist"
    );
    println!("ok");

    print!("[4/7] pool + router ... ");
    std::io::stdout().flush().ok();
    core::php::start_pool(&app.sup, minor)?;
    let router = core::server::start(app.db.clone(), core::ports::NGINX)?;
    println!("ok  (router on {})", router.port);

    print!("[5/7] starting the real edge binary (unprivileged ports) ... ");
    std::io::stdout().flush().ok();
    let edge_bin = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/debug/quickwp-edge");
    let mut edge = std::process::Command::new(&edge_bin)
        .arg(core::ca::certs_dir())
        .arg(core::ports::NGINX.to_string())
        .arg("8443")
        .arg("8080")
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let mut up = false;
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", 8443u16)).is_ok() {
            up = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(up, "edge did not bind 8443");
    println!("ok");

    print!("[6/7] HTTPS request, verifying against our CA ... ");
    std::io::stdout().flush().ok();
    let out = std::process::Command::new("/usr/bin/curl")
        .args(["-sS", "--cacert"])
        .arg(core::ca::ca_cert_path())
        .args([
            "--resolve",
            &format!("{domain}:8443:127.0.0.1"),
            &format!("https://{domain}:8443/"),
        ])
        .output()?;
    let body = String::from_utf8_lossy(&out.stdout);
    let err = String::from_utf8_lossy(&out.stderr);
    let ok = out.status.success() && body.contains(&domain) && body.contains("8.3.32");
    println!("{}", if ok { "ok" } else { "FAILED" });
    if !ok {
        println!("--- stderr ---\n{err}\n--- body ---\n{}", &body[..body.len().min(600)]);
    }

    print!("[7/7] cleanup ... ");
    std::io::stdout().flush().ok();
    let _ = edge.kill();
    let _ = edge.wait();
    router.stop();
    core::php::stop_pool(&app.sup, minor)?;
    core::site::delete(&app.db, &domain)?;
    println!("ok");

    if !ok {
        return Err("the HTTPS request did not verify".into());
    }
    println!("\nPASS  TLS terminates on our leaf, verifies against our CA, and PHP answers.");
    Ok(())
}
