//! Process identity.
//!
//! A pid alone is not an identity: pids are recycled, and a guard that kills
//! "pid 4312" some hours later may kill something else entirely. Pairing the
//! pid with the process start time makes it an identity that cannot be
//! accidentally reused.

/// Seconds since the epoch at which the process started, if it is alive.
pub fn start_time(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return None;
    }
    // `date -j -f` parses ps's own format back into an epoch, which avoids
    // hand-rolling a date parser for the one field we need.
    let d = std::process::Command::new("/bin/date")
        .args(["-j", "-f", "%a %b %e %T %Y", &text, "+%s"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&d.stdout).trim().parse().ok()
}

/// Is this pid a process that is still *running*?
///
/// `kill(pid, 0)` is not enough on its own: a ZOMBIE -- a process that has
/// exited but whose parent has not reaped it -- still exists as a pid and still
/// answers signal 0. Treating one as alive means a tunnel that has already died
/// reads as running, so the sweep leaves a dead row in place and a guard waits
/// forever on something that is already gone.
pub fn is_alive(pid: u32) -> bool {
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        return false;
    }
    !is_zombie(pid)
}

/// Has this process exited but not yet been reaped?
pub fn is_zombie(pid: u32) -> bool {
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false; // gone entirely, which `is_alive` already reports
    }
    String::from_utf8_lossy(&out.stdout).trim_start().starts_with('Z')
}

/// Is this exact process still running -- same pid AND same start time?
pub fn is_same_process(pid: u32, start: u64) -> bool {
    match start_time(pid) {
        // A second or two of slack: ps and date round differently.
        Some(now) => now.abs_diff(start) <= 2,
        None => false,
    }
}

/// Terminate a process group, then the process, then insist.
pub fn kill_tree(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
        libc::kill(pid as i32, libc::SIGTERM);
    }
    for _ in 0..30 {
        if !is_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_alive_and_has_a_start_time() {
        let me = std::process::id();
        assert!(is_alive(me));
        let start = start_time(me).expect("our own start time must be readable");
        assert!(is_same_process(me, start));
    }

    #[test]
    fn a_recycled_pid_does_not_match_a_stale_start_time() {
        let me = std::process::id();
        // Same pid, a start time from long ago: not the same process.
        assert!(!is_same_process(me, 1));
    }

    #[test]
    fn an_impossible_pid_is_not_alive() {
        assert!(!is_alive(u32::MAX - 1));
        assert!(start_time(u32::MAX - 1).is_none());
    }

    #[test]
    fn a_zombie_is_not_alive() {
        // A child that has exited but not been reaped still answers signal 0.
        // Counting it as running is how a dead tunnel stays in the table.
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        for _ in 0..50 {
            if is_zombie(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if is_zombie(pid) {
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "a zombie still answers signal 0");
            assert!(!is_alive(pid), "a zombie must not read as alive");
        }
        let _ = child.wait();
        assert!(!is_alive(pid));
    }
}
