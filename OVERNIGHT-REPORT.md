# Overnight report — 2026-10-21 (branch `overnight/2026-10-21`)

Cut from `36e3ac4` (v0.61.2). 15 commits including this report and its correction, all pushed. Nothing merged, no version bump, no tag, no release.

## 1. Bricked chat (top priority) — two causes found and fixed

The log (`BRICKED-CHAT-LOG.txt`) shows two separate failures. Each one alone reads as "bricked".

**a) The model couldn't read the file it was asked to rework.** Fixed in `d96b304`.
- What happened in "all": Read `parkour.html` (340 lines, ~40 KB), then Read the `.ares/tool-results/…/toolu_….txt` spill with `limit: 1`, which came back as "1/1 lines". After that nothing happened until Stop.
- Cause: Read pages up to 50 KB but declared no `maxResultSizeChars`, so it fell under the engine's 24k default. Any Read over 24k chars was spilled to disk as **one line of JSON**. Read pages by line and cuts lines at 4,000 chars, so reading the spill could only ever show its first 4,000 chars. The model could not see the file at all.
- Fix:
  - Read is now self-bounded (`maxResultSizeChars: 0`), so a whole-file Read stays inline.
  - Every spill is now written in a form Read can page: the text body with real newlines, or pretty-printed JSON.
- Test: `tests/read-spill-brick.test.mjs` reproduces the exact move (Read the spill with offset/limit).

**b) The next message hung forever after `recall_surfaced`.** Fixed in `1d50bdb`.
- What happened in "did u get bricked": `turn_started`, `recall_surfaced`, then nothing. No reply, no error, no `turn_ended`.
- Cause: between recall and the model call, the daemon awaits optional context with **no deadline**: agent runtime, memory recall and episodic write, estate, cross-surface digest, repo map, git delta, Forge note.
  - Stop in that window only records a pending cancel.
  - The stuck-turn watchdog is armed after this block.
  - So one await that never settles wedges the chat, and every message after it queues behind.
  - An earlier chat in the same log (`sess_9615497c`) died the same way: every turn after a Stop had to be Stopped too.
- Fix: `boundedTurnPrep` races that block against `ARES_TURN_PREP_TIMEOUT_MS` (default 20 s) and the owner's Stop.
  - On timeout the reply goes ahead without the context, and the owner sees one line saying so.
  - Stop settles the turn immediately.
- Test: `tests/daemon-turn-prep-bounded.test.mjs` drives the real daemon with a preparation step that never settles.
  - With the fix neutralised, the daemon wedges and the test times out. I ran this to confirm the test catches it.
  - With the fix, Stop settles in well under the deadline and the next message gets a reply.

**c) Related hardening.** `7a9bdf6`
- The Claude OAuth token refresh runs at the top of every stream. It had no timeout and no single-flight guard.
- Now there is one exchange per refresh token, capped at 15 s (`ARES_ANTHROPIC_REFRESH_TIMEOUT_MS`).
- This also stops concurrent refreshes from presenting a rotated token and signing the owner out mid-task.

**Checked and ruled out** from the log and code (subagent audit plus my own read):
- After the Stop there was no orphan or partial assistant message, and no tool_use/tool_result pairing break.
- The claimed input was cancelled with its generation (the startup-recovery fix is present).
- The run lease was released.
- Compaction is bounded (30 s fallback).
- The blind-image guard is not involved: no images in the turn.

**What I couldn't prove:** the log has no timestamps, so I can't say *which* preparation await hung on the Windows box. The fix bounds all of them. If it happens again, the daemon now logs `turn prep: <input> preparation exceeded …ms` to stderr. That line plus the owner-visible notice will show it was this path.

## 2. Leftover: forge-native-view canvas test

**Not a code or test bug. No change made.**
- Here it passes 8/8 with Chromium present.
- With a clean HOME (as CI runs it) it is 6 pass and 2 skip (no Chromium).
- The old failure was local-only: the owner's own `ui.json` has `dangerousBypass` set. The previous session's notes say so.
- The owner says the Forge works, so I stopped there.

## 3. Roadmap move 1 — "Zero-surprise tools"

| Item | Status | Commit |
| --- | --- | --- |
| Edit auto-read when the read-stamp is missing | **Already shipped before tonight**: `ARES_EDIT_AUTO_READ`, `autoReadForMutation`, plus tests. Stamps are deliberately cleared on compaction, and auto-read covers the missing stamp, so "read before editing" no longer errors. | — |
| Glob separator normalization | Done. Backslashes become `/`. An absolute pattern splits into root + relative pattern. Only a blank pattern is refused. | `e389960` |
| PowerShell spill-to-.ps1 / parse error with line | Done (logic only, see "needs the owner"). Multi-line or `"`-bearing commands go as `-EncodedCommand`. Over about 11k chars they go to a BOM'd `.ps1` run with `-File`. `At line:N char:M` is quoted back with the offending line. `ARES_PS_ENCODED=0` reverts. | `47e7540` |
| PowerShell auto-background on timeout | **Skipped.** It needs a live foreground child adopted into `ShellRegistry`, which I can't exercise without Windows. | — |
| Browser kill-switch state exposed | Done. The HALT error now says when and why it was engaged, that it is the owner's switch, not to retry, and how to release it (`ares operator resume`). | `d25777d` |
| Browser kill-switch reset per turn | **Deliberately not done.** It is the owner's durable halt, and only the owner should release it. | — |
| One Browser health probe per session | **Not needed now.** With no hidden browser, every unavailable path already refuses instantly. The 190/190 July failures were the old bridge. | — |
| RemotePC `timeout_ms` clamp | Done. Any value is accepted and clamped to 1–120 s. Values of 120 or less are read as seconds. | `3da7de2` |
| RemotePC op ids | **Not needed at tool level.** Every request already carries a `reqId` and the tool has no outer watchdog, so nothing retries. Connector-side dedupe would need a connector protocol bump. | — |
| Write creates the missing workspace dir | Done. Only the session's own workspace is created; a missing external project root still fails. | `4ebbdf5` |
| 429 → provider failover | Done. On a 429 with Retry-After over 5 s, the engine asks the daemon whether the existing failover ladder would find a backup. If yes, it ends the attempt at once so the ladder moves the turn. Single-provider setups and the Ares Gateway keep backing off. `ARES_RATE_LIMIT_FAILOVER=0` disables it. | `0eec602` |
| Cache prefix frozen behind one breakpoint | **Already in place**: tools and system breakpoints, with memory and identity riding as message-level reminders. Last session measured 87–99 % cache hits. No change. | — |

## 4. Roadmap move 2 (pure-code items)

- Self-context budget is now 5 % of the model window, never under 12k (it was a flat 3,500). `e6dbd2e`
- Curated memory (`MEMORY.md`) is pinned and never dropped. A greeting still never hauls in the raw daily logs. `e6dbd2e`
- The "no candidates" light-dream ticks are gone: no DREAMS.md line and no dream-phase events when nothing was staged. `08d771f`
- New env knobs are documented in `ares help`. `825ebe5`
- Prompt budget: the coding catalog was 14,183 of 14,200 with a clean HOME (17 spare, below the 20 the release rule asks for). I trimmed four words, so it is now **14,163 (37 spare)**. `a8a2377`

## 5. Test results

**Full gate: 1 failure, and it is not from tonight's changes.** (An earlier version of this report said the gate was green with 3,881 pass. That was wrong: I wrote it before the gate had finished, and the numbers did not come from the log. These are the real results from `gate.log`.)
- Command: `node scripts/test-gate.mjs`, with HOME/USERPROFILE/APPDATA/LOCALAPPDATA pointed at an empty temp dir (as CI does), after `pnpm check` and `pnpm build`.
- First pass: **3,988 tests, 3,945 pass, 1 fail, 0 cancelled, 42 skipped.**
- The failure is `tests/phone-terminal.test.mjs`, test "exit frame carries the shell's exit code…". Its command-mode terminal reports exit 0 instead of 3. The gate reran it alone and it failed again, so the gate exits 1.
- It is **pre-existing**:
  - The same test fails identically on an untouched `36e3ac4` (v0.61.2) checkout built on this box with the same empty HOME.
  - It passes 23/23 with the normal HOME.
  - None of tonight's commits touch `phoneTerminal.ts` or `remoteAgentServer.ts`.
  - It depends on tmux, which this box has; the test skips without it.
- I did not fix it. It is outside tonight's scope and needs a look at how the tmux shell behaves under an empty HOME. Logged for the owner.
- The prompt-budget trim (`a8a2377`) was rebuilt while the gate was running. I re-ran all prompt and system-prompt tests afterwards with a clean HOME: 21/21 pass.
- New tests added tonight: `read-spill-brick`, `daemon-turn-prep-bounded`, `powershell-delivery`, `remote-pc-timeout-clamp`, `rate-limit-failover`, `browser-halted-message`. New cases also went into `tools-hardening`, `gauntlet-edgecases-2`, `v12-anthropic-oauth`, `v5-effects-rails`, `v27-context-wiring` and `v4-lifecycle`.

## 6. Needs the owner

- **PowerShell on Windows.** The new delivery is unit-tested only; this box has no PowerShell.
  - Please run one multi-line command and one with double quotes through the PowerShell tool on both 5.1 and pwsh 7.
  - One thing to watch: 5.1 is known to sometimes wrap stderr as `#< CLIXML` when given `-EncodedCommand`.
  - If anything looks off, `ARES_PS_ENCODED=0` restores the old behaviour with no rebuild.
- **The bricked-chat fix (b) is proven in the daemon test harness, not on the desktop.** If a chat ever sits at "thinking" with no reply again:
  - After 20 s it should now say "Memory and workspace context took over 20s to gather…" and answer anyway.
  - Stop should work immediately.
- **Pre-existing gate failure.** `phone-terminal.test.mjs` command-mode exit code fails with an empty HOME on this box (see §5). It fails on v0.61.2 too, so I don't think it's mine, but the release gate will be red here until it's fixed or understood.
- **Not deployed anywhere.** This branch is not merged and the garrison was not rebuilt or restarted; it still runs `~/Ares`.
- **Native Forge view for websites** was not touched (per brief).
- **Left for the owner:** PowerShell auto-background, and connector-side RemotePC op ids.
