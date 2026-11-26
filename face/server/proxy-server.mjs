// ============================================================================
//  Example proxy server for the optional "accurate" modes (Node 18+).
//  Keeps API keys on the server — the browser only talks to this proxy.
//
//    POST /tts      {text, lang, voice?, rate?, pitch?}
//                   → {audio:<base64 mp3>, mime, visemes:[{audioOffset, visemeId}]}
//                   uses Azure Speech (viseme events give exact mouth timing)
//    POST /emotion  {sentence, context}
//                   → {emotion, intensity, gestures, emphasis}
//                   uses the Anthropic Messages API to classify the sentence
//
//  Setup:
//    npm i microsoft-cognitiveservices-speech-sdk
//    AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=koreacentral ANTHROPIC_API_KEY=... node server/proxy-server.mjs
//  Then in the studio: 모드 = "외부 TTS 서버" → http://localhost:8787/tts
//                      자동 감정 → 분석기 "AI 엔드포인트" → http://localhost:8787/emotion
//
//  NOTE: provided as an integration template. It was not run against the
//  live Azure / Anthropic services while building this package (no keys).
// ============================================================================
import http from 'node:http';

const PORT = process.env.PORT || 8787;
const VOICES = { ko: 'ko-KR-SunHiNeural', en: 'en-US-JennyNeural', ja: 'ja-JP-NanamiNeural' };
const EMOTIONS = ['neutral', 'smile', 'happy', 'laugh', 'sad', 'angry', 'surprised', 'fear', 'disgust', 'embarrassed', 'doubt', 'thinking', 'confident', 'blank', 'wink'];

async function azureTTS({ text, lang = 'ko', voice, rate = 1, pitch = 1 }) {
  const sdk = await import('microsoft-cognitiveservices-speech-sdk');
  const cfg = sdk.SpeechConfig.fromSubscription(process.env.AZURE_SPEECH_KEY, process.env.AZURE_SPEECH_REGION);
  cfg.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  const synth = new sdk.SpeechSynthesizer(cfg, null);
  const visemes = [];
  synth.visemeReceived = (_, e) => visemes.push({ audioOffset: e.audioOffset / 10000, visemeId: e.visemeId }); // 100ns → ms
  const esc = s => s.replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const v = voice || VOICES[lang] || VOICES.en;
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${v.slice(0, 5)}"><voice name="${v}"><prosody rate="${Math.round((rate - 1) * 100)}%" pitch="${Math.round((pitch - 1) * 50)}%">${esc(text)}</prosody></voice></speak>`;
  const result = await new Promise((res, rej) => synth.speakSsmlAsync(ssml, r => { synth.close(); res(r); }, e => { synth.close(); rej(new Error(e)); }));
  if (!result.audioData) throw new Error('Azure TTS failed: ' + result.errorDetails);
  return { audio: Buffer.from(result.audioData).toString('base64'), mime: 'audio/mpeg', visemes };
}

async function claudeEmotion({ sentence, context }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 200,
      system: `You label the emotion a talking character should show while saying a sentence. Reply with JSON only: {"emotion": one of ${JSON.stringify(EMOTIONS)}, "intensity": 0..1, "gestures": subset of ["nod","tilt","lookAway","back","slow"], "emphasis": [words to stress]}`,
      messages: [{ role: 'user', content: `Context: ${context || ''}\nSentence: ${sentence}` }],
    }),
  });
  const j = await r.json();
  const txt = j.content?.[0]?.text || '{}';
  return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  let body = ''; for await (const c of req) body += c;
  try {
    const data = JSON.parse(body || '{}');
    const out = req.url.startsWith('/tts') ? await azureTTS(data) : req.url.startsWith('/emotion') ? await claudeEmotion(data) : null;
    if (!out) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
}).listen(PORT, () => console.log(`proxy on http://localhost:${PORT}  (/tts, /emotion)`));
