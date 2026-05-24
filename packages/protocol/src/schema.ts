import type { PlanStep, UpgradePlan, VerificationCommand } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function expectArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

export function parseUpgradePlan(value: unknown): UpgradePlan {
  if (!isRecord(value)) throw new Error("plan must be an object");
  const goal = expectString(value.goal, "goal");
  const summary = expectString(value.summary, "summary");
  const steps = expectArray(value.steps ?? [], "steps").map(parsePlanStep);
  const verification = expectArray(value.verification ?? [], "verification").map(parseVerificationCommand);
  return { goal, summary, steps, verification };
}

export function parseVerificationCommand(value: unknown): VerificationCommand {
  if (!isRecord(value)) throw new Error("verification command must be an object");
  const program = expectString(value.program, "program");
  const args = expectArray(value.args ?? [], "args").map((arg, index) => expectString(arg, `args[${index}]`));
  const cwd = value.cwd === undefined ? undefined : expectString(value.cwd, "cwd");
  const timeoutMs = value.timeoutMs === undefined ? undefined : Number(value.timeoutMs);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("timeoutMs must be a positive number");
  }
  return { program, args, cwd, timeoutMs };
}

export function parsePlanStep(value: unknown): PlanStep {
  if (!isRecord(value)) throw new Error("plan step must be an object");
  const id = expectString(value.id, "step.id");
  const title = expectString(value.title, "step.title");
  const safety = expectString(value.safety, "step.safety") as PlanStep["safety"];
  const type = expectString(value.type, "step.type");
  if (!id.trim()) throw new Error("step.id must not be empty");
  if (!["read-only", "workspace-write", "destructive", "external-state"].includes(safety)) {
    throw new Error(`unsupported step safety: ${safety}`);
  }
  switch (type) {
    case "create_dir":
      return { id, title, safety, type, path: expectString(value.path, "step.path") };
    case "write_file":
      return {
        id,
        title,
        safety,
        type,
        path: expectString(value.path, "step.path"),
        content: expectString(value.content, "step.content"),
      };
    case "replace_text":
      return {
        id,
        title,
        safety,
        type,
        path: expectString(value.path, "step.path"),
        oldText: expectString(value.oldText, "step.oldText"),
        newText: expectString(value.newText, "step.newText"),
      };
    case "run_verification":
      return { id, title, safety, type, command: parseVerificationCommand(value.command) };
    case "spawn_agent":
      return {
        id,
        title,
        safety,
        type,
        agent: expectString(value.agent, "step.agent"),
        prompt: expectString(value.prompt, "step.prompt"),
        background: value.background === undefined ? undefined : Boolean(value.background),
      };
    default:
      throw new Error(`unsupported plan step type: ${type}`);
  }
}
