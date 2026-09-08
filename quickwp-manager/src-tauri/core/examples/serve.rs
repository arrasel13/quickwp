//! End-to-end proof that a site actually serves.
//!
//!   create site -> start pool -> start edge -> HTTP request -> PHP output
//!   then: stop the site and prove it answers its OWN 503, not a neighbour's page.
use quickwp_core as core;

fn get(port: u16, host: &str) -> std::io::Result<String> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port))?;
    write!(s, "GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")?;
    let mut out = String::new();
    s.read_to_string(&mut out)?;
    Ok(out)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let minor = "8.3";
    let app = core::Quickwp::new()?;

    println!("QuickWP serving spike\n");

    print!("[1/6] ensuring PHP {minor} ... ");
    use std::io::Write;
    std::io::stdout().flush().ok();
    core::runtime::install_php(minor, "fpm", |_| {}).await?;
    println!("ok");

    print!("[2/6] creating two sites ... ");
    std::io::stdout().flush().ok();
    for d in ["alpha.test", "beta.test"] {
        let _ = core::site::delete(&app.db, d);
        core::site::create(
            &app.db,
            &core::site::NewSite {
                name: d.split('.').next().unwrap().to_string(),
                domain: d.to_string(),
                kind: "php".into(),
                php_minor: minor.into(),
                link_path: None,
            },
        )?;
    }
    println!("ok  (alpha.test, beta.test)");

    print!("[3/6] starting pool + edge ... ");
    std::io::stdout().flush().ok();
    core::php::start_pool(&app.sup, minor)?;
    let edge = core::server::start(app.db.clone(), core::ports::NGINX)?;
    println!("ok  (edge on 127.0.0.1:{})", edge.port);

    print!("[4/6] GET alpha.test ... ");
    std::io::stdout().flush().ok();
    let body = get(edge.port, "alpha.test")?;
    let served_php = body.contains("8.3.32") && body.contains("alpha.test");
    println!("{}", if served_php { "ok  (PHP executed, correct site)" } else { "FAILED" });
    if !served_php {
        println!("--- response ---\n{}", &body[..body.len().min(900)]);
        return Err("alpha.test did not serve its own PHP".into());
    }

    print!("[5/6] stopping alpha.test only ... ");
    std::io::stdout().flush().ok();
    core::site::set_enabled(&app.db, "alpha.test", false)?;
    let stopped = get(edge.port, "alpha.test")?;
    let beta = get(edge.port, "beta.test")?;
    let correct = stopped.contains("503")
        && stopped.contains("This site is stopped")
        && !stopped.contains("beta")
        && beta.contains("beta.test")
        && beta.contains("8.3.32");
    println!("{}", if correct { "ok" } else { "FAILED" });
    println!("      alpha -> its own 503 page, naming itself, not beta's content");
    println!("      beta  -> still serving normally");
    if !correct {
        return Err("a stopped site must answer for itself in every tier".into());
    }

    print!("[6/6] cleaning up ... ");
    std::io::stdout().flush().ok();
    edge.stop();
    core::php::stop_pool(&app.sup, minor)?;
    for d in ["alpha.test", "beta.test"] {
        core::site::delete(&app.db, d)?;
    }
    println!("ok");

    println!("\nPASS  sites serve, and a stopped site answers for itself.");
    Ok(())
}
