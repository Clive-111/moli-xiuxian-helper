import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BattleUI } from '../src/battle-ui.js';
import { startControlServer } from '../src/control-server.js';
import { ControlInterrupted } from '../src/control-errors.js';

let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});
const catalog={version:1,updatedAt:Date.now(),regions:[{id:'n',name:'北境'},{id:'s',name:'南境'}],nodes:[
  {id:'a',regionName:'北境',name:'石阶',type:'battle',availability:'unverified'},
  {id:'b',regionName:'北境',name:'北泉',type:'healing',availability:'unverified'},
  {id:'c',regionName:'南境',name:'石阶',type:'battle',availability:'unverified'},
  {id:'d',regionName:'南境',name:'阵台',type:'rest',availability:'unverified'},
  {id:'e',regionName:'南境',name:'决战',type:'challenge',availability:'unverified'},
],items:['赤灵髓','碧灵髓','金灵髓'].map((name,id)=>({name,id:String(id)}))};
test('map catalog scan reads both regions and locked nodes, never clicks a location, returns to ongoing combat',async()=>{
  const page=await browser.newPage();
  try{
    await page.setContent('<aside data-player-panel><b>测试修士</b><div><span>气血</span> <span>100 / 100</span></div></aside><main data-game-main></main>');
    await page.evaluate(()=>{
      window.locationClicks=0;const main=document.querySelector('main');
      window.battle=()=>{main.dataset.mode='';main.dataset.region='北境';main.dataset.location='石阶';main.innerHTML='<h1>石阶</h1><p>正在探索</p><button>撤退</button><button id="map">山河图</button>';main.querySelector('#map').onclick=map;};
      window.map=()=>{main.dataset.mode='map';main.innerHTML='<h1>山河图</h1><div class="map-viewport" data-map-level="regions"><button aria-label="展开北境">北境</button><button aria-label="展开南境">南境</button></div><button id="back" aria-label="返回战斗">返回</button>';
        main.querySelector('#back').onclick=battle;
        main.querySelector('.map-viewport button').onclick=()=>{const map=main.querySelector('.map-viewport');map.dataset.mapLevel='locations';map.innerHTML='<span class="map-region-label">北境</span><span class="map-region-label">南境</span>';
          for(const [name,region,type,locked] of [['石阶','北境','历练之地',false],['北泉','北境','安全区，可调息',false],['石阶','南境','历练之地',true],['阵台','南境','安全区，普通歇息',false],['决战','南境','独立挑战',false]]){
            const node=document.createElement('button');node.className='map-node';node.dataset.region=region;node.setAttribute('aria-label',name+'，'+type);node.innerHTML='<strong>'+name+'</strong>';node.disabled=locked;node.onclick=()=>locationClicks++;map.append(node);
          }
        };
      };battle();
    });
    const ui=new BattleUI(page,{characterName:'测试修士',target:{regionName:'北境',stageName:'石阶'}},{actionDelaySeconds:.001,responseTimeoutSeconds:1},()=>{},new AbortController().signal);
    ui.ensureApp=async()=>page.mainFrame();
    const result=await ui.inspectCatalog(catalog);
    assert.equal(result.nodes.find(n=>n.id==='a').availability,'visible');assert.equal(result.nodes.find(n=>n.id==='c').availability,'locked');
    assert.equal(result.nodes.find(n=>n.id==='b').availability,'visible');assert.equal(result.nodes.find(n=>n.id==='d').type,'rest');
    assert.equal(await page.evaluate(()=>locationClicks),0);assert.equal((await ui.observe()).mode,'combat');
    let clicks=0;ui.beforeAction=()=>{throw new ControlInterrupted('stop');};
    await page.getByText('撤退',{exact:true}).evaluate(el=>el.onclick=()=>window.retreats=(window.retreats??0)+1);
    await assert.rejects(ui.retreatForTarget({regionName:'北境',stageName:'石阶'},{force:true}),error=>error instanceof ControlInterrupted && error.beforeRetreat===true);
    assert.equal(await page.evaluate(()=>window.retreats??0),0);
  }finally{await page.close();}
});
test('Chinese panel retains draft while SSE updates; grouped selections and controls work on desktop and mobile',async()=>{
  const control=new EventEmitter();let id=0;const commands=[];
  let state={phase:'running',desired:'running',revision:1,settings:{target:{regionName:'北境',stageName:'石阶'},healingTarget:{regionName:'北境',locationName:'北泉'},consumables:{enabled:true,itemNames:['赤灵髓','碧灵髓']}},
    state:{character:'测试修士',region:'北境',location:'石阶',health:{current:'342,102.18',maximum:'360,785.47',percent:94.82},inventoryStocks:[{name:'赤灵髓',count:3}]},updatedAt:Date.now(),catalog,
    consumables:{nextAt:Date.now()+600000,results:{'赤灵髓':{before:4,after:0}}},logs:[{id:1,at:Date.now(),message:'当前关卡正在战斗，持续监测。'}]};
  control.snapshot=()=>state;control.record=state;control.catalog=catalog;
  control.command=(kind,payload)=>{commands.push({kind,payload});return{id:++id,kind};};
  const server=await startControlServer(control,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1200}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`http://127.0.0.1:${server.server.address().port}`);await page.getByText('战斗运行中',{exact:true}).waitFor();
    await page.locator('#battle-region').selectOption('南境');await page.locator('#battle-stage').selectOption('石阶');
    control.emit('change',{...state,updatedAt:Date.now()});await page.waitForTimeout(100);
    assert.equal(await page.locator('#battle-region').inputValue(),'南境');assert.equal(await page.locator('#dirty').textContent(),'有尚未应用的修改');
    state={...state,revision:2,settings:{...state.settings,saleTarget:{regionName:'北境',locationName:'镇',shopName:'商会'}},lastCommand:{id:50,kind:'settings',ok:true,saleTargetOnly:true}};
    control.emit('change',state);await page.waitForTimeout(100);
    assert.equal(await page.locator('#battle-region').inputValue(),'南境');assert.equal(await page.locator('#dirty').textContent(),'有尚未应用的修改');
    await page.getByRole('button',{name:'保存并应用',exact:true}).click();await page.waitForTimeout(100);
    assert.equal(commands[0].payload.settings.target.regionName,'南境');assert.equal(commands[0].payload.revision,2);assert.deepEqual(commands[0].payload.settings.saleTarget,state.settings.saleTarget);
    await page.getByRole('button',{name:'撤退并停止'}).click();await page.waitForTimeout(100);assert.equal(commands[1].kind,'stop');
    assert.equal(await page.locator('#items input:checked').count(),2);
    const artifacts=process.env.CONTAINER_PROFILE_PATH ? path.join(os.tmpdir(),'control-test') : 'work';
    await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'control-panel-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'control-panel-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
  }finally{await page.close();await server.close();}
});
