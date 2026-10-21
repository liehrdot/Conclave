//! The bridge to the backend while the app runs: every few seconds the shell posts its state to
//! `/api/desktop/poll` and gets back the tray tooltip (sync state, running jobs), notices it shows as system
//! notifications while the window is hidden (news from your other devices), and the
//! commands the settings page queued (autostart on/off, open the data folder or the log).
//!
//! The poll is a long poll: the backend holds it up to `WAIT` and answers at once when the web app queues a
//! command, so „Update installieren“ starts right away instead of after the next poll.

use std::thread;
use std::time::Duration;

use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt;

use crate::backend::{self, Backend};
use crate::updates::{self, Updates};

const FIRST_AFTER: Duration = Duration::from_secs(3);
const EVERY: Duration = Duration::from_secs(10); // after a failed poll
const WAIT: u64 = 8; // seconds the backend may hold a poll
const MIN_GAP: Duration = Duration::from_secs(1);

pub fn start(app: AppHandle, backend: Backend, autostart_item: CheckMenuItem<Wry>, updates: Updates) {
    thread::spawn(move || {
        let mut since: u64 = 0;
        let mut wait = FIRST_AFTER;
        loop {
            thread::sleep(wait);
            wait = EVERY;
            let started = std::time::Instant::now();
            let st = backend::status(&backend);
            let (Some(url), true) = (st.url.clone(), st.state == "ready") else { continue };
            let token = backend::token_of(&url);
            let visible = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(true);
            let autostart = app.autolaunch().is_enabled().unwrap_or(false);
            let body = serde_json::json!({
                "since": since, "visible": visible, "autostart": autostart,
                "version": app.package_info().version.to_string(),
                "features": ["moxfield"],
                "update": serde_json::to_value(updates::snapshot(&updates)).unwrap_or(serde_json::Value::Null),
                "wait": WAIT,
            })
            .to_string();
            let within = Duration::from_secs(WAIT + 5);
            let Ok(text) = backend::http_request_within(&url, "POST", "/api/desktop/poll", token.as_deref(), Some(&body), within) else { continue };
            let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            wait = MIN_GAP.saturating_sub(started.elapsed()); // poll again at once, but never more than once a second
            if let Some(n) = data["since"].as_u64() {
                since = n;
            }
            if let (Some(tip), Some(tray)) = (data["tooltip"].as_str(), app.tray_by_id("main")) {
                let _ = tray.set_tooltip(Some(tip));
            }
            if !visible {
                for n in data["notices"].as_array().into_iter().flatten() {
                    let _ = app
                        .notification()
                        .builder()
                        .title(n["title"].as_str().unwrap_or(backend::APP_NAME))
                        .body(n["body"].as_str().unwrap_or(""))
                        .show();
                }
            }
            for c in data["commands"].as_array().into_iter().flatten() {
                match c["type"].as_str().unwrap_or("") {
                    "autostart" => {
                        let m = app.autolaunch();
                        let _ = if c["value"].as_bool().unwrap_or(false) { m.enable() } else { m.disable() };
                        let _ = autostart_item.set_checked(m.is_enabled().unwrap_or(false));
                    }
                    "open_data" => crate::open_folder(&backend::dirs(&app).data),
                    "open_log" => {
                        if let Some(folder) = backend::dirs(&app).log.parent() {
                            crate::open_folder(folder);
                        }
                    }
                    "check_update" => updates::check(app.clone(), updates.clone(), backend.clone()),
                    "install_update" => updates::install(app.clone(), updates.clone(), backend.clone(), None),
                    "install_version" => {
                        if let Some(v) = c["value"].as_str() {
                            updates::install(app.clone(), updates.clone(), backend.clone(), Some(v.to_string()));
                        }
                    }
                    _ => {}
                }
            }
        }
    });
}
