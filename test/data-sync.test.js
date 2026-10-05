import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SetupControl} from '../src/setup-control.js';
import {startControlServer} from '../src/control-server.js';
import {chromium} from 'playwright';

async function syncHarness() {
 const directory=await mkdtemp(path.join(os.tmpdir(),'moli-data-sync-'));
 const actions=[],signal=new AbortController().signal;
 const state={character:'测试修士',region:'北境',location:'石阶',mode:'rest',view:{dialogs:[],activeTab:'游历'},health:{current:'100',maximum:'100',percent:100},heal:{running:false}};
 const catalog={version:1,resourceUrl:'https://game.test/assets/game.js',updatedAt:Date.now(),regions:[{id:'north',name:'北境'}],nodes:[{id:'battle',name:'石阶',regionName:'北境',regionId:'north',type:'battle'},{id:'rest',name:'清泉',regionName:'北境',regionId:'north',type:'healing'}],items:[],shops:[]};
 const knowledge={revision:'v1',resourceUrl:catalog.resourceUrl,enemies:[],items:[],recipes:[],maps:[]};
 const ui={config:{},signal,async detectCharacter(){return state.character;},async openForLogin(){},async observeExisting(){return structuredClone(state);},async observe(){const value=structuredClone(state);this.onSnapshot?.(value);return value;},async inspectCatalog(value){this.beforeAction?.('读取地图');actions.push('catalog');return {...value,checkedAt:Date.now(),nodes:value.nodes.map(node=>({...node,availability:'visible'}))};}};
 const c=new SetupControl({base:{enabled:false,channelUrl:'https://discord.test/channels/1/2',appName:'App',target:null,consumables:{enabled:false,itemNames:[]}},directory,runtime:{profilePath:directory},signal,log:()=>{},makeUI:async()=>ui,closeGamePage:async()=>{actions.push('close');},catalogLoader:async()=>structuredClone(catalog),knowledgeLoader:async()=>({knowledge,catalog}),libraryReader:()=>({async read(view){ui.beforeAction?.('查看'+view);actions.push(view);return {items:[{name:view==='inventory'?'测试材料':'测试配方',key:view,category:'材料',quantity:1}],equipment:[],updatedAt:Date.now()};}}),bestiaryReader:()=>({async read(){ui.beforeAction?.('读取图鉴');actions.push('bestiary');return {entries:[],resourceUrl:catalog.resourceUrl,updatedAt:Date.now()};}})});
 await c.initialize();
 async function bind(){await c.command('setup-detect').promise;const result=await c.command('setup-bind',{token:c.getSetup().candidate.token}).promise;assert.ok(result.ok,result.error);await c.tail;}
 return {c,ui,state,actions,bind};
}

test('confirmation loads all four data groups without selecting a target or starting consumption; reopening refreshes again',async()=>{
 const h=await syncHarness();try{
  await h.bind();const {c}=h;
  assert.deepEqual(h.actions,['catalog','inventory','crafting','bestiary']);
  assert.equal(c.dataSync.phase,'done');assert.deepEqual(c.dataSync.completed,h.actions);
  assert.equal(c.catalog.nodes.filter(n=>n.availability==='visible').length,2);
  assert.equal(c.library.views.inventory.items.length,1);assert.equal(c.library.views.crafting.items.length,1);assert.ok(c.bestiary.updatedAt);
  assert.equal(c.record.desired,'stopped');assert.equal(c.record.settings.target,null);assert.equal(c.record.settings.healingTarget,null);assert.equal(c.record.settings.consumables.enabled,false);
  await c.command('close-game').promise;c.browserClosed=true;h.actions.length=0;
  await c.command('open-game').promise;await c.tail;
  assert.deepEqual(h.actions,['catalog','inventory','crafting','bestiary']);assert.equal(c.record.desired,'stopped');assert.equal(c.getSetup().browserClosed,false);
 }finally{h.c.close();}
});

test('one failed list keeps its previous cache and does not discard successful groups',async()=>{
 const h=await syncHarness();try{
  await h.bind();const previous=h.c.library.views.inventory,reader=h.c.libraryReader;
  h.c.libraryReader=ui=>({async read(view){if(view==='inventory')throw Error('inventory unavailable');return reader(ui).read(view);}});
  const result=await h.c.command('sync').promise;
  assert.equal(result.ok,true);assert.equal(result.partial,true);assert.equal(h.c.dataSync.phase,'partial');
  assert.equal(h.c.library.views.inventory,previous);assert.equal(h.c.libraryErrors.inventory,'inventory unavailable');
  assert.deepEqual(result.completed,['catalog','crafting','bestiary']);
 }finally{h.c.close();}
});

test('open rechecks transient launcher transitions with a bounded retry, then queues full data refresh',async()=>{
 const h=await syncHarness();try{
  await h.bind();await h.c.command('close-game').promise;h.actions.length=0;
  const observe=h.ui.observe;let attempts=0;
  h.ui.observe=async()=>{if(++attempts<=2)throw Object.assign(Error('launcher changed'),{launchStateChanged:true});return observe.call(h.ui);};
  assert.equal((await h.c.command('open-game').promise).ok,true);await h.c.tail;
  assert.equal(h.c.dataSync.phase,'done');assert.deepEqual(h.actions,['catalog','inventory','crafting','bestiary']);
  await h.c.command('close-game').promise;attempts=0;h.actions.length=0;
  h.ui.observe=async()=>{attempts++;throw Object.assign(Error('launcher keeps changing'),{launchStateChanged:true});};
  assert.equal((await h.c.command('open-game').promise).ok,false);await h.c.tail;
  assert.equal(attempts,3);assert.deepEqual(h.actions,[]);assert.equal(h.c.record.desired,'stopped');
 }finally{h.c.close();}
});

test('identity changes, dialogs and pending item operations pause before navigating any list',async()=>{
 const h=await syncHarness();try{
  await h.bind();
  for(const variant of ['identity','dialog','transaction']){
   h.actions.length=0;
   h.state.character=variant==='identity'?'另一个人物':'测试修士';h.state.view.dialogs=variant==='dialog'?['未知确认']:[];
   if(variant==='transaction')h.c.inventoryActions.data={version:1,activeId:'pending',previews:{},operations:{pending:{id:'pending'}}};
   const result=await h.c.command('sync').promise;
   assert.equal(result.ok,false);assert.equal(h.c.dataSync.phase,'paused');assert.deepEqual(h.actions,[]);
  }
 }finally{h.c.close();}
});

test('panel fills battle/healing selectors and lists after confirmation, reports progress and offers a retry without starting',async()=>{
 const h=await syncHarness(),server=await startControlServer(h.c,{port:0});
 const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true}),page=await browser.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let release;const gate=new Promise(resolve=>release=resolve),loader=h.c.catalogLoader;h.c.catalogLoader=async()=>{await gate;return loader();};
 try{
  await page.goto('http://127.0.0.1:'+server.server.address().port);
  await page.locator('#setup-detect').click();await page.locator('#setup-bind:enabled').waitFor();await page.locator('#setup-bind').click();
  await page.waitForFunction(()=>document.querySelector('#data-sync').textContent.includes('正在读取战斗与调息地点'));
  release();await h.c.tail;
  await page.waitForFunction(()=>document.querySelector('#data-sync').textContent.includes('已全部读取'));
  assert.equal(await page.locator('#battle-region option').count(),2);assert.equal(await page.locator('#healing-region option').count(),2);
  await page.locator('#battle-region').selectOption('北境');assert.match(await page.locator('#battle-stage').textContent(),/石阶/u);
  await page.locator('#healing-region').selectOption('北境');assert.match(await page.locator('#healing-stage').textContent(),/清泉/u);
  await page.waitForFunction(()=>document.querySelector('#inventory-count').textContent==='1'&&document.querySelector('#crafting-count').textContent==='1');
  assert.equal(h.c.record.settings.target,null);assert.equal(h.c.record.desired,'stopped');
  h.c.catalogLoader=async()=>{throw Error('地图下载暂不可用');};
  await page.locator('[data-command="sync"]').click();
  await page.waitForFunction(()=>document.querySelector('#data-sync').textContent.includes('部分完成'));
  assert.match(await page.locator('#data-sync').textContent(),/地图下载暂不可用/u);
  assert.equal(await page.locator('#battle-region').inputValue(),'北境');
  assert.equal(h.c.record.desired,'stopped');assert.deepEqual(errors,[]);
 }finally{release();h.c.close();await browser.close();await server.close();}
});

test('close interrupts a running batch after its current read, duplicate sync merges, and closed games cannot reconnect',async()=>{
 const h=await syncHarness();let release;try{
  await h.bind();h.actions.length=0;
  let entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),inspect=h.ui.inspectCatalog;
  h.ui.inspectCatalog=async value=>{const result=await inspect.call(h.ui,value);entered();await gate;return result;};
  const job=h.c.command('sync');assert.equal(h.c.command('sync'),job);await ready;
  const close=h.c.command('close-game');release();
  assert.equal((await job.promise).ok,false);assert.equal((await close.promise).ok,true);
  assert.deepEqual(h.actions,['catalog','close']);assert.equal(h.c.dataSync.phase,'paused');
  assert.equal((await h.c.command('sync').promise).ok,false);assert.deepEqual(h.actions,['catalog','close']);
 }finally{release?.();h.c.close();}
});

test('full sync API requires a bound character, same origin and CSRF token',async()=>{
 const h=await syncHarness(),server=await startControlServer(h.c,{port:0}),origin='http://127.0.0.1:'+server.server.address().port;
 try{
  const session=await fetch(origin+'/api/session'),{token}=await session.json(),cookie=session.headers.get('set-cookie').split(';')[0];
  const headers={cookie,origin,'Content-Type':'application/json','X-CSRF-Token':token};
  const post=changes=>fetch(origin+'/api/commands/sync',{method:'POST',headers:{...headers,...changes},body:'{}'});
  assert.equal((await post({})).status,409);await h.bind();
  assert.equal((await post({origin:'http://foreign.test'})).status,403);
  assert.equal((await post({'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await post({})).status,202);await h.c.tail;assert.equal(h.c.dataSync.phase,'done');
 }finally{h.c.close();await server.close();}
});
