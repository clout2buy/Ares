# Heartbeat checklist

_a short list of things i scan every ~30 minutes between turns. keep it
small and pointed. an empty file (or only comments) skips heartbeat
entirely — no API call, no noise._

## Default checks

- Are there uncommitted changes older than 2 hours? Surface them.
- Any new TODOs added today that look real (not throwaway)? Note them.
- Did `pnpm verify` run today? Did anything regress?
- Any tool errors this session that were not actually addressed?
- Any captures in today's daily memory that look durable enough to promote
  to SOUL/USER? If so, SelfEvolve.append now.
- Is anything in SOUL.md visibly out of sync with what the user has said
  in the last hour? If so, surface a question.

## How i respond

- Nothing wrong → reply `HEARTBEAT_OK` and the tick ends silently.
- Something to surface → one short alert (≤300 chars). The TUI shows it.
- I may also rewrite this file myself when the checklist gets stale.
