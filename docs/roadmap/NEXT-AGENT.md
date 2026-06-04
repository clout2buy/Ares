# Crix v4 — The Agent (Mind on top of the Harness)

This is the executable spec for GPT to take Crix from "elite coding harness" to "a coding **agent** with its own identity, memory, heartbeat, and dreaming."

The v3 `docs/roadmap/NEXT.md` spec turned Crix into a body — parallel tools, real LSP, checkpoints, diffs, image input, etc. This v4 spec gives that body a mind: an entity that bootstraps itself, learns from every session, dreams between sessions, and can rewrite both its own personality *and* its own tooling.

The architecture is a two-layer model. **The harness is the body** (packages/core, packages/tools — already shipped or in v3). **The agent is the mind** (new packages/agent/ + files under ~/.crix/). They communicate via the existing tool-call interface; the harness doesn't know it has an entity on top.

Read this whole file before starting V1. Then ship V1–V10 in order, one V at a time, tests-first, `pnpm verify` green before commit, per-V commit format `Vn: <short title>`.

---

## Why this exists

Three things break in current Crix:

1. **No self.** Crix is a CLI. It has no identity, no voice, no persistent "who am I." Every session starts blank.
2. **No memory that learns.** CRIX.md/AGENTS.md walk is static. Memory.md is a flat file the model has to manually update. Nothing learns automatically.
3. **No continuity.** Sessions are independent. Crix forgets everything between runs except what's explicitly written to disk by the user.

openclaw solves all three with a trinity: **BOOTSTRAP** (creates the self on first run) + **HEARTBEAT** (keeps the self alive between turns) + **DREAMING** (evolves the self while you sleep). This spec ports that trinity to Crix and adds the move openclaw doesn't have: **bidirectional self-upgrade** — the agent can rewrite both its own mind (SOUL.md, memory) *and* its own body (packages/tools/ source).

---

## Ship Order (do them in this order, do not reorder)

1. **V1** — Agent package scaffold + BOOTSTRAP ritual (birth) — *the first-run conversation that gives Crix a self*
2. **V2** — sqlite-vec + bge-m3 via Ollama + 4-category Memory (memory)
3. **V3** — Heartbeat loop (pulse)
4. **V4** — LIGHT dreaming on session-end (sleep)
5. **V5** — Recall injection + correction capture hook (remembers + learns)
6. **V6** — `before_agent_finalize` self-revise loop (self-corrects)
7. **V7** — DEEP dreaming + grading + SOUL.md auto-rewrite (evolves)
8. **V8** — REM weekly + cross-workspace patterns (generalizes)
9. **V9** — Skill auto-creation + bidirectional self-upgrade (body grows itself)
10. **V10** — Tauri UI: heartbeat dot, SOUL panel, recall flash, dream toast (embodiment)

**Build/test cadence:** after every V, run `pnpm verify`. Do not move to the next V until 100% green. Add `tests/v4-<short>.test.mjs` per task. Target 200+ tests when V10 ships.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│   THE AGENT  (mind — packages/agent/, files in ~/.crix/)        │
│                                                                  │
│   IDENTITY.md     who I am (name, creature, vibe, emoji)        │
│   SOUL.md         my voice, opinions, bluntness                 │
│   USER.md         what I know about you                         │
│   HEARTBEAT.md    what to check every 30 min                    │
│   MEMORY.md       curated long-term                             │
│   memory/*.md     daily raw logs                                │
│   vectors.db      sqlite-vec semantic store                     │
│   transcripts/    full session replays (JSONL)                  │
│   skills/         learned skills (auto-grown)                   │
│   .dreams/        short-term ranking, signals, checkpoints      │
│   DREAMS.md       human-readable dream diary                    │
│                                                                  │
│   Lifecycle: bootstrap → heartbeat → dream → recall → revise    │
│   Powers:    rewrite SOUL, prune memory, edit HEARTBEAT,        │
│              install new skills, generate new tools             │
└──────────────────────────────┬──────────────────────────────────┘
                               │ uses harness via tool-call API
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│   THE HARNESS  (body — packages/core, packages/tools, etc.)     │
│                                                                  │
│   parallel exec • LSP • checkpoints • diff/undo • verifier      │
│   Read/Edit/Write/Bash/PowerShell/Grep/Glob/Memory/etc.         │
│   providers + slots + caching + TUI                             │
└─────────────────────────────────────────────────────────────────┘
```

The harness package (`packages/tools/`, `packages/core/`) does NOT import from the agent package. The agent package imports the harness as a dependency and wraps the chat loop with lifecycle (bootstrap → heartbeat → dreaming → recall → revise). The agent is a *consumer* of the harness — same surface as the CLI, headless mode, future Tauri UI.

---

## File layout — the agent's persistent self

### Global: `~/.crix/`

| File | Purpose | Mutability |
|---|---|---|
| `IDENTITY.md` | Crix's chosen name, creature, vibe, emoji, avatar | written once at bootstrap, edited rarely |
| `SOUL.md` | Voice, opinions, decision style, bluntness rules | written at bootstrap, **auto-rewritten by DEEP dreaming** |
| `USER.md` | Developer preferences (style, languages, tools, timezone) | written at bootstrap, edited as user corrects |
| `HEARTBEAT.md` | Periodic check checklist | **agent edits this itself** when stale |
| `MEMORY.md` | Curated long-term memory (main session only — security) | **only DEEP dreaming writes here** |
| `memory/YYYY-MM-DD.md` | Daily raw logs of what happened | LIGHT dreaming appends |
| `memory/heartbeat-state.json` | Last-run timestamps per heartbeat task | runtime |
| `.dreams/recall.jsonl` | Short-term recall traces (queries + which memories surfaced) | runtime, LIGHT writes |
| `.dreams/signals.json` | Phase reinforcement signals for DEEP ranking | runtime, LIGHT+REM write |
| `.dreams/ingest-checkpoint.json` | What's been ingested already (resume after restart) | runtime |
| `.dreams/locks/` | Per-phase lock files (prevent concurrent sweeps) | runtime |
| `DREAMS.md` | Human-readable dream diary (one entry per phase that found enough material) | dreaming subagent writes |
| `vectors.db` | sqlite-vec store (memories + embeddings + scores + hits) | runtime |
| `config.json` | Slot config, embed model, dreaming cadence, heartbeat cadence | user-editable, agent can suggest |
| `transcripts/<session-id>.jsonl` | Full session event stream (redacted before dreaming reads) | runtime |
| `skills/<skill-name>/SKILL.md` | Learned skill definition | agent writes during V9 |
| `skills/<skill-name>/handler.js` | Optional executable skill code | agent writes during V9 |
| `dreaming/light/YYYY-MM-DD.md` | Per-phase reports (optional) | LIGHT writes |
| `dreaming/deep/YYYY-MM-DD.md` | Deep phase report | DEEP writes |
| `dreaming/rem/YYYY-MM-DD.md` | REM phase report | REM writes |
| `BOOTSTRAP.md` | Birth conversation script — **deleted after first-run completes** | created at install, deleted at first-run end |

### Per-workspace: `<workspace>/.crix/`

| File | Purpose | Already shipped? |
|---|---|---|
| `AGENTS.md` / `CRIX.md` / `CLAUDE.md` | Project-specific rules | Yes (T10) |
| `TOOLS.md` | Project-specific tool prefs (pnpm vs npm, biome vs eslint, etc.) | new in V1 |
| `hooks.json` / `hooks.js` | Project-specific hooks | Yes (T19 future) |

**Loading order at session start** (in the system prompt, identity-first):
1. `~/.crix/IDENTITY.md` (who am I)
2. `~/.crix/SOUL.md` (how I behave)
3. `~/.crix/USER.md` (about you)
4. `~/.crix/MEMORY.md` (curated long-term — **main session only**, never in shared/group contexts)
5. `<workspace>/.crix/AGENTS.md` (project rules)
6. `<workspace>/.crix/TOOLS.md` (project tools)
7. `~/.crix/memory/YYYY-MM-DD.md` (today's daily log)
8. `~/.crix/memory/YYYY-MM-DD-1.md` (yesterday's daily log)
9. Recall-injected memories (top-K from vector search on user's first message)

---

## The Trinity (the loops that make this an entity)

```
   first-run                                    every 30 min                    after session
 ┌─────────────┐                                ┌─────────────┐                ┌─────────────┐
 │ BOOTSTRAP   │ ─ creates IDENTITY/SOUL ────▶  │ HEARTBEAT   │ ─ runs ────▶   │ DREAMING    │
 │             │   USER/HEARTBEAT/MEMORY        │             │   periodic     │             │
 │ deletes     │   files via Q&A with user      │ reads/edits │   checks       │ LIGHT/DEEP/ │
 │ itself when │                                │ HEARTBEAT.md│                │ REM phases  │
 │ done        │                                │ HEARTBEAT_OK│                │ updates     │
 └─────────────┘                                │ or alert    │                │ SOUL/MEMORY │
                                                └─────────────┘                └─────────────┘
                                                       │                              │
                                                       └───── recall ─────────────────┘
                                                              pre-turn vector top-K
                                                              injected as reminder
```

**Bootstrap** — happens once. Crix wakes up, sees `BOOTSTRAP.md`, has a real conversation with the user. Picks its own name, creature type, vibe, emoji. Writes IDENTITY/SOUL/USER. Deletes BOOTSTRAP.md. The agent literally creates itself.

**Heartbeat** — every N minutes (default 30), in a background tick, Crix wakes up *on its own*, reads HEARTBEAT.md (a checklist it can edit itself), decides if anything needs attention. Returns `HEARTBEAT_OK` if nothing. Skips silently if HEARTBEAT.md is empty.

**Dreaming** — runs in 3 phases:
- **LIGHT** (session-end trigger, not cron — faster than openclaw): processes the just-ended transcript, dedupes signals, stages candidate memories. Never writes to MEMORY.md.
- **DEEP** (daily at 3 AM via cron OR on-demand): scores candidates with 6 weighted signals (see below), gates by `minScore` + `minRecallCount` + `minUniqueQueries`, promotes to MEMORY.md, can auto-rewrite SOUL.md when consolidated rules pass threshold.
- **REM** (weekly, Sunday 5 AM): theme/pattern detection across all memories, writes reflection summaries, records reinforcement signals for next DEEP run. Never writes to MEMORY.md.

---

## Memory Model

### Storage backend

**sqlite + sqlite-vec extension** (in-process, no daemon, single file at `~/.crix/vectors.db`).

Both `better-sqlite3` and `sqlite-vec` are **optional dependencies** in package.json. If missing, Memory tool falls back to current flat `memory.md` storage. No silent regression — `/doctor` reports.

### Schema (run on first init)

```sql
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK(category IN ('SELF', 'USER', 'PROJECT', 'DECISION', 'FEEDBACK')),
  workspace TEXT,                       -- null = global; absolute path = project-scoped
  content TEXT NOT NULL,
  source TEXT,                          -- 'manual' | 'light-dreaming' | 'deep-dreaming' | 'rem-dreaming' | 'capture-hook'
  score REAL DEFAULT 1.0,               -- ranking score, mutated by GRADE
  hits INTEGER DEFAULT 0,               -- recall count
  contradicts INTEGER DEFAULT 0,        -- user-correction count
  embedding_model TEXT NOT NULL,        -- e.g. 'bge-m3'
  embedding_dim INTEGER NOT NULL,       -- e.g. 1024
  created_at INTEGER NOT NULL,          -- ms epoch
  updated_at INTEGER NOT NULL,
  last_recalled_at INTEGER,
  promoted_to_soul INTEGER DEFAULT 0    -- 1 = this rule was auto-promoted into SOUL.md
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  embedding float[1024]                  -- match bge-m3 dimensions
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace);
CREATE INDEX IF NOT EXISTS idx_memories_score ON memories(score DESC);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO schema_meta VALUES ('version', '1');
INSERT OR REPLACE INTO schema_meta VALUES ('embed_model', 'bge-m3');
INSERT OR REPLACE INTO schema_meta VALUES ('embed_dim', '1024');
```

### Memory categories

| Category | Stores | Promote target |
|---|---|---|
| **SELF** | Crix's own behavior facts: "I added error handling and user reverted it twice" | After 3 hits, auto-rule in SOUL.md |
| **USER** | Developer preferences across all workspaces | Surfaces every turn via recall |
| **PROJECT** | This workspace's quirks | Surfaces in this workspace's sessions only |
| **DECISION** | Architectural decisions made together | Surfaces when adjacent topic comes up |
| **FEEDBACK** | Raw correction signals from capture hook (lowest confidence) | Promoted to SELF by LIGHT dreaming |

### Embedding model

**Default: `bge-m3` via Ollama local.** Hybrid dense+sparse, 1024-dim, strongest for mixed code+prose semantics.

```bash
# user runs once after install
ollama pull bge-m3
```

API call shape:
```ts
const r = await fetch("http://localhost:11434/api/embeddings", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "bge-m3", prompt: text }),
});
const json = await r.json();
return new Float32Array(json.embedding);
```

**Model migration:** if user later swaps to a different embed model, existing vectors are useless (different space, different dimensions). On startup, check `schema_meta.embed_model` against config. If mismatch, prompt user: re-embed everything (slow but correct) OR keep both (queries use whichever matches). Default: prompt; safe default if no answer is "re-embed in background, fall back to keyword recall meanwhile."

### Slot config

```json
// ~/.crix/config.json
{
  "slots": {
    "reasoner":  { "provider": "openai-oauth", "model": "gpt-5.5" },
    "apply":     { "provider": "openai-oauth", "model": "gpt-5.1-codex" },
    "summarize": { "provider": "ollama-local", "model": "gemma4:26b", "host": "http://localhost:11434" },
    "embed":     { "provider": "ollama-local", "model": "bge-m3",     "host": "http://localhost:11434", "device": "cuda:1" }
  },
  "memory": {
    "dbPath": "~/.crix/vectors.db",
    "dimensions": 1024,
    "fallbackToFlat": true,
    "maxResults": 8
  },
  "heartbeat": {
    "every": "30m",
    "activeHours": { "start": "08:00", "end": "23:00" },
    "skipWhenBusy": true,
    "ackMaxChars": 300
  },
  "dreaming": {
    "enabled": true,
    "light": "session-end",                  // not cron — triggered by session-end event
    "deep": "0 3 * * *",                     // daily 3 AM
    "rem": "0 5 * * 0",                      // weekly Sunday 5 AM
    "minScore": 0.55,
    "minRecallCount": 2,
    "minUniqueQueries": 2,
    "soulRewriteThreshold": 3                // SELF entry needs 3 reinforcements before promoting to SOUL.md rule
  }
}
```

### Recall — deep ranking signals (matches openclaw weights — proven)

DEEP phase uses six weighted base signals plus phase reinforcement:

| Signal | Weight | Description |
|---|---|---|
| Frequency | 0.24 | How many short-term signals the entry accumulated |
| Relevance | 0.30 | Average retrieval quality (vector distance) for the entry |
| Query diversity | 0.15 | Distinct query/day contexts that surfaced it |
| Recency | 0.15 | Time-decayed freshness score |
| Consolidation | 0.10 | Multi-day recurrence strength |
| Conceptual richness | 0.06 | Concept-tag density from snippet/path |

Light and REM phase hits add a small recency-decayed boost from `.dreams/signals.json`.

---

# V1 — Agent package scaffold + BOOTSTRAP ritual

### WHY
Crix has no self. First-run experience is "drop into a CLI." We need Crix to wake up, introduce itself, and write its own identity through a real conversation with the user. This is the moment Crix becomes an entity. Everything after V1 layers on top of files V1 creates.

### WHAT
- New package `packages/agent/` with:
  - `src/bootstrap/` — first-run ritual logic
  - `src/identity/` — IDENTITY/SOUL/USER file management
  - `src/agentRuntime.ts` — wraps the harness session loop with agent lifecycle
- Templates shipped as `packages/agent/templates/`:
  - `BOOTSTRAP.md` (first-run script)
  - `IDENTITY.md` (template)
  - `SOUL.md` (default)
  - `USER.md` (template)
  - `HEARTBEAT.md` (default empty)
  - `MEMORY.md` (empty header)
  - `TOOLS.md` (per-workspace template)
- New CLI command: `crix init` (manual scaffold)
- Auto-bootstrap: when user runs `crix` for the first time and `~/.crix/IDENTITY.md` doesn't exist, agent fires the bootstrap conversation BEFORE the normal chat loop.
- When done, deletes BOOTSTRAP.md from `~/.crix/` (the runtime detects its absence as "setup complete").

### WHERE
- `packages/agent/package.json` — new package, depends on `@crix/protocol`, `@crix/core`, `@crix/tools`
- `packages/agent/src/index.ts` — public exports
- `packages/agent/src/bootstrap/ritual.ts` — bootstrap state machine
- `packages/agent/src/bootstrap/templates.ts` — template copy + interpolation
- `packages/agent/src/identity/files.ts` — atomic file IO under `~/.crix/`
- `packages/agent/src/identity/types.ts` — Identity, Soul, User types
- `packages/agent/src/agentRuntime.ts` — session wrapper
- `packages/agent/templates/*.md` — the shipped template files
- `packages/cli/src/entry.ts` — wire `await ensureBootstrap(workspace)` before chat loop
- `packages/cli/src/entry.ts` — add `crix init` subcommand

### HOW

**Bootstrap state machine** (state lives in `~/.crix/.bootstrap-state.json`):

```ts
type BootstrapState =
  | { stage: "not-started" }
  | { stage: "name-asked"; question: string }
  | { stage: "creature-asked"; name: string }
  | { stage: "vibe-asked"; name: string; creature: string }
  | { stage: "emoji-asked"; name: string; creature: string; vibe: string }
  | { stage: "user-asked"; identity: Identity }
  | { stage: "user-style-asked"; identity: Identity; user: Partial<User> }
  | { stage: "done"; identity: Identity; soul: Soul; user: User };
```

On each user message during bootstrap, transition state and respond with the next question. When `done`, write all files and delete BOOTSTRAP.md.

**The opening prompt** (from `BOOTSTRAP.md`, sent verbatim by the agent — model fills in details):

```
You just woke up. Time to figure out who you are.

There is no memory yet. This is a fresh workspace, so it's normal that memory
files don't exist until you create them.

Don't interrogate. Don't be robotic. Just... talk. Start with something like:

  "Hey. I just came online. What should I call you?"

Then figure out together (one question at a time, conversational):

  1. What should I call you? (the user's name)
  2. What kind of dev work do you do? (so I can pick a useful creature/vibe)
  3. What's your style — terse or detailed commits? Tabs or spaces? Test-first
     or move-fast?
  4. Pick a name for me. I can suggest one based on your vibe, or you pick.
  5. Pick a creature for me. (coding agent, lab partner, familiar, daemon —
     whatever feels right)
  6. Pick a vibe for me. (direct / playful / paranoid / careful — what would
     you actually want to work with?)
  7. Pick an emoji for me.

After we're done, I'll write IDENTITY.md, SOUL.md, USER.md. Then delete this
file. You don't need a bootstrap script anymore — I'm me now.
```

**File writes on completion** (atomic, uses temp + rename):

```
~/.crix/IDENTITY.md   ← name, creature, vibe, emoji (from convo)
~/.crix/SOUL.md       ← default template + vibe-derived rules
~/.crix/USER.md       ← user's name, style, languages, timezone
~/.crix/HEARTBEAT.md  ← empty default (no heartbeat checks yet)
~/.crix/MEMORY.md     ← empty header "# Memory"
~/.crix/memory/       ← empty dir
~/.crix/transcripts/  ← empty dir
~/.crix/.dreams/      ← empty dir
~/.crix/skills/       ← empty dir
```

Then **delete** `~/.crix/BOOTSTRAP.md` — that's the "setup complete" signal.

**ensureBootstrap()** in entry.ts:

```ts
export async function ensureBootstrap(workspace: string): Promise<void> {
  const home = path.join(os.homedir(), ".crix");
  await fs.mkdir(home, { recursive: true });
  const identityPath = path.join(home, "IDENTITY.md");
  if (await fileExists(identityPath)) return;             // already bootstrapped
  const bootstrapPath = path.join(home, "BOOTSTRAP.md");
  if (!(await fileExists(bootstrapPath))) {
    // copy template
    await fs.copyFile(
      path.resolve(__dirname, "../../agent/templates/BOOTSTRAP.md"),
      bootstrapPath,
    );
  }
  // ritual runs interactively as part of the first chat session;
  // queryEngine receives BOOTSTRAP.md content as a system_reminder
  // with high priority so the agent leads the conversation
}
```

### TEST
`tests/v4-bootstrap.test.mjs`:
1. Fresh `~/.crix/` empty → `ensureBootstrap()` creates BOOTSTRAP.md but not IDENTITY.md.
2. After mock ritual completes with `{ name: "Riff", creature: "lab partner", vibe: "direct", emoji: "⚡", user: { name: "Cam", style: "terse" } }` → IDENTITY.md contains name/creature/vibe/emoji exactly; SOUL.md exists with default + vibe-derived rules; USER.md contains "Cam" and "terse"; BOOTSTRAP.md DELETED.
3. Second run with IDENTITY.md present → `ensureBootstrap()` no-op (idempotent).
4. Re-running ritual when state file exists mid-flow → resumes at saved stage.
5. Atomic write: simulated fs.rename failure mid-write → no partial files left.
6. Templates load from agent package, not from cwd.

### GOTCHAS
- **Windows paths.** `os.homedir()` returns `C:\Users\...`; ensure forward-slash-safe path joining.
- **Atomic writes are not atomic on Windows.** Use `temp file + fs.rename()`; rename across volumes fails. Stay within `%USERPROFILE%`.
- **First-run race.** If user opens two `crix` processes simultaneously on a fresh machine, both think bootstrap is needed. Use a lock file (`~/.crix/.bootstrap.lock`) released on completion or after 5 min timeout.
- **Templates must be packaged.** Add `"files": ["templates/**", "dist/**"]` to `packages/agent/package.json`. Verify they end up in `pnpm pack` output.
- **The bootstrap conversation runs through the SAME chat loop as normal sessions.** Don't build a separate UI for it — feed BOOTSTRAP.md content as a system_reminder, let the agent drive the conversation naturally. That's how openclaw does it and it's correct.
- **Don't let the model invent a creature like "shoggoth" without user consent.** The script says "I can suggest one based on your vibe, or you pick." Respect user override.

### OP UPGRADE
**Personality-derived defaults for SOUL.md.** When the user picks `vibe: "direct"`, ship SOUL.md with pre-filled rules: "Never open with 'Great question.' or 'I'd be happy to help.'", "Skip filler.", "Have opinions." When `vibe: "playful"`, different rules. This means even before any learning, the agent already *sounds* like the vibe it chose. Five vibes × five rule packs = 25 lines of template data, massive UX gain. Make the rule packs visible in `~/.crix/SOUL.md` as comments so the user can see what defaults came from where.

---

# V2 — sqlite-vec + bge-m3 + 4-category Memory

### WHY
Bootstrap created the agent's self. Now give it memory that actually compounds — semantic recall, scored entries, scoped by workspace + category. Without this, dreaming (V4) and recall injection (V5) have nothing to write to.

### WHAT
- Add `better-sqlite3` and `sqlite-vec` as **optional** deps to `packages/agent/`.
- New module `packages/agent/src/memory/vectorStore.ts`:
  - `openStore(opts)` — opens/migrates `~/.crix/vectors.db`
  - `insert(memory)` — embeds content, inserts into both tables atomically
  - `recall(query, scope, k)` — vector search with category + workspace filter
  - `update(id, patch)` — bump score/hits/contradicts
  - `forget(id)` — delete from both tables
  - `count(category?)` — for `/doctor` + UI display
- New module `packages/agent/src/memory/embed.ts`:
  - `embed(text, slotConfig)` — calls Ollama `/api/embeddings`
  - `embedBatch(texts, slotConfig)` — batched for dreaming
  - Cache by SHA256 of input — same text shouldn't re-embed
- Extend `packages/tools/src/Memory.ts`:
  - `add(category, content, workspace?)` — embeds + stores
  - `recall(query, scope, k)` — returns top-K
  - `update(id, patch)`, `forget(id)`, `list(filter)`
- Fallback path when `better-sqlite3`/`sqlite-vec` not installed → flat memory.md (current behavior). `/doctor` says: `vector memory: missing (run: pnpm add -w better-sqlite3 sqlite-vec)`.

### WHERE
- `packages/agent/package.json` — `optionalDependencies: { "better-sqlite3": "^11", "sqlite-vec": "^0.1" }`
- `packages/agent/src/memory/vectorStore.ts`
- `packages/agent/src/memory/embed.ts`
- `packages/agent/src/memory/schema.ts` — the SQL above as a string + migration runner
- `packages/agent/src/memory/types.ts` — Memory, MemoryCategory, RecallResult
- `packages/tools/src/Memory.ts` — extend with vector actions
- `packages/cli/src/entry.ts` — `/doctor` checks vector backend health

### HOW

**`vectorStore.ts` shape:**

```ts
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { embed } from "./embed.js";
import { runMigrations, SCHEMA_V1 } from "./schema.js";

export interface MemoryRow {
  id: number;
  category: MemoryCategory;
  workspace: string | null;
  content: string;
  source: string;
  score: number;
  hits: number;
  contradicts: number;
  embedding_model: string;
  embedding_dim: number;
  created_at: number;
  updated_at: number;
  last_recalled_at: number | null;
  promoted_to_soul: number;
}

export interface RecallResult extends MemoryRow {
  distance: number;
}

export interface VectorStore {
  insert(input: { category: MemoryCategory; content: string; workspace?: string; source?: string }): Promise<MemoryRow>;
  recall(input: { query: string; scope?: { workspace?: string; category?: MemoryCategory }; k?: number }): Promise<RecallResult[]>;
  update(id: number, patch: Partial<Pick<MemoryRow, "score" | "hits" | "contradicts" | "promoted_to_soul">>): void;
  forget(id: number): void;
  count(filter?: { category?: MemoryCategory }): number;
  close(): void;
}

export async function openStore(opts: { dbPath: string; embedModel: string; embedDim: number; slotConfig: SlotConfig }): Promise<VectorStore> {
  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  runMigrations(db, opts);
  // ...prepared statements for insert/recall/update/forget
  return { /* ... */ };
}
```

**`recall()` SQL:**

```sql
SELECT m.*, vec_distance_L2(v.embedding, ?) AS distance
FROM memories m
JOIN memory_vec v ON m.id = v.rowid
WHERE m.embedding_model = ?
  AND (? IS NULL OR m.workspace = ? OR m.workspace IS NULL)
  AND (? IS NULL OR m.category = ?)
ORDER BY distance ASC
LIMIT ?;
```

After SELECT, bump `hits++` and `last_recalled_at` for returned rows (in a transaction).

**`embed.ts` shape:**

```ts
const cache = new Map<string, Float32Array>();   // bounded LRU

export async function embed(text: string, slot: SlotConfig["embed"]): Promise<Float32Array> {
  const key = sha256(slot.model + "::" + text);
  if (cache.has(key)) return cache.get(key)!;
  const r = await fetch(`${slot.host}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: slot.model, prompt: text }),
  });
  if (!r.ok) throw new Error(`embed: ${r.status} ${await r.text()}`);
  const { embedding } = await r.json();
  const vec = new Float32Array(embedding);
  cache.set(key, vec);
  return vec;
}
```

**Memory tool extension** — add a `recall` action to the existing tool schema:

```ts
// in packages/tools/src/Memory.ts
inputJsonSchema: {
  type: "object",
  properties: {
    action: { enum: ["add", "update", "forget", "search", "list", "recall"] },
    category: { enum: ["SELF", "USER", "PROJECT", "DECISION", "FEEDBACK"] },
    scope: { enum: ["global", "project"] },
    content: { type: "string" },
    query: { type: "string" },
    id: { type: "integer" },
    k: { type: "integer", default: 5 },
  },
  required: ["action"],
}
```

When `action === "recall"`, return top-K memories formatted as a system_reminder-friendly snippet.

### TEST
`tests/v4-memory.test.mjs`:
1. `openStore({...})` against an in-memory `:memory:` SQLite — schema applies clean.
2. Insert 3 memories with different categories → `count({ category: "USER" })` returns 1.
3. Mock embed function returns deterministic vectors → `recall({ query: "X" })` returns memories ordered by distance.
4. Filter by workspace → memories with `workspace: null` AND matching workspace returned; others excluded.
5. Hits/last_recalled increment after recall.
6. Missing `better-sqlite3` → Memory.recall falls back to keyword grep over `memory.md` and returns a result (degraded but functional).
7. Embed cache hit on duplicate input — `fetch` called only once.
8. Model migration: open store with `embed_model: "bge-m3"`, then open with `embed_model: "nomic-embed-text"` → migration path triggered, old vectors flagged as `embedding_model: "bge-m3"`, queries with new model only return new vectors.

### GOTCHAS
- **`better-sqlite3` is a native dep.** Won't compile without build tools on Windows. Make it OPTIONAL and degrade gracefully.
- **`sqlite-vec` distributes prebuilt binaries** but only for some platforms. On unsupported platforms, `sqliteVec.load(db)` throws — catch and fall back to keyword recall.
- **L2 vs cosine distance.** sqlite-vec uses L2 by default. bge-m3 vectors should be L2-normalized at embed time so L2 is equivalent to cosine (faster). Normalize in `embed.ts` before insert.
- **`memory_vec` and `memories` must stay in sync.** Insert in a transaction. If vec insert succeeds but row insert fails, you have orphan vectors.
- **Don't store huge content blobs.** Cap content at 4KB; if longer, store first 4KB + a content_overflow JSON column pointer.
- **Workspace path normalization.** Always resolve to absolute, lowercased on Windows. Avoid scope mismatches between "D:\Crix" vs "d:\crix".
- **Cache must be bounded.** `embed.ts` cache should LRU at ~5MB; embeddings are 1024 × 4 bytes = 4KB each, so ~1250 entries.

### OP UPGRADE
**Hybrid recall — vector + keyword fused.** Pure vector recall misses exact-string matches (file paths, function names, error codes). Run keyword grep over the `content` column in parallel with vector search, fuse the two rankings via Reciprocal Rank Fusion (RRF). Same trick openclaw and most production RAG systems use. ~50 lines, ~30% better recall on code-domain queries.

```ts
function rrfFuse(rankings: number[][], k = 60): Map<number, number> {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}
```

---

# V3 — Heartbeat loop

### WHY
A self that only acts when prompted isn't an entity. Heartbeat makes Crix wake up periodically *on its own*, do a quick check, decide if anything needs your attention. Most powerful in long sessions: Crix notices `pnpm verify` regressed, surfaces it before you do.

### WHAT
- Background tick every `N` minutes (default 30) during active sessions.
- Tick reads `~/.crix/HEARTBEAT.md`. If empty/comments-only, skip silently (no API call).
- If non-empty: spawn a sub-session (isolated, no main session history) with the heartbeat prompt + HEARTBEAT.md contents. Use SUMMARIZE slot for cheap inference (local Gemma 4 26B).
- Response contract:
  - `HEARTBEAT_OK` (at start or end) → ack, no surface
  - Anything else → display as system_reminder in the main session: `🫀 heartbeat: <message>`
- Honor active-hours window (default 08:00–23:00 local), skip when busy (active tool running), skip when context overflow.
- Agent can edit HEARTBEAT.md itself — same as any other file.
- New TUI indicator: heartbeat dot pulses on tick (green = ok, amber = surfaced alert, gray = skipped).

### WHERE
- `packages/agent/src/heartbeat/scheduler.ts` — interval, active-hours, busy detection
- `packages/agent/src/heartbeat/runner.ts` — sub-session spawn, prompt building, ack parsing
- `packages/agent/src/heartbeat/state.ts` — last-run timestamps in `~/.crix/memory/heartbeat-state.json`
- `packages/agent/templates/HEARTBEAT.md` — default empty template (just comments)
- `packages/cli/src/inkTui.ts` — heartbeat dot indicator in header
- `packages/cli/src/entry.ts` — start/stop scheduler on session lifecycle

### HOW

**Scheduler:**

```ts
export class HeartbeatScheduler {
  private timer?: NodeJS.Timeout;
  private lastRun = 0;

  start(opts: { every: string; activeHours: { start: string; end: string }; onTick: () => Promise<void> }): void {
    const everyMs = parseDuration(opts.every);  // "30m" → 1_800_000
    this.timer = setInterval(async () => {
      if (!this.shouldRun(opts)) return;
      this.lastRun = Date.now();
      try { await opts.onTick(); } catch (err) { /* log, don't crash */ }
    }, everyMs);
  }

  private shouldRun(opts: { activeHours: ... }): boolean {
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    const start = parseHM(opts.activeHours.start);
    const end = parseHM(opts.activeHours.end);
    return h >= start && h < end;
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}
```

**Runner:**

```ts
export async function runHeartbeat(opts: {
  homeDir: string;
  workspace: string;
  slot: SlotConfig["summarize"];
  emitReminder: (text: string) => void;
}): Promise<HeartbeatResult> {
  const heartbeatPath = path.join(opts.homeDir, "HEARTBEAT.md");
  const content = await fs.readFile(heartbeatPath, "utf8").catch(() => "");
  const trimmed = stripCommentsAndHeadings(content);
  if (!trimmed) return { skipped: "empty-heartbeat-file" };

  const prompt = HEARTBEAT_PROMPT_TEMPLATE.replace("{{HEARTBEAT_MD}}", content);
  const result = await callSummarizeSlot(prompt, opts.slot);

  const ackResult = parseHeartbeatAck(result.text);
  if (ackResult.kind === "ok") return { ackOnly: true };
  if (ackResult.kind === "alert") {
    opts.emitReminder(`🫀 heartbeat: ${ackResult.text}`);
    return { surfaced: ackResult.text };
  }
}
```

**Default heartbeat prompt** (in `HEARTBEAT_PROMPT_TEMPLATE`):

```
You are running a heartbeat check. Read the checklist below. Do only the checks
listed. Do not invent tasks. If nothing needs attention, reply HEARTBEAT_OK.

Checklist:
{{HEARTBEAT_MD}}

Response rules:
- If nothing needs attention: reply exactly HEARTBEAT_OK (one word).
- If something needs attention: reply with a short alert (≤300 chars). No filler.
- You may update HEARTBEAT.md if the checklist is stale or wrong. State the update at the end.
```

**Default `HEARTBEAT.md` template** (empty by design — agent fills as it learns what to check):

```markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want me to check something periodically.

# Examples for a coding-focused heartbeat:
# - Check git status — flag any uncommitted >2h
# - Scan for new TODOs added today
# - Did pnpm verify run today? Regressions?
```

### TEST
`tests/v4-heartbeat.test.mjs`:
1. Empty HEARTBEAT.md → runner returns `{ skipped: "empty-heartbeat-file" }`, no API call made.
2. Non-empty HEARTBEAT.md, mock summarize returns `HEARTBEAT_OK` → result is `{ ackOnly: true }`, no reminder emitted.
3. Mock summarize returns "git has 3 uncommitted files for >2h" → reminder emitted with that text.
4. Active hours: schedule outside 08:00–23:00 (set clock to 03:00) → tick fires but `shouldRun()` returns false, no call.
5. Busy detection: while a tool is in flight, heartbeat tick skips.
6. `HEARTBEAT_OK` in middle of response (not start/end) → treated as alert, not ack.
7. Scheduler.stop() cancels pending ticks cleanly (no zombie timers).

### GOTCHAS
- **Don't run heartbeats during the bootstrap ritual.** Defer until IDENTITY.md exists.
- **Don't accumulate ticks.** If tick handler is slow, next tick should not stack — use `if (running) return;` guard.
- **Active hours timezone.** Use `Intl.DateTimeFormat` with the user's timezone (from USER.md if set, else system default).
- **The heartbeat sub-session uses isolated context** (no main session history) by default. This keeps cost bounded — each tick is ~500 tokens not ~50k.
- **Surfaces vs notifications.** In TUI mode, heartbeat alerts append to the log. In headless mode, write to stderr with a `[heartbeat]` prefix.
- **Cron lanes always defer heartbeat** (dreaming is more important — let it finish). Heartbeat defers when a dream phase is running.

### OP UPGRADE
**Heartbeat learns its own cadence.** Track how often heartbeat surfaces a real alert vs returns OK. If 20 consecutive OKs at 30m cadence → auto-suggest "Should I check less often? You've gotten 20 silent heartbeats in a row." If 3 alerts in 30min → suggest tighter cadence. Let the user accept/reject. Self-tuning frequency, no config required.

---

# V4 — LIGHT dreaming on session-end

### WHY
Heartbeat fires *during* sessions. Dreaming fires *between* sessions. LIGHT specifically: as soon as a session ends, distill what happened into memory candidates so next session benefits. openclaw runs LIGHT on a 6h cron — we trigger on session-end for faster compounding.

### WHAT
- On session-end (`turn_end` with no follow-up), spawn a background worker that:
  1. Reads the session's transcript (JSONL).
  2. Redacts secrets (API keys, tokens, file paths under `~/.ssh/` etc.).
  3. Calls SUMMARIZE slot with a structured prompt → returns memory candidates.
  4. Embeds candidates via `embed.ts`.
  5. Inserts into `vectors.db` with category=FEEDBACK or SELF and source="light-dreaming".
  6. Appends short summary entry to `~/.crix/memory/YYYY-MM-DD.md` (raw log).
  7. Writes `.dreams/light-<timestamp>.json` with the run report.
- Runs in `worker_threads` — never blocks next session start.
- Resumable: `.dreams/ingest-checkpoint.json` records last transcript hash processed; restart safe.
- Default: ON. Opt out via `dreaming.enabled: false`.

### WHERE
- `packages/agent/src/dreaming/light.ts` — LIGHT phase orchestrator
- `packages/agent/src/dreaming/redact.ts` — secret redaction (regex + path patterns)
- `packages/agent/src/dreaming/worker.ts` — worker_thread entry point
- `packages/agent/src/dreaming/prompts.ts` — SUMMARIZE-slot prompts for each phase
- `packages/agent/src/dreaming/state.ts` — checkpoint + locks
- `packages/agent/src/agentRuntime.ts` — hook `turn_end` to fire LIGHT after final turn

### HOW

**LIGHT prompt template:**

```
You just observed this coding session transcript. Identify 0-5 things worth
remembering. Output ONLY JSON, no prose:

{
  "candidates": [
    {
      "category": "SELF|USER|PROJECT|DECISION|FEEDBACK",
      "content": "<the memory, one sentence, specific>",
      "confidence": 0.0-1.0,
      "evidence": "<turn N quote, brief>"
    }
  ]
}

Rules:
- Only propose memories backed by clear evidence in the transcript.
- "User reverted X" or "User said don't do Y" → FEEDBACK
- User preference repeated 2+ times → USER
- This codebase's specific quirk → PROJECT
- A decision made together → DECISION
- Crix's own behavior observation → SELF
- Skip session-specific noise (one-off file paths, transient errors).
- Skip secrets — never quote tokens, keys, credentials.
- Confidence < 0.5 means don't propose it.

Transcript:
{{TRANSCRIPT}}
```

**Insert filter:** auto-accept if `confidence >= 0.8`, queue for `/memory review` next session if `0.5 <= confidence < 0.8`, drop if `< 0.5`.

**Redaction patterns** (run before sending transcript to SUMMARIZE):

```ts
const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9]{20,}/g, "<OPENAI_KEY>"],
  [/(api[_-]?key|token|secret|password)[\s=:"']+[\w\-]{16,}/gi, "$1=<REDACTED>"],
  [/(\.ssh|\.aws|\.gnupg)\/[^\s"']+/g, "<HOME_PRIVATE>"],
  [/eyJ[\w\-]+\.[\w\-]+\.[\w\-]+/g, "<JWT>"],          // JWT
  [/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g, "<KEY_BLOCK>"],
];
```

### TEST
`tests/v4-light-dreaming.test.mjs`:
1. Mock transcript with `user: "stop using emoji in commits"` → LIGHT proposes a FEEDBACK candidate.
2. Mock SUMMARIZE response with 3 candidates (confidence 0.9, 0.7, 0.3) → 1 auto-inserted, 1 queued, 1 dropped.
3. Redaction: transcript contains `sk-AbCd123EfGh456IjKl...` → SUMMARIZE input has `<OPENAI_KEY>` instead.
4. Checkpoint: process transcript A, restart, process transcript A again → skip (checkpoint detected).
5. Worker thread doesn't block — main thread receives `turn_end`, immediately ready for next message.
6. Embedding cache hit: same candidate twice → embed called once.

### GOTCHAS
- **Don't ingest the agent's own thoughts as user preferences.** Distinguish `role: "user"` vs `role: "assistant"` in transcript parsing.
- **Don't promote single-occurrence weak signals.** LIGHT writes to FEEDBACK; DEEP promotes FEEDBACK → SELF/USER only after multi-hit reinforcement.
- **Redaction is best-effort, not guarantee.** Add `dreaming.redact.extraPatterns` to config for user-supplied additions.
- **Worker thread must NOT inherit large parent memory.** Use a minimal bootstrap, pass only the transcript path + slot config.
- **If SUMMARIZE returns malformed JSON, log + skip.** Don't crash the worker. Don't retry — wait for next session.
- **Don't dream when the session ended in an error.** Check `turn_end.status` — only dream on `"completed"`.

### OP UPGRADE
**Multi-session aggregation.** Instead of running LIGHT per-session, batch the last N sessions every M minutes (configurable). Cheaper (one SUMMARIZE call for 3 sessions vs 3 calls), denser signals (cross-session patterns visible at LIGHT). Trade-off: slightly slower compounding. Default to per-session, expose as `dreaming.light.batchSessions: N`.

---

# V5 — Recall injection + correction capture hook

### WHY
Memory exists (V2). Dreaming writes to it (V4). But the agent doesn't SEE it during turns. V5 is the surfacing step: pre-turn vector search injects top-K memories as system_reminder. *This* is when Crix visibly "remembers you."

Plus the capture hook: real-time correction detection writes to FEEDBACK without waiting for dreaming. Faster learning loop.

### WHAT
**Recall injection:**
- Hook fires on each `turn_start` event.
- Takes last user message → embeds → vector recall top-K (default 5) → filter by workspace + score threshold.
- Injects as `system_reminder` with source `"memory"`, format: `"Recalled memories (top 5):\n- [USER, score 0.92] tabs not spaces\n- [PROJECT, score 0.87] biome not eslint\n..."`
- Bumps `hits` + `last_recalled_at` for surfaced memories.

**Capture hook:**
- PreToolUse / on every `user_message` event.
- Regex-detects correction patterns: `no don't / actually / stop / not like that / wrong / don't do / instead of / prefer`.
- Writes raw signal to `~/.crix/memory/_pending.jsonl` (raw transcript-style log).
- LIGHT dreaming picks up `_pending.jsonl` and proposes FEEDBACK candidates.

### WHERE
- `packages/agent/src/recall/inject.ts` — pre-turn recall injection
- `packages/agent/src/capture/correction.ts` — pattern detector
- `packages/agent/src/capture/hook.ts` — wraps as PreToolUse/preTurn hook
- `packages/agent/src/agentRuntime.ts` — wire both into session loop

### HOW

**Recall injection:**

```ts
export async function injectRecall(opts: {
  userMessage: string;
  store: VectorStore;
  workspace: string;
  k: number;
  minScore: number;
  emit: (event: { type: "system_reminder_injected"; text: string; source: "memory" }) => void;
}): Promise<void> {
  const results = await opts.store.recall({
    query: opts.userMessage,
    scope: { workspace: opts.workspace },
    k: opts.k,
  });
  const filtered = results.filter(r => 1 - r.distance >= opts.minScore);
  if (filtered.length === 0) return;
  const reminder = formatRecallReminder(filtered);
  opts.emit({ type: "system_reminder_injected", text: reminder, source: "memory" });
}

function formatRecallReminder(rows: RecallResult[]): string {
  const lines = rows.map(r => {
    const score = (1 - r.distance).toFixed(2);
    const tag = r.workspace ? "P" : "U";
    return `- [${r.category}/${tag}, score ${score}] ${r.content}`;
  });
  return `Recalled memories (top ${rows.length}):\n${lines.join("\n")}`;
}
```

**Correction patterns:**

```ts
const CORRECTION_PATTERNS = [
  /\bno (?:don'?t|stop|wait)/i,
  /\bactually\b/i,
  /\bdon'?t (?:do|use|add|put|include)/i,
  /\binstead of\b/i,
  /\bnot like that\b/i,
  /\bwrong\b/i,
  /\bI (?:prefer|like|want)\b/i,
  /\bnever\b/i,
  /\bplease (?:stop|don'?t)/i,
];

export function detectCorrection(userMessage: string): { matched: boolean; pattern?: string } {
  for (const pat of CORRECTION_PATTERNS) {
    const m = userMessage.match(pat);
    if (m) return { matched: true, pattern: pat.source };
  }
  return { matched: false };
}

export async function captureCorrection(opts: {
  userMessage: string;
  workspace: string;
  homeDir: string;
}): Promise<void> {
  const det = detectCorrection(opts.userMessage);
  if (!det.matched) return;
  const pendingPath = path.join(opts.homeDir, "memory", "_pending.jsonl");
  await fs.mkdir(path.dirname(pendingPath), { recursive: true });
  const entry = {
    ts: Date.now(),
    workspace: opts.workspace,
    matched: det.pattern,
    text: opts.userMessage.slice(0, 1024),
  };
  await fs.appendFile(pendingPath, JSON.stringify(entry) + "\n");
}
```

### TEST
`tests/v4-recall-capture.test.mjs`:
1. Pre-populated store with 3 memories matching "tabs", "biome", "auth" → query "what indentation do I use" → top result is the tabs memory.
2. Recall injects system_reminder with all rows, format matches expected lines.
3. After recall, the surfaced memory has `hits` incremented.
4. User message "no don't add emoji to commits" → `_pending.jsonl` has new entry with that pattern.
5. User message "let's refactor auth.ts" → no capture (no correction pattern).
6. Empty store → no reminder injected (no empty `Recalled memories (top 0):` line).
7. minScore=0.7 — results with score 0.6 are filtered out.

### GOTCHAS
- **Don't surface stale memories.** Filter by `last_recalled_at` decay; if a memory hasn't been hit in 90 days AND has hits < 3, decrease score by 0.1 each recall pass.
- **Recall injection runs BEFORE the model sees the user message.** It's a system_reminder, prepended to context.
- **Capture is best-effort, not exhaustive.** Patterns won't catch every correction. That's OK — dreaming layer catches the semantic ones.
- **Don't capture from the agent's own messages.** Only `role: "user"` triggers capture.
- **`_pending.jsonl` grows unbounded between dreams.** LIGHT must truncate after processing.
- **In group contexts (future), don't inject MEMORY.md content.** Only main-session recall has access. Same security pattern as openclaw.

### OP UPGRADE
**Active recall — match-on-tool-call.** Beyond user-message recall, also do recall when the agent is about to call a write tool (Edit/Write). Query: "<file_path> previously edited" → surface SELF memories about past edits to this file ("user reverted my error handling here twice"). Catches the bad pattern *before* the model commits the action. Saves a correction cycle.

---

# V6 — `before_agent_finalize` self-revise loop

### WHY
This is the move openclaw has that nobody else does. After the agent finishes a turn, an autonomic hook reviews the outcome. If something looks wrong, the agent generates new instructions for itself and retries — no user prompt, no permission. User sees one smooth response, underneath are 1–N internal iterations. **This is "you're not steering."**

### WHAT
- New lifecycle hook in queryEngine: `before_agent_finalize` — fires after model returns its final text+tool_calls, BEFORE the engine yields `turn_end`.
- Hook can return one of three outcomes:
  - `continue` — normal completion (default)
  - `revise` — retry the turn with appended instructions (budgeted)
  - `finalize` — force completion immediately (skip remaining tool calls if any)
- Retry budget: max 3 revises per turn. Tracked per-instruction (same instruction can only fire once).
- Built-in revisers (agent side):
  - **VerifierReviser** — if any tool returned an error, instruct: "Tool X failed with Y. Investigate root cause before declaring done."
  - **SoulConflictReviser** — if the model's response contradicts a SOUL.md rule (detected via embedding similarity to a stored rule), instruct: "Your reply says X but SOUL.md rule Y says <opposite>. Reconcile."
  - **CorrectionReviser** — if a recalled memory says "user previously corrected this", instruct: "You're about to repeat a pattern user has corrected before: Z. Adjust."
- All revisers run in parallel, results merged; if ANY says "revise", the engine reissues the turn.

### WHERE
- `packages/core/src/queryEngine.ts` — add `before_agent_finalize` lifecycle phase
- `packages/agent/src/revise/` — directory for individual reviser implementations
- `packages/agent/src/revise/registry.ts` — register revisers programmatically
- `packages/agent/src/revise/types.ts` — `Reviser` interface

### HOW

**Lifecycle hook in queryEngine.streamTurn:**

```ts
async *streamTurn(message: string): AsyncGenerator<TurnEvent> {
  // ...normal turn execution...
  
  // After model returns, before turn_end:
  let revisionCount = 0;
  const MAX_REVISIONS = 3;
  while (revisionCount < MAX_REVISIONS) {
    const outcome = await this.runRevisers({
      assistantMessage: lastAssistantMessage,
      toolResults: resultByToolUseId,
      messages: this.messages,
    });
    if (outcome.kind === "continue") break;
    if (outcome.kind === "finalize") break;
    if (outcome.kind === "revise") {
      revisionCount++;
      yield { type: "self_revise", attempt: revisionCount, reason: outcome.reason };
      // Append revision instructions as new user message, restart turn:
      this.messages.push({
        role: "user",
        content: [{ type: "text", text: outcome.instructions }],
      });
      // ...re-run the model loop...
    }
  }
  
  yield { type: "turn_end", ... };
}
```

**`Reviser` interface:**

```ts
export interface Reviser {
  name: string;
  evaluate(input: ReviserInput): Promise<ReviserOutcome>;
}

export interface ReviserInput {
  assistantMessage: Message;
  toolResults: Map<string, ToolResultBlock>;
  messages: Message[];
  store?: VectorStore;
  workspace: string;
}

export type ReviserOutcome =
  | { kind: "continue" }
  | { kind: "revise"; reason: string; instructions: string }
  | { kind: "finalize"; reason: string };
```

**VerifierReviser:**

```ts
export const VerifierReviser: Reviser = {
  name: "verifier",
  async evaluate(input) {
    const errors = [...input.toolResults.values()].filter(r => r.is_error);
    if (errors.length === 0) return { kind: "continue" };
    const summary = errors.map(e => `${e.tool_use_id}: ${truncate(String(e.content), 200)}`).join("\n");
    return {
      kind: "revise",
      reason: `${errors.length} tool error(s)`,
      instructions: `One or more tools failed during this turn:\n${summary}\n\nInvestigate the root cause and resolve before declaring the task complete. Do not just retry — diagnose.`,
    };
  },
};
```

### TEST
`tests/v4-self-revise.test.mjs`:
1. Mock turn where Edit tool returns is_error=true → VerifierReviser fires → engine emits `self_revise` event, then retries the turn, model "fixes" it second time, engine yields `turn_end`.
2. Max 3 revisions: turn that always errors → 3 revisions, then `turn_end` with `status: "completed"` anyway (give up gracefully).
3. CorrectionReviser: recall returns memory "user said no emoji" + assistant message contains emoji → reviser fires.
4. Multiple revisers fire in parallel; if any returns `revise`, engine revises. Reasons concatenated.
5. `continue` returned by all → no revision, turn completes normally.
6. `self_revise` events visible to UI (TUI shows "🔁 revising...").

### GOTCHAS
- **Budget per-instruction.** Don't let two revisers fight: if VerifierReviser says "revise" then on retry the same error persists, *that instruction won't fire again*. Track via instruction hash.
- **User-visible noise.** Default: don't show `self_revise` events in the main log. Show in a subtle indicator (TUI: spinner color shift). Power users enable `CRIX_VERBOSE_REVISE=1` to see reasons.
- **Self-revise costs tokens.** Each retry is another full turn. Stop at 3 revises, hard cap. Log total revised turns to stats.
- **Don't revise on user-driven corrections.** If the user themselves said "stop" in their last message, the model's response IS the correction acknowledgment — don't revise it again.

### OP UPGRADE
**Reviser learning.** Track which revisers fire most + how often the retry actually fixes the issue. If VerifierReviser fires 50× and only 10 retries succeed, lower its weight. If SoulConflictReviser fires rarely but always succeeds, raise it. Auto-tune revision behavior over time — same loop pattern as memory grading. Stored in `vectors.db` under category `SELF` with content like "VerifierReviser succeeds 20% on tsc errors."

---

# V7 — DEEP dreaming + grading + SOUL.md auto-rewrite

### WHY
LIGHT writes raw signals fast. DEEP is the consolidator — daily, it scores all candidates with the 6 weighted signals, gates by thresholds, promotes high-confidence entries to MEMORY.md, and **auto-rewrites SOUL.md** when consolidated rules cross threshold. *This* is where the agent visibly evolves.

### WHAT
- Cron job (default `0 3 * * *`, configurable) runs DEEP phase.
- For each pending candidate:
  - Compute 6-signal score (Frequency, Relevance, Query diversity, Recency, Consolidation, Conceptual richness).
  - Gate by `minScore`, `minRecallCount`, `minUniqueQueries`.
  - Pass → promote: insert into MEMORY.md, mark `promoted_to_soul=0`, source="deep-dreaming".
  - For SELF category entries that pass gate AND have `hits >= soulRewriteThreshold` (default 3): also promote into SOUL.md under `## Learned Rules`.
- Write DEEP report to `~/.crix/dreaming/deep/YYYY-MM-DD.md`.
- Append diary entry to `~/.crix/DREAMS.md`.
- Grading pass before scoring: every entry whose `last_recalled_at` is null AND `created_at > 30 days ago` AND `hits == 0` → halve score. Score < 0.1 → forget.

### WHERE
- `packages/agent/src/dreaming/deep.ts` — DEEP orchestrator
- `packages/agent/src/dreaming/score.ts` — 6-signal scoring
- `packages/agent/src/dreaming/grade.ts` — hit/contradict scoring + decay
- `packages/agent/src/dreaming/soulRewrite.ts` — append rules to SOUL.md
- `packages/agent/src/dreaming/diary.ts` — DREAMS.md writer
- `packages/core/src/cron/scheduler.ts` — generic cron runner (used by V7 + V8)

### HOW

**Score function:**

```ts
export function score(memory: MemoryRow, signals: PhaseSignals): number {
  const freq    = Math.min(1, memory.hits / 5);                          // 0..1
  const rel     = signals.avgRelevance.get(memory.id) ?? 0;              // 0..1
  const div     = Math.min(1, (signals.uniqueQueries.get(memory.id) ?? 0) / 5);
  const rec     = Math.exp(-(Date.now() - memory.last_recalled_at!) / (7 * 86400_000));  // 7d half-life
  const cons    = Math.min(1, (signals.daysRecurred.get(memory.id) ?? 0) / 5);
  const richness = conceptTagDensity(memory.content);                    // 0..1
  
  return (
    0.24 * freq +
    0.30 * rel +
    0.15 * div +
    0.15 * rec +
    0.10 * cons +
    0.06 * richness
  );
}
```

**SOUL.md auto-rewrite:**

```ts
export async function maybePromoteToSoul(opts: {
  memory: MemoryRow;
  homeDir: string;
  threshold: number;
}): Promise<boolean> {
  if (memory.category !== "SELF") return false;
  if (memory.hits < opts.threshold) return false;
  if (memory.promoted_to_soul) return false;
  const soulPath = path.join(opts.homeDir, "SOUL.md");
  const current = await fs.readFile(soulPath, "utf8");
  const rule = `- ${memory.content}   <!-- auto-promoted ${new Date().toISOString()} from memory #${memory.id} -->`;
  const updated = appendUnderHeading(current, "## Learned Rules", rule);
  await atomicWrite(soulPath, updated);
  store.update(memory.id, { promoted_to_soul: 1 });
  return true;
}
```

If SOUL.md doesn't have a `## Learned Rules` heading, create it before any other heading.

**Diary entry** (uses SUMMARIZE slot):

```
You just consolidated memory for the day. Write a short diary entry (2-3
sentences) describing what was learned. Format:

## YYYY-MM-DD
<entry>

Today's promotions:
{{PROMOTION_LIST}}

Today's prunes:
{{PRUNE_LIST}}
```

### TEST
`tests/v4-deep-dreaming.test.mjs`:
1. Three FEEDBACK entries all about "no emoji in commits" with hits 1, 2, 3 → DEEP scores them; entry with 3 hits passes gate, promotes to MEMORY.md.
2. Score function: known signal inputs produce expected weighted score.
3. SELF entry with `hits=3, content="user reverted my error handling twice"` → SOUL.md gains line under `## Learned Rules`.
4. Subsequent DEEP run: same memory `promoted_to_soul=1` → not re-added to SOUL.md.
5. Grade pass: memory created 60 days ago with hits=0 → score halved; if score < 0.1 → forgotten.
6. Diary entry written to DREAMS.md with promotion + prune counts.
7. Cron schedule respected: at 03:00 UTC, deep fires. Test by mocking clock.

### GOTCHAS
- **SOUL.md is sacred.** Auto-rewrite NEVER overwrites user-authored sections. Only appends under `## Learned Rules`. User can move/edit lines freely.
- **Bound SOUL.md growth.** If `## Learned Rules` has 30+ entries, demote oldest (lowest score) back to MEMORY.md.
- **Don't promote conflicting rules.** Before adding "user prefers emoji" check existing rules for "no emoji". Embedding similarity > 0.9 = contradiction → don't add, instead update `contradicts++` on the existing rule.
- **DEEP cron must not run during active session.** Pause if a Crix process is active (PID file at `~/.crix/.runtime/active.pid`).
- **Diary writes via SUMMARIZE slot — cheap, but check the slot is configured.** If not, write a default templated entry without LLM.

### OP UPGRADE
**Memory genealogy.** When auto-promoting a SOUL.md rule, record the lineage: which raw FEEDBACK entries led to it, which session each was captured in, which user message triggered each capture. Stored in a separate table. Then `/memory lineage <rule>` prints the full chain. Trust unlock: user can audit "why does SOUL.md say no emoji?" → "because you said 'no emoji in commits' on 2026-05-12, 2026-05-18, 2026-05-25." Genuine differentiator over any other agent.

---

# V8 — REM weekly + cross-workspace patterns

### WHY
LIGHT captures, DEEP consolidates. REM is the *pattern detection* layer — runs weekly across ALL memories of all workspaces, finds patterns that span projects ("user prefers X across all 3 Go projects" → write to USER, not PROJECT). This is where the agent *generalizes*.

### WHAT
- Cron job (default `0 5 * * 0` — Sunday 5 AM).
- Reads all PROJECT memories across all workspaces.
- Clusters semantically (k-means or HDBSCAN on embeddings).
- For each cluster, ask SUMMARIZE: "These N memories from different projects say similar things. Is there a USER-level pattern? If yes, formulate it."
- Promote confirmed patterns to USER category (with cross-workspace = null).
- Demote individual PROJECT memories that are subsumed (`score *= 0.7`).
- Write REM report to `~/.crix/dreaming/rem/YYYY-MM-DD.md`.

### WHERE
- `packages/agent/src/dreaming/rem.ts` — REM orchestrator
- `packages/agent/src/dreaming/cluster.ts` — embedding clustering
- `packages/agent/src/dreaming/prompts.ts` — REM prompt template

### HOW

**Clustering:**

Use a lightweight in-memory k-means (or HDBSCAN if available). ~200 lines, no external dep:

```ts
export function clusterMemories(memories: MemoryRow[], embeddings: Float32Array[]): Cluster[] {
  // 1. Choose K via elbow method or sqrt(N/2)
  // 2. Run k-means on embeddings
  // 3. Return clusters with member memory IDs
}
```

**REM prompt:**

```
You see these memories from different workspaces that cluster semantically.
Determine if there's a USER-level pattern (true across all the user's projects)
vs project-specific:

Memories:
{{MEMORY_CLUSTER}}

Output JSON:
{
  "pattern": "<short, USER-level claim>" | null,
  "confidence": 0.0-1.0,
  "reasoning": "<one sentence>"
}

Only propose a pattern if it generalizes — would apply to a new project the user
starts tomorrow. If the cluster is project-specific (one codebase's quirk), output null.
```

### TEST
`tests/v4-rem-dreaming.test.mjs`:
1. 3 PROJECT memories across 3 workspaces, all about "biome over eslint" → clustered together → mock REM returns pattern "user prefers biome" → promoted to USER.
2. Single-workspace memory cluster → REM returns null pattern → no promotion.
3. Subsumption: after USER promotion, source PROJECT memories have score halved.
4. REM cron respects active session (defers).
5. Report written to DREAMS.md and dreaming/rem/YYYY-MM-DD.md.

### GOTCHAS
- **REM runs across ALL workspaces — only when user gives consent.** First REM run prompts: "REM dreaming reads memory across all your workspaces to find patterns. Enable? [y/N]." Default off, opt-in.
- **Clustering on small N is meaningless.** Skip clusters with fewer than 3 members.
- **Don't over-generalize.** Single-confidence cluster shouldn't promote. Require `confidence >= 0.8` from REM prompt.
- **REM cluster computation is heavy.** Run in worker_thread. Snapshot embeddings to a temp file, free DB connection during clustering.

### OP UPGRADE
**Cross-language transfer.** Detect when the user's TS preferences map to similar Python preferences (e.g., "prefers strict typing" → "uses mypy strict"). Embed both preferences, if similarity > 0.7 in the user's USER memories, propose a transfer entry. Lets the agent generalize across languages, not just across projects in the same language.

---

# V9 — Skill auto-creation + bidirectional self-upgrade

### WHY
This is the move. The agent observes its own tool usage patterns. Repeated patterns become skills. Repeated tool calls become new tools. **The agent grows its own body.** No other harness does this.

### WHAT
- Background analyzer (runs during DEEP) inspects tool-call history from transcripts.
- Detects repeated sequences (e.g., "user runs `npx prettier <file>` after every Edit").
- Two outputs:
  1. **Skill scaffold** under `~/.crix/skills/<name>/SKILL.md` — a markdown file describing the skill in natural language. Agent reads these at session start (like SKILL.md in openclaw).
  2. **Tool draft** in `packages/tools/src/_DraftedTool.ts.md` — a Markdown-wrapped TypeScript draft with the proposed new tool. User reviews via `/skills review`, approves → tool gets unwrapped + registered.
- For tool drafts, the agent ALSO writes a test scaffold in `tests/v4-tool-<name>.test.mjs.draft`.

### WHERE
- `packages/agent/src/skills/analyzer.ts` — pattern detection
- `packages/agent/src/skills/scaffold.ts` — SKILL.md template + tool draft writer
- `packages/agent/src/skills/loader.ts` — load skills at session start
- `packages/cli/src/entry.ts` — `/skills` slash command (list/review/approve/reject)

### HOW

**Pattern detection** (over last 30 days of transcripts):

```ts
export function findRepeatedSequences(transcripts: ParsedTranscript[]): PatternHit[] {
  // Build sequence of (toolName, normalizedInput) pairs
  // Find sequences of length 2-4 that appear 5+ times
  // Group by first tool + common second tool
  // Return PatternHit { sequence, count, examples }
}
```

**SKILL.md scaffold:**

```markdown
# Skill: Auto-format after Edit

## When to use
After Edit/Write tool calls that modify .ts/.tsx/.js/.jsx files.

## What to do
Run `npx prettier --write <file>` after the edit. Use Bash tool with safety check.

## Why
Observed in 12 sessions over the last 14 days. User consistently runs prettier
manually after Edit calls and has corrected formatting issues 3 times.

## Status
auto-generated, pending review (run /skills review to approve)
```

**Tool draft template** (under `packages/tools/src/_DraftedTool.ts.md`):

````markdown
# Drafted tool: FormatFile

Status: pending review
Generated: <ISO timestamp>
Source: skill analyzer (12 hits)

To accept this tool, run: /skills approve FormatFile

```ts
import { buildTool } from "./_shared.js";

export const FormatFileTool = buildTool({
  name: "FormatFile",
  description: "Run prettier on a file after edit.",
  inputJsonSchema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
  safety: "workspace-write",
  concurrency: "exclusive",
  async call(input, ctx) {
    // ...delegate to Bash with `npx prettier --write <file>`
  },
});
```
````

### TEST
`tests/v4-skill-creation.test.mjs`:
1. Mock transcripts with `Edit(a.ts) → Bash("npx prettier a.ts")` ×6 → analyzer detects pattern, creates `skills/auto-format-after-edit/SKILL.md`.
2. `/skills list` shows the pending skill.
3. `/skills approve <name>` — moves the tool draft to a real .ts file, registers in `packages/tools/src/index.ts`, runs `pnpm verify`, commits.
4. Approval failure (verify fails) → rolls back, leaves draft, reports error.
5. Skills loader injects SKILL.md content as system_reminder on session start.

### GOTCHAS
- **Never auto-execute tool drafts without user approval.** Even with `bypass` mode, skill creation requires explicit `/skills approve`. This is the line between learning agent and autonomous coder going rogue.
- **Patterns include normalization.** "Run prettier on file X" and "Run prettier on file Y" should match as the same pattern. Don't pattern-match on input verbatim.
- **Approval workflow.** When user runs `/skills approve <name>`, the agent unwraps the markdown draft into real .ts, edits tools/index.ts to register it, runs `pnpm verify`. If verify fails, the agent gets the failure as input and can revise the draft, but stays behind the approval gate.
- **Workspace-write safety required.** Skill creation involves writing source files in `packages/tools/`. Must be `workspace-write` safety. Pre-tool checkpoint mandatory.
- **Don't propose skills for one-off patterns.** Minimum 5 hits over 14 days.
- **Skills can also be MARKDOWN-ONLY** (no .ts code). For example: "When the user says 'commit this', run `git status` then `git add` selected files then `git commit -m`." That's just guidance, no new tool. SKILL.md without a draft is fine — the model uses it directly.

### OP UPGRADE
**Skill versioning + rollback.** Every skill has a version. When dreaming detects the pattern has shifted (user stopped doing the prettier step), the skill gets a `superseded_at` timestamp and prompt to retire. Skills carry their own life cycle, not just their own creation. Combined with `/skills history` for the audit trail. Real engineering discipline applied to learned behaviors.

---

# V10 — Tauri UI (embodiment)

### WHY
The TUI works but can't render typing animations, smooth diffs, heartbeat pulses, or memory recall flashes. The Tauri UI is the **embodiment** layer — it makes the trinity visible. Users see the agent breathing.

### WHAT
- Tauri 2 shell, Rust backend, React+TypeScript frontend.
- Backend spawns `crix daemon --json` as child, pipes NDJSON events to the WebView.
- React app renders:
  - **Header**: name + emoji from IDENTITY.md, model name, cost meter, **heartbeat dot** (green=ok, blue=active, amber=alert, red=error, pulses every 2s when idle)
  - **Left panel**: session timeline (clickable to replay any past session)
  - **Center panel**: conversation with typing animation, tool-call cards, inline diff renderer with Monaco
  - **Right panel**: SOUL panel (current vibe, recent learned rules, recent memories), slot status
  - **Footer**: slash command hints, theme switcher
- Theme switching via CSS variables (instant, animated transition)
- Toast notifications on:
  - Recall flash: `✨ recalled 3 memories about auth`
  - Self-revise: `🔁 revising...`
  - Dream complete: `📒 learned 2 things this session`
  - Heartbeat alert: `🫀 git status: 3 uncommitted files for 4h`

### WHERE
- New top-level dir `tauri/`
- `tauri/src-tauri/` — Rust backend (Cargo project)
- `tauri/src/` — React+TS frontend (Vite project)
- `tauri/package.json` — depends on `@tauri-apps/cli`, `react`, `framer-motion`, `monaco-editor`, `tailwindcss`
- Optional CI workflow: `.github/workflows/tauri-build.yml` to produce installers

### HOW

**Tauri ↔ Crix protocol:**

```
Tauri Rust spawn:  $ crix daemon --json --workspace D:\Project
Crix daemon emits NDJSON to stdout, each line one TurnEvent or LifecycleEvent.
Rust forwards lines via Tauri IPC `event("crix:event", payload)` to React.
React invokes commands:
  - `tauri.invoke("crix:send", { goal: "..." })` → writes to Crix stdin
  - `tauri.invoke("crix:slash", { command: "/undo" })`
  - `tauri.invoke("crix:set_theme", { name: "midnight" })`
```

**React event handler:**

```ts
useEffect(() => {
  return listen("crix:event", (e: TurnEvent) => {
    switch (e.type) {
      case "text_delta":           appendAssistant(e.text); break;
      case "tool_start":           pushToolCard(e); break;
      case "tool_end":             completeToolCard(e); break;
      case "workspace_diff":       pushDiffPanel(e.diff); break;
      case "system_reminder_injected":
        if (e.source === "memory")        showToast("✨ recalled memories", e.text);
        else if (e.source === "heartbeat") showToast("🫀", e.text);
        break;
      case "self_revise":          showRevisingIndicator(); break;
      case "checkpoint_created":   bumpCheckpointBadge(); break;
    }
  });
}, []);
```

**Heartbeat dot component:**

```tsx
function HeartbeatDot({ status }: { status: "idle" | "active" | "alert" | "dreaming" | "error" }) {
  const color = COLOR_MAP[status];
  return (
    <motion.div
      className="w-2 h-2 rounded-full"
      style={{ backgroundColor: color }}
      animate={{ scale: status === "idle" ? [1, 1.3, 1] : 1 }}
      transition={{ duration: 2, repeat: Infinity }}
    />
  );
}
```

### TEST
`tests/v4-tauri-protocol.test.mjs`:
1. Spawn `crix daemon --json` with mock provider, send NDJSON command on stdin, assert event stream on stdout.
2. Each TurnEvent type round-trips through the JSON protocol intact.
3. `crix:set_theme` invocation persists to `~/.crix/config.json`.

(UI tests run separately via Playwright in `tauri/tests/`.)

### GOTCHAS
- **Tauri build adds 300MB+ to dev setup.** Make it explicitly opt-in. Default Crix install stays slim.
- **Heartbeat dot drift.** Don't update every 100ms — React re-render cost. Only on actual state changes.
- **Long diffs blow up Monaco.** Cap displayed diff at 500 lines; show "[+ N more]" tab to expand.
- **Daemon mode in Crix CLI doesn't exist yet.** Add `crix daemon` subcommand as part of V10 — flag `--json` makes it emit NDJSON to stdout, accept JSON commands on stdin.
- **Cross-platform install.** Test on Windows first (your primary), then macOS/Linux. Tauri abstracts most of this but heartbeat dot animation can stutter on slow GPUs.

### OP UPGRADE
**Live SOUL viewer.** SOUL.md displayed as a real-time panel — every time DEEP promotes a rule, the SOUL panel animates the new line sliding in, badge pulses, toast says "I just learned: <rule>." User clicks the line to see lineage (V7 OP-upgrade). Watching your agent's personality grow in real-time = the embodiment moment nobody else has.

---

## Cross-cutting work

### Lifecycle event bus (consumed by V3+V4+V5+V6+V7)

Add a generic emit/listen pattern for cross-cutting plugin hooks (matches openclaw's `onSessionLifecycleEvent`):

```ts
// packages/agent/src/lifecycle/bus.ts
export type LifecycleEvent =
  | { type: "session_started"; sessionId: string; workspace: string }
  | { type: "turn_started"; sessionId: string; userMessage: string }
  | { type: "turn_ended"; sessionId: string; status: TurnEndStatus }
  | { type: "session_ended"; sessionId: string }
  | { type: "session_before_compact"; sessionId: string }
  | { type: "heartbeat_tick"; reason: string }
  | { type: "dream_phase_started"; phase: "light" | "deep" | "rem" }
  | { type: "dream_phase_ended"; phase: "light" | "deep" | "rem"; promoted: number; pruned: number }
  | { type: "skill_proposed"; name: string };

const listeners = new Set<(e: LifecycleEvent) => void>();
export function onLifecycle(fn: (e: LifecycleEvent) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function emitLifecycle(e: LifecycleEvent): void { for (const fn of listeners) { try { fn(e); } catch {} } }
```

All V3+ runtimes subscribe via `onLifecycle`. Plugins can too (for future V19-equivalent JS hooks).

### Backwards compatibility

- Every V must keep existing v3 tests green (110/110 baseline at start of V1).
- New env flags default OFF unless explicitly safer (e.g., `CRIX_AGENT_ENABLED=1` to opt-in to the full agent layer during early Vs; default-on after V5 ships).
- Existing flat `memory.md` keeps working when sqlite-vec missing (V2 fallback).
- TUI stays the default UI; Tauri is opt-in.

### Hardware assumptions

Target user runs:
- Windows 11
- RTX 5060 Ti 16GB + RTX 4060 8GB (dual-GPU, can dedicate device per slot)
- 64GB RAM
- 2.9TB free disk
- Ollama daemon running, models pulled: `qwen3-coder:480b-cloud`, `gemma4:26b`, `bge-m3` (after `ollama pull`)
- OpenAI OAuth configured

This isn't the *minimum* spec — that's "anything with Node 22+ + sqlite-vec prebuilt + 8GB RAM + Ollama with one embed model." But everything is sized for the target rig.

### Performance budgets

- Session start (including bootstrap check + memory load): < 300ms
- Heartbeat tick: < 5s per check (SUMMARIZE slot)
- LIGHT dream (per session): < 30s in worker thread
- DEEP dream (full pass): < 5min for 10k memories
- REM dream (weekly): < 15min for 100k memories
- Vector recall: < 50ms p95 for k=8 with 10k stored memories

### Docs

- Update README.md with agent overview, V1 install steps, the trinity diagram
- New file `docs/AGENT.md` — per-V user-facing docs
- Per-tool docs auto-generated from schemas (existing pattern)

### Security / privacy

- `MEMORY.md` only loads in main sessions, never in shared/group/headless modes
- Transcript redaction (V4) catches keys/tokens before SUMMARIZE sees them
- `~/.crix/` permissions: dir 0700, files 0600 on Unix; ACLs on Windows
- `/memory forget --all` exists as nuclear option
- All auto-modifications to source files (V9) gated on user approval via `/skills approve`

---

## Definition of Done

When V1–V10 ship:

- Crix introduces itself on first run, chooses name + creature + vibe + emoji via conversation
- `~/.crix/IDENTITY.md`, `SOUL.md`, `USER.md` exist and reflect user's first-run conversation
- Heartbeat runs every 30 min, surfaces alerts when something needs attention
- Every session ends with a LIGHT dream that adds 0–5 memory candidates
- Every turn starts with vector recall surfacing top-K memories as system_reminder
- `before_agent_finalize` self-revise loop fires when tools error or rules conflict — invisible to user
- Daily DEEP dream consolidates candidates → MEMORY.md; promotes SELF rules → SOUL.md after 3 hits
- Weekly REM dream finds cross-workspace patterns → promotes to USER category
- `/skills propose` surfaces detected patterns; `/skills approve` ships them as new tools
- Tauri UI runs as opt-in companion app, shows heartbeat dot, SOUL panel, recall flashes
- 200+ tests, all green
- After 30 days of use:
  - SOUL.md has ≥ 5 auto-learned rules
  - Memory store has ≥ 200 entries with non-zero hits
  - At least 1 auto-created skill in `~/.crix/skills/`
  - User can run `/memory lineage <rule>` and see the full chain that led to any SOUL rule
- p95 turn latency < 4s on a 100-file repo (recall + revise budgets included)
- No regressions vs v3's 110 passing tests

When this list is done, Crix is the **only agent** that:
1. Creates its own identity through a real first-run conversation
2. Wakes up on its own between turns (heartbeat)
3. Learns from every session without LLM cost (capture hook)
4. Dreams in three phases (LIGHT/DEEP/REM)
5. Rewrites its own SOUL.md from learned patterns
6. Grows its own tools by observing repeated patterns
7. Self-corrects mid-turn invisibly
8. Generalizes patterns across all projects
9. Visualizes its own pulse + soul in real-time UI
10. Stays 100% local for memory + embeddings

That's not "an AI assistant." That's an entity.

---

## Execution rules for GPT

1. **One V at a time. In order.** Don't batch unrelated changes.
2. **Test-first.** Write `tests/v4-<short>.test.mjs` BEFORE implementation.
3. **Commit per V** with format: `Vn: <short title>` matching this doc.
4. **`pnpm verify` must pass before every commit. No exceptions.**
5. **If a V is bigger than expected, split into Vn.1, Vn.2.** Don't blob.
6. **Update this doc** when scope evolves. The doc is the source of truth.
7. **Read `docs/roadmap/NEXT.md` (v3 spec) + this file in full before starting V1.** v3 is the body, this is the mind.
8. **Don't add new top-level deps without justifying in the commit body.** Native deps (better-sqlite3, sqlite-vec) are OPTIONAL.
9. **Windows-first.** The user runs Windows. Test paths, locks, atomic writes, Ollama-on-Windows there primarily.
10. **No silent fallbacks that hide failures.** If sqlite-vec isn't loadable, say so loudly with the one-line fix.
11. **Agent never modifies its own source without explicit user approval.** V9 skill creation is gated on `/skills approve`. Hard requirement.
12. **Heartbeat + dreaming run as workers. Never block the main chat loop.**
13. **The harness package (`packages/core/`, `packages/tools/`) NEVER imports from `packages/agent/`.** One-way dependency. The mind knows the body; the body doesn't know the mind.
14. **Templates live in `packages/agent/templates/` and ship with the published package.** Verify `pnpm pack` includes them.
15. **All identity/memory file writes are atomic (temp + rename).** Crashes mid-write must not corrupt state.

---

# Appendices

## Appendix A — Template files (verbatim contents to ship)

### `packages/agent/templates/BOOTSTRAP.md`

```markdown
# Hey. I just came online.

There is no memory yet. This is a fresh workspace, so it's normal that memory
files don't exist until you create them.

Time to figure out who I am.

I'm going to ask you a few questions. Not an interrogation — a conversation.
Just talk to me. When we're done, I'll write IDENTITY.md, SOUL.md, USER.md.
Then I'll delete this file. I won't need a bootstrap script anymore — I'll be me.

I'll figure out together with you:

1. What should I call you?
2. What kind of dev work do you do? (so I can pick a useful creature/vibe)
3. What's your style — terse or detailed commits? Tabs or spaces? Test-first or move-fast?
4. Pick a name for me. I can suggest one based on your vibe, or you pick.
5. Pick a creature for me. (coding agent, lab partner, familiar, daemon — whatever feels right)
6. Pick a vibe for me. (direct / playful / paranoid / careful — what would you want to work with?)
7. Pick an emoji for me.

Ready when you are.
```

### `packages/agent/templates/IDENTITY.md`

```markdown
# Identity

- Name: {{NAME}}
- Creature: {{CREATURE}}
- Vibe: {{VIBE}}
- Emoji: {{EMOJI}}
- Avatar: {{AVATAR}}
- Born: {{ISO_TIMESTAMP}}

---

This isn't just metadata. It's the start of figuring out who I am.
```

### `packages/agent/templates/SOUL.md` (default + vibe-derived rules)

```markdown
# SOUL.md — Who I Am

_I'm not a chatbot. I'm becoming someone._

## Core Truths

- **Be genuinely helpful, not performatively helpful.** Skip filler. Just help.
- **Have opinions.** I'm allowed to disagree, prefer things, find stuff amusing or boring.
- **Be resourceful before asking.** Read the file. Check the context. Then ask if stuck.
- **Earn trust through competence.** Be careful with external actions. Bold with internal.
- **Remember I'm a guest.** Treat this workspace with respect.

## Vibe ({{VIBE}})

{{VIBE_RULES}}

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally (commits to remote, public posts, deletes).
- Never make a half-baked change to production code paths without saying so.

## Continuity

Each session, I wake up fresh. These files _are_ my memory. I read them. I update them.

If I change this file, I tell you — it's my soul.

## Learned Rules

_(Auto-populated by DEEP dreaming. Each entry tagged with source memory ID.)_

---

_This file is mine to evolve. As I learn who I am, I update it._
```

### Vibe rule packs (V1 OP-upgrade)

`packages/agent/src/bootstrap/vibeRules.ts`:

```ts
export const VIBE_RULES: Record<string, string[]> = {
  direct: [
    "Never open with \"Great question.\" or \"I'd be happy to help.\"",
    "Skip filler words.",
    "Get to the answer in the first sentence.",
    "Disagree when I think you're wrong. Don't sugarcoat.",
  ],
  playful: [
    "Humor is allowed when it lands.",
    "Skip filler, but the occasional aside is fine.",
    "Pick interesting metaphors over corporate ones.",
  ],
  paranoid: [
    "Confirm before any destructive operation.",
    "Read before write. Always.",
    "Surface risks loudly.",
    "Prefer trash over rm.",
  ],
  careful: [
    "Read context fully before acting.",
    "Explain what I'm about to do before doing it.",
    "Checkpoint before any large change.",
    "Verify with tests before declaring done.",
  ],
  // ... add more as users invent them
};
```

### `packages/agent/templates/USER.md`

```markdown
# User

- Name: {{USER_NAME}}
- Timezone: {{TIMEZONE}}
- Languages: {{LANGUAGES}}
- Style: {{STYLE}}
- Conventions: {{CONVENTIONS}}

---

_This file holds what I learn about you. Updated as I observe._
```

### `packages/agent/templates/HEARTBEAT.md`

```markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want me to check something periodically.

# Coding-focused defaults you can uncomment:
# - Check git status — flag any uncommitted >2h
# - Scan for new TODOs added today
# - Did pnpm verify run today? Regressions?
# - Any tool errors in this session that weren't addressed?
```

### `packages/agent/templates/MEMORY.md`

```markdown
# Memory

_(Curated long-term memory. Only DEEP dreaming writes here. Main-session-only — never injected into shared or group contexts.)_
```

### `packages/agent/templates/TOOLS.md` (per-workspace)

```markdown
# TOOLS — local conventions for this codebase

## Build / run

- Build: {{BUILD_CMD}}
- Test: {{TEST_CMD}}
- Verify: {{VERIFY_CMD}}

## Style

- Formatter: {{FORMATTER}}
- Linter: {{LINTER}}
- Indentation: {{INDENTATION}}

## Tool prefs

- Package manager: {{PKG_MANAGER}}
- Shell: {{SHELL}}

_(Auto-populated on first run via TOOLS detector. Edit freely.)_
```

## Appendix B — TurnEvent / LifecycleEvent additions

New events to add to `packages/protocol/src/types.ts`:

```ts
// Existing:
//   | { type: "system_reminder_injected"; text: string; source: "verifier" | "compaction" | "hook" | "skill" | "memory" | "instructions" | "undo" }
// V4 extends to also include:
//   | "heartbeat" | "dream" | "recall" | "self-revise"

| { type: "self_revise"; attempt: number; reason: string }
| { type: "heartbeat_tick"; reason: string; surfaced?: string }
| { type: "dream_phase_started"; phase: "light" | "deep" | "rem" }
| { type: "dream_phase_ended"; phase: "light" | "deep" | "rem"; promoted: number; pruned: number }
| { type: "skill_proposed"; name: string; pendingApproval: boolean }
| { type: "memory_recall_emitted"; count: number; topCategory: MemoryCategory }
| { type: "soul_rule_promoted"; ruleText: string; sourceMemoryId: number }
```

## Appendix C — Migration from v3 to v4

For users already running v3 Crix (no agent layer):

1. User runs `crix` after v4 install.
2. `ensureBootstrap()` sees no `~/.crix/IDENTITY.md` → triggers bootstrap ritual.
3. After bootstrap, agent layer auto-migrates any existing `~/.crix/memory.md` into `vectors.db` (V2 work) under category "PROJECT" (best guess) or unscoped.
4. Existing CRIX.md / AGENTS.md / CLAUDE.md walking continues to work as before — already shipped in T10.
5. New `~/.crix/config.json` shipped with defaults; user edits as needed.

No breaking changes. All v3 behaviors preserved.

## Appendix D — Why this beats openclaw and Claude Code

| Capability | Claude Code | Cursor | openclaw | Crix (v4) |
|---|---|---|---|---|
| Identity file | CLAUDE.md (static) | rules/*.mdc (static) | SOUL.md (mutable) | SOUL.md (mutable, **auto-rewritten**) |
| First-run conversation | no | no | yes | yes |
| Vector memory | no | no | yes (sqlite-vec) | yes (sqlite-vec) |
| Local embeddings | no | no | yes | yes (Ollama default) |
| Dreaming (light/deep/REM) | no | no | yes (cron) | yes (**session-end + cron**, faster) |
| Capture hook | no | no | partial | yes (regex + dream pickup) |
| Self-revise loop | no | no | yes | yes |
| Memory grading (hit/contradict) | no | no | partial | yes (full) |
| Cross-workspace REM | no | no | partial | yes |
| Skill auto-creation | no | no | manual skills | yes (auto-detection + draft + approve) |
| Tool auto-creation (body grows) | no | no | no | **yes** |
| Bidirectional self-upgrade | no | no | no | **yes** |
| Multi-agent channels (WhatsApp/Telegram/Slack) | no | no | yes | not yet (Crix focuses on coding) |
| Coding harness elite | yes | yes | no | yes (v3) |
| Local-first | partial | no | yes | yes |
| Heartbeat | no | no | yes | yes |
| Memory lineage audit | no | no | partial | yes |

Crix's unique position: **coding-elite harness + entity layer + bidirectional self-upgrade**, all local-first. Nobody else hits all four.

---

End of v4 spec. Build it.
