import type { PermissionMode, SafetyClass, VerificationCommand } from "@crix/protocol";

import { classifyShellVerificationCommand } from "./shellSafety.js";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export class SafetyPolicy {
  constructor(readonly mode: PermissionMode) {}

  evaluateSafety(safety: SafetyClass): PolicyDecision {
    if (safety === "external-state") {
      return deny("external state changes require explicit approval outside the autonomous loop");
    }
    if (this.mode === "danger-full-access") return allow("danger-full-access allows local actions");
    if (this.mode === "workspace-write") {
      if (safety === "read-only" || safety === "workspace-write") return allow("workspace-write allows scoped local edits");
      return deny("workspace-write refuses destructive actions");
    }
    if (this.mode === "auto-safe") {
      if (safety === "read-only") return allow("auto-safe allows read-only actions");
      return deny("auto-safe refuses writes and destructive actions");
    }
    if (safety === "read-only") return allow("ask mode allows read-only actions");
    return deny("ask mode refuses non-interactive state changes");
  }
}

export function classifyVerificationCommand(command: VerificationCommand): PolicyDecision {
  return classifyShellVerificationCommand(command);
}

function allow(reason: string): PolicyDecision {
  return { allowed: true, reason };
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason };
}

