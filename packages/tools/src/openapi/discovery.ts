// Google API discovery documents (https://www.googleapis.com/discovery/v1/apis/<name>/<version>/rest)
// -> OpenAPI 3. Every Google API (Gmail, Calendar, Drive, Docs, Sheets, Tasks,
// YouTube, People ...) publishes one, and none publishes OpenAPI, so this is what
// lets `Api add` take a Google API by URL, and what the Google preset is curated
// from. Pure data in, data out.

type Json = Record<string, any>;

/** Discovery schemas name their references bare ("Message"); OpenAPI wants a pointer. */
function fixRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(fixRefs);
  if (node && typeof node === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === "$ref" && typeof v === "string") out.$ref = `#/components/schemas/${v}`;
      else if (k === "annotations") continue;
      else out[k] = fixRefs(v);
    }
    return out;
  }
  return node;
}

function paramSchema(pv: Json): Json {
  const base: Json = { type: pv.type ?? "string" };
  if (pv.format) base.format = pv.format;
  if (Array.isArray(pv.enum)) base.enum = pv.enum;
  if (pv.default !== undefined) base.default = pv.type === "integer" || pv.type === "number" ? Number(pv.default) : pv.type === "boolean" ? pv.default === "true" || pv.default === true : pv.default;
  if (pv.minimum !== undefined) base.minimum = Number(pv.minimum);
  if (pv.maximum !== undefined) base.maximum = Number(pv.maximum);
  if (pv.pattern) base.pattern = pv.pattern;
  return pv.repeated ? { type: "array", items: base } : base;
}

export function isDiscoveryDocument(raw: unknown): raw is Json {
  return Boolean(raw && typeof raw === "object" && typeof (raw as Json).discoveryVersion === "string" && (raw as Json).resources !== undefined);
}

export function discoveryToOpenApi(doc: Json): Json {
  const paths: Record<string, Json> = {};
  const servicePath = String(doc.servicePath ?? "").replace(/^\/+/, "");
  const walk = (resources: Json | undefined, trail: string[]): void => {
    for (const [name, res] of Object.entries<Json>(resources ?? {})) {
      for (const [mname, m] of Object.entries<Json>(res.methods ?? {})) {
        const rel = String(m.path ?? m.flatPath ?? "");
        // {+name} is a path variable that may contain slashes (people/me); remember which.
        const reserved = new Set<string>();
        const templated = rel.replace(/\{\+([^}]+)\}/g, (_all, n: string) => {
          reserved.add(n);
          return `{${n}}`;
        });
        // `path` is relative to servicePath; some documents already include it.
        const full = `/${templated.startsWith(servicePath) && servicePath ? "" : servicePath}${templated}`.replace(/\/{2,}/g, "/");
        const parameters = Object.entries<Json>(m.parameters ?? {}).map(([pn, pv]) => ({
          name: pn,
          in: pv.location === "path" ? "path" : "query",
          required: pv.required === true,
          ...(pv.description ? { description: String(pv.description) } : {}),
          schema: paramSchema(pv),
          ...(pv.repeated ? { style: "form", explode: true } : {}),
          ...(reserved.has(pn) ? { "x-reserved": true } : {}),
        }));
        const op: Json = {
          operationId: m.id ?? [...trail, name, mname].join("."),
          summary: String(m.description ?? "").split(/(?<=\.)\s/)[0],
          ...(m.description ? { description: String(m.description) } : {}),
          parameters,
          ...(m.request?.$ref ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${m.request.$ref}` } } } } } : {}),
          responses: { "200": { description: m.response?.$ref ?? "OK" } },
          ...(Array.isArray(m.scopes) ? { "x-scopes": m.scopes } : {}),
        };
        paths[full] ??= {};
        paths[full]![String(m.httpMethod ?? "GET").toLowerCase()] = op;
      }
      walk(res.resources, [...trail, name]);
    }
  };
  walk(doc.resources, []);
  return {
    openapi: "3.0.0",
    info: { title: doc.title ?? doc.name ?? "Google API", version: String(doc.version ?? ""), description: doc.description ?? "" },
    servers: [{ url: String(doc.rootUrl ?? "https://www.googleapis.com/").replace(/\/+$/, "") }],
    components: { schemas: fixRefs(doc.schemas ?? {}) },
    paths,
  };
}
