// ============================================================================
//  AI conversation — Gemini Live (one realtime audio WebSocket session)
//  Ported from K-ANCHOR (kyuil71.github.io/Image-3d-maker/announcer):
//  mic PCM 16 kHz in → native voice 24 kHz out, local voice-activity barge-in,
//  Google Search grounding, perform_action tool that drives the 3D face.
//  The API key stays on this device (localStorage) and is only sent to Google.
// ============================================================================
const GAPI = 'https://generativelanguage.googleapis.com/v1beta';
const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const LIVE_DEFAULT = 'gemini-3.8-live';
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const $ = id => document.getElementById(id);

const RECORDER_SRC = `class PCMRecorder extends AudioWorkletProcessor {
 constructor(){super();this.sum=0;this.count=0;this.phase=0;this.ratio=sampleRate/16000;this.chunk=new Float32Array(640);this.index=0;}
 process(inputs){const input=inputs[0]&&inputs[0][0];if(input)for(const s of input){this.sum+=s;this.count++;this.phase++;if(this.phase>=this.ratio){this.chunk[this.index++]=this.sum/this.count;this.sum=0;this.count=0;this.phase-=this.ratio;if(this.index===640){this.port.postMessage(this.chunk.buffer,[this.chunk.buffer]);this.chunk=new Float32Array(640);this.index=0;}}}return true;}
}
registerProcessor('pcm-recorder',PCMRecorder);`;
let recorderURL = null;

function pcmBase64(samples) {
  const bytes = new Uint8Array(samples.length * 2), v = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) v.setInt16(i * 2, Math.round(clamp(samples[i], -1, 1) * 32767), true);
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- face actions (tool: perform_action)
export const ACTS = {
  look_left: { ko: '왼쪽 보기', f: (c, k) => { c.h.y = -.3 * k; c.e.y = -.22; } },
  look_right: { ko: '오른쪽 보기', f: (c, k) => { c.h.y = .3 * k; c.e.y = .22; } },
  look_up: { ko: '위 보기', f: (c, k) => { c.h.x = -.2 * k; c.e.x = -.2; } },
  look_down: { ko: '아래 보기', f: (c, k) => { c.h.x = .24 * k; c.e.x = .22; } },
  look_front: { ko: '정면 보기', f: c => { c.h.x = c.h.y = c.h.z = 0; c.e.x = c.e.y = 0; } },
  eyes_left: { ko: '눈만 왼쪽', f: (c, k) => { c.e.y = -.28 * Math.min(k, 1.4); } },
  eyes_right: { ko: '눈만 오른쪽', f: (c, k) => { c.e.y = .28 * Math.min(k, 1.4); } },
  eyes_up: { ko: '눈만 위', f: (c, k) => { c.e.x = -.2 * Math.min(k, 1.4); } },
  eyes_down: { ko: '눈만 아래', f: (c, k) => { c.e.x = .22 * Math.min(k, 1.4); } },
  head_down: { ko: '고개 숙이기', f: (c, k) => { c.h.x = .36 * k; c.e.x = .1; } },
  head_up: { ko: '고개 들기', f: (c, k) => { c.h.x = -.3 * k; c.e.x = -.08; } },
  head_turn_left: { ko: '고개 왼쪽으로', f: (c, k) => { c.h.y = -.5 * k; c.e.y = 0; } },
  head_turn_right: { ko: '고개 오른쪽으로', f: (c, k) => { c.h.y = .5 * k; c.e.y = 0; } },
  head_tilt_left: { ko: '고개 왼쪽 갸웃', f: (c, k) => { c.h.z = .24 * k; } },
  head_tilt_right: { ko: '고개 오른쪽 갸웃', f: (c, k) => { c.h.z = -.24 * k; } },
  nod: { ko: '끄덕', f: (c, k) => c.osc.push({ axis: 'x', amp: .17 * Math.min(k, 1.3), f: 2.2, dur: 1.5, t: 0 }) },
  shake: { ko: '도리도리', f: (c, k) => c.osc.push({ axis: 'y', amp: .24 * Math.min(k, 1.3), f: 2.4, dur: 1.7, t: 0 }) },
  smile: { ko: '웃기', f: (c, k) => c.setExpr('smile', 5, k) },
  laugh: { ko: '크게 웃기', f: (c, k) => c.setExpr('laugh', 3, k) },
  shy: { ko: '수줍게', f: (c, k) => c.setExpr('embarrassed', 4, k) },
  sad: { ko: '슬픈 표정', f: (c, k) => c.setExpr('sad', 8, k) },
  cry: { ko: '울기', f: (c, k) => c.setExpr('sad', 7, Math.max(1.4, k)) },
  angry: { ko: '화난 표정', f: (c, k) => c.setExpr('angry', 5, k) },
  surprise: { ko: '놀란 표정', f: (c, k) => c.setExpr('surprised', 1.8, k) },
  disgust: { ko: '찡그리기', f: (c, k) => c.setExpr('disgust', 3, k) },
  think: { ko: '생각하는 표정', f: (c, k) => c.setExpr('thinking', 4, k) },
  wink: { ko: '윙크', f: c => { c.wink = 0.6; } },
  blink: { ko: '깜박', f: c => { c.blinkNow = true; } },
  eyes_close: { ko: '눈 감기', f: c => { c.eyes = 'close'; } },
  eyes_open: { ko: '눈 뜨기', f: c => { c.eyes = null; } },
  mouth_open: { ko: '입 벌리기', f: c => { c.mouth = 'open'; } },
  mouth_close: { ko: '입 다물기', f: c => { c.mouth = 'close'; } },
  pout: { ko: '뽀뽀 입', f: c => { c.mouth = 'pucker'; } },
  neutral: { ko: '표정 원래대로', f: c => { c.clearExpr(); c.mouth = null; c.eyes = null; } },
  reset: { ko: '원래대로', f: c => c.reset() },
};

function voiceFeatFactory() {
  const vf = { hpY: 0, hpX: 0, lpY: 0, buf: new Float32Array(640) };
  return function voiceFeat(x) {
    const dt = 1 / 16000, rcH = 1 / (2 * Math.PI * 150), rcL = 1 / (2 * Math.PI * 3400), a = rcH / (rcH + dt), b = dt / (rcL + dt);
    const y = vf.buf; let et = 0, eb = 0;
    for (let i = 0; i < x.length; i++) { vf.hpY = a * (vf.hpY + x[i] - vf.hpX); vf.hpX = x[i]; vf.lpY += b * (vf.hpY - vf.lpY); y[i] = vf.lpY; et += x[i] * x[i]; eb += vf.lpY * vf.lpY; }
    const band = et > 1e-12 ? eb / et : 0; let per = 0; const N = x.length;
    if (eb > 1e-9) for (let l = 40; l <= 200; l += 2) { let c = 0, e1 = 0, e2 = 0; for (let i = 0; i + l < N; i += 2) { const u = y[i], v = y[i + l]; c += u * v; e1 += u * u; e2 += v * v; } const r = c / Math.sqrt(e1 * e2 + 1e-12); if (r > per) per = r; }
    return { band, per };
  };
}
function endHang(text) {
  const t = String(text || '').trim().replace(/[.,!?…~\s]+$/, '');
  if (!t) return 1300;
  if (/(^|\s)(음+|어+|으+|그+|저기|그)$/.test(t)) return 1800;
  if (/(그러니까|그래서|근데|그리고|는데|은데|ㄴ데|인데|해서|하고|려고|는지|면서|거나|든지|니까|으면|라면|다면|고|서|면|며|랑|와|과|이랑|을|를|이|가|은|는|에|에서|로|으로|의|도)$/.test(t)) return 1700;
  if (/[?？]$/.test(String(text).trim()) || /(요|다|까|죠|지|네|야|자|어|아|해|래|게|군|구나|니|봐|줘|워|돼)$/.test(t)) return 800;
  return 1150;
}
function liveSystem() {
  const d = new Date();
  return [
    '당신은 3D 얼굴 캐릭터 "세린(Serene)"입니다. 사용자와 얼굴을 마주 보고 실시간 음성으로 대화합니다. 사용자는 화면 속 당신의 3D 얼굴을 보고 있습니다.',
    `오늘은 ${d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}입니다.`,
    '친한 사람과 마주 앉아 이야기하듯 편안하고 자연스러운 존댓말(해요체)로 말하세요. 보통 1~3문장으로 짧게 답하고, 사용자가 자세히 원할 때만 길게 설명하세요.',
    '"알겠습니다", "요청하신 대로", "말씀하신" 같은 기계적인 응답 문구나 같은 맺음말을 반복하지 마세요. 매번 질문으로 끝낼 필요도 없습니다. 사람처럼 맞장구치고, 흐름에 맞게 이어가세요.',
    '평소 표정은 차분한 보통 표정입니다. 스스로 웃는 것은 정말 웃긴 이야기나 기쁜 소식일 때만 가끔 하세요.',
    '사용자가 끼어들면 이전 답을 멈추고 새 말을 끝까지 들은 뒤, 끊기기 전까지 한 이야기와 새 말을 함께 이해해서 이어서 답하세요. 이미 한 말은 반복하지 마세요.',
    '최신 정보, 날씨, 뉴스, 가격, 일정, 경기 결과나 검색 요청에는 google_search를 사용하세요. 검색할 때는 "확인해 볼게요"처럼 짧게 말하고, URL은 읽지 마세요. 검색하지 않은 정보를 검색했다고 말하지 마세요.',
    '시선, 고개, 표정, 눈, 입을 움직여 달라는 요청에는 반드시 perform_action을 호출하세요. 사용자는 화면으로 바로 보고 있으니, 한 일을 말로 보고하거나 확인하지 마세요. 동작만 하고 아무 말도 하지 않거나, 꼭 필요하면 "이렇게요?"처럼 아주 짧은 한마디만 하세요. 대화 도중에 온 지시라면 동작을 한 뒤 하던 이야기를 자연스럽게 이어가세요.',
    '사용자는 한국어로 말합니다. 음성 인식이 틀릴 수 있으니 발음이 비슷한 말과 앞뒤 흐름으로 뜻을 헤아리세요. 뜻이 애매하면 "○○ 말씀이세요?"처럼 짧게 되물으세요. 기침, 잡음, "음" 같은 의미 없는 소리에는 대답하지 마세요.',
    '왼쪽과 오른쪽은 사용자가 보는 화면 기준입니다. 사용자가 "네 오른쪽"처럼 당신 몸 기준을 말하면 반대쪽을 쓰세요. "더", "많이"는 intensity를 2~3으로 하세요.',
    '시선과 고개는 다음 지시까지 유지되고, 표정은 몇 초 뒤 자연스럽게 풀립니다. "원래대로", "그만", "평소처럼"은 reset입니다. 입을 다물라는 지시에는 대답하지 말고 동작만 하세요.',
  ].join('\n');
}
const LIVE_PROFILES = [
  { greet: true, textVia: 'client', tools: 'full', model: null },
  { greet: false, textVia: 'realtime', tools: 'full', model: LIVE_DEFAULT },
  { greet: false, textVia: 'realtime', tools: 'fn', model: LIVE_DEFAULT },
  { greet: false, textVia: 'realtime', tools: 'none', model: LIVE_DEFAULT },
];
function liveSetup(model, voice, prof, resumeHandle, recap) {
  const fn = { functionDeclarations: [{ name: 'perform_action', description: '세린의 시선·고개·표정·눈·입 동작을 실행합니다. 실행 여부는 반환 결과를 따르세요.',
    parameters: { type: 'OBJECT', properties: { actions: { type: 'ARRAY', items: { type: 'STRING', enum: Object.keys(ACTS) } }, intensity: { type: 'NUMBER', description: '정도 1~3, 기본 1' } }, required: ['actions'] } }] };
  const tools = prof.tools === 'full' ? [{ googleSearch: {} }, fn] : prof.tools === 'fn' ? [fn] : null;
  const sys = liveSystem() + (recap ? '\n\n[연결이 잠시 끊겼다가 다시 이어졌습니다. 아래는 끊기기 전까지의 대화입니다. 인사를 반복하지 말고, 사용자가 말을 걸면 이 흐름을 이어서 자연스럽게 답하세요.]\n' + recap : '')
    + (prof.tools === 'full' ? '' : '\n지금은 검색 도구가 꺼져 있습니다. 최신 정보는 정확히 알 수 없다고 솔직하게 말하세요.')
    + (prof.tools === 'none' ? '\n지금은 얼굴 동작 도구가 꺼져 있습니다. 동작 요청에는 지금은 할 수 없다고 말하세요.' : '');
  const setup = {
    model: 'models/' + model.replace(/^models\//, ''),
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    systemInstruction: { parts: [{ text: sys }] },
    inputAudioTranscription: {}, outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true }, activityHandling: 'START_OF_ACTIVITY_INTERRUPTS', turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY' },
    contextWindowCompression: { slidingWindow: {} }, sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
  if (tools) setup.tools = tools;
  return { setup };
}
function aiErrText(m) {
  m = String(m || '');
  if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(m)) return 'API 키가 올바르지 않습니다. 키를 다시 확인해 주세요.';
  if (/PERMISSION_DENIED|permission/i.test(m)) return '이 키에 Gemini API 권한이 없습니다. AI Studio에서 새 키를 만들어 보세요.';
  if (/quota|RESOURCE_EXHAUSTED|429|rate/i.test(m)) return '사용량 한도에 도달했습니다. 잠시 후 다시 시도하세요.';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return '네트워크에 연결할 수 없습니다.';
  return m;
}

// ============================================================================
//  initAI(host): host = { ensureAudio(), toast(msg,ms), store, animator, setExpr(id,k), clearExpr(),
//                         analyzeMood(text) → expression id|null, onState(state) }
// ============================================================================
export function initAI(host) {
  const store = host.store;
  const ai = { on: false, key: '', model: '', profile: 0, recover: 0, hideTurn: null, heard: false };
  // face control layer read by the animator each frame
  const ctl = host.animator.aiCtl = {
    h: { x: 0, y: 0, z: 0 }, e: { x: 0, y: 0 }, osc: [], mouth: null, eyes: null, wink: 0, blinkNow: false,
    setExpr: (id, hold, k) => host.setExpr(id, hold, k), clearExpr: () => host.clearExpr(),
    reset() { this.h.x = this.h.y = this.h.z = 0; this.e.x = this.e.y = 0; this.osc = []; this.mouth = this.eyes = null; this.wink = 0; host.clearExpr(); },
  };
  const voiceFeat = voiceFeatFactory();

  // ---------------------------------------------------------------- connection log (1-7)
  const LOG_KEY = 'connLog';
  const connLog = (() => { try { return JSON.parse(store.get(LOG_KEY, '[]')) || []; } catch { return []; } })();
  function logEv(ev, detail = '') {
    const d = new Date(), t = d.toLocaleTimeString('ko-KR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 1);
    connLog.push({ t, date: d.toLocaleDateString('ko-KR'), ev, detail: String(detail).replace(/AIza[\w-]+/g, '[키]') });
    while (connLog.length > 60) connLog.shift();
    store.set(LOG_KEY, JSON.stringify(connLog)); renderLog();
  }
  function renderLog() {
    const box = $('aiLog'); if (!box) return;
    box.textContent = connLog.slice().reverse().map(e => `${e.t}  ${e.ev}${e.detail ? '  · ' + e.detail : ''}`).join('\n') || '기록 없음';
  }

  const live = {
    ws: null, ready: false, state: 'closed', epoch: 0, nodes: new Set(), nextTime: 0, speaking: false, userActive: false,
    blockOutput: false, muted: false, autoMuted: false, pre: [], lastVoice: 0, sp: 0, quiet: 0, noise: .004, pauseNod: true, turn: 0, inputText: '', outputText: '', serverDone: true,
    threshold: .02, calls: new Set(), canceled: new Set(), greeted: false, resumeHandle: null, openedAt: 0, goAwayAt: 0,
    emit(s) { this.state = s; onState(s); },
    send(v) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(v)); return true; } return false; },
    // microphone + worklet + voice output are created once per conversation and survive reconnects
    async ensureIO() {
      const ctx = this.ctx = host.ensureAudio(); if (ctx.state !== 'running') await ctx.resume().catch(() => { });
      if (this.stream && this.stream.active && this.stream.getAudioTracks().some(t => t.readyState === 'live')) return;
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
      this.stream = stream;
      stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => { if (ai.on) { logEv('마이크 트랙 종료', '다른 앱이 마이크를 가져갔을 수 있음'); this.stream = null; scheduleReconnect('마이크 재시작'); } }));
      if (!recorderURL) recorderURL = URL.createObjectURL(new Blob([RECORDER_SRC], { type: 'text/javascript' }));
      if (!ctx.__pcmRec) { await ctx.audioWorklet.addModule(recorderURL); ctx.__pcmRec = true; }
      for (const k of ['mic', 'rec', 'silent']) { try { this[k] && this[k].disconnect(); } catch (e) { } }
      if (!this.out) { this.out = ctx.createGain(); this.out.connect(ctx.destination); host.connectVoice(this.out); }
      this.mic = ctx.createMediaStreamSource(stream); this.rec = new AudioWorkletNode(ctx, 'pcm-recorder');
      this.silent = ctx.createGain(); this.silent.gain.value = 0;
      this.mic.connect(this.rec); this.rec.connect(this.silent).connect(ctx.destination);
      this.rec.port.onmessage = e => this.capture(new Float32Array(e.data));
      if (this.muted) stream.getAudioTracks().forEach(t => t.enabled = false);
    },
    async connect({ key, model, voice, prof, resume, recap }) {
      this.closeSocket(); const ep = ++this.epoch;
      this.prof = prof; this.phase = 'setup'; this.okTurns = 0; this.resumed = !!resume; this.model = model;
      this.calls.clear(); this.canceled.clear(); this.inputText = ''; this.outputText = ''; this.blockOutput = false; this.userActive = false; this.pre = [];
      this.emit(ai.reconnecting ? 'reconnecting' : 'connecting');
      this.timer = setTimeout(() => { if (ep === this.epoch) { logEv('연결 시간 초과', '30초 동안 응답 없음'); this.closeSocket(); liveClosed(4000, 'timeout'); } }, 30000);
      try {
        await this.ensureIO();
        if (ep !== this.epoch) return;
        const ws = this.ws = new WebSocket(LIVE_WS + '?key=' + encodeURIComponent(key));
        logEv(resume ? '재연결 시도 (세션 이어붙이기)' : recap ? '재연결 시도 (새 세션 + 대화 요약)' : '연결 시도', `모델 ${model} · 설정 ${ai.profile + 1}`);
        ws.onopen = () => { if (ep === this.epoch) { this.openedAt = performance.now(); this.send(liveSetup(model, voice, prof, resume, recap)); } };
        let chain = Promise.resolve();
        ws.onmessage = e => { chain = chain.then(async () => { if (ep !== this.epoch) return; const raw = typeof e.data === 'string' ? e.data : await e.data.text(); if (ep === this.epoch) this.handle(JSON.parse(raw)); })
          .catch(err => { if (ep === this.epoch) logEv('메시지 처리 오류', err.message); }); };
        ws.onerror = () => { if (ep === this.epoch) logEv('웹소켓 오류', navigator.onLine ? '' : '오프라인'); };      // onclose follows and decides
        ws.onclose = e => { if (ep !== this.epoch) return; this.ws = null; this.ready = false; clearTimeout(this.timer); liveClosed(e.code, e.reason || ''); };
      } catch (e) {
        if (ep !== this.epoch) return;
        if (e.name === 'NotAllowedError') { this.fail('마이크 권한을 허용해 주세요.'); return; }
        logEv('연결 준비 실패', e.message); liveClosed(4001, e.message);
      }
    },
    capture(samples) {
      if (!this.ready || this.muted) return;
      let p = 0; for (const v of samples) p += v * v; const rms = Math.sqrt(p / samples.length), now = performance.now();
      const f = voiceFeat(samples);
      const packet = { audio: { data: pcmBase64(samples), mimeType: 'audio/pcm;rate=16000' } };
      this.pre.push(packet); if (this.pre.length > 10) this.pre.shift();
      const base = Math.max(this.threshold, this.noise * 3), thr = base * (this.speaking ? 1.8 : 1);
      const voice = rms > thr && f.band > .38 && f.per > .4;
      if (!this.userActive) {
        if (rms < this.noise) this.noise += (rms - this.noise) * .3; else if (!voice) this.noise += (rms - this.noise) * .015;
        this.noise = clamp(this.noise, .002, .05);
        if (voice) { this.sp += .04; this.quiet = 0; } else { this.sp = Math.max(0, this.sp - .02); if (rms < thr * .5 && ++this.quiet > 3) this.sp = 0; }
      }
      if (!this.userActive && this.sp >= .2) {
        this.sp = 0; this.lastVoice = now; this.pauseNod = true; wakeOn();
        this.userActive = true; this.blockOutput = true; this.inputText = ''; this.turn++;
        const was = this.speaking; this.clearAudio(); onInterrupt(was); this.emit('listening');
        if (was) logEv('끼어들기 감지', 'AI 말 중단 (이어폰 없이 자주 뜨면 민감도를 올리세요)');
        this.send({ realtimeInput: { activityStart: {} } }); for (const q of this.pre) this.send({ realtimeInput: q }); this.pre = []; return;
      }
      if (this.userActive) {
        this.send({ realtimeInput: packet });
        if ((rms > base * .5 && f.band > .3) || (rms > this.noise * 2.5 && f.per > .5)) { this.lastVoice = now; this.pauseNod = false; wakeOn(); }
        else if (!this.pauseNod && now - this.lastVoice > 260) { this.pauseNod = true; host.animator.triggerNod(0.45); }
        if (now - this.lastVoice > endHang(this.inputText)) { this.userActive = false; this.send({ realtimeInput: { activityEnd: {} } }); this.blockOutput = false; this.outputText = ''; this.emit('thinking'); }
      }
    },
    handle(e) {
      if (e.error) { logEv('서버 오류', e.error.message || ''); return; }
      if (e.setupComplete) {
        clearTimeout(this.timer); this.ready = true; this.phase = 'ready';
        const wasRe = ai.reconnecting; ai.reconnecting = false; ai.retry = 0; ai.handoverPending = false;
        logEv(this.resumed ? '다시 연결됨 · 대화 이어짐' : wasRe ? '다시 연결됨 · 새 세션 (대화 요약 전달)' : '연결됨', `${Math.round(performance.now() - this.openedAt)}ms`);
        if (wasRe) { this.greeted = true; addMsg('info', this.resumed ? '연결을 이어 붙였습니다. 대화가 계속됩니다.' : '다시 연결했습니다. 앞의 대화 내용을 전달해 두었습니다.'); }
        this.emit(this.speaking ? 'speaking' : 'connected'); return;
      }
      if (e.sessionResumptionUpdate) {
        const u = e.sessionResumptionUpdate;
        if (u.resumable !== false && u.newHandle) this.resumeHandle = u.newHandle;
      }
      if (e.goAway) {      // server will close this socket soon → hand over to a new one at a quiet moment
        const left = parseFloat(String((e.goAway.timeLeft || '')).replace(/[^\d.]/g, '')) || 10;
        logEv('서버 연결 종료 예고', `남은 시간 약 ${left}초 · 조용할 때 새 연결로 넘김`);
        ai.handoverPending = true; this.goAwayAt = performance.now(); this.goAwayLeft = left;
      }
      for (const id of (e.toolCallCancellation && e.toolCallCancellation.ids) || []) this.canceled.add(id);
      const s = e.serverContent;
      if (s) {
        if (s.interrupted) { const was = this.speaking; this.clearAudio(); onInterrupt(was); this.outputText = ''; if (this.userActive) this.emit('listening'); }
        if (s.inputTranscription && s.inputTranscription.text) {
          this.inputText += s.inputTranscription.text; transcript('me', this.inputText, this.turn);
          if (!this.userActive && /검색|날씨|최신|뉴스|시세|가격|일정/.test(this.inputText)) this.emit('searching');
        }
        if (!this.userActive && !this.blockOutput && !s.interrupted) {
          if (s.outputTranscription && s.outputTranscription.text) { this.outputText += s.outputTranscription.text; transcript('ai', this.outputText, this.turn); }
          for (const p of (s.modelTurn && s.modelTurn.parts) || []) {
            if (p.inlineData && /^audio\/pcm/.test(p.inlineData.mimeType || '')) this.enqueue(p.inlineData);
            if (p.executableCode) { this.emit('searching'); this.searching = true; }
          }
          if (s.groundingMetadata) sources(s.groundingMetadata, this.turn);
        }
        if (s.modelTurn || s.outputTranscription) this.gotReply = true;
        if (s.turnComplete) {
          this.serverDone = true; this.searching = false;
          if (this.gotReply) { this.okTurns++; liveWorked(); remember('me', this.inputText); remember('ai', this.outputText); }
          this.gotReply = false; if (!this.nodes.size && !this.userActive) this.emit('connected');
        }
      }
      if (e.toolCall) {
        const responses = [];
        for (const c of e.toolCall.functionCalls || []) {
          if (this.calls.has(c.id)) continue; this.calls.add(c.id);
          let response = { ok: false, message: '취소되었거나 지원하지 않는 요청입니다.' };
          if (!this.userActive && !this.canceled.has(c.id) && c.name === 'perform_action') {
            try { response = perform(c.args || {}, this.turn); } catch (err) { response = { ok: false, message: '동작을 실행하지 못했습니다.' }; }
          }
          responses.push({ id: c.id, name: c.name, response });
        }
        if (responses.length) this.send({ toolResponse: { functionResponses: responses } });
      }
    },
    enqueue(data) {
      if (!this.ctx || this.userActive || this.blockOutput) return;
      const raw = atob(data.data), n = raw.length >> 1, rate = Number((/rate=(\d+)/.exec(data.mimeType) || [])[1] || 24000);
      const buf = this.ctx.createBuffer(1, n, rate), out = buf.getChannelData(0);
      for (let i = 0; i < n; i++) { let v = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8); if (v >= 32768) v -= 65536; out[i] = v / 32768; }
      const node = this.ctx.createBufferSource(); node.buffer = buf; node.connect(this.out);
      this.nextTime = Math.max(this.nextTime || 0, this.ctx.currentTime + .025); node.start(this.nextTime); this.nextTime += buf.duration;
      this.nodes.add(node); this.speaking = true; this.serverDone = false; wakeOn(); if (this.state !== 'speaking') this.emit('speaking');
      node.onended = () => { this.nodes.delete(node); try { node.disconnect(); } catch (e) { } if (!this.nodes.size) { this.speaking = false; if (this.ready && !this.userActive) this.emit(this.serverDone ? 'connected' : 'thinking'); } };
    },
    clearAudio() { for (const n of this.nodes) { n.onended = null; try { n.stop(); n.disconnect(); } catch (e) { } } this.nodes.clear(); this.nextTime = 0; this.speaking = false; },
    text(t, silentUser) {
      if (!this.ready) return false;
      this.clearAudio(); this.userActive = false; this.blockOutput = false; this.turn++; this.outputText = ''; this.inputText = silentUser ? '' : t;
      if (!silentUser) transcript('me', t, this.turn);
      if (this.prof && this.prof.textVia === 'realtime') { this.send({ realtimeInput: { activityStart: {} } }); this.send({ realtimeInput: { text: t } }); this.send({ realtimeInput: { activityEnd: {} } }); }
      else this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: t }] }], turnComplete: true } });
      this.phase = silentUser ? 'greeting' : 'talk'; this.emit('thinking'); return true;
    },
    mute(v, auto) {
      this.muted = v; this.autoMuted = v && !!auto; if (this.stream) this.stream.getAudioTracks().forEach(t => t.enabled = !v);
      if (v && this.userActive) { this.send({ realtimeInput: { activityEnd: {} } }); this.userActive = false; this.blockOutput = false; this.emit('thinking'); }
      this.pre = []; onState(this.state);
    },
    fail(msg) { logEv('연결 중단', msg); this.close(true); this.emit('error'); notice(String(msg).replace(/AIza[\w-]+/g, '[키 숨김]')); },
    closeSocket() {
      this.epoch++; this.ready = false; clearTimeout(this.timer);
      if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; this.ws.onmessage = null; try { this.ws.close(); } catch (e) { } this.ws = null; }
      this.userActive = false; this.pre = [];
    },
    close(quiet) {
      this.closeSocket(); this.clearAudio();
      if (this.rec) { this.rec.port.onmessage = null; try { this.rec.disconnect(); } catch (e) { } this.rec = null; }
      for (const k of ['mic', 'silent', 'out']) { try { this[k] && this[k].disconnect(); } catch (e) { } this[k] = null; }
      if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null;
      this.muted = false; this.autoMuted = false; this.resumeHandle = null;
      if (!quiet) this.emit('closed');
    },
  };

  // ---------------------------------------------------------------- wake lock (held for the whole conversation)
  const wake = { lock: null, pending: false };
  async function wakeOn() {
    if (wake.lock || wake.pending || !ai.on || document.hidden || !('wakeLock' in navigator)) return;
    wake.pending = true;
    try { const l = await navigator.wakeLock.request('screen'); if (!ai.on) l.release().catch(() => { }); else { wake.lock = l; l.addEventListener('release', () => { if (wake.lock === l) wake.lock = null; }); } } catch (e) { }
    wake.pending = false;
  }
  function wakeOff() { const l = wake.lock; wake.lock = null; if (l) l.release().catch(() => { }); }

  // ---------------------------------------------------------------- chat log
  const bubbles = new Map();
  const history = [];   // finished turns, used to brief a fresh session after an unrecoverable drop
  function remember(who, text) { text = String(text || '').trim(); if (!text) return; history.push((who === 'me' ? '사용자: ' : '세린: ') + text); while (history.length > 16) history.shift(); }
  const recap = () => history.join('\n').slice(-2500);
  function addMsg(who, text) {
    const d = document.createElement('div'); d.className = 'msg ' + who; d.appendChild(document.createTextNode(text));
    const log = $('chatLog'); log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
  }
  function bubble(who, turn) { const id = who + turn; let d = bubbles.get(id); if (!d || !d.isConnected) { d = addMsg(who, ''); bubbles.set(id, d); } return d; }
  let moodSent = '';
  function transcript(who, text, turn) {
    if (who === 'ai' && ai.hideTurn === turn) return;
    const d = bubble(who, turn); let tn = d.firstChild; while (tn && tn.nodeType !== 3) tn = tn.nextSibling;
    if (!tn) { tn = document.createTextNode(''); d.insertBefore(tn, d.querySelector('.src')); }
    tn.nodeValue = text.trim(); const log = $('chatLog'); log.scrollTop = log.scrollHeight;
    if (who === 'ai') {      // mood from her own words (completed sentences only)
      const parts = text.trim().split(/(?<=[.!?…。])\s+/); const last = parts.length > 1 ? parts[parts.length - 2] : '';
      if (last && last !== moodSent) { moodSent = last; host.moodFromText(last, ai.heard); }
    }
    host.subtitle && host.subtitle(who, text.trim());
  }
  function sources(meta, turn) {
    const d = bubble('ai', turn); let box = d.querySelector('.src');
    for (const c of meta.groundingChunks || []) {
      const web = c.web; if (!web || !web.uri) continue;
      let url; try { url = new URL(web.uri); if (!/^https?:$/.test(url.protocol)) continue; } catch (e) { continue; }
      if (!box) { box = document.createElement('div'); box.className = 'src'; d.appendChild(box); }
      if ([...box.querySelectorAll('a')].some(a => a.href === url.href)) continue;
      const a = document.createElement('a'); a.href = url.href; a.textContent = web.title || url.hostname; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.appendChild(a);
    }
  }
  function perform(args, turn) {
    const n = clamp(Math.round(+args.intensity || 1), 1, 3), k = [1, 1.4, 1.75][n - 1];
    const acts = (args.actions || []).filter(id => ACTS[id]);
    if (!acts.length) return { ok: false, message: '지원하지 않는 동작입니다.' };
    for (const id of acts) ACTS[id].f(ctl, k);
    ctl.h.x = clamp(ctl.h.x, -.65, .65); ctl.h.y = clamp(ctl.h.y, -.8, .8); ctl.h.z = clamp(ctl.h.z, -.45, .45);
    const d = bubble('ai', turn); let chip = d.querySelector('.act');
    if (!chip) { chip = document.createElement('span'); chip.className = 'act'; d.insertBefore(chip, d.firstChild); }
    chip.textContent = '▸ ' + [...new Set([...(chip.textContent.replace(/^▸ /, '').split(' · ').filter(Boolean)), ...acts.map(a => ACTS[a].ko)])].join(' · ');
    return { ok: true, note: '동작이 화면에 반영됨. 한 일을 말로 보고하지 말 것.' };
  }
  function onInterrupt(was) { if (!was) return; const d = bubbles.get('ai' + live.turn) || bubbles.get('ai' + (live.turn - 1)); if (d) d.classList.add('cut'); }
  function notice(t) { addMsg('err', t); host.toast(t, 4500); }

  const STATE_TXT = {
    connecting: '연결 중…', connected: '말씀하세요. 그냥 말을 걸면 됩니다.', listening: '듣고 있어요…',
    thinking: '생각하는 중…', searching: '검색으로 확인하는 중…', speaking: '말하는 중 · 말을 걸면 바로 멈춰요',
    error: '연결이 끊겼습니다. 다시 연결하세요.', closed: '연결 전',
    reconnecting: '연결 복구 중…', offline: '네트워크 끊김 · 연결되면 자동 복구',
  };
  function onState(s) {
    if (ai.on) wakeOn();
    if (s === 'listening') ai.heard = true;
    let txt = live.muted && live.ready ? '마이크가 꺼져 있습니다. 🎤를 눌러 켜세요.' : (STATE_TXT[s] || STATE_TXT.closed);
    if (s === 'reconnecting' && ai.retryIn) txt = `연결 복구 중… (${ai.retry}번째)`;
    $('aiState').textContent = txt;
    const mic = $('aiMic');
    mic.classList.toggle('on', s === 'listening'); mic.classList.toggle('think', /thinking|searching|connecting/.test(s)); mic.classList.toggle('speak', s === 'speaking');
    mic.classList.toggle('muted', live.muted); mic.textContent = live.muted ? '🔇' : (s === 'error' ? '🔄' : '🎤'); mic.classList.toggle('think', /thinking|searching|connecting|reconnecting|offline/.test(s));
    if (s === 'connected' && ai.on && !live.greeted && live.prof && live.prof.greet) {
      live.greeted = true;
      live.text('(대화가 연결됨) 차분한 평소 표정으로, 사람이 처음 말을 건네듯 한 문장으로 가볍게 인사해 주세요. 웃지 말고, "무엇이든 물어보세요" 같은 정형화된 안내 문구는 쓰지 마세요.', true);
    }
    if (s === 'thinking' || s === 'searching') host.animator.gesture('lookAway');
    host.onState(s, txt, ai.on, live.muted);
  }

  // ---------------------------------------------------------------- connect / profiles
  async function listModels(key) {
    const res = await fetch(`${GAPI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
    return j.models || [];
  }
  function rankLive(models) {
    const names = models.filter(m => (m.supportedGenerationMethods || []).includes('bidiGenerateContent') || /live|native-audio/.test(m.name))
      .map(m => m.name.replace(/^models\//, '')).filter(n => /^gemini-/.test(n));
    const score = n => (n === LIVE_DEFAULT ? 1e4 : 0) + parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0) * 10 + (/live/.test(n) ? 5 : 0) - (/preview|exp/.test(n) ? 3 : 0);
    return [LIVE_DEFAULT, ...[...new Set(names)].filter(n => n !== LIVE_DEFAULT).sort((a, b) => score(b) - score(a))];
  }
  async function connect() {
    const key = $('aiKey').value.trim();
    if (!key) { $('aiErr').textContent = 'API 키를 입력하세요.'; host.openAIPanel(); return; }
    if (!navigator.mediaDevices || !window.isSecureContext) { $('aiErr').textContent = '마이크는 HTTPS 주소에서만 사용할 수 있습니다.'; host.openAIPanel(); return; }
    host.ensureAudio();
    $('aiConnect').disabled = true; $('aiConnect').textContent = '확인 중…'; $('aiErr').textContent = '';
    host.onState('connecting', '키 확인 중…', true, false);
    try {
      const ranked = rankLive(await listModels(key));
      ai.key = key; store.set('aiKey', key);
      const saved = store.get('liveModel', ''); ai.model = saved && ranked.includes(saved) ? saved : LIVE_DEFAULT;
      const sel = $('aiModel'); sel.textContent = '';
      for (const n of ranked) sel.add(new Option(n, n));
      sel.value = ai.model;
      start();
    } catch (e) { $('aiErr').textContent = '연결 실패: ' + aiErrText(e.message); host.onState('closed', '연결 실패', false, false); host.openAIPanel(); }
    finally { $('aiConnect').disabled = false; $('aiConnect').textContent = '연결'; }
  }
  function go(keepProfile, opts = {}) {
    if (!keepProfile) ai.profile = clamp(+store.get('liveProfile', 0) || 0, 0, LIVE_PROFILES.length - 1);
    const prof = LIVE_PROFILES[ai.profile];
    live.threshold = +$('aiSens').value;
    live.connect({ key: ai.key, model: prof.model || ai.model, voice: $('aiVoice').value, prof, resume: opts.resume || null, recap: opts.recap || null });
  }
  function liveWorked() { ai.everWorked = true; if (String(store.get('liveProfile', '0')) !== String(ai.profile)) store.set('liveProfile', String(ai.profile)); }

  // ---- reconnection (1-1, 1-2, 1-4): unlimited while the conversation is on, with back-off
  const BACKOFF = [0.5, 1, 2, 4, 8, 15, 30];
  let reTimer = null;
  function scheduleReconnect(why, immediate) {
    if (!ai.on) return;
    clearTimeout(reTimer);
    if (!navigator.onLine) { ai.reconnecting = true; live.emit('offline'); logEv('오프라인', '네트워크가 돌아오면 자동 재연결'); return; }
    ai.reconnecting = true;
    const delay = immediate ? 0 : BACKOFF[Math.min(ai.retry, BACKOFF.length - 1)];
    ai.retry++; ai.retryIn = delay;
    live.emit('reconnecting');
    logEv('재연결 예약', `${why} · ${delay}초 후 · ${ai.retry}번째`);
    reTimer = setTimeout(() => {
      if (!ai.on) return;
      if (document.hidden) { logEv('재연결 보류', '화면이 다시 보이면 연결'); return; }
      const handle = live.resumeHandle;
      go(true, handle ? { resume: handle } : { recap: recap() });
    }, delay * 1000);
  }
  function liveClosed(code, reason) {
    if (!ai.on) return;
    const where = live.phase === 'setup' ? '설정 단계' : live.phase === 'greeting' ? '첫 인사 직후' : '대화 중';
    const lived = live.openedAt ? Math.round((performance.now() - live.openedAt) / 1000) : 0;
    const detail = `코드 ${code}${reason ? ' (' + reason + ')' : ''} · ${where} · 유지 ${lived}초 · ${live.model || ai.model}`;
    logEv('연결 끊김', detail);
    const neverWorked = !live.okTurns && !live.resumed && !ai.everWorked;
    // 1) quota / billing: retrying cannot help
    if (/quota|exceeded|billing|RESOURCE_EXHAUSTED/i.test(reason)) {
      ai.on = false; clearTimeout(reTimer); host.aiActive(false);
      live.fail(neverWorked ? `이 API 키로는 Gemini Live 모델을 쓸 수 없습니다(사용 한도 0 또는 결제 미연결). ${detail}` : `Gemini 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 AI Studio에서 한도·결제를 확인해 주세요. ${detail}`);
      return;
    }
    if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(reason)) { ai.on = false; clearTimeout(reTimer); host.aiActive(false); live.fail(aiErrText(reason)); return; }
    // 2) the resumption handle was refused → forget it and start a fresh session with a recap
    if (live.resumed && live.phase === 'setup') { live.resumeHandle = null; logEv('세션 이어붙이기 거부', '새 세션 + 대화 요약으로 재연결'); return scheduleReconnect('이어붙이기 실패', true); }
    // 3) never answered with this profile → step down to a simpler setup
    if (neverWorked && /^(1007|1008|1011)$/.test(String(code)) && ai.profile < LIVE_PROFILES.length - 1) {
      ai.profile++; live.resumeHandle = null;
      addMsg('err', `연결이 거부되어 설정을 바꿔 다시 연결합니다 (${ai.profile + 1}/${LIVE_PROFILES.length})`);
      return scheduleReconnect('설정 단계 거부', true);
    }
    // 4) internal error while searching → continue without the search tool (1-4)
    if (String(code) === '1011' && (live.searching || /search|grounding|tool/i.test(reason)) && LIVE_PROFILES[ai.profile].tools === 'full') {
      ai.profile = 2; live.resumeHandle = null;
      addMsg('err', '검색 중 서버 오류로 연결이 끊겨, 검색 도구 없이 다시 연결합니다. (대화 새로 시작 시 검색 기능 복구)');
      return scheduleReconnect('검색 중 서버 오류', true);
    }
    // 5) everything else (time limit, network, background, server hiccup): reconnect, resuming if possible
    scheduleReconnect(String(code) === '1000' || ai.handoverPending ? '서버 세션 시간 만료' : '연결 끊김', String(code) === '1000' || ai.handoverPending);
  }
  // planned hand-over after goAway: wait for a quiet moment (or the deadline), then swap sockets
  setInterval(() => {
    if (!ai.on || !ai.handoverPending || !live.ready) return;
    const leftMs = live.goAwayLeft * 1000 - (performance.now() - live.goAwayAt);
    const quiet = !live.speaking && !live.userActive && live.serverDone;
    if (quiet || leftMs < 3000) {
      ai.handoverPending = false; ai.reconnecting = true;
      logEv('새 연결로 넘김', live.resumeHandle ? '세션 이어붙이기' : '새 세션 + 대화 요약');
      const h = live.resumeHandle; go(true, h ? { resume: h } : { recap: recap() });
    }
  }, 250);
  function start() {
    ai.on = true; ai.heard = false; ai.retry = 0; ai.reconnecting = false; ai.everWorked = false; history.length = 0;
    bubbles.clear(); $('chatLog').textContent = ''; ctl.reset();
    host.beforeStart(); host.aiActive(true);
    $('aiSetup').classList.add('hidden'); $('aiTalk').classList.remove('hidden');
    host.toast('AI와 대화를 시작합니다');
    logEv('대화 시작');
    go();
  }
  function stop() {
    const was = ai.on; ai.on = false; clearTimeout(reTimer); ai.reconnecting = false; ai.handoverPending = false;
    live.close(true); live.state = 'closed'; wakeOff(); ctl.reset(); host.aiActive(false);
    $('aiSetup').classList.remove('hidden'); $('aiTalk').classList.add('hidden');
    onState('closed');
    if (was) { host.toast('AI 대화를 종료했습니다.'); logEv('대화 종료'); }
  }
  function micPress() {
    if (!ai.on) return connect();
    if (!live.ready) { if (!/connecting|reconnecting/.test(live.state) || !ai.reconnecting) { ai.retry = 0; scheduleReconnect('수동 재연결', true); } return; }
    live.mute(!live.muted); host.toast(live.muted ? '마이크를 껐습니다.' : '마이크를 켰습니다.');
  }
  function sendText() {
    const v = $('aiText').value.trim(); if (!v || !ai.on) return;
    if (!live.ready) return host.toast('아직 연결되지 않았습니다.');
    $('aiText').value = ''; onInterrupt(live.speaking); live.text(v);
  }

  // ---------------------------------------------------------------- wiring
  $('aiKey').value = store.get('aiKey', '');
  $('aiConnect').onclick = connect;
  $('aiKey').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  $('aiMic').onclick = micPress;
  $('aiSend').onclick = sendText;
  $('aiText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) sendText(); });
  $('aiStop').onclick = stop;
  $('aiCtlReset').onclick = () => { ctl.reset(); host.toast('표정과 자세를 원래대로 돌렸습니다.'); };
  $('aiVoice').value = store.get('liveVoice', 'Kore');
  $('aiVoice').onchange = e => { store.set('liveVoice', e.target.value); if (ai.on) { host.toast('목소리를 바꿔 다시 연결합니다.'); go(); } };
  const sensShow = () => { $('aiSensV').textContent = (+$('aiSens').value).toFixed(3); };
  $('aiSens').value = store.get('liveSens', '0.020'); sensShow();
  $('aiSens').oninput = () => { live.threshold = +$('aiSens').value; store.set('liveSens', $('aiSens').value); sensShow(); };
  $('aiModel').onchange = e => { ai.model = e.target.value; store.set('liveModel', ai.model === LIVE_DEFAULT ? '' : ai.model); store.set('liveProfile', '0'); if (ai.on) { host.toast('모델을 바꿔 다시 연결합니다.'); go(); } };
  $('aiReset').onclick = () => { if (!ai.on) return; bubbles.clear(); history.length = 0; $('chatLog').textContent = ''; ctl.reset(); live.resumeHandle = null; live.greeted = false; ai.retry = 0; host.toast('대화를 새로 시작합니다.'); logEv('대화 새로 시작'); go(); };
  // network / visibility recovery (1-2)
  addEventListener('online', () => { logEv('온라인 복귀'); if (ai.on && !live.ready && !(live.ws && live.ws.readyState <= 1)) { ai.retry = 0; scheduleReconnect('네트워크 복귀', true); } });
  addEventListener('offline', () => { logEv('오프라인'); if (ai.on) live.emit('offline'); });
  document.addEventListener('visibilitychange', () => {
    if (!ai.on) return;
    if (document.hidden) { logEv('화면 숨김', '마이크 일시 정지'); if (live.ready && !live.muted) live.mute(true, true); return; }
    logEv('화면 복귀');
    if (live.ctx && live.ctx.state !== 'running') live.ctx.resume().catch(() => { });
    wakeOn();
    if (live.autoMuted) live.mute(false);
    if (!live.ready && !/connecting|reconnecting/.test(live.state)) { ai.retry = 0; scheduleReconnect('화면 복귀', true); }
    else if (!live.ready && ai.reconnecting) { ai.retry = 0; scheduleReconnect('화면 복귀', true); }
  });
  // iOS / Android may suspend audio on interruptions (calls, other apps)
  const unlock = () => { if (ai.on && live.ctx && live.ctx.state !== 'running') live.ctx.resume().catch(() => { }); };
  addEventListener('pointerdown', unlock, { passive: true });
  $('aiLogCopy').onclick = () => { navigator.clipboard?.writeText(connLog.map(e => `${e.date} ${e.t}  ${e.ev}  ${e.detail}`).join('\n')).then(() => host.toast('연결 기록을 복사했습니다.')).catch(() => host.toast('복사할 수 없습니다.')); };
  $('aiLogClear').onclick = () => { connLog.length = 0; store.set(LOG_KEY, '[]'); renderLog(); };
  renderLog();
  addEventListener('pagehide', () => { if (ai.on) live.close(true); });

  return { ai, live, connect, stop, micPress, logEv, connLog, liveClosed, scheduleReconnect, get on() { return ai.on; }, get hasKey() { return !!(store.get('aiKey', '') || $('aiKey').value.trim()); } };
}
