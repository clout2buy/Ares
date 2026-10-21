// The KillSwitch — one durable flag that halts every commit. When engaged,
// runEffect throws HaltedError before any side effect, and in-flight callers
// can cancel. File-backed so `ares operator halt` from another process (or a
// crash-recovery script) stops the running Operator immediately.

import { promises as fs } from "node:fs";
import { exists, writeFileAtomic } from "@ares/agent";

export class HaltedError extends Error {
  constructor(message = "operator halted: kill switch engaged") {
    super(message);
    this.name = "HaltedError";
  }
}

/** "operator halted: kill switch engaged (since <at>, reason: <reason>)". */
export async function haltedErrorFor(killSwitch: Pick<KillSwitch, "status">): Promise<HaltedError> {
  const status = await killSwitch.status?.().catch(() => null);
  const detail = [status?.at ? `since ${status.at}` : "", status?.reason ? `reason: ${status.reason}` : ""].filter(Boolean).join(", ");
  return new HaltedError(`operator halted: kill switch engaged${detail ? ` (${detail})` : ""}`);
}

export class KillSwitch {
  constructor(private readonly file: string) {}

  /** In-memory switch (no file) — for tests. */
  static memory(): KillSwitch {
    const ks = new KillSwitch("");
    let on = false;
    ks.engaged = async () => on;
    ks.engage = async () => {
      on = true;
    };
    ks.release = async () => {
      on = false;
    };
    ks.status = async () => (on ? {} : null);
    return ks;
  }

  /** When and why the switch was engaged, for an error the model can act on
   *  (and stop retrying). Null when released or unreadable. */
  async status(): Promise<{ at?: string; reason?: string } | null> {
    if (!(await this.engaged())) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { at?: unknown; reason?: unknown };
      return {
        ...(typeof parsed.at === "string" ? { at: parsed.at } : {}),
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      };
    } catch {
      return {};
    }
  }

  async engaged(): Promise<boolean> {
    if (!this.file) return false;
    return exists(this.file);
  }

  async engage(reason = "manual"): Promise<void> {
    if (!this.file) return;
    await writeFileAtomic(this.file, JSON.stringify({ at: new Date().toISOString(), reason }) + "\n");
  }

  async release(): Promise<void> {
    if (!this.file) return;
    await fs.rm(this.file, { force: true });
  }
}
