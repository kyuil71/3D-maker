// ============================================================================
//  Face rig builder
//  Turns a static scanned head mesh (no rig, no blend shapes) into an animatable
//  character:
//    1. ray-casts 2D landmarks onto the mesh to get 3D facial feature points
//    2. cuts real openings: eye holes (for 3D eyeballs) and a mouth slit
//       between the upper and lower lip, with inner-lip / eyelid-rim strips
//    3. generates ARKit-52-style morph targets by anatomical vertex deformation
//       (smooth falloff weights, jaw rotation about the TMJ axis, eyelids that
//       slide over the eyeball surface, ...)
//    4. adds 3D eyeballs, teeth, gums, tongue and an oral cavity
//    5. skins head / neck to a small skeleton for head motion
//  All deformation is a deterministic function of rest position, so vertices
//  that are duplicated at UV seams always move together (no cracks).
// ============================================================================
import * as THREE from 'three';

export const ARKIT_52 = [
  'eyeBlinkLeft','eyeLookDownLeft','eyeLookInLeft','eyeLookOutLeft','eyeLookUpLeft','eyeSquintLeft','eyeWideLeft',
  'eyeBlinkRight','eyeLookDownRight','eyeLookInRight','eyeLookOutRight','eyeLookUpRight','eyeSquintRight','eyeWideRight',
  'jawForward','jawLeft','jawRight','jawOpen',
  'mouthClose','mouthFunnel','mouthPucker','mouthLeft','mouthRight',
  'mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthDimpleLeft','mouthDimpleRight',
  'mouthStretchLeft','mouthStretchRight','mouthRollLower','mouthRollUpper','mouthShrugLower','mouthShrugUpper',
  'mouthPressLeft','mouthPressRight','mouthLowerDownLeft','mouthLowerDownRight','mouthUpperUpLeft','mouthUpperUpRight',
  'browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight',
  'cheekPuff','cheekSquintLeft','cheekSquintRight','noseSneerLeft','noseSneerRight','tongueOut'
];
// Extra (non-ARKit) channels driven by the app
export const EXTRA_CHANNELS = ['tongueUp','headPitch','headYaw','headRoll'];

// morph targets stored on the skin mesh (eye rotation and tongue are rigid objects)
const SKIN_MORPHS = ARKIT_52.filter(n => !/eyeLook(In|Out)|tongueOut/.test(n))
  .concat(['jawArc','eyeBlinkArcLeft','eyeBlinkArcRight']);

const JAW_ANGLE = 0.40;        // rad at jawOpen = 1  (~23°)
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;

// ---------------------------------------------------------------- utilities
function catmull(pts, seg = 8) {           // smooth polyline through points
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}
function polyY(poly, x) {                   // y of an x-monotone polyline (clamped at ends)
  if (x <= poly[0][0]) return poly[0][1];
  for (let i = 1; i < poly.length; i++) if (x <= poly[i][0]) {
    const a = poly[i - 1], b = poly[i], t = (x - a[0]) / (b[0] - a[0] || 1e-9);
    return a[1] + (b[1] - a[1]) * t;
  }
  return poly[poly.length - 1][1];
}
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function nearestOnPoly(x, y, poly) {
  let best = null, bd = 1e9;
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
    const t = clamp01(((x - ax) * dx + (y - ay) * dy) / l2);
    const px = ax + dx * t, py = ay + dy * t, d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) { bd = d; best = [px, py]; }
  }
  return best;
}
function distToPoly(x, y, poly) {           // returns [distance, param 0..1 along poly]
  let bd = 1e9, bs = 0, acc = 0; const lens = []; let total = 0;
  for (let i = 0; i < poly.length - 1; i++) { const l = Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]); lens.push(l); total += l; }
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
    const t = clamp01(((x - ax) * dx + (y - ay) * dy) / l2);
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < bd) { bd = d; bs = (acc + lens[i] * t) / total; }
    acc += lens[i];
  }
  return [bd, bs];
}

// 2D grid over front-facing triangles → fast "surface depth at (x,y)"
function makeSurface(P, I) {
  const cell = 0.01, x0 = -0.6, y0 = -1.0, nx = 120, ny = 200;
  const grid = new Map();
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    if (Math.max(P[a + 2], P[b + 2], P[c + 2]) < -0.25) continue;
    const minx = Math.floor((Math.min(P[a], P[b], P[c]) - x0) / cell), maxx = Math.floor((Math.max(P[a], P[b], P[c]) - x0) / cell);
    const miny = Math.floor((Math.min(P[a + 1], P[b + 1], P[c + 1]) - y0) / cell), maxy = Math.floor((Math.max(P[a + 1], P[b + 1], P[c + 1]) - y0) / cell);
    for (let gx = minx; gx <= maxx; gx++) for (let gy = miny; gy <= maxy; gy++) {
      const k = gx * 1000 + gy; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(t);
    }
  }
  return function surfZ(x, y) {
    const k = Math.floor((x - x0) / cell) * 1000 + Math.floor((y - y0) / cell);
    const l = grid.get(k); let best = -Infinity;
    if (!l) return best;
    for (const t of l) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const v0x = P[b] - P[a], v0y = P[b + 1] - P[a + 1], v1x = P[c] - P[a], v1y = P[c + 1] - P[a + 1], v2x = x - P[a], v2y = y - P[a + 1];
      const den = v0x * v1y - v1x * v0y; if (Math.abs(den) < 1e-14) continue;
      const v = (v2x * v1y - v1x * v2y) / den, w = (v0x * v2y - v2x * v0y) / den, u = 1 - v - w;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const z = u * P[a + 2] + v * P[b + 2] + w * P[c + 2];
      if (z > best) best = z;
    }
    return best;
  };
}

function weldIds(P, n) {
  const map = new Map(), id = new Int32Array(n); let k = 0;
  for (let i = 0; i < n; i++) {
    const key = Math.round(P[i * 3] * 1e5) + ',' + Math.round(P[i * 3 + 1] * 1e5) + ',' + Math.round(P[i * 3 + 2] * 1e5);
    let w = map.get(key); if (w === undefined) { w = k++; map.set(key, w); } id[i] = w;
  }
  return { id, count: k };
}
// area-weighted normals, shared across welded duplicates (no seams)
function weldedNormals(P, I, weld, nVerts, out) {
  const acc = new Float64Array(weld.count * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [I[t], I[t + 1], I[t + 2]]) { const w = weld.id[q] * 3; acc[w] += nx; acc[w + 1] += ny; acc[w + 2] += nz; }
  }
  out = out || new Float32Array(nVerts * 3);
  for (let i = 0; i < nVerts; i++) {
    const w = weld.id[i] * 3, l = Math.hypot(acc[w], acc[w + 1], acc[w + 2]) || 1;
    out[i * 3] = acc[w] / l; out[i * 3 + 1] = acc[w + 1] / l; out[i * 3 + 2] = acc[w + 2] / l;
  }
  return out;
}

// ============================================================================
export function buildRig(srcGeom, LM, options = {}) {
  const t0 = performance.now();
  const log = options.log || (() => {});
  const morphNormals = options.morphNormals !== false;
  const P0 = srcGeom.attributes.position.array;
  const N0 = srcGeom.attributes.position.count;
  const UV0 = srcGeom.attributes.uv.array;
  const I0 = srcGeom.index.array;
  const surfZ = makeSurface(P0, I0);
  const S = (x, y) => surfZ(x, y);

  // ------------------------------------------------ 3D landmarks
  const lipLine = catmull(LM.C.lipLine, 10);
  const lineY = x => polyY(lipLine, x);
  const cornerR = LM.R.mouthCorner, cornerL = LM.L.mouthCorner;
  const mouthCx = (cornerL[0] + cornerR[0]) / 2, mouthHalf = (cornerL[0] - cornerR[0]) / 2;
  const lipZ0 = S(mouthCx, lineY(mouthCx) + 0.004);
  const upTop = LM.C.upperLipTop[1], lowBot = LM.C.lowerLipBottom[1];
  const tmj = LM.tmj;
  const chinY = LM.C.chin[1], chinCreaseY = LM.C.chinCrease[1];
  const eyes = {};
  for (const side of ['L', 'R']) {
    const E = LM[side], sg = side === 'L' ? 1 : -1;
    let up = E.eyeUpper.slice().sort((a, b) => a[0] - b[0]);
    let lo = E.eyeLower.slice().sort((a, b) => a[0] - b[0]);
    up = catmull(up, 8); lo = catmull(lo, 8);
    const xmin = up[0][0], xmax = up[up.length - 1][0];
    const contour = up.concat(lo.slice(1, -1).reverse());
    const irisZ = S(E.iris[0], E.iris[1]);
    // fit sphere radius: front at iris surface, passes through corners
    const fitR = (cx, cy, cz) => {
      const rs = [];
      for (const c of [up[0], up[up.length - 1]]) {
        const z = S(c[0], c[1]); const d2 = (c[0] - cx) ** 2 + (c[1] - cy) ** 2, dz = z - cz;
        if (dz < -0.002) rs.push((d2 + dz * dz) / (-2 * dz));
      }
      return rs.length ? Math.min(0.085, Math.max(0.06, rs.reduce((a, b) => a + b) / rs.length)) : 0.07;
    };
    const R = fitR(E.iris[0], E.iris[1], irisZ);
    eyes[side] = { side, sg, up, lo, xmin, xmax, contour, iris: E.iris, irisZ, R,
      center: new THREE.Vector3(E.iris[0], E.iris[1], irisZ - 0.0025 - R),
      upY: x => polyY(up, x), loY: x => polyY(lo, x), brow: E.brow };
  }
  log(`landmarks ok · eye R=${eyes.L.R.toFixed(3)} lipZ=${lipZ0.toFixed(3)}`);

  // ------------------------------------------------ topology: cut eye holes + mouth slit
  const weld0 = weldIds(P0, N0);
  const triCount = I0.length / 3;
  const del = new Uint8Array(triCount);               // 1 = eye, 2 = mouth
  const mouthSlitHalf = mouthHalf - 0.004;
  for (let t = 0; t < triCount; t++) {
    const a = I0[t * 3] * 3, b = I0[t * 3 + 1] * 3, c = I0[t * 3 + 2] * 3;
    const cx = (P0[a] + P0[b] + P0[c]) / 3, cy = (P0[a + 1] + P0[b + 1] + P0[c + 1]) / 3, cz = (P0[a + 2] + P0[b + 2] + P0[c + 2]) / 3;
    for (const E of Object.values(eyes)) {
      if (cx > E.xmin - 0.01 && cx < E.xmax + 0.01 && cz > E.irisZ - 0.06 && inPoly(cx, cy, E.contour)) del[t] = 1;
    }
    if (!del[t] && Math.abs(cx - mouthCx) < mouthSlitHalf && Math.abs(cy - lineY(cx)) < 0.025 && cz > lipZ0 - 0.12) {
      const sa = P0[a + 1] - lineY(P0[a]), sb = P0[b + 1] - lineY(P0[b]), sc = P0[c + 1] - lineY(P0[c]);
      const pos = (sa > 0) + (sb > 0) + (sc > 0);
      if (pos > 0 && pos < 3) del[t] = 2;
    }
  }
  // boundary edges created by the cut (in weld space)
  const edgeCount = new Map();
  const ek = (a, b) => a < b ? a * 2000003 + b : b * 2000003 + a;
  const touched = new Uint8Array(weld0.count);         // weld verts of deleted tris → feature tag
  for (let t = 0; t < triCount; t++) if (del[t]) for (let k = 0; k < 3; k++) touched[weld0.id[I0[t * 3 + k]]] = del[t];
  for (let t = 0; t < triCount; t++) {
    if (del[t]) continue;
    for (let k = 0; k < 3; k++) {
      const a = weld0.id[I0[t * 3 + k]], b = weld0.id[I0[t * 3 + (k + 1) % 3]];
      const key = ek(a, b); edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  }
  const P = Float32Array.from(P0);
  // snap boundary vertices onto the smooth feature curves (removes saw-tooth edges)
  const boundaryEdges = [];  // [vi, vj, tag] directed as in the kept triangle
  for (let t = 0; t < triCount; t++) {
    if (del[t]) continue;
    for (let k = 0; k < 3; k++) {
      const vi = I0[t * 3 + k], vj = I0[t * 3 + (k + 1) % 3];
      const a = weld0.id[vi], b = weld0.id[vj];
      if (touched[a] && touched[b] && touched[a] === touched[b] && edgeCount.get(ek(a, b)) === 1) boundaryEdges.push([vi, vj, touched[a]]);
    }
  }
  const boundaryVert = new Map();  // vertex index → tag
  for (const [vi, vj, tag] of boundaryEdges) { boundaryVert.set(vi, tag); boundaryVert.set(vj, tag); }
  const gapAt = x => 0.0016 * (1 - Math.min(1, ((x - mouthCx) / mouthHalf) ** 4));
  // snap all duplicates via weld id
  const snapW = new Map();
  for (const [vi, tag] of boundaryVert) {
    const w = weld0.id[vi]; if (snapW.has(w)) continue;
    let x = P[vi * 3], y = P[vi * 3 + 1];
    if (tag === 1) {
      const E = x < 0 ? eyes.R : eyes.L; const q = nearestOnPoly(x, y, E.contour.concat([E.contour[0]]));
      snapW.set(w, [q[0], q[1]]);
    } else {
      const ly = lineY(x), side = y > ly ? 1 : -1;
      snapW.set(w, [x, ly + side * gapAt(x) / 2]);
    }
  }
  for (let i = 0; i < N0; i++) { const s = snapW.get(weld0.id[i]); if (s) { P[i * 3] = s[0]; P[i * 3 + 1] = s[1]; } }

  // ------------------------------------------------ inner rim strips (inner lips, eyelid rims)
  let idx = [];
  for (let t = 0; t < triCount; t++) if (!del[t]) idx.push(I0[t * 3], I0[t * 3 + 1], I0[t * 3 + 2]);
  const baseN = weldedNormals(P, idx, weld0, N0);
  const extraPos = [], extraUV = [], extraCol = [], parent = [];
  let nextIndex = N0;
  const ringMaps = [new Map(), new Map()];
  const ringVert = (vi, ring, tag) => {
    const m = ringMaps[ring]; const key = vi; if (m.has(key)) return m.get(key);
    const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2];
    let nx, ny, nz, col;
    if (tag === 1) {
      const E = x < 0 ? eyes.R : eyes.L; const c = E.center;
      let dx = c.x - x, dy = c.y - y, dz = c.z - z; const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const d = ring === 0 ? 0.0025 : 0.016;
      nx = x + dx * d; ny = y + dy * d; nz = z + dz * d;
      col = ring === 0 ? [0.62, 0.42, 0.40] : [0.16, 0.09, 0.08];
    } else {
      const side = y > lineY(x) ? 1 : -1;
      let dx = mouthCx - x, dy = lineY(mouthCx) - y, dz = (lipZ0 - 0.12) - z; const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const d = ring === 0 ? 0.009 : 0.026;
      nx = x + dx * d * 0.6; ny = y + side * (ring === 0 ? -0.0022 : 0.005); nz = z + dz * d;   // ring0 crosses → seals the closed mouth
      col = ring === 0 ? [0.62, 0.36, 0.36] : [0.16, 0.06, 0.07];
    }
    extraPos.push(nx, ny, nz); extraUV.push(UV0[vi * 2], UV0[vi * 2 + 1]); extraCol.push(...col); parent.push(vi);
    m.set(key, nextIndex); return nextIndex++;
  };
  for (const [a, b, tag] of boundaryEdges) {
    if (tag === 2 && (P[a * 3 + 1] > lineY(P[a * 3])) !== (P[b * 3 + 1] > lineY(P[b * 3]))) continue;  // no web across the slit ends
    const a1 = ringVert(a, 0, tag), b1 = ringVert(b, 0, tag), a2 = ringVert(a, 1, tag), b2 = ringVert(b, 1, tag);
    idx.push(b, a, a1, b, a1, b1, b1, a1, a2, b1, a2, b2);
  }
  const NT = N0 + parent.length;
  const POS = new Float32Array(NT * 3); POS.set(P); POS.set(extraPos, N0 * 3);
  const UV = new Float32Array(NT * 2); UV.set(UV0); UV.set(extraUV, N0 * 2);
  const COL = new Float32Array(NT * 3).fill(1); COL.set(extraCol, N0 * 3);
  const PARENT = new Int32Array(NT).fill(-1); for (let i = 0; i < parent.length; i++) PARENT[N0 + i] = parent[i];
  const weld = weldIds(POS, NT);
  const NRM = weldedNormals(POS, idx, weld, NT);
  log(`cut: eye/mouth boundary edges=${boundaryEdges.length}, verts=${NT}`);

  // safety: push eyeballs back so they never poke through the lid skin
  for (const E of Object.values(eyes)) {
    let worst = 0;
    for (let i = 0; i < N0; i++) {
      const x = POS[i * 3], y = POS[i * 3 + 1], z = POS[i * 3 + 2];
      const dx = x - E.center.x, dy = y - E.center.y; const r2 = E.R * E.R - dx * dx - dy * dy;
      if (r2 <= 0 || Math.abs(dx) > 0.1 || z < E.irisZ - 0.05 || boundaryVert.get(i) === 1) continue;
      if (inPoly(x, y, E.contour)) continue;
      const sz = E.center.z + Math.sqrt(r2); worst = Math.max(worst, sz - z + 0.0008);
    }
    E.center.z -= Math.min(worst, 0.02); E.pushBack = worst;
  }
  const sphereZ = (E, x, y) => { const dx = x - E.center.x, dy = y - E.center.y, r2 = E.R * E.R - dx * dx - dy * dy; return r2 > 0 ? E.center.z + Math.sqrt(r2) : -Infinity; };

  // ------------------------------------------------ morph targets
  const D = {}; for (const n of SKIN_MORPHS) D[n] = new Float32Array(NT * 3);
  const put = (n, i, x, y, z) => { const a = D[n]; a[i * 3] += x; a[i * 3 + 1] += y; a[i * 3 + 2] += z; };
  const g2 = (x, y, cx, cy, rx, ry) => Math.exp(-(((x - cx) / rx) ** 2) - (((y - cy) / ry) ** 2));
  const rotX = (y, z, ang) => { const dy = y - tmj.y, dz = z - tmj.z, c = Math.cos(ang), s = Math.sin(ang); return [tmj.y + dy * c - dz * s, tmj.z + dy * s + dz * c]; };
  const lateralZ = (x, y, z, dx) => { const s0 = S(x, y), s1 = S(x + dx, y); return (isFinite(s0) && isFinite(s1) && Math.abs(z - s0) < 0.01) ? s1 - s0 : 0; };

  for (let i = 0; i < N0; i++) {
    const x = POS[i * 3], y = POS[i * 3 + 1], z = POS[i * 3 + 2];
    const front = ss(-0.15, 0.05, z) * (1 - ss(0.40, 0.47, Math.abs(x)));
    if (front <= 0) continue;
    const nx = NRM[i * 3], ny = NRM[i * 3 + 1], nz = NRM[i * 3 + 2];
    const ax = Math.abs(x - mouthCx), ly = lineY(x);
    const isSlit = boundaryVert.get(i) === 2;
    // ---- lip / jaw side weights
    const tl = 0.0005 + Math.max(0, ax - mouthHalf * 0.97) * 0.9;
    const upper = isSlit ? (y > ly ? 1 : 0) : ss(-tl, tl, y - ly);
    const lower = 1 - upper;
    const tj = 0.0005 + Math.max(0, ax - mouthHalf * 0.97) * 1.4;
    const jawSide = isSlit ? (y > ly ? 0 : 1) : 1 - ss(-tj, tj, y - ly);
    const xn = (x - mouthCx) / (mouthHalf * 1.08);
    const yn = y > ly ? (y - ly) / (upTop - ly) : (ly - y) / (ly - lowBot);
    const lipFront = ss(lipZ0 - 0.13, lipZ0 - 0.07, z);
    const lips = (1 - ss(0.75, 1.3, Math.hypot(xn, yn))) * lipFront;
    const pyn = y > ly ? (y - ly) / 0.15 : (ly - y) / 0.17;
    const peri = (1 - ss(0.35, 1.0, Math.hypot((x - mouthCx) / (mouthHalf * 1.7), pyn))) * ss(lipZ0 - 0.2, lipZ0 - 0.1, z);
    // ---- jaw
    // jaw influence: lower lip follows the jaw fully at the centre, the mouth corners (modiolus)
    // only ~45 %, upper lip near the corners follows a little → elliptical opening
    let J;
    const c = Math.min(1, ax / mouthHalf) ** 2, c15 = Math.pow(c, 1.5);
    if (ax <= mouthHalf) {
      J = y > ly ? 0.45 * c15 * (1 - ss(0.0, 0.07, y - ly))
                 : 1 - 0.55 * c15 * (1 - ss(0.02, 0.10, ly - y));
    } else {
      const k = ss(mouthHalf, mouthHalf + 0.05, ax);
      const edge = y > ly ? 0.45 * (1 - ss(0.0, 0.07, y - ly)) : 1 - 0.55 * (1 - ss(0.02, 0.10, ly - y));
      J = edge * (1 - k) + jawSide * k;
    }
    const wJaw = J * ss(tmj.z - 0.12, tmj.z + 0.1, z) * ss(chinY - 0.24, chinY - 0.03, y) * front;
    if (wJaw > 0) {
      const [ry, rz] = rotX(y, z, JAW_ANGLE * wJaw);
      put('jawOpen', i, 0, ry - y, rz - z);
      const [hy, hz] = rotX(y, z, JAW_ANGLE * wJaw * 0.5);
      put('jawArc', i, 0, (hy - y) - (ry - y) / 2, (hz - z) - (rz - z) / 2);
      // lips stretch slightly toward centre as the jaw drops
      put('jawOpen', i, -(x - mouthCx) * 0.06 * lips * lower, 0, 0);
      put('jawForward', i, 0, -0.002 * wJaw, 0.022 * wJaw);
      const lz = lateralZ(x, y, z, 0.024 * wJaw);
      put('jawLeft', i, 0.024 * wJaw, 0, lz); put('jawRight', i, -0.024 * wJaw, 0, lateralZ(x, y, z, -0.024 * wJaw));
      // mouthClose: bring the lower lip back up to meet the upper lip
      const lipOnly = lower * (1 - ss(0.55, 1.25, Math.hypot(xn, yn))) * lipFront;
      put('mouthClose', i, 0, -(ry - y) * lipOnly, -(rz - z) * lipOnly);
    }
    if (lips > 0 || peri > 0) {
      const c2 = Math.min(1, xn * xn);
      put('mouthClose', i, 0, -0.003 * upper * lips, 0);
      // funnel: lips flare forward & open into a round aperture
      put('mouthFunnel', i, -(x - mouthCx) * 0.24 * lips, (upper * 0.010 - lower * 0.012) * lips * (1 - 0.6 * c2), 0.016 * lips + 0.004 * peri);
      // pucker: lips compress toward centre and protrude, sealed
      const lp = (1 - ss(0.8, 1.45, Math.hypot(xn, yn))) * lipFront;
      put('mouthPucker', i, -(x - mouthCx) * 0.34 * lp, (ly - y) * 0.25 * lp, 0.03 * lp * (1 - 0.45 * c2) + 0.006 * peri);
      put('mouthRollUpper', i, 0, -0.004 * upper * lips, -0.011 * upper * lips);
      put('mouthRollLower', i, 0, 0.005 * lower * lips, -0.013 * lower * lips);
      put('mouthShrugUpper', i, 0, 0.006 * upper * lips, 0.003 * upper * lips);
      const chinG = g2(x, y, mouthCx, chinCreaseY - 0.02, 0.07, 0.06) * front;
      put('mouthShrugLower', i, 0, 0.008 * (lower * lips + chinG * 0.7), 0.006 * (lower * lips + chinG));
      const lz1 = lateralZ(x, y, z, 0.03 * peri), lz2 = lateralZ(x, y, z, -0.03 * peri);
      put('mouthLeft', i, 0.03 * peri, 0, lz1); put('mouthRight', i, -0.03 * peri, 0, lz2);
    }
    for (const side of ['Left', 'Right']) {
      const sg = side === 'Left' ? 1 : -1, C = side === 'Left' ? cornerL : cornerR, E = side === 'Left' ? eyes.L : eyes.R;
      const gC = g2(x, y, C[0], C[1], 0.08, 0.065) * front;
      const sideMask = ss(-0.03, 0.05, sg * (x - mouthCx));
      if (gC > 1e-4) {
        const gCheek = g2(x, y, C[0] + sg * 0.04, C[1] + 0.10, 0.08, 0.065) * front;
        const gNaso = g2(x, y, C[0] + sg * 0.03, C[1] + 0.045, 0.03, 0.05) * front;
        put('mouthSmile' + side, i, sg * 0.026 * gC, 0.038 * gC + 0.02 * gCheek, -0.02 * gC + 0.012 * gCheek + 0.008 * gNaso);
        const gF = g2(x, y, C[0], C[1] - 0.01, 0.07, 0.06) * front, gD = g2(x, y, C[0] - sg * 0.02, C[1] - 0.08, 0.05, 0.05) * front;
        put('mouthFrown' + side, i, sg * 0.003 * gF, -0.03 * gF - 0.01 * gD, -0.004 * gF);
        const gDi = g2(x, y, C[0], C[1], 0.05, 0.05) * front;
        put('mouthDimple' + side, i, sg * 0.007 * gDi, 0.002 * gDi, -0.009 * gDi);
        const gS = g2(x, y, C[0], C[1], 0.08, 0.07) * front;
        put('mouthStretch' + side, i, sg * 0.026 * gS, -0.012 * gS - 0.006 * lower * lips * sideMask, -0.012 * gS);
      }
      if (lips > 0) {
        put('mouthPress' + side, i, 0, (upper * -0.003 + lower * 0.003) * lips * sideMask, -0.004 * lips * sideMask);
        const gx = Math.exp(-((((x - mouthCx) - sg * 0.065) / 0.065) ** 2));
        const wu = upper * gx * Math.exp(-(((y - ly - 0.02) / 0.06) ** 2)) * lipFront;
        put('mouthUpperUp' + side, i, 0, 0.02 * wu, 0.004 * wu);
        const wl = lower * gx * Math.exp(-(((ly - 0.025 - y) / 0.06) ** 2)) * lipFront;
        put('mouthLowerDown' + side, i, 0, -0.022 * wl, 0.004 * wl);
      }
      // cheek puff
      const gP = g2(x, y, mouthCx + sg * 0.17, ly + 0.03, 0.075, 0.085) * front;
      if (gP > 1e-4) put('cheekPuff', i, nx * 0.036 * gP, ny * 0.036 * gP, nz * 0.036 * gP);
      // nose sneer
      const A = LM[side === 'Left' ? 'L' : 'R'].noseAla;
      const gN = g2(x, y, A[0] + sg * 0.005, A[1] + 0.025, 0.035, 0.05) * front;
      const gNl = g2(x, y, mouthCx + sg * 0.05, ly + 0.05, 0.04, 0.04) * front * upper;
      if (gN > 1e-4 || gNl > 1e-4) put('noseSneer' + side, i, sg * 0.004 * gN, 0.019 * gN + 0.007 * gNl, 0.003 * gN);
      // brows
      const brow = E.brow;  // ordered inner → outer
      const [dB, sB] = distToPoly(x, y, brow);
      const byAt = polyY(brow.slice().sort((a, b) => a[0] - b[0]), x);
      const wB = Math.exp(-((dB / (y > byAt ? 0.07 : 0.045)) ** 2)) * front * (sg * x > -0.005 ? 1 : 0);
      if (wB > 1e-4) {
        put('browDown' + side, i, -sg * 0.012 * (1 - sB) * wB, -0.026 * (1 - 0.3 * sB) * wB, 0.006 * (1 - sB) * wB);
        put('browOuterUp' + side, i, 0, 0.032 * Math.pow(sB, 1.2) * wB, -0.002 * sB * wB);
        put('browInnerUp', i, sg * 0.003 * (1 - sB) * wB, 0.034 * Math.pow(1 - sB, 1.5) * wB, 0);
      }
      // ---- eyelids
      if (sg * x > 0.02 && z > E.irisZ - 0.07) {
        const xc = Math.min(E.xmax, Math.max(E.xmin, x));
        const hx = 1 - ss(0, 0.025, Math.max(E.xmin - x, x - E.xmax));
        const U = E.upY(xc), L = E.loY(xc), gap = Math.max(0, U - L);
        const isB = boundaryVert.get(i) === 1;
        const fUp = (y >= U - 0.002 || (isB && y > (U + L) / 2)) ? (1 - ss(0, 0.05, y - U)) * hx * front : 0;
        const fLo = (y <= L + 0.002 || (isB && y <= (U + L) / 2)) ? (1 - ss(0, 0.035, L - y)) * hx * front : 0;
        const lidZ = (dy, f) => { const zt = Math.max(z, sphereZ(E, x, y + dy) + 0.0035); return (zt - z) * f; };
        if (fUp > 0) {
          const dy = -0.86 * gap * fUp;
          const dzF = lidZ(-0.86 * gap, fUp);
          put('eyeBlink' + side, i, 0, dy, dzF);
          put('eyeBlinkArc' + side, i, 0, 0, Math.max(0, lidZ(-0.43 * gap, fUp) - dzF / 2));
          put('eyeSquint' + side, i, 0, -0.10 * gap * fUp, lidZ(-0.10 * gap, fUp));
          put('eyeWide' + side, i, 0, 0.32 * gap * fUp, -0.002 * fUp);
          put('eyeLookUp' + side, i, 0, 0.14 * gap * fUp, 0);
          put('eyeLookDown' + side, i, 0, -0.30 * gap * fUp, lidZ(-0.30 * gap, fUp));
        }
        if (fLo > 0) {
          put('eyeBlink' + side, i, 0, 0.14 * gap * fLo, lidZ(0.14 * gap, fLo));
          put('eyeSquint' + side, i, 0, 0.30 * gap * fLo, lidZ(0.30 * gap, fLo));
          put('eyeWide' + side, i, 0, -0.06 * gap * fLo, 0);
          put('eyeLookUp' + side, i, 0, 0.04 * gap * fLo, 0);
          put('eyeLookDown' + side, i, 0, -0.08 * gap * fLo, 0);
          put('cheekSquint' + side, i, 0, 0.12 * gap * fLo, lidZ(0.12 * gap, fLo));
        }
      }
      const gCS = g2(x, y, E.iris[0], E.loY(E.iris[0]) - 0.065, 0.07, 0.045) * front;
      if (gCS > 1e-4) {
        put('cheekSquint' + side, i, 0, 0.018 * gCS, 0.006 * gCS);
        put('eyeSquint' + side, i, 0, 0.005 * gCS, 0.002 * gCS);
      }
    }
    const gFH = g2(x, y, 0, LM.C.forehead[1] - 0.02, 0.1, 0.07) * front;
    if (gFH > 1e-4) put('browInnerUp', i, 0, 0.012 * gFH, 0);
  }
  // rim strip vertices inherit their parent's motion
  for (let i = N0; i < NT; i++) { const p = PARENT[i]; for (const n of SKIN_MORPHS) { const a = D[n]; a[i * 3] = a[p * 3]; a[i * 3 + 1] = a[p * 3 + 1]; a[i * 3 + 2] = a[p * 3 + 2]; } }
  log(`morphs computed (${SKIN_MORPHS.length})`);

  // ------------------------------------------------ split into face (morphing) and static parts
  const active = new Uint8Array(NT);
  for (const n of SKIN_MORPHS) { const a = D[n]; for (let i = 0; i < NT; i++) if (!active[i] && (Math.abs(a[i * 3]) + Math.abs(a[i * 3 + 1]) + Math.abs(a[i * 3 + 2])) > 1e-6) active[i] = 1; }
  const faceTris = [], restTris = [];
  for (let t = 0; t < idx.length; t += 3) (active[idx[t]] || active[idx[t + 1]] || active[idx[t + 2]] ? faceTris : restTris).push(idx[t], idx[t + 1], idx[t + 2]);

  // morph normals
  let DN = null;
  if (morphNormals) {
    DN = {};
    const tmp = new Float32Array(NT * 3), nOut = new Float32Array(NT * 3);
    for (const n of SKIN_MORPHS) {
      const a = D[n]; for (let k = 0; k < NT * 3; k++) tmp[k] = POS[k] + a[k];
      weldedNormals(tmp, faceTris, weld, NT, nOut);
      const dn = new Float32Array(NT * 3); for (let k = 0; k < NT * 3; k++) dn[k] = active[(k / 3) | 0] ? nOut[k] - NRM[k] : 0;
      DN[n] = dn;
    }
  }

  // ------------------------------------------------ skeleton + skin weights
  const bonesW = { root: new THREE.Vector3(0, -0.80, -0.05), neck: new THREE.Vector3(0, -0.46, -0.10), head: new THREE.Vector3(0, 0.05, -0.08) };
  const root = new THREE.Bone(); root.name = 'root'; root.position.copy(bonesW.root);
  const neck = new THREE.Bone(); neck.name = 'neck'; neck.position.copy(bonesW.neck).sub(bonesW.root); root.add(neck);
  const head = new THREE.Bone(); head.name = 'head'; head.position.copy(bonesW.head).sub(bonesW.neck); neck.add(head);
  const SKI = new Uint16Array(NT * 4), SKW = new Float32Array(NT * 4);
  for (let i = 0; i < NT; i++) {
    const s = POS[i * 3 + 1] + 0.35 * POS[i * 3 + 2];
    const h = ss(-0.62, -0.25, s), nk = ss(-0.95, -0.6, s) * (1 - h), r = Math.max(0, 1 - h - nk);
    SKI[i * 4] = 2; SKI[i * 4 + 1] = 1; SKI[i * 4 + 2] = 0; SKI[i * 4 + 3] = 0;
    SKW[i * 4] = h; SKW[i * 4 + 1] = nk; SKW[i * 4 + 2] = r;
  }

  // skin mask (1 = skin, 0 = hair) so the skin-tone grade never touches the blonde hair
  const SKN = new Float32Array(NT);
  for (let i = 0; i < NT; i++) {
    const q = PARENT[i] >= 0 ? PARENT[i] : i;
    const x = POS[q * 3], y = POS[q * 3 + 1], z = POS[q * 3 + 2], ax = Math.abs(x);
    const front = 0.67 - 0.3 * Math.min(1, ax / 0.42) ** 2;          // forehead → temples
    const t1 = ss(0.12, -0.04, z), t2 = ss(-0.14, -0.3, z);
    const side = ax > 0.3 ? 0.33 : 0.5;                                  // above the ears
    const line = (front * (1 - t1) + side * t1) * (1 - t2) + (-0.17) * t2; // nape at the back
    SKN[i] = 1 - ss(line - 0.012, line + 0.03, y);
  }
  function makeGeom(tris, withMorph) {
    const used = new Int32Array(NT).fill(-1); const list = [];
    for (const v of tris) if (used[v] < 0) { used[v] = list.length; list.push(v); }
    const n = list.length, g = new THREE.BufferGeometry();
    const pick = (src, k) => { const o = new src.constructor(n * k); for (let j = 0; j < n; j++) for (let c = 0; c < k; c++) o[j * k + c] = src[list[j] * k + c]; return o; };
    g.setAttribute('position', new THREE.BufferAttribute(pick(POS, 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(pick(NRM, 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(pick(UV, 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(pick(COL, 3), 3));
    g.setAttribute('skinMask', new THREE.BufferAttribute(pick(SKN, 1), 1));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(pick(SKI, 4), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(pick(SKW, 4), 4));
    const ind = new Uint32Array(tris.length); for (let k = 0; k < tris.length; k++) ind[k] = used[tris[k]];
    g.setIndex(new THREE.BufferAttribute(ind, 1));
    if (withMorph) {
      g.morphAttributes.position = SKIN_MORPHS.map(m => { const a = new THREE.BufferAttribute(pick(D[m], 3), 3); a.name = m; return a; });
      if (DN) g.morphAttributes.normal = SKIN_MORPHS.map(m => { const a = new THREE.BufferAttribute(pick(DN[m], 3), 3); a.name = m; return a; });
      g.morphTargetsRelative = true;
    }
    g.computeBoundingSphere(); g.boundingSphere.radius *= 1.3;
    return g;
  }
  const faceGeom = makeGeom(faceTris, true);
  const restGeom = makeGeom(restTris, false);
  const skinMat = options.material;
  const faceMesh = new THREE.SkinnedMesh(faceGeom, skinMat); faceMesh.name = 'Face';
  const restMesh = new THREE.SkinnedMesh(restGeom, skinMat); restMesh.name = 'HeadBody';
  faceMesh.morphTargetDictionary = {}; SKIN_MORPHS.forEach((m, k) => faceMesh.morphTargetDictionary[m] = k);
  faceMesh.morphTargetInfluences = new Array(SKIN_MORPHS.length).fill(0);
  const group = new THREE.Group(); group.name = 'CharacterRig';
  group.add(root, faceMesh, restMesh);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([root, neck, head]);
  faceMesh.bind(skeleton); restMesh.bind(skeleton);
  for (const m of [faceMesh, restMesh]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; }

  // ------------------------------------------------ eyes, mouth interior
  const inHead = v => v.clone().sub(bonesW.head);
  const eyeObjs = {};
  for (const E of Object.values(eyes)) {
    const pivot = new THREE.Group(); pivot.name = 'Eye' + (E.sg > 0 ? 'Left' : 'Right');
    pivot.position.copy(inHead(E.center));
    const g = new THREE.SphereGeometry(E.R, 64, 48); g.rotateX(Math.PI / 2);
    const irisAng = Math.asin(Math.min(0.95, LM.irisRadius / E.R));
    const mat = new THREE.MeshPhysicalMaterial({ map: makeIrisTexture(irisAng), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 0.6 });
    const ball = new THREE.Mesh(g, mat); ball.name = 'Eyeball';
    ball.castShadow = false; ball.receiveShadow = true;
    pivot.add(ball);
    // dark socket behind the eyeball (only visible at the eye corners)
    const sock = new THREE.Mesh(invertGeom(new THREE.SphereGeometry(E.R * 1.12, 32, 24)), new THREE.MeshStandardMaterial({ color: 0x3a1c1a, roughness: 0.9 }));
    sock.position.copy(inHead(E.center)).add(new THREE.Vector3(0, 0, -0.012)); sock.name = 'EyeSocket';
    head.add(pivot, sock);
    eyeObjs[E.sg > 0 ? 'L' : 'R'] = pivot;
  }
  const mouth = buildMouth({ lineY, mouthCx, mouthHalf, lipZ0, S, tmj, bonesW, chinY });
  head.add(mouth.upper, mouth.jawPivot, mouth.cavity);
  mouth.cavity.bindMorph = true;

  group.updateMatrixWorld(true);
  log(`rig built in ${(performance.now() - t0).toFixed(0)} ms · face verts ${faceGeom.attributes.position.count}, static verts ${restGeom.attributes.position.count}, tris ${(faceTris.length + restTris.length) / 3}`);

  // ------------------------------------------------ runtime API
  const dict = faceMesh.morphTargetDictionary, inf = faceMesh.morphTargetInfluences;
  function apply(w) {      // w: { arkitName: 0..1, ...extra }
    for (const n of SKIN_MORPHS) { const k = dict[n]; if (k !== undefined) inf[k] = w[n] || 0; }
    const jo = w.jawOpen || 0; inf[dict.jawArc] = 4 * jo * (1 - jo);
    for (const s of ['Left', 'Right']) { const b = w['eyeBlink' + s] || 0; inf[dict['eyeBlinkArc' + s]] = 4 * b * (1 - b); }
    // eyes (rigid rotation). ARKit: In = toward nose, Out = away.
    for (const s of ['Left', 'Right']) {
      const e = eyeObjs[s[0]], sg = s === 'Left' ? 1 : -1;
      const yaw = ((w['eyeLookOut' + s] || 0) - (w['eyeLookIn' + s] || 0)) * sg * 0.45;
      const pitch = ((w['eyeLookDown' + s] || 0) - (w['eyeLookUp' + s] || 0)) * 0.35;
      e.rotation.set(pitch, yaw, 0, 'YXZ');
    }
    mouth.apply(w, JAW_ANGLE);
    head.rotation.set(-(w.headPitch || 0) * 0.65, (w.headYaw || 0) * 0.65, (w.headRoll || 0) * 0.65, 'YXZ');
    neck.rotation.set(-(w.headPitch || 0) * 0.35, (w.headYaw || 0) * 0.35, (w.headRoll || 0) * 0.35, 'YXZ');
  }
  return { group, faceMesh, restMesh, skeleton, bones: { root, neck, head }, eyes: eyeObjs, mouth, apply,
    morphNames: SKIN_MORPHS, info: { faceVerts: faceGeom.attributes.position.count, restVerts: restGeom.attributes.position.count, tris: (faceTris.length + restTris.length) / 3, eyeR: eyes.L.R, eyePush: [eyes.L.pushBack, eyes.R.pushBack] },
    landmarks3D: { eyes, lipZ0, mouthCx, mouthHalf, lineY },
    dispose() { faceGeom.dispose(); restGeom.dispose(); group.traverse(o => { if (o.isMesh && o !== faceMesh && o !== restMesh) { o.geometry.dispose(); } }); } };
}

// ============================================================================
//  Iris texture (colour profile sampled from the original painted eye)
// ============================================================================
const IRIS_PROFILE = [[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[2,3,2],[8,4,3],[21,10,6],[28,14,7],[34,15,8],[39,18,8],[44,20,8],[46,21,8],[49,22,9],[51,24,8],[51,24,8],[53,25,8],[57,26,7],[61,28,10],[61,28,10],[62,29,11],[64,30,12],[65,31,13],[65,33,15],[68,34,17],[69,36,18],[78,44,31]];
function makeIrisTexture(irisAng) {
  // equirect sphere map: canvas row y ↔ polar angle from the front pole; iris edge at irisAng
  const W = 1024, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
  const gain = 1.15, prof = IRIS_PROFILE;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const fib = new Float32Array(W); for (let i = 0; i < W; i++) fib[i] = rnd();
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i < W; i++) fib[i] = (fib[i] + fib[(i + 1) % W] + fib[(i + W - 1) % W]) / 3;
  for (let y = 0; y < H; y++) {
    const rr = ((y + 0.5) / H) * Math.PI / irisAng;     // 0 at front pole, 1 at iris edge
    for (let x = 0; x < W; x++) {
      let c;
      if (rr < 1.0) {
        const k = Math.min(prof.length - 1, Math.floor(rr * (prof.length - 1)));
        const base = prof[k]; const f = 0.75 + 0.5 * fib[x] * (rr > 0.42 ? 1 : 0);
        const ring = rr > 0.88 ? 1 - (rr - 0.88) * 3.2 : 1; // dark limbal ring
        c = base.map(v => v * gain * f * ring);
        if (rr > 0.42 && rr < 0.6) c = c.map((v, j) => v * (1.15 + 0.2 * fib[(x * 3) % W]));
      } else {
        const t = Math.min(1, (rr - 1.0) / 0.12);
        const scl = [200, 186, 177];
        const vein = Math.max(0, fib[(x * 7) % W] - 0.62) * 60 * Math.min(1, Math.max(0, (rr - 1.4) / 1.5));
        const lim = [60, 34, 22];
        c = scl.map((v, j) => lim[j] + (v - lim[j]) * t - (j ? vein : -vein * 0.2) * 0.5 - Math.max(0, rr - 2.4) * 25);
      }
      const o = (y * W + x) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

// ============================================================================
//  Mouth interior: teeth, gums, tongue, oral cavity
// ============================================================================
// inward-facing geometry (so it survives glTF export, which has no BackSide)
function invertGeom(g) {
  const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i]; ix[i] = ix[i + 1]; ix[i + 1] = t; }
  const n = g.attributes.normal; if (n) for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i];
  return g;
}
function superEllipsoid(w, h, d, e = 0.35, seg = 14) {
  const g = new THREE.SphereGeometry(1, seg, seg);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = v => Math.sign(v) * Math.pow(Math.abs(v), e);
    p.setXYZ(i, f(x) * w / 2, f(y) * h / 2, f(z) * d / 2);
  }
  g.computeVertexNormals(); return g;
}
function buildMouth({ lineY, mouthCx, mouthHalf, lipZ0, S, tmj, bonesW, chinY }) {
  const ly = lineY(mouthCx);
  const toothMat = new THREE.MeshPhysicalMaterial({ color: 0xd2c9b6, envMapIntensity: 0.35, roughness: 0.28, clearcoat: 0.6, clearcoatRoughness: 0.15, vertexColors: true });
  const gumMat = new THREE.MeshStandardMaterial({ color: 0xa8484f, envMapIntensity: 0.35, roughness: 0.45, vertexColors: true });
  const tongueMat = new THREE.MeshPhysicalMaterial({ color: 0x93434a, envMapIntensity: 0.35, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4, vertexColors: true });
  const toLocal = v => v.sub(bonesW.head);
  const upperFront = lipZ0 - 0.05;   // ~7 mm behind the lip surface
  const archHalf = mouthHalf * 0.70, depth = 0.17;
  // tooth widths (incisor → molar) in model units
  const widths = [0.046, 0.036, 0.040, 0.037, 0.037, 0.050, 0.050];
  const total = widths.reduce((a, b) => a + b);
  function arch(upper) {
    const grp = new THREE.Group();
    const front = upper ? upperFront : upperFront - 0.012;
    const yEdge = upper ? ly - 0.006 : ly - 0.017;      // incisal edges; lower teeth sit lower & behind (hidden by the lower lip)
    const pt = t => new THREE.Vector3(mouthCx + archHalf * 1.25 * Math.sin(t * 1.2), 0, front - depth * (1 - Math.cos(t * 1.2)) * 1.1);
    for (const sg of [-1, 1]) {
      let acc = 0;
      widths.forEach((w, k) => {
        const tc = (acc + w / 2) / total; acc += w;
        const t = sg * tc * 1.15;
        const p = pt(t), p2 = pt(t + sg * 0.01); const dir = Math.atan2(p2.x - p.x, p2.z - p.z);
        const h = (k < 3 ? 0.054 : 0.042) * (upper ? 1 : 0.82), th = k < 3 ? 0.03 : 0.048;
        const geo = superEllipsoid(w * 0.9, h, th, k < 3 ? 0.42 : 0.55);
        const dark = (upper ? 0.92 : 0.7) - Math.min(0.55, tc * 0.8);
        const col = new Float32Array(geo.attributes.position.count * 3).fill(dark); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const m = new THREE.Mesh(geo, toothMat);
        m.position.set(p.x, upper ? yEdge + h / 2 : yEdge - h / 2, p.z);
        m.rotation.y = dir - Math.PI / 2 * sg;
        m.receiveShadow = true;
        grp.add(m);
      });
    }
    // gum band
    const pts = []; for (let t = -1.2; t <= 1.2001; t += 0.05) { const p = pt(t); p.y = upper ? yEdge + 0.05 : yEdge - 0.046; p.z -= 0.004; pts.push(p); }
    const gum = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.02, 10, false), gumMat);
    gum.scale.set(1, 1, 1);
    const gc = new Float32Array(gum.geometry.attributes.position.count * 3).fill(0.85); gum.geometry.setAttribute('color', new THREE.BufferAttribute(gc, 3));
    gum.receiveShadow = true; grp.add(gum);
    return grp;
  }
  const upper = arch(true); upper.name = 'UpperTeeth';
  upper.position.copy(toLocal(new THREE.Vector3()));
  // jaw pivot at the TMJ (in head-bone space)
  const jawPivot = new THREE.Group(); jawPivot.name = 'JawPivot';
  jawPivot.position.copy(toLocal(new THREE.Vector3(0, tmj.y, tmj.z)));
  const lowerArch = arch(false); lowerArch.name = 'LowerTeeth';
  lowerArch.position.set(0, -tmj.y, -tmj.z);
  jawPivot.add(lowerArch);
  // tongue (ellipsoid with tip-up morph)
  const tg = new THREE.SphereGeometry(1, 40, 24);
  const tp = tg.attributes.position, tipUp = new Float32Array(tp.count * 3), tCol = new Float32Array(tp.count * 3);
  const tR = [mouthHalf * 0.7, 0.032, 0.15];
  for (let i = 0; i < tp.count; i++) {
    let x = tp.getX(i) * tR[0], y = tp.getY(i) * tR[1], z = tp.getZ(i) * tR[2];
    x *= 1 - 0.35 * Math.max(0, z / tR[2]);                 // narrower tip
    y += -0.012 * Math.abs(x / tR[0]) ** 2 * (y > 0 ? -1 : 0) - 0.006 * (y > 0 ? (x / tR[0]) ** 2 : 0); // central groove-ish shape
    tp.setXYZ(i, x, y, z);
    const f = Math.max(0, (z / tR[2] - 0.15) / 0.85); tipUp[i * 3 + 1] = 0.055 * f * f; tipUp[i * 3 + 2] = -0.01 * f;
    const dk = 0.22 + 0.5 * Math.max(0, z / tR[2] * 0.5 + 0.5); tCol.set([dk, dk, dk], i * 3);
  }
  tg.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
  tg.computeVertexNormals();
  tg.morphAttributes.position = [new THREE.BufferAttribute(tipUp, 3)]; tg.morphTargetsRelative = true;
  const tongue = new THREE.Mesh(tg, tongueMat); tongue.name = 'Tongue';
  tongue.morphTargetInfluences = [0]; tongue.morphTargetDictionary = { tongueUp: 0 };
  const tongueRest = new THREE.Vector3(mouthCx, ly - 0.064, upperFront - 0.04 - tR[2]);
  tongue.position.set(tongueRest.x, tongueRest.y - tmj.y, tongueRest.z - tmj.z);
  tongue.receiveShadow = true;
  jawPivot.add(tongue);
  // oral cavity (back faces only → visible only through the mouth opening)
  const cg = new THREE.SphereGeometry(1, 48, 32), cp = cg.attributes.position;
  const cc = new THREE.Vector3(mouthCx, ly - 0.025, lipZ0 - 0.17), cr = [mouthHalf * 0.98, 0.1, 0.19];
  const jawM = new Float32Array(cp.count * 3), cCol = new Float32Array(cp.count * 3);
  for (let i = 0; i < cp.count; i++) {
    const x = cc.x + cp.getX(i) * cr[0], y = cc.y + cp.getY(i) * cr[1], z = cc.z + cp.getZ(i) * cr[2];
    cp.setXYZ(i, x - bonesW.head.x, y - bonesW.head.y, z - bonesW.head.z);
    const w = ss(cc.y + 0.03, cc.y - 0.03, y);
    const ang = JAW_ANGLE * w, dy = y - tmj.y, dz = z - tmj.z;
    jawM[i * 3 + 1] = tmj.y + dy * Math.cos(ang) - dz * Math.sin(ang) - y; jawM[i * 3 + 2] = tmj.z + dy * Math.sin(ang) + dz * Math.cos(ang) - z;
    const dk = 0.35 + 0.65 * Math.max(0, (z - cc.z) / cr[2]); cCol.set([dk, dk * 0.9, dk * 0.9], i * 3);
  }
  cg.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
  cg.morphAttributes.position = [new THREE.BufferAttribute(jawM, 3)]; cg.morphTargetsRelative = true;
  cg.computeVertexNormals(); invertGeom(cg);
  const cavity = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: 0x3c1518, roughness: 0.8, vertexColors: true }));
  cavity.name = 'OralCavity'; cavity.morphTargetInfluences = [0]; cavity.morphTargetDictionary = { jawOpen: 0 };
  function apply(w, JA) {
    const jo = w.jawOpen || 0;
    jawPivot.rotation.x = JA * jo;
    jawPivot.position.copy(toLocal(new THREE.Vector3((w.jawLeft || 0) * 0.022 - (w.jawRight || 0) * 0.022, tmj.y - 0.002 * (w.jawForward || 0), tmj.z + 0.02 * (w.jawForward || 0))));
    cavity.morphTargetInfluences[0] = jo;
    const to = w.tongueOut || 0;
    tongue.position.set(tongueRest.x, tongueRest.y - tmj.y + 0.01 * to, tongueRest.z - tmj.z + 0.075 * to);
    tongue.scale.set(1, 1 - 0.25 * to, 1);
    tongue.morphTargetInfluences[0] = Math.min(1, w.tongueUp || 0) * (1 - to);
  }
  return { upper, jawPivot, cavity, tongue, apply };
}
