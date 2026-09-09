//! Verifies the two single-binary tools install, verify and run.
//!
//! Deliberately does NOT open a tunnel: that publishes this machine to the
//! internet, which is a decision for the person at the keyboard.
use quickwp_core as core;
use std::io::Write;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app = core::Quickwp::new()?;
    println!("QuickWP tools spike\n");

    print!("[1/4] mailpit: fetch + verify ... ");
    std::io::stdout().flush().ok();
    let mp = core::mail::install(|_| {}).await?;
    println!("ok  ({})", mp.display());

    print!("[2/4] mailpit: start + answer on its UI port ... ");
    std::io::stdout().flush().ok();
    let port = core::mail::start(&app.sup)?;
    let reachable = std::net::TcpStream::connect(("127.0.0.1", port)).is_ok();
    println!("{}", if reachable { format!("ok  (:{port})") } else { "FAILED".into() });
    core::mail::stop(&app.sup)?;

    print!("[3/4] cloudflared: fetch + verify ... ");
    std::io::stdout().flush().ok();
    let cf = core::tunnel::install(|_| {}).await?;
    let out = std::process::Command::new(&cf).arg("--version").output()?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    println!("ok  ({version})");
    println!("      no tunnel opened: sharing publishes this machine, so it stays a decision");

    print!("[4/4] the sendmail shim points at Mailpit ... ");
    std::io::stdout().flush().ok();
    let shim = core::mail::sendmail_path()?;
    let ok = shim.contains(&core::ports::MAILPIT_SMTP.to_string()) && shim.contains("sendmail");
    println!("{}", if ok { "ok" } else { "FAILED" });

    if !reachable || !ok {
        return Err("a tool did not come up".into());
    }
    println!("\nPASS  Mailpit and cloudflared install, verify and run.");
    Ok(())
}
