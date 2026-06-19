// Deploy — ship a built site/app to the web (Vercel / Netlify / Cloudflare Pages).
//
// Real-world reach: the agent can research + build a landing page, then actually
// put it online. Uses the provider's official CLI via npx (no install step) with
// a token from the environment; parses the live URL out of the CLI output.
// Outward-facing, so it always asks the owner before publishing.

import { z } from "zod";
import { spawn } from "node:child_process";
import { getCredential } from "@ares/core";
import { buildTool, resolveWorkspacePath } from "./_shared.js";

const TOKEN_ENV: Record<string, string> = {
  vercel: "VERCEL_TOKEN",
  netlify: "NETLIFY_AUTH_TOKEN",
  cloudflare: "CLOUDFLARE_API_TOKEN",
};

const inputSchema = z
  .object({
    provider: z.enum(["vercel", "netlify", "cloudflare"]).default("vercel"),
    dir: z.string().optional().describe("Directory to deploy. Defaults to the workspace root."),
    prod: z.boolean().default(false).describe("Publish to production instead of a preview URL."),
    project: z.string().optional().describe("Project/site name (Cloudflare Pages / Netlify site)."),
  })
  .strict();

export interface DeployOutput {
  provider: string;
  url: string | null;
  production: boolean;
  log: string;
}

export const DeployTool = buildTool({
  name: "Deploy",
  description:
    "Deploy a built site or app to the web (Vercel, Netlify, or Cloudflare Pages) and return the live URL. Requires the provider's token in the environment: VERCEL_TOKEN, NETLIFY_AUTH_TOKEN, or CLOUDFLARE_API_TOKEN. Build the site first, then deploy its output directory. Outward-facing — confirm with the owner.",
  safety: "external-state",
  concurrency: "exclusive",
  // A real deploy runs for minutes — the 20s external-state default would sever
  // every one. Generous cap that still bounds a truly stuck provider CLI.
  watchdogTimeoutMs: 300_000,
  inputZod: inputSchema,
  activityDescription: (i) => `Deploying to ${i.provider}${i.prod ? " (prod)" : ""}`,

  async checkPermissions(i, ctx) {
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Deploy is disabled in plan mode." };
    return {
      kind: "ask",
      prompt: `Deploy ${i.dir ?? "the workspace"} to ${i.provider}${i.prod ? " (PRODUCTION)" : " (preview)"}?`,
      suggestion: "allow_once",
    };
  },

  async call(i, ctx): Promise<{ output: DeployOutput; display: string }> {
    const token = await getCredential(TOKEN_ENV[i.provider]);
    if (!token) {
      throw new Error(
        `DEPLOY_NO_TOKEN: no ${TOKEN_ENV[i.provider]} in the credential vault or environment for ${i.provider}. ` +
          `Ask the owner to add it (Settings → Keys or an env var).`,
      );
    }
    const dir = i.dir ? await resolveWorkspacePath(ctx, i.dir, "dir", "read") : ctx.workspace;
    const { program, args, env } = deployCommand(i, token, dir);
    const { stdout, stderr, code } = await run(program, args, dir, env, ctx.signal);
    const log = (stdout + "\n" + stderr).trim();
    if (code !== 0) {
      throw new Error(`Deploy failed (${i.provider}, exit ${code}): ${log.slice(-700)}`);
    }
    const url = extractUrl(log, i.provider);
    return {
      output: { provider: i.provider, url, production: i.prod, log: log.slice(-600) },
      display: url ? `Deployed → ${url}` : `Deployed to ${i.provider} (URL not parsed)`,
    };
  },
});

function deployCommand(
  i: z.infer<typeof inputSchema>,
  token: string,
  dir: string,
): { program: string; args: string[]; env: NodeJS.ProcessEnv } {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  switch (i.provider) {
    case "vercel":
      return {
        program: npx,
        args: ["-y", "vercel", "deploy", "--yes", "--token", token, ...(i.prod ? ["--prod"] : [])],
        env: { ...process.env },
      };
    case "netlify":
      return {
        program: npx,
        args: [
          "-y",
          "netlify-cli",
          "deploy",
          "--dir",
          ".",
          "--auth",
          token,
          ...(i.project ? ["--site", i.project] : []),
          ...(i.prod ? ["--prod"] : []),
        ],
        env: { ...process.env },
      };
    case "cloudflare":
      return {
        program: npx,
        args: ["-y", "wrangler", "pages", "deploy", ".", ...(i.project ? ["--project-name", i.project] : [])],
        env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
      };
  }
}

function extractUrl(log: string, provider: string): string | null {
  const host =
    provider === "vercel" ? /https:\/\/\S+\.vercel\.app/ : provider === "netlify" ? /https:\/\/\S+\.netlify\.app/ : /https:\/\/\S+\.pages\.dev/;
  const specific = log.match(host)?.[0];
  if (specific) return specific.replace(/[).,]+$/, "");
  const any = log.match(/https:\/\/[^\s)]+/)?.[0];
  return any ? any.replace(/[).,]+$/, "") : null;
}

function run(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, windowsHide: true, signal });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 240_000);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
