// Key checks for the life-surface connect services (openai, gemini,
// google-places). The connect hub runs these before storing a key, so the
// owner hears "that key doesn't work" on the form, not later from a failed
// image. Each throws a sentence the form shows; the return is the success note.

type Verify = (values: Record<string, string>, signal: AbortSignal) => Promise<string | void>;

export const LIFE_VERIFIERS: Record<string, Verify> = {
  async openai(values, signal) {
    const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${values.OPENAI_API_KEY}` }, signal });
    if (res.status === 401) throw new Error("OpenAI doesn't recognise that key");
    if (!res.ok) throw new Error(`OpenAI answered HTTP ${res.status}`);
    return "";
  },
  async gemini(values, signal) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": values.GEMINI_API_KEY! }, signal });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error("Google doesn't accept that key for the Gemini API");
    if (!res.ok) throw new Error(`Gemini answered HTTP ${res.status}`);
    return "";
  },
  async "google-places"(values, signal) {
    // The cheapest real call: a one-result text search asking only for ids.
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": values.GOOGLE_PLACES_API_KEY!, "x-goog-fieldmask": "places.id" },
      body: JSON.stringify({ textQuery: "coffee", maxResultCount: 1 }),
      signal,
    });
    if (res.status === 403) throw new Error("that key can't use Places API (New) — enable it for the key's project");
    if (res.status === 400 || res.status === 401) throw new Error("Google doesn't accept that key");
    if (!res.ok) throw new Error(`Google Places answered HTTP ${res.status}`);
    return "";
  },
};
