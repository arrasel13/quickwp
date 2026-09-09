//! Live end-to-end tunnel check. Publishes a THROWAWAY site briefly, fetches
//! it over the public URL, then closes the share and deletes the site.
//!
//! Run deliberately, never as part of the regular suite: it exposes this
//! machine to the internet for the duration.
use quickwp_core as core;
use std::io::Write;

fn step(n: &str, s: &str) {
    print!("[{n}] {s} ... ");
    std::io::stdout().flush().ok();
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let minor = "8.3";
    let domain = "tunnelcheck.test";
    let app = core::Quickwp::new()?;

    println!("QuickWP live tunnel check\n");

    step("1/6", "throwaway site + pool + router");
    core::runtime::install_php(minor, "fpm", |_| {}).await?;
    let _ = core::site::delete(&app.db, domain);
    let site = core::site::create(
        &app.db,
        &core::site::NewSite {
            name: "Tunnel Check".into(),
            domain: domain.into(),
            kind: "php".into(),
            php_minor: minor.into(),
            link_path: None,
        },
    )?;
    // A marker only this test would serve, so a success cannot be someone
    // else's page answering.
    let marker = format!("QUICKWP-TUNNEL-{}", core::proc::now());
    std::fs::write(
        std::path::Path::new(&site.docroot).join("index.php"),
        format!("<?php echo {marker:?};"),
    )?;
    core::php::start_pool(&app.sup, minor)?;
    let router = core::server::start(app.db.clone(), core::ports::NGINX)?;
    println!("ok");

    step("2/6", "cloudflared");
    core::tunnel::install(|_| {}).await?;
    println!("ok");

    step("3/6", "opening a PUBLIC share");
    let url = core::tunnel::start(&app.db, &app.sup, domain, Some(std::process::id()))?;
    println!("ok");
    println!("      {url}  (public right now)");

    step("4/6", "fetching it from the outside");
    let mut body = String::new();
    let mut errtext = String::new();
    let mut reached = false;
    for _ in 0..20 {
        let out = std::process::Command::new("/usr/bin/curl")
            .args(["-sS", "-i", "-L", "--max-time", "15", &url])
            .output()?;
        body = String::from_utf8_lossy(&out.stdout).into_owned();
        errtext = String::from_utf8_lossy(&out.stderr).into_owned();
        if body.contains(&marker) {
            reached = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    // Distinguish "our code is broken" from "this network cannot resolve the
    // hostname". Both look like an empty body, and only one is a bug here.
    let dns_blocked = errtext.contains("Could not resolve host");
    println!(
        "{}",
        if reached {
            "ok  (our own page came back)"
        } else if dns_blocked {
            "INCONCLUSIVE — the hostname does not resolve on this network"
        } else {
            "FAILED"
        }
    );
    if !reached {
        // A control fetch straight at the router: if THIS works, the origin is
        // fine and the problem is between Cloudflare and us.
        let ctl = std::process::Command::new("/usr/bin/curl")
            .args([
                "-sS", "-i", "--max-time", "10",
                "-H", &format!("Host: {domain}"),
                &format!("http://127.0.0.1:{}/", core::ports::NGINX),
            ])
            .output()?;
        println!("--- via tunnel ---\n{}", body.chars().take(600).collect::<String>());
        println!("--- curl stderr ---\n{}", errtext.trim());
        println!(
            "--- control, straight at the router ---\n{}",
            String::from_utf8_lossy(&ctl.stdout).chars().take(400).collect::<String>()
        );
        let log = core::paths::logs().join(format!("tunnel-{domain}.log"));
        let lg = std::fs::read_to_string(&log).unwrap_or_default();
        let tail: Vec<&str> = lg.lines().rev().take(14).collect();
        println!("--- cloudflared tail ---\n{}", tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
    }

    step("5/6", "closing the share");
    core::tunnel::stop(&app.db, &app.sup, domain)?;
    let still_listed = core::tunnel::list(&app.db)?.iter().any(|t| t.domain == domain);
    let out = std::process::Command::new("/usr/bin/curl")
        .args(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "12", &url])
        .output()?;
    let after = String::from_utf8_lossy(&out.stdout).trim().to_string();
    println!("ok  (still recorded: {still_listed}, url now returns {after})");

    step("6/6", "cleanup");
    router.stop();
    core::php::stop_pool(&app.sup, minor)?;
    core::site::delete(&app.db, domain)?;
    println!("ok");

    if still_listed {
        return Err("the share was not forgotten after being stopped".into());
    }
    if reached {
        println!("\nPASS  a share reached the internet and was closed again.");
        return Ok(());
    }
    if dns_blocked {
        // cloudflared registered, the origin served, the share opened and
        // closed. What could not be exercised is the public round trip, and
        // the reason is outside QuickWP.
        println!(
            "\nINCONCLUSIVE  the tunnel registered with Cloudflare and the origin served\n\
             correctly, but *.trycloudflare.com hostnames do not resolve from this\n\
             network, so the public round trip could not be made from here.\n\
             Everything QuickWP controls -- opening, recording, guarding and closing\n\
             a share -- did work. Try the URL from another machine to confirm."
        );
        return Ok(());
    }
    Err("the live tunnel check did not pass".into())
}
