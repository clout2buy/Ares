#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader, Read as IoRead, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{Emitter, Listener, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_COLOR_NONE,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct DaemonState {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    root: Mutex<Option<PathBuf>>,
    provider: Mutex<Option<String>>,
    model: Mutex<Option<String>>,
    events: Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: Arc<AtomicU64>,
}

/// The local Kokoro voice sidecar (voice_service/server.py) — auto-started with
/// the app so spoken replies "just work", and killed on close.
struct VoiceState {
    child: Mutex<Option<Child>>,
}

struct CrixRuntime {
    app_root: PathBuf,
    cli_entry: PathBuf,
    node: PathBuf,
    workspace: PathBuf,
}

#[derive(Serialize)]
struct DaemonStatus {
    running: bool,
    root: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Serialize)]
struct AgentIdentity {
    name: Option<String>,
    avatar: Option<String>,
    mark: Option<String>,
}

#[derive(Clone, Serialize)]
struct BufferedEvent {
    seq: u64,
    event: Value,
}

#[derive(Serialize)]
struct OllamaModel {
    id: String,
    hint: String,
    group: String,
    source: String,
    size: Option<u64>,
    #[serde(rename = "modifiedAt")]
    modified_at: Option<String>,
    description: Option<String>,
    family: Option<String>,
    parameters: Option<String>,
    quantization: Option<String>,
    #[serde(rename = "contextWindow")]
    context_window: Option<u64>,
    modalities: Vec<String>,
    capabilities: Vec<String>,
    #[serde(rename = "storagePath")]
    storage_path: Option<String>,
}

#[derive(Serialize)]
struct OllamaDiscovery {
    host: String,
    reachable: bool,
    models: Vec<OllamaModel>,
    error: Option<String>,
    #[serde(rename = "localRoot")]
    local_root: Option<String>,
}

#[tauri::command]
fn crix_set_theme(name: String) -> String {
    name
}

#[tauri::command]
fn crix_dev_mode() -> bool {
    env::var("CRIX_DEV")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || cfg!(debug_assertions)
}

#[tauri::command]
fn crix_ollama_models() -> OllamaDiscovery {
    discover_ollama_models()
}

#[tauri::command]
fn crix_agent_identity() -> AgentIdentity {
    load_agent_identity()
}

#[tauri::command]
fn crix_self_model() -> Option<Value> {
    load_self_model()
}

#[tauri::command]
fn crix_daemon_status(state: State<DaemonState>) -> DaemonStatus {
    daemon_status(state.inner())
}

#[tauri::command]
fn crix_drain_events(state: State<DaemonState>, after: Option<u64>) -> Vec<BufferedEvent> {
    let after = after.unwrap_or(0);
    state
        .events
        .lock()
        .map(|events| {
            events
                .iter()
                .filter(|event| event.seq > after)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn crix_start_daemon(
    app: tauri::AppHandle,
    state: State<DaemonState>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<DaemonStatus, String> {
    {
        let child = state.child.lock().map_err(|_| "daemon state lock failed")?;
        if child.is_some() {
            return Ok(daemon_status(state.inner()));
        }
    }

    start_daemon(app, state.inner(), provider, model)
}

#[tauri::command]
fn crix_restart_daemon(
    app: tauri::AppHandle,
    state: State<DaemonState>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<DaemonStatus, String> {
    stop_existing_daemon(state.inner())?;
    push_event(
        &app,
        state.inner(),
        json!({ "type": "desktop_daemon_restarting" }),
    );
    start_daemon(app, state.inner(), provider, model)
}

fn start_daemon(
    app: tauri::AppHandle,
    state: &DaemonState,
    provider: Option<String>,
    model: Option<String>,
) -> Result<DaemonStatus, String> {
    let runtime = resolve_crix_runtime(Some(&app)).ok_or_else(|| {
        "Could not find Crix runtime. Rebuild the desktop runtime before launching the app."
            .to_string()
    })?;
    fs::create_dir_all(&runtime.workspace)
        .map_err(|error| format!("failed to create Crix workspace: {error}"))?;
    if let Some(home) = desktop_crix_home() {
        fs::create_dir_all(&home)
            .map_err(|error| format!("failed to create Crix home: {error}"))?;
    }

    let provider = clean_optional(provider);
    let model = clean_optional(model);
    let mut command = Command::new(&runtime.node);
    command
        .arg(&runtime.cli_entry)
        .arg("daemon")
        .arg("--json")
        .arg("--workspace")
        .arg(&runtime.workspace);
    if let Some(provider) = provider.as_ref() {
        command.arg("--provider").arg(provider);
    }
    if let Some(model) = model.as_ref() {
        command.arg("--model").arg(model);
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .current_dir(&runtime.workspace)
        .env("CRIX_AGENT_ENABLED", "1")
        .env("CRIX_HOME", desktop_crix_home_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start Crix daemon: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "daemon stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "daemon stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "daemon stderr unavailable".to_string())?;

    {
        let mut root_state = state.root.lock().map_err(|_| "daemon root lock failed")?;
        *root_state = Some(runtime.workspace.clone());
    }
    {
        let mut provider_state = state
            .provider
            .lock()
            .map_err(|_| "daemon provider lock failed")?;
        *provider_state = provider.clone();
    }
    {
        let mut model_state = state.model.lock().map_err(|_| "daemon model lock failed")?;
        *model_state = model.clone();
    }
    {
        let mut stdin_state = state.stdin.lock().map_err(|_| "daemon stdin lock failed")?;
        *stdin_state = Some(stdin);
    }
    {
        let mut child_state = state.child.lock().map_err(|_| "daemon child lock failed")?;
        *child_state = Some(child);
    }

    spawn_output_reader(
        app.clone(),
        stdout,
        false,
        state.events.clone(),
        state.next_event_seq.clone(),
    );
    spawn_output_reader(
        app.clone(),
        stderr,
        true,
        state.events.clone(),
        state.next_event_seq.clone(),
    );
    push_event(
        &app,
        state,
        json!({
            "type": "desktop_daemon_started",
            "root": runtime.workspace.display().to_string(),
            "provider": provider,
            "model": model
        }),
    );

    Ok(DaemonStatus {
        running: true,
        root: Some(runtime.workspace.display().to_string()),
        provider,
        model,
    })
}

#[tauri::command]
fn crix_send(goal: String, state: State<DaemonState>) -> Result<(), String> {
    let trimmed = goal.trim();
    if trimmed.is_empty() {
        return Err("message is empty".to_string());
    }

    write_daemon_command(state.inner(), json!({ "type": "send", "goal": trimmed }))
}

#[tauri::command]
fn crix_set_reasoning(level: String, state: State<DaemonState>) -> Result<(), String> {
    let level = level.trim().to_ascii_lowercase();
    if !matches!(level.as_str(), "low" | "medium" | "high" | "max") {
        return Err("reasoning level must be low, medium, high, or max".to_string());
    }

    write_daemon_command(
        state.inner(),
        json!({ "type": "reasoning", "level": level }),
    )
}

#[tauri::command]
fn crix_set_routing(routing: Value, state: State<DaemonState>) -> Result<(), String> {
    // The owner's per-lane model assignments. Passed through verbatim; the
    // daemon resolves it against @crix/core resolveRoute() on the live turn.
    write_daemon_command(
        state.inner(),
        json!({ "type": "routing", "routing": routing }),
    )
}

#[tauri::command]
fn crix_set_openrouter_key(
    key: String,
    model: Option<String>,
    state: State<DaemonState>,
) -> Result<(), String> {
    // The owner's OpenRouter API key (pasted in-app). Persisted to ui.json by
    // the daemon; applied when the daemon next starts on the openrouter provider.
    write_daemon_command(
        state.inner(),
        json!({ "type": "openrouter_key", "key": key, "model": model }),
    )
}

#[tauri::command]
fn crix_permission_response(
    id: Option<String>,
    decision: String,
    state: State<DaemonState>,
) -> Result<(), String> {
    let decision = decision.trim();
    if !matches!(decision, "allow_once" | "allow_always" | "deny") {
        return Err("permission decision must be allow_once, allow_always, or deny".to_string());
    }

    write_daemon_command(
        state.inner(),
        json!({ "type": "permission_response", "id": id, "decision": decision }),
    )
}

fn write_daemon_command(state: &DaemonState, command: Value) -> Result<(), String> {
    let mut stdin_state = state.stdin.lock().map_err(|_| "daemon stdin lock failed")?;
    let stdin = stdin_state
        .as_mut()
        .ok_or_else(|| "Crix daemon is not running".to_string())?;
    let line = command.to_string();
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to send message to daemon: {error}"))
}

#[tauri::command]
fn crix_stop_daemon(app: tauri::AppHandle, state: State<DaemonState>) -> Result<(), String> {
    stop_existing_daemon(state.inner())?;
    push_event(
        &app,
        state.inner(),
        json!({ "type": "desktop_daemon_stopped" }),
    );
    Ok(())
}

#[tauri::command]
fn crix_window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    window
        .minimize()
        .map_err(|error| format!("failed to minimize window: {error}"))
}

#[tauri::command]
fn crix_window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    let maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to read maximize state: {error}"))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|error| format!("failed to unmaximize window: {error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("failed to maximize window: {error}"))
    }
}

#[tauri::command]
fn crix_window_close(app: tauri::AppHandle, state: State<DaemonState>) -> Result<(), String> {
    let _ = stop_existing_daemon(state.inner());
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    window
        .close()
        .map_err(|error| format!("failed to close window: {error}"))
}

fn stop_existing_daemon(state: &DaemonState) -> Result<(), String> {
    {
        let mut stdin_state = state.stdin.lock().map_err(|_| "daemon stdin lock failed")?;
        *stdin_state = None;
    }

    let mut child_state = state.child.lock().map_err(|_| "daemon child lock failed")?;
    if let Some(mut child) = child_state.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    {
        let mut provider_state = state
            .provider
            .lock()
            .map_err(|_| "daemon provider lock failed")?;
        *provider_state = None;
    }
    {
        let mut model_state = state.model.lock().map_err(|_| "daemon model lock failed")?;
        *model_state = None;
    }
    Ok(())
}

#[cfg(windows)]
fn voice_python(root: &Path) -> std::ffi::OsString {
    let venv = root
        .join(".crix")
        .join("voice-venv")
        .join("Scripts")
        .join("python.exe");
    if venv.exists() {
        venv.into_os_string()
    } else {
        std::ffi::OsString::from("python")
    }
}

#[cfg(not(windows))]
fn voice_python(root: &Path) -> std::ffi::OsString {
    let venv = root
        .join(".crix")
        .join("voice-venv")
        .join("bin")
        .join("python");
    if venv.exists() {
        venv.into_os_string()
    } else {
        std::ffi::OsString::from("python3")
    }
}

/// Spawn voice_service/server.py headlessly. Best-effort: if Python / the venv /
/// the script is missing, or the port is already taken by a manual sidecar, the
/// child simply exits and chat is unaffected.
fn start_voice_sidecar(app: &tauri::AppHandle, state: &VoiceState) {
    if let Ok(guard) = state.child.lock() {
        if guard.is_some() {
            return;
        }
    }
    let Some(runtime) = resolve_crix_runtime(Some(app)) else {
        return;
    };
    let script = runtime.app_root.join("voice_service").join("server.py");
    if !script.exists() {
        return;
    }
    let mut command = Command::new(voice_python(&runtime.app_root));
    command.arg(&script).current_dir(&runtime.app_root);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Ok(child) = command.spawn() {
        if let Ok(mut guard) = state.child.lock() {
            *guard = Some(child);
        }
    }
}

fn stop_voice_sidecar(state: &VoiceState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(DaemonState {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            root: Mutex::new(None),
            provider: Mutex::new(None),
            model: Mutex::new(None),
            events: Arc::new(Mutex::new(Vec::new())),
            next_event_seq: Arc::new(AtomicU64::new(1)),
        })
        .manage(VoiceState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                hide_windows_accent_border(&window);
            }
            // Auto-start the local voice sidecar so spoken replies work out of the box.
            if let Some(voice) = app.try_state::<VoiceState>() {
                start_voice_sidecar(&handle, voice.inner());
            }
            app.listen("tauri://close-requested", move |_| {
                if let Some(state) = handle.try_state::<DaemonState>() {
                    let mut stdin_state = state.stdin.lock().ok();
                    if let Some(stdin_state) = stdin_state.as_mut() {
                        **stdin_state = None;
                    }
                    if let Ok(mut child_state) = state.child.lock() {
                        if let Some(mut child) = child_state.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
                if let Some(voice) = handle.try_state::<VoiceState>() {
                    stop_voice_sidecar(voice.inner());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crix_set_theme,
            crix_dev_mode,
            crix_ollama_models,
            crix_agent_identity,
            crix_self_model,
            crix_drain_events,
            crix_daemon_status,
            crix_start_daemon,
            crix_restart_daemon,
            crix_send,
            crix_set_reasoning,
            crix_set_routing,
            crix_set_openrouter_key,
            crix_permission_response,
            crix_stop_daemon,
            crix_window_minimize,
            crix_window_toggle_maximize,
            crix_window_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Crix Tauri app");
}

#[cfg(windows)]
fn hide_windows_accent_border(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        let color = DWMWA_COLOR_NONE;
        // Suppress BOTH the window border and the top caption edge. On Win11 a
        // frameless + transparent window otherwise bleeds the system accent
        // colour as a line across the very top — clearing only the border
        // leaves that top sliver, so we clear the caption colour too.
        for attr in [DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR] {
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd.0 as _,
                    attr as u32,
                    &color as *const _ as *const core::ffi::c_void,
                    std::mem::size_of_val(&color) as u32,
                );
            }
        }
    }
}

fn daemon_status(state: &DaemonState) -> DaemonStatus {
    let running = state
        .child
        .lock()
        .map(|child| child.is_some())
        .unwrap_or(false);
    let root = state
        .root
        .lock()
        .ok()
        .and_then(|root| root.as_ref().map(|path| path.display().to_string()));
    let provider = state.provider.lock().ok().and_then(|value| value.clone());
    let model = state.model.lock().ok().and_then(|value| value.clone());
    DaemonStatus {
        running,
        root,
        provider,
        model,
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn push_event(app: &tauri::AppHandle, state: &DaemonState, event: Value) {
    push_event_parts(app, &state.events, &state.next_event_seq, event);
}

fn push_event_parts(
    app: &tauri::AppHandle,
    events: &Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: &Arc<AtomicU64>,
    event: Value,
) {
    let seq = next_event_seq.fetch_add(1, Ordering::SeqCst);
    let buffered = BufferedEvent {
        seq,
        event: event.clone(),
    };
    if let Ok(mut buffer) = events.lock() {
        buffer.push(buffered.clone());
        let extra = buffer.len().saturating_sub(1200);
        if extra > 0 {
            buffer.drain(0..extra);
        }
    }
    let _ = app.emit("crix:event-buffered", buffered);
    let _ = app.emit("crix:event", event);
}

fn spawn_output_reader<R>(
    app: tauri::AppHandle,
    reader: R,
    stderr: bool,
    events: Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: Arc<AtomicU64>,
) where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else {
                break;
            };
            if stderr {
                push_event_parts(
                    &app,
                    &events,
                    &next_event_seq,
                    json!({ "type": "daemon_stderr", "text": line }),
                );
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => {
                    push_event_parts(&app, &events, &next_event_seq, value);
                }
                Err(_) => {
                    push_event_parts(
                        &app,
                        &events,
                        &next_event_seq,
                        json!({ "type": "daemon_stdout", "text": line }),
                    );
                }
            }
        }
        push_event_parts(
            &app,
            &events,
            &next_event_seq,
            json!({ "type": "desktop_daemon_stream_closed" }),
        );
    });
}

fn discover_ollama_models() -> OllamaDiscovery {
    let host = env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".to_string());
    let (mut models, local_root) = discover_ollama_manifests();
    let parsed = match parse_http_host(&host) {
        Some(parsed) => parsed,
        None => {
            return OllamaDiscovery {
                host,
                reachable: false,
                models,
                error: Some("OLLAMA_HOST must be an http://host:port URL".to_string()),
                local_root,
            };
        }
    };

    let tags = match http_json(&parsed, "GET", "/api/tags", None) {
        Ok(value) => value,
        Err(error) => {
            models.sort_by(|a, b| a.id.cmp(&b.id));
            return OllamaDiscovery {
                host: parsed.display,
                reachable: false,
                models,
                error: Some(error),
                local_root,
            };
        }
    };

    let mut seen = models
        .iter()
        .map(|model| model.id.clone())
        .collect::<HashSet<_>>();
    if let Some(items) = tags.get("models").and_then(|value| value.as_array()) {
        for item in items.iter().take(80) {
            let Some(id) = item
                .get("name")
                .or_else(|| item.get("model"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let show = http_json(&parsed, "POST", "/api/show", Some(json!({ "model": id }))).ok();
            let api_model = ollama_model_from_api_item(id, item, show.as_ref(), &local_root);
            if seen.insert(api_model.id.clone()) {
                models.push(api_model);
            } else if let Some(existing) = models.iter_mut().find(|model| model.id == id) {
                merge_api_model(existing, api_model);
            }
        }
    }

    models.sort_by(|a, b| a.id.cmp(&b.id));
    OllamaDiscovery {
        host: parsed.display,
        reachable: true,
        models,
        error: None,
        local_root,
    }
}

fn load_agent_identity() -> AgentIdentity {
    let mut candidates = Vec::new();
    if let Ok(home) = env::var("CRIX_HOME") {
        candidates.push(PathBuf::from(home).join("IDENTITY.md"));
    }
    if let Some(home) = desktop_crix_home() {
        candidates.push(home.join("IDENTITY.md"));
    }

    for path in candidates {
        if let Ok(text) = fs::read_to_string(path) {
            let name = extract_identity_field(&text, &["Name"]);
            let avatar = extract_identity_field(&text, &["Avatar", "Picture", "Icon", "Emoji"]);
            let mark =
                extract_identity_field(&text, &["Mark", "Plain-text mark", "Plain text mark"]);
            return AgentIdentity { name, avatar, mark };
        }
    }

    AgentIdentity {
        name: None,
        avatar: None,
        mark: None,
    }
}

fn load_self_model() -> Option<Value> {
    let mut candidates = Vec::new();
    if let Ok(home) = env::var("CRIX_HOME") {
        candidates.push(PathBuf::from(home).join("self").join("model.json"));
    }
    if let Some(home) = desktop_crix_home() {
        candidates.push(home.join("self").join("model.json"));
    }

    for path in candidates {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                return Some(value);
            }
        }
    }
    None
}

fn extract_identity_field(text: &str, keys: &[&str]) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches('-').trim();
        for key in keys {
            let prefix = format!("{key}:");
            if let Some(value) = trimmed.strip_prefix(&prefix) {
                let value = value.trim().trim_matches('*').trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn user_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn ollama_model_from_api_item(
    id: &str,
    item: &Value,
    show: Option<&Value>,
    local_root: &Option<String>,
) -> OllamaModel {
    let details = show
        .and_then(|value| value.get("details"))
        .or_else(|| item.get("details"));
    let model_info = show.and_then(|value| value.get("model_info"));
    let family = details
        .and_then(|value| value.get("family"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            model_info
                .and_then(|value| value.get("general.architecture"))
                .and_then(|value| value.as_str())
        });
    let parameters = details
        .and_then(|value| value.get("parameter_size"))
        .and_then(|value| value.as_str());
    let quant = details
        .and_then(|value| value.get("quantization_level"))
        .and_then(|value| value.as_str());
    let context = model_info
        .and_then(|value| value.get("llama.context_length"))
        .or_else(|| model_info.and_then(|value| value.get("qwen3.context_length")))
        .or_else(|| model_info.and_then(|value| value.get("gemma3.context_length")))
        .and_then(|value| value.as_u64());
    let capabilities = show
        .and_then(|value| value.get("capabilities"))
        .and_then(|value| value.as_array())
        .map(|values| string_array(values))
        .unwrap_or_default();
    let modalities = modalities_from_capabilities(&capabilities);
    let hint = hint_from_parts(family, parameters, quant);

    OllamaModel {
        id: id.to_string(),
        hint: if hint.is_empty() {
            "Local Ollama model".to_string()
        } else {
            hint
        },
        group: "local".to_string(),
        source: "local".to_string(),
        size: item.get("size").and_then(|value| value.as_u64()),
        modified_at: item
            .get("modified_at")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        description: Some(local_model_description(id, family, local_root)),
        family: family.map(str::to_string),
        parameters: parameters.map(str::to_string),
        quantization: quant.map(str::to_string),
        context_window: context,
        modalities,
        capabilities,
        storage_path: local_root.clone(),
    }
}

fn merge_api_model(existing: &mut OllamaModel, api_model: OllamaModel) {
    existing.hint = api_model.hint;
    existing.size = api_model.size.or(existing.size);
    existing.modified_at = api_model
        .modified_at
        .or_else(|| existing.modified_at.clone());
    existing.description = api_model
        .description
        .or_else(|| existing.description.clone());
    existing.family = api_model.family.or_else(|| existing.family.clone());
    existing.parameters = api_model.parameters.or_else(|| existing.parameters.clone());
    existing.quantization = api_model
        .quantization
        .or_else(|| existing.quantization.clone());
    existing.context_window = api_model.context_window.or(existing.context_window);
    if !api_model.modalities.is_empty() {
        existing.modalities = api_model.modalities;
    }
    if !api_model.capabilities.is_empty() {
        existing.capabilities = api_model.capabilities;
    }
    existing.storage_path = api_model
        .storage_path
        .or_else(|| existing.storage_path.clone());
}

fn discover_ollama_manifests() -> (Vec<OllamaModel>, Option<String>) {
    let roots = ollama_model_roots();
    for root in roots {
        let manifests = root.join("manifests");
        let blobs = root.join("blobs");
        if !manifests.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_files(&manifests, &mut files);
        let mut models = Vec::new();
        for file in files {
            if let Some(model) = ollama_model_from_manifest(&root, &manifests, &blobs, &file) {
                models.push(model);
            }
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models.dedup_by(|a, b| a.id == b.id);
        return (models, Some(root.display().to_string()));
    }
    (Vec::new(), None)
}

fn ollama_model_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(value) = env::var("OLLAMA_MODELS") {
        push_model_root(&mut roots, PathBuf::from(value));
    }
    if let Ok(profile) = env::var("USERPROFILE") {
        push_model_root(
            &mut roots,
            PathBuf::from(profile).join(".ollama").join("models"),
        );
    }
    if let Ok(home) = env::var("HOME") {
        push_model_root(
            &mut roots,
            PathBuf::from(home).join(".ollama").join("models"),
        );
    }
    roots
}

fn push_model_root(roots: &mut Vec<PathBuf>, raw: PathBuf) {
    let root = if raw.join("manifests").is_dir() {
        raw
    } else if raw.join("models").join("manifests").is_dir() {
        raw.join("models")
    } else {
        raw
    };
    if root.join("manifests").is_dir() && !roots.iter().any(|item| item == &root) {
        roots.push(root);
    }
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

fn ollama_model_from_manifest(
    root: &Path,
    manifests: &Path,
    blobs: &Path,
    file: &Path,
) -> Option<OllamaModel> {
    let id = model_id_from_manifest_path(manifests, file)?;
    let text = fs::read_to_string(file).ok()?;
    let manifest: Value = serde_json::from_str(&text).ok()?;
    let config_digest = manifest
        .get("config")
        .and_then(|value| value.get("digest"))
        .and_then(|value| value.as_str());
    let config = config_digest.and_then(|digest| read_blob_json(blobs, digest));
    if config
        .as_ref()
        .and_then(|value| value.get("remote_host"))
        .and_then(|value| value.as_str())
        .is_some()
        || id.contains("-cloud")
        || id.ends_with(":cloud")
    {
        return None;
    }

    let size = manifest
        .get("layers")
        .and_then(|value| value.as_array())
        .map(|layers| {
            layers
                .iter()
                .filter_map(|layer| layer.get("size").and_then(|value| value.as_u64()))
                .sum()
        });
    let family = config
        .as_ref()
        .and_then(|value| value.get("model_family"))
        .and_then(|value| value.as_str());
    let parameters = config
        .as_ref()
        .and_then(|value| value.get("model_type"))
        .and_then(|value| value.as_str());
    let quant = config
        .as_ref()
        .and_then(|value| value.get("file_type"))
        .and_then(|value| value.as_str());
    let context = config
        .as_ref()
        .and_then(|value| value.get("context_length"))
        .and_then(|value| value.as_u64());
    let capabilities = config
        .as_ref()
        .and_then(|value| value.get("capabilities"))
        .and_then(|value| value.as_array())
        .map(|values| string_array(values))
        .unwrap_or_else(|| vec!["completion".to_string()]);
    let modalities = modalities_from_capabilities(&capabilities);
    let modified_at = fs::metadata(file)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string());
    let hint = hint_from_parts(family, parameters, quant);

    Some(OllamaModel {
        id: id.clone(),
        hint: if hint.is_empty() {
            "Local manifest model".to_string()
        } else {
            hint
        },
        group: "local".to_string(),
        source: "local".to_string(),
        size,
        modified_at,
        description: Some(local_model_description(
            &id,
            family,
            &Some(root.display().to_string()),
        )),
        family: family.map(str::to_string),
        parameters: parameters.map(str::to_string),
        quantization: quant.map(str::to_string),
        context_window: context,
        modalities,
        capabilities,
        storage_path: Some(root.display().to_string()),
    })
}

fn model_id_from_manifest_path(manifests: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(manifests).ok()?;
    let parts = rel
        .iter()
        .map(|part| part.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    if parts.len() < 4 {
        return None;
    }
    let namespace = &parts[1];
    let name = &parts[2];
    let tag = parts.last()?;
    if namespace == "library" {
        Some(format!("{name}:{tag}"))
    } else {
        Some(format!("{namespace}/{name}:{tag}"))
    }
}

fn read_blob_json(blobs: &Path, digest: &str) -> Option<Value> {
    let file = digest.replace(':', "-");
    let text = fs::read_to_string(blobs.join(file)).ok()?;
    serde_json::from_str(&text).ok()
}

fn hint_from_parts(family: Option<&str>, parameters: Option<&str>, quant: Option<&str>) -> String {
    [family, parameters, quant]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}

fn string_array(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn modalities_from_capabilities(capabilities: &[String]) -> Vec<String> {
    let mut modalities = vec!["Text".to_string()];
    if capabilities
        .iter()
        .any(|item| item.contains("vision") || item.contains("image"))
    {
        modalities.push("Image".to_string());
    }
    if capabilities.iter().any(|item| item.contains("tools")) {
        modalities.push("Tools".to_string());
    }
    modalities
}

fn local_model_description(id: &str, family: Option<&str>, local_root: &Option<String>) -> String {
    let root = local_root
        .as_deref()
        .unwrap_or("the local Ollama model store");
    let family = family.unwrap_or_else(|| id.split(':').next().unwrap_or("local"));
    format!("{id} is installed locally under {root}. It runs through the Ollama daemon with no cloud token spend; Crix uses it as an offline {family} model when selected.")
}

struct ParsedHttpHost {
    display: String,
    connect_host: String,
    host_header: String,
    port: u16,
}

fn parse_http_host(raw: &str) -> Option<ParsedHttpHost> {
    let trimmed = raw.trim().trim_end_matches('/');
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("HTTP://"))
        .unwrap_or(trimmed);
    if without_scheme.starts_with("https://") || without_scheme.contains('/') {
        return None;
    }
    let (host, port) = if let Some((host, port)) = without_scheme.rsplit_once(':') {
        (host.to_string(), port.parse::<u16>().ok()?)
    } else {
        (without_scheme.to_string(), 11434)
    };
    if host.is_empty() {
        return None;
    }
    let connect_host = match host.as_str() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_string(),
        "localhost" => "127.0.0.1".to_string(),
        _ => host.clone(),
    };
    Some(ParsedHttpHost {
        display: format!("http://{}:{}", host, port),
        connect_host,
        host_header: host,
        port,
    })
}

fn http_json(
    host: &ParsedHttpHost,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let body_text = body.map(|value| value.to_string()).unwrap_or_default();
    let address = (host.connect_host.as_str(), host.port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve Ollama host: {error}"))?
        .next()
        .ok_or_else(|| "failed to resolve Ollama host".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(900))
        .map_err(|error| format!("Ollama not reachable: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1_200)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1_200)));
    let request = if body_text.is_empty() {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            host.host_header,
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            host.host_header,
            body_text.len(),
            body_text,
        )
    };
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("failed to query Ollama: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("failed to read Ollama response: {error}"))?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .ok_or_else(|| "invalid Ollama HTTP response".to_string())?;
    serde_json::from_str(body).map_err(|error| format!("invalid Ollama JSON: {error}"))
}

fn resolve_crix_runtime(app: Option<&tauri::AppHandle>) -> Option<CrixRuntime> {
    if let Some(app) = app {
        if let Some(runtime) = bundled_runtime(app) {
            return Some(runtime);
        }
    }

    if let Ok(root) = env::var("CRIX_ROOT") {
        if let Some(found) = cli_in_root(Path::new(&root)) {
            return Some(found);
        }
    }

    let mut starts = Vec::new();
    if let Ok(current) = env::current_dir() {
        starts.push(current);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }

    for start in starts {
        for ancestor in start.ancestors() {
            if let Some(found) = cli_in_root(ancestor) {
                return Some(found);
            }
        }
    }

    None
}

fn bundled_runtime(app: &tauri::AppHandle) -> Option<CrixRuntime> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        push_runtime_candidates(&mut candidates, resource_dir);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_runtime_candidates(&mut candidates, parent.to_path_buf());
        }
    }

    let mut seen = HashSet::new();
    for root in candidates {
        if seen.insert(root.clone()) {
            if let Some(runtime) = runtime_at(&root) {
                return Some(runtime);
            }
        }
    }
    None
}

fn push_runtime_candidates(candidates: &mut Vec<PathBuf>, root: PathBuf) {
    candidates.push(root.join("runtime"));
    candidates.push(root);
}

fn runtime_at(root: &Path) -> Option<CrixRuntime> {
    let cli = root.join("cli").join("crix-cli.mjs");
    let node = root
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if cli.exists() && node.exists() {
        return Some(CrixRuntime {
            app_root: root.to_path_buf(),
            cli_entry: cli,
            node,
            workspace: desktop_workspace_dir(),
        });
    }
    None
}

fn cli_in_root(root: &Path) -> Option<CrixRuntime> {
    let cli = root
        .join("packages")
        .join("cli")
        .join("dist")
        .join("entry.js");
    if cli.exists() {
        Some(CrixRuntime {
            app_root: root.to_path_buf(),
            cli_entry: cli,
            node: PathBuf::from("node"),
            workspace: env::var("CRIX_WORKSPACE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| root.to_path_buf()),
        })
    } else {
        None
    }
}

fn desktop_workspace_dir() -> PathBuf {
    if let Ok(value) = env::var("CRIX_WORKSPACE") {
        return PathBuf::from(value);
    }
    user_desktop_dir()
        .unwrap_or_else(|| user_home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("Crix Workspace")
}

fn desktop_crix_home() -> Option<PathBuf> {
    if let Ok(value) = env::var("CRIX_HOME") {
        return Some(PathBuf::from(value));
    }
    user_config_dir()
        .or_else(|| user_home_dir().map(|home| home.join(".config")))
        .map(|dir| dir.join("Crix").join("home"))
}

fn desktop_crix_home_string() -> String {
    desktop_crix_home()
        .unwrap_or_else(|| PathBuf::from(".crix-home"))
        .display()
        .to_string()
}

fn user_desktop_dir() -> Option<PathBuf> {
    user_home_dir().map(|home| home.join("Desktop"))
}

fn user_config_dir() -> Option<PathBuf> {
    if let Ok(value) = env::var("APPDATA") {
        return Some(PathBuf::from(value));
    }
    if let Ok(value) = env::var("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(value));
    }
    user_home_dir().map(|home| {
        if cfg!(target_os = "macos") {
            home.join("Library").join("Application Support")
        } else {
            home.join(".config")
        }
    })
}
