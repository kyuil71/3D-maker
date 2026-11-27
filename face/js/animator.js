// ============================================================================
//  Face animator: layers expressions, manual control, lip sync and
//  procedural "alive" behaviour (blinks, saccades, gaze, head motion,
//  breathing, micro-expressions) into one set of ARKit weights per frame.
// ============================================================================
import * as THREE from 'three';
import { ARKIT_52 } from './rig.js?v=20261127d';
import { EXPRESSIONS } from './expressions.js?v=20261127d';

const EXPR = Object.fromEntries(EXPRESSIONS.map(e => [e.id, e]));
const CH = ARKIT_52.concat(['tongueUp', 'headPitch', 'headYaw', 'headRoll']);
const MOUTH_SHAPE = new Set(['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthClose', 'mouthRollLower', 'mouthRollUpper', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthShrugLower', 'mouthShrugUpper', 'tongueOut']);
const MOUTH_SOFT = new Set(['mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthPressLeft', 'mouthPressRight', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthLeft', 'mouthRight']);

// smooth 1D value noise
class Noise {
  constructor(seed = Math.random() * 1000) { this.f = [0.13, 0.071, 0.29, 0.047].map(x => x * (0.8 + Math.random() * 0.4)); this.p = this.f.map(() => seed + Math.random() * 100); }
  at(t) { let s = 0, a = 1, n = 0; for (let i = 0; i < 4; i++) { s += Math.sin(t * this.f[i] * Math.PI * 2 + this.p[i]) * a; n += a; a *= 0.6; } return s / n; }
}
class Spring {  // critically damped
  constructor(x = 0) { this.x = x; this.v = 0; }
  step(target, dt, omega) { const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, det = 1 / (f + hhoo); const dx = f * this.x + dt * this.v + hhoo * target; const dv = this.v + hoo * (target - this.x); this.x = dx * det; this.v = dv * det; return this.x; }
}

export class FaceAnimator {
  constructor() {
    this.exprTarget = { neutral: 1 }; this.exprSprings = {};
    this.intensity = 1; this.transition = 0.6;
    this.manual = {}; this.raw = {};
    this.viseme = null; this.visemeAmp = 1; this.speaking = false;
    this.idle = { blink: true, gaze: 'camera', head: true, breath: true, micro: true };
    this.out = {}; for (const c of CH) this.out[c] = 0;
    this.t = 0;
    // blink state
    this.nextBlink = 1.5; this.blinkT = -1; this.blinkDouble = false;
    // gaze
    this.sacc = new THREE.Vector2(); this.saccTarget = new THREE.Vector2(); this.nextSacc = 0.5;
    this.eyeYaw = { L: new Spring(), R: new Spring() }; this.eyePitch = { L: new Spring(), R: new Spring() };
    this.gazeOffset = new THREE.Vector2(); this.gazeOffsetT = 0;
    // head
    this.nH = [new Noise(), new Noise(), new Noise()]; this.headS = [new Spring(), new Spring(), new Spring()];
    this.nod = new Spring(); this.nodImpulse = 0; this.tilt = 0; this.tiltT = 0;
    this.micro = ['browInnerUp', 'mouthSmileLeft', 'mouthSmileRight', 'eyeSquintLeft', 'eyeSquintRight', 'browOuterUpLeft', 'mouthPressLeft'].map(c => [c, new Noise()]);
    this.breathPhase = Math.random() * 6; this.breathRate = 1 / 4.3;
    this.pointer = null;
  }
  // ---------- API
  setExpression(id, weight = 1, exclusive = true) {
    if (exclusive) for (const k in this.exprTarget) this.exprTarget[k] = 0;
    this.exprTarget[id] = weight;
  }
  setExpressionMix(map) { for (const k in this.exprTarget) this.exprTarget[k] = 0; Object.assign(this.exprTarget, map); }
  calmActive() { return Object.entries(this.exprSprings).some(([id, s]) => EXPR[id]?.calm && s.x > 0.5); }
  triggerNod(strength = 1) { this.nodImpulse += 0.9 * strength; }
  gesture(g) {
    if (g === 'nod') this.triggerNod(0.8);
    if (g === 'tilt') { this.tilt = (Math.random() < 0.5 ? -1 : 1) * 0.07; this.tiltT = 2.2; }
    if (g === 'lookAway') { this.gazeOffset.set(0.25 * (Math.random() < 0.5 ? -1 : 1), 0.18); this.gazeOffsetT = 1.6; }
    if (g === 'back') this.nodImpulse -= 0.7;
  }
  // ---------- per frame
  update(dt, rig, camera) {
    dt = Math.min(dt, 0.05); this.t += dt;
    const o = this.out; for (const c of CH) o[c] = 0;
    // 1) expression layer (springs per expression)
    const omega = 4.2 / Math.max(0.05, this.transition);
    const ids = new Set([...Object.keys(this.exprTarget), ...Object.keys(this.exprSprings)]);
    for (const id of ids) {
      const s = this.exprSprings[id] ||= new Spring(0);
      const w = s.step(this.exprTarget[id] || 0, dt, omega);
      const E = EXPR[id]; if (!E || Math.abs(w) < 1e-4) continue;
      for (const [k, v] of Object.entries(E.w)) o[k] += v * w * this.intensity;
    }
    for (const c in o) if (!c.startsWith('head')) o[c] = Math.min(1, Math.max(0, o[c]));
    // 2) manual controller + raw ARKit
    for (const [k, v] of Object.entries(this.manual)) o[k] = (o[k] || 0) + v;
    for (const [k, v] of Object.entries(this.raw)) o[k] = (o[k] || 0) + v;
    // 3) lip sync — speech overrides mouth shapes of the expression, keeps its mood
    if (this.viseme) {
      const amp = this.visemeAmp;
      for (const k of MOUTH_SHAPE) o[k] *= 0.3;
      for (const k of MOUTH_SOFT) o[k] *= 0.65;
      for (const [k, v] of Object.entries(this.viseme)) if (k[0] !== '_') o[k] = (o[k] || 0) + v * amp;
    }
    const calm = this.calmActive();
    // 4) micro-expressions
    if (this.idle.micro && !calm) for (const [c, n] of this.micro) o[c] += Math.max(0, n.at(this.t * 0.6)) * 0.07;
    // 5) blinks
    let blink = 0;
    if (this.idle.blink) {
      this.nextBlink -= dt * (this.speaking ? 1.25 : 1);
      if (this.nextBlink <= 0 && this.blinkT < 0) { this.blinkT = 0; this.blinkDouble = Math.random() < 0.14; this.nextBlink = 1.2 - Math.log(Math.random() + 1e-6) * 2.6; }
      if (this.blinkT >= 0) {
        this.blinkT += dt; const t = this.blinkT;
        blink = t < 0.075 ? Math.sin(t / 0.075 * Math.PI / 2) : t < 0.1 ? 1 : t < 0.26 ? 1 - Math.pow((t - 0.1) / 0.16, 0.8) : 0;
        if (t >= 0.26) { if (this.blinkDouble) { this.blinkT = 0; this.blinkDouble = false; } else this.blinkT = -1; }
      }
    }
    o.eyeBlinkLeft = 1 - (1 - o.eyeBlinkLeft) * (1 - blink);
    o.eyeBlinkRight = 1 - (1 - o.eyeBlinkRight) * (1 - blink * 0.97);
    // 6) gaze (per-eye vergence toward camera / pointer) + saccades
    const manualGaze = Math.abs(this.manualGazeAmt || 0) > 0.01;
    if (this.idle.gaze !== 'off' && rig && camera) {
      this.nextSacc -= dt;
      if (this.nextSacc <= 0) {
        const big = this.idle.gaze === 'wander' ? 0.22 : 0.05;
        this.saccTarget.set((Math.random() - 0.5) * big, (Math.random() - 0.5) * big * 0.6);
        this.nextSacc = 0.35 + Math.random() * (this.idle.gaze === 'wander' ? 1.6 : 2.6);
      }
      this.sacc.lerp(this.saccTarget, 1 - Math.exp(-dt * 30));
      if (this.gazeOffsetT > 0) { this.gazeOffsetT -= dt; if (this.gazeOffsetT <= 0) this.gazeOffset.set(0, 0); }
      const target = new THREE.Vector3();
      if (this.idle.gaze === 'pointer' && this.pointer) target.copy(this.pointer); else target.copy(camera.position);
      const headInv = new THREE.Matrix4().copy(rig.bones.head.matrixWorld).invert();
      const tl = target.clone().applyMatrix4(headInv);
      for (const s of ['L', 'R']) {
        const e = rig.eyes[s].position;
        const d = tl.clone().sub(e);
        let yaw = Math.atan2(d.x, d.z), pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z));
        if (d.z < 0) { yaw = 0; pitch = 0; }   // target behind the head
        yaw = THREE.MathUtils.clamp(yaw + this.sacc.x + this.gazeOffset.x, -0.55, 0.55);
        pitch = THREE.MathUtils.clamp(pitch + this.sacc.y - this.gazeOffset.y, -0.38, 0.38);
        const gw = manualGaze ? 0.15 : 1;
        const y = this.eyeYaw[s].step(yaw * gw, dt, 28), p = this.eyePitch[s].step(pitch * gw, dt, 28);
        const sg = s === 'L' ? 1 : -1, S = s === 'L' ? 'Left' : 'Right';
        const lr = (y / 0.45) * sg;   // + = out
        o['eyeLookOut' + S] += Math.max(0, lr); o['eyeLookIn' + S] += Math.max(0, -lr);
        o['eyeLookDown' + S] += Math.max(0, p / 0.35); o['eyeLookUp' + S] += Math.max(0, -p / 0.35);
      }
      this.gazeYaw = (this.eyeYaw.L.x + this.eyeYaw.R.x) / 2; this.gazePitch = (this.eyePitch.L.x + this.eyePitch.R.x) / 2;
    } else { this.gazeYaw = 0; this.gazePitch = 0; }
    // 7) head motion: noise + follow gaze + nods + tilt
    let hy = 0, hp = 0, hr = 0;
    if (this.idle.head) {
      const amp = (this.speaking ? 1.8 : 1) * (calm ? 0.4 : 1);
      hy = this.nH[0].at(this.t) * 0.035 * amp + (this.gazeYaw || 0) * 0.3;
      hp = this.nH[1].at(this.t * 1.1) * 0.022 * amp - (this.gazePitch || 0) * 0.25;
      hr = this.nH[2].at(this.t * 0.9) * 0.016 * amp;
      if (this.speaking && Math.random() < dt * 0.35) this.triggerNod(0.35 + Math.random() * 0.4);
    }
    // nod: impulse-driven spring
    this.nod.v -= this.nodImpulse * 1.2; this.nodImpulse = 0;
    const nod = this.nod.step(0, dt, 9);
    if (this.tiltT > 0) { this.tiltT -= dt; if (this.tiltT <= 0) this.tilt = 0; }
    const hs = this.headS;
    o.headYaw += hs[0].step(hy, dt, 3); o.headPitch += hs[1].step(hp, dt, 3) + nod * 0.08; o.headRoll += hs[2].step(hr + this.tilt, dt, 3);
    // 8) breathing (root bob + slight neck pitch)
    if (rig) {
      this.breathPhase += dt * this.breathRate * Math.PI * 2;
      const b = this.idle.breath ? Math.sin(this.breathPhase) : 0;
      rig.bones.root.position.y = rig.bones.rootRestY + b * 0.0035;
      o.headPitch += b * 0.006;
      o.mouthClose += 0;  // placeholder
    }
    for (const c of CH) if (!c.startsWith('head')) o[c] = Math.min(1, Math.max(0, o[c]));
    if (rig) rig.apply(o);
    return o;
  }
}
