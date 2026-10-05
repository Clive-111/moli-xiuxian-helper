import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { startControlServer } from '../src/control-server.js';

let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});
async function setup() {
  const c=new EventEmitter(),commands=[],errors=[];
  const item={name:'药草',key:'a'.repeat(64),category:'材料',quantity:'1'}, recipe={name:'药丸',key:'b'.repeat(64),category:'补给',recipeType:'普通炼制',stock:'可供 1 炉'};
  c.library={revision:1,views:{inventory:{updatedAt:1,items:[item],equipment:[]},crafting:{updatedAt:1,items:[recipe],equipment:[]}},details:{[recipe.key]:{name:recipe.name,updatedAt:1,facts:[],materials:[],ingredients:[]}}};
  const state={phase:'running',desired:'running',revision:1,settings:{target:{regionName:'北境',stageName:'银阶'},healingTarget:null,consumables:{enabled:false,itemNames:['赤灵髓']}},catalog:{regions:[],nodes:[],items:[]},state:{character:'测试修士',region:'北境',location:'银阶'},logs:[],consumables:{},library:{revision:1,sync:{intervalMs:60000}}};
  state.bestiary={revision:1,updatedAt:1,error:''};
  c.getBestiary=()=>({...state.bestiary,entries:[],unknown:[],stale:false});
  c.snapshot=()=>state;
  const publish=()=>{state.library.revision=c.library.revision;c.emit('change',state);};
  c.command=(kind,payload)=>{
    commands.push({kind,payload});const id=commands.length;
    if(kind==='library'&&!payload.key){
      for(const view of payload.views??[payload.view]){if(view==='bestiary'){state.bestiary.updatedAt=Date.now();state.bestiary.revision++;continue;}const value=c.library.views[view];value.updatedAt=Date.now();
      if(view==='inventory')value.items[0].quantity=String(Number(value.items[0].quantity)+1);}
      c.library.revision++;
      state.lastCommand={id,kind,ok:true,automatic:payload.automatic===true,view:payload.view};publish();
    }
    return {id,kind};
  };
  c.images={close:async()=>{}};
  const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  const url=`http://127.0.0.1:${server.server.address().port}`;
  return {c,state,commands,errors,page,url,publish,close:async()=>{await page.close();await server.close();}};
}

test('close and open controls reflect disconnected state without silently starting or reading the game',async()=>{
  const h=await setup();try{
    h.state.desired='stopped';h.state.phase='stopped';await h.page.clock.install();await h.page.goto(h.url);
    await h.page.getByRole('button',{name:'关闭游戏',exact:true}).click();
    assert.equal(h.commands.at(-1).kind,'close-game');
    h.state.gameClosed=true;h.state.phase='closed';h.publish();
    await h.page.waitForFunction(()=>document.querySelector('#phase').textContent==='游戏已关闭');
    assert.equal(await h.page.locator('[data-command=start]').isDisabled(),true);
    assert.equal(await h.page.getByRole('button',{name:'打开游戏',exact:true}).isVisible(),true);
    await h.page.locator('.nav[href="#library"]').click();await h.page.clock.fastForward(121000);
    assert.equal(h.commands.length,1);assert.match(await h.page.locator('#library-sync').textContent(),/当前显示缓存/u);
    await h.page.locator('.nav[href="#overview"]').click();
    await h.page.getByRole('button',{name:'打开游戏',exact:true}).click();assert.equal(h.commands.at(-1).kind,'open-game');
    h.state.gameClosed=false;h.state.phase='stopped';h.publish();
    await h.page.waitForFunction(()=>!document.querySelector('[data-command=start]').disabled);
    assert.equal(await h.page.getByRole('button',{name:'打开游戏',exact:true}).isVisible(),false);
    assert.equal(h.commands.length,2);assert.deepEqual(h.errors,[]);
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await h.page.screenshot({path:'work/close-game-panel-mobile.png',fullPage:true});
  }finally{await h.close();}
});

test('visible stale list and switched tab auto-sync; offscreen and healing do not operate the game',async()=>{
  const h=await setup();try{
    await h.page.goto(h.url);await h.page.locator('#library-grid button').waitFor({state:'attached'});
    await h.page.waitForTimeout(1100);assert.equal(h.commands.length,0);
    await h.page.locator('#library').scrollIntoViewIfNeeded();
    await h.page.waitForTimeout(1100);assert.equal(h.commands.length,0);assert.equal(await h.page.locator('#library-fold').getAttribute('open'),null);
    await h.page.locator('#library-fold > summary').focus();await h.page.keyboard.press('Enter');
    await h.page.waitForFunction(()=>document.querySelector('.item-amount').textContent==='× 2');
    assert.equal(h.commands.length,1);assert.equal(h.commands[0].payload.automatic,true);
    await h.page.getByRole('tab',{name:/炼制/u}).click();
    await h.page.waitForFunction(()=>document.querySelector('#library-updated').textContent.includes(new Date().getFullYear()));
    assert.deepEqual(h.commands.at(-1).payload.views,['inventory','crafting','bestiary']);assert.equal(h.commands.length,1);
    h.state.phase='healing';h.c.library.views.crafting.updatedAt=1;h.c.library.revision++;h.publish();
    const count=h.commands.length;await h.page.waitForTimeout(1300);assert.equal(h.commands.length,count);
    // Move offscreen while healing still suppresses reads. Publishing running
    // first races the real one-second timer before the scroll has finished.
    await h.page.locator('#overview').scrollIntoViewIfNeeded();
    await h.page.waitForFunction(()=>document.getElementById('library').getBoundingClientRect().top>=innerHeight);
    h.state.phase='running';h.publish();
    await h.page.waitForTimeout(1300);assert.equal(h.commands.length,count);assert.deepEqual(h.errors,[]);
    await h.page.locator('#library-search').fill('药丸');await h.page.locator('#library-fold > summary').click();
    await h.page.waitForFunction(()=>localStorage.getItem('control-section:library')==='closed');
    assert.equal(await h.page.locator('#library-search').inputValue(),'药丸');
    await h.page.screenshot({path:'work/fold-desktop.png',fullPage:true});
    await h.page.reload();assert.equal(await h.page.locator('#library-fold').getAttribute('open'),null);
    await h.page.locator('.nav[href="#library"]').click();assert.notEqual(await h.page.locator('#library-fold').getAttribute('open'),null);
    await h.page.locator('#library-fold > summary').click();await h.page.setViewportSize({width:390,height:844});
    await h.page.locator('#library').scrollIntoViewIfNeeded();assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await h.page.screenshot({path:'work/fold-mobile.png',fullPage:true});
  }finally{await h.close();}
});

test('stopped browsing never auto-syncs; starting enables checks and stopping disables them across tabs and reloads',async()=>{
  const h=await setup();try{
    h.state.desired='stopped';h.state.phase='stopped';await h.page.clock.install();await h.page.goto(h.url+'/#library');
    await h.page.locator('#library-grid button').first().waitFor();await h.page.clock.fastForward(121000);
    assert.equal(h.commands.length,0);assert.match(await h.page.locator('#library-sync').textContent(),/挂机未启动/u);
    await h.page.getByRole('tab',{name:/炼制/u}).click();await h.page.clock.fastForward(61000);assert.equal(h.commands.length,0);
    await h.page.locator('#library-refresh').click();await h.page.waitForFunction(()=>document.querySelector('#library-updated').textContent.includes(new Date().getFullYear()));
    assert.equal(h.commands.length,1);assert.equal(h.commands[0].payload.automatic,undefined);
    for(const v of Object.values(h.c.library.views))v.updatedAt=1;h.state.bestiary.updatedAt=1;h.publish();
    h.state.desired='running';h.state.phase='running';h.publish();await h.page.clock.fastForward(1500);
    await h.page.waitForFunction(()=>document.querySelector('#library-sync').textContent.includes('挂机运行时'));
    assert.equal(h.commands.length,2);assert.equal(h.commands[1].payload.automatic,true);
    // Desired stopped arrives before the stop animation/phase catches up.
    h.state.desired='stopped';h.publish();for(const v of Object.values(h.c.library.views))v.updatedAt=1;h.state.bestiary.updatedAt=1;
    await h.page.clock.fastForward(121000);assert.equal(h.commands.length,2);
    await h.page.locator('.nav[href="#bestiary"]').click();await h.page.clock.fastForward(61000);assert.equal(h.commands.length,2);
    await h.page.reload();await h.page.locator('#bestiary-meta').waitFor();await h.page.clock.fastForward(61000);assert.equal(h.commands.length,2);
    assert.match(await h.page.locator('#bestiary-sync').textContent(),/挂机未启动/u);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('SSE revision arriving during a slow cache response is not lost when no later event arrives',async()=>{
  const h=await setup();let release,entered;
  const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let first=true;
  try{
    await h.page.route('**/api/library',async route=>{
      if(!first)return route.continue();first=false;
      const body=JSON.stringify(h.c.library);entered();await gate;await route.fulfill({contentType:'application/json',body});
    });
    await h.page.goto(h.url);await ready;
    h.c.library.views.inventory.items[0].quantity='9';h.c.library.revision=2;h.publish();
    await h.page.waitForTimeout(100);release();
    await h.page.waitForFunction(()=>document.querySelector('.item-amount')?.textContent==='× 9');
    assert.equal(h.commands.length,0);assert.deepEqual(h.errors,[]);
  }finally{release();await h.close();}
});

test('an expired SSE session is renewed automatically without reloading the panel',async()=>{
  const h=await setup();let sessions=0,streams=0;
  try{
    await h.page.route('**/api/session',route=>{sessions++;return route.continue();});
    await h.page.route('**/api/events',route=>++streams===1?route.fulfill({status:401,contentType:'application/json',body:'{"error":"session expired"}'}):route.continue());
    await h.page.goto(h.url);
    await h.page.waitForFunction(()=>document.querySelector('#connection').textContent==='实时连接');
    await h.page.locator('#library-grid button').waitFor({state:'attached'});
    assert.ok(sessions>=2);assert.ok(streams>=2);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('cached list changes preserve filters and an open recipe draft, with no automatic reads in details',async()=>{
  const h=await setup();try{
    for(const data of Object.values(h.c.library.views))data.updatedAt=Date.now();
    h.state.bestiary.updatedAt=Date.now();
    await h.page.goto(h.url);await h.page.locator('#library-grid button').waitFor({state:'attached'});
    await h.page.locator('#library-fold > summary').click();await h.page.getByRole('tab',{name:/炼制/u}).click();await h.page.locator('#library-search').fill('药丸');
    await h.page.locator('#library-grid button').click();
    await h.page.getByRole('button',{name:'10 炉',exact:true}).click();
    const input=h.page.getByRole('spinbutton',{name:'自定义炼制炉数'});
    assert.equal(await input.inputValue(),'10');
    h.c.library.views.crafting.updatedAt=1;h.c.library.views.crafting.items[0].stock='可供 3 炉';h.c.library.revision++;h.publish();
    await h.page.waitForFunction(()=>document.querySelector('.collection-stock')?.textContent==='可供 3 炉');
    await h.page.waitForTimeout(1200);
    assert.equal(await input.inputValue(),'10');assert.equal(await h.page.locator('#library-search').inputValue(),'药丸');
    assert.equal(h.commands.filter(c=>c.payload.automatic).length,0);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('viewing only bestiary refreshes all three pages each minute and either refresh button uses that batch',async()=>{
  const h=await setup();try{
    await h.page.clock.install();await h.page.goto(h.url+'/#bestiary');
    await h.page.waitForFunction(()=>document.querySelector('#bestiary-meta').textContent.includes(new Date().getFullYear()));
    assert.equal(await h.page.locator('#library-fold').getAttribute('open'),null);
    assert.equal(h.commands.length,1);assert.deepEqual(h.commands[0],{kind:'library',payload:{views:['inventory','crafting','bestiary'],automatic:true}});
    await h.page.locator('#bestiary-search').fill('保留筛选');await h.page.locator('#bestiary-order').selectOption('reverse');
    // Only the bestiary is stale: inventory freshness must not suppress its refresh.
    h.c.library.views.inventory.updatedAt=Date.now()+61000;h.c.library.views.crafting.updatedAt=Date.now()+61000;h.state.bestiary.updatedAt=1;h.publish();
    await h.page.clock.fastForward(61000);
    await h.page.waitForFunction(()=>document.querySelector('#bestiary-meta').textContent.includes(new Date().getFullYear()));
    assert.equal(h.commands.length,2);assert.equal(h.state.bestiary.revision,3);
    assert.equal(await h.page.locator('#bestiary-search').inputValue(),'保留筛选');assert.equal(await h.page.locator('#bestiary-order').inputValue(),'reverse');
    await h.page.locator('#bestiary-refresh').click();assert.equal(h.commands.length,3);assert.deepEqual(h.commands[2].payload,{views:['inventory','crafting','bestiary']});
    await h.page.locator('#bestiary-fold > summary').click();await h.page.clock.fastForward(61000);assert.equal(h.commands.length,3);
    // Read dialogs suppress timer-driven page changes even with bestiary visible.
    h.state.phase='healing';h.publish();await h.page.locator('#bestiary-fold > summary').click();await h.page.clock.fastForward(61000);assert.equal(h.commands.length,3);
    await h.page.evaluate(()=>document.getElementById('library-detail').showModal());h.state.phase='running';h.publish();await h.page.clock.fastForward(61000);assert.equal(h.commands.length,3);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
