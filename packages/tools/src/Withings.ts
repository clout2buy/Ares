// Withings — weight, body composition, activity and sleep from the owner's
// Withings devices, through their own registered Withings app (oauth-app).
//
// Every data call is an "action" webservice on https://wbsapi.withings.net,
// POSTed as a form with `Authorization: Bearer`, answering HTTP 200 with
// `{status, body}` — status 0 is success, anything else is an error (401 an
// invalid token). API reference: https://developer.withings.com/api-reference/
//   POST /measure     action=getmeas     meastypes, category=1, startdate/enddate (epoch s)
//   POST /v2/measure  action=getactivity startdateymd, enddateymd, data_fields
//   POST /v2/sleep    action=getsummary  startdateymd, enddateymd, data_fields
// A measure's real value is value × 10^unit (weight 7215, unit -2 → 72.15 kg).
// Tokens come from the generic OAuth module (WITHINGS_OAUTH handles the
// requesttoken quirk and the rotating refresh token).

import { z } from "zod";
import { getValidAccessToken, WITHINGS_OAUTH } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";

const API = "https://wbsapi.withings.net";

/** Withings measure type codes → label and unit. */
export const MEAS_TYPES: Record<number, { key: string; unit: string }> = {
  1: { key: "weight", unit: "kg" },
  5: { key: "fat_free_mass", unit: "kg" },
  6: { key: "fat_ratio", unit: "%" },
  8: { key: "fat_mass", unit: "kg" },
  9: { key: "diastolic_bp", unit: "mmHg" },
  10: { key: "systolic_bp", unit: "mmHg" },
  11: { key: "heart_rate", unit: "bpm" },
  76: { key: "muscle_mass", unit: "kg" },
  77: { key: "hydration", unit: "kg" },
  88: { key: "bone_mass", unit: "kg" },
};

const inputSchema = z
  .object({
    action: z.enum(["measurements", "activity", "sleep"]).describe("measurements: weight, body composition, blood pressure, heart rate. activity: steps/calories per day. sleep: nightly sleep summary."),
    days: z.number().int().positive().max(90).default(7).describe("How many days back to look."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface WithingsOutput {
  measurements?: Array<{ date: string } & Record<string, number | string>>;
  activity?: Array<Record<string, unknown>>;
  sleep?: Array<Record<string, unknown>>;
  message: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** One Withings action call. Exported for tests. */
export async function withingsCall(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, any>> {
  const token = await getValidAccessToken(WITHINGS_OAUTH);
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    ...(signal ? { signal } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: number; body?: Record<string, any>; error?: string };
  if (!res.ok) throw new Error(`Withings: HTTP ${res.status}`);
  if (json.status !== 0) {
    const hint = json.status === 401 ? " — the connection expired; call Connect service \"withings\" again" : "";
    throw new Error(`Withings: ${json.error ?? `status ${json.status}`}${hint}`);
  }
  return json.body ?? {};
}

export function decodeMeasureGroups(groups: Array<Record<string, any>>): Array<{ date: string } & Record<string, number | string>> {
  return groups.map((g) => {
    const row: { date: string } & Record<string, number | string> = { date: new Date(Number(g.date) * 1000).toISOString() };
    for (const m of Array.isArray(g.measures) ? g.measures : []) {
      const type = MEAS_TYPES[Number(m.type)];
      if (!type) continue;
      row[type.key] = Math.round(Number(m.value) * 10 ** Number(m.unit) * 100) / 100;
    }
    return row;
  });
}

const SLEEP_FIELDS = "total_sleep_time,sleep_score,deepsleepduration,remsleepduration,lightsleepduration,wakeupcount,hr_average,sleep_efficiency";

export const WithingsTool = buildTool<typeof inputSchema, WithingsOutput>({
  name: "Withings",
  description:
    "The owner's Withings health data: measurements (weight, fat %, muscle, blood pressure, heart rate), daily activity (steps, distance, calories) and nightly sleep summaries. " +
    "If Withings isn't connected, call Connect service \"withings\" first.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  watchdogTimeoutMs: 30_000,
  activityDescription: (input) => `Reading Withings ${input.action}`,
  async call(input: Input, ctx): Promise<ToolResult<WithingsOutput>> {
    const now = new Date();
    const since = new Date(now.getTime() - input.days * 86_400_000);
    try {
      switch (input.action) {
        case "measurements": {
          const body = await withingsCall("/measure", {
            action: "getmeas",
            meastypes: Object.keys(MEAS_TYPES).join(","),
            category: "1",
            startdate: String(Math.floor(since.getTime() / 1000)),
            enddate: String(Math.floor(now.getTime() / 1000)),
          }, ctx.signal);
          const measurements = decodeMeasureGroups((body.measuregrps as Array<Record<string, any>>) ?? []).sort((a, b) => b.date.localeCompare(a.date));
          const latest = measurements.find((m) => m.weight !== undefined);
          const message = measurements.length
            ? `${measurements.length} measurement(s) in ${input.days} days.${latest ? ` Latest weight ${latest.weight} kg${latest.fat_ratio !== undefined ? `, fat ${latest.fat_ratio}%` : ""} (${latest.date.slice(0, 10)}).` : ""}`
            : `No measurements in the last ${input.days} days.`;
          return okResult({ measurements, message });
        }
        case "activity": {
          const body = await withingsCall("/v2/measure", {
            action: "getactivity",
            startdateymd: ymd(since),
            enddateymd: ymd(now),
            data_fields: "steps,distance,calories,totalcalories,active,hr_average",
          }, ctx.signal);
          const activity = ((body.activities as Array<Record<string, any>>) ?? []).map((a) => ({ date: a.date, steps: a.steps, distanceM: a.distance, calories: a.calories, totalCalories: a.totalcalories, activeSeconds: a.active }));
          const message = activity.length ? activity.map((a) => `${a.date}: ${a.steps ?? 0} steps`).join("; ") : `No activity in the last ${input.days} days.`;
          return okResult({ activity, message });
        }
        case "sleep": {
          const body = await withingsCall("/v2/sleep", { action: "getsummary", startdateymd: ymd(since), enddateymd: ymd(now), data_fields: SLEEP_FIELDS }, ctx.signal);
          const sleep = ((body.series as Array<Record<string, any>>) ?? []).map((s) => ({ date: s.date, ...(s.data ?? {}) }));
          const hours = (sec: unknown) => (typeof sec === "number" ? `${(sec / 3600).toFixed(1)} h` : "?");
          const message = sleep.length
            ? sleep.map((s: Record<string, any>) => `${s.date}: ${hours(s.total_sleep_time)}${s.sleep_score !== undefined ? `, score ${s.sleep_score}` : ""}`).join("; ")
            : `No sleep data in the last ${input.days} days.`;
          return okResult({ sleep, message });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failResult<WithingsOutput>(message.startsWith("OAUTH_") ? message.replace(/^OAUTH_[A-Z_]+: /, "") : message);
    }
  },
});
