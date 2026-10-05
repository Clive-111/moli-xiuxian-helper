(() => {
  const dialog=$('material-farming'),results=$('material-farming-results'),search=$('material-farming-search'),kind=$('material-farming-kind');
  const el=(tag,cls,value)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(value!=null)node.textContent=value;return node;};
  const fmt=n=>n>0&&n<0.0001?'<0.0001':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:4});
  let data=null,state={},sequence=0,key='';
  options(kind,[{value:'',label:'全部炼材与材料'},{value:'part',label:'炼材'},{value:'material',label:'材料'}],'');
  const lootText=l=>[
    l.guaranteed?`必得 ${fmt(l.guaranteed)} 件`:'',
    l.extraChance?`${fmt(l.extraChance*100)}% ${l.guaranteed?'额外':''}掉落 1 件`:'',
  ].filter(Boolean).join('，')+` · ${l.rolls} 次判定${l.ignoreLuck?' · 不受倍率影响':''}`;
  function mapCard(map,output,reference){
    const card=el('article','material-map'+(reference?' reference':''));card.dataset.mapId=map.id;
    const head=el('div','material-map-head');head.append(el('strong','',`${map.regionName||'区域待核实'} / ${map.name}`),el('span','material-yield',`${fmt(output.expected)} 件 / 轮`));card.append(head);
    card.append(el('p','hint',`${map.groups} 波 · 每波 ${map.groupSize} 只 · 地图倍率 ×${fmt(map.multiplier)} · 目标怪占比 ${fmt(output.enemyShare*100)}%`));
    for(const enemy of output.enemies){
      const row=el('p','hint');row.append(el('strong','',`${enemy.name} · 预计 ${fmt(enemy.count)} 只/轮`),el('br'));
      row.append(document.createTextNode('基础掉落：'+enemy.loot.map(lootText).join('；')));card.append(row);
    }
    if(map.difficulty)card.append(el('p','hint',`最高境界 ${map.difficulty.maxRealmLabel} · 峰值每波气血 ${fmt(map.difficulty.peakHp)} / 攻击 ${fmt(map.difficulty.peakAttack)}`));
    if(reference)card.append(el('p','material-reference-note',map.reasons.join('；')));
    return card;
  }
  function details(row,item){
    const body=row.querySelector('.material-item-maps');if(body.childElementCount)return;
    const maps=data.maps.map(map=>({map,output:map.outputs.find(o=>o.itemId===item.id)})).filter(r=>r.output)
      .sort((a,b)=>Number(b.map.eligible)-Number(a.map.eligible)||b.output.expected-a.output.expected||a.map.id.localeCompare(b.map.id));
    const verified=maps.filter(r=>r.map.eligible),reference=maps.filter(r=>!r.map.eligible);
    if(verified.length){body.append(el('h4','',`可推荐地图 · ${verified.length} 张`));for(const r of verified)body.append(mapCard(r.map,r.output,false));}
    else body.append(el('p','hint',item.reason));
    if(reference.length){const extra=el('details','material-reference');extra.append(el('summary','',`待核实、锁定与挑战 · ${reference.length} 张`),el('p','hint','不参与最佳地图排名；含未遭遇敌人时只展示已知掉落。'));for(const r of reference)extra.append(mapCard(r.map,r.output,true));body.append(extra);}
  }
  function render(){
    const opened=new Set([...results.querySelectorAll('.material-rank-row[open]')].map(e=>e.dataset.id));
    const focus=document.activeElement?.closest('.material-rank-row')?.dataset.id;
    results.replaceChildren();if(!data)return;
    const term=search.value.trim(),rows=data.items.filter(i=>(!kind.value||i.kind===kind.value)&&(!term||i.name.includes(term))&&(!$('material-only-ranked').checked||i.best));
    text('material-farming-message',data.note);
    text('material-farming-meta',`共 ${data.items.length} 种 · 已有推荐 ${data.items.filter(i=>i.best).length} 种 · 当前显示 ${rows.length} 种`);
    text('material-farming-time',`图鉴：${date(data.bestiaryAt)} · 地图：${date(data.catalogAt)}`);
    for(const warning of data.warnings)results.append(el('p','reason',warning));
    for(const item of rows){
      const row=el('details','material-rank-row');row.dataset.id=item.id;row.open=opened.has(item.id);
      const summary=el('summary'),name=el('div','material-name');name.append(el('span','tag',item.kind==='part'?'炼材':'材料'),el('strong','',item.name));
      const location=el('div','material-location');location.append(el('span','',item.best?`${item.best.regionName} / ${item.best.name}`:item.reason),el('small','muted',item.best?(item.ties>1?`并列最高 ${item.ties} 张地图 · 展开对比`:'展开查看地图排行与掉落依据'):'展开查看来源说明'));
      const amount=el('div','material-amount');amount.append(el('strong','',item.best?fmt(item.best.expected):'—'),el('small','muted','件 / 轮'));
      summary.append(name,location,amount);row.append(summary,el('div','material-item-maps'));row.ontoggle=()=>{if(row.open)details(row,item);};
      results.append(row);if(row.open)details(row,item);
      if(item.id===focus)summary.focus({preventScroll:true});
    }
    if(!rows.length)results.append(el('p','hint',data.items.length?'没有符合当前筛选的炼材或材料。':'当前资源中没有识别到炼材与材料，请同步资料。'));
  }
  async function calculate(){
    if(!dialog.open||!token)return;const request=++sequence;text('material-farming-message','正在计算各炼材的最佳地图…');
    try{
      const response=await fetch('/api/farming/materials',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:'{}'});
      const value=await response.json();if(request!==sequence||!dialog.open)return;if(!response.ok)throw new Error(value.error);
      data=value;render();
    }catch(error){if(request===sequence&&dialog.open){data=null;results.replaceChildren();text('material-farming-message',error.message);text('material-farming-meta','数据暂不可用');}}
  }
  $('material-farming-open').onclick=()=>{if(!dialog.open){dialog.showModal();void calculate();}};
  $('material-farming-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{sequence++;$('material-farming-open').focus();});
  search.oninput=render;kind.onchange=render;$('material-only-ranked').onchange=render;
  $('material-farming-reload').onclick=()=>void calculate();
  $('material-farming-sync').onclick=async()=>{text('material-farming-message','正在排队同步图鉴与地图，完成后自动重新排名…');const job=await send('bestiary');if(!job)text('material-farming-message','同步未提交，请先打开游戏并查看面板提示。');};
  window.addEventListener('battle-state',event=>{
    const previous=state;state=event.detail;
    $('material-farming-sync').disabled=Boolean(state.gameClosed||state.closingGame||state.busy||state.inventoryActions?.activeId||state.crafting?.activeId);
    const next=JSON.stringify([state.bestiary?.revision,state.bestiary?.knowledgeRevision,state.catalog?.resourceUrl,state.catalog?.updatedAt,state.catalog?.checkedAt]);
    if(next!==key){key=next;if(dialog.open)void calculate();}
    if(dialog.open&&state.lastCommand?.id!==previous.lastCommand?.id&&state.lastCommand?.kind==='bestiary'&&!state.lastCommand.ok)text('material-farming-message','资料同步未完成：'+state.lastCommand.error);
  });
})();
