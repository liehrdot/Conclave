//! Selling on Cardmarket without Cardmarket's API (only verified business sellers get it; Cardmarket's support
//! suggested working in the logged-in page instead, as long as the user does the final click for every card): the web
//! app's Verkaufsliste navigates the main window to `SELL_HOST?d=<cards as JSON>`, the shell cancels that navigation,
//! keeps the cards and opens Cardmarket in its own window, where the user logs in as usual. After every page load the
//! shell hands the list to `cardmarket.js` (an init script), whose bar opens the current card's product page and fills
//! Cardmarket's own sell form. The script never submits: the user checks the form and clicks Cardmarket's button. The
//! page gets no IPC: it talks back only through cancelled navigations to `SELL_HOST?a=…` (show the state, go to card
//! i, card listed / not listed, close), and the shell only ever opens the cardmarket.com addresses Conclave sent.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, WebviewWindow};

use crate::site_window::{self, Site};

/// What the web app may offer when the shell has this module (`features` in the bridge's poll).
pub const FEATURE: &str = "cardmarket";
const LABEL: &str = "cardmarket";
const SELL_HOST: &str = "conclave-sell.invalid";
const HOME: &str = "https://www.cardmarket.com/en/Magic";
const MAX_PAYLOAD: usize = 1024 * 1024;
const MAX_CARDS: usize = 2000;

static SITE: Site = Site {
    label: LABEL,
    title: "Cardmarket – Conclave",
    size: (1280.0, 900.0),
    min_size: (760.0, 520.0),
    script: include_str!("cardmarket.js"),
    relay_host: SELL_HOST,
    on_relay: handle_request,
    on_load: Some(push_state),
    on_closed: Some(closed),
};

struct Queue {
    cards: Vec<Value>,
    current: usize,
    done: Vec<String>,
}

static QUEUE: Mutex<Option<Queue>> = Mutex::new(None);

/// The main window's hand-over of the cards to sell (never a real address: `.invalid` cannot resolve).
pub fn is_sell(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(SELL_HOST)
}

/// Only Cardmarket's own pages are opened from the list.
fn cardmarket_url(v: &Value) -> Option<Url> {
    let url = Url::parse(v.as_str()?).ok()?;
    let ok = url.scheme() == "https" && matches!(url.host_str(), Some("www.cardmarket.com") | Some("cardmarket.com"));
    ok.then_some(url)
}

fn card_url(card: &Value) -> Url {
    cardmarket_url(&card["url"]).or_else(|| cardmarket_url(&card["search_url"])).unwrap_or_else(|| Url::parse(HOME).unwrap())
}

fn param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

/// From the main window: keep the cards and open the first one in the Cardmarket window.
pub fn start(app: &AppHandle, url: &Url) {
    let Some(raw) = param(url, "d") else { return };
    if raw.len() > MAX_PAYLOAD {
        return;
    }
    let Ok(data) = serde_json::from_str::<Value>(&raw) else { return };
    let cards: Vec<Value> = data["cards"]
        .as_array()
        .map(|a| a.iter().filter(|c| c["id"].as_str().is_some_and(|id| !id.is_empty() && id.len() <= 40)).take(MAX_CARDS).cloned().collect())
        .unwrap_or_default();
    let Some(first) = cards.first() else { return };
    let target = card_url(first);
    *QUEUE.lock().unwrap() = Some(Queue { cards, current: 0, done: Vec::new() });
    site_window::open(app, &SITE, target);
}

/// The Cardmarket window is gone: forget the list and tell the Verkaufsliste.
fn closed(app: &AppHandle) {
    *QUEUE.lock().unwrap() = None;
    tell_main(app, json!({"type": "closed"}));
}

fn state() -> Value {
    match QUEUE.lock().unwrap().as_ref() {
        Some(q) => json!({"cards": q.cards, "current": q.current, "done": q.done}),
        None => Value::Null,
    }
}

/// The list for the bar; serde_json writes a valid JS literal, so no page data becomes code here.
fn push_state(w: &WebviewWindow) {
    let _ = w.eval(&format!("window.__conclaveSell && window.__conclaveSell({})", state()));
}

fn tell_main(app: &AppHandle, event: Value) {
    site_window::eval_main(app, &format!("window.conclaveSell && window.conclaveSell({event})"));
}

/// One click in the bar: `a=state|goto|done|undone|close` (with `i` = card index or `id` = card id).
fn handle_request(app: &AppHandle, url: &Url) {
    let action = param(url, "a").unwrap_or_default();
    let index = param(url, "i").and_then(|i| i.parse::<usize>().ok());
    let id = param(url, "id").unwrap_or_default();
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(w) = app.get_webview_window(LABEL) else { return };
        match action.as_str() {
            "goto" => {
                let target = {
                    let mut guard = QUEUE.lock().unwrap();
                    let Some(q) = guard.as_mut() else { return };
                    let Some(i) = index.filter(|i| *i < q.cards.len()) else { return };
                    q.current = i;
                    card_url(&q.cards[i])
                };
                let _ = w.navigate(target);
            }
            "done" | "undone" => {
                let known = {
                    let mut guard = QUEUE.lock().unwrap();
                    let Some(q) = guard.as_mut() else { return };
                    let known = q.cards.iter().any(|c| c["id"].as_str() == Some(id.as_str()));
                    q.done.retain(|d| d != &id);
                    if known && action == "done" {
                        q.done.push(id.clone());
                    }
                    known
                };
                if known {
                    tell_main(&app, json!({"type": if action == "done" { "listed" } else { "unlisted" }, "id": id}));
                }
                push_state(&w);
            }
            "close" => {
                let _ = w.close();
                site_window::show_main(&app);
            }
            _ => push_state(&w),
        }
    });
}
