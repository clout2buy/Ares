# Self-Upgrade Loop

The first goal for Crix is to upgrade itself safely.

## Simple Commands

```powershell
cd D:\Crix
.\crix.bat dry
.\crix.bat apply
.\crix.bat inspect
```

Use `dry` before `apply`.

## Required Flow

1. Inspect the repository.
2. Build a small `UpgradePlan` with scoped edits.
3. Run Crix in `workspace-write` mode.
4. Checkpoint each touched file.
5. Apply edits.
6. Run focused verification.
7. Write `proof.json`.
8. Resume from `.crix/sessions/<session-id>/events.jsonl` if interrupted.
9. Roll back from `.crix/sessions/<session-id>/checkpoints/<step-id>/manifest.json` when needed.

Rollback command:

```powershell
.\\crix.bat rollback --checkpoint .crix/sessions/<session-id>/checkpoints/<step-id>
```

## Model Integration Contract

A future Codex/OpenAI provider should only produce this JSON shape:

```json
{
  "goal": "improve Crix",
  "summary": "Small scoped change",
  "steps": [
    {
      "id": "write-doc",
      "title": "write doc",
      "safety": "workspace-write",
      "type": "write_file",
      "path": "docs/example.md",
      "content": "# Example\n"
    }
  ],
  "verification": [
    {
      "program": "pnpm",`r`n      "args": ["test"],
      "timeout_ms": 120000
    }
  ]
}
```

The provider should not execute tools directly. Crix executes the plan through its own policy, editor, verifier, event store, and proof writer.

## Status Values

- `passed`: all applied steps and verification passed.
- `failed`: verification failed.
- `blocked`: policy denied a step or a step failed to apply.
- `dry-run`: no state-changing step was executed.

