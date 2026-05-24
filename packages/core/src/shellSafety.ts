import path from "node:path";
import type { VerificationCommand } from "@crix/protocol";
import type { PolicyDecision } from "./policy.js";

export interface ShellToken {
  value: string;
  lower: string;
  quoted: boolean;
}

export interface ShellAnalysis {
  display: string;
  program: string;
  programBase: string;
  tokens: ShellToken[];
  denied: boolean;
  reason?: string;
  warnings: string[];
  readOnly: boolean;
}

const SHELL_PROGRAMS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh", "fish"]);
const BLOCKED_PROGRAMS = new Set(["reg", "reg.exe", "diskpart", "diskpart.exe", "format", "format.com", "shutdown", "shutdown.exe", "schtasks", "schtasks.exe", "sc", "sc.exe", "wscript", "cscript"]);
const DESTRUCTIVE_PROGRAMS = new Set(["rm", "del", "erase", "rmdir", "rd", "remove-item", "move-item", "copy-item", "set-content", "new-item"]);
const NETWORK_PROGRAMS = new Set(["curl", "curl.exe", "wget", "wget.exe", "ssh", "ssh.exe", "scp", "scp.exe", "ftp", "ftp.exe"]);
const SHELL_OPERATORS = /[;&|`><]/;
const POWERSHELL_FLAGS = new Set(["-encodedcommand", "-enc", "-command", "-c", "-file"]);
const CMD_FLAGS = new Set(["/c", "/k"]);

export function analyzeShellCommand(command: VerificationCommand): ShellAnalysis {
  const program = command.program.trim();
  const programBase = path.basename(program).toLowerCase();
  const tokens = [program, ...command.args].map((value) => shellToken(value));
  const allLower = tokens.map((token) => token.lower);
  const joined = allLower.join(" ");
  const warnings: string[] = [];

  const deny = (reason: string): ShellAnalysis => ({
    display: [command.program, ...command.args].join(" "),
    program,
    programBase,
    tokens,
    denied: true,
    reason,
    warnings,
    readOnly: false,
  });

  if (!program) return deny("empty program");
  if (BLOCKED_PROGRAMS.has(programBase)) return deny(`blocked dangerous program: ${programBase}`);
  if (DESTRUCTIVE_PROGRAMS.has(programBase)) return deny(`blocked destructive program: ${programBase}`);
  if (NETWORK_PROGRAMS.has(programBase)) return deny(`blocked network-capable program: ${programBase}`);
  if (programBase.replace(/\.(exe|cmd|bat)$/, "") === "git" && ["reset", "clean", "push", "checkout", "restore"].includes(allLower[1] ?? "")) {
    return deny(`blocked git mutation command: git ${allLower[1]}`);
  }

  if (SHELL_PROGRAMS.has(programBase)) {
    const flag = allLower.slice(1).find((token) => POWERSHELL_FLAGS.has(token) || CMD_FLAGS.has(token));
    if (!flag) return deny(`blocked interactive shell program: ${programBase}`);
    const commandText = command.args.join(" ");
    const nested = analyzeShellText(commandText);
    if (nested.denied) return deny(`blocked shell command: ${nested.reason}`);
    warnings.push("shell wrapper detected; command text parsed for dangerous operators");
  }

  if (allLower.some((token) => token.includes("..\\") || token.includes("../"))) {
    warnings.push("relative parent path reference present");
  }

  const literalOperators = command.args.filter((arg) => SHELL_OPERATORS.test(arg));
  if (literalOperators.length > 0 && SHELL_PROGRAMS.has(programBase)) {
    return deny(`blocked shell operator in shell command: ${literalOperators[0]}`);
  }

  return {
    display: [command.program, ...command.args].join(" "),
    program,
    programBase,
    tokens,
    denied: false,
    warnings,
    readOnly: isKnownReadOnlyCommand(programBase, allLower.slice(1)),
  };
}

export function classifyShellVerificationCommand(command: VerificationCommand): PolicyDecision {
  const analysis = analyzeShellCommand(command);
  if (analysis.denied) return deny(analysis.reason ?? "blocked unsafe shell command");
  const program = analysis.programBase.replace(/\.(exe|cmd|bat)$/, "");
  const args = command.args;
  const sub = args[0]?.toLowerCase();

  if (program === "node") {
    return sub === "--test" || sub === "--check" ? allow("node verification allowed") : deny("node command must be --test or --check");
  }
  if (program === "pnpm" || program === "npm") {
    if (!sub) return deny(`${program} requires a verification subcommand`);
    if (!["test", "run", "exec", "build", "check", "verify"].includes(sub)) return deny(`${program} ${sub} is not verification-safe`);
    if (args.some((arg) => SHELL_OPERATORS.test(arg))) return deny(`${program} verification args contain shell operator`);
    return allow("package verification allowed");
  }
  if (program === "java" || program === "javac") return allow("Java verification allowed");
  if (program === "git") {
    return ["status", "diff", "show", "log"].includes(sub ?? "") ? allow("read-only git command allowed") : deny(`git ${sub ?? ""} is not verification-safe`);
  }
  return deny(`${command.program} is not in the verification allowlist`);
}

function analyzeShellText(text: string): { denied: boolean; reason?: string } {
  const lower = text.toLowerCase();
  const blockedFragments = [
    "invoke-expression",
    " iex ",
    "encodedcommand",
    "start-process",
    "-verb runas",
    "remove-item",
    "rm -rf",
    "git reset",
    "git clean",
    "git push",
    "git checkout",
    "git restore",
    "reg add",
    "reg delete",
    "diskpart",
    "format ",
    "shutdown",
    "schtasks",
  ];
  const fragment = blockedFragments.find((part) => lower.includes(part));
  if (fragment) return { denied: true, reason: `contains blocked fragment ${fragment}` };
  if (/[;&|`]/.test(text)) return { denied: true, reason: "contains shell control operator" };
  return { denied: false };
}

function shellToken(value: string): ShellToken {
  const trimmed = value.trim();
  const quoted = (trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
  const unquoted = quoted ? trimmed.slice(1, -1) : trimmed;
  return { value: unquoted, lower: unquoted.toLowerCase(), quoted };
}

function isKnownReadOnlyCommand(programBase: string, args: string[]): boolean {
  const program = programBase.replace(/\.(exe|cmd|bat)$/, "");
  if (program === "git") return ["status", "diff", "show", "log"].includes(args[0] ?? "");
  if (program === "node") return args[0] === "--check" || args[0] === "--test";
  if (program === "pnpm" || program === "npm") return ["test", "run", "exec", "build", "check", "verify"].includes(args[0] ?? "");
  if (program === "java" || program === "javac") return true;
  return false;
}

function allow(reason: string): PolicyDecision {
  return { allowed: true, reason };
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason };
}
