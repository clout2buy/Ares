// `ares orsi …` — Ares at the ORSI door (see orsiDoor.ts).
//
//   ares orsi register        declare the gene once (and after an Ares upgrade)
//   ares orsi work            run door jobs forever (a service; real provider, throwaway workspaces)
//   ares orsi genome          fetch the evolved rules and show what the next turn will run on
//   ares orsi status          what ORSI holds about Ares
import type { ParsedArgs } from "./args.js";
import { CONSENT_TEXT, doorConfig, join, leave, readMembership, refreshGenome, register, status, work } from "./orsiDoor.js";
import { currentRules, DEFAULT_RULES } from "./orsiOverlay.js";
import { cliRuntimeContext, cliVersion } from "./runtime.js";

export async function orsiCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "status";
  const home = cliRuntimeContext().home;
  if (sub === "join") {
    if (args.flags.get("yes") !== "true" && !args.flags.has("yes")) {
      console.log(CONSENT_TEXT + "\n\nRun `ares orsi join --yes` to agree and join.");
      return 2;
    }
    const m = await join(home, args.flags.get("door") || undefined, await cliVersion());
    console.log(`joined the ${m.fleet} fleet as ${m.agent} at ${m.door}`);
    return 0;
  }
  if (sub === "leave") {
    console.log((await leave(home)) ? "left: membership and evolved rules removed; Ares runs on its seed rules" : "nothing to leave");
    return 0;
  }
  const cfg = doorConfig(process.env, home);
  if (!cfg) {
    console.error("not joined. `ares orsi join` (or set ORSI_DOOR and ORSI_TOKEN for a manually minted token)");
    return 2;
  }
  const member = readMembership(home);
  try {
    switch (sub) {
      case "register": {
        const out = await register(cfg, `ares-${await cliVersion()}`);
        console.log(JSON.stringify(out, null, 1));
        return 0;
      }
      case "work": {
        const ac = new AbortController();
        process.on("SIGINT", () => ac.abort());
        process.on("SIGTERM", () => ac.abort());
        await work(cfg, home, (line) => console.log(line), ac.signal);
        return 0;
      }
      case "genome": {
        const g = await refreshGenome(cfg, home);
        console.log(JSON.stringify(g, null, 1));
        const rules = currentRules(home);
        console.log(rules === DEFAULT_RULES ? "\n(next turn runs on the seed rules; nothing evolved yet)" : `\n(next turn runs on evolved rules, ${rules.length} chars)`);
        return 0;
      }
      case "status": {
        console.log(JSON.stringify(await status(cfg), null, 1));
        return 0;
      }
      default:
        console.error("ares orsi join [--yes] | leave | status | genome | register | work" + (member ? `   (joined as ${member.agent})` : ""));
        return 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
