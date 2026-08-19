# The Agent's Own Computer — design spec

Status: SPEC (nothing built). Source: field study of xAI's Grok Bot desktop app
(2026-08-19), including its agent's own description of its runtime, verified by
it against its live machine. Treat the Grok details as *design intelligence*,
not gospel — but the shape held up under questioning and matches what we'd
derive independently.

## Why

Ares's ComputerUse drives the OWNER's machine. That is why it is gated,
premium, and permission-heavy — every click is on real state. An agent-owned
sandbox inverts the trade: long-running, login-requiring, mistake-tolerant
autonomy moves to a machine where nothing needs a prompt, and the owner's
Windows box stays what it already is — a second, guarded channel. We keep
Ares's edge (real local coding, fleets, the owner's repos) and add the thing
Grok Bot leads with.

The one-sentence mental model (Grok's, and correct):
**the chat is the control plane; the computer is a tool target; the model
never becomes the computer — it calls it.**

## Architecture

- Engine unchanged. queryEngine's tool loop IS the wire. The sandbox arrives
  as a new toolset (`AgentComputer`), not a new engine mode.
- **Both toolsets live at once; the target is named on the call.** No
  host-vs-sandbox session flag — real work uses both in one turn (pull a file
  off the host, work in the sandbox, copy the result back). A flag is too
  coarse. Host-side calls keep their existing permission gates; sandbox calls
  don't need them. (Grok patch #1.)
- Sandbox: headless Debian under **WSL2** (not Docker Desktop — keeps the
  installer story clean for external users; WSL2 can run Xvfb, VNC, and Chrome
  fine). A dedicated distro, e.g. `ares-computer`.
- Persistence contract: **the OS is disposable, /home is forever.**
  "Update the computer" = replace the distro image, keep the home volume
  (tar export/import of /home, or a separately mounted VHDX). Files, installs
  recorded in a manifest, and browser logins survive.
- The owner's real machine remains a SECOND permissioned channel — including
  file copy in/out of the sandbox, which is a host-side, gated operation.

## Displays and browsers (the part we'd have gotten wrong)

Verified Grok behavior, adopt as-is:

- **Displays are per user-facing agent, not per nested worker.** A background
  worker shares its parent agent's screen and takes the lease. Per-worker Xvfb
  would pay for desktops nobody watches and make the "look, it's working" pane
  meaningless. N Chromes only when N agents have a reason to be on screen.
  (Grok patch #3.)
- Per-agent **Xvfb display** (1280×800) — Chrome's single-instance rule steals
  windows onto the first display otherwise. One machine, N displays, N Chrome
  processes, one login session.
- Per-agent Chrome profile (profile lock demands it), with the **cookie and
  saved-password SQLite files symlinked into a shared store** so a login done
  once sticks for every agent. Local Storage stays per-agent — leveldb will
  not share. Sites that live on localStorage tokens will need per-agent
  sign-in; that is acceptable.
- **Screen ownership:** clicks/keystrokes belong to a desktop driver, and only
  one driver may own a display at a time (per-display lease/mutex).
- **Browser work prefers page-level CDP** — it does not take the mouse, so it
  runs concurrently with other work on the same machine.
- **Playwright rides the display's Chrome, never its own.** Reuse the existing
  Playwright stack via `connectOverCDP` into the Chrome that already owns the
  display; a Playwright-launched second browser splits the session from the
  VNC pane and the screenshots, and the login story falls apart. WebFetch
  stays what it is — no JS, no cookies, public pages — and does NOT run
  inside the sandbox Chrome. (Grok patch #2.)
- **exec may not drive the GUI.** No xdotool-from-shell fake clicks. Input
  goes through the desktop driver tool or not at all — this keeps the lease
  meaningful and the audit trail honest.

## Action API (tool surface)

Phase 1 set:

| Tool | Notes |
|---|---|
| `computer_exec` | shell in the sandbox; direct; no GUI input allowed |
| `computer_fs` | read/write/list under the sandbox home |
| `computer_screenshot` | read-only capture of a named display |
| `computer_cdp` | page-level browser control (navigate/read/click-by-node); mouse-free |

Phase 2/3 additions: `computer_desktop` (click/type under a display lease),
`computer_transfer` (host⇄sandbox copy, permissioned on the host side),
snapshot/reset.

## The watchable, grabbable screen

- Stream the desktop into an Ares pane VNC-style (noVNC embeds in the webview;
  we already did CDP live-streaming and the garrison /view page — same
  plumbing pattern).
- The stream is **writable**; "watch" vs "drive" is a product mode on top.
- **Handoff protocol** for 2FA / CAPTCHA / payments: the agent STOPS, the
  owner gets the desktop with an explicit "hand it back" control, then the
  agent continues. This slots perfectly into Ares's existing doctrine — Ares
  never handles credentials or CAPTCHAs itself; now it has somewhere to hand
  them.
- Proof-by-screenshot: the agent posting its own desktop into chat is the
  cheapest trust move in the product. The GUI screenshot gate extends to the
  sandbox unchanged.

## Boundaries that are doctrine, not detail

- **Per-owner sandbox.** Garrison/Telegram users never share a cookie store —
  one sandbox per owner identity, full stop. (Grok patch #4.)
- **The OS is disposable and we don't pretend otherwise.** A reinstall
  manifest (packages re-applied on rebuild) is a real upgrade over Grok's
  throw-away-and-hope, but home + logins are the only durable surface.

## Phases

1. **Headless learner.** WSL2 distro + exec/fs/screenshot/CDP, ONE display,
   ONE Chrome, persistent home. Both toolsets live, target named per call.
   The symlink login-store trick WAITS until two user-facing agents actually
   exist on the machine. This is enough to learn everything else against.
2. **The pane.** noVNC stream in the desktop app, watch/drive toggle, the
   2FA handoff control, inline self-screenshots.
3. **Crew semantics.** Per-subagent displays, the shared login store
   (symlink trick), display leases, snapshot/reset ("fresh computer" button),
   distro-rebuild-keep-home updates.

## Open questions

- WSL2 availability/enablement UX on machines that never turned it on
  (installer detects, offers `wsl --install`, falls back to
  host-only ComputerUse).
- Multi-user: garrison/telegram sessions sharing one sandbox vs per-owner.
- Disk budget: Chrome + desktop in a distro ≈ 2–4 GB; home growth unbounded —
  needs the same ledger treatment as the session WAL.
- Whether Phase 1 should reuse the existing Playwright/WebFetch browser stack
  inside the sandbox instead of raw CDP plumbing.
