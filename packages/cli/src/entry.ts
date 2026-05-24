#!/usr/bin/env node
// crix — the v2 CLI entrypoint.
//
// M0 surface: `crix run --goal "<text>"` streams TurnEvents as NDJSON
// using the mock provider. Real providers and the Ink TUI ship in M1/M2.

import { QueryEngine, MockEchoProvider, type EngineTool } from "@crix/core";

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return { command, flags };
}

function printHelp(): void {
  process.stdout.write(
    [
      "crix v0.3.0-alpha.1 — streaming coding-agent harness",
      "",
      "Usage:",
      "  crix run --goal \"<text>\"          Run one turn with the mock provider (M0).",
      "  crix help                           Print this help.",
      "",
      "Future milestones add real providers (OpenAI + Ollama Cloud), tools,",
      "Ink TUI, permissions, hooks, skills, MCP, DAG sessions.",
      "",
    ].join("\n"),
  );
}

async function runCommand(args: ParsedArgs): Promise<number> {
  const goal = args.flags.get("goal");
  if (!goal) {
    process.stderr.write("error: --goal is required\n");
    return 2;
  }

  const tools: EngineTool[] = [];
  const sessionId = `sess_${Date.now().toString(36)}`;

  const engine = new QueryEngine(
    {
      provider: new MockEchoProvider(),
      model: "mock-echo",
      systemPrompt: "You are Crix, a streaming coding-agent harness.",
      tools,
      workspace: process.cwd(),
    },
    sessionId,
  );

  engine.appendUserMessage(goal);

  for await (const event of engine.streamTurn()) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }

  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "run": {
      const code = await runCommand(args);
      process.exit(code);
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case "":
      printHelp();
      return;
    default:
      process.stderr.write(`error: unknown command "${args.command}". Run \`crix help\`.\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
