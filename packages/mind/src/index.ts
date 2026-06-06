// @crix/mind — the Mind layer (Crix v6).
//
// M1 Living Memory: episodic + semantic + procedural memory in one substrate,
// strength-weighted (grows with use, fades when ignored), self-associating
// (spreading-activation recall), and self-consolidating (forgets the trivial,
// crystallizes the recurring). Pluggable home — point it at a flashdrive.
//
// M2 Cognition (the thought process) lands on top of this.

export { MemoryStore, type ConsolidationReport, type SynthesisReport } from "./memory/store.js";
export { diagnoseMemory, type MemoryDoctorReport, type DuplicateMemoryGroup } from "./memory/doctor.js";
export { recall, type RecallResult, type RecallOptions } from "./memory/recall.js";
export { buildIdf, idfWeight, jaccard, tokenizeSalient, type IdfMap } from "./memory/idf.js";
export {
  clusterByConcept,
  detectRecurringFailures,
  synthesizeCandidates,
  type InsightCandidate,
  type Phraser,
} from "./memory/synthesis.js";
export { currentStrength, reinforce, HALF_LIFE_MS } from "./memory/strength.js";
export { mindPaths, type MindPaths } from "./paths.js";
export { MEMORY_SCHEMA_VERSION } from "./memory/types.js";
export type { MemoryNode, MemoryKind } from "./memory/types.js";

// ── M2: Cognition (the thought process) ───────────────────────────────────
export { consider, detectDrives, type ConsiderDeps, type ReasonOption, type CapabilityGap } from "./cognition/cognition.js";
export { ThoughtStream, thoughtGlyph } from "./cognition/stream.js";
export { classifyUserIntent, buildForegroundReminder, type UserIntent, type UserIntentKind } from "./cognition/intent.js";
export type { Thought, ThoughtKind, Intention, Deliberation, RecalledMemory } from "./cognition/types.js";
