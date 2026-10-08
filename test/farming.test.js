import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge, parseGameDefinitions } from '../src/knowledge.js';
import { farmingPlan, recommendMaps, groupLoot, linkLibrary, allocateFarmingMaps } from '../src/farming.js';

const source=`
const material=(name)=>({name,kind:'material'});
const objects={ore:material('矿'),wood:material('木'),part:{name:'剑料',kind:'part'},sword:{name:'剑',kind:'equipment',slot:'weapon',blade:'part',hilt:'wood'},armor:{name:'甲',kind:'equipment',slot:'body'},hat:{name:'帽',kind:'equipment',slot:'head'}};
const loot=(itemId,chance)=>({itemId,chance});
const enemy=(id,name)=>({name,realm:1,definition:{id,stats:{maxHp:'10',attack:'2',defense:'1',agility:'1'},abilities:{}},loot:[loot('ore',.2)]});
const monsters=Object.fromEntries([enemy('rat','鼠')].map(e=>[e.definition.id,e]));
const maps={hill:{name:'山',pool:['rat'],groups:2,groupSize:1,encounterPools:{2:['rat']}}};
const recipes={part:{name:'剑料',path:'component',output:'part',materials:{ore:2},difficulty:0},a:{name:'木',path:'ordinary',output:'wood',materials:{ore:1},difficulty:1},b:{name:'木2',path:'ordinary',output:'wood',materials:{ore:2},difficulty:2}};
globalThis.DO_NOT_EXECUTE=1;throw new Error('never execute');
`;
test('map and loot projections share the exact downloaded resource without executing it',()=>{
  const definitions=source.replace("hill:{name:'山',pool", "hill:{...mapFactory('山','start',[]),name:'山',pool")+`
    const mapFactory=(name,prerequisite)=>({name,prerequisite});
    const regions=[{id:'north',name:'北境',locations:['hill','spring']},{id:'south',name:'南境',locations:['rest']}];
    const places={spring:{name:'泉',prerequisite:'hill',meditation:true},rest:{name:'台',prerequisite:'spring'}};
    const marrows={red:{name:'赤灵髓',kind:'marrow',marrowValue:100}};
  `;
  const bundle=parseGameDefinitions(definitions,'same-resource');
  assert.equal(bundle.catalog.resourceUrl,bundle.knowledge.resourceUrl);
  assert.equal(bundle.catalog.nodes.find(n=>n.id==='hill').type,'battle');
  assert.equal(bundle.knowledge.maps.find(n=>n.id==='hill').name,'山');assert.equal(globalThis.DO_NOT_EXECUTE,undefined);
});
test('bounded AST projector resolves renamed constructors and tables without executing the script',()=>{
  const k=parseKnowledge(source,'resource');assert.equal(k.enemies[0].name,'鼠');assert.equal(k.recipes.find(r=>r.type==='兵刃合炼').materials.part,1);assert.equal(globalThis.DO_NOT_EXECUTE,undefined);
  const renamed=source.replaceAll('objects','renamedItems').replaceAll('enemy','renamedEnemy').replaceAll('monsters','renamedMonsters');assert.equal(parseKnowledge(renamed).maps[0].groups,2);
  assert.throws(()=>parseKnowledge(source.replace("loot('ore',.2)","loot('missing',.2)")),/不完整/u);
});
test('unknown or side-effectful data constructors are rejected, rather than evaluated',()=>{
  assert.throws(()=>parseKnowledge(source.replace("({itemId,chance})","(fetch('http://invalid'),{itemId,chance})")),/不完整|静态/u);
  assert.equal(globalThis.DO_NOT_EXECUTE,undefined);
});

test('repeated loot tables preserve every independent roll and map yield',()=>{
  const updated=source.replace("loot:[loot('ore',.2)]","loot:[loot('wood',.1),...Array.from({length:4},()=>loot('ore',.4))]");
  const knowledge=parseKnowledge(updated,'resource'),enemy=knowledge.enemies[0];
  assert.deepEqual(enemy.loot.map(row=>[row.itemId,row.chance]),[['wood',.1],...Array(4).fill(['ore',.4])]);
  const ore=groupLoot(enemy.loot,knowledge.items).find(row=>row.itemId==='ore');
  assert.equal(ore.rolls,4);assert.equal(ore.expected,1.6);assert.ok(Math.abs(ore.atLeastOne-.8704)<1e-10);
  const bestiary={knowledgeRevision:knowledge.revision,resourceUrl:'resource',entries:[{id:'rat'}]};
  const catalog={resourceUrl:'resource',nodes:[{id:'hill',availability:'visible'}]};
  const [map]=recommendMaps(knowledge,bestiary,catalog,[{itemId:'ore',quantity:4}]);
  assert.ok(Math.abs(map.outputs[0].expected-3.2)<1e-10);assert.equal(globalThis.DO_NOT_EXECUTE,undefined);
});

test('repeated table callbacks bind local counts, undefined values and indices',()=>{
  const updated=source.replace("loot:[loot('ore',.2)]","loot:repeated('ore')")+`
    const repeated=(itemId,count=3)=>Array.from({length:count},(value,index)=>({itemId,chance:(index+1)/10,ignoreLuck:!value}));
  `;
  const loot=parseKnowledge(updated).enemies[0].loot;
  assert.deepEqual(loot.map(row=>row.chance),[.1,.2,.3]);assert.ok(loot.every(row=>row.itemId==='ore'&&row.ignoreLuck===true));
  for(const count of [0,3000])assert.equal(parseKnowledge(updated.replace("repeated('ore')",`repeated('ore',${count})`)).enemies[0].loot.length,count);
});

test('invalid, unbounded and non-length-only repeat tables fail closed',()=>{
  for(const shape of ['{length:-1}','{length:1.5}','{length:3001}','{length:1/0}','{length:"4"}','{length:unknownLength()}','{length:1,0:"ore"}','[]','null']){
    assert.throws(()=>parseKnowledge(source.replace("loot('ore',.2)",`...Array.from(${shape},()=>loot('ore',.4))`)),/重复数据|不完整|静态/u,shape);
  }
});

test('repeat tables reject unknown callbacks, extra arguments and shadowed Array',()=>{
  for(const expression of ['Array.from({length:4},unknownCallback)','Array.from({length:4},()=>fetch("http://invalid"))','Array.from({length:0},()=>loot("ore",.4),{})']){
    assert.throws(()=>parseKnowledge(source.replace("loot('ore',.2)",`...${expression}`)),/重复数据|不完整|静态/u,expression);
  }
  const repeated=source.replace("loot('ore',.2)","...Array.from({length:4},()=>loot('ore',.4))");
  assert.throws(()=>parseKnowledge(repeated+'const Array={from:()=>[]};'),/重复数据|不完整/u);
  assert.equal(globalThis.DO_NOT_EXECUTE,undefined);
});

test('knowledge preserves the game marrow potency for catalog-consistent chooser order',()=>{
  const k=parseKnowledge(source.replace("ore:material('矿')","high:{name:'高灵髓',kind:'marrow',marrowValue:1e5},low:{name:'低灵髓',kind:'marrow',marrowValue:2},ore:material('矿')"));
  assert.equal(k.items.find(i=>i.id==='high').marrowValue,100000);
  assert.equal(k.items.find(i=>i.id==='low').marrowValue,2);
});
const armorUpdate=`
for(const [inner,slot] of [['armor','body'],['hat','head']]){
  for(const [outer,prefix] of [['part','金'],['wood','木']]){
    const output=inner+'-lined-'+outer;
    objects[output]={name:prefix+objects[inner].name,kind:'equipment',slot,interior:inner,exterior:outer,value:unavailablePriceHelper()};
    DO_NOT_RUN.push({interior:inner,exterior:outer,output});
  }
}
`;
test('nested armor family tables project all item slots and recipes without running push or economic code',()=>{
  const k=parseKnowledge(source+armorUpdate),armor=k.recipes.filter(r=>r.type==='防具升炼');
  assert.equal(armor.length,4);assert.equal(k.items.find(i=>i.id==='armor-lined-part').slot,'body');
  assert.deepEqual(armor.find(r=>r.output==='hat-lined-wood').materials,{hat:1,wood:1});
  const list=linkLibrary({view:'crafting',items:armor.map(r=>({name:r.name,recipeType:'防具升炼'}))},k);
  assert.ok(list.items.every(i=>i.recipeId&&i.gameItemId&&i.slot));
  const renamed=(source+armorUpdate).replaceAll('objects','itemsV2').replaceAll('inner','lining').replaceAll('outer','shell');
  assert.equal(parseKnowledge(renamed).recipes.filter(r=>r.type==='防具升炼').length,4);
  const duplicate=source+armorUpdate+"const oldTable=[{interior:'armor',exterior:'part',output:'armor-lined-part'}];";
  assert.equal(parseKnowledge(duplicate).recipes.filter(r=>r.type==='防具升炼').length,4);
});
test('unknown armor material expressions, conditional generation and oversized tables reject incomplete data',()=>{
  assert.throws(()=>parseKnowledge(source+armorUpdate.replace('interior:inner','interior:unknownMaterial()')),/不完整/u);
  assert.throws(()=>parseKnowledge(source+armorUpdate.replace('objects[output]=','if (unknownCondition()) objects[output]=')),/条件结构/u);
  assert.throws(()=>parseKnowledge(source+armorUpdate.replace("[['armor','body'],['hat','head']]",`[${Array(1001).fill("['armor','body']").join(',')}]`)),/器物表/u);
  assert.equal(globalThis.DO_NOT_EXECUTE,undefined);
});
const setup=()=>{
  const knowledge=parseKnowledge(source,'resource');
  const library={revision:1,views:{inventory:{updatedAt:1,items:[{name:'矿',quantity:'3'}]},crafting:{updatedAt:1,items:knowledge.recipes.map((r,i)=>({key:String(i),name:r.name,recipeType:r.type,chance:'必成'}))}}};
  const bestiary={revision:1,knowledgeRevision:knowledge.revision,resourceUrl:'resource',updatedAt:1,entries:[{id:'rat'}]};
  const catalog={resourceUrl:'resource',nodes:[{id:'hill',name:'山',regionName:'北境',availability:'visible'}]};
  return {knowledge,library,bestiary,catalog};
};
test('shared inventory is deducted once; output rounding and alternative routes are independent',()=>{
  const context=setup(),key=context.library.views.crafting.items.find(r=>r.name==='剑').key;
  let p=farmingPlan(context,{recipeKey:key});assert.equal(p.missing.length,0);
  p=farmingPlan(context,{recipeKey:key,quantity:2});assert.equal(p.missing[0].quantity,3);
  p=farmingPlan(context,{recipeKey:key,quantity:2,choices:{wood:'b'}});assert.equal(p.missing[0].quantity,5);
  context.knowledge.recipes.find(r=>r.id==='part').outputCount=2;
  p=farmingPlan(context,{recipeKey:key,quantity:2});assert.equal(p.missing[0].quantity,1);
  p=farmingPlan(context,{recipeKey:key,ignoreStock:true});assert.equal(p.missing[0].quantity,3);
  assert.throws(()=>farmingPlan(context,{recipeKey:key,choices:{wood:'gone'}}),/路线/u);
});
test('same output recipes match difficulty and output; equipment instances exclude equipped items',()=>{
  const c=setup();c.knowledge.recipes.find(r=>r.id==='b').name='另炼木';
  const list=linkLibrary({view:'crafting',items:[{name:'木',recipeType:'普通炼制',summary:'难度 2',aria:'查看木，成功产出1份'}]},c.knowledge);
  // A unique exact recipe label remains authoritative.
  assert.equal(list.items[0].recipeId,'a');
  c.library.views.inventory.items=[{name:'剑料',identity:'i1',quality:'90',quantity:'1',equipped:true},{name:'剑料',identity:'i2',quality:'100',quantity:'1'}];
  const p=farmingPlan(c,{recipeKey:c.library.views.crafting.items.find(r=>r.name==='剑').key});assert.equal(p.tree.children[0].owned,1);assert.equal(p.tree.children[0].instances.length,1);
});
test('cycles and absent sources stay explicit instead of fabricating a farming route',()=>{
  const c=setup();c.knowledge.recipes.find(r=>r.id==='part').materials={part:1};const p=farmingPlan(c,{recipeKey:c.library.views.crafting.items.find(r=>r.name==='剑').key});assert.ok(p.warnings.some(w=>w.includes('循环')));assert.ok(p.missing.find(m=>m.itemId==='part').sources.length===0);
});
test('drop rolls preserve guaranteed quantities, fractional probabilities and multiplier exemptions',()=>{
  const result=groupLoot([{itemId:'a',chance:1.2},{itemId:'a',chance:1.2},{itemId:'b',chance:.2},{itemId:'b',chance:.2}],[]);
  assert.equal(result[0].guaranteed,1);assert.equal(result[0].rolls,2);assert.equal(result[0].expected,2.4);assert.equal(result[0].atLeastOne,1);assert.ok(Math.abs(result[1].atLeastOne-.36)<1e-10);
});
test('map yields use full pools, overrides, random group sizes; unknown enemies invalidate difficulty',()=>{
  const c=setup();c.knowledge.enemies[0].loot=[{itemId:'ore',chance:.2},{itemId:'ore',chance:1,ignoreLuck:true}];
  c.knowledge.enemies.push({...c.knowledge.enemies[0],id:'unknown'});
  Object.assign(c.knowledge.maps[0],{pool:['rat','unknown'],groups:2,randomGroupSize:true,enemyMultiplier:2,encounterPools:{2:['rat']}});
  const [m]=recommendMaps(c.knowledge,c.bestiary,c.catalog,[{itemId:'ore',name:'矿',quantity:5}]);assert.equal(m.totalEnemies,3);assert.equal(m.targetCount,2.25);assert.equal(m.targetShare,.75);assert.ok(Math.abs(m.outputs[0].expected-3.15)<1e-10);assert.equal(m.difficulty,null);
  c.knowledge.maps[0].challenge=true;assert.equal(recommendMaps(c.knowledge,c.bestiary,c.catalog,[{itemId:'ore'}])[0].eligible,false);
});

test('stocked intermediates retain expandable sources without spending sibling inventory',()=>{
  const c=setup();c.library.views.inventory.items=[{name:'剑料',quantity:1},{name:'矿',quantity:1}];
  const p=farmingPlan(c,{recipeKey:c.library.views.crafting.items.find(r=>r.name==='剑').key});
  const part=p.tree.children[0],wood=p.tree.children[1];
  assert.equal(part.shortage,0);assert.equal(part.sourcePreview,true);assert.equal(part.children[0].name,'矿');
  assert.equal(part.children[0].reference,true);assert.equal(part.children[0].required,2);
  assert.equal(wood.children[0].owned,1);assert.deepEqual(p.missing,[]);
  assert.equal(p.farming.basis,'reference');assert.equal(p.farming.inventorySatisfied,true);
  assert.deepEqual(p.farming.targets.map(t=>[t.itemId,t.quantity]),[['ore',3]]);
});

test('whole-item farming traces multiple levels, merges leaves and credits shared stock and excess output once',()=>{
  const c=setup(),key=c.library.views.crafting.items.find(r=>r.name==='剑').key;
  c.knowledge.items.push({id:'ingot',name:'锭',kind:'material'});
  c.knowledge.recipes.push({id:'smelt',name:'炼锭',type:'普通炼制',output:'ingot',outputCount:2,materials:{ore:3}});
  c.library.views.crafting.items.push({key:'smelt',name:'炼锭',recipeType:'普通炼制',chance:'85%'});
  c.knowledge.recipes.find(r=>r.id==='part').materials={ingot:1};
  c.knowledge.recipes.find(r=>r.id==='a').materials={ingot:1,ore:2};
  c.library.views.inventory.items=[{name:'矿',quantity:1}];
  let p=farmingPlan(c,{recipeKey:key});
  assert.deepEqual(p.farming.targets.map(t=>[t.itemId,t.quantity]),[['ore',4]]);
  assert.equal(p.farming.recipes.find(r=>r.id==='smelt').batches,1);
  assert.equal(p.farming.targets[0].via.length,2);assert.equal(p.farming.unresolved.length,0);
  p=farmingPlan(c,{recipeKey:key,ignoreStock:true});assert.equal(p.farming.targets[0].quantity,5);
  p=farmingPlan(c,{recipeKey:key,quantity:3});assert.equal(p.farming.targets[0].quantity,14);
  assert.equal(p.farming.recipes.find(r=>r.id==='smelt').batches,3);
});

test('farming stops at encountered drops and supports an explicit deeper recipe route',()=>{
  const c=setup(),key=c.library.views.crafting.items.find(r=>r.name==='剑').key;
  c.library.views.inventory.items=[];c.knowledge.enemies[0].loot.push({itemId:'wood',chance:.25});
  let p=farmingPlan(c,{recipeKey:key});
  assert.deepEqual(p.farming.targets.map(t=>[t.itemId,t.quantity]),[['ore',2],['wood',1]]);
  p=farmingPlan(c,{recipeKey:key,choices:{wood:'b'}});assert.deepEqual(p.farming.targets.map(t=>[t.itemId,t.quantity]),[['ore',4]]);
  p=farmingPlan(c,{recipeKey:key,choices:{wood:'drop:wood'}});assert.equal(p.farming.targets.find(t=>t.itemId==='wood').quantity,1);
});

test('an encountered farmable alternative is preferred, while unavailable sources and cycles remain unresolved',()=>{
  const c=setup(),key=c.library.views.crafting.items.find(r=>r.name==='剑').key;
  c.library.views.inventory.items=[];c.knowledge.items.push({id:'rare',name:'稀有物',kind:'material'});
  c.knowledge.recipes.find(r=>r.id==='a').materials={rare:1};
  c.knowledge.enemies.push({...c.knowledge.enemies[0],id:'unseen',loot:[{itemId:'rare',chance:1}]});
  let p=farmingPlan(c,{recipeKey:key});assert.equal(p.tree.children[1].recipeId,'b');
  assert.equal(p.farming.unresolved.length,0);assert.equal(p.farming.targets[0].quantity,4);
  p=farmingPlan(c,{recipeKey:key,choices:{wood:'a'}});assert.equal(p.farming.unresolved[0].itemId,'rare');
  assert.equal(p.farming.targets.some(t=>t.itemId==='rare'),false);
  c.knowledge.recipes.find(r=>r.id==='a').materials={wood:1};
  p=farmingPlan(c,{recipeKey:key});assert.equal(p.tree.children[1].recipeId,'b');assert.equal(p.farming.unresolved.length,0);
  p=farmingPlan(c,{recipeKey:key,choices:{wood:'a'}});assert.match(p.farming.unresolved[0].issue,/循环/u);
  c.library.views.inventory.items=[{name:'稀有物',quantity:1}];c.knowledge.recipes.find(r=>r.id==='a').materials={rare:1};
  p=farmingPlan(c,{recipeKey:key});assert.equal(p.tree.children[1].recipeId,'a');assert.equal(p.farming.unresolved.length,0);
});

test('single-material farming has its own quantity and excludes sibling materials',()=>{
  const c=setup(),key=c.library.views.crafting.items.find(r=>r.name==='剑').key;
  let p=farmingPlan(c,{recipeKey:key,scope:'single',materialId:'part',materialQuantity:3});
  assert.equal(p.farming.scope,'single');assert.equal(p.farming.name,'剑料');assert.equal(p.farming.quantity,3);
  assert.equal(p.farming.targets[0].quantity,3);assert.equal(p.farming.recipes.some(r=>r.id==='a'),false);
  p=farmingPlan(c,{recipeKey:key,scope:'single',materialId:'part',materialQuantity:3,ignoreStock:true});
  assert.equal(p.farming.targets[0].quantity,6);
  assert.throws(()=>farmingPlan(c,{recipeKey:key,scope:'single',materialId:'not-in-chain'}),/材料链/u);
  assert.throws(()=>farmingPlan(c,{recipeKey:key,materialQuantity:0}),/数量/u);
});

test('whole-item itinerary credits joint drops before allocating other maps and reports uncovered gaps',()=>{
  const targets=[{itemId:'a',quantity:10},{itemId:'b',quantity:6},{itemId:'c',quantity:2}];
  const map=(id,outputs,extra={})=>({id,name:id,regionName:'测试',eligible:true,unknown:false,coverage:outputs.length,difficulty:{maxRealm:1},outputs:outputs.map(([itemId,expected])=>({itemId,name:itemId,expected})),...extra});
  const result=allocateFarmingMaps([map('joint',[['a',2],['b',2]]),map('a-only',[['a',1]]),map('unknown',[['c',20]],{unknown:true}),map('locked',[['c',20]],{eligible:false})],targets);
  assert.deepEqual(result.steps.map(s=>[s.mapId,s.rounds]),[['joint',3],['joint',2]]);
  assert.equal(result.totalRounds,5);assert.equal(result.steps[0].gains.find(g=>g.itemId==='b').credited,6);
  assert.equal(result.steps[1].gains.some(g=>g.itemId==='b'),false);
  assert.deepEqual(result.uncovered,targets.slice(2));
  const c=setup(),key=c.library.views.crafting.items.find(r=>r.name==='剑').key;
  c.bestiary.knowledgeRevision='old';let p=farmingPlan(c,{recipeKey:key,ignoreStock:true});assert.equal(p.farming.itinerary.steps.length,0);assert.equal(p.farming.itinerary.uncovered.length,1);
  c.bestiary.knowledgeRevision=c.knowledge.revision;c.knowledge.maps[0].challenge=true;
  p=farmingPlan(c,{recipeKey:key,ignoreStock:true});assert.equal(p.farming.itinerary.steps.length,0);
});
