#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{Emitter, Listener, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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

#[derive(Serialize)]
struct DaemonStatus {
    running: bool,
    root: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Clone, Serialize)]
struct BufferedEvent {
    seq: u64,
    event: Value,
}

#[tauri::command]
fn crix_set_theme(name: String) -> String {
    name
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
        .map(|events| events.iter().filter(|event| event.seq > after).cloned().collect())
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
    push_event(&app, state.inner(), json!({ "type": "desktop_daemon_restarting" }));
    start_daemon(app, state.inner(), provider, model)
}

fn start_daemon(
    app: tauri::AppHandle,
    state: &DaemonState,
    provider: Option<String>,
    model: Option<String>,
) -> Result<DaemonStatus, String> {
    let (root, cli_entry) = resolve_crix_cli().ok_or_else(|| {
        "Could not find packages/cli/dist/entry.js. Build Crix from the repo before launching the desktop app.".to_string()
    })?;

    let provider = clean_optional(provider);
    let model = clean_optional(model);
    let mut command = Command::new("node");
    command
        .arg(&cli_entry)
        .arg("daemon")
        .arg("--json");
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
        .current_dir(&root)
        .env("CRIX_AGENT_ENABLED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start Crix daemon: {error}"))?;

    let stdin = child.stdin.take().ok_or_else(|| "daemon stdin unavailable".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "daemon stdout unavailable".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "daemon stderr unavailable".to_string())?;

    {
        let mut root_state = state.root.lock().map_err(|_| "daemon root lock failed")?;
        *root_state = Some(root.clone());
    }
    {
        let mut provider_state = state.provider.lock().map_err(|_| "daemon provider lock failed")?;
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

    spawn_output_reader(app.clone(), stdout, false, state.events.clone(), state.next_event_seq.clone());
    spawn_output_reader(app.clone(), stderr, true, state.events.clone(), state.next_event_seq.clone());
    push_event(
        &app,
        state,
        json!({
            "type": "desktop_daemon_started",
            "root": root.display().to_string(),
            "provider": provider,
            "model": model
        }),
    );

    Ok(DaemonStatus {
        running: true,
        root: Some(root.display().to_string()),
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

    let mut stdin_state = state.stdin.lock().map_err(|_| "daemon stdin lock failed")?;
    let stdin = stdin_state
        .as_mut()
        .ok_or_else(|| "Crix daemon is not running".to_string())?;
    let line = json!({ "type": "send", "goal": trimmed }).to_string();
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to send message to daemon: {error}"))
}

#[tauri::command]
fn crix_stop_daemon(app: tauri::AppHandle, state: State<DaemonState>) -> Result<(), String> {
    stop_existing_daemon(state.inner())?;
    push_event(&app, state.inner(), json!({ "type": "desktop_daemon_stopped" }));
    Ok(())
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
        let mut provider_state = state.provider.lock().map_err(|_| "daemon provider lock failed")?;
        *provider_state = None;
    }
    {
        let mut model_state = state.model.lock().map_err(|_| "daemon model lock failed")?;
        *model_state = None;
    }
    Ok(())
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
        .setup(|app| {
            let handle = app.handle().clone();
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
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crix_set_theme,
            crix_drain_events,
            crix_daemon_status,
            crix_start_daemon,
            crix_restart_daemon,
            crix_send,
            crix_stop_daemon
        ])
        .run(tauri::generate_context!())
        .expect("error while running Crix Tauri app");
}

fn daemon_status(state: &DaemonState) -> DaemonStatus {
    let running = state.child.lock().map(|child| child.is_some()).unwrap_or(false);
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
    if let Ok(mut buffer) = events.lock() {
        buffer.push(BufferedEvent {
            seq,
            event: event.clone(),
        });
        let extra = buffer.len().saturating_sub(1200);
        if extra > 0 {
            buffer.drain(0..extra);
        }
    }
    let _ = app.emit("crix:event", event);
}

fn spawn_output_reader<R>(
    app: tauri::AppHandle,
    reader: R,
    stderr: bool,
    events: Arc<Mutex<Vec<BufferedEvent>>>,
    next_event_seq: Arc<AtomicU64>,
)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else {
                break;
            };
            if stderr {
                push_event_parts(&app, &events, &next_event_seq, json!({ "type": "daemon_stderr", "text": line }));
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => {
                    push_event_parts(&app, &events, &next_event_seq, value);
                }
                Err(_) => {
                    push_event_parts(&app, &events, &next_event_seq, json!({ "type": "daemon_stdout", "text": line }));
                }
            }
        }
        push_event_parts(&app, &events, &next_event_seq, json!({ "type": "desktop_daemon_stream_closed" }));
    });
}

fn resolve_crix_cli() -> Option<(PathBuf, PathBuf)> {
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

fn cli_in_root(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let cli = root.join("packages").join("cli").join("dist").join("entry.js");
    if cli.exists() {
        Some((root.to_path_buf(), cli))
    } else {
        None
    }
}
