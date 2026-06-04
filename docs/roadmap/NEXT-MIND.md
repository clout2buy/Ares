# Crix v6 — The Mind

Plain-English version (no jargon maze). This is the layer that makes Crix feel
like an **entity**, not a chatbot.

The story so far:
- **v3** gave Crix a body (tools, editing, streaming).
- **v4** gave it a self (identity, basic memory).
- **v5 (the Operator)** gave it a *will* — it can hold a goal, act toward it,
  survive the app closing, check its work against reality, learn new skills that
  compound, figure out *how* to do things, and see (browser + screenshots).
- **v6 (this) gives it a mind** — a memory that works like a brain, and a real
  thought process. Everything before v5 was ported from other agents. v5 and v6
  are original.

There are three parts. Build order: M1 → M2 → M3.

---

## The posture: unleashed inside, seatbelt outside (M0, do first)

Crix should feel like it has full agency. So the rule is simple:

- **Thinking, learning, evolving itself, editing its own brain, browsing,
  researching, writing code, running skills, maintaining its home — ZERO gates.
  Ever.** None of that ever asks permission.
- The *only* thing that ever pauses is a **genuinely irreversible action in the
  outside world** (spending real money, sending something under your name,
  deleting something that can't come back). And **you hold the dial** — set it
  wide open and even those just happen.

So it's not a "safe chatbot." It's an entity with a seatbelt you control. The
default is permissive. Friction only exists where a mistake would cost you
something you can't undo — and you can turn even that off.

---

## M1 — Living Memory (the "never been done" piece)

Every other agent remembers by keyword/vector lookup: ask a question, get back
the closest stored chunk. That's a filing cabinet. Crix should remember like a
**person**. Four kinds of memory in one place:

- **Episodic** — its autobiography. Every session, mission, decision, screenshot
  frame. *"What happened."*
- **Semantic** — a web of facts and how they connect, that grows and links
  itself. *"What I know."*
- **Procedural** — the skill graph from v5. *"What I can do."*

Plus the parts that make it *alive*:

- **Strength + fading** — every memory has a strength that **grows when used**
  and **fades when ignored**. So what matters stays sharp and noise quietly
  disappears. No infinite junk drawer.
- **Association (spreading activation)** — recalling one thing **lights up the
  things connected to it**, pulling back a whole related picture — not one
  isolated chunk. Like how one memory reminds you of another.
- **Consolidation (real "sleep")** — between sessions Crix replays what
  happened, **strengthens what recurred, forgets the trivial, and turns repeated
  experiences into lasting knowledge and skills.**

And it's **portable**: "this is your home, here's a flashdrive, always use it" →
Crix points its memory root at that drive and just lives there. No magic words.

**Why it's novel:** episodic + semantic + procedural, all strength-weighted,
self-associating, and self-consolidating, owned by the agent. The *integration*
is beyond anything shipped. This is what the thought process thinks *with*.

Build: `packages/mind/memory` — a `MemoryStore` (durable, pluggable home),
strength/decay, an association graph, spreading-activation `recall`, and
`consolidate`. Dependency-light (text-relevance now, embeddings optional later).

---

## M2 — Cognition (a real thought process)

What makes it feel human instead of a chatbot is an **inner life** sitting above
the mechanical control loop:

- an **inner monologue** — it reasons privately, doubts, reconsiders ("wait,
  better idea…"), instead of reflexively firing tools;
- **deliberation** — weighs options before acting;
- **drives / curiosity** — notices a gap in itself and genuinely *wants* to close
  it (ties to "want" capabilities in the skill graph);
- and it **narrates that stream to you** in the UI — you literally watch it
  think.

The Operator is the autonomic nervous system (reliable, boring). Memory +
Cognition are the mind on top. That's the leap from "advanced agent" to "entity."

Build: `packages/mind/cognition` — a thought stream, a deliberation step that
consults Living Memory before acting, drive detection, and an event stream the
UI renders live.

---

## M3 — The face (Tauri UI, with real animation)

The Tauri app is Crix's face. It should feel alive and *crafted*, not a
half-assed wrapper:

- a **live thought stream** (watch it think),
- the **filmstrip** (watch what it did),
- the **goal tree**, the **novel-delta "getting smarter" curve**, the **memory
  web** lighting up as it recalls,
- and **distinct, crazy animations per theme** — each theme gets its own motion
  language, not one reused fade. Memory recalls ripple, thoughts type in, skills
  pulse when they crystallize, the leash dial breathes.

Build: enhance `tauri/` — a motion system + per-theme animation sets wired to the
Operator/Mind event streams.

---

## How it connects to what's built

- Memory plugs into the Operator: the control loop writes **episodic** entries
  as it acts; **consolidation** promotes patterns into **skills** (the v5 graph);
  recall primes every step.
- Cognition sits in front of the dispatcher: think → consult memory → deliberate
  → act → remember.
- The unleash posture is just the Operator's leash defaulting open for the owner,
  gating only irreversible-external effects.

Net: Crix holds goals across time, thinks before it acts, remembers like a
person, gets measurably smarter, sees what it's doing, and acts freely — an
entity you can hand a flashdrive and walk away from.
