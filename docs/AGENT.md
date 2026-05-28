# Crix Agent Layer

Crix v4 adds a mind package on top of the existing harness.

## Boundary

- `packages/agent/` owns identity, bootstrap, recall, heartbeat, dreaming, self-revision signals, and learned skill proposals.
- `packages/core/` and `packages/tools/` remain the harness. They do not import the agent package.
- The CLI consumes the agent package the same way a future Tauri UI or headless runner can.

## Bootstrap

Run:

```bash
crix agent bootstrap
```

That creates the `~/.crix` scaffold and `BOOTSTRAP.md` if identity does not exist yet.

To complete bootstrap non-interactively:

```bash
crix agent bootstrap --user Clout --name Crix --creature "coding daemon" --vibe direct --emoji "*"
```

This writes:

- `~/.crix/IDENTITY.md`
- `~/.crix/SOUL.md`
- `~/.crix/USER.md`
- `~/.crix/HEARTBEAT.md`
- `~/.crix/MEMORY.md`
- `<workspace>/.crix/TOOLS.md`

## Memory

Default memory configuration is written to `~/.crix/config.json`.

The preferred stack is:

- embeddings: Ollama `bge-m3`
- store: `better-sqlite3` with optional `sqlite-vec`

If native sqlite dependencies are unavailable, Crix uses an explicit JSON vector fallback and reports that in:

```bash
crix agent doctor
```

## Lifecycle

The agent layer exposes:

- heartbeat: `runHeartbeatTick`
- LIGHT dreaming: `runLightDream`
- DEEP dreaming: `crix agent dream deep`
- REM dreaming: `crix agent dream rem`
- recall injection: `recallForTurn`
- self-revise signal: `beforeAgentFinalizeSignal`
- skill proposals: `proposeSkills`

## UI

The default TUI includes the cleaner `graphite` and `oxide` themes:

```bash
crix theme graphite
crix theme oxide
```

The optional Tauri companion scaffold lives in `tauri/` and talks to:

```bash
crix daemon --json
```

The default CLI install remains slim; Tauri is opt-in.
