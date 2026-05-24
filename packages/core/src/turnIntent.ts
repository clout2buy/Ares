export type TurnIntentKind =
  | "workspace_capture"
  | "goal_run"
  | "repo_scan"
  | "tool_audit"
  | "agent_orchestration"
  | "local_status"
  | "provider_chat";

export type RepoScanIntentMode = "scout" | "deep";

export interface TurnIntentContext {
  activeWorkspace?: string;
  pathExists?: (path: string) => boolean;
}

export interface TurnIntent {
  kind: TurnIntentKind;
  reason: string;
  targetPath?: string;
  repoScanMode?: RepoScanIntentMode;
}

export function planTurnIntent(text: string, context: TurnIntentContext = {}): TurnIntent {
  const targetPath = extractLocalPath(text);
  const targetExists = targetPath ? context.pathExists?.(targetPath) ?? true : false;

  if (isGoalRunIntent(text)) {
    return {
      kind: "goal_run",
      reason: "user asked Crix to implement or modify local files",
      targetPath,
    };
  }

  if (targetPath && targetExists && isWorkspaceCaptureIntent(text)) {
    return {
      kind: "workspace_capture",
      reason: "user explicitly selected a local workspace",
      targetPath,
    };
  }

  if (isToolAuditIntent(text)) {
    return {
      kind: "tool_audit",
      reason: "user asked to exercise or inspect the available tool runtime",
    };
  }

  if (isAgentOrchestrationIntent(text)) {
    return {
      kind: "agent_orchestration",
      reason: "user asked to exercise or inspect agent orchestration",
    };
  }

  if (isRepoDeepScanIntent(text, context)) {
    return {
      kind: "repo_scan",
      reason: "user asked for deeper codebase inspection",
      targetPath,
      repoScanMode: "deep",
    };
  }

  if (isRepoScoutIntent(text, context)) {
    return {
      kind: "repo_scan",
      reason: "user asked Crix to learn or inspect a codebase",
      targetPath,
      repoScanMode: "scout",
    };
  }

  if (isLocalStatusIntent(text)) {
    return {
      kind: "local_status",
      reason: "user opened a lightweight local status turn",
    };
  }

  return {
    kind: "provider_chat",
    reason: "no local deterministic turn intent matched",
  };
}

export function extractLocalPath(text: string): string | undefined {
  const matches = text.match(/[A-Za-z]:\\(?:[^\\/:*?"<>|\s]+\\?)+/g) ?? [];
  return matches[0]?.replace(/[.,;:]+$/, "");
}

function isRepoScanIntent(text: string, context: TurnIntentContext): boolean {
  return isRepoDeepScanIntent(text, context) || isRepoScoutIntent(text, context);
}

function isRepoScoutIntent(text: string, context: TurnIntentContext): boolean {
  const normalized = text.trim().toLowerCase();
  const intentText = stripLocalPaths(text).toLowerCase();
  const hasPath = Boolean(extractLocalPath(text));
  const hasWorkspace = Boolean(context.activeWorkspace);
  if (isAgentBehaviorMetaQuestion(normalized)) return false;
  const scoutVerb = /\b(learn|inspect|scout|understand|review|look|check|audit|analy[sz]e|map)\b/.test(intentText);
  const repoWord = /\b(repo|codebase|project|folder|workspace|runtime|query|harness)\b/.test(intentText);
  if (hasPath) return scoutVerb || repoWord;
  if (!hasWorkspace) return false;
  return /^(inspect|learn it|learn this|learn how it works|just learn how it works)\b/.test(normalized)
    || /\b(lmk what (u|you) see|suggest next steps for (this|the) (repo|codebase|project|workspace))\b/.test(normalized)
    || (scoutVerb && repoWord);
}

function isWorkspaceCaptureIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const withoutPath = stripLocalPaths(text).toLowerCase();
  if (!withoutPath.trim()) return true;
  return /\b(is u|is you|is me|is us|is my workspace|is the workspace)\b/.test(withoutPath)
    || /\b(use|switch to|set|select|remember|open)\b.*\b(workspace|repo|repository|project|folder|directory)\b/.test(normalized)
    || /\b(workspace|repo|repository|project|folder|directory)\b.*\b(use|switch|set|select|remember|open)\b/.test(normalized);
}

function isGoalRunIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (isMetaQuestion(normalized, /\b(tools?|agents?|subagents?|workers?)\b/)) return false;
  if (isAgentBehaviorMetaQuestion(normalized)) return false;
  if (isRepoDeepScanIntent(text, { activeWorkspace: extractLocalPath(text) }) || isRepoScoutIntent(text, { activeWorkspace: extractLocalPath(text) })) return false;

  const intentText = stripLocalPaths(text).toLowerCase();
  const hasPath = Boolean(extractLocalPath(text));
  const action = /\b(make|create|build|write|generate|implement|add|fix|change|update|upgrade|refactor|scaffold|set up|setup)\b/.test(intentText);
  const artifact = /\b(app|application|website|site|webpage|page|html|css|javascript|typescript|component|feature|file|project|game|notes?|todo|dashboard|api|server|script|test|bug|issue|ui|tool|harness|crix|repo|code)\b/.test(intentText);
  const asksToOpen = /\b(open|launch|show|view)\b.*\b(it|browser|page|site|app|html)\b/.test(intentText) || /\bwhen done\b/.test(intentText);

  return action && (artifact || hasPath || asksToOpen);
}

function isRepoDeepScanIntent(text: string, context: TurnIntentContext): boolean {
  const normalized = text.trim().toLowerCase();
  const hasWorkspace = Boolean(extractLocalPath(text) || context.activeWorkspace);
  if (!hasWorkspace) return false;
  return /\b(deep scan|deep-scan|scan deeper|full scan|deeper scan|analyze deeply|deep inspect)\b/.test(normalized)
    || /^(deep scan it|scan it deeper|go deeper)\b/.test(normalized);
}

function isToolAuditIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (isMetaQuestion(normalized, /\btools?\b/)) return false;
  const asksForRuntimeExercise = /\b(flex|show|exercise|test|audit|inspect|run|prove|check)\b/.test(normalized);
  const namesTooling = /\b(tool|tools|tooling|toolcards?|tool calls?|tool runtime|runtime tools?)\b/.test(normalized);
  return asksForRuntimeExercise && namesTooling;
}

function isAgentOrchestrationIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (isMetaQuestion(normalized, /\b(agents?|subagents?|workers?)\b/)) return false;
  const asksForAgentExercise = /\b(flex|show|exercise|test|audit|inspect|run|prove|check|spawn)\b/.test(normalized);
  const namesAgents = /\b(agent|agents|subagent|subagents|worker|workers)\b/.test(normalized);
  return asksForAgentExercise && namesAgents;
}

function isLocalStatusIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "").trim();
  if (/^(hi|hey|hello|yo|sup|how are you|hows it going|how's it going|oh|ok|okay|thanks|thank you|cool|nice)\b\s*$/.test(normalized)) return true;
  return /^(man\s+tf|wtf|tf|bruh|bro|bro what|huh|what|nah|no|nope|yikes|ugh|dang|damn|lol|lmao)\s*$/.test(normalized);
}

function isMetaQuestion(normalized: string, subject: RegExp): boolean {
  if (/\b(don't|dont|do not)\b.*\b(work|run|execute|call|use)\b/.test(normalized)) return true;
  if (/\b(real|fake|instance response|when i said|question|figure out)\b/.test(normalized) && subject.test(normalized)) return true;
  return false;
}

function isAgentBehaviorMetaQuestion(normalized: string): boolean {
  const aboutAgent = /\b(u|you|your|ur|agent|crix|coding|code|prompt|instructions|behavior|tools?|scan|inspect)\b/.test(normalized);
  if (!aboutAgent) return false;
  return /\b(i never asked|never asked|why did (u|you)|why are (u|you)|what made (u|you)|makes (u|you) do|made (u|you) do|supposed to|is it something in (ur|your) (coding|code|prompt|instructions)|what caused (it|that)|trying to trouble\s*shoot|trouble\s*shoot)\b/.test(normalized);
}

function stripLocalPaths(text: string): string {
  return text.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\s]+\\?)+/g, "").trim();
}
