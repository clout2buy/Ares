# Terminal: an owner shell on the garrison box, from the phone

The Terminal tab gives the owner a real shell on the machine the garrison runs
on (doingbox/Rook), reachable through the same origin and tunnel as the rest of
the phone API. This document is the contract the phone app builds against and
the honest statement of what it exposes.

Server code: `packages/cli/src/phoneTerminal.ts` (wired in `remoteAgentServer.ts`
and `entry/garrisonCmd.ts`). Tests: `tests/phone-terminal.test.mjs`.

## What it is

* One **tmux** session per terminal id, on a dedicated socket (`tmux -L ares-term`).
  tmux owns the real PTY (controlling terminal, job control, Ctrl-C/Ctrl-Z,
  vim/htop/less, 256 colors, UTF-8, SIGWINCH on resize). No native Node
  dependency is added; `tmux` and `python3` are not required beyond the tmux
  binary (`/usr/bin/tmux`).
* The garrison reads the pane's **raw output** (tmux `pipe-pane` into a private
  FIFO) into a 1 MB ring per terminal, so the phone's own terminal emulator
  keeps native scrollback. Input goes back through `tmux send-keys -H` as exact
  bytes.
* Terminals **survive** the phone disconnecting, the app being backgrounded and
  (when the tmux server is detached from the unit, see "Restarts") a garrison
  restart. Re-attach replays what was missed.
* The shell runs as the garrison's service user (`mrdoing`) in `$HOME` as a
  login shell. **`sudo` is passwordless on this box, so this is effectively
  root.** That is what the owner asked for.

## Auth and access rules

All terminal routes require the **owner bearer** (the garrison gateway token,
`Authorization: Bearer <token>`), constant-time compared.

| Situation | Answer |
|---|---|
| no bearer | 401 `{error}` |
| bearer that is not the owner token (guest/tenant/read-only token) | 403 `{error:"owner only"}` (audited as denied) |
| `ARES_TERMINAL=0` | GET answers `{enabled:false,...}` (200); every other route 503 `{enabled:false}`; WebSocket gets an `error` frame and closes |
| owner has Ares paused (`/gateway/control/pause`) | create/attach/run answer 423 `{paused:true}`; live sockets are closed |
| plain http from a non-loopback address (LAN) | 403 `{error:"terminal requires the tunnel or TLS"}`; override with `ARES_TERMINAL_ALLOW_LAN=1` |
| tunnel (Cloudflare; loopback socket plus proxy headers) with `x-forwarded-proto: http` | refused the same way |

"Came through the tunnel/TLS terminator" is decided exactly like the control
API decides it: the socket is loopback (cloudflared dials the origin over
loopback) and proxy headers are present. A direct non-loopback connection is
never trusted just because it claims to be proxied.

## HTTP routes

All JSON, bodies <= 16 KB, all strings bounded.

```
GET    /gateway/terminal
  -> {enabled, max, reason?, sessions:[{id,title,createdAt,lastActiveAt,cols,rows,alive,attached,cwd?,exitCode?}]}

POST   /gateway/terminal/sessions   {title?, cols, rows, cwd?, command?}
  -> 200 {id}
     400 bad cols/rows/cwd/command   409 {error,max} at the limit
     429 {error,retryAfterSec} when creating too fast (10/min)
     423 paused   503 disabled/unavailable

POST   /gateway/terminal/sessions/<id>/rename   {title}   -> {ok:true,title}
DELETE /gateway/terminal/sessions/<id>                    -> {ok:true}
  kills the shell and its whole process tree, then the tmux session

POST   /gateway/terminal/run   {command, timeoutSec?<=120, cwd?}
  -> {exitCode, signal?, timedOut, stdout, stderr, truncated}
```

* `id` is `t-` plus 8 hex chars; anything else is a 404.
* `cols` 20..500 (default 80), `rows` 5..200 (default 24).
* `cwd` must be an absolute existing directory; default `$HOME`.
* `command`, if given, runs as `$SHELL -lc <command>` instead of an interactive
  shell; the terminal ends when it exits (the `exit` frame carries the code).
* `title` <= 64 chars, control characters stripped. If absent the app shows its
  own default (the server returns `"Terminal"` plus a counter).
* `run` is one-shot, no TTY, login shell, same scrubbed environment, 60 s
  default and 120 s hard timeout, at most 4 at once, stdout and stderr each
  truncated to 64 KB (head kept, `truncated:true`) and scrubbed for secret
  shapes. The whole process group is killed on timeout.

## WebSocket: `wss://<origin>/gateway/terminal/<id>?cols=&rows=&since=`

Same origin and tunnel as `/gateway`. Authentication mirrors the gateway
socket: the **first frame must be `hello`** within 10 s, carrying the owner
token. (The read-only gateway token is refused.)

```
client -> {"t":"hello","token":"<owner token>"}          (the key "type" is also accepted)
server -> {"t":"ready","id":"t-...","cols":80,"rows":24,"alive":true}
server -> {"t":"replay","d":"...","seq":N,"reset":true|false}
```

Query parameters:

* `cols`, `rows`: the phone's current grid; the terminal is resized to it.
* `since`: the last `seq` the client rendered. If the server still holds that
  point (ring buffer is 1 MB) and the gap is <= 256 KB, `replay` carries exactly
  the missed bytes and `reset:false` (just write `d`; do not clear). Otherwise
  (no `since`, too old, garrison restarted) `replay` is a **fresh snapshot** of
  the pane (scrollback up to the 256 KB bound, the visible screen, cursor
  position) with `reset:true`: call `term.reset()` first, then write `d`.

Frames after that (JSON text frames only):

```
client -> {"t":"in","d":"<utf8 text>"}          keystrokes / paste, <= 64 KB per frame
client -> {"t":"resize","cols":C,"rows":R}
client -> {"t":"ping"}
server -> {"t":"out","d":"<utf8 text>","seq":N}  coalesced to ~30 ms
server -> {"t":"replay","d":"...","seq":N,"reset":true}  resync after the server dropped output for a slow client
server -> {"t":"exit","code":N}                  shell ended (code null if killed); socket then closes
server -> {"t":"pong"}
server -> {"t":"error","message":"..."}          then close (4401 auth, 4403 forbidden, 4404 no such terminal, 4423 paused, 4503 disabled)
```

* `seq` is a byte offset in the terminal's output stream, always on a UTF-8
  character boundary (a character split across reads is held back until it is
  whole). Remember the latest `seq` and send it as `since` when you reconnect.
* **Keepalive**: the server sends a WebSocket ping every 20 s and drops a peer
  that has been silent 75 s; Cloudflare reaps a socket idle for 100 s. The app
  should also send `{"t":"ping"}` about every 25 s while foregrounded and
  reconnect with `since` after any close that was not `exit`.
* **Backpressure**: if the phone cannot keep up (socket buffer over 512 KB or
  more than 512 KB unsent) the server drops the unsent output, then sends a
  `replay` snapshot (`reset:true`) once the buffer drains. The engine is never
  blocked by a slow phone. Resyncs are rate limited to one per second.
* Several clients can attach to one terminal; the last `resize` wins.
* A terminal whose shell exited stays listed (`alive:false`, `exitCode`) with its
  final screen until deleted or reaped (10 minutes with nobody attached);
  attaching to it replays then sends `exit`.

## Environment of the shell

Built from an allowlist, never from the garrison's own environment: `PATH`,
`HOME`, `USER`, `LOGNAME`, `SHELL`, `TZ`, `XDG_RUNTIME_DIR`, plus
`TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=en_US.UTF-8`. Nothing
starting with `ARES_`, no APNS keys, no OAuth client secrets, no `EXPO_TOKEN`,
no provider keys. Extra names can be opted in with `ARES_TERMINAL_ENV_PASS=A,B`.
The tmux server and the pane run under `env -i`. This is hygiene, not a
boundary: the shell is the same Unix user as the garrison and can read
`~/.ares` (including the gateway token) and `sudo` to anything.

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `ARES_TERMINAL` | on | `0` is the kill switch (routes answer `enabled:false`, live terminals are killed at once) |
| `ARES_TERMINAL_MAX` | 6 | concurrent terminals |
| `ARES_TERMINAL_IDLE_HOURS` | 12 | a terminal with no client attached for this long is killed |
| `ARES_TERMINAL_SHELL` | `$SHELL` or `/bin/bash` | shell binary (must exist) |
| `ARES_TERMINAL_LOG` | off | `1` writes an output transcript per terminal to `~/.ares/terminal/logs/<id>.log`, mode 0600 (output only; typed secrets that are not echoed are not captured) |
| `ARES_TERMINAL_ALLOW_LAN` | off | `1` allows plain http from LAN addresses |
| `ARES_TERMINAL_SOCKET` | `ares-term` | tmux socket name (`-L`) |
| `ARES_TERMINAL_SERVER` | `auto` | `systemd` runs the tmux server as its own transient unit so it survives a garrison restart; `direct` keeps it in the garrison's cgroup; `auto` picks systemd only when the garrison runs under systemd with passwordless sudo |
| `ARES_TERMINAL_ENV_PASS` | none | extra env names the shell may inherit |

## Restarts

systemd's default `KillMode=control-group` kills every process in the
garrison's unit on `systemctl restart ares-garrison`, including a tmux server
started by it. With `ARES_TERMINAL_SERVER=auto` (default) on a systemd host with
passwordless sudo, the tmux server is started as the transient unit
`ares-term-<socket>.service` (via `sudo systemd-run`, as the same user), outside
the garrison's cgroup, so terminals survive a garrison restart and are re-adopted
(titles and creation times are stored as tmux session options). If that is not
possible it falls back to `direct`, and a garrison restart then ends the
terminals. Either way, the phone disconnecting or the app being backgrounded
never ends a terminal.

## Audit

`~/.ares/audit/<day>.jsonl` (also visible in `GET /gateway/audit?action=terminal.`):
`terminal.create`, `terminal.attach`, `terminal.detach` (duration, bytes in and
out, remote class), `terminal.kill`, `terminal.idle`, `terminal.run`,
`terminal.denied` (reason). The remote is recorded as a **class** only
(`loopback`, `tunnel`, `lan`). **Keystroke content is never audited.** For
`terminal.run` the command string is recorded after secret redaction, because a
one-shot command is an explicit action rather than a keystroke stream.

## The honest risk statement

* **A stolen owner token is a root-capable shell on the box**, from anywhere the
  tunnel is reachable. The terminal makes the gateway token as sensitive as an
  SSH key to a sudoer.
* Mitigations that exist: rotate the garrison token (delete
  `~/.ares/garrison/token`, restart: every phone must re-pair); `ARES_TERMINAL=0`
  plus restart removes the feature (and the owner kill switch
  `POST /gateway/control/stop` kills every terminal); pause closes live sockets
  and refuses new ones; every open/kill/denied is audited; transport is refused
  unless it came through the tunnel/TLS.
* A **Face ID (or passcode) gate in the app** only protects against someone using
  the unlocked phone. It does nothing against a stolen token, a backup, or
  malware that reads the app's keychain item.
* The environment scrub keeps Ares's own secrets out of the shell's *inherited
  environment*; it cannot stop a shell that can `cat ~/.ares/garrison/token`.
* Output you see, including anything you `cat`, passes through the tunnel
  provider (Cloudflare) in clear to them as it does for all the phone API.

## Kill switch and pause semantics

* `POST /gateway/control/stop` (the app's big red button) kills every terminal
  (tree and tmux session) and counts them as stopped jobs.
* `POST /gateway/control/pause` closes all live terminal sockets (the tmux
  sessions and their processes keep running, frozen only in the sense that nobody
  can reach them) and refuses create/attach/run until resume.
