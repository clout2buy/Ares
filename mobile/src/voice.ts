// Voice on the phone: hold to talk (16 kHz mono WAV → the box transcribes),
// and spoken replies (the box synthesizes mp3 → played here). Both ride the
// phone API on the gateway origin.

import { AudioModule, AudioQuality, IOSOutputFormat, createAudioPlayer, setAudioModeAsync, type RecordingOptions } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

/** What the Google Speech API wants: LINEAR16, 16 kHz, one channel. */
export const RECORDING: RecordingOptions = {
  extension: ".wav",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 256_000,
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: {
    extension: ".wav",
    outputFormat: "default",
    audioEncoder: "default",
  },
  web: {},
};

export async function ensureMicrophone(): Promise<boolean> {
  const status = await AudioModule.requestRecordingPermissionsAsync();
  if (!status.granted) return false;
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  return true;
}

export async function afterRecording(): Promise<void> {
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
}

/** Ship a finished recording to the box; back comes the text. */
export async function transcribeFile(origin: string, token: string, uri: string): Promise<string> {
  const audio = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const res = await fetch(`${origin}/gateway/stt`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ audio, encoding: "LINEAR16", sampleRateHertz: 16_000 }),
  });
  if (!res.ok) throw new Error(`stt ${res.status}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}

let current: ReturnType<typeof createAudioPlayer> | undefined;

/** Speak a reply. A new one interrupts whatever is still talking. */
export async function speak(origin: string, token: string, text: string): Promise<void> {
  const res = await fetch(`${origin}/gateway/tts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  const body = (await res.json()) as { audio?: string };
  if (!body.audio) return;
  const file = `${FileSystem.cacheDirectory ?? ""}ares-say-${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(file, body.audio, { encoding: FileSystem.EncodingType.Base64 });
  stopSpeaking();
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  current = createAudioPlayer({ uri: file });
  current.play();
}

export function stopSpeaking(): void {
  try {
    current?.remove();
  } catch {
    /* already gone */
  }
  current = undefined;
}
