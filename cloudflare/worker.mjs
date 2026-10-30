const BUILD = '/b/8b0b5899ed/';
const LOCAL = new Set(['loader.js', 'game.js', 'io_worker.js', 'wgpu_worker.js', 'shaders/index.json']);
const MAX_BATCH = 64 * 1024 * 1024;

function isolated(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, headers });
}

function validKey(key) {
  return key && !key.includes('\\') && !key.includes('\0') &&
    !key.split('/').some(part => part === '..' || part === '.' || part === '');
}

function mime(key) {
  const ext = key.split('.').pop();
  return ({ wasm: 'application/wasm', js: 'text/javascript', json: 'application/json',
    png: 'image/png', webp: 'image/webp', woff: 'font/woff', wgsl: 'text/plain' })[ext] || 'application/octet-stream';
}

// Fetch only from an operator-configured source, never a URL supplied by a visitor.
async function asset(env, key, method = 'GET', range = null) {
  if (!validKey(key)) return new Response('Invalid asset path', { status: 400 });
  if (env.GAME_ASSETS) {
    const meta = await env.GAME_ASSETS.head(key);
    if (!meta) return new Response('Asset not found', { status: 404 });
    const headers = new Headers({ 'Content-Type': mime(key), 'Accept-Ranges': 'bytes', ETag: meta.httpEtag });
    let offset = 0, length = meta.size;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
      offset = match[1] ? Number(match[1]) : Math.max(0, meta.size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), meta.size - 1) : meta.size - 1;
      length = end - offset + 1;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0 || offset >= meta.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
      }
      headers.set('Content-Range', `bytes ${offset}-${end}/${meta.size}`);
    }
    headers.set('Content-Length', String(length));
    if (method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    const object = await env.GAME_ASSETS.get(key, range ? { range: { offset, length } } : undefined);
    if (!object) return new Response('Asset not found', { status: 404 });
    return new Response(object.body, { status: range ? 206 : 200, headers });
  }
  if (env.ASSET_ORIGIN) {
    const base = new URL(env.ASSET_ORIGIN);
    if (base.protocol !== 'https:') return new Response('ASSET_ORIGIN must use HTTPS', { status: 503 });
    base.pathname = base.pathname.replace(/\/$/, '') + '/' + key.split('/').map(encodeURIComponent).join('/');
    base.search = '';
    base.hash = '';
    const response = await fetch(base, { method, headers: range ? { Range: range } : {}, redirect: 'error' });
    const headers = new Headers(response.headers);
    if (key.endsWith('.wasm') && response.ok) headers.set('Content-Type', 'application/wasm');
    headers.delete('Set-Cookie');
    return new Response(response.body, { status: response.status, headers });
  }
  return new Response('Missing game assets: configure GAME_ASSETS or ASSET_ORIGIN.', { status: 503 });
}

async function batch(request, env) {
  // Limit the actual body, not just the caller's Content-Length header.
  const reader = request.body?.getReader();
  if (!reader) return new Response('Invalid batch', { status: 400 });
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1024 * 1024) { await reader.cancel(); return new Response('Batch too large', { status: 413 }); }
    chunks.push(value);
  }
  let runs;
  try { runs = JSON.parse(await new Blob(chunks).text()); } catch { return new Response('Invalid JSON', { status: 400 }); }
  let total = 0;
  if (!Array.isArray(runs) || runs.length > 1000 || runs.some(run => {
    if (!Array.isArray(run) || run.length !== 3) return true;
    const [name, start, end] = run;
    if (typeof name !== 'string' || !validKey(name) || !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) || start < 0 || end < start) return true;
    total += end - start + 1;
    return total > MAX_BATCH;
  })) return new Response('Invalid batch ranges', { status: 400 });
  // Fetch sequentially and stream each range so a batch never buffers 64 MiB.
  async function* bytes() {
        for (const [name, start, end] of runs) {
          const response = await asset(env, 'data/' + name, 'GET', `bytes=${start}-${end}`);
          const expected = end - start + 1;
          if (response.status !== 206 || response.headers.get('Content-Range')?.split('/')[0] !== `bytes ${start}-${end}`) {
            await response.body?.cancel();
            throw new Error('Asset source did not honor the requested range');
          }
          const r = response.body.getReader(); let received = 0;
          try { for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            received += value.length;
            if (received > expected) { await r.cancel(); throw new Error('Oversized range response'); }
            yield value;
          } } finally { await r.cancel(); }
          if (received !== expected) throw new Error('Truncated range response');
        }
  }
  const iterator = bytes();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel() {
      await iterator.return();
    }
  });
  const headers = new Headers({ 'Content-Type': 'application/octet-stream',
    'X-Run-Lengths': runs.map(([, start, end]) => end - start + 1).join(','), 'Cache-Control': 'no-store' });
  const gzip = new URL(request.url).searchParams.get('gz') === '1';
  if (gzip) headers.set('Content-Encoding', 'gzip');
  return new Response(gzip ? stream.pipeThrough(new CompressionStream('gzip')) : stream, { headers });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/__pages/status') {
    let ready = false;
    try { ready = (await asset(env, BUILD.slice(1) + 'game.wasm', 'HEAD')).ok; } catch { /* unavailable upstream */ }
    return Response.json({ ready, message: ready ? 'Engine available. Additional game assets are required.' :
      'The game files are not available. This repository does not include the engine or game assets. The site owner must configure a complete asset source before the game can start.' }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (path === '/data/batch' && request.method === 'POST') return batch(request, env);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  if (path.startsWith(BUILD) && LOCAL.has(path.slice(BUILD.length))) return env.ASSETS.fetch(request);
  if (path === '/data/manifest.json') return env.ASSETS.fetch(request);
  if (path.startsWith('/data/') || path.startsWith(BUILD)) {
    let key;
    try { key = decodeURIComponent(path.slice(1)); } catch { return new Response('Invalid path', { status: 400 }); }
    return asset(env, key, request.method, request.headers.get('Range'));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try { return isolated(await route(request, env)); }
    catch { return isolated(new Response('Asset service unavailable', { status: 502 })); }
  }
};
