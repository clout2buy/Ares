//! The Forge's native browser view: a real browser inside the side panel.
//!
//! Owner, 2026-10-20: "it should never resort to screenshots. Only an
//! interactive preview… every site can load in ares preview! I can actually
//! log in for ares on its preview." The Forge used to put local pages in an
//! iframe and stream JPEG frames of a hidden Playwright browser for
//! everything else, because sites that send X-Frame-Options / CSP
//! frame-ancestors refuse to be framed. A child WEBVIEW is not a frame: it is
//! a top-level browser (WebView2 on Windows) laid over the panel, so every
//! site loads, sign-ins work, and video, audio and WebGL run at full speed.
//!
//! One page, two drivers. On Windows the view's browser listens for the
//! Chrome DevTools Protocol on 127.0.0.1 (ARES_FORGE_CDP_PORT, default 9333);
//! the daemon is started with ARES_FORGE_CDP_URL and its Browser tool
//! attaches Playwright to THIS page, so Ares clicks and types in the page the
//! owner is looking at, and the owner can take over at any moment.
//!
//! The view has its own persistent profile (<ARES_HOME>/forge-browser):
//! logins survive restarts and never mix with the app's own webview. It
//! loads remote origins only, which get no IPC (no capability lists a remote
//! URL), so a site in the Forge can never call the app's commands.

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewBuilder,
    WebviewUrl,
};

pub const LABEL: &str = "forge-view";
const DEFAULT_CDP_PORT: u16 = 9333;

/// Where the view's DevTools endpoint listens (Windows; see module docs).
pub fn cdp_port() -> u16 {
    std::env::var("ARES_FORGE_CDP_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_CDP_PORT)
}

/// The endpoint the daemon attaches to, or None where the view has none.
pub fn cdp_url() -> Option<String> {
    if cfg!(windows) && std::env::var("ARES_FORGE_CDP").as_deref() != Ok("0") {
        Some(format!("http://127.0.0.1:{}", cdp_port()))
    } else {
        None
    }
}

/// The panel rect, in CSS (logical) pixels relative to the window.
#[derive(Deserialize, Clone, Copy)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Bounds {
    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.w.max(1.0), self.h.max(1.0)).into(),
        }
    }
}

fn parse(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).map_err(|e| format!("not a link: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        // the daemon wakes the view with a blank page, then navigates it itself
        "about" if parsed.as_str() == "about:blank" => Ok(parsed),
        other => Err(format!("the Forge view opens http(s) links, not {other}:")),
    }
}

fn view(app: &AppHandle) -> Option<Webview> {
    app.get_webview(LABEL)
}

fn emit_nav(app: &AppHandle, url: &str, loading: bool) {
    let _ = app.emit_to(
        "main",
        "forge-view-nav",
        serde_json::json!({ "url": url, "loading": loading }),
    );
}

/// Show the view over `bounds`, creating it on first use (at `url`) and, when
/// `navigate`, sending it to `url` if it shows something else. `navigate` is
/// false when Ares already drove the page there itself over CDP — loading it
/// again would cancel Ares's own navigation. With no url and no view, nothing.
pub fn show(app: &AppHandle, url: Option<String>, navigate: bool, bounds: Bounds, profile: PathBuf) -> Result<(), String> {
    if let Some(existing) = view(app) {
        existing.set_bounds(bounds.rect()).map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        if let Some(next) = url.filter(|_| navigate) {
            let target = parse(&next)?;
            let current = existing.url().ok();
            if current.as_ref().map(|c| c.as_str()) != Some(target.as_str()) {
                existing.navigate(target).map_err(|e| e.to_string())?;
            }
        }
        return Ok(());
    }
    let Some(first) = url else { return Ok(()) };
    let target = parse(&first)?;
    let window = app.get_window("main").ok_or("the main window is gone")?;
    let _ = std::fs::create_dir_all(&profile);
    let nav = app.clone();
    let titles = app.clone();
    #[allow(unused_mut)]
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(target))
        .data_directory(profile)
        .on_page_load(move |_view, payload| {
            emit_nav(&nav, payload.url().as_str(), matches!(payload.event(), PageLoadEvent::Started));
        })
        .on_document_title_changed(move |_view, title| {
            let _ = titles.emit_to("main", "forge-view-title", serde_json::json!({ "title": title }));
        })
        // Sign-in popups ("Continue with Google") open as real popup windows
        // with window.opener intact, the way a browser does it.
        .on_new_window(|_url, _features| NewWindowResponse::Allow);
    #[cfg(windows)]
    {
        // wry's own defaults are dropped once args are set, so keep them.
        let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
        if cdp_url().is_some() {
            args.push_str(&format!(" --remote-debugging-port={}", cdp_port()));
        }
        builder = builder.additional_browser_args(&args);
    }
    let rect = bounds.rect();
    window
        .add_child(builder, rect.position, rect.size)
        .map_err(|e| format!("could not open the Forge view: {e}"))?;
    Ok(())
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(v) = view(app) {
        v.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// back | forward | reload | stop
pub fn control(app: &AppHandle, action: &str) -> Result<(), String> {
    let Some(v) = view(app) else { return Ok(()) };
    match action {
        "reload" => v.reload().map_err(|e| e.to_string()),
        "back" => v.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => v.eval("history.forward()").map_err(|e| e.to_string()),
        "stop" => v.eval("window.stop()").map_err(|e| e.to_string()),
        other => Err(format!("unknown Forge view action: {other}")),
    }
}

/// The page the view shows right now (None: no view yet).
pub fn current_url(app: &AppHandle) -> Option<String> {
    view(app).and_then(|v| v.url().ok()).map(|u| u.to_string())
}
