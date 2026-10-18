const express = require("express");
const axios = require("axios");
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

// Universal CORS headers for web clients and PS5 browser
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Body parsing for the configure form
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const clientHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://kick.com/"
};

// -------------------------------------------------------------
// Favorites (in-memory)
// -------------------------------------------------------------
const DEFAULT_FAVORITES = [];

// In-memory favorites (nothing saved to disk)
let favorites = DEFAULT_FAVORITES.slice();

const isFavorite = (slug) => favorites.some((f) => f.slug.toLowerCase() === slug.toLowerCase());

// Returns true if the channel is now a favorite, false if it was removed
function toggleFavorite(slug, name) {
  const idx = favorites.findIndex((f) => f.slug.toLowerCase() === slug.toLowerCase());
  if (idx >= 0) {
    favorites.splice(idx, 1);
    return false;
  }
  favorites.push({ slug, name: name || slug });
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

// Build a catalog containing only the given slugs (used by /streamers=...manifest.json)
async function buildCatalogBySlugs(idPrefix, slugs) {
  const pinned = await Promise.all(
    slugs.map(async (slug) => {
      const st = await getChannelStatus(slug);
      return {
        id: `${idPrefix}:${slug}`,
        type: "kick",
        name: `${st.isLive ? "🔴" : "❌"} ${st.username}`,
        poster: st.profilePic,
        posterShape: "poster",
        description: st.isLive
          ? `🔴 LIVE NOW: ${st.title}\nViewers: ${Number(st.viewers).toLocaleString()}`
          : "❌ Currently Offline"
      };
    })
  );
  return pinned;
}

// -------------------------------------------------------------
// Manifest Setup
// -------------------------------------------------------------
// Custom type "kick" with two catalogs. Every channel opens the same page:
// a list with a favorite toggle, a LIVE NOW entry (when live) and seekable VODs.
//   Channels  -> favorites + currently live channels (+ search)
//   Favorites -> your saved channels
const manifest = {
  id: "kick.streams",
  version: "1.0.0",
  name: "Kick Streams & Videos",
  description: "Watch Kick livestreams and seekable past VODs, with favorites",
  logo: "https://kick.com/favicon.ico",
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
  if (id.startsWith("kick_favorites:")) {
    const slugs = id.slice("kick_favorites:".length).split(",");
    return { metas: await buildCatalogBySlugs("kick", slugs) };
  }
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

// -------------------------------------------------------------
// Configure page: manage Kick usernames (in-memory)
// -------------------------------------------------------------
app.get("/", (req, res) => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configure Kick Streams Addon</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0e0f;color:#fff;margin:0;padding:24px}
  .max{max-width:720px;margin:0 auto}
  h1{font-size:26px;margin:0 0 6px;color:#53fc18}
  p.sub{color:#c9d1d3;margin:0 0 22px}
  .card{background:#16191b;border-radius:16px;padding:22px;margin-bottom:20px}
  .input-group{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  .input-wrap{position:relative;flex:1}
  input[type="text"]{flex:1;width:100%;box-sizing:border-box;padding:10px 14px;border-radius:8px;border:1px solid #33414e;background:#0f1417;color:#fff;font-size:14px}
  textarea{flex:1 1 100%;padding:10px 14px;border-radius:8px;border:1px solid #33414e;background:#0f1417;color:#fff;font-size:14px}
  button{padding:10px 18px;border-radius:8px;border:none;background:#53fc18;color:#000;font-weight:700;cursor:pointer;font-size:14px}
  button.secondary{background:#33414e;color:#fff}
  button:disabled{opacity:.5;cursor:not-allowed}
  .suggestions{position:absolute;z-index:50;background:#16191b;border:1px solid #33414e;border-radius:8px;max-height:260px;overflow-y:auto;width:100%;top:100%;left:0;margin-top:4px;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.3)}
  .suggestion{display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid #33414e;cursor:pointer}
  .suggestion:last-child{border-bottom:none}
  .suggestion:hover{background:#1f2529}
  .suggestion img{width:32px;height:32px;border-radius:50%;margin-right:10px;background:#0f1417;border:1px solid #33414e}
  .suggestion .name{font-weight:600;color:#fff}
  .suggestion .live{color:#53fc18;font-size:12px;margin-left:auto}
  ul{list-style:none;padding:0;margin:0}
  li{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #33414e;border-radius:8px;margin-bottom:8px;background:#0f1417}
  li span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hint{color:#94a3b8;font-size:13px;margin-top:8px}
  .urlbox{background:#0f1417;border:1px solid #33414e;border-radius:8px;padding:12px;margin-top:10px;word-break:break-all;font-size:13px}
  .urlbox a{color:#53fc18;text-decoration:none}
  .msg{margin:10px 0;padding:10px 12px;border-radius:8px;font-size:14px}
  .msg.ok{background:#14532d;color:#bbf7d0;border:1px solid #16a34a}
  .msg.err{background:#7f1d1d;color:#fecaca;border:1px solid #dc2626}
  h3{font-size:17px;margin:24px 0 8px;color:#53fc18}
</style>
</head>
<body>
<div class="max">
  <h1>⚙️ Configure Kick Streams</h1>
  <p class="sub">Add as many Kick usernames as you need. They will appear in the <b>Favorites</b> catalog of the addon.</p>

  <div class="card">
    <div class="input-group">
      <div class="input-wrap">
        <input type="text" id="newSlug" placeholder="kick username (e.g. xqc)" maxlength="60" autocomplete="off">
        <div id="suggestions" class="suggestions"></div>
      </div>
      <button onclick="addOne()">Add</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <h3>Per-user manifest</h3>
    <p class="sub" style="margin-bottom:8px">Copy this link to install only your selected users:</p>
    <div class="urlbox" id="userManifestUrl"></div>
    <p class="hint" style="margin-top:8px">URL format: <code>/streamers=user1,user2,etc.manifest.json</code></p>
  </div>
</div>
<script>
  const currentSlugs = JSON.parse('${JSON.stringify(favorites.map(f=>f.slug))}');
  function updateUserManifest(){
    const url = location.origin + "/streamers=" + currentSlugs.join(",") + ".manifest.json";
    document.getElementById('userManifestUrl').innerHTML = '<a href="'+escapeHtml(url)+'" target="_blank">'+escapeHtml(url)+'</a>';
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]))}
  async function addOne(){
    const el=document.getElementById('newSlug'); const s=el.value.trim();
    if(!s)return;
    const msg=document.getElementById('msg');
    const r=await fetch('/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'action=add&slug='+encodeURIComponent(s)});
    const j=await r.json();
    msg.innerHTML='<div class="msg '+(j.ok?'ok':'err')+'">'+escapeHtml(j.message||'')+'</div>';
    if(j.ok){el.value='';setTimeout(()=>location.reload(),400);}
  }
  updateUserManifest();
  // -------------------------------------------------------------
  // Autocomplete: fetch Kick username + photo as you type
  // -------------------------------------------------------------
  const input = document.getElementById('newSlug');
  const suggestions = document.getElementById('suggestions');
  let debounceTimer = null;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    suggestions.innerHTML = '';
    suggestions.style.display = 'none';
    if (!q) return;
    debounceTimer = setTimeout(async () => {
      try {
        const r = await fetch(\`https://kick.com/api/v1/channels/\${encodeURIComponent(q)}\`, {
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://kick.com/' }
        });
        const d = await r.json();
        if (d?.user?.username) {
          const isLive = Boolean(d?.livestream?.is_live);
          const pic = d?.user?.profile_pic || 'https://kick.com/favicon.ico';
          const el = document.createElement('div');
          el.className = 'suggestion';
          el.innerHTML = \`<img src="\${escapeHtml(pic)}" alt=""><div class="name">\${escapeHtml(d.user.username)}</div><div class="live">\${isLive ? '🔴 LIVE' : ''}</div>\`;
          el.onclick = () => { input.value = d.user.username; suggestions.innerHTML = ''; suggestions.style.display = 'none'; };
          suggestions.appendChild(el);
          suggestions.style.display = 'block';
        }
      } catch {}
    }, 300);
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !suggestions.contains(e.target)) {
      suggestions.innerHTML = '';
      suggestions.style.display = 'none';
    }
  });
</script>
</body>
</html>`;
  res.send(html);
});

app.post("/", async (req, res) => {
  const { action, slug, slugs } = req.body;
  let message = "Unknown action.";
  let ok = false;

  if (action === "add" && slug) {
    const s = cleanSlug(slug);
    if (!s) {
      message = "Invalid username.";
    } else if (isFavorite(s)) {
      message = `${s} is already added.`;
    } else {
      favorites.push({ slug: s, name: s });
      ok = true;
      message = `Added ${s}.`;
    }
  } else if (action === "addbulk" && slugs) {
    const parts = String(slugs).split(",").map(cleanSlug).filter(Boolean);
    let added = 0;
    for (const s of parts) {
      if (!isFavorite(s)) {
        favorites.push({ slug: s, name: s });
        added++;
      }
    }
    ok = added > 0;
    message = added ? `Added ${added} username(s).` : "No new usernames added.";
  } else if (action === "remove" && slug) {
    const s = cleanSlug(slug);
    const idx = favorites.findIndex((f) => f.slug.toLowerCase() === s.toLowerCase());
    if (idx >= 0) {
      favorites.splice(idx, 1);
      ok = true;
      message = `Removed ${s}.`;
    } else {
      message = `${s} not found.`;
    }
  } else {
    message = "Missing username.";
  }

  res.json({ ok, message });
});

// -------------------------------------------------------------
// User-specific manifest: /streamers=user1,user2,etc.manifest.json
// Returns a manifest whose Favorites catalog shows only those users.
// -------------------------------------------------------------
app.get("/streamers=:slugs.manifest.json", (req, res) => {
  const slugs = String(req.params.slugs)
    .split(/,/)
    .map(cleanSlug)
    .filter(Boolean);

  if (slugs.length === 0) {
    return res.status(400).json({ error: "Provide /streamers=user1,user2,etc.manifest.json" });
  }

  const userManifest = {
    id: `community.kick.live.user.${slugs.join(",")}`,
    version: "1.0.0",
    name: `Kick Streams - ${slugs.length} user(s)`,
    description: "Watch Kick livestreams for your selected users",
    resources: ["catalog", "stream", "meta"],
    types: ["kick"],
    idPrefixes: ["kick:", "kicklive:", "kickvod:", "kickfav:"],
    catalogs: [
      { type: "kick", id: "kick_channels", name: "Channels", extra: [{ name: "search", isRequired: false }] },
      { type: "kick", id: `kick_favorites:${slugs.join(",")}`, name: "Favorites" }
    ]
  };

  res.json(userManifest);
});

const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

process.on("unhandledRejection", (reason) => {
  console.warn("[Addon Warning] Caught unhandled rejection:", reason);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Addon running on http://localhost:${PORT}/manifest.json`);
});
