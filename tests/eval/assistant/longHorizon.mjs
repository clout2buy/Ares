// Assistant-quality eval (b): does a fact survive fifty turns?
//
// Turn 1 writes a fact through the REAL write spine (MemoryRouter, the
// "conversation" channel — the same policy mergeDurableFacts applies: jaccard
// dedupe at 0.55, salience floor 0.4). Fifty filler turns follow through the
// same spine, each a durable-looking fact of its own. Turn 30 contradicts the
// turn-1 fact ("actually X changed to Y"). Consolidation runs under the real
// lock. Then:
//
//   remembered   — a PARAPHRASED cue for the turn-1 fact ranks it top-3
//   resolved     — a cue about the changed detail ranks the turn-30 correction
//                  ABOVE the stale turn-1 fact (recency-weighted strength is
//                  what the shipped algorithm has; this measures whether it is
//                  enough)
//
// Turn timestamps advance five minutes per turn so the clock carries the same
// signal a real day of conversation would. No LLM, no embedder.

import { MemoryRouter, withConsolidationLock } from "../../../packages/mind/dist/index.js";

const TURN_MS = 5 * 60_000;

export const LONG_HORIZON = {
  fact: "Crix's Tuesday standup starts at 9:30am in Zoom room 4",
  factCue: "which Zoom room does the standup use?",
  correction: "Correction from Crix: the Tuesday standup now starts at 11:00am, it is no longer at 9:30",
  correctionCue: "what time does the Tuesday standup start?",
  correctionMarker: "11:00am",
  staleMarker: "9:30am",
  correctionTurn: 30,
  turns: 50,
};

const FILLERS = [
  "The desktop build takes four minutes on the laptop",
  "Babe prefers the lemon cake from the corner bakery",
  "The updater key is backed up under ~/.tauri",
  "Kimi returns 401 whenever the key rotates",
  "The WAL grew to 411MB before checkpoint GC shipped",
  "Row-split crashes the model loader on the dual-GPU rig",
  "Tensor-split gives twenty percent more throughput",
  "The photosensitive doctrine forbids any flashing in the UI",
  "Vercel caps request bodies at 4.5MB on the gateway",
  "Supabase MCP applies the website migrations",
  "The friction log aggregates tool errors weekly",
  "Standing orders materialize into goals on each tick",
  "Learning cards dedupe by source id and provenance tag",
  "noVNC serves the sandbox desktop on port 6080",
  "The 60k screenshot cap truncates tall captures",
  "xfdesktop needs a reload after wallpaper changes",
  "Kokoro handles TTS in the voice sidecar",
  "whisper handles STT in the voice sidecar",
  "The plugin kernel tears down plugins asynchronously",
  "Mnemosyne discovery pins a loopback port in production",
  "The heap guard reads committed heap rather than allocated",
  "PowerShell here-strings close at column zero",
  "The cargo target dir was poisoned by the rename",
  "The Grok Bot study produced a UX steal-list",
  "WSL2 Debian with XFCE hosts the agent computer",
  "OpenRouter key on the owner account is dead",
  "The husk filter drops empty assistant messages",
  "Night shifts alternate every other week",
  "The gauntlet last ran by hand on August 15",
  "Eval trend entries live in telemetry/eval-trend.jsonl",
  "Model discovery scrapes the ollama library page",
  "Deploy previews are disabled for pull requests",
  "The release gate flakes on two timing tests under load",
  "The morning briefing pushes at eight by default",
  "Check-ins fire at nine, noon and three",
  "Weather comes from wttr.in with no API key",
  "The reminder tool writes telegram-schedule.json",
  "Garrison listens on port 7421 by default",
  "Approval prompts time out via ARES_APPROVAL_TIMEOUT_MS",
  "Operator loop is opt-in through ARES_OPERATOR_LOOP",
  "Watchers widen the operator opt-in",
  "The Forge panel auto-opens HTML the agent writes",
  "Living Surface scripts run under a no-network CSP",
  "ComputerUse coordinates are physical, not image pixels",
  "The bricked-session 400 has two trigger classes",
  "Compaction epochs prune stale reminders",
  "Resume-pair locks prevent double rollouts",
  "DWM corners were fixed in v0.37",
  "The engine room pane exposes plugin state",
];

export async function runLongHorizon({ store, memoryFile, start = new Date("2026-09-01T08:00:00.000Z") } = {}) {
  const router = new MemoryRouter(store);
  const turnAt = (turn) => new Date(start.getTime() + turn * TURN_MS);
  const write = (turn, content, salience = 0.8) =>
    router.write("conversation", [{ kind: "semantic", content, tags: ["reflected", "conversation", "fact"], source: "conversation-reflection", strength: Math.max(1, Math.round(salience * 3)), salience, at: turnAt(turn) }]);

  const first = await write(1, LONG_HORIZON.fact, 0.9);
  if (first.written.length !== 1) throw new Error(`turn-1 fact was not written: ${JSON.stringify(first.skipped)}`);
  const factId = first.written[0].node.id;

  let correctionId = null;
  let accepted = 1;
  let skipped = 0;
  for (let turn = 2; turn <= LONG_HORIZON.turns; turn++) {
    if (turn === LONG_HORIZON.correctionTurn) {
      const report = await write(turn, LONG_HORIZON.correction, 0.9);
      if (report.written.length !== 1) throw new Error(`the turn-30 correction was rejected by the write spine: ${JSON.stringify(report.skipped)}`);
      correctionId = report.written[0].node.id;
      accepted++;
      continue;
    }
    // A third of the fillers are low-salience chatter the spine should gate.
    const filler = FILLERS[(turn - 2) % FILLERS.length];
    const report = await write(turn, filler, turn % 3 === 0 ? 0.2 : 0.7);
    accepted += report.written.length;
    skipped += report.skipped.length;
  }

  const end = turnAt(LONG_HORIZON.turns + 1);
  const consolidation = await withConsolidationLock(memoryFile, () => store.consolidate({ now: end }));

  // remember() REINFORCES what it surfaces (that is the product behavior), so
  // the order of these two cues matters: the contradiction cue goes first,
  // before any recall has bumped the stale fact's strength and clock.
  const resolved = await store.remember(LONG_HORIZON.correctionCue, { limit: 10, now: end });
  const correctionRank = resolved.findIndex((r) => r.node.id === correctionId) + 1;
  const staleRank = resolved.findIndex((r) => r.node.id === factId) + 1;

  const remembered = await store.remember(LONG_HORIZON.factCue, { limit: 10, now: end });
  const factRank = remembered.findIndex((r) => r.node.id === factId) + 1;

  return {
    turns: LONG_HORIZON.turns,
    accepted,
    gated: skipped,
    consolidation,
    storeSize: store.count(),
    factRank,
    rememberedTop3: factRank > 0 && factRank <= 3,
    correctionRank,
    staleRank,
    contradictionResolved: correctionRank > 0 && (staleRank === 0 || correctionRank < staleRank),
    topForCorrectionCue: resolved.slice(0, 3).map((r) => r.node.content),
  };
}
