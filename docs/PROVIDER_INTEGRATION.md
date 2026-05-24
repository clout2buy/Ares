# Provider Integration

Crix currently supports two providers:

- `MockProvider`: creates a verification-only plan.
- `PlanFileProvider`: reads an `UpgradePlan` from JSON.

The model-powered provider should implement `ModelProvider` in `crix-core` or a future `crix-provider-openai` crate.

## Rules For Model Providers

- Return structured `UpgradePlan` values only.
- Never write files directly.
- Never run shell commands directly.
- Never use credentials unless the user explicitly approves that exact run.
- Prefer small plans that can be verified quickly.
- Include verification commands in every non-trivial plan.

## Recommended First OpenAI Provider

- Read model/account configuration from explicit CLI flags or local config.
- Support a dry-run mode that prints the plan before execution.
- Include repository context from `git status`, `package.json`, and selected files.
- Use the plan JSON schema as the only output contract.

