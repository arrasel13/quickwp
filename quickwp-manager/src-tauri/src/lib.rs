use std::process::Command;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
    success: bool,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PHPVersion {
    version: String,
    full_version: Option<String>,
    status: String, // "installed" or "available"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WordPressSiteConfig {
    site_title: String,
    folder_name: String,
    site_url: String,
    database_name: String,
    wp_version: String,
    enable_debug: bool,
    admin_user: String,
    admin_password: String,
    admin_email: String,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn execute_command(command: String, args: Vec<String>) -> Result<CommandResult, String> {
    let output = Command::new(&command)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(CommandResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

#[tauri::command]
async fn check_prerequisites() -> Result<CommandResult, String> {
    // Check if Laravel Herd is installed and running
    let herd_check = Command::new("herd")
        .arg("--version")
        .output();

    // Check if WP-CLI is installed
    let wp_cli_check = Command::new("wp")
        .arg("--version")
        .output();

    let mut messages = Vec::new();
    let mut success = true;

    match herd_check {
        Ok(output) if output.status.success() => {
            messages.push(format!("✅ Laravel Herd: {}", String::from_utf8_lossy(&output.stdout).trim()));
        }
        _ => {
            messages.push("❌ Laravel Herd not found or not running".to_string());
            success = false;
        }
    }

    match wp_cli_check {
        Ok(output) if output.status.success() => {
            messages.push(format!("✅ WP-CLI: {}", String::from_utf8_lossy(&output.stdout).trim()));
        }
        _ => {
            messages.push("❌ WP-CLI not found".to_string());
            success = false;
        }
    }

    Ok(CommandResult {
        success,
        stdout: messages.join("\n"),
        stderr: String::new(),
        exit_code: if success { Some(0) } else { Some(1) },
    })
}

#[tauri::command]
async fn create_wordpress_site(config: WordPressSiteConfig) -> Result<CommandResult, String> {
    // This is a placeholder for the actual WordPress site creation logic
    // In a real implementation, this would:
    // 1. Create the project directory
    // 2. Download WordPress
    // 3. Set up the database
    // 4. Configure wp-config.php
    // 5. Run the WordPress installation

    let steps = vec![
        "Checking Laravel Herd status...",
        "Creating project directory...",
        "Downloading WordPress...",
        "Setting up database...",
        "Configuring wp-config.php...",
        "Running WordPress installation...",
        "Installing themes and plugins...",
        "Finalizing setup...",
    ];

    let output = format!(
        "WordPress site creation initiated:\n{}\n✅ Site '{}' would be created at {}.test",
        steps.join("\n"),
        config.site_title,
        config.folder_name
    );

    Ok(CommandResult {
        success: true,
        stdout: output,
        stderr: String::new(),
        exit_code: Some(0),
    })
}

#[tauri::command]
async fn open_site_in_browser(url: String) -> Result<(), String> {
    let full_url = if url.starts_with("http") {
        url
    } else {
        format!("http://{}", url)
    };

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&full_url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(&["/C", "start", &full_url])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&full_url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn get_php_versions() -> Result<Vec<PHPVersion>, String> {
    let mut php_versions = Vec::new();

    // List of common PHP versions to check
    let versions_to_check = vec!["8.5", "8.4", "8.3", "8.2", "8.1", "8.0", "7.4"];

    // First, try to get installed versions from Laravel Herd
    let herd_output = Command::new("herd")
        .arg("php")
        .arg("--list")
        .output();

    let mut installed_versions = Vec::new();

    if let Ok(output) = herd_output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Parse the output to get installed versions
            for line in stdout.lines() {
                // Herd output typically shows versions like "php@8.3" or "8.3"
                if let Some(version) = extract_php_version(&line) {
                    installed_versions.push(version);
                }
            }
        }
    }

    // If Herd doesn't work, try checking system PHP installations
    if installed_versions.is_empty() {
        for version in &versions_to_check {
            let php_check = Command::new("php")
                .arg(format!("{}", version))
                .arg("--version")
                .output();

            if let Ok(output) = php_check {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(full_version) = extract_full_php_version(&stdout) {
                        installed_versions.push((version.to_string(), full_version));
                    }
                }
            }
        }

        // Also check default PHP
        let default_php = Command::new("php")
            .arg("--version")
            .output();

        if let Ok(output) = default_php {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(full_version) = extract_full_php_version(&stdout) {
                    let version = extract_major_minor_version(&full_version);
                    if !installed_versions.iter().any(|(v, _)| v == &version) {
                        installed_versions.push((version, full_version));
                    }
                }
            }
        }
    }

    // Build the response with all versions
    for version in versions_to_check {
        let installed = installed_versions.iter()
            .find(|(v, _)| v == version);

        if let Some((_, full_version)) = installed {
            php_versions.push(PHPVersion {
                version: version.to_string(),
                full_version: Some(full_version.clone()),
                status: "installed".to_string(),
            });
        } else {
            php_versions.push(PHPVersion {
                version: version.to_string(),
                full_version: None,
                status: "available".to_string(),
            });
        }
    }

    Ok(php_versions)
}

fn extract_php_version(line: &str) -> Option<(String, String)> {
    // Extract version from Herd output
    // Example: "php@8.3" or "8.3.25"
    let parts: Vec<&str> = line.split_whitespace().collect();
    for part in parts {
        if part.contains("8.") || part.contains("7.") {
            let version_str = part.replace("php@", "");
            let version_parts: Vec<&str> = version_str.split('.').collect();
            if version_parts.len() >= 2 {
                let major_minor = format!("{}.{}", version_parts[0], version_parts[1]);
                return Some((major_minor, version_str));
            }
        }
    }
    None
}

fn extract_full_php_version(output: &str) -> Option<String> {
    // Extract version from "php --version" output
    // Example: "PHP 8.3.25 (cli) (built: ..."
    for line in output.lines() {
        if line.starts_with("PHP ") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                return Some(parts[1].to_string());
            }
        }
    }
    None
}

fn extract_major_minor_version(full_version: &str) -> String {
    let parts: Vec<&str> = full_version.split('.').collect();
    if parts.len() >= 2 {
        format!("{}.{}", parts[0], parts[1])
    } else {
        full_version.to_string()
    }
}

#[tauri::command]
async fn install_php_version(version: String) -> Result<CommandResult, String> {
    // Try to install using Laravel Herd
    let output = Command::new("herd")
        .arg("php")
        .arg("install")
        .arg(&version)
        .output()
        .map_err(|e| format!("Failed to execute herd command: {}", e))?;

    Ok(CommandResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            execute_command,
            check_prerequisites,
            create_wordpress_site,
            open_site_in_browser,
            get_php_versions,
            install_php_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
