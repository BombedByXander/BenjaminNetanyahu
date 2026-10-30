import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import worker from '../cloudflare/worker.mjs';

const objects = new Map([
  ['b/8b0b5899ed/game.wasm', Buffer.from([0, 97, 115, 109])],
  ['data/example.rpf', Buffer.from('abcdefghij')]
]);
const env = {
  ASSETS: { fetch: async () => new Response('static') },
  GAME_ASSETS: {
    head: async key => objects.has(key) ? { size: objects.get(key).length, httpEtag: '"test"' } : null,
    get: async (key, options) => {
      const bytes = objects.get(key);
      return bytes ? { body: options?.range ? bytes.subarray(options.range.offset, options.range.offset + options.range.length) : bytes } : null;
    }
  }
};
const get = (path, init, bindings = env) => worker.fetch(new Request('https://game.pages.dev' + path, init), bindings);

test('isolation headers cover static, dynamic and error responses', async () => {
  for (const path of ['/', '/b/8b0b5899ed/loader.js', '/data/missing']) {
    const response = await get(path);
    assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
    assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  }
});
test('R2 serves wasm and exact, suffix, open-ended and invalid ranges', async () => {
  const wasm = await get('/b/8b0b5899ed/game.wasm');
  assert.equal(wasm.headers.get('Content-Type'), 'application/wasm');
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), new Uint8Array([0, 97, 115, 109]));
  for (const [range, expected] of [['bytes=2-4', 'cde'], ['bytes=-3', 'hij'], ['bytes=8-', 'ij']]) {
    const response = await get('/data/example.rpf', { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), expected);
  }
  for (const range of ['bytes=99-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,3-4']) {
    assert.equal((await get('/data/example.rpf', { headers: { Range: range } })).status, 416);
  }
});
test('batch byte ordering and gzip agree with the engine protocol', async () => {
  for (const query of ['', '?gz=1']) {
    const response = await get('/data/batch' + query, { method: 'POST', body: JSON.stringify([['example.rpf', 2, 4], ['example.rpf', 8, 9]]) });
    assert.equal(response.headers.get('X-Run-Lengths'), '3,2');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal((query ? gunzipSync(bytes) : bytes).toString(), 'cdeij');
  }
});
test('invalid batches and traversal are rejected', async () => {
  for (const body of ['{}', 'bad', '[["../secret",0,2]]', '[["example.rpf",-1,2]]', '[["example.rpf",0,67108864]]']) {
    assert.equal((await get('/data/batch', { method: 'POST', body })).status, 400);
  }
  assert.equal((await get('/data/batch', { method: 'POST', body: ' '.repeat(1048577) })).status, 413);
  assert.equal((await get('/data/a%2f..%2fsecret')).status, 400);
});
test('missing sources and missing engine produce actionable status', async () => {
  assert.equal((await (await get('/__pages/status')).json()).ready, true);
  const status = await get('/__pages/status', undefined, { ASSETS: env.ASSETS });
  assert.equal((await status.json()).ready, false);
  assert.equal(status.headers.get('Cache-Control'), 'no-store');
  assert.equal((await get('/data/example.rpf', undefined, { ASSETS: env.ASSETS })).status, 503);
});
test('failed range reads fail the batch instead of returning corrupt bytes', async () => {
  const response = await get('/data/batch', { method: 'POST', body: '[["missing",0,2]]' });
  await assert.rejects(response.arrayBuffer());
});
test('build preserves the versioned worker paths and creates the entry point', async () => {
  await import('../scripts/build-pages.mjs');
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes("fetch('/__pages/status'"));
  assert.ok(html.includes('/b/8b0b5899ed'));
  assert.ok((await readFile(new URL('../dist/b/8b0b5899ed/loader.js', import.meta.url), 'utf8')).includes('/game.wasm'));
  assert.ok((await readFile(new URL('../dist/_worker.js', import.meta.url), 'utf8')).includes('export default'));
});
