// ============================================================================
//  Serene · Facial Animation Studio — application shell
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildRig, ARKIT_52 } from './rig.js';
import { DEFAULT_LANDMARKS } from './landmarks.js';
import { EXPRESSIONS, CONTROLLER, VISEMES, VISEME_LABELS } from './expressions.js';
import { SpeechDriver, AudioLipSync, parseVisemeJSON, externalTTS, detectLang } from './speech.js';
import { RuleEmotionAnalyzer, AIEmotionAnalyzer } from './emotion.js';
import { FaceAnimator } from './animator.js';

const $ = id => document.getElementById(id);
const ASSETS = window.__ASSETS || null;
const asset = p => (ASSETS && ASSETS[p]) || p;
const TEX_LEVELS = window.__TEX_LEVELS || [1, 2, 4, 8];
const isMobile = matchMedia('(pointer:coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const LS = { lm: 'serene.landmarks.v1', presets: 'serene.presets.v1', settings: 'serene.settings.v1' };
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };

// ---------------------------------------------------------------- ui helpers
const toast = (msg, ms = 2600) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms); };
const progress = (p, text) => { $('lbar').style.width = (p * 100).toFixed(0) + '%'; if (text) $('ltext').textContent = text; };
const fatal = msg => { $('loading').classList.remove('done'); $('ltext').classList.add('err'); $('ltext').textContent = msg; console.error(msg); };
const fillRange = el => { const p = (el.value - el.min) / (el.max - el.min) * 100; el.style.setProperty('--p', p + '%'); };
document.addEventListener('input', e => { if (e.target.type === 'range') fillRange(e.target); });
window.addEventListener('error', e => { if (!state.ready) fatal('실행 오류: ' + e.message); else toast('오류: ' + e.message, 5000); });
window.addEventListener('unhandledrejection', e => { const m = e.reason?.message || String(e.reason); if (!state.ready) fatal('실행 오류: ' + m); else toast('오류: ' + m, 5000); });

const state = { ready: false, quality: 'auto', texLevel: isMobile ? 2 : 4, autoRotate: false, light: 'studio', bg: 'dark', calib: false };

// ---------------------------------------------------------------- renderer / scene
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 미지원');
} catch (e) { fatal('WebGL2를 초기화할 수 없습니다. 최신 Chrome / Edge / Safari / Firefox에서 하드웨어 가속을 켜고 다시 열어 주세요.\n(' + e.message + ')'); throw e; }
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;  // Khronos PBR Neutral keeps the original skin hue
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); fatal('GPU 컨텍스트가 손실되었습니다. 텍스처 해상도를 낮추거나 저사양 모드로 다시 열어 주세요.'); });

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
function gradientTex(c0, c1, c2) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512; const g = cv.getContext('2d');
  const gr = g.createRadialGradient(256, 200, 10, 256, 260, 420); gr.addColorStop(0, c0); gr.addColorStop(0.6, c1); gr.addColorStop(1, c2);
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const BG = { dark: gradientTex('#3c3f45', '#1f2125', '#121316'), light: gradientTex('#fbfaf8', '#e5e3df', '#cfccc7') };
scene.background = BG.dark;

const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 0.6; controls.maxDistance = 9;
controls.autoRotateSpeed = 1.2; controls.screenSpacePanning = true;
const VIEWS = {
  front: { p: [0, 0.12, 3.3], t: [0, 0.06, 0] }, side: { p: [3.3, 0.12, 0.05], t: [0, 0.06, 0] }, back: { p: [0, 0.12, -3.3], t: [0, 0.06, 0] },
  q45: { p: [2.3, 0.4, 2.3], t: [0, 0.06, 0] }, face: { p: [0, 0.08, 2.45], t: [0, 0.06, 0.2] }, full: { p: [0, 0.05, 4.8], t: [0, -0.05, 0] },
};
camera.position.set(...VIEWS.front.p); controls.target.set(...VIEWS.front.t);
let camAnim = null;
function goView(name) {
  const v = VIEWS[name], tgt = new THREE.Vector3(...v.t), pos = new THREE.Vector3(...v.p);
  const k = Math.max(1, 0.85 / Math.max(0.3, camera.aspect));   // portrait screens: step back so the head fits
  pos.sub(tgt).multiplyScalar(k).add(tgt);
  camAnim = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: tgt };
  document.querySelectorAll('#camViews button').forEach(b => b.classList.toggle('on', b.dataset.v === name));
}

// lights
const key = new THREE.DirectionalLight(0xffffff, 2); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.00025; key.shadow.normalBias = 0.012; key.shadow.radius = 3;
Object.assign(key.shadow.camera, { left: -1.1, right: 1.1, top: 1.1, bottom: -1.1, near: 0.5, far: 12 });
const fill = new THREE.DirectionalLight(0xffffff, 0.5), rim = new THREE.DirectionalLight(0xffffff, 1), rim2 = new THREE.DirectionalLight(0xffffff, 0.5);
const hemi = new THREE.HemisphereLight(0xffffff, 0x443322, 0.25);
scene.add(key, fill, rim, rim2, hemi);
const LIGHTS = {
  studio: { env: 0.35, key: [0xfff0e2, 1.9, [1.4, 1.6, 2.6]], fill: [0xdfe8ff, 0.45, [-2.2, 0.4, 1.6]], rim: [0xffffff, 1.3, [-1.2, 1.8, -2.4]], rim2: [0xffe6cc, 0.55, [1.8, 0.6, -2]], hemi: [0xffffff, 0x443322, 0.2], exp: 1.05 },
  beauty: { env: 0.7, key: [0xfff4ea, 2.1, [0, 2.4, 2.6]], fill: [0xffe9de, 0.8, [0, -1.6, 2]], rim: [0xffffff, 1.0, [0, 1.6, -2.5]], rim2: [0xfff0e0, 0.4, [-2, 0.5, -1]], hemi: [0xffffff, 0x665544, 0.3], exp: 1.12 },
  rembrandt: { env: 0.22, key: [0xffe2c4, 3.1, [-2.1, 1.8, 1.4]], fill: [0x9fb6ff, 0.16, [2.4, 0.2, 1.2]], rim: [0xffffff, 0.6, [1.5, 1.5, -2]], rim2: [0xffffff, 0, [0, 0, -1]], hemi: [0xffffff, 0x221a14, 0.08], exp: 1.1 },
  rim: { env: 0.15, key: [0xffffff, 0.75, [0.5, 1.2, 3]], fill: [0xffffff, 0, [0, 0, 1]], rim: [0x7fb0ff, 3.4, [-2.4, 1.0, -1.5]], rim2: [0xffa060, 3.2, [2.4, 1.0, -1.5]], hemi: [0xffffff, 0x000000, 0.05], exp: 1.2 },
  day: { env: 0.9, key: [0xfff6e8, 2.6, [2.5, 3.5, 2]], fill: [0xbcd4ff, 0.5, [-2, 1, 1]], rim: [0xffffff, 0.7, [-1, 2, -3]], rim2: [0xffffff, 0, [0, 0, -1]], hemi: [0xcfe3ff, 0x7a6a55, 0.6], exp: 1.1 },
};
function setLighting(name) {
  const L = LIGHTS[name]; state.light = name;
  scene.environmentIntensity = L.env; renderer.toneMappingExposure = L.exp;
  for (const [l, d] of [[key, L.key], [fill, L.fill], [rim, L.rim], [rim2, L.rim2]]) { l.color.set(d[0]); l.intensity = d[1]; l.position.set(...d[2]); }
  hemi.color.set(L.hemi[0]); hemi.groundColor.set(L.hemi[1]); hemi.intensity = L.hemi[2];
}
setLighting('studio');

// ---------------------------------------------------------------- loading
// Skin: dielectric (metalness 0). Gloss and tone are adjustable (UI sliders); the grade is masked to skin only.
const skinMat = new THREE.MeshPhysicalMaterial({ roughness: 1.0, metalness: 0, vertexColors: true, ior: 1.4, specularIntensity: 0.3, envMapIntensity: 0.55 });
const skinTone = { value: 0.75 }, skinGloss = { value: 0.3 }, skinDebug = { value: 0 };
// fair Caucasian reference: average scan skin → target (sRGB 241,212,197), both in linear
const SKIN_SRC = new THREE.Color().setRGB(180 / 255, 141 / 255, 115 / 255, THREE.SRGBColorSpace);
const SKIN_DST = new THREE.Color().setRGB(241 / 255, 212 / 255, 197 / 255, THREE.SRGBColorSpace);
const skinRatio = { value: new THREE.Vector3(SKIN_DST.r / SKIN_SRC.r, SKIN_DST.g / SKIN_SRC.g, SKIN_DST.b / SKIN_SRC.b) };
function setGloss(g) {   // 0 = matte/powdered … 1 = oily/wet. Real skin ≈ 0.25–0.4
  skinGloss.value = g;
  skinMat.roughness = 1.25 - 0.75 * g;        // multiplies the scan roughness map (~0.62) → 0.78 … 0.31
  skinMat.specularIntensity = 0.12 + 0.55 * g;
  skinMat.envMapIntensity = 0.25 + 0.6 * g;
}
setGloss(0.3);
skinMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, { uSkinTone: skinTone, uSkinRatio: skinRatio, uSkinDebug: skinDebug });
  sh.vertexShader = 'attribute float skinMask;\nvarying float vSkin;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vSkin = skinMask;');
  sh.fragmentShader = 'uniform float uSkinTone; uniform vec3 uSkinRatio; uniform float uSkinDebug; varying float vSkin;\n' + sh.fragmentShader
    .replace('#include <map_fragment>', `#include <map_fragment>
      {
        // re-tint the scan albedo toward fair Caucasian skin: per-channel gain that maps the average
        // scan skin colour onto the target, so freckles / pores / make-up contrast are preserved.
        vec3 c = diffuseColor.rgb;
        vec3 t = min(c * uSkinRatio, vec3(1.0));
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float m = vSkin * smoothstep(0.02, 0.08, l) * uSkinTone;   // keep lashes / brows-dark strands
        diffuseColor.rgb = mix(c, t, m);
        if (uSkinDebug > 0.5) diffuseColor.rgb = vec3(vSkin);
      }`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      // soft subsurface look: lift shadowed diffuse with a red-shifted wrap term (light bleeding through skin)
      reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.32, 0.12, 0.08) * 0.35 * vSkin;
      reflectedLight.directDiffuse *= mix(vec3(1.0), vec3(1.03, 0.98, 0.96), vSkin);`);
};
const texLoader = new THREE.TextureLoader();
let rig = null, srcGeom = null;
const animator = new FaceAnimator();
let LM = store.get(LS.lm, null) || structuredClone(DEFAULT_LANDMARKS);

function loadTex(url, srgb) {
  return new Promise((res, rej) => texLoader.load(asset(url), t => { t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); res(t); }, undefined, () => rej(new Error('텍스처를 불러올 수 없습니다: ' + url))));
}
async function setTextureLevel(level, onProg) {
  const maxTex = renderer.capabilities.maxTextureSize;
  if (level * 1024 > maxTex) { toast(`이 기기의 최대 텍스처 크기(${maxTex}px)를 넘어 ${maxTex / 1024 | 0}K로 낮춥니다.`); level = Math.max(...TEX_LEVELS.filter(l => l * 1024 <= maxTex)); }
  const sub = TEX_LEVELS.filter(l => l <= Math.min(level, 4)).pop() || TEX_LEVELS[0];
  const files = [[`assets/tex/basecolor_${level}k.webp`, true], [`assets/tex/normal_${sub}k.webp`, false], [`assets/tex/orm_${sub}k.webp`, false]];
  let n = 0; const tex = await Promise.all(files.map(([f, s]) => loadTex(f, s).then(t => { onProg && onProg(++n / files.length); return t; })));
  const old = [skinMat.map, skinMat.normalMap, skinMat.roughnessMap];
  skinMat.map = tex[0]; skinMat.normalMap = tex[1]; skinMat.normalScale.set(0.7, 0.7); skinMat.roughnessMap = tex[2]; skinMat.metalnessMap = null;
  skinMat.needsUpdate = true;
  old.forEach(t => t && t !== skinMat.roughnessMap && t.dispose());
  state.texLevel = level; $('selTex').value = level;
}
function rebuildRig(lm) {
  const t0 = performance.now();
  if (rig) { rig.group.removeFromParent(); rig.dispose(); }
  const logs = [];
  rig = buildRig(srcGeom, lm, { material: skinMat, morphNormals: !isMobile && state.quality !== 'low', log: s => logs.push(s) });
  rig.bones.rootRestY = rig.bones.root.position.y;
  scene.add(rig.group);
  const i = rig.info;
  $('rigInfo').innerHTML = `<b>리그 정보</b><br>얼굴 변형 메시 ${i.faceVerts.toLocaleString()} 버텍스 · 정적 메시 ${i.restVerts.toLocaleString()} 버텍스<br>삼각형 ${i.tris.toLocaleString()} (원본 1,074,502)<br>모프 타깃 ${rig.morphNames.length}개 (ARKit 52 매핑 + 보정 3) · 본 3개<br>안구 반지름 ${(i.eyeR * 176).toFixed(1)}mm 환산 · 생성 ${(performance.now() - t0).toFixed(0)}ms`;
  console.log(logs.join('\n'));
  return rig;
}

async function init() {
  if (location.protocol === 'file:' && !ASSETS) {
    fatal('이 버전은 로컬 웹서버가 필요합니다 (브라우저가 file:// 에서 모델 파일 로딩을 차단).\n폴더에서  python -m http.server 8000  실행 후 http://localhost:8000 으로 열거나,\n함께 제공된 단일 HTML 버전(serene_face_studio_single.html)을 여세요.');
    return;
  }
  progress(0.02, '3D 모델 불러오는 중…');
  const gltf = await new GLTFLoader().loadAsync(asset('assets/head.glb'), e => { if (e.total) progress(0.02 + 0.5 * e.loaded / e.total, `3D 모델 불러오는 중… ${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`); })
    .catch(e => { throw new Error('모델(GLB)을 불러오지 못했습니다: ' + e.message); });
  let src; gltf.scene.traverse(o => { if (o.isMesh && !src) src = o; });
  src.updateMatrixWorld(true); srcGeom = src.geometry.clone().applyMatrix4(src.matrixWorld);
  progress(0.55, '텍스처 불러오는 중…');
  const level = TEX_LEVELS.includes(state.texLevel) ? state.texLevel : TEX_LEVELS[TEX_LEVELS.length - 1];
  await setTextureLevel(Math.min(level, TEX_LEVELS[TEX_LEVELS.length - 1]), p => progress(0.55 + 0.25 * p));
  progress(0.82, '얼굴 리그 생성 중… (특징점 → 블렌드셰이프 52 · 입/눈 구조)');
  await new Promise(r => setTimeout(r, 30));
  try { rebuildRig(LM); } catch (e) {
    console.error(e);
    if (store.get(LS.lm)) { toast('저장된 캘리브레이션으로 리그 생성 실패 → 기본값 사용'); LM = structuredClone(DEFAULT_LANDMARKS); rebuildRig(LM); } else throw e;
  }
  progress(1, '완료');
  buildUI();
  state.ready = true;
  $('loading').classList.add('done');
  goView('front');
  renderer.compile(scene, camera);
}

// ---------------------------------------------------------------- quality
let pixelRatio = 1, frameTimes = [], qualityStep = 0;
function applyQuality() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (state.quality === 'high') { pixelRatio = dpr; key.castShadow = true; }
  else if (state.quality === 'low') { pixelRatio = Math.min(1, dpr) * (isMobile ? 0.85 : 1); key.castShadow = false; }
  else { pixelRatio = Math.min(dpr, isMobile ? 1.5 : 2) * [1, 0.85, 0.7, 0.7][qualityStep]; key.castShadow = qualityStep < 3; }
  renderer.setPixelRatio(pixelRatio); resize();
}
function autoQuality(dt) {
  if (state.quality !== 'auto') return;
  frameTimes.push(dt); if (frameTimes.length < 120) return;
  const avg = frameTimes.reduce((a, b) => a + b) / frameTimes.length; frameTimes = [];
  if (avg > 1 / 40 && qualityStep < 3) { qualityStep++; applyQuality(); toast(`자동 품질 조정: 단계 ${qualityStep} (평균 ${(1 / avg).toFixed(0)}fps)`); }
  else if (avg < 1 / 58 && qualityStep > 0) { qualityStep--; applyQuality(); }
}
function resize() {
  const v = $('view'), w = v.clientWidth, h = v.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  if (state.calib) layoutCalib();
}
new ResizeObserver(resize).observe($('view'));
applyQuality();

// ---------------------------------------------------------------- speech / audio
const driver = new SpeechDriver();
const rules = new RuleEmotionAnalyzer();
let analyzer = rules;
let audioCtx = null, audioEl = null, audioSrc = null, audioLS = null, visTrack = null, micStream = null, micSrc = null, recDest = null;
const visOut = {};
let lipMode = 'idle', baseExpr = { neutral: 1 }, restoreTimer = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioLS = new AudioLipSync(audioCtx); recDest = audioCtx.createMediaStreamDestination();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function ensureAudioEl() {
  if (audioEl) return audioEl;
  audioEl = new Audio(); audioEl.crossOrigin = 'anonymous';
  ensureAudio();
  audioSrc = audioCtx.createMediaElementSource(audioEl);
  audioSrc.connect(audioLS.input()); audioSrc.connect(audioCtx.destination); audioSrc.connect(recDest);
  audioEl.addEventListener('ended', () => { setLip('idle'); onSpeechEnd(); });
  return audioEl;
}
function setLip(mode, label) {
  lipMode = mode; const b = $('lipBadge');
  const L = { idle: ['대기', ''], approx: ['근사 립싱크 · 브라우저 음성 (텍스트 타이밍 추정 + 단어 경계 재동기화)', 'approx'], sim: ['무음 미리보기 · 사용 가능한 음성 없음 (텍스트 타이밍 추정)', 'sim'], analysis: ['오디오 분석 립싱크 · 실제 파형 기반 (타이밍 정확, 입 모양 추정)', 'analysis'], exact: ['정확 립싱크 · 비즘 타임스탬프 동기화', 'exact'] }[mode];
  b.textContent = label || L[0]; b.className = 'badge ' + L[1];
  $('hudMode').textContent = mode === 'idle' ? '' : b.textContent.split('·')[0].trim();
}
function onSentence(text) {
  if (!$('chkAutoEmo').checked) return;
  const handle = r => {
    $('emoReadout').innerHTML = `“${text.slice(0, 40)}${text.length > 40 ? '…' : ''}”<br>→ <b>${EXPRESSIONS.find(e => e.id === r.emotion)?.ko || r.emotion}</b> ${(r.intensity * 100).toFixed(0)}% ${r.gestures.length ? '· ' + r.gestures.join(', ') : ''} ${r.source ? '<br><span class="hint">' + r.source + '</span>' : ''}`;
    $('hudEmo').textContent = r.emotion === 'neutral' ? '' : '감정: ' + (EXPRESSIONS.find(e => e.id === r.emotion)?.ko || r.emotion);
    if (r.emotion !== 'neutral') { const m = {}; for (const [k, v] of Object.entries(baseExpr)) m[k] = v * 0.35; m[r.emotion] = (m[r.emotion] || 0) + r.intensity; animator.setExpressionMix(m); }
    for (const g of r.gestures) animator.gesture(g);
  };
  clearTimeout(restoreTimer);
  if (analyzer.analyzeAsync) analyzer.analyzeAsync(text, $('txt').value).then(handle); else handle(analyzer.analyze(text));
}
function onSpeechEnd() {
  animator.speaking = false; animator.viseme = null;
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => { if (!animator.speaking) { animator.setExpressionMix({ ...baseExpr }); $('hudEmo').textContent = ''; } }, 900);
  $('btnSpeak').textContent = '▶ 말하기';
}
driver.on('sentence', s => onSentence(s.text));
driver.on('word', () => { if (Math.random() < 0.18) animator.triggerNod(0.4); });
driver.on('end', () => { setLip('idle'); onSpeechEnd(); });
driver.on('error', e => toast('음성 합성 오류: ' + e));

function pickVoice(text) {
  const sel = $('selVoice').value, vs = driver.voices();
  if (sel !== 'auto') return vs.find(v => v.voiceURI === sel) || null;
  const lang = detectLang(text);
  const cands = vs.filter(v => v.lang.toLowerCase().startsWith(lang));
  return cands.find(v => /natural|neural|online|google/i.test(v.name)) || cands.find(v => v.localService) || cands[0] || null;
}
async function speak() {
  const text = $('txt').value.trim(); if (!text) return;
  const mode = $('selMode').value;
  stopAll(true);
  animator.speaking = true;
  if (mode === 'tts') {
    const voice = pickVoice(text);
    if (!voice) toast(`‘${detectLang(text)}’ 음성을 찾지 못했습니다. 무음 미리보기로 립싱크만 재생합니다. (OS/브라우저에 해당 언어 음성 설치 필요)`, 5200);
    driver.calib = $('rngCal').value / 100;
    driver.speak(text, { voice, rate: $('rngRate').value / 100, pitch: $('rngPitch').value / 100, volume: $('rngVol').value / 100 });
    setLip(driver.simulate ? 'sim' : 'approx');
  } else if (mode === 'audio') {
    const el = ensureAudioEl();
    if (!el.src) { toast('먼저 오디오 파일을 열어 주세요.'); animator.speaking = false; return; }
    el.currentTime = 0; el.volume = $('rngVol').value / 100; el.playbackRate = $('rngRate').value / 100;
    await el.play(); setLip(visTrack ? 'exact' : 'analysis');
    onSentence(text);
  } else if (mode === 'mic') {
    ensureAudio();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      micSrc = audioCtx.createMediaStreamSource(micStream); micSrc.connect(audioLS.input()); micSrc.connect(recDest);
      setLip('analysis', '마이크 실시간 분석 립싱크'); $('btnSpeak').textContent = '● 마이크 사용 중';
    } catch (e) { toast('마이크 권한이 필요합니다: ' + e.message); animator.speaking = false; }
  } else if (mode === 'external') {
    const ep = $('extEndpoint').value.trim(); if (!ep) { toast('외부 TTS 서버 주소를 입력하세요 (README의 server 예제 참고).'); animator.speaking = false; return; }
    store.set(LS.settings, { ...store.get(LS.settings, {}), extEndpoint: ep });
    setLip('exact', '외부 TTS 요청 중…');
    try {
      const { url, track } = await externalTTS(ep, { text, lang: detectLang(text), rate: $('rngRate').value / 100, pitch: $('rngPitch').value / 100 });
      const el = ensureAudioEl(); el.src = url; visTrack = track; el.volume = $('rngVol').value / 100; el.playbackRate = 1;
      await el.play(); setLip('exact'); onSentence(text);
    } catch (e) { toast('외부 TTS 실패: ' + e.message, 5000); setLip('idle'); animator.speaking = false; }
  }
  if (mode !== 'mic') $('btnSpeak').textContent = '↻ 다시 말하기';
}
function pauseAll() {
  if (driver.state === 'speaking') { driver.pause(); $('btnPause').textContent = '▶'; }
  else if (driver.state === 'paused') { driver.resume(); $('btnPause').textContent = '❚❚'; }
  else if (audioEl && audioEl.src && lipMode !== 'idle') { if (audioEl.paused) { audioEl.play(); $('btnPause').textContent = '❚❚'; } else { audioEl.pause(); $('btnPause').textContent = '▶'; } }
}
function stopAll(silent) {
  driver.stop();
  if (audioEl) { audioEl.pause(); try { audioEl.currentTime = 0; } catch { } }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; micSrc && micSrc.disconnect(); micSrc = null; }
  $('btnPause').textContent = '❚❚';
  if (!silent) { setLip('idle'); onSpeechEnd(); }
}

// ---------------------------------------------------------------- recording / screenshot
let recorder = null, recChunks = [];
function pickMime() { for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; return ''; }
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function startRecorder(stream, label) {
  const mime = pickMime(); if (!mime) { toast('이 브라우저는 동영상 녹화를 지원하지 않습니다.'); return null; }
  recChunks = []; const r = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
  r.ondataavailable = e => e.data.size && recChunks.push(e.data);
  r.onstop = () => { download(new Blob(recChunks, { type: mime }), `serene_${label}_${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`); stream.getTracks().forEach(t => t.kind === 'video' && t.stop && label === 'tab' && t.stop()); };
  r.start(250); return r;
}
function toggleRec() {
  if (recorder) { recorder.stop(); recorder = null; $('btnRec').classList.remove('on'); $('btnRec').textContent = '● REC'; return; }
  const vs = renderer.domElement.captureStream(30);
  if (audioCtx && recDest) recDest.stream.getAudioTracks().forEach(t => vs.addTrack(t));
  recorder = startRecorder(vs, 'canvas');
  if (recorder) { $('btnRec').classList.add('on'); $('btnRec').textContent = '■ 녹화 중'; toast('캔버스 녹화 시작 — 오디오 파일·외부 TTS·마이크 음성은 함께 녹음됩니다. 브라우저 음성은 ‘탭’ 녹화를 쓰세요.', 5200); }
}
async function recTab() {
  if (recorder) return toggleRec();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include' });
    recorder = startRecorder(s, 'tab'); $('btnRec').classList.add('on'); $('btnRec').textContent = '■ 녹화 중';
    s.getVideoTracks()[0].addEventListener('ended', () => { if (recorder) toggleRec(); });
    toast('탭 녹화: 공유 창에서 “이 탭”과 “탭 오디오 공유”를 선택하세요.', 5000);
  } catch (e) { toast('탭 녹화를 시작할 수 없습니다: ' + e.message); }
}
function screenshot() {
  const s = +$('selShot').value, w = renderer.domElement.width, h = renderer.domElement.height;
  const maxDim = Math.min(renderer.capabilities.maxRenderbufferSize || 8192, 8192);
  const k = Math.min(s, maxDim / Math.max(w, h));
  renderer.setPixelRatio(pixelRatio * k); resize();
  renderer.render(scene, camera);
  renderer.domElement.toBlob(b => { download(b, `serene_${Math.round(w * k)}x${Math.round(h * k)}.png`); toast(`스크린샷 저장 (${Math.round(w * k)}×${Math.round(h * k)})`); }, 'image/png');
  renderer.setPixelRatio(pixelRatio); resize();
}
async function exportGLB() {
  toast('GLB 내보내는 중… (리그 · 블렌드셰이프 · 텍스처 포함)', 6000);
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  rig.apply({}); rig.group.updateMatrixWorld(true);
  const ab = await new GLTFExporter().parseAsync(rig.group, { binary: true, maxTextureSize: Math.min(4096, state.texLevel * 1024) });
  download(new Blob([ab], { type: 'model/gltf-binary' }), 'serene_face_rig.glb');
  toast(`GLB 저장 완료 (${(ab.byteLength / 1048576).toFixed(1)} MB)`);
  return ab;
}
window.__exportGLB = exportGLB;

// ---------------------------------------------------------------- calibration
const orthoCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.55, -0.45, 0.01, 20); orthoCam.position.set(0, 0, 5);
let calPts = [], calDrag = null;
const CAL_SPEC = () => {
  const P = [];
  for (const s of ['R', 'L']) {
    LM[s].eyeUpper.forEach((p, i) => P.push({ ref: [s, 'eyeUpper', i], label: i === 0 || i === LM[s].eyeUpper.length - 1 ? '' : '' }));
    LM[s].eyeLower.forEach((p, i) => { if (i > 0 && i < LM[s].eyeLower.length - 1) P.push({ ref: [s, 'eyeLower', i] }); });
    P.push({ ref: [s, 'iris'], label: '눈동자' });
    LM[s].brow.forEach((p, i) => P.push({ ref: [s, 'brow', i] }));
    P.push({ ref: [s, 'mouthCorner'], label: '입꼬리' }, { ref: [s, 'noseAla'], label: '콧볼' });
  }
  LM.C.lipLine.forEach((p, i) => { if (i > 0 && i < LM.C.lipLine.length - 1) P.push({ ref: ['C', 'lipLine', i] }); });
  for (const k of ['upperLipTop', 'lowerLipBottom', 'chin', 'chinCrease', 'noseTip', 'forehead']) P.push({ ref: ['C', k], label: { upperLipTop: '윗입술', lowerLipBottom: '아랫입술', chin: '턱끝', chinCrease: '턱주름', noseTip: '코끝', forehead: '이마' }[k] });
  return P;
};
const getRef = r => r.length === 3 ? LM[r[0]][r[1]][r[2]] : LM[r[0]][r[1]];
function syncLM() {
  for (const s of ['R', 'L']) { const u = LM[s].eyeUpper, l = LM[s].eyeLower; l[0] = u[0].slice(); l[l.length - 1] = u[u.length - 1].slice(); }
  LM.C.lipLine[0] = LM.R.mouthCorner.slice(); LM.C.lipLine[LM.C.lipLine.length - 1] = LM.L.mouthCorner.slice();
}
function layoutCalib() {
  const v = $('view'), w = v.clientWidth, h = v.clientHeight, asp = w / h;
  let H = 1.12, W = H * asp; if (W < 0.9) { W = 0.9; H = W / asp; }
  Object.assign(orthoCam, { left: -W / 2, right: W / 2, top: 0.06 + H / 2 + 0.04, bottom: 0.06 - H / 2 + 0.04 }); orthoCam.updateProjectionMatrix();
  const svg = $('calSvg'); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const toS = p => [(p[0] - orthoCam.left) / (orthoCam.right - orthoCam.left) * w, (orthoCam.top - p[1]) / (orthoCam.top - orthoCam.bottom) * h];
  const lines = [];
  for (const s of ['R', 'L']) { lines.push(LM[s].eyeUpper, LM[s].eyeLower, LM[s].brow); }
  lines.push(LM.C.lipLine);
  let html = lines.map(l => `<polyline points="${l.map(p => toS(p).join(',')).join(' ')}"/>`).join('');
  calPts = CAL_SPEC();
  calPts.forEach((P, i) => { const [x, y] = toS(getRef(P.ref)); html += `<circle data-i="${i}" cx="${x}" cy="${y}" r="${isMobile ? 9 : 5.5}"/>` + (P.label ? `<text x="${x + 8}" y="${y - 6}">${P.label}</text>` : ''); });
  svg.innerHTML = html;
  svg._toM = (sx, sy) => [orthoCam.left + sx / w * (orthoCam.right - orthoCam.left), orthoCam.top - sy / h * (orthoCam.top - orthoCam.bottom)];
}
function openCalib(open) {
  state.calib = open; $('calib').classList.toggle('hidden', !open); $('btnCalib').classList.toggle('on', open);
  controls.enabled = !open;
  if (open) { layoutCalib(); toast('정면 직교 뷰: 점을 드래그하여 특징점을 조정하세요.'); }
}
function bindCalib() {
  const svg = $('calSvg');
  svg.addEventListener('pointerdown', e => { const c = e.target.closest('circle'); if (!c) return; calDrag = calPts[+c.dataset.i]; c.classList.add('sel'); svg.setPointerCapture(e.pointerId); });
  svg.addEventListener('pointermove', e => {
    if (!calDrag) return; const r = svg.getBoundingClientRect(); const [x, y] = svg._toM(e.clientX - r.left, e.clientY - r.top);
    const ref = calDrag.ref; if (ref.length === 3) LM[ref[0]][ref[1]][ref[2]] = [x, y]; else LM[ref[0]][ref[1]] = [x, y];
    syncLM(); layoutCalib();
  });
  svg.addEventListener('pointerup', () => { calDrag = null; });
  $('calApply').onclick = () => { syncLM(); try { rebuildRig(LM); store.set(LS.lm, LM); toast('리그를 새 특징점으로 재생성했습니다.'); } catch (e) { toast('리그 생성 실패: ' + e.message, 5000); } };
  $('calReset').onclick = () => { LM = structuredClone(DEFAULT_LANDMARKS); localStorage.removeItem(LS.lm); layoutCalib(); rebuildRig(LM); toast('기본 특징점으로 복원했습니다.'); };
  $('calExport').onclick = () => download(new Blob([JSON.stringify(LM, null, 1)], { type: 'application/json' }), 'serene_landmarks.json');
  $('calImport').onchange = async e => { const f = e.target.files[0]; if (!f) return; LM = JSON.parse(await f.text()); layoutCalib(); toast('불러옴 — ‘리그 재생성’을 눌러 적용하세요.'); };
  $('calClose').onclick = () => openCalib(false);
}

// ---------------------------------------------------------------- UI
let ctrlVals = {}, mixMode = false, mixMap = {}, currentExpr = 'neutral';
function updateManual() {
  const m = {}; let gaze = 0;
  for (const c of CONTROLLER) { const v = ctrlVals[c.id] || 0; if (!v) continue; if (c.gaze) gaze += Math.abs(v); for (const [k, x] of Object.entries(c.map(v))) m[k] = (m[k] || 0) + x; }
  animator.manual = m; animator.manualGazeAmt = gaze;
}
function makeSlider(parent, { id, label, min, max, step = 0.01, value = 0, fmt = v => v.toFixed(2), onInput }) {
  const d = document.createElement('div'); d.className = 'ctrl';
  d.innerHTML = `<label>${label}<output>${fmt(value)}</output></label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-id="${id}">`;
  const inp = d.querySelector('input'), out = d.querySelector('output');
  inp.addEventListener('input', () => { out.textContent = fmt(+inp.value); onInput(+inp.value); });
  inp.addEventListener('dblclick', () => { inp.value = 0; inp.dispatchEvent(new Event('input', { bubbles: true })); });
  parent.appendChild(d); fillRange(inp); return inp;
}
function renderMix() {
  const box = $('mixList'); box.innerHTML = '';
  if (!mixMode) return;
  for (const [id, v] of Object.entries(mixMap)) {
    const e = EXPRESSIONS.find(x => x.id === id); const d = document.createElement('div'); d.className = 'mixitem';
    d.innerHTML = `<span>${e.icon} ${e.ko}</span><input type="range" min="0" max="100" value="${v * 100}"><output>${(v * 100) | 0}%</output>`;
    const inp = d.querySelector('input'); fillRange(inp);
    inp.oninput = () => { mixMap[id] = inp.value / 100; d.querySelector('output').textContent = inp.value + '%'; baseExpr = { ...mixMap }; animator.setExpressionMix(baseExpr); };
    box.appendChild(d);
  }
}
function selectExpr(id) {
  if (mixMode) { if (mixMap[id] !== undefined) delete mixMap[id]; else mixMap[id] = 0.6; baseExpr = Object.keys(mixMap).length ? { ...mixMap } : { neutral: 1 }; }
  else { currentExpr = id; baseExpr = { [id]: 1 }; }
  animator.setExpressionMix({ ...baseExpr });
  document.querySelectorAll('#exprGrid button').forEach(b => b.classList.toggle('on', mixMode ? mixMap[b.dataset.id] !== undefined : b.dataset.id === currentExpr));
  renderMix();
}
function renderPresets() {
  const list = store.get(LS.presets, []); const box = $('presetList'); box.innerHTML = list.length ? '' : '<div class="hint">저장된 프리셋이 없습니다.</div>';
  list.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'preset'; d.innerHTML = `<span title="${p.name}">${p.name}</span><button>불러오기</button><button>삭제</button>`;
    const [bl, bd] = d.querySelectorAll('button');
    bl.onclick = () => applyPreset(p); bd.onclick = () => { list.splice(i, 1); store.set(LS.presets, list); renderPresets(); };
    box.appendChild(d);
  });
}
function applyPreset(p) {
  ctrlVals = { ...p.ctrl }; animator.raw = { ...(p.raw || {}) };
  document.querySelectorAll('#ctrlSliders input').forEach(i => { i.value = ctrlVals[i.dataset.id] || 0; i.dispatchEvent(new Event('input', { bubbles: true })); });
  document.querySelectorAll('#rawSliders input').forEach(i => { i.value = animator.raw[i.dataset.id] || 0; i.dispatchEvent(new Event('input', { bubbles: true })); });
  if (p.expr) { const ids = Object.keys(p.expr); if (ids.length > 1 && !mixMode) { $('chkMix').checked = true; $('chkMix').dispatchEvent(new Event('change')); } if (mixMode) { mixMap = { ...p.expr }; baseExpr = { ...mixMap }; animator.setExpressionMix(baseExpr); renderMix(); document.querySelectorAll('#exprGrid button').forEach(b => b.classList.toggle('on', mixMap[b.dataset.id] !== undefined)); } else selectExpr(ids[0] || 'neutral'); }
  if (p.intensity !== undefined) { $('rngInt').value = p.intensity * 100; $('rngInt').dispatchEvent(new Event('input', { bubbles: true })); }
  updateManual(); toast(`프리셋 ‘${p.name}’ 적용`);
}
function resetAll() {
  ctrlVals = {}; animator.raw = {};
  document.querySelectorAll('#ctrlSliders input, #rawSliders input').forEach(i => { i.value = 0; i.dispatchEvent(new Event('input', { bubbles: true })); });
  mixMap = {}; if (mixMode) { $('chkMix').checked = false; $('chkMix').dispatchEvent(new Event('change')); }
  selectExpr('neutral'); stopAll(); updateManual(); toast('모든 표정을 초기 상태로 되돌렸습니다.');
}
const SAMPLES = {
  ko: '안녕하세요. 정말 만나서 반가워요! 오늘은 제 표정과 목소리를 보여 드릴게요.',
  ko2: '너무 슬픈 일이 있었어요. 아직도 마음이 아프네요…',
  ko3: '정말 놀라운 일이네요! 이건 믿기 어려워요.',
  ko4: '이 부분은 조금 더 생각해 봐야겠습니다. 음… 어떻게 하면 좋을까요?',
  en: "Hello! It's really nice to meet you. I can smile, frown, and speak with natural lip movements.",
  ja: 'こんにちは。お会いできてとても嬉しいです！今日はよろしくお願いします。',
};
function buildUI() {
  // expressions
  const g = $('exprGrid');
  EXPRESSIONS.forEach((e, i) => { const b = document.createElement('button'); b.dataset.id = e.id; b.title = (i + 1) + '. ' + e.ko + (e.facs ? ' · FACS ' + e.facs : ''); b.innerHTML = `<span class="ic">${e.icon}</span>${e.ko}`; b.onclick = () => selectExpr(e.id); g.appendChild(b); });
  selectExpr('neutral');
  $('chkMix').onchange = e => {
    mixMode = e.target.checked; $('mixHint').textContent = mixMode ? '여러 표정을 선택해 혼합' : '클릭하여 전환';
    if (mixMode) { mixMap = currentExpr !== 'neutral' ? { [currentExpr]: 1 } : {}; baseExpr = Object.keys(mixMap).length ? { ...mixMap } : { neutral: 1 }; animator.setExpressionMix({ ...baseExpr }); document.querySelectorAll('#exprGrid button').forEach(b => b.classList.toggle('on', mixMap[b.dataset.id] !== undefined)); renderMix(); }
    else selectExpr(currentExpr);
  };
  $('rngInt').oninput = e => { animator.intensity = e.target.value / 100; $('oInt').textContent = e.target.value + '%'; };
  $('rngSkin').oninput = e => { skinTone.value = e.target.value / 100; $('oSkin').textContent = e.target.value + '%'; store.set(LS.settings, { ...store.get(LS.settings, {}), skin2: +e.target.value }); };
  $('rngGloss').oninput = e => { setGloss(e.target.value / 100); $('oGloss').textContent = e.target.value + '%'; store.set(LS.settings, { ...store.get(LS.settings, {}), gloss: +e.target.value }); };
  { const st = store.get(LS.settings, {});
    if (st.skin2 !== undefined) { $('rngSkin').value = st.skin2; skinTone.value = st.skin2 / 100; $('oSkin').textContent = st.skin2 + '%'; }
    if (st.gloss !== undefined) { $('rngGloss').value = st.gloss; setGloss(st.gloss / 100); $('oGloss').textContent = st.gloss + '%'; } }
  $('rngTrans').oninput = e => { animator.transition = e.target.value / 100; $('oTrans').textContent = (e.target.value / 100).toFixed(2) + 's'; };
  for (const [id, k] of [['chkBlink', 'blink'], ['chkHead', 'head'], ['chkBreath', 'breath'], ['chkMicro', 'micro']]) $(id).onchange = e => animator.idle[k] = e.target.checked;
  $('selGaze').onchange = e => animator.idle.gaze = e.target.value;
  $('selAnalyzer').onchange = e => { const ai = e.target.value === 'ai'; $('aiEndpoint').classList.toggle('hidden', !ai); analyzer = ai ? new AIEmotionAnalyzer($('aiEndpoint').value.trim(), rules) : rules; };
  $('aiEndpoint').onchange = e => { if ($('selAnalyzer').value === 'ai') analyzer = new AIEmotionAnalyzer(e.target.value.trim(), rules); };
  // controller
  const cs = $('ctrlSliders');
  for (const c of CONTROLLER) makeSlider(cs, { id: c.id, label: c.ko, min: c.range[0], max: c.range[1], onInput: v => { ctrlVals[c.id] = v; updateManual(); } });
  const rs = $('rawSliders');
  for (const n of ARKIT_52) makeSlider(rs, { id: n, label: n, min: 0, max: 1, onInput: v => { if (v) animator.raw[n] = v; else delete animator.raw[n]; } });
  $('btnReset').onclick = resetAll;
  $('btnSavePreset').onclick = () => {
    const name = $('presetName').value.trim() || `프리셋 ${new Date().toLocaleTimeString()}`;
    const list = store.get(LS.presets, []); list.push({ name, ctrl: { ...ctrlVals }, raw: { ...animator.raw }, expr: { ...baseExpr }, intensity: animator.intensity });
    store.set(LS.presets, list); $('presetName').value = ''; renderPresets(); toast(`‘${name}’ 저장됨`);
  };
  renderPresets();
  // top bar
  document.querySelectorAll('#camViews button').forEach(b => b.onclick = () => goView(b.dataset.v));
  $('btnAutoRot').onclick = () => { controls.autoRotate = !controls.autoRotate; $('btnAutoRot').classList.toggle('on', controls.autoRotate); };
  $('btnCamReset').onclick = () => { controls.autoRotate = false; $('btnAutoRot').classList.remove('on'); goView('front'); };
  $('selLight').onchange = e => setLighting(e.target.value);
  $('btnBg').onclick = () => { state.bg = state.bg === 'dark' ? 'light' : 'dark'; document.body.className = state.bg; scene.background = BG[state.bg]; $('btnBg').classList.toggle('on', state.bg === 'light'); };
  const st = $('selTex'); const names = { 1: '텍스처 1K', 2: '텍스처 2K', 4: '텍스처 4K', 8: '텍스처 8K (Ultra)' };
  TEX_LEVELS.forEach(l => { const o = document.createElement('option'); o.value = l; o.textContent = names[l]; st.appendChild(o); }); st.value = state.texLevel;
  st.onchange = async e => { toast('텍스처 불러오는 중…'); try { await setTextureLevel(+e.target.value); toast(`텍스처 ${e.target.value}K 적용`); } catch (err) { toast(err.message); } };
  $('selQuality').onchange = e => { const prevLow = state.quality === 'low'; state.quality = e.target.value; qualityStep = 0; applyQuality(); if (prevLow !== (state.quality === 'low') && !isMobile) { rebuildRig(LM); } toast('렌더링 품질: ' + e.target.selectedOptions[0].textContent); };
  $('btnCalib').onclick = () => openCalib(!state.calib); bindCalib();
  $('btnExport').onclick = () => exportGLB().catch(e => toast('내보내기 실패: ' + e.message));
  $('btnShot').onclick = screenshot; $('btnRec').onclick = toggleRec; $('btnRecTab').onclick = recTab;
  $('btnHideUI').onclick = () => { document.body.classList.toggle('noui'); toast('H 키로 UI 표시/숨기기', 1800); };
  $('btnFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); };
  $('btnLeft').onclick = () => { $('left').classList.toggle('open'); $('right').classList.remove('open'); };
  $('btnRight').onclick = () => { $('right').classList.toggle('open'); $('left').classList.remove('open'); };
  $('view').addEventListener('pointerdown', () => { $('left').classList.remove('open'); $('right').classList.remove('open'); });
  addEventListener('keydown', e => { if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return; if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('noui'); });
  // speech
  document.querySelectorAll('.samples button').forEach(b => b.onclick = () => { $('txt').value = SAMPLES[b.dataset.s]; });
  $('btnSpeak').onclick = () => { if ($('selMode').value === 'mic' && micStream) { stopAll(); $('btnSpeak').textContent = '▶ 말하기'; } else speak(); };
  $('btnPause').onclick = pauseAll; $('btnStop').onclick = () => stopAll();
  for (const [r, o, f] of [['rngRate', 'oRate', v => (v / 100).toFixed(1)], ['rngPitch', 'oPitch', v => (v / 100).toFixed(1)], ['rngVol', 'oVol', v => v + '%'], ['rngCal', 'oCal', v => (v / 100).toFixed(2)]]) $(r).oninput = e => { $(o).textContent = f(+e.target.value); if (r === 'rngVol' && audioEl) audioEl.volume = e.target.value / 100; };
  $('selMode').onchange = e => { const m = e.target.value; $('boxVoice').classList.toggle('hidden', m !== 'tts'); $('boxAudio').classList.toggle('hidden', m !== 'audio'); $('boxExt').classList.toggle('hidden', m !== 'external'); stopAll(); };
  $('fileAudio').onchange = e => { const f = e.target.files[0]; if (!f) return; const el = ensureAudioEl(); el.src = URL.createObjectURL(f); visTrack = null; $('audioName').textContent = f.name + ' (분석 모드)'; };
  $('fileVis').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { visTrack = parseVisemeJSON(JSON.parse(await f.text())); $('audioName').textContent += ` + ${f.name} (정확 모드, ${visTrack.tokens.length} 비즘)`; } catch (err) { toast('비즘 JSON 해석 실패: ' + err.message); } };
  const saved = store.get(LS.settings, {}); if (saved.extEndpoint) $('extEndpoint').value = saved.extEndpoint;
  const fillVoices = () => {
    const sel = $('selVoice'), cur = sel.value; sel.innerHTML = '<option value="auto">자동 (문장 언어 감지)</option>';
    const vs = driver.voices().slice().sort((a, b) => { const o = l => /^ko/i.test(l) ? 0 : /^ja/i.test(l) ? 1 : /^en/i.test(l) ? 2 : 3; return o(a.lang) - o(b.lang) || a.name.localeCompare(b.name); });
    for (const v of vs) { const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' ☁'}`; sel.appendChild(o); }
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    if (!vs.length) { const o = document.createElement('option'); o.disabled = true; o.textContent = '— 시스템 음성 없음 (무음 미리보기) —'; sel.appendChild(o); }
  };
  fillVoices(); if (window.speechSynthesis) speechSynthesis.onvoiceschanged = fillVoices;
  const vb = $('visBar'); for (const k of ['sil', 'A', 'EO', 'E', 'I', 'O', 'U', 'EU', 'MBP', 'SS', 'LN', 'FV', 'CH', 'KG', 'H', 'W', 'R', 'TH']) { const s = document.createElement('span'); s.dataset.v = k; s.textContent = VISEME_LABELS[k]; vb.appendChild(s); }
  // pointer gaze
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -1.0), ndc = new THREE.Vector2();
  renderer.domElement.addEventListener('pointermove', e => {
    const r = renderer.domElement.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera); const p = new THREE.Vector3(); plane.normal.copy(camera.position).sub(controls.target).normalize(); plane.constant = -plane.normal.dot(controls.target) - 1.0;
    if (ray.ray.intersectPlane(plane, p)) animator.pointer = p;
  });
  document.querySelectorAll('input[type=range]').forEach(fillRange);
  setLip('idle');
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock(); let fpsAcc = 0, fpsN = 0, lastVis = '';
function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  if (!state.ready) return;
  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt / 0.9); const k = camAnim.t < 0.5 ? 4 * camAnim.t ** 3 : 1 - (-2 * camAnim.t + 2) ** 3 / 2;
    camera.position.lerpVectors(camAnim.p0, camAnim.p1, k); controls.target.lerpVectors(camAnim.t0, camAnim.t1, k); if (camAnim.t >= 1) camAnim = null;
  }
  controls.update();
  if (state.frozen) { renderer.render(scene, camera); return; }   // test hook: time advanced manually via studio.advance()
  // lip sync sources
  let vis = null;
  if (driver.state === 'speaking' || driver.state === 'paused') { const tr = driver.update(driver.state === 'speaking' ? dt : 0); if (tr) vis = tr.evaluate(tr.time, visOut); }
  else if (audioEl && !audioEl.paused && (lipMode === 'exact' || lipMode === 'analysis')) {
    if (visTrack && lipMode === 'exact') vis = visTrack.evaluate(audioEl.currentTime + 0.02, visOut);
    else vis = audioLS.update();
  } else if (micStream) vis = audioLS.update();
  animator.viseme = vis; animator.speaking = !!vis || driver.state !== 'idle';
  if (state.calib) { rig.apply({}); rig.bones.root.position.y = rig.bones.rootRestY; renderer.render(scene, orthoCam); return; }
  animator.update(dt, rig, camera);
  key.target.position.set(0, 0, 0);
  renderer.render(scene, camera);
  // hud
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { $('fps').textContent = (fpsN / fpsAcc).toFixed(0) + ' fps · ' + (renderer.info.render.triangles / 1000).toFixed(0) + 'k tris'; fpsAcc = 0; fpsN = 0; }
  const cv = vis ? (vis._current || (vis._level > 0.1 ? '~' : 'sil')) : '—';
  if (cv !== lastVis) { lastVis = cv; $('hudVis').textContent = 'viseme: ' + (VISEME_LABELS[cv] || cv); document.querySelectorAll('#visBar span').forEach(s => s.classList.toggle('on', s.dataset.v === cv)); }
  autoQuality(dt);
}
loop();
init().catch(e => fatal(e.message || String(e)));

// debug / automation hooks
window.studio = { skinTone, skinDebug, setGloss, advance(sec, fps = 60) { for (let i = 0; i < sec * fps; i++) { const tr = driver.state === 'speaking' ? driver.update(1 / fps) : null; animator.viseme = tr ? tr.evaluate(tr.time, visOut) : animator.viseme; animator.update(1 / fps, rig, camera); } renderer.render(scene, camera); }, get rig() { return rig; }, animator, driver, scene, camera, controls, renderer, goView, setLighting, selectExpr, exportGLB, state, textToVisemes: null };
