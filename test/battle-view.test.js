import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BattleUI, readGameSnapshot } from '../src/battle-ui.js';
import { BattleRunner } from '../src/battle.js';
import { ViewRecoveryError, runBattleIteration } from '../src/battle-view.js';
import { PauseError, RetryError } from '../src/errors.js';
import { runTask } from '../src/task-runner.js';

let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL ?? 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const config = { characterName: '测试修士', target: { regionName: '北境', stageName: '银阶' }, pollIntervalSeconds: 5, healActionIntervalSeconds: 2 };
const fixture = `<!doctype html><meta charset="utf-8">
<aside class="character-panel"><header><div role="group" aria-label="角色展示"><button aria-label="显示头像" aria-pressed="true">人像</button><button aria-label="显示属性与技能">属性</button></div></header><div id="profile" class="discord-profile"><img src="bad:" alt=""><h3>测试修士</h3></div><div class="meter red"><span>气血</span><span id="hp" title="70 / 100">70 / 100</span><progress value="70" max="100"></progress></div></aside>
<nav class="central-nav" aria-label="主导航"><button aria-current="page">游历</button><button>行囊</button><button>修行</button><button>世界</button></nav>
<main data-region="北境" data-location="银阶"></main><script>
window.actions=[]; window.avatarWorks=true; window.name='测试修士'; window.ticks=0;setInterval(()=>ticks++,10);
const main=document.querySelector('main');
function profile(show){document.querySelector('#profile').hidden=!show;document.querySelector('#profile h3').textContent=window.name;document.querySelector('[aria-label="显示头像"]')?.setAttribute('aria-pressed',String(show));}
document.querySelector('[aria-label="显示头像"]').onclick=()=>{actions.push('avatar');if(avatarWorks)profile(true)};
document.querySelector('[aria-label="显示属性与技能"]').onclick=()=>profile(false);
function view(tab='游历',map=false){document.querySelectorAll('nav button').forEach(b=>{b.removeAttribute('aria-current');if(b.textContent===tab)b.setAttribute('aria-current','page')});main.dataset.mode=map?'map':'';
main.innerHTML=map?'<h1>山河图</h1><div class="map-viewport"></div><button aria-label="返回当地">返回</button>':tab==='游历'?'<h1>银阶</h1><div class="battle-heading"><span>正在探索</span><button id="retreat">撤退</button></div>':'<h1>'+tab+'</h1>'+(tab==='行囊'?'<div class="inventory-view"></div>':'');
if(map)main.querySelector('button').onclick=()=>{actions.push('map-back');view()};if(tab==='游历'&&!map)document.querySelector('#retreat').onclick=()=>actions.push('FORBIDDEN:retreat');}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{actions.push('tab:'+b.textContent);view(b.textContent)});
function modal(title='灵髓积蕴',extra=false){const d=document.createElement('dialog');d.setAttribute('aria-label',title);d.innerHTML='<header><h2>'+title+'</h2><button aria-label="关闭窗口">X</button></header><div>增攻 +20</div>'+(extra?'<button>确认购买</button>':'');d.querySelector('button').onclick=()=>{actions.push('close:'+title);d.remove()};document.body.append(d);d.showModal();}
function hp(value){const e=document.querySelector('#hp');e.textContent=value+' / 100';e.title=e.textContent;document.querySelector('progress').value=value;}
view();</script>`;

async function setup() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://view.invalid/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.setContent('<iframe src="https://view.invalid/game" style="width:1100px;height:750px"></iframe>');
  const frame = await page.frameLocator('iframe').locator('aside').waitFor().then(() => page.frames().find(f => f.url().includes('view.invalid')));
  const logs = [], waits = [];
  const ui = new BattleUI(page, config, { actionDelaySeconds: 0.001, responseTimeoutSeconds: 10 }, s => logs.push(s), new AbortController().signal, { recoveryWait: async ms => waits.push(ms) });
  return { context, page, frame, ui, logs, waits, actions: () => frame.evaluate(() => actions) };
}

test('known modal, another tab and hidden profile recover in order without gameplay clicks', async () => {
  const h = await setup();
  try {
    await h.frame.evaluate(() => { profile(false);view('修行');modal(); });
    assert.equal((await h.ui.ensureMonitoringView()).ready,true);
    assert.deepEqual(await h.actions(), ['close:灵髓积蕴','tab:游历','avatar']);
    assert.ok(h.waits.length === 3 && h.waits.every(ms => ms >= 2000));
    assert.equal((await h.ui.observe()).character,'测试修士');
    await h.ui.ensureMonitoringView();
    assert.equal((await h.actions()).length,3);
  } finally { await h.context.close(); }
});

test('bag, cultivation, world and map return to current exploration through scoped controls', async () => {
  for (const tab of ['行囊','修行','世界','地图']) {
    const h = await setup();
    try {
      await h.frame.evaluate(tab => {view(tab==='地图'?'游历':tab,tab==='地图');document.body.insertAdjacentHTML('beforeend','<button>游历</button><button aria-label="返回当地">外部返回</button>');},tab);
      assert.equal((await h.ui.ensureMonitoringView()).ready,true);
      assert.deepEqual(await h.actions(),[tab==='地图'?'map-back':'tab:游历']);
    } finally { await h.context.close(); }
  }
});

test('unknown, augmented and stacked dialogs never get dismissed; manual closure resumes', async () => {
  for (const variant of ['unknown','extra','stacked']) {
    const h = await setup();
    try {
      await h.frame.evaluate(variant => { modal(variant==='unknown'?'物品详情':'灵髓积蕴',variant==='extra');if(variant==='stacked')modal('购买确认'); },variant);
      for(let i=0;i<3;i++) assert.equal((await h.ui.ensureMonitoringView()).ready,false);
      assert.equal((await h.ui.ensureMonitoringView()).delayMs,30000);
      assert.deepEqual(await h.actions(),[]);
      await h.frame.evaluate(()=>document.querySelectorAll('dialog').forEach(d=>d.remove()));
      assert.equal((await h.ui.ensureMonitoringView()).ready,true);
    } finally { await h.context.close(); }
  }
});

test('a real mismatch or sensitive dialog pauses before any restoring clicks', async () => {
  for (const variant of ['other','存档管理','创建角色','授权','验证码']) {
    const h=await setup();
    try {
      await h.frame.evaluate(variant=>{if(variant==='other'){window.name='其他人';profile(true);view('修行')}else modal(variant);},variant);
      await assert.rejects(h.ui.ensureMonitoringView(),PauseError);
      assert.deepEqual(await h.actions(),[]);
    } finally {await h.context.close();}
  }
});

test('missing, duplicated or disabled avatar button waits and retries only on layout changes', async () => {
  for(const variant of ['missing','duplicate','disabled']) {
    const h=await setup();
    try {
      await h.frame.evaluate(variant=>{profile(false);const b=document.querySelector('[aria-label="显示头像"]');if(variant==='missing')b.remove();else if(variant==='duplicate')b.after(b.cloneNode(true));else b.disabled=true;},variant);
      for(let i=0;i<3;i++)await h.ui.ensureMonitoringView();
      const logCount=h.logs.length;
      await h.frame.evaluate(()=>hp(51));
      assert.equal((await h.ui.ensureMonitoringView()).delayMs,30000);
      assert.equal(h.logs.length,logCount);
      assert.deepEqual(await h.actions(),[]);
      await h.frame.evaluate(()=>profile(true));
      assert.equal((await h.ui.ensureMonitoringView()).ready,true);
    } finally {await h.context.close();}
  }
});

test('a loading profile is not toggled and a broken avatar image does not prevent monitoring', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{profile(false);document.querySelector('[aria-label="显示头像"]').setAttribute('aria-pressed','true');});
    assert.equal((await h.ui.ensureMonitoringView()).ready,false);
    assert.deepEqual(await h.actions(),[]);
    await h.frame.evaluate(()=>profile(true));
    assert.equal((await h.ui.ensureMonitoringView()).ready,true);
    assert.deepEqual(await h.actions(),[]);
  } finally {await h.context.close();}
});

test('successful restore with lost acknowledgement rereads before another click', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>profile(false));
    h.ui.waitFor=async()=>{throw new RetryError('模拟响应超时');};
    assert.equal((await h.ui.ensureMonitoringView()).ready,true);
    await h.ui.ensureMonitoringView();
    assert.deepEqual(await h.actions(),['avatar']);
  } finally {await h.context.close();}
});

test('an unresponsive restore stops after three rounds then a newly enabled control resets the budget', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{profile(false);avatarWorks=false;});
    h.ui.waitFor=async()=>{throw new RetryError('无变化');};
    for(let i=0;i<3;i++)await h.ui.ensureMonitoringView();
    await h.ui.ensureMonitoringView();
    assert.deepEqual(await h.actions(),['avatar','avatar','avatar']);
    await h.frame.evaluate(()=>{document.querySelector('[aria-label="显示头像"]').disabled=true;});
    await h.ui.ensureMonitoringView();
    await h.frame.evaluate(()=>{document.querySelector('[aria-label="显示头像"]').disabled=false;avatarWorks=true;});
    assert.equal((await h.ui.ensureMonitoringView()).ready,true);
    assert.equal((await h.actions()).length,4);
  } finally {await h.context.close();}
});

test('read-only checks do not restore and mid-operation disappearance yields to next iteration', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>profile(false));
    const runner=new BattleRunner(h.ui,config,()=>{}, {readOnly:true});
    const consumables={runIfDue:async()=>assert.fail('must not consume')};
    await assert.rejects(runBattleIteration(h.ui,runner,consumables,{readOnly:true}),ViewRecoveryError);
    assert.deepEqual(await h.actions(),[]);
    await h.frame.evaluate(()=>profile(true));
    const calls=[];
    const pending={at:123};
    const interrupted={pendingEntry:pending,async step(){await h.frame.evaluate(()=>profile(false));await h.ui.observe();calls.push('battle-write');}};
    const result=await runBattleIteration(h.ui,interrupted,{runIfDue:async()=>calls.push('consumables')});
    assert.equal(result.delayMs,5000);assert.equal(interrupted.pendingEntry,pending);
    assert.deepEqual(calls,[]); // An unresolved entry also defers supplies until its outcome is known.
  } finally {await h.context.close();}
});

test('recovery gates consumables and battle while a sibling travel task continues', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>modal('未知弹窗'));
    const calls=[];
    const runner={step:async()=>calls.push('battle')};const consumables={runIfDue:async()=>calls.push('consume')};
    const abort=new AbortController();const travel={step:async()=>{calls.push('travel');return {done:true};}};
    await Promise.all([runBattleIteration(h.ui,runner,consumables),runTask(travel,{config:{},signal:abort.signal,log:()=>{}})]);
    assert.deepEqual(calls,['travel']);
    await h.frame.evaluate(()=>document.querySelector('dialog').remove());
    await runBattleIteration(h.ui,runner,consumables);
    assert.deepEqual(calls,['travel','consume','battle']);
  } finally {await h.context.close();}
});

test('observe itself never navigates away from script-owned map or closes a popup', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>view('游历',true));
    assert.equal((await h.ui.observe()).mode,'map');
    assert.deepEqual(await h.actions(),[]);
    await h.frame.evaluate(()=>modal());
    await assert.rejects(h.ui.observe(),ViewRecoveryError);
    assert.deepEqual(await h.actions(),[]);
  } finally {await h.context.close();}
});

test('entry succeeds then profile vanishes: recovery confirms combat without entering twice', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{
      hp(100);main.dataset.location='城镇';
      main.innerHTML='<h1>城镇</h1><button>调息</button><article><strong>银阶</strong><button>前往探索</button></article>';
      main.querySelector('article button').onclick=()=>{actions.push('enter');main.dataset.location='银阶';view();profile(false);modal();};
    });
    const runner=new BattleRunner(h.ui,config,()=>{});
    const consumables={runIfDue:async()=>{}};
    await runBattleIteration(h.ui,runner,consumables);
    assert.ok(runner.pendingEntry);
    await runBattleIteration(h.ui,runner,consumables);
    assert.equal(runner.pendingEntry,null);
    await runBattleIteration(h.ui,runner,consumables);
    assert.deepEqual(await h.actions(),['enter','close:灵髓积蕴','avatar']);
  } finally {await h.context.close();}
});

test('retreat succeeds then UI changes: restoring does not repeat retreat', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{
      main.dataset.location='旧关卡';
      document.querySelector('#retreat').onclick=()=>{actions.push('retreat');main.dataset.location='城镇';main.innerHTML='<h1>城镇</h1><button disabled>调息</button>';profile(false);modal();};
    });
    const runner=new BattleRunner(h.ui,config,()=>{});const consumables={runIfDue:async()=>{}};
    await runBattleIteration(h.ui,runner,consumables);
    assert.ok(runner.pendingRetreat);
    await runBattleIteration(h.ui,runner,consumables);
    assert.equal(runner.pendingRetreat,null);
    await runBattleIteration(h.ui,runner,consumables);
    assert.deepEqual(await h.actions(),['retreat','close:灵髓积蕴','avatar']);
  } finally {await h.context.close();}
});

test('hidden old content cannot identify combat, inventory or the current region', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{view('修行');main.insertAdjacentHTML('afterbegin','<div hidden><div class="page-heading"><span class="eyebrow">旧区域 · 历练之地</span></div><div class="battle-heading">正在探索</div><div class="inventory-view"></div></div>');main.removeAttribute('data-region');});
    const state=await h.frame.evaluate(readGameSnapshot,'测试修士');
    assert.equal(state.mode,'unknown');assert.equal(state.region,'');
    assert.equal((await h.ui.ensureMonitoringView()).ready,true);
  } finally {await h.context.close();}
});
