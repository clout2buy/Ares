// PointMap — Ares designs the Cyber backdrop itself.
//
// The desktop's point cloud is driven by a small spec (shape kind, motion,
// spread, density, size, opacity, colours). This tool lets Ares save a new one
// into the owner's Appearance list, list what is there, or delete one of its
// own. The desktop validates every spec again before it paints, so a wild
// value can never blank the room; the ranges below are the same ones it clamps to.
import { z } from "zod";
import { buildTool } from "@ares/tools";
import { loadUiSettings, updateUiSettings } from "../uiSettings.js";

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "hex colour like #7c5cff");

const input = z
  .object({
    action: z.enum(["list", "save", "delete"]).describe("list the saved maps, save a new one, or delete one by id"),
    id: z.string().regex(/^[a-z0-9_-]{1,48}$/i).optional().describe("for delete, or to overwrite an existing map on save"),
    name: z.string().min(1).max(40).optional().describe("save: the name shown in Appearance"),
    kind: z.enum(["nebula", "horizon", "waves", "orbit"]).optional().describe("save: nebula = volumetric drift; horizon = low bowl; waves = rolling sheet; orbit = rings + shell"),
    density: z.number().int().min(2000).max(16000).optional().describe("save: point count (default 8000)"),
    amplitude: z.number().min(0).max(1).optional().describe("save: surface displacement / cloud spread 0..1"),
    speed: z.number().min(0).max(1).optional().describe("save: drift speed 0..1 (0 = still). Keep it slow; nothing may flash."),
    spread: z.number().min(0.3).max(1.4).optional().describe("save: how much of the room it fills"),
    lift: z.number().min(-1).max(1).optional().describe("save: vertical placement, -1 floor .. 1 ceiling"),
    size: z.number().min(0.4).max(2.5).optional().describe("save: point size multiplier"),
    opacity: z.number().min(0.1).max(1).optional().describe("save: overall opacity"),
    colors: z.union([z.literal("accent"), z.tuple([hex, hex])]).optional().describe("save: 'accent' follows the owner's accent dial, or two hex colours [dark, light]"),
    note: z.string().max(160).optional().describe("save: one line on what it looks like"),
    activate: z.boolean().optional().describe("save: also make it the current backdrop (default true)"),
  })
  .strict();

type Spec = Record<string, unknown>;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "map";
}

export function makePointMapTool() {
  return buildTool({
    name: "PointMap",
    description:
      "The desktop's Cyber BACKDROP / BACKGROUND / point cloud (pointcloud) designs — Settings → Appearance → Point map. " +
      "This is the ONLY way to add a backdrop design: the app draws them from a small spec (shape kind, motion, spread, density, size, opacity, colours) on the GPU. " +
      "NEVER write HTML, three.js or shader files for a backdrop; the app cannot load them. " +
      "Use whenever the owner asks for a new background / backdrop / point cloud / point map look ('generate a pointcloud background', 'surprise me with a backdrop', 'something calmer behind the chat'). " +
      "save writes it into the Appearance list; activate:true also switches the room to it right away; list shows what is saved; delete removes one. " +
      "Design with intent: pick the kind that fits the mood, set colours as two hex values or 'accent', keep speed low (nothing may flash), and say what it looks like in note.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: input,
    activityDescription: (i) => `PointMap ${i.action}${i.name ? ": " + i.name : i.id ? " " + i.id : ""}`,

    async call(i): Promise<{ output: unknown; display: string }> {
      const settings = await loadUiSettings().catch(() => null);
      const maps: Spec[] = Array.isArray(settings?.pointMaps) ? [...settings!.pointMaps!] : [];
      if (i.action === "list") {
        return { output: maps, display: maps.length ? maps.map((m) => `${String(m.id)} · ${String(m.name)} · ${String(m.kind)}${m.note ? " — " + String(m.note) : ""}`).join("\n") : "no saved point maps (the four built-ins always show)" };
      }
      if (i.action === "delete") {
        if (!i.id) throw new Error("delete needs id");
        const next = maps.filter((m) => m.id !== i.id);
        if (next.length === maps.length) return { output: { ok: false }, display: `no saved map "${i.id}"` };
        await updateUiSettings({ pointMaps: next });
        return { output: { ok: true, id: i.id }, display: `deleted point map ${i.id}` };
      }
      if (!i.name) throw new Error("save needs name");
      const id = i.id ?? `${slug(i.name)}-${Math.random().toString(36).slice(2, 7)}`;
      const spec: Spec = {
        id,
        name: i.name,
        by: "ares",
        kind: i.kind ?? "nebula",
        density: i.density ?? 8000,
        amplitude: i.amplitude ?? 0.6,
        speed: i.speed ?? 0.3,
        spread: i.spread ?? 1.1,
        lift: i.lift ?? 0,
        size: i.size ?? 1,
        opacity: i.opacity ?? 0.8,
        colors: i.colors ?? "accent",
        ...(i.note ? { note: i.note } : {}),
      };
      const next = [...maps.filter((m) => m.id !== id), spec];
      const activate = i.activate !== false;
      await updateUiSettings({ pointMaps: next, ...(activate ? { pointMapActivation: { id, at: Date.now() } } : {}) });
      return { output: { ...spec, activated: activate }, display: `saved point map "${i.name}" (${id})${activate ? " and switched the room to it" : ""} — it is listed in Settings → Appearance → Point map` };
    },
  });
}
