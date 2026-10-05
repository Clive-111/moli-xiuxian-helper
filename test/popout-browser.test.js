import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {BattleUI} from '../src/battle-ui.js';
import {SetupControl} from '../src/setup-control.js';
import {startControlServer} from '../src/control-server.js';

let browser,fixture,origin;
const game='<aside class="character-panel"><div class="discord-profile"><h3>测试修士</h3></div><div><span>气血</span><span id="hp">100 / 100</span></div></aside><main data-region="北境" data-location="石阶"><h1>石阶</h1><p>正在探索</p><button onclick="actions.push(\'retreat\')">撤退</button><button onclick="actions.push(\'map\')">山河图</button></main><script>window.actions=[];</script>';
const shell='<button onclick="launches++">打开应用</button><script>window.launches=0;</script><iframe src="/game" style="width:900px;height:700px"></iframe>';
before(async()=>{
 fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/game'?game:shell);});
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+fixture.address().port;
 browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>fixture.close(resolve));});
async function harness(){
 const context=await browser.newContext(),page=await context.newPage(),channelUrl=origin+'/channels/1/2';
 await page.goto(channelUrl);await page.frameLocator('iframe').locator('#hp').waitFor();
 const config={channelUrl,appName:'App',characterName:'测试修士',consumables:{enabled:false,itemNames:[]}};
 const ui=new BattleUI(page,config,{responseTimeoutSeconds:1,actionDelaySeconds:.001},()=>{},new AbortController().signal);
 return {context,page,config,ui};
}
async function popOut(h){
 const ready=h.context.waitForEvent('page');await h.page.evaluate(()=>window.open('/popout'));
 const popup=await ready;await popup.frameLocator('iframe').locator('#hp').waitFor();
 await h.page.locator('iframe').evaluate(el=>el.remove());return popup;
}
async function until(fn){const end=Date.now()+4000;while(!await fn()){if(Date.now()>end)throw Error('Timed out waiting for read-only update');await new Promise(resolve=>setTimeout(resolve,30));}}

test('game moved into a popout and back stays attached without reopening the launcher or clicking game controls',async()=>{
 const h=await harness();try{
  assert.equal((await h.ui.observe()).location,'石阶');
  const popup=await popOut(h);await popup.frameLocator('iframe').locator('#hp').evaluate(el=>el.textContent='77 / 100');
  assert.equal((await h.ui.observe()).health.current,'77');assert.equal(h.ui.page,popup);
  h.page.emit('crash');assert.notEqual(h.ui.crashed,true);
  popup.emit('crash');assert.equal(h.ui.crashed,true);h.ui.crashed=false;
  assert.equal(await h.page.evaluate(()=>launches),0);
  assert.deepEqual(await h.ui.frame.evaluate(()=>actions),[]);
  await popup.locator('iframe').evaluate(el=>el.remove());
  await h.page.reload();await h.page.frameLocator('iframe').locator('#hp').waitFor();
  assert.equal((await h.ui.observeExisting()).health.current,'100');assert.equal(h.ui.page,h.page);
  assert.equal(await h.page.evaluate(()=>launches),0);
 }finally{await h.context.close();}
});

test('closing the source channel leaves its popout readable; unrelated tabs are ignored and duplicate games fail closed',async()=>{
 const h=await harness();try{
  const unrelated=await h.context.newPage();await unrelated.goto(origin+'/unrelated');await unrelated.frameLocator('iframe').locator('#hp').waitFor();
  assert.equal((await h.ui.observeExisting()).character,'测试修士');
  const popup=await popOut(h);await h.page.close();
  assert.equal((await h.ui.observe()).location,'石阶');assert.equal(h.ui.page,popup);
  const duplicate=await h.context.newPage();await duplicate.goto(origin+'/popout');await duplicate.frameLocator('iframe').locator('#hp').waitFor();
  await assert.rejects(h.ui.observeExisting(),/多个游戏界面/u);await duplicate.close();
  await popup.frameLocator('iframe').locator('h3').evaluate(el=>el.textContent='另一个人物');
  await assert.rejects(h.ui.observeExisting(),/角色不符/u);
 }finally{await h.context.close();}
});

test('binding publishes location and health immediately, stopped polling reads only, and closed games never reconnect',async()=>{
 const h=await harness(),directory=await mkdtemp(path.join(os.tmpdir(),'moli-popout-'));let connections=0,reads=0;
 h.ui.config={...h.config,characterName:''};const observe=h.ui.observeExisting.bind(h.ui);h.ui.observeExisting=async()=>{reads++;return observe();};
 const c=new SetupControl({base:{...h.config,characterName:''},directory,runtime:{profilePath:path.join(directory,'browser')},signal:new AbortController().signal,log:()=>{},makeUI:async()=>{connections++;return h.ui;}});
 c.syncAll=async()=>({}); // Keep this fixture focused on status-only polling.
 await c.initialize();const server=await startControlServer(c,{port:0});
 try{
  await popOut(h);
  assert.equal((await c.command('setup-detect').promise).ok,true);
  const bound=await c.command('setup-bind',{token:c.getSetup().candidate.token}).promise;assert.ok(bound.ok,bound.error);
  assert.equal(c.snapshot().state.location,'石阶');assert.equal(c.snapshot().state.health.current,'100');assert.ok(c.snapshot().updatedAt);
  assert.equal(c.record.desired,'stopped');assert.equal(c.record.settings.target,null);assert.equal(c.record.settings.consumables.enabled,false);
  await h.ui.frame.locator('#hp').evaluate(el=>el.textContent='66 / 100');c.nextStatusRead=0;
  await until(()=>c.state.health.current==='66');
  assert.deepEqual(await h.ui.frame.evaluate(()=>actions),[]);assert.equal(await h.page.evaluate(()=>launches),0);
  const previous=c.state;await h.ui.frame.locator('h3').evaluate(el=>el.textContent='不同人物');c.nextStatusRead=0;
  await until(()=>c.statusError?.includes('角色不符'));assert.equal(c.state,previous);assert.equal(c.record.desired,'stopped');
  await h.ui.frame.locator('h3').evaluate(el=>el.textContent='测试修士');c.nextStatusRead=0;await until(()=>!c.statusError);
  assert.equal((await c.command('status').promise).ok,true);
  await c.command('close-game').promise;const before={reads,connections};c.nextStatusRead=0;
  await new Promise(resolve=>setTimeout(resolve,550));await c.tail;
  assert.deepEqual({reads,connections},before);assert.equal((await c.command('status').promise).ok,false);
  assert.equal(connections,before.connections);assert.equal(c.record.desired,'stopped');assert.equal(c.record.gameClosed,true);
  assert.equal((await fetch('http://127.0.0.1:'+server.server.address().port+'/health')).status,200);
 }finally{c.close();await server.close();await h.context.close();}
});
