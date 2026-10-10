// Google Forms — build a form, add questions, publish it, read responses.
//
// Since mid-2026 a form created through the API starts UNPUBLISHED (Google's
// "granular controls for responders"), so create + add questions is private
// drafting and runs freely; `publish` is the step that puts the form in front
// of the world and starts collecting other people's answers — that one asks.
// forms.create accepts only a title, so a description rides a follow-up
// updateFormInfo in the same call.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { GOOGLE_API, googleJson } from "./googleApi.js";

const question = z.object({
  title: z.string().describe("The question text."),
  type: z.enum(["short_text", "paragraph", "multiple_choice", "checkboxes", "dropdown", "scale", "date"]).optional().describe("Default short_text."),
  options: z.array(z.string()).optional().describe("Choices for multiple_choice / checkboxes / dropdown."),
  required: z.boolean().optional(),
  low: z.number().int().optional().describe("scale: lowest value (default 1)."),
  high: z.number().int().optional().describe("scale: highest value (default 5)."),
});

const inputSchema = z.object({
  action: z.enum(["create", "add_questions", "get", "publish", "responses"]).describe(
    "create: a new (unpublished) form with a title and optional description. add_questions: append questions. " +
    "get: the form's questions and links. publish: open it to respondents — asks first. responses: read submitted answers.",
  ),
  form_id: z.string().optional().describe("The form id — everything except create."),
  title: z.string().optional().describe("create: the form title."),
  description: z.string().optional().describe("create: the description shown under the title."),
  questions: z.array(question).optional().describe("add_questions: the questions to append, in order."),
  max_results: z.number().optional().describe("responses: max responses (default 50)."),
});

type Input = z.infer<typeof inputSchema>;
type Question = z.infer<typeof question>;

interface FormItem { itemId?: string; title?: string; questionItem?: { question?: { questionId?: string } } }
interface Form { formId: string; info?: { title?: string; description?: string }; responderUri?: string; items?: FormItem[] }
interface FormResponse { responseId: string; lastSubmittedTime?: string; respondentEmail?: string; answers?: Record<string, { questionId?: string; textAnswers?: { answers?: Array<{ value?: string }> } }> }

export interface GoogleFormsOutput {
  form?: { id: string; title: string; editUrl: string; responderUrl?: string };
  questions?: Array<{ id?: string; title: string }>;
  responses?: Array<{ id: string; submittedAt?: string; answers: Record<string, string> }>;
  message: string;
}

const editUrl = (id: string) => `https://docs.google.com/forms/d/${id}/edit`;

/** One question → the Forms API `question` object. Exported for tests. */
export function formQuestion(q: Question): Record<string, unknown> {
  const base = { required: Boolean(q.required) };
  switch (q.type ?? "short_text") {
    case "paragraph": return { ...base, textQuestion: { paragraph: true } };
    case "multiple_choice": return { ...base, choiceQuestion: { type: "RADIO", options: (q.options ?? []).map((value) => ({ value })) } };
    case "checkboxes": return { ...base, choiceQuestion: { type: "CHECKBOX", options: (q.options ?? []).map((value) => ({ value })) } };
    case "dropdown": return { ...base, choiceQuestion: { type: "DROP_DOWN", options: (q.options ?? []).map((value) => ({ value })) } };
    case "scale": return { ...base, scaleQuestion: { low: q.low ?? 1, high: q.high ?? 5 } };
    case "date": return { ...base, dateQuestion: {} };
    default: return { ...base, textQuestion: { paragraph: false } };
  }
}

/** createItem requests that append `questions` after `existing` items. */
export function addQuestionRequests(questions: Question[], existing: number): unknown[] {
  return questions.map((q, i) => ({
    createItem: {
      item: { title: q.title, questionItem: { question: formQuestion(q) } },
      location: { index: existing + i },
    },
  }));
}

function batchUpdate(formId: string, requests: unknown[]): Promise<unknown> {
  return googleJson("Forms", `${GOOGLE_API.forms}/forms/${encodeURIComponent(formId)}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
}

export const GoogleFormsTool = buildTool<typeof inputSchema, GoogleFormsOutput>({
  name: "GoogleForms",
  description:
    "Google Forms: create a form, add questions (text, paragraph, multiple choice, checkboxes, dropdown, scale, date), " +
    "publish it to respondents, and read responses. Requires Google connected via Connect.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  async checkPermissions(input) {
    if (input.action === "publish")
      return { kind: "ask", prompt: `Publish Google Form ${input.form_id ?? "?"} so anyone with the link can respond`, suggestion: "allow_once" };
    return { kind: "allow" };
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "create": return `Creating form: ${input.title ?? ""}`;
      case "add_questions": return `Adding ${input.questions?.length ?? 0} question(s)`;
      case "get": return "Reading a form";
      case "publish": return "Publishing a form";
      case "responses": return "Reading form responses";
      default: return "Google Forms";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleFormsOutput>> {
    const fail = (message: string): ToolResult<GoogleFormsOutput> => ({ output: { message }, display: message });
    switch (input.action) {
      case "create": {
        if (!input.title) return fail("title is required for create.");
        const form = await googleJson<Form>("Forms", `${GOOGLE_API.forms}/forms`, { method: "POST", body: JSON.stringify({ info: { title: input.title } }) });
        if (input.description) await batchUpdate(form.formId, [{ updateFormInfo: { info: { description: input.description }, updateMask: "description" } }]);
        const out = { id: form.formId, title: input.title, editUrl: editUrl(form.formId), ...(form.responderUri ? { responderUrl: form.responderUri } : {}) };
        return { output: { form: out, message: `Created form "${input.title}" (unpublished) — ${out.editUrl}. Add questions, then publish.` }, display: `Created ${input.title}` };
      }
      case "add_questions": {
        if (!input.form_id || !input.questions?.length) return fail("form_id and questions are required for add_questions.");
        const bad = input.questions.find((q) => ["multiple_choice", "checkboxes", "dropdown"].includes(q.type ?? "") && !q.options?.length);
        if (bad) return fail(`"${bad.title}" is a ${bad.type} question with no options.`);
        const form = await googleJson<Form>("Forms", `${GOOGLE_API.forms}/forms/${encodeURIComponent(input.form_id)}`);
        await batchUpdate(input.form_id, addQuestionRequests(input.questions, form.items?.length ?? 0));
        return { output: { message: `Added ${input.questions.length} question(s) — ${editUrl(input.form_id)}` }, display: "Questions added" };
      }
      case "get": {
        if (!input.form_id) return fail("form_id is required for get.");
        const form = await googleJson<Form>("Forms", `${GOOGLE_API.forms}/forms/${encodeURIComponent(input.form_id)}`);
        const questions = (form.items ?? []).map((it) => ({ ...(it.questionItem?.question?.questionId ? { id: it.questionItem.question.questionId } : {}), title: it.title ?? "" }));
        const out = { id: form.formId, title: form.info?.title ?? "", editUrl: editUrl(form.formId), ...(form.responderUri ? { responderUrl: form.responderUri } : {}) };
        return { output: { form: out, questions, message: `${out.title}\n${questions.map((q, i) => `${i + 1}. ${q.title}`).join("\n")}\nEdit: ${out.editUrl}${out.responderUrl ? `\nRespond: ${out.responderUrl}` : ""}` }, display: `${questions.length} questions` };
      }
      case "publish": {
        if (!input.form_id) return fail("form_id is required for publish.");
        await googleJson("Forms", `${GOOGLE_API.forms}/forms/${encodeURIComponent(input.form_id)}:setPublishSettings`, {
          method: "POST",
          body: JSON.stringify({ publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } }, updateMask: "publishState" }),
        });
        const form = await googleJson<Form>("Forms", `${GOOGLE_API.forms}/forms/${encodeURIComponent(input.form_id)}`);
        return { output: { form: { id: form.formId, title: form.info?.title ?? "", editUrl: editUrl(form.formId), ...(form.responderUri ? { responderUrl: form.responderUri } : {}) }, message: `Published and accepting responses: ${form.responderUri ?? editUrl(form.formId)}` }, display: "Form published" };
      }
      case "responses": {
        if (!input.form_id) return fail("form_id is required for responses.");
        const id = encodeURIComponent(input.form_id);
        const [form, data] = await Promise.all([
          googleJson<Form>("Forms", `${GOOGLE_API.forms}/forms/${id}`),
          googleJson<{ responses?: FormResponse[] }>("Forms", `${GOOGLE_API.forms}/forms/${id}/responses?pageSize=${Math.min(input.max_results ?? 50, 5000)}`),
        ]);
        const titles = new Map<string, string>();
        for (const it of form.items ?? []) if (it.questionItem?.question?.questionId) titles.set(it.questionItem.question.questionId, it.title ?? "");
        const responses = (data.responses ?? []).map((r) => ({
          id: r.responseId,
          ...(r.lastSubmittedTime ? { submittedAt: r.lastSubmittedTime } : {}),
          answers: Object.fromEntries(Object.entries(r.answers ?? {}).map(([qid, a]) => [titles.get(qid) ?? qid, (a.textAnswers?.answers ?? []).map((x) => x.value ?? "").join(", ")])),
        }));
        const lines = responses.map((r) => `${r.submittedAt ?? ""}\n${Object.entries(r.answers).map(([q, a]) => `  ${q}: ${a}`).join("\n")}`);
        return { output: { responses, message: responses.length ? `${responses.length} response(s)\n\n${lines.join("\n\n")}` : "No responses yet." }, display: `${responses.length} responses` };
      }
      default:
        return fail("Unknown action.");
    }
  },
});
