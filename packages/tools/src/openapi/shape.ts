// Shaping a response for the model: pick part of it (select / fields), and when it
// is still too big shrink it STRUCTURALLY — keep the shape, cut the length of each
// array and string, and say exactly what was cut and how to read the rest — instead
// of slicing the JSON text in the middle of a value.

/**
 * The key to step into at segs[i]: a key that itself contains dots (Microsoft
 * Graph's "@odata.nextLink") is found by trying the longest join of segments first.
 */
function stepInto(obj: Record<string, unknown>, segs: string[], i: number): { value: unknown; used: number } | undefined {
  for (let n = segs.length - i; n >= 1; n--) {
    const key = segs.slice(i, i + n).join(".");
    if (Object.prototype.hasOwnProperty.call(obj, key)) return { value: obj[key], used: n };
  }
  return undefined;
}

export function getPath(value: unknown, pathText: string): unknown {
  if (pathText === "" || pathText === ".") return value;
  const segs = pathText.split(/[.\[\]]+/).filter(Boolean);
  let current: unknown = value;
  for (let i = 0; i < segs.length; ) {
    if (current === null || typeof current !== "object") return undefined;
    const step = stepInto(current as Record<string, unknown>, segs, i);
    if (!step) return undefined;
    current = step.value;
    i += step.used;
  }
  return current;
}

/** "results.0.name", "items.*.id", "0:15" (a slice). */
export function selectPath(value: unknown, pathText: string): unknown {
  let current: unknown = value;
  const segments = pathText.split(/[.\[\]]+/).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const slice = /^(-?\d*):(-?\d*)$/.exec(seg);
    if (slice) {
      if (!Array.isArray(current)) return undefined;
      current = current.slice(slice[1] ? Number(slice[1]) : 0, slice[2] ? Number(slice[2]) : undefined);
      continue;
    }
    if (seg === "*") {
      if (!Array.isArray(current)) return undefined;
      const rest = segments.slice(i + 1).join(".");
      return current.map((item) => (rest ? selectPath(item, rest) : item));
    }
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Keep only these dotted paths of an object; a path that crosses an array applies to every element. */
function pickPaths(source: unknown, paths: string[]): unknown {
  if (Array.isArray(source)) return source.map((item) => pickPaths(item, paths));
  if (!isObject(source)) return source;
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const segs = path.split(".").filter(Boolean);
    if (!segs.length) continue;
    assign(out, source, segs);
  }
  return out;
}

function assign(target: Record<string, unknown>, source: Record<string, unknown>, segs: string[]): void {
  const [head, ...rest] = segs as [string, ...string[]];
  if (!(head in source)) return;
  const value = source[head];
  if (!rest.length) {
    target[head] = value;
    return;
  }
  if (Array.isArray(value)) {
    const existing = Array.isArray(target[head]) ? (target[head] as unknown[]) : value.map(() => ({}));
    target[head] = value.map((item, i) => {
      if (!isObject(item)) return item;
      const slot = isObject(existing[i]) ? (existing[i] as Record<string, unknown>) : {};
      assign(slot, item, rest);
      return slot;
    });
    return;
  }
  if (isObject(value)) {
    const slot = isObject(target[head]) ? (target[head] as Record<string, unknown>) : {};
    assign(slot, value, rest);
    target[head] = slot;
  }
}

/**
 * Narrow a response to the fields asked for. An array is projected element by
 * element; an object that carries the operation's items array (itemsPath) keeps
 * its envelope (next cursor, totals) and has the items projected; any other
 * object is projected directly.
 */
export function projectFields(value: unknown, fields: string[], itemsPath?: string): unknown {
  const paths = fields.map((f) => f.trim()).filter(Boolean);
  if (!paths.length) return value;
  if (Array.isArray(value)) return pickPaths(value, paths);
  if (isObject(value)) {
    if (itemsPath && itemsPath !== "." && Array.isArray(getPath(value, itemsPath))) {
      return replacePath(value, itemsPath, pickPaths(getPath(value, itemsPath), paths));
    }
    return pickPaths(value, paths);
  }
  return value;
}

function replacePath(root: Record<string, unknown>, pathText: string, replacement: unknown): Record<string, unknown> {
  const segs = pathText.split(/[.\[\]]+/).filter(Boolean);
  const clone = (node: unknown, i: number): unknown => {
    if (i === segs.length) return replacement;
    if (!isObject(node)) return node;
    return { ...node, [segs[i]!]: clone(node[segs[i]!], i + 1) };
  };
  return clone(root, 0) as Record<string, unknown>;
}

// ─── shrinking ───────────────────────────────────────────────────────────────

export interface ShrinkResult {
  value: unknown;
  /** True when anything was cut. */
  changed: boolean;
  /** Where and how much: "items: 312 -> 8", "items.*.body: long text cut to 200 characters". */
  cuts: string[];
}

interface Caps {
  array: number;
  string: number;
  depth: number;
  keys: number;
}

function reduce(value: unknown, caps: Caps, path: string, depth: number, cuts: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (value.length > caps.string) {
      const key = `${path || "(root)"}: long text`;
      cuts.set(key, `${key} cut to ${caps.string} characters`);
      return `${value.slice(0, caps.string)}…(+${value.length - caps.string} chars)`;
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= caps.depth) {
    const key = `${path || "(root)"}: deep nesting`;
    cuts.set(key, `${key} collapsed`);
    return Array.isArray(value) ? `[…${value.length} items]` : `{…${Object.keys(value).length} keys}`;
  }
  if (Array.isArray(value)) {
    const star = path ? `${path}.*` : "*";
    const kept = value.slice(0, caps.array).map((item) => reduce(item, caps, star, depth + 1, cuts));
    if (value.length > caps.array) {
      cuts.set(`${path || "(root)"}: array`, `${path || "(root)"}: ${value.length} -> ${caps.array}`);
      kept.push(`…(+${value.length - caps.array} more)` as never);
    }
    return kept;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, caps.keys)) out[k] = reduce(v, caps, path ? `${path}.${k}` : k, depth + 1, cuts);
  if (entries.length > caps.keys) {
    cuts.set(`${path || "(root)"}: keys`, `${path || "(root)"}: ${entries.length} keys -> ${caps.keys}`);
    out["…"] = `+${entries.length - caps.keys} more keys`;
  }
  return out;
}

/** Shrink a JSON value until its text fits maxChars, keeping its shape. */
export function shrinkJson(value: unknown, maxChars: number): ShrinkResult {
  const size = (v: unknown) => JSON.stringify(v)?.length ?? 0;
  if (size(value) <= maxChars) return { value, changed: false, cuts: [] };
  let caps: Caps = { array: 60, string: 600, depth: 9, keys: 80 };
  const floor: Caps = { array: 2, string: 60, depth: 3, keys: 12 };
  let best: ShrinkResult = { value, changed: true, cuts: [] };
  for (let round = 0; round < 24; round++) {
    const cuts = new Map<string, string>();
    const candidate = reduce(value, caps, "", 0, cuts);
    best = { value: candidate, changed: true, cuts: [...cuts.values()].slice(0, 8) };
    if (size(candidate) <= maxChars) return best;
    caps = {
      array: Math.max(floor.array, Math.floor(caps.array * 0.6)),
      string: Math.max(floor.string, Math.floor(caps.string * 0.6)),
      depth: round % 3 === 2 ? Math.max(floor.depth, caps.depth - 1) : caps.depth,
      keys: Math.max(floor.keys, Math.floor(caps.keys * 0.7)),
    };
  }
  return best;
}
