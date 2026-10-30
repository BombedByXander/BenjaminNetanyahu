import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
const build = 'b/8b0b5899ed/';
await mkdir(new URL(build + 'shaders/', output), { recursive: true });
await mkdir(new URL('data/', output), { recursive: true });
for (const name of ['loader.js', 'game.js', 'io_worker.js', 'wgpu_worker.js']) {
  await copyFile(new URL(name, root), new URL(build + name, output));
}
await copyFile(new URL('data-manifest.json', root), new URL('data/manifest.json', output));
await copyFile(new URL('shader-index.json', root), new URL(build + 'shaders/index.json', output));
let html = await readFile(new URL('homepage.html', root), 'utf8');
// Gate the module before it starts workers or downloads missing title art.
html = html.replace('<script type="module">', `<script type="module">
try {
  const response = await fetch('/__pages/status', {cache: 'no-store'});
  const status = await response.json();
  if (!status.ready) throw new Error(status.message);
  if (!crossOriginIsolated) throw new Error('Cross-origin isolation is unavailable. Check your hosting headers.');
  if (!navigator.gpu) throw new Error('This game requires a browser with WebGPU enabled.');
} catch (error) {
  const panel = document.createElement('main');
  panel.style.cssText = 'position:fixed;inset:0;z-index:100;background:#111;color:#eee;padding:10vh 8vw;font:18px/1.6 system-ui;overflow:auto';
  const heading = document.createElement('h1');
  heading.textContent = 'Game unavailable';
  const detail = document.createElement('p');
  detail.textContent = error.message;
  panel.append(heading, detail);
  document.body.append(panel);
  throw error;
}
`);
await writeFile(new URL('index.html', output), html);
await copyFile(new URL('cloudflare/worker.mjs', root), new URL('_worker.js', output));
await writeFile(new URL('404.html', output), '<!doctype html><title>Not found</title><h1>Not found</h1>');
console.log('Built dist/ for Cloudflare Pages. Game assets require GAME_ASSETS (R2) or ASSET_ORIGIN.');
