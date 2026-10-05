import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BattleControl, initialSettings, validateSettings } from '../src/battle-control.js';
import { parseCatalog, targetNode } from '../src/catalog.js';
import { atomicJson } from '../src/control-store.js';
import { startControlServer } from '../src/control-server.js';
import { PauseError } from '../src/errors.js';
import { ControlInterrupted } from '../src/control-errors.js';

const source = `const whatever=[{id:'north',name:'北境',locations:['a','b','c']},{id:'south',name:'南境',locations:['d','e','f']}];
const data={a:{...factory('石阶','start',[]),description:'x'},b:{name:'北泉',prerequisite:'a',meditation:!0},c:{...factory('决战','a',[]),challenge:!0},d:{...differentHelper('石阶','a',[])},e:{name:'南泉',meditation:true,prerequisite:'d'},f:{name:'阵台',prerequisite:'e'}};
const items={red:{name:'赤灵髓',kind:'marrow'},green:{name:'碧灵髓',kind:'marrow'},new:{name:'金灵髓',kind:'marrow'}}; throw new Error('remote code must never execute');`;
const catalog = () => parseCatalog(source);
const base = { enabled:false, channelUrl:'https://discord.com/channels/1/2',appName:'霜月茉莉',characterName:'测试修士',target:{regionName:'北境',stageName:'石阶'},healingTarget:{regionName:'北境',locationName:'北泉'},pollIntervalSeconds:5,healActionIntervalSeconds:2,consumables:{enabled:true,itemNames:['赤灵髓','碧灵髓'],intervalMinutes:10,quantity:'all'} };
async function setup(options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'battle-control-'));
  const state={character:'测试修士',region:'北境',location:'石阶',mode:'combat',health:{current:'100',maximum:'100',percent:100},view:{dialogs:[],activeTab:'游历'},heal:{running:false,enabled:false}};
  const actions=[], abort=new AbortController(); let connections=0;
  const ui={ signal:abort.signal, log:()=>{},
    async observe(){this.onSnapshot?.(structuredClone(state));return structuredClone(state);},
    async ensureMonitoringView(){await this.observe();return {ready:true};},
    async inspectCatalog(c){actions.push('inspect');return {...c,checkedAt:Date.now(),nodes:c.nodes.map(n=>({...n,availability:n.id===options.locked?'locked':'visible'}))};},
    async retreatForTarget(target,{force}={}){this.beforeAction?.('撤退');assert.equal(force,true);actions.push('retreat');state.mode='rest';state.location='北泉';await this.observe();},
    async consumeAllApproved(name){this.beforeAction?.('使用'+name);actions.push(name);return {before:2,after:0};},
  };
  const control = new BattleControl({base:structuredClone(base),directory,runtime:{profilePath:directory,retrySeconds:[10,30,60],recoveryIntervalSeconds:300},signal:abort.signal,log:()=>{},catalogLoader:async()=>catalog(),makeUI:async()=>{connections++;return ui;},...options});
  await control.initialize();control.close();
  return {control,state,ui,actions,directory,abort,get connections(){return connections;}};
}
const command=async(c,kind,payload)=>{const result=await c.command(kind,payload).promise;assert.equal(result.ok,true,result.error);return result;};

test('close game disconnects without launching or retreating and all implicit reconnect paths are fenced',async()=>{
  let closes=0;const h=await setup({closeGamePage:async()=>closes++});
  await command(h.control,'close-game');
  assert.equal(h.connections,0);assert.equal(closes,1);assert.deepEqual(h.actions,[]);
  assert.equal(h.control.phase,'closed');assert.equal(h.control.record.desired,'stopped');
  const record=JSON.parse(await readFile(path.join(h.directory,'settings.json'),'utf8'));assert.equal(record.gameClosed,true);
  for(const kind of ['start','resume','restart','refresh','library','bestiary']){
    const result=await h.control.command(kind,kind==='library'?{view:'inventory'}:{}).promise;
    assert.equal(result.ok,false);assert.match(result.error,/先点击「打开游戏」/u);
  }
  await assert.rejects(h.control.connect(),/游戏已关闭/u);
  await command(h.control,'stop');await h.control.tick();
  assert.equal(h.control.phase,'closed');assert.equal(h.connections,0);assert.equal(closes,1);
  assert.equal(h.control.command('library',{view:'inventory',automatic:true}).skipped,'stopped');
});

test('explicit open only connects; start still verifies state and keeps navigation evidence and marrow clock',async()=>{
  const h=await setup({closeGamePage:async()=>{}});await h.control.connect();
  const runner=h.control.runner;runner.pendingEntry={at:10,target:base.target};
  const timer=structuredClone(h.control.consumables.state);
  await command(h.control,'close-game');assert.equal(h.control.runner,runner);assert.ok(runner.pendingEntry);
  await command(h.control,'open-game');
  assert.equal(h.control.record.gameClosed,false);assert.equal(h.control.record.desired,'stopped');assert.equal(h.control.phase,'stopped');
  assert.equal(runner.pendingEntry,null);assert.deepEqual(h.actions,[]);
  await command(h.control,'start');assert.equal(h.control.record.desired,'running');assert.deepEqual(h.actions,['inspect']);
  assert.deepEqual(h.control.consumables.state,timer);
});

test('close waits for an in-flight confirmation, cancels queued work and merges duplicate clicks',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),actions=[];
  const h=await setup({closeGamePage:async()=>actions.push('close')});
  await h.control.connect();h.control.record.desired='running';
  h.control.inventoryActions.equip=async()=>{actions.push('issued');entered();await gate;h.ui.beforeAction('核对已发出动作',{cleanup:true});actions.push('confirmed');};
  const item=h.control.command('inventory-equip',{id:'instance:item-1',slot:'head',requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});await ready;
  const start=h.control.command('start'),close=h.control.command('close-game');
  assert.equal(h.control.command('close-game'),close);assert.equal(h.control.snapshot().closingGame,true);
  assert.throws(()=>h.control.command('open-game'),/正在关闭/u);
  assert.deepEqual(actions,['issued']);release();
  assert.equal((await item.promise).ok,true);assert.equal((await start.promise).ok,false);assert.equal((await close.promise).ok,true);
  assert.deepEqual(actions,['issued','confirmed','close']);assert.equal(h.control.stopRequests,0);assert.equal(h.control.record.desired,'stopped');
});

test('close preserves unconfirmed sale evidence, cancels remaining intent, and blocks review until explicit open',async()=>{
  const h=await setup({closeGamePage:async()=>{}}),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const pending={line:{id:'instance:item-1'},quantity:1,issuedAt:12};
  h.control.inventoryActions.data={version:1,activeId:id,previews:{},operations:{[id]:{id,lines:[],stage:'awaiting-review',pending,resumeDesired:true}}};
  await command(h.control,'close-game');
  const op=h.control.inventoryActions.active;assert.deepEqual(op.pending,pending);assert.equal(op.resumeDesired,false);assert.equal(op.cancelRequested,true);
  const result=await h.control.command('inventory-review',{operationId:id}).promise;assert.equal(result.ok,false);assert.equal(h.connections,0);
  assert.equal(h.control.inventoryActions.active.id,id);assert.match(h.control.reason,/未确认操作记录已保留/u);
});

test('persisted close survives controller restart and suppresses startup reviews and deferred reads',async()=>{
  const h=await setup({closeGamePage:async()=>{}});await command(h.control,'close-game');
  let closes=0,opens=0;
  const restored=new BattleControl({base,directory:h.directory,runtime:h.control.runtime,signal:h.abort.signal,log:()=>{},
    makeUI:async()=>{opens++;throw Error('must not launch');},closeGamePage:async()=>closes++});
  try{
    await restored.initialize();restored.crafting.startupReviewId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    restored.libraryDeferred={view:'inventory'};
    await new Promise(r=>setTimeout(r,600));
    assert.equal(restored.phase,'closed');assert.equal(restored.record.desired,'stopped');assert.equal(opens,0);assert.equal(closes,1);
    assert.equal(restored.crafting.startupReviewId,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  }finally{restored.close();}
});

test('close disk failure still disconnects, stops reconnects and reports persistence failure',async()=>{
  let closes=0;const h=await setup({closeGamePage:async()=>closes++});
  h.control.persist=async()=>{throw Error('disk full');};
  const result=await h.control.command('close-game').promise;
  assert.equal(result.ok,false);assert.match(result.error,/关闭状态无法保存/u);assert.equal(closes,1);
  assert.equal(h.control.record.gameClosed,true);assert.equal(h.control.record.desired,'stopped');
  await h.control.tick();assert.equal(h.connections,0);
});

test('page close failure is visible and retry does not reopen the game',async()=>{
  let attempts=0;const h=await setup({closeGamePage:async()=>{if(++attempts===1)throw Error('page close failed');}});
  assert.equal((await h.control.command('close-game').promise).ok,false);assert.equal(h.control.phase,'attention');
  await command(h.control,'close-game');assert.equal(h.control.phase,'closed');assert.equal(attempts,2);assert.equal(h.connections,0);
});

test('catalog orders future marrow definitions by potency rather than bundle position',()=>{
  const updated=source.replace("red:{name:'赤灵髓',kind:'marrow'},green:{name:'碧灵髓',kind:'marrow'},new:{name:'金灵髓',kind:'marrow'}",
    "new:{name:'新灵髓',kind:'marrow',marrowValue:1000},green:{name:'碧灵髓',kind:'marrow',marrowValue:200},red:{name:'赤灵髓',kind:'marrow',marrowValue:100},unknown:{name:'待核实灵髓',kind:'marrow'}");
  const result=parseCatalog(updated);
  assert.deepEqual(result.items.map(i=>i.id),['red','green','new','unknown']);
  assert.equal(result.items[0].marrowValue,100);
});

test('stop gets a queue boundary after fast healing stop, before any immediate re-entry', async () => {
  const h = await setup({ now: () => 10000 });
  await h.control.connect();
  h.control.needsPreflight = false; h.control.record.desired = 'running';
  h.control.consumables.runIfDue = async () => {};
  Object.assign(h.state, { mode: 'rest', location: '北泉', heal: { running: true, enabled: false } });
  h.ui.stopHealing = async () => { h.actions.push('stop-heal'); h.state.heal.running = false; };
  h.ui.enterTarget = async () => assert.fail('stop must prevent re-entry');
  await h.control.tick();
  assert.equal(h.control.nextTick, 10000);
  await command(h.control, 'stop');
  await h.control.tick();
  assert.equal(h.control.record.desired, 'stopped');
  assert.deepEqual(h.actions, ['stop-heal']);
});

test('resume reconciles a resting pending entry without defeat logs but not a stage preview', async () => {
  const h = await setup(); await h.control.connect();
  const attempt = { at: 0, target: base.target, before: { health: { current: '100', maximum: '100' }, battleFeedback: { repeatStage: '石阶', defeats: ['old'] } } };
  h.control.runner.pendingEntry = structuredClone(attempt);
  h.state.mode = 'ready'; h.control.reconcile(h.state);
  assert.ok(h.control.runner.pendingEntry);
  Object.assign(h.state, { mode: 'rest', location: '北泉', health: { current: '5', maximum: '100' } });
  await command(h.control, 'resume');
  assert.equal(h.control.runner.pendingEntry, null); assert.equal(h.control.record.desired, 'running');
  assert.deepEqual(h.actions, ['inspect']);
});

test('resume and library reads clear superseded healing travel only after target combat is confirmed',async()=>{
  const reads=[];
  const h=await setup({libraryReader:()=>({read:async view=>{reads.push(view);return {view,items:[],equipment:[],updatedAt:Date.now()};}})});
  await h.control.connect();h.control.runner.pendingHealingTravel={at:0};
  h.control.phase='attention';h.control.reason='旧调息行程待确认';
  const timer=structuredClone(h.control.consumables.state);
  await command(h.control,'resume');assert.equal(h.control.runner.pendingHealingTravel,null);
  await command(h.control,'library',{view:'inventory'});
  assert.deepEqual(reads,['inventory']);assert.deepEqual(h.actions,['inspect']);
  assert.deepEqual(h.control.consumables.state,timer);assert.equal(h.control.record.desired,'running');
});

test('library refresh and detail are serialized and cached; duplicate requests merge without starting stopped battle',async()=>{
  let entered,release,reads=0;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const value=view=>({view,updatedAt:Date.now(),items:[{key:'a'.repeat(64),name:'碧灵髓',quantity:'3'}],equipment:[]});
  const h=await setup({libraryReader:()=>({read:async view=>{reads++;entered();await gate;return value(view);}})});
  const first=h.control.command('library',{view:'inventory'});await ready;
  assert.equal(h.control.command('library',{view:'inventory'}),first);
  const second=h.control.command('library',{view:'crafting'});assert.notEqual(first,second);assert.equal(reads,1);
  release();assert.equal((await first.promise).ok,true);assert.equal((await second.promise).ok,true);
  assert.equal(reads,2);assert.equal(h.control.library.revision,2);assert.equal(h.control.record.desired,'stopped');
  assert.equal(h.control.library.views.inventory.items[0].quantity,'3');
  assert.equal(JSON.parse(await readFile(path.join(h.directory,'library.json'))).revision,2);
});

test('automatic library requests coalesce across clients, throttle views globally and publish snapshots immediately',async()=>{
  let now=10000,reads=0,release,entered;
  const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const h=await setup({now:()=>now,libraryReader:()=>({read:async view=>{reads++;entered();await gate;return {view,updatedAt:now,items:[],equipment:[]};}})});
  h.control.record.desired='running';h.control.phase='running';
  const revisions=[];h.control.on('change',s=>revisions.push(s.library.revision));
  const first=h.control.command('library',{view:'inventory',automatic:true});await ready;
  assert.equal(h.control.command('library',{view:'inventory',automatic:true}),first);
  assert.ok(h.control.command('library',{view:'crafting',automatic:true}).skipped);
  release();assert.equal((await first.promise).ok,true);assert.equal(reads,1);
  assert.ok(revisions.includes(1));assert.equal(h.control.command('library',{view:'inventory',automatic:true}).skipped,'fresh');
  now+=60100;
  assert.equal((await h.control.command('library',{view:'crafting',automatic:true}).promise).ok,true);
  assert.equal(reads,2);assert.equal(h.control.record.desired,'running');
});

test('automatic library sync yields to healing, navigation, stop, crafting and fresh game-state changes',async()=>{
  const h=await setup({libraryReader:()=>({read:async()=>assert.fail('must defer automatic navigation')})});
  h.control.record.desired='running';
  for(const phase of ['healing','switching','checking','recovering','attention','retrying','stopping']){
    h.control.phase=phase;assert.equal(h.control.command('library',{view:'inventory',automatic:true}).skipped,'busy');
  }
  h.control.phase='running';h.control.stopRequests=1;
  assert.equal(h.control.command('library',{view:'inventory',automatic:true}).skipped,'stopped');h.control.stopRequests=0;
  h.control.record.desired='running';h.state.mode='rest';
  const result=await h.control.command('library',{view:'inventory',automatic:true}).promise;
  assert.equal(result.ok,true);assert.ok(result.skipped);assert.equal(h.control.library.revision,0);
  assert.throws(()=>h.control.command('library',{view:'inventory',key:'a'.repeat(64),automatic:true}),/列表/u);
});

test('failed automatic reads retain last data and back off, while explicit refresh remains available',async()=>{
  let fail=false,now=10000;
  const h=await setup({now:()=>now,libraryReader:()=>({read:async view=>{if(fail)throw new Error('结构变化');return {view,updatedAt:now,items:[],equipment:[]};}})});
  await command(h.control,'library',{view:'inventory'});const cached=h.control.library;
  h.control.record.desired='running';h.control.phase='running';
  fail=true;now+=60100;
  assert.equal((await h.control.command('library',{view:'inventory',automatic:true}).promise).ok,false);
  assert.equal(h.control.library,cached);assert.equal(h.control.librarySyncAt,now+60000);
  assert.equal(h.control.command('library',{view:'inventory',automatic:true}).skipped,'throttled');
  fail=false;await command(h.control,'library',{view:'inventory'});assert.equal(h.control.libraryErrors.inventory,undefined);
});
test('library response or write failure retains last snapshot and timer; unresolved game actions forbid page switching',async()=>{
  const h=await setup({libraryReader:()=>({read:async view=>({view,updatedAt:Date.now(),items:[],equipment:[]})})});
  await h.control.consumables.save({version:1,nextAt:Date.now()+600000,results:{}});
  await command(h.control,'library',{view:'inventory'});const saved=h.control.library,next=h.control.consumables.state.nextAt;
  h.control.libraryReader=()=>({read:async()=>{throw new Error('layout changed');}});
  assert.equal((await h.control.command('library',{view:'inventory'}).promise).ok,false);assert.equal(h.control.library,saved);
  assert.match(h.control.snapshot().library.errors.inventory,/layout changed/u);assert.equal(h.control.consumables.state.nextAt,next);
  h.control.runner.pendingEntry={at:Date.now()};h.state.mode='unknown';
  const result=await h.control.command('library',{view:'crafting'}).promise;assert.equal(result.ok,false);assert.match(result.error,/上一游戏动作/u);
  h.control.runner.pendingEntry=null;h.control.libraryReader=()=>({read:async view=>({view,items:[],equipment:[]})});
  h.control.write=async()=>{throw new Error('disk full');};assert.equal((await h.control.command('library',{view:'inventory'}).promise).ok,false);assert.equal(h.control.library,saved);
});
test('stop received during library read allows only owned view cleanup before retreat',async()=>{
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const actions=[];
  const h=await setup({libraryReader:ui=>({read:async()=>{entered();await gate;assert.throws(()=>ui.beforeAction('next item'),ControlInterrupted);ui.beforeAction('关闭查看详情',{cleanup:true});actions.push('closed');ui.beforeAction('查看后返回游历',{cleanup:true});actions.push('returned');return{items:[],equipment:[]};}})});
  const read=h.control.command('library',{view:'inventory'});await ready;const stop=h.control.command('stop');release();
  assert.equal((await read.promise).ok,true);assert.equal((await stop.promise).ok,true);assert.deepEqual(actions,['closed','returned']);assert.deepEqual(h.actions,['retreat']);
});

test('a full viewer queue cannot reject or delay the stop fence',async()=>{
  let entered,release,reads=0;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const h=await setup({libraryReader:()=>({read:async()=>{reads++;entered();await gate;return{items:[],equipment:[]};}})});
  const first=h.control.command('library',{view:'inventory'});await ready;
  for(let i=0;i<9;i++)h.control.command('library',{view:'inventory',key:String(i).repeat(64)});
  assert.equal(h.control.pending.size,10);assert.equal(h.control.command('library',{view:'inventory'}),first);
  const stop=h.control.command('stop');assert.equal(h.control.stopRequests,1);release();
  assert.equal((await stop.promise).ok,true);assert.equal(reads,1);assert.equal(h.control.phase,'stopped');
});

test('one-minute batches merge clients, publish each page, and manual refresh bypasses the budget',async()=>{
  let now=100000,reads=[];const h=await setup({now:()=>now,libraryReader:()=>({read:async view=>{reads.push(view);return {view,updatedAt:now,items:[],equipment:[]};}})});
  h.control.record.desired='running';h.control.phase='running';
  const first=h.control.command('library',{views:['inventory','crafting'],automatic:true});assert.equal(h.control.command('library',{views:['crafting','inventory'],automatic:true}),first);
  const revisions=[];h.control.on('change',s=>revisions.push(s.library.revision));await first.promise;
  assert.deepEqual(reads,['inventory','crafting']);assert.ok(revisions.includes(1)&&revisions.includes(2));assert.equal(h.control.snapshot().library.sync.intervalMs,60000);
  now+=59000;assert.ok(h.control.command('library',{views:['inventory','crafting'],automatic:true}).skipped);
  await command(h.control,'library',{views:['inventory','crafting']});assert.equal(reads.length,4);
  now+=60001;await command(h.control,'library',{views:['inventory','crafting'],automatic:true});assert.equal(reads.length,6);
});
test('a failed batch page retains old data and still updates the other page; automatic retries wait a minute',async()=>{
  let fail=false,now=100000;const h=await setup({now:()=>now,libraryReader:()=>({read:async view=>{if(fail&&view==='inventory')throw new Error('读取失败');return {view,updatedAt:now,items:[],equipment:[]};}})});
  await command(h.control,'library',{views:['inventory','crafting']});const old=h.control.library.views.inventory;
  h.control.record.desired='running';h.control.phase='running';
  fail=true;now+=61000;const result=await h.control.command('library',{views:['inventory','crafting'],automatic:true}).promise;
  assert.equal(result.partial,true);assert.equal(h.control.library.views.inventory,old);assert.equal(h.control.library.views.crafting.updatedAt,now);assert.equal(h.control.librarySyncAt,now+60000);
  fail=false;await command(h.control,'library',{views:['inventory','crafting']});assert.equal(h.control.libraryErrors.inventory,undefined);
});
test('death between batch pages defers remaining page and permits battle recovery before continuation',async()=>{
  const reads=[];let h;h=await setup({libraryReader:()=>({read:async view=>{reads.push(view);h.state.mode='rest';return {view,updatedAt:Date.now(),items:[],equipment:[]};}})});
  h.control.record.desired='running';h.control.phase='running';
  const result=await h.control.command('library',{views:['inventory','crafting'],automatic:true}).promise;
  assert.equal(result.deferred,true);assert.deepEqual(reads,['inventory']);assert.deepEqual(h.control.libraryDeferred.views,['crafting']);assert.equal(h.control.nextTick,0);
  h.state.mode='combat';await h.control.command('library',h.control.libraryDeferred,{continuation:true}).promise;assert.deepEqual(reads,['inventory','crafting']);assert.equal(h.control.libraryDeferred,null);
});

test('bestiary uses the shared queue, only exposes encountered enemies, and rejects mismatched resource versions',async()=>{
  let resourceUrl='resource',reads=0;
  const knowledge={version:1,revision:'rev',resourceUrl:'resource',items:[{id:'ore',name:'矿'}],recipes:[],maps:[],enemies:[{id:'rat',name:'鼠',stats:{},loot:[{itemId:'ore',chance:.1}]},{id:'hidden',name:'未遭遇',stats:{},loot:[]}]};
  const h=await setup({knowledgeLoader:async()=>knowledge,bestiaryReader:()=>({read:async()=>{reads++;return {resourceUrl,updatedAt:123,entries:[{name:'鼠',lootText:'掉落：矿',kills:'2'}]};}})});
  const result=await h.control.command('bestiary').promise;assert.equal(result.ok,true);assert.equal(h.control.getBestiary().entries.length,1);assert.equal(h.control.getBestiary().entries[0].id,'rat');assert.equal(h.control.record.desired,'stopped');
  const saved=h.control.bestiary;resourceUrl='changed';assert.equal((await h.control.command('bestiary').promise).ok,false);assert.equal(h.control.bestiary,saved);assert.match(h.control.bestiaryError,/版本/u);assert.equal(reads,2);
});

const syncKnowledge={revision:'sync-v1',resourceUrl:'sync-resource',items:[],enemies:[],recipes:[],maps:[]};
const syncViews=['inventory','crafting','bestiary'];

test('bestiary refresh repairs an old map version from the same bundle, inspects once, and updates both recommendations',async()=>{
  const knowledge={...syncKnowledge,revision:'v2',resourceUrl:'new-resource',items:[{id:'red',name:'赤灵髓',kind:'marrow'},{id:'pill',name:'丹',kind:'material'}],
    recipes:[{id:'pill',name:'丹',type:'普通炼制',output:'pill',outputCount:1,materials:{red:2}}],
    enemies:[{id:'rat',name:'鼠',realm:1,stats:{},abilities:{},loot:[{itemId:'red',chance:1}]}],
    maps:[{id:'a',name:'石阶',pool:['rat'],groups:2,groupSize:1,enemyMultiplier:1,encounterPools:{}}]};
  const fresh={...catalog(),resourceUrl:'new-resource'},h=await setup({knowledgeLoader:async()=>({knowledge,catalog:structuredClone(fresh)}),
    bestiaryReader:()=>({read:async()=>({resourceUrl:'new-resource',updatedAt:123,entries:[{name:'鼠',lootText:'赤灵髓'}]})})});
  h.control.knowledge=knowledge;h.control.bestiary={knowledgeRevision:'v2',resourceUrl:'new-resource',revision:1,entries:[{id:'rat'}]};
  h.control.catalog={...catalog(),resourceUrl:'old-resource',checkedAt:1};
  h.control.library.views={inventory:{items:[]},crafting:{items:[{key:'recipe',name:'丹',recipeType:'普通炼制'}]}};
  assert.equal(h.control.planFarming({recipeKey:'recipe'}).stale,true);
  assert.equal(h.control.planMarrow().bestMapId,null);
  const timer=structuredClone(h.control.consumables.state),settings=structuredClone(h.control.record);
  await command(h.control,'bestiary');
  assert.equal(h.control.planFarming({recipeKey:'recipe'}).stale,false);assert.equal(h.control.planMarrow().bestMapId,'a');
  assert.deepEqual(h.actions,['inspect']);assert.deepEqual(h.control.record,settings);assert.deepEqual(h.control.consumables.state,timer);
  for(const file of ['catalog','knowledge','bestiary'])assert.equal(JSON.parse(await readFile(path.join(h.directory,file+'.json'),'utf8')).resourceUrl,'new-resource');
  await command(h.control,'bestiary');assert.deepEqual(h.actions,['inspect'],'same-version periodic read must not revisit map');
});

test('version synchronization uses actual locked map evidence and preserves all cached projections on scan failure',async()=>{
  const fresh={...catalog(),resourceUrl:'new'},knowledge={...syncKnowledge,resourceUrl:'new'};
  const h=await setup({locked:'a',knowledgeLoader:async()=>({knowledge,catalog:fresh}),bestiaryReader:()=>({read:async()=>({resourceUrl:'new',entries:[],updatedAt:1})})});
  h.control.catalog={...catalog(),resourceUrl:'old',checkedAt:1,nodes:catalog().nodes.map(n=>({...n,availability:'visible'}))};
  const old=h.control.catalog;h.ui.inspectCatalog=async()=>{throw Error('map scan failed');};
  const result=await h.control.command('bestiary').promise;assert.equal(result.ok,false);assert.equal(h.control.catalog,old);assert.equal(h.control.knowledge,null);assert.equal(h.control.bestiary,null);
  h.ui.inspectCatalog=async c=>({...c,checkedAt:123,nodes:c.nodes.map(n=>({...n,availability:n.id==='a'?'locked':'unverified'}))});
  await command(h.control,'bestiary');assert.equal(h.control.catalog.nodes.find(n=>n.id==='a').availability,'locked');
  assert.equal(h.control.catalog.nodes.find(n=>n.id==='b').availability,'unverified');
});

test('version synchronization rejects an old game page and stops at queue boundaries without scanning or publishing mixed data',async()=>{
  let version='old';const fresh={...catalog(),resourceUrl:'new'},knowledge={...syncKnowledge,resourceUrl:'new'};
  const h=await setup({knowledgeLoader:async()=>({knowledge,catalog:fresh}),bestiaryReader:()=>({read:async()=>({resourceUrl:version,entries:[],updatedAt:1})})});
  assert.equal((await h.control.command('bestiary').promise).ok,false);assert.deepEqual(h.actions,[]);
  version='new';h.ui.inspectCatalog=async c=>{h.control.stopRequests++;return {...c,checkedAt:1};};
  assert.equal((await h.control.command('bestiary').promise).ok,false);assert.equal(h.control.knowledge,null);assert.equal(h.control.bestiary,null);assert.equal(h.control.catalog,null);
  h.control.stopRequests--;
});

test('refresh map entry also refreshes outdated bestiary and loot without a second map scan',async()=>{
  let reads=0;const fresh={...catalog(),resourceUrl:'new'},knowledge={...syncKnowledge,resourceUrl:'new',revision:'new'};
  const h=await setup({catalogLoader:async()=>fresh,knowledgeLoader:async()=>({knowledge,catalog:fresh}),bestiaryReader:()=>({read:async()=>{reads++;return {resourceUrl:'new',updatedAt:1,entries:[]};}})});
  h.control.knowledge={...syncKnowledge,resourceUrl:'old'};h.control.bestiary={knowledgeRevision:syncKnowledge.revision,resourceUrl:'old',entries:[]};
  await command(h.control,'refresh');assert.equal(reads,1);assert.deepEqual(h.actions,['inspect']);assert.equal(h.control.knowledge.resourceUrl,'new');assert.equal(h.control.bestiary.resourceUrl,'new');
});

test('stopped battle rejects old-panel automatic reads before connecting, but explicit three-page refresh works',async()=>{
  const reads=[],h=await setup({knowledgeLoader:async()=>syncKnowledge,
    libraryReader:()=>({read:async view=>{reads.push(view);return {items:[],equipment:[],updatedAt:1};}}),
    bestiaryReader:()=>({read:async()=>{reads.push('bestiary');return {resourceUrl:syncKnowledge.resourceUrl,entries:[],updatedAt:1};}})});
  for(const [kind,payload] of [['library',{views:syncViews}],['library',{view:'inventory'}],['library',{view:'crafting'}],['bestiary',{}]]){
    assert.equal(h.control.command(kind,{...payload,automatic:true}).skipped,'stopped');
    assert.equal((await h.control.execute(kind,{...payload,automatic:true})).skipped,'stopped');
  }
  assert.equal(h.connections,0);assert.deepEqual(reads,[]);assert.equal(h.control.librarySyncAt,undefined);
  await command(h.control,'library',{views:syncViews});assert.deepEqual(reads,syncViews);assert.equal(h.control.record.desired,'stopped');
});

test('automatic work queued before stop is skipped and deferred pages cannot resume while stopped',async()=>{
  const h=await setup({libraryReader:()=>({read:async()=>assert.fail('stopped refresh must not open pages')})});
  h.control.record.desired='running';h.control.phase='running';
  let release;const gate=new Promise(r=>release=r);void h.control.serial(()=>gate);
  const read=h.control.command('library',{views:syncViews,automatic:true}),stop=h.control.command('stop');release();
  assert.equal((await read.promise).skipped,'stopped');assert.equal((await stop.promise).ok,true);
  assert.equal(h.control.command('library',{views:['crafting','bestiary'],automatic:true},{continuation:true}).skipped,'stopped');
  assert.equal(h.control.libraryDeferred,null);assert.equal(h.control.library.revision,0);
  assert.deepEqual(h.actions,['retreat']);
});

test('stop during automatic batch lets current page clean up, cancels remaining pages and starts no new automatic reads',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),reads=[];
  const h=await setup({knowledgeLoader:async()=>assert.fail('no bestiary download after stopping'),libraryReader:()=>({read:async view=>{reads.push(view);enter();await gate;return {items:[],equipment:[],updatedAt:1};}})});
  h.control.record.desired='running';h.control.phase='running';
  const read=h.control.command('library',{views:syncViews,automatic:true});await entered;
  const stop=h.control.command('stop');release();assert.equal((await read.promise).skipped,'stopped');assert.equal((await stop.promise).ok,true);
  assert.deepEqual(reads,['inventory']);assert.equal(h.control.libraryDeferred,null);
});
test('three-page refresh merges clients and throttles against the oldest page, with manual refresh available',async()=>{
  let now=100000,reads=[];
  const h=await setup({now:()=>now,knowledgeLoader:async()=>syncKnowledge,
    libraryReader:()=>({read:async view=>{reads.push(view);return {items:[],equipment:[],updatedAt:now};}}),
    bestiaryReader:()=>({read:async()=>{reads.push('bestiary');return {resourceUrl:syncKnowledge.resourceUrl,entries:[],updatedAt:now};}})});
  h.control.record.desired='running';h.control.phase='running';
  const first=h.control.command('library',{views:syncViews,automatic:true});
  assert.equal(h.control.command('library',{views:[...syncViews].reverse(),automatic:true}),first);
  const result=await first.promise;assert.equal(result.ok,true);assert.deepEqual(result.completed,syncViews);assert.deepEqual(reads,syncViews);
  assert.equal(h.control.record.desired,'running');assert.equal(h.control.bestiary.revision,1);
  now+=60001;h.control.library.views.inventory.updatedAt=now;h.control.library.views.crafting.updatedAt=now;
  await command(h.control,'library',{views:syncViews,automatic:true});assert.equal(reads.length,6);
  assert.equal(h.control.command('library',{views:syncViews,automatic:true}).skipped,'fresh');
  await command(h.control,'library',{views:syncViews});assert.equal(reads.length,9);
  assert.throws(()=>h.control.command('library',{views:['bestiary','bestiary']}),/无效/u);
  assert.throws(()=>h.control.command('library',{views:['inventory','unknown']}),/无效/u);
});

test('failed bestiary refresh keeps old data and backs off without blocking inventory, recipes or a manual retry',async()=>{
  let now=100000,fail=false;
  const h=await setup({now:()=>now,knowledgeLoader:async()=>syncKnowledge,
    libraryReader:()=>({read:async()=>({items:[],equipment:[],updatedAt:now})}),
    bestiaryReader:()=>({read:async()=>{if(fail)throw new Error('图鉴临时失败');return {resourceUrl:syncKnowledge.resourceUrl,entries:[],updatedAt:now};}})});
  await command(h.control,'library',{views:syncViews});const saved=h.control.bestiary;
  h.control.record.desired='running';h.control.phase='running';
  now+=60001;fail=true;const result=await command(h.control,'library',{views:syncViews,automatic:true});
  assert.equal(result.partial,true);assert.deepEqual(result.completed,['inventory','crafting']);assert.equal(h.control.bestiary,saved);assert.match(h.control.bestiaryError,/临时失败/u);
  assert.equal(h.control.library.views.inventory.updatedAt,now);assert.equal(h.control.command('library',{views:syncViews,automatic:true}).skipped,'throttled');
  fail=false;await command(h.control,'library',{views:syncViews});assert.equal(h.control.bestiaryError,'');assert.equal(h.control.bestiary.revision,2);
});

test('death while downloading bestiary definitions defers only the remaining page and then resumes once',async()=>{
  const reads=[];let h,die=true;
  h=await setup({knowledgeLoader:async()=>{if(die)h.state.mode='rest';return syncKnowledge;},
    libraryReader:()=>({read:async view=>{reads.push(view);return {items:[],equipment:[],updatedAt:Date.now()};}}),
    bestiaryReader:()=>({read:async()=>{reads.push('bestiary');return {resourceUrl:syncKnowledge.resourceUrl,entries:[],updatedAt:Date.now()};}})});
  h.control.record.desired='running';h.control.phase='running';
  const result=await command(h.control,'library',{views:syncViews,automatic:true});assert.equal(result.deferred,true);assert.deepEqual(reads,['inventory','crafting']);assert.deepEqual(h.control.libraryDeferred.views,['bestiary']);
  die=false;h.state.mode='combat';await h.control.command('library',h.control.libraryDeferred,{continuation:true}).promise;
  assert.deepEqual(reads,syncViews);assert.equal(h.control.libraryDeferred,null);assert.equal(h.control.record.desired,'running');
});

test('stop queued during recipe reading cancels the remaining bestiary page',async()=>{
  let enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const h=await setup({knowledgeLoader:async()=>assert.fail('stop must cancel the bestiary download'),
    libraryReader:()=>({read:async view=>{if(view==='crafting'){enter();await gate;}return {items:[],equipment:[],updatedAt:Date.now()};}})});
  const job=h.control.command('library',{views:syncViews});await ready;
  const stop=h.control.command('stop');release();assert.equal((await job.promise).ok,false);assert.equal((await stop.promise).ok,true);assert.equal(h.control.phase,'stopped');assert.equal(h.control.libraryDeferred,null);
});

test('catalog AST extraction classifies every node without executing source or relying on symbols',()=>{
  const c=catalog();assert.equal(c.regions.length,2);assert.equal(c.nodes.length,6);
  assert.equal(c.nodes.filter(n=>n.type==='healing').length,2);assert.equal(c.nodes.find(n=>n.id==='c').type,'challenge');assert.equal(c.nodes.find(n=>n.id==='f').type,'rest');
  assert.equal(targetNode(c,{regionName:'南境',stageName:'石阶'},'battle').id,'d');
  assert.throws(()=>targetNode(c,{regionName:'北境',stageName:'决战'},'battle'));
  assert.throws(()=>targetNode(c,{regionName:'南境',locationName:'阵台'},'healing'));
});
test('changed resource identifiers parse; incomplete or ambiguous definitions never replace valid catalogs',()=>{
  assert.equal(parseCatalog(source.replaceAll('factory','newMinifiedName').replace('whatever','Z99')).nodes.length,6);
  assert.throws(()=>parseCatalog(source.replace("['a','b','c']","['missing','b','c']")),/缺失/u);
  assert.throws(()=>parseCatalog(source+" const duplicate={a:{...other('石阶','start',[])}};"),/重名/u);
});
test('closed consumables retain explicit selection; new catalog items never get automatic permission',()=>{
  const settings=initialSettings(base);settings.consumables.enabled=false;
  assert.deepEqual(validateSettings(settings,catalog()).consumables,{enabled:false,itemNames:['赤灵髓','碧灵髓'],intervalMinutes:10,quantity:'all'});
  settings.consumables.itemNames.push('无名灵髓');assert.throws(()=>validateSettings(settings,catalog()));
});
test('matching stage also retreats on stop, stopped intent persists, and save does not start it',async()=>{
  const h=await setup();await command(h.control,'start');await command(h.control,'stop');
  assert.equal(h.actions.filter(a=>a==='retreat').length,1);assert.equal(h.control.phase,'stopped');
  const settings=initialSettings(base);settings.healingTarget={regionName:'南境',locationName:'南泉'};
  await command(h.control,'settings',{revision:1,settings});assert.equal(h.control.record.desired,'stopped');
  assert.equal(JSON.parse(await readFile(path.join(h.directory,'settings.json'))).desired,'stopped');
  assert.equal(h.control.config.healingTarget.regionName,'南境');
});
test('failed atomic settings persistence leaves active settings and revision unchanged',async()=>{
  const h=await setup();await command(h.control,'refresh');
  h.control.write=async(file,value)=>{if(file.endsWith('settings.json'))throw new Error('disk full');return atomicJson(file,value);};
  const settings=initialSettings(base);settings.target.regionName='南境';
  const result=await h.control.command('settings',{revision:1,settings}).promise;
  assert.equal(result.ok,false);assert.equal(h.control.config.target.regionName,'北境');assert.equal(h.control.record.revision,1);
});
test('locked and unsupported destinations cannot be applied or started',async()=>{
  const h=await setup({locked:'a'});const result=await h.control.command('start').promise;
  assert.equal(result.ok,false);assert.match(result.error,/锁定/u);assert.equal(h.actions.includes('retreat'),false);
  assert.equal(h.control.record.desired,'stopped');
});
test('refresh failure retains previous catalog and exposes its reason',async()=>{
  const h=await setup();await command(h.control,'refresh');const previous=h.control.catalog;
  h.control.catalogLoader=async()=>{throw new Error('resource changed');};
  const result=await h.control.command('refresh').promise;assert.equal(result.ok,false);assert.equal(h.control.catalog,previous);assert.match(h.control.catalogError,/resource changed/u);
});
test('two pages with stale revisions cannot overwrite each other',async()=>{
  const h=await setup();await command(h.control,'refresh');
  await command(h.control,'settings',{revision:1,settings:initialSettings(base)});
  const result=await h.control.command('settings',{revision:1,settings:initialSettings(base)}).promise;assert.equal(result.ok,false);assert.match(result.error,/另一页面/u);
});
test('resume and restart preserve the browser adapter, pending action and consumable deadline',async()=>{
  const h=await setup();await command(h.control,'start');
  await h.control.consumables.save({version:1,nextAt:Date.now()+600000,results:{'赤灵髓':{before:3,after:0}}});
  const next=h.control.consumables.state.nextAt;h.control.runner.healPending=true;
  await command(h.control,'restart');assert.equal(h.control.ui,h.ui);assert.equal(h.control.runner.healPending,true);assert.equal(h.control.consumables.state.nextAt,next);
  await command(h.control,'resume');assert.equal(h.control.consumables.state.nextAt,next);
});
test('save conflict pauses only this controller, manual resolution resumes without process restart',async()=>{
  const h=await setup();const original=h.ui.inspectCatalog;
  h.ui.inspectCatalog=async()=>{throw new PauseError('存档冲突');};
  const result=await h.control.command('start').promise;assert.equal(result.ok,false);assert.equal(h.control.phase,'attention');
  h.ui.inspectCatalog=original;await command(h.control,'resume');assert.equal(h.control.record.desired,'running');
});
test('duplicate stop requests share one command; stop fences navigation before another click',async()=>{
  const h=await setup();await command(h.control,'start');h.control.consumables.config.enabled=false;
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  h.control.runner.step=async()=>{entered();await gate;h.ui.beforeAction('开始探索');h.actions.push('entered');};
  const tick=h.control.serial(()=>h.control.tick());await ready;
  const first=h.control.command('stop'),second=h.control.command('stop');assert.equal(first,second);
  release();await tick;assert.equal((await first.promise).ok,true);assert.equal(h.actions.includes('entered'),false);assert.equal(h.actions.filter(a=>a==='retreat').length,1);
});
test('stop during marrow response confirms issued item and blocks the second item without resetting timer',async()=>{
  const h=await setup();await command(h.control,'start');
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  h.ui.consumeAllApproved=async name=>{h.ui.beforeAction(name);h.actions.push(name);entered();await gate;return{before:2,after:0};};
  const tick=h.control.serial(()=>h.control.tick());await ready;const stop=h.control.command('stop');release();await tick;await stop.promise;
  assert.equal(h.actions.filter(a=>a==='赤灵髓').length,1);assert.equal(h.actions.includes('碧灵髓'),false);
  const record=JSON.parse(await readFile(h.control.consumables.filename));assert.ok(record.nextAt>Date.now());assert.equal(record.results['赤灵髓'].after,0);assert.ok(record.results['碧灵髓'].uncertain);
});
test('uncertain retreat is never reported as stopped and is not repeated by a second stop',async()=>{
  const h=await setup();await command(h.control,'start');
  h.ui.retreatForTarget=async()=>{h.actions.push('retreat');throw new Error('response timeout');};
  const result=await h.control.command('stop').promise;assert.equal(result.ok,false);assert.match(result.error,/撤退未确认/u);assert.equal(h.control.record.desired,'stopped');
  await h.control.command('stop').promise;assert.equal(h.actions.filter(a=>a==='retreat').length,1);
});
test('retreat click success with a lost response is confirmed by rereading, without a duplicate',async()=>{
  const h=await setup();await command(h.control,'start');
  h.ui.retreatForTarget=async()=>{h.actions.push('retreat');h.state.mode='rest';throw new Error('response timeout');};
  await command(h.control,'stop');assert.equal(h.control.phase,'stopped');assert.equal(h.actions.filter(a=>a==='retreat').length,1);
});
test('stopped intent and timer survive a new controller; disabling consumables retains the same deadline',async()=>{
  const h=await setup();await command(h.control,'refresh');
  const nextAt=Date.now()+600000;await h.control.consumables.save({version:1,nextAt,results:{}});
  const settings=initialSettings(base);settings.consumables.enabled=false;await command(h.control,'settings',{revision:1,settings});
  const second=new BattleControl({base,runtime:h.control.runtime,directory:h.directory,signal:h.abort.signal,makeUI:async()=>h.ui,log:()=>{},catalogLoader:async()=>catalog()});
  await second.initialize();second.close();assert.equal(second.phase,'stopped');assert.equal(second.consumables.state.nextAt,nextAt);assert.deepEqual(second.record.settings.consumables.itemNames,['赤灵髓','碧灵髓']);
});
test('HTTP controls require host, same-origin and session; readers only see cached snapshots',async()=>{
  const h=await setup();const server=await startControlServer(h.control,{port:0});
  try {
    const url=`http://127.0.0.1:${server.server.address().port}`;
    assert.equal((await fetch(url+'/api/state')).status,401);
    const session=await fetch(url+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();
    const headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':token,Origin:url};
    assert.equal((await fetch(url+'/api/commands/start',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(url+'/api/commands/start',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:'{}'})).status,403);
    for(const endpoint of ['review','sync','delete','confirm']){
      const body=JSON.stringify({operationId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',confirmed:true,reviewedAt:1});
      assert.equal((await fetch(url+'/api/crafting/'+endpoint,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
      assert.equal((await fetch(url+'/api/crafting/'+endpoint,{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body})).status,403);
      assert.equal((await fetch(url+'/api/crafting/'+endpoint,{method:'POST',headers,body})).status,202);await h.control.tail;
      assert.equal(h.control.lastCommand.kind,'craft-'+endpoint);assert.equal(h.control.lastCommand.ok,false);assert.match(h.control.lastCommand.error,endpoint==='delete'?/未找到这条炼制记录/u:endpoint==='confirm'?/核对记录已变化/u:/没有可核对结果/u);
    }
    const connections=h.connections;await fetch(url+'/api/state',{headers:{Cookie:cookie}});await fetch(url+'/api/catalog',{headers:{Cookie:cookie}});assert.equal(h.connections,connections);
    const accepted=await fetch(url+'/api/commands/start',{method:'POST',headers,body:'{}'});assert.equal(accepted.status,202);await h.control.tail;
    assert.equal(h.control.record.desired,'running');
    const events=await fetch(url+'/api/events',{headers:{Cookie:cookie}});const reader=events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value),/data:/u);await reader.cancel();
    assert.equal(h.control.record.desired,'running');
    assert.equal((await fetch(url+'/api/commands/shell',{method:'POST',headers,body:'{}'})).status,404);
    for(const endpoint of ['close-game','open-game']){
      assert.equal((await fetch(url+'/api/commands/'+endpoint,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
      assert.equal((await fetch(url+'/api/commands/'+endpoint,{method:'POST',headers,body:'{}'})).status,202);await h.control.tail;
      assert.equal(h.control.lastCommand.ok,true);assert.equal(h.control.record.desired,'stopped');
      assert.equal(h.control.record.gameClosed,endpoint==='close-game');
    }
  } finally {await server.close();}
});

test('changing only healer leaves correct combat running; changing battle target retreats on the next boundary',async()=>{
  const h=await setup();await command(h.control,'start');
  const settings=initialSettings(base);settings.consumables.enabled=false;settings.healingTarget={regionName:'南境',locationName:'南泉'};
  await command(h.control,'settings',{revision:1,settings});await h.control.tick();
  assert.equal(h.actions.includes('retreat'),false);assert.equal(h.control.phase,'running');
  settings.target.regionName='南境';await command(h.control,'settings',{revision:2,settings});
  h.ui.retreatForTarget=async target=>{assert.equal(target.regionName,'南境');h.actions.push('retreat');h.state.mode='rest';await h.ui.observe();};
  await h.control.tick();assert.equal(h.actions.filter(a=>a==='retreat').length,1);
});
test('fresh resource with failed map scan keeps the previous catalog intact',async()=>{
  const h=await setup();await command(h.control,'refresh');const old=h.control.catalog;
  h.ui.inspectCatalog=async()=>{throw new Error('map layout changed');};
  const result=await h.control.command('refresh').promise;assert.equal(result.ok,false);assert.equal(h.control.catalog,old);
  const saved=JSON.parse(await readFile(path.join(h.directory,'catalog.json')));assert.equal(saved.checkedAt,old.checkedAt);
});
test('instant healing and cooldown are displayed as healing even without a continuous-healing label',async()=>{
  const h=await setup();await command(h.control,'start');h.control.consumables.config.enabled=false;
  Object.assign(h.state,{mode:'rest',location:'北泉',health:{current:'10',maximum:'100',percent:10},heal:{enabled:true,running:false}});
  h.ui.heal=async()=>{h.state.health={current:'50',maximum:'100',percent:50};h.state.heal.enabled=false;await h.ui.observe();};
  await h.control.tick();assert.equal(h.control.phase,'healing');await h.control.tick();assert.equal(h.control.phase,'healing');
});
