(() => {
  const el=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!=null)e.textContent=value;return e;};
  const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:3});
  const percent=n=>fmt(n*100)+'%';
  const abilityValue=value=>Array.isArray(value)?value.map(abilityValue).join(' → '):value&&typeof value==='object'?Object.entries(value).map(([k,v])=>`${({coefficient:'系数',damageMultiplier:'伤害倍率',threshold:'阈值',scale:'缩放系数',every:'间隔次数',count:'次数'})[k]??'参数'} ${abilityValue(v)}`).join('，'):value===true?'是':String(value);
  const skills={strikes:'连续攻击',entryStrikes:'先手袭击',ignoreDefense:'无视防御',sturdy:'坚固（特殊减伤）',reflectionRatio:'伤害反震',entryStatRatio:'随角色属性增强',entryHealthRatio:'随角色属性增加气血',entryAgilityAttackRatio:'随角色敏捷增加攻击',hpRegen:'回复气血',regeneration:'再生',restraint:'拘束',rending:'撕裂',weakening:'削弱',reversal:'逆转',walletSuppressionUnit:'财力压制',rampingDamage:'伤害递增',mirrorOpening:'镜像开场',arrayStrikes:'阵法连击',rampingDamageStep:'伤害递增幅度',entryDamageMultiplier:'入场伤害倍率',noToughnessXp:'不提供韧性经验',currentHpAttackDivisor:'按当前气血攻击',extraStrike:'额外攻击',entryAttackCoefficient:'入场攻击系数',defensiveFlash:'闪身防御',attackCoefficientMultiplier:'攻击系数倍率',agilityDeficit:'敏捷差压制',softBones:'柔骨',missPunishment:'未命中惩罚',periodicStrike:'周期攻击',hitHealingRatio:'命中回血',entrySequence:'入场连招',bullying:'欺弱',attackAfterDamageThreshold:'受伤后强化攻击',healthBurst:'气血爆发'};
  let data={entries:[]},state={},loadedRevision=-1,loading=false,reload=false,firstRequested=false,visible=false,current=null,plan=null,choices={},sequence=0,sort='easy',focus='',scope='whole',materialId='',expanded=new Set(['root']);
  function picture(entry){const img=el('img','enemy-art');img.alt=entry.name;img.loading='lazy';if(/^\/api\/library\/images\/[a-f0-9]{64}$/u.test(entry.image??''))img.src=entry.image;else img.hidden=true;img.onerror=()=>img.hidden=true;return img;}
  function lootText(drop){return [drop.guaranteed?`必得 ${fmt(drop.guaranteed)}`:'',drop.extraChance?`${percent(drop.extraChance)} ${drop.guaranteed?'额外':''}掉落 1`:''].filter(Boolean).join('，')+(drop.rolls>1?` · ${drop.rolls} 次独立判定`:'')+(drop.ignoreLuck?' · 不受掉落加成影响':'');}
  function renderBestiary(){
    const term=$('bestiary-search').value.trim();const entries=(data.entries??[]).filter(e=>[e.name,...(e.loot??[]).map(l=>l.name),...(e.locations??[]).map(l=>l.name)].some(v=>v.includes(term)));
    if($('bestiary-order').value==='reverse')entries.reverse();
    const opened=new Set([...$('bestiary-list').querySelectorAll('details[open]')].map(e=>e.dataset.id));
    $('bestiary-list').replaceChildren(...entries.map(e=>{
      const card=el('details','enemy-card');card.dataset.id=e.id;card.open=opened.has(e.id);const summary=el('summary'),info=el('div');info.append(el('strong','',e.name),el('small','muted',`${e.summary||e.realmLabel} · ${e.loot?.length??0} 种掉落`));summary.append(picture(e),info);card.append(summary);
      card.append(el('p','muted',e.description),el('p','',`出没：${(e.locations??[]).map(m=>`${m.regionName} / ${m.name}${m.challenge?'（一次性挑战）':''}${m.availability==='visible'?'':'（可用情况未核实）'}`).join('、')||'暂未核实'} `));
      const list=el('ul','enemy-loot');for(const l of e.loot??[])list.append(el('li','',`${l.name}：${lootText(l)}`));if(!list.childElementCount)list.append(el('li','muted','无击败掉落'));card.append(el('h4','','基础掉落'),list);
      const stats=el('div','enemy-stats');for(const [key,name]of Object.entries({maxHp:'气血',attack:'攻击',defense:'防御',agility:'敏捷',critChance:'暴击率',critMultiplier:'暴击倍率',attackSpeed:'攻速'}))if(e.stats?.[key]!=null)stats.append(el('span','',`${name} ${key==='critChance'?percent(Number(e.stats[key])):fmt(e.stats[key])}`));card.append(stats);
      card.append(el('p','hint',Object.entries(e.abilities??{}).filter(([,v])=>v).map(([k,v])=>`${skills[k]??'其他特殊能力'}：${abilityValue(v)}`).join(' · ')||'无特殊能力'));return card;
    }));
    if(!entries.length)$('bestiary-list').append(el('p','muted',data.updatedAt?'没有符合条件的敌人':'尚未读取图鉴，点击刷新即可采集。'));
    text('bestiary-meta',`${entries.length} / ${data.entries?.length??0} 种已遭遇敌人${data.updatedAt?' · 读取于 '+date(data.updatedAt):''}${data.stale?' · 数据版本待核实':''}`);
    const error=[state.bestiary?.error,data.error,data.unknown?.length?'待核实：'+data.unknown.join('、'):''].filter(Boolean).join('；');text('bestiary-error',error);$('bestiary-error').hidden=!error;
  }
  async function loadBestiary(){if(!state.bestiary)return;if(loading){reload=true;return;}loading=true;reload=false;try{const response=await fetch('/api/bestiary');if(!response.ok)throw new Error('图鉴缓存读取失败');data=await response.json();loadedRevision=data.revision??0;renderBestiary();}catch(error){text('bestiary-error',error.message);$('bestiary-error').hidden=false;}finally{loading=false;if(reload&&loadedRevision!==state.bestiary?.revision)void loadBestiary();}}
  async function ensureBestiary(){if(!token||!state.bestiary||firstRequested||state.bestiary.updatedAt||state.desired!=='running'||state.gameClosed)return;firstRequested=true;await send('bestiary');}
  function changeScope(next,id){scope=next;if(id){materialId=id;$('farming-material-quantity').value='1';}renderScope();void requestPlan();}
  function renderScope(){
    text('farming-whole',plan?'完整制作 · '+plan.name:'完整成品刷取');
    for(const [id,value] of [['farming-whole','whole'],['farming-single','single']]){$(id).setAttribute('aria-pressed',String(scope===value));$(id).className=scope===value?'primary':'secondary';}
    $('farming-single-controls').hidden=scope!=='single';
    if(plan){const available=plan.materialOptions??[];if(!available.some(m=>m.itemId===materialId))materialId=available[0]?.itemId??'';options($('farming-material'),available.map(m=>({value:m.itemId,label:m.name})),materialId);}
  }
  function treeNode(n){const box=el('details','material-node');box.dataset.path=n.path;box.dataset.itemId=n.itemId;box.open=expanded.has(n.path);box.addEventListener('toggle',()=>{if(!box.isConnected)return;if(box.open)expanded.add(n.path);else expanded.delete(n.path);});const summary=el('summary');summary.append(el('strong','',n.name),el('span','muted',n.reference?`来源参考用量 ${fmt(n.required)}`:`需要 ${fmt(n.required)} · 已有 ${fmt(n.owned)} · 缺少 ${fmt(n.shortage)}`));box.append(summary);
    if(n.sourcePreview)box.append(el('p','hint','库存已满足；以下展示补做同等数量的来源，不计入本次缺口。'));
    if(n.recipeName)box.append(el('p','hint',`${n.reference||n.sourcePreview?'补做参考：':''}${n.recipeName} · ${fmt(n.batches)} 炉/组 · 每次产出 ${n.outputCount} · 成功率 ${n.chance}`));
    if(n.instances?.length){const more=el('details','material-instances');more.append(el('summary','',`${n.instances.length} 件可用实例 · 查看品质`),el('p','hint',n.instances.map(i=>`品质 ${i.quality}（${i.id}）`).join('、')+'；实际炼制时需手动选择。'));box.append(more);}
    if(n.path!=='root'){const action=el('button','quiet','单独查看此物品的刷取');action.type='button';action.onclick=()=>changeScope('single',n.itemId);box.append(action);}
    if(n.issue)box.append(el('p','hint',n.issue));for(const c of n.children??[])box.append(treeNode(c));return box;
  }
  function renderPlan(){
    const content=$('farming-content');content.replaceChildren();if(!plan)return;
    renderScope();
    const farming=plan.farming;
    text('farming-message',`${$('farming-ignore-stock').checked?'当前按从零制作计算，未扣减库存。 ':''}${plan.note} 库存读取于 ${date(plan.inventoryAt)}。`);
    for(const warning of plan.warnings)content.append(el('p','reason',warning));
    content.append(treeNode(plan.tree));
    for(const route of plan.routes){const box=el('div','route-choice'),label=el('label','',`${route.name} · 可选路线`),select=el('select');select.setAttribute('aria-label',route.name+'的合成路线');
      for(const option of route.alternatives){const opt=el('option','',`${option.name}${option.canMake?' · 现有材料可完成':option.farmable?' · 已知可刷来源':''}`);opt.value=option.id;select.append(opt);}select.value=route.selected;select.onchange=()=>{choices[route.itemId]=select.value;void requestPlan();};label.append(select);box.append(label);
      for(const option of route.alternatives)box.append(el('p','hint',`${option.name}：${option.materials.map(m=>`${m.name} 需${fmt(m.required)} / 有${fmt(m.owned)}`).join('，')}`));content.append(box);
    }
    content.append(el('h4','',`${scope==='whole'?'完整制作':'单个物品'}：${farming.name} × ${fmt(farming.quantity)}`));
    content.append(el('p','hint farming-basis',farming.basis==='reference'?'现有库存已足够，本次无需刷取。以下仍展示从零制作的来源，方便继续备料。':farming.basis==='from-zero'?'以下按从零制作统计；相同基础材料已合并，不计入已有库存。':'已计入已有库存，同一份材料不会重复使用；不能直接掉落的中间材料已逐层追溯到可刷取物品。'));
    if(farming.recipes.length)content.append(el('p','hint','刷取统计采用：'+farming.recipes.map(r=>`${r.name} × ${fmt(r.batches)} 炉/组`).join('、')+'。按成功完成最低用量，失败可能增加消耗。'));
    for(const m of farming.targets){const row=el('article','material-source');row.dataset.itemId=m.itemId;row.append(el('strong','',`${m.name} · ${farming.basis==='shortage'?'需补':'参考需'} ${fmt(m.quantity)}`));
      if(m.via.length)row.append(el('p','hint','用于：'+m.via.join('；')));
      for(const source of m.sources)row.append(el('p','',`${source.name}：${source.loot.map(lootText).join('；')}`));content.append(row);
    }
    for(const m of farming.unresolved)content.append(el('p','reason farming-unresolved',`${m.name} × ${fmt(m.quantity)}：${m.issue}。可切换合成路线或刷新图鉴；没有把它当作可刷材料。`));
    const itinerary=farming.itinerary,summary=el('article','farming-itinerary');summary.append(el('h4','',scope==='whole'?'整件刷取汇总':'当前物品刷取汇总'));
    summary.append(el('p','hint','按各材料缺口比例选图，同图掉落的材料会一起补足缺口。轮数按期望产出配平，随机掉落不保证按这些轮数拿齐，也不保证全局最少轮数。'));
    if(itinerary.steps.length){summary.append(el('p','',`已知材料覆盖安排：${itinerary.steps.length} 段 · 理论 ${fmt(itinerary.totalRounds)} 整轮`));const list=el('ol');for(const step of itinerary.steps){const row=el('li');row.append(el('strong','',`${step.regionName} / ${step.name} · ${fmt(step.rounds)} 轮`),el('p','hint',step.gains.map(g=>`${g.name} 可补足 ${fmt(g.credited)}（预计掉落 ${fmt(g.expected)}）`).join('；')));if(step.dynamic)row.append(el('p','hint','含特殊能力，请结合角色情况选择。'));list.append(row);}summary.append(list);}
    else summary.append(el('p','hint','暂无已核实可重复、敌人数据完整的地图安排。'));
    if(farming.unresolved.length||itinerary.uncovered.length)summary.append(el('p','reason',`尚未覆盖：${[...farming.unresolved,...itinerary.uncovered].map(m=>`${m.name} × ${fmt(m.quantity)}`).join('、')}。以上为部分来源，不能据此视为整件已配齐。`));content.append(summary);
    const toolbar=el('div','farming-toolbar'),filter=el('select'),order=el('select');filter.setAttribute('aria-label','对比材料');order.setAttribute('aria-label','地图排序');
    for(const m of [{itemId:'',name:'全部刷取材料'},...farming.targets]){const option=el('option','',m.name);option.value=m.itemId;filter.append(option);}if(!farming.targets.some(m=>m.itemId===focus))focus='';filter.value=focus;
    for(const [id,name]of [['easy','较低难度'],['mobs','目标怪更多'],['yield','理论产出更高']]){const option=el('option','',name);option.value=id;order.append(option);}order.value=sort;
    filter.onchange=()=>{focus=filter.value;renderPlan();};order.onchange=()=>{sort=order.value;renderPlan();};toolbar.append(filter,order);content.append(el('h4','','地图对比'),toolbar);
    const metrics=m=>{const outputs=m.outputs.filter(o=>!focus||o.itemId===focus);return {outputs,coverage:outputs.length,yield:focus?(outputs[0]?.expected??0):outputs.reduce((s,o)=>s+Math.min(1,o.expected/o.quantity),0),share:focus?(outputs[0]?.enemyShare??0):m.targetShare,count:focus?(outputs[0]?.enemyCount??0):m.targetCount,enemies:focus?(outputs[0]?.enemies??[]):m.enemies};};
    const easy=(a,b)=>(!a.difficulty)-(!b.difficulty)||(a.difficulty?.maxRealm??Infinity)-(b.difficulty?.maxRealm??Infinity)||(a.difficulty?.peakHp??Infinity)-(b.difficulty?.peakHp??Infinity)||(a.difficulty?.peakAttack??Infinity)-(b.difficulty?.peakAttack??Infinity);
    const maps=farming.maps.filter(m=>metrics(m).coverage).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||(!focus?metrics(b).coverage-metrics(a).coverage:0)||(sort==='easy'?easy(a,b):sort==='mobs'?metrics(b).share-metrics(a).share:metrics(b).yield-metrics(a).yield)||a.name.localeCompare(b.name,'zh-CN'));
    if(!maps.length)content.append(el('p','muted','目前没有已核实的地图来源。先刷新图鉴与地点目录，或切换材料路线。'));
    if(!focus&&sort==='yield')content.append(el('p','hint','多材料收益按每种缺料的每轮补足比例之和排序（单种最多计 100%），避免把不同材料数量直接相加。'));
    for(const m of maps){const card=el('article','farming-map');card.append(el('h4','',`${m.regionName} / ${m.name}`),el('span','tag',m.eligible?'可重复普通关卡':m.challenge?'一次性挑战':'尚未核实可用'));
      card.append(el('p','',`目标怪占比 ${percent(metrics(m).share)} · 预计 ${fmt(metrics(m).count)} / ${fmt(m.totalEnemies)} 只每轮 · ${m.groups} 波 · 每波 ${m.groupSize} 只`));
      card.append(el('p','',metrics(m).enemies.map(e=>`${e.name} 约 ${fmt(e.count)} 只`).join('、')));
      for(const o of metrics(m).outputs)card.append(el('p','',`${o.name}：约 ${fmt(o.expected)} / 轮`));
      card.append(el('p','hint',m.difficulty?`难度依据：最高境界 ${m.difficulty.maxRealmLabel} · 峰值每波气血 ${fmt(m.difficulty.peakHp)} / 攻击 ${fmt(m.difficulty.peakAttack)} · 地图倍率 ×${m.multiplier}`:'存在未遭遇敌人，难度未能完整核实；掉落仅统计已知来源。'));
      if(m.abilities.length)card.append(el('p','hint','特性：'+m.abilities.map(k=>skills[k]??k).join('、')));
      if(m.dynamic)card.append(el('p','reason','含特殊减伤、反震或随角色变化的能力，基础属性排序不能代表实际战斗难度。'));content.append(card);
    }
  }
  async function requestPlan(){
    if(!current||!token)return;const request=++sequence,key=current.item.key;text('farming-message','正在计算材料链与地图来源…');
    try{const response=await fetch('/api/farming/plan',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({recipeKey:key,quantity:Number($('farming-quantity').value),ignoreStock:$('farming-ignore-stock').checked,choices,scope,materialId:materialId||undefined,materialQuantity:Number($('farming-material-quantity').value)})});const value=await response.json();if(request!==sequence||key!==current?.item.key)return;if(!response.ok)throw new Error(value.error);plan=value;renderPlan();}
    catch(error){if(request===sequence){plan=null;$('farming-content').replaceChildren();text('farming-message',error.message);}}
  }
  try{const saved=localStorage.getItem('control-bestiary-order');if(saved==='reverse')$('bestiary-order').value=saved;}catch{}
  $('bestiary-order').onchange=()=>{try{localStorage.setItem('control-bestiary-order',$('bestiary-order').value);}catch{}renderBestiary();};
  $('farming-whole').onclick=()=>changeScope('whole');$('farming-single').onclick=()=>changeScope('single');
  $('farming-material').onchange=()=>{materialId=$('farming-material').value;void requestPlan();};$('farming-material-quantity').onchange=()=>void requestPlan();
  $('bestiary-search').oninput=renderBestiary;$('bestiary-refresh').onclick=()=>window.GameDataSync.refresh();
  $('farming-ignore-stock').onchange=()=>void requestPlan();$('farming-quantity').onchange=()=>void requestPlan();
  $('farming-reload').onclick=async()=>{text('farming-message','正在排队同步图鉴、掉落与地图，完成后自动更新推荐…');const job=await send('bestiary');if(!job)text('farming-message','资料同步未提交，请先打开游戏并查看面板提示。');};
  window.addEventListener('recipe-detail',event=>{
    const value=event.detail;if(value?.view!=='crafting'){current=null;sequence++;$('farming').hidden=true;return;}
    const changed=current?.item.key!==value.item.key;current=value;$('farming').hidden=false;if(changed){choices={};plan=null;focus='';scope='whole';materialId='';expanded=new Set(['root']);$('farming-material-quantity').value='1';renderScope();$('farming-quantity').value='1';$('farming-ignore-stock').checked=false;$('farming-content').replaceChildren();void ensureBestiary();void requestPlan();}
  });
  window.addEventListener('battle-state',event=>{
    const previous=state;state=event.detail;
    // Cache reads are safe even before scroll restoration has made the open
    // section visible; game reads remain gated by the shared visibility timer.
    if(state.bestiary?.revision!==loadedRevision&&($('bestiary-fold').open||current))void loadBestiary();
    const busy=Boolean(state.busy);text('bestiary-refresh',busy?'↻ 排队刷新三项资料':'↻ 刷新行囊、炼制与图鉴');$('bestiary-refresh').disabled=false;
    if(state.bestiary?.error!==previous.bestiary?.error)renderBestiary();
    const catalogChanged=previous.catalog?.resourceUrl!==state.catalog?.resourceUrl||previous.catalog?.updatedAt!==state.catalog?.updatedAt||previous.catalog?.checkedAt!==state.catalog?.checkedAt;
    $('farming-reload').disabled=Boolean(state.busy||state.gameClosed||state.closingGame);
    if(current&&(previous.library?.revision!==state.library?.revision||previous.bestiary?.revision!==state.bestiary?.revision||previous.bestiary?.knowledgeRevision!==state.bestiary?.knowledgeRevision||catalogChanged))void requestPlan();
    if(current&&state.lastCommand?.id!==previous.lastCommand?.id&&state.lastCommand?.kind==='bestiary'&&!state.lastCommand.ok)text('farming-message','资料同步未完成：'+state.lastCommand.error);
  });
  new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);if(visible&&token)void loadBestiary();}).observe($('bestiary-content'));
  window.addEventListener('section-toggle',event=>{if(event.detail.id==='bestiary'&&event.detail.open)void loadBestiary();});
})();
