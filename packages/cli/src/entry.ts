#!/usr/bin/env node
// crix — v2 CLI entrypoint.
//
// Commands (M1 surface):
//   crix run --goal "<text>" [--provider openai|ollama] [--model X]
//   crix login                                      OAuth device-code
//   crix doctor                                     auth + ollama health
//   crix help
//
// All commands emit NDJSON for `run`; everything else writes human text.
// The Ink TUI ships in M2.

import {
  Session,
  MockEchoProvider,
  OpenAIResponsesProvider,
  OllamaCloudPool,
  DEFAULT_OLLAMA_SLOTS,
  authStatus,
  deviceCodeLogin,
  loadAuthToken,
  type EngineTool,
  type ToolCallContext,
  type Provider,
} from "@crix/core";
import { DEFAULT_TOOLS, adaptToolForEngine, type RichToolContext, type FileReadStamp } from "@crix/tools";

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
      "Commands:",
      "  crix run --goal \"<text>\" [--provider openai|ollama|mock] [--model X]",
      "                              Run one turn, streaming TurnEvents as NDJSON.",
      "  crix login                  ChatGPT OAuth device-code flow.",
      "  crix doctor                 Show provider auth + Ollama Cloud health.",
      "  crix help                   Print this help.",
      "",
      "Env vars:",
      "  OPENAI_API_KEY              Use OpenAI Platform Responses API.",
      "  CRIX_OPENAI_OAUTH_TOKEN     Use a ChatGPT OAuth access token directly.",
      "  CRIX_REASONER, CRIX_APPLY, CRIX_SUMMARIZE",
      "                              Override Ollama Cloud slot models.",
      "  CRIX_HOME                   Override auth/config dir (default ~/.crix).",
      "",
      "The Ink TUI lands in M2. For now `crix run` is one-shot NDJSON.",
      "",
    ].join("\n"),
  );
}

// ─── provider selection ────────────────────────────────────────────────

interface ProviderSelection {
  provider: Provider;
  model: string;
  source: string;
}

async function selectProvider(flags: Map<string, string>): Promise<ProviderSelection> {
  const explicit = flags.get("provider");
  const requestedModel = flags.get("model");

  if (explicit === "mock") {
    return {
      provider: new MockEchoProvider(),
      model: requestedModel ?? "mock-echo",
      source: "explicit:mock",
    };
  }

  if (explicit === "openai" || (!explicit && (await loadAuthToken()))) {
    const provider = new OpenAIResponsesProvider();
    return {
      provider,
      model: requestedModel ?? process.env.CRIX_OPENAI_MODEL ?? "gpt-4o",
      source: explicit ? "explicit:openai" : "auto:openai",
    };
  }

  if (explicit === "ollama" || !explicit) {
    const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS });
    return {
      provider: pool.provider("reasoner"),
      model: requestedModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model,
      source: explicit ? "explicit:ollama" : "auto:ollama",
    };
  }

  throw new Error(`unknown provider: ${explicit}`);
}

// ─── tool wiring ───────────────────────────────────────────────────────

function buildEngineTools(): EngineTool[] {
  // Shared per-session state populated by the tool harness.
  const fileReadStamps = new Map<string, FileReadStamp>();
  return DEFAULT_TOOLS.map((tool) => {
    const adapted = adaptToolForEngine(tool, (base: ToolCallContext): RichToolContext => ({
      ...base,
      permissionMode: "workspace-write",
      fileReadStamps,
    }));
    return adapted as EngineTool;
  });
}

// ─── commands ──────────────────────────────────────────────────────────

async function runCommand(args: ParsedArgs): Promise<number> {
  const goal = args.flags.get("goal");
  if (!goal) {
    process.stderr.write("error: --goal is required\n");
    return 2;
  }

  let selection: ProviderSelection;
  try {
    selection = await selectProvider(args.flags);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const session = new Session({
    workspace: process.cwd(),
    provider: selection.provider,
    model: selection.model,
    systemPrompt: buildSystemPrompt(),
    tools: buildEngineTools(),
  });

  process.stderr.write(
    `crix: provider=${selection.provider.name} model=${selection.model} source=${selection.source} session=${session.meta.id}\n`,
  );

  for await (const event of session.send(goal)) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  return 0;
}

async function loginCommand(): Promise<number> {
  process.stderr.write("crix: starting ChatGPT OAuth device-code flow…\n");
  try {
    const file = await deviceCodeLogin({
      onDeviceCode: (code) => {
        process.stdout.write(
          [
            "",
            "  Open this URL in your browser:",
            `    ${code.verificationUrl}`,
            "",
            `  Enter the code: ${code.userCode}`,
            "",
            "  Waiting for authorization…",
            "",
          ].join("\n"),
        );
      },
    });
    process.stdout.write(`Logged in${file.profile.email ? ` as ${file.profile.email}` : ""}.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: login failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function doctorCommand(): Promise<number> {
  process.stdout.write("crix doctor\n\n");

  // Auth
  const auth = await authStatus();
  process.stdout.write("OpenAI auth:\n");
  process.stdout.write(`  configured: ${auth.configured ? "yes" : "no"}\n`);
  process.stdout.write(`  mode:       ${auth.mode}\n`);
  process.stdout.write(`  source:     ${auth.source}\n`);
  if (auth.email) process.stdout.write(`  email:      ${auth.email}\n`);
  if (auth.tokenPreview) process.stdout.write(`  token:      ${auth.tokenPreview}\n`);
  process.stdout.write(`  authPath:   ${auth.authPath}\n`);
  process.stdout.write("\n");

  // Ollama Cloud
  const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS });
  const health = await pool.health();
  process.stdout.write("Ollama Cloud:\n");
  process.stdout.write(`  host:       ${health.host}\n`);
  process.stdout.write(`  reachable:  ${health.reachable ? "yes" : "no"}\n`);
  process.stdout.write(`  available:  ${health.availableModels.length} model(s)\n`);
  for (const slot of health.slots) {
    process.stdout.write(
      `  ${slot.name.padEnd(10)} ${slot.model.padEnd(35)} ${slot.present ? "[present]" : "[missing]"}\n`,
    );
  }
  process.stdout.write("\n");
  process.stdout.write(`crix: ${auth.configured || health.reachable ? "ready" : "no providers configured"}\n`);
  return 0;
}

// ─── system prompt ─────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    "You are Crix, a streaming coding-agent harness running in the terminal.",
    "",
    "Operating principles:",
    "- Use tools to act; do not describe actions you haven't taken.",
    "- Read files before editing them. The Edit tool will refuse otherwise.",
    "- Prefer narrow, complete changes over broad rewrites.",
    "- Match the codebase's existing style; check neighbors before adding new patterns.",
    "- Verify your work with tests/typecheck/lint when changes warrant it.",
    "- Be concise. The user sees streamed text in a terminal.",
    "",
    "When you finish, report what you changed (1-3 sentences) and any blockers.",
  ].join("\n");
}

// ─── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "run":
      process.exit(await runCommand(args));
      return;
    case "login":
      process.exit(await loginCommand());
      return;
    case "doctor":
      process.exit(await doctorCommand());
      return;
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
