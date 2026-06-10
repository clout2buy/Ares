# Package Boundaries

This file documents the intended dependency direction for Ares packages. It is a guardrail for future cleanup and upgrade work.

## Intended Dependency Direction

```text
protocol
  -> core
    -> tools
      -> cli

agent, mind, operator, effects, and connectors are feature layers composed by cli.
```

The CLI may import every package because it is the composition root. Lower-level packages should avoid importing upward into feature or UI layers.

## Package Rules

- `@ares/protocol` contains shared types only. It should not import other Ares packages.
- `@ares/core` owns provider-neutral runtime behavior and may import `@ares/protocol`.
- `@ares/tools` may import `@ares/core` and `@ares/protocol` contracts.
- `@ares/agent` owns identity, skill, memory-adjacent persistence, and lifecycle behavior.
- `@ares/mind` owns cognition and living-memory mechanics. It should stay dependency-light.
- `@ares/operator` owns durable goals and acquisition. It should not need agent internals except where it deliberately writes agent skills.
- `@ares/effects` owns guarded side effects and should not depend on agent identity internals.
- `@ares/connectors` owns browser and external connectors. It may use effects for guarded execution.
- `@ares/cli` wires packages together and should remain the only broad importer.

## Known Boundary Debt

- `@ares/operator` imports `@ares/agent` for home/path and atomic-write helpers.
- `@ares/effects` imports `@ares/agent` for home/path and filesystem helpers.

These are accepted short-term dependencies. The next boundary cleanup should move shared home/path/write helpers into a neutral module before splitting larger runtime files.

## Dependency Hygiene

When adding a dependency:

1. Add it only to the package that imports it.
2. Prefer workspace package contracts over deep source imports.
3. Do not add dependencies for type shapes that can live in `@ares/protocol`.
4. Run `rg "@ares/<package>" packages/<target>/src` before removing workspace dependencies.

TypeScript project references should match actual source imports. If a package imports another `@ares/*` package, declare both the workspace dependency in `package.json` and the project reference in `tsconfig.json`. If source no longer imports the package, remove the manifest entry and reference together after `pnpm build` confirms the graph.
