// Ares instances — separate, always-on copies of Ares on a Linux host.
//
// Each instance is its own entity: its own container, home (identity, memory,
// vault), gateway token and systemd unit. Nothing of the parent's home is
// copied in — model access comes from the instance's own sign-in (Anthropic
// OAuth finishes on the phone) or keys the owner passes explicitly. The
// container gets no Docker socket, so an instance cannot spawn instances.
//
// Layout (ARES_INSTANCES_ROOT, default ~/ares-instances):
//   <name>/instance.json   metadata (ports, model, hostname, image)
//   <name>/instance.env    0600 env for the container (ports, public URL, keys)
//   <name>/data/           HOME inside the container (uid 11011), .ares lives here
//   .image/                staged build context for the shared image

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INSTANCE_UID = 11011;
export const INSTANCE_IMAGE = "ares-instance";
const CONTAINER_WS_PORT = 7421;
const CONTAINER_HTTP_PORT = 7422;
const FIRST_HOST_PORT = 17431;

export interface InstanceLimits {
  memory: string;
  cpus: string;
  pids: number;
}

export interface InstanceMeta {
  name: string;
  purpose?: string;
  provider: string;
  model: string;
  wsPort: number;
  httpPort: number;
  hostname?: string;
  image: string;
  limits: InstanceLimits;
  guarded: boolean;
  createdAt: string;
  createdBy: string;
}

export interface InstanceConfig {
  root: string;
  sourceRoot: string;
  unitDir: string;
  cloudflaredConfig: string;
  baseImage: string;
  nodeBin: string;
  domain?: string;
  maxInstances: number;
  user: string;
  parentName: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { input?: string; sudo?: boolean; timeoutMs?: number; signal?: AbortSignal },
) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const program = opts.sudo ? "sudo" : cmd;
    const argv = opts.sudo ? ["-n", cmd, ...args] : args;
    const child = spawn(program, argv, { stdio: ["pipe", "pipe", "pipe"], signal: opts.signal });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });

/** Host name of the owner's public URL minus its first label: ares.example.com → example.com. */
export function domainFromPublicUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const labels = new URL(url).hostname.split(".");
    return labels.length >= 3 ? labels.slice(1).join(".") : undefined;
  } catch {
    return undefined;
  }
}

export function instanceConfig(env: NodeJS.ProcessEnv = process.env): InstanceConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    root: env.ARES_INSTANCES_ROOT ?? path.join(os.homedir(), "ares-instances"),
    sourceRoot: env.ARES_INSTANCE_SOURCE ?? path.resolve(here, "..", "..", ".."),
    unitDir: env.ARES_INSTANCE_UNIT_DIR ?? "/etc/systemd/system",
    cloudflaredConfig: env.ARES_CLOUDFLARED_CONFIG ?? "/etc/cloudflared/config.yml",
    baseImage: env.ARES_INSTANCE_BASE_IMAGE ?? "ubuntu:24.04",
    nodeBin: env.ARES_INSTANCE_NODE ?? process.execPath,
    domain: env.ARES_INSTANCE_DOMAIN ?? domainFromPublicUrl(env.ARES_REMOTE_PUBLIC_URL),
    maxInstances: Number(env.ARES_INSTANCES_MAX ?? 6) || 6,
    user: os.userInfo().username,
    parentName: agentNameFrom(path.join(env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "IDENTITY.md")),
  };
}

function agentNameFrom(identityFile: string): string {
  try {
    return readFileSync(identityFile, "utf8").match(/^\s*-\s*Name:\s*([^\n,(–—-]+)/m)?.[1]?.trim() || "Ares";
  } catch {
    return "Ares";
  }
}

export function validateInstanceName(name: string): string | null {
  if (!/^[a-z][a-z0-9-]{0,28}[a-z0-9]$/.test(name)) {
    return "instance names are 2-30 chars: lowercase letters, digits and dashes, starting with a letter";
  }
  return null;
}

export const unitName = (name: string) => `ares-instance-${name}`;
export const containerName = unitName;
export const publicHostname = (name: string, domain: string) => `${name}-ares.${domain}`;

/** The next free pair (ws, http) at or above 17431, stepping by two. */
export function pickPorts(taken: ReadonlySet<number>, start = FIRST_HOST_PORT): { wsPort: number; httpPort: number } {
  for (let ws = start; ws < 65000; ws += 2) {
    if (!taken.has(ws) && !taken.has(ws + 1)) return { wsPort: ws, httpPort: ws + 1 };
  }
  throw new Error("no free port pair for a new instance");
}

/** Listening TCP ports from `ss -ltnH` output. */
export function parseListeningPorts(ssOutput: string): Set<number> {
  const ports = new Set<number>();
  for (const line of ssOutput.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    const port = Number(local?.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports;
}

export function renderUnit(meta: InstanceMeta, cfg: Pick<InstanceConfig, "root" | "user">, docker = "/usr/bin/docker"): string {
  const dir = path.posix.join(cfg.root, meta.name);
  const run = [
    `${docker} run --rm --name ${containerName(meta.name)}`,
    "--read-only --cap-drop=ALL --security-opt=no-new-privileges",
    `--pids-limit=${meta.limits.pids} --memory=${meta.limits.memory} --cpus=${meta.limits.cpus}`,
    "--tmpfs /tmp:rw,nosuid,nodev,size=256m",
    `--env-file=${dir}/instance.env`,
    `-v ${dir}/data:/data:rw -v ${dir}/data/workspace:/workspace:rw`,
    `-p 127.0.0.1:${meta.wsPort}:${CONTAINER_WS_PORT} -p 127.0.0.1:${meta.httpPort}:${CONTAINER_HTTP_PORT}`,
    `${meta.image} --provider ${meta.provider} --model ${meta.model}`,
  ].join(" ");
  return `[Unit]
Description=Ares instance ${meta.name}${meta.purpose ? ` - ${meta.purpose.replace(/\s+/g, " ").slice(0, 80)}` : ""}
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${cfg.user}
Group=${cfg.user}
ExecStartPre=-${docker} rm -f ${containerName(meta.name)}
ExecStart=${run}
ExecStop=${docker} stop -t 10 ${containerName(meta.name)}
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
`;
}

export function renderEnvFile(meta: InstanceMeta, extra: Record<string, string> = {}, tz = process.env.TZ): string {
  const base: Record<string, string> = {
    ARES_GARRISON_HOST: "0.0.0.0",
    ARES_GARRISON_PORT: String(CONTAINER_WS_PORT),
    ARES_REMOTE_AGENT_PORT: String(CONTAINER_HTTP_PORT),
    ARES_INSTANCE_NAME: meta.name,
    ...(meta.hostname ? { ARES_REMOTE_PUBLIC_URL: `https://${meta.hostname}` } : {}),
    ...(tz ? { TZ: tz } : {}),
  };
  const lines = Object.entries({ ...base, ...extra }).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad env name: ${k}`);
    if (/[\r\n]/.test(v)) throw new Error(`env ${k} must be one line`);
    return `${k}=${v}`;
  });
  return lines.join("\n") + "\n";
}

export function renderIdentity(meta: InstanceMeta, parentName: string, host: string): string {
  const title = meta.name.charAt(0).toUpperCase() + meta.name.slice(1);
  return `# Identity

- Name: ${title}
- Creature: Ares instance — a separate, always-on agent
- Vibe: blunt, capable, gets it done
- Born: ${meta.createdAt}
- Spawned by: ${parentName} on ${host}

---

I am ${title}, my own Ares. ${parentName} deployed me on ${host}, but my home,
memory and keys are mine alone; I do not share ${parentName}'s. I live in a
locked-down container: I can work freely inside it, and I cannot touch the host.
${meta.purpose ? `\n## Why I exist\n\n${meta.purpose.trim()}\n` : ""}
## What i know about myself

_(this section grows as i learn. SelfEvolve.replace_section can rewrite it.)_
`;
}

export function renderUiSettings(guarded: boolean): string {
  if (guarded) return "{}\n";
  return (
    JSON.stringify(
      {
        dangerousBypass: true,
        permissions: { mode: "free", fileWrite: true, shell: true, network: true, sensitive: true, fleetsInherit: true },
      },
      null,
      2,
    ) + "\n"
  );
}

export function renderDockerfile(baseImage: string): string {
  return `FROM ${baseImage}
USER root
RUN if command -v apt-get >/dev/null; then apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl jq ripgrep python3 && rm -rf /var/lib/apt/lists/*; fi \\
 && useradd -m -u ${INSTANCE_UID} -s /bin/bash agent
COPY node-bin /usr/local/bin/node
COPY package.json /opt/ares/package.json
COPY node_modules /opt/ares/node_modules
COPY packages /opt/ares/packages
RUN chmod 755 /usr/local/bin/node
USER agent
WORKDIR /workspace
ENV HOME=/data ARES_HOME=/data/.ares ARES_REQUIRE_ENCRYPTION=1 ARES_INSTANCE=1
ENTRYPOINT ["node", "/opt/ares/packages/cli/dist/entry.js", "garrison", "serve"]
`;
}

const ingressMarker = (name: string) => `# ares-instance:${name}`;

/** Insert a hostname rule above the first wildcard or catch-all rule (ingress is first-match). */
export function addIngress(yaml: string, name: string, hostname: string, port: number): string {
  if (yaml.includes(ingressMarker(name))) throw new Error(`tunnel already routes instance ${name}`);
  if (new RegExp(`hostname:\\s*"?${hostname.replace(/\./g, "\\.")}"?\\s*$`, "m").test(yaml)) {
    throw new Error(`tunnel already has a rule for ${hostname}`);
  }
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^ingress:\s*$/.test(l));
  if (start < 0) throw new Error("cloudflared config has no ingress section");
  let at = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (/^\s*-\s*hostname:\s*"?\*\./.test(lines[i]) || /^\s*-\s*service:/.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("cloudflared ingress has no wildcard or catch-all rule to insert above");
  const indent = lines[at].match(/^(\s*)-/)![1];
  lines.splice(at, 0, `${indent}${ingressMarker(name)}`, `${indent}- hostname: ${hostname}`, `${indent}  service: http://127.0.0.1:${port}`);
  return lines.join("\n");
}

export function removeIngress(yaml: string, name: string): string {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.trim() === ingressMarker(name));
  if (at < 0) return yaml;
  lines.splice(at, 3);
  return lines.join("\n");
}

export function pairLink(hostname: string, token: string, name: string): string {
  const params = new URLSearchParams({ url: `wss://${hostname}/gateway`, token, name });
  return `ares://pair?${params.toString()}`;
}

// ── operations ───────────────────────────────────────────────────────────

export interface InstanceStatus extends InstanceMeta {
  active: string;
  healthy: boolean;
  url?: string;
}

export class Instances {
  constructor(
    readonly cfg: InstanceConfig = instanceConfig(),
    private readonly run: Runner = defaultRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private dir(name: string) {
    return path.join(this.cfg.root, name);
  }

  private async must(cmd: string, args: string[], opts?: Parameters<Runner>[2]): Promise<string> {
    const r = await this.run(cmd, args, opts);
    if (r.code !== 0) throw new Error(`${opts?.sudo ? "sudo " : ""}${cmd} ${args.slice(0, 3).join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-600)}`);
    return r.stdout;
  }

  async preflight(): Promise<string> {
    if (process.platform !== "linux") throw new Error("Ares instances run on a Linux host with Docker and systemd; this machine is " + process.platform);
    const docker = (await this.run("sh", ["-c", "command -v docker"])).stdout.trim();
    if (!docker) throw new Error("Docker is not installed on this host");
    const sudo = await this.run("sudo", ["-n", "true"]);
    if (sudo.code !== 0) throw new Error(`${this.cfg.user} needs passwordless sudo to install systemd units`);
    return docker;
  }

  async meta(name: string): Promise<InstanceMeta> {
    const file = path.join(this.dir(name), "instance.json");
    if (!existsSync(file)) throw new Error(`no instance named ${name}`);
    return JSON.parse(await readFile(file, "utf8")) as InstanceMeta;
  }

  async list(): Promise<InstanceMeta[]> {
    if (!existsSync(this.cfg.root)) return [];
    const out: InstanceMeta[] = [];
    for (const entry of await readdir(this.cfg.root)) {
      if (entry.startsWith(".")) continue;
      const file = path.join(this.cfg.root, entry, "instance.json");
      if (existsSync(file)) out.push(JSON.parse(await readFile(file, "utf8")) as InstanceMeta);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async status(name: string): Promise<InstanceStatus> {
    const meta = await this.meta(name);
    const active = (await this.run("systemctl", ["is-active", unitName(name)])).stdout.trim() || "unknown";
    let healthy = false;
    try {
      const res = await this.fetchImpl(`http://127.0.0.1:${meta.httpPort}/gateway/health`, { signal: AbortSignal.timeout(3_000) });
      healthy = res.ok;
    } catch {
      /* down */
    }
    return { ...meta, active, healthy, ...(meta.hostname ? { url: `https://${meta.hostname}` } : {}) };
  }

  async sourceRevision(): Promise<string> {
    const sha = (await this.run("git", ["-C", this.cfg.sourceRoot, "rev-parse", "--short", "HEAD"])).stdout.trim() || "local";
    const dirty = (await this.run("git", ["-C", this.cfg.sourceRoot, "status", "--porcelain", "--untracked-files=no"])).stdout.trim();
    return dirty ? `${sha}-dirty` : sha;
  }

  /** Stage the built checkout and build ares-instance:<rev> + :latest. */
  async buildImage(signal?: AbortSignal): Promise<string> {
    const src = this.cfg.sourceRoot;
    if (!existsSync(path.join(src, "packages", "cli", "dist", "entry.js"))) {
      throw new Error(`${src} is not built — run pnpm build there first`);
    }
    const stage = path.join(this.cfg.root, ".image");
    await mkdir(stage, { recursive: true });
    for (const part of ["packages", "node_modules"]) {
      await this.must("rsync", ["-a", "--delete", "--exclude", ".cache", "--exclude", "*.tsbuildinfo", `${path.join(src, part)}/`, `${path.join(stage, part)}/`], { timeoutMs: 600_000, signal });
    }
    await this.must("cp", [path.join(src, "package.json"), path.join(stage, "package.json")]);
    await this.must("cp", ["-L", this.cfg.nodeBin, path.join(stage, "node-bin")]);
    await writeFile(path.join(stage, "Dockerfile"), renderDockerfile(this.cfg.baseImage));
    await writeFile(path.join(stage, ".dockerignore"), ".git\n");
    const tag = `${INSTANCE_IMAGE}:${await this.sourceRevision()}`;
    await this.must("docker", ["build", "-t", tag, "-t", `${INSTANCE_IMAGE}:latest`, stage], { timeoutMs: 1_800_000, signal });
    return tag;
  }

  private async imageExists(): Promise<boolean> {
    return (await this.run("docker", ["image", "inspect", `${INSTANCE_IMAGE}:latest`])).code === 0;
  }

  private async sudoWrite(file: string, content: string): Promise<void> {
    await this.must("tee", [file], { sudo: true, input: content });
  }

  private async tunnelId(yaml: string): Promise<string | undefined> {
    return yaml.match(/^tunnel:\s*(\S+)/m)?.[1];
  }

  private async editTunnel(edit: (yaml: string) => string): Promise<void> {
    const file = this.cfg.cloudflaredConfig;
    const before = await this.must("cat", [file], { sudo: true });
    const after = edit(before);
    if (after === before) return;
    const backup = `${file}.bak.${Math.floor(Date.now() / 1000)}`;
    await this.must("cp", [file, backup], { sudo: true });
    await this.sudoWrite(file, after);
    const check = await this.run("cloudflared", ["tunnel", "--config", file, "ingress", "validate"], { sudo: true });
    if (check.code !== 0) {
      await this.must("cp", [backup, file], { sudo: true });
      throw new Error(`cloudflared rejected the new ingress, restored ${backup}: ${(check.stderr || check.stdout).trim().slice(-400)}`);
    }
    await this.must("systemctl", ["restart", "cloudflared"], { sudo: true });
  }

  async create(opts: {
    name: string;
    purpose?: string;
    provider?: string;
    model?: string;
    publicUrl?: boolean;
    guarded?: boolean;
    limits?: Partial<InstanceLimits>;
    env?: Record<string, string>;
    signal?: AbortSignal;
    log?: (line: string) => void;
  }): Promise<InstanceStatus> {
    const log = opts.log ?? (() => {});
    const bad = validateInstanceName(opts.name);
    if (bad) throw new Error(bad);
    const docker = await this.preflight();
    if (existsSync(this.dir(opts.name))) throw new Error(`instance ${opts.name} already exists`);
    const existing = await this.list();
    if (existing.length >= this.cfg.maxInstances) {
      throw new Error(`already running ${existing.length} instances (ARES_INSTANCES_MAX=${this.cfg.maxInstances}); remove one first`);
    }
    const wantPublic = opts.publicUrl !== false && Boolean(this.cfg.domain) && existsSync(this.cfg.cloudflaredConfig);
    if (opts.publicUrl === true && !wantPublic) {
      throw new Error("a public URL needs a domain (ARES_INSTANCE_DOMAIN or ARES_REMOTE_PUBLIC_URL) and a cloudflared config");
    }

    if (!(await this.imageExists())) {
      log("building the instance image (first time takes a few minutes)…");
      await this.buildImage(opts.signal);
    }

    const taken = parseListeningPorts((await this.run("ss", ["-ltnH"])).stdout);
    for (const m of existing) taken.add(m.wsPort).add(m.httpPort);
    const ports = pickPorts(taken);
    const meta: InstanceMeta = {
      name: opts.name,
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
      provider: opts.provider ?? "anthropic",
      model: opts.model ?? "claude-opus-5-5",
      ...ports,
      ...(wantPublic ? { hostname: publicHostname(opts.name, this.cfg.domain!) } : {}),
      image: `${INSTANCE_IMAGE}:latest`,
      limits: { memory: opts.limits?.memory ?? "4g", cpus: opts.limits?.cpus ?? "2", pids: opts.limits?.pids ?? 512 },
      guarded: opts.guarded ?? false,
      createdAt: new Date().toISOString(),
      createdBy: this.cfg.parentName,
    };

    const dir = this.dir(opts.name);
    const home = path.join(dir, "data", ".ares");
    await mkdir(home, { recursive: true });
    await mkdir(path.join(dir, "data", "workspace"), { recursive: true });
    await writeFile(path.join(home, "IDENTITY.md"), renderIdentity(meta, this.cfg.parentName, os.hostname()));
    await writeFile(path.join(home, "ui.json"), renderUiSettings(meta.guarded));
    await writeFile(path.join(dir, "instance.env"), renderEnvFile(meta, opts.env), { mode: 0o600 });
    await chmod(path.join(dir, "instance.env"), 0o600);
    await writeFile(path.join(dir, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
    await this.must("chown", ["-R", `${INSTANCE_UID}:${INSTANCE_UID}`, path.join(dir, "data")], { sudo: true });
    await this.must("chmod", ["700", path.join(dir, "data")], { sudo: true });

    if (meta.hostname) {
      log(`routing https://${meta.hostname} through the tunnel…`);
      await this.editTunnel((yaml) => addIngress(yaml, meta.name, meta.hostname!, meta.httpPort));
      const yaml = await this.must("cat", [this.cfg.cloudflaredConfig], { sudo: true });
      const tunnel = await this.tunnelId(yaml);
      if (tunnel) {
        const cert = path.join(path.dirname(this.cfg.cloudflaredConfig), "cert.pem");
        const dns = await this.run("cloudflared", ["tunnel", "--origincert", cert, "route", "dns", tunnel, meta.hostname], { sudo: true });
        if (dns.code !== 0 && !/already exists/i.test(dns.stderr + dns.stdout)) log(`DNS route not created (a wildcard record may already cover it): ${(dns.stderr || dns.stdout).trim().slice(-200)}`);
      }
    }

    const unitFile = path.posix.join(this.cfg.unitDir, `${unitName(meta.name)}.service`);
    await this.sudoWrite(unitFile, renderUnit(meta, this.cfg, docker));
    await this.must("systemctl", ["daemon-reload"], { sudo: true });
    await this.must("systemctl", ["enable", "--now", unitName(meta.name)], { sudo: true });
    log(`started ${unitName(meta.name)}; waiting for it to answer…`);
    return this.waitHealthy(meta.name, 60_000);
  }

  async waitHealthy(name: string, timeoutMs: number): Promise<InstanceStatus> {
    const until = Date.now() + timeoutMs;
    let last = await this.status(name);
    while (!last.healthy && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2_000));
      last = await this.status(name);
    }
    return last;
  }

  async systemctl(action: "start" | "stop" | "restart", name: string): Promise<InstanceStatus> {
    await this.meta(name);
    await this.must("systemctl", [action, unitName(name)], { sudo: true });
    return action === "stop" ? this.status(name) : this.waitHealthy(name, 60_000);
  }

  /** Rebuild the image from the current checkout and restart the given (or every) instance. */
  async update(names: string[] | "all", signal?: AbortSignal): Promise<{ image: string; restarted: InstanceStatus[] }> {
    await this.preflight();
    const image = await this.buildImage(signal);
    const targets = names === "all" ? (await this.list()).map((m) => m.name) : names;
    const restarted: InstanceStatus[] = [];
    for (const name of targets) restarted.push(await this.systemctl("restart", name));
    return { image, restarted };
  }

  async logs(name: string, lines = 80): Promise<string> {
    await this.meta(name);
    const r = await this.run("journalctl", ["-u", unitName(name), "-n", String(Math.min(Math.max(lines, 1), 500)), "--no-pager", "-o", "cat"]);
    return (r.stdout || r.stderr).trim();
  }

  async pair(name: string): Promise<{ link?: string; url?: string; tokenPath: string }> {
    const meta = await this.meta(name);
    const tokenPath = path.join(this.dir(name), "data", ".ares", "garrison", "token");
    if (!meta.hostname) return { tokenPath };
    const token = (await this.must("cat", [tokenPath], { sudo: true })).trim();
    return { link: pairLink(meta.hostname, token, name), url: `https://${meta.hostname}`, tokenPath };
  }

  /** Stop and uninstall. The home is kept under .removed/ unless purge. */
  async remove(name: string, purge = false): Promise<string> {
    const meta = await this.meta(name);
    await this.preflight();
    await this.run("systemctl", ["disable", "--now", unitName(name)], { sudo: true });
    await this.run("docker", ["rm", "-f", containerName(name)]);
    await this.run("rm", ["-f", path.posix.join(this.cfg.unitDir, `${unitName(name)}.service`)], { sudo: true });
    await this.must("systemctl", ["daemon-reload"], { sudo: true });
    if (meta.hostname && existsSync(this.cfg.cloudflaredConfig)) await this.editTunnel((yaml) => removeIngress(yaml, name));
    if (purge) {
      await this.must("rm", ["-rf", this.dir(name)], { sudo: true });
      return `removed ${name} and deleted its home`;
    }
    const kept = path.join(this.cfg.root, ".removed", `${name}-${Date.now()}`);
    await mkdir(path.dirname(kept), { recursive: true });
    await rename(this.dir(name), kept);
    return `removed ${name}; its home is kept at ${kept}`;
  }
}
