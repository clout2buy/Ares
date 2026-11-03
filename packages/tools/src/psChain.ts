// psChain — make bash-style `&&` / `||` chains run on Windows PowerShell 5.1.
//
// WHY: field window Sep 20 - Nov 2, PowerShell was the most-failing tool (12% of
// 977 calls) and 13 of those were 5.1 parse errors on `a && b`: models write
// pipeline-chain operators because pwsh 7 and every POSIX shell accept them.
// The tool description already warns; models keep doing it. So before handing a
// command to powershell.exe 5.1 we rewrite the chain into the 5.1 equivalent:
//
//   a && b        ->  a; if ($?) { b }
//   a || b        ->  a; if (-not $?) { b }
//   a && b || c   ->  a; $__aresOk = $?; if ($__aresOk) { b; $__aresOk = $? }; if (-not $__aresOk) { c; $__aresOk = $? }
//
// (left-associative, exactly how pwsh 7 and bash read a mixed chain).
//
// A regex over the whole command cannot do this safely: `&&` inside a string,
// a here-string, a comment or a `$( )` must not move. This is a small
// tokenizer that only splits at operators outside quotes/comments, and only at
// statement level (never inside plain parentheses, where 5.1 does not accept a
// statement list). Line count is preserved, so PowerShell's `At line:N` still
// points at the line the model wrote.

export interface ChainRewrite {
  command: string;
  /** True when at least one `&&`/`||` was rewritten. */
  changed: boolean;
}

const OK_VAR = "$__aresOk";

type Closer = "}" | ")" | null;

interface Frame {
  /** Whether `&&`/`||` may be split at this nesting level. */
  statements: boolean;
}

/** Rewrite top-level `&&`/`||` for Windows PowerShell 5.1. Returns the input
 *  unchanged when it has no operator outside strings/comments. */
export function rewritePowerShellChains(command: string): ChainRewrite {
  if (!command.includes("&&") && !command.includes("||")) return { command, changed: false };
  const state = { src: command, i: 0, changed: false };
  try {
    const out = scanBlock(state, null, { statements: true });
    return state.changed ? { command: out, changed: true } : { command, changed: false };
  } catch {
    // An unbalanced script is PowerShell's to report, with its own location.
    return { command, changed: false };
  }
}

interface ScanState {
  src: string;
  i: number;
  changed: boolean;
}

/**
 * Scan statements until `closer` (not consumed) or end of input. Returns the
 * rewritten text of the block body.
 */
function scanBlock(st: ScanState, closer: Closer, frame: Frame): string {
  const src = st.src;
  let out = "";
  // Current statement: completed segments with the operator that FOLLOWS each.
  let segments: string[] = [];
  let ops: Array<"&&" | "||"> = [];
  let seg = "";

  const flush = () => {
    if (ops.length === 0) {
      out += seg;
    } else {
      segments.push(seg);
      out += emitChain(segments, ops);
      st.changed = true;
    }
    segments = [];
    ops = [];
    seg = "";
  };

  while (st.i < src.length) {
    const ch = src[st.i];
    const next = src[st.i + 1] ?? "";

    if (closer && ch === closer) break;

    // Here-strings: @' ... '@ / @" ... "@ with the closer at column 0.
    if (ch === "@" && (next === "'" || next === '"') && /^[ \t]*\r?\n/.test(src.slice(st.i + 2))) {
      seg += readHereString(st, next);
      continue;
    }
    if (ch === "'" || ch === "‘" || ch === "’") {
      seg += readSingleQuoted(st);
      continue;
    }
    if (ch === '"' || ch === "“" || ch === "”") {
      seg += readDoubleQuoted(st);
      continue;
    }
    if (ch === "<" && next === "#") {
      const end = src.indexOf("#>", st.i + 2);
      if (end < 0) throw new Error("unterminated block comment");
      seg += src.slice(st.i, end + 2);
      st.i = end + 2;
      continue;
    }
    if (ch === "#" && (st.i === 0 || /\s|[;{}()|]/.test(src[st.i - 1]))) {
      const nl = src.slice(st.i).search(/\r?\n/);
      const end = nl < 0 ? src.length : st.i + nl;
      seg += src.slice(st.i, end);
      st.i = end;
      continue;
    }
    if (ch === "`") {
      // Escape / line continuation: the next character is literal.
      seg += src.slice(st.i, st.i + 2);
      st.i += 2;
      continue;
    }
    if (ch === "$" && next === "{") {
      // `${env:Path}` is a braced variable name, not a script block.
      const end = src.indexOf("}", st.i + 2);
      if (end < 0) throw new Error("unterminated variable");
      seg += src.slice(st.i, end + 1);
      st.i = end + 1;
      continue;
    }
    if (ch === "{" || (ch === "$" && next === "(") || (ch === "@" && (next === "(" || next === "{"))) {
      const open = ch === "{" ? "{" : ch + next;
      const close: Closer = open.endsWith("(") ? ")" : "}";
      st.i += open.length;
      const body = scanBlock(st, close, { statements: true });
      if (src[st.i] !== close) throw new Error("unbalanced");
      st.i += 1;
      seg += open + body + close;
      continue;
    }
    if (ch === "(") {
      st.i += 1;
      const body = scanBlock(st, ")", { statements: false });
      if (src[st.i] !== ")") throw new Error("unbalanced");
      st.i += 1;
      seg += "(" + body + ")";
      continue;
    }
    if (frame.statements && ((ch === "&" && next === "&") || (ch === "|" && next === "|"))) {
      segments.push(seg);
      ops.push(ch === "&" ? "&&" : "||");
      seg = "";
      st.i += 2;
      continue;
    }
    if (ch === ";" && frame.statements) {
      flush();
      out += ";";
      st.i += 1;
      continue;
    }
    if ((ch === "\n" || (ch === "\r" && next === "\n")) && frame.statements) {
      // A newline right after an operator or a trailing pipe continues the
      // statement (pwsh 7 accepts `a &&` + newline + `b`).
      const pending = seg.trim();
      if ((ops.length > 0 && pending === "") || pending.endsWith("|")) {
        const nl = ch === "\r" ? "\r\n" : "\n";
        seg += nl;
        st.i += nl.length;
        continue;
      }
      flush();
      const nl = ch === "\r" ? "\r\n" : "\n";
      out += nl;
      st.i += nl.length;
      continue;
    }
    seg += ch;
    st.i += 1;
  }
  flush();
  return out;
}

function emitChain(segments: string[], ops: Array<"&&" | "||">): string {
  // Trailing blanks of the whole statement stay after it (`{ a && b }` keeps
  // the space before its closing brace).
  const lastRaw = segments[segments.length - 1];
  const trail = /[ \t]*$/.exec(lastRaw)?.[0] ?? "";
  segments = [...segments.slice(0, -1), lastRaw.slice(0, lastRaw.length - trail.length)];
  return emitChainBody(segments, ops) + trail;
}

function emitChainBody(segments: string[], ops: Array<"&&" | "||">): string {
  const head = segments[0].replace(/[ \t]+$/, "");
  if (ops.length === 1) {
    const guard = ops[0] === "&&" ? "$?" : "-not $?";
    return `${head}; if (${guard}) {${segments[1]} }`;
  }
  if (ops.every((op) => op === ops[0])) {
    // Pure chain: nest, so each link runs only when the previous one did.
    const guard = ops[0] === "&&" ? "$?" : "-not $?";
    let tail = segments[segments.length - 1];
    for (let k = segments.length - 2; k >= 1; k--) {
      tail = `${segments[k].replace(/[ \t]+$/, "")}; if (${guard}) {${tail} }`;
    }
    return `${head}; if (${guard}) {${tail} }`;
  }
  let text = `${head}; ${OK_VAR} = $?`;
  for (let k = 0; k < ops.length; k++) {
    const guard = ops[k] === "&&" ? OK_VAR : `-not ${OK_VAR}`;
    text += `; if (${guard}) {${segments[k + 1].replace(/[ \t]+$/, "")}; ${OK_VAR} = $? }`;
  }
  return text;
}

function readSingleQuoted(st: ScanState): string {
  const src = st.src;
  const start = st.i;
  st.i += 1;
  while (st.i < src.length) {
    const c = src[st.i];
    if (c === "'" || c === "‘" || c === "’") {
      const n = src[st.i + 1];
      if (n === "'" || n === "‘" || n === "’") {
        st.i += 2;
        continue;
      }
      st.i += 1;
      return src.slice(start, st.i);
    }
    st.i += 1;
  }
  throw new Error("unterminated string");
}

function readDoubleQuoted(st: ScanState): string {
  const src = st.src;
  let text = src[st.i];
  st.i += 1;
  while (st.i < src.length) {
    const c = src[st.i];
    if (c === "`") {
      text += src.slice(st.i, st.i + 2);
      st.i += 2;
      continue;
    }
    if (c === "$" && src[st.i + 1] === "(") {
      st.i += 2;
      const body = scanBlock(st, ")", { statements: true });
      if (src[st.i] !== ")") throw new Error("unbalanced");
      st.i += 1;
      text += "$(" + body + ")";
      continue;
    }
    if (c === '"' || c === "“" || c === "”") {
      const n = src[st.i + 1];
      if (n === '"' || n === "“" || n === "”") {
        text += c + n;
        st.i += 2;
        continue;
      }
      text += c;
      st.i += 1;
      return text;
    }
    text += c;
    st.i += 1;
  }
  throw new Error("unterminated string");
}

function readHereString(st: ScanState, quote: string): string {
  const src = st.src;
  const start = st.i;
  const re = quote === "'" ? /\r?\n'@/g : /\r?\n"@/g;
  re.lastIndex = st.i + 2;
  const m = re.exec(src);
  if (!m) throw new Error("unterminated here-string");
  st.i = m.index + m[0].length;
  return src.slice(start, st.i);
}
