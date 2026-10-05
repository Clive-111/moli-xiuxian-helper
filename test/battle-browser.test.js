import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BattleUI, readGameSnapshot } from '../src/battle-ui.js';
import { healthStatus } from '../src/battle.js';
import { BattleRunner } from '../src/battle.js';

let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL ?? 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const config = { channelUrl: 'https://discord.com/channels/1/2', appName: '测试 App', characterName: '测试修士', target: { regionName: '北境', stageName: '银阶' }, pollIntervalSeconds: 5, healActionIntervalSeconds: 2, consumables: { enabled: true, itemNames: ['莹灵髓', '玉灵髓'] } };
// Chromium can take several seconds to stabilize an inactive tab under Docker.
const runtime = { actionDelaySeconds: 0.001, responseTimeoutSeconds: 10 };
const fixture = `<!doctype html><meta charset="utf-8"><aside data-player-panel><b>测试修士</b><div><span>气血</span><span id="hp">100 / 100</span><div role="progressbar" aria-valuenow="100" aria-valuemax="100"></div></div></aside><main data-game-main data-region="南境" data-location="城镇"></main><script>
window.actions=[];window.ticks=0;setInterval(()=>ticks++,10);
const main=document.querySelector('main');let mode='rest',region='南境';
function hp(value,max=100){document.querySelector('#hp').textContent=value+' / '+max;document.querySelector('[role=progressbar]').setAttribute('aria-valuenow',value);document.querySelector('[role=progressbar]').setAttribute('aria-valuemax',max)}
function fight(stage){actions.push(region+'/'+stage);mode='combat';main.dataset.mode=mode;main.dataset.location=stage;main.innerHTML='<h1>'+stage+'</h1><p>正在探索</p><button>撤退</button><p id="waves">第1组</p>';}
function rest(){mode='rest';main.dataset.mode=mode;main.dataset.region=region;main.dataset.location='城镇';main.innerHTML='<h1>城镇</h1><button id="heal">调息</button><button id="map">山河图</button>'+['银阶','石阶'].map(s=>'<article><b>'+s+'</b><p>可重复探索</p><button class="enter">前往探索</button></article>').join('');document.querySelector('#heal').onclick=()=>{actions.push('heal');hp(100)};document.querySelector('#map').onclick=()=>map();document.querySelectorAll('.enter').forEach(b=>b.onclick=()=>fight(b.parentElement.querySelector('b').textContent));}
function map(selected){main.dataset.mode='map';main.dataset.location='山河图';main.innerHTML='<h1>山河图</h1><div data-map></div><button id="back">返回</button>';document.querySelector('#back').onclick=rest;const area=document.querySelector('[data-map]');if(!selected){for(const r of ['南境','北境']){const b=document.createElement('button');b.textContent=r;b.onclick=()=>{region=r;main.dataset.region=r;map(true)};area.append(b)}}else{for(const s of ['银阶','石阶']){const b=document.createElement('button');b.innerHTML='<span>'+s+'</span>';b.onclick=()=>fight(s);area.append(b)}}}
rest();</script>`;
async function setup(target = config.target) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.setContent('<iframe title="游戏" src="https://fixture.invalid/game" style="width:100%;height:800px"></iframe>');
  await page.frameLocator('iframe').locator('#heal').waitFor();
  const frame = page.frames().find(frame => frame.url().includes('fixture.invalid'));
  const ui = new BattleUI(page, { ...config, target }, runtime, () => {}, new AbortController().signal);
  return { context, page, frame, ui };
}
test('same-region entry scopes its button; cross-region entry resolves duplicate stage names by region', async () => {
  for (const target of [{ regionName: '南境', stageName: '石阶' }, { regionName: '北境', stageName: '银阶' }]) {
    const h = await setup(target);
    try { await h.ui.observe(); await h.ui.enterTarget(target); assert.deepEqual(await h.frame.evaluate(() => actions), [target.regionName+'/'+target.stageName]); }
    finally { await h.context.close(); }
  }
});

test('entry accepts 96 percent in both nearby and map paths, but blocks 95 and a newly increased maximum',async()=>{
  for(const regionName of ['南境','北境']){
    const target={regionName,stageName:'银阶'},h=await setup(target);
    try{
      await h.frame.evaluate(()=>hp(95));await assert.rejects(h.ui.enterTarget(target),/未超过 95%/u);
      await h.frame.evaluate(()=>hp(96,200));await assert.rejects(h.ui.enterTarget(target),/未超过 95%/u);
      await h.frame.evaluate(()=>hp(96));await h.ui.enterTarget(target);
      assert.deepEqual(await h.frame.evaluate(()=>actions),[regionName+'/银阶']);
    }finally{await h.context.close();}
  }
});

test('over-95 continuous healing ends through its own activity button and resumes entry even after a lost click response',async()=>{
  const h=await setup({regionName:'南境',stageName:'银阶'});
  try{
    await h.frame.evaluate(()=>{
      hp(96);document.querySelector('#heal').textContent='调息中';document.querySelector('#heal').disabled=true;
      const activity=document.createElement('section');activity.className='activity-view';activity.innerHTML='<div class="ongoing-activity"><h3>调息中</h3><button>结束活动</button></div>';
      activity.querySelector('button').onclick=()=>{actions.push('stop-heal');activity.remove();document.querySelector('#heal').textContent='调息';document.querySelector('#heal').disabled=false;};main.append(activity);
    });
    const unique=h.ui.unique.bind(h.ui);h.ui.unique=async(locator,label)=>{const el=await unique(locator,label);if(label==='停止调息'){const click=el.click.bind(el);el.click=async options=>{await click(options);throw new Error('response lost');};}return el;};
    const runner=new BattleRunner(h.ui,h.ui.config,()=>{});
    await runner.step();assert.deepEqual(await h.frame.evaluate(()=>actions),['stop-heal']);
    await runner.step();assert.deepEqual(await h.frame.evaluate(()=>actions),['stop-heal','南境/银阶']);
  }finally{await h.context.close();}
});
test('real DOM HP and two-page task activity survive sibling inputs and repeated clears', async () => {
  const h = await setup();
  try {
    const sibling = await h.context.newPage(); await sibling.setContent('<input>');
    await h.frame.evaluate(() => { hp(50); });
    const runner = new BattleRunner(h.ui, config, () => {});
    await runner.step(); await runner.step(); await runner.step(); await runner.step();
    assert.equal((await h.ui.observe()).mode, 'combat');
    const before = await h.frame.evaluate(() => ticks);
    await sibling.locator('input').pressSequentially('/修仙', { delay: 50 });
    assert.ok(await h.frame.evaluate(() => ticks) > before);
    await h.frame.evaluate(() => { document.querySelector('#waves').textContent='第1组'; });
    await runner.step(); assert.deepEqual(await h.frame.evaluate(() => actions), ['heal','北境/银阶']);
  } finally { await h.context.close(); }
});
test('locked, missing and duplicate targets pause instead of entering an alternative', async () => {
  for (const variant of ['locked','missing','duplicate']) {
    const h = await setup({ regionName: '南境', stageName: '银阶' });
    try {
      await h.frame.evaluate(variant => { const row=document.querySelector('article'); if(variant==='locked')row.querySelector('button').disabled=true; if(variant==='missing')row.remove(); if(variant==='duplicate')row.after(row.cloneNode(true)); }, variant);
      const target = { regionName: '南境', stageName: variant === 'missing' ? '不存在的关卡' : '银阶' };
      await h.ui.observe(); await assert.rejects(h.ui.enterTarget(target));
      assert.deepEqual(await h.frame.evaluate(() => actions), []);
    } finally { await h.context.close(); }
  }
});

test('live-style sidebar selects player HP title and raw progress, even with hidden combat labels', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(`<style>.eyebrow{display:none}</style><aside class="character-panel"><div class="meter red"><div><span>气血</span><span title="55,599.999 / 55,600.00">5.56万 / 5.56万</span></div><progress aria-label="气血" value="99.999998" max="100"></progress></div><div class="discord-profile"><h3>测试修士</h3></div></aside><main><div class="page-heading"><span class="eyebrow">新区域 · 历练之地</span><h1>另一关</h1></div><div class="battle-heading"><span class="eyebrow">正在探索</span><button>撤退</button></div><div>敌人 气血 100 / 100</div></main>`);
    const state = await page.evaluate(readGameSnapshot, '测试修士');
    assert.equal(state.mode, 'combat'); assert.equal(state.region, '新区域');
    assert.equal(state.health.current, '55,599.999'); assert.equal(healthStatus(state.health).full, false);
    await page.locator('.discord-profile h3').evaluate(el => el.textContent = '测试修士的小号');
    assert.equal((await page.evaluate(readGameSnapshot, '测试修士')).character, '测试修士的小号');
    await page.locator('main').evaluate(el => { el.innerHTML='<h1>城镇</h1><button aria-pressed="true">调息</button><section aria-label="当前活动">正在调息</section>'; });
    assert.equal((await page.evaluate(readGameSnapshot, '测试修士')).heal.running, true);
  } finally { await context.close(); }
});

test('nearby exploration may open a preview rather than start immediately', async () => {
  const target = { regionName: '南境', stageName: '银阶' };
  const h = await setup(target);
  try {
    await h.frame.evaluate(() => {
      document.querySelector('.enter').onclick = () => {
        main.dataset.location='银阶';main.dataset.mode='';
        main.innerHTML='<h1>银阶</h1><button>山河图</button><button id="start">开始探索</button>';
        document.querySelector('#start').onclick=()=>fight('银阶');
      };
    });
    await h.ui.observe(); await h.ui.enterTarget(target);
    assert.deepEqual(await h.frame.evaluate(()=>actions),['南境/银阶']);
  } finally { await h.context.close(); }
});

test('live-style map previews a location and confirms its region before starting', async () => {
  for (const variant of ['valid', 'wrong-region', 'duplicate']) {
    const h = await setup();
    try {
      await h.frame.evaluate(variant => {
        window.previewVariant = variant;
        window.map = function() {
          main.dataset.mode='map'; main.dataset.location='山河图';
          main.innerHTML='<h1>山河图</h1><div class="map-viewport" data-map-level="regions"><button aria-label="展开北境">北境</button></div>';
          document.querySelector('.map-viewport button').onclick=()=>{
            const map=document.querySelector('.map-viewport');map.dataset.mapLevel='locations';
            map.innerHTML='<button aria-label="银阶"><strong>银阶</strong></button>'+(previewVariant==='duplicate'?'<button aria-label="银阶">银阶</button>':'');
            map.querySelector('button').onclick=()=>{
              region=previewVariant==='wrong-region'?'南境':'北境';main.dataset.region=region;main.dataset.mode='';main.dataset.location='银阶';
              main.innerHTML='<h1>银阶</h1><button>山河图</button><button id="start">开始探索</button>';
              document.querySelector('#start').onclick=()=>fight('银阶');
            };
          };
        };
      }, variant);
      await h.ui.observe();
      if(variant==='valid') { await h.ui.enterTarget(config.target); assert.deepEqual(await h.frame.evaluate(()=>actions), ['北境/银阶']); }
      else { await assert.rejects(h.ui.enterTarget(config.target)); assert.deepEqual(await h.frame.evaluate(()=>actions), []); }
    } finally { await h.context.close(); }
  }
});

test('App launcher selects the named heading and Join, never a duplicate hidden name or Leave', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType:'text/html', body:fixture }));
    await page.setContent(`<button aria-label="APP">APP</button><script>
      document.querySelector('button').onclick=()=>{const d=document.createElement('div');d.role='dialog';d.innerHTML='<span style="position:absolute;clip:rect(0,0,0,0)">测试 App</span><h3>测试 App</h3>';document.body.append(d);d.querySelector('h3').onclick=()=>{d.innerHTML='<h3>测试 App</h3><button aria-label="加入 测试 App">加入</button><button>在私信中启动</button>';d.querySelector('button').onclick=()=>{d.remove();const f=document.createElement('iframe');f.src='https://fixture.invalid/game';f.style='width:100%;height:800px';document.body.append(f)}}};
    </script>`);
    const ui=new BattleUI(page,config,runtime,()=>{},new AbortController().signal);ui.needsNavigate=false;
    assert.equal((await ui.observe()).character,'测试修士');
    assert.equal(page.frames().length,2);
  } finally { await context.close(); }
});

test('an already open App menu or profile is reused without toggling the launcher or joining another App', async () => {
  for (const profile of [false, true]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
      await page.setContent('<button aria-label="APP">APP</button><div role="dialog"><h3>别的 App</h3><button>加入</button></div><div role="dialog" id="app"><h3>测试 App</h3></div>');
      await page.evaluate(profile => {
        window.actions = [];
        document.querySelector('button').onclick = () => actions.push('launcher');
        document.querySelector('[role=dialog] button').onclick = () => actions.push('wrong-app');
        const app = document.querySelector('#app');
        const showProfile = () => {
          app.innerHTML = '<h3>测试 App</h3><button>加入</button><button>离开</button>';
          app.querySelector('button').onclick = () => { actions.push('join'); app.remove(); const f = document.createElement('iframe'); f.src = 'https://fixture.invalid/game'; document.body.append(f); };
        };
        app.querySelector('h3').onclick = showProfile;
        if (profile) showProfile();
      }, profile);
      const ui = new BattleUI(page, config, runtime, () => {}, new AbortController().signal); ui.needsNavigate = false;
      assert.equal((await ui.observe()).character, '测试修士');
      assert.deepEqual(await page.evaluate(() => actions), ['join']);
    } finally { await context.close(); }
  }
});

test('a known game iframe loading briefly is awaited without reopening the Discord launcher', async () => {
  const h = await setup();
  try {
    await h.ui.observe();
    await h.page.evaluate(() => { const b = document.createElement('button'); b.textContent = 'APP'; b.onclick = () => { window.launcherClicked = true; }; document.body.append(b); });
    await h.frame.evaluate(() => {
      const contents = [...document.body.childNodes]; document.body.replaceChildren(document.createTextNode('加载中'));
      setTimeout(() => document.body.replaceChildren(...contents), 150);
    });
    assert.equal((await h.ui.observe()).character, '测试修士');
    assert.equal(await h.page.evaluate(() => Boolean(window.launcherClicked)), false);
  } finally { await h.context.close(); }
});

test('consume all is scoped to the two named player items despite nearby All buttons', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{
      const panel=document.querySelector('aside');
      for(const [name,count] of [['凝灵髓',8],['玄灵髓',13],['莹灵髓',11],['玉灵髓',3]]) {
        const row=document.createElement('article');row.className='quick-item';
        row.innerHTML='<div class="quick-item-info"><strong>'+name+'</strong><small title="持有 '+count+' 个">×'+count+'</small></div><button aria-label="使用全部'+name+'">全部</button>';
        row.querySelector('button').onclick=()=>{actions.push('consume:'+name+':'+count);row.remove();};panel.append(row);
      }
    });
    assert.deepEqual(await h.ui.consumeAllApproved('莹灵髓'),{before:11,after:0});
    assert.deepEqual(await h.ui.consumeAllApproved('玉灵髓'),{before:3,after:0});
    assert.ok((await h.ui.consumeAllApproved('玉灵髓')).skipped);
    await assert.rejects(h.ui.consumeAllApproved('玄灵髓'),/未获授权/u);
    assert.deepEqual(await h.frame.evaluate(()=>actions),['consume:莹灵髓:11','consume:玉灵髓:3']);
    assert.equal(await h.frame.locator('.quick-item').count(),2);
  } finally {await h.context.close();}
});

test('a disabled use button skips the item and an ambiguous row never consumes', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{
      document.querySelector('aside').insertAdjacentHTML('beforeend','<article class="quick-item"><div class="quick-item-info"><strong>莹灵髓</strong><small title="持有 2 个">×2</small></div><button aria-label="使用全部莹灵髓" disabled>全部</button></article>');
    });
    assert.ok((await h.ui.consumeAllApproved('莹灵髓')).skipped);
    await h.frame.evaluate(()=>{const row=document.querySelector('.quick-item');row.after(row.cloneNode(true));});
    await assert.rejects(h.ui.consumeAllApproved('莹灵髓'),/唯一/u);
  } finally {await h.context.close();}
});

test('a target change retreats once then heals and switches regions through the real UI adapter', async () => {
  const h=await setup();
  try {
    await h.frame.evaluate(()=>{
      hp(50);fight('石阶');
      document.querySelector('main button').onclick=()=>{actions.push('retreat');rest();};
    });
    const runner=new BattleRunner(h.ui,config,()=>{});
    await runner.step(); assert.equal((await h.ui.observe()).mode,'rest');
    await runner.step(); await runner.step(); await runner.step(); await runner.step();
    assert.deepEqual(await h.frame.evaluate(()=>actions),['南境/石阶','retreat','heal','北境/银阶']);
    assert.equal((await h.ui.observe()).mode,'combat');
    await h.ui.retreatForTarget(config.target);
    assert.deepEqual(await h.frame.evaluate(()=>actions),['南境/石阶','retreat','heal','北境/银阶']);
  } finally {await h.context.close();}
});
