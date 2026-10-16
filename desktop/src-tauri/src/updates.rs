//! Updates from GitHub Releases: `latest.json` (written by the release workflow, signed with the key whose public
//! part is in `tauri.conf.json`) is checked a little after the start and then once a day. The bridge reports the
//! state to the web app, which shows it under Einstellungen → Desktop-App and offers „Update installieren“; the
//! install runs the NSIS updater in passive mode and restarts the app.
//!
//! Which `latest.json` is checked comes from the backend (`GET /api/desktop/feed`): the stable release's by default,
//! the newest preview build's with „Vorschau-Versionen anzeigen“ on, or one picked version for „Zu dieser Version
//! wechseln“ (that one may be older; any other check only takes a newer version). The feed must be one of this repo's
//! release files, and the installer's signature is checked against `pubkey` either way.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::backend::{self, Backend};

const CHECK_AFTER: Duration = Duration::from_secs(45);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 3600);
const RELEASES: &str = "https://github.com/liehrdot/mtgdeckbuilder/releases/";

#[derive(Clone, Serialize, Default, Debug)]
pub struct UpdateState {
    /// unknown | none | available | downloading | installing | error | unconfigured
    pub state: String,
    pub current: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub progress: Option<u8>,
    pub error: Option<String>,
    pub checked: Option<u64>,
    /// the last check looked at preview builds too
    pub preview: bool,
}

#[derive(Default, Clone)]
pub struct Updates(pub Arc<Mutex<UpdateState>>);

pub fn snapshot(u: &Updates) -> UpdateState {
    u.0.lock().unwrap().clone()
}

fn set(u: &Updates, f: impl FnOnce(&mut UpdateState)) {
    f(&mut u.0.lock().unwrap());
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Ask the backend which `latest.json` to check (`version` = exactly that one, also an older one). None = the
/// endpoint in `tauri.conf.json` (the backend is not up yet, or GitHub could not be asked).
fn feed(backend: &Backend, version: Option<&str>) -> Result<Option<(Url, bool)>, String> {
    let st = backend::status(backend);
    let (Some(url), true) = (st.url.clone(), st.state == "ready") else { return Ok(None) };
    let path = match version {
        Some(v) => format!("/api/desktop/feed?version={}", v.chars().filter(|c| c.is_ascii_alphanumeric() || ".-".contains(*c)).collect::<String>()),
        None => "/api/desktop/feed".to_string(),
    };
    let text = match backend::http_request(&url, "GET", &path, backend::token_of(&url).as_deref(), None) {
        Ok(t) => t,
        Err(e) if version.is_some() => return Err(format!("Die Update-Datei für {} fehlt ({e}).", version.unwrap_or(""))),
        Err(_) => return Ok(None),
    };
    let data: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let Some(feed) = data["feed"].as_str() else { return Ok(None) };
    if !feed.starts_with(RELEASES) {
        return Err(format!("unerwartete Update-Adresse {feed}"));
    }
    Ok(Some((Url::parse(feed).map_err(|e| e.to_string())?, data["preview"].as_bool().unwrap_or(false))))
}

/// The updater for the feed (blocking: it asks the backend first); with `version` set it takes any version but the running one (going back).
fn updater(app: &AppHandle, backend: &Backend, version: Option<&str>) -> Result<(Updater, bool), String> {
    let Some((url, preview)) = feed(backend, version)? else {
        return Ok((app.updater().map_err(|e| e.to_string())?, false));
    };
    let mut builder = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?;
    if version.is_some() {
        builder = builder.version_comparator(|current, release| release.version != current);
    }
    Ok((builder.build().map_err(|e| e.to_string())?, preview))
}

/// Check in the background; the result lands in the state.
pub fn check(app: AppHandle, updates: Updates, backend: Backend) {
    let current = app.package_info().version.to_string();
    set(&updates, |s| s.current = current);
    tauri::async_runtime::spawn(async move {
        let (updater, preview) = match tauri::async_runtime::spawn_blocking({
            let (a, b) = (app.clone(), backend.clone());
            move || updater(&a, &b, None)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
        {
            Ok(u) => u,
            Err(e) => {
                set(&updates, |s| {
                    s.state = "unconfigured".into();
                    s.error = Some(e);
                    s.checked = Some(now());
                });
                return;
            }
        };
        set(&updates, |s| s.preview = preview);
        match updater.check().await {
            Ok(Some(update)) => set(&updates, |s| {
                s.state = "available".into();
                s.version = Some(update.version.clone());
                s.notes = update.body.clone();
                s.error = None;
                s.checked = Some(now());
            }),
            Ok(None) => set(&updates, |s| {
                s.state = "none".into();
                s.version = None;
                s.notes = None;
                s.error = None;
                s.checked = Some(now());
            }),
            Err(e) => set(&updates, |s| {
                s.state = "error".into();
                s.error = Some(e.to_string());
                s.checked = Some(now());
            }),
        }
    });
}

/// Download the announced update (or, with `version`, exactly that version, also an older one), stop the backend
/// (the installer overwrites its folder, and open files there made earlier updates fail) and run the installer. On
/// Windows the app exits once the installer runs and is restarted by it afterwards; if the install fails, the
/// backend is started again.
pub fn install(app: AppHandle, updates: Updates, backend: Backend, version: Option<String>) {
    {
        let st = updates.0.lock().unwrap();
        if st.state == "downloading" || st.state == "installing" {
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        let result: Result<(), String> = async {
            let (updater, _) = tauri::async_runtime::spawn_blocking({
                let (a, b, v) = (app.clone(), backend.clone(), version.clone());
                move || updater(&a, &b, v.as_deref())
            })
            .await
            .map_err(|e| e.to_string())??;
            let update: Update = updater.check().await.map_err(|e| e.to_string())?.ok_or_else(|| match &version {
                Some(v) => format!("Version {v} läuft schon."),
                None => "Es gibt gerade kein Update.".to_string(),
            })?;
            set(&updates, |s| {
                s.state = "downloading".into();
                s.progress = Some(0);
                s.version = Some(update.version.clone());
                s.error = None;
            });
            let (on_chunk_state, on_done_state) = (updates.clone(), updates.clone());
            let mut got: usize = 0;
            let bytes = update
                .download(
                    move |chunk, total| {
                        got += chunk;
                        if let Some(t) = total.filter(|t| *t > 0) {
                            let p = (got as f64 / t as f64 * 100.0).min(100.0) as u8;
                            set(&on_chunk_state, |s| s.progress = Some(p));
                        }
                    },
                    move || {
                        set(&on_done_state, |s| {
                            s.state = "installing".into();
                            s.progress = Some(100);
                        })
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
            let stopper = backend.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                backend::stop(&stopper);
                std::thread::sleep(Duration::from_millis(800)); // let Windows release the files
            })
            .await;
            update.install(bytes).map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = result {
            set(&updates, |s| {
                s.state = "error".into();
                s.error = Some(e);
                s.progress = None;
            });
            if backend::status(&backend).state == "stopped" {
                backend::start(app.clone(), backend.clone());
            }
        }
    });
}

/// Periodic checks: a little after the start, then daily.
pub fn start(app: AppHandle, updates: Updates, backend: Backend) {
    std::thread::spawn(move || {
        std::thread::sleep(CHECK_AFTER);
        loop {
            check(app.clone(), updates.clone(), backend.clone());
            std::thread::sleep(CHECK_EVERY);
        }
    });
}
