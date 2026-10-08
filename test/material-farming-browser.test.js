import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';
import {materialFarming,bestiaryView} from '../src/farming.js';
import {startControlServer} from '../src/control-server.js';
import {materialFixture} from './helpers/material-fixture.js';
let browser;before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});after(async()=>browser?.close());
const image=letter=>'/api/library/images/'+letter.repeat(64);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvS8AAAAASUVORK5CYII=','base64');
async function fixture(){
  const c=Object.assign(new EventEmitter(),materialFixture()),commands=[],errors=[];
  const state={phase:'closed',desired:'stopped',gameClosed:true,revision:1,settings:{target:{regionName:'北境',stageName:'同名山谷'},healingTarget:null,consumables:{enabled:false,itemNames:['赤灵髓']}},catalog:c.catalog,logs:[],consumables:{nextAt:12345},library:{revision:1,sync:{intervalMs:60000}},bestiary:{revision:1,updatedAt:1},crafting:{operations:[],previews:[]}};
  c.snapshot=()=>state;c.planMaterials=p=>materialFarming(c,p);c.getBestiary=()=>bestiaryView(c.knowledge,c.bestiary,c.catalog);
  c.command=(kind,payload)=>{commands.push({kind,payload});return {id:commands.length,kind};};
  c.library={revision:1,views:{inventory:{items:[{gameItemId:'red',image:image('a')}]},crafting:{items:[{recipeId:'crafted',image:image('b')},{gameItemId:'green',image:image('c')}]}},details:{}};
  c.images={get:async id=>{if(id==='c'.repeat(64))throw Error('image unavailable');return png;},close:async()=>{}};
  const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.locator('#material-farming-open').waitFor();
  return {c,state,page,commands,errors,close:async()=>{await page.close();await server.close();}};
}
test('all materials have individual best maps; closed game allows cached browsing, searching and keyboard details only',async()=>{
  const h=await fixture();try{
    const original=structuredClone(h.state);await h.page.getByRole('button',{name:'炼材掉落排行',exact:true}).click();
    await h.page.locator('.material-rank-row').first().waitFor();assert.equal(await h.page.locator('.material-rank-row').count(),5);
    const red=h.page.locator('.material-rank-row[data-id=red]');assert.match(await red.locator('summary').innerText(),/北境 \/ 同名山谷/u);assert.match(await red.locator('.material-amount').innerText(),/6.5/u);
    assert.match(await h.page.locator('.material-rank-row[data-id=green] summary').innerText(),/南境 \/ 同名山谷/u);
    await red.locator('summary').focus();await h.page.keyboard.press('Enter');await red.locator('.material-map').first().waitFor();assert.match(await red.innerText(),/基础掉落：20%/u);
    assert.equal(await h.page.locator('#material-farming-sync').isDisabled(),true);
    await h.page.getByLabel('搜索炼材或材料').fill('赤');assert.equal(await h.page.locator('.material-rank-row').count(),1);
    await h.page.getByLabel('搜索炼材或材料').fill('');assert.deepEqual(await h.page.locator('#material-farming-kind option').evaluateAll(es=>es.map(e=>e.value)),['','part','material'],await h.page.locator('#material-farming-kind').evaluate(e=>e.outerHTML));await h.page.getByLabel('炼材排行分类').selectOption('part');assert.equal(await h.page.locator('.material-rank-row').count(),2);
    await h.page.getByLabel('仅看可推荐').check();assert.equal(await h.page.locator('.material-rank-row').count(),1);
    await h.page.clock.install();await h.page.clock.fastForward(121000);assert.deepEqual(h.commands,[]);assert.deepEqual(h.state,original);
    await h.page.keyboard.press('Escape');assert.equal(await h.page.locator('#material-farming').evaluate(d=>d.open),false);assert.equal(await h.page.locator('#material-farming-open').evaluate(e=>e===document.activeElement),true);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('cached icons load, failures fall back, and inventory refresh adds images without resetting the list',async()=>{
  const h=await fixture();try{
    await h.page.locator('#material-farming-open').click();await h.page.locator('.material-rank-row').first().waitFor();
    const red=h.page.locator('.material-rank-row[data-id=red]'),crafted=h.page.locator('.material-rank-row[data-id=crafted]'),green=h.page.locator('.material-rank-row[data-id=green]');
    await h.page.waitForFunction(()=>document.querySelector('.material-rank-row[data-id=red] img')?.naturalWidth>0);
    await crafted.scrollIntoViewIfNeeded();await h.page.waitForFunction(()=>document.querySelector('.material-rank-row[data-id=crafted] img')?.naturalWidth>0);
    assert.equal(await red.locator('img').getAttribute('src'),image('a'));assert.equal(await crafted.locator('img').getAttribute('src'),image('b'));
    await green.scrollIntoViewIfNeeded();await h.page.waitForFunction(()=>document.querySelector('.material-rank-row[data-id=green] .material-icon')?.title==='图片暂不可用');
    assert.equal(await green.locator('img').count(),0);
    await h.page.getByLabel('搜索炼材或材料').fill('未知');
    const hidden=h.page.locator('.material-rank-row[data-id=hidden]');await hidden.locator('summary').click();assert.equal(await hidden.locator('img').count(),0);
    h.c.library.views.inventory.items.push({gameItemId:'hidden',image:image('d')});h.state.library.revision++;h.c.emit('change',h.state);
    await h.page.waitForFunction(()=>document.querySelector('.material-rank-row[data-id=hidden] img')?.naturalWidth>0);
    assert.equal(await hidden.getAttribute('open'),'');assert.equal(await h.page.getByLabel('搜索炼材或材料').inputValue(),'未知');
    assert.deepEqual(h.commands,[]);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('SSE updates preserve filter and expansion, stale data loses winners and manual sync uses existing queue',async()=>{
  const h=await fixture();try{
    await h.page.locator('#material-farming-open').click();await h.page.locator('.material-rank-row').first().waitFor();await h.page.getByLabel('搜索炼材或材料').fill('赤');
    await h.page.locator('.material-rank-row summary').click();
    h.c.catalog.resourceUrl='old';h.state.catalog={...h.c.catalog,updatedAt:2};h.c.emit('change',h.state);
    await h.page.waitForFunction(()=>document.querySelector('.material-location')?.textContent.includes('资料版本待同步'));
    assert.equal(await h.page.getByLabel('搜索炼材或材料').inputValue(),'赤');assert.equal(await h.page.locator('.material-rank-row').getAttribute('open'),'');
    h.state.gameClosed=false;h.state.phase='stopped';h.c.emit('change',h.state);await h.page.waitForFunction(()=>!document.querySelector('#material-farming-sync').disabled);
    await h.page.locator('#material-farming-sync').click();assert.deepEqual(h.commands.map(c=>c.kind),['bestiary']);
    h.c.catalog.resourceUrl='r1';h.state.catalog={...h.c.catalog,checkedAt:3};h.c.emit('change',h.state);
    await h.page.waitForFunction(()=>document.querySelector('.material-amount strong')?.textContent==='6.5');
    assert.equal(await h.page.getByLabel('搜索炼材或材料').inputValue(),'赤');assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('material ranking fits desktop/mobile and clears old results on API failure or empty data',async()=>{
  const h=await fixture();try{
    await h.page.locator('#material-farming-open').click();await h.page.locator('.material-rank-row').first().waitFor();
    await h.page.locator('.material-rank-row[data-id=red] summary').click();await h.page.screenshot({path:'work/material-farming-desktop.png'});
    await h.page.setViewportSize({width:390,height:844});await h.page.screenshot({path:'work/material-farming-mobile.png'});
    assert.equal(await h.page.locator('#material-farming').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    const close=h.page.getByRole('button',{name:'关闭炼材掉落排行',exact:true}),bounds=await close.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390);
    await close.click();await h.page.locator('#material-farming-open').click();await h.page.locator('.material-rank-row').first().waitFor();
    h.c.planMaterials=()=>{throw Error('测试：资料暂不可用');};await h.page.locator('#material-farming-reload').click();
    await h.page.waitForFunction(()=>document.querySelector('#material-farming-message').textContent==='测试：资料暂不可用');assert.equal(await h.page.locator('.material-rank-row').count(),0);
    h.c.planMaterials=()=>({items:[],maps:[],warnings:[],note:'没有数据'});await h.page.locator('#material-farming-reload').click();
    await h.page.waitForFunction(()=>document.querySelector('#material-farming-results').textContent.includes('没有识别到'));assert.deepEqual(h.commands,[]);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
