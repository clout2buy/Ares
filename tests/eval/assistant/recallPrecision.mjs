// Assistant-quality eval (a): recall precision / recall.
//
// Seeds the REAL MemoryStore through the REAL write spine (MemoryRouter) with
// 60 memories — 20 relevant to 5 queries (4 each), 10 near-duplicate
// paraphrases of relevant facts (2 per topic; they carry the same fact, so
// they count as relevant), and 30 distractors, a third of which deliberately
// share exactly one query token so a flat overlap cannot coast. Then runs the
// product recall path (store.remember — spreading activation, reinforcement,
// Hebbian linking) for each query and scores:
//
//   P@5  = relevant in the top 5 ÷ 5
//   R@10 = relevant in the top 10 ÷ relevant for that query (6)
//
// Deterministic: fixed seed content, fixed clock, no LLM, no embedder (the
// lexical path is the invariant every deployment has). No mock store — the
// number measures the shipped algorithm.

import { MemoryRouter } from "../../../packages/mind/dist/index.js";

export const RECALL_TOPICS = [
  {
    id: "standup",
    query: "What time is the Tuesday standup with the team?",
    relevant: [
      "The team standup moved to 9:30am on Tuesdays",
      "Tuesday standup runs 15 minutes with the team, camera optional",
      "The Tuesday standup happens in Zoom room 4",
      "Crix leads the Tuesday standup rotation this month",
    ],
    nearDuplicates: [
      "Team standup is Tuesdays at 9:30 in the morning",
      "The Tuesday standup is a 15-minute Zoom with the whole team",
    ],
  },
  {
    id: "gpu-rig",
    query: "How fast does the local model run on the GPU rig?",
    relevant: [
      "The 4060 + 5060Ti GPU rig runs the local 35B model at 59 tok/s via Ollama",
      "Tensor-split across both GPUs gives +20% throughput for the local model",
      "Row-split on the GPU rig crashes the model loader, use tensor-split",
      "Local model weights for the rig live under D:/models",
    ],
    nearDuplicates: [
      "The local 35B model does about 59 tokens per second on the dual-GPU rig",
      "Splitting tensors over the two GPUs makes the local model 20% faster",
    ],
  },
  {
    id: "telegram-briefing",
    query: "When does the Telegram briefing get pushed each morning?",
    relevant: [
      "The Telegram briefing is pushed at ARES_BRIEFING_HOUR, default 8 in the morning",
      "The morning briefing over Telegram goes to every allowed chat",
      "Telegram check-ins fire at 9, 12 and 3 by default, separate from the briefing",
      "The Telegram briefing includes weather when ARES_OWNER_LOCATION is set",
    ],
    nearDuplicates: [
      "Telegram's morning briefing is sent at 8 unless ARES_BRIEFING_HOUR changes it",
      "Every allowed Telegram chat receives the morning briefing push",
    ],
  },
  {
    id: "website-deploy",
    query: "How do we deploy the website and apply database migrations?",
    relevant: [
      "Deploy the doingteam.com website by sync-commit to the DoingTeam.git main branch",
      "The Supabase MCP applies the database migrations for the website",
      "The website deploy runs on Vercel, which caps request bodies at 4.5MB",
      "Database migrations for the website live under supabase/migrations",
    ],
    nearDuplicates: [
      "Website deploys go through a sync commit to DoingTeam.git main",
      "Database migrations are applied through the Supabase MCP connector",
    ],
  },
  {
    id: "photosensitive",
    query: "What is the rule about flashing effects in the UI?",
    relevant: [
      "Photosensitive doctrine: nothing in the UI ever flashes, the rule is permanent",
      "SetUiEffect must never produce flashing or strobing effects",
      "The two CSS laws forbid flashing transitions in the UI skin",
      "Effects ladder: capacity tiers, but no flashing at any tier of the UI",
    ],
    nearDuplicates: [
      "The UI never flashes; the photosensitive rule is permanent",
      "No strobe or flashing effects anywhere in the UI, ever",
    ],
  },
];

export const RECALL_DISTRACTORS = [
  // Share exactly one query token — the traps.
  "The updater rule: never bump the version without a changelog",
  "Model discovery parses the ollama.com library HTML, which is fragile",
  "Deploy previews for pull requests are disabled on the gateway",
  "Run the release gate twice if a timing test flakes",
  "Morning coffee at 6, gym at 7, then the commute",
  "Build time for the desktop app is about 4 minutes on the laptop",
  "The design team ships the new landing page on Friday",
  "The database backup job is a cron on the NAS",
  "Special effects in the boot cinematic are cool-teal",
  "A fast reconnect uses a 3 second backoff on the mirror",
  // Plain distractors.
  "The Kimi endpoint returns 401 when the key is rotated",
  "OpenRouter key on the owner's account is dead",
  "The heap guard reads committed heap, not allocated",
  "The WAL file grew to 411MB before checkpoint GC landed",
  "Crix works night shifts on alternating weeks",
  "Babe likes the lemon cake from the corner bakery",
  "The husk filter drops empty assistant messages",
  "PowerShell here-strings need the closing marker at column zero",
  "Cargo target dir got poisoned by the repo rename",
  "The Grok Bot field study produced a UX steal-list",
  "WSL2 Debian with XFCE hosts the agent computer",
  "noVNC exposes the sandbox desktop on port 6080",
  "The 60k screenshot cap truncates tall captures",
  "xfdesktop must be reloaded after wallpaper changes",
  "Kokoro TTS and whisper STT run in the voice sidecar",
  "The plugin kernel supports async teardown",
  "Mnemosyne discovery uses a fixed loopback port in production",
  "Learning cards are idempotent by source id",
  "Standing orders materialize into goals each tick",
  "The friction log aggregates tool error rates weekly",
];

export function buildRecallSeeds() {
  const seeds = [];
  for (const topic of RECALL_TOPICS) {
    for (const content of topic.relevant) seeds.push({ content, topic: topic.id, relevant: true });
    for (const content of topic.nearDuplicates) seeds.push({ content, topic: topic.id, relevant: true, nearDuplicate: true });
  }
  for (const content of RECALL_DISTRACTORS) seeds.push({ content, topic: null, relevant: false });
  return seeds;
}

/**
 * Run the eval against a real store. `now` fixes the clock so strength decay
 * is identical run to run. Returns per-query and aggregate numbers.
 */
export async function runRecallPrecision({ store, now = new Date("2026-09-01T12:00:00.000Z") } = {}) {
  const seeds = buildRecallSeeds();
  if (seeds.length !== 60) throw new Error(`expected 60 seeds, built ${seeds.length}`);
  // Interleave topics and distractors so insertion order carries no signal.
  const order = [...seeds].sort((a, b) => hash(a.content) - hash(b.content));
  const router = new MemoryRouter(store);
  const report = await router.write(
    "manual",
    order.map((s) => ({ kind: "semantic", content: s.content, tags: ["assistant-eval", s.topic ? `topic:${s.topic}` : "distractor"], source: "assistant-eval", at: now })),
  );
  if (report.written.length !== 60) throw new Error(`write spine accepted ${report.written.length}/60 seeds: ${JSON.stringify(report.skipped)}`);
  const idToSeed = new Map(report.written.map((w, i) => [w.node.id, order[i]]));

  const queries = [];
  for (const topic of RECALL_TOPICS) {
    const results = await store.remember(topic.query, { limit: 10, now });
    const hits = results.map((r) => idToSeed.get(r.node.id)).map((s) => Boolean(s && s.topic === topic.id));
    const relevantTotal = topic.relevant.length + topic.nearDuplicates.length;
    const p5 = hits.slice(0, 5).filter(Boolean).length / 5;
    const r10 = hits.slice(0, 10).filter(Boolean).length / relevantTotal;
    queries.push({ id: topic.id, query: topic.query, p5, r10, returned: results.length, top: results.slice(0, 5).map((r) => r.node.content) });
  }
  const mean = (key) => queries.reduce((s, q) => s + q[key], 0) / queries.length;
  return { seeds: seeds.length, relevant: 30, distractors: 30, queries, p5: mean("p5"), r10: mean("r10") };
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}
