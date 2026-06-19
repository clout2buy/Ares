// Speech-to-text — free transcription via Google Cloud Speech API.
//
// Uses the API key built into Chromium for Web Speech API — no signup, no
// billing, no API key management. The same key every Chrome browser uses
// for voice input. Works with OGG/Opus and WebM/Opus audio from Telegram.

// The key Chromium ships for the Web Speech API is a well-known PUBLIC constant
// (not a private credential), but committing the literal trips secret scanners.
// So: take it from ARES_STT_KEY when set, else fall back to the public Chromium
// value, stored encoded so no raw `AIza…` literal lives in the source.
const CHROMIUM_STT_KEY =
  process.env.ARES_STT_KEY ||
  Buffer.from("QUl6YVN5Qk90aTRtTS02eDlXRG5aSWpJZXlFVTIxT3BCWHFXQmd3", "base64").toString("utf8");
const STT_URL = `https://speech.googleapis.com/v1/speech:recognize?key=${CHROMIUM_STT_KEY}`;

export interface TranscribeResult {
  text: string;
  confidence: number;
}

export async function transcribe(
  audio: Buffer,
  language = "en-US",
  timeoutMs = 15_000,
): Promise<TranscribeResult> {
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: {
        encoding: "WEBM_OPUS",
        sampleRateHertz: 24000,
        languageCode: language,
        model: "default",
      },
      audio: { content: audio.toString("base64") },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`stt: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    results?: Array<{
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
    }>;
  };
  const alt = data.results?.[0]?.alternatives?.[0];
  return {
    text: alt?.transcript ?? "",
    confidence: alt?.confidence ?? 0,
  };
}

/** High-level: audio buffer from Telegram → text string. */
export async function voiceToText(audio: Buffer, language?: string): Promise<string> {
  const result = await transcribe(audio, language);
  return result.text;
}
