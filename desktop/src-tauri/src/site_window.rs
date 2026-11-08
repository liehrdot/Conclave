//! The windows for outside sites (Moxfield, Cardmarket): a page the user logs in to, one init script, and a
//! `.invalid` relay host. The script talks back only by navigating to that host, which can never resolve; the
//! shell cancels the navigation and hands the address to the site module.

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// One site's window.
pub struct Site {
    pub label: &'static str,
    pub title: &'static str,
    pub size: (f64, f64),
    pub min_size: (f64, f64),
    pub script: &'static str,
    pub relay_host: &'static str,
    /// A navigation to `relay_host`, cancelled.
    pub on_relay: fn(&AppHandle, &Url),
    /// After every page load (e.g. hand the page its state).
    pub on_load: Option<fn(&WebviewWindow)>,
    /// Once the window is gone.
    pub on_closed: Option<fn(&AppHandle)>,
}

pub fn bring_to_front(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        bring_to_front(&w);
    }
}

/// Run `js` in the main window (the web app's `window.conclave…` hooks).
pub fn eval_main(app: &AppHandle, js: &str) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(js);
    }
}

/// Show `url` in the site's window, building it the first time. Called from navigation handlers, so the work runs
/// on its own thread: building a webview inside an event handler deadlocks WebView2 on Windows (the window shows
/// up but stays white).
pub fn open(app: &AppHandle, site: &'static Site, url: Url) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(w) = app.get_webview_window(site.label) {
            let _ = w.navigate(url);
            bring_to_front(&w);
            return;
        }
        let handle = app.clone();
        let mut builder = WebviewWindowBuilder::new(&app, site.label, WebviewUrl::External(url))
            .title(site.title)
            .inner_size(site.size.0, site.size.1)
            .min_inner_size(site.min_size.0, site.min_size.1)
            .initialization_script(site.script)
            .on_navigation(move |u| {
                if u.host_str() != Some(site.relay_host) {
                    return true;
                }
                (site.on_relay)(&handle, u);
                false
            });
        if let Some(on_load) = site.on_load {
            builder = builder.on_page_load(move |w, p| {
                if p.event() == PageLoadEvent::Finished {
                    std::thread::spawn(move || on_load(&w));
                }
            });
        }
        match builder.build() {
            Ok(w) => {
                if let Some(on_closed) = site.on_closed {
                    let app = app.clone();
                    w.on_window_event(move |e| {
                        if let WindowEvent::Destroyed = e {
                            on_closed(&app);
                        }
                    });
                }
            }
            Err(e) => eprintln!("{} window: {e}", site.label),
        }
    });
}
