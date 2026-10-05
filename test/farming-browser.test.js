import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {EventEmitter} from 'node:events';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {BattleUI} from '../src/battle-ui.js';
import {BestiaryUI} from '../src/bestiary-ui.js';
import {farmingPlan,bestiaryView} from '../src/farming.js';
import {startControlServer} from '../src/control-server.js';
let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});
const fixture=`<!doctype html><meta charset="utf-8"><script src="/assets/app.js"></script><aside class="character-panel"><div class="discord-profile"><h3>测试修士</h3></div><div><span>气血</span><span>100 / 100</span></div></aside><nav class="central-nav"><button>游历</button><button>履历</button></nav><main data-region="北境" data-location="山"></main><script>
window.actions=[];const main=document.querySelector('main');function show(tab){document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.textContent===tab));if(tab==='游历')main.innerHTML='<h1>山</h1><p>正在探索</p><button>撤退</button>';else{main.innerHTML='<div class="journal-view"><h1>修行履历</h1><button>敌人图鉴</button><button>了却此世</button></div>';main.querySelector('button').onclick=()=>{actions.push('atlas');main.innerHTML='<div class="bestiary-view"><div class="page-heading"><span class="eyebrow" hidden>历世见闻 · 1种</span><h1>敌人图鉴</h1></div><input type="search" aria-label="搜索已遭遇敌人或掉落物"><div class="bestiary-list"><button class="bestiary-entry"><strong>山鼠</strong><small>炼气 · 击败 123 次</small><small class="bestiary-entry-loot">掉落：矿</small></button></div></div>';};}}document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{actions.push(b.textContent);show(b.textContent)});show('游历');</script>`;
test('bestiary reader inspects history and returns to combat without touching reincarnation or retreat',async()=>{
  const page=await browser.newPage();await page.route('http://fixture.local/**',r=>r.fulfill({contentType:r.request().url().endsWith('.js')?'text/javascript':'text/html',body:r.request().url().endsWith('.js')?'':fixture}));
  try{await page.goto('http://fixture.local');const ui=new BattleUI(page,{characterName:'测试修士',target:{regionName:'北境',stageName:'山'}},{actionDelaySeconds:.3,responseTimeoutSeconds:1},()=>{},new AbortController().signal);ui.ensureApp=async()=>page.mainFrame();const reader=new BestiaryUI(ui,{wait:async()=>{}});const result=await reader.read();assert.equal(result.entries[0].name,'山鼠');assert.equal(result.entries[0].kills,'123');assert.equal(result.resourceUrl,'http://fixture.local/assets/app.js');assert.equal((await ui.observe()).mode,'combat');assert.deepEqual(await page.evaluate(()=>actions),['履历','atlas','游历']);
    await page.locator('.discord-profile h3').evaluate(e=>e.textContent='他人');await assert.rejects(reader.read(),/角色|恢复|人工/u);
  }finally{await page.close();}
});
test('recipe planner and bestiary render, switch routes, retain draft and fit a mobile viewport',async()=>{
  const c=new EventEmitter(),commands=[];c.knowledge={revision:'k',resourceUrl:'r',items:[{id:'sword',name:'苏灵鸣金重剑',kind:'equipment'},{id:'part',name:'鸣金重料',kind:'part'},{id:'ore',name:'鸣金锭',kind:'material'},{id:'wood',name:'苏灵木',kind:'material'}],recipes:[{id:'sword',name:'苏灵鸣金重剑',type:'兵刃合炼',output:'sword',outputCount:1,materials:{part:1,wood:2}},{id:'part',name:'鸣金重料',type:'精炼',output:'part',outputCount:1,materials:{ore:6}}],enemies:[{id:'rat',name:'山鼠',realm:1,realmLabel:'炼气',stats:{maxHp:'10',attack:'2',defense:'1',agility:'1'},abilities:{},loot:[{itemId:'ore',chance:.25},{itemId:'wood',chance:1.2}]}],maps:[{id:'hill',name:'青山',pool:['rat'],groups:10,groupSize:2,enemyMultiplier:1,encounterPools:{},challenge:false}]};
  c.library={revision:1,views:{inventory:{updatedAt:Date.now(),items:[],equipment:[]},crafting:{updatedAt:Date.now(),items:c.knowledge.recipes.map((r,i)=>({key:String(i+1).repeat(64),name:r.name,recipeType:r.type,category:'器物',chance:'必成',output:'每次 1件'})),equipment:[]}},details:{}};
  c.bestiary={revision:1,knowledgeRevision:'k',resourceUrl:'r',updatedAt:1,entries:[{id:'rat',name:'山鼠',kills:'123'}]};c.catalog={resourceUrl:'r',regions:[],nodes:[{id:'hill',name:'青山',regionName:'北境',availability:'visible',type:'battle'}],items:[]};
  const state={phase:'running',desired:'running',revision:1,settings:{target:{regionName:'北境',stageName:'青山'},healingTarget:null,consumables:{enabled:false,itemNames:[]}},catalog:c.catalog,logs:[],consumables:{},library:{revision:1,sync:{intervalMs:60000}},bestiary:{revision:1,updatedAt:1},crafting:{operations:[],previews:[]}};
  c.snapshot=()=>state;c.getBestiary=()=>bestiaryView(c.knowledge,c.bestiary,c.catalog);c.planFarming=p=>farmingPlan(c,p);c.command=(kind,payload)=>{commands.push(kind);return {id:commands.length,kind};};c.images={close:async()=>{}};
  const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.getByRole('tab',{name:/炼制/u}).click();await page.getByRole('button',{name:'查看苏灵鸣金重剑详情'}).click();await page.locator('.farming-map').waitFor();assert.match(await page.locator('#farming-content').innerText(),/青山/u);assert.match(await page.locator('#farming-content').innerText(),/25%/u);await page.locator('#farming-quantity').fill('2');await page.locator('#farming-quantity').dispatchEvent('change');await page.waitForFunction(()=>document.querySelector('.material-node summary').textContent.includes('需要 2'));
    state.library.revision=2;c.library.revision=2;c.emit('change',state);await page.waitForTimeout(100);assert.equal(await page.locator('#farming-quantity').inputValue(),'2');
    c.catalog={...c.catalog,resourceUrl:'old-map',updatedAt:2};state.catalog=c.catalog;c.emit('change',state);
    await page.waitForFunction(()=>document.querySelector('#farming-content').textContent.includes('资源版本未对齐'));
    await page.getByRole('button',{name:'同步资料并刷新推荐',exact:true}).click();assert.equal(commands.at(-1),'bestiary');
    // A catalog-only SSE update must invalidate the open recipe plan, without
    // closing it or changing the user's quantity/stock/route draft.
    c.catalog={...c.catalog,resourceUrl:'r',updatedAt:3,checkedAt:3};state.catalog=c.catalog;c.emit('change',state);
    await page.waitForFunction(()=>!document.querySelector('#farming-content').textContent.includes('资源版本未对齐'));
    assert.equal(await page.locator('#farming-quantity').inputValue(),'2');
    const directory=process.env.CONTAINER_PROFILE_PATH?path.join(os.tmpdir(),'bestiary-tests'):path.resolve('work');await mkdir(directory,{recursive:true});await page.locator('.farming-map').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'bestiary-recipe-desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.locator('.farming-map').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'bestiary-recipe-mobile.png')});assert.equal(await page.locator('#library-detail').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await page.getByRole('button',{name:'关闭物品详情'}).click();await page.locator('#bestiary-fold > summary').click();await page.locator('.enemy-card').waitFor();await page.locator('.enemy-card summary').click();assert.match(await page.locator('.enemy-card').innerText(),/必得 1/u);assert.deepEqual(errors,[]);
  }finally{await page.close();await server.close();}
});

test('stocked ingots expand, single and whole farming stay distinct, and reverse order survives refresh',async()=>{
  const c=new EventEmitter();
  c.knowledge={revision:'k',resourceUrl:'r',items:[['sword','养灵鸣金剑'],['part','鸣金精料'],['ingot','鸣金锭'],['essence','养灵淬液'],['wood','养灵木'],['ore','坚甲碎片'],['core','聚灵砂核']].map(([id,name])=>({id,name,kind:'material'})),recipes:[
    {id:'sword',name:'养灵鸣金剑',type:'兵刃合炼',output:'sword',outputCount:1,materials:{part:1,essence:1}},
    {id:'part',name:'鸣金精料',type:'精炼',output:'part',outputCount:1,materials:{ingot:2}},
    {id:'ingot',name:'粗炼鸣金锭',type:'普通炼制',output:'ingot',outputCount:1,materials:{ore:4,core:2}},
    {id:'ingot2',name:'精炼鸣金锭',type:'普通炼制',output:'ingot',outputCount:2,materials:{ore:5,core:3}},
    {id:'essence',name:'养灵淬液',type:'精炼',output:'essence',outputCount:1,materials:{wood:2}}
  ],enemies:[{id:'rat',name:'山鼠',realm:1,realmLabel:'炼气',stats:{maxHp:'10',attack:'2'},abilities:{},loot:[{itemId:'ore',chance:1},{itemId:'core',chance:.5}]},{id:'ape',name:'木猿',realm:2,realmLabel:'筑基',stats:{maxHp:'20',attack:'3'},abilities:{},loot:[{itemId:'wood',chance:1}]}],maps:[{id:'hill',name:'青山',pool:['rat','ape'],groups:10,groupSize:2,enemyMultiplier:1,encounterPools:{},challenge:false}]};
  c.library={revision:1,views:{inventory:{updatedAt:Date.now(),items:[{name:'鸣金锭',quantity:2},{name:'养灵淬液',identity:'i1',quantity:1,quality:100}],equipment:[]},crafting:{updatedAt:Date.now(),items:c.knowledge.recipes.map((r,i)=>({key:String(i+1).repeat(64),name:r.name,recipeType:r.type,category:'器物',chance:'必成',output:'每次 1 件'})),equipment:[]}},details:{}};
  c.bestiary={revision:1,knowledgeRevision:'k',resourceUrl:'r',updatedAt:1,entries:[{id:'rat',name:'山鼠',kills:'123'},{id:'ape',name:'木猿',kills:'12'}]};c.catalog={resourceUrl:'r',regions:[],nodes:[{id:'hill',name:'青山',regionName:'北境',availability:'visible',type:'battle'}],items:[]};
  const state={phase:'running',desired:'running',revision:1,settings:{target:{regionName:'北境',stageName:'青山'},healingTarget:null,consumables:{enabled:false,itemNames:[]}},catalog:c.catalog,logs:[],consumables:{},library:{revision:1,sync:{intervalMs:60000}},bestiary:{revision:1,updatedAt:1},crafting:{operations:[],previews:[]}};
  c.snapshot=()=>state;c.getBestiary=()=>bestiaryView(c.knowledge,c.bestiary,c.catalog);c.planFarming=p=>farmingPlan(c,p);c.command=(kind,payload)=>({id:1,kind});c.images={close:async()=>{}};
  const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`http://127.0.0.1:${server.server.address().port}/#bestiary`);await page.locator('.enemy-card').first().waitFor();
    assert.equal(await page.locator('.enemy-card').first().getAttribute('data-id'),'rat');
    await page.locator('#bestiary-order').selectOption('reverse');assert.equal(await page.locator('.enemy-card').first().getAttribute('data-id'),'ape');
    await page.locator('#bestiary-search').fill('猿');assert.equal(await page.locator('.enemy-card').count(),1);
    c.bestiary.revision=2;state.bestiary.revision=2;c.emit('change',state);await page.waitForTimeout(150);
    assert.equal(await page.locator('#bestiary-search').inputValue(),'猿');assert.equal(await page.locator('#bestiary-order').inputValue(),'reverse');
    await page.reload();await page.locator('.enemy-card').first().waitFor();assert.equal(await page.locator('.enemy-card').first().getAttribute('data-id'),'ape');
    await page.locator('#library-fold > summary').click();await page.getByRole('tab',{name:/炼制/u}).click();await page.getByRole('button',{name:'查看养灵鸣金剑详情'}).click();await page.locator('.farming-map').waitFor();
    assert.match(await page.locator('.farming-basis').innerText(),/现有库存已足够/u);
    assert.deepEqual(await page.locator('.material-source').evaluateAll(rows=>rows.map(r=>r.dataset.itemId)),['ore','core','wood']);
    await page.locator('[data-item-id="part"] > summary').click();await page.locator('[data-item-id="ingot"] > summary').click();
    assert.equal(await page.locator('[data-item-id="ingot"] [data-item-id="ore"] > summary').isVisible(),true);
    assert.match(await page.locator('[data-item-id="ingot"] > .hint').first().innerText(),/库存已满足/u);
    await page.getByLabel('鸣金锭的合成路线').selectOption('ingot2');
    await page.waitForFunction(()=>document.querySelector('[data-item-id="ingot"] > p:nth-of-type(2)')?.textContent.includes('精炼鸣金锭'));
    assert.equal(await page.locator('[data-item-id="ingot"]').getAttribute('open'),'');
    assert.match(await page.locator('.material-source[data-item-id="ore"]').innerText(),/参考需 5/u);
    await page.locator('[data-item-id="ingot"] > button').click();
    await page.waitForFunction(()=>document.querySelector('#farming-content h4')?.textContent.includes('单个物品：鸣金锭'));
    assert.equal(await page.locator('#farming-material').inputValue(),'ingot');assert.equal(await page.locator('.material-source[data-item-id="wood"]').count(),0);
    await page.locator('#farming-material-quantity').fill('5');await page.locator('#farming-material-quantity').dispatchEvent('change');
    await page.waitForFunction(()=>document.querySelector('.material-source[data-item-id="ore"] strong')?.textContent.includes('需补 10'));
    c.library.revision=2;state.library.revision=2;c.emit('change',state);await page.waitForTimeout(150);
    assert.equal(await page.locator('#farming-material-quantity').inputValue(),'5');assert.equal(await page.locator('#farming-single').getAttribute('aria-pressed'),'true');
    await page.locator('#farming-whole').click();await page.locator('.material-source[data-item-id="wood"]').waitFor();
    assert.match(await page.locator('.farming-itinerary').innerText(),/整件刷取汇总/u);
    const directory=process.env.CONTAINER_PROFILE_PATH?path.join(os.tmpdir(),'bestiary-tests'):path.resolve('work');await mkdir(directory,{recursive:true});
    await page.locator('#farming').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'farming-v2-desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.locator('.farming-itinerary').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'farming-v2-mobile.png')});
    assert.equal(await page.locator('#library-detail').evaluate(e=>e.scrollWidth<=e.clientWidth),true);assert.deepEqual(errors,[]);
  }finally{await page.close();await server.close();}
});
