// ============================================================================
//  Expression presets (FACS / ARKit weights), visemes and the facial controller
// ============================================================================
const sym = (o, base) => { // helper: { mouthSmile: .5 } → mouthSmileLeft/Right
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(o)) {
    if (/^(eyeBlink|eyeSquint|eyeWide|eyeLookUp|eyeLookDown|mouthSmile|mouthFrown|mouthDimple|mouthStretch|mouthPress|mouthLowerDown|mouthUpperUp|browDown|browOuterUp|cheekSquint|noseSneer)$/.test(k)) {
      out[k + 'Left'] = (out[k + 'Left'] || 0) + v; out[k + 'Right'] = (out[k + 'Right'] || 0) + v;
    } else out[k] = (out[k] || 0) + v;
  }
  return out;
};

// FACS action units involved are noted for each preset.
export const EXPRESSIONS = [
  { id: 'neutral', ko: '중립', en: 'Neutral', icon: '◯', w: {} },
  { id: 'smile', ko: '미소', en: 'Smile', icon: '◡', facs: 'AU6+AU12',
    w: sym({ mouthSmile: 0.52, cheekSquint: 0.22, eyeSquint: 0.12, mouthDimple: 0.12 }) },
  { id: 'happy', ko: '행복', en: 'Happy', icon: '☺', facs: 'AU6+AU12+AU25',
    w: sym({ mouthSmile: 0.82, cheekSquint: 0.48, eyeSquint: 0.32, browOuterUp: 0.18, mouthUpperUp: 0.22, mouthLowerDown: 0.12 }, { jawOpen: 0.1, browInnerUp: 0.12 }) },
  { id: 'laugh', ko: '크게 웃음', en: 'Laugh', icon: '😆', facs: 'AU6+AU12+AU25+AU27',
    w: sym({ mouthSmile: 1.0, cheekSquint: 0.75, eyeSquint: 0.62, eyeBlink: 0.18, mouthUpperUp: 0.45, mouthLowerDown: 0.42, browOuterUp: 0.2, mouthStretch: 0.1 }, { jawOpen: 0.5, headPitch: 0.06 }) },
  { id: 'sad', ko: '슬픔', en: 'Sad', icon: '☹', facs: 'AU1+AU4+AU15+AU17',
    w: sym({ mouthFrown: 0.62, eyeSquint: 0.1, eyeLookDown: 0.22, mouthPress: 0.12, browDown: 0.12, eyeBlink: 0.12 }, { browInnerUp: 0.88, mouthShrugLower: 0.35, headPitch: -0.08 }) },
  { id: 'angry', ko: '화남', en: 'Angry', icon: '😠', facs: 'AU4+AU5+AU7+AU23',
    w: sym({ browDown: 0.92, eyeSquint: 0.38, noseSneer: 0.42, mouthPress: 0.42, mouthFrown: 0.32, cheekSquint: 0.15, eyeWide: 0.12 }, { jawForward: 0.1, mouthRollLower: 0.1, headPitch: -0.05 }) },
  { id: 'surprised', ko: '놀람', en: 'Surprised', icon: '😮', facs: 'AU1+AU2+AU5+AU26',
    w: sym({ eyeWide: 0.9, browOuterUp: 0.9 }, { browInnerUp: 0.9, jawOpen: 0.42, mouthFunnel: 0.22, headPitch: 0.05 }) },
  { id: 'fear', ko: '두려움', en: 'Fear', icon: '😨', facs: 'AU1+AU2+AU4+AU5+AU20+AU26',
    w: sym({ eyeWide: 0.85, browOuterUp: 0.38, mouthStretch: 0.62, mouthLowerDown: 0.3, mouthFrown: 0.2, browDown: 0.1 }, { browInnerUp: 1.0, jawOpen: 0.2, headPitch: -0.04 }) },
  { id: 'disgust', ko: '혐오', en: 'Disgust', icon: '🤢', facs: 'AU9+AU10+AU15',
    w: sym({ noseSneer: 0.88, browDown: 0.52, eyeSquint: 0.42, cheekSquint: 0.35, mouthFrown: 0.3 },
      { mouthUpperUpLeft: 0.72, mouthUpperUpRight: 0.55, mouthShrugLower: 0.32, headYaw: -0.04, headPitch: -0.03 }) },
  { id: 'embarrassed', ko: '당황', en: 'Embarrassed', icon: '😳', facs: 'AU12(asym)+AU24+gaze down',
    w: sym({ eyeLookDown: 0.42, mouthPress: 0.3, eyeSquint: 0.18 },
      { mouthSmileLeft: 0.42, mouthSmileRight: 0.24, browInnerUp: 0.38, mouthRollLower: 0.2, eyeLookOutLeft: 0.2, eyeLookInRight: 0.2, headPitch: -0.12, headRoll: 0.06 }) },
  { id: 'doubt', ko: '의심', en: 'Doubtful', icon: '🤨', facs: 'AU2(R)+AU4(L)+AU7',
    w: { browDownLeft: 0.62, browOuterUpRight: 0.6, eyeSquintLeft: 0.52, eyeSquintRight: 0.1, mouthPressRight: 0.32, mouthLeft: 0.18, mouthSmileRight: 0.14, headRoll: -0.05, headYaw: 0.05 } },
  { id: 'thinking', ko: '생각', en: 'Thinking', icon: '🤔', facs: 'gaze up + AU4 + AU18',
    w: { eyeLookUpLeft: 0.45, eyeLookUpRight: 0.45, eyeLookOutLeft: 0.32, eyeLookInRight: 0.32, browInnerUp: 0.28, browDownRight: 0.22, mouthPucker: 0.18, mouthLeft: 0.25, mouthRollLower: 0.15, headRoll: 0.07, headPitch: 0.04 } },
  { id: 'confident', ko: '자신감', en: 'Confident', icon: '😏', facs: 'AU12(asym)+AU24',
    w: { mouthSmileLeft: 0.45, mouthSmileRight: 0.2, eyeSquintLeft: 0.2, eyeSquintRight: 0.18, browDownLeft: 0.1, browDownRight: 0.1, mouthPressLeft: 0.2, mouthPressRight: 0.2, jawForward: 0.1, headPitch: 0.08 } },
  { id: 'blank', ko: '무표정', en: 'Blank', icon: '😐', facs: 'relaxed lids, no micro-expressions', calm: true,
    w: { eyeBlinkLeft: 0.18, eyeBlinkRight: 0.18, mouthClose: 0.05 } },
  { id: 'wink', ko: '윙크', en: 'Wink', icon: '😉', facs: 'AU46(L)+AU6+AU12',
    w: { eyeBlinkLeft: 1.0, cheekSquintLeft: 0.5, mouthSmileLeft: 0.55, mouthSmileRight: 0.25, browDownLeft: 0.25, headRoll: 0.05 } },
];

// ---------------------------------------------------------------- visemes
// mouth shapes as ARKit weights (+ tongueUp). dom = coarticulation dominance.
export const VISEMES = {
  sil: { dom: 1.0, w: {} },
  A:   { dom: 1.0, w: { jawOpen: 0.29, mouthLowerDownLeft: 0.15, mouthLowerDownRight: 0.15, mouthUpperUpLeft: 0.06, mouthUpperUpRight: 0.06 } },
  EO:  { dom: 1.0, w: { jawOpen: 0.23, mouthFunnel: 0.14, mouthLowerDownLeft: 0.09, mouthLowerDownRight: 0.09 } },
  E:   { dom: 1.0, w: { jawOpen: 0.19, mouthStretchLeft: 0.32, mouthStretchRight: 0.32, mouthSmileLeft: 0.12, mouthSmileRight: 0.12, mouthUpperUpLeft: 0.09, mouthUpperUpRight: 0.09, mouthLowerDownLeft: 0.12, mouthLowerDownRight: 0.12 } },
  I:   { dom: 1.0, w: { jawOpen: 0.09, mouthStretchLeft: 0.42, mouthStretchRight: 0.42, mouthSmileLeft: 0.28, mouthSmileRight: 0.28, mouthUpperUpLeft: 0.13, mouthUpperUpRight: 0.13, mouthLowerDownLeft: 0.11, mouthLowerDownRight: 0.11 } },
  O:   { dom: 1.1, w: { jawOpen: 0.19, mouthFunnel: 0.55, mouthPucker: 0.32 } },
  U:   { dom: 1.2, w: { jawOpen: 0.07, mouthPucker: 0.85, mouthFunnel: 0.25 } },
  EU:  { dom: 1.0, w: { jawOpen: 0.08, mouthStretchLeft: 0.42, mouthStretchRight: 0.42, mouthUpperUpLeft: 0.07, mouthUpperUpRight: 0.07, mouthLowerDownLeft: 0.06, mouthLowerDownRight: 0.06 } },
  MBP: { dom: 2.6, close: 1, w: { jawOpen: 0.0, mouthPressLeft: 0.45, mouthPressRight: 0.45, mouthRollLower: 0.12, mouthRollUpper: 0.08 } },
  FV:  { dom: 2.0, w: { jawOpen: 0.05, mouthRollLower: 0.6, mouthUpperUpLeft: 0.19, mouthUpperUpRight: 0.19 } },
  SS:  { dom: 1.6, w: { jawOpen: 0.04, mouthStretchLeft: 0.3, mouthStretchRight: 0.3, mouthUpperUpLeft: 0.17, mouthUpperUpRight: 0.17, mouthLowerDownLeft: 0.15, mouthLowerDownRight: 0.15, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 } },
  CH:  { dom: 1.6, w: { jawOpen: 0.06, mouthFunnel: 0.35, mouthPucker: 0.25, mouthUpperUpLeft: 0.18, mouthUpperUpRight: 0.18, mouthLowerDownLeft: 0.18, mouthLowerDownRight: 0.18 } },
  LN:  { dom: 1.2, w: { jawOpen: 0.12, tongueUp: 0.85, mouthStretchLeft: 0.1, mouthStretchRight: 0.1 } },
  KG:  { dom: 0.9, w: { jawOpen: 0.13, mouthStretchLeft: 0.1, mouthStretchRight: 0.1 } },
  H:   { dom: 0.5, w: { jawOpen: 0.15 } },
  TH:  { dom: 1.5, w: { jawOpen: 0.1, tongueOut: 0.3, tongueUp: 0.25 } },
  W:   { dom: 1.4, w: { jawOpen: 0.04, mouthPucker: 0.7, mouthFunnel: 0.2 } },
  R:   { dom: 1.1, w: { jawOpen: 0.1, mouthFunnel: 0.3, mouthPucker: 0.25 } },
};
export const VISEME_LABELS = { sil: '입술 닫기', A: '아/A', EO: '어', E: '에/E', I: '이/I', O: '오/O', U: '우/U', EU: '으', MBP: 'ㅁㅂㅍ', FV: 'F/V', SS: 'ㅅㅆ/S', CH: 'ㅈㅊ/SH', LN: 'ㄹㄴ/L', KG: 'ㄱㅋ/K', H: 'ㅎ/H', TH: 'TH', W: 'W/ㅜ˘', R: 'R' };

// ---------------------------------------------------------------- facial controller
// value ranges: [min, max]; map(v) → partial ARKit weights
export const CONTROLLER = [
  { id: 'browL', ko: '왼쪽 눈썹 높이', range: [-1, 1], map: v => v > 0 ? { browOuterUpLeft: v * 0.9, browInnerUp: v * 0.3 } : { browDownLeft: -v } },
  { id: 'browR', ko: '오른쪽 눈썹 높이', range: [-1, 1], map: v => v > 0 ? { browOuterUpRight: v * 0.9, browInnerUp: v * 0.3 } : { browDownRight: -v } },
  { id: 'frown', ko: '미간 찡그리기', range: [0, 1], map: v => ({ browDownLeft: v * 0.8, browDownRight: v * 0.8, noseSneerLeft: v * 0.12, noseSneerRight: v * 0.12 }) },
  { id: 'blinkL', ko: '왼쪽 눈 감기', range: [0, 1], map: v => ({ eyeBlinkLeft: v }) },
  { id: 'blinkR', ko: '오른쪽 눈 감기', range: [0, 1], map: v => ({ eyeBlinkRight: v }) },
  { id: 'wide', ko: '눈 크게 뜨기', range: [0, 1], map: v => ({ eyeWideLeft: v, eyeWideRight: v }) },
  { id: 'gazeV', ko: '시선 상하', range: [-1, 1], gaze: true, map: v => v > 0 ? { eyeLookUpLeft: v, eyeLookUpRight: v } : { eyeLookDownLeft: -v, eyeLookDownRight: -v } },
  { id: 'gazeH', ko: '시선 좌우', range: [-1, 1], gaze: true, map: v => v > 0 ? { eyeLookOutLeft: v, eyeLookInRight: v } : { eyeLookInLeft: -v, eyeLookOutRight: -v } },
  { id: 'puff', ko: '볼 부풀리기', range: [0, 1], map: v => ({ cheekPuff: v, mouthPressLeft: v * 0.2, mouthPressRight: v * 0.2 }) },
  { id: 'smile', ko: '입꼬리 올리기', range: [0, 1], map: v => ({ mouthSmileLeft: v, mouthSmileRight: v }) },
  { id: 'frownM', ko: '입꼬리 내리기', range: [0, 1], map: v => ({ mouthFrownLeft: v, mouthFrownRight: v }) },
  { id: 'pucker', ko: '입술 오므리기', range: [0, 1], map: v => ({ mouthPucker: v }) },
  { id: 'part', ko: '입술 벌리기', range: [0, 1], map: v => ({ mouthUpperUpLeft: v * 0.8, mouthUpperUpRight: v * 0.8, mouthLowerDownLeft: v * 0.8, mouthLowerDownRight: v * 0.8 }) },
  { id: 'funnel', ko: '입술 앞으로 내밀기', range: [0, 1], map: v => ({ mouthFunnel: v * 0.8, mouthPucker: v * 0.25 }) },
  { id: 'jaw', ko: '턱 열기', range: [0, 1], map: v => ({ jawOpen: v }) },
  { id: 'jawLR', ko: '턱 좌우 이동', range: [-1, 1], map: v => v > 0 ? { jawLeft: v } : { jawRight: -v } },
  { id: 'pitch', ko: '고개 상하 회전', range: [-1, 1], head: true, map: v => ({ headPitch: v * 0.45 }) },
  { id: 'yaw', ko: '고개 좌우 회전', range: [-1, 1], head: true, map: v => ({ headYaw: v * 0.7 }) },
  { id: 'roll', ko: '고개 기울이기', range: [-1, 1], head: true, map: v => ({ headRoll: v * 0.35 }) },
];
