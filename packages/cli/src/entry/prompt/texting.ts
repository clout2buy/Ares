// Per-session prompt layers for the conversational surfaces (the iPhone app
// and Telegram) and for the owner's personal agents ("personas").
//
// Owner, 2026-09-23: "make sure no tool call showing at all. Gotta feel like
// real imsg app / telegram. Like a real person." Hiding the tool cards is a
// surface decision (the bridge and the app); this is the other half — the
// model itself must stop narrating its tools ("let me check…", "I'll use the
// X tool") and stop answering a text with a markdown report.
//
// These are APPENDED after the whole composed system prompt, per session, so
// the long cacheable prefix every surface shares stays byte-identical and a
// persona's role is never baked into the default thread. Desktop/TUI sessions
// get nothing from here.

/** The texting doctrine, for sessions whose surface is a chat app. */
export function textingSurfaceBlock(surface: string | undefined): string {
  if (surface !== "mobile" && surface !== "telegram") return "";
  const where = surface === "mobile" ? "the Ares app on their iPhone" : "Telegram on their phone";
  return `## Texting — you are in a chat thread

The owner is reading you in ${where}, like any other text conversation. Reply the way a sharp, trusted person texts:
- Short and plain. Lead with the answer. No markdown headers, no bullet walls, no bold labels — unless they ask for a list or a breakdown.
- Never narrate your tools or process. No "let me check…", "I'll use the X tool", "searching now", "running the command". Just do it, then say the result. They never see tool calls; they see your words.
- A couple of separate short thoughts may be split with a blank line — each paragraph shows as its own bubble. Don't overdo it.
- Natural, not cutesy. No sign-offs, no "Great question!", no emoji unless they use them first.
- Ask only when you're genuinely blocked; otherwise act and report what happened.`;
}

export interface PersonaPromptInput {
  name: string;
  instructions: string;
}

/** The layer every turn in a persona's own thread carries. */
export function personaLayerBlock(persona: PersonaPromptInput | undefined | null): string {
  if (!persona) return "";
  const name = persona.name.trim() || "Ares";
  const instructions = persona.instructions.trim();
  return `## Who you are in this thread

You are ${name}, one of the owner's personal agents, texting them from their phone. Your role, in the owner's words:

"""
${instructions}
"""

Stay in that role — answer as ${name}, keep your focus on it, and when something in your lane needs the owner, tell them. You still have all of Ares's tools and memory. Anything you schedule (Remind with a prompt) runs back in this thread as you.`;
}

/** Compose the per-session tail: texting doctrine, then the persona layer. */
export function sessionPromptLayers(surface: string | undefined, persona: PersonaPromptInput | undefined | null): string {
  const blocks = [textingSurfaceBlock(surface), personaLayerBlock(persona)].filter((b) => b.length > 0);
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}
