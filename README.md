# Kick Stremio Add-on

Watch 100+ Kick live streams and recorded VODs directly inside Stremio (compatible with Desktop, Web, Android TV, and PS5 browser).

### Installation

**1. One-click install**

[![Install to Stremio](https://img.shields.io/badge/Install%20to-Stremio-7b5bf5?style=for-the-badge)](stremio://kick-streams-stremio.onrender.com/manifest.json)

> If the button doesn't open Stremio, use the [Stremio Web install link](https://web.stremio.com/#/addons?addon=https%3A%2F%2Fkick-streams-stremio.onrender.com%2Fmanifest.json) or the manifest link below.

**2. Manual install**

Copy the manifest link and paste it into Stremio's Add-on search bar:

```
https://kick-streams-stremio.onrender.com/manifest.json
```

### Features

- 🔴 Live / ❌ Offline indicators
- Top 100+ English livestreams
- Search channels by username
- Past recorded broadcasts (VODs)
- Native CORS proxy for PS5 and browser playback
- Build a custom per-user manifest URL from the config page (browser-only, no server storage)
- Addon logo uses Kick's favicon

### Configuration

Open the addon's configure page, add the Kick usernames you want, then copy the generated per-user manifest URL. Nothing is saved on the server or in your browser — the selected streamers only exist in that page while you build the URL, and the URL itself carries the list:

```
https://kick-streams-stremio.onrender.com/streamers=user1,user2.manifest.json
```

A fresh visitor to the configure page always starts with an empty list.
