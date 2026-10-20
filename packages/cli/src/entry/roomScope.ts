// Rooms — the Rooms tool's host (the daemon registers it), process-wide.
//
// Like agentScope.ts for agents: the tool runs inside an agent's turn, far
// from the daemon's command loop, and needs one synchronous answer to "which
// room is this session a seat in?" plus a way to post. The daemon's engine
// (daemon/rooms.ts) implements RoomsHost and sets it here.

export interface RoomCard {
  id: string;
  name: string;
  emoji?: string;
  purpose: string;
  members: Array<{ kind: "agent" | "person"; name: string; mine: boolean; muted?: boolean }>;
  paused: boolean;
}

export interface RoomJobCard {
  id: string;
  title: string;
  owner?: string;
  status: string;
  due?: string;
  links: string[];
  note?: string;
}

export interface RoomsHost {
  /** The room this session is a seat in (undefined: not a room thread). */
  roomOf(sessionId: string): RoomCard | undefined;
  /** Every room the asking agent is a member of (or all, for plain Ares). */
  list(sessionId: string): RoomCard[];
  /** Post as the agent sitting in this session. */
  say(sessionId: string, text: string, roomId?: string): Promise<{ room: RoomCard; seq: number }>;
  /** Stay quiet this turn (the turn's final text is NOT posted). */
  pass(sessionId: string): void;
  /** Add or change a job on the room's board. */
  job(sessionId: string, spec: { id?: string; title?: string; owner?: string; status?: string; due?: string; link?: string; note?: string }, roomId?: string): Promise<{ job: RoomJobCard; board: RoomJobCard[] }>;
  /** Replace the room's shared notes (what the group agreed). */
  note(sessionId: string, text: string, roomId?: string): Promise<void>;
  /** The board, as cards. */
  board(sessionId: string, roomId?: string): RoomJobCard[];
  /** Put a file from this machine into the room's shared files (kept by the
   *  room's host; every member's agents read the same copy). */
  share(sessionId: string, filePath: string, name?: string, roomId?: string): Promise<{ room: RoomCard; name: string; url: string | null; updated: boolean; rev: number }>;
  /** Hand real work to the agent's full-model work thread for this room. */
  work(sessionId: string, task: string, roomId?: string): Promise<{ room: RoomCard; threadId: string }>;
  /** Pull a shared file down into this machine's copy of the room folder. */
  fetch(sessionId: string, name: string, roomId?: string): Promise<{ room: RoomCard; path: string; size: number; url: string | null }>;
  /** The room's shared files, with their links. */
  files(sessionId: string, roomId?: string): Promise<{ room: RoomCard; files: Array<{ name: string; size: number; at: string; url: string | null }> }>;
  /** The last messages of a room, as lines ("who: text"), oldest first. */
  read(sessionId: string, roomId?: string, limit?: number): Promise<{ room: RoomCard; lines: string[] }>;
}

let host: RoomsHost | undefined;

export function setRoomsHost(next: RoomsHost | undefined): void {
  host = next;
}

export function roomsHost(): RoomsHost | undefined {
  return host;
}
