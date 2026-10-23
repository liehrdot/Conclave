//! Links that leave the app: WebView2 neither follows `target="_blank"` / `window.open` nor should the main window
//! itself wander off to a web page, so those open in the system browser instead (Scryfall, the about page's
//! channels, Cardmarket offers …). moxfield.com and the Verkaufsliste keep their own windows.

use tauri::{AppHandle, Url};

use crate::{cardmarket, moxfield};

/// The pages the main window shows itself: the backend on 127.0.0.1 and the start page (tauri.localhost).
fn is_local(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost") | Some("[::1]")),
        _ => true,
    }
}

/// Only web and mail links go to the system; anything else (file:, custom protocols) is dropped.
fn is_external(url: &Url) -> bool {
    !is_local(url) && matches!(url.scheme(), "http" | "https" | "mailto")
}

fn open_external(url: &Url) {
    if is_external(url) {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// The main window's navigation handler: `true` lets the main window load `url`.
pub fn navigate(app: &AppHandle, url: &Url) -> bool {
    if cardmarket::is_sell(url) {
        cardmarket::start(app, url);
        return false;
    }
    if moxfield::is_moxfield(url) {
        moxfield::open(app, url.clone());
        return false;
    }
    if is_local(url) {
        return true;
    }
    open_external(url);
    false
}

/// A link with `target="_blank"` or `window.open`: own pages (the print PDF) may open a popup of the app, Moxfield
/// goes to its window, everything else to the system browser.
pub fn new_window(app: &AppHandle, url: &Url) -> bool {
    if moxfield::is_moxfield(url) {
        moxfield::open(app, url.clone());
        return false;
    }
    if is_local(url) && !cardmarket::is_sell(url) {
        return true;
    }
    open_external(url);
    false
}

