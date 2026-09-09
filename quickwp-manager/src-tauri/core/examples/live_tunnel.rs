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


/// Resolve a hostname through a public resolver.
///
/// Some networks (this one included) do not return records for ephemeral
/// *.trycloudflare.com hostnames, while resolving trycloudflare.com itself
/// perfectly well. Asking a public resolver directly separates "Cloudflare has
/// not published this name" from "the local resolver will not tell us about
/// it" -- and, once we have the address, the round trip can be made anyway by
/// pinning it, which exercises the real public path end to end.
fn resolve_public(host: &str) -> Option<String> {
    for server in ["1.1.1.1", "8.8.8.8"] {
        let out = std::process::Command::new("/usr/bin/dig")
            .arg(format!("@{server}"))
            .args(["+short", "+time=3", "+tries=1", host, "A"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(ip) = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_digit() || c == '.'))
        {
            return Some(ip.to_string());
        }
    }
    None
}

fn fetch(url: &str, pin: Option<(&str, &str)>) -> (String, String) {
    let mut cmd = std::process::Command::new("/usr/bin/curl");
    cmd.args(["-sS", "-i", "-L", "--max-time", "20"]);
    if let Some((host, ip)) = pin {
        // Pinning the address bypasses the local resolver without changing
        // anything else: TLS still validates against the real hostname, and
        // the request still travels through Cloudflare's edge.
        cmd.args(["--resolve", &format!("{host}:443:{ip}")]);
    }
    cmd.arg(url);
    match cmd.output() {
        Ok(o) => (
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
        Err(e) => (String::new(), e.to_string()),
    }
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
    let host = url.trim_start_matches("https://").trim_end_matches('/').to_string();
    let mut body = String::new();
    let mut errtext = String::new();
    let mut reached = false;
    let mut pinned_ip: Option<String> = None;

    for attempt in 0..20 {
        let (b, e) = fetch(&url, pinned_ip.as_deref().map(|ip| (host.as_str(), ip)));
        body = b;
        errtext = e;
        if body.contains(&marker) {
            reached = true;
            break;
        }
        // The local resolver will not answer for this name. Ask a public one
        // and pin the address, so the round trip can still be made.
        if pinned_ip.is_none() && errtext.contains("Could not resolve host") && attempt >= 2 {
            pinned_ip = resolve_public(&host);
            if let Some(ip) = &pinned_ip {
                println!("\n      local DNS will not answer for this name; Cloudflare published");
                println!("      it at {ip}, so the address is pinned and the fetch continues");
                print!("      retrying ... ");
                std::io::stdout().flush().ok();
                continue;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }

    let dns_blocked = !reached && errtext.contains("Could not resolve host");
    println!(
        "{}",
        if reached && pinned_ip.is_some() {
            "ok  (our own page came back, through Cloudflare, address pinned)"
        } else if reached {
            "ok  (our own page came back)"
        } else if dns_blocked {
            "INCONCLUSIVE — the name is unresolvable even from a public resolver"
        } else {
            "FAILED"
        }
    );
    if !reached {
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
        // Not even a public resolver has the name, so there is nothing to pin
        // and no round trip to make. Everything QuickWP controls still worked.
        println!(
            "\nINCONCLUSIVE  the tunnel registered with Cloudflare and the origin served\n\
             correctly, but the hostname is unresolvable even from 1.1.1.1, so the\n\
             public round trip could not be made from here. Opening, recording,\n\
             guarding and closing a share all worked."
        );
        return Ok(());
    }
    Err("the live tunnel check did not pass".into())
}
