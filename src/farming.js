import { orderMarrows } from './marrow-order.js';

const number = v => {const n=Number(String(v??0).replaceAll(',',''));return Number.isFinite(n)&&n>=0?n:0;};
const cap = n => Math.min(Number.MAX_SAFE_INTEGER,n);
function sourceCheck(knowledge,bestiary,availableRecipes){
  const seen=new Set(bestiary?.entries?.map(e=>e.id)??[]),dropped=new Set(knowledge.enemies.filter(e=>seen.has(e.id)).flatMap(e=>e.loot.filter(l=>number(l.chance)>0).map(l=>l.itemId)));
  const recipes=knowledge.recipes.filter(r=>availableRecipes.has(r.id));
  // Grow a finite closure instead of recursively revisiting alternative routes.
  // Exclude the candidate's output so a circular route cannot prove itself.
  const checked=new Map();
  return recipe=>{
    if(!checked.has(recipe.output)){
      const reachable=new Set(dropped);reachable.delete(recipe.output);let changed=true;
      while(changed){changed=false;for(const route of recipes)if(route.output!==recipe.output&&!reachable.has(route.output)&&Object.keys(route.materials).every(id=>reachable.has(id))){reachable.add(route.output);changed=true;}}
      checked.set(recipe.output,reachable);
    }
    return Object.keys(recipe.materials).every(id=>checked.get(recipe.output).has(id));
  };
}
export function groupLoot(loot, items) {
  const groups=[];
  for(const row of loot??[]){if(number(row.chance)<=0)continue;let g=groups.find(x=>x.itemId===row.itemId&&x.chance===number(row.chance)&&x.ignoreLuck===Boolean(row.ignoreLuck));
    if(g)g.rolls++;else groups.push({itemId:row.itemId,name:items.find(i=>i.id===row.itemId)?.name??row.itemId,chance:number(row.chance),rolls:1,ignoreLuck:Boolean(row.ignoreLuck)});
  }
  return groups.map(g=>({...g,guaranteed:Math.floor(g.chance),extraChance:g.chance%1,expected:g.chance*g.rolls,atLeastOne:g.chance>=1?1:1-(1-g.chance)**g.rolls}));
}
export function bestiaryView(knowledge,bestiary,catalog){
  if(!knowledge||!bestiary)return {revision:0,entries:[],updatedAt:null};
  const stale=knowledge.revision!==bestiary.knowledgeRevision||knowledge.resourceUrl!==bestiary.resourceUrl;
  return {revision:bestiary.revision,updatedAt:bestiary.updatedAt,stale,unknown:bestiary.unknown??[],entries:bestiary.entries.map(seen=>{
    const e=knowledge.enemies.find(x=>x.id===seen.id);if(!e)return {...seen,unknown:true};
    return {...e,...seen,loot:groupLoot(e.loot,knowledge.items),locations:knowledge.maps.filter(m=>[m.pool,...Object.values(m.encounterPools)].some(p=>p.includes(e.id))).map(m=>{const node=catalog?.nodes?.find(n=>n.id===m.id);return {id:m.id,name:m.name,regionName:node?.regionName??'',availability:node?.availability??'unverified',challenge:m.challenge};})};
  })};
}
export function linkLibrary(data,knowledge){
  if(!knowledge)return data;
  return {...data,items:data.items.map(item=>{
    const matches=knowledge.items.filter(i=>i.name===item.name);
    let recipe;
    if(data.view==='crafting'){
      const candidates=knowledge.recipes.filter(r=>r.type===item.recipeType);
      const exact=candidates.filter(r=>r.name===item.name);
      const output=candidates.filter(r=>knowledge.items.find(i=>i.id===r.output)?.name===item.name);
      recipe=(exact.length?exact:output);
      const difficulty=/难度\s*(\d+)/u.exec(item.summary??'')?.[1],produced=/成功产出\s*(\d+)/u.exec(item.aria??'')?.[1];
      if(difficulty!=null&&recipe.length>1)recipe=recipe.filter(r=>r.difficulty===Number(difficulty));
      if(produced!=null)recipe=recipe.filter(r=>r.outputCount===Number(produced));
      recipe=recipe.length===1?recipe[0]:null;
    }
    return {...item,gameItemId:recipe?.output??(matches.length===1?matches[0].id:null),slot:matches.length===1?matches[0].slot??null:null,equipped:item.equipped??null,recipeId:recipe?.id??null};
  })};
}

export function recommendMaps(knowledge,bestiary,catalog,missing,{includeEmpty=false}={}){
  const seen=new Set((bestiary?.entries??[]).map(e=>e.id)),targets=new Set(missing.map(x=>x.itemId));
  const enemies=new Map(knowledge.enemies.map(e=>[e.id,e])),rows=[];
  for(const map of knowledge.maps){
    const node=catalog?.nodes?.find(n=>n.id===map.id),yields=Object.fromEntries([...targets].map(id=>[id,0])),counts=new Map(),materialCounts=new Map([...targets].map(id=>[id,new Map()]));
    let total=0,targetCount=0,maxRealm=-1,maxRealmLabel='',peakHp=0,peakAttack=0,unknown=false,dynamic=false;
    const abilities=new Set(),encounters=new Map();
    for(let wave=1;wave<=map.groups;wave++){
      const pool=map.encounterPools[wave]??map.pool,groupSize=map.randomGroupSize?1.5:map.groupSize,peakSize=map.randomGroupSize?2:map.groupSize;
      total+=groupSize;let waveHp=0,waveAttack=0;
      if(!pool.length)unknown=true;
      for(const id of pool){
        if(includeEmpty)encounters.set(id,(encounters.get(id)??0)+groupSize/pool.length);
        const e=enemies.get(id);if(!seen.has(id)||!e){unknown=true;continue;}
        if(e.realm>maxRealm){maxRealm=e.realm;maxRealmLabel=e.realmLabel||bestiary.entries.find(x=>x.id===e.id)?.summary?.split('·')[0]?.trim()||`境界档 ${e.realm}`;}
        waveHp=Math.max(waveHp,number(e.stats.maxHp)*map.enemyMultiplier);waveAttack=Math.max(waveAttack,number(e.stats.attack)*map.enemyMultiplier);
        for(const [a,v] of Object.entries(e.abilities??{})){if(v){abilities.add(a);if(['entryStatRatio','entryHealthRatio','entryAgilityAttackRatio','sturdy','reflectionRatio'].includes(a))dynamic=true;}}
        const weight=groupSize/pool.length;let hit=false;
        const matched=new Set();
        for(const drop of e.loot){if(!targets.has(drop.itemId)||number(drop.chance)<=0)continue;hit=true;matched.add(drop.itemId);yields[drop.itemId]+=weight*number(drop.chance)*(drop.ignoreLuck?1:map.enemyMultiplier);}
        for(const itemId of matched){const count=materialCounts.get(itemId);count.set(id,(count.get(id)??0)+weight);}
        if(hit){targetCount+=weight;counts.set(id,(counts.get(id)??0)+weight);}
      }
      peakHp=Math.max(peakHp,waveHp*peakSize);peakAttack=Math.max(peakAttack,waveAttack*peakSize);
    }
    const outputs=missing.filter(x=>yields[x.itemId]>0).map(x=>{const list=[...materialCounts.get(x.itemId)].map(([id,count])=>({id,name:enemies.get(id).name,count})),enemyCount=list.reduce((s,e)=>s+e.count,0);return {...x,expected:yields[x.itemId],enemyCount,enemyShare:total?enemyCount/total:0,enemies:list};});if(!outputs.length&&!includeEmpty)continue;
    rows.push({id:map.id,name:map.name,regionName:node?.regionName??'',availability:node?.availability??'unverified',challenge:map.challenge,
      eligible:node?.availability==='visible'&&!map.challenge,groups:map.groups,groupSize:map.randomGroupSize?'1–2':String(map.groupSize),multiplier:map.enemyMultiplier,
      outputs,coverage:outputs.length,totalEnemies:total,targetCount,targetShare:total?targetCount/total:0,
      enemies:[...counts].map(([id,count])=>({id,name:enemies.get(id).name,count})),unknown,dynamic,
      difficulty:unknown?null:{maxRealm,maxRealmLabel,peakHp,peakAttack},abilities:[...abilities],
      ...(includeEmpty?{encounters:[...encounters].map(([id,count])=>({id,count,known:seen.has(id)&&enemies.has(id)}))}:{})});
  }
  return rows;
}

function dropMaps({knowledge,bestiary,catalog},selected,stale,options){
  const nodes=new Map((catalog?.nodes??[]).map(n=>[n.id,n]));
  return recommendMaps(knowledge,bestiary,catalog,selected.map(i=>({itemId:i.id,name:i.name,quantity:1})),options).map(m=>{
    const reasons=[];
    if(stale)reasons.push('数据版本待核实');
    if(m.challenge)reasons.push('独立挑战');
    else if(nodes.get(m.id)?.type!=='battle')reasons.push('普通关卡类型待核实');
    if(m.availability!=='visible')reasons.push(m.availability==='locked'?'地图锁定':'地图可用情况待核实');
    if(m.unknown)reasons.push('含未遭遇敌人，仅统计已知掉落');
    return {...m,expectedTotal:m.outputs.reduce((sum,o)=>sum+o.expected,0),eligible:reasons.length===0,reasons};
  }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.expectedTotal-a.expectedTotal||a.id.localeCompare(b.id));
}

// Read-only projection of the same encounter/drop model used by recipe farming.
// No inventory deficit, recipe, game navigation or automation setting is needed.
export function marrowFarming({knowledge,bestiary,catalog},payload={}){
  if(!knowledge)throw new Error('请先刷新敌人图鉴，建立掉落数据');
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('灵髓选择无效');
  const items=orderMarrows(knowledge.items.filter(i=>i.kind==='marrow')).map(({id,name})=>({id,name}));
  const ids=payload.itemIds??items.map(i=>i.id);
  if(!Array.isArray(ids)||!ids.length||ids.length>items.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!items.some(i=>i.id===id)))throw new Error('请选择目录中的灵髓种类');
  const selected=items.filter(i=>ids.includes(i.id));
  const stale=bestiary?.knowledgeRevision!==knowledge.revision||bestiary?.resourceUrl!==knowledge.resourceUrl||catalog?.resourceUrl!==knowledge.resourceUrl;
  const warnings=[];
  if(!bestiary?.updatedAt)warnings.push('尚未读取已遭遇敌人，请刷新图鉴。');
  if(stale)warnings.push('图鉴与地图资源版本未对齐，请刷新图鉴和地图状态；以下仅供参考。');
  const maps=dropMaps({knowledge,bestiary,catalog},selected,stale);
  const ranked=maps.filter(m=>m.eligible),best=ranked[0]??null;
  const bestByItem=selected.map(item=>{
    const rows=ranked.map(m=>({mapId:m.id,name:m.name,regionName:m.regionName,expected:m.outputs.find(o=>o.itemId===item.id)?.expected??0})).filter(m=>m.expected>0).sort((a,b)=>b.expected-a.expected||a.mapId.localeCompare(b.mapId));
    return {...item,best:rows[0]??null,ties:rows.filter(m=>Math.abs(m.expected-(rows[0]?.expected??0))<1e-9).length};
  });
  return {items,selected,maps,bestMapId:best?.id??null,bestTies:ranked.filter(m=>Math.abs(m.expectedTotal-(best?.expectedTotal??0))<1e-9).length,bestByItem,warnings,stale,
    bestiaryAt:bestiary?.updatedAt??null,catalogAt:catalog?.checkedAt??null,
    note:'按完整通关一轮计算，沿用炼制原料刷取的遭遇池、波数、掉落判定及地图倍率；不含个人气运，不是每分钟收益，也不保证当前角色能通关。多种灵髓合计按件数等权相加。'};
}

function materialImages(knowledge,library){
  const byId=new Map(knowledge.items.map(item=>[item.id,item])),byName=new Map(),images=new Map();
  for(const item of knowledge.items){const ids=byName.get(item.name)??[];ids.push(item.id);byName.set(item.name,ids);}
  const recipes=new Map(knowledge.recipes.map(recipe=>[recipe.id,recipe.output]));
  const rows=[...(library?.views?.inventory?.items??[]),...(library?.views?.crafting?.items??[]),...Object.values(library?.details??{})]
    .filter(row=>/^\/api\/library\/images\/[a-f0-9]{64}$/u.test(row.image??''));
  // An exact item/recipe ID takes precedence over older name-only caches.
  // Reuse observed image routes; never guess asset URLs or merge namesakes.
  for(const row of rows){const id=row.gameItemId??recipes.get(row.recipeId);if(byId.has(id)&&!images.has(id))images.set(id,row.image);}
  for(const row of rows){
    if(row.gameItemId||row.recipeId)continue;
    const ids=byName.get(row.name);if(ids?.length===1&&!images.has(ids[0]))images.set(ids[0],row.image);
  }
  return images;
}

export function materialFarming({knowledge,bestiary,catalog,library},payload={}){
  if(!knowledge)throw new Error('请先同步图鉴与地图，建立炼材掉落数据');
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)throw new Error('炼材排行不需要选择物品，搜索和筛选在面板完成');
  const images=materialImages(knowledge,library);
  const selected=knowledge.items.filter(i=>['part','material'].includes(i.kind)).map(({id,name,kind})=>({id,name,kind,image:images.get(id)??null}));
  const stale=bestiary?.knowledgeRevision!==knowledge.revision||bestiary?.resourceUrl!==knowledge.resourceUrl||catalog?.resourceUrl!==knowledge.resourceUrl;
  const warnings=[];
  if(!bestiary?.updatedAt)warnings.push('尚未读取已遭遇敌人，请同步图鉴与地图。');
  if(stale)warnings.push('图鉴与地图资源版本未对齐，请同步资料；以下仅供参考。');
  // Compute all materials in one pass through the encounter pools. The winner
  // for each item is chosen from its own yield, never the map's total loot.
  const maps=dropMaps({knowledge,bestiary,catalog},selected,stale);
  const enemies=new Map(knowledge.enemies.map(e=>[e.id,e]));
  for(const map of maps)for(const output of map.outputs)output.enemies=output.enemies.map(enemy=>({...enemy,
    loot:groupLoot(enemies.get(enemy.id).loot.filter(l=>l.itemId===output.itemId),knowledge.items)}));
  const items=selected.map(item=>{
    const rows=maps.filter(m=>m.eligible).map(m=>({mapId:m.id,name:m.name,regionName:m.regionName,expected:m.outputs.find(o=>o.itemId===item.id)?.expected??0}))
      .filter(m=>m.expected>0).sort((a,b)=>b.expected-a.expected||a.mapId.localeCompare(b.mapId));
    const best=rows[0]??null,hasReference=maps.some(m=>m.outputs.some(o=>o.itemId===item.id));
    const direct=knowledge.enemies.some(e=>e.loot.some(l=>l.itemId===item.id&&number(l.chance)>0));
    const craftable=knowledge.recipes.some(r=>r.output===item.id);
    const reason=best?'':stale?'资料版本待同步':hasReference?'仅有未核实、锁定或挑战来源':direct?'当前图鉴尚无已核实掉落来源':craftable?'暂无直接掉落，可通过炼制获得':'当前数据没有直接掉落来源';
    return {...item,best,ties:best?rows.filter(m=>Math.abs(m.expected-best.expected)<1e-9).length:0,reason};
  }).sort((a,b)=>Number(Boolean(b.best))-Number(Boolean(a.best))||a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));
  return {items,maps,stale,warnings,bestiaryAt:bestiary?.updatedAt??null,catalogAt:catalog?.checkedAt??null,
    note:'逐种比较完整通关一轮的理论掉落件数，计入遭遇池、波数和地图倍率；不是单次爆率或每分钟收益，不含个人气运。仅统计直接掉落，不折算合成产量。'};
}

// The same wave/pool calculation, projected by map and then by enemy. Include
// zero-drop and unknown maps so absence of evidence is never shown as no drops.
export function mapFarming({knowledge,bestiary,catalog},payload={}){
  if(!knowledge)throw new Error('请先同步图鉴与地图，建立地图掉落数据');
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)throw new Error('地图筛选在面板完成，无需提交额外参数');
  const items=knowledge.items.filter(i=>['part','material'].includes(i.kind));
  const itemById=new Map(items.map(i=>[i.id,i])),enemies=new Map(knowledge.enemies.map(e=>[e.id,e]));
  const stale=bestiary?.knowledgeRevision!==knowledge.revision||bestiary?.resourceUrl!==knowledge.resourceUrl||catalog?.resourceUrl!==knowledge.resourceUrl;
  const warnings=[];
  if(!bestiary?.updatedAt)warnings.push('尚未读取已遭遇敌人，掉落统计暂不完整。');
  if(stale)warnings.push('图鉴与地图资源版本未对齐，请同步资料；以下仅供参考。');
  const stats=new Map(dropMaps({knowledge,bestiary,catalog},items,stale,{includeEmpty:true}).map(map=>{
    const enemyRows=map.encounters.map(encounter=>{
      const definition=enemies.get(encounter.id),loot=new Map();
      if(encounter.known)for(const drop of groupLoot(definition.loot.filter(l=>itemById.has(l.itemId)),knowledge.items)){
        const row=loot.get(drop.itemId)??{itemId:drop.itemId,name:drop.name,kind:itemById.get(drop.itemId).kind,perKill:0,expected:0,rolls:[]};
        row.perKill+=drop.expected*(drop.ignoreLuck?1:map.multiplier);row.rolls.push(drop);loot.set(drop.itemId,row);
      }
      for(const row of loot.values())row.expected=row.perKill*encounter.count;
      return {...encounter,name:encounter.known?definition.name:'未遭遇或未识别的怪物',loot:[...loot.values()].sort((a,b)=>b.expected-a.expected||a.itemId.localeCompare(b.itemId))};
    });
    const outputs=map.outputs.map(o=>({...o,kind:itemById.get(o.itemId).kind})).sort((a,b)=>b.expected-a.expected||a.itemId.localeCompare(b.itemId));
    const unknownCount=Math.max(0,map.totalEnemies-enemyRows.filter(e=>e.known).reduce((sum,e)=>sum+e.count,0));
    return [map.id,{...map,outputs,enemies:enemyRows,unknownCount}];
  }));
  return {maps:knowledge.maps.map(m=>stats.get(m.id)),stale,warnings,bestiaryAt:bestiary?.updatedAt??null,catalogAt:catalog?.checkedAt??null,
    note:'按完整通关一轮统计炼材与材料的直接掉落，计入遭遇池、波数和地图倍率；不含装备、个人气运和合成产量。期望是长期平均值，不保证单轮必得，也不代表每分钟收益。'};
}

// Allocate whole rounds by their contribution to each original material gap.
// Joint drops reduce every remaining gap before choosing the next map. This is
// a bounded heuristic, not a guarantee of minimum rounds or actual drop timing.
export function allocateFarmingMaps(maps,targets){
  const remaining=new Map(targets.map(t=>[t.itemId,t.quantity])),steps=[];
  const candidates=maps.filter(m=>m.eligible&&!m.unknown);
  for(let n=0;n<targets.length;n++){
    const ranked=candidates.map(map=>({map,score:map.outputs.reduce((sum,o)=>sum+Math.min(o.expected,remaining.get(o.itemId)??0)/targets.find(t=>t.itemId===o.itemId).quantity,0)}))
      .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.map.coverage-a.map.coverage||(a.map.difficulty?.maxRealm??Infinity)-(b.map.difficulty?.maxRealm??Infinity)||a.map.id.localeCompare(b.map.id));
    if(!ranked.length)break;
    const map=ranked[0].map,active=map.outputs.filter(o=>(remaining.get(o.itemId)??0)>1e-8&&o.expected>0);
    if(!active.length)break;
    const rounds=cap(Math.max(1,Math.min(...active.map(o=>Math.ceil(remaining.get(o.itemId)/o.expected)))));
    const gains=active.map(o=>{const required=remaining.get(o.itemId),expected=rounds*o.expected,credited=Math.min(required,expected);remaining.set(o.itemId,Math.max(0,required-expected));return {itemId:o.itemId,name:o.name,expected,credited};});
    steps.push({mapId:map.id,name:map.name,regionName:map.regionName,rounds,gains,dynamic:map.dynamic});
  }
  return {steps,totalRounds:cap(steps.reduce((n,s)=>n+s.rounds,0)),uncovered:targets.filter(t=>(remaining.get(t.itemId)??0)>1e-8).map(t=>({...t,quantity:remaining.get(t.itemId)}))};
}

export function planFarmingSources({knowledge,bestiary,catalog,stock,availableRecipes,choices,stale,itemId,quantity,root,ignoreStock}){
  const items=new Map(knowledge.items.map(i=>[i.id,i])),seen=new Set(bestiary?.entries?.map(e=>e.id)??[]);
  const farmable=sourceCheck(knowledge,bestiary,availableRecipes);
  const sources=id=>knowledge.enemies.filter(e=>seen.has(e.id)&&e.loot.some(l=>l.itemId===id&&number(l.chance)>0)).map(e=>({id:e.id,name:e.name,loot:groupLoot(e.loot.filter(l=>l.itemId===id),knowledge.items)}));
  const canMake=(r,amount,balance)=>Object.entries(r.materials).every(([id,n])=>(balance.get(id)??0)>=n*Math.ceil(amount/r.outputCount));
  function collect(startingStock){
    const ledger=new Map(startingStock),targets=new Map(),unresolved=new Map(),used=new Map();let count=0;
    const add=(rows,id,amount,via,issue)=>{const row=rows.get(id)??{itemId:id,name:items.get(id)?.name??id,quantity:0,via:[],...(issue?{issue}:{sources:sources(id)})};row.quantity=cap(row.quantity+amount);const path=via.map(mid=>items.get(mid)?.name??mid).join(' → ');if(path&&!row.via.includes(path))row.via.push(path);rows.set(id,row);};
    function walk(id,amount,ancestors=[],forced){
      if(++count>2000||ancestors.length>32)throw new Error('刷取来源链过大，请缩小数量');
      const owned=forced?0:Math.min(ledger.get(id)??0,amount),need=amount-owned;
      if(!forced)ledger.set(id,(ledger.get(id)??0)-owned);
      if(!need)return;
      if(ancestors.includes(id)){add(unresolved,id,need,ancestors,'循环配方，无法继续追溯');return;}
      const recipes=forced?[forced]:knowledge.recipes.filter(r=>r.output===id&&availableRecipes.has(r.id)),drops=sources(id);
      const chosen=recipes.find(r=>r.id===choices[id])??recipes.find(r=>canMake(r,need,ledger))??recipes.find(farmable)??recipes[0];
      const direct=!forced&&drops.length&&(choices[id]==='drop:'+id||!choices[id]&&!recipes.some(r=>canMake(r,need,ledger)));
      if(direct||!chosen&&drops.length){add(targets,id,need,ancestors);return;}
      if(!chosen){add(unresolved,id,need,ancestors,'已遭遇图鉴无直接掉落，且没有可用的合成配方');return;}
      const batches=Math.ceil(need/chosen.outputCount),record=used.get(chosen.id)??{id:chosen.id,name:chosen.name,batches:0};record.batches+=batches;used.set(chosen.id,record);
      for(const [mid,n] of Object.entries(chosen.materials))walk(mid,cap(n*batches),[...ancestors,id]);
      ledger.set(id,(ledger.get(id)??0)+batches*chosen.outputCount-need);
    }
    walk(itemId,quantity,[],root);return {targets:[...targets.values()],unresolved:[...unresolved.values()],recipes:[...used.values()]};
  }
  let result=collect(ignoreStock?new Map():stock);
  const inventorySatisfied=!ignoreStock&&!result.targets.length&&!result.unresolved.length;
  if(inventorySatisfied)result=collect(new Map());
  const maps=recommendMaps(knowledge,bestiary,catalog,result.targets);if(stale)maps.forEach(m=>m.eligible=false);
  return {...result,itemId,name:items.get(itemId)?.name??itemId,quantity,inventorySatisfied,basis:ignoreStock?'from-zero':inventorySatisfied?'reference':'shortage',maps,
    itinerary:allocateFarmingMaps(maps,result.targets)};
}

export function farmingPlan({knowledge,bestiary,catalog,library},payload={}){
  if(!knowledge)throw new Error('请先读取敌人图鉴，建立游戏数据目录');
  const quantity=payload.quantity??1;if(!Number.isSafeInteger(quantity)||quantity<1||quantity>10000)throw new Error('目标数量须为 1–10000');
  const choices=payload.choices??{};if(typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).length>200)throw new Error('路线选择无效');
  const scope=payload.scope??'whole';if(!['whole','single'].includes(scope))throw new Error('刷取范围无效');
  const materialQuantity=payload.materialQuantity??1;if(!Number.isSafeInteger(materialQuantity)||materialQuantity<1||materialQuantity>10000)throw new Error('材料数量须为 1–10000');
  const linked=linkLibrary({...library.views.crafting,view:'crafting',items:library.views.crafting?.items??[]},knowledge);
  const selected=linked.items.find(i=>i.key===payload.recipeKey);
  const root=knowledge.recipes.find(r=>r.id===selected?.recipeId);if(!root)throw new Error('该配方与游戏定义无法唯一对应，请刷新图鉴和炉鼎');
  const itemById=new Map(knowledge.items.map(i=>[i.id,i])),availableRecipes=new Set(linked.items.map(i=>i.recipeId).filter(Boolean));
  const inventory=linkLibrary({...library.views.inventory,view:'inventory',items:library.views.inventory?.items??[]},knowledge);
  const stock=new Map(),instances=new Map();for(const i of inventory.items){if(!i.gameItemId||i.equipped)continue;stock.set(i.gameItemId,cap((stock.get(i.gameItemId)??0)+number(i.quantity??1)));if(i.identity){const list=instances.get(i.gameItemId)??[];list.push({id:i.identity,quality:i.quality});instances.set(i.gameItemId,list);}}
  if(payload.ignoreStock===true)stock.clear();
  const ledger=new Map(stock),nodes=[],missing=new Map(),warnings=new Set(),routeOptions=new Map();let nodeCount=0;
  const farmable=sourceCheck(knowledge,bestiary,availableRecipes);
  const canMake=(r,amount,balance)=>Object.entries(r.materials).every(([id,n])=>(balance.get(id)??0)>=n*Math.ceil(amount/r.outputCount));
  function expand(id,amount,path,ancestors,forceRecipe,reference=false,balance=ledger){
    if(++nodeCount>2000||ancestors.size>32)throw new Error('材料链过大，请缩小目标数量');
    const item=itemById.get(id);const owned=forceRecipe?0:Math.min(balance.get(id)??0,amount);
    if(!forceRecipe)balance.set(id,(balance.get(id)??0)-owned);
    const shortage=amount-owned,node={itemId:id,name:item?.name??id,path,reference,required:amount,owned,shortage,instances:instances.get(id)??[],children:[]};
    // Keep the replenishment recipe visible without spending sibling inventory
    // or adding reference-only ingredients to the real shortage ledger.
    if(!shortage){const source=expand(id,amount,path,ancestors,forceRecipe,true,new Map());return {...source,...node,children:source.children,recipeId:source.recipeId,recipeName:source.recipeName,alternatives:source.alternatives,batches:source.batches,outputCount:source.outputCount,chance:source.chance,issue:source.issue,sourcePreview:true};}
    if(ancestors.has(id)){node.issue='循环配方，未继续展开';warnings.add(node.issue);if(!reference)missing.set(id,(missing.get(id)??0)+shortage);return node;}
    const recipes=forceRecipe?[forceRecipe]:knowledge.recipes.filter(r=>r.output===id&&availableRecipes.has(r.id));
    const routes=recipes.map(r=>({id:r.id,name:r.name,type:r.type,outputCount:r.outputCount,canMake:canMake(r,shortage,balance),farmable:farmable(r),materials:Object.entries(r.materials).map(([mid,n])=>({itemId:mid,name:itemById.get(mid)?.name??mid,required:n*Math.ceil(shortage/r.outputCount),owned:Math.min(balance.get(mid)??0,n*Math.ceil(shortage/r.outputCount))}))}));
    const directDrop=!forceRecipe&&knowledge.enemies.some(e=>bestiary?.entries?.some(s=>s.id===e.id)&&e.loot.some(l=>l.itemId===id&&Number(l.chance)>0));
    if(directDrop&&recipes.length)routes.push({id:'drop:'+id,name:'直接刷取'+node.name,type:'掉落',canMake:false,materials:[]});
    let chosen=recipes.find(r=>r.id===choices[id])??recipes.find(r=>canMake(r,shortage,balance))??recipes.find(farmable)??recipes[0];
    if(choices[id]&&!routes.some(r=>r.id===choices[id]))throw new Error(`「${node.name}」路线已变化，请重新选择`);
    if(choices[id]==='drop:'+id)chosen=null;
    node.alternatives=routes;node.recipeId=chosen?.id;node.recipeName=chosen?.name;
    if(routes.length>1&&(!reference||!routeOptions.has(id)))routeOptions.set(id,{itemId:id,name:node.name,selected:chosen?.id??'drop:'+id,alternatives:routes});
    if(!chosen){if(!reference)missing.set(id,(missing.get(id)??0)+shortage);node.issue=directDrop?'可直接刷取':'无可用合成配方，且已遭遇图鉴暂无掉落来源';return node;}
    node.batches=Math.ceil(shortage/chosen.outputCount);node.outputCount=chosen.outputCount;
    const tile=linked.items.find(i=>i.recipeId===chosen.id);node.chance=tile?.chance??'未核实';
    if(!/必成|100%/u.test(node.chance))warnings.add('部分配方成功率不足 100% 或尚未核实；以下为成功完成所需最低用量，失败会增加消耗。');
    const next=new Set(ancestors);next.add(id);
    for(const [mid,n] of Object.entries(chosen.materials))node.children.push(expand(mid,cap(n*node.batches),path+'/'+mid,next,undefined,reference,balance));
    // Excess output is available to later sibling branches, not counted twice.
    balance.set(id,(balance.get(id)??0)+node.batches*chosen.outputCount-shortage);
    return node;
  }
  nodes.push(expand(root.output,quantity,'root',new Set(),root));
  if(!inventory.updatedAt)warnings.add('尚无库存快照，暂按未持有材料计算；请手动刷新行囊与炉鼎。');
  if(inventory.items.some(i=>!i.gameItemId))warnings.add('部分库存无法唯一对应物品定义，未计入抵扣，请核对行囊。');
  const seen=new Set((bestiary?.entries??[]).map(x=>x.id));
  const shortages=[...missing].map(([id,amount])=>({itemId:id,name:itemById.get(id)?.name??id,quantity:amount,sources:knowledge.enemies.filter(e=>seen.has(e.id)&&e.loot.some(l=>l.itemId===id&&number(l.chance)>0)).map(e=>({id:e.id,name:e.name,loot:groupLoot(e.loot.filter(l=>l.itemId===id),knowledge.items)}))}));
  if(!bestiary?.updatedAt)warnings.add('尚未读取已遭遇敌人，来源暂不完整。');
  const stale=bestiary?.knowledgeRevision!==knowledge.revision||bestiary?.resourceUrl!==knowledge.resourceUrl||catalog?.resourceUrl!==knowledge.resourceUrl;
  if(stale)warnings.add('图鉴或地图资源版本未对齐，请刷新目录与图鉴；暂不提供确定推荐。');
  const maps=recommendMaps(knowledge,bestiary,catalog,shortages);if(stale)maps.forEach(m=>m.eligible=false);
  const materialOptions=new Map();const visit=n=>{if(n.itemId!==root.output)materialOptions.set(n.itemId,{itemId:n.itemId,name:n.name});n.children.forEach(visit);};visit(nodes[0]);
  const materialId=payload.materialId??materialOptions.keys().next().value;
  if(scope==='single'&&!materialOptions.has(materialId))throw new Error('请选择材料链中的物品');
  const farming=planFarmingSources({knowledge,bestiary,catalog,stock,availableRecipes,choices,stale,
    itemId:scope==='single'?materialId:root.output,quantity:scope==='single'?materialQuantity:quantity,root:scope==='whole'?root:null,ignoreStock:payload.ignoreStock===true});
  return {name:selected.name,quantity,tree:nodes[0],missing:shortages,routes:[...routeOptions.values()],maps,warnings:[...warnings],stale,materialOptions:[...materialOptions.values()],farming:{...farming,scope},
    libraryRevision:library.revision,knowledgeRevision:knowledge.revision,bestiaryRevision:bestiary?.revision??0,inventoryAt:inventory.updatedAt??null,
    note:'成功完成所需最低用量；地图为理论值，假设完成整轮，含已核实地图倍率，不含角色气运等个人加成。'};
}
