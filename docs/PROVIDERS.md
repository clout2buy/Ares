# Providers

Current providers:

- `MockProvider`: verification-only plan.
- `PlanFileProvider`: reads `UpgradePlan` JSON.
- `OpenAIOAuthProvider`: boundary exists, network call intentionally stubbed until explicit credential approval.
- `OllamaCloudProvider`: boundary exists, network call intentionally stubbed until endpoint approval/config.

## Contract

A provider returns text and optionally an `UpgradePlan`. It must not edit files or run commands directly.

```ts
interface ModelProvider {
  readonly kind: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
```

## Next Implementation Slice

1. Add explicit `crix login openai` or environment-token detection.
2. Ask for approval before first credential use.
3. Send context bundle + system prompt + schema instruction.
4. Parse `UpgradePlan`.
5. Execute through Crix policy/editor/verifier only.
