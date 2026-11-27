// ============================================================================
//  Procedural upper body + clothing
//  The scan stops just below the neck (with a flat slanted cut). This adds a
//  virtual torso (shoulders → upper chest) dressed in a knit top. The garment
//  is lofted from the neck: the collar hugs the scanned neck surface (sampled
//  per angle / height) and then widens into anatomically-proportioned shoulders
//  and chest. It is skinned to the same skeleton as the head so the collar
//  follows the neck when the head turns, and it breathes with the root bone.
// ============================================================================
import * as THREE from 'three';

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

export const GARMENT_COLORS = {
  charcoal: { ko: '차콜', c: 0x3a3c40 }, cream: { ko: '크림 아이보리', c: 0xe6dccb }, navy: { ko: '네이비', c: 0x1f2a44 },
  black: { ko: '블랙', c: 0x18181a }, camel: { ko: '카멜', c: 0xa47a52 }, burgundy: { ko: '버건디', c: 0x5a1f2a }, white: { ko: '화이트', c: 0xf1f0ec },
};
export const GARMENT_STYLES = { crew: '라운드넥 니트', turtle: '터틀넥 니트', none: '없음 (원본 흉상)' };

// knit normal + colour-variation textures (canvas)
function knitTextures(rib) {
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'), img = g.createImageData(N, N);
  const h = (x, y) => {
    if (rib) { const u = (x / N) * 8; return 0.5 + 0.5 * Math.cos(u * Math.PI * 2); }
    // jersey knit: rows of V-shaped loops
    const u = (x / N) * 8, v = (y / N) * 12;
    const col = u - Math.floor(u), row = v - Math.floor(v);
    const leg = Math.abs(col - 0.5) * 2;                  // 0 centre … 1 edge
    const vshape = Math.abs((row + leg * 0.5) % 1 - 0.5) * 2;
    return 0.65 * (1 - leg * leg) + 0.35 * (1 - vshape);
  };
  const H = new Float32Array(N * N); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) H[y * N + x] = h(x, y);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = H[y * N + (x + 1) % N] - H[y * N + (x + N - 1) % N], dy = H[((y + 1) % N) * N + x] - H[((y + N - 1) % N) * N + x];
    const s = 2.2, nx = -dx * s, ny = -dy * s, l = Math.hypot(nx, ny, 1);
    const o = (y * N + x) * 4; img.data[o] = (nx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const nt = new THREE.CanvasTexture(cv); nt.wrapS = nt.wrapT = THREE.RepeatWrapping; nt.colorSpace = THREE.NoColorSpace; nt.anisotropy = 8;
  // subtle yarn shading as AO-like colour map
  const cv2 = document.createElement('canvas'); cv2.width = cv2.height = N; const g2 = cv2.getContext('2d'), im2 = g2.createImageData(N, N);
  for (let i = 0; i < N * N; i++) { const v = 200 + 55 * H[i] - Math.random() * 10; im2.data[i * 4] = im2.data[i * 4 + 1] = im2.data[i * 4 + 2] = v; im2.data[i * 4 + 3] = 255; }
  g2.putImageData(im2, 0, 0);
  const ct = new THREE.CanvasTexture(cv2); ct.wrapS = ct.wrapT = THREE.RepeatWrapping; ct.colorSpace = THREE.SRGBColorSpace; ct.anisotropy = 8;
  return { nt, ct };
}

// sample the scanned neck: max radius around the axis per (angle, height) bin
function sampleNeck(P, axisZ) {
  const AB = 72, Y0 = -0.98, Y1 = -0.3, DY = 0.015, YB = Math.ceil((Y1 - Y0) / DY);
  const R = new Float32Array(AB * YB);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2]; if (y < Y0 || y > Y1) continue;
    const a = Math.floor(((Math.atan2(x, z - axisZ) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * AB) % AB;
    const k = Math.floor((y - Y0) / DY) * AB + a; const r = Math.hypot(x, z - axisZ); if (r > R[k]) R[k] = r;
  }
  return (phi, y) => {
    if (y < Y0 || y > Y1) return 0;
    const a = Math.floor(((phi + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * AB), yb = Math.floor((y - Y0) / DY);
    let m = 0; for (let dy = -1; dy <= 1; dy++) for (let da = -1; da <= 1; da++) { const b = yb + dy; if (b < 0 || b >= YB) continue; m = Math.max(m, R[b * AB + (a + da + AB) % AB]); }
    return m;
  };
}

export function buildGarment(srcPositions, skeleton, opt = {}) {
  const style = opt.style || 'crew';
  const AX = -0.1;                                  // body axis (x = 0, z = AX)
  const rScan = sampleNeck(srcPositions, AX);
  // design torso (half width / half depth / centre z) by height
  const W = [[-0.6, 0.36], [-0.68, 0.6], [-0.76, 0.86], [-0.86, 1.04], [-0.98, 1.15], [-1.12, 1.2], [-1.4, 1.17], [-2.1, 1.08]];
  const Dd = [[-0.6, 0.27], [-0.8, 0.42], [-1.0, 0.5], [-1.3, 0.55], [-2.1, 0.55]];
  const Cz = [[-0.6, -0.12], [-1.0, -0.08], [-1.4, -0.06], [-2.1, -0.06]];
  const tab = (T, y) => { if (y >= T[0][0]) return T[0][1]; for (let i = 1; i < T.length; i++) if (y >= T[i][0]) { const t = (y - T[i - 1][0]) / (T[i][0] - T[i - 1][0]); return lerp(T[i - 1][1], T[i][1], t); } return T[T.length - 1][1]; };
  const shoulderThin = y => 0.42 * ss(-0.75, -0.95, y) * (1 - ss(-1.25, -1.5, y));
  function rDesign(phi, y) {   // ray from the axis → superellipse surface
    const w = tab(W, y), d = tab(Dd, y), c = tab(Cz, y), n = 2.6, k = shoulderThin(y);
    const sx = Math.sin(phi), sz = Math.cos(phi);
    let lo = 0, hi = 2.5;
    for (let it = 0; it < 28; it++) {
      const t = (lo + hi) / 2, x = sx * t, z = AX + sz * t - c;
      const dEff = d * (1 - k * Math.pow(Math.min(1, Math.abs(x) / w), 4));
      (Math.pow(Math.abs(x) / w, n) + Math.pow(Math.abs(z) / dEff, n) > 1 ? hi = t : lo = t);
    }
    return lo;
  }
  const neckY = style === 'turtle'
    ? phi => -0.36 - 0.03 * Math.max(0, Math.cos(phi))
    : phi => -0.645 - 0.095 * Math.pow(Math.max(0, Math.cos(phi)), 1.5) + 0.055 * Math.max(0, -Math.cos(phi));
  const hugUntil = style === 'turtle' ? -0.6 : null;
  const SEG = 128, yBot = -2.1;
  const fr = []; for (let k = 0; k <= 44; k++) fr.push(Math.pow(k / 44, 1.7));   // dense near the collar
  const pos = [], uv = [], ribFlag = [];
  // ring list: [inner fold, top edge, body rings...]
  const rings = [];
  for (let s = 0; s <= SEG; s++) {
    const phi = (s / SEG) * Math.PI * 2 - Math.PI;   // seam at the back
    const ny = neckY(phi);
    const col = [];
    const hug = y => rScan(phi, y) + (style === 'turtle' ? 0.03 : 0.017) + 0.014 * Math.max(0, -Math.cos(phi)) ** 2;
    const top = hug(ny);
    col.push([top - 0.013, ny - 0.035, 'rib']);           // fold inside the collar
    col.push([top + 0.003, ny + 0.006, 'rib']);           // rounded top edge
    let prevR = top;
    for (const f of fr) {
      const y = ny + (yBot - ny) * f; const below = ny - y;
      let r = Math.max(rDesign(phi, y), rScan(phi, y) + 0.02);
      const hugT = hugUntil !== null ? ss(hugUntil + 0.02, hugUntil - 0.12, y) : ss(0.0, 0.13, below);
      r = lerp(Math.max(hug(y), top * 0.98), r, hugT);
      if (style !== 'turtle' && below < 0.035) r += 0.006;  // rib band slightly thicker
      if (style === 'turtle' && y > hugUntil) r += 0.006 * Math.sin((y - ny) * 90);   // rolled-collar folds
      r = Math.max(r, rScan(phi, y) + 0.012);
      col.push([r, y, (style === 'turtle' ? y > hugUntil - 0.02 : below < 0.04) ? 'rib' : 'body']);
      prevR = r;
    }
    rings.push(col);
  }
  const NR = rings[0].length;
  // smooth every ring around the body (removes the bin-quantisation wobble of the neck sampling),
  // then re-impose the 'never inside the scanned neck' constraint
  for (let k = 0; k < NR; k++) {
    let r = rings.map(c => c[k][0]);
    for (let pass = 0; pass < 6; pass++) r = r.map((v, s) => { const a = r[(s + SEG - 1) % SEG], b = r[(s + 1) % SEG]; return (a + 2 * v + b) / 4; });
    for (let s = 0; s <= SEG; s++) {
      const phi = (s / SEG) * Math.PI * 2 - Math.PI, y = rings[s][k][1];
      const floor = rScan(phi, y) + (k === 0 ? -0.004 : 0.014);
      rings[s][k][0] = Math.max(r[s % SEG], floor);
    }
  }
  for (let s = 0; s <= SEG; s++) {
    const phi = (s / SEG) * Math.PI * 2 - Math.PI;
    let acc = 0;
    for (let k = 0; k < NR; k++) {
      const [r, y, tag] = rings[s][k];
      const x = Math.sin(phi) * r, z = AX + Math.cos(phi) * r;
      if (k > 0) { const [r0, y0] = rings[s][k - 1]; acc += Math.hypot(r - r0, y - y0); }
      pos.push(x, y, z); uv.push((s / SEG) * 14, acc * 9); ribFlag.push(tag === 'rib' ? 1 : 0);
    }
  }
  const nV = pos.length / 3;
  // bottom cap
  const capC = nV; pos.push(0, yBot, -0.06); uv.push(0, 0); ribFlag.push(0);
  const idxBody = [], idxRib = [];
  for (let s = 0; s < SEG; s++) for (let k = 0; k < NR - 1; k++) {
    const a = s * NR + k, b = (s + 1) * NR + k, c = a + 1, d = b + 1;
    const L = (ribFlag[a] && ribFlag[c]) ? idxRib : idxBody;
    L.push(a, c, b, b, c, d);
  }
  for (let s = 0; s < SEG; s++) idxBody.push((s + 1) * NR + NR - 1, s * NR + NR - 1, capC);
  // orientation check: ring 0 is the inner fold, so the winding (a,c,b) faces outward on the body
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([...idxBody, ...idxRib]);
  g.addGroup(0, idxBody.length, 0); g.addGroup(idxBody.length, idxRib.length, 1);
  g.computeVertexNormals();
  // make sure normals point away from the axis
  const P = g.attributes.position, Nn = g.attributes.normal; let flip = 0, tot = 0;
  for (let i = 0; i < nV; i += 7) { const x = P.getX(i), z = P.getZ(i) - AX; flip += (Nn.getX(i) * x + Nn.getZ(i) * z) < 0 ? 1 : 0; tot++; }
  if (flip > tot / 2) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i]; ix[i] = ix[i + 1]; ix[i + 1] = t; } g.computeVertexNormals(); }
  // skin weights (same formula as the head/neck skin so the collar moves with the neck)
  const SKI = new Uint16Array((nV + 1) * 4), SKW = new Float32Array((nV + 1) * 4);
  for (let i = 0; i <= nV; i++) {
    const s = P.getY(i) + 0.35 * P.getZ(i);
    const h = ss(-0.62, -0.25, s), nk = ss(-0.95, -0.6, s) * (1 - h), r = Math.max(0, 1 - h - nk);
    SKI.set([2, 1, 0, 0], i * 4); SKW.set([h, nk, r, 0], i * 4);
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(SKI, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(SKW, 4));
  g.computeBoundingSphere();
  const color = new THREE.Color(GARMENT_COLORS[opt.color || 'charcoal'].c);
  const body = knitTextures(false), rib = knitTextures(true);
  const mk = t => new THREE.MeshPhysicalMaterial({ color, map: t.ct, normalMap: t.nt, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.92, sheen: 0.6, sheenRoughness: 0.75, sheenColor: color.clone().lerp(new THREE.Color(1, 1, 1), 0.35), specularIntensity: 0.2 });
  const mats = [mk(body), mk(rib)];
  const mesh = new THREE.SkinnedMesh(g, mats); mesh.name = 'Garment';
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
  mesh.bind(skeleton);
  mesh.setColor = key => { const c = new THREE.Color(GARMENT_COLORS[key].c); for (const m of mats) { m.color.copy(c); m.sheenColor.copy(c.clone().lerp(new THREE.Color(1, 1, 1), 0.35)); } };
  mesh.disposeAll = () => { g.dispose(); for (const m of mats) { m.map.dispose(); m.normalMap.dispose(); m.dispose(); } };
  return mesh;
}
