// First run as a conversation, not a settings page.
//
// Owner, 2026-10-25: "users don't know API keys, status, engine, garrison —
// they don't know." A new person should never read the word "key". They meet
// Ares in a chat that asks the one question that matters — which AI do you
// already pay for? — opens the matching sign-in, and makes their first agent
// on the brain that just connected. Scripted (no model runs before a key
// exists), so it is the same five bubbles for everyone. Keys, Ollama and the
// Ares account are still reachable, one step further in ("Something else").
import { useEffect, useRef, useState } from "react";
import "./setup.css";
import { AGENT_TEMPLATES } from "./agents";

/** "I'll sort it out myself" is a real decision: remember it so the setup
 *  never re-prompts on every boot. (A key landing closes it through keyStatus.) */
export const SETUP_SKIP_KEY = "ares.firstRun.choice";

export function setupSkipped(): boolean {
  try {
    const v = window.localStorage.getItem(SETUP_SKIP_KEY);
    return v === "local-ollama" || v === "skipped";
  } catch {
    return false;
  }
}

/** The brain a fresh sign-in puts the first agent on. Sonnet/5.5: strong and
 *  cheap on a subscription — a new person should not burn a Pro plan's limit
 *  on the flagship before they've sent ten messages. */
export const SETUP_BRAIN: Record<"anthropic" | "openai", { provider: string; model: string }> = {
  anthropic: { provider: "anthropic", model: "claude-sonnet-5" },
  openai: { provider: "openai", model: "gpt-5.5" },
};

type Line = { who: "ares" | "you"; text: string };
type Stage = "pick" | "signing" | "other" | "name" | "agent" | "done";

export function SetupChat({
  active,
  keyStatus,
  signingIn,
  onSignIn,
  onOpenKeys,
  onOpenAres,
  onName,
  onFirstAgent,
  onSkip,
}: {
  active: boolean;
  keyStatus: Record<string, boolean>;
  /** The provider whose browser sign-in is open right now, if any. */
  signingIn: "anthropic" | "openai" | null;
  onSignIn: (provider: "anthropic" | "openai") => void;
  onOpenKeys: () => void;
  onOpenAres: () => void;
  onName: (name: string) => void;
  /** Make the first agent on the connected brain; opens their chat. */
  onFirstAgent: (agent: { name: string; emoji: string; color: string; role: string; provider: string; model: string }) => void;
  onSkip: () => void;
}): React.ReactElement | null {
  const [stage, setStage] = useState<Stage>("pick");
  const [lines, setLines] = useState<Line[]>([{ who: "ares", text: "Hi — I'm Ares. I think with an AI model, and the easiest one to use is the one you already pay for. Which do you have?" }]);
  const [picked, setPicked] = useState<"anthropic" | "openai" | null>(null);
  const [name, setName] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const say = (who: Line["who"], text: string) => setLines((l) => [...l, { who, text }]);

  // A key landed (sign-in finished, or one pasted in Settings): move on.
  const connected = (["anthropic", "openai", "kimi", "deepseek", "openrouter", "ollama", "ares"] as const).find((p) => keyStatus[p]);
  useEffect(() => {
    if (!active || !connected) return;
    if (stage === "signing" || stage === "other" || stage === "pick") {
      say("ares", `You're in${connected === "anthropic" ? " — Claude is connected" : connected === "openai" ? " — ChatGPT is connected" : ""}. What should I call you?`);
      setStage("name");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, active]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines, stage]);

  if (!active) return null;

  const brain = picked && connected === picked ? SETUP_BRAIN[picked] : connected === "openai" ? SETUP_BRAIN.openai : connected === "anthropic" ? SETUP_BRAIN.anthropic : null;

  const pick = (p: "anthropic" | "openai") => {
    setPicked(p);
    say("you", p === "anthropic" ? "Claude" : "ChatGPT");
    say("ares", `Opening ${p === "anthropic" ? "Claude" : "ChatGPT"} sign-in in your browser. Come back here once it says you're done.`);
    setStage("signing");
    onSignIn(p);
  };
  const neither = () => {
    say("you", "Neither");
    say("ares", "No problem. You can connect an Ares account (models included, nothing to set up), or paste a key from any AI provider if you have one.");
    setStage("other");
  };
  const submitName = () => {
    const n = name.trim();
    say("you", n || "Just call me whatever");
    if (n) onName(n);
    say("ares", `${n ? `Nice to meet you, ${n}. ` : ""}Last thing — who do you want to talk to first? Each one is an agent with its own memory. You can make more later.`);
    setStage("agent");
  };
  const makeAgent = (t: (typeof AGENT_TEMPLATES)[number]) => {
    const b = brain ?? SETUP_BRAIN.anthropic;
    say("you", t.name);
    say("ares", `Making ${t.name}. Say hi.`);
    setStage("done");
    onFirstAgent({ name: t.name, emoji: t.emoji, color: t.color, role: t.role, provider: b.provider, model: b.model });
  };

  return (
    <div className="scrim center setupScrim" role="dialog" aria-modal="true" aria-label="Welcome to Ares">
      <div className="setupCard" onClick={(e) => e.stopPropagation()}>
        <header className="setupHead">
          <span className="setupMark" aria-hidden="true" />
          <strong>Ares</strong>
        </header>
        <div className="setupLines">
          {lines.map((l, i) => (
            <div key={i} className="setupLine" data-who={l.who}>
              <span>{l.text}</span>
            </div>
          ))}
          {stage === "signing" && signingIn ? (
            <div className="setupLine" data-who="ares"><span className="setupWaiting">Waiting on your browser…</span></div>
          ) : null}
          <div ref={endRef} />
        </div>
        <footer className="setupReply">
          {stage === "pick" ? (
            <>
              <button type="button" className="setupChoice primary" onClick={() => pick("anthropic")}>Claude</button>
              <button type="button" className="setupChoice primary" onClick={() => pick("openai")}>ChatGPT</button>
              <button type="button" className="setupChoice" onClick={neither}>Neither</button>
            </>
          ) : null}
          {stage === "signing" ? (
            <>
              <button type="button" className="setupChoice" onClick={() => picked && onSignIn(picked)}>Open it again</button>
              <button type="button" className="setupChoice" onClick={neither}>Use something else</button>
            </>
          ) : null}
          {stage === "other" ? (
            <>
              <button type="button" className="setupChoice primary" onClick={onOpenAres}>Ares account</button>
              <button type="button" className="setupChoice" onClick={onOpenKeys}>I have a key</button>
              <button type="button" className="setupChoice" onClick={() => pick("anthropic")}>Actually, Claude</button>
              <button type="button" className="setupChoice" onClick={() => pick("openai")}>Actually, ChatGPT</button>
            </>
          ) : null}
          {stage === "name" ? (
            <form className="setupNameRow" onSubmit={(e) => { e.preventDefault(); submitName(); }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={40} />
              <button type="submit" className="setupChoice primary">{name.trim() ? "That's me" : "Skip"}</button>
            </form>
          ) : null}
          {stage === "agent" ? (
            <div className="setupAgents">
              {AGENT_TEMPLATES.slice(0, 4).map((t) => (
                <button type="button" key={t.name} className="setupAgent" style={{ ["--agent" as string]: t.color }} onClick={() => makeAgent(t)} title={t.role}>
                  <span className="setupAgentFace" aria-hidden="true">{t.emoji}</span>
                  <b>{t.name}</b>
                  <small>{t.role.replace(/^You're my /, "").split(".")[0]}</small>
                </button>
              ))}
            </div>
          ) : null}
        </footer>
        {stage !== "done" && stage !== "agent" ? (
          <button type="button" className="setupSkip" onClick={onSkip}>I'll set it up myself</button>
        ) : null}
      </div>
    </div>
  );
}
