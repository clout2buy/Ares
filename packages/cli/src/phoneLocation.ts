// Location triggers: "when I arrive at / leave a place, do this".
//
//   GET    /gateway/location                    {places, rules, limits, recent}   everything the screen needs, one trip
//   GET    /gateway/location/places             {places, limits}
//   POST   /gateway/location/places             {id?, name, lat, lon, radiusM?} → 201 {place} (200 when id updates one)
//   DELETE /gateway/location/places/<id>[?cascade=1]
//                                               200 {ok, removedRules} · 409 while rules still use it
//   GET    /gateway/location/rules              {rules, limits}
//   POST   /gateway/location/rules              {id?, placeId, transition, instruction, agentId?, name?, days?,
//                                                between?, quiet?, once?, enabled?} → 201 {rule} (200 on update)
//   DELETE /gateway/location/rules/<id>         200 {ok}
//   POST   /gateway/location/event              {placeId, transition: enter|exit, at?, deviceId?, timeZone?}
//                                               200 {ok, matched, fired[], skipped[], deduped?}
//   GET    /gateway/location/recent             {events[]}   what the last events did
//
// The phone owns the geofences (iOS region monitoring) and reports crossings
// here; this file owns what a crossing MEANS. A matching rule starts an owner
// turn in its agent's thread, which is the same door a phone message uses, so
// the remote-autonomy gate applies unchanged: anything dangerous is put to the
// owner's phone for approval, never auto-approved. Around that door:
//   - the owner pause stops every rule (the event is recorded as skipped),
//   - one rule fires at most once per DEDUPE_MS, whatever the phone resends,
//   - at most MAX_FIRES_PER_HOUR rules fire in an hour,
//   - an event older than STALE_EVENT_MS never fires (a queued arrival from
//     yesterday must not run today's errand),
//   - every decision, fired or skipped, lands in the audit trail.
//
// Honest limit, enforced here and explained in the app: iOS monitors at most
// 20 regions per app. A place is a region only while an enabled rule uses it,
// so what is capped is the distinct places used by enabled rules.
//
// Files, under <home>/location/: places.json, rules.json, recent.json.

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  HttpError,
  clipText,
  formatClock,
  inClockWindow,
  isValidTimeZone,
  newId,
  parseClock,
  readJsonFile,
  readJsonObject,
  resolveTimeZone,
  sendJson,
  writeJsonFile,
  zonedParts,
} from "./phoneCommon.js";

// ─── Contract ─────────────────────────────────────────────────────────────

export const MAX_PLACES = 50;
export const MAX_RULES = 100;
/** What iOS allows an app to monitor at once. */
export const IOS_REGION_CAP = 20;
export const MIN_RADIUS_M = 100;
export const MAX_RADIUS_M = 5_000;
export const DEFAULT_RADIUS_M = 150;
export const DEDUPE_MS = 10 * 60_000;
export const EVENT_DEDUPE_MS = 60_000;
export const STALE_EVENT_MS = 15 * 60_000;
export const MAX_FIRES_PER_HOUR = 12;
const MAX_EVENTS_PER_MINUTE = 60;
/** How long a rule's turn gets to refuse before it is treated as started. */
const ADMIT_MS = 1_500;
const RECENT_KEPT = 40;

export type Transition = "enter" | "exit";

export interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  createdAt: string;
}

export interface ClockWindow {
  from: string;
  to: string;
}

export interface LocationRule {
  id: string;
  name: string;
  placeId: string;
  transition: Transition;
  /** "ares" or a persona id: the agent whose thread runs it. */
  agentId: string;
  instruction: string;
  /** 0 = Sunday … 6 = Saturday. Absent = every day. */
  days?: number[];
  /** Only fire inside this window (local time where the phone is). */
  between?: ClockWindow;
  /** Never fire inside this window. */
  quiet?: ClockWindow;
  /** Fire once, then switch itself off. */
  once: boolean;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
  fireCount: number;
  /** Set when a one-shot rule has run. */
  completedAt?: string;
}

export interface LocationLimits {
  maxPlaces: number;
  maxRules: number;
  /** iOS's own ceiling on monitored regions. */
  regionCap: number;
  /** Distinct places enabled rules use right now. */
  regionsInUse: number;
}

export type SkipReason = "paused" | "disabled" | "stale" | "days" | "outside_window" | "quiet_hours" | "deduped" | "rate_limited" | "failed" | "completed";

export interface EventResult {
  ok: true;
  matched: number;
  fired: Array<{ ruleId: string; name: string }>;
  skipped: Array<{ ruleId: string; name: string; reason: SkipReason }>;
  deduped?: boolean;
}

export interface RecentEvent {
  at: string;
  placeId: string;
  placeName: string;
  transition: Transition;
  deviceId?: string;
  fired: number;
  skipped: Array<{ ruleId: string; reason: SkipReason }>;
}

// ─── Validation ───────────────────────────────────────────────────────────

const PLACE_ID_RE = /^pl_[a-f0-9]{10}$/;
const RULE_ID_RE = /^lr_[a-f0-9]{10}$/;

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function validatePlaceInput(body: Record<string, unknown>, existing?: Place): Omit<Place, "id" | "createdAt"> {
  const rawName = body.name ?? existing?.name;
  const name = clipText(rawName, 200);
  if (!name || name.length > 40) throw new HttpError(400, "name is required (up to 40 characters)");
  const lat = finite(body.lat ?? existing?.lat);
  const lon = finite(body.lon ?? existing?.lon);
  if (lat === undefined || lat < -90 || lat > 90) throw new HttpError(400, "lat must be a number between -90 and 90");
  if (lon === undefined || lon < -180 || lon > 180) throw new HttpError(400, "lon must be a number between -180 and 180");
  const radius = body.radiusM === undefined ? (existing?.radiusM ?? DEFAULT_RADIUS_M) : finite(body.radiusM);
  if (radius === undefined || radius < MIN_RADIUS_M || radius > MAX_RADIUS_M) {
    throw new HttpError(400, `radiusM must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} metres (iOS cannot watch a smaller circle reliably)`);
  }
  return { name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, radiusM: Math.round(radius) };
}

function windowOf(v: unknown, field: string): ClockWindow | undefined | null {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, `${field} must be {from, to} like {"from":"22:00","to":"07:00"}`);
  const o = v as Record<string, unknown>;
  const from = parseClock(o.from);
  const to = parseClock(o.to);
  if (from === undefined || to === undefined) throw new HttpError(400, `${field}.from and ${field}.to must look like 07:30`);
  if (from === to) throw new HttpError(400, `${field} must not start and end at the same time`);
  return { from: formatClock(from), to: formatClock(to) };
}

export interface RuleCheck {
  place: (id: string) => Place | undefined;
  knownAgent: (id: string) => boolean;
}

export function validateRuleInput(body: Record<string, unknown>, check: RuleCheck, existing?: LocationRule): Omit<LocationRule, "id" | "createdAt" | "fireCount" | "lastFiredAt" | "completedAt"> {
  const placeId = typeof (body.placeId ?? existing?.placeId) === "string" ? String(body.placeId ?? existing?.placeId) : "";
  const place = check.place(placeId);
  if (!place) throw new HttpError(400, "placeId must be one of your places");
  const transition = body.transition ?? existing?.transition;
  if (transition !== "enter" && transition !== "exit") throw new HttpError(400, "transition must be enter or exit");
  const instruction = typeof (body.instruction ?? existing?.instruction) === "string" ? String(body.instruction ?? existing?.instruction).trim() : "";
  if (instruction.length < 2) throw new HttpError(400, "instruction is required");
  if (instruction.length > 1000) throw new HttpError(400, "instruction must be at most 1000 characters");
  const agentId = body.agentId ?? existing?.agentId ?? "ares";
  if (typeof agentId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) throw new HttpError(400, "agentId must be an agent id");
  if (!check.knownAgent(agentId)) throw new HttpError(400, "that agent does not exist");

  let days: number[] | undefined = existing?.days;
  if (body.days !== undefined) {
    if (body.days === null) days = undefined;
    else {
      if (!Array.isArray(body.days) || body.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, "days must be a list of weekday numbers, 0 (Sunday) to 6 (Saturday)");
      const unique = [...new Set(body.days as number[])].sort((a, b) => a - b);
      days = unique.length === 0 || unique.length === 7 ? undefined : unique;
    }
  }
  const between = windowOf(body.between, "between");
  const quiet = windowOf(body.quiet, "quiet");
  const once = body.once === undefined ? (existing?.once ?? false) : body.once;
  const enabled = body.enabled === undefined ? (existing?.enabled ?? true) : body.enabled;
  if (typeof once !== "boolean") throw new HttpError(400, "once must be true or false");
  if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  const name = clipText(body.name, 60) ?? existing?.name ?? `${transition === "enter" ? "Arrive at" : "Leave"} ${place.name}`;
  const finalBetween = between === undefined ? existing?.between : (between ?? undefined);
  const finalQuiet = quiet === undefined ? existing?.quiet : (quiet ?? undefined);
  return {
    name,
    placeId,
    transition,
    agentId,
    instruction,
    ...(days ? { days } : {}),
    ...(finalBetween ? { between: finalBetween } : {}),
    ...(finalQuiet ? { quiet: finalQuiet } : {}),
    once,
    enabled,
  };
}

function normalizePlace(raw: unknown): Place | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !PLACE_ID_RE.test(r.id) || typeof r.name !== "string") return undefined;
  const lat = finite(r.lat);
  const lon = finite(r.lon);
  const radius = finite(r.radiusM);
  if (lat === undefined || lon === undefined || radius === undefined) return undefined;
  return { id: r.id, name: r.name, lat, lon, radiusM: radius, createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString() };
}

function normalizeRule(raw: unknown): LocationRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !RULE_ID_RE.test(r.id) || typeof r.placeId !== "string" || typeof r.instruction !== "string") return undefined;
  if (r.transition !== "enter" && r.transition !== "exit") return undefined;
  const win = (v: unknown): ClockWindow | undefined => {
    const o = v as { from?: unknown; to?: unknown } | undefined;
    return o && parseClock(o.from) !== undefined && parseClock(o.to) !== undefined ? { from: String(o.from), to: String(o.to) } : undefined;
  };
  const days = Array.isArray(r.days) ? (r.days as unknown[]).filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) : undefined;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "Location rule",
    placeId: r.placeId,
    transition: r.transition,
    agentId: typeof r.agentId === "string" ? r.agentId : "ares",
    instruction: r.instruction,
    ...(days && days.length ? { days } : {}),
    ...(win(r.between) ? { between: win(r.between) } : {}),
    ...(win(r.quiet) ? { quiet: win(r.quiet) } : {}),
    once: r.once === true,
    enabled: r.enabled !== false,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
    ...(typeof r.lastFiredAt === "string" ? { lastFiredAt: r.lastFiredAt } : {}),
    fireCount: finite(r.fireCount) ?? 0,
    ...(typeof r.completedAt === "string" ? { completedAt: r.completedAt } : {}),
  };
}

// ─── The turn a rule starts ───────────────────────────────────────────────

/** What the agent receives. The owner wrote the instruction and the place name, so they are trusted; the rest says how this turn came about. */
export function ruleTurnText(input: { rule: LocationRule; place: Place; eventMs: number; timeZone: string }): string {
  const { rule, place } = input;
  const p = zonedParts(input.eventMs, input.timeZone);
  const clock = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: input.timeZone }).format(new Date(input.eventMs));
  return (
    `(System: a location rule just fired: the owner ${rule.transition === "enter" ? "arrived at" : "left"} "${place.name}" at ${clock} on ${weekday}. ` +
    "This started on its own while they are out, so do exactly what their instruction below says, then text them briefly what you did, in your own voice. " +
    "Anything that spends money, sends a message, posts, deletes or changes something important goes through their usual approval on their phone: ask, do not assume, " +
    "and if it is refused, stop and tell them. Do not try another way around a refusal.)\n\n" +
    rule.instruction
  );
}

// ─── The service ──────────────────────────────────────────────────────────

export interface LocationServiceOptions {
  home: string;
  /** Start the turn in the rule's agent thread. Resolves once it is admitted; it does not wait for the turn to finish. */
  fire: (rule: LocationRule, place: Place, text: string, inputId: string) => Promise<void>;
  agents?: { get(id: string): { id: string } | undefined };
  isPaused?: () => boolean;
  audit?: (entry: { actor: string; action: string; target?: string; params?: unknown; result?: string }) => void | Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  maxFiresPerHour?: number;
  /** Overrides how long a turn gets to refuse before it counts as started (tests). */
  admitMs?: number;
}

export class LocationService {
  private readonly dir: string;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fireTimes: number[] = [];
  private readonly seenEvents = new Map<string, number>();
  private readonly arrivals: number[] = [];

  constructor(private readonly opts: LocationServiceOptions) {
    this.dir = path.join(opts.home, "location");
    this.now = opts.now ?? Date.now;
  }

  /** One mutation at a time: every change is read-modify-write on a file. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(fn);
    this.chain = next;
    return next;
  }

  knownAgent = (id: string): boolean => id === "ares" || Boolean(this.opts.agents?.get(id));

  async places(): Promise<Place[]> {
    const raw = await readJsonFile<{ places?: unknown[] }>(path.join(this.dir, "places.json"));
    return (Array.isArray(raw?.places) ? raw!.places : []).flatMap((p) => { const v = normalizePlace(p); return v ? [v] : []; });
  }

  async rules(): Promise<LocationRule[]> {
    const raw = await readJsonFile<{ rules?: unknown[] }>(path.join(this.dir, "rules.json"));
    return (Array.isArray(raw?.rules) ? raw!.rules : []).flatMap((r) => { const v = normalizeRule(r); return v ? [v] : []; });
  }

  private savePlaces(places: Place[]): Promise<void> {
    return writeJsonFile(path.join(this.dir, "places.json"), { version: 1, places });
  }
  private saveRules(rules: LocationRule[]): Promise<void> {
    return writeJsonFile(path.join(this.dir, "rules.json"), { version: 1, rules });
  }

  limitsFor(rules: LocationRule[]): LocationLimits {
    return { maxPlaces: MAX_PLACES, maxRules: MAX_RULES, regionCap: IOS_REGION_CAP, regionsInUse: new Set(rules.filter((r) => r.enabled).map((r) => r.placeId)).size };
  }

  async recent(): Promise<RecentEvent[]> {
    const raw = await readJsonFile<{ events?: RecentEvent[] }>(path.join(this.dir, "recent.json"));
    return Array.isArray(raw?.events) ? raw!.events : [];
  }

  async snapshot(): Promise<{ places: Place[]; rules: LocationRule[]; limits: LocationLimits; recent: RecentEvent[] }> {
    const [places, rules, recent] = await Promise.all([this.places(), this.rules(), this.recent()]);
    return { places, rules, limits: this.limitsFor(rules), recent };
  }

  // ── places ──
  upsertPlace(body: Record<string, unknown>): Promise<{ place: Place; created: boolean }> {
    return this.serial(async () => {
      const places = await this.places();
      const id = typeof body.id === "string" ? body.id : undefined;
      if (id !== undefined && !PLACE_ID_RE.test(id)) throw new HttpError(400, "id is not a place id");
      const existing = id ? places.find((p) => p.id === id) : undefined;
      if (id && !existing) throw new HttpError(404, "no such place");
      const fields = validatePlaceInput(body, existing);
      if (places.some((p) => p.id !== id && p.name.toLowerCase() === fields.name.toLowerCase())) throw new HttpError(409, `you already have a place called ${fields.name}`);
      if (!existing && places.length >= MAX_PLACES) throw new HttpError(409, `you can keep at most ${MAX_PLACES} places`);
      const place: Place = existing ? { ...existing, ...fields } : { id: newId("pl"), ...fields, createdAt: new Date(this.now()).toISOString() };
      await this.savePlaces(existing ? places.map((p) => (p.id === place.id ? place : p)) : [...places, place]);
      return { place, created: !existing };
    });
  }

  removePlace(id: string, cascade: boolean): Promise<{ removedRules: number }> {
    return this.serial(async () => {
      if (!PLACE_ID_RE.test(id)) throw new HttpError(404, "no such place");
      const places = await this.places();
      if (!places.some((p) => p.id === id)) throw new HttpError(404, "no such place");
      const rules = await this.rules();
      const using = rules.filter((r) => r.placeId === id);
      if (using.length > 0 && !cascade) throw new HttpError(409, `${using.length === 1 ? "a rule uses" : `${using.length} rules use`} this place; remove ${using.length === 1 ? "it" : "them"} first, or confirm removing both`);
      if (using.length) await this.saveRules(rules.filter((r) => r.placeId !== id));
      await this.savePlaces(places.filter((p) => p.id !== id));
      return { removedRules: using.length };
    });
  }

  // ── rules ──
  upsertRule(body: Record<string, unknown>): Promise<{ rule: LocationRule; created: boolean }> {
    return this.serial(async () => {
      const [places, rules] = await Promise.all([this.places(), this.rules()]);
      const id = typeof body.id === "string" ? body.id : undefined;
      if (id !== undefined && !RULE_ID_RE.test(id)) throw new HttpError(400, "id is not a rule id");
      const existing = id ? rules.find((r) => r.id === id) : undefined;
      if (id && !existing) throw new HttpError(404, "no such rule");
      const fields = validateRuleInput(body, { place: (pid) => places.find((p) => p.id === pid), knownAgent: this.knownAgent }, existing);
      if (!existing && rules.length >= MAX_RULES) throw new HttpError(409, `you can keep at most ${MAX_RULES} rules`);
      // `fields` already carries the final days/between/quiet (kept, changed or cleared), so start from a copy without them.
      const base: LocationRule | undefined = existing ? { ...existing } : undefined;
      if (base) {
        delete base.days;
        delete base.between;
        delete base.quiet;
        // Turning a finished one-shot back on re-arms it.
        if (fields.enabled) delete base.completedAt;
      }
      const candidate: LocationRule = base
        ? { ...base, ...fields }
        : { id: newId("lr"), ...fields, createdAt: new Date(this.now()).toISOString(), fireCount: 0 };
      const next = existing ? rules.map((r) => (r.id === candidate.id ? candidate : r)) : [...rules, candidate];
      const inUse = this.limitsFor(next).regionsInUse;
      if (candidate.enabled && inUse > IOS_REGION_CAP) {
        throw new HttpError(409, `iOS can watch at most ${IOS_REGION_CAP} places at once, and your enabled rules would use ${inUse}. Turn a rule off, or point rules at places you already use.`);
      }
      await this.saveRules(next);
      return { rule: candidate, created: !existing };
    });
  }

  removeRule(id: string): Promise<void> {
    return this.serial(async () => {
      const rules = await this.rules();
      if (!RULE_ID_RE.test(id) || !rules.some((r) => r.id === id)) throw new HttpError(404, "no such rule");
      await this.saveRules(rules.filter((r) => r.id !== id));
    });
  }

  // ── events ──
  /** The phone crossed a region boundary. */
  handleEvent(body: Record<string, unknown>): Promise<EventResult> {
    return this.serial(async () => {
      const nowMs = this.now();
      this.arrivals.push(nowMs);
      while (this.arrivals.length && nowMs - this.arrivals[0]! > 60_000) this.arrivals.shift();
      if (this.arrivals.length > MAX_EVENTS_PER_MINUTE) throw new HttpError(429, "too many location events");
      const placeId = typeof body.placeId === "string" ? body.placeId : "";
      const transition = body.transition;
      if (transition !== "enter" && transition !== "exit") throw new HttpError(400, "transition must be enter or exit");
      const deviceId = clipText(body.deviceId, 80);
      const places = await this.places();
      const place = places.find((p) => p.id === placeId);
      if (!place) throw new HttpError(404, "unknown place");

      // The phone resends when it is unsure an event landed; the same crossing within a minute is one event.
      const dedupeKey = `${placeId}|${transition}|${deviceId ?? ""}`;
      const seen = this.seenEvents.get(dedupeKey);
      if (seen !== undefined && nowMs - seen < EVENT_DEDUPE_MS) return { ok: true, matched: 0, fired: [], skipped: [], deduped: true };
      this.seenEvents.set(dedupeKey, nowMs);
      if (this.seenEvents.size > 500) for (const [k, t] of this.seenEvents) if (nowMs - t > EVENT_DEDUPE_MS) this.seenEvents.delete(k);

      // When it happened: the phone's stamp if it is believable, else now. A future stamp is the phone's clock being wrong.
      const stamped = typeof body.at === "string" ? Date.parse(body.at) : NaN;
      const eventMs = Number.isFinite(stamped) && stamped <= nowMs + 5 * 60_000 ? Math.min(stamped, nowMs) : nowMs;
      const zone = isValidTimeZone(body.timeZone) ? body.timeZone : resolveTimeZone();

      const rules = await this.rules();
      const result: EventResult = { ok: true, matched: 0, fired: [], skipped: [] };
      const audit = (rule: LocationRule, outcome: string) =>
        void Promise.resolve(this.opts.audit?.({ actor: "location", action: "location.rule", target: rule.name, params: { rule: rule.id, place: place.name, transition, ...(deviceId ? { device: deviceId } : {}) }, result: outcome })).catch(() => undefined);
      const skip = (rule: LocationRule, reason: SkipReason) => {
        result.skipped.push({ ruleId: rule.id, name: rule.name, reason });
        audit(rule, `skipped: ${reason}`);
      };

      let changed = false;
      for (const rule of rules) {
        if (rule.placeId !== placeId || rule.transition !== transition) continue;
        if (!rule.enabled) {
          // A finished one-shot is shown, not silently ignored; a switched-off rule is simply off.
          if (rule.completedAt) { result.matched++; skip(rule, "completed"); }
          continue;
        }
        result.matched++;
        if (process.env.ARES_LOCATION_RULES === "0") { skip(rule, "disabled"); continue; }
        if (this.opts.isPaused?.()) { skip(rule, "paused"); continue; }
        if (nowMs - eventMs > STALE_EVENT_MS) { skip(rule, "stale"); continue; }
        const at = zonedParts(eventMs, zone);
        if (rule.days && !rule.days.includes(at.weekday)) { skip(rule, "days"); continue; }
        const minute = at.hour * 60 + at.minute;
        if (rule.between && !inClockWindow(minute, parseClock(rule.between.from)!, parseClock(rule.between.to)!)) { skip(rule, "outside_window"); continue; }
        if (rule.quiet && inClockWindow(minute, parseClock(rule.quiet.from)!, parseClock(rule.quiet.to)!)) { skip(rule, "quiet_hours"); continue; }
        if (rule.lastFiredAt && nowMs - Date.parse(rule.lastFiredAt) < DEDUPE_MS) { skip(rule, "deduped"); continue; }
        while (this.fireTimes.length && nowMs - this.fireTimes[0]! > 3_600_000) this.fireTimes.shift();
        if (this.fireTimes.length >= (this.opts.maxFiresPerHour ?? MAX_FIRES_PER_HOUR)) { skip(rule, "rate_limited"); continue; }
        // Starting a turn resolves when the turn ENDS, which can be minutes. Only a refusal to start matters
        // here, and that comes back at once; after that the turn runs on without holding the phone's request.
        const started = this.opts
          .fire(rule, place, ruleTurnText({ rule, place, eventMs, timeZone: zone }), `loc_${rule.id}_${Math.floor(eventMs / 60_000)}`)
          .then(() => undefined, (err: unknown) => ({ err }));
        let admitTimer: ReturnType<typeof setTimeout> | undefined;
        const early = await Promise.race([
          started,
          new Promise<"running">((resolve) => {
            admitTimer = setTimeout(() => resolve("running"), this.opts.admitMs ?? ADMIT_MS);
          }),
        ]);
        if (admitTimer) clearTimeout(admitTimer);
        if (early && early !== "running") {
          this.opts.log?.(`location: rule "${rule.name}" could not start (${early.err instanceof Error ? early.err.message : String(early.err)})`);
          skip(rule, "failed");
          continue;
        }
        if (early === "running") {
          void started.then((late) => { if (late) this.opts.log?.(`location: rule "${rule.name}" ended with an error (${late.err instanceof Error ? late.err.message : String(late.err)})`); });
        }
        this.fireTimes.push(nowMs);
        rule.lastFiredAt = new Date(nowMs).toISOString();
        rule.fireCount += 1;
        if (rule.once) {
          rule.enabled = false;
          rule.completedAt = rule.lastFiredAt;
        }
        changed = true;
        result.fired.push({ ruleId: rule.id, name: rule.name });
        audit(rule, "fired");
      }
      if (changed) await this.saveRules(rules);

      const recent = await this.recent();
      const entry: RecentEvent = {
        at: new Date(eventMs).toISOString(),
        placeId,
        placeName: place.name,
        transition,
        ...(deviceId ? { deviceId } : {}),
        fired: result.fired.length,
        skipped: result.skipped.map((s) => ({ ruleId: s.ruleId, reason: s.reason })),
      };
      await writeJsonFile(path.join(this.dir, "recent.json"), { events: [entry, ...recent].slice(0, RECENT_KEPT) });
      return result;
    });
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────

/** Authentication is the caller's (handlePhoneApi's owner bearer check runs before any hook). */
export function createLocationApi(service: LocationService, log: (line: string) => void = () => {}) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/gateway/location" && !url.pathname.startsWith("/gateway/location/")) return false;
    const parts = url.pathname.replace(/^\/gateway\/location\/?/, "").split("/").filter(Boolean);
    const [head, id] = parts;
    const method = req.method ?? "GET";
    const send = (status: number, body: unknown): true => (sendJson(res, status, body), true);
    try {
      if (!head) {
        if (method !== "GET") return send(405, { error: "method not allowed" });
        return send(200, await service.snapshot());
      }
      if (head === "places") {
        if (parts.length > 2) return send(404, { error: "not found" });
        if (!id) {
          if (method === "GET") {
            const { places, limits } = await service.snapshot();
            return send(200, { places, limits });
          }
          if (method === "POST" || method === "PUT") {
            const { place, created } = await service.upsertPlace(await readJsonObject(req, 4 * 1024));
            return send(created ? 201 : 200, { place });
          }
          return send(405, { error: "method not allowed" });
        }
        if (method === "DELETE") {
          const { removedRules } = await service.removePlace(id, url.searchParams.get("cascade") === "1");
          return send(200, { ok: true, removedRules });
        }
        return send(405, { error: "method not allowed" });
      }
      if (head === "rules") {
        if (parts.length > 2) return send(404, { error: "not found" });
        if (!id) {
          if (method === "GET") {
            const { rules, limits } = await service.snapshot();
            return send(200, { rules, limits });
          }
          if (method === "POST" || method === "PUT") {
            const { rule, created } = await service.upsertRule(await readJsonObject(req, 8 * 1024));
            return send(created ? 201 : 200, { rule });
          }
          return send(405, { error: "method not allowed" });
        }
        if (method === "DELETE") {
          await service.removeRule(id);
          return send(200, { ok: true });
        }
        return send(405, { error: "method not allowed" });
      }
      if (head === "event") {
        if (method !== "POST") return send(405, { error: "method not allowed" });
        return send(200, await service.handleEvent(await readJsonObject(req, 2 * 1024)));
      }
      if (head === "recent") {
        if (method !== "GET") return send(405, { error: "method not allowed" });
        return send(200, { events: await service.recent() });
      }
      return send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      log(`location: ${method} ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "location failed" });
      return true;
    }
  };
}

// ─── Firing ───────────────────────────────────────────────────────────────

/** The slice of SessionManager the firer drives (structural; see phoneHooks.ts). */
export interface LocationSessionHost {
  create(opts: { surface?: "mobile"; tenant?: { role: "owner" }; personaId?: string }): { id: string };
  ensureLive(sessionId: string): Promise<unknown | null>;
  send(sessionId: string, text: string, options?: { inputId?: string }): Promise<void>;
}

export interface LocationPersonas {
  store: { get(id: string): { sessionId?: string } | undefined };
  defaultThread(): Promise<string | undefined>;
}

/**
 * Run a rule's instruction in the right thread: its agent's own, or the main
 * phone thread. The same owner-role mobile session a phone message lands in,
 * so the remote permission posture is the one the owner already trusts and
 * anything dangerous asks their phone. Nothing is pre-approved here.
 */
export function makeLocationFirer(deps: { sessions: LocationSessionHost; personas: LocationPersonas }): LocationServiceOptions["fire"] {
  return async (rule, _place, text, inputId) => {
    let sessionId: string | undefined;
    if (rule.agentId !== "ares") {
      const persona = deps.personas.store.get(rule.agentId);
      if (!persona) throw new Error(`agent ${rule.agentId} no longer exists`);
      sessionId = persona.sessionId || deps.sessions.create({ surface: "mobile", tenant: { role: "owner" }, personaId: rule.agentId }).id;
    } else {
      sessionId = (await deps.personas.defaultThread()) ?? deps.sessions.create({ surface: "mobile", tenant: { role: "owner" } }).id;
    }
    const live = await deps.sessions.ensureLive(sessionId);
    if (!live) throw new Error("the target thread could not be opened");
    await deps.sessions.send(sessionId, text, { inputId });
  };
}
