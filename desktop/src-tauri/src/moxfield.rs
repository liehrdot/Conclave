//! Moxfield import without Moxfield's API (they give deckbuilding apps no access; their support suggested
//! logging in inside the client instead): the web app navigates the main window to a moxfield.com link, the shell
//! cancels that navigation and opens the page in its own window, where the user logs in as usual. `moxfield.js`
//! keeps the deck the page itself loads and shows an „In Conclave importieren“ bar; a click navigates to
//! `conclave-import.invalid?d=<deck as JSON>`, which this module cancels too and hands to the main window's
//! `window.conclaveMoxfield()`. The page gets no IPC: the only way back is that one cancelled navigation, and the
//! web app only fills its import preview with it, which the user still has to confirm. On the collection page the
//! user's own click on Moxfield's „Export“ produces a CSV; the script keeps it and hands it over the same way
//! (`{kind: "collection", csv}`), for the collection import dialog.

use tauri::{AppHandle, Manager, Url};

use crate::site_window::{self, Site};

/// What the web app may offer when the shell has this module (`features` in the bridge's poll).
pub const FEATURE: &str = "moxfield";
const LABEL: &str = "moxfield";
const MAX_PAYLOAD: usize = 2 * 1024 * 1024;  // a collection CSV comes in parts of 400 KB

static SITE: Site = Site {
    label: LABEL,
    title: "Moxfield – Conclave",
    size: (1180.0, 860.0),
    min_size: (700.0, 500.0),
    script: include_str!("moxfield.js"),
    relay_host: "conclave-import.invalid",
    on_relay: deliver,
    on_load: None,
    on_closed: None,
};

/// A link the main window must not open itself: moxfield.com pages go to the Moxfield window.
pub fn is_moxfield(url: &Url) -> bool {
    url.scheme() == "https" && matches!(url.host_str(), Some("moxfield.com") | Some("www.moxfield.com"))
}

/// Open `url` (a moxfield.com page) in the Moxfield window, or show it there when the window is already open.
pub fn open(app: &AppHandle, url: Url) {
    site_window::open(app, &SITE, url);
}

/// The deck (or collection CSV) from the bar's click: checked to be JSON of sane size, handed to the main window, Moxfield window closed.
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
    // a collection CSV comes in parts: the window stays open until the last one
    let part = |key: &str| deck.get(key).and_then(serde_json::Value::as_u64);
    let last = match (part("part"), part("parts")) {
        (Some(i), Some(n)) => i + 1 >= n,
        _ => true,
    };
    let js = format!("window.conclaveMoxfield && window.conclaveMoxfield({deck})");
    let app = app.clone();
    std::thread::spawn(move || {
        site_window::eval_main(&app, &js);
        if !last {
            return;
        }
        site_window::show_main(&app);
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.close();
        }
    });
}
