const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const PREVIEW_W = 270;
const PREVIEW_H = 480;
let FINAL_W = 1080;
let FINAL_H = 1920;
canvas.width = PREVIEW_W;
canvas.height = PREVIEW_H;

const motions = ['zoom', 'panup', 'pandown'];

const state = {
  captions: [],
  scenes: [],
  images: [],
  audioDuration: 60,
  audioFile: null,
  audioFileName: '',
  audioProfile: null,
  audioAnalysisReady: false,
  selectedCaptionId: null,
  playing: false,
  playStartMs: 0,
  playStartTime: 0,
  raf: null,
  chunks: [],
  mediaRecorder: null,
  rendering: false,
  thumbnail: { image: null, imageObj: null, prompt: '', text: '', style: 'photo-person-bg' },
};

function log(msg) {
  const el = $('log');
  if (el) el.textContent = msg;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function parseTime(v) {
  if (!v) return 0;
  const txt = String(v).trim();
  if (txt.includes(':')) {
    const [m, s] = txt.split(':').map(Number);
    return (m || 0) * 60 + (s || 0);
  }
  return Number(txt) || 0;
}

function speed() {
  return clamp(parseFloat($('speedInput')?.value || '1'), 0.5, 3);
}

function timelineTime() {
  const audio = $('audio');
  if (audio && !audio.paused && audio.currentTime > 0) return audio.currentTime;
  return parseFloat($('previewSeek')?.value || '0') || 0;
}

function normalizeSpacing(text) {
  return String(text || '')
    .replace(/[\t\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?…。！？])/g, '$1')
    .trim();
}

function plainKey(text) {
  return String(text || '')
    .replace(/[\s\n.,!?。、！？·\-~…]/g, '')
    .toLowerCase();
}

function stripLabels(text) {
  const banned = /(후킹|문제\s*제기|문제제기|공감|전개|해결|마무리|인트로|아웃트로)/gi;
  return String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/^\s*\d+\s*[.)-]?\s*/g, '')
      .replace(/^\s*[-•*]\s*/g, '')
      .replace(banned, '')
      .replace(/["“”‘’`]/g, '')
      .trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeTailRepeat(text) {
  let clean = normalizeSpacing(text);
  if (!clean) return '';

  // 같은 문장 연속 반복 제거: "찾아오니까요. 찾아오니까요."
  for (let i = 0; i < 4; i++) {
    const next = clean.replace(/(.{2,}?)([.!?。！？]?)(\s+\1\2)+$/u, '$1$2').trim();
    if (next === clean) break;
    clean = next;
  }

  // 같은 단어/구절 반복 제거
  clean = clean.replace(/([^\s]{2,})(\s+\1)+/gu, '$1');

  // 앞뒤가 같은 문자열이면 앞쪽만 남김
  const key = plainKey(clean);
  if (key.length >= 6 && key.length % 2 === 0) {
    const half = key.length / 2;
    if (key.slice(0, half) === key.slice(half)) {
      let seen = 0;
      let cut = clean.length;
      for (let i = 0; i < clean.length; i++) {
        if (!/[\s\n.,!?。、！？·\-~…]/.test(clean[i])) seen++;
        if (seen === half) { cut = i + 1; break; }
      }
      clean = clean.slice(0, cut).trim();
    }
  }

  return clean.trim();
}

function getMaxChars() {
  return clamp(parseInt($('captionMaxChars')?.value || '14', 10), 8, 24);
}

function getMaxLines() {
  return clamp(parseInt($('captionMaxLines')?.value || '2', 10), 1, 3);
}

function getChunkLimit() {
  return getMaxChars() * getMaxLines();
}

function getAutoCaptionLimit(limit = getChunkLimit()) {
  // 모든 대본 공통 싱크 기준: 화면 표시 한계보다 조금 짧게 잘라 앞부분 밀림을 막는다.
  // 사용자가 한 줄/줄 수를 바꿔도 22~30자 사이에서 안전하게 자동 분할한다.
  const uiLimit = Number(limit) || getChunkLimit();
  return clamp(Math.min(uiLimit, 28), 18, 30);
}

function findNaturalCaptionCut(text, limit) {
  const clean = String(text || '').trim();
  if (clean.length <= limit) return clean.length;

  const searchEnd = Math.min(clean.length, limit + 8);
  const searchStart = Math.max(8, Math.floor(limit * 0.45));
  const candidates = [
    '. ', '? ', '! ', '。', '！', '？', ', ', '，', '、',
    '습니다 ', '입니다 ', '합니다 ', '됩니다 ', '였나요 ', '나요 ', '까요 ', '요 ', '죠 ',
    '지만 ', '는데 ', '니까 ', '그리고 ', '그다음 ', '먼저 ', '그래서 ',
    '보다 ', '으로 ', '에서 ', '에게 ', '한테 ', '하고 ', '하며 ', '면서 ',
    ' 다 ', ' 고 ', ' 은 ', ' 는 ', ' 을 ', ' 를 ', ' 에 ', ' 가 '
  ];

  let cut = -1;
  for (const token of candidates) {
    const idx = clean.lastIndexOf(token, searchEnd);
    if (idx >= searchStart) {
      cut = idx + token.length;
      break;
    }
  }

  if (cut < searchStart) {
    const space = clean.lastIndexOf(' ', limit);
    cut = space >= searchStart ? space : limit;
  }
  return clamp(cut, searchStart, clean.length);
}

function splitBlockByLength(block, limit = getChunkLimit()) {
  let remain = normalizeSpacing(removeTailRepeat(block));
  const out = [];
  if (!remain) return out;

  const autoLimit = getAutoCaptionLimit(limit);
  while (remain.length > autoLimit) {
    const cut = findNaturalCaptionCut(remain, autoLimit);
    const part = removeTailRepeat(remain.slice(0, cut));
    if (part) out.push(part);
    remain = remain.slice(cut).trim();
  }

  if (remain) out.push(removeTailRepeat(remain));
  return out.filter((p, i, arr) => p && (!i || plainKey(p) !== plainKey(arr[i - 1])));
}

function splitScriptToCaptions(raw) {
  const cleaned = stripLabels(raw);
  if (!cleaned) return [];

  let blocks = cleaned.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    const lines = cleaned.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 1) blocks = lines;
  }
  if (blocks.length <= 1) {
    const sentences = cleaned.match(/[^.!?。！？]+[.!?。！？]?/g);
    if (sentences && sentences.length > 1) blocks = sentences.map((s) => s.trim()).filter(Boolean);
  }
  if (!blocks.length) blocks = [cleaned];

  const result = [];
  for (const block of blocks) {
    const chunks = splitBlockByLength(block, getChunkLimit());
    for (const chunk of chunks) {
      const fixed = removeTailRepeat(chunk);
      if (!fixed) continue;
      if (result.length && plainKey(result[result.length - 1]) === plainKey(fixed)) continue;
      result.push(fixed);
    }
  }
  return result;
}

function displayCaption(text) {
  const clean = removeTailRepeat(text);
  // 싱크용 점(...) 자막은 화면에 표시하지 않음
  if (!clean || /^[.\u2026\s]+$/.test(clean)) return '';

  const max = getMaxChars();
  const userLines = getMaxLines();

  // 잘림 방지: 사용자가 2줄로 둬도 긴 문장은 자동으로 3~5줄까지 허용
  const dynamicLines = clean.length > max * userLines
    ? Math.min(5, Math.max(userLines, Math.ceil(clean.length / max)))
    : userLines;

  const lines = [];
  let remain = clean;
  while (remain && lines.length < dynamicLines) {
    if (remain.length <= max) {
      lines.push(remain);
      remain = '';
      break;
    }

    let cut = remain.lastIndexOf(' ', max);
    if (cut < Math.floor(max * 0.45)) cut = max;

    const part = remain.slice(0, cut).trim();
    if (part) lines.push(part);
    remain = remain.slice(cut).trim();
  }

  // 그래도 남으면 글자를 버리지 않고 마지막 줄에 붙임.
  // 실제 화면 넘침은 drawCaption()에서 자동 글자축소로 처리.
  if (remain && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${remain}`.trim();
  }

  return lines.filter(Boolean).join('\n');
}

function collectCaptionStyle() {
  return {
    font: $('captionFont')?.value || 'gothic',
    weight: $('captionFontWeight')?.value || '900',
    textColor: $('captionTextColor')?.value || '#ffffff',
    strokeColor: $('captionStrokeColor')?.value || '#b33636',
    bgColor: $('captionBgColor')?.value || '#000000',
    boxOpacity: $('captionBoxOpacity')?.value || '0',
    fontSize: $('fontSize')?.value || '58',
    pos: $('captionPos')?.value || 'lower',
    x: $('captionX')?.value || '0',
    y: $('captionY')?.value || '62',
  };
}

function fontFamily(kind) {
  const map = {
    gothic: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    bold: 'Arial Black, system-ui, sans-serif',
    myeongjo: 'Georgia, serif',
    hand: 'Comic Sans MS, cursive',
    youtube: 'Impact, Arial Black, sans-serif',
  };
  return map[kind] || map.gothic;
}

function getCaptionAtTime(t = timelineTime()) {
  const time = Number(t) || 0;
  // 말하기 전/빈 구간에서 마지막 자막이 먼저 뜨던 문제 방지
  return state.captions.find((c) => time >= c.start && time < c.end) || null;
}

function getSceneAtTime(t = timelineTime()) {
  const time = Number(t) || 0;
  // 말하기 전/빈 구간에서 마지막 장면/자막이 튀어나오지 않게 fallback 제거
  return state.scenes.find((s) => time >= s.start && time < s.end) || null;
}

function getSelectedCaption() {
  return state.captions.find((c) => c.id === state.selectedCaptionId) || getCaptionAtTime() || null;
}

function syncPreviewToCaption(cap, keepIfInside = true) {
  if (!cap) return timelineTime();
  let t = timelineTime();
  const inside = t >= cap.start && t < cap.end;
  if (!inside || !keepIfInside) {
    t = Math.min(Math.max(0, cap.start + 0.01), Math.max(0, state.audioDuration || cap.end || 0));
    const seek = $('previewSeek');
    if (seek) seek.value = t.toFixed(2);
    const audio = $('audio');
    if (audio && audio.src) audio.currentTime = t;
  }
  updateSeekUI(t);
  drawFrame(t);
  return t;
}

function setActiveCaption(id, movePreview = true) {
  state.selectedCaptionId = id || null;
  updateLiveCaptionEditor();
  const cap = getSelectedCaption();
  if (movePreview && cap) syncPreviewToCaption(cap);
  markActiveCaptionCard();
}

function markActiveCaptionCard() {
  document.querySelectorAll('.sceneCard').forEach((card) => card.classList.remove('activeSceneCard'));
  if (!state.selectedCaptionId) return;
  const tx = document.querySelector(`textarea[data-caption-id="${state.selectedCaptionId}"]`);
  const card = tx?.closest?.('.sceneCard');
  if (card) card.classList.add('activeSceneCard');
}

function rebuildScenes() {
  const oldScenes = state.scenes || [];
  state.scenes = state.captions.map((cap, idx) => {
    const old = oldScenes[idx] || {};
    return {
      id: old.id || uid(),
      title: `장면 ${idx + 1}`,
      captionIds: [cap.id],
      start: cap.start,
      end: cap.end,
      image: old.image || state.images[idx] || null,
      imageObj: old.imageObj || null,
      motion: old.motion || motions[idx % motions.length],
      fullText: cap.text,
      prompt: cap.text,
      topFixedText: old.topFixedText !== false,
    };
  });
  cacheSceneImages();
}


function estimateCaptionReadWeight(text, minDur = 1.5) {
  const raw = String(text || '');
  const keyLen = Math.max(1, plainKey(raw).length);
  const koreanLen = (raw.match(/[가-힣]/g) || []).length;
  const englishWords = (raw.match(/[A-Za-z]+/g) || []).length;
  const numberLen = (raw.match(/[0-9]/g) || []).length;
  const commaPause = (raw.match(/[,，、]/g) || []).length * 0.22;
  const sentencePause = (raw.match(/[.!?。！？…]/g) || []).length * 0.34;
  const linePause = (raw.match(/\n/g) || []).length * 0.16;
  const spacePause = Math.min(0.5, (raw.match(/\s/g) || []).length * 0.035);
  const shortBoost = keyLen <= 8 ? 0.42 : keyLen <= 14 ? 0.24 : 0;
  const longPenalty = keyLen >= 26 ? 0.28 : 0;

  // 한국어 TTS/낭독 평균에 맞춘 상대 가중치. 실제 초로 확정하지 않고 전체 음성 길이에 다시 정규화한다.
  const weight = koreanLen * 0.118 + englishWords * 0.30 + numberLen * 0.055 + commaPause + sentencePause + linePause + spacePause + shortBoost + longPenalty + 0.48;
  return Math.max(minDur, weight);
}

function normalizeDurationsToTotal(durations, total) {
  const sum = durations.reduce((a, b) => a + b, 0) || 1;
  return durations.map((dur) => (dur / sum) * total);
}

function distributeCaptionDurations(parts, totalDuration, minDur = 1.5) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const count = Math.max(1, parts.length || 1);
  const avg = total / count;

  // V43: 모든 대본 공통 싱크 엔진.
  // 고정 초수/균등분배가 아니라 문장별 읽기 가중치를 계산한 뒤 음성 길이에 맞춰 전체를 재정규화한다.
  const safeMin = Math.min(Math.max(0.55, avg * 0.42), minDur);
  const safeMax = Math.max(safeMin + 0.2, avg * 2.15);
  const weights = (parts || []).map((text) => estimateCaptionReadWeight(text, safeMin));
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

  let durations = weights.map((w) => {
    const weightedDur = (w / weightSum) * total;
    const blended = avg * 0.18 + weightedDur * 0.82;
    return clamp(blended, safeMin, safeMax);
  });

  // 앞부분 누적 오차가 뒤로 밀리지 않도록 2회 보정하고, 마지막은 buildCaptionTimeline에서 음성 끝으로 강제 고정한다.
  durations = normalizeDurationsToTotal(durations, total);
  durations = durations.map((dur) => clamp(dur, safeMin, safeMax));
  durations = normalizeDurationsToTotal(durations, total);
  return durations;
}

function getSpeechSegments(profile, totalDuration) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const segments = (profile?.segments || [])
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end))
    .map((seg) => ({
      start: clamp(Number(seg.start), 0, total),
      end: clamp(Number(seg.end), 0, total)
    }))
    .filter((seg) => seg.end - seg.start >= 0.10)
    .sort((a, b) => a.start - b.start);

  if (!segments.length) return [];

  const merged = [];
  segments.forEach((seg) => {
    const last = merged[merged.length - 1];
    if (last && seg.start - last.end <= 0.20) last.end = Math.max(last.end, seg.end);
    else merged.push({ ...seg });
  });

  const speechTotal = merged.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0);
  if (speechTotal < total * 0.28 || speechTotal > total * 0.97) return [];
  return merged;
}

function findSilenceGapAt(time, segments, totalDuration) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const t = clamp(Number(time) || 0, 0, total);
  if (!segments.length) return null;

  if (t < segments[0].start && segments[0].start >= 0.22) {
    return { start: 0, end: segments[0].start, nextSpeechStart: segments[0].start };
  }

  for (let i = 0; i < segments.length - 1; i++) {
    const gapStart = segments[i].end;
    const gapEnd = segments[i + 1].start;
    if (gapEnd - gapStart < 0.22) continue;
    if (t >= gapStart && t < gapEnd) {
      return { start: gapStart, end: gapEnd, nextSpeechStart: gapEnd };
    }
  }

  const last = segments[segments.length - 1];
  if (t >= last.end && total - last.end >= 0.22) {
    return { start: last.end, end: total, nextSpeechStart: total };
  }

  return null;
}

function moveTransitionOutOfSilence(time, segments, totalDuration) {
  const gap = findSilenceGapAt(time, segments, totalDuration);
  if (!gap) return time;
  return clamp((gap.nextSpeechStart || time) + 0.02, 0, totalDuration);
}

function buildStableCaptionTimeline(parts, totalDuration, style) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const minDur = clamp(parseFloat($('captionMinSeconds')?.value || '1.5'), 1.0, 4);
  const cleanParts = (parts || []).map((v) => removeTailRepeat(v)).filter(Boolean);
  const captions = [];
  if (!cleanParts.length) return captions;

  const styleBase = style || collectCaptionStyle();
  const avg = total / Math.max(1, cleanParts.length);
  const leadDelay = total > 3 ? Math.min(0.18, Math.max(0.04, avg * 0.04)) : 0;
  const activeTotal = Math.max(0.5, total - leadDelay);
  const durations = distributeCaptionDurations(cleanParts, activeTotal, minDur);

  let t = leadDelay;
  cleanParts.forEach((text, idx) => {
    const isLast = idx === cleanParts.length - 1;
    const start = Number(t.toFixed(2));
    const next = isLast ? total : Math.min(total, t + durations[idx]);
    const end = Number(Math.max(start + 0.18, next).toFixed(2));
    captions.push({ id: uid(), start, end, text, captionStyle: { ...styleBase } });
    t = next;
  });

  if (captions.length) captions[captions.length - 1].end = Number(total.toFixed(2));
  return captions;
}

function applySilenceHoldToTimeline(baseCaptions, audioProfile, totalDuration) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const captions = (baseCaptions || []).map((cap) => ({ ...cap, captionStyle: { ...(cap.captionStyle || {}) } }));
  if (captions.length <= 1) return captions;

  const segments = getSpeechSegments(audioProfile, total);
  if (!segments.length) return captions;

  const firstVoiceAt = segments[0]?.start || 0;
  captions[0].start = firstVoiceAt > 0.25 ? Number(Math.max(0, firstVoiceAt - 0.06).toFixed(2)) : 0;

  const baseTransitions = [];
  for (let i = 0; i < captions.length - 1; i++) baseTransitions.push(captions[i].end);

  const adjusted = baseTransitions.map((time) => moveTransitionOutOfSilence(time, segments, total));
  const minGap = 0.28;

  for (let i = 0; i < adjusted.length; i++) {
    const prevLimit = i === 0 ? captions[0].start + minGap : adjusted[i - 1] + minGap;
    const nextLimit = i === adjusted.length - 1 ? total - minGap : baseTransitions[i + 1] - minGap;
    if (adjusted[i] < prevLimit || adjusted[i] > nextLimit) {
      adjusted[i] = clamp(baseTransitions[i], prevLimit, Math.max(prevLimit, nextLimit));
    }
  }

  for (let i = 0; i < captions.length - 1; i++) {
    const cut = Number(clamp(adjusted[i], captions[i].start + 0.18, total).toFixed(2));
    captions[i].end = cut;
    captions[i + 1].start = cut;
  }
  captions[captions.length - 1].end = Number(total.toFixed(2));

  for (let i = 1; i < captions.length; i++) {
    if (captions[i].start < captions[i - 1].end) captions[i].start = captions[i - 1].end;
    if (captions[i].end <= captions[i].start) captions[i].end = Math.min(total, captions[i].start + 0.18);
  }
  captions[captions.length - 1].end = Number(total.toFixed(2));

  return captions;
}

function buildCaptionTimeline(parts, totalDuration, style, audioProfile = null) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const base = buildStableCaptionTimeline(parts, total, style);
  return applySilenceHoldToTimeline(base, audioProfile, total);
}

async function analyzeAudioSilenceProfile(file) {
  if (!file || !(window.AudioContext || window.webkitAudioContext)) return null;
  let audioCtx = null;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
    const buf = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(buf.slice(0));
    const total = audioBuffer.duration || 0;
    if (!total || total < 0.5) return null;

    const sr = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const channelCount = Math.max(1, audioBuffer.numberOfChannels || 1);
    const win = Math.max(512, Math.floor(sr * 0.030));
    const rms = [];

    for (let i = 0; i < length; i += win) {
      let sum = 0;
      let count = 0;
      const end = Math.min(length, i + win);
      for (let ch = 0; ch < channelCount; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let j = i; j < end; j++) {
          sum += data[j] * data[j];
          count++;
        }
      }
      rms.push(Math.sqrt(sum / Math.max(1, count)));
    }

    if (!rms.length) return null;

    const sorted = rms.slice().sort((a, b) => a - b);
    const p20 = sorted[Math.floor(sorted.length * 0.20)] || 0.001;
    const p55 = sorted[Math.floor(sorted.length * 0.55)] || p20;
    const p92 = sorted[Math.floor(sorted.length * 0.92)] || p55;
    const threshold = Math.max(0.0035, p20 * 2.6, p55 * 0.75, p92 * 0.055);

    const raw = [];
    let inVoice = false;
    let st = 0;

    for (let i = 0; i < rms.length; i++) {
      const t = i * win / sr;
      const voiced = rms[i] >= threshold;
      if (voiced && !inVoice) {
        inVoice = true;
        st = t;
      }
      if ((!voiced || i === rms.length - 1) && inVoice) {
        const en = Math.min(total, (i + 1) * win / sr);
        raw.push({ start: st, end: en });
        inVoice = false;
      }
    }

    const merged = [];
    raw.forEach((seg) => {
      if (seg.end - seg.start < 0.09) return;
      const last = merged[merged.length - 1];
      if (last && seg.start - last.end < 0.24) last.end = seg.end;
      else merged.push({ ...seg });
    });

    const segments = merged
      .map((seg) => ({
        start: Math.max(0, seg.start - 0.025),
        end: Math.min(total, seg.end + 0.045)
      }))
      .filter((seg) => seg.end - seg.start >= 0.12);

    const speechTotal = segments.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0);
    const firstVoiceAt = segments[0]?.start || 0;

    return { duration: total, firstVoiceAt, segments, threshold, speechTotal };
  } catch (err) {
    console.warn('audio silence analyze failed', err);
    return null;
  } finally {
    if (audioCtx?.close) audioCtx.close().catch(() => {});
  }
}


function setAudioAnalysisProgress(percent, label) {
  const box = $('audioAnalysisBox');
  const fill = $('audioAnalysisFill');
  const percentEl = $('audioAnalysisPercent');
  const status = $('audioAnalysisStatus');
  const p = clamp(Math.round(Number(percent) || 0), 0, 100);
  if (box) box.classList.add('active');
  if (fill) fill.style.width = `${p}%`;
  if (percentEl) percentEl.textContent = `${p}%`;
  if (status) status.textContent = label || `분석중 ${p}%`;
}

function markAudioAnalysisReady(ready, message = '') {
  state.audioAnalysisReady = !!ready;
  const box = $('audioAnalysisBox');
  const btn = $('btnTranscribe');
  if (box) box.classList.toggle('done', !!ready);
  if (btn) btn.textContent = ready ? '음성·자막 다시 분석하기' : '음성·자막 분석하기';
  if (message) log(message);
}

function getCaptionPartsFromEditors() {
  syncScriptEditors('right');
  const raw = $('generatedScript')?.value || $('rightScriptEditor')?.value || '';
  return splitScriptToCaptions(raw);
}

function findVoiceCutCandidates(segments, totalDuration) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const candidates = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const prev = segments[i];
    const next = segments[i + 1];
    const gap = next.start - prev.end;
    // 짧은 쉼도 전환 후보로 잡되, 다음 말 시작 시점으로 자막을 바꾼다.
    if (gap >= 0.08) candidates.push(clamp(next.start + 0.01, 0, total));
  }
  return candidates.filter((v, i, arr) => Number.isFinite(v) && v > 0.03 && v < total - 0.03 && (!i || Math.abs(v - arr[i - 1]) > 0.04));
}

function buildVoiceSegmentCaptionTimeline(parts, totalDuration, style, audioProfile) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const cleanParts = (parts || []).map((v) => removeTailRepeat(v)).filter(Boolean);
  const styleBase = style || collectCaptionStyle();
  if (!cleanParts.length) return [];

  const segments = getSpeechSegments(audioProfile, total);
  if (!segments.length || cleanParts.length === 1) {
    const base = buildStableCaptionTimeline(cleanParts, total, styleBase);
    if (segments[0]) base[0].start = Number(clamp(segments[0].start + 0.01, 0, total).toFixed(2));
    return base;
  }

  const base = buildStableCaptionTimeline(cleanParts, total, styleBase);
  const candidates = findVoiceCutCandidates(segments, total);
  const boundaries = [];
  const minGap = Math.max(0.18, Math.min(0.55, total / Math.max(1, cleanParts.length) * 0.20));

  for (let i = 0; i < cleanParts.length - 1; i++) {
    const target = base[i]?.end || ((i + 1) / cleanParts.length) * total;
    const prev = boundaries.length ? boundaries[boundaries.length - 1] : clamp(segments[0].start + 0.01, 0, total);
    const remaining = (cleanParts.length - 1) - i;
    const latest = total - minGap * remaining;
    const pool = candidates.filter((cut) => cut > prev + minGap && cut < latest);

    let chosen = null;
    if (pool.length) {
      // 자막이 말보다 먼저 넘어가는 문제를 막기 위해 target보다 약간 뒤의 말 시작점을 우선 선택한다.
      const future = pool.filter((cut) => cut >= target - 0.04);
      const list = future.length ? future : pool;
      chosen = list.reduce((best, cut) => Math.abs(cut - target) < Math.abs(best - target) ? cut : best, list[0]);
    } else {
      chosen = clamp(target, prev + minGap, latest);
      chosen = moveTransitionOutOfSilence(chosen, segments, total);
    }
    boundaries.push(Number(clamp(chosen, prev + minGap, latest).toFixed(2)));
  }

  const firstStart = Number(clamp((segments[0]?.start || 0) + 0.01, 0, total).toFixed(2));
  const captions = [];
  for (let i = 0; i < cleanParts.length; i++) {
    const start = i === 0 ? firstStart : boundaries[i - 1];
    const end = i === cleanParts.length - 1 ? total : boundaries[i];
    captions.push({
      id: uid(),
      start: Number(start.toFixed(2)),
      end: Number(Math.max(start + 0.18, end).toFixed(2)),
      text: cleanParts[i],
      captionStyle: { ...styleBase }
    });
  }
  captions[captions.length - 1].end = Number(total.toFixed(2));
  return captions;
}

function applyVoiceAnalysisCaptions(parts, totalDuration, style = collectCaptionStyle()) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const captions = buildVoiceSegmentCaptionTimeline(parts, total, style, state.audioProfile);
  state.captions = captions;
  state.audioDuration = total;
  rebuildScenes();
  if ($('generatedScript')) $('generatedScript').value = parts.join('\n\n');
  if ($('rightScriptEditor')) $('rightScriptEditor').value = parts.join('\n\n');
  if ($('ttsText')) $('ttsText').value = parts.join('\n');
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
  if (state.captions[0]) setActiveCaption(state.captions[0].id, false);
  return captions;
}

async function analyzeAudioAndCaptions() {
  const audio = $('audio');
  const file = state.audioFile;
  const parts = getCaptionPartsFromEditors();
  if (!parts.length) {
    log('먼저 대본을 넣거나 주제를 골라 대본을 생성하세요.');
    $('rightScriptEditor')?.focus();
    return false;
  }
  if (!file || !audio?.src) {
    log('먼저 음성파일을 넣으세요.');
    $('audioFile')?.click();
    return false;
  }

  finishPreview(true);
  setAudioAnalysisProgress(5, '음성 메타데이터 확인중...');
  await new Promise((resolve) => setTimeout(resolve, 60));

  const duration = Number(audio.duration || state.audioDuration || 0);
  if (!duration || duration < 0.5) {
    log('음성 길이를 아직 읽지 못했습니다. 파일을 다시 넣거나 잠시 뒤 다시 누르세요.');
    return false;
  }

  setAudioAnalysisProgress(25, '음성 파형 분석중...');
  await new Promise((resolve) => setTimeout(resolve, 80));
  state.audioProfile = await analyzeAudioSilenceProfile(file);

  setAudioAnalysisProgress(55, '무음구간 찾는중...');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const segments = getSpeechSegments(state.audioProfile, duration);

  setAudioAnalysisProgress(78, '자막 문장과 말소리 구간 맞추는중...');
  await new Promise((resolve) => setTimeout(resolve, 80));
  pushUndoState();
  applyVoiceAnalysisCaptions(parts, duration, collectCaptionStyle());

  setAudioAnalysisProgress(100, '분석 완료. 장면 시간이 음성 구간 기준으로 생성됐습니다.');
  markAudioAnalysisReady(true);
  const silenceCount = Math.max(0, segments.length - 1);
  log(`음성·자막 분석 완료: 음성 ${formatTime(duration)}, 자막 ${parts.length}개, 말소리 구간 ${segments.length || '기본'}개, 무음 후보 ${silenceCount}개. 장면은 자막 1개 = 음성구간 1개 기준으로 생성했습니다.`);
  return true;
}

function createCaptionsFromScript() {
  const parts = splitScriptToCaptions($('generatedScript')?.value || '');
  if (!parts.length) {
    log('대본이 없어 자막 생성을 건너뛰었습니다.');
    return;
  }

  finishPreview(true);
  state.captions = [];
  state.scenes = [];
  state.images = [];
  state.selectedCaptionId = null;

  const audio = $('audio');
  const audioDur = Number(audio?.duration || 0);
  const minDur = clamp(parseFloat($('captionMinSeconds')?.value || '1.5'), 1.0, 4);
  const total = audioDur > 1 ? audioDur : Math.max(20, parts.length * Math.max(2, minDur));
  const style = collectCaptionStyle();

  // V40 싱크 엔진: 글자수만 보지 않고 한글 길이, 영어/숫자, 쉼표, 마침표, 짧은 문장 보정값을 합산해
  // 음성 전체 길이에 다시 정규화한다. 이전 대본/장면은 여기서 완전히 끊어 싱크가 섞이지 않게 한다.
  state.captions = buildCaptionTimeline(parts, total, style, state.audioProfile);
  state.audioDuration = total;
  rebuildScenes();
  if ($('generatedScript')) $('generatedScript').value = parts.join('\n\n');
  if ($('ttsText')) $('ttsText').value = parts.join('\n');
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
  if (state.captions[0]) setActiveCaption(state.captions[0].id);
  syncScriptEditors('left');
  log(`V49 안정형+무음 HOLD 싱크 적용 완료: 음성 ${formatTime(total)}, 자막 ${parts.length}개`);
}

function renderThumbnailCard(box) {
  if (!box) return;
  const card = document.createElement('div');
  card.className = 'sceneCard compactSceneCard thumbnailAutoCard';

  const thumb = document.createElement('div');
  thumb.className = 'sceneThumb compactThumb thumbnailAutoThumb';
  if (state.thumbnail?.image) {
    const img = document.createElement('img');
    img.src = state.thumbnail.image;
    img.alt = '썸네일 미리보기';
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = '썸네일 없음<br>드래그/첨부';
  }
  const info = document.createElement('div');
  info.className = 'sceneInfo compactSceneInfo';

  const top = document.createElement('div');
  top.className = 'compactSceneTop thumbnailAutoTop';
  top.innerHTML = '<strong>썸네일 자동 만들기</strong><span>한글 문구 포함 프롬프트</span>';

  const mediaRow = document.createElement('div');
  mediaRow.className = 'compactMediaRow';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.className = 'sceneFileInputHidden';
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await setThumbnailFromFile(file);
    renderEditor();
  });

  const generateBtn = document.createElement('button');
  generateBtn.type = 'button';
  generateBtn.className = 'primary sceneGenerateBtn';
  generateBtn.textContent = '썸네일 생성하기';
  generateBtn.addEventListener('click', generateThumbnailImage);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'secondary sceneAttachBtn';
  copyBtn.textContent = '프롬프트 복사';
  copyBtn.addEventListener('click', copyThumbnailPrompt);

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'secondary sceneAttachBtn';
  attachBtn.textContent = '이미지 첨부';
  attachBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  const dropZone = document.createElement('div');
  dropZone.className = 'sceneDropZone thumbnailDropZone';
  dropZone.innerHTML = state.thumbnail?.image ? '썸네일 교체<br><b>드래그하거나 첨부하기</b>' : '썸네일 이미지 끌어넣기<br><b>또는 첨부하기</b>';
  dropZone.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  ['dragenter', 'dragover'].forEach((type) => {
    dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragOver');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dragOver');
    });
  });
  dropZone.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) await setThumbnailFromFile(file);
    renderEditor();
  });

  mediaRow.append(generateBtn, copyBtn, attachBtn, dropZone, fileInput);

  const promptWrap = document.createElement('div');
  promptWrap.className = 'compactPromptWrap scenePromptBox';

  const promptTop = document.createElement('div');
  promptTop.className = 'scenePromptTop';
  const promptLabel = document.createElement('strong');
  promptLabel.textContent = '썸네일 이미지 프롬프트';
  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'secondary scenePromptCopy';
  downloadBtn.textContent = '썸네일 다운로드';
  downloadBtn.addEventListener('click', downloadThumbnail);
  promptTop.append(promptLabel, downloadBtn);

  const promptBox = document.createElement('textarea');
  promptBox.id = 'thumbPromptBox';
  promptBox.className = 'scenePromptTextarea';
  promptBox.placeholder = '대본 내용에 맞춘 썸네일 프롬프트가 여기에 표시됩니다.';
  promptBox.value = state.thumbnail?.prompt || makeThumbnailPrompt();
  promptBox.addEventListener('input', () => {
    state.thumbnail.prompt = promptBox.value;
  });

  promptWrap.append(promptTop, promptBox);
  info.append(top, mediaRow, promptWrap);
  card.append(thumb, info);
  box.appendChild(card);
}

function renderEditor() {
  const box = $('sceneEditor');
  if (!box) return;
  box.innerHTML = '';
  renderThumbnailCard(box);

  if (!state.scenes.length) {
    const empty = document.createElement('div');
    empty.className = 'emptyState';
    empty.innerHTML = '아직 장면이 없습니다.<br>오른쪽에 대본을 넣고 음성파일 적용 후 <b>장면 자동나누기</b>를 누르세요.';
    box.appendChild(empty);
    return;
  }

  state.scenes.forEach((scene, idx) => {
    const cap = state.captions.find((c) => c.id === scene.captionIds[0]);
    if (!cap) return;

    const card = document.createElement('div');
    card.className = 'sceneCard compactSceneCard';

    const thumb = document.createElement('div');
    thumb.className = 'sceneThumb compactThumb';
    if (scene.image) {
      const img = document.createElement('img');
      img.src = scene.image;
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '이미지 없음<br>업로드/AI 생성';
    }

    const info = document.createElement('div');
    info.className = 'sceneInfo compactSceneInfo';

    const top = document.createElement('div');
    top.className = 'compactSceneTop';
    top.innerHTML = `<strong>장면 ${idx + 1}</strong><span>${cap.start.toFixed(2)}초 ~ ${cap.end.toFixed(2)}초 (${Math.max(0.1, cap.end - cap.start).toFixed(2)}초)</span>`;

    const mediaRow = document.createElement('div');
    mediaRow.className = 'compactMediaRow';

    const upload = document.createElement('input');
    upload.type = 'file';
    upload.accept = 'image/*';
    upload.className = 'sceneFileInputHidden';
    upload.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await setSceneImageFromFile(scene, file, idx);
    });

    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'primary sceneGenerateBtn';
    aiBtn.textContent = `장면 ${idx + 1} 생성하기`;
    aiBtn.addEventListener('click', () => generateSceneImage(scene, idx));

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'secondary sceneAttachBtn';
    attachBtn.textContent = `장면 ${idx + 1} 첨부하기`;
    attachBtn.addEventListener('click', () => openSceneImagePicker(upload));

    const dropZone = document.createElement('div');
    dropZone.className = 'sceneDropZone';
    dropZone.innerHTML = scene.image ? '이미지 교체<br><b>드래그하거나 첨부하기</b>' : '이미지 끌어넣기<br><b>또는 첨부하기</b>';
    dropZone.addEventListener('click', () => openSceneImagePicker(upload));
    ['dragenter', 'dragover'].forEach((type) => {
      dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragOver');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragOver');
      });
    });
    dropZone.addEventListener('drop', async (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      await setSceneImageFromFile(scene, file, idx);
    });

    const motionSel = document.createElement('select');
    const motionMap = { zoom: '확대', panup: '위로', pandown: '아래로', zoomout: '축소', left: '좌측', right: '우측', none: '고정' };
    Object.keys(motionMap).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = motionMap[m];
      if (scene.motion === m) opt.selected = true;
      motionSel.appendChild(opt);
    });
    motionSel.addEventListener('change', () => {
      scene.motion = motionSel.value;
      drawFrame(timelineTime());
    });

    mediaRow.append(aiBtn, attachBtn, motionSel, dropZone, upload);

    const row = document.createElement('div');
    row.className = 'captionRow compactCaptionRow v8CaptionRow';

    const label = document.createElement('div');
    label.className = 'compactCapLabel';
    label.textContent = '자막';

    const stInput = document.createElement('input');
    stInput.value = cap.start.toFixed(2);
    stInput.title = '시작';
    stInput.addEventListener('change', () => {
      cap.start = parseTime(stInput.value);
      if (cap.start >= cap.end) cap.end = cap.start + 1;
      scene.start = cap.start;
      scene.end = cap.end;
      renderEditor();
      setActiveCaption(cap.id);
      syncPreviewToCaption(cap, false);
    });

    const enInput = document.createElement('input');
    enInput.value = cap.end.toFixed(2);
    enInput.title = '끝';
    enInput.addEventListener('change', () => {
      cap.end = Math.max(cap.start + 0.2, parseTime(enInput.value));
      scene.start = cap.start;
      scene.end = cap.end;
      state.audioDuration = Math.max(state.audioDuration, cap.end);
      renderEditor();
      setActiveCaption(cap.id);
      syncPreviewToCaption(cap);
    });

    const tx = document.createElement('textarea');
    tx.value = cap.text;
    tx.placeholder = '여기서 바로 자막 수정';
    tx.dataset.captionId = cap.id;
    tx.className = 'editableCaptionBox';
    tx.addEventListener('focus', () => setActiveCaption(cap.id));
    tx.addEventListener('input', () => {
      cap.text = tx.value;
      scene.fullText = tx.value;
      scene.prompt = tx.value;
      scene.customPrompt = '';
      const promptTextArea = card.querySelector('.scenePromptTextarea');
      if (promptTextArea) promptTextArea.value = makeImagePrompt(scene.prompt || scene.fullText || tx.value || '', idx);
      setActiveCaption(cap.id);
      const live = $('liveCaptionText');
      if (live && document.activeElement !== live) live.value = tx.value;
      syncPreviewToCaption(cap);
    });
    tx.addEventListener('blur', () => {
      const cleaned = removeTailRepeat(tx.value);
      if (cleaned !== tx.value) {
        tx.value = cleaned;
        tx.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '삭제';
    del.className = 'danger compactDel';
    del.addEventListener('click', () => {
      state.captions = state.captions.filter((c) => c.id !== cap.id);
      state.scenes = state.scenes.filter((s) => s.id !== scene.id);
      state.selectedCaptionId = null;
      state.scenes.forEach((s, i) => { s.title = `장면 ${i + 1}`; });
      renderEditor();
      updateLiveCaptionEditor();
      updateSeekUI(timelineTime());
      drawFrame(timelineTime());
      log('자막칸을 삭제했습니다.');
    });

    row.append(label, stInput, enInput, tx, del);

    const promptWrap = document.createElement('div');
    promptWrap.className = 'compactPromptWrap scenePromptBox';

    const promptTop = document.createElement('div');
    promptTop.className = 'scenePromptTop';

    const promptLabel = document.createElement('strong');
    promptLabel.textContent = `장면 ${idx + 1} 이미지 프롬프트`;

    const promptCopy = document.createElement('button');
    promptCopy.type = 'button';
    promptCopy.className = 'secondary scenePromptCopy';
    promptCopy.textContent = '프롬프트 복사';

    const promptBox = document.createElement('textarea');
    promptBox.className = 'scenePromptTextarea';
    promptBox.value = makeImagePrompt(scene.prompt || scene.fullText || cap.text || '', idx);
    promptBox.placeholder = '이 장면 이미지 프롬프트';
    promptBox.addEventListener('input', () => {
      scene.customPrompt = promptBox.value;
    });
    promptCopy.addEventListener('click', async () => {
      const prompt = scene.customPrompt || promptBox.value || makeImagePrompt(scene.prompt || scene.fullText || cap.text || '', idx);
      await navigator.clipboard?.writeText(prompt).catch(() => {});
      const oldText = promptCopy.textContent;
      promptCopy.textContent = '복사 완료';
      setTimeout(() => { promptCopy.textContent = oldText; }, 1200);
    });

    promptTop.append(promptLabel, promptCopy);
    promptWrap.append(promptTop, promptBox);

    const tools = document.createElement('div');
    tools.className = 'compactSceneTools';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '자막칸 추가';
    addBtn.addEventListener('click', () => addCaptionAfter(cap.id));

    const topTextLabel = document.createElement('label');
    topTextLabel.className = 'checkLine smallCheck compactCheck';
    const topTextCheck = document.createElement('input');
    topTextCheck.type = 'checkbox';
    topTextCheck.checked = scene.topFixedText !== false;
    topTextCheck.addEventListener('change', () => {
      scene.topFixedText = topTextCheck.checked;
      drawFrame(timelineTime());
    });
    topTextLabel.append(topTextCheck, document.createTextNode('상단 고정글자 표시'));

    tools.append(addBtn, topTextLabel);
    info.append(top, mediaRow, row, promptWrap, tools);
    card.append(thumb, info);
    box.appendChild(card);
  });

  updateLiveCaptionEditor();
}

function addCaptionAfter(captionId) {
  const idx = state.captions.findIndex((c) => c.id === captionId);
  const base = state.captions[idx];
  if (!base) return;
  const start = base.end;
  const end = start + 2;
  const newCap = { id: uid(), start, end, text: '새 자막', captionStyle: { ...collectCaptionStyle() } };
  state.captions.splice(idx + 1, 0, newCap);
  state.audioDuration = Math.max(state.audioDuration, end);
  rebuildScenes();
  renderEditor();
  setActiveCaption(newCap.id);
  drawFrame(timelineTime());
}

function updateLiveCaptionEditor() {
  const tx = $('liveCaptionText');
  const info = $('liveCaptionInfo');
  if (!tx) return;
  const cap = getSelectedCaption();
  if (!cap) {
    tx.value = '';
    if (info) info.textContent = '자막 없음';
    return;
  }
  if (document.activeElement !== tx) tx.value = cap.text;
  if (info) info.textContent = `${cap.start.toFixed(2)}초 ~ ${cap.end.toFixed(2)}초`;
  markActiveCaptionCard();
}

function updateCaptionTextLive(value) {
  const cap = getSelectedCaption();
  if (!cap) return;
  const scene = state.scenes.find((s) => s.captionIds.includes(cap.id));
  cap.text = String(value || '');
  if (scene) {
    scene.fullText = cap.text;
    scene.prompt = cap.text;
  }
  document.querySelectorAll(`textarea[data-caption-id="${cap.id}"]`).forEach((el) => {
    if (el !== document.activeElement) el.value = cap.text;
  });
  syncPreviewToCaption(cap);
}

function applyCaptionStyleAll() {
  const style = collectCaptionStyle();
  state.captions.forEach((cap) => { cap.captionStyle = { ...style }; });
  const cap = getSelectedCaption();
  if (cap) syncPreviewToCaption(cap);
  else drawFrame(timelineTime());
  log('전체 자막 스타일 적용 완료');
}

function applyCaptionStyleCurrent() {
  const cap = getSelectedCaption();
  if (!cap) return;
  cap.captionStyle = { ...collectCaptionStyle() };
  syncPreviewToCaption(cap);
  log('현재 자막 스타일 적용 완료');
}

function applyCaptionStyleLive() {
  const cap = getSelectedCaption();
  if (cap) {
    cap.captionStyle = { ...collectCaptionStyle() };
    syncPreviewToCaption(cap);
  } else {
    drawFrame(timelineTime());
  }
}

function cacheSceneImages() {
  state.scenes.forEach((scene) => {
    if (!scene.image || scene.imageObj) return;
    const img = new Image();
    img.onload = () => { scene.imageObj = img; drawFrame(timelineTime()); };
    img.src = scene.image;
  });
}

function drawCoverImage(img, x, y, w, h, t, scene) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  let scale = Math.max(w / iw, h / ih);
  const localDur = Math.max(0.1, (scene.end || 1) - (scene.start || 0));
  const p = clamp((t - (scene.start || 0)) / localDur, 0, 1);
  let dx = x + (w - iw * scale) / 2;
  let dy = y + (h - ih * scale) / 2;

  if (scene.motion === 'zoom') scale *= 1 + p * 0.12;
  if (scene.motion === 'zoomout') scale *= 1.12 - p * 0.12;

  dx = x + (w - iw * scale) / 2;
  dy = y + (h - ih * scale) / 2;

  if (scene.motion === 'panup') dy -= h * 0.08 * p;
  if (scene.motion === 'pandown') dy += h * 0.08 * p;
  if (scene.motion === 'left') dx -= w * 0.08 * p;
  if (scene.motion === 'right') dx += w * 0.08 * p;

  ctx.drawImage(img, dx, dy, iw * scale, ih * scale);
}

function drawCaption(text, style = collectCaptionStyle()) {
  // 싱크용 점(...) 자막은 투명 처리 = 아무것도 그리지 않음
  const printable = displayCaption(text);
  if (!printable || /^[.\u2026\s]+$/.test(printable)) return;

  const lines = printable.split('\n').filter(Boolean);
  if (!lines.length) return;

  const baseSize = Number(style.fontSize || 58);
  const fs = Math.max(12, Math.round(baseSize * (canvas.width / 540)));
  const xOffset = (Number(style.x || 0) / 100) * canvas.width;
  let y;
  const pos = style.pos || 'lower';
  if (pos === 'top') y = canvas.height * 0.14;
  else if (pos === 'upper') y = canvas.height * 0.28;
  else if (pos === 'center') y = canvas.height * 0.5;
  else if (pos === 'bottom') y = canvas.height * 0.84;
  else y = canvas.height * (Number(style.y || 62) / 100);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 자막이 캔버스 밖으로 넘어가지 않도록 가로/세로 모두 자동 글자 축소
  let fitFs = fs;
  const maxWidth = canvas.width * 0.9;
  const maxHeight = canvas.height * 0.34;
  while (fitFs > 9) {
    ctx.font = `${style.weight || 900} ${fitFs}px ${fontFamily(style.font)}`;
    const lineHTest = fitFs * 1.16;
    const tooWide = lines.some((line) => ctx.measureText(line).width > maxWidth);
    const tooTall = lineHTest * lines.length > maxHeight;
    if (!tooWide && !tooTall) break;
    fitFs -= 1;
  }

  ctx.font = `${style.weight || 900} ${fitFs}px ${fontFamily(style.font)}`;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const lineH = fitFs * 1.16;
  const blockH = lineH * lines.length;

  // 상단/하단 선택 시에도 자막 박스가 화면 밖으로 나가지 않게 보정
  const safeTop = fitFs * 0.8 + blockH / 2;
  const safeBottom = canvas.height - fitFs * 0.8 - blockH / 2 - 28;
  y = clamp(y, safeTop, safeBottom);

  const bgOpacity = clamp(Number(style.boxOpacity || 0), 0, 90) / 100;
  if (bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(style.bgColor || '#000000', bgOpacity);
    ctx.fillRect(canvas.width * 0.06, y - blockH / 2 - fitFs * 0.35, canvas.width * 0.88, blockH + fitFs * 0.7);
  }

  lines.forEach((line, i) => {
    const ly = y + (i - (lines.length - 1) / 2) * lineH;
    ctx.strokeStyle = style.strokeColor || '#b33636';
    ctx.lineWidth = Math.max(2, fitFs * 0.14);
    ctx.strokeText(line, canvas.width / 2 + xOffset, ly);
    ctx.fillStyle = style.textColor || '#ffffff';
    ctx.fillText(line, canvas.width / 2 + xOffset, ly);
  });

  ctx.restore();
}

function hexToRgba(hex, opacity) {
  const h = String(hex || '#000000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${opacity})`;
}

function drawFrame(t = 0) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#070b12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const scene = getSceneAtTime(t);
  const cap = getCaptionAtTime(t);
  if (scene && scene.imageObj) {
    drawCoverImage(scene.imageObj, 0, 0, canvas.width, canvas.height, t, scene);
  }

  if (cap && cap.text) drawCaption(cap.text, cap.captionStyle || collectCaptionStyle());

  ctx.fillStyle = 'rgba(0,0,0,.7)';
  ctx.fillRect(0, canvas.height - 26, canvas.width, 10);
  const total = Math.max(1, state.audioDuration || 60);
  ctx.fillStyle = '#67e8a5';
  ctx.fillRect(0, canvas.height - 26, canvas.width * clamp(t / total, 0, 1), 10);
}

function updateSeekUI(t = timelineTime()) {
  const total = Math.max(0, state.audioDuration || 0);
  const seek = $('previewSeek');
  if (seek) {
    seek.max = total.toFixed(2);
    seek.value = clamp(t, 0, total).toFixed(2);
  }
  const time = $('previewTime');
  if (time) time.textContent = `${formatTime(t)} / ${formatTime(total)}`;
  updateLiveCaptionEditor();
}

function finishPreview(reset = false) {
  state.playing = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = null;
  const audio = $('audio');
  if (audio) audio.pause();

  if (reset) {
    if (audio) audio.currentTime = 0;
    updateSeekUI(0);
    drawFrame(0);
    return;
  }

  const t = Math.min(state.audioDuration || 0, timelineTime());
  updateSeekUI(t);
  drawFrame(t);
}

function previewLoop() {
  if (!state.playing) return;
  const audio = $('audio');
  let t;

  // V44 싱크 고정: 음성이 있으면 자막/장면 시간은 무조건 audio.currentTime을 기준으로 한다.
  // performance.now()는 음성이 없거나 재생 실패했을 때만 쓰는 예비 타이머다.
  if (audio && audio.src && !audio.paused && Number.isFinite(audio.currentTime)) {
    t = audio.currentTime;
  } else {
    t = state.playStartTime + ((performance.now() - state.playStartMs) / 1000) * speed();
  }

  if (t >= state.audioDuration - 0.03) {
    updateSeekUI(state.audioDuration);
    drawFrame(state.audioDuration);
    finishPreview(false);
    return;
  }
  updateSeekUI(t);
  drawFrame(t);
  state.raf = requestAnimationFrame(previewLoop);
}

function playPreview() {
  // 재생 버튼만 다시 눌러도 기존 상태를 완전히 끊고 새로 재생한다.
  finishPreview(false);

  let current = parseFloat($('previewSeek')?.value || '0') || 0;
  const total = Math.max(0, state.audioDuration || 0);
  if (current >= total - 0.05) current = 0;

  state.playing = true;
  state.playStartTime = current;
  state.playStartMs = performance.now();

  const audio = $('audio');
  updateSeekUI(current);
  drawFrame(current);

  if (audio && audio.src) {
    audio.pause();
    audio.currentTime = current;
    audio.onended = () => finishPreview(false);
    audio.play()
      .then(() => {
        // audio.play()가 실제로 시작된 뒤 루프를 시작해야 앞부분 랜덤 싱크 밀림이 없다.
        state.playStartTime = audio.currentTime || current;
        state.playStartMs = performance.now();
        if (state.playing) previewLoop();
      })
      .catch(() => {
        // 오디오 재생이 막힌 경우에만 예비 타이머로 미리보기를 진행한다.
        state.playStartTime = current;
        state.playStartMs = performance.now();
        if (state.playing) previewLoop();
      });
    return;
  }

  previewLoop();
}

function stopPreview(reset = false) {
  finishPreview(reset);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function setSceneImageFromFile(scene, file, idx) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    log('이미지 파일만 첨부할 수 있습니다.');
    return;
  }
  scene.image = await fileToDataURL(file);
  scene.imageObj = null;
  cacheSceneImages();
  renderEditor();
  drawFrame(timelineTime());
  log(`장면 ${idx + 1} 이미지 첨부 완료`);
}

function openSceneImagePicker(input) {
  if (!input) return;
  input.value = '';
  input.click();
}

async function generateSceneImage(scene, idx) {
  const prompt = scene.customPrompt || makeImagePrompt(scene.prompt || scene.fullText || '', idx);
  await navigator.clipboard?.writeText(prompt).catch(() => {});
  const box = $('imagePromptList');
  if (box) box.value = prompt;
  openImageProvider(prompt, idx);
  log(`장면 ${idx + 1} 프롬프트를 복사하고 생성창을 열었습니다. ChatGPT/Gemini에서 붙여넣기 후 생성하고, 완성 이미지는 이 장면에 끌어넣으세요.`);
}

function imageProviderUrl() {
  const provider = $('imageProvider')?.value || 'chatgpt';
  if (provider === 'gemini') return 'https://gemini.google.com/app';
  if (provider === 'manual') return '';
  return 'https://chatgpt.com/';
}


function buildImageProviderUrl(promptText = '', sceneIndex = '') {
  // 확장프로그램 없이 쓰는 최종 방식: 생성 사이트만 연다.
  // 프롬프트는 클립보드에 복사되므로 ChatGPT/Gemini 입력창에 붙여넣으면 된다.
  return imageProviderUrl();
}

function openImageProvider(promptText = '', sceneIndex = '') {
  const url = buildImageProviderUrl(promptText, sceneIndex);
  if (!url) return;
  window.open(url, '_blank');
}

function requestExtensionOpenTabs(prompts) {
  const provider = $('imageProvider')?.value || 'chatgpt';
  if (provider === 'manual' || provider === 'api') return false;
  const urls = prompts.map((prompt, index) => ({
    index,
    prompt,
    url: buildImageProviderUrl(prompt, index)
  })).filter(x => x.url);
  if (!urls.length) return false;
  window.postMessage({
    type: 'SENIAL_OPEN_AI_TABS',
    provider,
    items: urls,
    closeAfterSend: false
  }, '*');
  return true;
}

function styleLabelFromSelect() {
  const style = $('imageStyle')?.value || 'photo-person-bg';
  const map = {
    'photo-person-bg': '실사 인물배경',
    'photo-person': '실사 인물',
    'photo-bg': '실사 배경',
    'comic-person-bg': '만화 지브리 인물배경',
    'comic-person': '만화 지브리 인물',
    'comic-bg': '만화 지브리 배경',
  };
  return map[style] || '실사 인물배경';
}


function getActiveTopicContext() {
  const picked = cleanSeoTopicText($('scriptTopic')?.value || '');
  const autoSeed = cleanSeoTopicText($('autoSeedTopic')?.value || '');
  const category = cleanSeoTopicText($('scriptCategory')?.value || '');
  const request = String($('scriptRequest')?.value || '').trim();
  // 선택한 주제/올자동 입력 주제만 이미지 프롬프트의 주제로 사용한다.
  // 기본 카테고리(예: 상식)는 프롬프트에 섞지 않는다.
  const main = picked || autoSeed || '';
  return { main, request, category };
}

function makePromptSourceText(text) {
  const ctx = getActiveTopicContext();
  const sceneText = String(text || '').replace(/\n/g, ' ').trim();
  const parts = [];
  if (ctx.main) parts.push(`주제: ${ctx.main}`);
  if (ctx.request) parts.push(`방향: ${ctx.request}`);
  if (sceneText && (!ctx.main || plainKey(sceneText) !== plainKey(ctx.main))) parts.push(`장면 내용: ${sceneText}`);
  if (!parts.length) parts.push('장면 내용: 쇼츠 장면');
  return parts.join(', ');
}

function makeImagePrompt(text, idx) {
  const style = $('imageStyle')?.value || 'photo-person-bg';
  const base = makePromptSourceText(text);

  // V40: 이미지 프롬프트는 항상 선택한 주제 + 장면 자막을 같이 반영한다.
  // 배경 모드는 사람/인물/얼굴/몸이 절대 나오지 않도록 프롬프트를 분리한다.
  if (style === 'comic-bg') {
    return `${base}, Studio Ghibli inspired background scenery matching the topic, environment only, landscape only, empty scene, no people, no person, no character, no human, no face, no body, cinematic background, vertical 9:16, no text, no subtitles`;
  }
  if (style === 'photo-bg') {
    return `${base}, realistic cinematic background matching the topic, environment only, landscape only, empty scene, no people, no person, no character, no human, no face, no body, vertical 9:16, no text, no subtitles`;
  }
  if (style === 'comic-person') return `${base}, emotional Studio Ghibli inspired anime character scene matching the topic, single person, cinematic, vertical 9:16, no text, no subtitles`;
  if (style === 'comic-person-bg') return `${base}, emotional Studio Ghibli inspired anime scene with person and background matching the topic, cinematic, vertical 9:16, no text, no subtitles`;
  if (style === 'photo-person') return `${base}, realistic cinematic portrait scene matching the topic, single person, vertical 9:16, no text, no subtitles`;
  return `${base}, realistic cinematic scene with person and background matching the topic, vertical 9:16, no text, no subtitles`;
}



function thumbnailSourceText() {
  const topic = getActiveTopicContext().main;
  const firstCaption = state.captions?.[0]?.text || '';
  const scriptLines = String($('generatedScript')?.value || '')
    .split(/\n+/)
    .map((v) => removeTailRepeat(v).trim())
    .filter(Boolean);
  return firstCaption || scriptLines[0] || topic || '오늘도 잘 버텨낸 하루';
}

function makeThumbnailText(force = false) {
  if (state.thumbnail?.text && !force) return state.thumbnail.text;
  const source = thumbnailSourceText();
  const clean = removeTailRepeat(source)
    .replace(/[!?!.。！？]+$/g, '')
    .replace(/혹시\s*/g, '')
    .trim();
  let text = clean;
  if (clean.length > 18) {
    if (/아무도.*몰라|몰라주는/.test(clean)) text = '아무도 몰라줘도';
    else if (/버텨|견뎌/.test(clean)) text = '오늘도 잘 버텼습니다';
    else if (/마음|무너/.test(clean)) text = '마음이 무너진 날';
    else text = clean.slice(0, 16).trim();
  }
  state.thumbnail.text = text || '오늘도 잘 버텼습니다';
  return state.thumbnail.text;
}

function makeThumbnailPrompt() {
  const subject = thumbnailSourceText();
  const koreanText = makeThumbnailText(false);
  const style = $('imageStyle')?.value || state.thumbnail?.style || 'photo-person-bg';
  state.thumbnail.style = style;
  const base = `${subject}, viral YouTube Shorts thumbnail, strong emotional hook, dramatic composition, high contrast, vertical 9:16, cinematic, include large Korean thumbnail text exactly: "${koreanText}", bold Korean typography, text integrated into the image, easy to read on mobile, no subtitles`;
  if (style === 'comic-bg') return `${base}, Studio Ghibli inspired background scenery, environment only, landscape only, empty scene, no people, no person, no character, no human, no face, no body`;
  if (style === 'photo-bg') return `${base}, realistic cinematic background, environment only, landscape only, empty scene, no people, no person, no character, no human, no face, no body`;
  if (style === 'comic-person') return `${base}, emotional Studio Ghibli inspired anime character scene, single person, expressive mood, cinematic lighting`;
  if (style === 'comic-person-bg') return `${base}, emotional Studio Ghibli inspired anime scene with person and background, cinematic lighting`;
  if (style === 'photo-person') return `${base}, realistic cinematic portrait, single person, close-up, dramatic lighting`;
  return `${base}, realistic cinematic scene with person and background, dramatic lighting`;
}

function updateThumbnailPromptBox(force = true) {
  const prompt = state.thumbnail?.prompt && !force ? state.thumbnail.prompt : makeThumbnailPrompt();
  state.thumbnail.prompt = prompt;
  state.thumbnail.style = $('imageStyle')?.value || state.thumbnail?.style || 'photo-person-bg';
  if ($('thumbPromptBox')) $('thumbPromptBox').value = prompt;
  return prompt;
}

async function generateThumbnailImage() {
  const prompt = $('thumbPromptBox')?.value || updateThumbnailPromptBox();
  state.thumbnail.prompt = prompt;
  await navigator.clipboard?.writeText(prompt).catch(() => {});
  openImageProvider(prompt, 'thumbnail');
  log('썸네일 프롬프트를 복사하고 생성 사이트를 열었습니다. 생성 후 이미지를 썸네일 카드에 끌어넣으세요.');
}

async function copyThumbnailPrompt() {
  const prompt = $('thumbPromptBox')?.value || updateThumbnailPromptBox();
  state.thumbnail.prompt = prompt;
  await navigator.clipboard?.writeText(prompt).catch(() => {});
  log('썸네일 프롬프트 복사 완료');
}

function renderThumbnailPreview() {
  const box = $('thumbPreviewInner');
  if (!box) return;
  if (!state.thumbnail.image) {
    box.innerHTML = '썸네일 이미지 끌어넣기<br><b>또는 이미지 첨부</b>';
    return;
  }
  box.innerHTML = '';
  const img = document.createElement('img');
  img.src = state.thumbnail.image;
  img.alt = '썸네일 미리보기';
  box.append(img);
}

async function setThumbnailFromFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    log('썸네일은 이미지 파일만 첨부할 수 있습니다.');
    return;
  }
  state.thumbnail.image = await fileToDataURL(file);
  state.thumbnail.imageObj = null;
  renderThumbnailPreview();
  log('썸네일 이미지 첨부 완료');
}

function downloadThumbnail() {
  if (!state.thumbnail.image) {
    log('먼저 썸네일 이미지를 첨부하세요.');
    return;
  }
  const a = document.createElement('a');
  a.href = state.thumbnail.image;
  a.download = 'senial_thumbnail.png';
  a.click();
}

function splitThumbnailText(text, max = 10) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return ['오늘도 잘', '버텼습니다'];
  const words = clean.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length === 1 && lines[0].length > max) {
    const one = lines[0];
    return [one.slice(0, Math.ceil(one.length / 2)), one.slice(Math.ceil(one.length / 2))];
  }
  return lines.slice(0, 3);
}

function bindThumbnailEvents() {
  $('btnGenerateThumbnail')?.addEventListener('click', generateThumbnailImage);
  $('btnCopyThumbnailPrompt')?.addEventListener('click', copyThumbnailPrompt);
  $('btnAttachThumbnail')?.addEventListener('click', () => $('thumbImageFile')?.click());
  $('btnDownloadThumbnail')?.addEventListener('click', downloadThumbnail);
  $('thumbImageFile')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) setThumbnailFromFile(f); });
  ['thumbImageStyle'].forEach((id) => {
    $(id)?.addEventListener('input', updateThumbnailPromptBox);
    $(id)?.addEventListener('change', updateThumbnailPromptBox);
  });
  const dz = $('thumbDropZone');
  if (dz) {
    dz.addEventListener('click', () => $('thumbImageFile')?.click());
    ['dragenter', 'dragover'].forEach((type) => dz.addEventListener(type, (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.add('dragOver');
    }));
    ['dragleave', 'drop'].forEach((type) => dz.addEventListener(type, (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragOver');
    }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) setThumbnailFromFile(f);
    });
  }
  updateThumbnailPromptBox();
  renderThumbnailPreview();
}

async function generateAllImages() {
  if (!state.scenes.length) {
    createCaptionsFromScript();
  }
  if (!state.scenes.length) {
    log('대본이 없어 이미지 프롬프트 생성을 건너뛰었습니다.');
    return;
  }

  const thumbnailPrompt = updateThumbnailPromptBox(true);
  const prompts = state.scenes.map((scene, i) => scene.customPrompt || makeImagePrompt(scene.prompt || scene.fullText || '', i));
  const previewText = [`[썸네일]\n${thumbnailPrompt}`, ...prompts.map((p, i) => `[장면 ${i + 1}]\n${p}`)].join('\n\n');
  const box = $('imagePromptList');
  if (box) box.value = previewText;
  await navigator.clipboard?.writeText(previewText).catch(() => {});
  renderEditor();
  log(`선택 주제 기준으로 썸네일 1개 + 장면별 이미지 프롬프트 ${prompts.length}개 생성 완료.`);
}

async function attachBulkImages(files) {
  const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  if (!state.scenes.length) {
    createCaptionsFromScript();
  }
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  for (let i = 0; i < list.length && i < state.scenes.length; i++) {
    state.scenes[i].image = await fileToDataURL(list[i]);
    state.scenes[i].imageObj = null;
  }
  cacheSceneImages();
  renderEditor();
  drawFrame(timelineTime());
  log(`이미지 ${Math.min(list.length, state.scenes.length)}장을 장면 순서대로 자동 첨부했습니다.`);
}



function getSafeSceneIndex(value) {
  if (value === null || value === undefined || value === '') return -1;
  const n = Number(value);
  if (!Number.isFinite(n)) return -1;
  return Math.floor(n);
}

async function attachDataUrlImages(dataUrls) {
  let list = Array.isArray(dataUrls) ? dataUrls.filter(Boolean) : [];
  if (!list.length) return;
  if (!state.scenes.length) createCaptionsFromScript();

  // 확장프로그램에서 {index, data} 형태로 오면 장면 번호에 맞춰 꽂는다.
  if (typeof list[0] === 'object') {
    list = list.filter(x => x && x.data).sort((a, b) => {
      const ai = getSafeSceneIndex(a.index);
      const bi = getSafeSceneIndex(b.index);
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
    });
    const attachedIndexes = [];
    for (const item of list) {
      let idx = getSafeSceneIndex(item.index);

      // scene 번호가 없으면 Number(null)=0 처리 때문에 계속 1번 장면에 들어가던 문제 방지
      // 번호가 없는 이미지는 아직 이미지가 없는 첫 장면에 넣는다.
      if (idx < 0) idx = state.scenes.findIndex((s) => !s.image);

      if (idx >= 0 && idx < state.scenes.length) {
        state.scenes[idx].image = item.data;
        state.scenes[idx].imageObj = null;
        attachedIndexes.push(idx);
      }
    }
    cacheSceneImages();
    renderEditor();
    drawFrame(timelineTime());
    if (attachedIndexes.length) {
      window.postMessage({ type: 'SENIAL_ATTACH_CONFIRMED', indexes: attachedIndexes }, '*');
    }
    log(`외부 이미지 ${attachedIndexes.length}장을 장면 번호에 맞춰 자동 첨부했습니다.`);
    return;
  }

  for (let i = 0; i < list.length && i < state.scenes.length; i++) {
    state.scenes[i].image = list[i];
    state.scenes[i].imageObj = null;
  }
  cacheSceneImages();
  renderEditor();
  drawFrame(timelineTime());
  log(`외부 이미지 ${Math.min(list.length, state.scenes.length)}장을 자동 첨부했습니다.`);
}

window.addEventListener('senial-extension-images', (event) => {
  const images = event?.detail?.images || [];
  attachDataUrlImages(images);
});

window.addEventListener('message', (event) => {
  if (event?.data?.type === 'SENIAL_EXTENSION_IMAGES') {
    attachDataUrlImages(event.data.images || []);
  }
});

function setImageStyleFromAuto(version, kind) {
  const styleMap = {
    photo: { personBackground: 'photo-person-bg', person: 'photo-person', background: 'photo-bg' },
    comic: { personBackground: 'comic-person-bg', person: 'comic-person', background: 'comic-bg' },
  };
  const val = styleMap[version]?.[kind] || 'photo-person-bg';
  if ($('imageStyle')) $('imageStyle').value = val;
}

async function runAutoMode(version, kind) {
  setImageStyleFromAuto(version, kind);
  const panel = $('autoModePanel');
  if (panel) panel.style.display = 'none';
  if (!state.captions.length) createCaptionsFromScript();
  rebuildScenes();
  renderEditor();
  await generateAllImages();
}



function chooseRenderMime() {
  // V35: MP4 변환은 제외하고 브라우저 기본 녹화에 안정적인 WEBM만 사용한다.
  const candidates = [
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WEBM' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WEBM' },
    { mime: 'video/webm', ext: 'webm', label: 'WEBM' },
  ];
  if (!window.MediaRecorder) return candidates[candidates.length - 1];
  return candidates.find((item) => MediaRecorder.isTypeSupported(item.mime)) || candidates[candidates.length - 1];
}

function updateRenderProgress(percent, label) {
  const p = clamp(Math.round(Number(percent) || 0), 0, 100);
  const fill = $('renderProgressFill');
  const txt = $('renderPercent');
  const mini = $('renderProgressMini');
  const status = $('renderStatus');
  const btn = $('btnRender');
  if (fill) fill.style.width = `${p}%`;
  if (txt) txt.textContent = `${p}%`;
  if (mini) mini.classList.toggle('active', p > 0 && p < 100);
  if (status) status.textContent = label || `생성 중 ${p}%`;
  if (btn && state.rendering) btn.textContent = `생성 중 ${p}%`;
}

function resetRenderProgress() {
  const fill = $('renderProgressFill');
  const txt = $('renderPercent');
  const mini = $('renderProgressMini');
  const btn = $('btnRender');
  if (fill) fill.style.width = '0%';
  if (txt) txt.textContent = '0%';
  if (mini) mini.classList.remove('active');
  if (btn) btn.textContent = 'WEBM 생성 및 다운로드';
}

async function renderWebm() {
  if (state.rendering) return;
  state.rendering = true;
  const status = $('renderStatus');
  const link = $('downloadLink');
  const btn = $('btnRender');
  updateRenderProgress(0, '생성 준비 중 0%');
  if (btn) {
    btn.classList.add('renderingNow');
    btn.disabled = true;
  }
  if (link) {
    link.classList.add('disabledDownload');
    link.removeAttribute('href');
    link.textContent = '생성 중입니다. 100% 완료 후 다운로드 가능';
  }
  try {
    const oldW = canvas.width;
    const oldH = canvas.height;
    canvas.width = FINAL_W;
    canvas.height = FINAL_H;
    const fps = 30;
    const stream = canvas.captureStream(fps);
    const audio = $('audio');
    let audioNode, audioCtx;
    if (audio && audio.src && audio.captureStream) {
      audio.currentTime = 0;
      const audioStream = audio.captureStream();
      audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
    }
    const renderType = chooseRenderMime();
    const recorder = new MediaRecorder(stream, { mimeType: renderType.mime });
    const chunks = [];
    let renderFinished = false;
    let stopWatchdog = null;

    function finishRender() {
      if (renderFinished) return;
      renderFinished = true;
      if (stopWatchdog) clearTimeout(stopWatchdog);
      stream.getTracks().forEach((track) => track.stop());

      if (!chunks.length) {
        throw new Error('녹화 데이터가 비어 있습니다. 다시 생성해 주세요.');
      }

      const blob = new Blob(chunks, { type: renderType.mime });
      const url = URL.createObjectURL(blob);
      if (link) {
        link.href = url;
        link.download = `senial_video.${renderType.ext}`;
        link.textContent = `✅ ${renderType.label} 다운로드`;
        link.classList.remove('disabledDownload');
      }
      canvas.width = oldW;
      canvas.height = oldH;
      drawFrame(timelineTime());
      state.rendering = false;
      updateRenderProgress(100, `완료 100% - 아래 ${renderType.label} 다운로드를 누르세요`);
      if (btn) {
        btn.classList.remove('renderingNow');
        btn.disabled = false;
        btn.textContent = `${renderType.label} 다시 생성`;
      }
      const mini = $('renderProgressMini');
      if (mini) mini.classList.add('done');
    }

    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = finishRender;
    recorder.onerror = (e) => { throw e.error || new Error('영상 녹화 중 오류가 발생했습니다.'); };
    const total = Math.max(1, state.audioDuration || 30);
    let started = performance.now();
    let useAudioClock = !!(audio && audio.src);

    function closeRecorder() {
      if (audio) audio.pause();
      updateRenderProgress(99, '영상 파일 마감 처리 중 99%');
      try {
        if (recorder.state === 'recording') recorder.requestData();
      } catch (_) {}
      stopWatchdog = setTimeout(() => {
        if (!renderFinished && chunks.length) finishRender();
      }, 3000);
      if (recorder.state !== 'inactive') recorder.stop();
      else finishRender();
    }

    function step() {
      // V44 다운로드 싱크 고정: 음성이 있으면 렌더 타임도 audio.currentTime 기준으로만 그린다.
      // 기존 performance.now() 기준 렌더는 브라우저 부하에 따라 음성과 자막이 랜덤하게 어긋날 수 있었다.
      const t = useAudioClock && audio && Number.isFinite(audio.currentTime)
        ? Math.min(total, audio.currentTime)
        : Math.min(total, (performance.now() - started) / 1000);
      const percent = Math.min(99, Math.floor((t / total) * 100));
      updateRenderProgress(percent, `생성 중 ${percent}%  ·  ${formatTime(t)} / ${formatTime(total)}`);
      drawFrame(t);
      if (t < total - 0.03) requestAnimationFrame(step);
      else closeRecorder();
    }

    drawFrame(0);
    recorder.start(1000);
    if (audio && audio.src) {
      audio.pause();
      audio.currentTime = 0;
      audio.play()
        .then(() => {
          started = performance.now();
          useAudioClock = true;
          step();
        })
        .catch(() => {
          started = performance.now();
          useAudioClock = false;
          step();
        });
    } else {
      started = performance.now();
      useAudioClock = false;
      step();
    }
  } catch (err) {
    console.error(err);
    state.rendering = false;
    if (btn) {
      btn.classList.remove('renderingNow');
      btn.disabled = false;
      btn.textContent = 'WEBM 생성 및 다운로드';
    }
    updateRenderProgress(0, '실패');
    if (status) status.textContent = '실패';
    alert('영상 생성 실패: 브라우저가 MediaRecorder를 지원하는지 확인하세요.');
  }
}

function saveProject() {
  const data = {
    captions: state.captions,
    scenes: state.scenes.map((s) => ({ ...s, imageObj: null })),
    audioDuration: state.audioDuration,
    thumbnail: { ...state.thumbnail, imageObj: null },
    script: $('generatedScript')?.value || '',
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'senial_project.json';
  a.click();
}

function loadProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      state.captions = data.captions || [];
      state.scenes = data.scenes || [];
      state.audioDuration = data.audioDuration || 60;
      state.thumbnail = { ...(state.thumbnail || {}), ...(data.thumbnail || {}), imageObj: null };
      if ($('generatedScript')) $('generatedScript').value = data.script || '';
      if ($('thumbImageStyle')) $('thumbImageStyle').value = state.thumbnail.style || 'photo-person-bg';
      if ($('thumbPromptBox')) $('thumbPromptBox').value = state.thumbnail.prompt || makeThumbnailPrompt();
      state.thumbnail.text = state.thumbnail.text || makeThumbnailText();
      renderThumbnailPreview();
      cacheSceneImages();
      renderEditor();
      updateSeekUI(0);
      drawFrame(0);
      log('작업 불러오기 완료');
    } catch (err) {
      alert('JSON 파일을 읽지 못했습니다.');
    }
  };
  reader.readAsText(file);
}

function updateAudioStatus(file, duration = 0) {
  const info = $('audioAttachInfo');
  const rightInfo = $('rightAudioAttachInfo');
  const badge = $('audioQuickBadge');
  if (!file) {
    const emptyText = '음성 파일을 선택하면 길이와 예상 자막 수가 표시됩니다.';
    if (info) info.textContent = emptyText;
    if (rightInfo) rightInfo.textContent = '온도쿠에서 받은 음성파일을 여기에 넣으세요.';
    if (badge) badge.textContent = '대기중';
    return;
  }
  const html = `음성 첨부됨<br>파일명: <b>${file.name}</b><br>길이: <b>${formatTime(duration)}</b>`;
  if (info) info.innerHTML = html;
  if (rightInfo) rightInfo.innerHTML = html;
  if (badge) badge.textContent = '첨부완료';
}


const SENIAL_SCRIPT_API_MODEL = 'gpt-4.1-mini';
const SENIAL_GEMINI_MODEL = 'gemini-1.5-flash';
const SENIAL_OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const SENIAL_API_KEY_STORAGE = 'senial_script_api_key';
const SENIAL_API_PROVIDER_STORAGE = 'senial_script_api_provider';
const SENIAL_API_CHECK_STORAGE = 'senial_script_api_check_status';
const SENIAL_SCRIPT_API_LINKS = {
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  claude: 'https://console.anthropic.com/settings/keys'
};
const SENIAL_TOPIC_LIST = [
  '상식','명언','뉴스','감성','부업','돈관리','사업','맛집','여행','인테리어',
  '방수공사','자동화','AI도구','자기계발','연애','가족','건강일상','유머','역사','직접입력'
];

const SENIAL_TOPIC_SUGGESTIONS = {
  '상식': ['요즘 사람들이 의외로 모르는 상식','생활비 아끼는 작은 습관','일상에서 바로 쓰는 심리 상식','알아두면 손해 안 보는 기본 상식','대화가 쉬워지는 잡학 상식','모르면 불편한 디지털 상식','하루를 바꾸는 시간관리 상식','돈 새는 습관 체크리스트','사람 관계에서 꼭 필요한 말습관','2026년 기준 생활 트렌드 정리'],
  '명언': ['오늘 마음을 잡아주는 한 문장','무너진 마음을 다시 세우는 말','포기하고 싶을 때 듣는 말','조용히 성장하는 사람의 문장','나를 지키는 현실 명언','힘든 하루 끝에 필요한 말','인생이 막막할 때 보는 문장','혼자 버티는 사람에게 필요한 말','늦었다고 느낄 때 필요한 말','흔들리는 마음을 잡는 짧은 명언'],
  '뉴스': ['오늘 사람들이 많이 찾는 이슈 정리','2026년 오늘 기준 생활 뉴스 흐름','요즘 경제 흐름 1분 정리','AI 뉴스 핵심만 쉽게 정리','부동산 이슈 쉽게 보기','자영업자가 봐야 할 최근 흐름','돈과 연결되는 오늘 이슈','SNS에서 화제 된 흐름 정리','이번 주 알아둘 변화 정리','복잡한 뉴스를 쉽게 풀어보기'],
  '감성': ['아무도 몰라주는 하루를 버틴 사람에게','마음이 무너진 날 필요한 이야기','괜찮은 척 지친 사람에게','혼자 참고 있는 사람에게','오늘도 버틴 나에게 하는 말','늦은 밤 마음이 복잡한 사람에게','말 한마디에 무너진 날','조용히 견디는 사람의 마음','다시 시작하기 전 필요한 위로','내 편이 필요했던 하루'],
  '부업': ['초보가 시작하기 쉬운 부업 흐름','시간 없을 때 가능한 부업 아이디어','자영업자 부수익 자동화 아이디어','돈 안 들이고 시작하는 온라인 부업','AI로 줄일 수 있는 반복작업','블로그 부업 시작 전 체크','쇼츠 부업 현실 체크','크몽 판매 아이템 찾기','동네 사장님 대상 자동화 서비스','작게 시작하는 디지털 상품'],
  '돈관리': ['월급이 새는 습관 잡기','소액부터 시작하는 돈관리','고정비 줄이는 현실 방법','돈 모으기 전에 끊어야 할 습관','자영업자 현금흐름 체크','50대 전 돈관리 기준','카드값 줄이는 실전 루틴','소비를 줄이는 하루 점검','돈 때문에 불안할 때 보는 기준','생활비 관리 1분 정리'],
  '사업': ['작은 가게가 살아남는 방법','자영업자가 바로 점검할 것','손님이 안 올 때 봐야 할 문제','온라인 세팅이 필요한 이유','매출보다 먼저 봐야 할 흐름','사장님이 놓치는 자동화 포인트','작게 시작하는 영업 전략','단골을 만드는 첫인상','사업 초반에 줄여야 할 낭비','광고 전에 준비할 기본 세팅'],
  '맛집': ['동네 맛집 고르는 기준','실패 없는 맛집 체크법','요즘 뜨는 음식점 포인트','가성비 맛집 찾는 방법','데이트 맛집 고르는 팁','혼밥 맛집 고르는 기준','리뷰 볼 때 걸러야 할 표현','맛집 쇼츠 만드는 법','사장님이 알아야 할 메뉴 소개법','인천 맛집 탐방 주제'],
  '여행': ['가볍게 떠나는 하루 여행','여행 전 꼭 확인할 체크리스트','비 오는 날 가기 좋은 여행지','가성비 여행 준비법','혼자 여행할 때 필요한 기준','사진 잘 나오는 여행 코스','주말 가까운 여행 아이디어','여행비 줄이는 현실 팁','처음 가는 곳에서 실패 줄이기','감성 여행 쇼츠 주제'],
  '인테리어': ['상가 인테리어 전 꼭 볼 것','공사 전 견적 비교 기준','작은 매장 분위기 바꾸는 법','인테리어 비용 줄이는 순서','매장 첫인상을 바꾸는 포인트','철거 전 확인해야 할 부분','조명 하나로 달라지는 공간','사무실 인테리어 체크리스트','카페형 공간 만드는 기준','인테리어 계약 전 주의점'],
  '방수공사': ['옥상 누수 전조증상','방수공사 전 확인할 부분','우레탄 방수 기본 상식','비 오기 전 점검해야 할 곳','베란다 누수 체크 방법','방수 견적 볼 때 기준','외벽 누수 의심 신호','방수 하자 줄이는 순서','건물주가 알아야 할 방수 상식','장마 전 방수 점검'],
  '자동화': ['자영업 자동화 기본 세팅','반복업무 줄이는 자동화 아이디어','블로그 자동화 시작 전 기준','쇼츠 제작 자동화 흐름','AI 도구로 시간 줄이는 법','사장님에게 필요한 자동화 3가지','고객 응대 자동화 아이디어','콘텐츠 자동화 현실 체크','업무 자동화로 줄일 수 있는 낭비','초보용 자동화 프로그램 아이디어'],
  'AI도구': ['요즘 쓸만한 AI 도구 흐름','무료 AI 도구 활용법','쇼츠 제작에 필요한 AI 도구','블로그에 쓰는 AI 도구 정리','AI로 대본 만드는 방법','이미지 프롬프트 잘 쓰는 법','AI 도구 선택 기준','초보가 피해야 할 AI 실수','AI 자동화 시작 순서','ChatGPT 활용 쇼츠 주제'],
  '자기계발': ['미루는 습관 끊는 방법','하루를 다시 잡는 루틴','작게 성공하는 사람의 습관','의욕 없을 때 시작하는 법','무너진 계획 다시 세우기','시간을 아끼는 현실 습관','자존감보다 중요한 꾸준함','나를 바꾸는 5분 루틴','성장하는 사람이 조용히 하는 일','포기하지 않는 기준'],
  '연애': ['말 한마디로 멀어지는 순간','상대 마음을 지치게 하는 습관','오래 가는 관계의 기준','연락 때문에 힘들 때 보는 말','좋은 사람 고르는 현실 기준','이별 후 마음 정리하는 법','관계에서 나를 잃지 않는 법','사소한 배려가 중요한 이유','서운함을 말하는 방법','혼자만 애쓰는 관계 체크'],
  '가족': ['가족에게 상처받은 날','말하지 못한 마음을 전하는 법','부모님과 대화가 어려울 때','가족 사이에도 필요한 거리','고마움을 표현하는 작은 방법','집에서 마음이 지칠 때','가족 갈등 줄이는 말습관','내 편이 필요했던 하루','가족에게 기대를 내려놓는 법','가까워서 더 조심해야 하는 말'],
  '건강일상': ['무리하지 않고 몸 챙기는 습관','하루 컨디션을 망치는 습관','잠을 방해하는 생활 패턴','걷기가 주는 일상 변화','피곤한 날 루틴 정리','물 마시는 습관 만들기','오래 앉아 있을 때 체크할 것','아침을 가볍게 시작하는 법','스트레스 줄이는 생활 루틴','지친 하루 회복 습관'],
  '유머': ['요즘 사람들 공감 웃긴 순간','직장인 현실 공감 상황','사장님만 아는 웃픈 순간','나만 그런 줄 알았던 습관','카톡 답장 늦는 사람 특징','월요일 아침 현실 반응','배달음식 고를 때 생기는 일','혼자 있을 때 하는 이상한 행동','돈 쓸 때와 아낄 때 차이','쇼츠용 짧은 공감 유머'],
  '역사': ['역사 속 의외의 선택','알고 보면 흥미로운 사건','짧게 보는 한국사 이야기','세계사 속 반전 장면','역사 인물의 결정적 순간','오늘과 연결되는 역사 이야기','1분 역사 상식','잘 알려지지 않은 역사 이야기','역사에서 배우는 현실 교훈','사람들이 오해하는 역사 상식'],
  '직접입력': ['직접 입력할 주제를 적어주세요','내 사업 홍보용 쇼츠 대본','내 가게 소개 쇼츠 대본','내 서비스 설명 쇼츠 대본','고객 공감형 쇼츠 대본','문제 해결형 쇼츠 대본','후기형 쇼츠 대본','정보형 쇼츠 대본','감성형 쇼츠 대본','판매 연결형 쇼츠 대본']
};

function getTodayKoreanDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getScriptApiProvider() {
  return $('scriptApiProvider')?.value || 'openai';
}

function getScriptApiKeyStorageName(provider = getScriptApiProvider()) {
  return `${SENIAL_API_KEY_STORAGE}_${provider}`;
}

function setApiCheckStatus(text, mode = 'fail') {
  const el = $('apiCheckStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('checking', 'ok', 'fail');
  el.classList.add(mode);
}


function initApiKeyEyeToggle() {
  const input = $('openaiApiKey');
  const btn = $('btnToggleApiKey');
  if (!input || !btn || btn.dataset.ready === '1') return;
  btn.dataset.ready = '1';
  input.type = 'password';
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
  });
}

function clearStoredScriptApiKeys() {
  ['openai', 'gemini', 'claude'].forEach((provider) => {
    localStorage.removeItem(getScriptApiKeyStorageName(provider));
    localStorage.removeItem(`${SENIAL_API_CHECK_STORAGE}_${provider}`);
  });
  localStorage.removeItem(SENIAL_API_KEY_STORAGE);
}

function loadSavedApiKey() {
  const input = $('openaiApiKey');
  const provider = $('scriptApiProvider');
  if (provider) provider.value = localStorage.getItem(SENIAL_API_PROVIDER_STORAGE) || provider.value || 'openai';
  clearStoredScriptApiKeys();
  if (!input) return;
  input.value = '';
  input.type = 'password';
  setApiCheckStatus('확인안됨', 'fail');
}

function saveApiKeyFromInput() {
  const input = $('openaiApiKey');
  const provider = getScriptApiProvider();
  localStorage.setItem(SENIAL_API_PROVIDER_STORAGE, provider);
  if (!input) return;
  const key = String(input.value || '').trim();
  if (key) {
    sessionStorage.setItem(getScriptApiKeyStorageName(provider), key);
  } else {
    sessionStorage.removeItem(getScriptApiKeyStorageName(provider));
    localStorage.removeItem(getScriptApiKeyStorageName(provider));
  }
}

function handleScriptApiProviderChange() {
  const provider = getScriptApiProvider();
  localStorage.setItem(SENIAL_API_PROVIDER_STORAGE, provider);
  const saved = sessionStorage.getItem(getScriptApiKeyStorageName(provider)) || '';
  if ($('openaiApiKey')) {
    $('openaiApiKey').value = saved;
    $('openaiApiKey').type = 'password';
  }
  setApiCheckStatus('확인안됨', 'fail');
}

function openScriptApiSite() {
  const url = SENIAL_SCRIPT_API_LINKS[getScriptApiProvider()] || SENIAL_SCRIPT_API_LINKS.openai;
  window.open(url, '_blank', 'noopener');
}

function initScriptTopicChips() {
  const box = $('scriptTopicChips');
  if (!box || box.dataset.ready === '1') return;
  box.dataset.ready = '1';
  box.innerHTML = SENIAL_TOPIC_LIST.map((name, idx) => `<button type="button" class="topicChip${idx === 0 ? ' active' : ''}" data-topic="${name}">${name}</button>`).join('');
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-topic]');
    if (!btn) return;
    const topic = btn.dataset.topic || '상식';
    clearScriptSceneStateForNewTopic('키워드 변경');
    box.querySelectorAll('.topicChip').forEach(b => b.classList.toggle('active', b === btn));
    if ($('scriptCategory')) $('scriptCategory').value = topic;
    if ($('scriptTopic')) $('scriptTopic').value = '';
    makeSeoKeywords(true);
  });
  $('scriptCategory')?.addEventListener('change', () => {
    const val = $('scriptCategory').value;
    clearScriptSceneStateForNewTopic('카테고리 변경');
    box.querySelectorAll('.topicChip').forEach(b => b.classList.toggle('active', b.dataset.topic === val));
    if ($('scriptTopic')) $('scriptTopic').value = '';
    makeSeoKeywords(true);
  });
  $('topicSuggestionBox')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-topic]');
    if (!btn) return;
    selectScriptTopic(btn.dataset.topic || '');
  });
}

function syncScriptEditors(source) {
  const left = $('generatedScript');
  const right = $('rightScriptEditor');
  if (!left || !right) return;
  if (source === 'right') left.value = right.value;
  else right.value = left.value;
}

function setScriptIntoEditors(script) {
  const clean = sanitizeGeneratedScript(script);
  if ($('generatedScript')) $('generatedScript').value = clean;
  if ($('rightScriptEditor')) $('rightScriptEditor').value = clean;
  return clean;
}


function cleanSeoTopicText(value) {
  return String(value || '')
    .replace(/^[\s\d.)\-–—]+/g, '')
    .replace(/^\d{4}[-./년\s]+\d{1,2}[-./월\s]+\d{1,2}\s*/g, '')
    .replace(/^\d{1,2}\s+/g, '')
    .replace(/\s*(트렌드|쇼츠|추천|요즘|핵심정리|1분요약)$/g, '')
    .replace(/["“”‘’`!！#*_>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueLines(lines) {
  const seen = new Set();
  return (lines || [])
    .map((line) => sanitizeGeneratedScript(line))
    .map((line) => line.replace(/^[\s\d.)\-–—]+/g, '').trim())
    .filter(Boolean)
    .filter((line) => {
      const key = plainKey(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function categorySeoScriptLines(category, topic, request) {
  const t = cleanSeoTopicText(topic || category);
  const tone = request ? `${request} 방향으로` : '짧고 현실적으로';
  const templates = {
    '상식': [
      `혹시 ${t} 제대로 알고 있다고 생각했나요`,
      `의외로 많은 사람이 여기서 손해를 봅니다`,
      `핵심은 복잡한 설명보다 기준 하나를 잡는 겁니다`,
      `먼저 지금 내 상황에 바로 적용되는지 확인하세요`,
      `그다음 비용 시간 위험을 따로 나눠보면 답이 빨라집니다`,
      `작은 차이를 먼저 잡는 사람이 결국 덜 헤맵니다`,
      `${tone} 정리하면 아는 것보다 바로 쓰는 게 중요합니다`,
      `저장해두고 필요할 때 다시 확인하세요`
    ],
    '명언': [
      `오늘 마음이 무거웠다면 이 말만 기억하세요`,
      `버티는 시간도 분명히 앞으로 가는 시간입니다`,
      `남들은 결과만 보지만 나는 과정을 지나고 있습니다`,
      `늦은 게 아니라 아직 끝까지 안 간 겁니다`,
      `작게라도 움직인 하루는 절대 헛되지 않습니다`,
      `무너진 날에도 다시 일어나는 사람이 결국 남습니다`,
      `${tone} 오늘은 스스로를 너무 몰아붙이지 마세요`,
      `이 말이 필요한 사람에게 조용히 보내주세요`
    ],
    '뉴스': [
      `요즘 ${t} 흐름을 어렵게 볼 필요 없습니다`,
      `핵심은 지금 사람들이 어디에 관심을 두는지입니다`,
      `큰 변화보다 생활에 바로 닿는 부분부터 봐야 합니다`,
      `돈 시간 일상과 연결되는 신호를 먼저 확인하세요`,
      `확정되지 않은 말보다 반복되는 흐름이 더 중요합니다`,
      `오늘 기준으로는 빠른 판단보다 차분한 확인이 필요합니다`,
      `${tone} 복잡한 뉴스는 기준만 잡으면 쉬워집니다`,
      `다음 흐름도 쉽게 정리해서 알려드릴게요`
    ],
    '감성': [
      `혹시 오늘도 아무도 몰라주는 하루를 버텼나요`,
      `괜찮은 척했지만 사실은 많이 지쳤을지도 모릅니다`,
      `그래도 당신은 오늘 하루를 끝까지 지나왔습니다`,
      `남들이 모르는 노력은 사라지는 게 아닙니다`,
      `조용히 견딘 시간도 분명히 내 안에 남습니다`,
      `지금 당장 달라지지 않아도 괜찮습니다`,
      `${tone} 오늘만큼은 나에게 조금 다정해져도 됩니다`,
      `이 영상은 오늘 버틴 당신에게 남깁니다`
    ],
    '부업': [
      `부업을 시작하기 전에 이 기준부터 보세요`,
      `많이 버는 방법보다 먼저 안 잃는 구조가 중요합니다`,
      `처음부터 큰돈을 쓰면 오래 버티기 어렵습니다`,
      `내 시간 내 기술 내 고객을 먼저 나눠보세요`,
      `반복해서 팔 수 있는 작은 상품이 가장 현실적입니다`,
      `AI는 돈을 대신 벌어주는 게 아니라 시간을 줄여주는 도구입니다`,
      `${tone} 작게 테스트하고 반응이 있으면 키우세요`,
      `부업 시작 전 이 기준은 꼭 저장하세요`
    ],
    '돈관리': [
      `돈이 안 모일 때는 수입보다 새는 돈부터 봐야 합니다`,
      `매달 반복되는 고정비가 가장 먼저 점검할 부분입니다`,
      `작은 소비도 기록하면 패턴이 바로 보입니다`,
      `돈 관리는 참는 게 아니라 순서를 정하는 일입니다`,
      `필요한 지출과 습관적 지출을 나누면 훨씬 쉬워집니다`,
      `처음 목표는 큰 금액보다 한 달 흐름을 잡는 겁니다`,
      `${tone} 오늘 한 가지만 줄여도 시작은 충분합니다`,
      `이 기준 저장하고 이번 달부터 바로 확인하세요`
    ],
    '사업': [
      `자영업자가 바로 점검할 건 매출만이 아닙니다`,
      `손님이 줄면 광고보다 먼저 기본 세팅을 봐야 합니다`,
      `가게 설명 사진 후기 동선이 흐트러지면 선택받기 어렵습니다`,
      `온라인에서 찾기 쉬운 가게가 오프라인에서도 유리합니다`,
      `처음 보는 고객은 작은 불편 하나로 바로 지나갑니다`,
      `그래서 지금은 큰 투자보다 빠른 점검이 먼저입니다`,
      `${tone} 오늘은 내 가게가 검색에서 어떻게 보이는지 확인하세요`,
      `사장님이라면 이 기준은 꼭 저장하세요`
    ],
    '맛집': [
      `맛집을 고를 때 리뷰 숫자만 보면 실패할 수 있습니다`,
      `진짜 봐야 할 건 최근 사진과 반복되는 평가입니다`,
      `맛 분위기 친절 가격 중 무엇이 강점인지 먼저 보세요`,
      `메뉴가 많다고 좋은 게 아니라 대표 메뉴가 분명해야 합니다`,
      `동네 맛집은 화려함보다 다시 가고 싶은 이유가 중요합니다`,
      `리뷰 문장이 비슷하면 조금 더 확인하는 게 좋습니다`,
      `${tone} 실패 줄이는 맛집 기준은 생각보다 단순합니다`,
      `다음 맛집 고를 때 이 기준으로 비교해보세요`
    ],
    '여행': [
      `여행은 멀리 가는 것보다 만족도가 먼저입니다`,
      `일정이 빡빡하면 좋은 장소도 피곤한 기억으로 남습니다`,
      `처음엔 이동시간 식사 휴식만 먼저 잡으세요`,
      `사진 명소보다 내 컨디션에 맞는 코스가 더 중요합니다`,
      `예산은 숙소 교통 식비를 나눠야 새는 돈이 줄어듭니다`,
      `가까운 여행도 기준만 잡으면 충분히 특별해집니다`,
      `${tone} 이번 여행은 욕심보다 여유를 먼저 챙기세요`,
      `여행 전 이 체크리스트는 저장해두세요`
    ],
    '인테리어': [
      `인테리어 견적 전에 꼭 봐야 할 게 있습니다`,
      `예쁜 디자인보다 먼저 동선과 사용 목적이 정해져야 합니다`,
      `철거 전기 설비 마감 순서를 모르면 비용이 늘어납니다`,
      `사진만 보고 결정하면 실제 현장에서 차이가 커질 수 있습니다`,
      `작은 매장일수록 조명 색상 수납이 분위기를 좌우합니다`,
      `계약 전에는 공사 범위와 빠지는 항목을 꼭 확인하세요`,
      `${tone} 인테리어는 시작 전 정리가 절반입니다`,
      `공사 준비 중이라면 이 기준을 저장하세요`
    ],
    '방수공사': [
      `누수는 물이 샌 뒤보다 그 전 신호가 더 중요합니다`,
      `옥상 바닥 갈라짐 들뜸 고임은 그냥 넘기면 안 됩니다`,
      `방수공사는 칠하는 것보다 바탕 정리가 먼저입니다`,
      `비 오기 전 작은 틈을 잡아야 큰 비용을 막을 수 있습니다`,
      `견적을 볼 때는 자재보다 시공 범위와 보수 조건을 확인하세요`,
      `겉은 멀쩡해 보여도 물길은 안쪽에서 이미 생길 수 있습니다`,
      `${tone} 장마 전에는 한 번만이라도 점검하는 게 좋습니다`,
      `건물 관리 중이라면 이 기준 꼭 저장하세요`
    ],
    '자동화': [
      `자동화는 어려운 기술보다 반복업무를 찾는 것부터 시작입니다`,
      `매일 똑같이 하는 일이 있다면 줄일 수 있는 후보입니다`,
      `글쓰기 정리 고객응대 자료관리부터 먼저 보면 됩니다`,
      `처음부터 완전 자동을 바라보면 오히려 막힙니다`,
      `반자동으로 시간을 줄이고 결과를 확인하는 게 현실적입니다`,
      `AI 도구는 사람을 빼는 게 아니라 손을 덜어주는 역할입니다`,
      `${tone} 오늘 반복되는 일 하나만 자동화 후보로 적어보세요`,
      `사장님이라면 이 흐름은 꼭 기억하세요`
    ],
    'AI도구': [
      `AI 도구를 쓸 때 제일 중요한 건 질문입니다`,
      `좋은 답은 좋은 프롬프트에서 시작됩니다`,
      `무엇을 만들지 누구에게 보여줄지 먼저 정해야 합니다`,
      `대본 이미지 제목을 따로 만들면 결과가 더 깔끔합니다`,
      `처음부터 완벽하게 만들기보다 수정하면서 맞추는 게 빠릅니다`,
      `AI는 대신 생각하는 도구가 아니라 작업 속도를 올리는 도구입니다`,
      `${tone} 오늘은 한 가지 작업에만 AI를 써보세요`,
      `초보라면 이 순서부터 저장하세요`
    ],
    '자기계발': [
      `계획이 자꾸 무너진다면 의지가 약한 게 아닐 수 있습니다`,
      `목표가 너무 크면 시작 전부터 지치기 쉽습니다`,
      `처음엔 하루 5분처럼 실패하기 어려운 단위로 줄이세요`,
      `꾸준함은 감정이 아니라 환경으로 만드는 겁니다`,
      `할 일을 줄이면 오히려 실행률이 올라갑니다`,
      `작은 성공이 쌓이면 자신감은 뒤따라옵니다`,
      `${tone} 오늘은 딱 하나만 끝내도 충분합니다`,
      `다시 시작하고 싶다면 이 기준을 저장하세요`
    ],
    '연애': [
      `관계가 힘들 때는 사랑보다 말투를 먼저 봐야 합니다`,
      `서운함을 참기만 하면 결국 더 크게 터집니다`,
      `상대가 알아주길 기다리기보다 차분히 표현하는 게 중요합니다`,
      `좋은 관계는 매번 맞는 사람이 아니라 조율하는 사람입니다`,
      `혼자만 애쓰는 관계라면 잠시 멈춰서 봐야 합니다`,
      `내 마음을 잃지 않는 것도 사랑의 기준입니다`,
      `${tone} 오래 가는 관계는 작은 배려에서 갈립니다`,
      `지금 떠오르는 사람이 있다면 이 말을 기억하세요`
    ],
    '가족': [
      `가족이라서 더 쉽게 상처 주는 말이 있습니다`,
      `가깝다는 이유로 마음을 다 아는 건 아닙니다`,
      `고마움도 미안함도 미루면 점점 말하기 어려워집니다`,
      `가족 사이에도 적당한 거리와 표현이 필요합니다`,
      `작은 말 한마디가 분위기를 바꿀 수 있습니다`,
      `이해받기 전에 먼저 차분히 전하는 연습이 필요합니다`,
      `${tone} 오늘 한 마디만 부드럽게 바꿔보세요`,
      `가족 때문에 마음이 복잡했다면 저장해두세요`
    ],
    '건강일상': [
      `컨디션이 자주 무너지면 생활 흐름부터 봐야 합니다`,
      `잠 식사 움직임은 생각보다 하루 기분을 크게 바꿉니다`,
      `무리한 계획보다 지킬 수 있는 작은 루틴이 먼저입니다`,
      `오래 앉아 있다면 중간에 몸을 풀어주는 습관이 필요합니다`,
      `물 마시기 걷기 정리만 해도 하루가 조금 가벼워집니다`,
      `중요한 건 한 번에 바꾸는 게 아니라 반복하는 겁니다`,
      `${tone} 오늘은 몸이 덜 지치는 선택 하나만 해보세요`,
      `일상 루틴이 필요하다면 이 기준을 저장하세요`
    ],
    '유머': [
      `나만 그런 줄 알았는데 다들 이러고 삽니다`,
      `아낄 때는 천 원도 아까운데 쓸 때는 갑자기 대범해집니다`,
      `월요일 아침엔 몸보다 마음이 먼저 출근을 거부합니다`,
      `배달앱 켜면 다이어트는 잠시 회의 들어갑니다`,
      `카톡 답장은 늦게 하면서 알림은 누구보다 빨리 봅니다`,
      `현실은 웃긴데 막상 내 일이면 안 웃깁니다`,
      `${tone} 그래도 이런 게 사는 재미일지도 모릅니다`,
      `공감되면 조용히 저장해두세요`
    ],
    '역사': [
      `역사는 외우는 게 아니라 선택을 보는 겁니다`,
      `큰 사건 뒤에는 늘 작은 판단들이 쌓여 있습니다`,
      `당시에는 당연했던 결정도 시간이 지나면 다르게 보입니다`,
      `그래서 역사는 현재를 이해하는 좋은 기준이 됩니다`,
      `사람은 시대가 달라도 비슷한 고민을 반복합니다`,
      `과거의 실수와 선택을 보면 오늘의 판단이 조금 선명해집니다`,
      `${tone} 짧은 역사 이야기도 현실의 힌트가 됩니다`,
      `이런 역사 상식이 좋다면 저장해두세요`
    ],
    '직접입력': [
      `혹시 ${t}를 어떻게 알려야 할지 고민하고 있나요`,
      `처음 보는 사람은 긴 설명보다 바로 이해되는 기준을 원합니다`,
      `먼저 어떤 문제를 해결하는지 한 문장으로 잡아야 합니다`,
      `그다음 왜 지금 필요한지 쉽게 보여주세요`,
      `복잡한 장점보다 고객이 바로 느끼는 변화가 중요합니다`,
      `마지막에는 다음 행동을 분명하게 안내해야 합니다`,
      `${tone} 설명은 짧게 혜택은 선명하게 가야 합니다`,
      `이 구조로 소개하면 훨씬 쉽게 전달됩니다`
    ]
  };
  return uniqueLines(templates[category] || templates['상식']);
}

function buildLocalSeoScript() {
  makeSeoKeywords(false);
  const category = $('scriptCategory')?.value || '상식';
  const picked = cleanSeoTopicText($('scriptTopic')?.value || '');
  const topic = picked || cleanSeoTopicText($('autoSeedTopic')?.value || '') || cleanSeoTopicText(getTopicSuggestions(category)[0] || category);
  const request = String($('scriptRequest')?.value || '').trim();
  const lines = categorySeoScriptLines(category, topic, request);
  return lines.join('\n');
}

function sanitizeGeneratedScript(text) {
  const cleaned = stripLabels(String(text || ''))
    .replace(/["“”‘’`!！]/g, '')
    .replace(/[\[#*_>|]/g, '')
    .replace(/^\s*(제목|해시태그|태그|설명|썸네일|SEO)\s*[:：].*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned
    .split('\n')
    .map((line) => line
      .replace(/^\s*\d{4}[-./년\s]+\d{1,2}[-./월\s]+\d{1,2}\s*/g, '')
      .replace(/^\s*\d{1,2}\s+(?=[가-힣A-Za-z])/g, '')
      .replace(/^\s*\d+\s*[.)-]\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .filter((line, idx, arr) => !idx || plainKey(line) !== plainKey(arr[idx - 1]))
    .join('\n')
    .trim();
}

const SENIAL_TOPIC_ROTATION_STATE = {};
const SENIAL_GENERATED_TOPIC_HISTORY = {};

function rememberGeneratedTopics(scope, topics) {
  const key = scope || 'default';
  const prev = SENIAL_GENERATED_TOPIC_HISTORY[key] || [];
  const merged = prev.concat(topics || []).filter(Boolean);
  const seen = new Set();
  SENIAL_GENERATED_TOPIC_HISTORY[key] = merged.filter((item) => {
    const k = plainKey(item);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(-80);
}

function getGeneratedTopicHistory(scope) {
  return SENIAL_GENERATED_TOPIC_HISTORY[scope || 'default'] || [];
}


function inferTopicMood(seed) {
  const text = String(seed || '');
  if (/위로|지친|힘든|마음|버텨|외로|상처|무너|눈물|괜찮/.test(text)) return 'comfort';
  if (/돈|부업|수익|창업|사업|매출|자동화|AI|블로그|쇼츠/.test(text)) return 'business';
  if (/여행|맛집|카페|데이트|코스/.test(text)) return 'life';
  return 'general';
}

function buildKeywordLocalTopics(seed, count = 10) {
  const clean = cleanSeoTopicText(seed || '');
  if (!clean) return [];
  const mood = inferTopicMood(clean);
  const banks = {
    comfort: [
      `오늘도 버틴 나에게 필요한 위로`,
      `삶에 지친 마음을 다독이는 말`,
      `아무도 몰라줘도 괜찮은 이유`,
      `힘든 하루 끝에 나를 살리는 문장`,
      `무너진 마음을 다시 세우는 생각`,
      `포기하고 싶을 때 기억할 한마디`,
      `괜찮은 척 지친 사람에게`,
      `내 편이 필요했던 하루의 위로`,
      `조용히 견디는 사람에게 필요한 말`,
      `오늘만큼은 나에게 다정해지는 법`
    ],
    business: [
      `${clean} 시작 전 꼭 봐야 할 기준`,
      `${clean}으로 시간 줄이는 현실 방법`,
      `${clean} 초보가 놓치는 포인트`,
      `${clean} 작게 테스트하는 방법`,
      `${clean} 실패 줄이는 체크리스트`,
      `${clean} 바로 적용하는 1분 정리`,
      `${clean} 요즘 흐름 쉽게 보기`,
      `${clean} 돈 새는 부분 잡는 법`,
      `${clean} 사장님이 먼저 봐야 할 것`,
      `${clean} 현실적으로 시작하는 순서`
    ],
    life: [
      `${clean} 고를 때 실패 줄이는 기준`,
      `${clean} 요즘 사람들이 찾는 이유`,
      `${clean} 처음이라면 꼭 볼 포인트`,
      `${clean} 만족도 높이는 현실 팁`,
      `${clean} 가볍게 즐기는 방법`,
      `${clean} 사진보다 중요한 기준`,
      `${clean} 후회 줄이는 체크리스트`,
      `${clean} 하루 코스로 보는 방법`,
      `${clean} 숨은 포인트 정리`,
      `${clean} 초보도 쉽게 보는 기준`
    ],
    general: [
      `${clean} 핵심만 쉽게 정리`,
      `${clean} 지금 알아두면 좋은 이유`,
      `${clean} 처음 보면 헷갈리는 부분`,
      `${clean} 바로 써먹는 현실 기준`,
      `${clean} 사람들이 자주 놓치는 것`,
      `${clean} 1분 안에 이해하기`,
      `${clean} 요즘 기준으로 다시 보기`,
      `${clean} 실수 줄이는 체크리스트`,
      `${clean} 알아두면 도움 되는 포인트`,
      `${clean} 쉽게 보는 핵심 흐름`
    ]
  };
  return uniqueLines(banks[mood]).slice(0, count);
}

function getTopicSuggestions(category, forceNew = false) {
  const base = SENIAL_TOPIC_SUGGESTIONS[category] || SENIAL_TOPIC_SUGGESTIONS['상식'];
  if (!forceNew) return base.slice(0, 10);

  const key = category || '상식';
  const count = (SENIAL_TOPIC_ROTATION_STATE[key] || 0) + 1;
  SENIAL_TOPIC_ROTATION_STATE[key] = count;

  const today = getTodayKoreanDate();
  const hooks = [
    '요즘 다시 뜨는',
    '오늘 사람들이 찾는',
    '의외로 모르는',
    '지금 알아두면 좋은',
    '초보도 바로 쓰는',
    '50대도 이해하는',
    '하루 1분 핵심',
    '요즘 기준 바뀐'
  ];
  const tails = [
    '현실 체크',
    '핵심 정리',
    '실전 기준',
    '놓치기 쉬운 포인트',
    '바로 써먹는 방법',
    '1분 요약',
    '반드시 볼 흐름',
    '쉽게 보는 기준'
  ];

  const expanded = [];
  base.forEach((topic, idx) => {
    const hook = hooks[(idx + count) % hooks.length];
    const tail = tails[(idx * 2 + count) % tails.length];
    const short = String(topic).replace(/^요즘\s*/, '').replace(/\s*(정리|방법|기준|흐름|체크리스트)$/g, '').trim();
    expanded.push(topic);
    expanded.push(`${hook} ${short}`);
    expanded.push(`${short} ${tail}`);
    expanded.push(`${today} ${short} 트렌드`);
  });

  const start = (count * 7) % Math.max(1, expanded.length);
  const rotated = expanded.slice(start).concat(expanded.slice(0, start));
  const seen = new Set();
  return rotated.filter((item) => {
    const clean = String(item || '').replace(/["“”‘’`!！#*_>|]/g, '').trim();
    const k = plainKey(clean);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 10);
}

function renderTopicSuggestions(selectedTopic = '', topicsOverride = null) {
  const box = $('topicSuggestionBox');
  if (!box) return;
  const category = $('scriptCategory')?.value || '상식';
  const topics = Array.isArray(topicsOverride) ? topicsOverride : getTopicSuggestions(category);
  box.innerHTML = topics.map((topic) => {
    const active = topic === selectedTopic ? ' active' : '';
    const safeTopic = String(topic).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<button type="button" class="topicPickBtn${active}" data-topic="${safeTopic}"><span>${safeTopic}</span><b>고르기</b></button>`;
  }).join('');
}


function clearScriptSceneStateForNewTopic(reason = '주제 변경') {
  // 주제/카테고리가 바뀌면 이전 대본·장면·이미지·썸네일 프롬프트가 섞이지 않도록 작업 데이터를 분리 초기화한다.
  finishPreview(true);
  state.captions = [];
  state.scenes = [];
  state.images = [];
  state.selectedCaptionId = null;
  state.thumbnail = { image: null, imageObj: null, prompt: '', text: '', style: $('imageStyle')?.value || 'photo-person-bg' };
  ['generatedScript', 'rightScriptEditor', 'ttsText', 'imagePromptList'].forEach((id) => {
    if ($(id)) $(id).value = '';
  });
  const link = $('downloadLink');
  if (link) {
    link.removeAttribute('href');
    link.textContent = 'WEBM 생성 후 다운로드 가능';
    link.classList.add('disabledDownload');
  }
  resetRenderProgress();
  renderThumbnailPreview();
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
  log(`${reason}: 이전 대본과 장면을 초기화했습니다.`);
}

function retimeExistingCaptionsToDuration(totalDuration) {
  const total = Number(totalDuration) || 0;
  if (!state.captions.length || total <= 0) return false;
  const styleFallback = collectCaptionStyle();

  // 음성 재적용 때 자막칸 수를 바꾸면 싱크가 더 망가진다. 기존 칸 수 그대로 시간만 다시 잡는다.
  const parts = state.captions.map((cap) => removeTailRepeat(cap.text)).filter(Boolean);
  if (!parts.length) return false;

  const oldStyles = state.captions.map((cap) => ({ ...(cap.captionStyle || styleFallback) }));
  const oldIds = state.captions.map((cap) => cap.id);
  const rebuilt = buildCaptionTimeline(parts, total, styleFallback, state.audioProfile);
  state.captions = rebuilt.map((cap, idx) => ({
    ...cap,
    id: oldIds[idx] || cap.id,
    captionStyle: oldStyles[idx] || cap.captionStyle || { ...styleFallback }
  }));
  state.audioDuration = total;
  rebuildScenes();
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
  if (state.captions[0]) setActiveCaption(state.captions[0].id, false);
  log(`음성 길이 ${formatTime(total)} 기준으로 안정형+무음 HOLD 싱크를 다시 계산했습니다.`);
  return true;
}

async function selectScriptTopic(topic) {
  const clean = cleanSeoTopicText(topic);
  const prev = String($('scriptTopic')?.value || '').trim();
  if (clean && clean !== prev) clearScriptSceneStateForNewTopic('주제 변경');
  if ($('scriptTopic')) $('scriptTopic').value = clean;
  renderTopicSuggestions(clean);
  makeSeoKeywords(false);
  log(`주제 선택: ${clean}. 선택한 주제만 사용합니다.`);
  await generateSeoScriptByApi();
  $('rightScriptEditor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('rightScriptEditor')?.focus();
}

function makeSeoKeywords(showTopics = true, forceNewTopics = false, topicsOverride = null) {
  const category = $('scriptCategory')?.value || '상식';
  const currentTopic = String($('scriptTopic')?.value || '').trim();
  const topicList = Array.isArray(topicsOverride) ? topicsOverride : getTopicSuggestions(category, forceNewTopics);
  if (showTopics) renderTopicSuggestions(currentTopic, topicList);
  const manualSeed = cleanSeoTopicText($('autoSeedTopic')?.value || '');
  const topic = currentTopic || manualSeed || topicList[0] || category;
  const today = getTodayKoreanDate();
  const base = topic.replace(/["“”‘’`!！]/g, '').trim();
  const keywords = [
    `${base} 핵심`,
    `${base} 쇼츠`,
    `${base} 추천`,
    `${base} 요즘`,
    `${category} 핵심정리`,
    `${base} 1분요약`
  ];
  if ($('seoKeywordBox')) $('seoKeywordBox').value = Array.from(new Set(keywords)).join(', ');
  return $('seoKeywordBox')?.value || keywords.join(', ');
}

function buildTopicRefreshPrompt(seed, previousTopics = []) {
  const today = getTodayKoreanDate();
  const base = String(seed || '').trim() || '요즘 트렌드';
  const prev = previousTopics.length ? previousTopics.slice(-30).map((t, i) => `${i + 1}. ${t}`).join('\n') : '없음';
  return `너는 대한민국 유튜브 쇼츠 SEO 제목 전문가다.

[오늘 날짜]
${today}

[카테고리 또는 주제]
${base}

[이미 보여준 제목]
${prev}

[목표]
위 제목과 겹치지 않게 오늘 기준 SEO 트렌드형 쇼츠 제목 10개를 새로 생성하라.

[조건]
- 검색량이 높을 가능성이 있는 키워드 우선
- 요즘 트렌드 반영
- 클릭률 높은 제목
- 50대 이상도 이해하기 쉽게 작성
- 제목은 15자에서 25자 사이 권장
- 과장, 허위, 공포 조장 금지
- 건강일상 주제에서는 의사, 병원, 전문의 단어 금지
- 이전 제목과 중복 금지

[출력]
- 번호와 제목만 출력
- 설명, 해시태그, 따옴표, 느낌표 금지
- 한 줄에 제목 1개

지금 바로 새로운 제목 10개만 출력해라.`;
}

async function refreshScriptTopicsByKeyword() {
  const provider = getScriptApiProvider();
  const apiKey = String($('openaiApiKey')?.value || '').trim();
  const category = $('scriptCategory')?.value || '상식';
  const seed = String($('scriptTopic')?.value || '').trim() || category;
  const btn = $('btnMakeKeywords');
  if (btn) btn.disabled = true;

  try {
    let topics = [];
    if (apiKey) {
      saveApiKeyFromInput();
      const scope = `script:${category}:${seed}`;
      const raw = await callScriptProviderText(provider, apiKey, buildTopicRefreshPrompt(seed, getGeneratedTopicHistory(scope)), 700);
      topics = parseAutoTopics(raw).slice(0, 10);
      if (topics.length) rememberGeneratedTopics(scope, topics);
    }
    if (!topics.length) topics = getTopicSuggestions(category, true);
    if (topics.length) {
      clearScriptSceneStateForNewTopic('키워드 새로 생성');
      if ($('scriptTopic')) $('scriptTopic').value = '';
      makeSeoKeywords(true, false, topics);
      log(apiKey ? '키워드 기준으로 새로운 SEO 제목 10개를 생성했습니다.' : 'API 키가 없어 기본 제목을 다르게 섞어서 표시했습니다.');
    }
  } catch (err) {
    const topics = getTopicSuggestions(category, true);
    if ($('scriptTopic')) $('scriptTopic').value = '';
    makeSeoKeywords(true, false, topics);
    log(`키워드 제목 생성 실패: ${err.message || err}. 기본 제목을 다르게 표시했습니다.`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function buildSeoScriptPrompt() {
  const category = $('scriptCategory')?.value || '상식';
  const topic = String($('scriptTopic')?.value || '').trim();
  const request = String($('scriptRequest')?.value || '').trim();
  const keywordText = String($('seoKeywordBox')?.value || '').trim() || makeSeoKeywords();
  const lengthSec = Number($('scriptLength')?.value || 30);
  const targetLines = lengthSec <= 30 ? '7~9문장' : lengthSec <= 45 ? '9~12문장' : '12~15문장';
  const today = getTodayKoreanDate();

  return `너는 한국어 유튜브 쇼츠 SEO 대본 작가다.

[오늘 날짜]
${today}

[주제 카테고리]
${category}

[세부 주제]
${topic || category}

[상위노출 키워드]
${keywordText}

[추가 방향]
${request || '없음'}

[목표]
- ${lengthSec}초 내외 쇼츠 대본 작성
- 모바일 쇼츠에서 첫 3초 이탈률을 낮추는 구조
- 상위노출 키워드를 자연스럽게 포함하되 억지 반복 금지
- 첫 문장은 강한 후킹
- 끝 문장은 저장, 공유, 댓글을 유도하되 과장하지 않기

[절대 규칙]
- 출력은 대본 본문만 작성
- 제목, 설명, 해시태그, 번호, 단계명 쓰지 않기
- 따옴표, 느낌표, 특수문자 쓰지 않기
- 한 문장은 짧게
- 한 줄은 18자 안팎으로 모바일 자막에 맞게 작성
- 총 ${targetLines}으로 작성
- 같은 문장 반복 금지
- 확인되지 않은 사실을 단정하지 않기
- 뉴스 주제는 실시간 검색 결과를 확인할 수 없으면 확정 표현 대신 ${today} 기준 최근 흐름 중심으로 작성
- 건강일상 주제에서는 의사, 병원, 전문의 단어와 의료진 이미지 연상 표현 금지

[대본 구조]
1문장 강한 후킹
2문장 공감 또는 문제 제기
3~80퍼센트 핵심 정보와 이유
마지막 문장 저장/댓글 유도

지금 바로 대본만 작성해라.`;
}


function buildAutoTopicPrompt(seed) {
  const today = getTodayKoreanDate();
  const base = String(seed || '').trim() || '요즘 트렌드';
  return `너는 대한민국 유튜브 쇼츠 SEO 전문가이자 트렌드 분석가다.

[오늘 날짜]
${today}

[사용자가 입력한 주제 또는 카테고리]
${base}

[목표]
대한민국 사용자가 오늘 기준 관심 가질 만한 쇼츠 주제 20개를 생성하라.

[생성 기준]
- 오늘 날짜 기준 최신 흐름과 요즘 트렌드 반영
- 검색량이 높을 가능성이 있는 키워드 우선
- 유튜브 쇼츠 제목으로 바로 쓸 수 있게 작성
- 50대 이상도 이해하기 쉬운 제목
- 클릭률 높은 후킹형 제목
- 과장, 허위, 공포 조장 금지
- 서로 다른 주제만 생성
- 제목은 15자에서 25자 사이 권장
- 건강일상 주제에서는 의사, 병원, 전문의 단어 금지

[출력 규칙]
- 번호와 제목만 출력
- 설명, 해시태그, 따옴표, 느낌표 금지
- 한 줄에 주제 1개

예시 형식
1. 50대가 가장 후회하는 소비
2. AI로 줄이는 반복 업무

지금 바로 주제 20개만 출력해라.`;
}

function parseAutoTopics(text) {
  const seen = new Set();
  return String(text || '')
    .split(/\n+/)
    .map((line) => line
      .replace(/^\s*\d+\s*[.)-]?\s*/g, '')
      .replace(/^\s*[-•*]\s*/g, '')
      .replace(/^(제목|주제)\s*[:：]\s*/g, '')
      .replace(/["“”‘’`!！#*_>|]/g, '')
      .trim())
    .filter((line) => line.length >= 3)
    .filter((line) => {
      const key = plainKey(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

async function callOpenAiText(apiKey, prompt, systemText = '너는 한국어 콘텐츠 생성 전문가다. 요청한 형식만 출력한다.', maxTokens = 900) {
  const res = await fetch(SENIAL_OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: SENIAL_SCRIPT_API_MODEL,
      temperature: 0.85,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI API 오류 ${res.status}`);
  return data?.choices?.[0]?.message?.content || '';
}

async function callScriptProviderText(provider, apiKey, prompt, maxTokens = 900) {
  if (provider === 'gemini') return callGeminiScript(apiKey, prompt);
  if (provider === 'claude') return callClaudeScript(apiKey, prompt);
  return callOpenAiText(apiKey, prompt, '너는 대한민국 유튜브 쇼츠 SEO 전문가다. 요청한 형식만 출력한다.', maxTokens);
}

function renderAutoTopicResults(topics, selected = '') {
  const box = $('autoTopicResultBox');
  if (!box) return;
  if (!topics.length) {
    box.innerHTML = '<div class="hint">생성된 주제가 없습니다.</div>';
    return;
  }
  box.innerHTML = topics.map((topic) => {
    const active = topic === selected ? ' active' : '';
    const safeTopic = String(topic || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<button type="button" class="autoTopicPickBtn${active}" data-auto-topic="${safeTopic}"><span>${safeTopic}</span><b>고르기</b></button>`;
  }).join('');
}

async function generateAutoModeTopics() {
  const provider = getScriptApiProvider();
  const apiKey = String($('openaiApiKey')?.value || '').trim();
  const seed = String($('autoSeedTopic')?.value || '').trim() || String($('scriptCategory')?.value || '').trim() || '요즘 트렌드';
  const scope = `auto:${seed}`;
  const btn = $('btnAutoTopicGenerate');
  if (btn) btn.disabled = true;
  if ($('autoStyleBox')) $('autoStyleBox').style.display = 'none';
  log('올자동모드 주제를 오늘 날짜와 SEO 기준으로 생성 중입니다.');

  try {
    let topics = [];
    if (apiKey) {
      saveApiKeyFromInput();
      const prompt = getGeneratedTopicHistory(scope).length ? buildTopicRefreshPrompt(seed, getGeneratedTopicHistory(scope)) : buildAutoTopicPrompt(seed);
      const raw = await callScriptProviderText(provider, apiKey, prompt, 900);
      topics = parseAutoTopics(raw);
      if (topics.length) rememberGeneratedTopics(scope, topics);
    }
    if (!topics.length) {
      const keywordTopics = buildKeywordLocalTopics(seed, 10);
      const category = SENIAL_TOPIC_SUGGESTIONS[seed] ? seed : ($('scriptCategory')?.value || '상식');
      topics = keywordTopics.length ? keywordTopics : getTopicSuggestions(category, true);
    }
    clearScriptSceneStateForNewTopic('올자동 주제 생성');
    if ($('scriptTopic')) $('scriptTopic').value = '';
    if ($('autoSeedTopic')) $('autoSeedTopic').value = seed;
    renderAutoTopicResults(topics);
    log(apiKey ? 'SEO 트렌드 주제 생성 완료. 고르기를 누른 주제 1개만 사용합니다.' : 'API 키가 없어도 입력한 주제 기준 후보를 표시했습니다. 고르기를 누른 주제 1개만 사용합니다.');
  } catch (err) {
    const category = $('scriptCategory')?.value || '상식';
    const fallbackTopics = buildKeywordLocalTopics(seed, 10);
    clearScriptSceneStateForNewTopic('올자동 주제 생성 실패 후 초기화');
    if ($('scriptTopic')) $('scriptTopic').value = '';
    if ($('autoSeedTopic')) $('autoSeedTopic').value = seed;
    renderAutoTopicResults(fallbackTopics.length ? fallbackTopics : getTopicSuggestions(category, true));
    log(`올자동 주제 생성 실패: ${err.message || err}. 입력 주제 기준 후보로 대신 표시했습니다.`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function selectAutoModeTopic(topic) {
  const clean = String(topic || '').replace(/["“”‘’`!！]/g, '').trim();
  if (!clean) return;
  const prev = String($('scriptTopic')?.value || '').trim();
  if (clean !== prev) clearScriptSceneStateForNewTopic('올자동 주제 변경');
  if ($('scriptTopic')) $('scriptTopic').value = clean;
  if ($('autoSeedTopic')) $('autoSeedTopic').value = clean;
  renderAutoTopicResults(Array.from(document.querySelectorAll('[data-auto-topic]')).map(b => b.dataset.autoTopic || b.textContent || '').filter(Boolean), clean);
  makeSeoKeywords(false);
  if ($('autoStyleBox')) $('autoStyleBox').style.display = 'block';
  log(`올자동 주제 선택: ${clean}. 이제 실사 또는 만화를 고르세요.`);
}

function openOndokuForVoice() {
  window.open('https://ondoku3.com/', '_blank', 'noopener');
}

async function runAutoModeFromTopic(version, kind) {
  setImageStyleFromAuto(version, kind);
  const script = await generateSeoScriptByApi();
  const text = $('rightScriptEditor')?.value || $('generatedScript')?.value || script || '';
  if (text) await navigator.clipboard?.writeText(text).catch(() => {});
  const panel = $('autoModePanel');
  if (panel) panel.style.display = 'none';

  if (state.audioFile) {
    await analyzeAudioAndCaptions();
    await generateAllImages();
    log('올자동 흐름 완료: 대본 생성 → 음성·자막 분석 → 장면 생성 → 이미지 프롬프트 생성까지 진행했습니다.');
  } else {
    renderEditor();
    const btn = $('btnTranscribe');
    btn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    log('대본을 복사했습니다. 오토쿠/클로바에서 음성을 만든 뒤 음성파일을 넣고 음성·자막 분석하기를 누르세요. 분석 완료 후 이미지 프롬프트가 정확히 맞습니다.');
  }
}

async function callOpenAiScript(apiKey, prompt) {
  const res = await fetch(SENIAL_OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: SENIAL_SCRIPT_API_MODEL,
      temperature: 0.8,
      max_tokens: 700,
      messages: [
        { role: 'system', content: '너는 한국어 유튜브 쇼츠 SEO 대본만 만드는 작가다. 설명 없이 대본만 출력한다.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI API 오류 ${res.status}`);
  return data?.choices?.[0]?.message?.content || '';
}

async function callGeminiScript(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${SENIAL_GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 700 } })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API 오류 ${res.status}`);
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n') || '';
}

async function callClaudeScript(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 700,
      temperature: 0.8,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API 오류 ${res.status}`);
  return data?.content?.map(part => part.text || '').join('\n') || '';
}

async function verifyScriptApiKey() {
  const provider = getScriptApiProvider();
  const apiKey = String($('openaiApiKey')?.value || '').trim();
  saveApiKeyFromInput();
  if (!apiKey) {
    setApiCheckStatus('확인안됨', 'fail');
    log('API 키를 먼저 붙여넣으세요.');
    return false;
  }
  setApiCheckStatus('확인중', 'checking');
  const btns = [$('btnCheckScriptApi'), $('btnCheckScriptApiRight')].filter(Boolean);
  btns.forEach(btn => btn.disabled = true);
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`GPT 확인 실패 ${res.status}`);
    } else if (provider === 'gemini') {
      await callGeminiScript(apiKey, '대답은 가능 한 단어만 출력');
    } else if (provider === 'claude') {
      await callClaudeScript(apiKey, '대답은 가능 한 단어만 출력');
    }
    setApiCheckStatus('확인', 'ok');
    localStorage.setItem(`${SENIAL_API_CHECK_STORAGE}_${provider}`, '확인');
    log(`${provider === 'openai' ? 'GPT' : provider === 'gemini' ? 'Gemini' : 'Claude'} API 확인 완료. 대본 생성할 수 있습니다.`);
    return true;
  } catch (err) {
    setApiCheckStatus('확인안됨', 'fail');
    localStorage.setItem(`${SENIAL_API_CHECK_STORAGE}_${provider}`, '확인안됨');
    log(`API 확인안됨: ${err.message || err}`);
    return false;
  } finally {
    btns.forEach(btn => btn.disabled = false);
  }
}

async function generateSeoScriptByApi() {
  const provider = getScriptApiProvider();
  const keyInput = $('openaiApiKey');
  const apiKey = String(keyInput?.value || '').trim();
  const topic = String($('scriptTopic')?.value || '').trim();
  if (!apiKey) {
    const script = setScriptIntoEditors(buildLocalSeoScript());
    createCaptionsFromScript();
    log('API Key가 없어 기본 대본을 대본 편집 칸에 생성했습니다. API 키를 넣으면 AI 대본으로 생성됩니다.');
    return script;
  }
  if (!topic && $('scriptCategory')?.value === '직접입력') {
    log('직접입력은 세부 주제를 먼저 적어야 합니다.');
    $('scriptTopic')?.focus();
    return '';
  }

  saveApiKeyFromInput();
  makeSeoKeywords();
  const btn = $('btnGenerateScript');
  if (btn) btn.disabled = true;
  log(`${provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude' : 'GPT'}로 SEO 대본 생성 중입니다.`);

  try {
    const prompt = buildSeoScriptPrompt();
    const raw = provider === 'gemini' ? await callGeminiScript(apiKey, prompt) : provider === 'claude' ? await callClaudeScript(apiKey, prompt) : await callOpenAiScript(apiKey, prompt);
    const script = sanitizeGeneratedScript(raw);
    if (!script) throw new Error('API 응답에서 대본을 찾지 못했습니다.');
    setScriptIntoEditors(script);
    createCaptionsFromScript();
    log('대본 생성 완료. 대본 편집 칸에 넣고 장면 자동나누기까지 적용했습니다.');
    return script;
  } catch (err) {
    const fallback = setScriptIntoEditors(buildLocalSeoScript());
    createCaptionsFromScript();
    log(`API 대본 생성 실패: ${err.message || err}`);
    log('브라우저 보안/CORS 또는 키 문제일 수 있어 기본 대본을 대본 편집 칸에 대신 생성했습니다.');
    return fallback;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function copySeoScriptPrompt() {
  makeSeoKeywords();
  const prompt = buildSeoScriptPrompt();
  navigator.clipboard?.writeText(prompt).then(() => {
    log('SEO 대본 프롬프트를 복사했습니다. API가 안 될 때 ChatGPT/Claude/Gemini에 붙여넣으세요.');
  }).catch(() => log('프롬프트 복사에 실패했습니다.'));
}

function copyRightScript() {
  syncScriptEditors('right');
  const text = $('rightScriptEditor')?.value || $('generatedScript')?.value || '';
  navigator.clipboard?.writeText(text).then(() => log('우측 대본을 복사했습니다. 음성 만드는 곳에 붙여넣으세요.')).catch(() => log('대본 복사 실패'));
}


const SENIAL_UNDO_STACK = [];
const SENIAL_REDO_STACK = [];
const SENIAL_HISTORY_LIMIT = 30;

function makeStateSnapshot() {
  return {
    captions: JSON.parse(JSON.stringify(state.captions || [])),
    scenes: (state.scenes || []).map((sc) => ({ ...sc, imageObj: null })),
    images: JSON.parse(JSON.stringify(state.images || [])),
    audioDuration: state.audioDuration,
    audioFileName: state.audioFileName || '',
    selectedCaptionId: state.selectedCaptionId,
    thumbnail: { ...(state.thumbnail || {}), imageObj: null },
    generatedScript: $('generatedScript')?.value || '',
    rightScriptEditor: $('rightScriptEditor')?.value || '',
    ttsText: $('ttsText')?.value || '',
    imagePromptList: $('imagePromptList')?.value || '',
    seoKeywordBox: $('seoKeywordBox')?.value || '',
    scriptTopic: $('scriptTopic')?.value || '',
    autoSeedTopic: $('autoSeedTopic')?.value || '',
    autoTopicResultHtml: $('autoTopicResultBox')?.innerHTML || '',
  };
}

function restoreStateSnapshot(snap) {
  if (!snap) return;
  finishPreview(true);
  state.captions = JSON.parse(JSON.stringify(snap.captions || []));
  state.scenes = (snap.scenes || []).map((sc) => ({ ...sc, imageObj: null }));
  state.images = JSON.parse(JSON.stringify(snap.images || []));
  state.audioDuration = snap.audioDuration || 60;
  state.audioFileName = snap.audioFileName || '';
  state.selectedCaptionId = snap.selectedCaptionId || null;
  state.thumbnail = { ...(state.thumbnail || {}), ...(snap.thumbnail || {}), imageObj: null };
  if ($('generatedScript')) $('generatedScript').value = snap.generatedScript || '';
  if ($('rightScriptEditor')) $('rightScriptEditor').value = snap.rightScriptEditor || '';
  if ($('ttsText')) $('ttsText').value = snap.ttsText || '';
  if ($('imagePromptList')) $('imagePromptList').value = snap.imagePromptList || '';
  if ($('seoKeywordBox')) $('seoKeywordBox').value = snap.seoKeywordBox || '';
  if ($('scriptTopic')) $('scriptTopic').value = snap.scriptTopic || '';
  if ($('autoSeedTopic')) $('autoSeedTopic').value = snap.autoSeedTopic || '';
  if ($('autoTopicResultBox')) $('autoTopicResultBox').innerHTML = snap.autoTopicResultHtml || '';
  cacheSceneImages();
  renderThumbnailPreview();
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
}

function pushUndoState() {
  SENIAL_UNDO_STACK.push(makeStateSnapshot());
  if (SENIAL_UNDO_STACK.length > SENIAL_HISTORY_LIMIT) SENIAL_UNDO_STACK.shift();
  SENIAL_REDO_STACK.length = 0;
}

function undoLastAction() {
  if (!SENIAL_UNDO_STACK.length) {
    log('되돌릴 작업이 없습니다.');
    return;
  }
  SENIAL_REDO_STACK.push(makeStateSnapshot());
  restoreStateSnapshot(SENIAL_UNDO_STACK.pop());
  log('실행취소 완료');
}

function redoLastAction() {
  if (!SENIAL_REDO_STACK.length) {
    log('다시 실행할 작업이 없습니다.');
    return;
  }
  SENIAL_UNDO_STACK.push(makeStateSnapshot());
  restoreStateSnapshot(SENIAL_REDO_STACK.pop());
  log('다시실행 완료');
}

function resetAllProject() {
  if (!confirm('대본, 자막, 장면, 이미지, 음성, 썸네일을 전부 초기화할까요?')) return;
  pushUndoState();
  finishPreview(true);
  state.captions = [];
  state.scenes = [];
  state.images = [];
  state.audioDuration = 60;
  state.audioFile = null;
  state.audioFileName = '';
  state.audioProfile = null;
  state.audioAnalysisReady = false;
  state.selectedCaptionId = null;
  state.thumbnail = { image: null, imageObj: null, prompt: '', text: '', style: 'photo-person-bg' };
  ['generatedScript','rightScriptEditor','ttsText','imagePromptList','seoKeywordBox','scriptTopic','autoSeedTopic'].forEach((id) => { if ($(id)) $(id).value = ''; });
  if ($('autoTopicResultBox')) $('autoTopicResultBox').innerHTML = '';
  if ($('autoStyleBox')) $('autoStyleBox').style.display = 'none';
  if ($('audioFile')) $('audioFile').value = '';
  const audio = $('audio');
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  updateAudioStatus(null, 0);
  const link = $('downloadLink');
  if (link) {
    link.removeAttribute('href');
    link.textContent = 'WEBM 생성 후 다운로드 가능';
    link.classList.add('disabledDownload');
  }
  resetRenderProgress();
  renderThumbnailPreview();
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
  log('전체 초기화 완료');
}

function bindEvents() {
  loadSavedApiKey();
  initApiKeyEyeToggle();
  initScriptTopicChips();
  makeSeoKeywords();
  syncScriptEditors('left');
  $('openaiApiKey')?.addEventListener('change', saveApiKeyFromInput);
  $('scriptApiProvider')?.addEventListener('change', handleScriptApiProviderChange);
  $('scriptTopic')?.addEventListener('input', makeSeoKeywords);
  $('btnMakeKeywords')?.addEventListener('click', refreshScriptTopicsByKeyword);
  $('generatedScript')?.addEventListener('input', () => syncScriptEditors('left'));
  $('rightScriptEditor')?.addEventListener('input', () => syncScriptEditors('right'));
  $('btnCopyRightScript')?.addEventListener('click', copyRightScript);
  $('btnApplyRightScript')?.addEventListener('click', async () => {
    syncScriptEditors('right');
    if (state.audioFile) await analyzeAudioAndCaptions();
    else { pushUndoState(); createCaptionsFromScript(); log('음성파일이 없어 대본 기준으로 장면만 나눴습니다. 음성을 넣으면 음성·자막 분석하기로 다시 맞추세요.'); }
  });
    $('btnOpenScriptApiSite')?.addEventListener('click', openScriptApiSite);
  $('btnCheckScriptApi')?.addEventListener('click', verifyScriptApiKey);
  $('btnCheckScriptApiRight')?.addEventListener('click', verifyScriptApiKey);
  $('btnFocusScriptEditor')?.addEventListener('click', () => {
    $('rightScriptEditor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('rightScriptEditor')?.focus();
    generateSeoScriptByApi();
  });
  $('btnAnalyzeStyle')?.addEventListener('click', copySeoScriptPrompt);
  $('btnAutoTopicGenerate')?.addEventListener('click', () => { pushUndoState(); generateAutoModeTopics(); });
  $('autoTopicResultBox')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-auto-topic]');
    if (btn) { pushUndoState(); selectAutoModeTopic(btn.dataset.autoTopic || btn.textContent || ''); }
  });
  $('btnApplyScriptToCaptions')?.addEventListener('click', () => { pushUndoState(); syncScriptEditors('left'); createCaptionsFromScript(); });
  $('btnCopyScript')?.addEventListener('click', () => { syncScriptEditors('left'); navigator.clipboard?.writeText($('generatedScript')?.value || ''); });
  $('btnPreview')?.addEventListener('click', playPreview);
  $('btnStopPreview')?.addEventListener('click', () => stopPreview(true));
  $('btnRender')?.addEventListener('click', renderWebm);
  $('btnAiAll')?.addEventListener('click', () => { pushUndoState(); generateAllImages(); });
  $('btnSaveProject')?.addEventListener('click', saveProject);
  $('btnLoadProject')?.addEventListener('click', () => $('projectFile')?.click());
  $('projectFile')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) loadProjectFile(f); });
  $('btnClear')?.addEventListener('click', resetAllProject);
  $('btnFullReset')?.addEventListener('click', resetAllProject);
  $('btnUndo')?.addEventListener('click', undoLastAction);
  $('btnRedo')?.addEventListener('click', redoLastAction);
  $('btnAddCaption')?.addEventListener('click', () => {
    pushUndoState();
    if (state.captions.length) addCaptionAfter(state.captions[state.captions.length - 1].id);
    else {
      state.captions.push({ id: uid(), start: 0, end: 2, text: '새 자막', captionStyle: { ...collectCaptionStyle() } });
      state.audioDuration = Math.max(state.audioDuration, 2);
      rebuildScenes();
      renderEditor();
    }
  });
  $('btnSyncFix')?.addEventListener('click', () => log('싱크 보정은 꺼졌습니다. 시간칸에서 직접 수정하세요.'));
  $('btnSplitShort')?.addEventListener('click', () => log('자동 재분할은 꺼졌습니다. 대본 생성 시 문단 기준으로만 나눕니다.'));
  $('btnBuildScenes')?.addEventListener('click', () => { pushUndoState(); rebuildScenes(); renderEditor(); drawFrame(timelineTime()); });
  $('btnTranscribe')?.addEventListener('click', async () => {
    await analyzeAudioAndCaptions();
  });

  function applyAudioFile(file) {
    if (!file) return;
    if (!file.type?.startsWith('audio/')) {
      log('음성 파일만 넣을 수 있습니다. mp3, wav, m4a 파일을 선택하세요.');
      return;
    }
    state.audioFile = file;
    state.audioFileName = file.name;
    const audio = $('audio');
    if (!audio) return;
    audio.src = URL.createObjectURL(file);
    audio.onloadedmetadata = async () => {
      state.audioDuration = audio.duration || state.audioDuration;
      state.audioProfile = null;
      state.audioAnalysisReady = false;
      updateAudioStatus(file, state.audioDuration);
      setAudioAnalysisProgress(0, '음성 첨부 완료. 아래 음성·자막 분석하기를 누르세요.');
      markAudioAnalysisReady(false);
      updateSeekUI(0);
      drawFrame(0);
      log('음성 파일이 들어갔습니다. 바로 장면을 만들지 말고 음성·자막 분석하기를 눌러 싱크를 계산하세요.');
    };
  }

  $('audioFile')?.addEventListener('change', (e) => {
    pushUndoState();
    applyAudioFile(e.target.files?.[0]);
  });

  function bindAudioDropZone(zone) {
    if (!zone || zone.dataset.audioDropReady === '1') return;
    zone.dataset.audioDropReady = '1';
    zone.addEventListener('click', () => $('audioFile')?.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $('audioFile')?.click();
      }
    });
    ['dragenter', 'dragover'].forEach((eventName) => {
      zone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      zone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('dragover');
      });
    });
    zone.addEventListener('drop', (e) => {
      pushUndoState();
      applyAudioFile(e.dataTransfer?.files?.[0]);
    });
  }
  bindAudioDropZone($('audioDropZone'));
  bindAudioDropZone($('rightAudioDropZone'));

  $('previewSeek')?.addEventListener('input', (e) => {
    const t = parseFloat(e.target.value || '0') || 0;
    const audio = $('audio');
    if (audio && audio.src) audio.currentTime = t;
    updateSeekUI(t);
    drawFrame(t);
  });
  $('btnBack5')?.addEventListener('click', () => {
    const t = Math.max(0, timelineTime() - 5);
    if ($('previewSeek')) $('previewSeek').value = t;
    if ($('audio')?.src) $('audio').currentTime = t;
    updateSeekUI(t);
    drawFrame(t);
  });
  $('btnForward5')?.addEventListener('click', () => {
    const t = Math.min(state.audioDuration, timelineTime() + 5);
    if ($('previewSeek')) $('previewSeek').value = t;
    if ($('audio')?.src) $('audio').currentTime = t;
    updateSeekUI(t);
    drawFrame(t);
  });

  $('liveCaptionText')?.addEventListener('input', (e) => updateCaptionTextLive(e.target.value));
  $('liveCaptionText')?.addEventListener('blur', (e) => {
    const fixed = removeTailRepeat(e.target.value);
    if (fixed !== e.target.value) {
      e.target.value = fixed;
      updateCaptionTextLive(fixed);
    }
  });
  const shiftSelectedCaption = (delta) => {
    const cap = getSelectedCaption();
    if (!cap) return;
    const scene = state.scenes.find((sc) => sc.captionIds.includes(cap.id));
    const dur = Math.max(0.2, cap.end - cap.start);
    cap.start = Math.max(0, cap.start + delta);
    cap.end = Math.max(cap.start + dur, cap.end + delta);
    if (scene) { scene.start = cap.start; scene.end = cap.end; }
    state.audioDuration = Math.max(state.audioDuration, cap.end);
    renderEditor();
    setActiveCaption(cap.id);
    syncPreviewToCaption(cap, false);
  };
  $('btnSyncMinus')?.addEventListener('click', () => shiftSelectedCaption(-0.3));
  $('btnSyncPlus')?.addEventListener('click', () => shiftSelectedCaption(0.3));

  ['fontSize', 'captionY', 'captionX', 'captionBoxOpacity'].forEach((id) => {
    $(id)?.addEventListener('input', () => {
      if ($(`${id}Value`)) $(`${id}Value`).textContent = $(id).value;
      applyCaptionStyleLive();
    });
  });
  ['captionFont', 'captionFontWeight', 'captionTextColor', 'captionStrokeColor', 'captionBgColor', 'captionPos'].forEach((id) => {
    $(id)?.addEventListener('input', applyCaptionStyleLive);
    $(id)?.addEventListener('change', applyCaptionStyleLive);
  });
  ['captionMaxChars', 'captionMaxLines'].forEach((id) => {
    $(id)?.addEventListener('input', () => {
      const cap = getSelectedCaption();
      if (cap) syncPreviewToCaption(cap);
      else drawFrame(timelineTime());
    });
    $(id)?.addEventListener('change', () => {
      const cap = getSelectedCaption();
      if (cap) syncPreviewToCaption(cap);
      else drawFrame(timelineTime());
    });
  });
  $('btnApplyCaptionStyleAll')?.addEventListener('click', applyCaptionStyleAll);
  $('btnApplyCaptionStyleCurrent')?.addEventListener('click', applyCaptionStyleCurrent);

  // V16: 섹션 1/2 이동 꼬임 방지. data-jump 값을 그대로 쓰고, 고정 상단바 높이를 실측해서 이동한다.
  const sectionJumpOrder = ['secScript', 'secAudio', 'secThumb', 'secSceneAuto', 'secImage', 'secPreview', 'secOutput', 'secEdit'];

  function fixedHeaderOffset() {
    const ids = ['.topbar', '.topShortcutBar', '.quickNav', '.workflowBar'];
    let h = 0;
    ids.forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      if (st.position !== 'fixed' && st.position !== 'sticky') return;
      const r = el.getBoundingClientRect();
      if (r.height > 0) h += r.height;
    });
    return Math.max(150, Math.round(h + 18));
  }

  function jumpToSection(id) {
    const target = document.getElementById(id);
    if (!target) {
      log(`이동할 섹션을 찾지 못했습니다: ${id}`);
      return;
    }
    document.querySelectorAll('[data-jump]').forEach((b) => b.classList.toggle('active', b.dataset.jump === id));
    const top = target.getBoundingClientRect().top + window.scrollY - fixedHeaderOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setTimeout(() => {
      const retryTop = target.getBoundingClientRect().top + window.scrollY - fixedHeaderOffset();
      window.scrollTo({ top: Math.max(0, retryTop), behavior: 'auto' });
    }, 260);
    log(`섹션 이동: ${id}`);
  }

  document.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToSection(btn.dataset.jump);
    });
  });

  let currentWorkflowIndex = 0;
  function setWorkflowLabel() {
    const labelMap = {
      secScript: '1 주제/대본', secAudio: '2 음성넣기', secThumb: '3 자막스타일', secSceneAuto: '4 장면',
      secImage: '6 이미지', secPreview: '7 미리보기', secOutput: '8 WEBM 다운로드', secEdit: '9 편집'
    };
    const id = sectionJumpOrder[currentWorkflowIndex] || sectionJumpOrder[0];
    if ($('workflowStepLabel')) $('workflowStepLabel').textContent = labelMap[id] || id;
  }
  $('btnStepPrev')?.addEventListener('click', () => {
    currentWorkflowIndex = Math.max(0, currentWorkflowIndex - 1);
    setWorkflowLabel();
    jumpToSection(sectionJumpOrder[currentWorkflowIndex]);
  });
  $('btnStepNext')?.addEventListener('click', () => {
    currentWorkflowIndex = Math.min(sectionJumpOrder.length - 1, currentWorkflowIndex + 1);
    setWorkflowLabel();
    jumpToSection(sectionJumpOrder[currentWorkflowIndex]);
  });
  setWorkflowLabel();

  $('btnAutoMode')?.addEventListener('click', () => {
    const p = $('autoModePanel');
    if (p) p.style.display = p.style.display === 'none' || !p.style.display ? 'block' : 'none';
  });
  $('btnAutoPhoto')?.addEventListener('click', () => {
    const m = $('autoPhotoMenu');
    const c = $('autoComicMenu');
    if (m) m.style.display = m.style.display === 'grid' ? 'none' : 'grid';
    if (c) c.style.display = 'none';
  });
  $('btnAutoComic')?.addEventListener('click', () => {
    const m = $('autoComicMenu');
    const p = $('autoPhotoMenu');
    if (m) m.style.display = m.style.display === 'grid' ? 'none' : 'grid';
    if (p) p.style.display = 'none';
  });
  document.querySelectorAll('[data-auto-version][data-auto-kind]').forEach((btn) => {
    btn.addEventListener('click', () => { pushUndoState(); runAutoModeFromTopic(btn.dataset.autoVersion, btn.dataset.autoKind); });
  });
  $('btnOpenImageProvider')?.addEventListener('click', openImageProvider);
  $('btnOpenImageProvider2')?.addEventListener('click', openImageProvider);
  $('btnCopyAllPrompts')?.addEventListener('click', generateAllImages);
  $('btnGoThumbnail')?.addEventListener('click', () => jumpToSection('secEdit'));
  $('bulkImageFiles')?.addEventListener('change', (e) => attachBulkImages(e.target.files));

}

function init() {
  document.body.classList.add('mode-script');
  document.body.classList.remove('mode-voice');
  ['secMode', 'btnScriptMode', 'btnVoiceMode', 'modeNotice'].forEach((id) => { const el = $(id); if (el) el.style.display = 'none'; });
  document.querySelectorAll('[data-jump="secMode"]').forEach((el) => { el.style.display = 'none'; });
  bindEvents();
  bindThumbnailEvents();
  updateSeekUI(0);
  drawFrame(0);
  renderEditor();
  log('세니얼 적용 완료. 순서: 대본 → 음성파일 넣기 → 음성·자막 분석하기 → 장면/이미지 생성.');
}

window.addEventListener('DOMContentLoaded', init);
