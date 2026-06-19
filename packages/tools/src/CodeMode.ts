// CodeMode — run small JavaScript programs against workspace helpers.
//
// This is intentionally not a general shell. It is a token-saving batch
// surface for read-heavy repo operations: map files, grep, parse JSON,
// and return one compact result.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { buildTool, resolveWorkspacePath, workspaceRoot } from "./_shared.js";

const inputSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .describe(
        "Async JavaScript body. Available: ares.workspace, ares.read(path), ares.write(path,text), ares.glob(pattern), ares.grep(pattern, opts), ares.json(path). Return a JSON-serializable value.",
      ),
    timeout_ms: z.number().int().positive().max(60_000).default(10_000),
    allow_writes: z.boolean().default(false).describe("When true, ares.write is enabled and touched files are returned."),
  })
  .strict();

export interface CodeModeOutput {
  result: unknown;
  logs: string[];
  touchedFiles: string[];
}

export const CodeModeTool = buildTool({
  name: "CodeMode",
  description:
    "Execute a tiny async JavaScript batch program over workspace helper functions. Use when 5+ repetitive Read/Glob/Grep calls would waste context. Keep code short and return a compact JSON result.",
  safety: "workspace-write",
  concurrency: "exclusive",
  // Batches can legitimately churn many files — generous cap, not the 60s default.
  watchdogTimeoutMs: 180_000,
  inputZod: inputSchema,
  activityDescription: () => "Running CodeMode batch",

  async call(i, ctx): Promise<{ output: CodeModeOutput; touchedFiles?: string[]; display: string }> {
    const root = workspaceRoot(ctx);
    const touched = new Set<string>();
    const logs: string[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), i.timeout_ms);

    const helpers = {
      workspace: root,
      async read(filePath: string) {
        const resolved = await resolveWorkspacePath(ctx, filePath, "file_path", "read");
        return await fs.readFile(resolved, "utf8");
      },
      async write(filePath: string, content: string) {
        if (!i.allow_writes) throw new Error("ares.write requires allow_writes=true");
        const resolved = await resolveWorkspacePath(ctx, filePath, "file_path", "write");
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, String(content), "utf8");
        touched.add(resolved);
        return resolved;
      },
      async json(filePath: string) {
        return JSON.parse(await helpers.read(filePath));
      },
      async glob(pattern: string) {
        const re = globToRegExp(pattern);
        const files: string[] = [];
        await walk(root, async (file) => {
          const rel = path.relative(root, file).replace(/\\/g, "/");
          if (re.test(rel)) files.push(file);
        });
        return files;
      },
      async grep(pattern: string, opts?: { files?: string[]; flags?: string; max?: number }) {
        const flags = opts?.flags ?? "g";
        const re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
        const files = opts?.files ?? (await helpers.glob("**/*"));
        const hits: Array<{ path: string; line: number; text: string }> = [];
        for (const file of files) {
          const text = await fs.readFile(file, "utf8").catch(() => "");
          const lines = text.split(/\r?\n/);
          for (let idx = 0; idx < lines.length; idx++) {
            re.lastIndex = 0;
            if (re.test(lines[idx])) hits.push({ path: file, line: idx + 1, text: lines[idx] });
            if (hits.length >= (opts?.max ?? 200)) return hits;
          }
        }
        return hits;
      },
      signal: controller.signal,
    };

    const sandbox = vm.createContext({
      ares: helpers,
      console: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      },
      setTimeout,
      clearTimeout,
    });

    try {
      const script = new vm.Script(`(async () => {\n${i.code}\n})()`);
      const promise = script.runInContext(sandbox, { timeout: Math.min(i.timeout_ms, 1000) }) as Promise<unknown>;
      const result = await Promise.race([
        promise,
        new Promise((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error(`CodeMode timed out after ${i.timeout_ms}ms`))),
        ),
      ]);
      const touchedFiles = [...touched];
      return {
        output: { result, logs, touchedFiles },
        touchedFiles: touchedFiles.length > 0 ? touchedFiles : undefined,
        display: `CodeMode returned ${brief(result)}${touchedFiles.length ? `, touched ${touchedFiles.length} file(s)` : ""}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
});

const IGNORED_DIRS = new Set(["node_modules", ".git", ".ares", "dist", "build", "target", ".next", "coverage"]);

async function walk(dir: string, visit: (file: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(full, visit);
    } else if (entry.isFile()) {
      await visit(full);
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i++;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(out + "$");
}

function brief(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return "object";
  return JSON.stringify(value)?.slice(0, 60) ?? String(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
