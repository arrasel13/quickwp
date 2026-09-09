//! The `quickwp` CLI.
//!
//! A thin shell over `quickwp-core` -- the same crate the app's Tauri commands
//! sit on. That is the point: `quickwp site create` and the New Site dialog run
//! the same code, so the two cannot drift and the documented defaults are the
//! real ones.
//!
//! Exit codes: 0 ok, 1 the command failed, 2 bad usage.

use quickwp_core as core;

const USAGE: &str = r#"quickwp — a native local WordPress environment

USAGE
  quickwp <command> [args]

STACK
  status                       Services, sites and HTTPS state
  start                        Start the shared stack
  stop                         Stop the shared stack
  doctor                       Diagnose ports, DNS and certificate trust
  system preflight             Everything checked before HTTPS asks for a password
  system verify                Measure what is actually installed and working

SITES
  site list                    Every site and whether it is serving
  site create <domain> [--php <minor>] [--path <folder>] [--type <kind>]
  site delete <domain>
  site start <domain>          Serve this site again
  site stop <domain>           Stop serving THIS site; the stack keeps running
  site php <domain> <minor>    Switch a site's PHP version
  site domains <domain> --add <name>

PHP
  php list                     Pinned versions: installed, default, pool port
  php install <minor>
  php default <minor>          Default for new sites

DATABASES
  db list
  db install <series>
  db start <series> | db stop <series>
  db export <name>             Dump to ~/Downloads and print the path

MAIL / TUNNELS
  mail                         Mailpit status
  tunnel install               Download cloudflared
  tunnel list                  Everything currently shared publicly
  tunnel start <domain>        Share a site publicly; prints the URL.
                               A CLI share closes itself after an hour.
  tunnel stop <domain>

LOGS
  logs                         Every log QuickWP can show
  logs <id> [--lines N]        Tail one

Every command accepts --json for machine-readable output.
"#;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args.iter().any(|a| a == "--json");
    let args: Vec<String> = args.into_iter().filter(|a| a != "--json").collect();

    if args.is_empty() || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
        print!("{USAGE}");
        std::process::exit(if args.is_empty() { 2 } else { 0 });
    }
    if args[0] == "--version" || args[0] == "-v" {
        println!("quickwp {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // Hidden: the tunnel guard. Not in USAGE because nobody runs it by hand --
    // it is spawned beside every share so that a share always has something
    // watching it, even if whatever started it dies without warning.
    if args[0] == "__guard" {
        let get = |k: &str| -> Option<String> {
            let i = args.iter().position(|a| a == k)?;
            args.get(i + 1).cloned()
        };
        let Some(tunnel_pid) = get("--tunnel-pid").and_then(|v| v.parse().ok()) else {
            eprintln!("__guard: --tunnel-pid is required");
            std::process::exit(2);
        };
        let domain = get("--domain").unwrap_or_default();
        let parent = match (
            get("--parent-pid").and_then(|v| v.parse::<u32>().ok()),
            get("--parent-start").and_then(|v| v.parse::<u64>().ok()),
        ) {
            (Some(p), Some(s)) => Some((p, s)),
            _ => None,
        };
        let expires = get("--expires").and_then(|v| v.parse::<u64>().ok());
        core::tunnel::guard_loop(tunnel_pid, &domain, parent, expires);
        return;
    }

    match run(&args, json) {
        Ok(out) => {
            if !out.is_empty() {
                println!("{out}");
            }
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

fn need(args: &[String], i: usize, what: &str) -> Result<String, String> {
    args.get(i)
        .cloned()
        .ok_or_else(|| format!("missing <{what}>. Run `quickwp help`."))
}

fn out<T: serde::Serialize>(json: bool, value: &T, plain: impl FnOnce() -> String) -> String {
    if json {
        serde_json::to_string_pretty(value).unwrap_or_default()
    } else {
        plain()
    }
}

fn run(args: &[String], json: bool) -> Result<String, String> {
    let app = core::Quickwp::new().map_err(|e| e.to_string())?;
    let a = |i: usize| args.get(i).map(|s| s.as_str()).unwrap_or("");

    match (a(0), a(1)) {
        // ---------------------------------------------------------- stack
        ("status", _) => {
            let tld = app.db.tld().map_err(|e| e.to_string())?;
            let sys = core::privileged::state(&tld);
            let sites = core::site::list(&app.db).map_err(|e| e.to_string())?;
            let value = serde_json::json!({
                "tld": tld,
                "sites": sites.len(),
                "serving": sites.iter().filter(|s| s.enabled).count(),
                "https_ready": sys.resolver_installed && sys.daemon_running && sys.ca_trusted,
                "system": sys,
            });
            Ok(out(json, &value, || {
                let mut s = format!("{} site(s), .{tld}\n", sites.len());
                s.push_str(&format!(
                    "HTTPS: resolver {} · edge {} · CA {}\n",
                    yn(sys.resolver_installed),
                    yn(sys.daemon_running),
                    yn(sys.ca_trusted)
                ));
                for site in &sites {
                    s.push_str(&format!(
                        "  {:<28} {:<6} php {}\n",
                        site.domain,
                        if site.enabled { "up" } else { "stopped" },
                        site.php_minor
                    ));
                }
                s.trim_end().to_string()
            }))
        }
        // Checked before any password is asked for.
        ("system", "preflight") => {
            let tld = app.db.tld().map_err(|e| e.to_string())?;
            let edge = std::env::current_exe()
                .ok()
                .and_then(|e| e.parent().map(|d| d.join("quickwp-edge")))
                .unwrap_or_default();
            let takeover = args.iter().any(|a| a == "--takeover");
            let checks = core::privileged::preflight(&tld, &edge, takeover);
            let blocks = core::privileged::preflight_blocks(&checks);
            Ok(out(json, &checks, || {
                let mut s: String = checks
                    .iter()
                    .map(|c| {
                        format!(
                            "[{}] {}{}",
                            if c.ok { " ok " } else if c.blocking { "STOP" } else { "warn" },
                            c.label,
                            if c.ok { String::new() } else { format!("\n       {}", c.fix) }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                s.push_str(if blocks {
                    "\n\nNot ready: fix the STOP lines first. QuickWP will not ask for your \
                     password for an install that cannot succeed."
                } else {
                    "\n\nReady. Turn on HTTPS from the app's General tab."
                });
                s
            }))
        }
        ("system", "verify") => {
            let tld = app.db.tld().map_err(|e| e.to_string())?;
            let r = core::privileged::verify(&tld);
            Ok(out(json, &r, || {
                r.items
                    .iter()
                    .map(|i| format!("[{}] {} — {}", if i.ok { "ok" } else { "no" }, i.label, i.detail))
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        ("doctor", _) => {
            let f = app.doctor();
            Ok(out(json, &f, || {
                f.iter()
                    .map(|x| format!("[{}] {} — {}", x.level, x.title, x.detail))
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        ("start", _) => {
            let default = app.db.default_php().map_err(|e| e.to_string())?;
            if core::runtime::is_installed(&default, "fpm") {
                core::php::start_pool(&app.sup, &default).map_err(|e| e.to_string())?;
            }
            app.start_dns().map_err(|e| e.to_string())?;
            Ok(format!("Serving on port {}", core::ports::NGINX))
        }
        ("stop", _) => {
            app.stop_dns();
            app.sup.stop_all();
            Ok("Stopped.".into())
        }

        // ---------------------------------------------------------- sites
        ("site", "list") => {
            let sites = core::site::list(&app.db).map_err(|e| e.to_string())?;
            Ok(out(json, &sites, || {
                sites
                    .iter()
                    .map(|s| {
                        format!(
                            "{:<28} {:<8} php {:<4} {}",
                            s.domain,
                            if s.enabled { "up" } else { "stopped" },
                            s.php_minor,
                            s.docroot
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        ("site", "create") => {
            let domain = need(args, 2, "domain")?;
            let tld = app.db.tld().map_err(|e| e.to_string())?;
            let domain = if domain.contains('.') {
                domain
            } else {
                format!("{domain}.{tld}")
            };
            let php = flag(args, "--php")
                .unwrap_or(app.db.default_php().map_err(|e| e.to_string())?);
            let s = core::site::create(
                &app.db,
                &core::site::NewSite {
                    name: domain.split('.').next().unwrap_or(&domain).to_string(),
                    domain: domain.clone(),
                    kind: flag(args, "--type").unwrap_or_else(|| "php".into()),
                    php_minor: php,
                    link_path: flag(args, "--path"),
                },
            )
            .map_err(|e| e.to_string())?;
            app.ensure_cert(&s).map_err(|e| e.to_string())?;
            let _ = app.reload_dns();
            Ok(out(json, &s, || format!("Created {} at {}", s.domain, s.docroot)))
        }
        ("site", "delete") => {
            let d = need(args, 2, "domain")?;
            core::site::delete(&app.db, &d).map_err(|e| e.to_string())?;
            Ok(format!("Deleted {d}"))
        }
        ("site", "start") | ("site", "stop") => {
            let on = a(1) == "start";
            let d = need(args, 2, "domain")?;
            core::site::set_enabled(&app.db, &d, on).map_err(|e| e.to_string())?;
            Ok(format!("{d} is now {}", if on { "serving" } else { "stopped" }))
        }
        ("site", "php") => {
            let d = need(args, 2, "domain")?;
            let m = need(args, 3, "minor")?;
            core::site::set_php(&app.db, &d, &m).map_err(|e| e.to_string())?;
            Ok(format!("{d} now uses PHP {m}"))
        }
        ("site", "domains") => {
            let d = need(args, 2, "domain")?;
            let add = flag(args, "--add").ok_or("usage: quickwp site domains <domain> --add <name>")?;
            core::site::add_domain(&app.db, &d, &add).map_err(|e| e.to_string())?;
            if let Some(s) = core::site::find(&app.db, &d).map_err(|e| e.to_string())? {
                app.ensure_cert(&s).map_err(|e| e.to_string())?;
            }
            Ok(format!("{d} also answers on {add}"))
        }

        // ------------------------------------------------------------ php
        ("php", "list") => {
            let default = app.db.default_php().map_err(|e| e.to_string())?;
            let v = core::php::list(&app.sup, &default);
            Ok(out(json, &v, || {
                v.iter()
                    .map(|p| {
                        format!(
                            "{:<5} {:<8} {:<14} {:<6} {}",
                            p.minor,
                            p.patch,
                            if p.installed {
                                if p.running { "running" } else { "installed" }
                            } else {
                                "-"
                            },
                            if p.is_default { "default" } else { "" },
                            if p.eol { "EOL" } else { "" }
                        )
                        .trim_end()
                        .to_string()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        ("php", "install") => {
            let m = need(args, 2, "minor")?;
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            rt.block_on(async {
                for kind in ["fpm", "cli"] {
                    core::runtime::install_php(&m, kind, |_| {})
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok::<_, String>(())
            })?;
            Ok(format!("PHP {m} installed"))
        }
        ("php", "default") => {
            let m = need(args, 2, "minor")?;
            app.db.set_setting("default_php", &m).map_err(|e| e.to_string())?;
            Ok(format!("New sites will use PHP {m}"))
        }

        // ------------------------------------------------------ databases
        ("db", "list") => {
            let v = core::database::list(&app.sup);
            Ok(out(json, &v, || {
                v.iter()
                    .map(|e| {
                        format!(
                            "MySQL {:<5} {:<9} {}",
                            e.series,
                            e.version,
                            if e.running {
                                format!("running on {}", e.port)
                            } else if e.installed {
                                "stopped".into()
                            } else {
                                "not installed".into()
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        ("db", "install") => {
            let s = need(args, 2, "series")?;
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            rt.block_on(core::runtime::install_mysql(&s, |_| {}))
                .map_err(|e| e.to_string())?;
            Ok(format!("MySQL {s} installed"))
        }
        ("db", "start") => {
            let s = need(args, 2, "series")?;
            let p = core::database::start(&app.sup, &s).map_err(|e| e.to_string())?;
            Ok(format!("MySQL {s} on 127.0.0.1:{p}"))
        }
        ("db", "stop") => {
            let s = need(args, 2, "series")?;
            core::database::stop(&app.sup, &s).map_err(|e| e.to_string())?;
            Ok(format!("MySQL {s} stopped"))
        }
        ("db", "export") => {
            let name = need(args, 2, "database")?;
            let series = core::runtime::MYSQL_SERIES[0];
            let p = core::database::export(series, &name).map_err(|e| e.to_string())?;
            Ok(p.to_string_lossy().into_owned())
        }

        // ----------------------------------------------------------- mail
        ("mail", _) => {
            let catch = app.db.setting("catch_all").ok().flatten().map(|v| v == "1").unwrap_or(true);
            let st = core::mail::status(&app.sup, catch);
            Ok(out(json, &st, || {
                format!(
                    "Mailpit {} · smtp {} · ui {} · catch-all {}",
                    if st.installed { if st.running { "running" } else { "stopped" } } else { "not installed" },
                    st.smtp_port,
                    st.ui_url,
                    if st.catch_all { "on" } else { "off" }
                )
            }))
        }

        // -------------------------------------------------------- tunnels
        ("tunnel", "start") => {
            let d = need(args, 2, "domain")?;
            if core::site::find(&app.db, &d).map_err(|e| e.to_string())?.is_none() {
                return Err(format!("no site answers on `{d}`"));
            }
            if !core::tunnel::is_installed() {
                return Err("cloudflared is not installed. Run `quickwp tunnel install`.".into());
            }
            // The CLI exits immediately, so it cannot be the owner. The share
            // carries a deadline instead, and a guard process enforces it --
            // that is what makes a share with no window safe to start.
            let url = core::tunnel::start(&app.db, &app.sup, &d, None)
                .map_err(|e| e.to_string())?;
            let mins = core::tunnel::CLI_TUNNEL_SECONDS / 60;
            Ok(format!(
                "{url}\n\n{d} is PUBLIC. Anyone with that link reaches it.\n\
                 It closes automatically in {mins} minutes, or now with:\n  quickwp tunnel stop {d}"
            ))
        }
        ("tunnel", "install") => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            rt.block_on(core::tunnel::install(|_| {})).map_err(|e| e.to_string())?;
            Ok("cloudflared installed".into())
        }
        ("tunnel", "stop") => {
            let d = need(args, 2, "domain")?;
            let stopped = core::tunnel::stop(&app.db, &app.sup, &d).map_err(|e| e.to_string())?;
            Ok(if stopped {
                format!("{d} is no longer public.")
            } else {
                format!("{d} was not shared.")
            })
        }
        ("tunnel", "list") | ("tunnel", "") => {
            core::tunnel::sweep(&app.db, &app.sup).map_err(|e| e.to_string())?;
            let ts = core::tunnel::list(&app.db).map_err(|e| e.to_string())?;
            Ok(out(json, &ts, || {
                if ts.is_empty() {
                    return "Nothing is shared publicly.".into();
                }
                ts.iter()
                    .map(|t| {
                        let left = t
                            .expires_at
                            .map(|e| {
                                let secs = e.saturating_sub(core::proc::now());
                                format!("closes in {}m", secs / 60)
                            })
                            .unwrap_or_else(|| "closes with the app".into());
                        format!("{:<24} {}  ({}, {left})", t.domain, t.public_url, t.owner)
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }

        // ----------------------------------------------------------- logs
        ("logs", "") => {
            let s = core::log::sources();
            Ok(out(json, &s, || {
                s.iter()
                    .map(|l| format!("{:<18} {:>9}  {}", l.id, human(l.bytes), l.label))
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        ("logs", id) => {
            let lines = flag(args, "--lines")
                .and_then(|v| v.parse().ok())
                .unwrap_or(200);
            core::log::tail(id, lines).map_err(|e| e.to_string())
        }

        (cmd, _) => Err(format!("unknown command `{cmd}`. Run `quickwp help`.")),
    }
}

fn yn(b: bool) -> &'static str {
    if b {
        "yes"
    } else {
        "no"
    }
}

fn human(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1048576.0)
    }
}
