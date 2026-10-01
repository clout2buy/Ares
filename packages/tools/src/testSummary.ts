// testSummary - collapse a huge test/build log into what a coding agent needs:
// the counts, the FIRST error, each failure with a few lines of detail, and the
// last lines. A 10,000-line `pnpm test` run costs the model ~30k tokens that it
// mostly skims for the one red test; this keeps the signal and moves the full
// log to a file the model can Read by range if it needs more.
//
// Pure functions, no I/O. Bash calls summarizeTestOutput only when the command
// looks like a test/build run AND the output is large (see bashSummaryEnabled),
// so short, readable output is never rewritten.

export interface TestSummary {
  framework: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  /** Failure headings, de-duplicated, capped. */
  failureCount: number;
  firstError?: string;
  originalLines: number;
  /** The rendered, model-facing digest. */
  text: string;
}

const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:node\s+(?:--\S+\s+)*--test\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:-r\s+|--recursive\s+)?(?:test|check|verify|lint|build|typecheck)\b|npx\s+(?:--no-install\s+)?(?:jest|vitest|mocha|tsc|eslint)\b|jest\b|vitest\b|mocha\b|pytest\b|py\.test\b|python3?\s+-m\s+(?:pytest|unittest|compileall)\b|cargo\s+(?:test|nextest|build|check|clippy)\b|go\s+(?:test|build|vet)\b|make\s+(?:test|check|build)?\b|dotnet\s+(?:test|build)\b|mvn\s+(?:-\S+\s+)*(?:test|verify|package)\b|gradlew?\s+(?:\S+\s+)*(?:test|build|check)\b|ctest\b|rspec\b|phpunit\b|deno\s+test\b|tsc\b|eslint\b|ruff\b|mypy\b)/i;

/** Does this shell command look like a test/build/lint run? */
export function looksLikeTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

/** ARES_TEST_SUMMARY=off disables; ARES_TEST_SUMMARY_MIN_CHARS overrides the 8000-char floor. */
export function testSummaryMinChars(): number {
  if ((process.env.ARES_TEST_SUMMARY ?? "").trim().toLowerCase() === "off") return Number.POSITIVE_INFINITY;
  const n = Number(process.env.ARES_TEST_SUMMARY_MIN_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripTiming(line: string): string {
  return line.replace(/\s*\((?:\d+(?:\.\d+)?)\s*(?:ms|s)\)\s*$/, "").replace(/\s+\d+(?:\.\d+)?\s*ms$/, "").trim();
}

const FAILURE_MARKER =
  /^\s*(?:not ok \d+\b.*|[✖✗×✘x]\s+\S.*|FAIL(?:ED)?\b.*|--- FAIL:.*|●\s.+|_{3,}\s.+\s_{3,}|=+\s*FAILURES\s*=+|test\s+\S+\s+\.\.\.\s+FAILED|\d+\)\s+\S.*|panic:.*|thread '.+' panicked.*)$/;

const ERROR_LINE =
  /(?:\bAssertionError\b|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|\bError:|\berror(?:\[\w+\])?:|\berror TS\d+|\bpanic\b|\bException\b|\bFAILED\b|\bExpected\b.*\b(?:Received|but got|to equal|to be)\b|\bassert(?:ion)?\b.*\bfail)/i;

interface Counts {
  framework: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
}

function parseCounts(lines: string[]): Counts {
  const text = lines.join("\n");
  // node:test (TAP "# pass 3" or spec "ℹ pass 3")
  const nodeCounts: Record<string, number> = {};
  for (const line of lines) {
    const m = /^\s*(?:#|ℹ)\s*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/.exec(line);
    if (m) nodeCounts[m[1]] = Number(m[2]);
  }
  if (nodeCounts.tests !== undefined) {
    return {
      framework: "node:test",
      total: nodeCounts.tests,
      passed: nodeCounts.pass,
      failed: (nodeCounts.fail ?? 0) + (nodeCounts.cancelled ?? 0),
      skipped: nodeCounts.skipped,
    };
  }
  // jest
  const jest = /^Tests:\s+(.*)$/m.exec(text);
  if (jest) {
    const get = (word: string) => {
      const m = new RegExp(`(\\d+)\\s+${word}`).exec(jest[1]);
      return m ? Number(m[1]) : undefined;
    };
    return { framework: "jest", passed: get("passed"), failed: get("failed"), skipped: get("skipped"), total: get("total") };
  }
  // vitest
  const vitest = /^\s*Tests\s+(.*\bpassed\b.*|.*\bfailed\b.*)$/m.exec(text);
  if (vitest && /\(\d+\)/.test(vitest[1])) {
    const get = (word: string) => {
      const m = new RegExp(`(\\d+)\\s+${word}`).exec(vitest[1]);
      return m ? Number(m[1]) : undefined;
    };
    const total = /\((\d+)\)/.exec(vitest[1]);
    return { framework: "vitest", passed: get("passed"), failed: get("failed"), skipped: get("skipped"), total: total ? Number(total[1]) : undefined };
  }
  // pytest: "=== 2 failed, 10 passed, 1 skipped in 0.31s ===" (or "2 failed, 10 passed in 0.31s")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/\bin\s+\d+(?:\.\d+)?s\b/.test(line) && /\b(?:passed|failed|error|errors|skipped)\b/.test(line) && !/^\s*(?:ok|ℹ)/.test(line)) {
      const get = (word: string) => {
        const m = new RegExp(`(\\d+)\\s+${word}\\b`).exec(line);
        return m ? Number(m[1]) : undefined;
      };
      const passed = get("passed");
      const failed = (get("failed") ?? 0) + (get("errors?") ?? 0);
      const skipped = get("skipped");
      return { framework: "pytest", passed, failed, skipped, total: (passed ?? 0) + failed + (skipped ?? 0) };
    }
  }
  // cargo: sum every "test result:" line
  const cargo = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length > 0) {
    const passed = cargo.reduce((a, m) => a + Number(m[1]), 0);
    const failed = cargo.reduce((a, m) => a + Number(m[2]), 0);
    const skipped = cargo.reduce((a, m) => a + Number(m[3]), 0);
    return { framework: "cargo test", passed, failed, skipped, total: passed + failed + skipped };
  }
  // go test
  const goFail = lines.filter((l) => /^\s*--- FAIL:/.test(l)).length;
  const goPass = lines.filter((l) => /^\s*--- PASS:/.test(l)).length;
  if (goFail + goPass > 0 || lines.some((l) => /^(?:ok|FAIL)\s+\S+\s+[\d.]+s/.test(l))) {
    return { framework: "go test", passed: goPass || undefined, failed: goFail };
  }
  // tsc / compilers: count diagnostics
  const tsErrors = lines.filter((l) => /\berror TS\d+:/.test(l)).length;
  if (tsErrors > 0) return { framework: "tsc", failed: tsErrors };
  const rustErrors = lines.filter((l) => /^error(?:\[E\d+\])?:/.test(l)).length;
  if (rustErrors > 0) return { framework: "compiler", failed: rustErrors };
  return { framework: "output" };
}

function collectFailures(lines: string[], maxBlocks: number, blockLines: number): { headings: string[]; blocks: string[] } {
  const blocks: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!FAILURE_MARKER.test(line)) continue;
    const key = stripTiming(line).replace(/^\s*(?:\d+\)|not ok \d+ -?)\s*/, "");
    if (!key || /^=+\s*FAILURES/.test(key) || /^FAIL(?:ED)?$/i.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    total++;
    if (blocks.length >= maxBlocks) continue;
    const body: string[] = [line.trimEnd()];
    for (let j = i + 1; j < lines.length && body.length < blockLines; j++) {
      const next = lines[j];
      if (FAILURE_MARKER.test(next) && j > i + 1 && !/^\s{2,}/.test(next)) break;
      if (next.trim() === "" && body.length > 1 && lines[j + 1]?.trim() === "") break;
      body.push(next.trimEnd());
    }
    blocks.push(body.join("\n"));
  }
  return { headings: [...seen], blocks };
}

export interface SummarizeOptions {
  /** Path of the file holding the complete log, quoted in the digest. */
  fullOutputPath?: string;
  maxFailures?: number;
  failureLines?: number;
  tailLines?: number;
}

/** Collapse a large test/build log. Never throws. */
export function summarizeTestOutput(raw: string, options: SummarizeOptions = {}): TestSummary {
  const clean = raw.replace(ANSI, "");
  const lines = clean.split(/\r?\n/);
  const counts = parseCounts(lines);
  const maxFailures = options.maxFailures ?? 8;
  const { headings, blocks } = collectFailures(lines, maxFailures, options.failureLines ?? 14);
  const failureCount = counts.failed ?? headings.length;
  const firstErrorLine = lines.find((l) => ERROR_LINE.test(l) && !FAILURE_MARKER.test(l)) ?? lines.find((l) => ERROR_LINE.test(l));
  const firstError = firstErrorLine ? firstErrorLine.trim().slice(0, 300) : undefined;
  const tail = lines.filter((l) => l.trim() !== "").slice(-(options.tailLines ?? 8));

  const head = [
    counts.framework,
    counts.total !== undefined ? `${counts.total} total` : "",
    counts.passed !== undefined ? `${counts.passed} passed` : "",
    counts.failed !== undefined ? `${counts.failed} failed` : "",
    counts.skipped ? `${counts.skipped} skipped` : "",
  ].filter(Boolean).join(", ");
  const out: string[] = [
    `[test summary - ${head || counts.framework}; ${lines.length.toLocaleString("en-US")} output lines collapsed${options.fullOutputPath ? `; full log: ${options.fullOutputPath} (Read with offset/limit)` : ""}]`,
  ];
  if (firstError) out.push(`First error: ${firstError}`);
  if (blocks.length > 0) {
    out.push(`Failures (${failureCount > blocks.length ? `${blocks.length} of ${failureCount} shown` : String(blocks.length)}):`);
    blocks.forEach((b, i) => out.push(`${i + 1}. ${b.replace(/\n/g, "\n   ")}`));
  } else if ((counts.failed ?? 0) === 0 && !firstError) {
    out.push("No failures detected in the output.");
  }
  out.push("Last lines:", ...tail.map((l) => `  ${l.trimEnd().slice(0, 240)}`));
  return {
    framework: counts.framework,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    total: counts.total,
    failureCount,
    ...(firstError ? { firstError } : {}),
    originalLines: lines.length,
    text: out.join("\n"),
  };
}
