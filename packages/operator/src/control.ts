// Operator control — a tiny cross-process flag so a remote /pause (from the
// Telegram process) can stop the background loop (in the garrison process)
// without a live socket between them. Just a JSON file under the shared home.

import { promises as fs } from "node:fs";
import path from "node:path";
import { operatorPaths } from "./paths.js";

export interface OperatorControl {
  paused: boolean;
}

function controlFile(home?: string): string {
  return path.join(operatorPaths(home).operatorDir, "control.json");
}

/** Read the control flag. Missing / corrupt → not paused (autonomy runs). */
export async function readOperatorControl(home?: string): Promise<OperatorControl> {
  try {
    const parsed = JSON.parse(await fs.readFile(controlFile(home), "utf8")) as { paused?: unknown };
    return { paused: parsed?.paused === true };
  } catch {
    return { paused: false };
  }
}

/** Write the control flag (best-effort, atomic-ish). */
export async function setOperatorControl(control: OperatorControl, home?: string): Promise<void> {
  const file = controlFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ paused: control.paused === true }, null, 2) + "\n", "utf8");
}

/** Convenience: is the operator currently paused? */
export async function isOperatorPaused(home?: string): Promise<boolean> {
  return (await readOperatorControl(home)).paused;
}
