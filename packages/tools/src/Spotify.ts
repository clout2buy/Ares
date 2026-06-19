import { z } from "zod";
import { getValidAccessToken, OAUTH_PROVIDERS } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

const SPOT = "https://api.spotify.com/v1";

const inputSchema = z.object({
  action: z.enum([
    "now_playing", "play", "pause", "skip", "previous", "volume",
    "search", "queue", "recently_played", "playlists", "devices",
  ]).describe(
    "now_playing: what's currently playing. " +
    "play: resume playback or play a specific track/album/playlist URI. " +
    "pause: pause playback. skip/previous: next/prev track. " +
    "volume: set volume 0-100. " +
    "search: find tracks/albums/artists. " +
    "queue: add a track to the queue. " +
    "recently_played: last played tracks. " +
    "playlists: list the owner's playlists. " +
    "devices: list available playback devices.",
  ),
  query: z.string().optional().describe("Search query — for search action."),
  uri: z.string().optional().describe("Spotify URI (spotify:track:xxx) — for play/queue."),
  volume_percent: z.number().optional().describe("Volume 0-100 — for volume action."),
  device_id: z.string().optional().describe("Target device id — optional for play/volume."),
});

type Input = z.infer<typeof inputSchema>;

export interface SpotifyOutput {
  track?: { name: string; artist: string; album: string; uri: string; playing: boolean; progress_ms?: number; duration_ms?: number };
  results?: Array<{ name: string; artist: string; uri: string; type: string }>;
  playlists?: Array<{ name: string; id: string; tracks: number; uri: string }>;
  devices?: Array<{ id: string; name: string; type: string; active: boolean; volume: number }>;
  recently?: Array<{ name: string; artist: string; played_at: string }>;
  message: string;
}

async function spotFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getValidAccessToken(OAUTH_PROVIDERS.spotify);
  const res = await fetch(`${SPOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Spotify API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res;
}

type SpotArtist = { name: string };
type SpotTrack = { name: string; artists: SpotArtist[]; album: { name: string }; uri: string; duration_ms: number };

export const SpotifyTool = buildTool<typeof inputSchema, SpotifyOutput>({
  name: "Spotify",
  description:
    "Control Spotify playback and search music. Play, pause, skip, search tracks, manage queue, see what's playing. " +
    "Requires Spotify to be connected via the Connect tool first.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "now_playing": return "Checking what's playing";
      case "play": return "Playing music";
      case "pause": return "Pausing music";
      case "skip": return "Skipping track";
      case "previous": return "Previous track";
      case "search": return `Searching: ${input.query ?? ""}`;
      default: return "Spotify";
    }
  },
  async call(input: Input): Promise<ToolResult<SpotifyOutput>> {
    switch (input.action) {
      case "now_playing": {
        const res = await spotFetch("/me/player/currently-playing");
        if (res.status === 204) return { output: { message: "Nothing playing right now." }, display: "Nothing playing." };
        const data = await res.json() as { is_playing: boolean; progress_ms: number; item: SpotTrack };
        if (!data.item) return { output: { message: "Nothing playing right now." }, display: "Nothing playing." };
        const track = {
          name: data.item.name,
          artist: data.item.artists.map((a) => a.name).join(", "),
          album: data.item.album.name,
          uri: data.item.uri,
          playing: data.is_playing,
          progress_ms: data.progress_ms,
          duration_ms: data.item.duration_ms,
        };
        return { output: { track, message: `${track.playing ? "▶" : "⏸"} ${track.name} — ${track.artist} (${track.album})` }, display: `${track.name} — ${track.artist}` };
      }

      case "play": {
        const params = input.device_id ? `?device_id=${input.device_id}` : "";
        const body = input.uri
          ? input.uri.includes(":track:")
            ? { uris: [input.uri] }
            : { context_uri: input.uri }
          : undefined;
        await spotFetch(`/me/player/play${params}`, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
        return { output: { message: input.uri ? `Playing ${input.uri}` : "Playback resumed." }, display: "Playing" };
      }

      case "pause": {
        await spotFetch("/me/player/pause", { method: "PUT" });
        return { output: { message: "Paused." }, display: "Paused" };
      }

      case "skip": {
        await spotFetch("/me/player/next", { method: "POST" });
        return { output: { message: "Skipped to next track." }, display: "Skipped" };
      }

      case "previous": {
        await spotFetch("/me/player/previous", { method: "POST" });
        return { output: { message: "Previous track." }, display: "Previous" };
      }

      case "volume": {
        const vol = Math.max(0, Math.min(100, input.volume_percent ?? 50));
        const params = input.device_id ? `&device_id=${input.device_id}` : "";
        await spotFetch(`/me/player/volume?volume_percent=${vol}${params}`, { method: "PUT" });
        return { output: { message: `Volume set to ${vol}%.` }, display: `Volume: ${vol}%` };
      }

      case "search": {
        if (!input.query) return { output: { message: "query is required." }, display: "Missing query." };
        const params = new URLSearchParams({ q: input.query, type: "track,album,artist", limit: "10" });
        const res = await spotFetch(`/search?${params}`);
        const data = await res.json() as {
          tracks?: { items: Array<{ name: string; artists: SpotArtist[]; uri: string }> };
          albums?: { items: Array<{ name: string; artists: SpotArtist[]; uri: string }> };
          artists?: { items: Array<{ name: string; uri: string }> };
        };
        const results: SpotifyOutput["results"] = [];
        for (const t of data.tracks?.items ?? []) results.push({ name: t.name, artist: t.artists.map((a) => a.name).join(", "), uri: t.uri, type: "track" });
        for (const a of data.albums?.items ?? []) results.push({ name: a.name, artist: a.artists.map((x) => x.name).join(", "), uri: a.uri, type: "album" });
        for (const a of data.artists?.items ?? []) results.push({ name: a.name, artist: "", uri: a.uri, type: "artist" });
        const lines = results.slice(0, 15).map((r) => `[${r.type}] ${r.name}${r.artist ? ` — ${r.artist}` : ""} (${r.uri})`);
        return { output: { results, message: lines.join("\n") || "No results." }, display: `${results.length} results` };
      }

      case "queue": {
        if (!input.uri) return { output: { message: "uri is required." }, display: "Missing URI." };
        await spotFetch(`/me/player/queue?uri=${encodeURIComponent(input.uri)}`, { method: "POST" });
        return { output: { message: `Added to queue: ${input.uri}` }, display: "Queued" };
      }

      case "recently_played": {
        const res = await spotFetch("/me/player/recently-played?limit=10");
        const data = await res.json() as { items: Array<{ track: { name: string; artists: SpotArtist[] }; played_at: string }> };
        const recently = data.items.map((i) => ({ name: i.track.name, artist: i.track.artists.map((a) => a.name).join(", "), played_at: i.played_at }));
        const lines = recently.map((r) => `${new Date(r.played_at).toLocaleString()} — ${r.name} by ${r.artist}`);
        return { output: { recently, message: lines.join("\n") || "No recent plays." }, display: `${recently.length} recent tracks` };
      }

      case "playlists": {
        const res = await spotFetch("/me/playlists?limit=25");
        const data = await res.json() as { items: Array<{ name: string; id: string; tracks: { total: number }; uri: string }> };
        const playlists = data.items.map((p) => ({ name: p.name, id: p.id, tracks: p.tracks.total, uri: p.uri }));
        const lines = playlists.map((p) => `${p.name} (${p.tracks} tracks) — ${p.uri}`);
        return { output: { playlists, message: lines.join("\n") || "No playlists." }, display: `${playlists.length} playlists` };
      }

      case "devices": {
        const res = await spotFetch("/me/player/devices");
        const data = await res.json() as { devices: Array<{ id: string; name: string; type: string; is_active: boolean; volume_percent: number }> };
        const devices = data.devices.map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active, volume: d.volume_percent }));
        const lines = devices.map((d) => `${d.active ? "🔊" : "·"} ${d.name} (${d.type}) vol:${d.volume}%`);
        return { output: { devices, message: lines.join("\n") || "No devices found." }, display: `${devices.length} devices` };
      }

      default:
        return { output: { message: "Unknown action." }, display: "Unknown action." };
    }
  },
});
