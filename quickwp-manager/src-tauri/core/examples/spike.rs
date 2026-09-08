//! End-to-end proof of the runtime supply chain.
//!
//!   download -> verify sha256 -> extract -> start pool -> execute PHP
//!
//! Run: cargo run --example spike -- 8.3
use quickwp_core as core;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let minor = std::env::args().nth(1).unwrap_or_else(|| "8.3".into());
    let pin = core::runtime::php_pin(&minor, "fpm")?;

    println!("QuickWP runtime spike");
    println!("  arch      {}", core::runtime::arch());
    println!("  php       {} ({})", pin.patch, pin.minor);
    println!("  url       {}", pin.url);
    println!("  pinned    {}", pin.sha256);
    println!("  port      {}", core::ports::fpm_port(&minor)?);
    println!();

    print!("[1/4] fetching + verifying ... ");
    use std::io::Write;
    std::io::stdout().flush().ok();
    let started = std::time::Instant::now();
    let dir = core::runtime::install_php(&minor, "fpm", |_p| {}).await?;
    println!("ok  ({:.1}s)", started.elapsed().as_secs_f32());
    println!("      -> {}", dir.display());

    print!("[2/4] starting php-fpm pool ... ");
    std::io::stdout().flush().ok();
    let sup = core::supervisor::Supervisor::new();
    let port = core::php::start_pool(&sup, &minor)?;
    println!("ok  (listening on 127.0.0.1:{port})");

    print!("[3/4] executing PHP through FastCGI ... ");
    std::io::stdout().flush().ok();
    let version = core::php::health(&minor)?;
    println!("ok");
    println!("      -> PHP_VERSION reported by the pool: {version}");

    print!("[4/4] stopping pool (and its workers) ... ");
    std::io::stdout().flush().ok();
    core::php::stop_pool(&sup, &minor)?;
    let freed = core::ports::is_free(port);
    println!("ok  (port {port} free: {freed})");

    assert_eq!(version, pin.patch, "the pool must serve the pinned patch");
    assert!(freed, "stopping must not orphan workers holding the port");

    println!("\nPASS  the supply chain holds end to end.");
    Ok(())
}
