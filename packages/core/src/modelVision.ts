// Model vision capability — the single source of truth for "does this model
// see pixels?", shared by the daemon's per-turn escalation guard and the
// engine's outbound wire guard.
//
// It lived in cli/entry/sessionFactory.ts, where only the daemon could reach
// it. That left the engine unable to answer the question at the one place it
// actually matters — the moment a prompt is serialized for a provider — so a
// blind model still received image blocks whenever the daemon's escalation
// found no vision-capable fallback to escalate TO. See stripImagesForBlindModel
// in queryEngine.ts for what that cost a user.

/**
 * Does this model see pixels? Best-known per-model-id vision capability, same
 * pattern style as modelContextWindow. This exists because NOTHING else
 * threads vision metadata to the live turn — a user pasted a screenshot into a
 * pinned deepseek-v4-pro session and got "Can't view the image format
 * directly" while the app happily shipped the image to a blind model
 * (sess_e4c6022d). Conservative: unknown ids default to false so we never
 * skip escalation for a model that turns out blind.
 */
export function modelLikelyHasVision(modelId: string): boolean {
  const id = (modelId ?? "").toLowerCase();
  // Kimi went multimodal at K2.5: the coding-endpoint ids (kimi-for-coding,
  // k3, k3-256k) and K2.5+ all take image input per the live /models
  // metadata; only the original K2 line (k2, k2-0905, k2-thinking, k2:1t)
  // stays text-only via the blind list below.
  if (/kimi-for-coding|kimi-k2\.[5-9]|kimi-k[3-9]|(?:^|[^a-z0-9])k3(?:[^a-z0-9]|$)/.test(id)) return true;
  // DeepSeek V4.1-Flash (id: deepseek-flash) has native vision per DeepSeek's
  // model table; V4-Pro (deepseek-v4-pro) does NOT. DeepSeek's /models API
  // returns bare ids with no capability flags, so discovery can't learn this —
  // it falls back here, and here used to blanket-blind ALL deepseek, so a
  // pasted image to deepseek-flash was silently stripped. The retired
  // deepseek-v4-flash* ids are served by V4.1-Flash now, so "flash" => vision.
  if (/deepseek.*flash|deepseek-flash/.test(id)) return true;
  // Text-only families first — some ids would otherwise match broader patterns.
  if (/deepseek|gpt-oss|glm-|kimi-k|qwen3-coder|qwen3-next|minimax|gpt-3\.5|o1-mini|o3-mini/.test(id) && !/vl|vision/.test(id)) return false;
  if (/claude|sonnet|opus|haiku|fable|mythos/.test(id)) return true;
  if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo3\b|\bo4\b|o3-pro|o4-mini/.test(id)) return true;
  if (/gemini|gemma3|gemma-3/.test(id)) return true;
  if (/qwen.{0,3}vl|llava|pixtral|minicpm-v|internvl|phi-4-multimodal|llama-3\.2.*vision|llama-4|grok-[34]/.test(id)) return true;
  if (/vision|multimodal/.test(id)) return true;
  return false;
}
