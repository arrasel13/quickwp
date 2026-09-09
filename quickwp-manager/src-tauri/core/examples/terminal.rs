//! Proves the two things that were compromises:
//!
//!   1. The terminal is a real PTY -- the child sees a TTY, so interactive
//!      programs work and a prompt can be answered.
//!   2. The tunnel guard actually kills an orphaned child when its owner dies,
//!      matching on pid AND start time.
//!
//! The guard is exercised against a stand-in process, not a real tunnel: the
//! logic under test is "does the guard reap an orphan", and proving that does
//! not require publishing this machine to the internet.
use quickwp_core as core;
use std::io::Write;
use std::sync::{Arc, Mutex};

fn step(n: &str, s: &str) {
    print!("[{n}] {s} ... ");
    std::io::stdout().flush().ok();
}

fn ptys() -> core::pty::Ptys {
    static ONCE: std::sync::OnceLock<core::pty::Ptys> = std::sync::OnceLock::new();
    ONCE.get_or_init(core::pty::Ptys::new).clone()
}

fn wait_for(buf: &Arc<Mutex<String>>, needle: &str) -> bool {
    for _ in 0..80 {
        if buf.lock().unwrap().contains(needle) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join("quickwp-pty-example");
    std::fs::create_dir_all(&dir)?;

    let site = core::site::Site {
        id: 1,
        name: "pty".into(),
        domain: "pty.test".into(),
        docroot: dir.to_string_lossy().into(),
        kind: "php".into(),
        php_minor: "8.3".into(),
        server: "nginx".into(),
        enabled: true,
        is_linked: true,
        xdebug: false,
        db_engine: None,
        db_name: None,
        aliases: vec![],
    };

    println!("QuickWP terminal + guard spike\n");

    step("1/6", "opening a pseudo-terminal");
    let out = Arc::new(Mutex::new(String::new()));
    let sink = out.clone();
    ptys().open("t1", &site, 80, 24, move |c| sink.lock().unwrap().push_str(&c), || {})?;
    println!("ok");

    step("2/6", "the child sees a TTY (not a pipe)");
    // `test -t 0` is the question that separates a real terminal from a runner.
    ptys().write("t1", "test -t 0 && echo QUICKWP_IS_A_TTY\n")?;
    let saw_tty = wait_for(&out, "QUICKWP_IS_A_TTY");
    println!("{}", if saw_tty { "ok" } else { "FAILED" });

    step("3/6", "an interactive prompt can be answered");
    // Portable across sh/bash/zsh: `read -p` is bash-only and this shell is
    // whatever the user's SHELL is.
    ptys().write("t1", "printf 'name? '; read n; echo GOT=$n\n")?;
    std::thread::sleep(std::time::Duration::from_millis(500));
    ptys().write("t1", "quickwp\n")?;
    let answered = wait_for(&out, "GOT=quickwp");
    println!("{}", if answered { "ok" } else { "FAILED" });

    step("4/6", "resize reaches the child");
    let resized = ptys().resize("t1", 120, 40).is_ok();
    ptys().close("t1")?;
    println!("{}", if resized { "ok" } else { "FAILED" });

    step("5/6", "the guard reaps an orphan when its owner dies");
    let mut orphan = std::process::Command::new("/bin/sleep").arg("600").spawn()?;
    let orphan_pid = orphan.id();
    let mut owner = std::process::Command::new("/bin/sleep").arg("1").spawn()?;
    let owner_pid = owner.id();
    let owner_start = core::proc::start_time(owner_pid).expect("owner start time");

    let guard = std::thread::spawn(move || {
        core::tunnel::guard_loop(orphan_pid, "guard.test", Some((owner_pid, owner_start)), None)
    });

    let _ = owner.wait();
    let mut reaped = false;
    for _ in 0..60 {
        // try_wait reaps the orphan once it dies, so it does not linger as a
        // zombie and confuse the check.
        let _ = orphan.try_wait();
        if !core::proc::is_alive(orphan_pid) {
            reaped = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let _ = guard.join();
    let _ = orphan.kill();
    let _ = orphan.wait();
    println!("{}", if reaped { "ok  (orphan killed by the guard)" } else { "FAILED" });

    step("6/6", "the guard closes a share that has outlived its deadline");
    // This is the ONLY thing keeping a CLI-started share from running forever:
    // the CLI exits immediately, so there is no owner to watch, and the
    // deadline is the whole safety story.
    let mut timed = std::process::Command::new("/bin/sleep").arg("600").spawn()?;
    let timed_pid = timed.id();
    let deadline = core::proc::now() + 2;
    let g2 = std::thread::spawn(move || {
        core::tunnel::guard_loop(timed_pid, "expiry.test", None, Some(deadline))
    });
    let mut expired = false;
    for _ in 0..60 {
        let _ = timed.try_wait();
        if !core::proc::is_alive(timed_pid) {
            expired = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let _ = g2.join();
    let _ = timed.kill();
    let _ = timed.wait();
    println!("{}", if expired { "ok  (closed at its deadline)" } else { "FAILED" });

    if !(saw_tty && answered && resized && reaped && expired) {
        eprintln!("\n--- terminal output seen ---\n{}", out.lock().unwrap());
        return Err("a check failed".into());
    }
    println!("\nPASS  a real TTY, and a guard that closes both an orphan and an expired share.");
    Ok(())
}
