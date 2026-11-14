/* Листик 2.0: локальные рукописные заметки, безопасный режим чтения,
   добровольная синхронизация через Google Drive appDataFolder. */
'use strict';
const $ = id => document.getElementById(id);
const W = 1000, H = 1400;
const CLOUD_NAME = 'listik-notebooks-v2.json';
const CLOUD_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const COLORS = ['#303044','#6b5cc3','#3279b7','#d36b79','#459c83','#d49a42','#222222'];
const paper = $('paper'), context = paper.getContext('2d'), wrap = $('pageWrap');
let notes = [], selectedId = null, pageIndex = 0, tool = 'pen', brushColor = COLORS[0], brushWidth = 4;
let penOnly = true, readOnly = false, activePointer = null, activeStroke = null, swipeStart = null;
let history = [], future = [], saveTimer = null, syncTimer = null, initialized = false;
let token = '', tokenExpiry = 0, tokenClient = null, cloudFileId = null, syncing = false, rerunSync = false;
let syncEditCounter = 0, editCounter = 0, zoomIndex = 0;
const widths = [{label:'100%',value:'min(100%, 780px)'},{label:'150%',value:'990px'},{label:'200%',value:'1250px'}];
const clone = value => JSON.parse(JSON.stringify(value));
const id = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const current = () => notes.find(note => note.id === selectedId && !note.deleted);
const makeNote = (title='Новая тетрадь') => ({id:id(), title, pages:[[]], paper:'lined', updatedAt:Date.now(), deleted:false});
const stamp = () => Date.now();
const validPaper = x => ['lined','grid','dots','blank'].includes(x) ? x : 'lined';
function normalize(raw){
  if (!Array.isArray(raw)) throw new Error('Файл не содержит список тетрадей');
  return raw.filter(n => n && typeof n.id === 'string' && Array.isArray(n.pages)).map(n => ({
    id:n.id, title:String(n.title||'Без названия').slice(0,300), paper:validPaper(n.paper),
    updatedAt:Number(n.updatedAt)||0, deleted:!!n.deleted,
    pages:n.pages.map(p => Array.isArray(p) ? p.filter(s => s && Array.isArray(s.points)).map(s => ({
      tool:String(s.tool||'pen'), color:String(s.color||'#303044'), width:Number(s.width)||4,
      points:s.points.filter(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))
        .map(q => [Math.max(0,Math.min(W,q[0])),Math.max(0,Math.min(H,q[1])),q.length>2 ? Math.max(0,Math.min(1,Number(q[2])||0)) : undefined]),
      value: s.tool === 'text' ? String(s.value||'').slice(0,3000) : undefined
    })) : [])
  }));
}
function openDB(){ return new Promise((resolve,reject) => {
  const req=indexedDB.open('list-notes-db',1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('kv'))req.result.createObjectStore('kv')};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
}); }
async function dbGet(){const db=await openDB();return new Promise((resolve,reject)=>{
  const tx=db.transaction('kv','readonly');const r=tx.objectStore('kv').get('notes');
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);tx.oncomplete=()=>db.close();
});}
async function dbSet(data){const db=await openDB();return new Promise((resolve,reject)=>{
  const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(data,'notes');
  tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
});}
function status(message){$('status').textContent=message;}
function persist(){
  if(!initialized) return;
  editCounter++;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>dbSet(clone(notes)).then(()=>{
    status(authValid() ? '✓ Сохранено на устройстве · ожидает синхронизации' : '✓ Сохранено на устройстве');
  }).catch(e=>status('⚠ Не удалось сохранить: '+e.message)),150);
  if(authValid()) queueSync();
}
async function flush(){clearTimeout(saveTimer);await dbSet(clone(notes));}
function changed(){const n=current();if(n)n.updatedAt=stamp();persist();renderList();}
function selectNote(noteId){selectedId=noteId;pageIndex=0;history=[];future=[];render();toggleSide(false);}
function renderList(){
  const root=$('notesList'),query=$('search').value.trim().toLowerCase();root.textContent='';
  const visible=notes.filter(n=>!n.deleted);$('notesCount').textContent=String(visible.length);
  const list=visible.filter(n=>n.title.toLowerCase().includes(query)).sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!list.length){const msg=document.createElement('p');msg.className='empty-list';msg.textContent=query?'Ничего не найдено':'Здесь пока нет тетрадей';root.append(msg);}
  for(const n of list){
    const btn=document.createElement('button');btn.className='note-row'+(n.id===selectedId?' current':'');
    const icon=document.createElement('span');icon.className='note-icon';icon.textContent='✎';
    const desc=document.createElement('span');desc.style.minWidth='0';
    const title=document.createElement('span');title.className='note-name';title.textContent=n.title;
    const sub=document.createElement('span');sub.className='note-info';sub.textContent=`${n.pages.length} стр. · ${new Date(n.updatedAt).toLocaleDateString('ru-RU')}`;
    desc.append(title,sub);btn.append(icon,desc);btn.addEventListener('click',()=>selectNote(n.id));root.append(btn);
  }
}
function applyPaper(){wrap.classList.remove('lined','grid','dots','blank');wrap.classList.add(current()?.paper||'lined');$('paperType').value=current()?.paper||'lined';}
function syncTouchAction(){paper.style.touchAction = (readOnly || penOnly) ? 'pan-y' : 'none';}
function render(){
  let n=current();if(!n){n=notes.find(x=>!x.deleted);if(n){selectedId=n.id;pageIndex=0;}}
  pageIndex=Math.max(0,Math.min(pageIndex,Math.max(0,(n?.pages.length||1)-1)));
  $('title').value=n?.title||'';$('title').disabled=!n||readOnly;
  $('pageNumber').textContent=String(pageIndex+1);$('pageTotal').textContent=String(n?.pages.length||1);
  $('prevPage').disabled=pageIndex===0;$('nextPage').disabled=!n||pageIndex===(n.pages.length-1);
  $('addPage').disabled=!n;$('deletePage').disabled=!n||n.pages.length===1;$('deleteNote').disabled=!n;
  $('undoBtn').disabled=!history.length;$('redoBtn').disabled=!future.length;
  $('pageFootnote').textContent=readOnly?'Листай вправо или влево стилусом или пальцем. Рисование выключено.':'Чернила сохраняются автоматически. Для защиты от случайных линий включи режим чтения.';
  applyPaper();redraw();renderList();syncTouchAction();
}
function drawStroke(c,s){
  if(!s||!s.points?.length)return;
  const pts=s.points,base=s.width||4;c.save();c.lineCap='round';c.lineJoin='round';c.strokeStyle=s.color||'#303044';c.fillStyle=s.color||'#303044';
  if(s.tool==='text'){
    c.globalAlpha=1;c.font=`${Math.max(16,base*10)}px -apple-system, Arial, sans-serif`;
    String(s.value||'').split('\n').forEach((line,i)=>c.fillText(line,pts[0][0],pts[0][1]+i*Math.max(22,base*13),W-pts[0][0]));c.restore();return;
  }
  if(s.tool==='line'||s.tool==='rect'){
    const a=pts[0],b=pts[pts.length-1]||a;c.lineWidth=base;c.beginPath();
    if(s.tool==='line'){c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);}else c.rect(a[0],a[1],b[0]-a[0],b[1]-a[1]);
    c.stroke();c.restore();return;
  }
  c.globalAlpha=s.tool==='marker'?.3:s.tool==='pencil'?.65:1;
  let width=s.tool==='marker'?base*7:s.tool==='pencil'?base*.85:base;
  if(pts.length===1){c.beginPath();c.arc(pts[0][0],pts[0][1],width/2,0,Math.PI*2);c.fill();c.restore();return;}
  if(s.tool==='pen' && pts.some(p=>p.length>2 && p[2]!==undefined)){
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i];const pressure=(a[2]??.5)+(b[2]??.5);
      c.lineWidth=width*(0.65+pressure*.37);c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.stroke();
    }
  }else{
    c.lineWidth=width;c.beginPath();c.moveTo(pts[0][0],pts[0][1]);
    for(let i=1;i<pts.length-1;i++){const a=pts[i],b=pts[i+1];c.quadraticCurveTo(a[0],a[1],(a[0]+b[0])/2,(a[1]+b[1])/2);}
    c.lineTo(pts[pts.length-1][0],pts[pts.length-1][1]);c.stroke();
  }
  c.restore();
}
function redraw(){context.clearRect(0,0,W,H);for(const s of current()?.pages[pageIndex]||[])drawStroke(context,s);if(activeStroke)drawStroke(context,activeStroke);}
function pointFrom(e){const r=paper.getBoundingClientRect();return [Math.max(0,Math.min(W, (e.clientX-r.left)*W/r.width)),Math.max(0,Math.min(H, (e.clientY-r.top)*H/r.height)), e.pointerType==='pen' ? (e.pressure || 0.5) : undefined];}
function segmentDistance(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],sq=dx*dx+dy*dy;if(!sq)return Math.hypot(p[0]-a[0],p[1]-a[1]);const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/sq));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);}
function eraseAt(p){
  const n=current();if(!n)return false;const before=n.pages[pageIndex];
  const remaining=before.filter(s=>{
    const pts=s.points||[],tolerance=20+(s.width||4)*2;
    if(s.tool==='text')return !(Math.abs(p[0]-pts[0][0])<150 && Math.abs(p[1]-pts[0][1])<65);
    if(s.tool==='rect'&&pts.length>1){const a=pts[0],b=pts.at(-1);const corners=[a,[b[0],a[1]],b,[a[0],b[1]],a];return !corners.some((corner,i)=>i&&segmentDistance(p,corners[i-1],corner)<tolerance);}
    return !pts.some((q,i)=>segmentDistance(p,q,pts[Math.min(i+1,pts.length-1)])<tolerance);
  });
  if(remaining.length===before.length)return false;n.pages[pageIndex]=remaining;redraw();return true;
}
function remember(){if(!current())return;history.push(clone(current().pages[pageIndex]));if(history.length>80)history.shift();future=[];}
function changePage(delta){const n=current();if(!n)return;const next=pageIndex+delta;if(next<0||next>=n.pages.length)return;pageIndex=next;activeStroke=null;activePointer=null;history=[];future=[];render();}
function handleReadingDown(e){if(!current())return;swipeStart={pointerId:e.pointerId,x:e.clientX,y:e.clientY};if(e.pointerType==='pen')paper.setPointerCapture(e.pointerId);}
function handleReadingEnd(e){
  if(!readOnly||!swipeStart||swipeStart.pointerId!==e.pointerId)return;
  const dx=e.clientX-swipeStart.x,dy=e.clientY-swipeStart.y;swipeStart=null;
  if(Math.abs(dx)>65&&Math.abs(dx)>Math.abs(dy)*1.25)changePage(dx<0?1:-1);
}
paper.addEventListener('pointerdown',e=>{
  if(readOnly){handleReadingDown(e);return;}
  if(!current()||e.button!==0||(penOnly&&e.pointerType!=='pen')||(e.pointerType==='touch'&&e.width>36))return;
  if(tool==='text'){
    const value=prompt('Введи текст, который нужно разместить на странице:');
    if(!value)return;remember();current().pages[pageIndex].push({tool:'text',color:brushColor,width:brushWidth,points:[pointFrom(e)],value});redraw();changed();render();return;
  }
  if(activePointer!==null)return;
  e.preventDefault();activePointer=e.pointerId;paper.setPointerCapture(e.pointerId);remember();
  const p=pointFrom(e);
  if(tool==='eraser'){activeStroke=null;eraseAt(p);}else activeStroke={tool,color:brushColor,width:brushWidth,points:[p]};
  redraw();
});
paper.addEventListener('pointermove',e=>{
  if(readOnly||activePointer!==e.pointerId)return;e.preventDefault();
  const events=e.getCoalescedEvents?e.getCoalescedEvents():[e];
  for(const sample of events){const p=pointFrom(sample);if(tool==='eraser')eraseAt(p);
    else if(activeStroke){
      const last=activeStroke.points.at(-1);
      if(['line','rect'].includes(tool))activeStroke.points=[activeStroke.points[0],p];
      else if(Math.hypot(last[0]-p[0],last[1]-p[1])>.45)activeStroke.points.push(p);
    }
  }redraw();
});
function stopDrawing(e){
  if(readOnly){handleReadingEnd(e);return;}
  if(activePointer!==e.pointerId)return;
  activePointer=null;
  if(activeStroke){current()?.pages[pageIndex].push(activeStroke);activeStroke=null;}
  redraw();changed();render();
}
paper.addEventListener('pointerup',stopDrawing);
paper.addEventListener('pointercancel',e=>{if(readOnly){swipeStart=null;return;}stopDrawing(e);});
paper.addEventListener('lostpointercapture',e=>{if(!readOnly&&activePointer===e.pointerId)stopDrawing(e);});
function useHistory(source,target){const n=current();if(readOnly||!n||!source.length)return;target.push(clone(n.pages[pageIndex]));n.pages[pageIndex]=source.pop();changed();render();}
$('undoBtn').onclick=()=>useHistory(history,future);$('redoBtn').onclick=()=>useHistory(future,history);
function chooseTool(next){tool=next;document.querySelectorAll('[data-tool]').forEach(btn=>btn.classList.toggle('active',btn.dataset.tool===tool));}
for(const btn of document.querySelectorAll('[data-tool]'))btn.onclick=()=>chooseTool(btn.dataset.tool);
for(const c of COLORS){const btn=document.createElement('button');btn.className='swatch'+(c===brushColor?' selected':'');btn.style.background=c;btn.title='Цвет '+c;btn.setAttribute('aria-label','Цвет '+c);btn.onclick=()=>{brushColor=c;document.querySelectorAll('.swatch').forEach(b=>b.classList.toggle('selected',b===btn));};$('colors').append(btn);}
$('widthSelect').onchange=e=>brushWidth=Number(e.target.value);
$('penOnly').onchange=e=>{penOnly=e.target.checked;syncTouchAction();};
$('paperType').onchange=e=>{if(readOnly||!current())return;current().paper=validPaper(e.target.value);changed();render();};
$('modeBtn').onclick=()=>{
  readOnly=!readOnly;activeStroke=null;activePointer=null;swipeStart=null;
  document.body.classList.toggle('read-mode',readOnly);
  $('modeBtn').classList.toggle('reading',readOnly);$('modeBtn').setAttribute('aria-pressed',String(readOnly));
  $('modeIcon').textContent=readOnly?'✎':'◉';$('modeText').textContent=readOnly?'Редактировать':'Режим чтения';
  $('readerTip').hidden=!readOnly;render();status(readOnly?'◉ Чтение: стилус не изменит заметки':'✎ Редактирование включено');
};
$('newNote').onclick=()=>{if(readOnly){$('modeBtn').click();}const n=makeNote();notes.push(n);persist();selectNote(n.id);};
$('deleteNote').onclick=()=>{const n=current();if(!n||readOnly||!confirm(`Удалить тетрадь «${n.title}» со всеми страницами?`))return;n.deleted=true;n.updatedAt=stamp();persist();selectedId=null;history=[];future=[];render();};
$('title').addEventListener('input',e=>{const n=current();if(!n||readOnly)return;n.title=e.target.value||'Без названия';changed();});
$('prevPage').onclick=()=>changePage(-1);$('nextPage').onclick=()=>changePage(1);
$('addPage').onclick=()=>{const n=current();if(!n||readOnly)return;n.pages.push([]);pageIndex=n.pages.length-1;history=[];future=[];changed();render();};
$('deletePage').onclick=()=>{const n=current();if(!n||readOnly||n.pages.length===1||!confirm('Удалить эту страницу?'))return;n.pages.splice(pageIndex,1);pageIndex=Math.min(pageIndex,n.pages.length-1);history=[];future=[];changed();render();};
$('zoom').onclick=()=>{zoomIndex=(zoomIndex+1)%widths.length;wrap.style.width=widths[zoomIndex].value;$('zoom').textContent=widths[zoomIndex].label;};
function toggleSide(open){$('sidebar').classList.toggle('open',open);$('sideScrim').classList.toggle('visible',open);}
$('openSide').onclick=()=>toggleSide(true);$('closeSide').onclick=()=>toggleSide(false);$('sideScrim').onclick=()=>toggleSide(false);
$('search').oninput=renderList;
function previewCanvas(c,paperKind,strokes){
  c.width=240;c.height=336;const g=c.getContext('2d');g.fillStyle='#fffefa';g.fillRect(0,0,240,336);g.scale(.24,.24);
  drawBackground(g,paperKind);for(const s of strokes||[])drawStroke(g,s);
}
$('pageOverviewBtn').onclick=()=>{
  const grid=$('pageGrid');grid.textContent='';const n=current();if(!n)return;
  n.pages.forEach((strokes,i)=>{
    const btn=document.createElement('button');btn.className='thumb-btn'+(i===pageIndex?' chosen':'');
    const thumb=document.createElement('canvas');previewCanvas(thumb,n.paper,strokes);
    const label=document.createElement('span');label.textContent=`Страница ${i+1}`;btn.append(thumb,label);
    btn.onclick=()=>{pageIndex=i;history=[];future=[];render();$('pagesDialog').close();};grid.append(btn);
  });$('pagesDialog').showModal();
};
$('closePages').onclick=()=>$('pagesDialog').close();
function drawBackground(c,kind){
  c.save();c.strokeStyle='#e9e6f1';c.fillStyle='#ddd6ed';c.lineWidth=.95;
  if(kind==='lined'){for(let y=47;y<H;y+=47){c.beginPath();c.moveTo(0,y);c.lineTo(W,y);c.stroke();}}
  if(kind==='grid'){for(let y=47;y<H;y+=47){c.beginPath();c.moveTo(0,y);c.lineTo(W,y);c.stroke();}for(let x=47;x<W;x+=47){c.beginPath();c.moveTo(x,0);c.lineTo(x,H);c.stroke();}}
  if(kind==='dots'){for(let y=47;y<H;y+=47)for(let x=47;x<W;x+=47){c.beginPath();c.arc(x,y,1.5,0,Math.PI*2);c.fill();}}
  c.restore();
}
function exportCanvas(strokes,kind){const out=document.createElement('canvas');out.width=W;out.height=H;const c=out.getContext('2d');c.fillStyle='#fffefa';c.fillRect(0,0,W,H);drawBackground(c,kind);for(const s of strokes)drawStroke(c,s);return out;}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
$('savePNG').onclick=()=>{const n=current();if(!n)return;exportCanvas(n.pages[pageIndex],n.paper).toBlob(blob=>blob&&download(blob,`Листик-страница-${pageIndex+1}.png`),'image/png');};
$('savePDF').onclick=()=>{
  const n=current();if(!n)return;
  const win=window.open('','_blank');if(!win){alert('Разреши всплывающие окна для экспорта PDF');return;}
  const images=n.pages.map(strokes=>exportCanvas(strokes,n.paper).toDataURL('image/png'));
  const html='<!doctype html><html><head><meta charset="utf-8"><title>'+n.title.replace(/[<>&]/g,'')+'</title><style>@page{size:A4;margin:0}body{margin:0}img{width:210mm;height:297mm;display:block;page-break-after:always}@media screen{body{background:#eee}img{width:70vw;height:auto;margin:20px auto;box-shadow:0 3px 20px #0003}}</style></head><body>'+images.map(src=>`<img src="${src}" alt="Страница">`).join('')+'<script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body></html>';
  win.document.write(html);win.document.close();
};
$('exportBtn').onclick=()=>download(new Blob([JSON.stringify({format:'listik-v2',notes},null,2)],{type:'application/json'}),'listik-backup.json');
$('importBtn').onclick=()=>$('importFile').click();
$('importFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;
  try{const parsed=JSON.parse(await file.text());const incoming=normalize(Array.isArray(parsed)?parsed:parsed.notes);
    if(!confirm(`Импортировать ${incoming.length} тетрадей? Тетради с одинаковым ID объединятся по дате изменения.`))return;
    notes=merge(notes,incoming);await flush();editCounter++;selectedId=null;render();if(authValid())queueSync();status('✓ Резервная копия импортирована');
  }catch(err){alert('Не удалось прочитать файл: '+err.message);}finally{e.target.value='';}
};
function merge(left,right){const m=new Map();for(const n of [...left,...right]){const prev=m.get(n.id);if(!prev||n.updatedAt>prev.updatedAt)m.set(n.id,clone(n));}return [...m.values()];}
function queueSync(){clearTimeout(syncTimer);syncTimer=setTimeout(syncNow,5000);}
function authValid(){return !!token&&Date.now()<tokenExpiry-25000;}
async function api(url,options={}){
  if(!authValid()){token='';$('cloudBtn').textContent='☁ Переподключить Google Диск';throw Error('Срок входа в Google истек. Подключи его снова для синхронизации.');}
  const response=await fetch(url,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});
  if(!response.ok){if(response.status===401){token='';$('cloudBtn').textContent='☁ Переподключить Google Диск';}
    throw Error(`Google Диск: ошибка ${response.status}: ${(await response.text()).slice(0,160)}`);}
  return response;
}
async function findCloudFile(){
  if(cloudFileId)return cloudFileId;
  const url='https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q='+encodeURIComponent(`name = '${CLOUD_NAME}'`)+'&fields=files(id,name),nextPageToken&page_size=100';
  const data=await(await api(url)).json();cloudFileId=data.files?.find(f=>f.name===CLOUD_NAME)?.id||null;return cloudFileId;
}
async function loadRemote(){const file=await findCloudFile();if(!file)return [];
  const parsed=await(await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file)}?alt=media`)).json();return normalize(parsed.notes);
}
async function saveRemote(snapshot){
  const body=JSON.stringify({format:'listik-v2',notes:snapshot});
  if(cloudFileId){await api(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(cloudFileId)}?uploadType=media`,{method:'PATCH',headers:{'Content-Type':'application/json'},body});return;}
  const boundary='listik_boundary_'+Date.now();
  const multipart=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name:CLOUD_NAME,parents:['appDataFolder'],mimeType:'application/json'})}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
  const response=await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body:multipart});cloudFileId=(await response.json()).id;
}
async function syncNow(){
  if(!authValid()){status('☁ Google Диск не подключен · заметки хранятся на устройстве');return;}
  if(syncing){rerunSync=true;return;}
  syncing=true;clearTimeout(syncTimer);syncEditCounter=editCounter;
  try{
    status('☁ Синхронизация...');await flush();const remote=await loadRemote();const local=clone(notes);const combined=merge(remote,local);
    if(JSON.stringify(combined)!==JSON.stringify(remote))await saveRemote(combined);
    notes=merge(notes,combined);await flush();render();
    status('✓ Google Диск синхронизирован · '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));
    if(editCounter!==syncEditCounter)rerunSync=true;
  }catch(err){status('⚠ '+err.message);}finally{syncing=false;if(rerunSync){rerunSync=false;queueSync();}}
}
$('syncBtn').onclick=()=>{if(!authValid()){$('clientId').value=localStorage.getItem('listik_google_client_id')||'';$('cloudDialog').showModal();return;}syncNow();};
$('cloudBtn').onclick=()=>{$('clientId').value=localStorage.getItem('listik_google_client_id')||'';toggleSide(false);$('cloudDialog').showModal();};
$('cancelCloud').onclick=()=>$('cloudDialog').close();
$('connectCloud').onclick=()=>{
  const cid=$('clientId').value.trim();
  if(!/^[\w-]+\.apps\.googleusercontent\.com$/.test(cid)){alert('Нужен OAuth Client ID вида: 123.apps.googleusercontent.com');return;}
  if(!window.google?.accounts?.oauth2){alert('Google Identity Services не загрузился. Проверь интернет и отключи блокировщик Google при необходимости.');return;}
  if(localStorage.getItem('listik_google_client_id')!==cid)cloudFileId=null;
  localStorage.setItem('listik_google_client_id',cid);
  try{
    tokenClient=google.accounts.oauth2.initTokenClient({client_id:cid,scope:CLOUD_SCOPE,callback:async response=>{
      if(!response?.access_token){status('⚠ Google не разрешил вход');return;}
      token=response.access_token;tokenExpiry=stamp()+Number(response.expires_in||3300)*1000;
      localStorage.setItem('listik_authorized_'+cid,'yes');
      $('cloudBtn').textContent='☁ Google Диск подключен';await syncNow();
    }});
    $('cloudDialog').close();tokenClient.requestAccessToken({prompt:localStorage.getItem('listik_authorized_'+cid)==='yes'?'':'consent'});
  }catch(err){alert('Не удалось подключить Google: '+err.message);}
};
window.addEventListener('online',()=>{if(authValid())queueSync();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&authValid())queueSync();});
window.addEventListener('keydown',e=>{
  if(!readOnly||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||$('pagesDialog').open||$('cloudDialog').open)return;
  if(e.key==='ArrowRight')changePage(1);else if(e.key==='ArrowLeft')changePage(-1);
});
async function init(){
  try{notes=normalize(await dbGet()||[]);}catch(err){notes=[];status('⚠ Не удалось загрузить локальные заметки: '+err.message);}
  if(notes.length===0){notes.push(makeNote('Моя первая тетрадь'));await dbSet(notes);}
  selectedId=notes.find(n=>!n.deleted)?.id||null;initialized=true;render();status('✓ Готово · заметки сохраняются на этом устройстве');
  if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
init();
