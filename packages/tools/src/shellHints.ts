// shellHints — turn a bare "exited with code N" into something the model can
// act on.
//
// WHY: last month PowerShell failed 79 of 518 calls and 72 of those surfaced
// only as "powershell exited with code 1". The real cause was almost always in
// the last few lines of stderr — a 5.1 parser rejecting `&&`, a cmdlet name
// that isn't on PATH, an unquoted spaced path — and the model, seeing only the
// exit code, typically re-ran the same command. One `hint:` line naming the
// trap converts a retry loop into a one-shot fix. The table lives in a single
// exported function so it is unit-testable without spawning a shell.

/** Which interpreter actually ran the command — "powershell" is Windows
 *  PowerShell 5.1 (the dialect with the traps), "pwsh" is PowerShell 7+. */
export type ShellFlavor = "bash" | "powershell" | "pwsh" | "cmd" | "unknown";

/** Derive the flavor from the program path runShell was given. */
export function shellFlavorOf(program: string): ShellFlavor {
  const base = program.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  if (base === "pwsh") return "pwsh";
  if (base === "powershell") return "powershell";
  if (base === "cmd") return "cmd";
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(base)) return "bash";
  return "unknown";
}

/** Model-facing dialect label for the PowerShell result. */
export function powerShellDialect(flavor: ShellFlavor): string | undefined {
  if (flavor === "pwsh") return "PowerShell 7+ (pwsh)";
  if (flavor === "powershell") return "Windows PowerShell 5.1 (powershell.exe)";
  return undefined;
}

interface HintRule {
  /** Matched against the combined stderr+stdout tail (case-insensitive). */
  test: RegExp;
  hint: string | ((flavor: ShellFlavor) => string);
}

// Ordered: the most specific signature first, so a 5.1 `&&` error reports the
// operator fix rather than the generic ParserError advice.
const HINT_RULES: readonly HintRule[] = [
  {
    test: /The token '(?:&&|\|\|)' is not a valid statement separator/i,
    hint: "PowerShell 5.1: `&&`/`||` are not pipeline operators — use `;` to chain, or `if ($?) { ... }` to run only on success.",
  },
  {
    test: /Unexpected token '\?\?'|Unexpected token '\?'|The '\?\.' operator|null-coalescing/i,
    hint: "PowerShell 5.1 has no ternary (?:), null-coalescing (??) or null-conditional (?.) operators — use if/else and explicit `$null -eq` checks.",
  },
  {
    test: /is not recognized as the name of a cmdlet|is not recognized as an internal or external command|command not found|CommandNotFoundException/i,
    hint: (flavor) => `not on PATH (or misspelled); check with ${flavor === "bash" ? "`which <name>`" : "`Get-Command <name>`"} before retrying.`,
  },
  {
    test: /positional parameter cannot be found|A positional parameter cannot be found that accepts argument/i,
    hint: "quote the path — an unquoted path with spaces is split into several arguments.",
  },
  {
    test: /Cannot find path|Cannot find drive|No such file or directory|ENOENT|The system cannot find the (?:file|path) specified|does not exist/i,
    hint: "path does not exist; check `cwd` and use an absolute path (Get-Location / pwd shows where you are).",
  },
  {
    test: /EACCES|EPERM|Access is denied|Permission denied|UnauthorizedAccessException|being used by another process|EBUSY/i,
    hint: "permission problem — the file is locked by another process or needs elevation; close the holder (dev server, editor) or run as admin.",
  },
  {
    test: /ETIMEDOUT|timed out|timeout exceeded|Operation timed out/i,
    hint: "raise `timeout` or run with run_in_background=true and poll with BashOutput.",
  },
  {
    test: /missing the terminator|Unterminated string|unterminated (?:quoted|string)|missing closing|Missing closing|unexpected EOF while looking for matching|syntax error: unexpected end of file|The string is missing|Missing '\)'|Missing '\}'/i,
    hint: (flavor) => flavor === "bash"
      ? "quoting error — a string or bracket is unbalanced; put multi-line input in a heredoc (<<'EOF' … EOF)."
      : "quoting error — a string or bracket is unbalanced; use a single-quoted here-string (@'…'@) with the closing '@ at column 0.",
  },
  {
    test: /NativeCommandError/i,
    hint: "PowerShell 5.1: `2>&1` on a native exe wraps each stderr line in NativeCommandError and sets $? to false even on exit 0 — drop the redirect; stderr is already captured.",
  },
  {
    test: /Read-Host|Cannot read input|PromptForChoice|input is redirected|inappropriate ioctl for device|the input device is not a TTY/i,
    hint: "the command waited for interactive input — stdin is null here; pass values as arguments/flags instead of prompting.",
  },
  {
    test: /ParserError|ParseException|syntax error near unexpected token|SyntaxError/i,
    hint: (flavor) => flavor === "powershell"
      ? "PowerShell 5.1 parse error — check for `&&`/`||`, ternary/??/?., unbalanced quotes, or a here-string closer that is not at column 0."
      : "syntax error — check quoting and operators; put multi-line scripts in a heredoc/here-string.",
  },
];

/**
 * Return a one-line `hint` for a failed shell run, or null when no known
 * signature appears in the last ~40 lines of output. `exitCode` 0 never hints
 * (a warning on stderr is not a failure). Scans stderr FIRST then stdout, since
 * PowerShell writes its error records to stderr but some tools (pytest, cargo)
 * put the actionable line on stdout.
 */
export function classifyShellFailure(
  exitCode: number | null,
  stdoutTail: string,
  stderrTail: string,
  shell: ShellFlavor,
): string | null {
  if (exitCode === 0) return null;
  const tail = (text: string): string => text.split(/\r?\n/).slice(-40).join("\n");
  const haystack = `${tail(stderrTail)}\n${tail(stdoutTail)}`;
  if (haystack.trim().length === 0) {
    return shell === "powershell" || shell === "pwsh"
      ? "no output on failure — the command likely produced no error record; check the exit code's meaning for that program, and re-run with `$LASTEXITCODE` / `-ErrorAction Stop` to surface the error."
      : null;
  }
  for (const rule of HINT_RULES) {
    if (rule.test.test(haystack)) {
      return typeof rule.hint === "function" ? rule.hint(shell) : rule.hint;
    }
  }
  return null;
}
