# Oruna: what to fix, what to transplant, where

Companion to `DEVOENGINE.md` §22. Oruna is 949 lines of stdlib Python: one
loop (`main.turn`), an OpenAI-compatible chat endpoint, Oricle for memory and
task cards, self-written skills, five laws and a STOP file. That shape is
right and should not change. This document says, file and line, what breaks
it on long work and the smallest change that fixes each, in priority order.
Everything here keeps Oruna under about 1,250 lines and adds no dependency.

Line numbers refer to the `core/` tree as uploaded on 2026-11-08.

---

## 0. Fix before anything else: `edit_file` truncates files over 20,000 chars

`files.py:6-13` `read_file` returns `text[:LIMIT] + "\n[cut]"` for anything
over 20,000 characters. `files.py:17-25` `edit_file` calls `read_file`, does
the replacement on that **truncated** string, and `write_file`s it back.

Any `edit_file` on a file longer than 20,000 characters silently rewrites the
file as its first 20,000 characters plus the literal line `[cut]`. The rest
of the file is gone. The test at `tests/test_oruna.py:70-76` uses a 5-byte
file, so it cannot see this.

Fix (`files.py`): split reading from display.

```python
def _read(path):                       # the whole file, for tools that write
    with open(path, encoding="utf-8") as f:
        return f.read()

def read_file(path):                   # what the model sees: a slice, and say so
    try:
        text = _read(path)
    except (OSError, UnicodeDecodeError) as e:
        return f"error: {e}"
    STAMPS[path] = _sha(text)
    return text[:LIMIT] + (f"\n[cut: {len(text)} chars total; this is the first {LIMIT}]" if len(text) > LIMIT else "")

def edit_file(path, old, new):
    try:
        text = _read(path)             # never the slice
    except (OSError, UnicodeDecodeError) as e:
        return f"error: {e}"
    ...
```

Add a regression test with a 30,000-character file. This is a day-zero fix,
not a transplant.

---

## 1. What Oruna gets right (keep, do not generalise)

- **Laws as code with a pinned hash** (`laws.py:9-14`), the STOP file
  (`laws.py:22-24`), and the unattended guard (`laws.py:33-43`). This is the
  policy layer DevoEngine §12 describes, in 47 lines.
- **Skills with a mandatory test before acceptance** (`skills.py:56-71`), one
  broken skill never taking down the others (`skills.py:40-54`).
- **Memory on both ends of the turn**: pack before, attest after
  (`main.py:50-51, 68-69`), with the owner's next word as the outcome signal
  (`main.py:48-49`). That is DevoEngine's "status from evidence" idea applied
  to memory salience, and it is good.
- **Task cards** that the rules tell the model to advance (`prompt.py:11`,
  `oricle.py:113-122`). Half of transplant T1 already exists.
- **Episodes on close** so the next session starts mid-life (`main.py:85-94`).
- **Errors as text, never exceptions** (`tools.py:55-67`, `oricle.py:67-75`).
- **Interrupt budget** for unsolicited notes (`serve.py:15, 23-32`).

---

## 2. The transplants, in order of value per line

### T1. Acceptance on task cards (about 30 lines)

**Problem.** `oricle.task` (`oricle.py:113-122`) accepts `status="done"` on
the model's say-so. Under pressure a model closes cards it did not finish.

**Where.** `oricle.task` gains an optional `check` argument; `main.turn` gains
nothing. The gate lives in the tool, so it holds in all three doors.

```python
@_tool
def task(goal, next_action, id="", status="", check=""):
    """... check: a command that must exit 0 before status may become done (set it when you form the plan)."""
    if status == "done":
        card = _call("GET", f"task/{id}") if id else {}
        cmd = check or card.get("data", {}).get("check", "")
        if cmd:
            out = tools.run_shell(cmd)                 # bounded by run_shell's 60 s
            if not out.startswith("exit 0"):           # see T6: run_shell reports the exit code first
                _call("POST", "task", {"id": id, "status": "active",
                      "next_action": f"check failed: {out[-800:]}"})
                return f"task {id} is NOT done: check `{cmd}` failed\n{out[-800:]}"
    body = {"goal": goal, "next_action": next_action}
    ...
```

Add `check` to `tools.OPTIONAL["task"]` (`tools.py:36`). Record the check on
the card's `data` when first set so a later `done` without `check` still runs
it. Add one line to `prompt.RULES` line 11: "give the card a `check` command
when you plan; done means it passed."

Guard against weakening: a `check` may be set once and tightened, never
replaced by a shorter one in the same session (compare lengths and runner
name; refuse otherwise). Ten lines, and it closes the gaming hole DevoEngine
§4.3 describes.

### T2. Demote, do not trim (about 40 lines)

**Problem.** `main.trim` (`main.py:36-41`) deletes everything but the last 60
messages when the history passes 400,000 characters, leaving one line that
says it did. That is the worst of both worlds: lossy like a summary, and with
no summary. Also, 400k characters is around 100k tokens on code, so on a 128k
model the first trim often arrives after the provider has already rejected a
request (see T5).

**Where.** Replace `trim` with `demote`, called at the same site
(`main.py:61`). Oricle is already the store; `recall` is already the tool.

```python
def demote(keep=40, limit=240_000):
    """History past the limit is not thrown away: each old round goes to Oricle as a record the model can recall."""
    if sum(len(json.dumps(m)) for m in messages) < limit:
        return
    old, messages[1:-keep] = messages[1:-keep], []
    rounds, cur = [], []
    for m in old:                                       # a round = one assistant message + its tool results
        if m.get("role") == "assistant" and cur:
            rounds.append(cur); cur = []
        cur.append(m)
    if cur: rounds.append(cur)
    ids = []
    for i, r in enumerate(rounds):
        text = "\n".join(_flat(m) for m in r)[:6000]
        rid = oricle.commit_round(session["turns"], i, text)   # kind "round", tags ["oruna-round", session id]
        if rid: ids.append(rid)
    messages.insert(1, {"role": "user", "content":
        f"(earlier work was moved out of the window, not lost: {len(ids)} rounds are in memory as "
        f"{', '.join(ids[:6])}{'…' if len(ids) > 6 else ''}; recall(query) or recall(id) brings one back)"})
```

`oricle.commit_round` is a six-line wrapper over the existing `commit` route
with `kind: "round"`. `oricle.recall` already returns by query; add
`if query.startswith("rec_"): return the one record's full text` so an id
fetches a whole round. That is the entire knowledge store for a loop this
size. Nothing is forgotten; the model asks for what it needs.

Also set `keep` by rounds rather than messages so a round is never split
(the Ares adjacency incident: a tool result separated from its call bricks
the session on strict providers).

### T3. A wait verb (about 60 lines)

**Problem.** The only ways to pass time are `start_job` plus repeated
`read_job` polling inside one turn's 40-call budget, or the daily pulse.
Nothing can say "wake me when the build finishes" and stop spending calls.

**Where.** New tool `wait_for(kind, spec, minutes)` in `jobs.py` (it already
owns background processes), registered in `tools.BUILTIN`. It does not block
the turn; it ends it.

```python
WAITS = os.path.join(laws.HOME, "waits.jsonl")

def wait_for(kind, spec, minutes="60"):
    """End this turn now and wake when: kind=job (spec=job id exits), path (spec changes), timer (spec=minutes). The wake arrives as your next message."""
    laws.ensure_home()
    w = {"id": time.strftime("%H%M%S"), "kind": kind, "spec": spec, "until": time.time() + 60 * float(minutes),
         "mtime": os.path.getmtime(spec) if kind == "path" and os.path.exists(spec) else None}
    with open(WAITS, "a", encoding="utf-8") as f:
        f.write(json.dumps(w) + "\n")
    raise EndTurn(f"waiting on {kind} {spec} (up to {minutes} min)")   # tools.handle lets this one through

def due():
    """Waits whose condition holds; each is removed and returned once."""
    ...  # job: JOBS[spec].poll() is not None; path: mtime changed; timer: now >= until; anything past `until`: timed out
```

Wiring: `tools.handle` (`tools.py:55-67`) catches `EndTurn`, appends the tool
message, and sets a flag `turn` checks after each batch to break out of the
call loop and return the wait text as the reply. Then a waker:

- `--serve`: a daemon thread polls `jobs.due()` every 10 s and calls
  `turn(f"(wake) {kind} {spec}: {payload}", unattended=True)` under the same
  `serve.lock`.
- `--pulse` and `--once`: check `due()` at start and drain wakes first.
- terminal: check `due()` before each `theme.read()` and print the wake.

Zero tokens are spent while waiting. The job log tail or the changed path is
the payload. This also replaces the "do not poll" wish in `prompt.RULES`
with a verb the model can actually use.

### T4. Read stamps and the hash-drift re-read (about 30 lines)

**Problem.** `edit_file` requires exactly one match but has no idea whether
the model's `old` came from the current file. After T2 demotes the Read that
`old` was copied from, the model edits from memory. In Ares this was 46 of 49
post-compaction edit failures.

**Where.** `files.py`. Keep `STAMPS = {path: sha256}` updated by
`read_file`, `write_file` and `edit_file`. In `edit_file`, before matching:

```python
    cur = _sha(text)
    if STAMPS.get(path) != cur:                 # never read, or changed since: show the model the truth first
        hint = _around(text, old, lines=20)     # the best token-overlap region, numbered
        STAMPS[path] = cur
        if text.count(old) != 1:
            return f"error: file changed since you last read it (or was never read). Current text near your edit:\n{hint}"
```

If the match is still unique, proceed and say "note: file had changed since
your last read; edit applied against current bytes." That is Ares's
`ARES_EDIT_STALE_RETRY` behaviour in four lines, and `_around` is the
near-miss hint from `Edit.ts` reduced to a token-overlap window.

### T5. Provider resilience in `ask` (about 35 lines)

**Problem.** `main.ask` (`main.py:26-34`) is one `urlopen` with a 120 s
timeout. A 429, a 503, a reset connection or a context-length rejection ends
the turn and, in the terminal, pops the user's message (`main.py:122-124`).

**Where.** `ask` gets a small ladder and context-limit handling:

```python
RETRIABLE = {429, 500, 502, 503, 529}
def ask(tries=5):
    for n in range(tries):
        try:
            ...urlopen...
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code in RETRIABLE and n < tries - 1:
                time.sleep(min(20, 1.5 * 2 ** n)); continue
            if e.code == 400 and re.search(r"context|too long|maximum.*tokens|too many tokens", body, re.I):
                demote(keep=20, limit=0); continue      # make room and retry once with the same tail
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            if n < tries - 1: time.sleep(min(12, 0.8 * 2 ** n)); continue
            raise
```

Honour `Retry-After` when present (cap 60 s). Do not retry on other 400s or
on 401/403. That is the garrison's transient, capacity and network ladders
with one cap each.

### T6. Shell and jobs that cannot wedge or be lost (about 40 lines)

**Problems.**

- `tools.run_shell` (`tools.py:6-12`) uses `subprocess.run(shell=True,
  capture_output=True, timeout=60)`. On timeout Python kills the shell, then
  `communicate()` waits for the pipes to close. A grandchild that inherited
  the pipe (a server, `docker exec`, `tail -f`) keeps them open and the call
  never returns. This is the exact Ares incident of 2026-09-21.
- `jobs.JOBS` (`jobs.py:5`) is a dict of `Popen` objects. A restart of
  `--serve` or the pulse process forgets every job; `read_job` says
  "no job" while the log sits on disk. `stop_job` kills the shell, not the
  process tree.

**Fixes.**

```python
def run_shell(cmd, timeout=60):
    """Run a shell command. Output starts with 'exit N'. 60 s cap; use start_job for anything longer."""
    p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         start_new_session=True,                       # POSIX: its own process group
                         creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(p)                                                  # killpg / taskkill /T /F
        out, _ = p.communicate(timeout=5)                              # pipes close once the group is dead
        return f"exit timeout\n{out.decode('utf-8', 'replace')[-20000:]}\nerror: timed out after {timeout}s; use start_job"
    return f"exit {p.returncode}\n" + (out.decode("utf-8", "replace")[-20000:] or "(no output)")
```

Jobs: write `{"id", "pid", "cmd", "log"}` to `~/.oruna/jobs/<id>.json` at
start; `read_job` and `stop_job` fall back to the file and `os.kill(pid, 0)`
when the id is not in `JOBS`; `stop_job` kills the group. Start jobs with
the same `start_new_session`/creation flags. On startup, list jobs whose pid
is gone and whose log has no `exit` line as "orphaned" in the greeting.

The `exit N` prefix is what T1 keys on, and it gives the model the one fact
it most often guesses.

### T7. Two guards (about 25 lines)

**Problem.** `turn` has one terminator: `max_calls=40`. A model that repeats
the identical failing call burns all 40.

**Where.** In the call loop at `main.py:57-61`, keep two counters per turn:

- **Identical call**: `hash(name + json.dumps(args, sort_keys=True))`; the
  third identical call in a row is not executed; the tool message says
  "same call three times; change the input or the approach."
- **Failure streak**: a tool result starting with `error:` or `exit ` with a
  non-zero code, normalised (digits to `#`, 80 chars) and counted; at three
  in a row append one user message "STOP: this approach is dead; state the
  exact error and try a different one"; at six, end the turn with that as
  the reply.

Those are the two guards that caught the most in Ares telemetry. Skip the
rest.

### T8. Stop rewriting the system prompt every turn (about 10 lines)

**Problem.** `main.turn` puts the memory pack inside `messages[0]`
(`main.py:51`, `prompt.py:23-24`). The system message changes every turn, so
no provider can cache the prefix. On DeepSeek and OpenRouter-routed Anthropic
this is the difference between paying for the rules and laws once and paying
for them every call.

**Fix.** `prompt.system(unattended)` returns rules, laws and the static facts
only; `turn` appends the pack to the user message:

```python
messages.append({"role": "user", "content": (f"# Memory for this ask\n{memory}\n\n" if memory else "") + text})
```

`attest` still works: it matches ids against `pack_text`, not against the
system message. The date in `facts` should move to the user turn too, or the
prefix breaks at midnight.

---

## 3. What not to transplant

- The event-sourced kernel, projections and snapshots. Oruna's durability is
  Oricle plus files; that is enough for one agent.
- The work graph, scheduler and parallel workers. Task cards with `check`
  cover the honesty problem; parallelism is not Oruna's job.
- Model lanes, the context compiler's ranking, the judge. Oricle's pack is
  the compiler; `recall` by id is the escape hatch.
- The full tool belt. Oruna's six tools plus skills are the point.
- The gateway protocol. `serve.py` is right-sized.

If Oruna ever needs any of those, that is the moment to embed DevoEngine
instead of growing Oruna.

---

## 4. Order and cost

| # | Change | Files | Lines | Why first |
|---|---|---|---|---|
| 0 | `edit_file` truncation fix + test | `files.py`, `tests/` | 15 | data loss today |
| T6 | process-group shell, durable jobs, `exit N` prefix | `tools.py`, `jobs.py` | 40 | wedges and lost jobs; T1 depends on the prefix |
| T8 | memory pack on the user turn | `main.py`, `prompt.py` | 10 | halves token cost immediately |
| T5 | retry ladder, context-limit demote | `main.py` | 35 | turns stop dying on 503s |
| T2 | demote to Oricle, recall by id | `main.py`, `oricle.py` | 40 | the long-horizon fix |
| T4 | read stamps, hash-drift re-read | `files.py` | 30 | makes T2 safe for edits |
| T1 | `check` on task cards | `oricle.py`, `tools.py`, `prompt.py` | 30 | done means proven |
| T7 | identical-call and failure-streak guards | `main.py` | 25 | stops the 40-call burn |
| T3 | `wait_for` and the waker | `jobs.py`, `tools.py`, `main.py`, `serve.py` | 60 | zero-token waiting |

About 285 lines in total. Each row is independently shippable and testable
with the existing `unittest` layout; T2, T3 and T5 need a fake endpoint,
which is a 20-line `http.server` in the test file.

After all nine, Oruna is still one loop, three doors, five laws, and about
1,250 lines. It will finish long coding tasks it currently cannot, and it
will no longer destroy files over 20,000 characters when it edits them.
