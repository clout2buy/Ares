// Godot 4 text-scene (.tscn) parser + writer.
//
// The editor bridge is the preferred path, but agents usually work with the
// editor closed, so Ares must be able to read AND edit scenes on disk without
// corrupting them. The format is line-oriented:
//
//   [gd_scene load_steps=3 format=3 uid="uid://..."]
//   [ext_resource type="Script" path="res://player.gd" id="1_abc"]
//   [sub_resource type="BoxShape3D" id="BoxShape3D_xyz"]
//   size = Vector3(1, 2, 1)
//   [node name="Player" type="CharacterBody3D"]
//   script = ExtResource("1_abc")
//   [node name="Mesh" type="MeshInstance3D" parent="."]
//   [connection signal="pressed" from="Button" to="." method="_on_pressed"]
//
// We keep every block's raw property lines so a round-trip of an untouched
// scene is byte-identical except for load_steps, which we recompute.

const HEADER_RE = /^\[(\w+)((?:\s+[\w/]+=(?:"(?:[^"\\]|\\.)*"|\[[^\]]*\]|[^\s\]]+))*)\s*\]\s*$/;
const ATTR_RE = /([\w/]+)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|[^\s\]]+)/g;

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(ATTR_RE)) {
    const raw = m[2];
    attrs[m[1]] = raw.startsWith('"') ? JSON.parse(raw.replace(/\\\n/g, "\\n")) : coerceScalar(raw);
  }
  return attrs;
}

function coerceScalar(raw) {
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(raw)) return Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function quote(value) {
  return JSON.stringify(String(value));
}

/** Parse .tscn text into blocks. Unknown block kinds are preserved verbatim. */
export function parseTscn(text) {
  const lines = text.split(/\r?\n/);
  const doc = { header: null, extResources: [], subResources: [], nodes: [], connections: [], editable: [], other: [] };
  let current = null;
  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      const kind = m[1];
      const attrs = parseAttrs(m[2] ?? "");
      current = { kind, attrs, props: [] };
      switch (kind) {
        case "gd_scene":
        case "gd_resource":
          doc.header = current;
          break;
        case "ext_resource":
          doc.extResources.push(current);
          break;
        case "sub_resource":
          doc.subResources.push(current);
          break;
        case "node":
          doc.nodes.push(current);
          break;
        case "connection":
          doc.connections.push(current);
          break;
        case "editable":
          doc.editable.push(current);
          break;
        default:
          doc.other.push(current);
      }
      continue;
    }
    if (!current) {
      if (line.trim()) doc.other.push({ kind: "_raw", attrs: {}, props: [line] });
      continue;
    }
    if (line.trim() === "" && current.props.length === 0) continue;
    current.props.push(line);
  }
  // Trim trailing blank prop lines so serialization controls spacing.
  for (const block of [...doc.extResources, ...doc.subResources, ...doc.nodes, ...doc.connections, ...doc.other]) {
    while (block.props.length && block.props[block.props.length - 1].trim() === "") block.props.pop();
  }
  return doc;
}

/** Attribute values that must be written unquoted (instance=ExtResource("1"), groups=[...]). */
class RawLiteral {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

function serializeHeader(kind, attrs) {
  const parts = [kind];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (v instanceof RawLiteral) parts.push(`${k}=${v.text}`);
    else if (typeof v === "string" && (k === "instance" || k === "groups") && /^(ExtResource|\[)/.test(v)) parts.push(`${k}=${v}`);
    else parts.push(`${k}=${typeof v === "string" ? quote(v) : String(v)}`);
  }
  return `[${parts.join(" ")}]`;
}

/** Serialize a parsed document back to .tscn text. */
export function serializeTscn(doc) {
  const out = [];
  const header = doc.header ?? { kind: "gd_scene", attrs: { format: 3 }, props: [] };
  const steps = 1 + doc.extResources.length + doc.subResources.length;
  const headerAttrs = { ...header.attrs };
  if (steps > 1) headerAttrs.load_steps = steps;
  else delete headerAttrs.load_steps;
  // Godot writes load_steps before format; keep that order for clean diffs.
  const ordered = {};
  if (headerAttrs.load_steps !== undefined) ordered.load_steps = headerAttrs.load_steps;
  ordered.format = headerAttrs.format ?? 3;
  for (const [k, v] of Object.entries(headerAttrs)) if (!(k in ordered)) ordered[k] = v;
  out.push(serializeHeader(header.kind, ordered));
  out.push("");
  const emit = (block) => {
    out.push(serializeHeader(block.kind, block.attrs));
    for (const p of block.props) out.push(p);
    out.push("");
  };
  for (const b of doc.extResources) {
    out.push(serializeHeader(b.kind, b.attrs));
  }
  if (doc.extResources.length) out.push("");
  for (const b of doc.subResources) emit(b);
  for (const b of doc.nodes) emit(b);
  for (const b of doc.connections) {
    out.push(serializeHeader(b.kind, b.attrs));
  }
  if (doc.connections.length) out.push("");
  for (const b of doc.editable) out.push(serializeHeader(b.kind, b.attrs));
  for (const b of doc.other) {
    if (b.kind === "_raw") out.push(...b.props);
    else emit(b);
  }
  while (out.length > 1 && out[out.length - 1] === "" && out[out.length - 2] === "") out.pop();
  return out.join("\n").replace(/\n*$/, "\n");
}

/** Path of a node block relative to the scene root ("." for the root). */
export function nodePath(block) {
  const parent = block.attrs.parent;
  if (parent === undefined) return ".";
  if (parent === ".") return String(block.attrs.name);
  return `${parent}/${block.attrs.name}`;
}

function parentOf(path) {
  if (path === ".") return null;
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/** Parse "key = value" property lines into an object (values kept as raw literals). */
export function propsOf(block) {
  const props = {};
  let pending = null;
  for (const line of block.props) {
    if (pending) {
      pending.value += "\n" + line;
      if (balanced(pending.value)) {
        props[pending.key] = pending.value;
        pending = null;
      }
      continue;
    }
    const m = line.match(/^([\w/:.]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (balanced(m[2])) props[m[1]] = m[2];
    else pending = { key: m[1], value: m[2] };
  }
  if (pending) props[pending.key] = pending.value;
  return props;
}

function balanced(text) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return depth <= 0 && !inStr;
}

/** A readable summary of a scene: tree, scripts, instances, connections. */
export function summarizeTscn(doc, { withProps = true } = {}) {
  const extById = new Map(doc.extResources.map((r) => [String(r.attrs.id), r.attrs]));
  const resolveExt = (literal) => {
    const m = String(literal).match(/ExtResource\("([^"]+)"\)/);
    return m ? extById.get(m[1]) ?? null : null;
  };
  const nodes = doc.nodes.map((block) => {
    const props = propsOf(block);
    const info = {
      name: block.attrs.name,
      type: block.attrs.type ?? (block.attrs.instance ? "(instance)" : "(inherited)"),
      path: nodePath(block),
      parent: parentOf(nodePath(block)),
    };
    if (block.attrs.instance) {
      const ext = resolveExt(block.attrs.instance);
      info.instance = ext?.path ?? String(block.attrs.instance);
    }
    if (props.script) {
      const ext = resolveExt(props.script);
      info.script = ext?.path ?? props.script;
    }
    if (block.attrs.groups) info.groups = block.attrs.groups;
    if (withProps) {
      const shown = {};
      for (const [k, v] of Object.entries(props)) {
        if (k === "script") continue;
        shown[k] = v.length > 200 ? v.slice(0, 200) + "…" : v;
      }
      if (Object.keys(shown).length) info.props = shown;
    }
    return info;
  });
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const children = new Map();
  for (const n of nodes) {
    if (n.parent === null) continue;
    const list = children.get(n.parent) ?? [];
    list.push(n);
    children.set(n.parent, list);
  }
  const toTree = (n) => {
    const kids = children.get(n.path) ?? [];
    const { parent: _p, ...rest } = n;
    return kids.length ? { ...rest, children: kids.map(toTree) } : rest;
  };
  const root = byPath.get(".");
  return {
    format: doc.header?.attrs.format ?? null,
    uid: doc.header?.attrs.uid ?? null,
    nodeCount: nodes.length,
    tree: root ? toTree(root) : null,
    scripts: doc.extResources.filter((r) => r.attrs.type === "Script").map((r) => r.attrs.path),
    resources: doc.extResources.filter((r) => r.attrs.type !== "Script" && r.attrs.type !== "PackedScene").map((r) => ({ type: r.attrs.type, path: r.attrs.path })),
    instances: doc.extResources.filter((r) => r.attrs.type === "PackedScene").map((r) => r.attrs.path),
    connections: doc.connections.map((c) => ({ signal: c.attrs.signal, from: c.attrs.from, to: c.attrs.to, method: c.attrs.method })),
  };
}

// ---- editing --------------------------------------------------------------

function randomId() {
  return Math.random().toString(36).slice(2, 7);
}

/** Ensure an ext_resource for `resPath` exists; return its id. */
export function ensureExtResource(doc, type, resPath) {
  const existing = doc.extResources.find((r) => r.attrs.path === resPath && r.attrs.type === type);
  if (existing) return String(existing.attrs.id);
  const n = doc.extResources.length + 1;
  const id = `${n}_${randomId()}`;
  doc.extResources.push({ kind: "ext_resource", attrs: { type, path: resPath, id }, props: [] });
  return id;
}

/** Convert a JS value (from JSON) into a .tscn literal. Strings that already
 * look like Godot literals (Vector3(...), ExtResource(...), Color(...)) pass
 * through; {"$res": "res://x"} becomes an ExtResource reference. */
export function toLiteral(doc, value, hint = {}) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v) => toLiteral(doc, v)).join(", ")}]`;
  if (typeof value === "object") {
    if (value.$res) {
      const type = value.type ?? guessResourceType(value.$res);
      return `ExtResource("${ensureExtResource(doc, type, value.$res)}")`;
    }
    if (value.$var) return String(value.$var);
    const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${toLiteral(doc, v)}`);
    return `{\n${entries.join(",\n")}\n}`;
  }
  const s = String(value);
  if (/^(Vector[234]i?|Color|Rect2i?|Transform[23]D|Basis|Quaternion|Plane|AABB|NodePath|StringName|ExtResource|SubResource|Packed\w+Array|Object)\s*\(/.test(s)) return s;
  if (/^&"/.test(s) || /^\^"/.test(s)) return s;
  if (s.startsWith("res://") && (hint.resource || /\.(gd|cs|tscn|tres|res|png|jpg|jpeg|webp|svg|glb|gltf|obj|wav|ogg|mp3|ttf|material|shader|gdshader)$/i.test(s))) {
    return `ExtResource("${ensureExtResource(doc, hint.type ?? guessResourceType(s), s)}")`;
  }
  return JSON.stringify(s);
}

export function guessResourceType(resPath) {
  const ext = resPath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "gd":
    case "cs":
      return "Script";
    case "tscn":
    case "scn":
      return "PackedScene";
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "svg":
    case "bmp":
      return "Texture2D";
    case "wav":
    case "ogg":
    case "mp3":
      return "AudioStream";
    case "glb":
    case "gltf":
    case "fbx":
    case "dae":
    case "blend":
      return "PackedScene";
    case "obj":
      return "ArrayMesh"; // Godot's OBJ importer yields a mesh resource (instance via node.add type:"res://x.obj" for a scene)
    case "gdshader":
      return "Shader";
    case "tres":
    case "res":
      return "Resource";
    case "ttf":
    case "otf":
      return "FontFile";
    default:
      return "Resource";
  }
}

export function findNode(doc, path) {
  const want = normalizePath(path);
  return doc.nodes.find((b) => nodePath(b) === want) ?? null;
}

function normalizePath(path) {
  let p = String(path ?? ".").trim();
  if (p === "" || p === "/" ) return ".";
  if (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** Set properties on a node block: existing keys are replaced in place (so
 * diffs stay minimal), new keys are appended, `undefined` deletes. */
export function setProps(doc, block, props) {
  const existing = propsOf(block);
  const literal = (k, v) => `${k} = ${toLiteral(doc, v, { type: k === "script" ? "Script" : undefined })}`;
  const rebuilt = [];
  const done = new Set();
  for (const [k, v] of Object.entries(existing)) {
    if (Object.prototype.hasOwnProperty.call(props, k)) {
      done.add(k);
      if (props[k] !== undefined) rebuilt.push(literal(k, props[k]));
    } else rebuilt.push(`${k} = ${v}`);
  }
  for (const [k, v] of Object.entries(props)) {
    if (done.has(k) || v === undefined) continue;
    rebuilt.push(literal(k, v));
  }
  block.props = rebuilt;
  return block;
}

/** Add a node. `type` may be a ClassDB name or a res://*.tscn to instance. */
export function addNode(doc, { parent = ".", type = "Node", name, props = {}, script, groups }) {
  const parentPath = normalizePath(parent);
  if (parentPath !== "." && !findNode(doc, parentPath)) throw new Error(`parent node not found: ${parentPath}`);
  if (!name) name = type.includes("/") ? type.split("/").pop().replace(/\.tscn$/, "") : type;
  name = uniqueName(doc, parentPath, name);
  const attrs = { name };
  if (type.startsWith("res://")) {
    attrs.parent = parentPath;
    attrs.instance = `ExtResource("${ensureExtResource(doc, "PackedScene", type)}")`;
  } else {
    attrs.type = type;
    if (doc.nodes.length > 0) attrs.parent = parentPath;
  }
  if (groups?.length) attrs.groups = `[${groups.map((g) => JSON.stringify(g)).join(", ")}]`;
  const block = { kind: "node", attrs, props: [] };
  if (attrs.instance) block.attrs.instance = new RawLiteral(String(attrs.instance));
  if (attrs.groups) block.attrs.groups = new RawLiteral(attrs.groups);
  // Insert after the parent's last descendant so Godot reads parents first.
  let index = doc.nodes.length;
  if (parentPath !== "." || doc.nodes.length) {
    const parentIndex = doc.nodes.findIndex((b) => nodePath(b) === parentPath);
    index = parentIndex + 1;
    while (index < doc.nodes.length && isDescendant(nodePath(doc.nodes[index]), parentPath)) index++;
  }
  doc.nodes.splice(index, 0, block);
  const merged = { ...props };
  if (script) merged.script = { $res: script, type: "Script" };
  if (Object.keys(merged).length) setProps(doc, block, merged);
  return { path: nodePath(block), block };
}

function isDescendant(path, ancestor) {
  if (ancestor === ".") return path !== ".";
  return path.startsWith(ancestor + "/");
}

function uniqueName(doc, parentPath, name) {
  const siblings = new Set(doc.nodes.filter((b) => parentOf(nodePath(b)) === parentPath).map((b) => String(b.attrs.name)));
  if (!siblings.has(name)) return name;
  let i = 2;
  while (siblings.has(`${name}${i}`)) i++;
  return `${name}${i}`;
}

export function removeNode(doc, path) {
  const target = normalizePath(path);
  if (target === ".") throw new Error("refusing to remove the scene root");
  const before = doc.nodes.length;
  doc.nodes = doc.nodes.filter((b) => {
    const p = nodePath(b);
    return p !== target && !isDescendant(p, target);
  });
  doc.connections = doc.connections.filter((c) => {
    const from = normalizePath(c.attrs.from);
    const to = normalizePath(c.attrs.to);
    return ![from, to].some((p) => p === target || isDescendant(p, target));
  });
  return before - doc.nodes.length;
}

export function renameNode(doc, path, newName) {
  const block = findNode(doc, path);
  if (!block) throw new Error(`node not found: ${path}`);
  const oldPath = nodePath(block);
  block.attrs.name = newName;
  const newPath = nodePath(block);
  for (const b of doc.nodes) {
    if (b.attrs.parent && (b.attrs.parent === oldPath || b.attrs.parent.startsWith(oldPath + "/"))) {
      b.attrs.parent = newPath + b.attrs.parent.slice(oldPath.length);
    }
  }
  for (const c of doc.connections) {
    for (const key of ["from", "to"]) {
      if (c.attrs[key] === oldPath || String(c.attrs[key]).startsWith(oldPath + "/")) {
        c.attrs[key] = newPath + String(c.attrs[key]).slice(oldPath.length);
      }
    }
  }
  return newPath;
}

export function connectSignal(doc, { from, signal, to, method, flags }) {
  const f = normalizePath(from);
  const t = normalizePath(to);
  if (!findNode(doc, f)) throw new Error(`from node not found: ${f}`);
  if (!findNode(doc, t)) throw new Error(`to node not found: ${t}`);
  const exists = doc.connections.some((c) => normalizePath(c.attrs.from) === f && c.attrs.signal === signal && normalizePath(c.attrs.to) === t && c.attrs.method === method);
  if (exists) return false;
  const attrs = { signal, from: f, to: t, method };
  if (flags) attrs.flags = flags;
  doc.connections.push({ kind: "connection", attrs, props: [] });
  return true;
}

export function attachScript(doc, path, scriptPath) {
  const block = findNode(doc, path);
  if (!block) throw new Error(`node not found: ${path}`);
  setProps(doc, block, { script: { $res: scriptPath, type: "Script" } });
  return nodePath(block);
}

/** Build a brand-new scene document with a single root node. */
export function newScene(rootType, rootName, props = {}) {
  const doc = { header: { kind: "gd_scene", attrs: { format: 3 }, props: [] }, extResources: [], subResources: [], nodes: [], connections: [], editable: [], other: [] };
  addNode(doc, { type: rootType, name: rootName, props });
  return doc;
}

/** Parse a Godot variant literal like "Vector3(1, 2.5, -3)" into {type, values}. */
export function parseVariant(text) {
  if (typeof text === "number") return { type: "float", values: [text] };
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\w+)\((.*)\)$/s);
  if (!m) {
    const n = Number(text);
    return Number.isFinite(n) ? { type: "float", values: [n] } : null;
  }
  const values = m[2].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  return { type: m[1], values };
}
