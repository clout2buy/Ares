// Small helpers shared by the phone Connections modules: making text safe to
// hand to the phone, and the shape of the in-memory "last liveness test" cache.
//
// Nothing here touches the network or the vault. The rule the whole surface
// follows: a response field may describe a credential (present, expired, which
// account) but may never contain one.

/** A liveness test result remembered for the list's `health` field. */
export interface TestRecord {
  ok: boolean;
  detail: string;
  checkedAt: number;
  account?: string;
}

const tests = new Map<string, TestRecord>();

function key(home: string | undefined, id: string): string {
  return `${home ?? ""}\u0000${id}`;
}

export function rememberTest(home: string | undefined, id: string, record: TestRecord): void {
  tests.set(key(home, id), record);
  if (tests.size > 500) {
    const oldest = tests.keys().next().value;
    if (oldest !== undefined) tests.delete(oldest);
  }
}

export function recallTest(home: string | undefined, id: string): TestRecord | undefined {
  return tests.get(key(home, id));
}

export function forgetTest(home: string | undefined, id: string): void {
  tests.delete(key(home, id));
}

const SECRET_SHAPES: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bre_[A-Za-z0-9_]{16,}/g,
  /[?&](?:access_token|token|key|api_key|apikey|code|client_secret)=[^&\s"']+/gi,
  // Any long unbroken token-looking run.
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/**
 * Make provider- or exception-derived text safe for the phone: known secret
 * shapes and every exact secret the caller knows are replaced, control
 * characters are dropped, and the result is clipped. Defence in depth — the
 * callers already avoid putting secrets in messages.
 */
export function safeText(input: unknown, secrets: Array<string | undefined> = [], max = 200): string {
  let text = typeof input === "string" ? input : input instanceof Error ? input.message : String(input ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 6) text = text.split(secret).join("[redacted]");
  }
  for (const re of SECRET_SHAPES) text = text.replace(re, "[redacted]");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An account label worth showing: short, printable, no whitespace runs. */
export function cleanAccount(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.length > 120) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v;
}
