// Owner control-plane commands over Telegram — the same kill switch the phone
// app has, reachable from the chat the owner already has open.
//
//   /stopall            stop every turn, subagent, job and browser (not just this chat's turn)
//   /pause · /resume    freeze everything at the next tool boundary / let it continue
//   /log                the last ~15 audit entries, compact
//   /jobs               every scheduled job, who made it, whether it was approved
//   /cancel_job <id>    kill one job
//
// Owner-only, always: a guest's /pause is not a control signal. Each command
// answers with exactly ONE message (the bridge's one-notification rule). The
// bridge only parses; the host (garrison) owns the control plane and renders
// the text, so this package keeps knowing nothing about sessions or jobs.

export type OwnerControlKind = "stopall" | "pause" | "resume" | "log" | "jobs" | "cancel_job";

export interface OwnerControlDeps {
  stopAll(): Promise<string>;
  pause(): string | Promise<string>;
  resume(): string | Promise<string>;
  log(): Promise<string>;
  jobs?(): Promise<string>;
  cancelJob?(id: string): Promise<string>;
}

const ALIASES: Record<string, OwnerControlKind> = {
  stopall: "stopall",
  stop_all: "stopall",
  killall: "stopall",
  pause: "pause",
  resume: "resume",
  log: "log",
  audit: "log",
  jobs: "jobs",
  cancel_job: "cancel_job",
  canceljob: "cancel_job",
};

/** Recognize an owner control command (slash form only — a bare "pause" in a
 *  sentence is conversation, not a signal). */
export function parseOwnerControlCommand(text: string): { kind: OwnerControlKind; arg?: string } | null {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const kind = ALIASES[m[1].toLowerCase()];
  if (!kind) return null;
  const arg = m[2]?.trim();
  return arg ? { kind, arg } : { kind };
}

/** Run one parsed command against the host's control plane → the reply text. */
export async function runOwnerControlCommand(
  deps: OwnerControlDeps,
  command: { kind: OwnerControlKind; arg?: string },
): Promise<string> {
  switch (command.kind) {
    case "stopall":
      return deps.stopAll();
    case "pause":
      return deps.pause();
    case "resume":
      return deps.resume();
    case "log":
      return deps.log();
    case "jobs":
      return deps.jobs ? deps.jobs() : "Jobs aren't listable here.";
    case "cancel_job":
      if (!command.arg) return "Usage: /cancel_job <id> — see /jobs for ids.";
      return deps.cancelJob ? deps.cancelJob(command.arg) : "Jobs can't be cancelled here.";
  }
}
