# Agents

Built-in roles:

- `architect`: designs scoped implementation plans.
- `coder`: implements isolated code changes with tests.
- `reviewer`: finds correctness/safety/test gaps.
- `researcher`: maps code and gathers context.

Agents run through `AgentOrchestrator`, and visible local agent calls now execute through `TurnEngine` so they produce the same structured turn artifacts as tools. They share context but receive role-specific system prompts. Each run persists a transcript under `.crix/agents`, records scoped tools, can receive interventions, and propagates cancellation through provider `AbortSignal` where supported.

The goal is Claude/Codex-style natural agent use: Crix should decide when delegation helps, not require the user to micromanage every subtask.
