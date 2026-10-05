import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BattleUI} from '../src/battle-ui.js';
import {BattleRunner} from '../src/battle.js';
import {runBattleIteration,ViewRecoveryError} from '../src/battle-view.js';

let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});
const config={characterName:'测试修士',target:{regionName:'北境',stageName:'银阶'},healingTarget:{regionName:'南境',locationName:'南泉'},pollIntervalSeconds:5,healActionIntervalSeconds:2,consumables:{enabled:true,itemNames:['赤灵髓','碧灵髓']}};
async function setup(variant='valid') {
  const context=await browser.newContext();const page=await context.newPage();
  await page.setContent('<aside data-player-panel><b>测试修士</b><div><span>气血</span> <span id="hp">10 / 100</span></div></aside><main data-game-main></main>');
  await page.evaluate(variant=>{
    window.actions=[];window.variant=variant;
    window.regions={'南境':['南泉','石阶'],'北境':['北泉','银阶']};
    window.region='北境';window.locationName='银阶';
    const main=document.querySelector('main');
    window.show=()=>{
      main.dataset.region=region;main.dataset.location=locationName;main.dataset.mode='';
      main.innerHTML=`<h1>${locationName}</h1><button id="map">山河图</button>`;
      const control=document.createElement('button');
      if(locationName.endsWith('泉')) {
        control.textContent='调息';control.onclick=()=>{actions.push('heal');document.querySelector('#hp').textContent='200 / 200';};
      } else {
        control.textContent='开始探索';control.onclick=()=>{actions.push('combat:'+region+'/'+locationName);main.innerHTML='<h1>'+locationName+'</h1><p>正在探索</p><button>撤退</button>';};
      }
      main.append(control);main.querySelector('#map').onclick=()=>window.map();
    };
    window.map=()=>{
      main.dataset.mode='map';main.innerHTML='<h1>山河图</h1><div class="map-viewport" data-map-level="regions" style="min-height:200px"></div><button id="back">返回当地</button>';
      main.querySelector('#back').onclick=show;
      const area=main.querySelector('.map-viewport');
      for(const name of Object.keys(regions)) {
        const button=document.createElement('button');button.setAttribute('aria-label','展开'+name);button.textContent=name;area.append(button);
        button.onclick=()=>{
          area.dataset.mapLevel='locations';area.replaceChildren();
          if(variant==='clipped')area.style.cssText='position:relative;overflow:hidden;width:350px;height:200px';
          for(const location of regions[name]) {
            if(variant==='missing'&&location.endsWith('泉'))continue;
            const node=document.createElement('button');
            const safe=location.endsWith('泉');
            node.setAttribute('aria-label',location+(safe?'，安全区，可调息':'，历练之地'));
            node.innerHTML='<strong>'+location+'</strong><small>'+(safe?'安全 · 调息':'已清理')+'</small>';
            if(safe&&variant==='unsafe'){node.setAttribute('aria-label',location);node.querySelector('small').textContent='历练之地';}
            if(safe&&variant==='ordinary-rest'){node.setAttribute('aria-label',location+'，安全区，普通歇息');node.querySelector('small').textContent='安全区';}
            if(safe&&variant==='locked')node.disabled=true;
            node.onclick=()=>{actions.push('travel:'+name+'/'+location);region=variant==='wrong-region'?'错误区域':name;locationName=location;show();};
            area.append(node);
            if(safe&&variant==='clipped') {
              node.style.cssText='position:absolute;left:430px;top:-110px';
              let drag;
              area.onpointerdown=e=>{if(e.target===area){drag={x:e.clientX,y:e.clientY,left:parseFloat(node.style.left),top:parseFloat(node.style.top)};area.setPointerCapture(e.pointerId);window.drags=(window.drags||0)+1;}};
              area.onpointermove=e=>{if(drag){node.style.left=drag.left+e.clientX-drag.x+'px';node.style.top=drag.top+e.clientY-drag.y+'px';}};
              area.onpointerup=()=>{drag=null;};
            }
            if(safe&&variant==='duplicate')area.append(node.cloneNode(true));
          }
        };
      }
      if(variant==='remembered-map'&&!window.fullOverview) {
        area.querySelector('button').click();
        const full=document.createElement('button');full.setAttribute('aria-label','全图');main.append(full);
        full.onclick=()=>{window.fullOverview=true;map();};
      }
    };
    show();
    for(const [name,count] of [['莹灵髓',13],['玉灵髓',3],['赤灵髓',7],['碧灵髓',4],['玄灵髓',5]]) {
      const row=document.createElement('article');row.className='quick-item';
      row.innerHTML=`<div class="quick-item-info"><strong>${name}</strong><small title="持有 ${count} 个">×${count}</small></div><button aria-label="使用全部${name}">全部</button>`;
      row.querySelector('button').onclick=()=>{actions.push('use:'+name);row.remove();};document.querySelector('aside').append(row);
    }
  },variant);
  const cfg=structuredClone(config);
  const ui=new BattleUI(page,cfg,{actionDelaySeconds:0.001,responseTimeoutSeconds:0.5},()=>{},new AbortController().signal);
  ui.ensureApp=async()=>page.mainFrame();
  return {context,page,ui,cfg};
}

test('safe shop travel permits wounded ordinary rest nodes; unsafe and locked locations stay protected',async()=>{
  const h=await setup('ordinary-rest');try{await h.ui.selectMapDestination('南境','南泉',{safeTravel:true});assert.deepEqual(await h.page.evaluate(()=>actions),['travel:南境/南泉']);}finally{await h.context.close();}
  for(const variant of ['unsafe','locked','duplicate']){const h=await setup(variant);try{await assert.rejects(h.ui.selectMapDestination('南境','南泉',{safeTravel:true}));assert.deepEqual(await h.page.evaluate(()=>actions),[]);}finally{await h.context.close();}}
});

test('wounded travel, healing, and battle use independently configured regions and destinations',async()=>{
  for(const swapped of [false,true]) {
    const h=await setup();
    try {
      if(swapped){h.cfg.healingTarget={regionName:'北境',locationName:'北泉'};h.cfg.target={regionName:'南境',stageName:'石阶'};}
      const runner=new BattleRunner(h.ui,h.cfg,()=>{});
      const tick=()=>runBattleIteration(h.ui,runner,{runIfDue:async()=>{}});
      await tick();await tick();await tick();await tick();await tick();
      assert.deepEqual(await h.page.evaluate(()=>actions),[
        `travel:${h.cfg.healingTarget.regionName}/${h.cfg.healingTarget.locationName}`,'heal',
        `travel:${h.cfg.target.regionName}/${h.cfg.target.stageName}`,`combat:${h.cfg.target.regionName}/${h.cfg.target.stageName}`]);
      assert.equal((await h.ui.observe()).mode,'combat');
    } finally {await h.context.close();}
  }
});

test('missing, locked, ambiguous, ordinary resting and unsafe healing nodes cannot be clicked',async()=>{
  for(const variant of ['missing','locked','duplicate','unsafe','ordinary-rest']) {
    const h=await setup(variant);
    try {await assert.rejects(h.ui.travelToHealing(h.cfg.healingTarget));assert.deepEqual(await h.page.evaluate(()=>actions),[]);}
    finally {await h.context.close();}
  }
});

test('wrong-region arrival cannot trigger healing; low HP cannot start exploration',async()=>{
  const h=await setup('wrong-region');
  try {
    await assert.rejects(h.ui.travelToHealing(h.cfg.healingTarget),/与配置不符/u);
    await h.ui.heal(await h.ui.observe());
    await assert.rejects(h.ui.enterTarget(h.cfg.target),/未超过 95%/u);
    assert.deepEqual(await h.page.evaluate(()=>actions),['travel:南境/南泉']);
  } finally {await h.context.close();}
});

test('confirmed arrival after response timeout or view interruption never repeats the travel click',async()=>{
  for(const ErrorType of [Error,ViewRecoveryError]) {
    const h=await setup();
    try {
      const runner=new BattleRunner(h.ui,h.cfg,()=>{});
      const travel=h.ui.travelToHealing.bind(h.ui);
      h.ui.travelToHealing=async target=>{await travel(target);throw new ErrorType('response lost');};
      await assert.rejects(runner.step(),/response lost/u);
      await runBattleIteration(h.ui,runner,{runIfDue:assert.fail});
      assert.deepEqual(await h.page.evaluate(()=>actions),['travel:南境/南泉','heal']);
    } finally {await h.context.close();}
  }
});

test('only the configured new pair is used, even with old items adjacent and generic All buttons',async()=>{
  const h=await setup();
  try {
    for(const name of ['莹灵髓','玉灵髓','玄灵髓'])await assert.rejects(h.ui.consumeAllApproved(name),/未获授权/u);
    for(const name of ['赤灵髓','碧灵髓'])assert.equal((await h.ui.consumeAllApproved(name)).after,0);
    assert.deepEqual(await h.page.evaluate(()=>actions),['use:赤灵髓','use:碧灵髓']);
    assert.equal(await h.page.locator('.quick-item').count(),3);
    assert.ok((await h.ui.consumeAllApproved('碧灵髓')).skipped);
  } finally {await h.context.close();}
});

test('remembered local maps return to the overview and clipped nodes are panned into view without force',async()=>{
  for(const variant of ['remembered-map','clipped']) {
    const h=await setup(variant);
    try {
      await h.ui.travelToHealing(h.cfg.healingTarget);
      assert.deepEqual(await h.page.evaluate(()=>actions),['travel:南境/南泉']);
      if(variant==='clipped')assert.ok(await h.page.evaluate(()=>drags)>0);
    } finally {await h.context.close();}
  }
});

test('death at an ordinary safe resting point without a heal button navigates to the configured healer',async()=>{
  const h=await setup();
  try {
    await h.page.evaluate(()=>{
      locationName='阵台';show();document.querySelector('main button:last-child').remove();
      document.querySelector('main').insertAdjacentHTML('beforeend','<p class="location-safety">安全区<span>普通歇息</span></p>');
    });
    const state=await h.ui.observe();assert.equal(state.mode,'rest');assert.equal(state.heal.enabled,false);
    const runner=new BattleRunner(h.ui,h.cfg,()=>{});
    await runBattleIteration(h.ui,runner,{runIfDue:async()=>{}});
    await runner.step();assert.deepEqual(await h.page.evaluate(()=>actions),['travel:南境/南泉','heal']);
    assert.equal((await h.ui.observe()).location,'南泉');
  } finally {await h.context.close();}
});

test('visible save-conflict notices pause before gameplay even outside a dialog; hidden and historical notices do not',async()=>{
  const h=await setup();
  try {
    await h.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<p id="conflict">云端已有另一份保存版本，本地进度保留。请在存档管理选择要保留的进度。</p>'));
    await assert.rejects(h.ui.ensureMonitoringView(),/游戏需要人工处理/u);
    assert.deepEqual(await h.page.evaluate(()=>actions),[]);
    await h.page.locator('#conflict').evaluate(el=>el.hidden=true);
    assert.equal((await h.ui.ensureMonitoringView()).ready,true);
    await h.page.locator('#conflict').evaluate(el=>{el.hidden=false;el.className='log-entry';});
    assert.equal((await h.ui.ensureMonitoringView()).ready,true);
  } finally {await h.context.close();}
});
