// Google Slides — make and read decks.
//
// A slide is added with the TITLE_AND_BODY layout and its two placeholders
// mapped to object ids WE choose, so the title and body text land in the
// layout's own boxes in the same batchUpdate — no second round trip to
// discover what Google named them. Private to the owner: no ask.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { GOOGLE_API, capText, googleJson } from "./googleApi.js";

const inputSchema = z.object({
  action: z.enum(["create", "add_slide", "read"]).describe(
    "create: a new deck (title). add_slide: append a slide with a title and body text. read: every slide's text.",
  ),
  presentation_id: z.string().optional().describe("The deck's id — add_slide/read."),
  title: z.string().optional().describe("create: the deck title. add_slide: the slide title."),
  body: z.string().optional().describe("add_slide: body text (newlines become separate lines/bullets)."),
});

type Input = z.infer<typeof inputSchema>;

export interface GoogleSlidesOutput {
  presentation?: { id: string; title: string; url: string };
  slideId?: string;
  slides?: Array<{ index: number; text: string }>;
  message: string;
}

interface TextEl { textRun?: { content?: string } }
interface PageElement { shape?: { text?: { textElements?: TextEl[] } }; table?: { tableRows?: Array<{ tableCells?: Array<{ text?: { textElements?: TextEl[] } }> }> } }
interface Presentation { presentationId: string; title?: string; slides?: Array<{ objectId: string; pageElements?: PageElement[] }> }

const deckUrl = (id: string) => `https://docs.google.com/presentation/d/${id}/edit`;
const objectId = (tag: string) => `ares_${tag}_${randomBytes(6).toString("hex")}`;

/** The requests that append one titled slide. Exported for tests. */
export function addSlideRequests(title: string | undefined, body: string | undefined, ids = { slide: objectId("s"), title: objectId("t"), body: objectId("b") }): unknown[] {
  const requests: unknown[] = [
    {
      createSlide: {
        objectId: ids.slide,
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: ids.title },
          { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: ids.body },
        ],
      },
    },
  ];
  if (title) requests.push({ insertText: { objectId: ids.title, insertionIndex: 0, text: title } });
  if (body) requests.push({ insertText: { objectId: ids.body, insertionIndex: 0, text: body } });
  return requests;
}

function elementsText(els: TextEl[] | undefined): string {
  return (els ?? []).map((e) => e.textRun?.content ?? "").join("");
}

export function slideTexts(p: Presentation): Array<{ index: number; text: string }> {
  return (p.slides ?? []).map((slide, i) => {
    const parts: string[] = [];
    for (const el of slide.pageElements ?? []) {
      const t = elementsText(el.shape?.text?.textElements).trim();
      if (t) parts.push(t);
      for (const row of el.table?.tableRows ?? []) parts.push((row.tableCells ?? []).map((c) => elementsText(c.text?.textElements).trim()).join("\t"));
    }
    return { index: i + 1, text: parts.join("\n") };
  });
}

export const GoogleSlidesTool = buildTool<typeof inputSchema, GoogleSlidesOutput>({
  name: "GoogleSlides",
  description:
    "Google Slides: create a presentation, add a slide with a title and body, or read every slide's text. Requires Google connected via Connect.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "create": return `Creating deck: ${input.title ?? ""}`;
      case "add_slide": return `Adding slide: ${input.title ?? ""}`;
      case "read": return "Reading a deck";
      default: return "Google Slides";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleSlidesOutput>> {
    const fail = (message: string): ToolResult<GoogleSlidesOutput> => ({ output: { message }, display: message });
    switch (input.action) {
      case "create": {
        if (!input.title) return fail("title is required for create.");
        const p = await googleJson<Presentation>("Slides", `${GOOGLE_API.slides}/presentations`, { method: "POST", body: JSON.stringify({ title: input.title }) });
        const presentation = { id: p.presentationId, title: p.title ?? input.title, url: deckUrl(p.presentationId) };
        return { output: { presentation, message: `Created "${presentation.title}" — ${presentation.url}. Add slides with add_slide.` }, display: `Created ${presentation.title}` };
      }
      case "add_slide": {
        if (!input.presentation_id) return fail("presentation_id is required for add_slide.");
        if (!input.title && !input.body) return fail("add_slide needs a title or body.");
        const requests = addSlideRequests(input.title, input.body);
        const slideId = (requests[0] as { createSlide: { objectId: string } }).createSlide.objectId;
        await googleJson("Slides", `${GOOGLE_API.slides}/presentations/${encodeURIComponent(input.presentation_id)}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
        return { output: { slideId, message: `Added slide "${input.title ?? ""}" — ${deckUrl(input.presentation_id)}` }, display: "Slide added" };
      }
      case "read": {
        if (!input.presentation_id) return fail("presentation_id is required for read.");
        const p = await googleJson<Presentation>("Slides", `${GOOGLE_API.slides}/presentations/${encodeURIComponent(input.presentation_id)}`);
        const slides = slideTexts(p);
        const text = slides.map((s) => `— Slide ${s.index} —\n${s.text}`).join("\n\n");
        return { output: { presentation: { id: p.presentationId, title: p.title ?? "", url: deckUrl(p.presentationId) }, slides, message: `${p.title ?? ""}\n\n${capText(text, 40_000)}` }, display: `${slides.length} slides` };
      }
      default:
        return fail("Unknown action.");
    }
  },
});
