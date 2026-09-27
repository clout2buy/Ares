// `ares instance` — deploy and run separate Ares instances on this Linux host.
//
//   ares instance list
//   ares instance create <name> [--purpose "…"] [--provider p] [--model m]
//                        [--memory 4g] [--cpus 2] [--no-public] [--guarded] [--env-file path]
//     --no-public: no fixed <name>-ares.<domain> route; the instance's garrison
//     falls back to its own temporary trycloudflare URL.
//     --env-file: KEY=VALUE lines added to the instance's env (e.g. a provider key).
//   ares instance status|start|stop|restart|logs|pair <name>
//   ares instance update [<name>]      rebuild the image from this checkout, restart
//   ares instance image                rebuild the image only
//   ares instance remove <name> [--purge]

import { readFile } from "node:fs/promises";
import { Instances, type InstanceStatus } from "@ares/tools";
import type { ParsedArgs } from "./args.js";

const USAGE = "usage: ares instance <list|create|status|start|stop|restart|update|image|logs|pair|remove> [name] [flags]";

function line(s: InstanceStatus): string {
  return `${s.name.padEnd(16)} ${s.active.padEnd(10)} ${(s.healthy ? "healthy" : "down").padEnd(8)} ${`${s.provider}/${s.model}`.padEnd(30)} ${s.url ?? `localhost:${s.httpPort}`}`;
}

async function readEnvFile(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const raw of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq <= 0) throw new Error(`${file}: expected KEY=VALUE, got "${text.slice(0, 40)}"`);
    out[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return out;
}

export async function instanceCommand(parsed: ParsedArgs): Promise<number> {
  const [action = "list", name] = parsed.positionals;
  const flag = (key: string) => parsed.flags.get(key);
  const box = new Instances();
  const log = (text: string) => console.error(text);
  const needName = () => {
    if (!name) throw new Error(`ares instance ${action} <name>`);
    return name;
  };
  try {
    switch (action) {
      case "list": {
        const metas = await box.list();
        if (!metas.length) {
          console.log("No instances. Create one: ares instance create <name> --purpose \"…\"");
          return 0;
        }
        for (const meta of metas) console.log(line(await box.status(meta.name)));
        return 0;
      }
      case "create": {
        const status = await box.create({
          name: needName(),
          purpose: flag("purpose"),
          provider: flag("provider"),
          model: flag("model"),
          publicUrl: flag("no-public") === "true" ? false : undefined,
          guarded: flag("guarded") === "true",
          limits: { ...(flag("memory") ? { memory: flag("memory") } : {}), ...(flag("cpus") ? { cpus: flag("cpus") } : {}) },
          env: flag("env-file") ? await readEnvFile(flag("env-file")!) : undefined,
          log,
        });
        console.log(line(status));
        if (!status.healthy) console.log(`not answering yet — ares instance logs ${status.name}`);
        else if (status.url) console.log(`pair it on the phone: ares instance pair ${status.name}`);
        return status.healthy ? 0 : 1;
      }
      case "status":
        console.log(JSON.stringify(await box.status(needName()), null, 2));
        return 0;
      case "start":
      case "stop":
      case "restart":
        console.log(line(await box.systemctl(action, needName())));
        return 0;
      case "update": {
        const { image, restarted } = await box.update(name ? [name] : "all");
        console.log(`built ${image}`);
        for (const s of restarted) console.log(line(s));
        return restarted.every((s) => s.healthy) ? 0 : 1;
      }
      case "image":
        await box.preflight();
        console.log(`built ${await box.buildImage()}`);
        return 0;
      case "logs":
        console.log(await box.logs(needName(), Number(flag("lines") ?? 80)));
        return 0;
      case "pair": {
        const { link, tokenPath } = await box.pair(needName());
        if (!link) {
          console.log(`${name} has no public URL. Its token is at ${tokenPath} (sudo to read).`);
          return 1;
        }
        console.log(link);
        console.error("Open this on the phone (or paste it into Instances → ＋). It contains the instance's token.");
        return 0;
      }
      case "remove":
        console.log(await box.remove(needName(), flag("purge") === "true"));
        return 0;
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    console.error(`ares instance ${action}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
