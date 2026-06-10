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

// V62 자막 싱크 전용 보정값: 초반 숨소리/잡음을 말소리로 오인하지 않게 하고, 첫 자막 선출력을 막는다.
const CAPTION_FIRST_START_DELAY = 0.00;
const CAPTION_SINGLE_START_DELAY = 0.00;
const VOICE_CUT_DELAY = 0.00;

const state = {
  captions: [],
  scenes: [],
  images: [],
  imageAssets: [],
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
  draggingImageSlot: null,
  draggingImageMotion: '',
  pointerImageDrag: null,
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
  // V65: 음성 싱크 안정형 자막 분할.
  // 한 칸이 길면 실제 TTS 호흡과 맞지 않아 중간부터 밀리므로 10~14자 중심으로 촘촘히 나눈다.
  const uiLimit = Number(limit) || getChunkLimit();
  return clamp(Math.min(uiLimit, 14), 10, 14);
}

function optimizeCaptionChunks(chunks) {
  // 너무 짧은 단어만 단독 자막으로 남으면 자막이 빨리 튀거나 뒤 싱크가 흔들린다.
  // 1~4글자 조각은 앞/뒤 문장과 합쳐서 자연스러운 호흡 단위로 만든다.
  const source = (chunks || []).map((v) => removeTailRepeat(v)).filter(Boolean);
  const firstPass = [];
  source.forEach((chunk) => {
    const len = plainKey(chunk).length;
    const prev = firstPass[firstPass.length - 1] || '';
    const joined = prev ? `${prev} ${chunk}`.trim() : chunk;
    if (len <= 4 && prev && plainKey(joined).length <= 18) {
      firstPass[firstPass.length - 1] = joined;
    } else {
      firstPass.push(chunk);
    }
  });

  const out = [];
  for (let i = 0; i < firstPass.length; i++) {
    const current = firstPass[i];
    const next = firstPass[i + 1] || '';
    const len = plainKey(current).length;
    const joined = next ? `${current} ${next}`.trim() : current;
    if (len <= 4 && next && plainKey(joined).length <= 18) {
      out.push(joined);
      i++;
    } else {
      out.push(current);
    }
  }

  return out.filter((p, i, arr) => p && (!i || plainKey(p) !== plainKey(arr[i - 1])));
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
  return optimizeCaptionChunks(out);
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
  return optimizeCaptionChunks(result);
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


function syncScenesFromCaptions() {
  // 자막/음성 싱크 값은 captions가 원본이다. scenes는 이미지/모션 연결만 보관한다.
  if (!Array.isArray(state.captions) || !Array.isArray(state.scenes)) return;
  const oldByCap = new Map();
  state.scenes.forEach((scene) => {
    const capId = scene?.captionIds?.[0];
    if (capId) oldByCap.set(capId, scene);
  });
  state.scenes = state.captions.map((cap, idx) => {
    const old = oldByCap.get(cap.id) || state.scenes[idx] || {};
    return {
      ...old,
      id: old.id || uid(),
      title: `장면 ${idx + 1}`,
      captionIds: [cap.id],
      start: cap.start,
      end: cap.end,
      fullText: cap.text,
      prompt: old.prompt && old.prompt !== old.fullText ? old.prompt : cap.text,
      imageSlot: Number.isInteger(old.imageSlot) ? old.imageSlot : idx,
      motion: old.motion || motions[idx % motions.length],
      topFixedText: old.topFixedText !== false,
    };
  });
}

function buildImageSlotPromptSource(slot) {
  const n = Math.floor(Number(slot) || 0);
  const texts = [];
  state.scenes.forEach((scene, idx) => {
    if (getSceneImageSlot(scene, idx) !== n) return;
    const cap = state.captions.find((c) => c.id === scene.captionIds?.[0]);
    const t = removeTailRepeat(cap?.text || scene.fullText || scene.prompt || '').trim();
    if (t && !texts.includes(t)) texts.push(t);
  });
  return texts.join(' / ');
}

function refreshImageAssetPromptsFromGroups() {
  if (!state.imageAssets) state.imageAssets = [];
  const count = getImageSlotCount();
  for (let i = 0; i < count; i++) {
    const asset = ensureImageAsset(i, null, i);
    const grouped = buildImageSlotPromptSource(i);
    if (grouped && !asset.customPrompt) asset.prompt = grouped;
  }
}

function applyImageGrouping(per = getImageGroupSize(), silent = false) {
  syncScenesFromCaptions();
  const group = clamp(parseInt(per || '1', 10) || 1, 1, 50);
  if (!state.scenes.length) return;
  state.scenes.forEach((scene, idx) => {
    scene.imageSlot = Math.floor(idx / group);
  });
  refreshImageAssetPromptsFromGroups();
  cacheSceneImages();
  renderEditor();
  drawFrame(timelineTime());
  if (!silent) log(`이미지 묶기 적용: 자막 ${group}칸당 이미지 1장으로 연결했습니다.`);
}

function rebuildScenes() {
  const oldScenes = state.scenes || [];
  const per = getImageGroupSize();
  state.scenes = state.captions.map((cap, idx) => {
    const old = oldScenes.find((s) => s.captionIds?.includes(cap.id)) || oldScenes[idx] || {};
    const slot = Number.isInteger(old.imageSlot) ? old.imageSlot : Math.floor(idx / per);
    return {
      id: old.id || uid(),
      title: `장면 ${idx + 1}`,
      captionIds: [cap.id],
      start: cap.start,
      end: cap.end,
      image: old.image || state.images[idx] || null,
      imageObj: old.imageObj || null,
      imageSlot: slot,
      motion: old.motion || motions[idx % motions.length],
      fullText: cap.text,
      prompt: old.prompt && old.prompt !== old.fullText ? old.prompt : cap.text,
      topFixedText: old.topFixedText !== false,
    };
  });
  refreshImageAssetPromptsFromGroups();
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

function getCaptionMinDurationByText(text, avg = 1.5, uiMin = 1.5) {
  // V63: 짧은 단어 자막이 1.5초씩 잡히며 뒤 자막을 밀던 문제 보정.
  // 글자 수별 최소 시간을 다르게 적용한다.
  const len = Math.max(1, plainKey(text).length);
  let base;
  if (len <= 5) base = 0.45;
  else if (len <= 10) base = 0.65;
  else if (len <= 18) base = 0.90;
  else base = clamp(Number(uiMin) || 1.5, 1.20, 1.50);

  // 전체 음성이 짧을 때는 평균 길이에 맞춰 과도한 최소시간을 더 줄인다.
  return clamp(Math.min(base, Math.max(0.38, avg * 0.86)), 0.35, 1.50);
}

function balanceDurationsToTotal(durations, mins, maxes, total) {
  let out = durations.map((dur, i) => clamp(dur, mins[i], maxes[i]));
  for (let loop = 0; loop < 8; loop++) {
    const sum = out.reduce((a, b) => a + b, 0) || 1;
    const diff = total - sum;
    if (Math.abs(diff) < 0.01) break;

    if (diff > 0) {
      const headrooms = out.map((dur, i) => Math.max(0, maxes[i] - dur));
      const room = headrooms.reduce((a, b) => a + b, 0);
      if (room <= 0.001) break;
      out = out.map((dur, i) => dur + diff * (headrooms[i] / room));
    } else {
      const reducibles = out.map((dur, i) => Math.max(0, dur - mins[i]));
      const room = reducibles.reduce((a, b) => a + b, 0);
      if (room <= 0.001) break;
      out = out.map((dur, i) => dur + diff * (reducibles[i] / room));
    }
    out = out.map((dur, i) => clamp(dur, mins[i], maxes[i]));
  }
  return out;
}

function distributeCaptionDurations(parts, totalDuration, minDur = 1.5) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const count = Math.max(1, parts.length || 1);
  const avg = total / count;

  // V63: 모든 자막에 같은 최소시간을 주지 않고, 짧은 단어는 짧게 배치한다.
  const safeMins = (parts || []).map((text) => getCaptionMinDurationByText(text, avg, minDur));
  const safeMaxes = safeMins.map((safeMin) => Math.max(safeMin + 0.2, avg * 2.15));
  const weights = (parts || []).map((text, i) => estimateCaptionReadWeight(text, safeMins[i]));
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

  let durations = weights.map((w, i) => {
    const weightedDur = (w / weightSum) * total;
    const blended = avg * 0.18 + weightedDur * 0.82;
    return clamp(blended, safeMins[i], safeMaxes[i]);
  });

  durations = balanceDurationsToTotal(durations, safeMins, safeMaxes, total);
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
    if (last && seg.start - last.end <= 0.06) last.end = Math.max(last.end, seg.end);
    else merged.push({ ...seg });
  });

  const speechTotal = merged.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0);
  if (speechTotal < total * 0.28 || speechTotal > total * 0.985) return [];
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
  captions[0].start = firstVoiceAt > 0.25
    ? Number(clamp(firstVoiceAt + CAPTION_FIRST_START_DELAY, 0, total).toFixed(2))
    : Number(Math.min(CAPTION_FIRST_START_DELAY, total).toFixed(2));

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
    const threshold = Math.max(0.005, p20 * 3.2, p55 * 0.9, p92 * 0.07);

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
      if (last && seg.start - last.end < 0.10) last.end = seg.end;
      else merged.push({ ...seg });
    });

    const segments = merged
      .map((seg) => ({
        start: Math.max(0, seg.start),
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
  // 싱크 전용: 자막 전환은 이전 문장의 끝 시간이 아니라 다음 말소리 시작점에 건다.
  // 짧은 쉼도 살려서 한 줄 읽고 다음 줄 음성이 시작될 때 자막이 넘어가게 한다.
  return (segments || [])
    .slice(1)
    .map((seg) => clamp(Number(seg.start || 0) + VOICE_CUT_DELAY, 0, total))
    .filter((v, i, arr) => Number.isFinite(v) && v > 0.03 && v < total - 0.03 && (!i || Math.abs(v - arr[i - 1]) > 0.04));
}

function buildVoiceSegmentCaptionTimeline(parts, totalDuration, style, audioProfile) {
  const total = Math.max(0.5, Number(totalDuration) || 0);
  const cleanParts = (parts || []).map((v) => removeTailRepeat(v)).filter(Boolean);
  const styleBase = style || collectCaptionStyle();
  if (!cleanParts.length) return [];

  const segments = getSpeechSegments(audioProfile, total);
  if (!segments.length || cleanParts.length === 1) {
    const base = buildStableCaptionTimeline(cleanParts, total, styleBase);
    if (segments[0]) base[0].start = Number(clamp(segments[0].start + CAPTION_SINGLE_START_DELAY, 0, total).toFixed(2));
    return base;
  }

  const base = buildStableCaptionTimeline(cleanParts, total, styleBase);
  const candidates = findVoiceCutCandidates(segments, total);
  const boundaries = [];
  const avg = total / Math.max(1, cleanParts.length);
  const minGap = Math.max(0.12, Math.min(0.42, avg * 0.16));

  // V64: 중간 싱크 안정형.
  // 파형에서 잡힌 다음 말소리 시작점을 무조건 따라가면 짧은 단어/쉼표 때문에 중간부터 자막이 튄다.
  // 그래서 대본 길이 기반 목표 시간을 기준으로 두고, 가까운 음성 컷만 살짝 보정한다.
  const snapWindow = Math.max(0.18, Math.min(0.36, avg * 0.22));
  const maxDrift = Math.max(0.22, Math.min(0.48, avg * 0.30));

  for (let i = 0; i < cleanParts.length - 1; i++) {
    const target = base[i]?.end || ((i + 1) / cleanParts.length) * total;
    const prev = boundaries.length ? boundaries[boundaries.length - 1] : clamp(segments[0].start + CAPTION_FIRST_START_DELAY, 0, total);
    const remaining = (cleanParts.length - 1) - i;
    const latest = total - minGap * remaining;
    const safeTarget = clamp(target, prev + minGap, latest);

    const near = candidates
      .filter((cut) => cut > prev + minGap && cut < latest)
      .filter((cut) => Math.abs(cut - safeTarget) <= snapWindow);

    let chosen = safeTarget;
    if (near.length) {
      chosen = near.reduce((best, cut) => Math.abs(cut - safeTarget) < Math.abs(best - safeTarget) ? cut : best, near[0]);
      // 음성 컷을 쓰더라도 대본 기준 목표에서 너무 멀어지지 않게 제한한다.
      chosen = clamp(chosen, safeTarget - maxDrift, safeTarget + maxDrift);
    }

    chosen = clamp(chosen, prev + minGap, latest);
    boundaries.push(Number(chosen.toFixed(2)));
  }

  const firstStart = Number(clamp((segments[0]?.start || 0) + CAPTION_FIRST_START_DELAY, 0, total).toFixed(2));
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
  const captions = buildStableCaptionTimeline(parts, total, style);
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
  state.imageAssets = [];
  state.selectedCaptionId = null;

  const audio = $('audio');
  const audioDur = Number(audio?.duration || 0);
  const minDur = clamp(parseFloat($('captionMinSeconds')?.value || '1.5'), 1.0, 4);
  const total = audioDur > 1 ? audioDur : Math.max(20, parts.length * Math.max(2, minDur));
  const style = collectCaptionStyle();

  // 음성 분석값이 있으면 장면 자동나누기도 다음 말소리 시작점 기준 싱크를 사용한다.
  // 음성파일이 없거나 아직 분석 전이면 기존 대본 기준 싱크만 사용한다.
  state.captions = buildStableCaptionTimeline(parts, total, style);
  state.audioDuration = total;
  rebuildScenes();
  if ($('generatedScript')) $('generatedScript').value = parts.join('\n\n');
  if ($('ttsText')) $('ttsText').value = parts.join('\n');
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
  if (state.captions[0]) setActiveCaption(state.captions[0].id);
  syncScriptEditors('left');
  log(`V65 촘촘한 자막분할 싱크 적용 완료: 음성 ${formatTime(total)}, 자막 ${parts.length}개`);
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

function getImageSlotCount() {
  return Math.max(state.scenes.length || 0, state.imageAssets.length || 0, 1);
}

function getImageGroupSize() {
  const mode = $('imagePerCaptions')?.value || '1';
  const raw = mode === 'custom' ? $('customPerCaptions')?.value : mode;
  return clamp(parseInt(raw || '1', 10) || 1, 1, 50);
}

function ensureImageAsset(slot, scene = null, idx = 0) {
  const n = clamp(Math.floor(Number(slot) || 0), 0, Math.max(0, getImageSlotCount() - 1));
  if (!state.imageAssets) state.imageAssets = [];
  if (!state.imageAssets[n]) {
    state.imageAssets[n] = {
      id: uid(),
      image: scene?.image || null,
      imageObj: scene?.imageObj || null,
      prompt: scene?.prompt || scene?.fullText || '',
      customPrompt: scene?.customPrompt || '',
    };
  }
  if (scene && !state.imageAssets[n].prompt) state.imageAssets[n].prompt = scene.prompt || scene.fullText || '';
  return state.imageAssets[n];
}

function getSceneImageSlot(scene, idx = 0) {
  if (!scene) return 0;
  const raw = Number.isInteger(scene.imageSlot) ? scene.imageSlot : idx;
  return clamp(raw, 0, Math.max(0, getImageSlotCount() - 1));
}

function getSceneImageAsset(scene, idx = 0) {
  const slot = getSceneImageSlot(scene, idx);
  const asset = ensureImageAsset(slot, scene, idx);
  if (!asset.image && scene?.image && slot === idx) {
    asset.image = scene.image;
    asset.imageObj = scene.imageObj || null;
  }
  return asset;
}

function setSceneImageSlot(scene, slot, idx = 0) {
  if (!scene) return;
  scene.imageSlot = clamp(Math.floor(Number(slot) || 0), 0, Math.max(0, getImageSlotCount() - 1));
  ensureImageAsset(scene.imageSlot, scene, idx);
}



function hasDataTransferType(event, typeName) {
  const types = event?.dataTransfer?.types;
  if (!types) return false;
  if (typeof types.includes === 'function') return types.includes(typeName);
  if (typeof types.contains === 'function') return types.contains(typeName);
  return Array.from(types || []).includes(typeName);
}

function setImageDragPayload(event, scene, idx) {
  const slot = getSceneImageSlot(scene, idx);
  const motion = scene?.motion || 'zoom';
  state.draggingImageSlot = slot;
  state.draggingImageMotion = motion;
  try { event.dataTransfer?.setData('text/senial-image-slot', String(slot)); } catch (_) {}
  try { event.dataTransfer?.setData('application/x-senial-image-slot', String(slot)); } catch (_) {}
  try { event.dataTransfer?.setData('text/senial-image-motion', motion); } catch (_) {}
  try { event.dataTransfer?.setData('text/plain', `SENIAL_IMAGE_SLOT:${slot}`); } catch (_) {}
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
}

function getDraggedImageSlot(event) {
  const direct = event?.dataTransfer?.getData?.('text/senial-image-slot');
  if (direct !== undefined && direct !== null && direct !== '') return Math.floor(Number(direct));
  const app = event?.dataTransfer?.getData?.('application/x-senial-image-slot');
  if (app !== undefined && app !== null && app !== '') return Math.floor(Number(app));
  const plain = event?.dataTransfer?.getData?.('text/plain') || '';
  const match = String(plain).match(/SENIAL_IMAGE_SLOT:(\d+)/);
  if (match) return Math.floor(Number(match[1]));
  if (Number.isInteger(state.draggingImageSlot)) return state.draggingImageSlot;
  return -1;
}

function getDraggedImageMotion(event) {
  return event?.dataTransfer?.getData?.('text/senial-image-motion') || state.draggingImageMotion || '';
}

function clearImageDragPayload() {
  state.draggingImageSlot = null;
  state.draggingImageMotion = '';
}


function clearManualDragOver() {
  document.querySelectorAll('.sceneLinkDropZone.dragOver, .sceneDropZone.dragOver').forEach((el) => el.classList.remove('dragOver'));
}

function getSceneDropTargetFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.('.sceneLinkDropZone, .sceneDropZone') || null;
}

function linkDraggedImageToZone(zone, clientX = 0, clientY = 0) {
  if (!zone || !state.pointerImageDrag) return false;
  const targetIdx = Number(zone.dataset.sceneIndex);
  if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= state.scenes.length) return false;
  const targetScene = state.scenes[targetIdx];
  const sourceSlot = state.pointerImageDrag.slot;
  const sourceMotion = state.pointerImageDrag.motion || '';
  if (!Number.isInteger(sourceSlot) || sourceSlot < 0) return false;
  connectSceneImageSlot(targetScene, targetIdx, sourceSlot, sourceMotion);
  cacheSceneImages();
  renderEditor();
  drawFrame(timelineTime());
  log(`장면 ${targetIdx + 1}을 이미지 ${sourceSlot + 1}번에 연결했습니다. 연결된 장면은 같은 움직임으로 이어집니다.`);
  return true;
}

function startImagePointerDrag(event, scene, idx) {
  if (!scene || !event) return;
  if (event.button !== undefined && event.button !== 0) return;
  const slot = getSceneImageSlot(scene, idx);
  const asset = getSceneImageAsset(scene, idx);
  if (!asset?.image) return;

  state.pointerImageDrag = {
    slot,
    motion: scene.motion || 'zoom',
    startX: event.clientX,
    startY: event.clientY,
    active: false,
  };
  state.draggingImageSlot = slot;
  state.draggingImageMotion = scene.motion || 'zoom';

  const sourceEl = event.currentTarget;
  sourceEl?.classList?.add('manualDragSource');

  const onMove = (moveEvent) => {
    const d = Math.hypot(moveEvent.clientX - state.pointerImageDrag.startX, moveEvent.clientY - state.pointerImageDrag.startY);
    if (d > 4) state.pointerImageDrag.active = true;
    if (!state.pointerImageDrag.active) return;
    document.body.classList.add('senialImageManualDragging');
    clearManualDragOver();
    const zone = getSceneDropTargetFromPoint(moveEvent.clientX, moveEvent.clientY);
    if (zone) zone.classList.add('dragOver');
    moveEvent.preventDefault();
  };

  const onUp = (upEvent) => {
    const drag = state.pointerImageDrag;
    const zone = getSceneDropTargetFromPoint(upEvent.clientX, upEvent.clientY);
    clearManualDragOver();
    document.body.classList.remove('senialImageManualDragging');
    sourceEl?.classList?.remove('manualDragSource');
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);

    if (drag?.active && zone) linkDraggedImageToZone(zone, upEvent.clientX, upEvent.clientY);
    state.pointerImageDrag = null;
    clearImageDragPayload();
    upEvent.preventDefault();
  };

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  event.preventDefault();
}

function isSenialImageDrag(event) {
  return Number.isInteger(state.draggingImageSlot)
    || hasDataTransferType(event, 'text/senial-image-slot')
    || hasDataTransferType(event, 'application/x-senial-image-slot')
    || String(event?.dataTransfer?.getData?.('text/plain') || '').startsWith('SENIAL_IMAGE_SLOT:');
}

function getLinkedSceneIndexesBySlot(slot) {
  const targetSlot = Math.floor(Number(slot) || 0);
  return state.scenes
    .map((scene, idx) => getSceneImageSlot(scene, idx) === targetSlot ? idx : -1)
    .filter((idx) => idx >= 0);
}

function applyMotionToLinkedScenes(slot, motion) {
  getLinkedSceneIndexesBySlot(slot).forEach((sceneIdx) => {
    if (state.scenes[sceneIdx]) state.scenes[sceneIdx].motion = motion || 'zoom';
  });
}

function connectSceneImageSlot(targetScene, targetIdx, sourceSlot, sourceMotion = '') {
  if (!targetScene) return;
  const slot = clamp(Math.floor(Number(sourceSlot) || 0), 0, Math.max(0, getImageSlotCount() - 1));
  targetScene.imageSlot = slot;
  const sourceIdx = state.scenes.findIndex((scene, idx) => getSceneImageSlot(scene, idx) === slot);
  const motion = sourceMotion || state.scenes[sourceIdx]?.motion || targetScene.motion || 'zoom';
  targetScene.motion = motion;
  applyMotionToLinkedScenes(slot, motion);
  ensureImageAsset(slot, targetScene, targetIdx);
}

function getSceneLinkedMotionWindow(scene, idx = 0) {
  if (!scene) return { start: 0, end: 1 };
  const slot = getSceneImageSlot(scene, idx);
  let start = Number(scene.start || 0);
  let end = Number(scene.end || start + 1);
  for (let i = idx - 1; i >= 0; i--) {
    const prev = state.scenes[i];
    if (!prev || getSceneImageSlot(prev, i) !== slot) break;
    start = Math.min(start, Number(prev.start || start));
  }
  for (let i = idx + 1; i < state.scenes.length; i++) {
    const next = state.scenes[i];
    if (!next || getSceneImageSlot(next, i) !== slot) break;
    end = Math.max(end, Number(next.end || end));
  }
  return { start, end: Math.max(start + 0.1, end) };
}

function setImageAssetData(slot, dataUrl, scene = null, idx = 0) {
  const asset = ensureImageAsset(slot, scene, idx);
  asset.image = dataUrl;
  asset.imageObj = null;
  // 기존 저장/호환 로직을 위해 현재 장면에도 복사한다. 시간/싱크 값은 건드리지 않는다.
  if (scene) {
    scene.image = dataUrl;
    scene.imageObj = null;
    scene.imageSlot = clamp(Math.floor(Number(slot) || 0), 0, Math.max(0, getImageSlotCount() - 1));
  }
  return asset;
}

function syncLegacySceneImagesFromSlots() {
  state.scenes.forEach((scene, idx) => {
    const asset = getSceneImageAsset(scene, idx);
    if (asset?.image) {
      scene.image = asset.image;
      scene.imageObj = asset.imageObj || scene.imageObj || null;
    }
  });
}

function renderEditor() {
  const box = $('sceneEditor');
  if (!box) return;
  box.innerHTML = '';
  syncScenesFromCaptions();
  renderThumbnailCard(box);

  if (state.scenes.length) {
    const groupBar = document.createElement('div');
    groupBar.className = 'imageGroupBar';
    const per = getImageGroupSize();
    const imageCount = Math.max(1, Math.ceil(state.scenes.length / per));
    groupBar.innerHTML = `<strong>이미지 묶기</strong><span>현재 자막 ${per}칸당 이미지 1장 · 총 이미지 ${imageCount}장 사용</span>`;
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'primary smallGroupBtn';
    applyBtn.textContent = '묶기 적용';
    applyBtn.addEventListener('click', () => applyImageGrouping(getImageGroupSize()));
    groupBar.appendChild(applyBtn);
    box.appendChild(groupBar);
  }

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
    const imageAsset = getSceneImageAsset(scene, idx);
    if (imageAsset?.image) {
      const img = document.createElement('img');
      img.src = imageAsset.image;
      img.draggable = true;
      img.addEventListener('dragstart', (e) => setImageDragPayload(e, scene, idx));
      img.addEventListener('dragend', clearImageDragPayload);
      img.addEventListener('pointerdown', (e) => startImagePointerDrag(e, scene, idx));
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '이미지 없음<br>업로드/AI 생성';
    }
    thumb.draggable = !!imageAsset?.image;
    thumb.title = '이 이미지를 아래 장면의 이미지 연결칸으로 끌어놓으면 같은 이미지로 연결됩니다.';
    thumb.addEventListener('dragstart', (e) => setImageDragPayload(e, scene, idx));
    thumb.addEventListener('dragend', clearImageDragPayload);
    thumb.addEventListener('pointerdown', (e) => startImagePointerDrag(e, scene, idx));

    const visualCol = document.createElement('div');
    visualCol.className = 'sceneVisualColumn';
    const linkDrop = document.createElement('div');
    linkDrop.className = 'sceneLinkDropZone';
    linkDrop.dataset.sceneIndex = String(idx);
    const currentSlot = getSceneImageSlot(scene, idx);
    const linkedFromOther = currentSlot !== idx;
    if (linkedFromOther) linkDrop.classList.add('linked');
    linkDrop.innerHTML = linkedFromOther
      ? `<b>이미지 ${currentSlot + 1}에 연결됨</b><span>다른 장면 이미지를 여기로 끌면 변경</span>`
      : '<b>이미지 연결하기</b><span>위 장면 이미지를 여기로 끌어놓기</span>';
    ['dragenter', 'dragover'].forEach((type) => {
      linkDrop.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        linkDrop.classList.add('dragOver');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      linkDrop.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        linkDrop.classList.remove('dragOver');
      });
    });
    linkDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sourceSlot = getDraggedImageSlot(e);
      if (sourceSlot < 0) {
        log('연결할 이미지를 찾지 못했습니다. 위 장면 썸네일을 그대로 끌어주세요.');
        return;
      }
      const sourceMotion = getDraggedImageMotion(e);
      connectSceneImageSlot(scene, idx, sourceSlot, sourceMotion);
      cacheSceneImages();
      renderEditor();
      drawFrame(timelineTime());
      log(`장면 ${idx + 1}을 이미지 ${sourceSlot + 1}번에 연결했습니다. 연결된 장면은 같은 움직임으로 이어집니다.`);
    });
    visualCol.append(thumb, linkDrop);

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
    aiBtn.textContent = 'Gemini 생성';
    aiBtn.title = '프롬프트를 복사하고 Gemini 창을 엽니다.';
    aiBtn.addEventListener('click', () => generateSceneImage(scene, idx, 'gemini'));

    const chatgptBtn = document.createElement('button');
    chatgptBtn.type = 'button';
    chatgptBtn.className = 'secondary sceneAttachBtn';
    chatgptBtn.textContent = 'ChatGPT 생성';
    chatgptBtn.title = '프롬프트를 복사하고 ChatGPT 창을 엽니다.';
    chatgptBtn.addEventListener('click', () => generateSceneImage(scene, idx, 'chatgpt'));

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'secondary sceneAttachBtn';
    attachBtn.textContent = `장면 ${idx + 1} 첨부하기`;
    attachBtn.addEventListener('click', () => openSceneImagePicker(upload));

    const dropZone = document.createElement('div');
    dropZone.className = 'sceneDropZone';
    dropZone.dataset.sceneIndex = String(idx);
    dropZone.innerHTML = imageAsset?.image ? '이미지 교체/연결<br><b>드래그하거나 첨부하기</b>' : '이미지 끌어넣기/연결<br><b>또는 첨부하기</b>';
    dropZone.addEventListener('click', () => openSceneImagePicker(upload));
    ['dragenter', 'dragover'].forEach((type) => {
      dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragOver');
        if (isSenialImageDrag(e)) e.dataTransfer.dropEffect = 'copy';
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
      if (isSenialImageDrag(e)) {
        const sourceSlot = getDraggedImageSlot(e);
        if (sourceSlot >= 0) {
          const sourceMotion = getDraggedImageMotion(e);
          connectSceneImageSlot(scene, idx, sourceSlot, sourceMotion);
          cacheSceneImages();
          renderEditor();
          drawFrame(timelineTime());
          log(`장면 ${idx + 1}을 이미지 ${sourceSlot + 1}번에 연결했습니다.`);
          return;
        }
      }
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
      applyMotionToLinkedScenes(getSceneImageSlot(scene, idx), motionSel.value);
      renderEditor();
      drawFrame(timelineTime());
    });

    const imageSlotSel = document.createElement('select');
    imageSlotSel.title = '이 장면에서 사용할 이미지 번호';
    imageSlotSel.className = 'sceneImageSlotSelect';
    const slotCount = getImageSlotCount();
    for (let n = 0; n < slotCount; n++) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `이미지 ${n + 1}`;
      if (getSceneImageSlot(scene, idx) === n) opt.selected = true;
      imageSlotSel.appendChild(opt);
    }
    imageSlotSel.addEventListener('change', () => {
      connectSceneImageSlot(scene, idx, Number(imageSlotSel.value), scene.motion);
      renderEditor();
      drawFrame(timelineTime());
      log(`장면 ${idx + 1}에 이미지 ${Number(imageSlotSel.value) + 1}번을 연결했습니다.`);
    });

    mediaRow.append(aiBtn, chatgptBtn, attachBtn, imageSlotSel, motionSel, dropZone, upload);

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
      const asset = getSceneImageAsset(scene, idx);
      if (asset && !asset.customPrompt) asset.prompt = tx.value;
      const promptTextArea = card.querySelector('.scenePromptTextarea');
      if (promptTextArea && asset && !asset.customPrompt) promptTextArea.value = makeImagePrompt(asset.prompt || scene.prompt || scene.fullText || tx.value || '', getSceneImageSlot(scene, idx));
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
    promptLabel.textContent = `이미지 ${getSceneImageSlot(scene, idx) + 1} 프롬프트`;

    const promptCopy = document.createElement('button');
    promptCopy.type = 'button';
    promptCopy.className = 'secondary scenePromptCopy';
    promptCopy.textContent = '프롬프트 복사';

    const promptBox = document.createElement('textarea');
    promptBox.className = 'scenePromptTextarea';
    promptBox.value = imageAsset.customPrompt || makeImagePrompt(imageAsset.prompt || scene.prompt || scene.fullText || cap.text || '', getSceneImageSlot(scene, idx));
    promptBox.placeholder = '이 장면 이미지 프롬프트';
    promptBox.addEventListener('input', () => {
      imageAsset.customPrompt = promptBox.value;
    });
    promptCopy.addEventListener('click', async () => {
      const prompt = imageAsset.customPrompt || promptBox.value || makeImagePrompt(imageAsset.prompt || scene.prompt || scene.fullText || cap.text || '', getSceneImageSlot(scene, idx));
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
    card.append(visualCol, info);
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
    const asset = getSceneImageAsset(scene, state.scenes.indexOf(scene));
    if (asset && !asset.customPrompt) asset.prompt = buildImageSlotPromptSource(getSceneImageSlot(scene, state.scenes.indexOf(scene))) || cap.text;
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
  if (!state.imageAssets) state.imageAssets = [];
  state.scenes.forEach((scene, idx) => {
    const asset = getSceneImageAsset(scene, idx);
    if (!asset.image || asset.imageObj) return;
    const img = new Image();
    img.onload = () => {
      asset.imageObj = img;
      scene.imageObj = img;
      drawFrame(timelineTime());
    };
    img.src = asset.image;
  });
}

function drawCoverImage(img, x, y, w, h, t, scene) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  let scale = Math.max(w / iw, h / ih);
  const sceneIdx = state.scenes.indexOf(scene);
  const linkedWindow = getSceneLinkedMotionWindow(scene, sceneIdx);
  const localDur = Math.max(0.1, linkedWindow.end - linkedWindow.start);
  const p = clamp((t - linkedWindow.start) / localDur, 0, 1);
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
  syncScenesFromCaptions();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#070b12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const scene = getSceneAtTime(t);
  const cap = getCaptionAtTime(t);
  if (scene) {
    const idx = state.scenes.indexOf(scene);
    const asset = getSceneImageAsset(scene, idx);
    const imgObj = asset?.imageObj || scene.imageObj;
    if (imgObj) drawCoverImage(imgObj, 0, 0, canvas.width, canvas.height, t, scene);
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

async function playPreview() {
  // 재생 버튼을 누르면 음성파일이 있는 경우 먼저 음성·자막 분석을 끝낸 뒤 미리보기를 시작한다.
  // 이미 분석 완료 상태면 다시 분석하지 않고 바로 재생한다.
  finishPreview(false);

  const audio = $('audio');
  const hasAudio = !!(audio && audio.src && state.audioFile);
  const hasScript = !!(($('rightScriptEditor')?.value || $('generatedScript')?.value || '').trim());
  if (hasAudio && hasScript && !state.audioAnalysisReady) {
    log('재생 전 음성·자막 분석을 먼저 실행합니다.');
    const ok = await analyzeAudioAndCaptions();
    if (!ok) return;
    finishPreview(false);
  }

  let current = parseFloat($('previewSeek')?.value || '0') || 0;
  const total = Math.max(0, state.audioDuration || 0);
  if (current >= total - 0.05) current = 0;

  state.playing = true;
  state.playStartTime = current;
  state.playStartMs = performance.now();

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
  setImageAssetData(getSceneImageSlot(scene, idx), await fileToDataURL(file), scene, idx);
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

async function generateSceneImage(scene, idx, provider = '') {
  const asset = getSceneImageAsset(scene, idx);
  const prompt = asset.customPrompt || makeImagePrompt(asset.prompt || scene.prompt || scene.fullText || '', getSceneImageSlot(scene, idx));
  await navigator.clipboard?.writeText(prompt).catch(() => {});
  const box = $('imagePromptList');
  if (box) box.value = prompt;
  openImageProvider(prompt, idx, provider);
  const providerName = provider === 'gemini' ? 'Gemini' : provider === 'chatgpt' ? 'ChatGPT' : '생성 사이트';
  log(`이미지 ${getSceneImageSlot(scene, idx) + 1}번 프롬프트를 복사하고 ${providerName} 창을 열었습니다. 열린 창에서 붙여넣기 후 생성 버튼을 누르세요.`);
}

function imageProviderUrl(provider = '') {
  const selected = provider || $('imageProvider')?.value || 'chatgpt';
  if (selected === 'gemini') return 'https://gemini.google.com/app';
  if (selected === 'manual') return '';
  return 'https://chatgpt.com/';
}


function buildImageProviderUrl(promptText = '', sceneIndex = '', provider = '') {
  // 확장프로그램 없이 쓰는 최종 방식: 생성 사이트만 연다.
  // 프롬프트는 클립보드에 복사되므로 ChatGPT/Gemini 입력창에 붙여넣으면 된다.
  return imageProviderUrl(provider);
}

function openImageProvider(promptText = '', sceneIndex = '', provider = '') {
  const url = buildImageProviderUrl(promptText, sceneIndex, provider);
  if (!url) return;
  window.open(url, '_blank', 'noopener');
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
  const autoSeed = cleanSeoTopicText($('autoSeedTopic')?.value || getAutoTopicSeed());
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
  const useCaption = $('useCaptionForImage')?.checked !== false;
  const sourceText = useCaption ? text : '';
  const base = makePromptSourceText(sourceText);
  const topicGuide = 'person, age, outfit, background, lighting, and emotion must match the Korean Shorts topic naturally';
  const common = 'vertical 9:16, cinematic composition, strong emotional storytelling, mobile friendly framing, no text, no subtitles, no watermark, no logo';
  const realism = 'realistic cinematic photography, natural Korean atmosphere, expressive but not exaggerated, warm natural color grading, shallow depth of field, detailed background, natural skin texture';
  const ghibli = 'Studio Ghibli inspired hand painted animation, soft watercolor background, traditional cel animation feeling, gentle colors, warm natural lighting, nostalgic mood, simple facial features, painted environment, peaceful emotional atmosphere, no modern glossy anime style, no hyper detailed anime, no sharp neon lighting';
  const personAge = 'Korean person with age matching the topic, can be young adult, middle aged, or older when appropriate, natural pose, believable emotion';
  const bgOnly = 'environment only, landscape only, empty scene, no people, no person, no character, no human, no face, no body';

  if (style === 'comic-bg') return `${base}, ${ghibli}, ${bgOnly}, background scenery matching the topic, ${common}`;
  if (style === 'photo-bg') return `${base}, ${realism}, ${bgOnly}, realistic background scenery matching the topic, ${common}`;
  if (style === 'comic-person') return `${base}, ${ghibli}, ${personAge}, single person, close-up or medium shot, ${topicGuide}, ${common}`;
  if (style === 'comic-person-bg') return `${base}, ${ghibli}, ${personAge}, person and background matching the topic, storybook composition, ${topicGuide}, ${common}`;
  if (style === 'photo-person') return `${base}, ${realism}, ${personAge}, single person, portrait scene, close-up or medium shot, ${topicGuide}, ${common}`;
  return `${base}, ${realism}, ${personAge}, person and background matching the topic, ${topicGuide}, ${common}`;
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
  syncScenesFromCaptions();
  refreshImageAssetPromptsFromGroups();

  const thumbnailPrompt = updateThumbnailPromptBox(true);
  const usedSlots = [...new Set(state.scenes.map((scene, idx) => getSceneImageSlot(scene, idx)))].sort((a, b) => a - b);
  const prompts = usedSlots.map((slot) => {
    const asset = ensureImageAsset(slot, null, slot);
    const source = asset.prompt || buildImageSlotPromptSource(slot);
    return asset.customPrompt || makeImagePrompt(source, slot);
  });
  const previewText = [`[썸네일]\n${thumbnailPrompt}`, ...prompts.map((p, i) => `[이미지 ${usedSlots[i] + 1}]\n${p}`)].join('\n\n');
  const box = $('imagePromptList');
  if (box) box.value = previewText;
  await navigator.clipboard?.writeText(previewText).catch(() => {});
  renderEditor();
  log(`썸네일 1개 + 묶인 이미지 프롬프트 ${prompts.length}개 생성 완료.`);
}


async function attachBulkImages(files) {
  const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  if (!state.scenes.length) {
    createCaptionsFromScript();
  }
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const per = getImageGroupSize();
  state.imageAssets = [];
  for (let i = 0; i < list.length; i++) {
    setImageAssetData(i, await fileToDataURL(list[i]), null, i);
  }
  state.scenes.forEach((scene, i) => {
    const slot = clamp(Math.floor(i / per), 0, Math.max(0, list.length - 1));
    scene.imageSlot = slot;
    const asset = getSceneImageAsset(scene, i);
    if (asset?.image) {
      scene.image = asset.image;
      scene.imageObj = null;
    }
  });
  cacheSceneImages();
  renderEditor();
  drawFrame(timelineTime());
  log(`이미지 ${list.length}장을 이미지 보관함에 넣고, 장면별 이미지 번호로 연결했습니다.`);
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
        setImageAssetData(idx, item.data, state.scenes[idx], idx);
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
    setImageAssetData(i, list[i], state.scenes[i], i);
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

function getRandomAutoImageKind() {
  const kinds = ['personBackground', 'person', 'background'];
  return kinds[Math.floor(Math.random() * kinds.length)] || 'personBackground';
}

function setImageStyleFromAuto(version, kind) {
  const styleMap = {
    photo: { personBackground: 'photo-person-bg', person: 'photo-person', background: 'photo-bg' },
    comic: { personBackground: 'comic-person-bg', person: 'comic-person', background: 'comic-bg' },
  };
  const fixedKind = kind === 'random' ? getRandomAutoImageKind() : kind;
  const val = styleMap[version]?.[fixedKind] || 'photo-person-bg';
  if ($('imageStyle')) $('imageStyle').value = val;
  return fixedKind;
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


// V62: 다운로드 안정화 전용 헬퍼. Blob URL을 보관하고, 링크 클릭/자동 다운로드를 둘 다 지원한다.
let senialLastDownloadUrl = '';
function prepareSenialDownload(blob, fileName, label = 'WEBM') {
  const link = $('downloadLink');
  if (senialLastDownloadUrl) {
    try { URL.revokeObjectURL(senialLastDownloadUrl); } catch (_) {}
    senialLastDownloadUrl = '';
  }
  const url = URL.createObjectURL(blob);
  senialLastDownloadUrl = url;

  if (link) {
    link.href = url;
    link.download = fileName;
    link.target = '_self';
    link.rel = 'noopener';
    link.textContent = `✅ ${label} 다운로드 클릭`;
    link.classList.remove('disabledDownload');
    link.style.pointerEvents = 'auto';
    link.style.display = 'block';
    link.onclick = (e) => {
      // 일부 브라우저에서 sticky a 태그 기본 다운로드가 막힐 때를 대비해 강제 클릭 방식 사용
      e.preventDefault();
      const a = document.createElement('a');
      a.href = senialLastDownloadUrl || url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
    };
  }

  // 생성 직후 자동 저장창도 한 번 띄운다. 실패해도 아래 링크로 다시 받을 수 있다.
  setTimeout(() => {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
    } catch (_) {}
  }, 250);

  return url;
}

async function renderWebm() {
  if (state.rendering) return;
  syncScenesFromCaptions();
  refreshImageAssetPromptsFromGroups();
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

      canvas.width = oldW;
      canvas.height = oldH;
      drawFrame(timelineTime());
      state.rendering = false;
      if (btn) {
        btn.classList.remove('renderingNow');
        btn.disabled = false;
        btn.textContent = `${renderType.label} 다시 생성`;
      }

      if (!chunks.length) {
        updateRenderProgress(0, '실패 - 녹화 데이터가 비어 있습니다');
        if (status) status.textContent = '실패: 녹화 데이터가 비어 있습니다. 다시 생성해 주세요.';
        if (link) {
          link.classList.add('disabledDownload');
          link.removeAttribute('href');
          link.textContent = '다운로드 실패 - 다시 생성해 주세요';
        }
        return;
      }

      const blob = new Blob(chunks, { type: renderType.mime });
      prepareSenialDownload(blob, `senial_video.${renderType.ext}`, renderType.label);
      updateRenderProgress(100, `완료 100% - 저장창이 안 뜨면 아래 ${renderType.label} 다운로드 클릭`);
      if (status) status.textContent = `완료: 아래 ${renderType.label} 다운로드 클릭`;
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
  syncScenesFromCaptions();
  const data = {
    captions: state.captions,
    scenes: state.scenes.map((s) => ({ ...s, imageObj: null })),
    imageAssets: (state.imageAssets || []).map((a) => ({ ...a, imageObj: null })),
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
      state.imageAssets = (data.imageAssets || []).map((a) => ({ ...a, imageObj: null }));
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


const SENIAL_SCRIPT_API_MODEL = 'gpt-4o-mini';
const SENIAL_OPENAI_MODEL_FALLBACKS = [
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'gpt-4.1-nano'
];
const SENIAL_GEMINI_MODEL = 'gemini-1.5-flash';
const SENIAL_GEMINI_MODEL_FALLBACKS = [
  'gemini-1.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-pro'
];
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
  '감성','명언','인생조언','인간관계','자기계발',
  '동기부여','성공습관','돈관리','부업','사업',
  '창업','건강상식','다이어트','여행','역사',
  '상식','심리학','뉴스','연애','가족'
];

const SENIAL_SEO_PROMPT_GUIDES = {
  '감성': '위로, 공감, 외로움, 지친 마음, 조용한 감정선을 중심으로 작성한다. 정보형 설명, 손해, 기준, 비용, 위험 같은 상식형 문장은 금지한다.',
  '명언': '짧고 강한 한 문장형 명언을 중심으로 작성한다. 군더더기 설명보다 여운과 저장 욕구를 만든다.',
  '인생조언': '살면서 겪는 현실적인 고민과 깨달음을 담는다. 경험담처럼 자연스럽게 말하고 훈계처럼 쓰지 않는다.',
  '인간관계': '친구, 직장, 가족, 지인 사이의 거리감, 말투, 상처, 손절, 진심을 중심으로 작성한다.',
  '자기계발': '습관, 실행, 루틴, 미루기 극복, 성장 포인트를 실천형으로 작성한다.',
  '동기부여': '지금 당장 다시 움직이게 만드는 에너지와 행동 유도 중심으로 작성한다.',
  '성공습관': '성공한 사람들이 반복하는 작은 습관, 시간관리, 태도, 실행 기준을 중심으로 작성한다.',
  '돈관리': '절약, 소비습관, 고정비, 저축, 현금흐름처럼 생활 돈관리 중심으로 작성한다.',
  '부업': '초보 부업, 온라인 부수입, 작게 테스트하기, 시간 대비 효율을 중심으로 작성한다.',
  '사업': '사장님, 자영업자, 매출, 고객, 플레이스, 블로그, 기본 세팅, 전환율 중심으로 작성한다.',
  '창업': '창업 준비, 아이템 검증, 초기 비용, 고객 찾기, 실패 줄이는 순서를 중심으로 작성한다.',
  '건강상식': '생활 습관과 일반 상식 중심으로 작성한다. 의사, 병원, 전문의 단어와 의료진 이미지 연상 표현은 금지한다.',
  '다이어트': '무리한 감량이 아니라 식습관, 운동 루틴, 지속 가능한 체중관리 중심으로 작성한다.',
  '여행': '여행지 선택, 코스, 예산, 이동, 감성 포인트, 실패 줄이는 팁 중심으로 작성한다.',
  '역사': '역사 속 사건, 인물, 선택, 반전 포인트를 쉽고 흥미롭게 작성한다.',
  '상식': '일상에서 바로 써먹는 정보, 몰랐던 사실, 실수 줄이는 기준 중심으로 작성한다.',
  '심리학': '사람 마음, 행동 이유, 관계 심리, 말투, 선택 심리를 쉽게 풀어 작성한다.',
  '뉴스': '오늘 날짜 기준 최근 흐름을 쉽게 요약한다. 확인 불가능한 사실은 단정하지 않고 흐름 중심으로 작성한다.',
  '연애': '연락, 서운함, 이별, 좋은 사람 구별, 관계 유지 기준을 현실적으로 작성한다.',
  '가족': '부모, 자식, 부부, 가족 사이의 말, 거리, 고마움, 상처를 따뜻하게 작성한다.'
};

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
  '인생조언': ['인생이 막막할 때 보는 조언','늦었다고 느낄 때 필요한 말','후회 줄이는 현실 기준','나이 들수록 중요해지는 것','힘든 시기를 지나가는 법','조용히 인생이 바뀌는 순간','사람이 달라지는 작은 선택','혼자 버티는 사람의 인생 조언','마음이 흔들릴 때 잡는 기준','오늘 하루를 다시 보는 말'],
  '인간관계': ['사람 관계에서 지치지 않는 법','멀어져야 할 사람의 신호','진짜 내 편을 알아보는 기준','말 한마디로 관계가 바뀌는 순간','착한 사람이 자주 상처받는 이유','인간관계에서 선을 긋는 법','함부로 마음 주면 힘든 이유','좋은 사람과 오래 가는 기준','관계가 불편할 때 봐야 할 것','나를 지키는 인간관계 습관'],
  '동기부여': ['포기하고 싶을 때 다시 움직이는 말','시작이 어려운 사람에게 필요한 말','오늘 당장 바뀌는 작은 행동','무기력할 때 보는 동기부여','결국 해내는 사람의 생각','멈춘 마음을 다시 깨우는 말','실패 후 다시 일어나는 기준','지금 시작해야 하는 이유','작게라도 움직여야 하는 순간','내일로 미루지 않는 한마디'],
  '성공습관': ['성공하는 사람이 매일 하는 습관','결과가 달라지는 아침 루틴','시간을 아끼는 사람의 기준','조용히 앞서가는 사람의 태도','성공하는 사람이 버린 습관','작게 시작해 크게 바뀌는 루틴','돈보다 먼저 쌓아야 할 습관','꾸준한 사람이 이기는 이유','하루를 망치지 않는 작은 기준','성공 확률을 올리는 생활 습관'],
  '창업': ['창업 전 반드시 확인할 기준','초보 창업자가 줄여야 할 비용','아이템보다 먼저 봐야 할 고객','창업 실패 줄이는 현실 체크','작게 테스트하고 시작하는 법','처음 장사할 때 놓치는 것','가게 열기 전 필요한 온라인 세팅','창업 준비 순서 1분 정리','초기 비용 아끼는 창업 기준','혼자 창업할 때 필요한 생각'],
  '건강상식': ['하루 컨디션을 바꾸는 생활 습관','아침에 몸이 무거운 이유','잠을 방해하는 작은 습관','물 마시는 습관 만들기','오래 앉아 있을 때 체크할 것','걷기가 주는 일상 변화','스트레스 줄이는 생활 루틴','피곤한 날 회복하는 방법','무리하지 않고 몸 챙기는 기준','생활 속 건강상식 1분 정리'],
  '다이어트': ['다이어트가 자꾸 무너지는 이유','살 빼기 전에 바꿔야 할 습관','야식 줄이는 현실 방법','운동보다 먼저 잡아야 할 식습관','무리하지 않는 체중관리 기준','다이어트 초보가 놓치는 포인트','요요 줄이는 생활 루틴','배고픔을 이기는 작은 습관','식단 스트레스 줄이는 법','꾸준히 빠지는 사람의 공통점'],
  '심리학': ['사람 마음을 알 수 있는 작은 신호','상대가 거리 두는 심리','말투에 숨은 진짜 마음','자꾸 미루는 사람의 심리','착한 사람이 거절 못하는 이유','불안할 때 마음이 하는 행동','관계에서 집착이 생기는 이유','사람이 변하는 순간의 심리','첫인상이 오래가는 이유','심리학으로 보는 인간관계'],
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

function normalizeScriptApiProvider(provider) {
  const value = String(provider || '').toLowerCase().trim();
  if (value === 'gemini' || value === 'google') return 'gemini';
  if (value === 'claude' || value === 'anthropic') return 'claude';
  if (value === 'gpt' || value === 'openai') return 'openai';
  return 'openai';
}

function getSelectedScriptApiProvider() {
  return normalizeScriptApiProvider($('scriptApiProvider')?.value || localStorage.getItem(SENIAL_API_PROVIDER_STORAGE) || 'openai');
}

function detectScriptApiProviderFromKey(key) {
  const k = String(key || '').trim();
  if (/^AIza[0-9A-Za-z_\-]+/.test(k)) return 'gemini';
  if (/^sk-ant-[0-9A-Za-z_\-]+/.test(k)) return 'claude';
  if (/^sk-proj-[0-9A-Za-z_\-]+/.test(k) || /^sk-[0-9A-Za-z_\-]+/.test(k)) return 'openai';
  return '';
}

function resolveScriptApiProvider(key = $('openaiApiKey')?.value || '') {
  const selected = getSelectedScriptApiProvider();
  const detected = detectScriptApiProviderFromKey(key);
  const provider = detected || selected;
  const select = $('scriptApiProvider');
  if (select && select.value !== provider) select.value = provider;
  localStorage.setItem(SENIAL_API_PROVIDER_STORAGE, provider);
  return provider;
}

function getScriptApiProvider() {
  return resolveScriptApiProvider();
}

function getScriptApiKeyStorageName(provider = getSelectedScriptApiProvider()) {
  return `${SENIAL_API_KEY_STORAGE}_${normalizeScriptApiProvider(provider)}`;
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
  const providerSelect = $('scriptApiProvider');
  const provider = normalizeScriptApiProvider(localStorage.getItem(SENIAL_API_PROVIDER_STORAGE) || providerSelect?.value || 'openai');
  if (providerSelect) providerSelect.value = provider;
  if (!input) return;
  input.value = sessionStorage.getItem(getScriptApiKeyStorageName(provider)) || '';
  input.type = 'password';
  setApiCheckStatus('확인안됨', 'fail');
}

function saveApiKeyFromInput() {
  const input = $('openaiApiKey');
  if (!input) return;
  const key = String(input.value || '').trim();
  const provider = resolveScriptApiProvider(key);
  localStorage.setItem(SENIAL_API_PROVIDER_STORAGE, provider);
  if (key) {
    sessionStorage.setItem(getScriptApiKeyStorageName(provider), key);
  } else {
    sessionStorage.removeItem(getScriptApiKeyStorageName(provider));
  }
}

function handleScriptApiProviderChange() {
  const provider = getSelectedScriptApiProvider();
  localStorage.setItem(SENIAL_API_PROVIDER_STORAGE, provider);
  const saved = sessionStorage.getItem(getScriptApiKeyStorageName(provider)) || '';
  if ($('openaiApiKey')) {
    $('openaiApiKey').value = saved;
    $('openaiApiKey').type = 'password';
  }
  setApiCheckStatus('확인안됨', 'fail');
  log(`${provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude' : 'GPT'} API 모드로 변경했습니다.`);
}

function openScriptApiSite() {
  const url = SENIAL_SCRIPT_API_LINKS[getSelectedScriptApiProvider()] || SENIAL_SCRIPT_API_LINKS.openai;
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
  let clean = sanitizeGeneratedScript(script);
  const selectedTitle = cleanSeoTopicText($('scriptTopic')?.value || '');
  if (selectedTitle) {
    const lines = clean.split(/\n+/).map(v => v.trim()).filter(Boolean);
    if (lines.length > 1 && plainKey(lines[0]) === plainKey(selectedTitle)) {
      clean = lines.slice(1).join('\n').trim();
    }
  }
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
      `${t}이 마음에 오래 남는 날이 있습니다`,
      `설명하기 어려운 감정도 분명히 내 안에 남습니다`,
      `괜찮은 척 지나온 시간에도 의미는 있습니다`,
      `남들이 모른다고 해서 사라지는 마음은 아닙니다`,
      `조용히 흔들린 순간도 나를 조금씩 바꿉니다`,
      `오늘의 마음을 너무 쉽게 넘기지 않아도 됩니다`,
      `${tone} 나에게 조금 다정해져도 괜찮습니다`,
      `이 말이 필요한 순간 다시 꺼내보세요`
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

    '인생조언': [
      `살다 보면 누구나 방향을 잃는 순간이 있습니다`,
      `그럴 때 필요한 건 대단한 답보다 나를 잃지 않는 기준입니다`,
      `남의 속도에 맞추다 보면 내 마음이 먼저 지칩니다`,
      `늦었다는 생각보다 오늘 무엇을 다시 할지 보는 게 중요합니다`,
      `인생은 한 번에 바뀌지 않고 작은 선택으로 조금씩 달라집니다`,
      `지금 흔들린다고 실패한 건 아닙니다`,
      `${tone} 오늘의 나를 너무 쉽게 판단하지 마세요`,
      `이 말이 필요한 순간 다시 꺼내보세요`
    ],
    '인간관계': [
      `사람 관계가 힘들다면 먼저 내 마음의 소모를 봐야 합니다`,
      `좋은 사람은 나를 계속 불안하게 만들지 않습니다`,
      `모든 관계를 붙잡으려고 하면 결국 내가 먼저 지칩니다`,
      `거리 두기는 미움이 아니라 나를 지키는 방법일 수 있습니다`,
      `진심은 자주 설명하지 않아도 행동에서 보입니다`,
      `혼자만 애쓰는 관계라면 잠시 멈춰서 봐야 합니다`,
      `${tone} 오래 가는 관계는 편안함에서 시작됩니다`,
      `떠오르는 사람이 있다면 이 기준을 기억하세요`
    ],
    '동기부여': [
      `지금 멈춰 있어도 다시 시작할 수 있습니다`,
      `중요한 건 완벽한 준비가 아니라 작은 행동 하나입니다`,
      `기분이 나아질 때까지 기다리면 시작은 계속 밀립니다`,
      `오늘 5분이라도 움직이면 내일의 내가 달라집니다`,
      `결국 해내는 사람은 특별해서가 아니라 다시 했기 때문입니다`,
      `실패한 날보다 포기한 날이 더 오래 남습니다`,
      `${tone} 지금 할 수 있는 가장 작은 일부터 하세요`,
      `다시 움직이고 싶다면 이 영상을 저장하세요`
    ],
    '성공습관': [
      `성공하는 사람은 거창한 습관보다 작은 반복이 다릅니다`,
      `하루를 망치지 않는 기준 하나를 먼저 정합니다`,
      `중요한 일을 먼저 끝내는 사람이 결국 시간을 얻습니다`,
      `감정에 맡기지 않고 환경을 만들어 실행합니다`,
      `작은 약속을 지키는 힘이 큰 결과를 만듭니다`,
      `꾸준함은 재능보다 오래 남는 무기입니다`,
      `${tone} 오늘 하나만 반복해도 충분히 시작입니다`,
      `성공 습관이 필요하다면 저장해두세요`
    ],
    '창업': [
      `창업은 아이템보다 고객을 먼저 봐야 합니다`,
      `좋아 보이는 사업도 사줄 사람이 없으면 오래가기 어렵습니다`,
      `처음부터 크게 벌리기보다 작게 테스트하는 게 안전합니다`,
      `초기 비용은 줄이고 반응은 빠르게 확인해야 합니다`,
      `가게든 온라인이든 고객이 왜 선택해야 하는지 분명해야 합니다`,
      `준비가 부족한 창업은 매출보다 불안이 먼저 커집니다`,
      `${tone} 시작 전 고객과 비용을 따로 적어보세요`,
      `창업 준비 중이라면 이 기준을 저장하세요`
    ],
    '건강상식': [
      `컨디션이 자주 무너지면 생활 흐름부터 봐야 합니다`,
      `잠 식사 움직임은 생각보다 하루 기분을 크게 바꿉니다`,
      `무리한 계획보다 지킬 수 있는 작은 루틴이 먼저입니다`,
      `오래 앉아 있다면 중간에 몸을 풀어주는 습관이 필요합니다`,
      `물 마시기 걷기 정리만 해도 하루가 조금 가벼워집니다`,
      `중요한 건 한 번에 바꾸는 게 아니라 반복하는 겁니다`,
      `${tone} 오늘은 몸이 덜 지치는 선택 하나만 해보세요`,
      `일상 루틴이 필요하다면 이 기준을 저장하세요`
    ],
    '다이어트': [
      `다이어트가 자꾸 무너지는 건 의지가 약해서만은 아닙니다`,
      `처음부터 너무 줄이면 오래 버티기 어렵습니다`,
      `먼저 야식 음료 간식처럼 반복되는 습관을 봐야 합니다`,
      `운동보다 중요한 건 다시 돌아갈 수 있는 루틴입니다`,
      `매일 완벽하려고 하면 하루 실수에 쉽게 포기합니다`,
      `조금씩 줄이고 오래 가는 방식이 현실적입니다`,
      `${tone} 오늘은 한 가지 습관만 바꿔보세요`,
      `체중관리 중이라면 이 기준을 저장하세요`
    ],
    '심리학': [
      `사람 마음은 말보다 반복되는 행동에서 더 잘 보입니다`,
      `상대가 자주 피한다면 이유보다 거리감을 먼저 봐야 합니다`,
      `불안할수록 사람은 확인받고 싶어집니다`,
      `거절을 어려워하는 사람은 관계에서 쉽게 지칩니다`,
      `심리는 복잡해 보여도 결국 내 마음을 지키는 기준이 필요합니다`,
      `상대 마음만 보다가 내 감정을 놓치면 관계가 흔들립니다`,
      `${tone} 오늘은 말보다 행동을 차분히 보세요`,
      `사람 마음이 궁금하다면 저장해두세요`
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
  const category = getAutoMainTopic() || $('scriptCategory')?.value || '상식';
  const picked = stripTopicCategoryPrefix(cleanSeoTopicText($('scriptTopic')?.value || ''));
  const topic = picked || stripTopicCategoryPrefix(cleanSeoTopicText($('autoSubTopic')?.value || '')) || stripTopicCategoryPrefix(cleanSeoTopicText($('autoSeedTopic')?.value || '')) || cleanSeoTopicText(getTopicSuggestions(category)[0] || category);
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
    .map((line) => stripTopicCategoryPrefix(line)
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

function buildKeywordLocalTopics(seed, count = 10, category = '') {
  const clean = stripTopicCategoryPrefix(cleanSeoTopicText(seed || ''));
  if (!clean) return [];
  const c = String(category || '').trim();
  const mood = isEmotionalTopicCategory(c) ? 'emotion' : inferTopicMood(clean);
  const banks = {
    emotion: [
      `${clean}이 마음에 남는 이유`,
      `${clean}을 지나며 알게 된 것`,
      `${clean} 속에서 찾은 작은 위로`,
      `${clean}이 끝난 뒤 남는 마음`,
      `${clean} 앞에서 조용히 떠오른 생각`,
      `${clean}이 나에게 남긴 한 문장`,
      `${clean}처럼 마음이 흔들릴 때`,
      `${clean}을 겪은 사람에게 필요한 말`,
      `${clean} 뒤에 숨어 있던 진심`,
      `${clean}이 조금 다르게 보이는 순간`
    ],
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
      `${clean}에서 오래 남는 순간`,
      `${clean}을 더 깊게 느끼는 법`,
      `${clean}이 특별해지는 이유`,
      `${clean}에서 놓치기 쉬운 감정`,
      `${clean}을 기억으로 남기는 방법`,
      `${clean} 속 작은 여유 찾기`,
      `${clean}이 끝난 뒤 남는 것`,
      `${clean}을 다르게 보는 시선`,
      `${clean}에서 마음이 움직이는 순간`,
      `${clean}을 편하게 즐기는 기준`
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
  state.imageAssets = [];
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

function buildBasicSampleScript(topic) {
  const category = $('scriptCategory')?.value || '상식';
  const request = String($('scriptRequest')?.value || '').trim();
  const lines = categorySeoScriptLines(category, topic || category, request);
  return sanitizeGeneratedScript(lines.join('\n\n'));
}

async function selectScriptTopic(topic) {
  // 좌측 기본대본: 고르기 즉시 샘플 대본만 넣는다. API 호출 금지.
  const clean = cleanSeoTopicText(topic);
  const prev = String($('scriptTopic')?.value || '').trim();
  if (clean && clean !== prev) clearScriptSceneStateForNewTopic('기본대본 주제 변경');
  if ($('scriptTopic')) $('scriptTopic').value = clean;
  renderTopicSuggestions(clean);
  makeSeoKeywords(false);
  const sample = buildBasicSampleScript(clean);
  setScriptIntoEditors(sample);
  log(`기본대본 샘플 적용: ${clean}. API를 사용하지 않았습니다. 반복될 수 있으니 진짜 자동생성은 우측 세니얼 시작하기를 사용하세요.`);
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
  const main = getAutoMainTopic() || $('scriptCategory')?.value || '';
  const base = stripTopicCategoryPrefix(String(seed || '').trim() || '요즘 트렌드');
  const prev = previousTopics.length ? previousTopics.slice(-30).map((t, i) => `${i + 1}. ${t}`).join('\n') : '없음';
  return `너는 대한민국 유튜브 쇼츠 제목 전문가다.

[오늘 날짜]
${today}

[메인주제]
${main || '미지정'}

[카테고리 또는 주제]
${base}

[주제별 제목 방향]
${getTopicTitleStyleGuide(main)}

[이미 보여준 제목]
${prev}

[목표]
위 제목과 겹치지 않게 메인주제 말투에 맞는 쇼츠 제목 10개를 새로 생성하라.

[조건]
- 검색량이 높을 가능성이 있는 키워드 우선
- 요즘 트렌드 반영
- 클릭률 높은 제목
- 50대 이상도 이해하기 쉽게 작성
- 제목은 15자에서 25자 사이 권장
- 과장, 허위, 공포 조장 금지
- 건강상식 주제에서는 의사, 병원, 전문의 단어 금지
- 감성, 명언, 인생조언, 인간관계, 연애, 가족에서는 꼭 볼 포인트, 실패 줄이는 기준, 체크리스트, 핵심 정리 같은 정보형 표현 금지
- 제목 앞에 메인주제명과 슬래시를 붙이지 않기
- 이전 제목과 중복 금지

[출력]
- 번호와 제목만 출력
- 설명, 해시태그, 따옴표, 느낌표 금지
- 한 줄에 제목 1개

지금 바로 새로운 제목 10개만 출력해라.`;
}

async function refreshScriptTopicsByKeyword() {
  // 좌측은 기본샘플 전용이다. API 호출부와 완전히 분리해서 우측 세니얼 시작하기와 충돌하지 않게 한다.
  const category = $('scriptCategory')?.value || '상식';
  const btn = $('btnMakeKeywords');
  if (btn) btn.disabled = true;
  try {
    clearScriptSceneStateForNewTopic('기본샘플 제목 새로 보기');
    if ($('scriptTopic')) $('scriptTopic').value = '';
    makeSeoKeywords(true, true);
    log(`${category} 기본샘플 제목 10개를 다시 불러왔습니다. 기본샘플은 API를 사용하지 않습니다.`);
  } finally {
    if (btn) btn.disabled = false;
  }
}


function getAutoMainTopic() {
  return cleanSeoTopicText($('autoMainTopic')?.value || $('autoSeedTopic')?.value || '');
}

function getAutoSubTopic() {
  return cleanSeoTopicText($('autoSubTopic')?.value || '');
}

function getAutoTopicSeed() {
  const main = getAutoMainTopic();
  const sub = getAutoSubTopic();
  // 화면/대본에 '감성 / 제목'처럼 카테고리가 섞이지 않게, 실제 제목 씨앗은 부주제를 우선 사용한다.
  // 메인주제는 프롬프트 내부 방향성으로만 사용한다.
  return sub || main || String($('scriptCategory')?.value || '').trim() || '요즘 트렌드';
}

function isEmotionalTopicCategory(category) {
  return ['감성', '명언', '인생조언', '인간관계', '연애', '가족'].includes(String(category || '').trim());
}

function getTopicTitleStyleGuide(category) {
  const c = String(category || '').trim();
  const guides = {
    '감성': '감정, 여운, 공감, 위로 중심의 제목. 꼭 볼 포인트, 실패 줄이는 기준, 핵심 정리, 체크리스트 같은 정보형 표현 금지.',
    '명언': '짧고 강한 한 문장형 제목. 설명형 표현보다 저장하고 싶은 문장으로 작성.',
    '인생조언': '인생 경험과 깨달음 중심 제목. 훈계형, 정보형 표현 금지.',
    '인간관계': '관계의 거리감, 상처, 진심, 선 긋기 중심 제목.',
    '연애': '연락, 서운함, 이별, 좋은 사람 구별 같은 현실 감정 중심 제목.',
    '가족': '부모, 자식, 부부, 고마움, 상처, 따뜻한 말 중심 제목.',
    '사업': '사장님, 매출, 고객, 온라인 세팅, 전환율 중심의 실전형 제목.',
    '창업': '창업 준비, 초기 비용, 고객 검증, 실패 줄이기 중심 제목.',
    '돈관리': '절약, 소비습관, 고정비, 저축, 현금흐름 중심 제목.',
    '부업': '초보 부업, 온라인 부수입, 작게 테스트하기 중심 제목.',
    '건강상식': '생활 습관 중심의 일반 건강 상식 제목. 의사, 병원, 전문의 단어 금지.',
    '다이어트': '무리 없는 식습관, 루틴, 지속 가능한 체중관리 중심 제목.',
    '여행': '여행 감정, 코스, 여유, 기억, 실패 없는 준비 중심 제목.',
    '역사': '역사 속 사건, 선택, 반전, 사람 이야기 중심 제목.',
    '상식': '일상에서 바로 이해되는 정보형 제목.',
    '심리학': '사람 마음, 행동 이유, 말투, 관계 심리 중심 제목.',
    '뉴스': '오늘 날짜 기준 흐름을 쉽게 보는 제목. 확인 불가 사실 단정 금지.',
    '자기계발': '습관, 실행, 루틴, 성장 중심 제목.',
    '동기부여': '지금 움직이게 만드는 에너지와 행동 중심 제목.',
    '성공습관': '성공한 사람들의 반복 습관과 태도 중심 제목.'
  };
  return guides[c] || '선택한 메인주제의 말투와 소재를 따르는 제목.';
}

function stripTopicCategoryPrefix(text) {
  const categories = SENIAL_TOPIC_LIST || [];
  let clean = String(text || '').trim();
  for (const c of categories) {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp(`^\\s*${esc}\\s*[\\/|>:-]\\s*`, 'u'), '').trim();
  }
  return clean;
}


function syncLegacyAutoSeedTopic() {
  const seed = getAutoTopicSeed();
  if ($('autoSeedTopic')) $('autoSeedTopic').value = seed;
  return seed;
}

function buildSeoScriptPrompt() {
  const autoMain = getAutoMainTopic();
  const autoSub = getAutoSubTopic();
  const category = autoMain || $('scriptCategory')?.value || '상식';
  const topic = stripTopicCategoryPrefix(String($('scriptTopic')?.value || '').trim() || autoSub);
  const request = String($('scriptRequest')?.value || '').trim();
  const keywordText = String($('seoKeywordBox')?.value || '').trim() || makeSeoKeywords();
  const lengthSec = Number($('autoScriptLength')?.value || $('scriptLength')?.value || 30);
  const targetLines = lengthSec <= 30 ? '10~12문장' : lengthSec <= 40 ? '13~16문장' : '18~22문장';
  const today = getTodayKoreanDate();

  return `너는 한국어 유튜브 쇼츠 SEO 대본 작가다.

[오늘 날짜]
${today}

[메인주제]
${category}

[부주제]
${autoSub || '없음'}

[선택된 제목]
${topic || autoSub || category}

[상위노출 키워드]
${keywordText}

[주제별 전용 작성 방향]
${SENIAL_SEO_PROMPT_GUIDES[category] || SENIAL_SEO_PROMPT_GUIDES['상식']}

[추가 방향]
${request || '없음'}

[목표]
- ${lengthSec}초 내외 쇼츠 대본 작성
- 모바일 쇼츠에서 첫 3초 이탈률을 낮추는 구조
- 상위노출 키워드를 자연스럽게 포함하되 억지 반복 금지
- 선택된 제목은 내부 주제로만 사용하고 대본 첫 줄에 제목을 그대로 쓰지 않기
- 첫 문장에 메인주제명, 슬래시, 카테고리명 출력 금지
- 첫 문장은 '혹시 오늘도'로 시작하지 않기
- 끝 문장은 저장, 공유, 댓글을 유도하되 과장하지 않기

[절대 규칙]
- 출력은 대본 본문만 작성
- 제목, 설명, 해시태그, 번호, 단계명 쓰지 않기
- 따옴표, 느낌표, 특수문자 쓰지 않기
- 한 문장은 짧게
- 한 줄은 10~14자 안팎으로 모바일 자막과 TTS 호흡에 맞게 작성
- 총 ${targetLines}으로 작성
- 30초는 최소 10줄 이상 40초는 최소 13줄 이상 1분은 최소 18줄 이상 작성
- 짧은 제목형 문장만 나열하지 말고 자연스러운 내레이션으로 작성
- 같은 문장 반복 금지
- 확인되지 않은 사실을 단정하지 않기
- 뉴스 주제는 실시간 검색 결과를 확인할 수 없으면 확정 표현 대신 ${today} 기준 최근 흐름 중심으로 작성
- 건강상식 주제에서는 의사, 병원, 전문의 단어와 의료진 이미지 연상 표현 금지
- 감성, 명언, 인생조언, 인간관계, 연애, 가족 주제는 정보형 SEO 템플릿처럼 쓰지 않기
- 모든 주제에 같은 문장 구조를 반복하지 않기
- 선택한 메인주제의 말투와 소재를 반드시 우선 적용하기
- 감성, 명언, 인생조언, 인간관계, 연애, 가족 주제에서는 꼭 볼 포인트, 실패 줄이는 기준, 체크리스트, 핵심 정리 같은 정보형 표현 금지
- 대본 안에 '감성 / 제목' 같은 형식 출력 금지

[대본 구조]
1문장 강한 후킹
2문장 공감 또는 문제 제기
3문장부터 마지막 전까지 핵심 내용과 이유
마지막 문장 저장/댓글 유도

지금 바로 대본만 작성해라.`;
}


function buildAutoTopicPrompt(seed) {
  const today = getTodayKoreanDate();
  const main = getAutoMainTopic();
  const sub = getAutoSubTopic();
  const base = String(seed || '').trim() || getAutoTopicSeed();
  return `너는 대한민국 유튜브 쇼츠 SEO 전문가이자 트렌드 분석가다.

[오늘 날짜]
${today}

[메인주제]
${main || base}

[부주제]
${sub || '없음'}

[검색 기준]
${stripTopicCategoryPrefix(base)}

[주제별 제목 방향]
${getTopicTitleStyleGuide(main)}

[목표]
대한민국 사용자가 오늘 기준 관심 가질 만한 쇼츠 제목 10개를 생성하라.
메인주제에서 벗어나지 말고, 부주제가 있으면 부주제 방향으로 좁혀서 생성하라.
메인주제는 분류 기준으로만 쓰고 제목 앞에 붙이지 마라.

[생성 기준]
- 오늘 날짜 기준 최신 흐름과 요즘 트렌드 반영
- 검색량이 높을 가능성이 있는 키워드 우선
- 유튜브 쇼츠 제목으로 바로 쓸 수 있게 작성
- 50대 이상도 이해하기 쉬운 제목
- 클릭률 높은 후킹형 제목
- 과장, 허위, 공포 조장 금지
- 서로 다른 주제만 생성
- 제목은 15자에서 25자 사이 권장
- 건강상식 주제에서는 의사, 병원, 전문의 단어 금지
- 감성, 명언, 인생조언, 인간관계, 연애, 가족에서는 꼭 볼 포인트, 실패 줄이는 기준, 체크리스트, 핵심 정리 같은 정보형 표현 금지
- 제목 앞에 메인주제명과 슬래시를 붙이지 않기

[출력 규칙]
- 번호와 제목만 출력
- 설명, 해시태그, 따옴표, 느낌표 금지
- 한 줄에 주제 1개

예시 형식
1. 여행이 끝난 뒤 남는 마음
2. 매출보다 먼저 봐야 할 흐름

지금 바로 주제 10개만 출력해라.`;
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
    .slice(0, 10);
}

async function callOpenAiText(apiKey, prompt, systemText = '너는 한국어 콘텐츠 생성 전문가다. 요청한 형식만 출력한다.', maxTokens = 900) {
  const models = [SENIAL_SCRIPT_API_MODEL, ...(SENIAL_OPENAI_MODEL_FALLBACKS || [])]
    .filter((v, i, arr) => v && arr.indexOf(v) === i);
  let lastError = null;

  for (const model of models) {
    try {
      const res = await fetch(SENIAL_OPENAI_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.85,
          max_tokens: Math.max(256, Number(maxTokens) || 900),
          messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: prompt }
          ]
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = new Error(`${data?.error?.message || `OpenAI API 오류 ${res.status}`} / 시도 모델: ${model}`);
        continue;
      }
      const text = data?.choices?.[0]?.message?.content || '';
      if (String(text).trim()) return text;
      lastError = new Error(`OpenAI 응답이 비어 있습니다. / 시도 모델: ${model}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('OpenAI API 호출 실패');
}

async function callScriptProviderText(provider, apiKey, prompt, maxTokens = 900) {
  const actualProvider = resolveScriptApiProvider(apiKey || '');
  if (actualProvider === 'gemini') return callGeminiScript(apiKey, prompt, maxTokens);
  if (actualProvider === 'claude') return callClaudeScript(apiKey, prompt, maxTokens);
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
  const apiKey = String($('openaiApiKey')?.value || '').trim();
  const provider = resolveScriptApiProvider(apiKey);
  if ($('scriptApiProvider')) $('scriptApiProvider').value = provider;
  const seed = syncLegacyAutoSeedTopic();
  const mainCategory = getAutoMainTopic();
  if (mainCategory && $('scriptCategory')) $('scriptCategory').value = mainCategory;
  const scope = `auto:${mainCategory || seed}`;
  const btn = $('btnAutoTopicGenerate');
  if (btn) btn.disabled = true;
  if ($('autoStyleBox')) $('autoStyleBox').style.display = 'none';
  log('API키로 시작하기: API로 주제를 생성 중입니다.');

  try {
    if (!apiKey) {
      renderAutoTopicResults([]);
      log('API 키가 없어 주제 생성을 중단했습니다. API 모드에서는 기본 주제를 섞지 않습니다.');
      $('openaiApiKey')?.focus();
      return;
    }
    saveApiKeyFromInput();
    const prompt = getGeneratedTopicHistory(scope).length ? buildTopicRefreshPrompt(seed, getGeneratedTopicHistory(scope)) : buildAutoTopicPrompt(seed);
    const raw = await callScriptProviderText(provider, apiKey, prompt, 900);
    const topics = parseAutoTopics(raw).slice(0, 10);
    if (!topics.length) throw new Error('API 응답에서 주제를 찾지 못했습니다.');
    rememberGeneratedTopics(scope, topics);
    clearScriptSceneStateForNewTopic('API키로 시작하기');
    if ($('scriptTopic')) $('scriptTopic').value = '';
    if ($('autoSeedTopic')) $('autoSeedTopic').value = seed;
    renderAutoTopicResults(topics);
    log('API SEO 주제 생성 완료. 고르기를 누른 주제 1개만 사용합니다. 기본모드는 사용하지 않았습니다.');
  } catch (err) {
    clearScriptSceneStateForNewTopic('API키로 시작하기 API 실패');
    if ($('scriptTopic')) $('scriptTopic').value = '';
    if ($('autoSeedTopic')) $('autoSeedTopic').value = seed;
    renderAutoTopicResults([]);
    log(`API 주제 생성 실패: ${err.message || err}. 기본모드로 대체하지 않았습니다.`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function selectAutoModeTopic(topic) {
  const clean = String(topic || '').replace(/["“”‘’`!！]/g, '').trim();
  if (!clean) return;
  const prev = String($('scriptTopic')?.value || '').trim();
  if (clean !== prev) clearScriptSceneStateForNewTopic('API 주제 선택');
  if ($('scriptTopic')) $('scriptTopic').value = clean;
  if ($('autoSeedTopic')) $('autoSeedTopic').value = clean;
  renderAutoTopicResults(Array.from(document.querySelectorAll('[data-auto-topic]')).map(b => b.dataset.autoTopic || b.textContent || '').filter(Boolean), clean);
  makeSeoKeywords(false);
  if ($('autoStyleBox')) $('autoStyleBox').style.display = 'block';
  if ($('autoPhotoMenu')) $('autoPhotoMenu').style.display = 'none';
  if ($('autoComicMenu')) $('autoComicMenu').style.display = 'none';
  log(`API 주제 선택 완료: ${clean}. 이제 대본 만들기를 누르세요.`);
}

function openOndokuForVoice() {
  window.open('https://ondoku3.com/', '_blank', 'noopener');
}

async function runAutoModeFromTopic(version, kind) {
  setImageStyleFromAuto(version, kind);
  syncAutoScriptLengthToMain();
  const existingScript = String($('rightScriptEditor')?.value || $('generatedScript')?.value || '').trim();
  if (!existingScript) {
    log('먼저 대본 만들기를 눌러 대본을 생성하세요.');
    return '';
  }

  syncScriptEditors('right');
  const text = $('rightScriptEditor')?.value || $('generatedScript')?.value || existingScript;
  if (text) await navigator.clipboard?.writeText(text).catch(() => {});
  const panel = $('autoModePanel');

  if (state.audioFile) {
    if (!state.captions.length) createCaptionsFromScript();
    await analyzeAudioAndCaptions();
    await generateAllImages();
    if (panel) panel.style.display = 'none';
    log(`올자동 흐름 완료: 기존 대본 유지 → ${version === 'comic' ? '만화' : '실사'} 선택 → ${styleLabelFromSelect()} 랜덤 적용 → 이미지 프롬프트 생성 완료.`);
  } else {
    if (!state.captions.length) createCaptionsFromScript();
    await generateAllImages();
    if (panel) panel.style.display = 'none';
    const btn = $('btnTranscribe');
    btn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    log(`기존 대본 유지. ${version === 'comic' ? '만화' : '실사'} 선택 완료. 인물배경/인물/배경 중 ${styleLabelFromSelect()}가 랜덤 적용됐습니다.`);
  }
}

async function callOpenAiScript(apiKey, prompt) {
  return callOpenAiText(apiKey, prompt, '너는 한국어 유튜브 쇼츠 SEO 대본만 만드는 작가다. 설명 없이 대본만 출력한다.', 900);
}

async function getGeminiModelCandidates(apiKey) {
  const fixed = [SENIAL_GEMINI_MODEL, ...(SENIAL_GEMINI_MODEL_FALLBACKS || [])]
    .filter((v, i, arr) => v && arr.indexOf(v) === i);

  // API 키/프로젝트마다 지원 모델이 다를 수 있어서 실제 사용 가능한 모델 목록을 먼저 확인한다.
  // 실패하면 고정 fallback 목록으로 진행한다.
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fixed;

    const available = (data.models || [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);

    const preferred = available
      .filter((name) => /flash|lite/i.test(name))
      .sort((a, b) => {
        const score = (v) =>
          (v.includes('1.5-flash') ? 0 : 10) +
          (v.includes('2.0-flash-lite') ? 1 : 0) +
          (v.includes('2.0-flash') ? 2 : 0) +
          (v.includes('pro') ? 20 : 0) +
          v.length / 1000;
        return score(a) - score(b);
      });

    return [...fixed.filter((m) => available.includes(m)), ...preferred, ...available]
      .filter((v, i, arr) => v && arr.indexOf(v) === i);
  } catch (_) {
    return fixed;
  }
}

async function callGeminiScript(apiKey, prompt, maxTokens = 900) {
  const models = await getGeminiModelCandidates(apiKey);
  let lastError = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: Math.max(256, Number(maxTokens) || 900)
          }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = new Error(`${data?.error?.message || `Gemini API 오류 ${res.status}`} / 시도 모델: ${model}`);
        continue;
      }
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim() || '';
      if (text) return text;
      lastError = new Error(`Gemini 응답이 비어 있습니다. / 시도 모델: ${model}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Gemini API 호출 실패');
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
  const apiKey = String($('openaiApiKey')?.value || '').trim();
  const provider = resolveScriptApiProvider(apiKey);
  if ($('scriptApiProvider')) $('scriptApiProvider').value = provider;
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
      await callOpenAiText(apiKey, '대답은 가능 한 단어만 출력', '요청한 단어만 출력한다.', 32);
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


function getSelectedScriptLengthSeconds() {
  return Number($('autoScriptLength')?.value || $('scriptLength')?.value || 30);
}

function getMinimumScriptLines() {
  const lengthSec = getSelectedScriptLengthSeconds();
  if (lengthSec <= 30) return 10;
  if (lengthSec <= 40) return 13;
  return 18;
}

function isUsableGeneratedScript(script) {
  const lines = String(script || '').split(/\n+/).map(v => v.trim()).filter(Boolean);
  const text = lines.join(' ');
  const minLines = getMinimumScriptLines();
  if (lines.length < minLines) return false;
  if (text.length < minLines * 18) return false;
  const veryShort = lines.filter(v => plainKey(v).length <= 14).length;
  if (veryShort >= Math.max(3, Math.ceil(lines.length * 0.55))) return false;
  return true;
}

function buildSeoScriptRetryPrompt() {
  const first = buildSeoScriptPrompt();
  return `${first}

[재작성 강제 조건]
- 제목 후보 목록처럼 짧은 문장만 나열하지 말 것
- 선택 제목을 첫 줄에 그대로 쓰지 말 것
- 선택한 길이에 맞춰 최소 ${getMinimumScriptLines()}문장 이상 작성
- 각 문장은 자연스러운 쇼츠 내레이션으로 작성
- 대본이 짧으면 실패로 처리되므로 충분한 분량으로 작성
- 대본 본문만 출력`;
}

async function generateSeoScriptByApi() {
  const keyInput = $('openaiApiKey');
  const apiKey = String(keyInput?.value || '').trim();
  const provider = resolveScriptApiProvider(apiKey);
  if ($('scriptApiProvider')) $('scriptApiProvider').value = provider;
  const topic = String($('scriptTopic')?.value || '').trim();
  if (!apiKey) {
    log('API 키가 없어 대본 생성을 중단했습니다. API 모드에서는 기본 대본을 만들지 않습니다.');
    keyInput?.focus();
    return '';
  }
  if (!topic && $('scriptCategory')?.value === '직접입력') {
    log('직접입력은 세부 주제를 먼저 적어야 합니다.');
    $('scriptTopic')?.focus();
    return '';
  }

  saveApiKeyFromInput();
  makeSeoKeywords(false);
  syncAutoScriptLengthToMain();
  const btn = $('btnGenerateScript');
  if (btn) btn.disabled = true;
  log(`${provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude' : 'GPT'} API로만 SEO 대본 생성 중입니다.`);

  try {
    const prompt = buildSeoScriptPrompt();
    let raw = await callScriptProviderText(provider, apiKey, prompt, 1800);
    let script = sanitizeGeneratedScript(raw);
    if (!isUsableGeneratedScript(script)) {
      log('API 응답이 제목 목록처럼 짧아서 대본으로 다시 생성 중입니다.');
      raw = await callScriptProviderText(provider, apiKey, buildSeoScriptRetryPrompt(), 2200);
      script = sanitizeGeneratedScript(raw);
    }
    if (!script || !isUsableGeneratedScript(script)) throw new Error('API 응답에서 충분한 대본을 찾지 못했습니다.');
    setScriptIntoEditors(script);
    createCaptionsFromScript();
    log('API 대본 생성 완료. 기본모드는 사용하지 않았습니다.');
    return script;
  } catch (err) {
    log(`API 대본 생성 실패: ${err.message || err}. 기본 대본으로 대체하지 않았습니다.`);
    return '';
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
    imageAssets: (state.imageAssets || []).map((a) => ({ ...a, imageObj: null })),
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
    autoMainTopic: $('autoMainTopic')?.value || '',
    autoSubTopic: $('autoSubTopic')?.value || '',
    autoTopicResultHtml: $('autoTopicResultBox')?.innerHTML || '',
  };
}

function restoreStateSnapshot(snap) {
  if (!snap) return;
  finishPreview(true);
  state.captions = JSON.parse(JSON.stringify(snap.captions || []));
  state.scenes = (snap.scenes || []).map((sc) => ({ ...sc, imageObj: null }));
  state.images = JSON.parse(JSON.stringify(snap.images || []));
  state.imageAssets = (snap.imageAssets || []).map((a) => ({ ...a, imageObj: null }));
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
  if ($('autoMainTopic')) $('autoMainTopic').value = snap.autoMainTopic || '';
  if ($('autoSubTopic')) $('autoSubTopic').value = snap.autoSubTopic || '';
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
  state.imageAssets = [];
  state.audioDuration = 60;
  state.audioFile = null;
  state.audioFileName = '';
  state.audioProfile = null;
  state.audioAnalysisReady = false;
  state.selectedCaptionId = null;
  state.thumbnail = { image: null, imageObj: null, prompt: '', text: '', style: 'photo-person-bg' };
  ['generatedScript','rightScriptEditor','ttsText','imagePromptList','seoKeywordBox','scriptTopic','autoSeedTopic','autoMainTopic','autoSubTopic'].forEach((id) => { if ($(id)) $(id).value = ''; });
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


function initBasicSampleLabels() {
  const sec = $('secScript');
  const title = sec?.querySelector('h2');
  if (title) title.textContent = '1. 기본대본';
  const hint = sec?.querySelector('.hint');
  if (hint) hint.textContent = '기본샘플입니다. API 없이 바로 체험할 수 있지만 내용이 반복될 수 있습니다. 진짜 자동생성은 우측 세니얼 시작하기에서 API로 사용하세요.';
  const btn = $('btnMakeKeywords');
  if (btn) btn.textContent = '샘플 바꾸기';
  const focusBtn = $('btnFocusScriptEditor');
  if (focusBtn) focusBtn.textContent = '기본대본 넣기';
  const autoHead = $('autoModePanel')?.querySelector('.autoModeHead span');
  if (autoHead) autoHead.textContent = 'API키로 주제 10개를 만들고, 고른 제목으로 대본과 이미지 프롬프트를 만듭니다.';
  const autoBtn = $('btnAutoMode');
  if (autoBtn) autoBtn.textContent = 'API키로 시작하기';
  const autoStrong = $('autoModePanel')?.querySelector('.autoModeHead strong');
  if (autoStrong) autoStrong.textContent = 'API키로 시작하기';
  const autoHint = $('autoModePanel')?.querySelector('.autoTopicBox .hint');
  if (autoHint) autoHint.textContent = '우측은 API 전용입니다. 좌측 기본샘플과 섞이지 않습니다.';
  const nextHead = $('autoStyleBox')?.querySelector('.autoModeHead strong');
  if (nextHead) nextHead.textContent = '다음 작업';
  const nextHint = $('autoStyleBox')?.querySelector('.autoModeHead span');
  if (nextHint) nextHint.textContent = '고른 제목으로 대본을 만들고, 장면을 나눈 뒤 이미지 프롬프트를 만듭니다.';
  if ($('btnAutoPhoto')) $('btnAutoPhoto').textContent = '대본 만들기';
  if ($('btnAutoComic')) $('btnAutoComic').style.display = 'none';
}

function syncAutoScriptLengthToMain() {
  const len = $('autoScriptLength')?.value || $('scriptLength')?.value || '30';
  if ($('scriptLength')) $('scriptLength').value = len;
  return len;
}

async function generateImagesFromCurrentScriptOnly() {
  syncAutoScriptLengthToMain();
  const panel = $('autoModePanel');
  if (!($('generatedScript')?.value || '').trim() && !($('rightScriptEditor')?.value || '').trim()) {
    log('먼저 대본 만들기를 눌러 대본을 생성하세요.');
    return;
  }
  syncScriptEditors('right');
  if (!state.captions.length) createCaptionsFromScript();
  await generateAllImages();
  if (panel) panel.style.display = 'none';
  log('이미지 프롬프트 생성 완료. 장면 편집에서 실사/Gemini 또는 ChatGPT 생성 버튼을 선택하세요.');
}

function bindEvents() {
  loadSavedApiKey();
  initBasicSampleLabels();
  initApiKeyEyeToggle();
  initScriptTopicChips();
  makeSeoKeywords();
  syncScriptEditors('left');
  $('openaiApiKey')?.addEventListener('change', saveApiKeyFromInput);
  $('scriptApiProvider')?.addEventListener('change', handleScriptApiProviderChange);
  $('autoScriptLength')?.addEventListener('change', syncAutoScriptLengthToMain);
  $('scriptLength')?.addEventListener('change', () => { if ($('autoScriptLength')) $('autoScriptLength').value = $('scriptLength').value; });
  $('scriptTopic')?.addEventListener('input', makeSeoKeywords);
  $('btnMakeKeywords')?.addEventListener('click', refreshScriptTopicsByKeyword);
  $('generatedScript')?.addEventListener('input', () => { syncScriptEditors('left'); markAudioAnalysisReady(false); });
  $('rightScriptEditor')?.addEventListener('input', () => { syncScriptEditors('right'); markAudioAnalysisReady(false); });
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
    // 좌측 기본대본 버튼: API 호출 없이 현재 선택된 샘플만 대본창에 넣는다.
    const topic = cleanSeoTopicText($('scriptTopic')?.value || $('seoKeywordBox')?.value || $('scriptCategory')?.value || '상식');
    if (topic && !$('rightScriptEditor')?.value.trim()) {
      if ($('scriptTopic')) $('scriptTopic').value = topic;
      setScriptIntoEditors(buildBasicSampleScript(topic));
      log('기본대본 샘플을 대본 편집창에 넣었습니다.');
    }
    $('rightScriptEditor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('rightScriptEditor')?.focus();
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
  $('imagePerCaptions')?.addEventListener('change', () => { pushUndoState(); applyImageGrouping(getImageGroupSize()); });
  $('customPerCaptions')?.addEventListener('change', () => { pushUndoState(); applyImageGrouping(getImageGroupSize()); });
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
  $('btnAutoPhoto')?.addEventListener('click', async () => {
    pushUndoState();
    if ($('autoPhotoMenu')) $('autoPhotoMenu').style.display = 'none';
    if ($('autoComicMenu')) $('autoComicMenu').style.display = 'none';
    syncAutoScriptLengthToMain();
    const script = await generateSeoScriptByApi();
    if (script && $('autoPhotoMenu')) {
      $('autoPhotoMenu').style.display = 'grid';
      log('대본 생성 완료. 이제 실사 또는 만화 중 하나만 고르세요. 인물배경/인물/배경은 자동 랜덤 적용됩니다.');
    }
  });
  $('btnAutoComic')?.addEventListener('click', async () => {
    pushUndoState();
    if ($('autoPhotoMenu')) $('autoPhotoMenu').style.display = 'grid';
    if ($('autoComicMenu')) $('autoComicMenu').style.display = 'none';
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
