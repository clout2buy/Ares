# Oruna legacy core: what to do with it until DevoEngine replaces it

The current Oruna (`core/`, 949 lines) is being retired in favour of
DevoEngine (see `DEVOENGINE.md` §22). It is still running on doingbox as
`oruna-serve` and the daily pulse, so two things apply in the meantime.

## 1. Fix today: `edit_file` destroys files longer than 20,000 characters

`files.py` `read_file` returns `text[:20000] + "\n[cut]"`. `edit_file` calls
it, replaces inside the truncated string, and `write_file`s the result back.
Reproduced against the uploaded code: a 33,000-byte file became 20,006 bytes
ending in the literal line `[cut]` after one `edit_file`. The test uses a
5-byte file and cannot see it.

Minimal fix: read the whole file in `edit_file` (a private `_read` that does
not slice), keep the slice only in `read_file`'s return value, and add a
regression test with a 30,000-character file. Fifteen lines. Deploy with
the existing `deploy/doingbox.sh`.

## 2. Do not invest further

Everything else the old loop lacks (process-group shell kill, durable jobs,
retries, demotion instead of `trim`, read stamps, acceptance on task cards,
guards, prompt caching, a wait verb) is delivered by the engine. The parts of
the old code that are worth keeping are not engine code and are mapped to
engine seams in `DEVOENGINE.md` §22.1: laws, STOP, Oricle door, task cards,
skills with tests, pulse, the serve door, the terminal greeting.
