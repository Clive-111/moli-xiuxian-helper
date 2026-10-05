import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BattleUI,readGameSnapshot} from '../src/battle-ui.js';
import {BattleRunner} from '../src/battle.js';

let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});

test('region headings preserve every internal separator and strip only the final place-type suffix',async()=>{
  const page=await browser.newPage();
  try{
    for(const region of ['坠星灵舟·内舱','坠星灵舟·外舱','北境・东域·内城','涵岳内院']){
      for(const suffix of ['歇脚之地','历练之地','休整之地']){
        for(const separator of [' · ','・']){
          await page.setContent(`<style>.eyebrow{display:none}</style><main><div class="page-heading"><span class="eyebrow">${region}${separator}${suffix}</span><h1>目的地</h1></div><button>调息</button></main>`);
          assert.equal((await page.evaluate(readGameSnapshot,'测试修士')).region,region);
          // The visible text fallback must use the identical suffix rule.
          await page.locator('.page-heading').evaluate(el=>{el.className='';el.querySelector('span').className='';});
          assert.equal((await page.evaluate(readGameSnapshot,'测试修士')).region,region);
        }
      }
    }
    await page.setContent('<main data-region="明确区域·第二层"><div class="page-heading"><span class="eyebrow">其他区域 · 歇脚之地</span></div></main>');
    assert.equal((await page.evaluate(readGameSnapshot,'测试修士')).region,'明确区域·第二层');
    await page.setContent('<main><div class="page-heading"><span class="eyebrow">坠星灵舟·内舱</span></div></main>');
    assert.equal((await page.evaluate(readGameSnapshot,'测试修士')).region,'坠星灵舟·内舱');
  }finally{await page.close();}
});

async function setup({inner='坠星灵舟·内舱',outer='坠星灵舟·外舱',startElsewhere=false,lostTravel=false}={}){
  const page=await browser.newPage();
  const config={characterName:'测试修士',target:{regionName:outer,stageName:'前庭'},healingTarget:{regionName:inner,locationName:'静室'},pollIntervalSeconds:1,healActionIntervalSeconds:.001,actionDelaySeconds:.001};
  await page.setContent('<style>.eyebrow{display:none}</style><aside data-player-panel><b>测试修士</b><div><span>气血</span> <span id="hp">10 / 100</span></div></aside><main></main>');
  await page.evaluate(({inner,outer,startElsewhere})=>{
    window.actions=[];window.region=startElsewhere?outer:inner;window.place='静室';window.healing=false;window.combat=false;
    const main=document.querySelector('main');
    window.show=()=>{
      main.innerHTML=`<div class="page-heading"><span class="eyebrow">${region} · ${combat?'历练之地':'歇脚之地'}</span><h1>${place}</h1></div>`;
      if(combat){main.insertAdjacentHTML('beforeend','<div class="battle-heading">正在探索</div><button>撤退</button>');main.querySelector('button').onclick=()=>actions.push('retreat');return;}
      main.insertAdjacentHTML('beforeend',`<p class="location-safety">安全区 可调息</p><div class="place-actions"><button id="repeat">再探前庭</button><button id="heal">${healing?'停止调息':'调息'}</button></div><button id="map">山河图</button>`);
      main.querySelector('#heal').onclick=()=>{actions.push(healing?'stop-heal':'heal');healing=!healing;show();};
      main.querySelector('#repeat').onclick=()=>{actions.push('repeat');region=outer;place='前庭';combat=true;show();};
      main.querySelector('#map').onclick=()=>{
        main.innerHTML='<h1>山河图</h1><div class="map-viewport" data-map-level="regions"></div><button id="back">返回当地</button>';
        main.querySelector('#back').onclick=show;
        const area=main.querySelector('.map-viewport');
        for(const name of [inner,outer]){
          const button=document.createElement('button');button.setAttribute('aria-label','展开'+name);button.textContent=name;area.append(button);
          button.onclick=()=>{
            area.dataset.mapLevel='locations';area.innerHTML='<button aria-label="静室，安全区，可调息"><strong>静室</strong><small>安全 · 调息</small></button>';
            area.querySelector('button').onclick=()=>{actions.push('travel:'+name);region=name;place='静室';show();};
          };
        }
      };
    };
    show();
  },{inner,outer,startElsewhere});
  const ui=new BattleUI(page,config,{actionDelaySeconds:.001,responseTimeoutSeconds:.5},()=>{},new AbortController().signal);
  ui.ensureApp=async()=>page.mainFrame();
  ui.getCatalog=()=>({nodes:[{name:'前庭',regionName:outer,type:'battle',availability:'visible'}]});
  if(lostTravel){const travel=ui.travelToHealing.bind(ui);ui.travelToHealing=async target=>{await travel(target);throw new Error('response lost');};}
  return {page,ui,runner:new BattleRunner(ui,config,()=>{}),config};
}

test('already at the subregion healer starts once, waits, stops above 95%, and repeats into the other subregion',async()=>{
  for(const names of [{},{inner:'北境・深谷',outer:'北境・云台'}]){
    const h=await setup(names);
    try{
      await h.runner.step();await h.runner.step();
      assert.deepEqual(await h.page.evaluate(()=>actions),['heal']);
      await h.page.locator('#hp').evaluate(el=>el.textContent='95 / 100');await h.runner.step();
      assert.deepEqual(await h.page.evaluate(()=>actions),['heal']);
      await h.page.locator('#hp').evaluate(el=>el.textContent='96 / 100');
      await h.runner.step();await h.runner.step();await h.runner.step();
      assert.deepEqual(await h.page.evaluate(()=>actions),['heal','stop-heal','repeat']);
      assert.equal((await h.ui.observe()).region,h.config.target.regionName);
      assert.equal(h.runner.pendingEntry,null);
    }finally{await h.page.close();}
  }
});

test('same-name healer in a different subregion still navigates by the full region, including lost response reconciliation',async()=>{
  for(const lostTravel of [false,true]){
    const h=await setup({startElsewhere:true,lostTravel});
    try{
      if(lostTravel)await assert.rejects(h.runner.step(),/response lost/u);else await h.runner.step();
      await h.runner.step();await h.runner.step();
      assert.deepEqual(await h.page.evaluate(()=>actions),['travel:坠星灵舟·内舱','heal']);
      assert.equal(h.runner.pendingHealingTravel,null);
    }finally{await h.page.close();}
  }
});

test('a wrong subregion combat remains a mismatch and retreats instead of matching the shared region prefix',async()=>{
  const h=await setup();
  try{
    await h.page.evaluate(()=>{combat=true;place='前庭';show();});
    h.ui.retreatForTarget=async()=>{await h.page.evaluate(()=>actions.push('retreat'));};
    await h.runner.step();assert.deepEqual(await h.page.evaluate(()=>actions),['retreat']);
  }finally{await h.page.close();}
});

test('map opened during the navigation delay is reused without clicking a now-absent map entry',async()=>{
  const h=await setup({startElsewhere:true});
  try{
    const observe=h.ui.observe.bind(h.ui);let reads=0;
    h.ui.observe=async options=>{
      if(++reads===2)await h.page.locator('#map').click();
      return observe(options);
    };
    await h.ui.selectMapDestination(h.config.healingTarget.regionName,'静室',{healing:true});
    assert.deepEqual(await h.page.evaluate(()=>actions),['travel:坠星灵舟·内舱']);
  }finally{await h.page.close();}
});

test('a lost map-opening response checks the actual map before continuing and never repeats the click',async()=>{
  const h=await setup({startElsewhere:true});
  try{
    let mapClicks=0;const unique=h.ui.unique.bind(h.ui);
    h.ui.unique=async(locator,label)=>{
      const button=await unique(locator,label);
      if(label==='山河图'){
        const click=button.click.bind(button);button.click=async options=>{mapClicks++;await click(options);throw new Error('map response lost');};
      }
      return button;
    };
    await h.ui.travelToHealing(h.config.healingTarget);
    assert.equal(mapClicks,1);
    assert.deepEqual(await h.page.evaluate(()=>actions),['travel:坠星灵舟·内舱']);
  }finally{await h.page.close();}
});
