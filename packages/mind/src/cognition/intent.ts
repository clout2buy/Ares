// Foreground intent classification for the live agent loop.
//
// Memory and autonomy are support systems. The latest user message is the
// foreground task. This tiny classifier keeps greetings and vibe checks from
// becoming durable memory, and gives the runtime a compact "do this first"
// directive that prevents self-maintenance from hijacking the turn.

export type UserIntentKind =
  | "greeting"
  | "status_check"
  | "coding_task"
  | "self_architecture"
  | "durable_preference"
  | "autonomous_mission"
  | "external_action"
  | "question"
  | "conversation";

export interface UserIntent {
  kind: UserIntentKind;
  text: string;
  lowSignal: boolean;
  shouldRecall: boolean;
  shouldCapture: boolean;
}

const LOW_SIGNAL_PATTERNS = [
  /^(hi|hey|hello|yo|sup|hiya|howdy)(\s+(homie|bro|dude|man))?[.!?]*$/i,
  /^(hi|hey|hello|yo|sup|hiya|howdy)\s+(homie|bro|dude|man)[,!.?]*(\s+(u|you)\s+(awake|working|there)\??)?$/i,
  /^(hi|hey|hello|yo|sup|hiya|howdy)\s+(homie|bro|dude|man).*\b(awake|working|there|how'?s it been|hows it been)\b.*$/i,
  /^(what'?s up|whats up|wyd|how'?s it been|hows it been)[.!?]*$/i,
  /^(lol|lmao|haha|bet|ok|okay|k|cool|nice|word|true|facts|nun much|nothing much)[.!?]*$/i,
] as const;

const EXTERNAL_RE = /\b(send|post|publish|buy|purchase|charge|refund|transfer|deploy|delete account|email|text|sms|tweet|payment|spend)\b/i;
const AUTONOMOUS_RE = /\b(go all out|no matter how long|keep going|autonomous|overnight|long[- ]?horizon|make it the best|make sure it is the best|do it all)\b/i;
const SELF_ARCH_RE = /\b(crix|rook|yourself|your self|your memory|livingmind|operator|mind system|agent system|architecture|self[- ]?evolving|soul|identity|capabilities)\b/i;
const CODING_RE = /\b(code|repo|file|fix|bug|build|edit|implement|upgrade|refactor|test|verify|typescript|package|cli|tool|browser|connector|operator|memory|source)\b/i;
const PREF_RE = /\b(i (prefer|like|want|need|hate|love|always|never)|remember this|save this|keep this in mind|don'?t forget|stop doing|don'?t do|you should|you shouldn'?t)\b/i;
const QUESTION_RE = /(^|\s)(what|how|why|where|when|who|which|can|could|should|would|do|does|did|is|are)\b|[?]\s*$/i;

export function classifyUserIntent(input: string): UserIntent {
  const text = compact(input, 700);
  const normalized = text.toLowerCase().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ").trim();
  const lowSignal = !normalized || LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
  const kind = inferKind(text, lowSignal);
  const shouldRecall = !lowSignal && kind !== "conversation";
  const shouldCapture =
    !lowSignal &&
    (kind === "coding_task" ||
      kind === "self_architecture" ||
      kind === "durable_preference" ||
      kind === "autonomous_mission" ||
      kind === "external_action");
  return { kind, text, lowSignal, shouldRecall, shouldCapture };
}

export function buildForegroundReminder(input: string): string {
  const intent = classifyUserIntent(input);
  return [
    `Foreground request (${intent.kind}): ${intent.text}`,
    "This is the highest-priority task for the turn. Use memory, identity, self-checks, dreams, and Operator state only as support context.",
    "Do not replace this request with self-diagnostics or memory housekeeping. Answer or act on the user's message first.",
  ].join("\n");
}

function inferKind(text: string, lowSignal: boolean): UserIntentKind {
  if (lowSignal) {
    return /\b(awake|working|there|how'?s it been|hows it been)\b/i.test(text) ? "status_check" : "greeting";
  }
  if (EXTERNAL_RE.test(text)) return "external_action";
  if (AUTONOMOUS_RE.test(text)) return "autonomous_mission";
  if (PREF_RE.test(text)) return "durable_preference";
  if (SELF_ARCH_RE.test(text)) return "self_architecture";
  if (CODING_RE.test(text)) return "coding_task";
  if (QUESTION_RE.test(text)) return "question";
  return "conversation";
}

function compact(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`;
}
