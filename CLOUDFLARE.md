# Cloudflare Pages

The repository now builds for Pages, but it does **not** contain a playable game.
`game.wasm`, title art, shader packs, boot sets and roughly 20 GB of game data
are absent from upstream. A normal GTA V installation alone is not the matching
browser engine. Supply the matching `8b0b5899ed` mirror separately.

## Deploy the site

In Cloudflare, create a **Pages** project connected to this GitHub repository:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | Repository root |

The generated `_worker.js` handles cross-origin isolation, asset requests and
`POST /data/batch` (including gzip). The versioned script paths used by the engine
are preserved. Only browser files are published, not the bundled Python runtime
or investigation records. Without an asset source the page displays an explicit
unavailable message instead of hanging on the loading screen.

## Supply assets using one of these options

**R2:** Upload the contents of the matching `mirror/playgta5.com/` folder into an
R2 bucket, preserving object paths. In Pages settings, add an R2 binding named
`GAME_ASSETS` pointing to that bucket. Redeploy after adding the binding.
The bucket can remain private; the Pages Worker serves the game files.

**Existing HTTPS asset server:** Set a Pages environment variable named
`ASSET_ORIGIN` to the root URL of a complete matching mirror, then redeploy.
The source must honor HTTP byte ranges with `206` and `Content-Range`, support
HEAD, and serve raw game files without a login or HTML error page. Redirects are
not followed. Requests go through the Pages Worker, keeping browser URLs on
the same origin. A static file server is sufficient; batches are built by the
Worker. If both are set, R2 takes priority.

Expected source paths include:

```text
b/8b0b5899ed/game.wasm
b/8b0b5899ed/title/...
b/8b0b5899ed/shaders/...
data/bootset.json
data/bootset_low.json
data/common.rpf
data/x64/...
```

Pages static files are limited to 25 MiB each, while this engine alone is about
60 MiB. Do not put the game mirror in `dist` or Git. R2 or a separate asset
server is required. Asset traffic and batch reads consume Workers/R2 quotas;
choose limits appropriate for the number of players.

## Verify

Run `npm test` for routing, byte ranges, gzip, input validation and build checks.
`/__pages/status` reports whether the engine can be reached; it does not verify
the entire asset collection or GPU compatibility. Gameplay still requires a
compatible browser with WebGPU and shared WebAssembly memory64 support.

Deployment and actual gameplay cannot be verified without a Cloudflare project
and the missing matching assets. The original host returned HTTP 401 when
checked on October 30, 2026; the successor repository had no release assets.

References: [Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/),
[Pages limits](https://developers.cloudflare.com/pages/platform/limits/),
[R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
