// Spotify Web API - what is playing, search, queue and playback control, the owner's
// playlists, saved music and listening history. Playback control and every library
// or playlist change asks the owner first.
//
// Curated from the vendor's OpenAPI document
// https://developer.spotify.com/reference/web-api/open-api-schema.yaml (fetched
// 2026-09-30: 96 operations; the paths carry the /v1 base). Docs:
// https://developer.spotify.com/documentation/web-api.
//
// Deliberately left out: everything the February 2026 changelog REMOVED for apps in
// development mode (https://developer.spotify.com/documentation/web-api/references/changes/february-2026:
// several-ids lookups, artist top tracks, browse/new releases/categories, other users'
// profiles and playlists, the old /tracks playlist paths, per-type save/follow routes),
// and the endpoints Spotify restricted earlier (recommendations, audio features, audio
// analysis, featured playlists, related artists). Saving, following and removing now
// all go through /me/library by Spotify URI.

import { JSON_BODY, arrOf, bool, csv, definePreset, del, get, int, obj, p, post, put, str } from "./_kit.js";

const DEVICE = () => p("device_id", "query", str("Target this device (from listDevices); omit for the active device"));
const MARKET = () => p("market", "query", str("ISO 3166-1 alpha-2 country code for track relinking, e.g. US"));
const LIMIT = (max: number, dflt: number) => p("limit", "query", int(`How many items per page (max ${max})`, { default: dflt, minimum: 1, maximum: max }));
const OFFSET = () => p("offset", "query", int("Index of the first item to return", { default: 0, minimum: 0 }));

export default definePreset({
  id: "spotify",
  label: "Spotify",
  blurb: "What is playing on Spotify, search, the queue, your playlists, saved music and listening history. Reads run freely; playback control and any library or playlist change ask.",
  connect: "spotify",
  oauth: {
    provider: "spotify",
    scopes: [
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing",
      "user-read-recently-played",
      "user-top-read",
      "user-library-read",
      "user-library-modify",
      "user-follow-read",
      "playlist-read-private",
      "playlist-modify-public",
      "playlist-modify-private",
    ],
  },
  baseUrl: "https://api.spotify.com/v1",
  verifyOperationId: "getMe",
  ratePerMin: 120,
  keywords: ["spotify", "music", "song", "playlist", "now playing", "what's playing", "queue"],
  domain: "spotify.com",
  source: {
    kind: "vendor-openapi",
    specUrl: "https://developer.spotify.com/reference/web-api/open-api-schema.yaml",
    docsUrl: "https://developer.spotify.com/documentation/web-api",
    fetchedOn: "2026-09-30",
    note: "Removed-for-development-mode endpoints taken from the February 2026 changelog.",
  },
  notes: {
    rateLimits: "A rolling 30-second window per app (development mode is lower than extended quota mode); over it answers HTTP 429 with a Retry-After header, which the Api tool waits out when short. Source: https://developer.spotify.com/documentation/web-api/concepts/rate-limits",
    pagination: "Paged lists answer {items, next, total, limit, offset}; `next` is a full URL, followed with pages. Listing followed artists and recently played use cursors ({cursors:{after,before}}), not next-url: pass `after` / `before` by hand.",
    auth: "Authorization: Bearer <Spotify access token> from the owner's connected Spotify account (authorization code with PKCE).",
    scopes: "Reads need user-read-playback-state, user-read-currently-playing, user-read-recently-played, user-top-read, user-library-read, user-follow-read, playlist-read-private; changes need user-modify-playback-state, user-library-modify, playlist-modify-public / playlist-modify-private.",
    gotchas: [
      "Playback control (start, pause, skip, seek, volume, shuffle, repeat, transfer, queue) needs a Spotify Premium account and an active device; with none the call answers 404 NO_ACTIVE_DEVICE - call listDevices, then transferPlayback or pass device_id.",
      "Spotify Feb 2026 dev-mode changes: search now allows at most 10 results per call (default 5), and many catalog lookups were removed (see the header comment). A 403 on a catalog route usually means that route was withdrawn for development-mode apps.",
      "Spotify URIs look like spotify:track:<id>, spotify:album:<id>, spotify:playlist:<id>, spotify:artist:<id>; search results carry them in `uri`.",
      "Playback endpoints answer 204 with no body on success; a currently-playing call answers 204 when nothing is playing.",
      "The playback state may hold `item` = null for ads or private sessions.",
    ],
  },
  ops: [
    // Profile  (docs: /documentation/web-api/reference/get-current-users-profile)
    get("/me", "getMe", "The signed-in Spotify user: display name, id, country, product (premium or free)", [], {
      tags: ["Users"],
      keywords: ["who am i", "my spotify account", "am I premium"],
      vendor: "GET /v1/me",
    }),
    get("/me/top/{type}", "getTopItems", "The owner's most-listened artists or tracks over a time range", [
      p("type", "path", str("What to rank", { enum: ["artists", "tracks"] })),
      p("time_range", "query", str("short_term = about 4 weeks, medium_term = about 6 months, long_term = about a year", { enum: ["short_term", "medium_term", "long_term"], default: "medium_term" })),
      LIMIT(50, 20),
      OFFSET(),
    ], {
      tags: ["Users"],
      keywords: ["my top artists", "my top tracks", "most listened", "favorite songs", "what do I listen to most"],
      paginate: { style: "next-url", next: "next", items: "items" },
      vendor: "GET /v1/me/top/{type}",
    }),

    // Player  (docs: /documentation/web-api/reference/get-information-about-the-users-current-playback ...)
    get("/me/player", "getPlaybackState", "Current playback: the track or episode, device, progress, shuffle, repeat, volume", [MARKET(), p("additional_types", "query", str("Also return episodes: pass episode (comma-separated with track)"))], {
      tags: ["Player"],
      keywords: ["what's playing", "what is playing", "now playing", "playback state", "current song"],
      vendor: "GET /v1/me/player",
    }),
    get("/me/player/currently-playing", "getCurrentlyPlaying", "The track or episode playing right now (204, empty, when nothing plays)", [MARKET(), p("additional_types", "query", str("Also return episodes: pass episode (comma-separated with track)"))], {
      tags: ["Player"],
      keywords: ["what song is this", "currently playing", "what am I listening to"],
      vendor: "GET /v1/me/player/currently-playing",
    }),
    get("/me/player/devices", "listDevices", "Devices Spotify can play on: id, name, type, active, volume", [], {
      tags: ["Player"],
      keywords: ["my devices", "where can I play", "spotify devices", "speakers"],
      vendor: "GET /v1/me/player/devices",
    }),
    get("/me/player/queue", "getQueue", "The currently playing item and what is queued next", [], {
      tags: ["Player"],
      keywords: ["what's next", "my queue", "up next"],
      vendor: "GET /v1/me/player/queue",
    }),
    get("/me/player/recently-played", "getRecentlyPlayed", "Tracks the owner recently played, newest first, with played_at", [
      LIMIT(50, 20),
      p("after", "query", int("Only plays after this time (Unix milliseconds); do not combine with before")),
      p("before", "query", int("Only plays before this time (Unix milliseconds); do not combine with after")),
    ], {
      tags: ["Player"],
      keywords: ["recently played", "what did I listen to", "listening history", "songs I played"],
      vendor: "GET /v1/me/player/recently-played",
    }),
    put(
      "/me/player/play",
      "startPlayback",
      "Start or resume playback, optionally of a given album, playlist, artist or list of tracks; asks the owner",
      [DEVICE()],
      {
        tags: ["Player"],
        risk: "write",
        keywords: ["play", "resume", "play some music", "play this album", "play this playlist"],
        vendor: "PUT /v1/me/player/play",
        body: JSON_BODY(
          obj("What to play; an empty body resumes", {
            context_uri: str("Spotify URI of an album, artist or playlist to play, e.g. spotify:album:<id>"),
            uris: arrOf("Spotify track URIs to play, e.g. spotify:track:<id> (instead of context_uri)", { type: "string" }),
            offset: obj("Where to start inside the context: {position: 0-based index} or {uri: item URI}", { position: int("0-based index in the album or playlist"), uri: str("URI of the item to start at") }),
            position_ms: int("Start this many milliseconds into the first item"),
          }),
          false,
        ),
      },
    ),
    put("/me/player/pause", "pausePlayback", "Pause playback; asks the owner", [DEVICE()], { tags: ["Player"], risk: "write", keywords: ["pause the music", "stop the music", "pause spotify"], vendor: "PUT /v1/me/player/pause" }),
    post("/me/player/next", "skipToNext", "Skip to the next item in the queue; asks the owner", [DEVICE()], { tags: ["Player"], risk: "write", keywords: ["next song", "skip this song", "skip track"], vendor: "POST /v1/me/player/next" }),
    post("/me/player/previous", "skipToPrevious", "Go back to the previous item; asks the owner", [DEVICE()], { tags: ["Player"], risk: "write", keywords: ["previous song", "go back a song", "last track"], vendor: "POST /v1/me/player/previous" }),
    put("/me/player/seek", "seekToPosition", "Jump to a position in the playing item; asks the owner", [p("position_ms", "query", int("Position in milliseconds from the start", { minimum: 0 }), true), DEVICE()], {
      tags: ["Player"],
      risk: "write",
      vendor: "PUT /v1/me/player/seek",
    }),
    put("/me/player/repeat", "setRepeatMode", "Set repeat to track, context (the album or playlist) or off; asks the owner", [p("state", "query", str("track repeats one item, context repeats the album or playlist, off stops repeating", { enum: ["track", "context", "off"] }), true), DEVICE()], {
      tags: ["Player"],
      risk: "write",
      vendor: "PUT /v1/me/player/repeat",
    }),
    put("/me/player/volume", "setPlaybackVolume", "Set the device volume, 0 to 100 percent; asks the owner", [p("volume_percent", "query", int("Volume from 0 to 100", { minimum: 0, maximum: 100 }), true), DEVICE()], {
      tags: ["Player"],
      risk: "write",
      keywords: ["volume up", "turn it down", "set volume", "louder", "quieter"],
      vendor: "PUT /v1/me/player/volume",
    }),
    put("/me/player/shuffle", "setShuffle", "Turn shuffle on or off; asks the owner", [p("state", "query", bool("true shuffles, false plays in order"), true), DEVICE()], {
      tags: ["Player"],
      risk: "write",
      keywords: ["shuffle"],
      vendor: "PUT /v1/me/player/shuffle",
    }),
    put(
      "/me/player",
      "transferPlayback",
      "Move playback to another device (optionally starting it there); asks the owner",
      [],
      {
        tags: ["Player"],
        risk: "write",
        keywords: ["play on my speaker", "switch device", "move playback"],
        vendor: "PUT /v1/me/player",
        body: JSON_BODY(
          obj("The target device", { device_ids: arrOf("Exactly one device id from listDevices", { type: "string" }), play: bool("true starts playing on the new device; false keeps the current play state") }, ["device_ids"]),
          true,
        ),
      },
    ),
    post("/me/player/queue", "addToQueue", "Add a track or episode to the end of the playback queue; asks the owner", [p("uri", "query", str("Spotify URI of the track or episode, e.g. spotify:track:<id>"), true), DEVICE()], {
      tags: ["Player"],
      risk: "write",
      keywords: ["add to queue", "queue this song", "play this next"],
      vendor: "POST /v1/me/player/queue",
    }),

    // Search and catalog  (docs: /documentation/web-api/reference/search)
    get("/search", "search", "Search the Spotify catalog for tracks, artists, albums, playlists, shows or episodes; results carry the URIs to play", [
      p("q", "query", str("Search text; field filters work: artist:Radiohead track:Creep year:1997"), true),
      p("type", "query", csv("What to search: any of album, artist, playlist, track, show, episode, audiobook"), true),
      MARKET(),
      p("limit", "query", int("Results per type (max 10 since February 2026)", { default: 5, minimum: 1, maximum: 10 })),
      OFFSET(),
    ], {
      tags: ["Search"],
      keywords: ["find a song", "search spotify", "look up an artist", "find an album", "find a podcast"],
      vendor: "GET /v1/search",
    }),
    get("/tracks/{id}", "getTrack", "One track: name, artists, album, duration, URI", [p("id", "path", str("The Spotify track id")), MARKET()], { tags: ["Tracks"], vendor: "GET /v1/tracks/{id}" }),
    get("/artists/{id}", "getArtist", "One artist: name, genres, followers, URI", [p("id", "path", str("The Spotify artist id"))], { tags: ["Artists"], vendor: "GET /v1/artists/{id}" }),
    get("/artists/{id}/albums", "getArtistAlbums", "An artist's albums, singles and compilations", [
      p("id", "path", str("The Spotify artist id")),
      p("include_groups", "query", str("Comma-separated filter: album, single, appears_on, compilation")),
      MARKET(),
      LIMIT(10, 5),
      OFFSET(),
    ], {
      tags: ["Artists", "Albums"],
      paginate: { style: "next-url", next: "next", items: "items" },
      vendor: "GET /v1/artists/{id}/albums",
    }),
    get("/albums/{id}/tracks", "getAlbumTracks", "The tracks of an album", [p("id", "path", str("The Spotify album id")), MARKET(), LIMIT(50, 20), OFFSET()], {
      tags: ["Albums", "Tracks"],
      paginate: { style: "next-url", next: "next", items: "items" },
      vendor: "GET /v1/albums/{id}/tracks",
    }),

    // Library  (docs: /documentation/web-api/reference/get-users-saved-tracks and the February 2026 library routes)
    get("/me/tracks", "listSavedTracks", "Songs the owner saved (liked songs), newest first", [MARKET(), LIMIT(50, 20), OFFSET()], {
      tags: ["Library", "Tracks"],
      keywords: ["my liked songs", "saved songs", "my saved tracks", "my library"],
      paginate: { style: "next-url", next: "next", items: "items", limitParam: "limit" },
      vendor: "GET /v1/me/tracks",
    }),
    get("/me/albums", "listSavedAlbums", "Albums the owner saved", [MARKET(), LIMIT(50, 20), OFFSET()], {
      tags: ["Library", "Albums"],
      keywords: ["my saved albums", "my albums"],
      paginate: { style: "next-url", next: "next", items: "items", limitParam: "limit" },
      vendor: "GET /v1/me/albums",
    }),
    get("/me/following", "listFollowedArtists", "Artists the owner follows (cursor paged: pass after)", [
      p("type", "query", str("Must be artist", { enum: ["artist"] }), true),
      p("after", "query", str("Cursor: the last artist id of the previous page (cursors.after)")),
      LIMIT(50, 20),
    ], {
      tags: ["Users"],
      keywords: ["artists I follow", "followed artists"],
      vendor: "GET /v1/me/following",
    }),
    get("/me/library/contains", "checkLibraryContains", "For each Spotify URI, is it saved in the owner's library (a list of true/false)", [p("uris", "query", csv("Comma-separated Spotify URIs (up to 40), e.g. spotify:track:<id>"), true)], {
      tags: ["Library"],
      keywords: ["do I have this saved", "is this in my library", "have I liked this song"],
      vendor: "GET /v1/me/library/contains",
    }),
    put("/me/library", "saveLibraryItems", "Save tracks, albums, shows, episodes or audiobooks, or follow artists, playlists and users, by URI; asks the owner", [p("uris", "query", csv("Comma-separated Spotify URIs (up to 40) to save or follow"), true)], {
      tags: ["Library"],
      risk: "write",
      keywords: ["like this song", "save this album", "add to my library", "follow this artist"],
      vendor: "PUT /v1/me/library",
    }),
    del("/me/library", "removeLibraryItems", "Remove saved items, or unfollow artists, playlists and users, by URI; the owner decides", [p("uris", "query", csv("Comma-separated Spotify URIs (up to 40) to remove or unfollow"), true)], {
      tags: ["Library"],
      keywords: ["unlike this song", "remove from my library", "unfollow"],
      vendor: "DELETE /v1/me/library",
    }),

    // Playlists  (docs: /documentation/web-api/reference/get-a-list-of-current-users-playlists and the /items routes)
    get("/me/playlists", "listMyPlaylists", "The owner's playlists (made and followed): name, id, tracks total, public flag", [LIMIT(50, 20), OFFSET()], {
      tags: ["Playlists"],
      keywords: ["my playlists", "list my playlists", "which playlists do I have"],
      paginate: { style: "next-url", next: "next", items: "items", limitParam: "limit" },
      vendor: "GET /v1/me/playlists",
    }),
    get("/playlists/{playlist_id}", "getPlaylist", "One playlist: name, description, owner, followers, first items", [
      p("playlist_id", "path", str("The Spotify playlist id")),
      MARKET(),
      p("fields", "query", str("Spotify partial-response filter, e.g. name,tracks.total,owner.display_name")),
      p("additional_types", "query", str("Also return episodes: pass episode (comma-separated with track)")),
    ], { tags: ["Playlists"], vendor: "GET /v1/playlists/{playlist_id}" }),
    get("/playlists/{playlist_id}/items", "listPlaylistItems", "The tracks and episodes in a playlist, in order, with added_at", [
      p("playlist_id", "path", str("The Spotify playlist id")),
      MARKET(),
      p("fields", "query", str("Spotify partial-response filter, e.g. items(track(name,uri,artists(name))),next")),
      LIMIT(50, 20),
      OFFSET(),
      p("additional_types", "query", str("Also return episodes: pass episode (comma-separated with track)")),
    ], {
      tags: ["Playlists", "Tracks"],
      keywords: ["what is in this playlist", "songs in my playlist", "playlist tracks"],
      paginate: { style: "next-url", next: "next", items: "items", limitParam: "limit" },
      vendor: "GET /v1/playlists/{playlist_id}/items",
    }),
    post(
      "/me/playlists",
      "createPlaylist",
      "Create a new playlist on the owner's account; asks the owner",
      [],
      {
        tags: ["Playlists"],
        risk: "write",
        keywords: ["make a playlist", "create a new playlist", "new playlist"],
        vendor: "POST /v1/me/playlists",
        body: JSON_BODY(
          obj("The new playlist", {
            name: str("The playlist name"),
            description: str("Description shown in Spotify"),
            public: bool("true makes it public on the profile (default true); say false for private"),
            collaborative: bool("true lets others edit it (needs public false)"),
          }, ["name"]),
        ),
      },
    ),
    put(
      "/playlists/{playlist_id}",
      "changePlaylistDetails",
      "Rename a playlist or change its description or visibility; asks the owner",
      [p("playlist_id", "path", str("The Spotify playlist id (one the owner owns)"))],
      {
        tags: ["Playlists"],
        risk: "write",
        vendor: "PUT /v1/playlists/{playlist_id}",
        body: JSON_BODY(obj("Fields to change", { name: str("New name"), description: str("New description"), public: bool("true public, false private"), collaborative: bool("true lets others edit") }), false),
      },
    ),
    post(
      "/playlists/{playlist_id}/items",
      "addPlaylistItems",
      "Add tracks or episodes to a playlist by URI; asks the owner",
      [p("playlist_id", "path", str("The Spotify playlist id (one the owner owns or collaborates on)"))],
      {
        tags: ["Playlists", "Tracks"],
        risk: "write",
        keywords: ["add a song to my playlist", "add to playlist", "put this in my playlist"],
        vendor: "POST /v1/playlists/{playlist_id}/items",
        body: JSON_BODY(
          obj("What to add", { uris: arrOf("Spotify URIs to add, e.g. spotify:track:<id> (up to 100)", { type: "string" }), position: int("0-based index to insert at; omit to append") }, ["uris"]),
        ),
      },
    ),
    del(
      "/playlists/{playlist_id}/items",
      "removePlaylistItems",
      "Remove tracks or episodes from a playlist by URI; the owner decides",
      [p("playlist_id", "path", str("The Spotify playlist id (one the owner owns or collaborates on)"))],
      {
        tags: ["Playlists", "Tracks"],
        keywords: ["remove a song from my playlist", "take this off my playlist"],
        vendor: "DELETE /v1/playlists/{playlist_id}/items",
        body: JSON_BODY(
          obj("What to remove", { items: arrOf("Objects {uri} to remove", obj("One item", { uri: str("Spotify URI of the track or episode") }, ["uri"])), snapshot_id: str("The playlist snapshot_id to change against (optional)") }, ["items"]),
        ),
      },
    ),
  ],
  recipes: [
    {
      ask: "what's playing on Spotify right now",
      steps: [{ op: "getPlaybackState", fields: "is_playing,progress_ms,device.name,item.name,item.artists.name,item.album.name", note: "empty answer means nothing is playing; item is null during an ad" }],
    },
    {
      ask: "what did I listen to recently",
      steps: [{ op: "getRecentlyPlayed", params: { limit: 20 }, fields: "items.played_at,items.track.name,items.track.artists.name" }],
    },
    {
      ask: "who are my top artists lately",
      steps: [{ op: "getTopItems", params: { type: "artists", time_range: "short_term", limit: 10 }, fields: "items.name,items.genres" }],
    },
    {
      ask: "show what is in my playlists",
      steps: [
        { op: "listMyPlaylists", params: { limit: 20 }, fields: "items.name,items.id,items.tracks.total" },
        { op: "listPlaylistItems", params: { playlist_id: "37i9dQZF1DXcBWIGoYBM5M", fields: "items(track(name,uri,artists(name)))", limit: 25 }, note: "pick the playlist the owner means from the list above" },
      ],
    },
    {
      ask: "play some Radiohead on my speaker",
      steps: [
        { op: "listDevices", fields: "devices.id,devices.name,devices.is_active" },
        { op: "search", params: { q: "artist:Radiohead", type: "artist", limit: 1 }, fields: "artists.items.name,artists.items.uri" },
        { op: "startPlayback", params: { device_id: "device-id-example" }, body: { context_uri: "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb" }, note: "asks the owner first; needs Premium" },
      ],
    },
    {
      ask: "add this song to my road trip playlist",
      steps: [
        { op: "search", params: { q: "track:Karma Police artist:Radiohead", type: "track", limit: 3 }, fields: "tracks.items.name,tracks.items.uri,tracks.items.artists.name" },
        { op: "addPlaylistItems", params: { playlist_id: "playlist-id-example" }, body: { uris: ["spotify:track:63OQupATfueTdZMWTxW03A"] }, note: "asks the owner first" },
      ],
    },
  ],
  searchChecks: [
    ["what's playing", "getPlaybackState"],
    ["skip this song", "skipToNext"],
    ["find a song", "search"],
    ["my top artists", "getTopItems"],
    ["my playlists", "listMyPlaylists"],
    ["add to queue", "addToQueue"],
    ["recently played", "getRecentlyPlayed"],
    ["turn the volume down", "setPlaybackVolume"],
  ],
});
