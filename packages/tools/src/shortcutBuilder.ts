// Proposing new Shortcuts. Ares can describe a Shortcut in a small, documented
// subset of steps; this turns that into (1) a tap-by-tap recipe the owner can
// follow in the Shortcuts app, which always works, and (2) where every step has a
// known encoding, an unsigned .shortcut file (a binary plist).
//
// HONEST LIMIT: since iOS 15 the Shortcuts app only imports SIGNED files, and
// signing is done by Apple (macOS `shortcuts sign`, or the iCloud share link a
// device makes). This box cannot sign, so the file is UNSIGNED and iOS may refuse
// it. The app says so; the recipe is the path that is certain. The plist layout
// below is the documented WFWorkflow format but was not verified on a device.
//
// The subset (one object per step, `do` picks the kind):
//   text {text}                      Text
//   ask {prompt, default?}           Ask for Input (text)
//   notify {title, body?}            Show Notification
//   open_url {url}                   URL + Open URLs (http/https)
//   get_url {url, method?, json?}    Get Contents of URL (GET, or POST with string JSON)
//   set_volume {level 0-1}           Set Volume
//   wait {seconds}                   Wait
//   speak {text}                     Speak Text
//   show_result {text}               Show Result
//   alert {title?, message}          Show Alert
//   comment {text}                   Comment
//   set_focus {mode?, on}            RECIPE ONLY (no stable file encoding)

import { ShortcutValidationError } from "./deviceShortcuts.js";

export const STEP_KINDS = ["text", "ask", "notify", "open_url", "get_url", "set_volume", "wait", "speak", "show_result", "alert", "comment", "set_focus"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const MAX_STEPS = 30;
export const SHORTCUT_NAME_LIMIT = 100;

export interface ShortcutStep {
  do: StepKind;
  text?: string;
  prompt?: string;
  default?: string;
  title?: string;
  body?: string;
  message?: string;
  url?: string;
  method?: "GET" | "POST";
  json?: Record<string, string>;
  level?: number;
  seconds?: number;
  on?: boolean;
  mode?: string;
}

const CTRL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`, "g");

function text(v: unknown, field: string, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ShortcutValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ShortcutValidationError(`${field} must be a string`);
  const t = v.replace(CTRL, "");
  if (t.length > max) throw new ShortcutValidationError(`${field} is too long (max ${max} characters)`);
  if (required && !t.trim()) throw new ShortcutValidationError(`${field} must not be empty`);
  return t;
}

function webUrl(v: unknown, field: string): string {
  const u = text(v, field, 2000, true)!.trim();
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new ShortcutValidationError(`${field} must be a full http or https address`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ShortcutValidationError(`${field} must be http or https`);
  return u;
}

/** Validate one step against the subset; returns only the keys that step uses. */
export function normalizeStep(raw: unknown, index: number): ShortcutStep {
  const at = `step ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShortcutValidationError(`${at} must be an object`);
  const r = raw as Record<string, unknown>;
  const kind = STEP_KINDS.find((k) => k === r.do);
  if (!kind) throw new ShortcutValidationError(`${at}: "do" must be one of ${STEP_KINDS.join(", ")}`);
  const f = (name: string) => `${at} (${kind}) ${name}`;
  switch (kind) {
    case "text":
    case "speak":
    case "show_result":
    case "comment":
      return { do: kind, text: text(r.text, f("text"), 4000, true)! };
    case "ask": {
      const d = text(r.default, f("default"), 500, false);
      return { do: kind, prompt: text(r.prompt, f("prompt"), 300, true)!, ...(d ? { default: d } : {}) };
    }
    case "notify": {
      const body = text(r.body, f("body"), 500, false);
      return { do: kind, title: text(r.title, f("title"), 100, true)!, ...(body ? { body } : {}) };
    }
    case "alert": {
      const title = text(r.title, f("title"), 100, false);
      return { do: kind, message: text(r.message, f("message"), 500, true)!, ...(title ? { title } : {}) };
    }
    case "open_url":
      return { do: kind, url: webUrl(r.url, f("url")) };
    case "get_url": {
      const method = r.method === undefined ? "GET" : r.method === "GET" || r.method === "POST" ? r.method : undefined;
      if (!method) throw new ShortcutValidationError(`${f("method")} must be GET or POST`);
      let json: Record<string, string> | undefined;
      if (r.json !== undefined) {
        if (method !== "POST") throw new ShortcutValidationError(`${f("json")} needs method POST`);
        if (!r.json || typeof r.json !== "object" || Array.isArray(r.json)) throw new ShortcutValidationError(`${f("json")} must be an object of strings`);
        const entries = Object.entries(r.json as Record<string, unknown>);
        if (entries.length > 20) throw new ShortcutValidationError(`${f("json")} has too many fields (max 20)`);
        json = {};
        for (const [k, v] of entries) json[text(k, f("json key"), 100, true)!] = text(v, f("json value"), 1000, false) ?? "";
      }
      return { do: kind, url: webUrl(r.url, f("url")), method, ...(json ? { json } : {}) };
    }
    case "set_volume": {
      if (typeof r.level !== "number" || !Number.isFinite(r.level) || r.level < 0 || r.level > 1) throw new ShortcutValidationError(`${f("level")} must be a number from 0 to 1`);
      return { do: kind, level: r.level };
    }
    case "wait": {
      if (typeof r.seconds !== "number" || !Number.isFinite(r.seconds) || r.seconds <= 0 || r.seconds > 3600) throw new ShortcutValidationError(`${f("seconds")} must be a number from 0 to 3600`);
      return { do: kind, seconds: r.seconds };
    }
    case "set_focus": {
      const mode = text(r.mode, f("mode"), 40, false);
      return { do: kind, on: r.on !== false, ...(mode ? { mode } : {}) };
    }
  }
}

export function normalizeSteps(raw: unknown): ShortcutStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ShortcutValidationError("a Shortcut needs at least one step");
  if (raw.length > MAX_STEPS) throw new ShortcutValidationError(`a proposed Shortcut holds at most ${MAX_STEPS} steps`);
  return raw.map((s, i) => normalizeStep(s, i));
}

// ─── the recipe ───────────────────────────────────────────────────────────

const q = (s: string): string => `"${s.length > 120 ? `${s.slice(0, 117)}...` : s}"`;

export function describeStep(s: ShortcutStep): string {
  switch (s.do) {
    case "text": return `Add Text and type ${q(s.text!)}.`;
    case "ask": return `Add Ask for Input (type Text) with the prompt ${q(s.prompt!)}${s.default ? ` and default answer ${q(s.default)}` : ""}.`;
    case "notify": return `Add Show Notification with the title ${q(s.title!)}${s.body ? ` and body ${q(s.body)}` : ""}.`;
    case "open_url": return `Add URL and enter ${s.url}, then add Open URLs.`;
    case "get_url": return `Add Get Contents of URL for ${s.url} (method ${s.method})${s.json ? `; under Request Body choose JSON and add ${Object.keys(s.json).map((k) => q(k)).join(", ")} as Text fields` : ""}.`;
    case "set_volume": return `Add Set Volume and set it to ${Math.round(s.level! * 100)}%.`;
    case "wait": return `Add Wait and set it to ${s.seconds} second${s.seconds === 1 ? "" : "s"}.`;
    case "speak": return `Add Speak Text and type ${q(s.text!)}.`;
    case "show_result": return `Add Show Result and type ${q(s.text!)}.`;
    case "alert": return `Add Show Alert${s.title ? ` with the title ${q(s.title)}` : ""} and the message ${q(s.message!)}.`;
    case "comment": return `Add Comment and type ${q(s.text!)}.`;
    case "set_focus": return `Add Set Focus, choose ${s.mode ? q(s.mode) : "Do Not Disturb"} and turn it ${s.on === false ? "Off" : "On"}.`;
  }
}

// ─── the file: a binary property list ─────────────────────────────────────

/** A number that must be written as a real, not an integer (a volume of 1.0). */
export class PlistReal {
  constructor(readonly value: number) {}
}

type PlistValue = string | number | boolean | PlistReal | PlistValue[] | { [k: string]: PlistValue };

interface Node {
  t: "bool" | "int" | "real" | "str" | "arr" | "dict";
  v?: unknown;
  items?: number[];
  keys?: number[];
}

/** Encode a value as bplist00. Strings, numbers, booleans, arrays and dictionaries; enough for a workflow. */
export function encodeBplist(root: PlistValue): Buffer {
  const nodes: Node[] = [];
  const add = (v: PlistValue): number => {
    const idx = nodes.length;
    nodes.push({ t: "bool" });
    const node = nodes[idx]!;
    if (typeof v === "boolean") { node.t = "bool"; node.v = v; }
    else if (v instanceof PlistReal) { node.t = "real"; node.v = v.value; }
    else if (typeof v === "number") { if (Number.isInteger(v)) { node.t = "int"; node.v = v; } else { node.t = "real"; node.v = v; } }
    else if (typeof v === "string") { node.t = "str"; node.v = v; }
    else if (Array.isArray(v)) { node.t = "arr"; node.items = v.map((x) => add(x)); }
    else {
      node.t = "dict";
      const entries = Object.entries(v);
      node.keys = entries.map(([k]) => add(k));
      node.items = entries.map(([, x]) => add(x));
    }
    return idx;
  };
  add(root);
  const refSize = nodes.length < 256 ? 1 : nodes.length < 65536 ? 2 : 4;
  const uint = (n: number, size: number): Buffer => {
    const b = Buffer.alloc(size);
    if (size === 8) b.writeBigUInt64BE(BigInt(n));
    else b.writeUIntBE(n, 0, size);
    return b;
  };
  const marker = (high: number, len: number): Buffer => {
    if (len < 15) return Buffer.from([high | len]);
    const size = len < 256 ? 1 : len < 65536 ? 2 : 4;
    return Buffer.concat([Buffer.from([high | 0x0f, 0x10 | Math.log2(size)]), uint(len, size)]);
  };
  const parts: Buffer[] = [Buffer.from("bplist00")];
  const offsets: number[] = [];
  let pos = 8;
  for (const n of nodes) {
    offsets.push(pos);
    let b: Buffer;
    if (n.t === "bool") b = Buffer.from([n.v ? 0x09 : 0x08]);
    else if (n.t === "int") {
      const v = n.v as number;
      if (v >= 0 && v < 256) b = Buffer.from([0x10, v]);
      else if (v >= 0 && v < 65536) b = Buffer.concat([Buffer.from([0x11]), uint(v, 2)]);
      else if (v >= 0 && v < 4294967296) b = Buffer.concat([Buffer.from([0x12]), uint(v, 4)]);
      else {
        const eight = Buffer.alloc(8);
        eight.writeBigInt64BE(BigInt(v));
        b = Buffer.concat([Buffer.from([0x13]), eight]);
      }
    } else if (n.t === "real") {
      const eight = Buffer.alloc(8);
      eight.writeDoubleBE(n.v as number);
      b = Buffer.concat([Buffer.from([0x23]), eight]);
    } else if (n.t === "str") {
      const s = n.v as string;
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(s)) b = Buffer.concat([marker(0x50, s.length), Buffer.from(s, "ascii")]);
      else {
        const le = Buffer.from(s, "utf16le");
        const be = Buffer.alloc(le.length);
        for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]!; be[i + 1] = le[i]!; }
        b = Buffer.concat([marker(0x60, le.length / 2), be]);
      }
    } else if (n.t === "arr") b = Buffer.concat([marker(0xa0, n.items!.length), ...n.items!.map((i) => uint(i, refSize))]);
    else b = Buffer.concat([marker(0xd0, n.items!.length), ...n.keys!.map((i) => uint(i, refSize)), ...n.items!.map((i) => uint(i, refSize))]);
    parts.push(b);
    pos += b.length;
  }
  const offsetSize = pos < 256 ? 1 : pos < 65536 ? 2 : pos < 4294967296 ? 4 : 8;
  const table = Buffer.concat(offsets.map((o) => uint(o, offsetSize)));
  const trailer = Buffer.concat([Buffer.alloc(6), Buffer.from([offsetSize, refSize]), uint(nodes.length, 8), uint(0, 8), uint(pos, 8)]);
  return Buffer.concat([...parts, table, trailer]);
}

const A = "is.workflow.actions.";
interface Action { WFWorkflowActionIdentifier: string; WFWorkflowActionParameters: { [k: string]: PlistValue } }
const action = (id: string, params: { [k: string]: PlistValue } = {}): Action => ({ WFWorkflowActionIdentifier: `${A}${id}`, WFWorkflowActionParameters: params });

const tokenString = (s: string): PlistValue => ({ Value: { string: s }, WFSerializationType: "WFTextTokenString" });

/** The workflow actions for one step, or null when the step is recipe-only. */
function encodeStep(s: ShortcutStep): Action[] | null {
  switch (s.do) {
    case "text": return [action("gettext", { WFTextActionText: s.text! })];
    case "ask": return [action("ask", { WFAskActionPrompt: s.prompt!, WFInputType: "Text", ...(s.default ? { WFAskActionDefaultAnswer: s.default } : {}) })];
    case "notify": return [action("notification", { WFNotificationActionTitle: s.title!, WFNotificationActionBody: s.body ?? "" })];
    case "open_url": return [action("url", { WFURLActionURL: s.url! }), action("openurl")];
    case "get_url": {
      const params: { [k: string]: PlistValue } = { WFURL: s.url!, WFHTTPMethod: s.method ?? "GET" };
      if (s.json) {
        params.WFHTTPBodyType = "JSON";
        params.WFJSONValues = {
          Value: { WFDictionaryFieldValueItems: Object.entries(s.json).map(([k, v]) => ({ WFItemType: 0, WFKey: tokenString(k), WFValue: tokenString(v) })) },
          WFSerializationType: "WFDictionaryFieldValue",
        };
      }
      return [action("downloadurl", params)];
    }
    case "set_volume": return [action("setvolume", { WFVolume: new PlistReal(s.level!) })];
    case "wait": return [action("delay", { WFDelayTime: s.seconds! })];
    case "speak": return [action("speaktext", { WFText: s.text! })];
    case "show_result": return [action("showresult", { Text: s.text! })];
    case "alert": return [action("alert", { WFAlertActionTitle: s.title ?? "", WFAlertActionMessage: s.message! })];
    case "comment": return [action("comment", { WFCommentActionText: s.text! })];
    case "set_focus": return null;
  }
}

export interface BuiltProposal {
  name: string;
  description?: string;
  steps: ShortcutStep[];
  recipe: string[];
  file: { available: boolean; reason?: string };
}

/** Validate a proposal and build its recipe; says whether a file can be made. */
export function buildProposal(raw: { name: unknown; description?: unknown; steps: unknown }): BuiltProposal {
  const name = text(raw.name, "name", SHORTCUT_NAME_LIMIT, true)!.replace(/\s+/g, " ").trim();
  const description = text(raw.description, "description", 300, false)?.trim();
  const steps = normalizeSteps(raw.steps);
  const recipe = steps.map((s, i) => `${i + 1}. ${describeStep(s)}`);
  const blocked = steps.findIndex((s) => encodeStep(s) === null);
  return {
    name,
    ...(description ? { description } : {}),
    steps,
    recipe,
    file: blocked >= 0 ? { available: false, reason: `Step ${blocked + 1} (${steps[blocked]!.do.replace("_", " ")}) has no file encoding; follow the recipe.` } : { available: true },
  };
}

/** The unsigned .shortcut bytes, or null when a step is recipe-only. */
export function buildShortcutFile(steps: readonly ShortcutStep[]): Buffer | null {
  const actions: Action[] = [];
  for (const s of steps) {
    const a = encodeStep(s);
    if (!a) return null;
    actions.push(...a);
  }
  return encodeBplist({
    WFWorkflowActions: actions as unknown as PlistValue,
    WFWorkflowClientVersion: "2605.0.5",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: ["WFStringContentItem"],
    WFWorkflowTypes: [],
  });
}

export function shortcutFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shortcut";
  return `${base}.shortcut`;
}
