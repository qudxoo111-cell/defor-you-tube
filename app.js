const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const state = {
  captions: [],
  scenes: [],
  images: [],
  audioDuration: 60,
  logo: null,
  previewTimer: null,
  previewStart: 0,
  mediaRecorder: null,
  chunks: []
};
const motions = ['zoom','panup','pandown'];

function log(msg){ $('log').textContent = msg; }
function uid(){ return Math.random().toString(36).slice(2,9); }
function speed(){ return Math.max(0.5, Math.min(3, parseFloat($('speedInput').value || '1'))); }
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

function splitLongText(text){
  const clean = normalizeSpacing(text);
  if(clean.length <= 18) return clean;
  const targets = [' 하지만 ',' 그리고 ',' 그래서 ',' 이제 ',' 오늘 ',' 당신은 ',' 우리는 ',' 언젠가 ',' 지금 '];
  for(const t of targets){
    const i = clean.indexOf(t, Math.floor(clean.length*0.35));
    if(i>0 && i<clean.length-4) return clean.slice(0,i).trim()+'\n'+clean.slice(i).trim();
  }
  const mid = Math.floor(clean.length/2);
  let cut = clean.lastIndexOf(' ', mid);
  if(cut < 8) cut = clean.indexOf(' ', mid);
  if(cut < 8) cut = mid;
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

function buildScenes(){
  const n = imageGroupSize();
  const old = state.scenes || [];
  const scenes = [];
  for(let i=0;i<state.captions.length;i+=n){
    const caps = state.captions.slice(i,i+n);
    const oldScene = old[Math.floor(i/n)] || {};
    scenes.push({
      id: oldScene.id || uid(),
      title: `장면 ${scenes.length+1}`,
      captionIds: caps.map(c=>c.id),
      image: oldScene.image || state.images[scenes.length] || null,
      motion: oldScene.motion || motions[scenes.length % motions.length],
      prompt: oldScene.prompt || caps.map(c=>c.text.replace(/\n/g,' ')).join(' ')
    });
  }
  state.scenes = scenes;
}

function renderEditor(){
  const box = $('sceneEditor'); box.innerHTML='';
  state.scenes.forEach((scene,idx)=>{
    const card = document.createElement('div'); card.className='sceneCard'; card.draggable=true;
    card.addEventListener('dragstart', e=>{ e.dataTransfer.setData('text/plain', idx); });
    card.addEventListener('dragover', e=>e.preventDefault());
    card.addEventListener('drop', e=>{ e.preventDefault(); const from=+e.dataTransfer.getData('text/plain'); const [s]=state.scenes.splice(from,1); state.scenes.splice(idx,0,s); renderEditor(); drawFrame(currentTime()); });
    const thumb = document.createElement('div'); thumb.className='sceneThumb';
    if(scene.image){ const img=document.createElement('img'); img.src=scene.image; thumb.appendChild(img); } else thumb.textContent='이미지 없음\n업로드/AI 생성';
    const info = document.createElement('div'); info.className='sceneInfo';
    info.innerHTML = `<div class="sceneTop"><strong>${scene.title}</strong><span class="badge">${scene.motion}</span></div>`;
    const mini = document.createElement('div'); mini.className='miniGrid';
    const upload = document.createElement('input'); upload.type='file'; upload.accept='image/*'; upload.title='이미지 넣기';
    upload.addEventListener('change', async e=>{ const f=e.target.files[0]; if(f){ scene.image=await fileToDataURL(f); renderEditor(); drawFrame(currentTime()); }});
    const aiBtn = document.createElement('button'); aiBtn.textContent='AI 생성'; aiBtn.onclick=()=>generateSceneImage(scene, idx);
    const motionSel = document.createElement('select');
    ['zoom','panup','pandown','zoomout','left','right','rotate','none'].forEach(m=>{ const o=document.createElement('option'); o.value=m; o.textContent={zoom:'확대',panup:'위로',pandown:'아래로',zoomout:'축소',left:'좌측',right:'우측',rotate:'회전',none:'고정'}[m]; if(scene.motion===m)o.selected=true; motionSel.appendChild(o); });
    motionSel.onchange=()=>{ scene.motion=motionSel.value; renderEditor(); drawFrame(currentTime()); };
    mini.append(upload, aiBtn, motionSel);
    const prompt = document.createElement('textarea'); prompt.placeholder='이 장면 이미지 프롬프트'; prompt.value=scene.prompt||''; prompt.oninput=()=>scene.prompt=prompt.value;
    const rows = document.createElement('div'); rows.className='captionRows';
    scene.captionIds.forEach(cid=>{
      const cap = state.captions.find(c=>c.id===cid); if(!cap) return;
      const row = document.createElement('div'); row.className='captionRow';
      const st = document.createElement('input'); st.value=cap.start.toFixed(1); st.onchange=()=>{cap.start=parseTime(st.value); drawFrame(currentTime());};
      const en = document.createElement('input'); en.value=cap.end.toFixed(1); en.onchange=()=>{cap.end=parseTime(en.value); drawFrame(currentTime());};
      const tx = document.createElement('textarea'); tx.value=cap.text; tx.placeholder='Enter로 원하는 줄수 수정'; tx.oninput=()=>{cap.text=tx.value; drawFrame(currentTime());};
      const del = document.createElement('button'); del.textContent='×'; del.className='danger'; del.onclick=()=>{ state.captions=state.captions.filter(x=>x.id!==cap.id); buildScenes(); renderEditor(); drawFrame(currentTime()); };
      row.append(st,en,tx,del); rows.appendChild(row);
    });
    info.append(mini,prompt,rows); card.append(thumb,info); box.appendChild(card);
  });
}

function fileToDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }

async function loadBulkImages(e){
  const files=[...e.target.files];
  state.images=[];
  for(const f of files) state.images.push(await fileToDataURL(f));
  state.scenes.forEach((s,i)=>{ if(state.images[i]) s.image=state.images[i]; });
  renderEditor(); drawFrame(currentTime()); log(`${files.length}장 이미지를 불러왔습니다.`);
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
function syncFix(){
  state.captions.sort((a,b)=>a.start-b.start);
  const dur = state.audioDuration || Math.max(...state.captions.map(c=>c.end), 60);
  state.captions.forEach((c,i)=>{
    c.text = c.text.split('\n').map(normalizeSpacing).join('\n');
    if(i>0 && c.start < state.captions[i-1].end) c.start = state.captions[i-1].end;
    if(c.end <= c.start) c.end = c.start + 2.5;
    if(i < state.captions.length-1 && c.end > state.captions[i+1].start) c.end = state.captions[i+1].start;
  });
  if(state.captions.length) state.captions[state.captions.length-1].end = dur;
  buildScenes(); renderEditor(); drawFrame(currentTime()); log('싱크를 보정했습니다.');
}

async function generateSceneImage(scene, idx){
  const key=$('apiKey').value.trim();
  const prompt = imagePrompt(scene);
  if(!key){ scene.image = placeholderImage(prompt, idx); renderEditor(); drawFrame(currentTime()); log('API 키가 없어 임시 이미지가 들어갔습니다.'); return; }
  log(`${scene.title} AI 이미지 생성 중...`);
  try{
    const res = await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:'gpt-image-1',prompt,size:'1024x1536'})});
    if(!res.ok) throw new Error(await res.text());
    const data=await res.json(); const b64=data.data?.[0]?.b64_json;
    if(!b64) throw new Error('이미지 데이터 없음');
    scene.image='data:image/png;base64,'+b64; renderEditor(); drawFrame(currentTime()); log(`${scene.title} 이미지 생성 완료`);
  }catch(err){ scene.image=placeholderImage(prompt, idx); renderEditor(); drawFrame(currentTime()); log('AI 이미지 실패: '+err.message+'\n임시 이미지로 대체했습니다.'); }
}
function imagePrompt(scene){
  const style=$('imageStyle').value;
  const styleText={realistic:'ultra realistic Korean emotional cinematic photo',ghibli:'warm hand-drawn Japanese animation inspired background, soft colors, cinematic, no copyrighted characters',pixar:'high quality 3D animation style, warm light, expressive',webtoon:'Korean webtoon style, clean line art, cinematic'}[style];
  return `${styleText}, vertical 9:16 shorts image, ${scene.prompt || scene.captionIds.map(id=>state.captions.find(c=>c.id===id)?.text||'').join(' ')}`;
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

function makeThumbnail(){
  if(!state.scenes.length) buildScenes();
  const title=$('thumbTitle').value||'오늘도 수고했어요'; const top=$('thumbTop').value||'당신에게 전하는 말'; const bottom=$('thumbBottom').value||'끝까지 들어보세요';
  const c=document.createElement('canvas'); c.width=720; c.height=1280; const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,720,1280); g.addColorStop(0,'#f5ead8'); g.addColorStop(1,'#2b2b35'); x.fillStyle=g; x.fillRect(0,0,720,1280);
  x.fillStyle='rgba(0,0,0,.35)'; x.fillRect(40,120,640,1040);
  x.textAlign='center'; x.fillStyle='#ffd166'; x.font='bold 42px sans-serif'; wrapDraw(x,top,360,220,600,52);
  x.fillStyle='#fff'; x.font='bold 74px sans-serif'; wrapDraw(x,title,360,500,620,86);
  x.fillStyle='#67e8a5'; x.font='bold 46px sans-serif'; wrapDraw(x,bottom,360,920,600,58);
  const img=c.toDataURL('image/png'); if(!state.scenes[0]) state.scenes.push({id:uid(),title:'장면 1',captionIds:[],image:null,motion:'zoom',prompt:''}); state.scenes[0].image=img; renderEditor(); drawFrame(0); log('첫 장면 썸네일을 만들었습니다.');
}

function currentTime(){ return $('audio').currentTime || 0; }
function sceneAt(t){ return state.scenes.find(s=>{ const caps=s.captionIds.map(id=>state.captions.find(c=>c.id===id)).filter(Boolean); if(!caps.length) return false; return t>=caps[0].start && t<=caps[caps.length-1].end; }) || state.scenes[0]; }
function captionAt(t){ return state.captions.find(c=>t>=c.start && t<c.end) || state.captions[state.captions.length-1]; }

function drawFrame(t){
  ctx.clearRect(0,0,1080,1920); ctx.fillStyle='#000'; ctx.fillRect(0,0,1080,1920);
  const sc=sceneAt(t); const cap=captionAt(t); const sp=speed();
  if(sc?.image){ const img=new Image(); img.onload=()=>{ drawImageMotion(img, sc.motion, t); drawOverlay(cap, sp); }; img.src=sc.image; } else { ctx.fillStyle='#111827'; ctx.fillRect(0,0,1080,1920); drawOverlay(cap, sp); }
}
function drawImageMotion(img,motion,t){
  const w=1080,h=1920; let scale=1.08,dx=0,dy=0,rot=0; const p=(t%6)/6;
  if(motion==='zoom') scale=1.03+p*.12;
  if(motion==='zoomout') scale=1.18-p*.12;
  if(motion==='panup') { scale=1.14; dy=-p*110; }
  if(motion==='pandown') { scale=1.14; dy=p*110-110; }
  if(motion==='left') { scale=1.12; dx=-p*90; }
  if(motion==='right') { scale=1.12; dx=p*90-90; }
  if(motion==='rotate') { scale=1.1; rot=(p-.5)*0.035; }
  if(motion==='none') scale=1;
  const ir=img.width/img.height, cr=w/h; let dw,dh; if(ir>cr){ dh=h*scale; dw=dh*ir; } else { dw=w*scale; dh=dw/ir; }
  ctx.save(); ctx.translate(w/2+dx,h/2+dy); ctx.rotate(rot); ctx.drawImage(img,-dw/2,-dh/2,dw,dh); ctx.restore();
}
function drawOverlay(cap, sp){
  const fs=parseInt($('fontSize').value||58); const pos=$('captionPos').value; const text=cap?.text||'';
  ctx.fillStyle='rgba(0,0,0,.32)'; ctx.fillRect(0,0,1080,1920);
  ctx.font=`900 ${fs}px system-ui, sans-serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
  const y = pos==='top'?350:pos==='center'?960:1480;
  const lines=String(text).split('\n'); const lineH=fs*1.25; const startY=y-(lines.length-1)*lineH/2;
  lines.forEach((line,i)=>{ ctx.lineWidth=Math.max(6,fs*.16); ctx.strokeStyle='black'; ctx.fillStyle='white'; ctx.strokeText(line,540,startY+i*lineH); ctx.fillText(line,540,startY+i*lineH); });
  ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(36,1780,1008,48); ctx.fillStyle='#67e8a5'; const total=(state.audioDuration||60)/sp; ctx.fillRect(36,1780,1008*Math.min(1,currentTime()/(state.audioDuration||60)),48);
}
function wrapDraw(x,text,cx,y,maxW,lineH){
  const words=String(text).split(' '); let line='', yy=y;
  words.forEach(word=>{ const test=line?line+' '+word:word; if(x.measureText(test).width>maxW && line){ x.fillText(line,cx,yy); yy+=lineH; line=word; } else line=test; });
  if(line) x.fillText(line,cx,yy);
}

function preview(){
  const audio=$('audio'); if(audio.src) { audio.playbackRate=speed(); audio.play(); }
  cancelAnimationFrame(state.previewTimer);
  const loop=()=>{ drawFrame(currentTime()); state.previewTimer=requestAnimationFrame(loop); };
  loop();
}
function stopPreview(){ const audio=$('audio'); audio.pause(); cancelAnimationFrame(state.previewTimer); }
async function renderVideo(){
  alert('브라우저 테스트 버전은 미리보기 중심입니다. 영상 생성은 브라우저 성능에 따라 느릴 수 있습니다. 안정적인 MP4/H264 출력은 서버형 v2에서 붙이는 게 좋습니다.');
}

async function autoMode(){
  log('올자동 모드 시작');
  if(!state.captions.length) await transcribeAudio();
  syncFix(); buildScenes(); await generateAllImages(); makeThumbnail(); renderEditor(); drawFrame(0); log('올자동 모드 완료: 자막, 장면, 이미지, 첫 썸네일까지 구성했습니다.');
}
function saveProject(){
  const data=JSON.stringify({captions:state.captions,scenes:state.scenes,audioDuration:state.audioDuration},null,2); const blob=new Blob([data],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='senial-project.json'; a.click();
}
async function loadProject(e){ const f=e.target.files[0]; if(!f)return; const data=JSON.parse(await f.text()); state.captions=data.captions||[]; state.scenes=data.scenes||[]; state.audioDuration=data.audioDuration||60; renderEditor(); drawFrame(0); }

$('btnSample').onclick=sampleCaptions;
$('btnTranscribe').onclick=transcribeAudio;
$('btnBuildScenes').onclick=()=>{buildScenes();renderEditor();drawFrame(currentTime());};
$('bulkImageFiles').onchange=loadBulkImages;
$('btnAiAll').onclick=generateAllImages;
$('btnThumbnail').onclick=makeThumbnail;
$('btnSyncFix').onclick=syncFix;
$('btnPreview').onclick=preview;
$('btnStopPreview').onclick=stopPreview;
$('btnRender').onclick=renderVideo;
$('btnAutoMode').onclick=autoMode;
$('btnSaveProject').onclick=saveProject;
$('btnLoadProject').onclick=()=>$('projectFile').click();
$('projectFile').onchange=loadProject;
$('speedPreset').onchange=()=>{ $('speedInput').value=(+$('speedPreset').value).toFixed(2); if($('audio')) $('audio').playbackRate=speed(); };
$('speedInput').onchange=()=>{ if($('audio')) $('audio').playbackRate=speed(); };
$('fontSize').oninput=()=>{ $('fontSizeValue').textContent=$('fontSize').value; drawFrame(currentTime()); };
$('btnAddCaption').onclick=()=>{ const last=state.captions[state.captions.length-1]; const st=last?last.end:0; state.captions.push({id:uid(),start:st,end:st+4,text:'새 자막\n직접 수정'}); buildScenes(); renderEditor(); drawFrame(currentTime()); };
$('btnClear').onclick=()=>{ if(confirm('전체 초기화할까요?')){state.captions=[];state.scenes=[];renderEditor();drawFrame(0);} };
$('audioFile').onchange=async e=>{ const f=e.target.files[0]; if(f){ $('audio').src=URL.createObjectURL(f); $('audio').onloadedmetadata=()=>{state.audioDuration=$('audio').duration||60; log(`음성 로드 완료: ${formatTime(state.audioDuration)}`)}; }};
$('logoFile').onchange=async e=>{ const f=e.target.files[0]; if(f) state.logo=await fileToDataURL(f); };

sampleCaptions();
