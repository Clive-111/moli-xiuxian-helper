import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';
import {mapFarming,bestiaryView} from '../src/farming.js';
import {startControlServer} from '../src/control-server.js';
import {materialFixture} from './helpers/material-fixture.js';
let browser;before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});after(async()=>browser?.close());
async function fixture(){
  const c=Object.assign(new EventEmitter(),materialFixture()),commands=[],errors=[];
  const state={phase:'closed',desired:'stopped',gameClosed:true,revision:1,settings:{target:{regionName:'北境',stageName:'同名山谷'},healingTarget:null,consumables:{enabled:false,itemNames:['赤灵髓']}},catalog:c.catalog,logs:[],consumables:{nextAt:12345},library:{revision:1,sync:{intervalMs:60000}},bestiary:{revision:1,updatedAt:1},crafting:{operations:[],previews:[]}};
  c.snapshot=()=>state;c.planMaps=p=>mapFarming(c,p);c.getBestiary=()=>bestiaryView(c.knowledge,c.bestiary,c.catalog);
  c.command=(kind,payload)=>{commands.push({kind,payload});return {id:commands.length,kind};};c.library={revision:1,views:{},details:{}};
  const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.locator('#map-farming-open').waitFor();
  return {c,state,page,commands,errors,close:async()=>{await page.close();await server.close();}};
}

test('map view defaults to configured target and filters by region without changing settings or opening a closed game',async()=>{
  const h=await fixture();try{
    const original=structuredClone(h.state);await h.page.getByRole('button',{name:'地图掉落统计',exact:true}).click();
    await h.page.locator('.map-drop-overview').waitFor();assert.equal(await h.page.getByLabel('掉落统计地图').inputValue(),'north');
    assert.match(await h.page.locator('.map-drop-overview').innerText(),/9.1 件\/轮/u);
    const first=h.page.locator('.map-enemy').first();await first.locator('summary').focus();await h.page.keyboard.press('Enter');
    assert.match(await first.innerText(),/4.5 件/u);assert.match(await first.innerText(),/20%/u);
    await h.page.getByLabel('掉落统计区域').selectOption('南境');assert.equal(await h.page.getByLabel('掉落统计地图').inputValue(),'south');
    await h.page.getByLabel('掉落统计地图').selectOption('locked');assert.match(await h.page.locator('.map-drop-overview').innerText(),/地图锁定.*仅供参考/u);
    await h.page.getByLabel('搜索掉落地图').fill('不存在');assert.equal(await h.page.locator('.map-drop-overview').count(),0);
    await h.page.getByLabel('搜索掉落地图').fill('');assert.equal(await h.page.getByLabel('掉落统计区域').inputValue(),'南境');
    assert.equal(await h.page.locator('#map-farming-sync').isDisabled(),true);
    await h.page.clock.install();await h.page.clock.fastForward(121000);assert.deepEqual(h.commands,[]);assert.deepEqual(h.state,original);
    await h.page.keyboard.press('Escape');assert.equal(await h.page.locator('#map-farming-open').evaluate(e=>e===document.activeElement),true);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('SSE keeps chosen map, search and enemy expansion; missing maps never silently switch; sync is explicit',async()=>{
  const h=await fixture();try{
    await h.page.locator('#map-farming-open').click();await h.page.locator('.map-drop-overview').waitFor();
    await h.page.getByLabel('搜索掉落地图').fill('同名');await h.page.locator('.map-enemy[data-enemy=a] summary').click();
    h.c.catalog.resourceUrl='old';h.state.catalog={...h.c.catalog,updatedAt:2};h.c.emit('change',h.state);
    await h.page.waitForFunction(()=>document.querySelector('#map-farming-content')?.textContent.includes('版本未对齐'));
    assert.equal(await h.page.getByLabel('掉落统计地图').inputValue(),'north');assert.equal(await h.page.getByLabel('搜索掉落地图').inputValue(),'同名');assert.equal(await h.page.locator('.map-enemy[data-enemy=a]').getAttribute('open'),'');
    h.state.gameClosed=false;h.state.phase='stopped';h.c.emit('change',h.state);await h.page.waitForFunction(()=>!document.querySelector('#map-farming-sync').disabled);
    await h.page.locator('#map-farming-sync').click();assert.deepEqual(h.commands.map(c=>c.kind),['bestiary']);
    h.c.knowledge.maps=h.c.knowledge.maps.filter(m=>m.id!=='north');h.state.bestiary.revision++;h.c.emit('change',h.state);
    await h.page.waitForFunction(()=>document.querySelector('#map-farming-content')?.textContent.includes('原选择可能'));
    assert.equal(await h.page.locator('.map-drop-overview').count(),0);assert.equal(await h.page.getByLabel('搜索掉落地图').inputValue(),'同名');assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('desktop/mobile tables fit and failures remove stale statistics; empty catalog has a clear state',async()=>{
  const h=await fixture();try{
    await h.page.locator('#map-farming-open').click();await h.page.locator('.map-drop-overview').waitFor();await h.page.locator('.map-enemy').first().locator('summary').click();
    await h.page.screenshot({path:'work/map-farming-desktop.png'});await h.page.setViewportSize({width:390,height:844});
    await h.page.locator('.map-drop-overview').scrollIntoViewIfNeeded();await h.page.screenshot({path:'work/map-farming-mobile.png'});
    assert.equal(await h.page.locator('#map-farming').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    assert.equal(await h.page.locator('#map-farming-content').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    const close=h.page.getByRole('button',{name:'关闭地图掉落统计',exact:true}),box=await close.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=844);
    h.c.planMaps=()=>{throw Error('测试：统计暂不可用');};await h.page.locator('#map-farming-reload').click();
    await h.page.waitForFunction(()=>document.querySelector('#map-farming-message').textContent==='测试：统计暂不可用');assert.equal(await h.page.locator('.map-drop-overview').count(),0);
    h.c.planMaps=()=>({maps:[],warnings:[],note:'没有地图'});await h.page.locator('#map-farming-reload').click();
    await h.page.waitForFunction(()=>document.querySelector('#map-farming-content').textContent.includes('当前没有地图数据'));assert.deepEqual(h.commands,[]);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
