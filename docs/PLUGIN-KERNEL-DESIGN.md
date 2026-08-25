# The Plugin Kernel & the Harness Upgrade Path

*2026-08-25 — the "go all out" charter. Owner decision: adopt the Cordis-style
architecture as Ares's direction, via strangler migration, never big-bang.*

## Why

Studying [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh, v0.1 preview, 2026-08-13) surfaced three ideas that map directly onto
Ares's standing wounds:

1. **"Model-visible means logged."** One append-only session event log is the
   source of truth; everything else (in-memory history, UI transcript, usage
   stats) is a projection. Ares currently has THREE parallel truths — the
   SQLite kernel, the `events.jsonl` sidecar, in-memory messages — and our
   worst bug class (the 314MB-sidecar OOM, the tool_use/tool_result 400
   bricks, amnesia, husk sessions) is those truths diverging.
2. **Capability seams.** A seam = service definition + provider + consumer;
   swapping one provider redirects a whole subsystem (filesystem + subprocess
   share an "execution world" — point both at remote infra and Bash/PTY/LSP
   move together). This is the clean version of what the agent-computer
   (v0.41–0.43) wires by hand, and the decomposition pattern the 5,000-line
   queryEngine needs.
3. **Reversible plugins (Cordis).** Mount/unmount/hot-swap at runtime, every
   side effect rolled back on removal, dependencies declared and reactively
   managed, path independence (final state depends only on the enabled set).

Decision on Cordis itself: **build the properties natively, not the
dependency.** Cordis v4 is three weeks old as a public substrate under dsh;
Ares's daemon durability (leases, idempotent admission, crash recovery) must
not sit on a moving preview. `@ares/plugins` is ~300 lines and owned. If
Cordis stabilizes and the ecosystem matters, the kernel's contract is close
enough to adapt.

## What ships now: `@ares/plugins`

- `PluginHost` — serialized mount/unmount/swap/dispose; lifecycle events.
- `definePlugin({ name, inject?, setup(ctx, config) })`.
- `ctx.effect(cleanup)` — TEMPORAL guarantee: cleanups run in reverse
  registration order; a throwing setup unwinds its partial work. Cleanups may
  be async (v0.45.0): each is awaited before the one beneath it runs, and a
  rejection strands nothing — real tenants tear down real things.
- `ctx.provide(name, service)` / `inject` — SPATIAL guarantee: activation
  waits for dependencies; providers never vanish under a live dependent
  (dependents deactivate first, park pending, reactivate when the service
  returns). One live provider per name — a second is a setup error.
- Path independence proven by test: any mount order converges to the same
  running state (tests/plugin-host.test.mjs).

Deliberately absent (until a real tenant needs them): profiles/bundles,
config reconciliation, cross-process plugins, sandboxed plugin code.

## Migration plan (strangler, each step shippable)

**Step 0 — SHIPPED v0.45.0: maintenance as the zeroth tenant.** The daemon
owns one `PluginHost`; its heap watch, idle sweep + WAL fold, and deep-dream
timers run as `maintenance:*` plugins (daemonMaintenance.ts). Chosen before
the belt on purpose — no user-facing contract, so kernel rough edges surface
on a timer nobody is watching. What it bought immediately: a maintenance
ledger of every noteworthy run embedded in heap-critical crash artifacts
(the 2026-08-25 OOM night's climb was unattributable precisely because the
timers were anonymous), per-job re-entry guards, reverse-order teardown on
shutdown, and a live `plugins_list` wire command feeding the desktop's
Engine Room pane (Settings). The roster smoke test drives the built daemon
and asserts all four mounts are active.

**Step 1 — extension surfaces onto the host.**
The daemon owns one `PluginHost`. First tenants, in order of blast radius:
1. Belt tools (`packages/tools` registrations) — each tool a plugin providing
   `tool/<Name>`; the session belt consumes the registry. Win: tools can be
   added/removed mid-session with guaranteed cleanup, and Ares can safely
   mount a tool IT wrote (the self-extension story: forge → mount → try →
   unmount on misbehavior, no restart, no residue).
2. Skills and connectors — today's bespoke lifecycles (fragile HTML-parse
   discovery, encrypted-token daemons) become plugins with reversible setup.
3. Personas — roster entries mount/unmount their prompt layer + matcher.

**Step 2 — the log invariant in the kernel.** Rearchitect sessionKernel so the
event log is the ONLY durable truth and `events.jsonl` becomes a projection
(or is retired to export-on-demand). Kill the divergence bug class at the
root. Big; design doc of its own before code.

**Step 3 — queryEngine seams.** Decompose along dsh's pipeline stages
(`pre-step → request → llm/stream → tools/pre → execute → post`) with
waterfall interception, so budgeting/wire-log/steering/verification attach
instead of interleave. The wire-log eager-build bug (eacd0299) existed
because there is no seam here today.

**Step 4 — execution-world seam.** One provider pair (fs + subprocess) that
can point at the local machine OR the WSL2 agent-computer; "run this session
on the machine" becomes a provider swap instead of per-tool routing.

**Decision gate (~6 months):** if Cordis has stabilized and dsh's plugin
ecosystem is worth consuming, evaluate adapting `@ares/plugins`' contract to
Cordis-compatible; otherwise continue native. Also worth a cheap experiment
independent of all this: drive `dsh-headless` as a fourth CodingBackend
(alongside Claude Code/Codex) for DeepSeek-native agent runs.

## Sources

- dsh architecture: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- Cordis mechanics: https://floatboat.ai/blog/cordis-plugin-framework
  (ctx.effect / lifecycle / inject; "A Programming Paradigm for Spatiotemporal
  Composability"; path independence; proven 4 years in Koishi)
