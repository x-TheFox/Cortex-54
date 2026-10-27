//! CORTEX-54 desktop app (ADR-066). A thin native shell around the local brain:
//! - starts `cortexd` (the bundled Node runtime + cortexd.mjs) unless one is already running (e.g. the background
//!   service), and stops the one it started when the app quits;
//! - opens the cockpit (the same web terminal as the cloud) with a one-time login link;
//! - keeps a tray icon whose tooltip shows equity, positions and pulse age, with a kill switch and re-arm;
//! - closing the window hides it to the tray; trading carries on.
//! - checks for a signed update at launch (ADR-077) and offers it in the tray; nothing installs without a click;
//! - shows the brain's one-line health problem in the tray (ADR-076).
//! The shell holds no keys and makes no trading decisions: everything goes through the brain's own CLI and API.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

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

/// Tooltip text, plus the one-line problem (if any) the brain's health checks found.
fn pill_text(port: u16, token: &str) -> (String, Option<String>) {
    let Some(body) = local_get(port, "/pill", Some(token)) else {
        return ("CORTEX-54 · offline".into(), Some("The brain isn't answering".into()));
    };
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let eq = v["accounts"][0]["equity"].as_f64().map(|e| format!("${e:.2}")).unwrap_or_else(|| "—".into());
    let n = v["symbols"].as_array().map(|a| a.len()).unwrap_or(0);
    let age = v["pulse_age_s"].as_i64().map(|a| format!("{a}s")).unwrap_or_else(|| "never".into());
    let state = if v["ok"].as_bool() == Some(true) { "●" } else { "○ stale" };
    let problem = v["problem"].as_str().map(String::from);
    let line = format!("CORTEX-54 {state} · {eq} · {n} position(s) · pulse {age}");
    match &problem {
        Some(p) => (format!("{line}\n⚠ {p}"), problem),
        None => (line, None),
    }
}

/// Installed from an MSIX (ADR-079): Windows owns the files, so the in-app updater must not run (it would install a
/// second copy beside the package). Updates come as the next MSIX instead.
fn packaged() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_lowercase().contains("\\windowsapps\\"))
        .unwrap_or(false)
}

/// The cockpit itself: the app's bundled page and the local brain. Everything else is an outside link.
fn is_local(u: &Url) -> bool {
    match u.scheme() {
        "tauri" | "about" | "data" | "blob" | "asset" => true,
        "http" | "https" => matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "tauri.localhost")),
        _ => false,
    }
}

/// Outside links (key pages, docs, Alpaca, ntfy) open in the user's own browser, never inside the app window,
/// which can't open new windows anyway (ADR-082). Only web and mail links; anything else is ignored.
fn open_outside(app: &tauri::AppHandle, u: &Url) {
    if matches!(u.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(u.as_str(), None::<&str>);
    }
}

async fn tokio_sleep(d: Duration) {
    // no tokio dependency of our own: a blocking sleep on tauri's blocking pool
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(Daemon(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            // the main window, built here (not from config) so links can leave for the system browser
            if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
                let (nav, popup) = (handle.clone(), handle.clone());
                WebviewWindowBuilder::from_config(&handle, &cfg)?
                    .on_navigation(move |u| {
                        if is_local(u) {
                            true
                        } else {
                            open_outside(&nav, u);
                            false
                        }
                    })
                    .on_new_window(move |u, _| {
                        open_outside(&popup, &u);
                        NewWindowResponse::Deny
                    })
                    .build()?;
            }
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
            let health = MenuItem::with_id(app, "health", "Health: checking…", false, None::<&str>)?;
            let update = MenuItem::with_id(
                app,
                "update",
                if packaged() { "Updates: install the next MSIX" } else { "Up to date" },
                false,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit CORTEX-54", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &health,
                    &PredefinedMenuItem::separator(app)?,
                    &kill,
                    &rearm,
                    &PredefinedMenuItem::separator(app)?,
                    &update,
                    &quit,
                ],
            )?;
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
                        "update" if !packaged() => {
                            // signed update (minisign key in tauri.conf.json); the brain stops with the app and the
                            // new version starts it again
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Ok(Some(u)) = match app.updater() {
                                    Ok(up) => up.check().await,
                                    Err(e) => Err(e),
                                } {
                                    if u.download_and_install(|_, _| {}, || {}).await.is_ok() {
                                        app.restart();
                                    }
                                }
                            });
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            // ADR-077: look for a signed update once at launch and every 6 hours; offer it in the tray
            let up_handle = app.handle().clone();
            let up_item = update.clone();
            tauri::async_runtime::spawn(async move {
                if packaged() {
                    return;
                }
                loop {
                    if let Ok(up) = up_handle.updater() {
                        if let Ok(Some(u)) = up.check().await {
                            let _ = up_item.set_text(format!("Install update {} and restart", u.version));
                            let _ = up_item.set_enabled(true);
                        }
                    }
                    tokio_sleep(Duration::from_secs(6 * 3600)).await;
                }
            });

            // wait for the brain, then log the window in with a one-time link; keep the tooltip fresh
            let health_item = health.clone();
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
                    let (tip, problem) = pill_text(port, &token);
                    let _ = tray.set_tooltip(Some(tip));
                    // ADR-076: a problem shows next to the tray icon (macOS menu bar) and in the menu, in plain words
                    let _ = tray.set_title(problem.as_ref().map(|_| "⚠"));
                    let _ = health_item.set_text(match &problem {
                        Some(p) => format!("⚠ {p}"),
                        None => "Health: all good".to_string(),
                    });
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

#[cfg(test)]
mod tests {
    use super::is_local;
    use tauri::Url;

    #[test]
    fn outside_links_leave_the_app() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_local(&u("http://127.0.0.1:8754/#login=x")));
        assert!(is_local(&u("http://localhost:8754/")));
        assert!(is_local(&u("tauri://localhost/index.html")));
        assert!(!is_local(&u("https://aistudio.google.com/apikey")));
        assert!(!is_local(&u("https://app.alpaca.markets/signup")));
        assert!(!is_local(&u("http://127.0.0.1.evil.example/")));
        assert!(!is_local(&u("file:///etc/passwd")));
    }
}
