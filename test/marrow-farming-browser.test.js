import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {marrowFarming,bestiaryView} from '../src/farming.js';
import {startControlServer} from '../src/control-server.js';
import {marrowFixture} from './helpers/marrow-fixture.js';
let browser;before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});after(async()=>browser?.close());
async function fixture(){
 const c=Object.assign(new EventEmitter(),marrowFixture()),commands=[],errors=[];
 const state={phase:'running',desired:'running',revision:1,settings:{target:{regionName:'北境',stageName:'同名山谷'},healingTarget:null,consumables:{enabled:true,itemNames:['red','green'].map(id=>c.catalog.items.find(i=>i.id===id).name)}},catalog:c.catalog,logs:[],consumables:{nextAt:12345},library:{revision:1,sync:{intervalMs:60000}},bestiary:{revision:1,updatedAt:1},crafting:{operations:[],previews:[]}};
 c.snapshot=()=>state;c.planMarrow=p=>marrowFarming(c,p);c.getBestiary=()=>bestiaryView(c.knowledge,c.bestiary,c.catalog);c.command=(kind,payload)=>{commands.push({kind,payload});return {id:commands.length,kind};};c.library={revision:1,views:{},details:{}};
 const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.server.address().port}/#overview`);await page.locator('#items input').first().waitFor();
 return {c,state,page,commands,errors,close:async()=>{await page.close();await server.close();}};
}

test('supply entry ranks checked marrow, switches a single kind, preserves allowlist/timer and reads no game page',async()=>{
 const h=await fixture();try{
  const before=structuredClone(h.state);await h.page.getByRole('button',{name:'查看刷取期望',exact:true}).click();await h.page.locator('.marrow-best h3').waitFor();
  assert.match(await h.page.locator('.marrow-best').innerText(),/北境 \/ 同名山谷/u);assert.match(await h.page.locator('.marrow-best-yield').innerText(),/9.1/u);
  assert.equal(await h.page.locator('#marrow-farming-kind').inputValue(),'selected');
  await h.page.getByLabel('查看灵髓种类').selectOption('item:green');await h.page.waitForFunction(()=>document.querySelector('.marrow-best h3')?.textContent.includes('南境'));
  assert.match(await h.page.locator('.marrow-best-yield').innerText(),/^3 件/u);assert.equal(await h.page.locator('.marrow-map:not(.reference)').count(),2);
  assert.equal(await h.page.locator('.marrow-reference .marrow-map').count(),2);assert.deepEqual(h.state.settings,before.settings);assert.deepEqual(h.state.consumables,before.consumables);assert.deepEqual(h.commands,[]);
  await h.page.keyboard.press('Escape');assert.equal(await h.page.locator('#marrow-farming').evaluate(d=>d.open),false);assert.equal(await h.page.locator('#marrow-farming-open').evaluate(e=>e===document.activeElement),true);assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});

test('SSE refresh preserves selected kind; stale evidence removes best, manual data refresh uses existing queue',async()=>{
 const h=await fixture();try{
  await h.page.locator('#marrow-farming-open').click();await h.page.locator('.marrow-best h3').waitFor();await h.page.getByLabel('查看灵髓种类').selectOption('item:green');
  h.c.bestiary.knowledgeRevision='old';h.state.bestiary.revision++;h.c.emit('change',h.state);
  await h.page.waitForFunction(()=>document.querySelector('.marrow-best h3')?.textContent==='暂无可确定推荐');assert.equal(await h.page.getByLabel('查看灵髓种类').inputValue(),'item:green');
  assert.equal(await h.page.locator('.marrow-map:not(.reference)').count(),0);
  await h.page.locator('#marrow-farming-bestiary').click();await h.page.locator('#marrow-farming-map').click();assert.deepEqual(h.commands.map(c=>c.kind),['bestiary','refresh']);
  assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});

test('mobile layout, no checked items defaults to all, empty/new data and request failure are explicit',async()=>{
 const h=await fixture();try{
  for(const box of await h.page.locator('#items input').all())await box.uncheck();
  await h.page.locator('#marrow-farming-open').click();await h.page.locator('.marrow-best h3').waitFor();assert.equal(await h.page.getByLabel('查看灵髓种类').inputValue(),'all');
  await mkdir('work',{recursive:true});await h.page.screenshot({path:'work/marrow-farming-desktop.png'});
  await h.page.setViewportSize({width:390,height:844});await h.page.screenshot({path:'work/marrow-farming-mobile.png'});assert.ok(await h.page.locator('#marrow-farming').evaluate(e=>e.scrollWidth<=e.clientWidth));
  await h.page.getByLabel('查看灵髓种类').selectOption('selected');await h.page.waitForFunction(()=>document.querySelector('#marrow-farming-message')?.textContent.includes('尚未勾选'));
  h.c.bestiary.entries=[];await h.page.getByLabel('查看灵髓种类').selectOption('all');await h.page.waitForFunction(()=>document.querySelector('#marrow-farming-results')?.textContent.includes('这不表示游戏中没有掉落'));
  h.c.planMarrow=()=>{throw new Error('测试：数据暂不可用');};await h.page.locator('#marrow-farming-reload').click();await h.page.waitForFunction(()=>document.querySelector('#marrow-farming-message')?.textContent==='测试：数据暂不可用');assert.equal(await h.page.locator('.marrow-best').count(),0);
  assert.deepEqual(h.commands,[]);assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});
