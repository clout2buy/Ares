// `ares orsi …` — Ares at the ORSI door (see orsiDoor.ts).
//
//   ares orsi register        declare the gene once (and after an Ares upgrade)
//   ares orsi work            run door jobs forever (a service; real provider, throwaway workspaces)
//   ares orsi genome          fetch the evolved rules and show what the next turn will run on
//   ares orsi status          what ORSI holds about Ares
import type { ParsedArgs } from "./args.js";
import { doorConfig, refreshGenome, register, status, work } from "./orsiDoor.js";
import { currentRules, DEFAULT_RULES } from "./orsiOverlay.js";
import { cliRuntimeContext, cliVersion } from "./runtime.js";

export async function orsiCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "status";
  const cfg = doorConfig();
  const home = cliRuntimeContext().home;
  if (!cfg) {
    console.error("set ORSI_DOOR and ORSI_TOKEN (the door's owner mints the token: `orsi door token ares`)");
    return 2;
  }
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
        console.error("ares orsi register | work | genome | status");
        return 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
