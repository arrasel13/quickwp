
/// Installed, but not up. Usually means something else holds 443.
pub fn daemon_installed_but_stopped() -> bool {
    daemon_plist_path().exists() && !daemon_running()
}
