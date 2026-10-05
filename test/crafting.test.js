import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {craftSelection,inventoryEvidence,localOutcome,reviewLocalOutcome,craftReviewEvidence,craftReviewReason} from '../src/crafting-proof.js';
import {BattleControl} from '../src/battle-control.js';
import {atomicJson} from '../src/control-store.js';
import {PauseError} from '../src/errors.js';

const item={key:'a'.repeat(64),name:'成品',recipeType:'普通炼制',maxBatch:12};
const detail={name:'成品',facts:[{label:'成功率',value:'80%'}],materials:[{name:'草药',required:'2'}],ingredients:[]};
const inventory={items:[{name:'草药',quantity:'24',identity:''},{name:'刀',identity:'A',quality:'9'},{name:'刀',identity:'B',quality:'8'},{name:'刀',identity:'C',quality:'7'}]};
const selection=()=>craftSelection(item,detail,{quantity:2},inventory);
test('four types enforce frozen quantity, cap, and two exact unequipped instance IDs',()=>{
  for(const type of ['普通炼制','精炼']){
    assert.equal(craftSelection({...item,recipeType:type},detail,{quantity:'all'},inventory).quantity,12);
    assert.equal(craftSelection({...item,maxBatch:30000,recipeType:type},detail,{quantity:'all'},inventory).quantity,10000);
    for(const quantity of [0,-1,1.5,13,10001])assert.throws(()=>craftSelection(item,detail,{quantity},inventory));
  }
  const groups=[{candidates:[{id:'A',name:'刀',quality:'9'}]},{candidates:[{id:'B',name:'刀',quality:'8'}]}];
  for(const type of ['兵刃合炼','防具升炼']){
    const d={...detail,ingredients:groups},i={...item,recipeType:type};
    assert.deepEqual(craftSelection(i,d,{instanceIds:['A','B']},inventory).instances.map(x=>x.id),['A','B']);
    assert.throws(()=>craftSelection(i,d,{instanceIds:['A','A']},inventory));
    assert.throws(()=>craftSelection(i,d,{instanceIds:['A','C']},inventory));
    assert.throws(()=>craftSelection(i,d,{instanceIds:['A','B']},{items:inventory.items.filter(x=>x.identity!=='B')}));
  }
  assert.throws(()=>craftSelection(item,{...detail,name:'另一配方'},{quantity:1},inventory));
});
test('changed chance invalidates terms, while additional stock never increases a frozen all batch',()=>{
  const all=craftSelection(item,detail,{quantity:'all'},inventory);
  assert.equal(craftSelection({...item,maxBatch:30},detail,{quantity:all.quantity},inventory).signature,all.signature);
  assert.notEqual(craftSelection(item,{...detail,facts:[{label:'成功率',value:'90%'}]},{quantity:all.quantity},inventory).signature,all.signature);
  assert.throws(()=>craftSelection({...item,maxBatch:11},detail,{quantity:all.quantity},inventory));
});
test('local outcome requires settled notice, ready save and materials; probability failure with consumed materials counts',()=>{
  const before=inventoryEvidence(inventory),after=structuredClone(before);after.stacks.草药='20';
  assert.equal(localOutcome(before,after,selection(),{notice:'本批炼制已结算',saved:false}),null);
  assert.equal(localOutcome(before,before,selection(),{notice:'本批炼制已结算',saved:true}),null);
  assert.equal(localOutcome(before,after,selection(),{notice:'操作未完成',saved:true}),null);
  assert.ok(localOutcome(before,after,selection(),{notice:'本批炼制已结算',saved:true}));
});
test('local review requires exact batch consumption, ready save, and never invents a settlement notice',()=>{
  const before=inventoryEvidence(inventory);
  for(const remaining of ['24','23','21','19','0','unknown'])assert.equal(reviewLocalOutcome(before,{...before,stacks:{草药:remaining}},selection(),{saved:true}),null);
  const after={...before,stacks:{草药:'20'}};
  assert.equal(reviewLocalOutcome(before,after,selection(),{saved:false}),null);
  const result=reviewLocalOutcome(before,after,selection(),{saved:true});
  assert.equal(result.source,'inventory-review');assert.match(result.notice,/实际产出请查看行囊/u);assert.equal(result.produced,undefined);
  const duplicate={...selection(),materials:[{name:'草药',perUnit:'1'},{name:'草药',perUnit:'1'}]};
  assert.ok(reviewLocalOutcome(before,after,duplicate,{saved:true}));
  assert.equal(reviewLocalOutcome(null,after,selection(),{saved:true}),null);
});
test('equipment local proof checks both selected IDs disappeared, not unrelated instances',()=>{
  const before=inventoryEvidence(inventory);
  for(const type of ['兵刃合炼','防具升炼']){
    const selected={...selection(),type,quantity:1,instances:[{id:'A'},{id:'B'}]},after={...before,instances:{C:before.instances.C}};
    assert.ok(localOutcome(before,after,selected,{notice:'本批炼制已结算',saved:true}));
    assert.equal(reviewLocalOutcome(before,{...after,instances:{A:before.instances.A}},selected,{saved:true}),null);
    assert.equal(reviewLocalOutcome(before,after,{...selected,instances:[]},{saved:true}),null);
  }
});

test('failed review describes exact expected and actual consumption without treating unchanged inventory as success',()=>{
  const before=inventoryEvidence(inventory),after={...before,stacks:{草药:'22'}};
  const evidence=craftReviewEvidence(before,after,selection(),{saved:false});
  assert.deepEqual(evidence.materials,[{name:'草药',before:'24',after:'22',expected:'4',consumed:'2',matched:false}]);
  assert.match(craftReviewReason(evidence),/本地存档已就绪.*预计消耗 4.*24 → 22.*不会再次炼制/u);
  assert.equal(reviewLocalOutcome(before,after,selection(),{saved:true}),null);
});

async function setup(options={}){
  const directory=options.directory??await mkdtemp(path.join(os.tmpdir(),'craft-test-'));
  const state={character:'测试修士',mode:'combat',heal:{running:false},view:{dialogs:[]}},actions=[];
  let issued=0,localReady=options.localReady??true;
  const ui={config:{characterName:'测试修士'},async observe(){this.onSnapshot?.(state);return state;},async ensureMonitoringView(){return {ready:true};},async retreatForTarget(){actions.push('retreat');state.mode='rest';}};
  const adapter={reader:{async read(view,selected){actions.push('read:'+view);return {items:selected?[selected]:[],equipment:[],updatedAt:Date.now(),...(selected?{detail:{...detail,key:selected.key,updatedAt:Date.now()}}:{})};}},
    async preview(){return {item,detail,inventory,selection:selection()};},
    async stopActivity(check){await check('retreating');await ui.retreatForTarget();},
    witness(){assert.fail('must not observe cloud save traffic');},
    async synchronize(){assert.fail('must not upload to cloud');},
    async mutate(p,onIssued){await options.beforeIssued?.();await onIssued(inventoryEvidence(inventory));issued++;await options.afterIssued?.();if(options.uncertain)throw new Error('click response lost');return {notice:'本批炼制已结算',source:'settlement',verifiedAt:Date.now(),inventory:{}};},
    async recoverInventory(){return {stacks:{草药:options.reviewStock??'20'},instances:{}};},async localReady(){return localReady;}
  };
  const base={enabled:false,characterName:'测试修士',target:{regionName:'north',stageName:'stage'},consumables:{enabled:false,itemNames:['赤灵髓','碧灵髓'],intervalMinutes:10,quantity:'all'}};
  const params={base,directory,runtime:{profilePath:directory},signal:new AbortController().signal,log:()=>{},makeUI:async()=>ui,craftingOptions:{makeUI:()=>adapter,...options.craftingOptions}};
  const control=new BattleControl(params);await control.initialize();control.close();control.library.views.crafting={items:[item]};
  return {control,adapter,ui,actions,params,directory,get issued(){return issued;},fixLocal(){localReady=true;}};
}
async function preview(h){const r=await h.control.command('craft-preview',{key:item.key,quantity:2}).promise;assert.equal(r.ok,true,r.error);return r.previewId;}

test('craft completion refreshes its recipe detail before releasing the batch, including timeout review',async()=>{
  for(const uncertain of [false,true]){
    const h=await setup({uncertain}),id=await preview(h),reads=[];
    let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    const fresh={...detail,key:item.key,updatedAt:Date.now()+1000,materials:[{name:'草药',owned:'20',required:'2'}],ingredients:[{label:'护腿',candidates:[{id:'C',name:'刀',quality:'7'}]}]};
    h.adapter.reader.read=async(view,selected)=>{
      reads.push({view,key:selected?.key});
      if(view==='crafting'){enter();await gate;return {items:[item],detail:fresh,updatedAt:fresh.updatedAt};}
      return {items:[{name:'草药',quantity:'20'}],equipment:[],updatedAt:Date.now()};
    };
    const execute=h.control.command('craft-execute',{previewId:id});await entered;
    assert.equal(h.control.crafting.active.id,id);assert.equal(h.control.crafting.active.stage,'refreshing');
    assert.ok(h.control.crafting.active.local?.verifiedAt);release();
    assert.equal((await execute.promise).ok,true);
    assert.equal(h.control.crafting.active,null);
    assert.deepEqual(reads,[{view:'inventory',key:undefined},{view:'crafting',key:item.key}]);
    assert.equal(h.control.library.details[item.key].materials[0].owned,'20');
    assert.deepEqual(h.control.library.details[item.key].ingredients[0].candidates.map(c=>c.id),['C']);
    assert.equal(h.control.crafting.data.operations[id].refresh.detailUpdatedAt,fresh.updatedAt);
    await h.control.command('craft-execute',{previewId:id}).promise;assert.equal(h.issued,1);
  }
});

test('recipe refresh failure reports stale details without losing local proof, replaying or blocking later work',async()=>{
  const h=await setup(),id=await preview(h);h.control.record.desired='running';h.control.phase='running';
  const read=h.adapter.reader.read;h.adapter.reader.read=async(view,selected)=>{
    if(view==='crafting')throw new Error('detail timeout');return read(view,selected);
  };
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,true);
  const op=h.control.crafting.data.operations[id];
  assert.equal(op.stage,'completed');assert.ok(op.local.verifiedAt);assert.match(op.refresh.errors.crafting,/detail timeout/u);
  assert.equal(h.control.crafting.active,null);assert.equal(h.control.phase,'checking');
  await h.control.command('craft-execute',{previewId:id}).promise;assert.equal(h.issued,1);
});

test('deleting completed history removes details but preserves the replay fence after restart',async()=>{
  const h=await setup(),id=await preview(h);await h.control.command('craft-execute',{previewId:id}).promise;
  const beforeActions=[...h.actions],settings=structuredClone(h.control.record);
  const removed=await h.control.command('craft-delete',{operationId:id}).promise;assert.equal(removed.ok,true);assert.equal(removed.deleted,true);
  assert.deepEqual(h.control.crafting.snapshot().operations,[]);assert.equal(h.control.crafting.snapshot().historyCount,0);assert.deepEqual(h.control.crafting.snapshot().previews,[]);
  const saved=JSON.parse(await readFile(path.join(h.directory,'crafting.json')));assert.deepEqual(Object.keys(saved.operations[id]).sort(),['deletedAt','id','stage']);assert.equal(saved.previews[id],undefined);
  assert.equal((await h.control.command('craft-delete',{operationId:id}).promise).ok,true);
  const restarted=new BattleControl(h.params);await restarted.initialize();restarted.close();
  assert.equal((await restarted.command('craft-execute',{previewId:id}).promise).ok,true);assert.equal(h.issued,1);
  assert.deepEqual(h.actions,beforeActions);assert.deepEqual(h.control.record,settings);assert.deepEqual(restarted.crafting.snapshot().operations,[]);
});

test('cancelled history can be deleted, while active and unresolved records cannot',async()=>{
  const h=await setup(),id=await preview(h);
  await h.control.crafting.change(data=>{data.activeId=id;data.operations[id]={id,preview:data.previews[id],stage:'preparing',createdAt:1,updatedAt:1};});
  let result=await h.control.command('craft-delete',{operationId:id}).promise;assert.equal(result.ok,false);assert.match(result.error,/不能删除/u);
  await h.control.crafting.patch(id,{stage:'awaiting-review',issuedAt:2});
  result=await h.control.command('craft-delete',{operationId:id}).promise;assert.equal(result.ok,false);assert.equal(h.control.crafting.active.id,id);
  // Unknown/unfinished stages stay protected even if a damaged active pointer is absent.
  await h.control.crafting.change(data=>{data.activeId=null;});assert.equal((await h.control.command('craft-delete',{operationId:id}).promise).ok,false);
  await h.control.crafting.patch(id,{stage:'cancelled',issuedAt:undefined});assert.equal((await h.control.command('craft-delete',{operationId:id}).promise).ok,true);
  assert.equal(h.issued,0);assert.deepEqual(h.control.crafting.snapshot().operations,[]);
  assert.throws(()=>h.control.command('craft-delete',{operationId:'invalid'}),/操作编号/u);
  assert.equal((await h.control.command('craft-delete',{operationId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}).promise).ok,false);
});

test('history deletion survives write failure without hiding a record or blocking later attempts',async()=>{
  let fail=false;
  const h=await setup({craftingOptions:{write:async(file,value)=>{if(fail)throw new Error('disk full');await atomicJson(file,value);}}}),id=await preview(h);
  await h.control.command('craft-execute',{previewId:id}).promise;fail=true;
  const result=await h.control.command('craft-delete',{operationId:id}).promise;assert.equal(result.ok,false);assert.match(result.error,/disk full/u);
  assert.equal(h.control.crafting.snapshot().operations[0].id,id);assert.ok(h.control.crafting.data.previews[id]);
  fail=false;assert.equal((await h.control.command('craft-delete',{operationId:id}).promise).ok,true);assert.equal(h.issued,1);
});
test('one serial crafting transaction resumes only prior running task, preserves timer, and duplicate clicks merge',async()=>{
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const h=await setup({afterIssued:async()=>{entered();await gate;}});h.control.record.desired='running';h.control.phase='running';
  h.control.consumables.state={nextAt:123456};
  const id=await preview(h),job=h.control.command('craft-execute',{previewId:id});await ready;
  assert.equal(h.control.command('craft-execute',{previewId:id}),job);assert.equal(h.issued,1);
  release();assert.equal((await job.promise).ok,true);assert.equal(h.control.phase,'checking');assert.equal(h.control.consumables.state.nextAt,123456);
  assert.deepEqual(h.control.config.target,{regionName:'north',stageName:'stage'});assert.equal(h.control.record.desired,'running');
  assert.deepEqual(h.actions,['retreat','read:inventory','read:crafting']);
  await h.control.command('craft-execute',{previewId:id}).promise;assert.equal(h.issued,1);assert.equal(h.control.crafting.snapshot().operations[0].localSaved,true);assert.equal(h.control.crafting.snapshot().operations[0].cloudStatus,undefined);
  assert.equal(h.actions[0],'retreat');
});
test('stopped task stays stopped after craft; previews do not retreat or consume',async()=>{
  const h=await setup(),id=await preview(h);assert.deepEqual(h.actions,[]);assert.equal(h.issued,0);
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,true);assert.equal(h.control.phase,'stopped');
});

test('a previously paused task is not started by crafting',async()=>{
  const h=await setup(),id=await preview(h);h.control.record.desired='running';h.control.phase='attention';
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,true);assert.equal(h.control.phase,'attention');
  assert.equal(h.control.crafting.data.operations[id].resumeDesired,false);
});
test('uncertain local outcome refreshes once and releases the queue without repeating a consuming click',async()=>{
  const h=await setup({uncertain:true,localReady:false}),id=await preview(h);h.control.record.desired='running';h.control.phase='running';
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,true);assert.equal(h.control.phase,'checking');assert.equal(h.issued,1);
  assert.equal(h.control.crafting.active,null);assert.equal(h.control.crafting.data.operations[id].stage,'refreshed');
  h.control.libraryReader=()=>h.adapter.reader;
  assert.equal((await h.control.command('library',{view:'inventory'}).promise).ok,true);
  h.control.library.views.crafting={items:[item]};const next=await preview(h);assert.notEqual(next,id);
  assert.equal((await h.control.command('craft-review',{operationId:id}).promise).ok,true);assert.equal(h.issued,1);h.fixLocal();
  assert.equal((await h.control.command('craft-review',{operationId:id}).promise).ok,true);assert.equal(h.issued,1);assert.equal(h.control.phase,'checking');
  assert.equal((await h.control.command('craft-execute',{previewId:next}).promise).ok,true);assert.equal(h.issued,2);
});
test('consumed click with lost response survives process restart and local-only recovery',async()=>{
  const h=await setup({uncertain:true}),id=await preview(h);
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,true);
  await h.control.crafting.change(data=>{data.activeId=id;Object.assign(data.operations[id],{stage:'issued',local:null});});
  const restarted=new BattleControl(h.params);await restarted.initialize();restarted.close();assert.equal(restarted.phase,'stopped');
  assert.equal(restarted.crafting.active,null);assert.equal(restarted.crafting.startupReviewId,id);assert.equal(restarted.crafting.data.operations[id].stage,'unconfirmed');
  assert.equal((await restarted.command('craft-execute',{previewId:id}).promise).ok,true);assert.equal(h.issued,1);
  assert.equal((await restarted.command('craft-review',{operationId:id}).promise).ok,true);assert.equal(h.issued,1);
});

test('local proof is durable before cleanup failure and survives restart without another consuming action',async()=>{
  const h=await setup(),id=await preview(h);
  h.adapter.mutate=async(_preview,onIssued,onLocal)=>{
    const before=inventoryEvidence(inventory),after={...before,stacks:{草药:'20'}};
    await onIssued(before);await onLocal(localOutcome(before,after,selection(),{saved:true,notice:'本批炼制已结算'}));
    const stored=JSON.parse(await readFile(path.join(h.directory,'crafting.json')));assert.ok(stored.operations[id].local.verifiedAt);
    throw new Error('close timeout');
  };
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,true);
  const restarted=new BattleControl(h.params);await restarted.initialize();restarted.close();
  assert.ok(restarted.crafting.data.operations[id].local.verifiedAt);
  h.adapter.recoverInventory=async()=>({stacks:{草药:'19'},instances:{}});
  assert.equal((await restarted.command('craft-review',{operationId:id}).promise).ok,true);
  assert.equal(restarted.crafting.active,null);
  assert.equal((await restarted.command('craft-execute',{previewId:id}).promise).ok,true);
});

test('unsuccessful review persists material diagnostics and retains the issued fence',async()=>{
  const h=await setup({uncertain:true,reviewStock:'24'}),id=await preview(h);
  await h.control.command('craft-execute',{previewId:id}).promise;
  h.adapter.recoverInventory=async()=>({stacks:{草药:'24'},instances:{}});
  const result=await h.control.command('craft-review',{operationId:id}).promise;
  assert.equal(result.ok,true);assert.match(h.control.crafting.data.operations[id].warning,/预计消耗 4.*24 → 24/u);
  const record=JSON.parse(await readFile(path.join(h.directory,'crafting.json')));
  assert.equal(record.activeId,null);assert.equal(record.operations[id].stage,'refreshed');assert.equal(record.operations[id].lastReview.materials[0].consumed,'0');assert.equal(h.issued,1);
});

test('replenished materials release the queue, cache the fresh bag once, and historical review never resets current navigation',async()=>{
  const h=await setup({uncertain:true}),id=await preview(h);h.control.record.desired='running';h.control.phase='running';
  let reads=0;
  h.adapter.recoverInventory=async()=>{reads++;h.adapter.lastInventory={items:[{name:'草药',identity:'',quantity:'30'}],equipment:[],updatedAt:Date.now()};return inventoryEvidence(h.adapter.lastInventory);};
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,true);
  assert.equal(reads,1);assert.equal(h.control.library.views.inventory.items[0].quantity,'30');
  assert.equal(h.actions.filter(a=>a==='read:inventory').length,0);assert.equal(h.actions.filter(a=>a==='read:crafting').length,1);
  assert.equal(h.control.phase,'checking');assert.equal(h.control.crafting.active,null);assert.equal(h.issued,1);
  let itemsAllowed=false;h.control.inventoryActions.prepare=async()=>{itemsAllowed=true;return {};};
  assert.equal((await h.control.command('inventory-preview',{kind:'sell',ids:['chosen-item']}).promise).ok,true);assert.equal(itemsAllowed,true);
  h.control.phase='switching';h.control.runner.pendingEntry={regionName:'new',stageName:'new'};
  // A historical read waits if navigation itself is still unresolved.
  assert.equal((await h.control.command('craft-review',{operationId:id}).promise).ok,false);
  assert.deepEqual(h.control.runner.pendingEntry,{regionName:'new',stageName:'new'});assert.equal(h.control.phase,'switching');
  h.control.runner.pendingEntry=null;h.control.phase='running';
  assert.equal((await h.control.command('craft-review',{operationId:id}).promise).ok,true);assert.equal(h.control.phase,'running');assert.equal(h.issued,1);
});

test('failed refresh releases only the craft lock; real login/save conflicts still need handling',async()=>{
  for(const critical of [false,true]){
    const h=await setup({uncertain:true}),id=await preview(h);h.control.record.desired='running';h.control.phase='running';
    h.adapter.recoverInventory=async()=>{throw critical?new PauseError('存档冲突'):new Error('temporary list timeout');};
    assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,false);
    assert.equal(h.control.crafting.active,null);assert.equal(h.control.crafting.data.operations[id].stage,'unconfirmed');
    assert.equal(h.control.phase,critical?'attention':'checking');assert.equal(h.issued,1);
    await h.control.command('craft-execute',{previewId:id}).promise;assert.equal(h.issued,1);
  }
});

test('legacy pending record gets one automatic read after restart, stays nonblocking, and is never replayed',async()=>{
  const h=await setup({uncertain:true,reviewStock:'30'}),id=await preview(h);
  await h.control.command('craft-execute',{previewId:id}).promise;
  await h.control.crafting.change(data=>{data.activeId=id;data.operations[id].stage='awaiting-review';});
  let reads=0;h.adapter.recoverInventory=async()=>{reads++;return {stacks:{草药:'30'},instances:{}};};
  const restarted=new BattleControl(h.params);await restarted.initialize();
  try{
    assert.equal(restarted.crafting.active,null);
    for(let n=0;n<20&&restarted.crafting.startupReviewId;n++)await new Promise(r=>setTimeout(r,50));
    await restarted.tail;
    assert.equal(restarted.crafting.startupReviewId,null);assert.equal(reads,1);
    assert.equal(restarted.crafting.data.operations[id].stage,'refreshed');assert.equal(restarted.phase,'stopped');
    await restarted.command('craft-execute',{previewId:id}).promise;assert.equal(h.issued,1);
  }finally{restarted.close();}
});

test('stop during automatic post-craft refresh finishes the read but never resumes battle',async()=>{
  const h=await setup({uncertain:true,localReady:false}),id=await preview(h);h.control.record.desired='running';h.control.phase='running';
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  h.adapter.recoverInventory=async()=>{enter();await gate;return {stacks:{草药:'30'},instances:{}};};
  const execute=h.control.command('craft-execute',{previewId:id});await entered;
  const stop=h.control.command('stop');await h.control.crafting.tail;release();
  assert.equal((await execute.promise).ok,true);assert.equal((await stop.promise).ok,true);
  assert.equal(h.control.crafting.active,null);assert.equal(h.control.phase,'stopped');assert.equal(h.control.record.desired,'stopped');assert.equal(h.issued,1);
});

test('manual confirmation requires explicit current evidence, persists its source, and never recrafts or resumes a stopped task',async()=>{
  const h=await setup({uncertain:true,reviewStock:'30'}),id=await preview(h);await h.control.command('craft-execute',{previewId:id}).promise;
  h.adapter.recoverInventory=async()=>({stacks:{草药:'30'},instances:{}});
  await h.control.command('craft-review',{operationId:id}).promise;
  const reviewedAt=h.control.crafting.data.operations[id].lastReview.checkedAt;
  assert.throws(()=>h.control.command('craft-confirm',{operationId:id,reviewedAt}),/明确确认/u);
  assert.equal((await h.control.command('craft-confirm',{operationId:id,reviewedAt:reviewedAt-1,confirmed:true}).promise).ok,false);
  const payload={operationId:id,reviewedAt,confirmed:true};
  assert.equal((await h.control.command('craft-confirm',payload).promise).ok,true);
  const op=h.control.crafting.data.operations[id];assert.equal(op.local.source,'manual-review');assert.ok(op.manualConfirmation.confirmedAt);
  assert.equal(h.control.crafting.active,null);assert.equal(h.control.phase,'stopped');assert.equal(h.issued,1);
  assert.equal((await h.control.command('craft-confirm',payload).promise).ok,true);assert.equal(h.issued,1);
  const restarted=new BattleControl(h.params);await restarted.initialize();restarted.close();assert.equal(restarted.crafting.active,null);
});

test('manual confirmation rejects inventory changes, unsaved state and a conflicting character',async()=>{
  for(const reason of ['inventory','save','character']){
    const h=await setup({uncertain:true,reviewStock:'30'}),id=await preview(h);await h.control.command('craft-execute',{previewId:id}).promise;
    h.adapter.recoverInventory=async()=>({stacks:{草药:'30'},instances:{}});await h.control.command('craft-review',{operationId:id}).promise;
    const payload={operationId:id,reviewedAt:h.control.crafting.data.operations[id].lastReview.checkedAt,confirmed:true};
    if(reason==='inventory')h.adapter.recoverInventory=async()=>({stacks:{草药:'31'},instances:{}});
    if(reason==='save')h.adapter.localReady=async()=>false;
    if(reason==='character')h.adapter.recoverInventory=async()=>{throw new Error('角色不符');};
    assert.equal((await h.control.command('craft-confirm',payload).promise).ok,false);
    assert.equal(h.control.crafting.active,null);assert.equal(h.issued,1);
  }
});

test('legacy pending cloud record recovers locally through the old endpoint without uploads',async()=>{
  const h=await setup({uncertain:true}),id=await preview(h);
  await h.control.command('craft-execute',{previewId:id}).promise;
  await h.control.crafting.patch(id,{stage:'awaiting-sync',cloudStatus:'pending',baseline:{requestId:'legacy'},local:{verifiedAt:1,notice:'本批炼制已结算',inventory:{}}});
  await h.control.crafting.change(data=>{data.activeId=id;});
  const restarted=new BattleControl(h.params);await restarted.initialize();restarted.close();
  assert.equal(restarted.crafting.active,null);assert.equal(restarted.crafting.data.operations[id].stage,'unconfirmed');
  // Persisted local confirmation stays valid even when later bag quantities changed.
  h.adapter.recoverInventory=async()=>({stacks:{草药:'22'},instances:{}});
  assert.equal((await restarted.command('craft-sync',{operationId:id}).promise).ok,true);
  assert.equal(restarted.crafting.active,null);assert.equal(restarted.phase,'stopped');assert.equal(h.issued,1);
  assert.equal(restarted.crafting.snapshot().operations[0].cloudStatus,undefined);
});
test('stop after issued completes verification but cannot restart combat, including persisted stop fence',async()=>{
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const h=await setup({afterIssued:async()=>{entered();await gate;}}),id=await preview(h);h.control.record.desired='running';h.control.phase='running';
  const execute=h.control.command('craft-execute',{previewId:id});await ready;
  const stop=h.control.command('stop');await h.control.crafting.tail;
  assert.equal(JSON.parse(await readFile(path.join(h.directory,'crafting.json'))).stopRequested,true);
  release();assert.equal((await execute.promise).ok,true);assert.equal((await stop.promise).ok,true);assert.equal(h.control.record.desired,'stopped');assert.equal(h.control.phase,'stopped');assert.equal(h.issued,1);
  const restarted=new BattleControl(h.params);await restarted.initialize();restarted.close();assert.equal(restarted.record.desired,'stopped');
});
test('stop before consuming fence cancels queued crafting and no ingredients are spent',async()=>{
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const h=await setup({beforeIssued:async()=>{entered();await gate;}}),id=await preview(h);
  const execute=h.control.command('craft-execute',{previewId:id});await ready;const stop=h.control.command('stop');release();
  assert.equal((await execute.promise).ok,false);assert.equal((await stop.promise).ok,true);assert.equal(h.issued,0);assert.equal(h.control.crafting.active,null);
});
test('durable write failure before issuing is fail-closed; restart cancels only unissued operations',async()=>{
  const h=await setup({craftingOptions:{write:async(f,v)=>{if(v.operations[v.activeId]?.stage==='issued')throw new Error('disk full');await atomicJson(f,v);}}}),id=await preview(h);
  assert.equal((await h.control.command('craft-execute',{previewId:id}).promise).ok,false);assert.equal(h.issued,0);
  const record=JSON.parse(await readFile(path.join(h.directory,'crafting.json')));record.activeId=id;record.operations[id].stage='retreating';delete record.operations[id].issuedAt;await atomicJson(path.join(h.directory,'crafting.json'),record);
  const restarted=new BattleControl(h.params);await restarted.initialize();restarted.close();assert.equal(restarted.crafting.active,null);assert.equal(restarted.crafting.data.operations[id].stage,'cancelled');assert.equal(h.issued,0);
});
