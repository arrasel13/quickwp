//! Exercises exactly what the New Site dialog does, in the same order.
//!
//! The dialog previously created a blank PHP site and called it WordPress, and
//! the modal never mounted when the list was empty. Neither was caught because
//! nothing ran this path end to end.
use nexora_core as core;
use std::io::Write;

fn step(n: &str, s: &str) { print!("[{n}] {s} ... "); std::io::stdout().flush().ok(); }

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app = core::Nexora::new()?;
    let minor = "8.3";
    let series = core::runtime::MYSQL_SERIES[0];
    let domain = "createflow.test";

    println!("Nexora New Site flow\n");

    step("1/7", "PHP, MySQL, WP-CLI");
    core::runtime::install_php(minor, "fpm", |_| {}).await?;
    core::runtime::install_php(minor, "cli", |_| {}).await?;
    core::runtime::install_mysql(series, |_| {}).await?;
    core::wordpress::ensure_wp_cli(|_| {}).await?;
    core::database::start(&app.sup, series)?;
    println!("ok");

    step("2/7", "creating the site");
    let _ = core::site::delete(&app.db, domain);
    let _ = core::database::drop_for_site(series, domain);
    let site = core::site::create(&app.db, &core::site::NewSite {
        name: "Create Flow".into(),
        domain: domain.into(),
        kind: "wordpress".into(),
        php_minor: minor.into(),
        link_path: None,
    })?;
    app.ensure_cert(&site)?;
    println!("ok");

    step("3/7", "pool + router");
    core::php::start_pool(&app.sup, minor)?;
    let router = core::server::start(app.db.clone(), core::ports::NGINX)?;
    println!("ok");

    step("4/7", "database + scoped user");
    let creds = core::database::create_for_site(series, domain)?;
    println!("ok  ({})", creds.name);

    step("5/7", "installing WordPress");
    let res = core::wordpress::install(
        &site,
        &core::wordpress::WpInstallRequest {
            title: "Create Flow".into(),
            admin_user: "admin".into(),
            admin_email: "admin@createflow.test".into(),
            admin_password: None,
            version: None,
        },
        series,
        &creds,
        &format!("http://{domain}"),
    )?;
    core::site::set_database(&app.db, site.id, series, &creds.name)?;
    println!("ok  (admin password shown once: {})", res.admin_password);

    step("6/7", "it is actually WordPress, and it serves by name");
    let is_wp = core::wordpress::is_wordpress(&site);
    let version = core::wordpress::core_version(&site).unwrap_or_default();
    let out = std::process::Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "20", "-H", &format!("Host: {domain}"),
               &format!("http://127.0.0.1:{}/", core::ports::NGINX)])
        .output()?;
    let body = String::from_utf8_lossy(&out.stdout);
    let served = body.contains("wp-content") || body.contains("WordPress") || body.contains("Create Flow");
    println!("{}", if is_wp && served { format!("ok  (core {version}, page rendered)") } else { "FAILED".into() });
    if !(is_wp && served) {
        println!("  is_wordpress={is_wp} body={}", body.chars().take(300).collect::<String>());
    }

    step("7/7", "cleanup");
    router.stop();
    core::site::delete(&app.db, domain)?;
    core::database::drop_for_site(series, domain)?;
    core::php::stop_pool(&app.sup, minor)?;
    println!("ok");

    if !(is_wp && served) { return Err("the create flow did not produce a working WordPress site".into()); }
    println!("\nPASS  the New Site flow produces a real WordPress site.");
    Ok(())
}
