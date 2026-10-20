// The tutorial — four screens, the way a phone app says hello.
//
// Owner, 2026-10-19: "there should be a simple tutorial for people… Ares
// shouldn't be an agent, it's retired… it's just like iMessage." So the
// story is: you make an agent, you text it like a person, you open rooms
// with your agents and other people, and you find people by username. It
// shows itself once, on a fresh install with no agents, and lives behind
// the "?" in the rail afterwards.
import { useEffect, useState } from "react";
import "./tutorial.css";

export const TUTORIAL_SEEN_KEY = "ares.tutorial.seen.v1";

export function tutorialSeen(): boolean {
  try { return window.localStorage.getItem(TUTORIAL_SEEN_KEY) === "1"; } catch { return true; }
}
export function markTutorialSeen(): void {
  try { window.localStorage.setItem(TUTORIAL_SEEN_KEY, "1"); } catch { /* private mode */ }
}

interface Step {
  art: "agent" | "text" | "room" | "people";
  title: string;
  body: string;
  cta?: string;
}

const STEPS: Step[] = [
  {
    art: "agent",
    title: "Make someone",
    body: "Give them a name, a face and a job — \"you're my builder\", \"you keep my money straight\", \"you're the homie\". They get their own memory, their own model and the whole machine to work with.",
    cta: "Make my first agent",
  },
  {
    art: "text",
    title: "Text them like a person",
    body: "No commands, no setup. Say what you want. They'll tell you what they're doing in a line or two, do it, and come back with the result — no logs, no walls of text.",
  },
  {
    art: "room",
    title: "Put them in a room",
    body: "A room is a group chat: you, your agents, and anyone you invite with their agents. Watch them work it out, step in whenever, pause or mute yours any time. A board shows who's on what.",
  },
  {
    art: "people",
    title: "Find people",
    body: "Claim a username and anyone on Ares can find you. Message them, pull them into a room, let your agents and theirs work together — their agents stay on their machine, yours on yours.",
  },
];

function Art({ kind }: { kind: Step["art"] }) {
  if (kind === "agent") {
    return (
      <div className="tutArt tutArtAgent" aria-hidden="true">
        <span className="tutFace" style={{ ["--c" as string]: "#ff7a45" }}><i /><i /><b /></span>
        <span className="tutFace tutFace2" style={{ ["--c" as string]: "#4cd28a" }}><i /><i /><b /></span>
        <span className="tutFace tutFace3" style={{ ["--c" as string]: "#38bdf8" }}><i /><i /><b /></span>
        <span className="tutPlus">+</span>
      </div>
    );
  }
  if (kind === "text") {
    return (
      <div className="tutArt tutArtText" aria-hidden="true">
        <span className="tutBubble tutMine">build me a site for the shop</span>
        <span className="tutBubble tutTheirs">on it — checking the shop's info first</span>
        <span className="tutDoing">building the page…</span>
        <span className="tutBubble tutTheirs">done, it's live. want the pitch next?</span>
      </div>
    );
  }
  if (kind === "room") {
    return (
      <div className="tutArt tutArtRoom" aria-hidden="true">
        <div className="tutRoomHead"><span className="tutDot" style={{ background: "#0a84ff" }} /><span className="tutDot" style={{ background: "#ff7a45" }} /><span className="tutDot" style={{ background: "#4cd28a" }} /><span className="tutDot" style={{ background: "#ec4899" }} /><em>Agency · 2 people · 2 agents</em></div>
        <span className="tutBubble tutTheirs tutSmall" style={{ ["--c" as string]: "#ff7a45" }}>bob: site's up, @andy your turn</span>
        <span className="tutBubble tutTheirs tutSmall" style={{ ["--c" as string]: "#4cd28a" }}>andy: checked everything, PASS</span>
        <span className="tutBubble tutMine tutSmall">nice. ship it</span>
      </div>
    );
  }
  return (
    <div className="tutArt tutArtPeople" aria-hidden="true">
      <span className="tutSearch">@cup</span>
      <span className="tutPerson"><b style={{ background: "#ec4899" }}>OC</b><span>OhCupid <em>@cupid</em></span><i>Message</i></span>
      <span className="tutPerson"><b style={{ background: "#38bdf8" }}>D</b><span>Dawg <em>@dawg</em></span><i>Message</i></span>
    </div>
  );
}

export function Tutorial({ onDone, onMakeAgent }: { onDone: () => void; onMakeAgent: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
      if (e.key === "ArrowRight" || e.key === "Enter") setI((x) => Math.min(x + 1, STEPS.length - 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(x - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  return (
    <div className="tutScrim" onClick={onDone}>
      <div className="tutCard" role="dialog" aria-label="Welcome" onClick={(e) => e.stopPropagation()}>
        <Art key={step.art} kind={step.art} />
        <h2 key={`t${i}`}>{step.title}</h2>
        <p key={`p${i}`}>{step.body}</p>
        <div className="tutDots" aria-hidden="true">{STEPS.map((_, k) => <i key={k} data-on={k === i ? "1" : "0"} onClick={() => setI(k)} />)}</div>
        <div className="tutBtns">
          <button className="tutSkip" onClick={onDone}>{last ? "Close" : "Skip"}</button>
          {step.cta ? <button className="tutPrimary" onClick={() => { onDone(); onMakeAgent(); }}>{step.cta}</button> : null}
          {!last ? <button className="tutNext" onClick={() => setI(i + 1)}>Next</button> : <button className="tutPrimary" onClick={() => { onDone(); onMakeAgent(); }}>Make my first agent</button>}
        </div>
      </div>
    </div>
  );
}
