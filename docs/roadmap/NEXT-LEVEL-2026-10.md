# Ares — what takes it to the next level (Oct 2026)

Written 2026-10-09 from four months of the owner's own friction telemetry, the crash
artifacts, the self-files under `~/.ares`, the repo, and the roadmap docs. The
22-agent audit was halted early at the owner's request (usage), so competitor
claims below are pattern-level, not freshly researched.

## The one-line thesis

Ares does not need another capability. It has more raw reach than Dot, Grok Bot or
any lab product (desktop + CLI + Telegram + paired PCs + its own Linux computer +
browser + voice + Godot forge + five providers). What it lacks is the three things
that turn capability into a *person you trust*: **it fails too often, it does not
remember, and it is not one continuous self across machines.** Every month spent
adding a surface has multiplied the failure surface and starved those three.

## The evidence (numbers, not vibes)

Friction telemetry, 2,542 turns / 919 sessions, Jul–Oct 2026:

| Signal | Value |
| --- | --- |
| Turns that failed outright | 11% (Sept: 17%, 177 of 1,041) |
| Turns interrupted by the owner | 8% |
| Browser tool failure rate | 38% (266/707; July was 190/190; 47 "kill switch engaged") |
| PowerShell failure rate | 14% (356/2,564) |
| Edit failure rate | 13% (62× "read before editing", 9× truncated JSON args) |
| Bash failure rate | 9% |
| Compactions | 1,007 across 389 turns; 124 turns compacted 3+ times, max 19 |
| Verifier nags vs verified outcomes | 730 reminders → 36 verified, 471 unverified |
| Anthropic cache-read ratio on big turns | 0.66 average; 13% of big turns read zero cache |
| Turn duration | p50 0.9s, p90 220s, p99 21 min |
| Stream errors | 429×76, 404×58, 400-thinking-order×52, fetch-failed×44, stalls×14, max-turns×14 |

Memory, from `~/.ares` after four months of daily use:

- `MEMORY.md` (the "curated long-term memory, only DEEP dreaming writes here") holds 29 entries. They are raw user quotes, six of them repeated verbatim up to six times. Nothing distilled.
- `DREAMS.md`: 620 reflection ticks, 490 "found no durable memory candidates", 25 staged. A 4% yield loop that still costs a model call per tick.
- `IDENTITY.md` still says the agent is "Rook" living in `~/.crix/`, and names doingbox at `192.168.1.41` while `LAWS.md` says `192.168.1.237`.
- `USER.md` is 3.5 KB. After four months Ares knows less about its owner than a new-hire would after a week.
- All self-knowledge (identity, soul, user, capabilities, curated memory, daily logs) must fit a **3,500-token budget** (`packages/agent/src/identity/context.ts:37`), and curated memory is in the drop tier. Meanwhile the same turn routinely carries hundreds of thousands of tokens of tool output. Ares spends its context on exhaust and almost none on itself.

Continuity and ops:

- Garrison crashed 2026-10-07 with `EADDRINUSE 127.0.0.1:7421`: two garrisons on one box. `LAWS.md` has to hand-code "only one machine may poll the Telegram bot". That is a topology problem being solved with prose.
- `~/.ares` is 1.8 GB, 1.2 GB of it checkpoints.
- 470 commits and 141 releases in four months (80 releases in July). The roadmap docs contain four separate 20-item master plans (T1–T20, V0–V10, 14 workstreams, Tier 0–6). Shipping is not the bottleneck. Finishing is.
- CLI `ares login` is ChatGPT-only (`packages/cli/src/entry/introspect.ts:418`); Claude sign-in exists only inside the desktop daemon.
- The friction log already records every failure with a stable signature. Nothing reads it. Ares has watched itself fail PowerShell quoting 100+ times and never changed how it writes PowerShell.

## Where the competition actually wins

- **Dot** wins on *feeling known*: it builds a model of the person and brings it back unprompted. Ares has the richer memory architecture on paper and a 29-line memory file in practice.
- **Grok Bot** wins on *legibility*: each agent has a job line, a screen, a visible crew, proof-by-screenshot, A/B/C choice cards. The owner wrote this steal-list in August; none of it is built. Grok's machinery is weaker than Ares's agent-computer.
- **Lab products** (Claude Code, ChatGPT agent, Gemini) win on *reliability floor*: a tool call that fails 1 in 3 times would never ship. Ares's Browser tool fails 1 in 3 times.
- **Muse**: not verified (research was halted). If it is the memory-first assistant the name suggests, it lands in the Dot column.

Ares beats all of them on: local-first, multi-provider, real hands on real PCs, Telegram presence, a game forge, and an inheritable memory estate. None of that matters while a turn fails 1 in 9 times.

## The five moves, in order

### 1. Zero-surprise tools (the reliability floor) — 2 weeks

Each top error signature is a specific, small fix. Build them all, then build the
gauntlet that replays the 600+ recorded tool errors so they can never return.

- Edit "read before editing" (62): read-stamps must survive compaction and subagent handoff; when missing, auto-read then edit instead of failing.
- Glob backslashes (26): normalize separators inside the tool. Never bounce the model for a path style.
- PowerShell (356): spill any multi-line or quote-heavy script to a temp `.ps1` automatically; prefer `pwsh` 7 when present; pre-parse with the PowerShell parser and return the parse error with the line; auto-resolve "not on path" via `Get-Command` suggestions; auto-background after a timeout instead of dying.
- Browser (266): expose kill-switch state to the model and reset it per turn; add a health probe before the first Browser call of a session so a dead bridge is reported once, not 190 times.
- RemotePC (47): clamp `timeout_ms` in the schema; give every op an id so a watchdog retry cannot double-apply.
- Write "workspace does not exist" (23): create the directory or raise an approval card.
- 429 (76): failover to the next provider on rate limit, not just backoff.
- Cache ratio 0.66: freeze the static prefix (system prompt, tools, identity) behind one cache breakpoint; put memory and dynamic context after it.

Target: turn failure under 3%, Browser under 10%, PowerShell under 5%, cache-read above 0.85. Put the four numbers in the changelog of every release.

### 2. A memory that is a mind — 2 weeks

- Budget: self-context scales with the model (5% of context window, minimum 12k tokens). Curated memory is never in the drop tier.
- Format: one fact per record, typed (user / feedback / project / reference), with *why* and *how to apply*, linked. The model writes them; deterministic code dedupes by signature and merges. No raw quotes.
- Triggers: consolidate on session end and on every owner correction, not on a 30-minute tick. Delete the "no candidates" ticks entirely.
- Weekly deep pass that rewrites `USER.md` and `IDENTITY.md` from the week's records and flags contradictions (it would have caught Rook / `.crix` / the wrong IP).
- Recall eval: the current 5-query eval scores 1.0 and proves nothing. Mine 50 queries from real sessions and track p@5 per release.

### 3. Close the self-improvement loop — 2 weeks

This was the declared moat in `NEXT-ARES.md` ("Deterministic spine. LLM judgment. Deterministic verification.") and it was never pointed at Ares itself.

- Nightly job on the garrison: cluster `friction-*.jsonl` by signature, rank by cost (count × duration × owner interrupts).
- For each top cluster the model proposes one of: a LAWS/prompt amendment, a tool-hint patch, a code-fix candidate with a replay repro.
- Deterministic verification: the proposal must lower the cluster's rate in the replay gauntlet before it is kept.
- Morning report: "Last night I fixed X, proposed Y, and the failure rate moved from A to B."

A solo developer cannot triage 2,500 turns by hand. Ares can, every night. Nobody else's agent has its own failure ledger with stable signatures already on disk.

### 4. One Ares, many bodies — 1 week

- A presence table in the estate: which machine runs the garrison, who owns the Telegram bot, who holds the tunnel, what version each body runs. Enforced in code, not in `LAWS.md`.
- Garrison singleton guard with a health check on 7421 before bind, and a clean takeover protocol instead of a crash.
- Oricle sync switched on for desktop, laptop and doingbox so every body wakes with the same memory. The "One Mind" layer is built and sitting unused.
- CLI sign-in parity: Claude OAuth in `ares login`, not only in the desktop daemon.

### 5. Legibility — 1 week, already agreed in August

Job lines pinned per session and agent, A/B/C choice cards generalized from
`PermissionCard`, a crew roster of watchers and routines, `/tour`, reply-first doctrine
(reply, then work; never vanish into a silent job), proof-by-screenshot on completion.
Cheap, visible, and the exact thing that makes Grok Bot feel trustworthy.

## What to stop doing for one quarter

- No new surfaces, engines or channels. Every one so far shipped at 60% and raised the failure rate.
- Releases every two weeks, gated on the four reliability numbers, not on feature count.
- Delete the dead: the zero-LOC `browser-extension` and `browser-host` packages, Crix remnants in the self-files, the three superseded master-plan docs. Cap checkpoints at 200 MB with GC.
- Stop writing 20-item specs. Each of the five moves above is the whole spec; the file refs are in the telemetry.

## How you know it worked

| Metric | Now | Target (Jan 2027) |
| --- | --- | --- |
| Turn failure rate | 11% | < 3% |
| Browser / PowerShell failure | 38% / 14% | < 10% / < 5% |
| Compactions per 100 turns | 40 | < 15 |
| Cache-read ratio (big turns) | 0.66 | > 0.85 |
| Verified : unverified outcomes | 36 : 471 | 1 : 1 |
| Curated memory records | 29 raw quotes | 300+ typed, deduped |
| Self-files stale facts | 3 known | 0 (weekly pass) |
| Garrison crashes / month | 1–2 | 0 |
