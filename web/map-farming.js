(() => {
  const dialog=$('map-farming'),region=$('map-farming-region'),search=$('map-farming-search'),selector=$('map-farming-select'),content=$('map-farming-content');
  const el=(tag,cls,value)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(value!=null)node.textContent=value;return node;};
  const fmt=n=>n>0&&n<.0001?'<0.0001':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:4});
  let data=null,state={},selected='',initialized=false,sequence=0,key='';
  const category=i=>i.kind==='part'?'炼材':'材料';
  function table(headers,rows){
    const table=el('table','map-drop-table'),head=el('thead'),hr=el('tr'),body=el('tbody');
    for(const title of headers){const cell=el('th','',title);cell.scope='col';hr.append(cell);}head.append(hr);
    for(const cells of rows){const row=el('tr');for(const value of cells){const cell=el('td');cell.append(typeof value==='string'?document.createTextNode(value):value);row.append(cell);}body.append(row);}
    table.append(head,body);return table;
  }
  function render(){
    const expanded=new Set([...content.querySelectorAll('.map-enemy[open]')].map(e=>e.dataset.enemy));content.replaceChildren();
    if(!data)return;
    for(const warning of data.warnings)content.append(el('p','reason',warning));
    const map=data.maps.find(m=>m.id===selected);
    if(!map){content.append(el('p','hint',data.maps.length?'请选择要查看的地图；原选择可能已不在当前目录或筛选中。':'当前没有地图数据，请同步图鉴与地图。'));return;}
    const overview=el('section','map-drop-overview');overview.append(el('h3','',`${map.regionName||'区域待核实'} / ${map.name}`));
    if(!map.eligible)overview.append(el('p','reason',`${map.reasons.join('；')}。以下仅供参考。`));
    const metrics=el('div','map-drop-metrics');
    for(const [label,value] of [['每轮波数',String(map.groups)],['每轮怪物',fmt(map.totalEnemies)+' 只'],['已知材料种类',String(map.outputs.length)],['已知掉落合计',fmt(map.expectedTotal)+' 件/轮']]){
      const box=el('div');box.append(el('span','muted',label),el('strong','',value));metrics.append(box);
    }
    overview.append(metrics,el('p','hint',`每波 ${map.groupSize} 只 · 地图倍率 ×${fmt(map.multiplier)}${map.unknown?` · 尚有 ${fmt(map.unknownCount)} 只/轮的怪物资料未核实，合计仅含已知部分`:''}`));content.append(overview);
    content.append(el('h4','','本图一轮材料汇总'));
    if(map.outputs.length)content.append(table(['材料','期望件数 / 轮','掉落怪物'],map.outputs.map(item=>{
      const name=el('div');name.append(el('strong','',item.name),el('small','muted',category(item)));
      return [name,fmt(item.expected),item.enemies.map(e=>e.name).join('、')];
    })));
    else content.append(el('p','hint',map.unknown?'怪物资料尚未核实，暂不能确定本图的材料掉落。':'已知怪物没有炼材或材料直接掉落；其他类型物品不在本表统计。'));
    content.append(el('h4','','逐怪掉落明细'));
    for(const enemy of map.enemies){
      const row=el('details','map-enemy');row.dataset.enemy=enemy.id;row.open=expanded.has(enemy.id);
      const summary=el('summary');summary.append(el('strong','',enemy.name),el('span','muted',`预计 ${fmt(enemy.count)} 只/轮`));row.append(summary);
      if(!enemy.known)row.append(el('p','hint','该怪物尚未遭遇或定义缺失，掉落未计入汇总；这不代表不会掉落材料。'));
      else if(!enemy.loot.length)row.append(el('p','hint','该怪物暂无炼材或材料直接掉落。'));
      else row.append(table(['材料与基础判定','每只期望','本轮贡献'],enemy.loot.map(item=>{
        const name=el('div');name.append(el('strong','',item.name));
        for(const roll of item.rolls){const base=[roll.guaranteed?`必得 ${fmt(roll.guaranteed)} 件`:'',roll.extraChance?`${fmt(roll.extraChance*100)}% ${roll.guaranteed?'额外':''}掉落 1 件`:''].filter(Boolean).join('，');name.append(el('small','muted',`${base} · ${roll.rolls} 次判定${roll.ignoreLuck?' · 不受倍率影响':''}`));}
        return [name,fmt(item.perKill)+' 件',fmt(item.expected)+' 件'];
      })));
      content.append(row);
    }
  }
  function mapOptions(pickFirst=false){
    if(!data)return;
    const term=search.value.trim(),maps=data.maps.filter(m=>(!region.value||m.regionName===region.value)&&(!term||`${m.regionName} ${m.name}`.includes(term)));
    if(pickFirst&&!maps.some(m=>m.id===selected))selected=maps[0]?.id??'';
    options(selector,[{value:'',label:maps.length?'请选择地图':'没有符合筛选的地图'},...maps.map(m=>({value:m.id,label:`${m.regionName||'区域待核实'} / ${m.name}${m.eligible?'':' · 参考'}`}))],selected);
    text('map-farming-meta',`地图 ${data.maps.length} 张 · 当前筛选 ${maps.length} 张`);render();
  }
  async function calculate(){
    if(!dialog.open||!token)return;const request=++sequence;text('map-farming-message','正在计算各地图一轮掉落…');
    try{
      const response=await fetch('/api/farming/maps',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:'{}'});
      const value=await response.json();if(request!==sequence||!dialog.open)return;if(!response.ok)throw Error(value.error);
      data=value;
      options(region,[{value:'',label:'全部区域'},...[...new Set(data.maps.map(m=>m.regionName).filter(Boolean))].map(name=>({value:name,label:name}))],region.value);
      if(!initialized){const target=state.settings?.target,matched=data.maps.filter(m=>m.regionName===target?.regionName&&m.name===target?.stageName);selected=(matched.length===1?matched[0]:data.maps.find(m=>m.eligible)??data.maps[0])?.id??'';initialized=true;}
      text('map-farming-message',data.note);text('map-farming-time',`图鉴：${date(data.bestiaryAt)} · 地图：${date(data.catalogAt)}`);mapOptions();
    }catch(error){if(request===sequence&&dialog.open){data=null;content.replaceChildren();selector.replaceChildren();text('map-farming-message',error.message);text('map-farming-meta','数据暂不可用');}}
  }
  $('map-farming-open').onclick=()=>{if(!dialog.open){dialog.showModal();void calculate();}};
  $('map-farming-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{sequence++;$('map-farming-open').focus();});
  region.onchange=()=>mapOptions(true);search.oninput=()=>mapOptions(true);selector.onchange=()=>{selected=selector.value;content.replaceChildren();render();};
  $('map-farming-reload').onclick=()=>void calculate();
  $('map-farming-sync').onclick=async()=>{text('map-farming-message','正在排队同步图鉴与地图，完成后自动更新…');const job=await send('bestiary');if(!job)text('map-farming-message','同步未提交，请先打开游戏并查看面板提示。');};
  window.addEventListener('battle-state',event=>{
    const previous=state;state=event.detail;
    $('map-farming-sync').disabled=Boolean(state.gameClosed||state.closingGame||state.busy||state.inventoryActions?.activeId||state.crafting?.activeId);
    const next=JSON.stringify([state.bestiary?.revision,state.bestiary?.knowledgeRevision,state.catalog?.resourceUrl,state.catalog?.updatedAt,state.catalog?.checkedAt]);
    if(next!==key){key=next;if(dialog.open)void calculate();}
    if(dialog.open&&state.lastCommand?.id!==previous.lastCommand?.id&&state.lastCommand?.kind==='bestiary'&&!state.lastCommand.ok)text('map-farming-message','资料同步未完成：'+state.lastCommand.error);
  });
})();
