//! CORTEX-54 desktop app (ADR-066). A thin native shell around the local brain:
//! - starts `cortexd` (the bundled Node runtime + cortexd.mjs) unless one is already running (e.g. the background
//!   service), and stops the one it started when the app quits;
//! - opens the cockpit (the same web terminal as the cloud) with a one-time login link;
//! - keeps a tray icon whose tooltip shows equity, positions and pulse age, with a kill switch and re-arm;
//! - closing the window hides it to the tray; trading carries on.
//! The shell holds no keys and makes no trading decisions: everything goes through the brain's own CLI and API.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};

struct Daemon(Mutex<Option<Child>>);

fn cortex_home() -> PathBuf {
    if let Ok(h) = std::env::var("CORTEX_HOME") {
        return PathBuf::from(h);
    }
    let base = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(".cortex54")
}

fn read_config() -> (u16, String) {
    let path = cortex_home().join("config.json");
    let v: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let port = v["port"].as_u64().unwrap_or(8754) as u16;
    let pill = v["secrets"]["pill_token"].as_str().unwrap_or("").to_string();
    (port, pill)
}

/// Minimal HTTP/1.0 GET to the local daemon (no TLS, loopback only). Returns the body on 200.
fn local_get(port: u16, path: &str, bearer: Option<&str>) -> Option<String> {
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(4))).ok()?;
    let auth = bearer.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    write!(s, "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n{auth}\r\n").ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    let (head, body) = buf.split_once("\r\n\r\n")?;
    if head.lines().next()?.contains(" 200 ") { Some(body.to_string()) } else { None }
}

struct Paths {
    node: PathBuf,
    cortexd: PathBuf,
    root: PathBuf,
}

fn paths(app: &tauri::AppHandle) -> Paths {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
    let node = exe_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let root = app
        .path()
        .resource_dir()
        .map(|d| d.join("cortexd"))
        .unwrap_or_else(|_| PathBuf::from("../../dist/cortexd"));
    Paths { node, cortexd: root.join("cortexd.mjs"), root }
}

fn cortex_cmd(p: &Paths, args: &[&str]) -> Command {
    let mut c = Command::new(&p.node);
    c.arg(&p.cortexd).args(args).env("CORTEX_ROOT", &p.root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn cortex_json(p: &Paths, args: &[&str]) -> Option<serde_json::Value> {
    let out = cortex_cmd(p, args).stdout(Stdio::piped()).stderr(Stdio::null()).output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

fn pill_text(port: u16, token: &str) -> String {
    let Some(body) = local_get(port, "/pill", Some(token)) else { return "CORTEX-54 · offline".into() };
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let eq = v["accounts"][0]["equity"].as_f64().map(|e| format!("${e:.2}")).unwrap_or_else(|| "—".into());
    let n = v["symbols"].as_array().map(|a| a.len()).unwrap_or(0);
    let age = v["pulse_age_s"].as_i64().map(|a| format!("{a}s")).unwrap_or_else(|| "never".into());
    let state = if v["ok"].as_bool() == Some(true) { "●" } else { "○ stale" };
    format!("CORTEX-54 {state} · {eq} · {n} position(s) · pulse {age}")
}

pub fn run() {
    tauri::Builder::default()
        .manage(Daemon(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let p = paths(&handle);
            if !cortex_home().join("config.json").exists() {
                // first run: a keyless demo, so the app shows something real before any signup
                let _ = cortex_cmd(&p, &["setup", "--mode", "demo", "--yes", "--json"]).output();
            }
            let (port, token) = read_config();
            if local_get(port, "/health", None).is_none() {
                let logs = cortex_home().join("logs");
                let _ = std::fs::create_dir_all(&logs);
                let log = std::fs::File::create(logs.join("desktop-daemon.log")).ok();
                let mut cmd = cortex_cmd(&p, &["start"]);
                cmd.env("CORTEX_PARENT_PID", std::process::id().to_string());
                if let Some(f) = log {
                    if let Ok(f2) = f.try_clone() {
                        cmd.stdout(f).stderr(f2);
                    }
                }
                if let Ok(child) = cmd.spawn() {
                    *app.state::<Daemon>().0.lock().unwrap() = Some(child);
                }
            }

            // tray
            let open = MenuItem::with_id(app, "open", "Open cockpit", true, None::<&str>)?;
            let kill = MenuItem::with_id(app, "kill", "Kill switch: stop new entries", true, None::<&str>)?;
            let rearm = MenuItem::with_id(app, "rearm", "Re-arm", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit CORTEX-54", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &kill, &rearm, &PredefinedMenuItem::separator(app)?, &quit])?;
            let tray = TrayIconBuilder::with_id("pill")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("CORTEX-54 · starting")
                .menu(&menu)
                .on_menu_event(move |app, e| {
                    let p = paths(app);
                    match e.id().as_ref() {
                        "open" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "kill" => {
                            let _ = cortex_cmd(&p, &["kill", "tray"]).output();
                        }
                        "rearm" => {
                            let _ = cortex_cmd(&p, &["rearm"]).output();
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            // wait for the brain, then log the window in with a one-time link; keep the tooltip fresh
            std::thread::spawn(move || {
                for _ in 0..90 {
                    if local_get(port, "/health", None).is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(700));
                }
                if let Some(link) = cortex_json(&p, &["link", "--json"]).and_then(|v| v["login"].as_str().map(String::from)) {
                    if let (Some(w), Ok(url)) = (handle.get_webview_window("main"), link.parse()) {
                        let _ = w.navigate(url);
                    }
                }
                loop {
                    let _ = tray.set_tooltip(Some(pill_text(port, &token)));
                    std::thread::sleep(Duration::from_secs(30));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide(); // trading continues; the tray brings it back
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building CORTEX-54")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut c) = app.state::<Daemon>().0.lock().unwrap().take() {
                    let _ = c.kill();
                }
            }
        });
}
