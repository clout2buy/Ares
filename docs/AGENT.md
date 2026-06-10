# Ares Agent Layer

Ares v4 adds a mind package on top of the existing harness.

## Boundary

- `packages/agent/` owns identity, bootstrap, recall, heartbeat, dreaming, self-revision signals, and learned skill proposals.
- `packages/core/` and `packages/tools/` remain the harness. They do not import the agent package.
- The CLI consumes the agent package the same way a future Tauri UI or headless runner can.

## Bootstrap

Run:

```bash
ares agent bootstrap
```

That creates the `~/.ares` scaffold and `BOOTSTRAP.md` if identity does not exist yet.

To complete bootstrap non-interactively:

```bash
ares agent bootstrap --user Clout --name Ares --creature "coding daemon" --vibe direct --emoji "*"
```

This writes:

- `~/.ares/IDENTITY.md`
- `~/.ares/SOUL.md`
- `~/.ares/USER.md`
- `~/.ares/HEARTBEAT.md`
- `~/.ares/MEMORY.md`
- `<workspace>/.ares/TOOLS.md`

## Memory

Default memory configuration is written to `~/.ares/config.json`.

The preferred stack is:

- embeddings: Ollama `bge-m3`
- store: `better-sqlite3` with optional `sqlite-vec`

If native sqlite dependencies are unavailable, Ares uses an explicit JSON vector fallback and reports that in:

```bash
ares agent doctor
```

## Lifecycle

The agent layer exposes:

- heartbeat: `runHeartbeatTick`
- LIGHT dreaming: `runLightDream`
- DEEP dreaming: `ares agent dream deep`
- REM dreaming: `ares agent dream rem`
- recall injection: `recallForTurn`
- self-revise signal: `beforeAgentFinalizeSignal`
- skill proposals: `proposeSkills`

## UI

The default TUI includes the cleaner `graphite` and `oxide` themes:

```bash
ares theme graphite
ares theme oxide
```

The optional Tauri companion scaffold lives in `tauri/` and talks to:

```bash
ares daemon --json
```

The default CLI install remains slim; Tauri is opt-in.
