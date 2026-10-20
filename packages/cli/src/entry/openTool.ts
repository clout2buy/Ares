// Open — put a link on the owner's REAL screen, in their real browser.
//
// Owner, 2026-10-20: "bob made a game, but Bop on Cupid's PC and bob on mine
// opened screenshots or served variants instead of what we could play." A
// screenshot is a picture; a tunnel or a local server is a copy only one
// machine can reach. (The Forge is a real browser too — forge_view.rs.) What people want is the link, open in the browser
// they actually use, where the game runs and the multiplayer connects.
//
// From an agent's private chat (or plain Ares) any http(s) link may be opened
// — the owner asked. From a room seat only the room's own shared-file links
// may: other people in the room must never be able to push arbitrary pages
// onto the owner's screen by asking the owner's agent.
import { z } from "zod";
import { buildTool } from "@ares/tools";

export interface OpenHost {
  /** Open the link on the owner's screen. Throws when this session may not. */
  open(sessionId: string, url: string): Promise<void>;
}

let host: OpenHost | undefined;
export function setOpenHost(next: OpenHost | undefined): void {
  host = next;
}

const input = z
  .object({
    url: z.string().min(8).max(2000).describe("the http(s) link to open — e.g. a room file's link (Rooms share / files return them), a deployed site"),
  })
  .strict();

export function makeOpenTool() {
  return buildTool({
    name: "Open",
    description:
      "Open a link in your owner's own web browser (outside Ares), on their screen — when they want it there to play, use or keep. " +
      "Inside Ares, the Forge is a real live browser too (Browser open). Never send a screenshot in place of either. To get something to people in a room, share it (Rooms share) and post the link; " +
      "open it on your owner's screen with this tool when they ask. From a room you can only open that room's shared-file links.",
    safety: "read-only",
    concurrency: "exclusive",
    inputZod: input,
    activityDescription: (i) => `Opening ${i.url.replace(/^https?:\/\//, "").slice(0, 60)}`,
    async call(i, ctx): Promise<{ output: unknown; display: string }> {
      if (!host) throw new Error("opening links is only available in the desktop app");
      if (!/^https?:\/\//i.test(i.url)) throw new Error("only http(s) links can be opened");
      await host.open(ctx?.sessionId ?? "", i.url);
      return { output: { ok: true, url: i.url }, display: `opened ${i.url} in the owner's browser` };
    },
  });
}
