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

function splitBlockByLength(block, limit = getChunkLimit()) {
  let remain = normalizeSpacing(removeTailRepeat(block));
  const out = [];
  if (!remain) return out;

  while (remain.length > limit) {
    const searchEnd = Math.min(remain.length, limit + 8);
    const searchStart = Math.max(5, Math.floor(limit * 0.45));
    let cut = -1;

    const candidates = ['. ', '? ', '! ', '。', '！', '？', ' 다 ', '요 ', '죠 ', '니다 ', '니까 ', '고 ', '며 ', '서 ', '은 ', '는 ', '을 ', '를 ', '에 ', '가 '];
    for (const token of candidates) {
      const idx = remain.lastIndexOf(token, searchEnd);
      if (idx >= searchStart) {
        cut = idx + token.length;
        break;
      }
    }

    if (cut < searchStart) {
      const space = remain.lastIndexOf(' ', limit);
      cut = space >= searchStart ? space : limit;
    }

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
  return state.captions.find((c) => t >= c.start && t < c.end) || state.captions[state.captions.length - 1] || null;
}

function getSceneAtTime(t = timelineTime()) {
  return state.scenes.find((s) => t >= s.start && t < s.end) || state.scenes[state.scenes.length - 1] || null;
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

function createCaptionsFromScript() {
  const parts = splitScriptToCaptions($('generatedScript')?.value || '');
  if (!parts.length) {
    log('대본이 없어 자막 생성을 건너뛰었습니다.');
    return;
  }

  state.captions = [];
  state.scenes = [];
  state.images = [];
  state.selectedCaptionId = null;

  const audio = $('audio');
  const audioDur = Number(audio?.duration || 0);
  const minDur = clamp(parseFloat($('captionMinSeconds')?.value || '1.8'), 1.2, 4);
  const total = audioDur > 1 ? audioDur : Math.max(20, parts.length * Math.max(2, minDur));
  const style = collectCaptionStyle();

  // 자막 싱크 보정 핵심:
  // 기존 글자수 단순 비율 분배는 TTS의 쉼표/마침표/짧은 감탄 구간을 반영하지 못해
  // 뒤로 갈수록 자막이 밀렸다. 문장별 읽기 시간 + 말끝 쉼을 반영해 누적 오차를 줄인다.
  const readWeights = parts.map((text) => {
    const keyLen = Math.max(1, plainKey(text).length);
    const commaPause = (text.match(/[,，、]/g) || []).length * 0.35;
    const sentencePause = (text.match(/[.!?。！？…]/g) || []).length * 0.55;
    const linePause = (String(text).match(/\n/g) || []).length * 0.25;
    return Math.max(minDur, keyLen * 0.18 + commaPause + sentencePause + linePause + 0.35);
  });

  const weightSum = readWeights.reduce((a, b) => a + b, 0) || 1;
  let normalizedDurations = readWeights.map((w) => (w / weightSum) * total);

  // 너무 짧은 자막은 최소 표시 시간을 보장하고, 초과분은 긴 자막들에서만 줄인다.
  const safeMin = Math.min(minDur, total / Math.max(1, parts.length));
  let shortage = 0;
  normalizedDurations = normalizedDurations.map((dur) => {
    if (dur >= safeMin) return dur;
    shortage += safeMin - dur;
    return safeMin;
  });

  if (shortage > 0) {
    const reducible = normalizedDurations.reduce((sum, dur) => sum + Math.max(0, dur - safeMin), 0);
    if (reducible > 0) {
      normalizedDurations = normalizedDurations.map((dur) => {
        const cut = shortage * (Math.max(0, dur - safeMin) / reducible);
        return Math.max(safeMin, dur - cut);
      });
    }
  }

  let t = 0;
  state.captions = parts.map((text, idx) => {
    const isLast = idx === parts.length - 1;
    const start = Number(t.toFixed(2));
    const next = isLast ? total : Math.min(total, t + normalizedDurations[idx]);
    const end = Number(Math.max(start + 0.08, next).toFixed(2));
    t = end;
    return { id: uid(), start, end, text, captionStyle: { ...style } };
  });

  // 소수점 반올림으로 마지막 시간이 어긋나면 영상/음성 끝에 정확히 맞춘다.
  if (state.captions.length) {
    state.captions[state.captions.length - 1].end = Number(total.toFixed(2));
  }

  state.audioDuration = total;
  rebuildScenes();
  if ($('generatedScript')) $('generatedScript').value = parts.join('\n\n');
  if ($('ttsText')) $('ttsText').value = parts.join('\n');
  renderEditor();
  updateSeekUI(0);
  drawFrame(0);
  if (state.captions[0]) setActiveCaption(state.captions[0].id);
  syncScriptEditors('left');
  log(`음성 길이 기준 자막 싱크 보정 완료: ${parts.length}개`);
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
    empty.innerHTML = '아직 장면이 없습니다.<br>왼쪽에서 대본을 넣고 <b>대본만 자막 만들기</b>를 누르세요.';
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
  if (audio && audio.src && !audio.paused) {
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
  state.playStartMs = performance.now();
  state.playStartTime = current;

  const audio = $('audio');
  if (audio && audio.src) {
    audio.currentTime = current;
    audio.onended = () => finishPreview(false);
    audio.play().catch(() => {
      // 오디오 재생이 막혀도 캔버스 미리보기는 계속 진행한다.
    });
  }
  updateSeekUI(current);
  drawFrame(current);
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

function makeImagePrompt(text, idx) {
  const style = $('imageStyle')?.value || 'photo-person-bg';
  const base = String(text || '').replace(/\n/g, ' ').trim();

  // 배경 모드는 사람/인물/얼굴/몸이 절대 나오지 않도록 프롬프트를 분리한다.
  if (style === 'comic-bg') {
    return `${base}, Studio Ghibli inspired background scenery, environment only, landscape only, empty scene, no people, no person, no character, no human, no face, no body, cinematic background, vertical 9:16, no text, no subtitles`;
  }
  if (style === 'photo-bg') {
    return `${base}, realistic cinematic background, environment only, landscape only, empty scene, no people, no person, no character, no human, no face, no body, vertical 9:16, no text, no subtitles`;
  }
  if (style === 'comic-person') return `${base}, emotional Studio Ghibli inspired anime character scene, single person, cinematic, vertical 9:16, no text, no subtitles`;
  if (style === 'comic-person-bg') return `${base}, emotional Studio Ghibli inspired anime scene with person and background, cinematic, vertical 9:16, no text, no subtitles`;
  if (style === 'photo-person') return `${base}, realistic cinematic portrait scene, single person, vertical 9:16, no text, no subtitles`;
  return `${base}, realistic cinematic scene with person and background, vertical 9:16, no text, no subtitles`;
}



function thumbnailSourceText() {
  const firstCaption = state.captions?.[0]?.text || '';
  const scriptLines = String($('generatedScript')?.value || '')
    .split(/\n+/)
    .map((v) => removeTailRepeat(v).trim())
    .filter(Boolean);
  return firstCaption || scriptLines[0] || '오늘도 잘 버텨낸 하루';
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
  log(`썸네일 1개 + 장면별 이미지 프롬프트 ${prompts.length}개 생성 완료. 썸네일 문구는 프롬프트 안에 직접 포함됩니다.`);
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
    recorder.start(1000);
    if (audio && audio.src) audio.play().catch(() => {});
    const total = Math.max(1, state.audioDuration || 30);
    const started = performance.now();
    function step() {
      const t = Math.min(total, (performance.now() - started) / 1000);
      const percent = Math.min(99, Math.floor((t / total) * 100));
      updateRenderProgress(percent, `생성 중 ${percent}%  ·  ${formatTime(t)} / ${formatTime(total)}`);
      drawFrame(t);
      if (t < total) requestAnimationFrame(step);
      else {
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
    }
    step();
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
  const badge = $('audioQuickBadge');
  if (!file) {
    if (info) info.textContent = '음성 파일을 선택하면 길이와 예상 자막 수가 표시됩니다.';
    if (badge) badge.textContent = '대기중';
    return;
  }
  if (info) info.innerHTML = `음성 첨부됨<br>파일명: <b>${file.name}</b><br>길이: <b>${formatTime(duration)}</b>`;
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
    box.querySelectorAll('.topicChip').forEach(b => b.classList.toggle('active', b === btn));
    if ($('scriptCategory')) $('scriptCategory').value = topic;
    if ($('scriptTopic')) $('scriptTopic').value = '';
    makeSeoKeywords(true);
  });
  $('scriptCategory')?.addEventListener('change', () => {
    const val = $('scriptCategory').value;
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

function buildLocalSeoScript() {
  makeSeoKeywords();
  const category = $('scriptCategory')?.value || '상식';
  const picked = String($('scriptTopic')?.value || '').trim();
  const topic = picked || getTopicSuggestions(category)[0] || category;
  const request = String($('scriptRequest')?.value || '').trim();
  const keywords = String($('seoKeywordBox')?.value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .slice(0, 3);
  const mainKeyword = keywords[0] || topic;
  const subKeyword = keywords[1] || category;
  const tone = request ? `${request} 느낌으로` : '짧고 강하게';

  return [
    `혹시 ${topic} 때문에 고민하고 있나요`,
    `지금 필요한 건 복잡한 설명보다 바로 써먹는 기준입니다`,
    `${mainKeyword}에서 가장 먼저 볼 건 문제를 크게 만들기 전에 작은 신호를 잡는 겁니다`,
    `${subKeyword}는 시작 순서만 잡아도 시간과 비용이 확 줄어듭니다`,
    `오늘은 딱 세 가지만 기억하세요`,
    `첫째 지금 불편한 부분을 적고`,
    `둘째 바로 바꿀 수 있는 것부터 정리하고`,
    `셋째 결과가 보이는 순서로 실행하면 됩니다`,
    `${tone} 정리하면 시작은 작게 해도 방향은 분명해야 합니다`,
    `이 영상 저장해두고 필요할 때 다시 확인하세요`
  ].join('\n');
}

function sanitizeGeneratedScript(text) {
  return stripLabels(String(text || ''))
    .replace(/["“”‘’`!！]/g, '')
    .replace(/[\[#*_>|]/g, '')
    .replace(/^\s*(제목|해시태그|태그|설명|썸네일|SEO)\s*[:：].*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getTopicSuggestions(category) {
  const base = SENIAL_TOPIC_SUGGESTIONS[category] || SENIAL_TOPIC_SUGGESTIONS['상식'];
  return base.slice(0, 10);
}

function renderTopicSuggestions(selectedTopic = '') {
  const box = $('topicSuggestionBox');
  if (!box) return;
  const category = $('scriptCategory')?.value || '상식';
  const topics = getTopicSuggestions(category);
  box.innerHTML = topics.map((topic) => {
    const active = topic === selectedTopic ? ' active' : '';
    return `<button type="button" class="topicPickBtn${active}" data-topic="${topic}"><span>${topic}</span><b>고르기</b></button>`;
  }).join('');
}

function selectScriptTopic(topic) {
  const clean = String(topic || '').replace(/["“”‘’`!！]/g, '').trim();
  if ($('scriptTopic')) $('scriptTopic').value = clean;
  renderTopicSuggestions(clean);
  makeSeoKeywords(false);
  log(`주제 선택: ${clean}. 대본편집 생성을 누르면 바로 생성됩니다.`);
}

function makeSeoKeywords(showTopics = true) {
  const category = $('scriptCategory')?.value || '상식';
  const currentTopic = String($('scriptTopic')?.value || '').trim();
  if (showTopics) renderTopicSuggestions(currentTopic);
  const topic = currentTopic || getTopicSuggestions(category)[0] || category;
  if (!currentTopic && $('scriptTopic')) $('scriptTopic').value = topic;
  const today = getTodayKoreanDate();
  const base = topic.replace(/["“”‘’`!！]/g, '').trim();
  const keywords = [
    `${today} ${base}`,
    `${base} 쇼츠`,
    `${base} 추천`,
    `${base} 요즘`,
    `${category} 핵심정리`,
    `${base} 1분요약`
  ];
  if ($('seoKeywordBox')) $('seoKeywordBox').value = Array.from(new Set(keywords)).join(', ');
  return $('seoKeywordBox')?.value || keywords.join(', ');
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
    return;
  }
  if (!topic && $('scriptCategory')?.value === '직접입력') {
    log('직접입력은 세부 주제를 먼저 적어야 합니다.');
    $('scriptTopic')?.focus();
    return;
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
  } catch (err) {
    const fallback = setScriptIntoEditors(buildLocalSeoScript());
    createCaptionsFromScript();
    log(`API 대본 생성 실패: ${err.message || err}`);
    log('브라우저 보안/CORS 또는 키 문제일 수 있어 기본 대본을 대본 편집 칸에 대신 생성했습니다.');
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

function bindEvents() {
  loadSavedApiKey();
  initApiKeyEyeToggle();
  initScriptTopicChips();
  makeSeoKeywords();
  syncScriptEditors('left');
  $('openaiApiKey')?.addEventListener('change', saveApiKeyFromInput);
  $('scriptApiProvider')?.addEventListener('change', handleScriptApiProviderChange);
  $('scriptTopic')?.addEventListener('input', makeSeoKeywords);
  $('btnMakeKeywords')?.addEventListener('click', makeSeoKeywords);
  $('generatedScript')?.addEventListener('input', () => syncScriptEditors('left'));
  $('rightScriptEditor')?.addEventListener('input', () => syncScriptEditors('right'));
  $('btnCopyRightScript')?.addEventListener('click', copyRightScript);
  $('btnApplyRightScript')?.addEventListener('click', () => { syncScriptEditors('right'); createCaptionsFromScript(); });
  $('btnGenerateScript')?.addEventListener('click', generateSeoScriptByApi);
  $('btnOpenScriptApiSite')?.addEventListener('click', openScriptApiSite);
  $('btnCheckScriptApi')?.addEventListener('click', verifyScriptApiKey);
  $('btnCheckScriptApiRight')?.addEventListener('click', verifyScriptApiKey);
  $('btnFocusScriptEditor')?.addEventListener('click', () => {
    $('rightScriptEditor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('rightScriptEditor')?.focus();
    generateSeoScriptByApi();
  });
  $('btnAnalyzeStyle')?.addEventListener('click', copySeoScriptPrompt);
  $('btnApplyScriptToCaptions')?.addEventListener('click', () => { syncScriptEditors('left'); createCaptionsFromScript(); });
  $('btnCopyScript')?.addEventListener('click', () => { syncScriptEditors('left'); navigator.clipboard?.writeText($('generatedScript')?.value || ''); });
  $('btnPreview')?.addEventListener('click', playPreview);
  $('btnStopPreview')?.addEventListener('click', () => stopPreview(true));
  $('btnRender')?.addEventListener('click', renderWebm);
  $('btnAiAll')?.addEventListener('click', generateAllImages);
  $('btnSaveProject')?.addEventListener('click', saveProject);
  $('btnLoadProject')?.addEventListener('click', () => $('projectFile')?.click());
  $('projectFile')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) loadProjectFile(f); });
  $('btnClear')?.addEventListener('click', () => {
    if (!confirm('전체 장면과 자막을 삭제할까요?')) return;
    state.captions = [];
    state.scenes = [];
    state.selectedCaptionId = null;
    renderEditor();
    updateSeekUI(0);
    drawFrame(0);
  });
  $('btnAddCaption')?.addEventListener('click', () => {
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
  $('btnBuildScenes')?.addEventListener('click', () => { rebuildScenes(); renderEditor(); drawFrame(timelineTime()); });
  $('btnTranscribe')?.addEventListener('click', () => {
    const audio = $('audio');
    if (audio && audio.duration) {
      state.audioDuration = audio.duration;
      updateSeekUI(0);
      drawFrame(0);
      log('음성 길이를 영상 길이에 적용했습니다.');
    } else {
      log('먼저 음성 파일을 첨부하세요.');
    }
  });

  $('audioFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    state.audioFile = file;
    state.audioFileName = file.name;
    const audio = $('audio');
    audio.src = URL.createObjectURL(file);
    audio.onloadedmetadata = () => {
      state.audioDuration = audio.duration || state.audioDuration;
      updateAudioStatus(file, state.audioDuration);
      updateSeekUI(0);
      drawFrame(0);
    };
  });

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
    btn.addEventListener('click', () => runAutoMode(btn.dataset.autoVersion, btn.dataset.autoKind));
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
  log('세니얼 최종본 적용 완료. 재생 버튼 재시작 오류 수정, WEBM 전용 다운로드가 적용되었습니다.');
}

window.addEventListener('DOMContentLoaded', init);
