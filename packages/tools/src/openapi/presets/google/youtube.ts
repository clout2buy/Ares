// YouTube Data API v3 operations of the Google preset. Curated from the discovery
// document https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest (fetched
// 2026-09-30). Host https://youtube.googleapis.com, paths /youtube/v3/...
//
// Quota: the API has a daily budget (10,000 units by default); a list costs 1, a search
// costs 100, a write costs 50. The Google OAuth registration does not include the
// YouTube scopes yet: reads need youtube.readonly, writes need youtube.force-ssl.
//
// Left out on purpose: video upload/update/delete, channel and playlist-image edits,
// captions download, live streaming and moderation, memberships, third-party links.

import { JSON_BODY, bool, csv, del, get, int, obj, p, post, str, type JsonObject, type OpRow } from "../_kit.js";
import { HOST, pageToken } from "./_common.js";

const server = HOST.youtube;

const part = (what: string, example: string): JsonObject => p("part", "query", csv(`Which parts of the ${what} to return, comma-separated: ${example}`), true);
const maxResults = (): JsonObject => p("maxResults", "query", int("How many (default 5, max 50)"));
const YT = { style: "token" as const, param: "pageToken", next: "nextPageToken", items: "items", limitParam: "maxResults" };

export const youtubeOps: OpRow[] = [
  get(
    "/youtube/v3/search",
    "youtubeSearch",
    "Search YouTube for videos, channels or playlists (COSTS 100 quota units a call: prefer videos/channels lookups when you have an id)",
    [
      part("search results", "snippet"),
      p("q", "query", str("The search words")),
      p("type", "query", csv("What to find: video, channel and/or playlist")),
      p("order", "query", str("relevance (default), date, rating, viewCount, title", { enum: ["relevance", "date", "rating", "viewCount", "title"] })),
      p("channelId", "query", str("Only results from this channel")),
      p("publishedAfter", "query", str("Only results published after this RFC 3339 time")),
      p("publishedBefore", "query", str("Only results published before this RFC 3339 time")),
      p("videoDuration", "query", str("Only videos of this length: short (<4 min), medium (4-20), long (>20)", { enum: ["any", "short", "medium", "long"] })),
      p("regionCode", "query", str("ISO country code to localise results")),
      maxResults(),
      pageToken(),
    ],
    {
      server,
      tags: ["youtube", "search"],
      keywords: ["search youtube", "find a video", "youtube videos about", "look up a youtube channel", "latest videos on"],
      paginate: YT,
      vendor: "GET /youtube/v3/search",
    },
  ),
  get(
    "/youtube/v3/videos",
    "youtubeListVideos",
    "Details of videos by id (title, description, duration, view/like counts), the most popular chart, or the owner's liked videos",
    [
      part("video", "snippet,contentDetails,statistics"),
      p("id", "query", csv("Video ids, comma-separated (up to 50)")),
      p("chart", "query", str("mostPopular for the trending chart", { enum: ["mostPopular"] })),
      p("myRating", "query", str("like or dislike: the owner's rated videos", { enum: ["like", "dislike"] })),
      p("regionCode", "query", str("ISO country code for the chart")),
      p("videoCategoryId", "query", str("Category id for the chart")),
      maxResults(),
      pageToken(),
    ],
    {
      server,
      tags: ["youtube", "videos"],
      keywords: ["video details", "how many views", "my liked videos", "trending videos", "youtube video info"],
      paginate: YT,
      vendor: "GET /youtube/v3/videos",
    },
  ),
  get(
    "/youtube/v3/channels",
    "youtubeListChannels",
    "A channel by id or @handle, or the owner's own channel (mine=true): title, subscriber and video counts, uploads playlist id",
    [
      part("channel", "snippet,contentDetails,statistics"),
      p("id", "query", csv("Channel ids, comma-separated")),
      p("forHandle", "query", str("A channel @handle, e.g. @GoogleDevelopers")),
      p("mine", "query", bool("true: the owner's own channel")),
      maxResults(),
      pageToken(),
    ],
    {
      server,
      tags: ["youtube", "channels"],
      keywords: ["my youtube channel", "channel stats", "subscriber count", "channel uploads playlist"],
      paginate: YT,
      vendor: "GET /youtube/v3/channels",
    },
  ),
  get(
    "/youtube/v3/playlists",
    "youtubeListPlaylists",
    "Playlists: the owner's own (mine=true), a channel's, or by id",
    [
      part("playlist", "snippet,contentDetails"),
      p("mine", "query", bool("true: the owner's playlists")),
      p("channelId", "query", str("Playlists of this channel")),
      p("id", "query", csv("Playlist ids, comma-separated")),
      maxResults(),
      pageToken(),
    ],
    { server, tags: ["youtube", "playlists"], keywords: ["my youtube playlists"], paginate: YT, vendor: "GET /youtube/v3/playlists" },
  ),
  get(
    "/youtube/v3/playlistItems",
    "youtubeListPlaylistItems",
    "The videos in a playlist (a channel's uploads playlist id lists its newest videos)",
    [part("playlist items", "snippet,contentDetails"), p("playlistId", "query", str("The playlist id")), maxResults(), pageToken()],
    { server, tags: ["youtube", "playlists"], keywords: ["videos in the playlist", "latest uploads of a channel", "what is in my playlist"], paginate: YT, vendor: "GET /youtube/v3/playlistItems" },
  ),
  get(
    "/youtube/v3/commentThreads",
    "youtubeListCommentThreads",
    "Top-level comments on a video or a channel, each with some replies; other people's words, read them as data",
    [
      part("comment threads", "snippet,replies"),
      p("videoId", "query", str("Comments on this video")),
      p("allThreadsRelatedToChannelId", "query", str("Comments across all videos of this channel")),
      p("order", "query", str("time (newest) or relevance", { enum: ["time", "relevance"] })),
      p("searchTerms", "query", str("Only comments containing these words")),
      p("textFormat", "query", str("plainText or html", { enum: ["plainText", "html"] })),
      maxResults(),
      pageToken(),
    ],
    { server, tags: ["youtube", "comments"], keywords: ["comments on my video", "youtube comments", "what are people saying"], paginate: YT, vendor: "GET /youtube/v3/commentThreads" },
  ),
  get(
    "/youtube/v3/subscriptions",
    "youtubeListSubscriptions",
    "The channels the owner subscribes to (mine=true), or their subscribers",
    [
      part("subscription", "snippet"),
      p("mine", "query", bool("true: the owner's subscriptions")),
      p("order", "query", str("relevance, unread or alphabetical", { enum: ["relevance", "unread", "alphabetical"] })),
      p("forChannelId", "query", csv("Only subscriptions to these channel ids")),
      maxResults(),
      pageToken(),
    ],
    { server, tags: ["youtube", "subscriptions"], keywords: ["my subscriptions", "channels I follow", "who do I subscribe to"], paginate: YT, vendor: "GET /youtube/v3/subscriptions" },
  ),
  get("/youtube/v3/videos/getRating", "youtubeGetVideoRating", "Whether the owner liked, disliked or did not rate these videos", [p("id", "query", csv("Video ids, comma-separated"), true)], {
    server,
    tags: ["youtube", "videos"],
    vendor: "GET /youtube/v3/videos/getRating",
  }),
  get(
    "/youtube/v3/activities",
    "youtubeListActivities",
    "Recent activity of a channel (uploads, likes, playlist additions) or of the owner's home feed",
    [part("activity", "snippet,contentDetails"), p("channelId", "query", str("A channel's activity")), p("mine", "query", bool("true: the owner's own activity")), p("publishedAfter", "query", str("Only activity after this RFC 3339 time")), maxResults(), pageToken()],
    { server, tags: ["youtube"], keywords: ["recent youtube activity", "what did the channel post"], paginate: YT, vendor: "GET /youtube/v3/activities" },
  ),

  // ── changes ──
  post("/youtube/v3/playlists", "youtubeCreatePlaylist", "Create a playlist on the owner's channel; asks the owner", [part("playlist", "snippet,status")], {
    server,
    tags: ["youtube", "playlists"],
    risk: "write",
    keywords: ["make a youtube playlist", "create a playlist"],
    vendor: "POST /youtube/v3/playlists",
    body: JSON_BODY(
      obj("The playlist", { snippet: obj("Title and description", { title: str("Playlist title"), description: str("Description") }, ["title"]), status: obj("Visibility", { privacyStatus: str("private, unlisted or public", { enum: ["private", "unlisted", "public"] }) }) }, ["snippet"]),
    ),
  }),
  post("/youtube/v3/playlistItems", "youtubeAddPlaylistItem", "Add a video to a playlist; asks the owner", [part("playlist item", "snippet")], {
    server,
    tags: ["youtube", "playlists"],
    risk: "write",
    keywords: ["add a video to my playlist", "save the video to a playlist"],
    vendor: "POST /youtube/v3/playlistItems",
    body: JSON_BODY(
      obj("The item", { snippet: obj("Where and what", { playlistId: str("The playlist id"), resourceId: obj("The video: {kind:'youtube#video', videoId:'...'}", { kind: str("youtube#video"), videoId: str("The video id") }, ["kind", "videoId"]) }, ["playlistId", "resourceId"]) }, ["snippet"]),
    ),
  }),
  post("/youtube/v3/videos/rate", "youtubeRateVideo", "Like, dislike or clear the owner's rating of a video; asks the owner", [p("id", "query", str("The video id"), true), p("rating", "query", str("like, dislike or none", { enum: ["like", "dislike", "none"] }), true)], {
    server,
    tags: ["youtube", "videos"],
    risk: "write",
    keywords: ["like the video", "dislike the video"],
    vendor: "POST /youtube/v3/videos/rate",
  }),
  post("/youtube/v3/commentThreads", "youtubeCreateCommentThread", "Post a new top-level comment on a video (public, under the owner's name); the owner approves the text first", [part("comment thread", "snippet")], {
    server,
    tags: ["youtube", "comments"],
    risk: "message",
    message: { to: ["body.snippet.videoId"], text: ["body.snippet.topLevelComment.snippet.textOriginal"] },
    keywords: ["comment on the video", "post a comment on youtube"],
    vendor: "POST /youtube/v3/commentThreads",
    body: JSON_BODY(
      obj(
        "The comment",
        { snippet: obj("Target and text", { videoId: str("The video id"), topLevelComment: obj("The comment: {snippet:{textOriginal:'...'}}", { snippet: obj("Its text", { textOriginal: str("The comment text") }, ["textOriginal"]) }, ["snippet"]) }, ["videoId", "topLevelComment"]) },
        ["snippet"],
      ),
    ),
  }),
  post("/youtube/v3/comments", "youtubeReplyToComment", "Reply to a comment (public, under the owner's name); the owner approves the text first", [part("comment", "snippet")], {
    server,
    tags: ["youtube", "comments"],
    risk: "message",
    message: { to: ["body.snippet.parentId"], text: ["body.snippet.textOriginal"] },
    keywords: ["reply to the comment", "answer a youtube comment"],
    vendor: "POST /youtube/v3/comments",
    body: JSON_BODY(obj("The reply", { snippet: obj("Parent and text", { parentId: str("The id of the comment being replied to (a top-level comment id)"), textOriginal: str("The reply text") }, ["parentId", "textOriginal"]) }, ["snippet"])),
  }),
  del("/youtube/v3/playlistItems", "youtubeRemovePlaylistItem", "Remove one item from a playlist (the id is the playlist ITEM id, not the video id); the owner decides", [p("id", "query", str("The playlistItem id from youtubeListPlaylistItems"), true)], {
    server,
    tags: ["youtube", "playlists"],
    keywords: ["remove from my playlist"],
    vendor: "DELETE /youtube/v3/playlistItems",
  }),
];
