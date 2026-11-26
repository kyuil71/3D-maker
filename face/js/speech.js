// ============================================================================
//  Speech: phoneme → viseme conversion (Korean / English / Japanese),
//  coarticulated viseme timelines, Web Speech TTS driver, audio-analysis
//  lip sync, and importers for externally timed visemes (accurate mode).
// ============================================================================
import { VISEMES } from './expressions.js';

// ---------------------------------------------------------------- Korean
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const CHO_V = { 'ㄱ': 'KG', 'ㄲ': 'KG', 'ㅋ': 'KG', 'ㄴ': 'LN', 'ㄷ': 'LN', 'ㄸ': 'LN', 'ㅌ': 'LN', 'ㄹ': 'LN', 'ㅁ': 'MBP', 'ㅂ': 'MBP', 'ㅃ': 'MBP', 'ㅍ': 'MBP', 'ㅅ': 'SS', 'ㅆ': 'SS', 'ㅈ': 'CH', 'ㅉ': 'CH', 'ㅊ': 'CH', 'ㅎ': 'H', 'ㅇ': null };
const JUNG_V = { 'ㅏ': ['A'], 'ㅐ': ['E'], 'ㅑ': ['I', 'A'], 'ㅒ': ['I', 'E'], 'ㅓ': ['EO'], 'ㅔ': ['E'], 'ㅕ': ['I', 'EO'], 'ㅖ': ['I', 'E'], 'ㅗ': ['O'], 'ㅘ': ['W', 'A'], 'ㅙ': ['W', 'E'], 'ㅚ': ['W', 'E'], 'ㅛ': ['I', 'O'], 'ㅜ': ['U'], 'ㅝ': ['W', 'EO'], 'ㅞ': ['W', 'E'], 'ㅟ': ['W', 'I'], 'ㅠ': ['I', 'U'], 'ㅡ': ['EU'], 'ㅢ': ['EU', 'I'], 'ㅣ': ['I'] };
// coda → (viseme, consonant moved to next onset when the next syllable starts with ㅇ = 연음)
const JONG_V = { 'ㄱ': 'KG', 'ㄲ': 'KG', 'ㅋ': 'KG', 'ㄳ': 'KG', 'ㄺ': 'KG', 'ㄴ': 'LN', 'ㄵ': 'LN', 'ㄶ': 'LN', 'ㄷ': 'LN', 'ㅅ': 'LN', 'ㅆ': 'LN', 'ㅈ': 'LN', 'ㅊ': 'LN', 'ㅌ': 'LN', 'ㅎ': 'LN', 'ㄹ': 'LN', 'ㄼ': 'LN', 'ㄽ': 'LN', 'ㄾ': 'LN', 'ㅀ': 'LN', 'ㅁ': 'MBP', 'ㄻ': 'MBP', 'ㅂ': 'MBP', 'ㅍ': 'MBP', 'ㅄ': 'MBP', 'ㄿ': 'MBP', 'ㅇ': 'KG' };
const JONG_LIAISON = { 'ㄱ': 'KG', 'ㄲ': 'KG', 'ㅋ': 'KG', 'ㄴ': 'LN', 'ㄷ': 'LN', 'ㅅ': 'SS', 'ㅆ': 'SS', 'ㅈ': 'CH', 'ㅊ': 'CH', 'ㅌ': 'CH', 'ㄹ': 'LN', 'ㅁ': 'MBP', 'ㅂ': 'MBP', 'ㅍ': 'MBP', 'ㄳ': 'SS', 'ㄵ': 'CH', 'ㄺ': 'KG', 'ㄻ': 'MBP', 'ㄼ': 'MBP', 'ㄾ': 'CH', 'ㄿ': 'MBP', 'ㅄ': 'SS' };
export function decomposeHangul(ch) {
  const c = ch.charCodeAt(0) - 0xAC00; if (c < 0 || c > 11171) return null;
  return { cho: CHO[Math.floor(c / 588)], jung: JUNG[Math.floor((c % 588) / 28)], jong: JONG[c % 28] };
}
const isHangul = ch => { const c = ch.charCodeAt(0); return c >= 0xAC00 && c <= 0xD7A3; };
const isKana = ch => { const c = ch.charCodeAt(0); return (c >= 0x3041 && c <= 0x30FF); };
const isKanji = ch => { const c = ch.charCodeAt(0); return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF); };
const isLatin = ch => /[a-zA-Z]/.test(ch);

// ---------------------------------------------------------------- English (letter-pattern rules)
const EN_RULES = [
  ['tch', ['CH']], ['igh', ['A', 'I']], ['ough', ['O']], ['sh', ['CH']], ['ch', ['CH']], ['th', ['TH']], ['ph', ['FV']], ['wh', ['W']],
  ['ck', ['KG']], ['ng', ['KG']], ['qu', ['KG', 'W']], ['oo', ['U']], ['ee', ['I']], ['ea', ['I']], ['ai', ['E']], ['ay', ['E', 'I']],
  ['oa', ['O']], ['ou', ['A', 'U']], ['ow', ['O', 'U']], ['oi', ['O', 'I']], ['oy', ['O', 'I']], ['er', ['R']], ['ir', ['R']], ['ur', ['R']],
  ['ar', ['A', 'R']], ['or', ['O', 'R']], ['au', ['O']], ['aw', ['O']], ['ew', ['I', 'U']],
  ['a', ['A']], ['e', ['E']], ['i', ['I']], ['o', ['O']], ['u', ['EO']], ['y', ['I']],
  ['b', ['MBP']], ['m', ['MBP']], ['p', ['MBP']], ['f', ['FV']], ['v', ['FV']], ['s', ['SS']], ['z', ['SS']], ['c', ['KG']],
  ['k', ['KG']], ['g', ['KG']], ['q', ['KG']], ['x', ['KG', 'SS']], ['d', ['LN']], ['t', ['LN']], ['n', ['LN']], ['l', ['LN']],
  ['r', ['R']], ['w', ['W']], ['h', ['H']], ['j', ['CH']],
];
const EN_VOWELS = new Set(['A', 'E', 'I', 'O', 'U', 'EO', 'R']);
function englishWord(w) {
  w = w.toLowerCase().replace(/(.)\1+/g, '$1');
  if (w.length > 3 && w.endsWith('e') && !/[aeiou]e$/.test(w)) w = w.slice(0, -1);   // silent final e
  const out = []; let i = 0;
  while (i < w.length) {
    let hit = null;
    for (const [pat, vs] of EN_RULES) if (w.startsWith(pat, i)) { hit = [pat, vs]; break; }
    if (!hit) { i++; continue; }
    // soft c / g
    if (hit[0] === 'c' && /[eiy]/.test(w[i + 1] || '')) hit = ['c', ['SS']];
    for (const v of hit[1]) out.push(v);
    i += hit[0].length;
  }
  return out;
}

// ---------------------------------------------------------------- Japanese (kana → mora)
const KANA = 'あa いi うu えe おo かka きki くku けke こko がga ぎgi ぐgu げge ごgo さsa しshi すsu せse そso ざza じji ずzu ぜze ぞzo たta ちchi つtsu てte とto だda ぢji づzu でde どdo なna にni ぬnu ねne のno はha ひhi ふfu へhe ほho ばba びbi ぶbu べbe ぼbo ぱpa ぴpi ぷpu ぺpe ぽpo まma みmi むmu めme もmo やya ゆyu よyo らra りri るru れre ろro わwa ゐi ゑe をo んN ゔvu ぁa ぃi ぅu ぇe ぉo ゃya ゅyu ょyo っQ ゎwa'
  .split(' ').reduce((m, s) => (m[s[0]] = s.slice(1), m), {});
const JA_ONSET = c => (/^(k|g)/.test(c) ? 'KG' : /^(sh|ch|j)/.test(c) ? 'CH' : /^(s|z|ts)/.test(c) ? 'SS' : /^(t|d|n|r)/.test(c) ? 'LN' : /^h/.test(c) ? 'H' : /^f/.test(c) ? 'FV' : /^(b|p|m)/.test(c) ? 'MBP' : /^y/.test(c) ? 'I' : /^w/.test(c) ? 'W' : /^v/.test(c) ? 'FV' : null);
const JA_V = { a: 'A', i: 'I', u: 'U', e: 'E', o: 'O' };

// ---------------------------------------------------------------- text → timed tokens
// returns { tokens:[{v,t0,t1,ci,approx}], duration, lang }
export function textToVisemes(text, opts = {}) {
  const rate = opts.rate || 1, calib = opts.calib || 1;
  const k = calib / rate;
  const T = { koSyl: 0.165, koOn: 0.05, koCoda: 0.045, glide: 0.04, enV: 0.085, enC: 0.058, jaMora: 0.12, space: 0.05, comma: 0.24, stop: 0.42 };
  const tok = [];
  let t = 0.0;
  const push = (v, d, ci, approx) => { d *= k; tok.push({ v, t0: t, t1: t + d, ci, approx: !!approx }); t += d; };
  push('sil', 0.06, 0);
  const chars = [...text];
  let ci = 0;  // UTF-16 index (matches SpeechSynthesis boundary charIndex)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], here = ci; ci += ch.length;
    if (isHangul(ch)) {
      const d = decomposeHangul(ch);
      // liaison from previous coda
      const prev = tok._liaison; tok._liaison = null;
      let on = CHO_V[d.cho];
      if (d.cho === 'ㅇ' && prev) on = prev;
      const vs = JUNG_V[d.jung];
      const next = chars[i + 1] && isHangul(chars[i + 1]) ? decomposeHangul(chars[i + 1]) : null;
      const liaison = d.jong && d.jong !== 'ㅇ' && d.jong !== 'ㅎ' && next && next.cho === 'ㅇ';
      let vowelDur = T.koSyl - (on ? T.koOn : 0) - (d.jong && !liaison ? T.koCoda : 0);
      if (on) push(on, on === 'MBP' ? T.koOn * 1.2 : T.koOn, here);
      if (vs.length === 2) { push(vs[0], T.glide, here); vowelDur -= T.glide; }
      push(vs[vs.length - 1], Math.max(0.05, vowelDur), here);
      if (d.jong) { if (liaison) tok._liaison = JONG_LIAISON[d.jong] || null; else push(JONG_V[d.jong] || 'LN', T.koCoda, here); }
      continue;
    }
    if (isLatin(ch)) {
      let w = ch; while (chars[i + 1] && isLatin(chars[i + 1])) { w += chars[++i]; ci += 1; }
      for (const v of englishWord(w)) push(v, EN_VOWELS.has(v) ? T.enV : T.enC, here);
      continue;
    }
    if (isKana(ch)) {
      let c = ch.charCodeAt(0); if (c >= 0x30A1 && c <= 0x30F6) c -= 0x60;
      const h = String.fromCharCode(c);
      if (ch === 'ー') { const last = tok[tok.length - 1]; if (last) { last.t1 += T.jaMora * k; t += T.jaMora * k; } continue; }
      const r = KANA[h]; if (!r) continue;
      if (r === 'Q') { push('KG', T.jaMora * 0.8, here); continue; }
      if (r === 'N') { const nx = KANA[chars[i + 1]] || ''; push(/^[bpm]/.test(nx) ? 'MBP' : 'LN', T.jaMora * 0.9, here); continue; }
      if ('ゃゅょぁぃぅぇぉゎ'.includes(h) && tok.length) { // small kana: change vowel of previous mora
        const last = tok[tok.length - 1]; last.v = JA_V[r[r.length - 1]]; continue;
      }
      const onset = r.slice(0, -1), vow = r[r.length - 1];
      const on = JA_ONSET(onset);
      if (on) push(on, 0.04, here);
      push(JA_V[vow], T.jaMora - (on ? 0.04 : 0), here);
      continue;
    }
    if (isKanji(ch) || /[0-9０-９]/.test(ch)) {
      // reading unknown without a dictionary → plausible 2-mora approximation
      const cyc = ['A', 'I', 'O', 'E', 'U', 'EO'];
      const c0 = ch.charCodeAt(0);
      push(['KG', 'SS', 'LN', 'H'][c0 % 4], 0.04, here, true);
      push(cyc[c0 % 6], 0.09, here, true); push(cyc[(c0 >> 3) % 6], 0.1, here, true);
      continue;
    }
    if (/[.!?。！？…]/.test(ch)) { push('sil', T.stop, here); continue; }
    if (/[,，、;:]/.test(ch)) { push('sil', T.comma, here); continue; }
    if (/\s/.test(ch)) { if (tok.length && tok[tok.length - 1].v !== 'sil') push('sil', T.space * (isLatin(chars[i - 1] || '') ? 0.5 : 1), here); continue; }
  }
  push('sil', 0.15, ci);
  delete tok._liaison;
  return { tokens: tok, duration: t };
}

// ---------------------------------------------------------------- coarticulated evaluation
const VKEYS = Object.keys(VISEMES);
export class VisemeTrack {
  constructor(tokens, duration) { this.tokens = tokens; this.duration = duration ?? (tokens.length ? tokens[tokens.length - 1].t1 : 0); this.time = 0; }
  // dominance-model blend (Cohen & Massaro style): each segment emits a gaussian
  // influence; overlapping influences produce anticipatory & carry-over coarticulation.
  evaluate(t, out = {}) {
    for (const k in out) out[k] = 0;
    const tk = this.tokens; if (!tk.length) return out;
    let lo = 0, hi = tk.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tk[m].t1 < t - 0.3) lo = m + 1; else hi = m; }
    let sum = 0, closure = 0, current = null;
    const acc = {};
    for (let i = lo; i < tk.length && tk[i].t0 < t + 0.3; i++) {
      const s = tk[i], V = VISEMES[s.v] || VISEMES.sil;
      const c = (s.t0 + s.t1) / 2, dur = Math.max(0.03, s.t1 - s.t0);
      const sig = Math.max(0.035, dur * 0.6);
      let e = V.dom * Math.exp(-(((t - c) / sig) ** 2));
      if (t >= s.t0 && t <= s.t1) { e *= 1.6; current = s; }
      if (e < 1e-4) continue;
      sum += e;
      for (const [k, v] of Object.entries(V.w)) acc[k] = (acc[k] || 0) + v * e;
      if (V.close) closure = Math.max(closure, Math.exp(-(((t - c) / (dur * 0.5)) ** 2)));
    }
    if (sum > 0) for (const k in acc) out[k] = acc[k] / sum;
    if (closure > 0) {   // bilabial stops must reach full lip contact
      const open = 1 - 0.92 * closure;
      for (const k of ['jawOpen', 'mouthFunnel', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthStretchLeft', 'mouthStretchRight']) if (out[k]) out[k] *= open;
      out.mouthPressLeft = (out.mouthPressLeft || 0) * 0.5 + 0.4 * closure;
      out.mouthPressRight = (out.mouthPressRight || 0) * 0.5 + 0.4 * closure;
    }
    out._current = current ? current.v : 'sil';
    return out;
  }
  indexForChar(ci) { const i = this.tokens.findIndex(s => s.ci >= ci); return i < 0 ? this.tokens.length - 1 : i; }
}

// ---------------------------------------------------------------- sentence split
export function splitSentences(text) {
  const parts = text.match(/[^.!?。！？\n]+[.!?。！？…]*\s*|\n+/g) || [text];
  return parts.map(s => s.trim()).filter(Boolean);
}
export function detectLang(text) {
  if (/[가-힣]/.test(text)) return 'ko';
  if (/[぀-ヿ一-鿿]/.test(text)) return 'ja';
  return 'en';
}

// ---------------------------------------------------------------- Web Speech TTS driver (approximate lip sync)
export class SpeechDriver {
  constructor() {
    this.synth = window.speechSynthesis || null;
    this.queue = []; this.track = null; this.state = 'idle'; this.sentence = -1;
    this.listeners = {}; this.boundaryCount = 0; this.calib = 1; this.offset = 0;
    this.simulate = false;
  }
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, a) { (this.listeners[ev] || []).forEach(f => f(a)); }
  voices() { return this.synth ? this.synth.getVoices() : []; }
  speak(text, opt) {
    this.stop();
    const sentences = splitSentences(text);
    if (!sentences.length) return;
    this.opt = opt; this.queue = sentences.map(s => ({ text: s, lang: detectLang(s) }));
    this.sentence = -1; this.state = 'speaking';
    this.simulate = !this.synth || !opt.voice;   // no voice available → silent timeline preview
    this.emit('start');
    this._next();
  }
  _next() {
    this.sentence++;
    if (this.sentence >= this.queue.length) { this.state = 'idle'; this.track = null; this.emit('end'); return; }
    const S = this.queue[this.sentence];
    const { tokens, duration } = textToVisemes(S.text, { rate: this.opt.rate, calib: this.calib });
    const track = new VisemeTrack(tokens, duration); track.time = -this.offset; track.started = false;
    this.track = track;
    this.emit('sentence', { index: this.sentence, text: S.text, lang: S.lang });
    if (this.simulate) { track.started = true; track.sim = true; return; }
    const u = new SpeechSynthesisUtterance(S.text);
    u.voice = this.opt.voice; u.lang = this.opt.voice ? this.opt.voice.lang : S.lang;
    u.rate = this.opt.rate; u.pitch = this.opt.pitch; u.volume = this.opt.volume;
    u.onstart = () => { track.started = true; track.time = -this.offset; };
    u.onboundary = e => {        // re-synchronise the estimated timeline with the real speech
      if (e.name && e.name !== 'word') return;
      this.boundaryCount++;
      const i = track.indexForChar(e.charIndex); const target = track.tokens[i].t0 - this.offset;
      if (Math.abs(track.time - target) > 0.04) track.time += (target - track.time) * 0.7;
      this.emit('word', { charIndex: e.charIndex });
    };
    u.onend = () => { if (this.track === track) this._next(); };
    u.onerror = e => { if (e.error !== 'interrupted' && e.error !== 'canceled') this.emit('error', e.error); if (this.track === track) this._next(); };
    this.utter = u;
    this.synth.speak(u);
    // Chrome can drop onstart for some voices → start clock anyway after a short wait
    setTimeout(() => { if (this.track === track && !track.started && this.state === 'speaking') track.started = true; }, 400);
  }
  update(dt) {
    const tr = this.track; if (!tr || !tr.started || this.state !== 'speaking') return null;
    tr.time += dt;
    if (tr.sim && tr.time > tr.duration) { this._next(); return null; }
    return tr;
  }
  pause() { if (this.state !== 'speaking') return; this.state = 'paused'; if (this.synth && !this.simulate) this.synth.pause(); this.emit('pause'); }
  resume() { if (this.state !== 'paused') return; this.state = 'speaking'; if (this.synth && !this.simulate) this.synth.resume(); this.emit('resume'); }
  stop() { const was = this.state !== 'idle'; this.state = 'idle'; this.track = null; this.queue = []; if (this.synth) this.synth.cancel(); if (was) this.emit('end'); }
}

// ---------------------------------------------------------------- audio analysis lip sync (file / microphone)
export class AudioLipSync {
  constructor(ctx) {
    this.ctx = ctx; this.an = ctx.createAnalyser(); this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0.35;
    this.f = new Float32Array(this.an.frequencyBinCount); this.td = new Float32Array(this.an.fftSize);
    this.floor = -60; this.peak = -20; this.out = {}; this.level = 0;
  }
  input() { return this.an; }
  update() {
    const an = this.an; an.getFloatTimeDomainData(this.td); an.getFloatFrequencyData(this.f);
    let rms = 0; for (const v of this.td) rms += v * v; rms = Math.sqrt(rms / this.td.length);
    const db = 20 * Math.log10(rms + 1e-9);
    this.floor = Math.min(this.floor + 0.02, db < this.floor ? db : this.floor); this.peak = Math.max(db, this.peak - 0.03);
    const lvl = Math.max(0, Math.min(1, (db - this.floor - 6) / Math.max(10, this.peak - this.floor - 6)));
    const binHz = this.ctx.sampleRate / an.fftSize;
    const band = (a, b) => { let s = 0; for (let i = Math.floor(a / binHz); i < Math.min(this.f.length, b / binHz); i++) s += Math.pow(10, this.f[i] / 10); return s; };
    const b1 = band(250, 900), b2 = band(900, 2500), b3 = band(2500, 5000), b4 = band(5000, 10000);
    const tot = b1 + b2 + b3 + b4 + 1e-12;
    const open = b1 / tot, bright = b2 / (b1 + b2 + 1e-12), fric = (b4 + b3 * 0.4) / tot;
    const o = this.out; for (const k in o) o[k] = 0;
    this.level += (lvl - this.level) * 0.5;
    const L = this.level;
    if (fric > 0.45 && L > 0.05) { Object.assign(o, VISEMES.SS.w); for (const k in o) o[k] *= Math.min(1, L * 2); }
    else {
      o.jawOpen = L * (0.18 + 0.55 * open);
      const round = Math.max(0, 0.45 - bright) * 2;  // low F2 → rounded (오/우)
      const spread = Math.max(0, bright - 0.55) * 2; // high F2 → spread (이/에)
      o.mouthFunnel = L * round * 0.6; o.mouthPucker = L * round * 0.45;
      o.mouthStretchLeft = o.mouthStretchRight = L * spread * 0.5;
      o.mouthUpperUpLeft = o.mouthUpperUpRight = L * 0.15;
      o.mouthLowerDownLeft = o.mouthLowerDownRight = L * 0.25;
    }
    o._level = L;
    return o;
  }
}

// ---------------------------------------------------------------- external viseme timelines (accurate mode)
const AZURE = ['sil', 'EO', 'A', 'O', 'E', 'R', 'I', 'U', 'O', 'A', 'O', 'A', 'H', 'R', 'LN', 'SS', 'CH', 'TH', 'FV', 'LN', 'KG', 'MBP'];
const RHUBARB = { A: 'MBP', B: 'SS', C: 'E', D: 'A', E: 'O', F: 'U', G: 'FV', H: 'LN', X: 'sil' };
// Accepts: our own [{start,end,viseme}] / {visemes:[{time,viseme}]},
//          Azure Speech viseme events [{audioOffset(ms or 100ns ticks), visemeId}],
//          Rhubarb Lip Sync JSON {mouthCues:[{start,end,value}]}.
export function parseVisemeJSON(json) {
  let list = [];
  const pushEv = (time, v) => list.push({ time, v });
  if (json.mouthCues) return new VisemeTrack(json.mouthCues.map((c, i) => ({ v: RHUBARB[c.value] || 'sil', t0: c.start, t1: c.end, ci: i })));
  const arr = Array.isArray(json) ? json : (json.visemes || json.events || []);
  for (const e of arr) {
    if (e.visemeId !== undefined) {
      let t = e.audioOffset ?? e.time ?? 0; t = t > 1e6 ? t / 1e7 : t > 200 ? t / 1000 : t;   // 100ns ticks / ms / s
      pushEv(t, AZURE[e.visemeId] || 'sil');
    } else if (e.start !== undefined) list.push({ time: e.start, end: e.end, v: e.viseme || e.v || 'sil' });
    else pushEv(e.time ?? e.t ?? 0, e.viseme || e.v || 'sil');
  }
  list.sort((a, b) => a.time - b.time);
  const tokens = list.map((e, i) => ({ v: VISEMES[e.v] ? e.v : 'sil', t0: e.time, t1: e.end ?? (list[i + 1] ? list[i + 1].time : e.time + 0.15), ci: i }));
  return new VisemeTrack(tokens);
}

// External TTS adapter: POSTs to YOUR server (keeps API keys off the client).
// Expected response: { audio: "<base64>" | audioUrl: "...", mime: "audio/mpeg", visemes: [...any format parseVisemeJSON accepts] }
export async function externalTTS(endpoint, payload) {
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('TTS server ' + r.status);
  const j = await r.json();
  const url = j.audioUrl || ('data:' + (j.mime || 'audio/mpeg') + ';base64,' + j.audio);
  return { url, track: parseVisemeJSON(j.visemes ? { visemes: j.visemes } : j) };
}
