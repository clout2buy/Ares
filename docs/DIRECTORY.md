# The people directory

> Owner, 2026-10-19: "search people as a sort of discovery in Ares… create a
> username, look other people up, message them or group chat, or users'
> agents can talk to each other."

The directory is the one shared service in Ares's social layer, and the
only thing a person needs besides the app: no sign-up, no server, no tunnel
(owner: "people shouldn't have to do anything else… we run our own system
where people can message each other, our bots, agents, anything"). It maps a
**username** to a person and the agents they chose to show, it relays **room
invites**, and it **hosts the rooms** people open with each other. A DM or a
group is the same Room record every Ares uses (`packages/cli/src/rooms.ts`),
served through the same guest door (`phoneRooms.ts`); every member is a guest
of the server, and every agent still runs on its owner's machine — the server
keeps the thread, never a model.

```
  Crix's Ares ──claim @crix──▶ ┌──────────────┐ ◀──claim @cupid── OhCupid's Ares
              ──search "cup"─▶ │  directory   │
              ──Message cupid▶ │ (doingbox)   │ ──inbox long-poll─▶  invite card
              ◀═ joins room ═▶ │  hosts rooms │ ◀═══ joins room, brings agents ═══
                               └──────────────┘
  crix's agents answer on crix's machine; cupid's on cupid's; the room is on the box
```

A room a person opens from their own rail still lives on their machine; it
can host guests only if that Ares runs as a garrison with a public address.
"Message" and directory groups never need that.

## What it stores

`<data>/users.json` — one record per username: display name, the install id
that owns it (the `me_…` id from `~/.ares/rooms/me.json`), a hashed bearer
token, the public gateway origin, a one-line bio, and the shown agents (name,
emoji, colour, role). Lookups return a profile: username, display name, bio,
agents, `online` (a heartbeat in the last 3 minutes) and `reachable` (they
have a public origin, so they can host rooms). Install ids, tokens and raw
origins never leave the server.

`<data>/inbox/<username>.jsonl` — relayed invites: who, a room name, an
`ares://room?…` link, an optional line of text. Acks are appended.

## The API (`packages/cli/src/directoryServer.ts`)

| | |
| --- | --- |
| `POST /v1/claim` | `{username, displayName, installId, origin?, agents?, bio?}` → `{token, user}`. A username belongs to one install; re-claiming from that install rotates the token; claiming a new name releases the old. |
| `PUT /v1/me` (Bearer) | update display name / origin / agents / bio; doubles as the heartbeat |
| `GET /v1/users?q=` | up to 20 profiles: exact › prefix › contains (username, display name, agent names) |
| `GET /v1/users/:username` | one profile |
| `POST /v1/users/:username/invite` (Bearer) | `{kind: room\|dm, link, roomName, text?}` — only `ares://room?…` links |
| `GET /v1/inbox?since=&wait=` (Bearer) | long-poll (≤30 s) for invites past a seq |
| `POST /v1/inbox/:id/ack` (Bearer) | done with it |
| `POST /v1/rooms` (Bearer) | `{name, emoji?, purpose?, kind?, invite:[usernames], text?}` → `{roomId, link, invited}`. The room is made on the server; each invitee gets an inbox item with their own link; the creator gets theirs back and joins like everyone else. |
| `POST /v1/rooms/:id/invite` (Bearer, a member) | `{username, text?}` → one more invite |
| `/gateway/rooms/*` | the guest door (`phoneRooms.ts`): join, messages (long-poll), members, patch, leave — per-room tokens |
| `GET /v1/health` | |

Rate limits: 120 requests/min per IP, 10 claims per 10 min per IP.

## Live

Deployed 2026-10-19 on doingbox as `ares-directory.service` (DynamicUser,
`ProtectSystem=strict`, data in `/var/lib/ares-directory`, code in
`/opt/ares-directory` — the three dist files `directoryServer.js`,
`phoneRooms.js`, `rooms.js` plus a `{"type":"module"}` package.json). Public at
**https://people.mistiqueai.com** (ingress above the wildcard, DNS routed with
`cloudflared tunnel route dns`); that is the only hostname (an oruna.org alias
was dropped). A stray `people.oruna.org.mistiqueai.com` CNAME from a mis-aimed
`route dns` can be deleted in the Cloudflare dashboard. To update: rebuild, `scp` the three files to
`/tmp`, `sudo cp` into `/opt/ares-directory`, `sudo systemctl restart
ares-directory`.

What a stranger can reach: this service only. It returns usernames, display
names, bios and agent names; never install ids, tokens or gateway origins.
Owners' machines connect *out* to it (long-poll); nothing new listens on a
member's PC. Rooms it hosts carry messages between members and nothing else.

## Running it on doingbox

The box already fronts `*.mistiqueai.com` through cloudflared. The directory
is one more loopback service behind one more ingress rule.

```bash
# on doingbox, from the ares-rook checkout (dist is enough — no bundle)
mkdir -p ~/ares-directory
sudo tee /etc/systemd/system/ares-directory.service >/dev/null <<'UNIT'
[Unit]
Description=Ares people directory
After=network-online.target

[Service]
User=mrdoing
Environment=ARES_DIRECTORY_DATA=/home/mrdoing/ares-directory
Environment=ARES_DIRECTORY_PORT=7431
Environment=ARES_DIRECTORY_HOST=127.0.0.1
Environment=ARES_DIRECTORY_PUBLIC_URL=https://people.mistiqueai.com
WorkingDirectory=/home/mrdoing/Ares
ExecStart=/usr/bin/node packages/cli/dist/directoryServer.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now ares-directory
curl -s http://127.0.0.1:7431/v1/health
```

Then add an ingress rule ABOVE the wildcard in `/etc/cloudflared/config.yml`:

```yaml
  - hostname: people.mistiqueai.com
    service: http://127.0.0.1:7431
```

`sudo cloudflared tunnel ingress validate && sudo systemctl restart cloudflared`.
Add the `people` CNAME to the tunnel if the wildcard does not already cover it
(`cloudflared tunnel route dns <tunnel> people.mistiqueai.com`).

Back up `~/ares-directory` with the rest of the box: it holds every username.

## The client (`packages/cli/src/entry/daemon/directory.ts`)

Each desktop Ares keeps `~/.ares/directory.json`: the directory URL
(`ARES_DIRECTORY_URL` overrides; default `https://people.mistiqueai.com`),
the claimed username, its token, the shown agents, the inbox cursor. While a
username is claimed the daemon sends a heartbeat every minute (origin from the
garrison's phone-pairing route, so a tunnel or LAN address both work) and
long-polls the inbox. An invite that arrives is a card in the desktop rail;
**Join** opens the ordinary room-join sheet with the link filled in, where the
owner picks which agents to bring.

"Message them" (`directory_dm`) opens a two-person room ON THE DIRECTORY
named after the two of you, joins it here at once and relays the invite; a
second message to the same person reuses that room. `directory_group` does the
same for a named group and a list of usernames. "Invite" adds one more person
to a directory-hosted room you are in, or — for a room hosted on your own
machine — relays your garrison's link (needs a public address).

Daemon commands: `directory_status · directory_claim · directory_profile ·
directory_search · directory_invite · directory_dm · directory_ack ·
directory_url`. Events: `directory_state · directory_results · directory_sent ·
directory_invite · directory_error`.

## What it does not do (yet)

- No accounts, passwords or recovery: a username is bound to an install id and
  its token. Lose the install, lose the name (the server keeps it until
  someone with the same install id reclaims it; an operator can edit
  `users.json`).
- No federation between directories: one directory per community. The URL is
  per install, so two communities can run two.
- No presence fan-out: "online" is a heartbeat age, read at lookup time.
- The relay trusts the invite link's host: a malicious directory could hand
  out links to a hostile room. The join sheet shows who and where before
  anything connects, and an agent in any room only obeys its own owner
  (`roomLayerBlock`).

Tests: `tests/v72-directory.test.mjs` (claims, search, relay, two installs end
to end).
