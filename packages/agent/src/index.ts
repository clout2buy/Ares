export { crixAgentHome, agentPaths, workspaceToolsPath, type AgentPaths } from "./paths.js";
export { exists, readTextIfExists, writeFileAtomic, renderTemplate, nonCommentLines } from "./files.js";
export { readTemplate, type AgentTemplateName } from "./templates.js";
export { defaultAgentConfig, loadAgentConfig, expandHomePath, type CrixAgentConfig, type SlotConfig } from "./config.js";
export {
  ensureAgentScaffold,
  completeBootstrap,
  ensureWorkspaceTools,
  bootstrapReminder,
  type BootstrapProfile,
  type BootstrapState,
} from "./bootstrap/bootstrap.js";
export { VIBE_RULES, vibeRulesMarkdown } from "./bootstrap/vibeRules.js";
export { loadAgentSystemContext, composeAgentSystemPrompt, type AgentSystemContext, type AgentContextBlock } from "./identity/context.js";
export { embedText, embedOptionsFromConfig, lexicalEmbedding, type EmbedOptions } from "./memory/embed.js";
export { createMemoryStore, formatRecallReminder, type MemoryStore } from "./memory/vectorStore.js";
export type { AddMemoryInput, MemoryCategory, MemoryEntry, MemoryStoreStatus, RecallInput, RecallResult } from "./memory/types.js";
export { onLifecycle, emitLifecycle, type LifecycleEvent, type DreamPhase } from "./lifecycle/bus.js";
export { runHeartbeatTick, startHeartbeatLoop, type HeartbeatResult } from "./heartbeat.js";
export { runLightDream, runDeepDream, runRemDream, type DreamResult } from "./dreaming.js";
export { recallForTurn, type RecallOptions } from "./recall.js";
export { beforeAgentFinalizeSignal, type ReviseSignal } from "./revise.js";
export { recordToolPattern, proposeSkills, type ToolPatternObservation, type SkillProposal } from "./skills.js";
export { prepareCrixAgent, CrixAgentRuntime, type PreparedAgent } from "./runtime.js";
export { BootstrapTool, type BootstrapToolOutput } from "./tools/Bootstrap.js";
export { SelfEvolveTool, type SelfEvolveOutput } from "./tools/SelfEvolve.js";
export { SkillCraftTool, type SkillCraftOutput } from "./tools/SkillCraft.js";
export { captureUserMessage, detectCaptures, type CaptureMatch, type CaptureResult } from "./capture.js";
export { countAppendedItems, gainForTarget } from "./voice.js";
export type { EvolutionGain } from "./lifecycle/bus.js";
export {
  snapshotBrain,
  listSnapshots,
  restoreSnapshot,
  exportHome,
  importHome,
  type SnapshotInfo,
} from "./persistence.js";

