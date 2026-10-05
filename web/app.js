const $ = id => document.getElementById(id);
const phases = { closed:'游戏已关闭', closing:'正在关闭游戏', 'inventory-action':'物品操作与保存核对中', crafting:'炼制与存档核对中', stopped:'已停止', running:'战斗运行中', healing:'调息中', switching:'切换地点中', checking:'核对游戏状态', recovering:'恢复游戏界面', retrying:'等待重试', attention:'需要处理', stopping:'正在撤退并停止' };
const types = { battle:'普通战斗', healing:'可调息', rest:'普通歇息', challenge:'独立挑战' };
const availability = { visible:'当前可见', locked:'锁定', unverified:'尚未核实' };
let snapshot, draft, revision, token, dirty = false, lastCommand, catalogKey;
const date = at => at ? new Date(at).toLocaleString('zh-CN', { hour12:false }) : '—';
const text = (id, value) => { $(id).textContent = value; };
function notice(message, ok = false) { text('notice', message); $('notice').classList.toggle('success', ok); $('notice').hidden = false; }
function markDirty() { dirty = true; text('dirty','有尚未应用的修改'); $('dirty').classList.add('changed'); }
function options(select, list, selected) {
  select.replaceChildren(...list.map(item => { const option = new Option(item.label, item.value); option.disabled = Boolean(item.disabled); return option; }));
  if (list.some(i => i.value === selected)) select.value = selected;
}
function regionOptions() {
  const rows = snapshot.catalog?.regions.map(r => ({ value:r.name, label:r.name })) ?? [];
  options($('battle-region'),[{value:'',label:'请选择区域'},...rows],draft.target?.regionName ?? '');
  options($('healing-region'),[{value:'',label:'就地调息'},...rows],draft.healingTarget?.regionName ?? '');
  stageOptions('battle'); stageOptions('healing');
}
function stageOptions(kind) {
  const region = $(kind+'-region').value, search = $(kind+'-search').value.trim();
  const target = kind === 'battle' ? draft.target?.stageName : draft.healingTarget?.locationName;
  const list = (snapshot.catalog?.nodes ?? []).filter(n => n.type === (kind === 'battle' ? 'battle' : 'healing') && n.regionName === region && (!search || n.name.includes(search)))
    .map(n => ({value:n.name,label:`${n.name} · ${availability[n.availability]}`,disabled:n.availability === 'locked'}));
  options($(kind+'-stage'),[{value:'',label:region ? '请选择地点' : kind==='battle' ? '请先选择区域' : '在当前地点调息'},...list],target ?? '');
}
function updateDraftTarget(kind) {
  const regionName = $(kind+'-region').value, name = $(kind+'-stage').value;
  if (kind === 'battle') draft.target = {regionName,stageName:name};
  else draft.healingTarget = regionName ? {regionName,locationName:name} : null;
  markDirty();
}
function items() {
  const stocks = new Map((snapshot.state?.inventoryStocks ?? []).map(i => [i.name,i.count]));
  $('items').replaceChildren(...(snapshot.catalog?.items ?? []).map(item => {
    const label = document.createElement('label'); label.className = 'item';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = draft.consumables.itemNames.includes(item.name);
    check.onchange = () => { draft.consumables.itemNames = check.checked ? [...draft.consumables.itemNames,item.name] : draft.consumables.itemNames.filter(n => n !== item.name); markDirty(); };
    const name = document.createElement('span'); name.textContent = item.name;
    const stock = document.createElement('small'); stock.textContent = `× ${snapshot.state?.inventoryStocks ? stocks.get(item.name) ?? 0 : '—'}`;
    label.append(check,name,stock); return label;
  }));
  $('consumables-enabled').checked = draft.consumables.enabled;
}
function resetDraft() { draft = structuredClone(snapshot.settings); revision = snapshot.revision; dirty = false; text('dirty','已与生效设置同步'); $('dirty').classList.remove('changed'); regionOptions(); items(); }
function catalogRows() {
  const term = $('catalog-search').value.trim(), type = $('catalog-type').value;
  $('catalog-rows').replaceChildren(...(snapshot.catalog?.nodes ?? []).filter(n => (!term || (n.regionName+n.name).includes(term)) && (!type || n.type === type)).map(n => {
    const row = document.createElement('tr'), cell = document.createElement('td');
    const title = document.createElement('span'); title.textContent = n.name;
    const region = document.createElement('small'); region.textContent = n.regionName; cell.append(title,region); row.append(cell);
    for (const [label,style] of [[types[n.type],['battle','healing'].includes(n.type)?'':'dim'],[availability[n.availability],n.availability==='visible'?'':'warn']]) {
      const td = document.createElement('td'), tag = document.createElement('span'); tag.className = 'tag '+style; tag.textContent = label; td.append(tag); row.append(td);
    } return row;
  }));
}
function render(value) {
  snapshot = value;
  const setup = value.setup;
  const bound = !setup || setup.bound;
  $('setup-card').hidden = bound;
  for (const selector of ['.status-card','#destinations','#library','#bestiary','#activity']) document.querySelector(selector).hidden = !bound;
  $('refresh').disabled = !bound || Boolean(value.busy);
  if (setup?.browserViewPort) {
    $('browser-link').href = 'http://'+location.hostname+':'+setup.browserViewPort+'/vnc.html?autoconnect=true&resize=scale';
    $('browser-link').hidden = false;
  } else { $('browser-link').hidden = true; }
  if (!bound) {
    text('setup-character',setup?.candidate?.characterName ?? '尚未读取人物');
    text('setup-message',value.reason || '请先打开游戏，手动登录并显示角色头像页。');
    $('setup-bind').disabled = !setup?.candidate || Boolean(value.busy);
    $('setup-open').disabled = Boolean(value.busy);
    $('setup-detect').disabled = Boolean(value.busy) || Boolean(setup?.browserClosed);
    if (value.busy?.startsWith('setup-')) notice(value.reason || '正在处理首次设置…',true);
    else if (setup?.browserClosed) notice(value.reason);
    else if (value.lastCommand?.kind?.startsWith('setup-') && lastCommand !== value.lastCommand.id) {
      lastCommand = value.lastCommand.id;
      notice(value.lastCommand.ok ? value.lastCommand.message || '操作完成，请继续下一步。' : value.lastCommand.error,value.lastCommand.ok);
    }
    return;
  }
  if (!draft || !dirty && revision !== value.revision) resetDraft();
  const key = `${value.catalog?.updatedAt}/${value.catalog?.checkedAt}`;
  if (key !== catalogKey) { catalogKey = key; regionOptions(); catalogRows(); }
  items();
  text('phase',value.closingGame?'正在关闭游戏':phases[value.phase] ?? value.phase); $('status-dot').className = 'live-dot '+(value.phase==='attention'?'alert':['stopped','closed'].includes(value.phase)?'idle':'');
  document.querySelectorAll('[data-command]').forEach(button=>{
    const kind=button.dataset.command;
    button.hidden=kind==='open-game'&&!value.gameClosed;
    button.disabled=Boolean(value.closingGame||value.gameClosed&&!['open-game','close-game'].includes(kind)||kind==='open-game'&&value.busy||['start','resume','restart'].includes(kind)&&!value.settings.target);
  });
  text('character',value.state?.character || setup?.characterName || '待核实'); text('location',value.state?.location || '等待读取'); text('region',value.state?.region || '');
  text('health',value.state?.health ? `${value.state.health.current} / ${value.state.health.maximum}` : '—');
  $('hp-bar').value = value.state?.health?.percent ?? 0;
  text('updated',value.updatedAt ? `${value.gameClosed?'关闭前记录':'更新于'} ${date(value.updatedAt)}` : value.gameClosed?'未连接游戏':'等待读取游戏');
  const reason=[...new Set([value.reason,value.statusError].filter(Boolean))].join(' ');
  text('reason',reason); $('reason').hidden = !reason;
  text('busy',value.closingGame ? '等待当前操作核对结束后断开…' : value.busy ? '正在处理操作…' : '');
  text('active-battle',value.settings.target ? `当前生效：${value.settings.target.regionName} / ${value.settings.target.stageName}` : '尚未选择战斗目标，请先刷新地点目录');
  text('active-healing',`当前生效：${value.settings.healingTarget ? value.settings.healingTarget.regionName+' / '+value.settings.healingTarget.locationName : '就地调息'}`);
  text('catalog-count',`${value.catalog?.regions.length ?? 0} 个区域 · ${value.catalog?.nodes.length ?? 0} 个地点`);
  text('catalog-time',`资源更新：${date(value.catalog?.updatedAt)}　地图核实：${date(value.catalog?.checkedAt)}`);
  text('catalog-error',value.catalogError); $('catalog-error').hidden = !value.catalogError;
  const results = Object.entries(value.consumables?.results ?? {}).map(([name,r]) => `${name}：${r.uncertain?'未确认':r.skipped?'缺货或不可用':`${r.before} → ${r.after}`}`);
  text('last-use',value.consumables.disabledReason || results.join('；') || '尚无执行记录'); countdown();
  const logs = $('logs'); logs.replaceChildren(...value.logs.map(log => {
    const line = document.createElement('div'); line.className = 'log-line';
    const time = document.createElement('span'); time.className = 'log-time'; time.textContent = new Date(log.at).toLocaleTimeString('zh-CN',{hour12:false});
    const message = document.createElement('span'); message.className = 'log-message'; message.textContent = log.message; line.append(time,message); return line;
  }));
  if ($('follow-log').checked) logs.scrollTop = logs.scrollHeight;
  if (value.lastCommand && lastCommand !== value.lastCommand.id) { lastCommand = value.lastCommand.id; if(!value.lastCommand.automatic)notice(value.lastCommand.ok ? value.lastCommand.deferred?'等待当前游戏操作完成后继续读取。':value.lastCommand.partial?'部分页面读取失败，已保留旧数据。':'操作已完成。' : value.lastCommand.error,value.lastCommand.ok&&!value.lastCommand.partial); if (value.lastCommand.ok && value.lastCommand.kind === 'settings') resetDraft(); }
  window.dispatchEvent(new CustomEvent('battle-state',{detail:value}));
}
function countdown() {
  if (!snapshot) return;
  const remaining = (snapshot.consumables?.nextAt ?? 0) - Date.now();
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  text('next-use',!snapshot.settings.consumables.enabled ? '自动使用已关闭 · 原计时保留' : remaining>0 ? `下次检查：${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : '已到检查时间 · 等待任务运行及安全操作边界');
}
async function send(kind,payload={}) {
  try {
    const url = kind.startsWith('setup-') ? '/api/setup/'+kind.slice(6) : kind.startsWith('inventory-') ? '/api/inventory-actions/'+kind.slice(10) : kind.startsWith('craft-') ? '/api/crafting/'+kind.slice(6) : kind === 'settings' ? '/api/settings' : kind === 'refresh' ? '/api/catalog/refresh' : kind === 'library' ? '/api/library/read' : kind==='bestiary'?'/api/bestiary/read':'/api/commands/'+kind;
    const res = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify(payload)});
    const result = await res.json(); if (!res.ok) throw new Error(result.error);
    // A fast command can finish over SSE before its HTTP receipt arrives.
    // Do not replace that result with an obsolete queued message.
    if (snapshot?.lastCommand?.id !== result.id) notice(kind.startsWith('setup-') ? snapshot?.busy === kind ? snapshot.reason : '首次设置操作已提交，正在处理…' : '操作已排队，正在核对当前游戏状态。',true);
    return result;
  } catch (error) { notice(error.message); }
}
for (const kind of ['battle','healing']) {
  $(kind+'-region').onchange = () => { $(kind+'-search').value=''; stageOptions(kind); $(kind+'-stage').value=''; updateDraftTarget(kind); };
  $(kind+'-stage').onchange = () => updateDraftTarget(kind);
  $(kind+'-search').oninput = () => stageOptions(kind);
}
$('consumables-enabled').onchange = () => { draft.consumables.enabled = $('consumables-enabled').checked; markDirty(); };
$('save').onclick = () => send('settings',{revision,settings:draft}); $('discard').onclick = resetDraft;
$('refresh').onclick = () => send('refresh');
document.querySelectorAll('[data-command]').forEach(b => b.onclick=()=>send(b.dataset.command));
$('catalog-search').oninput=catalogRows; $('catalog-type').onchange=catalogRows;
$('setup-open').onclick=()=>send('setup-open-game');
$('setup-detect').onclick=()=>send('setup-detect');
$('setup-bind').onclick=()=>send('setup-bind',{token:snapshot?.setup?.candidate?.token});
setInterval(countdown,1000);
let eventStream, reconnectTimer, reconnectDelay=1000, connecting=false;
function reconnect(){
  if(reconnectTimer)return;
  text('connection','连接中断 · 正在重新连接');
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;void connect();},reconnectDelay);
  reconnectDelay=Math.min(reconnectDelay*2,10000);
}
async function connect() {
  if(connecting)return;connecting=true;
  clearTimeout(reconnectTimer);reconnectTimer=null;eventStream?.close();
  try {
    const res = await fetch('/api/session'); const data = await res.json(); if (!res.ok) throw new Error(data.error); token=data.token;
    const events = new EventSource('/api/events');eventStream=events;
    events.onmessage = event => { if(events!==eventStream)return;reconnectDelay=1000;text('connection','实时连接');render(JSON.parse(event.data)); };
    // Session cookies are invalid after a container restart. EventSource alone
    // cannot repair a 401: obtain a new session/CSRF token before reconnecting.
    events.onerror = () => { if(events!==eventStream)return;events.close();reconnect(); };
  } catch(error) { notice(error.message);reconnect(); }
  finally {connecting=false;}
}
window.addEventListener('online',()=>void connect());
connect();

// Native details keep the lists and filters mounted while shortening the page.
for(const id of ['library','bestiary']){
  const fold=$(id+'-fold'),key='control-section:'+id;
  let saved=null;try{saved=localStorage.getItem(key);}catch{/* Folding still works without storage. */}
  fold.open=saved==='open'||saved===null&&location.hash==='#'+id;
  fold.addEventListener('toggle',()=>{
    try{localStorage.setItem(key,fold.open?'open':'closed');}catch{}
    window.dispatchEvent(new CustomEvent('section-toggle',{detail:{id,open:fold.open}}));
  });
  document.querySelectorAll('.nav[href="#'+id+'"]').forEach(link=>link.addEventListener('click',()=>{fold.open=true;}));
}
window.addEventListener('hashchange',()=>{
  if(['#library','#bestiary'].includes(location.hash))$(location.hash.slice(1)+'-fold').open=true;
});
