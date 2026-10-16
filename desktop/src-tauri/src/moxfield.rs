//! Moxfield import without Moxfield's API (they give deckbuilding apps no access; their support suggested
//! logging in inside the client instead): the web app navigates the main window to a moxfield.com link, the shell
//! cancels that navigation and opens the page in its own window, where the user logs in as usual. `moxfield.js`
//! keeps the deck the page itself loads and shows an „In Conclave importieren“ bar; a click navigates to
//! `IMPORT_URL?d=<deck as JSON>`, which this module cancels too and hands to the main window's
//! `window.conclaveMoxfield()`. The page gets no IPC: the only way back is that one cancelled navigation, and the
//! web app only fills its import preview with it, which the user still has to confirm.

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "moxfield";
const IMPORT_HOST: &str = "conclave-import.invalid";
const MAX_PAYLOAD: usize = 512 * 1024;
const SCRIPT: &str = include_str!("moxfield.js");

/// A link the main window must not open itself: moxfield.com pages go to the Moxfield window.
pub fn is_moxfield(url: &Url) -> bool {
    url.scheme() == "https" && matches!(url.host_str(), Some("moxfield.com") | Some("www.moxfield.com"))
}

/// Open `url` (a moxfield.com page) in the Moxfield window, or show it there when the window is already open.
/// Called from navigation handlers, so the work runs on its own thread: building a webview inside an event handler
/// deadlocks WebView2 on Windows (the window shows up but stays white).
pub fn open(app: &AppHandle, url: Url) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.navigate(url);
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let handle = app.clone();
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
            .title("Moxfield – Conclave")
            .inner_size(1180.0, 860.0)
            .min_inner_size(700.0, 500.0)
            .initialization_script(SCRIPT)
            .on_navigation(move |u| {
                if u.host_str() != Some(IMPORT_HOST) {
                    return true;
                }
                deliver(&handle, u);
                false
            })
            .build();
        if let Err(e) = built {
            eprintln!("moxfield window: {e}");
        }
    });
}

/// The deck from the bar's click: checked to be JSON of sane size, handed to the main window, Moxfield window closed.
fn deliver(app: &AppHandle, url: &Url) {
    let Some(raw) = url.query_pairs().find(|(k, _)| k == "d").map(|(_, v)| v.into_owned()) else { return };
    if raw.len() > MAX_PAYLOAD {
        return;
    }
    let Ok(deck) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    if !deck.is_object() {
        return;
    }
    // serde_json writes a valid JS literal, so the page's data never becomes code here
    let js = format!("window.conclaveMoxfield && window.conclaveMoxfield({deck})");
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.eval(&js);
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.close();
        }
    });
}
