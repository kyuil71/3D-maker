// Builds dist/serene_face_studio_single.html — one self-contained file
// (three.js + app code + GLB + 1K/2K textures embedded as data URIs).
//   npm i esbuild   &&   node tools/build_single.mjs
import { build } from 'esbuild';
import fs from 'node:fs'; import path from 'node:path'; import url from 'node:url';
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist'); fs.mkdirSync(out, { recursive: true });
const vendor = path.join(root, 'vendor/three');
const res = await build({
  entryPoints: [path.join(root, 'js/main.js')], bundle: true, format: 'esm', minify: true, write: false, target: 'es2020',
  plugins: [{ name: 'strip-version', setup(b) { b.onResolve({ filter: /\?v=/ }, a => ({ path: path.join(a.resolveDir, a.path.replace(/\?v=.*$/, '')) })); } }, { name: 'three-alias', setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: path.join(vendor, 'three.module.min.js') }));
    b.onResolve({ filter: /^three\/addons\// }, a => ({ path: path.join(vendor, 'addons', a.path.replace('three/addons/', '')) }));
  } }],
});
let js = res.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const levels = (process.env.TEX || '1,2').split(',').map(Number);
const files = ['assets/head.glb'];
for (const l of levels) { files.push(`assets/tex/basecolor_${l}k.webp`); if (l <= 4) files.push(`assets/tex/normal_${l}k.webp`, `assets/tex/orm_${l}k.webp`); }
const mime = f => f.endsWith('.glb') ? 'model/gltf-binary' : 'image/webp';
const assets = Object.fromEntries(files.map(f => [f, `data:${mime(f)};base64,` + fs.readFileSync(path.join(root, f)).toString('base64')]));
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/studio.css'), 'utf8');
html = html.replace(/<link rel="stylesheet"[^>]*>/, `<style>${css}</style>`)
  .replace(/<script type="importmap">[\s\S]*?<\/script>/, '')
  .replace(/<script type="module" src="js\/main.js[^"]*"><\/script>/, () =>
    `<script>window.__TEX_LEVELS=${JSON.stringify(levels)};window.__ASSETS=${JSON.stringify(assets)};</script>\n<script type="module">${js}</script>`);
const file = path.join(out, 'serene_face_studio_single.html');
fs.writeFileSync(file, html);
console.log('wrote', file, (fs.statSync(file).size / 1048576).toFixed(1) + ' MB');
