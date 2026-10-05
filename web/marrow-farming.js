(() => {
  const dialog=$('marrow-farming'),select=$('marrow-farming-kind'),content=$('marrow-farming-results');
  const el=(tag,cls,value)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(value!=null)node.textContent=value;return node;};
  const fmt=n=>n>0&&n<0.0001?'<0.0001':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:4});
  const checkedNames=()=>[...$('items').querySelectorAll('input:checked')].map(input=>input.parentElement.querySelector('span').textContent);
  let state={},data=null,mode='selected',sequence=0,key='';
  function choices(){
    const list=data?.items??state.catalog?.items??[],chosen=checkedNames();
    options(select,[{value:'selected',label:`已勾选灵髓 · ${chosen.length} 种`},{value:'all',label:'全部灵髓 · 合计件数'},...list.map(i=>({value:'item:'+i.id,label:i.name}))],mode);
  }
  function mapCard(map,index,reference=false){
    const card=el('article','marrow-map'+(reference?' reference':''));card.dataset.mapId=map.id;
    const head=el('div','marrow-map-heading'),title=el('div');
    title.append(el('small','muted',map.regionName||'区域待核实'),el('h4','',`${reference?'':index+1+' · '}${map.name}`));
    const yieldText=el('div','marrow-yield');yieldText.append(el('strong','',fmt(map.expectedTotal)),el('small','muted',reference&&map.unknown?'已知件数 / 轮':'件 / 轮'));
    head.append(title,yieldText);card.append(head);
    const drops=el('div','marrow-drops');for(const output of map.outputs)drops.append(el('span','tag',`${output.name} ${fmt(output.expected)}`));card.append(drops);
    if(reference)card.append(el('p','hint',map.reasons.join('；')));
    const more=el('details','marrow-map-details');more.append(el('summary','','查看掉落与难度依据'));
    more.append(el('p','hint',`${map.groups} 波 · 每波 ${map.groupSize} 只 · 地图倍率 ×${fmt(map.multiplier)} · 目标怪占比 ${fmt(map.targetShare*100)}%`));
    for(const output of map.outputs)more.append(el('p','hint',`${output.name}：${output.enemies.map(e=>`${e.name} 约 ${fmt(e.count)} 只/轮`).join('、')}`));
    if(map.difficulty)more.append(el('p','hint',`最高境界 ${map.difficulty.maxRealmLabel} · 峰值每波气血 ${fmt(map.difficulty.peakHp)} / 攻击 ${fmt(map.difficulty.peakAttack)}`));
    if(map.dynamic)more.append(el('p','hint','含特殊减伤、反震或随角色变化的能力，请结合实际通关情况判断。'));
    card.append(more);return card;
  }
  function render(){
    content.replaceChildren();choices();if(!data)return;
    text('marrow-farming-message',data.note);
    text('marrow-farming-time',`图鉴：${date(data.bestiaryAt)} · 地图核实：${date(data.catalogAt)}`);
    for(const warning of data.warnings)content.append(el('p','reason',warning));
    const ranked=data.maps.filter(m=>m.eligible),reference=data.maps.filter(m=>!m.eligible),best=ranked.find(m=>m.id===data.bestMapId);
    const hero=el('section','marrow-best');
    hero.append(el('p','eyebrow','已核实普通关卡 · 每轮期望最高'));
    if(best){hero.append(el('h3','',`${best.regionName} / ${best.name}${data.bestTies>1?'（并列）':''}`),el('p','marrow-best-yield',`${fmt(best.expectedTotal)} 件 / 轮`),el('p','hint',`统计：${data.selected.map(i=>i.name).join('、')}。按完整通关比较，不代表刷取速度或必定掉落。`));}
    else hero.append(el('h3','','暂无可确定推荐'),el('p','hint','已核实且敌人资料完整的普通关卡中暂无来源；可刷新图鉴和地图状态，或选择其他灵髓。'));
    content.append(hero);
    if(data.selected.length>1){const kinds=el('details','marrow-by-kind');kinds.append(el('summary','','各类灵髓的最佳地图'));const grid=el('div','marrow-best-items');
      for(const item of data.bestByItem){const box=el('div');box.append(el('strong','',item.name),el('p','',item.best?`${item.best.regionName} / ${item.best.name}`:'暂无已核实来源'),el('small','muted',item.best?`${fmt(item.best.expected)} 件/轮${item.ties>1?' · 并列':''}`:''));grid.append(box);}kinds.append(grid);content.append(kinds);}
    if(ranked.length){content.append(el('h3','marrow-section-title','地图期望排行'));ranked.forEach((m,index)=>content.append(mapCard(m,index)));}
    if(reference.length){const extra=el('details','marrow-reference');extra.append(el('summary','',`待核实与独立挑战 · ${reference.length} 张地图`),el('p','hint','不计入最高期望推荐。存在未遭遇敌人时，只列出已知部分掉落。'));reference.forEach((m,i)=>extra.append(mapCard(m,i,true)));content.append(extra);}
    if(!data.maps.length)content.append(el('p','hint','当前图鉴尚未记录所选灵髓的地图掉落来源；这不表示游戏中没有掉落。'));
  }
  async function calculate(){
    if(!dialog.open||!token)return;
    const request=++sequence;choices();content.replaceChildren();text('marrow-farming-message','正在计算每轮掉落期望…');
    try{
      const list=data?.items??state.catalog?.items??[],selected=checkedNames();
      const ids=mode==='selected'?list.filter(i=>selected.includes(i.name)).map(i=>i.id):mode.startsWith('item:')?[mode.slice(5)]:undefined;
      if(ids&&!ids.length)throw new Error('尚未勾选灵髓；请选择一种灵髓或查看全部。');
      const response=await fetch('/api/farming/marrow',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify(ids?{itemIds:ids}:{})});
      const result=await response.json();if(request!==sequence||!dialog.open)return;if(!response.ok)throw new Error(result.error);
      data=result;render();
    }catch(error){if(request===sequence&&dialog.open){content.replaceChildren();text('marrow-farming-message',error.message);}}
  }
  $('marrow-farming-open').onclick=()=>{if(dialog.open)return;mode=checkedNames().length?'selected':'all';dialog.showModal();void calculate();};
  $('marrow-farming-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{sequence++;$('marrow-farming-open').focus();});
  select.onchange=()=>{mode=select.value;void calculate();};
  $('marrow-farming-reload').onclick=()=>void calculate();
  $('marrow-farming-bestiary').onclick=()=>void send('bestiary');
  $('marrow-farming-map').onclick=()=>void send('refresh');
  $('items').addEventListener('change',()=>{if(dialog.open&&mode==='selected')void calculate();});
  window.addEventListener('battle-state',event=>{
    state=event.detail;
    const next=JSON.stringify([state.bestiary?.revision,state.catalog?.updatedAt,state.catalog?.checkedAt,mode==='selected'?checkedNames():null]);
    const blocked=Boolean(state.busy||state.inventoryActions?.activeId||state.crafting?.activeId);
    $('marrow-farming-bestiary').disabled=blocked;$('marrow-farming-map').disabled=blocked;
    if(next!==key){key=next;if(dialog.open)void calculate();}
  });
})();
