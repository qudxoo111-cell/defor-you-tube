const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const PREVIEW_W = 270;
const PREVIEW_H = 480;
let FINAL_W = 1080;
let FINAL_H = 1920;
canvas.width = PREVIEW_W;
canvas.height = PREVIEW_H;
const state = {
  captions: [],
  scenes: [],
  images: [],
  audioDuration: 60,
  logo: null,
  thumbnail: null,
  previewTimer: null,
  previewStart: 0,
  mediaRecorder: null,
  chunks: [],
  audioContext: null,
  audioSource: null,
  syncOffset: 0,
  seeking: false,
  rendering: false,
  referenceVideoUrl: null,
  referenceVideoFile: null,
  referenceVideoDuration: 0,
  lastVideoUrl: null,
  lastVideoBlob: null,
  lastVideoFileName: '',
  analyzedStyle: {seconds:30, scenes:10, type:"감성공감형"}
};
const motions = ['zoom','panup','pandown'];

function log(msg){ $('log').textContent = msg; }
function uid(){ return Math.random().toString(36).slice(2,9); }
function speed(){ return Math.max(0.5, Math.min(3, parseFloat($('speedInput').value || '1'))); }
function applyVideoRatio(){
  const ratio = $('videoRatio') ? $('videoRatio').value : 'vertical';
  if(ratio === 'horizontal'){ FINAL_W = 1920; FINAL_H = 1080; }
  else { FINAL_W = 1080; FINAL_H = 1920; }
}
function imageGroupSize(){ return $('imagePerCaptions').value === 'custom' ? Math.max(1, parseInt($('customPerCaptions').value || '2')) : parseInt($('imagePerCaptions').value); }

function formatTime(sec){ sec=Math.max(0, sec||0); const m=Math.floor(sec/60); const s=(sec%60).toFixed(1).padStart(4,'0'); return `${m}:${s}`; }
function parseTime(v){ if(!v) return 0; if(String(v).includes(':')){ const [m,s]=String(v).split(':').map(Number); return (m||0)*60+(s||0); } return parseFloat(v)||0; }

function normalizeSpacing(text){
  return String(text||'')
    .replace(/\s+/g,' ')
    .replace(/\s+([,.!?…])/g,'$1')
    .replace(/([가-힣])([A-Za-z0-9])/g,'$1 $2')
    .replace(/([A-Za-z0-9])([가-힣])/g,'$1 $2')
    .trim();
}

function cleanScriptSymbols(text){
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/[`"'“”‘’]/g, '')
    .replace(/[!！?,，.。;；:：]/g, '')
    .replace(/[()\[\]{}<>《》【】]/g, ' ')
    .replace(/[|\\/]/g, ' ')
    .replace(/[~〜]/g, ' ')
    .replace(/[#*_+=^$@%]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripScriptSectionLabels(text){
  const banned = '(후킹|문제\\s*제기|문제제기|공감|전개|해결|마무리)';
  return String(text || '')
    .split(/\n+/)
    .map(line => line
      .replace(new RegExp('^\\s*\\d*\\s*[-–—.)]?\\s*' + banned + '\\s*$', 'gi'), '')
      .replace(new RegExp('^\\s*' + banned + '\\s*[:：-]?\\s*', 'gi'), '')
      .replace(/\[?\d{1,2}:\d{2}\s*~\s*\d{1,2}:\d{2}\s*\|?[^\]]*\]?/g, '')
      .trim())
    .filter(Boolean)
    .join('\n')
    .replace(new RegExp(banned, 'gi'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanCaptionText(text){
  return stripScriptSectionLabels(cleanScriptSymbols(text))
    .replace(/\b\d{1,2}\s*\d{2}\s*\d{1,2}\s*\d{2}\b/g, ' ')
    .replace(/\b\d+\s*초\b/g, ' ')
    .replace(/\b후킹\b|\b문제 제기\b|\b문제제기\b|\b공감\b|\b전개\b|\b해결\b|\b마무리\b/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function resetProjectContent(){
  state.captions = [];
  state.scenes = [];
  state.images = [];
  state.chunks = [];
  renderEditor();
  drawFrame(0);
  updateSeekUI();
}


function splitLongText(text){
  const clean = normalizeSpacing(text);
  if(clean.length <= 12) return clean;
  const targets = [' 하지만 ',' 그리고 ',' 그래서 ',' 이제 ',' 오늘 ',' 당신은 ',' 우리는 ',' 언젠가 ',' 지금 ', ' 그런데 ', ' 그래도 '];
  for(const t of targets){
    const i = clean.indexOf(t, Math.floor(clean.length*0.30));
    if(i>0 && i<clean.length-3) return clean.slice(0,i).trim()+'\n'+clean.slice(i).trim();
  }
  const mid = Math.floor(clean.length/2);
  let cut = clean.lastIndexOf(' ', mid);
  if(cut < 5) cut = clean.indexOf(' ', mid);
  if(cut < 5) cut = mid;
  return clean.slice(0,cut).trim()+'\n'+clean.slice(cut).trim();
}

function sampleCaptions(){
  state.captions = [
    {id:uid(),start:0,end:4,text:'오늘 하루도 정말\n수고 많으셨습니다'},
    {id:uid(),start:4,end:8,text:'포기하고 싶었던 순간도\n분명 있었을 겁니다'},
    {id:uid(),start:8,end:12,text:'그래도 당신은\n여기까지 잘 버텨왔습니다'},
    {id:uid(),start:12,end:17,text:'지금 당장은 느려 보여도\n조금씩 앞으로 가고 있습니다'},
    {id:uid(),start:17,end:22,text:'언젠가 오늘을 버틴 자신이\n자랑스러워질 날이 옵니다'},
    {id:uid(),start:22,end:27,text:'그러니 오늘도\n무너지지 말고 한 걸음만 가세요'}
  ];
  state.audioDuration = 27;
  buildScenes(); renderEditor(); drawFrame(0); log('샘플 자막을 넣었습니다.');
}

function buildScenes(forceOnePerCaption=false, inheritScenes=null){
  const n = forceOnePerCaption ? 1 : imageGroupSize();
  const old = state.scenes || [];
  const inherited = inheritScenes || old;
  const sceneByCaption = new Map();
  inherited.forEach(sc => (sc.captionIds||[]).forEach(cid => sceneByCaption.set(cid, sc)));
  const scenes = [];
  for(let i=0;i<state.captions.length;i+=n){
    const caps = state.captions.slice(i,i+n);
    const first = caps[0] || {};
    const sourceScene = sceneByCaption.get(first.sourceCaptionId || first.id) || old[Math.floor(i/n)] || {};
    const captionText = caps.map(c=>String(c.text||'').replace(/\n/g,' ')).join(' ');
    scenes.push({
      id: forceOnePerCaption ? uid() : (sourceScene.id || uid()),
      title: `장면 ${scenes.length+1}`,
      captionIds: caps.map(c=>c.id),
      image: sourceScene.image || state.images[scenes.length] || null,
      imageObj: sourceScene.imageObj || null,
      motion: sourceScene.motion || motions[scenes.length % motions.length],
      fullText: captionText,
      prompt: sourceScene.prompt || sourceScene.fullText || captionText
    });
  }
  state.scenes = scenes;
  cacheSceneImages();
}

function renderEditor(){
  const box = $('sceneEditor'); box.innerHTML='';
  if(!state.scenes.length){
    box.innerHTML = '<div class="emptyState">아직 장면이 없습니다.<br>왼쪽에서 대본 생성 후 <b>자막칸에 적용</b>을 누르세요.</div>';
    return;
  }
  state.scenes.forEach((scene,idx)=>{
    const card = document.createElement('div'); card.className='sceneCard'; card.draggable=true;
    card.addEventListener('dragstart', e=>{ e.dataTransfer.setData('text/plain', idx); });
    card.addEventListener('dragover', e=>e.preventDefault());
    card.addEventListener('drop', e=>{ e.preventDefault(); const from=+e.dataTransfer.getData('text/plain'); const [s]=state.scenes.splice(from,1); state.scenes.splice(idx,0,s); renderEditor(); drawFrame(timelineTime()); });
    const thumb = document.createElement('div'); thumb.className='sceneThumb';
    if(scene.image){ const img=document.createElement('img'); img.src=scene.image; thumb.appendChild(img); } else thumb.textContent='이미지 없음\n업로드/AI 생성';
    const info = document.createElement('div'); info.className='sceneInfo';
    info.innerHTML = `<div class="sceneTop"><strong>${scene.title}</strong><span class="badge">${scene.motion}</span></div>`;
    const mini = document.createElement('div'); mini.className='miniGrid';
    const upload = document.createElement('input'); upload.type='file'; upload.accept='image/*'; upload.title='이미지 넣기';
    upload.addEventListener('change', async e=>{ const f=e.target.files[0]; if(f){ setSceneImage(scene, await fileToDataURL(f)); renderEditor(); drawFrame(timelineTime()); }});
    const aiBtn = document.createElement('button'); aiBtn.textContent='AI 생성'; aiBtn.onclick=()=>generateSceneImage(scene, idx);
    const motionSel = document.createElement('select');
    ['zoom','panup','pandown','zoomout','left','right','rotate','none'].forEach(m=>{ const o=document.createElement('option'); o.value=m; o.textContent={zoom:'확대',panup:'위로',pandown:'아래로',zoomout:'축소',left:'좌측',right:'우측',rotate:'회전',none:'고정'}[m]; if(scene.motion===m)o.selected=true; motionSel.appendChild(o); });
    motionSel.onchange=()=>{ scene.motion=motionSel.value; renderEditor(); drawFrame(timelineTime()); };
    mini.append(upload, aiBtn, motionSel);
    const fullLabel = document.createElement('div'); fullLabel.className='sceneLabel'; fullLabel.textContent='장면 전체 문단 자막 - 이 내용이 실제 자막 기준입니다';
    const fullText = document.createElement('textarea'); fullText.className='sceneFullText'; fullText.placeholder='이 장면 전체 문단. 첫 대사부터 빠짐없이 넣으세요.'; fullText.value=scene.fullText || scene.captionIds.map(id=>state.captions.find(c=>c.id===id)?.text||'').join(' ').replace(/\n/g,' ');
    fullText.oninput=()=>{ scene.fullText=fullText.value; scene.prompt=scene.prompt || fullText.value; };
    const applyBtn = document.createElement('button'); applyBtn.className='sceneApply'; applyBtn.textContent='이 문단을 아래 자막칸에 적용'; applyBtn.onclick=()=>applySceneFullText(scene);
    const sceneTools = document.createElement('div'); sceneTools.className='sceneSplitTools';
    const splitBtn = document.createElement('button'); splitBtn.textContent='이 장면 더 잘게 나누기'; splitBtn.onclick=()=>splitSceneMore(scene);
    const addCapBtn = document.createElement('button'); addCapBtn.textContent='이 장면 자막칸 추가'; addCapBtn.onclick=()=>addCaptionToScene(scene);
    const topTextLabel = document.createElement('label'); topTextLabel.className='checkLine smallCheck';
    const topTextCheck = document.createElement('input'); topTextCheck.type='checkbox'; topTextCheck.checked = scene.topFixedText !== false;
    topTextCheck.onchange=()=>{ scene.topFixedText = topTextCheck.checked; drawFrame(timelineTime()); };
    topTextLabel.append(topTextCheck, document.createTextNode('상단 고정글자 표시'));
    sceneTools.append(splitBtn, addCapBtn, topTextLabel);
    const prompt = document.createElement('textarea'); prompt.placeholder='이 장면 이미지 프롬프트 - 비우면 위 문단으로 이미지 생성'; prompt.value=scene.prompt||''; prompt.oninput=()=>scene.prompt=prompt.value;
    const rows = document.createElement('div'); rows.className='captionRows';
    scene.captionIds.forEach(cid=>{
      const cap = state.captions.find(c=>c.id===cid); if(!cap) return;
      const row = document.createElement('div'); row.className='captionRow';
      const st = document.createElement('input'); st.value=cap.start.toFixed(1); st.onchange=()=>{cap.start=parseTime(st.value); drawFrame(timelineTime());};
      const en = document.createElement('input'); en.value=cap.end.toFixed(1); en.onchange=()=>{cap.end=parseTime(en.value); drawFrame(timelineTime());};
      const tx = document.createElement('textarea'); tx.value=cap.text; tx.placeholder='Enter로 원하는 줄수 수정'; tx.oninput=()=>{cap.text=tx.value; drawFrame(timelineTime());};
      const del = document.createElement('button'); del.textContent='×'; del.className='danger'; del.onclick=()=>{ state.captions=state.captions.filter(x=>x.id!==cap.id); buildScenes(); renderEditor(); drawFrame(timelineTime()); };
      row.append(st,en,tx,del); rows.appendChild(row);
    });
    info.append(mini,fullLabel,fullText,applyBtn,sceneTools,prompt,rows); card.append(thumb,info); box.appendChild(card);
  });
}

function splitSceneSentences(text){
  const clean = normalizeSpacing(String(text||'').replace(/\n+/g,' '));
  if(!clean) return [];
  let parts = clean.split(/(?<=[.!?。]|[다요죠니다까])\s+/).map(x=>x.trim()).filter(Boolean);
  if(parts.length <= 1 && clean.length > 34){
    const mid = Math.ceil(clean.length/2);
    let cut = clean.indexOf(' ', mid);
    if(cut < 0) cut = clean.lastIndexOf(' ', mid);
    if(cut > 8) parts = [clean.slice(0,cut).trim(), clean.slice(cut).trim()];
  }
  return parts.length ? parts : [clean];
}
function applySceneFullText(scene){
  const parts = splitSceneSentences(scene.fullText || scene.prompt || '');
  if(!parts.length) return;
  const oldCaps = scene.captionIds.map(id=>state.captions.find(c=>c.id===id)).filter(Boolean);
  const start = oldCaps[0]?.start ?? 0;
  const end = oldCaps[oldCaps.length-1]?.end ?? Math.min(start + parts.length*3.5, state.audioDuration||60);
  const span = Math.max(1, end - start);
  const newCaps = parts.map((txt,i)=>({id:uid(), start:start + span*i/parts.length, end:start + span*(i+1)/parts.length, text:splitLongText(txt)}));
  const remove = new Set(scene.captionIds);
  const firstIndex = Math.max(0, state.captions.findIndex(c=>remove.has(c.id)));
  state.captions = state.captions.filter(c=>!remove.has(c.id));
  state.captions.splice(firstIndex,0,...newCaps);
  buildScenes();
  renderEditor();
  drawFrame(timelineTime());
  log('장면 문단을 실제 자막칸에 적용했습니다. 첫 대사가 빠지면 위 문단을 고친 뒤 다시 적용하세요.');
}

function getSplitMaxSeconds(){
  const el = $('splitMaxSeconds');
  return Math.max(1.2, Math.min(8, parseFloat(el?.value || '3.2')));
}
function chunkTextForShortCaption(text){
  const clean = normalizeSpacing(String(text||'').replace(/\n+/g,' '));
  if(!clean) return [''];
  let parts = clean.split(/(?<=[.!?。]|[다요죠니다까요])\s+/).map(x=>x.trim()).filter(Boolean);
  if(parts.length > 1) return parts;
  // 한 컷 자막 글자 수를 22자 기준으로 유지해 문맥이 너무 잘게 끊기지 않게 함
  const target = 22;
  const out = [];
  let remain = clean;
  while(remain.length > target){
    let cut = remain.lastIndexOf(' ', target);
    if(cut < 8) cut = remain.indexOf(' ', target);
    if(cut < 8) cut = target;
    out.push(remain.slice(0,cut).trim());
    remain = remain.slice(cut).trim();
  }
  if(remain) out.push(remain);
  return out.length ? out : [clean];
}
function splitCaptionByRule(cap, maxSec){
  const duration = Math.max(0.5, cap.end - cap.start);
  const textParts = chunkTextForShortCaption(cap.text);
  const timeNeed = Math.ceil(duration / maxSec);
  const count = Math.max(textParts.length, timeNeed);
  if(count <= 1) return [cap];

  const chunks = [];
  for(let i=0;i<count;i++){
    let txt = textParts[i] || '';
    if(!txt && textParts.length){
      const src = textParts[Math.min(textParts.length-1, Math.floor(i * textParts.length / count))];
      txt = src;
    }
    chunks.push({
      id: uid(),
      start: cap.start + duration * i / count,
      end: cap.start + duration * (i+1) / count,
      text: splitLongText(txt),
      sourceCaptionId: cap.sourceCaptionId || cap.id
    });
  }
  return chunks;
}
function splitAllCaptionsShort(){
  const maxSec = getSplitMaxSeconds();
  const beforeScenes = [...(state.scenes || [])];
  const next = [];
  state.captions.forEach(cap => next.push(...splitCaptionByRule(cap, maxSec)));
  state.captions = next;
  const forceOne = !!($('autoSceneOnePerCaption') && $('autoSceneOnePerCaption').checked);
  if(forceOne && $('imagePerCaptions')) $('imagePerCaptions').value = '1';
  syncFix(false);
  buildScenes(forceOne, beforeScenes);
  renderEditor();
  drawFrame(timelineTime());
  log(`자막을 짧게 나눴습니다. 이미지 1장이 여러 자막칸에 걸려도 움직임은 장면 전체 시간으로 이어집니다.`);
}
function splitSceneMore(scene){
  const maxSec = getSplitMaxSeconds();
  const beforeScenes = [...(state.scenes || [])];
  const remove = new Set(scene.captionIds);
  const oldCaps = scene.captionIds.map(id=>state.captions.find(c=>c.id===id)).filter(Boolean);
  const firstIndex = Math.max(0, state.captions.findIndex(c=>remove.has(c.id)));
  const newCaps = [];
  oldCaps.forEach(cap => newCaps.push(...splitCaptionByRule(cap, maxSec)));
  state.captions = state.captions.filter(c=>!remove.has(c.id));
  state.captions.splice(firstIndex,0,...newCaps);
  const forceOne = !!($('autoSceneOnePerCaption') && $('autoSceneOnePerCaption').checked);
  if(forceOne && $('imagePerCaptions')) $('imagePerCaptions').value = '1';
  syncFix(false);
  buildScenes(forceOne, beforeScenes);
  renderEditor();
  drawFrame(timelineTime());
  log(`${scene.title}의 자막을 더 짧게 나눴습니다. 움직임은 장면 전체 시간으로 이어집니다.`);
}
function addCaptionToScene(scene){
  const caps = scene.captionIds.map(id=>state.captions.find(c=>c.id===id)).filter(Boolean);
  const last = caps[caps.length-1] || state.captions[state.captions.length-1];
  const st = last ? last.end : 0;
  const en = Math.min((state.audioDuration||st+3), st + 3);
  const newCap = {id:uid(), start:st, end:en>st?en:st+3, text:'새 자막\n직접 수정'};
  const insertAt = last ? state.captions.findIndex(c=>c.id===last.id)+1 : state.captions.length;
  state.captions.splice(insertAt,0,newCap);
  buildScenes();
  renderEditor();
  drawFrame(timelineTime());
  log('자막칸을 추가했습니다. 시작/끝 시간은 직접 조정하세요.');
}

function fileToDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }

function setSceneImage(scene, dataUrl){
  scene.image = dataUrl;
  scene.imageObj = new Image();
  scene.imageObj.decoding = 'async';
  scene.imageObj.onload = () => drawFrame(timelineTime());
  scene.imageObj.src = dataUrl;
}
function cacheSceneImages(){
  state.scenes.forEach(scene=>{
    if(scene.image && !scene.imageObj){
      scene.imageObj = new Image();
      scene.imageObj.decoding = 'async';
      scene.imageObj.src = scene.image;
    }
  });
}
function useCaptionForImage(){
  const el = $('useCaptionForImage');
  return !!(el && el.checked);
}


async function loadBulkImages(e){
  const files=[...e.target.files];
  state.images=[];
  for(const f of files) state.images.push(await fileToDataURL(f));
  state.scenes.forEach((s,i)=>{ if(state.images[i]) setSceneImage(s, state.images[i]); });
  renderEditor(); drawFrame(timelineTime()); log(`${files.length}장 이미지를 불러왔습니다.`);
}

async function transcribeAudio(){
  const key=$('apiKey').value.trim(); const file=$('audioFile').files[0];
  if(!file){ alert('음성 파일을 먼저 넣으세요.'); return; }
  $('audio').src = URL.createObjectURL(file);
  await new Promise(r=>{ $('audio').onloadedmetadata=()=>{ state.audioDuration=$('audio').duration||60; r(); }; });
  if(!key){
    autoBlankCaptions(state.audioDuration); log('API 키가 없어 임시 자막칸을 만들었습니다. 직접 자막을 넣으세요.'); return;
  }
  log('Whisper 자막 생성 중...');
  try{
    const fd = new FormData(); fd.append('file', file); fd.append('model','whisper-1'); fd.append('response_format','verbose_json'); fd.append('timestamp_granularities[]','segment');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:fd});
    if(!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const segments = data.segments || [];
    state.captions = segments.map(seg=>({id:uid(),start:seg.start||0,end:seg.end||0,text:splitLongText(seg.text||'')}));
    if(!state.captions.length && data.text) autoCaptionsFromText(data.text, state.audioDuration);
    syncTtsTextFromScript(state.captions.map(c=>String(c.text||'').replace(/\n/g,' ')).join('\n'));
    syncFix(); buildScenes(); renderEditor(); drawFrame(0); log('AI 자막 생성 완료. 싱크 보정까지 적용했습니다.');
  }catch(err){ autoBlankCaptions(state.audioDuration); log('AI 자막 실패: '+err.message+'\n임시 자막칸을 만들었습니다.'); }
}
function autoBlankCaptions(duration){
  const count=Math.max(3, Math.ceil(duration/5)); state.captions=[];
  for(let i=0;i<count;i++){ const st=i*duration/count,en=(i+1)*duration/count; state.captions.push({id:uid(),start:st,end:en,text:`자막 ${i+1}\n직접 수정하세요`}); }
  buildScenes(); renderEditor(); drawFrame(0);
}
function autoCaptionsFromText(text,duration){
  const parts=String(text).split(/(?<=[.!?。]|[다요죠니다])\s+/).filter(Boolean); const count=parts.length||1;
  state.captions=parts.map((p,i)=>({id:uid(),start:i*duration/count,end:(i+1)*duration/count,text:splitLongText(p)}));
}
function syncFix(updateView=true){
  state.captions.sort((a,b)=>a.start-b.start);
  const dur = state.audioDuration || Math.max(...state.captions.map(c=>c.end), 60);
  state.captions.forEach((c,i)=>{
    c.text = c.text.split('\n').map(normalizeSpacing).join('\n');
    if(i>0 && c.start < state.captions[i-1].end) c.start = state.captions[i-1].end;
    if(c.end <= c.start) c.end = c.start + 2.5;
    if(i < state.captions.length-1 && c.end > state.captions[i+1].start) c.end = state.captions[i+1].start;
  });
  if(state.captions.length) {
    state.captions[state.captions.length-1].end = dur;
    // 장면이 끊겨 첫 장면으로 되돌아가는 현상 방지
    for(let i=0;i<state.captions.length-1;i++){
      if(state.captions[i].end < state.captions[i+1].start){
        state.captions[i].end = state.captions[i+1].start;
      }
    }
  }
  if(updateView){
    buildScenes(); renderEditor(); drawFrame(timelineTime()); log('싱크를 보정했습니다. 마지막 구간까지 장면이 유지됩니다.');
  }
}


async function generateSceneImage(scene, idx){
  const key=$('apiKey').value.trim();
  const prompt = imagePrompt(scene);
  if(!key){ setSceneImage(scene, placeholderImage(prompt, idx)); renderEditor(); drawFrame(timelineTime()); log('API 키가 없어 임시 이미지가 들어갔습니다.'); return; }
  log(`${scene.title} AI 이미지 생성 중...`);
  try{
    const res = await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:'gpt-image-1',prompt,size:($('videoRatio')&&$('videoRatio').value==='horizontal')?'1536x1024':'1024x1536'})});
    if(!res.ok) throw new Error(await res.text());
    const data=await res.json(); const b64=data.data?.[0]?.b64_json;
    if(!b64) throw new Error('이미지 데이터 없음');
    setSceneImage(scene, 'data:image/png;base64,'+b64); renderEditor(); drawFrame(timelineTime()); log(`${scene.title} 이미지 생성 완료`);
  }catch(err){ setSceneImage(scene, placeholderImage(prompt, idx)); renderEditor(); drawFrame(timelineTime()); log('AI 이미지 실패: '+err.message+'\n임시 이미지로 대체했습니다.'); }
}
function imagePrompt(scene){
  const style=$('imageStyle').value;
  const styleText={
    person:'Korean person, emotional daily moment, cafe, walk, sunset, natural back view, cinematic lighting, photorealistic, high detail, warm tone',
    landscape:'beautiful landscape, ocean, mountain, city view, night city, cafe, pub, alley, drive road, sunset, cinematic lighting, ultra realistic, high detail',
    people:'friends, couple, family, coworkers, conversation, travel, dinner, pub gathering, warm natural atmosphere, photorealistic, cinematic, high detail'
  }[style] || 'emotional cinematic scene';
  const ratioText = $('videoRatio') && $('videoRatio').value === 'horizontal' ? 'horizontal 16:9 image' : 'vertical 9:16 shorts image';
  const captionText = scene.captionIds.map(id=>state.captions.find(c=>c.id===id)?.text||'').join(' ').replace(/\n/g,' ');
  const basePrompt = normalizeSpacing(scene.prompt || (useCaptionForImage() ? captionText : ''));
  const noTextRule = 'no text, no letters, no subtitles, no watermark, no logo';
  return `${styleText}, ${ratioText}, ${noTextRule}, ${basePrompt || 'emotional cinematic scene'}`;
}
async function generateAllImages(){ for(let i=0;i<state.scenes.length;i++) await generateSceneImage(state.scenes[i],i); }

function placeholderImage(text, idx){
  const c=document.createElement('canvas'); c.width=720; c.height=1280; const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,720,1280); g.addColorStop(0,`hsl(${(idx*55)%360},45%,28%)`); g.addColorStop(1,'#111827'); x.fillStyle=g; x.fillRect(0,0,720,1280);
  x.fillStyle='rgba(255,255,255,.1)'; for(let i=0;i<12;i++){ x.beginPath(); x.arc(Math.random()*720,Math.random()*1280,40+Math.random()*100,0,Math.PI*2); x.fill(); }
  x.fillStyle='#fff'; x.textAlign='center'; x.font='bold 48px sans-serif'; wrapDraw(x, `장면 ${idx+1}`, 360, 530, 600, 58);
  x.font='28px sans-serif'; wrapDraw(x, normalizeSpacing(text).slice(0,90), 360, 650, 600, 40);
  return c.toDataURL('image/png');
}

const thumbFonts = {
  gothic:'Pretendard, system-ui, sans-serif',
  bold:'Arial Black, Pretendard, system-ui, sans-serif',
  myeongjo:'Nanum Myeongjo, serif',
  hand:'Cafe24Ssurround, cursive',
  youtube:'Impact, Arial Black, sans-serif'
};

function splitThumbWords(text){
  return String(text || '').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
}
function wrapThumbLines(x, text, maxWidth, size, fontFamily){
  const rawLines = String(text || '').split('\n').map(v=>v.trim()).filter(Boolean);
  const lines = [];
  rawLines.forEach(raw=>{
    const words = splitThumbWords(raw);
    if(!words.length){ return; }
    let line = '';
    words.forEach(word=>{
      const test = line ? line + ' ' + word : word;
      if(x.measureText(test).width > maxWidth && line){
        lines.push(line);
        line = word;
      }else{
        line = test;
      }
    });
    if(line) lines.push(line);
  });
  // 띄어쓰기 없는 긴 한글 문장도 좌우로 넘지 않게 강제 분리
  const fixed = [];
  lines.forEach(line=>{
    if(x.measureText(line).width <= maxWidth){ fixed.push(line); return; }
    let buf = '';
    [...line].forEach(ch=>{
      const test = buf + ch;
      if(x.measureText(test).width > maxWidth && buf){ fixed.push(buf); buf = ch; }
      else buf = test;
    });
    if(buf) fixed.push(buf);
  });
  return fixed;
}
function fitThumbText(x, text, box, startSize, fontFamily, color='#fff', maxLines=5){
  let size = startSize;
  let lines = [];
  while(size >= 30){
    x.font = `900 ${size}px ${fontFamily}`;
    lines = wrapThumbLines(x, text, box.w, size, fontFamily);
    const lineH = size * 1.08;
    if(lines.length <= maxLines && lines.length * lineH <= box.h) break;
    size -= 3;
  }
  const lineH = size * 1.08;
  const totalH = lines.length * lineH;
  let y = box.y + Math.max(0, (box.h - totalH) / 2) + size * 0.82;
  x.textAlign='center';
  x.textBaseline='alphabetic';
  x.font = `900 ${size}px ${fontFamily}`;
  lines.slice(0,maxLines).forEach((line,i)=>{
    const yy = y + i * lineH;
    x.lineJoin='round';
    x.lineCap='round';
    x.lineWidth=Math.max(10,size*.16);
    x.strokeStyle='rgba(0,0,0,.92)';
    x.fillStyle=color;
    x.strokeText(line, box.x + box.w/2, yy);
    x.fillText(line, box.x + box.w/2, yy);
  });
}

function measureTopTextBlock(x, text, maxWidth, startSize, fontFamily, maxLines=5, minSize=24){
  let size = startSize;
  let lines = [];
  while(size >= minSize){
    x.font = `900 ${size}px ${fontFamily}`;
    const allLines = wrapThumbLines(x, text, maxWidth, size, fontFamily);
    lines = allLines.slice(0, maxLines);
    if(allLines.length <= maxLines) break;
    size -= 2;
  }
  const lineH = size * 1.06;
  return {size, lines, lineH, height: lines.length ? (lines.length * lineH) : 0};
}
function drawTopTextBlock(x, text, cx, y, maxWidth, startSize, fontFamily, color, strokeColor, maxLines=5){
  if(!String(text || '').trim()) return 0;
  const block = measureTopTextBlock(x, text, maxWidth, startSize, fontFamily, maxLines);
  x.save();
  x.textAlign='center';
  x.textBaseline='alphabetic';
  x.font = `900 ${block.size}px ${fontFamily}`;
  block.lines.forEach((line,i)=>{
    const yy = y + block.size * 0.82 + i * block.lineH;
    x.lineJoin='round';
    x.lineCap='round';
    x.lineWidth=Math.max(8, block.size * .16);
    x.strokeStyle=strokeColor || 'rgba(0,0,0,.92)';
    x.fillStyle=color || '#ffffff';
    x.strokeText(line, cx, yy);
    x.fillText(line, cx, yy);
  });
  x.restore();
  return block.height;
}
function makeThumbnail(){
  const mainTitle=$('thumbMainTitle')?.value || $('thumbTitle')?.value || '오늘도 수고했어요';
  const subTitle=$('thumbSubTitle')?.value || $('thumbBottom')?.value || '당신은 충분히 잘하고 있습니다';
  const fontKey=$('thumbFont')?.value || 'bold';
  const fontFamily = thumbFonts[fontKey] || thumbFonts.bold;
  const style=$('thumbStyle')?.value || 'comic';
  const mainSize = parseInt($('thumbMainSize')?.value || '92', 10);
  const subSize = parseInt($('thumbSubSize')?.value || '56', 10);
  const topY = parseInt($('thumbTextTop')?.value || '90', 10);
  const mainColor = $('thumbMainColor')?.value || '#ffffff';
  const subColor = $('thumbSubColor')?.value || '#ffd166';
  const subGap = parseInt($('thumbSubGap')?.value || '8', 10);
  const c=document.createElement('canvas'); c.width=720; c.height=1280; const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,720,1280);
  if(style==='photo'){ g.addColorStop(0,'#f7c978'); g.addColorStop(.52,'#263149'); g.addColorStop(1,'#080c16'); }
  else { g.addColorStop(0,'#5b37d1'); g.addColorStop(.42,'#ec4899'); g.addColorStop(1,'#111827'); }
  x.fillStyle=g; x.fillRect(0,0,720,1280);
  x.fillStyle='rgba(0,0,0,.16)'; x.fillRect(0,0,720,1280);
  // 요즘 쇼츠형: 위쪽 글자 전용 안전 영역
  x.fillStyle='rgba(0,0,0,.42)'; roundRect(x, 38, 78, 644, 650, 34); x.fill();
  x.fillStyle='rgba(255,255,255,.14)'; roundRect(x, 58, 98, 604, 610, 28); x.fill();
  x.fillStyle='rgba(0,0,0,.25)'; roundRect(x, 70, 110, 580, 586, 24); x.fill();
  // 하단은 비워서 실제 썸네일에서 답답하지 않게 처리
  x.fillStyle='rgba(255,255,255,.10)'; x.beginPath(); x.arc(600,980,210,0,Math.PI*2); x.fill();
  x.fillStyle='rgba(255,255,255,.07)'; x.beginPath(); x.arc(120,1060,150,0,Math.PI*2); x.fill();
  const mainH = drawTopTextBlock(x, mainTitle, 360, topY, 560, mainSize, fontFamily, mainColor, '#000000', 5);
  drawTopTextBlock(x, subTitle, 360, topY + mainH + subGap, 540, subSize, fontFamily, subColor, '#000000', 3);
  const img=c.toDataURL('image/png');
  state.thumbnail = {image: img, mainTitle, subTitle, font: fontKey, style, mainSize, subSize, topY};
  const preview = $('thumbPreview');
  if(preview){ preview.src = img; preview.style.display = 'block'; }
  const down = $('thumbDownload');
  if(down){ down.href = img; down.download = 'senial-thumbnail.png'; down.style.display = 'inline-block'; }
  log('썸네일 글자가 좌우로 넘지 않게 자동 맞춤으로 생성되었습니다.');
  return img;
}
function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}
function getMainVideo(){
  const v = $('referenceVideoPreview');
  return v && v.src ? v : null;
}
function hasUploadedVideoReady(){
  const v = getMainVideo();
  return !!(v && v.readyState >= 2 && v.videoWidth && v.videoHeight);
}

function getTimelineDuration(){
  const audio = $('audio');
  const video = getMainVideo();
  const vals = [
    state.audioDuration,
    audio && isFinite(audio.duration) ? audio.duration : 0,
    video && isFinite(video.duration) ? video.duration : 0,
    state.referenceVideoDuration
  ].filter(v => isFinite(v) && v > 0);
  return vals.length ? Math.max(...vals) : 0;
}

function fitCaptionsToDuration(newDuration, updateView=true){
  const dur = Math.max(0, parseFloat(newDuration || getTimelineDuration() || state.audioDuration || 0));
  if(!dur || !state.captions.length) return false;

  state.captions.sort((a,b)=>a.start-b.start);
  const firstStart = Math.min(...state.captions.map(c=>parseFloat(c.start)||0));
  const lastEnd = Math.max(...state.captions.map(c=>parseFloat(c.end)||0));
  const oldSpan = Math.max(0.1, lastEnd - firstStart);
  const scale = dur / oldSpan;

  state.captions.forEach(c=>{
    const st = Math.max(0, parseFloat(c.start)||0);
    const en = Math.max(st + 0.1, parseFloat(c.end)||st+0.1);
    c.start = Math.max(0, (st - firstStart) * scale);
    c.end = Math.max(c.start + 0.1, (en - firstStart) * scale);
  });
  state.captions[0].start = 0;
  state.captions[state.captions.length - 1].end = dur;
  syncFix(false);
  state.audioDuration = dur;
  buildScenes();
  if(updateView){
    renderEditor();
    drawFrame(timelineTime());
    updateSeekUI();
    log(`자막 전체 길이를 실제 음성/영상 길이 ${formatTime(dur)}에 맞췄습니다.`);
  }
  return true;
}

function captionTimelineTime(baseTime=currentTime()){
  return Math.max(0, baseTime + (state.syncOffset || 0));
}

function currentTime(){
  const audio = $('audio');
  const v = getMainVideo();
  if(audio && audio.src) return audio.currentTime || 0;
  if(v && v.src) return v.currentTime || 0;
  return 0;
}
function timelineTime(){ return captionTimelineTime(currentTime()); }
function setAudioTime(t){
  const audio=$('audio');
  const video=getMainVideo();
  const dur = state.audioDuration || audio.duration || video?.duration || 0;
  const nt = Math.max(0, Math.min(dur, t));
  if(audio && audio.src) audio.currentTime = nt;
  if(video && video.src) video.currentTime = nt;
  drawFrame(timelineTime()); updateSeekUI();
}
function sceneRange(scene){
  const caps = scene.captionIds.map(id=>state.captions.find(c=>c.id===id)).filter(Boolean);
  if(!caps.length) return null;
  return {start:caps[0].start, end:caps[caps.length-1].end};
}
function sceneAt(t){
  if(!state.scenes.length) return null;
  const hit = state.scenes.find(s=>{
    const r = sceneRange(s);
    return r && t >= r.start && t < r.end;
  });
  if(hit) return hit;

  // 핵심 수정: 오디오 시간이 마지막 자막 이후로 넘어가도 첫 장면으로 돌아가지 않게 함
  const ranged = state.scenes
    .map(s=>({scene:s, range:sceneRange(s)}))
    .filter(x=>x.range)
    .sort((a,b)=>a.range.start-b.range.start);

  if(!ranged.length) return state.scenes[0];
  if(t < ranged[0].range.start) return ranged[0].scene;
  return ranged[ranged.length-1].scene;
}
function captionAt(t){
  if(!state.captions.length) return null;
  const hit = state.captions.find(c=>t>=c.start && t<c.end);
  if(hit) return hit;
  if(t < state.captions[0].start) return state.captions[0];
  return state.captions[state.captions.length-1];
}

function drawFrame(t){
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#000'; ctx.fillRect(0,0,w,h);
  const sc=sceneAt(t); const cap=captionAt(t); const sp=speed();

  // 업로드한 mp4가 있으면 캔버스 미리보기/영상생성 배경으로 같이 표시
  if(hasUploadedVideoReady()){
    drawUploadedVideoFrame(getMainVideo(), w, h);
    drawOverlay(cap, sp, w, h, t);
    return;
  }

  if(sc?.imageObj && sc.imageObj.complete && sc.imageObj.naturalWidth){
    drawImageMotion(sc.imageObj, sc.motion, t, sc, w, h);
    drawOverlay(cap, sp, w, h, t);
  } else if(sc?.image){
    if(!sc.imageObj){ setSceneImage(sc, sc.image); }
    ctx.fillStyle='#111827'; ctx.fillRect(0,0,w,h); drawOverlay(cap, sp, w, h, t);
  } else {
    ctx.fillStyle='#111827'; ctx.fillRect(0,0,w,h); drawOverlay(cap, sp, w, h, t);
  }
}
function drawUploadedVideoFrame(video, w=canvas.width, h=canvas.height){
  if(!video || !video.videoWidth || !video.videoHeight){ ctx.fillStyle='#111827'; ctx.fillRect(0,0,w,h); return; }
  const ir = video.videoWidth / video.videoHeight;
  // 세로 쇼츠는 영상 가로폭을 화면에 맞추고 세로는 비율 그대로 둠
  const dw = w;
  const dh = w / ir;
  const dx = 0;
  const dy = (h - dh) / 2;
  ctx.drawImage(video, dx, dy, dw, dh);
}
function drawImageMotion(img,motion,t,scene,w=canvas.width,h=canvas.height){
  let scale=1.08,dx=0,dy=0,rot=0;

  // 핵심 수정: 이미지 1장이 자막 2칸 이상에 걸려도
  // 움직임이 자막칸마다 다시 시작되지 않고 장면 전체 시간으로 이어짐
  const range = scene ? sceneRange(scene) : null;
  const duration = range ? Math.max(0.1, range.end - range.start) : 7;
  const rawProgress = range ? (t - range.start) / duration : (t % 7) / 7;
  const p = Math.min(1, Math.max(0, rawProgress));

  const moveY = h * 0.22;
  const moveX = w * 0.20;
  if(motion==='zoom') scale=1.00+p*.35;
  if(motion==='zoomout') scale=1.35-p*.30;
  if(motion==='panup') { scale=1.22; dy=-p*moveY; }
  if(motion==='pandown') { scale=1.22; dy=p*moveY-moveY; }
  if(motion==='left') { scale=1.18; dx=-p*moveX; }
  if(motion==='right') { scale=1.18; dx=p*moveX-moveX; }
  if(motion==='rotate') { scale=1.16; rot=(p-.5)*0.045; }
  if(motion==='none') scale=1;
  const ir=img.naturalWidth/img.naturalHeight || img.width/img.height, cr=w/h; let dw,dh;
  if(ir>cr){ dh=h*scale; dw=dh*ir; } else { dw=w*scale; dh=dw/ir; }
  ctx.save(); ctx.translate(w/2+dx,h/2+dy); ctx.rotate(rot); ctx.drawImage(img,-dw/2,-dh/2,dw,dh); ctx.restore();
}

function getTopFixedTextSettings(){
  return {
    enabled: !!($('thumbOverlayEnable') && $('thumbOverlayEnable').checked),
    mainTitle: $('thumbMainTitle')?.value || '',
    subTitle: $('thumbSubTitle')?.value || '',
    fontKey: $('thumbFont')?.value || 'bold',
    style: $('thumbStyle')?.value || 'comic',
    mainSize: parseInt($('thumbMainSize')?.value || '92', 10),
    subSize: parseInt($('thumbSubSize')?.value || '56', 10),
    // v3.6: 메인/부제 Y 좌표를 완전히 분리. 기존 thumbTextTop 값은 호환용으로만 사용
    mainY: parseInt($('thumbMainY')?.value || $('thumbTextTop')?.value || '85', 10),
    subY: parseInt($('thumbSubY')?.value || '145', 10),
    topY: parseInt($('thumbMainY')?.value || $('thumbTextTop')?.value || '85', 10),
    textX: parseInt($('thumbTextX')?.value || '0', 10),
    subGap: parseInt($('thumbSubGap')?.value || '0', 10),
    mainColor: $('thumbMainColor')?.value || '#ffffff',
    subColor: $('thumbSubColor')?.value || '#ffd166',
    strokeColor: $('thumbStrokeColor')?.value || '#000000'
  };
}
function drawTopFixedTextOverlay(t, w=canvas.width, h=canvas.height){
  const cfg = getTopFixedTextSettings();
  if(!cfg.enabled) return;
  const main = String(cfg.mainTitle || '').trim();
  const sub = String(cfg.subTitle || '').trim();
  if(!main && !sub) return;
  const sc = sceneAt(t);
  if(sc && sc.topFixedText === false) return;

  const scale = w / 720;
  const x = ctx;
  const fontFamily = thumbFonts[cfg.fontKey] || thumbFonts.bold;
  const centerX = Math.max(w * 0.12, Math.min(w * 0.88, w / 2 + (cfg.textX || 0) * scale));
  const maxW = w * 0.84;
  const mainSize = Math.max(20, (cfg.mainSize || 92) * scale);
  const subSize = Math.max(16, (cfg.subSize || 56) * scale);
  const mainY = Math.max(6 * scale, Math.min(h * 0.55, (cfg.mainY || 85) * scale));
  let subY = Math.max(10 * scale, Math.min(h * 0.70, (cfg.subY || 145) * scale));
  const gap = (cfg.subGap || 0) * scale;

  function splitLines(text, size, maxWidth, maxLines){
    const original = String(text || '').split(/\n+/).map(s=>s.trim()).filter(Boolean);
    let lines = [];
    x.font = `900 ${size}px ${fontFamily}`;
    original.forEach(part=>{
      const words = part.split(/\s+/).filter(Boolean);
      if(words.length <= 1){
        let buf = '';
        [...part].forEach(ch=>{
          const test = buf + ch;
          if(x.measureText(test).width > maxWidth && buf){ lines.push(buf); buf = ch; }
          else buf = test;
        });
        if(buf) lines.push(buf);
        return;
      }
      let line = '';
      words.forEach(word=>{
        const test = line ? line + ' ' + word : word;
        if(x.measureText(test).width > maxWidth && line){ lines.push(line); line = word; }
        else line = test;
      });
      if(line) lines.push(line);
    });
    return lines.slice(0, maxLines);
  }
  function fitBlock(text, startSize, maxWidth, maxLines, minSize){
    let size = startSize;
    let lines = [];
    while(size >= minSize){
      lines = splitLines(text, size, maxWidth, maxLines);
      x.font = `900 ${size}px ${fontFamily}`;
      const tooWide = lines.some(line=>x.measureText(line).width > maxWidth + 1);
      if(!tooWide) break;
      size -= 2;
    }
    return { size, lines, lineH: size * 1.08, height: lines.length * size * 1.08 };
  }
  const mainBlock = fitBlock(main, mainSize, maxW, 4, 16 * scale);
  const subBlock = fitBlock(sub, subSize, maxW, 3, 14 * scale);

  // 부제목은 메인 아래에 반드시 보이게 강제 보정
  if(main && sub){
    const minVisibleSubY = mainY + mainBlock.height + Math.max(6 * scale, gap);
    if(subY < minVisibleSubY) subY = minVisibleSubY;
    const maxVisibleSubY = h * 0.72 - subBlock.height;
    if(subY > maxVisibleSubY) subY = Math.max(mainY + mainBlock.height + 4 * scale, maxVisibleSubY);
  }

  const topBox = Math.max(0, Math.min(main ? mainY : h, sub ? subY : h) - 12 * scale);
  const bottomBox = Math.min(h * 0.82, Math.max(main ? mainY + mainBlock.height : 0, sub ? subY + subBlock.height : 0) + 14 * scale);
  if(cfg.style === 'comic'){
    x.save();
    x.fillStyle = 'rgba(0,0,0,.24)';
    roundRect(x, centerX - maxW/2 - 8*scale, topBox, maxW + 16*scale, Math.max(20*scale, bottomBox - topBox), 20*scale);
    x.fill();
    x.restore();
  }

  function drawBlock(block, y, fill){
    if(!block.lines.length) return;
    x.save();
    x.textAlign = 'center';
    x.textBaseline = 'top';
    x.font = `900 ${block.size}px ${fontFamily}`;
    block.lines.forEach((line, i)=>{
      const yy = y + i * block.lineH;
      x.lineJoin = 'round';
      x.lineCap = 'round';
      x.lineWidth = Math.max(4, block.size * .18);
      x.strokeStyle = cfg.strokeColor || '#000000';
      x.fillStyle = fill || '#ffffff';
      x.strokeText(line, centerX, yy);
      x.fillText(line, centerX, yy);
    });
    x.restore();
  }
  drawBlock(mainBlock, mainY, cfg.mainColor || '#ffffff');
  drawBlock(subBlock, subY, cfg.subColor || '#ffd166');
}
function drawOverlay(cap, sp, w=canvas.width, h=canvas.height, t=timelineTime()){
  const base = w / 1080;
  const fs=Math.max(14, parseInt($('fontSize').value||58) * base); const pos=$('captionPos').value; const text=cap?.text||'';
  ctx.fillStyle='rgba(0,0,0,.30)'; ctx.fillRect(0,0,w,h);
  drawTopFixedTextOverlay(t, w, h);
  ctx.font=`900 ${fs}px system-ui, sans-serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
  const y = pos==='top'?h*.18:pos==='center'?h*.50:h*.77;
  const lines=String(text).split('\n'); const lineH=fs*1.25; const startY=y-(lines.length-1)*lineH/2;
  lines.forEach((line,i)=>{ ctx.lineWidth=Math.max(3,fs*.16); ctx.strokeStyle='black'; ctx.fillStyle='white'; ctx.strokeText(line,w/2,startY+i*lineH); ctx.fillText(line,w/2,startY+i*lineH); });
  const barX=w*.033, barY=h*.927, barW=w*.934, barH=Math.max(14,h*.025);
  ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(barX,barY,barW,barH); ctx.fillStyle='#67e8a5'; ctx.fillRect(barX,barY,barW*Math.min(1,currentTime()/(state.audioDuration||60)),barH);
}
function wrapDraw(x,text,cx,y,maxW,lineH){
  const words=String(text).split(' '); let line='', yy=y;
  words.forEach(word=>{ const test=line?line+' '+word:word; if(x.measureText(test).width>maxW && line){ x.fillText(line,cx,yy); yy+=lineH; line=word; } else line=test; });
  if(line) x.fillText(line,cx,yy);
}

function updateSeekUI(){
  const audio=$('audio');
  const dur = getTimelineDuration() || state.audioDuration || audio.duration || 0;
  const seek = $('previewSeek');
  if(seek && !state.seeking){ seek.max = dur || 0; seek.value = currentTime(); }
  const label = $('previewTime');
  if(label) label.textContent = `${formatTime(currentTime())} / ${formatTime(dur)}`;
}
function changeSyncOffset(delta){
  state.syncOffset = Math.round(((state.syncOffset || 0) + delta) * 10) / 10;
  if($('syncOffset')) $('syncOffset').value = state.syncOffset.toFixed(1);
  drawFrame(timelineTime());
  updateSeekUI();
  log(`자막 싱크 보정값: ${state.syncOffset.toFixed(1)}초 / +는 자막을 더 빨리 보이게, -는 더 늦게 보이게 합니다.`);
}

function preview(){
  canvas.width = PREVIEW_W;
  canvas.height = PREVIEW_H;
  cacheSceneImages();
  const audio=$('audio');
  const video=getMainVideo();
  cancelAnimationFrame(state.previewTimer);

  const hasAudio = !!(audio && audio.src);
  const hasVideo = !!(video && video.src);
  const playMedia = hasAudio ? audio : video;

  if(playMedia && playMedia.src) {
    playMedia.playbackRate=speed();
    if(playMedia.ended || playMedia.currentTime >= (state.audioDuration || playMedia.duration || 0) - 0.05) playMedia.currentTime = 0;

    if(hasVideo){
      video.playbackRate = speed();
      video.currentTime = playMedia.currentTime || 0;
      // 음성 파일이 따로 있으면 영상 소리는 끄고, 영상만 있으면 영상 속 소리를 사용
      video.muted = hasAudio;
      video.style.display = 'none';
    }

    drawFrame(timelineTime());
    updateSeekUI();

    setTimeout(()=>{
      playMedia.play().catch(()=>{});
      if(hasVideo && playMedia !== video) video.play().catch(()=>{});
    }, 80);
  }

  let lastDraw = 0;
  const loop=(now)=>{
    if(hasAudio && hasVideo && Math.abs(video.currentTime - audio.currentTime) > 0.12){
      video.currentTime = audio.currentTime;
    }
    if(!lastDraw || now - lastDraw > 1000/24){
      drawFrame(timelineTime());
      updateSeekUI();
      lastDraw = now;
    }
    const ended = playMedia && playMedia.src ? playMedia.ended : false;
    if(!ended) state.previewTimer=requestAnimationFrame(loop);
  };
  state.previewTimer=requestAnimationFrame(loop);
}
function stopPreview(){
  const audio=$('audio');
  const video=getMainVideo();
  audio.pause();
  if(video) video.pause();
  cancelAnimationFrame(state.previewTimer);
  drawFrame(timelineTime());
}

function setRenderButton(mode, percent=0){
  const btn = $('btnRender');
  if(!btn) return;
  btn.classList.remove('downloadReady','renderingNow');
  if(mode === 'ready'){
    btn.textContent = '쇼츠 만들기';
    btn.disabled = false;
    btn.onclick = renderVideo;
  }else if(mode === 'rendering'){
    const p = Math.max(0, Math.min(99, Math.round(percent || 0)));
    btn.textContent = `쇼츠 생성중 ${p}%`;
    btn.disabled = true;
    btn.classList.add('renderingNow');
  }else if(mode === 'download'){
    btn.textContent = '영상 다운로드';
    btn.disabled = false;
    btn.classList.add('downloadReady');
    btn.onclick = downloadLastVideo;
  }else if(mode === 'disabledDownload'){
    btn.textContent = '영상 다운로드 준비중';
    btn.disabled = true;
  }
}

function setDownloadStatus(text, mode='idle'){
  const el = $('renderStatus');
  if(el){
    el.textContent = text || '대기중';
    el.className = `renderStatus ${mode}`;
  }
  const link = $('downloadLink');
  if(link && mode !== 'done'){
    link.removeAttribute('href');
    link.classList.add('disabledDownload');
    link.style.display = 'block';
    link.textContent = text || '영상 생성 후 다운로드 가능';
  }
}

function downloadLastVideo(e){
  if(e && e.preventDefault) e.preventDefault();
  if(!state.lastVideoUrl){
    alert('아직 완성된 영상이 없습니다. 먼저 [쇼츠 만들기]를 눌러 영상 생성을 완료하세요.');
    return;
  }
  const a = document.createElement('a');
  a.href = state.lastVideoUrl;
  a.download = state.lastVideoFileName || 'senial_video.mp4';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>a.remove(), 300);
  log('영상 다운로드를 시작했습니다.');
}

function prepareDownloadLink(url, fileName){
  state.lastVideoUrl = url;
  state.lastVideoFileName = fileName;
  const link = $('downloadLink');
  if(link){
    link.href = url;
    link.download = fileName;
    link.style.display='block';
    link.classList.remove('disabledDownload');
    link.textContent = '영상 다운로드';
    link.onclick = downloadLastVideo;
  }
  setRenderButton('download');
  setDownloadStatus('생성 완료 · 영상 다운로드 가능', 'done');
}

function getVoiceTextSource(){
  const tts = $('ttsText')?.value || '';
  if(tts.trim()) return tts;
  const script = $('generatedScript')?.value || '';
  if(script.trim()) return script;
  return state.captions.map(c=>String(c.text||'').replace(/\n/g,' ')).join('\n');
}

function syncTtsTextFromScript(text){
  const box = $('ttsText');
  if(!box) return;
  const src = String(text || $('generatedScript')?.value || state.captions.map(c=>String(c.text||'').replace(/\n/g,' ')).join('\n') || '');
  const cleaned = stripScriptSectionLabels(cleanScriptSymbols(src))
    .split(/\n+/)
    .map(cleanCaptionText)
    .map(normalizeSpacing)
    .filter(Boolean)
    .join('\n');
  box.value = cleaned;
}

async function copyTtsText(){
  const text = getVoiceTextSource();
  if(!text.trim()){ alert('복사할 음성 텍스트가 없습니다. 먼저 대본을 만들거나 자막을 생성하세요.'); return false; }
  try{ await navigator.clipboard.writeText(text); }
  catch(e){
    const box = $('ttsText');
    if(box){ box.focus(); box.select(); document.execCommand('copy'); }
  }
  log('음성용 텍스트를 복사했습니다.');
  return true;
}

function openOndoku(){
  window.open('https://ondoku3.com/ko/advanced-tts-beta/', '_blank', 'noopener,noreferrer');
}

async function copyAndOpenOndoku(){
  await copyTtsText();
  openOndoku();
}



function getSupportedRecorderMime(){
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="h264,aac"',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find(m => { try{ return MediaRecorder.isTypeSupported(m); }catch(e){ return false; } }) || '';
}
function isMp4Mime(mime){ return /^video\/mp4/i.test(String(mime || '')); }
function setMp4Progress(text){
  setDownloadStatus(text, 'working');
  log(text);
}
function loadScriptOnce(src, globalCheck){
  return new Promise((resolve, reject)=>{
    if(globalCheck && globalCheck()) return resolve();
    const exists = [...document.scripts].find(s=>s.src === src);
    if(exists){
      exists.addEventListener('load', ()=>resolve(), {once:true});
      exists.addEventListener('error', ()=>reject(new Error('스크립트 로드 실패: '+src)), {once:true});
      return;
    }
    const script=document.createElement('script');
    script.src=src;
    script.async=true;
    script.onload=()=>resolve();
    script.onerror=()=>reject(new Error('스크립트 로드 실패: '+src));
    document.head.appendChild(script);
  });
}
async function getFfmpegInstance(){
  if(state.ffmpegReady && state.ffmpeg) return state.ffmpeg;
  setMp4Progress('MP4 변환 엔진 불러오는 중... 처음 1회는 조금 걸릴 수 있습니다.');
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js', ()=>window.FFmpegWASM?.FFmpeg);
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/umd/index.js', ()=>window.FFmpegUtil?.fetchFile);
  const { FFmpeg } = window.FFmpegWASM;
  const util = window.FFmpegUtil || {};
  const toBlobURL = util.toBlobURL || (async (url, type)=>URL.createObjectURL(await (await fetch(url)).blob()));
  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({progress})=>{
    const p = Math.max(0, Math.min(99, Math.round((progress || 0) * 100)));
    setDownloadStatus(`MP4 변환중... ${p}%`, 'working');
  });
  ffmpeg.on('log', ({message})=>{ if(message) console.log('[ffmpeg]', message); });
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
  });
  state.ffmpeg = ffmpeg;
  state.ffmpegReady = true;
  return ffmpeg;
}
async function convertWebmToMp4(webmBlob){
  const ffmpeg = await getFfmpegInstance();
  const inputName = 'input.webm';
  const outputName = 'output.mp4';
  try{ await ffmpeg.deleteFile(inputName); }catch(e){}
  try{ await ffmpeg.deleteFile(outputName); }catch(e){}
  const util = window.FFmpegUtil || {};
  const inputData = util.fetchFile ? await util.fetchFile(webmBlob) : new Uint8Array(await webmBlob.arrayBuffer());
  await ffmpeg.writeFile(inputName, inputData);
  setMp4Progress('MP4 변환중... 유튜브 업로드용으로 인코딩합니다.');
  await ffmpeg.exec([
    '-i', inputName,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputName
  ]);
  const data = await ffmpeg.readFile(outputName);
  return new Blob([data.buffer], {type:'video/mp4'});
}
async function finalizeRenderedBlob(rawBlob, recordedMime){
  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  let finalBlob = rawBlob;
  let fileName = `senial_shorts_${today}.mp4`;
  let finalType = 'MP4';
  if(!isMp4Mime(recordedMime)){
    try{
      finalBlob = await convertWebmToMp4(rawBlob);
    }catch(err){
      console.warn(err);
      finalBlob = rawBlob;
      fileName = `senial_shorts_${today}.webm`;
      finalType = 'WEBM';
      alert('MP4 자동변환에 실패했습니다. WEBM으로만 준비됩니다. 크롬/엣지 최신버전에서 다시 시도하거나, 이 WEBM을 캡컷/브루에서 MP4로 내보내세요.');
    }
  }
  if(state.lastVideoUrl){ try{ URL.revokeObjectURL(state.lastVideoUrl); }catch(e){} }
  const url = URL.createObjectURL(finalBlob);
  state.lastVideoBlob = finalBlob;
  prepareDownloadLink(url, fileName);
  setDownloadStatus(`${finalType} 생성 완료 · 영상 다운로드 가능`, 'done');
  log(`${finalType} 영상 생성 완료. [영상 다운로드] 버튼을 누르세요.`);
}


function waitForMediaReady(media, timeoutMs=3500){
  return new Promise(resolve=>{
    if(!media || !media.src) return resolve(false);
    if(media.readyState >= 1 && isFinite(media.duration)) return resolve(true);
    let done=false;
    const finish=(ok)=>{ if(done) return; done=true; cleanup(); resolve(ok); };
    const cleanup=()=>{
      media.removeEventListener('loadedmetadata', onMeta);
      media.removeEventListener('canplay', onMeta);
      media.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const onMeta=()=>finish(true);
    const onErr=()=>finish(false);
    const timer=setTimeout(()=>finish(false), timeoutMs);
    media.addEventListener('loadedmetadata', onMeta);
    media.addEventListener('canplay', onMeta);
    media.addEventListener('error', onErr);
    try{ media.load(); }catch(e){}
  });
}

function ensureScenesBeforeRender(){
  if(!state.captions.length) return false;
  if(!state.scenes.length){
    try{
      buildScenes();
      renderEditor();
    }catch(e){ console.warn(e); }
  }
  return !!state.scenes.length;
}

function showRenderStartingUI(){
  setRenderButton('rendering', 1);
  setDownloadStatus('쇼츠 생성 준비중... 재생을 시작합니다.', 'working');
  log('쇼츠 생성 시작. 화면이 0%에서 멈추지 않도록 자동 재생/렌더링을 같이 시작합니다.');
}

async function renderVideo(){
  const audio=$('audio');
  const uploadedVideo = getUploadedVideoFile();
  if(uploadedVideo && !state.referenceVideoDuration){
    updateReferenceVideoUI(uploadedVideo);
  }
  const video = getMainVideo();
  const hasUploadedVideo = !!(video && video.src);

  // 대본이 있으면 자동으로 자막/장면까지 만들어서 0% 멈춤 방지
  if((!state.captions.length || !state.scenes.length) && $('generatedScript')?.value.trim()){
    applyGeneratedScriptToCaptions();
  }
  if((!state.captions.length || !state.scenes.length) && $('scriptTopic')?.value.trim()){
    await generateScriptFromStyle();
    applyGeneratedScriptToCaptions();
  }
  if(state.captions.length && !state.scenes.length){
    ensureScenesBeforeRender();
  }

  // 영상만 넣은 경우에도 생성 허용. 영상도 없고 장면도 없으면 안내 후 중단.
  if(!hasUploadedVideo && (!state.captions.length || !state.scenes.length)){
    setRenderButton('ready');
    setDownloadStatus('대본/자막 또는 영상 파일이 필요합니다.', 'error');
    alert('영상 파일을 첨부하거나, 대본 생성 후 자막칸에 적용하세요.');
    return;
  }

  cacheSceneImages();
  stopPreview();
  state.rendering = true;
  showRenderStartingUI();

  applyVideoRatio();
  canvas.width = FINAL_W; canvas.height = FINAL_H;

  const hasAudio = !!(audio && audio.src);
  const hasVideo = !!(video && video.src);

  await waitForMediaReady(video, 4000);
  await waitForMediaReady(audio, 4000);

  let duration = state.audioDuration || 30;
  if(hasAudio && isFinite(audio.duration) && audio.duration > 0) duration = audio.duration;
  else if(hasVideo && isFinite(video.duration) && video.duration > 0) duration = video.duration;
  else if(state.captions.length) duration = Math.max(...state.captions.map(c=>c.end), duration);
  duration = Math.max(1, duration);

  try{
    if(hasVideo){
      video.pause();
      video.currentTime = 0;
      video.playbackRate = speed();
    }
    if(hasAudio){
      audio.pause();
      audio.currentTime = 0;
      audio.playbackRate = speed();
    }
  }catch(e){ console.warn(e); }

  drawFrame(0);
  updateSeekUI();

  const canvasStream = canvas.captureStream(30);
  const stream = new MediaStream(canvasStream.getVideoTracks());

  // 오디오 트랙 추가: 음성파일이 있으면 음성파일 우선, 없으면 업로드 영상 원본 소리 사용
  try{
    if(hasAudio && audio.captureStream){
      const audioStream = audio.captureStream();
      audioStream.getAudioTracks().forEach(track=>stream.addTrack(track));
    }else if(hasVideo && video.captureStream){
      const videoStream = video.captureStream();
      videoStream.getAudioTracks().forEach(track=>stream.addTrack(track));
    }
  }catch(e){ console.warn('audio track capture failed', e); }

  const mime = getSupportedRecorderMime();

  state.chunks=[];
  let rec;
  try{
    rec = mime ? new MediaRecorder(stream,{mimeType:mime, videoBitsPerSecond:8000000}) : new MediaRecorder(stream,{videoBitsPerSecond:8000000});
  }catch(err){
    state.rendering=false;
    setRenderButton('ready');
    setDownloadStatus('영상 생성 실패', 'error');
    canvas.width=PREVIEW_W; canvas.height=PREVIEW_H;
    log('영상 생성 실패: 이 브라우저에서 녹화를 지원하지 않습니다. 크롬/엣지로 다시 시도하세요.');
    alert('영상 생성 실패: 크롬 또는 엣지에서 다시 시도하세요.');
    return;
  }

  let finished = false;
  const finishRecording = ()=>{
    if(finished) return;
    finished = true;
    try{ if(hasAudio) audio.pause(); }catch(e){}
    try{ if(hasVideo) video.pause(); }catch(e){}
    const rawType = isMp4Mime(mime) ? 'video/mp4' : 'video/webm';
    const blob = new Blob(state.chunks,{type:rawType});
    setRenderButton('disabledDownload');
    setDownloadStatus(isMp4Mime(mime) ? 'MP4 마무리중...' : 'WEBM 생성 완료 · MP4 변환중...', 'working');
    finalizeRenderedBlob(blob, mime).finally(()=>{
      state.rendering = false;
      canvas.width = PREVIEW_W;
      canvas.height = PREVIEW_H;
      drawFrame(0);
      updateSeekUI();
    });
  };

  rec.ondataavailable = e=>{ if(e.data && e.data.size) state.chunks.push(e.data); };
  rec.onstop = finishRecording;
  rec.onerror = e=>{
    console.error(e);
    state.rendering=false;
    setRenderButton('ready');
    setDownloadStatus('영상 생성 오류', 'error');
    log('영상 생성 중 오류가 났습니다. 파일 용량을 줄이거나 720p로 다시 시도하세요.');
  };

  rec.start(300);

  let mediaPlayStarted = false;
  try{
    if(hasVideo){
      video.currentTime = 0;
      video.playbackRate = speed();
      // 음성파일 따로 있으면 영상 소리는 제거. 없으면 원본 소리 유지 시도.
      video.muted = !!hasAudio;
      await video.play();
      mediaPlayStarted = true;
    }
  }catch(err){
    console.warn('video play failed, retry muted', err);
    try{
      if(hasVideo){
        video.muted = true;
        await video.play();
        mediaPlayStarted = true;
      }
    }catch(e){ console.warn(e); }
  }

  try{
    if(hasAudio){
      audio.currentTime = 0;
      audio.playbackRate = speed();
      await audio.play();
      mediaPlayStarted = true;
    }
  }catch(err){
    console.warn('audio play failed', err);
  }

  const started = performance.now();
  const hardStop = setTimeout(()=>{
    try{ if(rec.state !== 'inactive'){ rec.requestData(); rec.stop(); } }catch(e){ finishRecording(); }
  }, Math.ceil(duration * 1000 / speed()) + 3000);

  const stopRecorder = ()=>{
    clearTimeout(hardStop);
    try{ if(rec.state !== 'inactive'){ rec.requestData(); rec.stop(); } else finishRecording(); }
    catch(e){ finishRecording(); }
  };

  const renderLoop = ()=>{
    const syntheticT = Math.min(duration, (performance.now()-started)/1000 * speed());
    let mediaT = 0;

    if(hasAudio && isFinite(audio.currentTime)) mediaT = audio.currentTime || 0;
    else if(hasVideo && isFinite(video.currentTime)) mediaT = video.currentTime || 0;

    // 재생이 막혀 currentTime이 0에 머물러도 진행률은 syntheticT로 전진시킴
    let t = mediaT > 0.05 || mediaPlayStarted ? Math.max(mediaT, syntheticT > 0.5 && mediaT < 0.05 ? syntheticT : mediaT) : syntheticT;
    t = Math.min(duration, Math.max(0, t));

    if(hasVideo && hasAudio && Math.abs((video.currentTime||0) - t) > 0.20){
      try{ video.currentTime = Math.min(t, Math.max(0, (video.duration || duration) - 0.05)); }catch(e){}
    }

    drawFrame(captionTimelineTime(t));
    const percent = duration ? (t / duration) * 100 : 1;
    const safePercent = Math.max(1, Math.min(99, Math.round(percent)));
    setRenderButton('rendering', safePercent);
    setDownloadStatus(`영상 생성중... ${safePercent}%`, 'working');
    updateSeekUI();

    if(t < duration - 0.05 && state.rendering) requestAnimationFrame(renderLoop);
    else stopRecorder();
  };

  requestAnimationFrame(renderLoop);
}
async function autoMode(){
  log('올자동 모드 시작');
  if(!state.captions.length){
    if($('generatedScript')?.value.trim()) applyGeneratedScriptToCaptions();
    else if($('scriptTopic')?.value.trim()){ await generateScriptFromStyle(); applyGeneratedScriptToCaptions(); }
    else if($('audioFile')?.files?.[0]) await transcribeAudio();
    else { alert('주제를 입력하거나 음성 파일을 넣으세요.'); return; }
  }
  syncFix(); buildScenes(); await generateAllImages(); makeThumbnail(); renderEditor(); drawFrame(0); log('올자동 모드 완료: 자막, 장면, 이미지, 썸네일 전용 이미지까지 구성했습니다.');
}

function applyTopFixedTextSettings(cfg){
  if($('thumbOverlayEnable')) $('thumbOverlayEnable').checked = cfg.enabled !== false;
  if($('thumbMainTitle')) $('thumbMainTitle').value = cfg.mainTitle || '';
  if($('thumbSubTitle')) $('thumbSubTitle').value = cfg.subTitle || '';
  if($('thumbFont')) $('thumbFont').value = cfg.fontKey || cfg.font || 'bold';
  if($('thumbStyle')) $('thumbStyle').value = cfg.style || 'comic';
  if($('thumbMainSize')) $('thumbMainSize').value = cfg.mainSize || 92;
  if($('thumbSubSize')) $('thumbSubSize').value = cfg.subSize || 56;
  if($('thumbMainY')) $('thumbMainY').value = cfg.mainY || cfg.topY || 85;
  if($('thumbSubY')) $('thumbSubY').value = cfg.subY || 145;
  if($('thumbTextTop')) $('thumbTextTop').value = cfg.mainY || cfg.topY || 85;
  if($('thumbTextX')) $('thumbTextX').value = cfg.textX || 0;
  if($('thumbSubGap')) $('thumbSubGap').value = cfg.subGap ?? 0;
  if($('thumbMainColor')) $('thumbMainColor').value = cfg.mainColor || '#ffffff';
  if($('thumbSubColor')) $('thumbSubColor').value = cfg.subColor || '#ffd166';
  if($('thumbStrokeColor')) $('thumbStrokeColor').value = cfg.strokeColor || '#000000';
}
function saveProject(){
  const data=JSON.stringify({captions:state.captions,scenes:state.scenes,audioDuration:state.audioDuration,thumbnail:state.thumbnail,topFixedText:getTopFixedTextSettings()},null,2); const blob=new Blob([data],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='senial-project.json'; a.click();
}
async function loadProject(e){ const f=e.target.files[0]; if(!f)return; const data=JSON.parse(await f.text()); state.captions=data.captions||[]; state.scenes=data.scenes||[]; state.audioDuration=data.audioDuration||60; state.thumbnail=data.thumbnail||null; if(data.topFixedText){ applyTopFixedTextSettings(data.topFixedText); } if(state.thumbnail?.image && $('thumbPreview')){ $('thumbPreview').src=state.thumbnail.image; $('thumbPreview').style.display='block'; } cacheSceneImages(); renderEditor(); drawFrame(0); }



function getUploadedVideoFile(){
  return state.referenceVideoFile || $('referenceVideoFile')?.files?.[0] || $('renderVideoFile')?.files?.[0] || null;
}
function updateRenderVideoAttachStatus(file, seconds){
  const el = $('renderVideoAttachInfo');
  if(!el) return;
  if(!file){
    el.textContent = '영상 생성용 첨부 영상 없음';
    el.classList.remove('okAttach');
    return;
  }
  const secText = seconds ? ` / ${formatTime(seconds)}` : '';
  el.textContent = `영상 생성용 첨부됨: ${file.name}${secText}`;
  el.classList.add('okAttach');
}
function getTargetSeconds(){
  const hasVideo = !!getUploadedVideoFile();
  const analyzed = Number(state.referenceVideoDuration || state.analyzedStyle?.seconds || 0);
  const selected = parseInt($('scriptLength')?.value || '30', 10);
  return Math.max(5, hasVideo && analyzed ? analyzed : (analyzed || selected || 30));
}
function updateReferenceVideoUI(file){
  const box = $('videoAttachBox');
  const preview = $('referenceVideoPreview');
  const info = $('referenceVideoInfo');
  if(!file){
    state.referenceVideoFile = null;
    state.referenceVideoDuration = 0;
    updateRenderVideoAttachStatus(null, 0);
    if(box) box.style.display = 'none';
    return;
  }
  state.referenceVideoFile = file;
  updateRenderVideoAttachStatus(file, 0);
  if(state.referenceVideoUrl) URL.revokeObjectURL(state.referenceVideoUrl);
  state.referenceVideoUrl = URL.createObjectURL(file);
  if(preview){
    preview.src = state.referenceVideoUrl;
    preview.style.display = 'none';
    preview.controls = false;
    preview.preload = 'metadata';
    preview.muted = true;
    preview.load();
    preview.onloadedmetadata = () => {
      const sec = Math.round(preview.duration || getTargetSeconds());
      state.referenceVideoDuration = sec;
      state.analyzedStyle.seconds = sec;
      state.analyzedStyle.scenes = Math.max(6, Math.ceil(sec/3));
      state.analyzedStyle.type = '업로드 영상 길이 기준';
      if(info) info.textContent = `${file.name} / ${formatTime(sec)} / ${state.analyzedStyle.scenes}장면 기준`;
      updateRenderVideoAttachStatus(file, sec);
      if($('scriptLength')){
        const closest = sec <= 35 ? '30' : sec <= 50 ? '45' : '60';
        $('scriptLength').value = closest;
      }
      updateSeekUI();
      drawFrame(0);
      log(`동영상 첨부 완료: ${formatTime(sec)} 길이에 맞춰 대본을 만들 수 있습니다.`);
    };
  }
  if(preview) preview.onloadeddata = () => { drawFrame(0); updateSeekUI(); };
  if(info) info.textContent = `${file.name} / 길이 확인 중...`;
  if(box) box.style.display = 'block';
}
function useUploadedVideoLength(){
  const file = getUploadedVideoFile();
  if(!file){ alert('먼저 동영상 파일을 선택하세요.'); return; }
  updateReferenceVideoUI(file);
  const sec = getTargetSeconds();
  log(`이 영상 길이 기준으로 설정했습니다: 약 ${sec}초`);
}
function analyzeReferenceStyle(){
  const video = getUploadedVideoFile();
  const len = parseInt($('scriptLength')?.value || '30', 10);
  if(video){
    updateReferenceVideoUI(video);
    const sec = getTargetSeconds();
    log(`영상 길이 분석 중... 파일을 읽는 중입니다. 현재 기준: 약 ${sec}초`);
  } else {
    state.analyzedStyle.seconds = len;
    state.analyzedStyle.scenes = Math.max(6, Math.ceil(len/3));
    state.analyzedStyle.type = $('youtubeUrl')?.value ? '유튜브 링크 참고형' : '기본 감성공감형';
    log(`영상 길이 분석 완료\n길이: 약 ${len}초\n장면수: ${state.analyzedStyle.scenes}개\n구조표시 없이 실제 나레이션만 생성`);
  }
}
function fallbackScript(topic, seconds){
  topic = topic || '뒤늦게 깨달은 내 편';
  if(seconds <= 35) return `${topic}
사실 가장 늦게 알게 됩니다
우리는 늘 누군가를 위해 애쓰지만
정작 내 마음은 자주 뒤로 미뤄둡니다
힘든 순간에 곁에 남는 사람은 많지 않습니다
그래서 결국 알게 됩니다
나를 지켜주는 사람보다
나를 무너지지 않게 하는 마음이 더 중요하다는 걸요
오늘부터는 나를 먼저 챙기세요
내 인생의 가장 든든한 편은
결국 나 자신입니다`;
  return `${topic}
이걸 늦게 깨달으면 인생이 꽤 아픕니다
우리는 남에게 좋은 사람이 되려고 애씁니다
괜찮은 척하고 이해하는 척하고
내 마음은 계속 뒤로 미뤄둡니다
그런데 시간이 지나면 알게 됩니다
내가 지친 이유는 부족해서가 아니라
나를 너무 오래 외면했기 때문이라는 걸요
진짜 내 편은 늘 내 옆에 있는 사람이 아니라
내가 무너지지 않게 붙잡아주는 마음입니다
오늘부터는 나를 먼저 챙기세요
상처 주는 관계는 내려놓고
나를 성장시키는 선택을 하세요
당신은 충분히 잘 살아왔습니다`;
}
async function generateScriptFromStyle(){
  const key=$('apiKey')?.value.trim();
  const topic=normalizeSpacing($('scriptTopic')?.value || '뒤늦게 깨달은 내 편');
  const req=normalizeSpacing($('scriptRequest')?.value || '감성적이고 따뜻하게');
  const seconds=getTargetSeconds();
  if(!topic){ alert('주제를 먼저 입력하세요.'); return; }
  log('대본 생성 중...');
  resetProjectContent();
  if(!key){
    $('generatedScript').value=stripScriptSectionLabels(cleanScriptSymbols(fallbackScript(topic, seconds)));
    syncTtsTextFromScript($('generatedScript').value);
    log('API 키가 없어 샘플 대본으로 생성했습니다. 음성용 텍스트에도 자동 입력했습니다.');
    return;
  }
  try{
    const prompt=`너는 한국 유튜브 쇼츠 대본 작가다. 업로드 영상 기준은 ${state.analyzedStyle.type}, 길이 ${seconds}초, 장면 ${state.analyzedStyle.scenes}개 정도다. 새 주제는 ${topic}. 추가 방향은 ${req}. 결과에는 후킹 문제제기 공감 전개 해결 마무리 같은 구조명이나 제목을 절대 쓰지 마라. 시간표기 번호 목록 설명 마크다운도 절대 쓰지 마라. 실제 영상에서 읽을 나레이션 문장만 줄바꿈으로 작성해라. 문장은 너무 짧게 끊지 말고 한 줄에 18자에서 30자 정도로 자연스럽게 작성해라. 저작권 문제 없게 원문을 베끼지 말고 새 대본으로 작성한다. 별표 느낌표 쉼표 따옴표 마침표 괄호 대괄호 콜론 같은 특수기호를 쓰지 마라.`;
    const res=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'user',content:prompt}],temperature:.8})});
    if(!res.ok) throw new Error(await res.text());
    const data=await res.json();
    $('generatedScript').value=stripScriptSectionLabels(cleanScriptSymbols(data.choices?.[0]?.message?.content || fallbackScript(topic, seconds)));
    syncTtsTextFromScript($('generatedScript').value);
    log('대본 생성 완료. 음성용 텍스트에도 자동 입력했습니다.');
  }catch(err){
    $('generatedScript').value=stripScriptSectionLabels(cleanScriptSymbols(fallbackScript(topic, seconds)));
    syncTtsTextFromScript($('generatedScript').value);
    log('대본 생성 실패: '+err.message+'\n샘플 대본으로 대체하고 음성용 텍스트에도 넣었습니다.');
  }
}
function applyGeneratedScriptToCaptions(){
  const text=stripScriptSectionLabels(cleanScriptSymbols($('generatedScript')?.value || ''));
  if(!text.trim()){ alert('생성된 대본이 없습니다.'); return; }
  $('generatedScript').value = text;
  syncTtsTextFromScript(text);
  const seconds=getTargetSeconds();
  const cleaned=text.split(/\n+/).map(cleanCaptionText).map(normalizeSpacing).filter(Boolean);
  const parts=[];
  cleaned.forEach(line=>chunkTextForShortCaption(line).forEach(x=>{ const y=cleanCaptionText(x); if(y) parts.push(y); }));
  const finalParts = parts.slice(0, Math.max(6, Math.ceil(seconds/2)));
  const count=finalParts.length || 1;
  state.captions=[];
  state.scenes=[];
  state.images=[];
  state.audioDuration=seconds;
  state.captions=finalParts.map((txt,i)=>({id:uid(),start:seconds*i/count,end:seconds*(i+1)/count,text:splitLongText(txt)}));
  syncFix(false); buildScenes(); renderEditor(); drawFrame(0); updateSeekUI();
  log(`기존 샘플을 지우고 새 대본을 ${count}개 자막칸으로 적용했습니다.`);
}
function copyGeneratedScript(){
  const t=$('generatedScript')?.value || '';
  navigator.clipboard?.writeText(t);
  syncTtsTextFromScript(t);
  log('대본을 복사하고 음성용 텍스트에도 넣었습니다.');
}



function toggleApiHelp(show=true){
  const panel = $('apiHelpPanel');
  if(panel) panel.style.display = show ? 'block' : 'none';
}
function openApiKeyPage(){
  window.open('https://platform.openai.com/api-keys', '_blank', 'noopener,noreferrer');
}
function pickBrowserVoice(preset){
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  const ko = voices.filter(v => (v.lang||'').toLowerCase().startsWith('ko'));
  const all = ko.length ? ko : voices;
  if(!all.length) return null;
  const p = String(preset || '').toLowerCase();
  const nameOf = v => `${v.name || ''} ${v.voiceURI || ''}`.toLowerCase();
  let v = null;
  if(p.includes('male')){
    v = all.find(x=>/male|man|남성|injoon|hoon|hyun|jun|microsoft injoon|google 한국어/i.test(nameOf(x)));
  }else if(p.includes('female')){
    v = all.find(x=>/female|woman|여성|yuna|sora|sunhi|microsoft sunhi|google 한국어/i.test(nameOf(x)));
  }
  return v || all[0];
}
function updateVoiceStatus(voice, preset){
  const el = $('voiceStatus');
  if(!el) return;
  const name = voice ? voice.name : '브라우저 기본 음성';
  if(String(preset).includes('male')) el.textContent = `현재 음성: ${name} / 남성 낮은 톤으로 보정`;
  else if(String(preset).includes('female')) el.textContent = `현재 음성: ${name} / 여성 부드러운 톤`;
  else el.textContent = `현재 음성: ${name}`;
}
function speakText(text){
  if(!('speechSynthesis' in window)){
    alert('이 브라우저는 무료 음성 샘플을 지원하지 않습니다. 크롬이나 엣지에서 테스트하세요.');
    return;
  }
  const clean = cleanCaptionText(text || '').slice(0, 700) || '무료 음성 샘플입니다 대본을 입력하면 이런 식으로 읽어줍니다';
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'ko-KR';
  const preset = $('freeVoicePreset')?.value || 'female-soft';
  const voice = pickBrowserVoice(preset);
  u.voice = voice;
  if(preset === 'fast-info'){ u.rate = 1.18; u.pitch = 1.0; }
  else if(preset === 'slow-emotion'){ u.rate = 0.78; u.pitch = 0.85; }
  else if(preset === 'male-calm'){ u.rate = 0.88; u.pitch = 0.48; }
  else { u.rate = 0.95; u.pitch = 1.18; }
  updateVoiceStatus(voice, preset);
  speechSynthesis.speak(u);
  log('무료 음성 샘플 재생 중입니다. 남성 음성이 없으면 브라우저 기본 음성을 낮은 톤으로 보정합니다. 영상에 음성을 넣으려면 음성 파일을 선택하세요.');
}
function voiceSamplePreview(){
  const topic = $('scriptTopic')?.value || '뒤늦게 깨달은 내 편';
  speakText(`${topic} 가장 늦게 깨닫는 것이 인생에서 가장 아플 때가 있습니다`);
}
function readGeneratedScript(){
  const text = $('generatedScript')?.value || $('scriptTopic')?.value || '';
  speakText(text);
}
if(window.speechSynthesis){ speechSynthesis.onvoiceschanged = ()=>speechSynthesis.getVoices(); }

function updateAudioWorkStatus(file, duration){
  const badge = $('audioQuickBadge');
  const info = $('audioAttachInfo');
  const dur = duration || state.audioDuration || 0;
  const expected = dur ? Math.max(3, Math.ceil(dur / Math.max(2, getSplitMaxSeconds ? getSplitMaxSeconds() : 4))) : 0;
  if(file){
    if(badge){ badge.textContent = '첨부완료'; badge.classList.add('ready'); }
    if(info){
      info.innerHTML = `음성 첨부됨<br>파일명: <b>${file.name}</b><br>길이: <b>${formatTime(dur)}</b><br>예상 자막: <b>${expected}개 내외</b>`;
    }
  }else{
    if(badge){ badge.textContent = '대기중'; badge.classList.remove('ready'); }
    if(info){ info.textContent = '음성 파일을 선택하면 길이와 예상 자막 수가 바로 표시됩니다.'; }
  }
}


if($('btnAnalyzeStyle')) $('btnAnalyzeStyle').onclick=analyzeReferenceStyle;
if($('btnGenerateScript')) $('btnGenerateScript').onclick=generateScriptFromStyle;
if($('btnApplyScriptToCaptions')) $('btnApplyScriptToCaptions').onclick=applyGeneratedScriptToCaptions;
if($('btnCopyScript')) $('btnCopyScript').onclick=copyGeneratedScript;
if($('btnCopyTts')) $('btnCopyTts').onclick=copyTtsText;
if($('btnOpenOndoku')) $('btnOpenOndoku').onclick=openOndoku;
if($('btnCopyOpenOndoku')) $('btnCopyOpenOndoku').onclick=copyAndOpenOndoku;
if($('btnApiHelp')) $('btnApiHelp').onclick=()=>toggleApiHelp(true);
if($('btnCloseApiHelp')) $('btnCloseApiHelp').onclick=()=>toggleApiHelp(false);
if($('btnOpenApiPage')) $('btnOpenApiPage').onclick=openApiKeyPage;
if($('btnVoicePreview')) $('btnVoicePreview').onclick=voiceSamplePreview;
if($('btnReadScript')) $('btnReadScript').onclick=readGeneratedScript;
if($('videoRatio')) $('videoRatio').onchange=()=>{ applyVideoRatio(); drawFrame(timelineTime()); log($('videoRatio').value==='horizontal'?'가로 16:9로 설정했습니다.':'세로 9:16으로 설정했습니다.'); };
if($('referenceVideoFile')) $('referenceVideoFile').onchange=e=>{ const f=e.target.files?.[0]; if(f) updateReferenceVideoUI(f); };
if($('renderVideoFile')) $('renderVideoFile').onchange=e=>{ const f=e.target.files?.[0]; if(f) updateReferenceVideoUI(f); };
if($('btnUseVideoLength')) $('btnUseVideoLength').onclick=useUploadedVideoLength;
if($('freeVoicePreset')) $('freeVoicePreset').onchange=()=>{ const preset=$('freeVoicePreset').value; const voice=pickBrowserVoice(preset); updateVoiceStatus(voice,preset); };


$('btnSample').onclick=sampleCaptions;
$('btnTranscribe').onclick=transcribeAudio;
$('btnBuildScenes').onclick=()=>{buildScenes();renderEditor();drawFrame(timelineTime());};
if($('btnSplitShort')) $('btnSplitShort').onclick=splitAllCaptionsShort;
$('bulkImageFiles').onchange=loadBulkImages;
$('btnAiAll').onclick=generateAllImages;
['thumbOverlayEnable','thumbMainTitle','thumbSubTitle','thumbFont','thumbStyle','thumbMainSize','thumbSubSize','thumbMainY','thumbSubY','thumbTextTop','thumbTextX','thumbSubGap','thumbMainColor','thumbSubColor','thumbStrokeColor'].forEach(id=>{
  const el=$(id);
  if(el){ el.addEventListener('input', ()=>drawFrame(timelineTime())); el.addEventListener('change', ()=>drawFrame(timelineTime())); }
});
if($('btnThumbnail')) $('btnThumbnail').onclick=makeThumbnail;
if($('btnMakeThumb')) $('btnMakeThumb').onclick=makeThumbnail;
$('btnSyncFix').onclick=()=>{ if(!fitCaptionsToDuration(getTimelineDuration(), true)) syncFix(true); };
if($('btnSyncFixEditor')) $('btnSyncFixEditor').onclick=()=>{ if(!fitCaptionsToDuration(getTimelineDuration(), true)) syncFix(true); };
$('btnPreview').onclick=preview;
$('btnStopPreview').onclick=stopPreview;
setRenderButton('ready');
if($('downloadLink')) $('downloadLink').onclick=downloadLastVideo;
$('btnAutoMode').onclick=autoMode;
$('btnSaveProject').onclick=saveProject;
$('btnLoadProject').onclick=()=>$('projectFile').click();
$('projectFile').onchange=loadProject;
$('speedPreset').onchange=()=>{ $('speedInput').value=(+$('speedPreset').value).toFixed(2); if($('audio')) $('audio').playbackRate=speed(); };
$('speedInput').onchange=()=>{ if($('audio')) $('audio').playbackRate=speed(); };
$('fontSize').oninput=()=>{ $('fontSizeValue').textContent=$('fontSize').value; drawFrame(timelineTime()); };
$('btnAddCaption').onclick=()=>{ const last=state.captions[state.captions.length-1]; const st=last?last.end:0; state.captions.push({id:uid(),start:st,end:st+4,text:'새 자막\n직접 수정'}); buildScenes(); renderEditor(); drawFrame(timelineTime()); };
$('btnClear').onclick=()=>{ if(confirm('전체 초기화할까요?')){state.captions=[];state.scenes=[];state.images=[];state.referenceVideoFile=null;state.referenceVideoDuration=0;state.lastVideoUrl=null;state.lastVideoBlob=null;state.lastVideoFileName=''; if($('generatedScript')) $('generatedScript').value=''; if($('ttsText')) $('ttsText').value=''; setRenderButton('ready'); setDownloadStatus('대기중', 'idle'); if($('referenceVideoFile')) $('referenceVideoFile').value=''; if($('renderVideoFile')) $('renderVideoFile').value=''; if($('videoAttachBox')) $('videoAttachBox').style.display='none'; if($('referenceVideoPreview')){ $('referenceVideoPreview').pause(); $('referenceVideoPreview').removeAttribute('src'); $('referenceVideoPreview').load(); } updateRenderVideoAttachStatus(null,0); renderEditor();drawFrame(0);updateSeekUI(); log('새 프로젝트 상태입니다. 샘플 없이 시작합니다.');} };
$('audioFile').onchange=async e=>{
  const f=e.target.files[0];
  if(f){
    const url=URL.createObjectURL(f);
    const audio=$('audio');
    audio.src=url;
    audio.load();
    updateAudioWorkStatus(f, 0);
    audio.onloadedmetadata=()=>{
      state.audioDuration=audio.duration||state.audioDuration||60;
      updateAudioWorkStatus(f, state.audioDuration);
      if(state.captions.length) fitCaptionsToDuration(state.audioDuration, true);
      else { updateSeekUI(); drawFrame(timelineTime()); }
      log(`음성 파일 적용 완료: ${f.name} / ${formatTime(state.audioDuration)} / 바로 AI 자막 생성을 누르세요.`);
    };
  }
};
$('logoFile').onchange=async e=>{ const f=e.target.files[0]; if(f) state.logo=await fileToDataURL(f); };


if($('btnBack5')) $('btnBack5').onclick=()=>setAudioTime(currentTime()-5);
if($('btnForward5')) $('btnForward5').onclick=()=>setAudioTime(currentTime()+5);
if($('previewSeek')){
  $('previewSeek').addEventListener('input', e=>{ state.seeking=true; setAudioTime(parseFloat(e.target.value||'0')); });
  $('previewSeek').addEventListener('change', e=>{ state.seeking=false; setAudioTime(parseFloat(e.target.value||'0')); });
}
if($('btnSyncMinus')) $('btnSyncMinus').onclick=()=>changeSyncOffset(-0.3);
if($('btnSyncPlus')) $('btnSyncPlus').onclick=()=>changeSyncOffset(0.3);
if($('btnSyncReset')) $('btnSyncReset').onclick=()=>{ state.syncOffset=0; $('syncOffset').value='0.0'; drawFrame(timelineTime()); updateSeekUI(); log('자막 싱크 보정값을 0으로 초기화했습니다.'); };
if($('syncOffset')) $('syncOffset').onchange=()=>{ state.syncOffset=parseFloat($('syncOffset').value||'0')||0; drawFrame(timelineTime()); updateSeekUI(); };
$('audio').addEventListener('timeupdate', ()=>{ drawFrame(timelineTime()); updateSeekUI(); });
$('audio').addEventListener('seeked', ()=>{ drawFrame(timelineTime()); updateSeekUI(); });
$('audio').addEventListener('play', ()=>{ if(!state.rendering) preview(); });
$('audio').addEventListener('pause', ()=>{ cancelAnimationFrame(state.previewTimer); drawFrame(timelineTime()); updateSeekUI(); });

if($('freeVoicePreset')) updateVoiceStatus(pickBrowserVoice($('freeVoicePreset').value), $('freeVoicePreset').value);
updateRenderVideoAttachStatus(null,0);
updateAudioWorkStatus(null,0);
renderEditor();
drawFrame(0);
updateSeekUI();
log('새 프로젝트 상태입니다. 주제를 입력하고 대본 생성을 누르세요.');


// v3.1 상단 바로가기 메뉴
function setupQuickNav(){
  const buttons = [...document.querySelectorAll('.quickNav [data-jump]')];
  if(!buttons.length) return;
  const targets = buttons
    .map(btn => ({btn, el: document.getElementById(btn.dataset.jump)}))
    .filter(x => x.el);

  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const el = document.getElementById(btn.dataset.jump);
      if(!el) return;
      el.scrollIntoView({behavior:'smooth', block:'start'});
      buttons.forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  const setActive = ()=>{
    let current = targets[0];
    const line = 170;
    targets.forEach(item=>{
      const top = item.el.getBoundingClientRect().top;
      if(top <= line) current = item;
    });
    buttons.forEach(b=>b.classList.remove('active'));
    if(current) current.btn.classList.add('active');
  };
  window.addEventListener('scroll', setActive, {passive:true});
  setActive();
}
setupQuickNav();
