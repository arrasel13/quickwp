//! End-to-end proof of phases 5 and 6:
//!
//!   MySQL installed and initialised -> database + scoped user -> WordPress
//!   core installed -> served over real HTTPS -> WP-CLI manages it.
use nexora_core as core;
use std::io::Write;

fn step(n: &str, s: &str) {
    print!("[{n}] {s} ... ");
    std::io::stdout().flush().ok();
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let minor = "8.3";
    let series = "8.4";
    let domain = "wptest.test";
    let app = core::Nexora::new()?;

    println!("Nexora WordPress spike\n");

    step("1/9", "PHP + WP-CLI");
    core::runtime::install_php(minor, "fpm", |_| {}).await?;
    core::runtime::install_php(minor, "cli", |_| {}).await?;
    core::wordpress::ensure_wp_cli(|_| {}).await?;
    println!("ok  (wp-cli {})", core::runtime::WPCLI_PIN.version);

    step("2/9", "MySQL (large download on a cold start)");
    let t = std::time::Instant::now();
    core::runtime::install_mysql(series, |_| {}).await?;
    println!("ok  ({:.0}s)", t.elapsed().as_secs_f32());

    step("3/9", "starting MySQL");
    let port = core::database::start(&app.sup, series)?;
    println!("ok  (127.0.0.1:{port})");

    step("4/9", "site + certificate");
    let _ = core::site::delete(&app.db, domain);
    let _ = core::database::drop_for_site(series, domain);
    let site = core::site::create(
        &app.db,
        &core::site::NewSite {
            name: "WP Test".into(),
            domain: domain.into(),
            kind: "wordpress".into(),
            php_minor: minor.into(),
            link_path: None,
        },
    )?;
    app.ensure_cert(&site)?;
    println!("ok");

    step("5/9", "database + scoped user");
    let creds = core::database::create_for_site(series, domain)?;
    println!("ok  (db `{}`, user `{}`)", creds.name, creds.user);

    step("6/9", "installing WordPress");
    let t = std::time::Instant::now();
    core::php::start_pool(&app.sup, minor)?;
    // WordPress writes its own URL into the database and serves redirects to
    // it, so the install URL must match the address this harness listens on.
    // The app installs with https://<domain> because the real edge holds 443.
    let url = format!("https://{domain}:8443");
    let res = core::wordpress::install(
        &site,
        &core::wordpress::WpInstallRequest {
            title: "Nexora Test".into(),
            admin_user: "admin".into(),
            admin_email: "admin@example.test".into(),
            admin_password: None,
            version: None,
        },
        series,
        &creds,
        &url,
    )?;
    println!("ok  ({:.0}s)", t.elapsed().as_secs_f32());
    println!("      core {}", core::wordpress::core_version(&site)?);
    println!("      admin password generated and shown once: {}", res.admin_password);

    step("7/9", "serving it over HTTPS");
    let router = core::server::start(app.db.clone(), core::ports::NGINX)?;
    let edge_bin = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/debug/nexora-edge");
    let mut edge = std::process::Command::new(&edge_bin)
        .arg(core::ca::certs_dir())
        .arg(core::ports::NGINX.to_string())
        .arg("8443")
        .arg("8080")
        .stderr(std::process::Stdio::null())
        .spawn()?;
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", 8443u16)).is_ok() { break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let out = std::process::Command::new("/usr/bin/curl")
        .args(["-sS", "-L", "-i", "--cacert"])
        .arg(core::ca::ca_cert_path())
        .args(["--resolve", &format!("{domain}:8443:127.0.0.1"), &format!("https://{domain}:8443/")])
        .output()?;
    let body = String::from_utf8_lossy(&out.stdout);
    let curl_err = String::from_utf8_lossy(&out.stderr);
    let served = body.contains("Nexora Test") || body.contains("wp-content") || body.contains("WordPress");
    println!("{}", if served { "ok  (WordPress rendered over TLS)" } else { "FAILED" });
    if !served {
        println!("--- curl stderr ---\n{}", curl_err.trim());
        println!("--- response ---\n{}", &body[..body.len().min(1200)]);
    }

    step("8/9", "WP-CLI manages the site");
    let plugins = core::wordpress::plugins(&site)?;
    let dry = core::wordpress::search_replace(&site, "https://old.test", "https://new.test", true)?;
    println!("ok  ({} plugin(s); search-replace dry run returned {} bytes)", plugins.len(), dry.len());

    step("9/9", "cleanup");
    let _ = edge.kill();
    let _ = edge.wait();
    router.stop();
    core::site::delete(&app.db, domain)?;
    core::database::drop_for_site(series, domain)?;
    core::database::stop(&app.sup, series)?;
    core::php::stop_pool(&app.sup, minor)?;
    println!("ok");

    if !served {
        return Err("WordPress did not render over HTTPS".into());
    }
    println!("\nPASS  WordPress installs on MySQL and serves over a trusted certificate.");
    Ok(())
}
