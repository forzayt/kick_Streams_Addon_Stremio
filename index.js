const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const app = express();
const PORT = process.env.PORT || 7000;
// Render/Railway provide RENDER_EXTERNAL_URL or you set HOST_URL manually
const HOST_URL = (
  process.env.HOST_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, "");

// Optional: set FAV_KEY to require ?key=... on the favorite toggle endpoint,
// so strangers who find your server can't change your favorites.
const FAV_KEY = process.env.FAV_KEY || "";

// Where favorites.json is stored. On hosts with ephemeral disks, point this at a persistent volume.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const FAV_FILE = path.join(DATA_DIR, "favorites.json");

// Universal CORS headers for web clients and PS5 browser
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clientHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://kick.com/"
};

// -------------------------------------------------------------
// Favorites (persisted to favorites.json)
// -------------------------------------------------------------
const DEFAULT_FAVORITES = [
  { slug: "achrafsabiri", name: "Achraf Sabiri" },
  { slug: "xqc", name: "xQc" },
  { slug: "adinross", name: "Adin Ross" }
];

function loadFavorites() {
  try {
    const data = JSON.parse(fs.readFileSync(FAV_FILE, "utf-8"));
    if (Array.isArray(data)) return data.filter((f) => f && f.slug);
  } catch {}
  return DEFAULT_FAVORITES.slice();
}

function saveFavorites() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FAV_FILE, JSON.stringify(favorites, null, 2));
  } catch (err) {
    console.warn("[Favorites] Could not save:", err.message);
  }
}

let favorites = loadFavorites();

const isFavorite = (slug) => favorites.some((f) => f.slug.toLowerCase() === slug.toLowerCase());

// Returns true if the channel is now a favorite, false if it was removed
function toggleFavorite(slug, name) {
  const idx = favorites.findIndex((f) => f.slug.toLowerCase() === slug.toLowerCase());
  if (idx >= 0) {
    favorites.splice(idx, 1);
    saveFavorites();
    return false;
  }
  favorites.push({ slug, name: name || slug });
  saveFavorites();
  return true;
}

function favToggleUrl(slug) {
  return `${HOST_URL}/fav/toggle?slug=${encodeURIComponent(slug)}${
    FAV_KEY ? `&key=${encodeURIComponent(FAV_KEY)}` : ""
  }`;
}

// A "stream" entry that opens the toggle page in the browser
function favStream(slug, displayName) {
  const nice = displayName || slug;
  return isFavorite(slug)
    ? { title: `⭐ Remove ${nice} from favorites (opens browser)`, externalUrl: favToggleUrl(slug) }
    : { title: `☆ Add ${nice} to favorites (opens browser)`, externalUrl: favToggleUrl(slug) };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

app.get("/fav/toggle", async (req, res) => {
  const slug = cleanSlug(req.query.slug);
  if (FAV_KEY && req.query.key !== FAV_KEY) return res.status(403).send("Forbidden.");
  if (!slug) return res.status(400).send("Missing channel.");

  const st = await getChannelStatus(slug);
  const nowFav = toggleFavorite(slug, st.username);
  statusCache.delete(slug);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Favorites</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b0e0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}
  .card{padding:32px;border-radius:16px;background:#16191b;max-width:360px}
  h1{font-size:44px;margin:0 0 8px} p{margin:6px 0;color:#c9d1d3} a{color:#53fc18}
</style></head><body><div class="card">
<h1>${nowFav ? "⭐" : "❌"}</h1>
<p><b>${escapeHtml(st.username)}</b> ${nowFav ? "was added to" : "was removed from"} your favorites.</p>
<p>You can close this tab and go back to Stremio.<br>Refresh the catalog to see the change.</p>
<p><a href="${escapeHtml(toggleLink(slug))}">Undo</a></p>
</div></body></html>`);
});

function toggleLink(slug) {
  return `/fav/toggle?slug=${encodeURIComponent(slug)}${FAV_KEY ? `&key=${encodeURIComponent(FAV_KEY)}` : ""}`;
}

// -------------------------------------------------------------
// Proxy security + caches
// -------------------------------------------------------------
// Hosts the proxy may fetch (prevents it being an open relay).
// Override with ALLOWED_HOSTS="a.com,b.com" (suffix match). "*" disables the check.
const ALLOWED_HOSTS = (
  process.env.ALLOWED_HOSTS ||
  "kick.com,live-video.net,cloudfront.net,amazonaws.com,ivsgo.com"
)
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function isAllowedUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (ALLOWED_HOSTS.includes("*")) return true;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

const CACHE_TTL_MS = 60 * 1000;
const VOD_CACHE_TTL_MS = 2 * 60 * 1000;
let liveStreamsCache = { timestamp: 0, data: [] };
const vodCache = new Map(); // slug -> { timestamp, data }
const statusCache = new Map(); // slug -> { timestamp, data }

function cleanSlug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

// -------------------------------------------------------------
// Playlist helpers
// -------------------------------------------------------------
function proxify(absUrl, isVod) {
  return `${HOST_URL}/proxy/stream?url=${encodeURIComponent(absUrl)}${isVod ? "&isVod=1" : ""}`;
}

function rewritePlaylist(originalText, targetUrl, isVod) {
  const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
  const isMaster = originalText.includes("#EXT-X-STREAM-INF");

  let lines = originalText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      // Tags: keep intact, rewrite URI="..." attributes
      if (trimmed.startsWith("#")) {
        return trimmed.replace(/URI="([^"]+)"/g, (m, uri) => {
          const abs = uri.startsWith("http") ? uri : new URL(uri, baseUrl).href;
          return `URI="${proxify(abs, isVod)}"`;
        });
      }

      // Segment or sub-playlist line
      const abs = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href;
      return proxify(abs, isVod);
    })
    .filter((l) => l !== null);

  // VOD media playlists: strip live-style tags, force VOD + ENDLIST
  if (isVod && !isMaster) {
    lines = lines.filter(
      (l) =>
        !/^#EXT-X-PLAYLIST-TYPE/i.test(l) &&
        !/^#EXT-X-ENDLIST/i.test(l) &&
        !/^#EXT-X-START/i.test(l) &&
        !/^#EXT-X-TWITCH-LIVE/i.test(l) &&
        !/^#EXT-X-PROGRAM-DATE-TIME/i.test(l)
    );

    if (!lines.some((l) => l.startsWith("#EXTM3U"))) lines.unshift("#EXTM3U");
    const insertAt = lines.findIndex((l) => l.startsWith("#EXTM3U")) + 1;
    lines.splice(insertAt, 0, "#EXT-X-PLAYLIST-TYPE:VOD");
    lines.push("#EXT-X-ENDLIST");
  }

  return lines.join("\n") + "\n";
}

// -------------------------------------------------------------
// Universal Stream & Segment Proxy
// -------------------------------------------------------------
app.get("/proxy/stream", async (req, res) => {
  const targetUrl = req.query.url;
  const isVod = req.query.isVod === "1";

  if (!targetUrl || targetUrl === "null" || targetUrl === "undefined") {
    return res.status(400).send("Stream URL unavailable.");
  }
  if (!isAllowedUrl(targetUrl)) {
    return res.status(403).send("Host not allowed.");
  }

  try {
    const upstreamHeaders = {
      "User-Agent": clientHeaders["User-Agent"],
      Referer: "https://kick.com/"
    };
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;

    const upstream = await axios.get(targetUrl, {
      responseType: "stream",
      headers: upstreamHeaders,
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 400
    });

    const contentType = upstream.headers["content-type"] || "";
    const isPlaylist = /\.m3u8(\?|$)/i.test(targetUrl) || /mpegurl/i.test(contentType);

    if (isPlaylist) {
      const chunks = [];
      for await (const chunk of upstream.data) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf-8");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
      return res.send(rewritePlaylist(text, targetUrl, isVod));
    }

    // Binary chunk: stream through, preserving range info
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType || "video/mp2t");
    res.setHeader("Accept-Ranges", upstream.headers["accept-ranges"] || "bytes");
    if (upstream.headers["content-length"]) {
      res.setHeader("Content-Length", upstream.headers["content-length"]);
    }
    if (upstream.headers["content-range"]) {
      res.setHeader("Content-Range", upstream.headers["content-range"]);
    }
    if (isVod) res.setHeader("Cache-Control", "public, max-age=3600");

    upstream.data.on("error", () => res.end());
    req.on("close", () => upstream.data.destroy());
    return upstream.data.pipe(res);
  } catch (err) {
    return res.status(404).send("Segment or playlist not found.");
  }
});

// -------------------------------------------------------------
// Kick API Resolvers
// -------------------------------------------------------------
async function getAtLeast100Livestreams() {
  const now = Date.now();
  if (now - liveStreamsCache.timestamp < CACHE_TTL_MS && liveStreamsCache.data.length > 0) {
    return liveStreamsCache.data;
  }

  try {
    const pages = [1, 2, 3, 4, 5];
    const pageRequests = pages.map((page) =>
      axios
        .get(`https://kick.com/stream/livestreams/en?page=${page}`, {
          headers: clientHeaders,
          timeout: 7000
        })
        .then((res) => (Array.isArray(res.data) ? res.data : res.data?.data || []))
        .catch(() => [])
    );

    const results = await Promise.all(pageRequests);
    const combinedRaw = results.flat();
    const seen = new Set();
    const parsed = [];

    for (const item of combinedRaw) {
      const slug = item.channel?.slug || item.slug;
      if (!slug || seen.has(slug.toLowerCase())) continue;
      seen.add(slug.toLowerCase());

      const username = item.channel?.user?.username || item.username || slug;
      const title = item.session_title || item.title || "Live Stream";
      const thumb =
        item.thumbnail?.url ||
        (typeof item.thumbnail === "string" ? item.thumbnail : null);
      const pic = item.channel?.user?.profile_pic || item.profile_pic || thumb;

      parsed.push({
        slug,
        username,
        title,
        poster: pic || thumb || "https://kick.com/favicon.ico",
        viewers: item.viewer_count || item.viewers || 0,
        category: item.categories?.[0]?.name || item.category?.name || "General"
      });
    }

    if (parsed.length > 0) {
      liveStreamsCache.data = parsed;
      liveStreamsCache.timestamp = now;
      return parsed;
    }
  } catch (err) {
    console.error("[Kick API Error] Bulk live fetch error:", err.message);
  }

  return liveStreamsCache.data;
}

async function getChannelStatus(slug) {
  const cached = statusCache.get(slug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  let data;
  try {
    const res = await axios.get(`https://kick.com/api/v1/channels/${slug}`, {
      headers: clientHeaders,
      timeout: 5000
    });
    const d = res.data;
    data = {
      isLive: Boolean(d?.livestream?.is_live),
      playbackUrl: d?.playback_url || null,
      title: d?.livestream?.session_title || "Live Stream",
      viewers: d?.livestream?.viewer_count || 0,
      profilePic: d?.user?.profile_pic || "https://kick.com/favicon.ico",
      username: d?.user?.username || slug
    };
  } catch {
    data = {
      isLive: false,
      playbackUrl: null,
      title: "Offline",
      viewers: 0,
      profilePic: "https://kick.com/favicon.ico",
      username: slug
    };
  }

  statusCache.set(slug, { timestamp: Date.now(), data });
  return data;
}

async function getVodList(slug) {
  const cached = vodCache.get(slug);
  if (cached && Date.now() - cached.timestamp < VOD_CACHE_TTL_MS) return cached.data;

  try {
    const r = await axios.get(`https://kick.com/api/v2/channels/${slug}/videos`, {
      headers: clientHeaders,
      timeout: 6000
    });
    const list = Array.isArray(r.data) ? r.data : r.data?.data || [];

    const data = list
      .slice(0, 20)
      .map((v) => ({
        id: v.id || v.video?.id,
        title: v.session_title || v.title || "Past Broadcast",
        created: v.created_at || v.video?.created_at || null,
        durationMs: v.duration || v.video?.duration || 0,
        source: v.source || v.playback_url || v.video?.source || v.video?.playback_url,
        thumb:
          (typeof v.thumbnail === "string" ? v.thumbnail : v.thumbnail?.src || v.thumbnail?.url) ||
          null
      }))
      .filter((v) => v.id);

    vodCache.set(slug, { timestamp: Date.now(), data });
    return data;
  } catch (err) {
    console.warn(`[Kick VODs] No VODs available for ${slug}: ${err.message}`);
    return cached ? cached.data : [];
  }
}

async function resolveVodUrl(vod) {
  let url = vod.source;
  if (!url && vod.id) {
    try {
      const d = await axios.get(`https://kick.com/api/v1/video/${vod.id}`, {
        headers: clientHeaders,
        timeout: 5000
      });
      url = d.data?.source || d.data?.playback_url || d.data?.video?.playback_url;
    } catch {}
  }
  return url ? proxify(url, true) : null;
}

// -------------------------------------------------------------
// Catalog builder
// -------------------------------------------------------------
// idPrefix is always "kick" (opens the channel page)
// onlyFavorites: true for the Favorites catalog
async function buildCatalog(idPrefix, extra, onlyFavorites = false) {
  if (extra && extra.search) {
    const slug = cleanSlug(extra.search);
    if (!slug) return [];
    const st = await getChannelStatus(slug);
    return [
      {
        id: `${idPrefix}:${slug}`,
        type: "kick",
        name: `${isFavorite(slug) ? "⭐ " : ""}${st.isLive ? "🔴" : "❌"} ${st.username}`,
        poster: st.profilePic,
        posterShape: "poster",
        description: st.isLive
          ? `🔴 LIVE NOW: ${st.title}\nViewers: ${Number(st.viewers).toLocaleString()}`
          : "❌ OFFLINE"
      }
    ];
  }

  const streams = onlyFavorites ? [] : await getAtLeast100Livestreams();
  const liveSlugs = new Set(streams.map((s) => s.slug.toLowerCase()));

  const pinned = await Promise.all(
    favorites.map(async (f) => {
      const st = await getChannelStatus(f.slug);
      const isLive = liveSlugs.has(f.slug.toLowerCase()) || st.isLive;
      return {
        id: `${idPrefix}:${f.slug}`,
        type: "kick",
        name: `⭐ ${isLive ? "🔴" : "❌"} ${f.name || st.username}`,
        poster: st.profilePic,
        posterShape: "poster",
        description: isLive
          ? `🔴 LIVE NOW: ${st.title}\nViewers: ${Number(st.viewers).toLocaleString()}`
          : "❌ Currently Offline"
      };
    })
  );

  if (onlyFavorites) return pinned;

  const others = streams
    .filter((s) => !isFavorite(s.slug))
    .map((s) => ({
      id: `${idPrefix}:${s.slug}`,
      type: "kick",
      name: `🔴 ${s.username}`,
      poster: s.poster,
      posterShape: "poster",
      description: `${s.title}\nCategory: ${s.category} | Viewers: ${Number(s.viewers).toLocaleString()}`
    }));

  return [...pinned, ...others];
}

// -------------------------------------------------------------
// Manifest Setup
// -------------------------------------------------------------
// Custom type "kick" with two catalogs. Every channel opens the same page:
// a list with a favorite toggle, a LIVE NOW entry (when live) and seekable VODs.
//   Channels  -> favorites + currently live channels (+ search)
//   Favorites -> your saved channels
const manifest = {
  id: "community.kick.live",
  version: "1.0.0",
  name: "Kick Streams & Videos",
  description: "Watch Kick livestreams and seekable past VODs, with favorites",
  resources: ["catalog", "stream", "meta"],
  types: ["kick"],
  idPrefixes: ["kick:", "kicklive:", "kickvod:", "kickfav:"],
  catalogs: [
    { type: "kick", id: "kick_channels", name: "Channels", extra: [{ name: "search", isRequired: false }] },
    { type: "kick", id: "kick_favorites", name: "Favorites" }
  ]
};

const builder = new addonBuilder(manifest);

// ---------------------------- Catalogs ----------------------------
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "kick") return { metas: [] };
  if (id === "kick_channels") return { metas: await buildCatalog("kick", extra) };
  if (id === "kick_favorites") return { metas: await buildCatalog("kick", null, true) };
  return { metas: [] };
});

// ----------------------------- Meta -------------------------------
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "kick") return { meta: null };

  // Channel page: favorite toggle, LIVE NOW (if live) and VOD episode list
  if (id.startsWith("kick:")) {
    const slug = id.slice("kick:".length);
    const [st, vods] = await Promise.all([getChannelStatus(slug), getVodList(slug)]);

    const now = new Date().toISOString();
    const videos = [];

    // Favorite toggle entry
    videos.push({
      id: `kickfav:${slug}`,
      title: isFavorite(slug) ? "⭐ Remove from favorites" : "☆ Add to favorites",
      released: now
    });

    if (st.isLive && st.playbackUrl) {
      videos.push({
        id: `kicklive:${slug}`,
        title: `🔴 LIVE NOW: ${st.title}`,
        released: now
      });
    }

    for (const v of vods) {
      const mins = Math.round((v.durationMs || 0) / 60000);
      const d = v.created ? new Date(v.created) : new Date(0);
      videos.push({
        id: `kickvod:${slug}:${v.id}`,
        title: `📼 ${v.title}${mins > 0 ? ` (${mins}m)` : ""}`,
        released: (isNaN(d.getTime()) ? new Date(0) : d).toISOString(),
        thumbnail: v.thumb || undefined
      });
    }

    return {
      meta: {
        id,
        type: "kick",
        name: `${isFavorite(slug) ? "⭐ " : ""}${st.username || slug}`,
        poster: st.profilePic,
        posterShape: "poster",
        description: vods.length
          ? `Past broadcasts for ${st.username || slug}`
          : `No VODs found for ${st.username || slug}`,
        videos
      }
    };
  }

  return { meta: null };
});

// ---------------------------- Streams -----------------------------
builder.defineStreamHandler(async ({ type, id }) => {
  // Favorite toggle episode
  if (id.startsWith("kickfav:")) {
    const slug = id.slice("kickfav:".length);
    const st = await getChannelStatus(slug);
    return { streams: [favStream(slug, st.username)] };
  }

  // Seekable VOD episode
  if (id.startsWith("kickvod:")) {
    const [, slug, vodId] = id.split(":");
    const vods = await getVodList(slug);
    const vod = vods.find((v) => String(v.id) === String(vodId));
    const url = vod ? await resolveVodUrl(vod) : null;
    return { streams: url ? [{ title: `📼 VOD: ${vod.title}`, url }] : [] };
  }

  // Live stream
  if (id.startsWith("kicklive:") || id.startsWith("kick:")) {
    const slug = id.slice(id.indexOf(":") + 1);
    const st = await getChannelStatus(slug);

    if (st.isLive && st.playbackUrl) {
      return {
        streams: [{ title: `🔴 LIVE NOW: ${st.title}`, url: proxify(st.playbackUrl, false) }]
      };
    }

    return {
      streams: [
        { title: "❌ OFFLINE (open channel on Kick)", externalUrl: `https://kick.com/${slug}` }
      ]
    };
  }

  return { streams: [] };
});

const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

process.on("unhandledRejection", (reason) => {
  console.warn("[Addon Warning] Caught unhandled rejection:", reason);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Addon running on http://localhost:${PORT}/manifest.json`);
});
