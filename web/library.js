/* Visible lists refresh through the shared game queue; cached snapshots arrive over SSE. */
(() => {
  let view='inventory', cache={views:{},details:{}}, selected=null, revision=-1, fetching=false, busy=false;
  let wantedRevision=-1, cacheAgain=false, detailStamp='', latestState, syncing=false, nextSyncAt=0;
  const onScreen=new Set(),syncViews=['inventory','crafting','bestiary'];
  const syncMessage=value=>{text('library-sync',value);text('bestiary-sync',value);};
  const labels={inventory:'行囊',crafting:'炼制'};
  const node=(tag,className,value)=>{const el=document.createElement(tag); if(className)el.className=className;if(value!=null)el.textContent=value;return el;};
  function picture(item) {
    const wrap=node('span','item-art');
    const fallback=node('span','art-fallback','◇'); fallback.setAttribute('aria-label','暂无原图'); wrap.append(fallback);
    if (/^\/api\/library\/images\/[a-f0-9]{64}$/u.test(item.image??'')) {
      const img=new Image(); img.alt=item.name; img.loading='lazy'; img.src=item.image;
      img.onload=()=>{fallback.hidden=true;}; img.onerror=()=>{img.remove();}; wrap.append(img);
    }
    return wrap;
  }
  function switchView(next) {
    view=next; $('library-search').value=''; $('library-category').value='';
    for(const key of Object.keys(labels)) {const active=key===view;$('tab-'+key).setAttribute('aria-selected',String(active));$('tab-'+key).tabIndex=active?0:-1;}
    $('library-panel').setAttribute('aria-labelledby','tab-'+view); renderList(); nextSyncAt=0; void syncVisible();
  }
  function renderList() {
    const data=cache.views[view], crafting=view==='crafting';
    $('library-refresh').textContent=busy?'↻ 排队刷新三项资料':'↻ 刷新行囊、炼制与图鉴';
    $('library-refresh').disabled=false;
    $('library-search').placeholder=crafting?'搜索配方或成品':'搜索物品名称';
    const category=$('library-category').value;
    options($('library-category'),[{value:'',label:'全部类别'},...Array.from(new Set((data?.items??[]).map(i=>i.category))).sort().map(name=>({value:name,label:name}))],category);
    const term=$('library-search').value.trim().toLocaleLowerCase();
    const items=(data?.items??[]).filter(i=>(!term||(i.name+' '+i.recipeType).toLocaleLowerCase().includes(term))&&(!category||i.category===category));
    text('library-summary',data?`${data.summary || data.items.length+' 项'} · 显示 ${items.length} 项`:'尚未读取');
    text('library-updated',data?`同步于 ${date(data.updatedAt)}`:'等待读取最新库存与配方');
    for(const key of Object.keys(labels)) text(key+'-count',cache.views[key]?.items.length??'—');
    $('library-equipment').hidden=crafting||!data?.equipment?.length;
    $('equipment-grid').replaceChildren(...(crafting?[]:data?.equipment??[]).map(i=>{
      const el=node('button','equipment-slot'+(i.equipped?'':' vacant'));el.type='button';el.setAttribute('aria-label','更换'+i.slot+'装备');el.onclick=()=>window.InventoryActions?.chooseSlot(i);el.append(picture(i),node('small','muted',i.slot),node('strong','',i.equipped?i.name:'未装备'));return el;
    }));
    $('library-grid').replaceChildren(...items.map(item=>{
      const card=node('button','collection-item'); card.type='button';card.setAttribute('aria-label',`查看${item.name}详情`);
      const top=node('span','collection-top');top.append(node('span','tag dim',item.category),node('span','item-amount',crafting?item.summary:item.quality?`品质 ${item.quality}`:`× ${item.quantity}`));
      card.append(top,picture(item),node('strong','collection-name',item.name));
      const facts=node('span','collection-facts');
      if(crafting){facts.append(node('span','',item.chance?`成功率 ${item.chance}`:item.recipeType),node('small','muted',item.output));card.append(facts,node('span','collection-stock'+(item.ready?' available':''),item.stock||'材料待核实'));}
      else card.append(node('span','collection-price',item.price||item.summary||'点击查看说明'));
      card.onclick=()=>openDetail(item);
      if(!crafting){const wrap=node('div','inventory-card');wrap.dataset.itemKey=item.key;wrap.append(card);return wrap;}return card;
    }));
    window.InventoryActions?.decorate({view,items,all:data?.items??[],picture});
    $('library-empty').hidden=Boolean(items.length);
    if(!items.length){$('library-empty').replaceChildren(node('span','',crafting?'♧':'◇'),node('h3','',data?'没有符合条件的条目':crafting?'查看可用炼制配方':'把行囊带到控制台'),node('p','',data?'可以更换类别或搜索关键词。':`点击「读取游戏${labels[view]}」，获取当前游戏中的${crafting?'配方与材料信息':'物品原图与库存'}。`));}
    $('library-workshop').hidden=!crafting||!data?.workshop;
    text('library-workshop',data?.workshop?`炉鼎：${data.workshop}。执行前会重新核对；缺少材料不代表未解锁。`:'');
  }
  function renderDetail() {
    if(!selected)return;
    selected.item=cache.views[selected.view]?.items.find(i=>i.key===selected.item.key)??selected.item;
    const item=selected.item, detail=cache.details[item.key];
    detailStamp=`${item.key}/${detail?.updatedAt??''}`;
    text('detail-title',item.name); const content=$('detail-content');
    const hero=node('div','detail-hero'); const names=node('div');names.append(node('span','tag',item.category),node('p','muted',selected.view==='inventory'?item.quality?`品质 ${item.quality}`:`读取时库存 × ${item.quantity}`:item.recipeType));hero.append(picture(item),names);
    content.replaceChildren(hero);
    window.dispatchEvent(new CustomEvent('recipe-detail',{detail:{item,detail,view:selected.view,picture}}));
    if(!detail){content.append(node('p','muted','正在排队读取游戏详情，读取后自动返回游历。'));text('detail-time','等待读取');return;}
    if(detail.description)content.append(node('p','detail-description',detail.description));
    if(detail.facts?.length){const facts=node('dl','detail-facts');for(const row of detail.facts){const line=node('div');line.append(node('dt','',row.label),node('dd','',row.value));facts.append(line);}content.append(facts);}
    if(detail.materials?.length){content.append(node('h3','detail-section-title','所需材料'));const table=node('table','materials-table');const head=node('thead'),hr=node('tr');for(const title of ['材料','当前拥有','每炉消耗'])hr.append(node('th','',title));head.append(hr);table.append(head);const body=node('tbody');for(const row of detail.materials){const tr=node('tr',row.missing?'material-short':'');tr.append(node('td','',row.name),node('td','',row.owned),node('td','',row.required));body.append(tr);}table.append(body);content.append(table);}
    if(detail.ingredients?.length){content.append(node('h3','detail-section-title','器物材料'));for(const row of detail.ingredients)content.append(node('p','muted',`${row.summary||row.name} · 可选 ${row.available} 件`));}
    if(detail.notes?.length)content.append(node('p','detail-notes',Array.from(new Set(detail.notes)).join(' · ')));
    // Preserve equipment stats and comparison text without reproducing action controls.
    if(detail.text){const more=node('details','detail-original');more.append(node('summary','','游戏完整说明'),node('p','',detail.text));content.append(more);}
    text('detail-time',`读取于 ${date(detail.updatedAt)}`);
  }
  async function requestDetail(){if(!selected)return;await send('library',{view:selected.view,key:selected.item.key});}
  function openDetail(item){selected={view,item};renderDetail();if(!$('library-detail').open)$('library-detail').showModal();void requestDetail();}
  async function loadCache(){
    if(fetching){cacheAgain=true;return;}fetching=true;cacheAgain=false;
    try{const res=await fetch('/api/library');const data=await res.json();if(!res.ok)throw new Error(data.error);cache=data??{views:{},details:{}};revision=cache.revision??0;renderList();
      // A list refresh must not rebuild the crafting form or erase chosen materials.
      if(selected && detailStamp!==`${selected.item.key}/${cache.details[selected.item.key]?.updatedAt??''}`)renderDetail();
    }
    catch(error){text('library-error',error.message);$('library-error').hidden=false;}
    finally{fetching=false;if(cacheAgain && wantedRevision!==revision){cacheAgain=false;void loadCache();}}
  }
  async function syncVisible(){
    if(latestState?.gameClosed||latestState?.closingGame){syncMessage('游戏已关闭，当前显示缓存；先打开游戏才能刷新');return;}
    if(latestState?.desired!=='running'){
      syncMessage('挂机未启动，自动检查已关闭；可手动刷新');return;
    }
    // IntersectionObserver notifications can lag a scroll or an SSE layout change.
    // Recheck current geometry before enqueueing any automatic game read.
    const visible = id => {
      const element=$(id==='bestiary'?'bestiary-content':id),box=element.getBoundingClientRect();
      return onScreen.has(id)&&$(id+'-fold').open&&element.getClientRects().length>0
        &&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;
    };
    if(!latestState?.library?.sync || !token || document.hidden || !['library','bestiary'].some(visible))return;
    if(selected||document.querySelector('dialog[open]')){syncMessage('查看详情或操作窗口期间暂停自动同步');return;}
    if(busy || ['checking','switching','healing','recovering','retrying','attention','stopping'].includes(latestState.phase)){
      syncMessage(latestState.busy==='library'?'正在同步行囊、炼制与图鉴…':'等待当前游戏操作完成后同步');return;
    }
    const interval=latestState.library?.sync?.intervalMs??60000;
    if(syncing){syncMessage('正在同步行囊、炼制与图鉴…');return;}
    syncMessage(latestState.library?.sync?.deferred?.length?'等待安全时机继续读取剩余页面':'挂机运行时，每 1 分钟同步行囊、炼制与图鉴');
    if(latestState.library?.sync?.deferred?.length||Date.now()<nextSyncAt||Date.now()<(latestState.library?.sync?.nextAt??0)||syncViews.every(v=>Date.now()-(v==='bestiary'?latestState.bestiary?.updatedAt??0:cache.views[v]?.updatedAt??0)<interval))return;
    syncing=true;syncMessage('正在同步行囊、炼制与图鉴…');
    try{
      const res=await fetch('/api/library/read',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({views:syncViews,automatic:true})});
      const result=await res.json();if(!res.ok)throw new Error(result.error);
      nextSyncAt=Date.now()+(result.skipped?1000:interval);
      if(result.skipped && latestState.library?.revision!==revision)void loadCache();
    }catch(error){nextSyncAt=Date.now()+60000;syncMessage('同步未完成，稍后重试：'+error.message);}
    finally{syncing=false;}
  }
  window.addEventListener('battle-state',event=>{
    const state=event.detail; latestState=state; busy=Boolean(state.busy)||Boolean(state.crafting?.activeId)||Boolean(state.inventoryActions?.activeId);
    $('library-refresh').disabled=false;$('detail-refresh').disabled=false;
    const error=state.library?.errors?.[view];text('library-error',error??'');$('library-error').hidden=!error;
    if(state.library){wantedRevision=state.library.revision;if(wantedRevision!==revision)void loadCache();}
    else {text('library-refresh',busy?'正在读取游戏…':`↻ ${cache.views[view]?'刷新':'读取游戏'}${labels[view]}`);}
    if(state.lastCommand?.kind==='library' && !state.lastCommand.ok && selected?.item.key===state.lastCommand.key) text('detail-time',`读取未完成：${state.lastCommand.error}`);
  });
  for(const key of Object.keys(labels)){
    $('tab-'+key).onclick=()=>switchView(key);
    $('tab-'+key).onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();switchView(key==='inventory'?'crafting':'inventory');$('tab-'+view).focus();}};
  }
  window.GameDataSync={refresh:()=>send('library',{views:syncViews})};
  $('library-refresh').onclick=window.GameDataSync.refresh;
  $('library-search').oninput=renderList;$('library-category').onchange=renderList;
  $('detail-close').onclick=()=>$('library-detail').close();$('detail-refresh').onclick=requestDetail;
  $('library-detail').addEventListener('close',()=>{selected=null;detailStamp='';window.dispatchEvent(new CustomEvent('recipe-detail',{detail:null}));void syncVisible();});
  window.InventoryLibrary={render:renderList,inventory:()=>cache.views.inventory,picture};
  const visibility=new IntersectionObserver(entries=>{for(const entry of entries){const id=entry.target.id==='bestiary-content'?'bestiary':'library';if(entry.isIntersecting)onScreen.add(id);else onScreen.delete(id);}void syncVisible();},{threshold:0});
  visibility.observe($('library'));visibility.observe($('bestiary-content'));
  window.addEventListener('section-toggle',event=>{if(['library','bestiary'].includes(event.detail.id)&&event.detail.open)void syncVisible();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void syncVisible();});
  window.addEventListener('focus',()=>{if(wantedRevision!==revision)void loadCache();void syncVisible();});
  setInterval(syncVisible,1000);
})();
