// ============================================================================
//  Automatic emotion analysis
//  • RuleEmotionAnalyzer: offline keyword / punctuation / emoji rules (KO/EN/JA)
//  • AIEmotionAnalyzer:   optional — POSTs to your own endpoint (no keys in client)
//  Output per sentence: { emotion, intensity, gestures:[...], emphasis:[words] }
// ============================================================================
const LEX = {
  happy: ['반가', '기뻐', '기쁘', '행복', '좋아', '좋은', '좋네', '감사', '고마', '최고', '사랑', '축하', '즐거', '신나', '다행', '멋지', '훌륭',
    'glad', 'happy', 'great', 'love', 'thank', 'wonderful', 'awesome', 'nice to meet', 'excited', 'congrat', 'delight', 'pleased',
    '嬉しい', 'うれしい', '楽しい', 'ありがとう', '幸せ', '素晴らしい', 'よろしく', '大好き', 'おめでとう'],
  laugh: ['ㅋㅋ', 'ㅎㅎ', '하하', '히히', '웃기', '재밌', '재미있', 'haha', 'lol', 'funny', 'hilarious', '笑', 'ははは', '面白い', 'w w'],
  sad: ['슬프', '슬퍼', '슬픈', '우울', '눈물', '아프', '힘들', '외로', '그리워', '보고 싶', '미안', '안타깝', '속상', '실망', '죄송',
    'sad', 'sorry', 'miss you', 'cry', 'lonely', 'unfortunately', 'depress', 'hurt', 'disappoint', 'grief',
    '悲しい', '寂しい', '辛い', 'つらい', '残念', 'ごめん', '泣'],
  angry: ['화나', '화가', '짜증', '열받', '분노', '어이없', '용서', '그만해', '싫어', '나빠', 'angry', 'furious', 'annoy', 'hate', 'stop it', 'unacceptable', 'mad',
    '怒', 'ムカつく', 'むかつく', 'ふざけるな', '許さない', 'いい加減'],
  surprised: ['놀라', '놀랍', '대박', '세상에', '진짜?', '정말?', '헐', '와!', '우와', '어머', '깜짝', 'wow', 'surpris', 'amazing', 'unbelievable', 'no way', 'really?', 'oh my',
    'びっくり', '驚', 'まさか', 'すごい', '本当に？', 'えっ'],
  fear: ['무서', '두려', '겁나', '불안', '걱정', '떨려', '위험', '공포', 'scared', 'afraid', 'fear', 'terrif', 'anxious', 'worried', 'nervous', 'danger',
    '怖', 'こわい', '不安', '心配', '危ない'],
  disgust: ['역겨', '더러', '징그', '토할', '혐오', '끔찍', '구역질', 'disgust', 'gross', 'yuck', 'nasty', 'eww', '気持ち悪い', 'キモい', '汚い'],
  embarrassed: ['당황', '부끄', '창피', '민망', '쑥스', '어쩌지', '어떡해', 'embarrass', 'awkward', 'oops', 'shy', '恥ずかし', 'やばい', 'あせ'],
  doubt: ['글쎄', '과연', '의심', '수상', '설마', '그럴까', '정말일까', '믿기 어', 'hmm', 'doubt', 'suspicious', 'really', 'not sure', 'i wonder', 'questionable', '本当かな', '怪しい', 'どうかな'],
  thinking: ['생각해', '고민', '음…', '음...', '흠', '글쎄요', '어디 보자', '검토', '살펴', 'let me think', 'think', 'consider', 'perhaps', 'maybe', 'well...', '考え', 'うーん', 'えーと', 'かな'],
  confident: ['확신', '자신', '물론', '당연', '반드시', '틀림없', '걱정 마', '할 수 있', '문제없', 'of course', 'definitely', 'certainly', 'confident', 'trust me', 'no problem', 'i can',
    'もちろん', '絶対', '任せて', '大丈夫'],
};
const EMOJI = { '😀': 'happy', '😊': 'smile', '🙂': 'smile', '😂': 'laugh', '🤣': 'laugh', '😢': 'sad', '😭': 'sad', '😠': 'angry', '😡': 'angry', '😮': 'surprised', '😲': 'surprised', '😱': 'fear', '😨': 'fear', '🤢': 'disgust', '😳': 'embarrassed', '🤨': 'doubt', '🤔': 'thinking', '😎': 'confident', '😉': 'wink', '😐': 'blank' };
const INTENS = ['정말', '너무', '진짜', '완전', '엄청', '매우', '아주', 'so ', 'very', 'really', 'extremely', 'totally', 'とても', '本当に', 'すごく', '超'];
const SOFT = ['조금', '약간', '살짝', '좀', 'a bit', 'slightly', 'a little', 'ちょっと', '少し'];

export class RuleEmotionAnalyzer {
  analyze(sentence) {
    const s = sentence.toLowerCase();
    const score = {};
    for (const [emo, words] of Object.entries(LEX)) for (const w of words) if (s.includes(w.toLowerCase())) score[emo] = (score[emo] || 0) + 1 + w.length * 0.05;
    for (const [e, emo] of Object.entries(EMOJI)) if (sentence.includes(e)) score[emo] = (score[emo] || 0) + 2;
    const excl = (sentence.match(/[!！]/g) || []).length, ques = (sentence.match(/[?？]/g) || []).length, dots = /(\.\.\.|…)/.test(sentence);
    if (excl && (score.surprised || /정말|진짜|really|本当/.test(s))) score.surprised = (score.surprised || 0) + 0.5;
    if (ques && !Object.keys(score).length) score.thinking = 0.6;
    if (dots && !Object.keys(score).length) score.thinking = 0.5;
    // "만나서 반가워요" etc. → warm smile rather than big happiness
    if (score.happy && !excl && score.happy < 2.2) { score.smile = score.happy; delete score.happy; }
    let best = 'neutral', bv = 0;
    for (const [k, v] of Object.entries(score)) if (v > bv) { best = k; bv = v; }
    let intensity = best === 'neutral' ? 0 : Math.min(1, 0.55 + 0.15 * bv + 0.12 * excl);
    if (INTENS.some(w => s.includes(w))) intensity = Math.min(1, intensity + 0.15);
    if (SOFT.some(w => s.includes(w))) intensity *= 0.7;
    const gestures = [];
    if (best === 'smile' || best === 'happy') gestures.push('nod');
    if (best === 'sad') gestures.push('slow');
    if (best === 'thinking' || best === 'doubt') gestures.push('tilt', 'lookAway');
    if (best === 'surprised') gestures.push('back');
    if (ques) gestures.push('tilt');
    const emphasis = (sentence.match(/[\p{L}\p{N}]+/gu) || []).filter(w => INTENS.some(i => w.toLowerCase().includes(i.trim())));
    return { emotion: best, intensity, gestures, emphasis, scores: score };
  }
}

export class AIEmotionAnalyzer {
  // endpoint: your server. Request {sentence, context}; response {emotion, intensity, gestures?, emphasis?}
  constructor(endpoint, fallback) { this.endpoint = endpoint; this.fallback = fallback || new RuleEmotionAnalyzer(); }
  async analyzeAsync(sentence, context) {
    try {
      const r = await fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sentence, context }) });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      return { ...this.fallback.analyze(sentence), ...j, source: 'ai' };
    } catch (e) { return { ...this.fallback.analyze(sentence), source: 'rules (AI 실패: ' + e.message + ')' }; }
  }
}
