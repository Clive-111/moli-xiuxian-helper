import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BattleUI } from '../src/battle-ui.js';

let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL ?? 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const catalog = {
  regions: [{ id: 'old', name: '旧山' }, { id: 'new', name: '新原' }],
  nodes: [
    { id: 'a', name: '旧台', regionName: '旧山', type: 'battle' },
    { id: 'b', name: '新丘', regionName: '新原', type: 'battle' },
    { id: 'c', name: '新泉', regionName: '新原', type: 'healing' },
  ],
};
async function fixture({ remembered = false, currentClipped = false, combat = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent('<iframe style="margin:30px;width:760px;height:580px;border:0"></iframe>');
  const frame = page.frames()[1];
  await frame.setContent('<aside data-player-panel><b>测试修士</b><div><span>气血</span> <span>100 / 100</span></div></aside><main data-game-main data-region="新原"></main>');
  await frame.evaluate(({ remembered, currentClipped, combat }) => {
    const main = document.querySelector('main');
    window.actions = []; window.drags = 0; window.combat = combat;
    window.show = () => {
      main.dataset.location = '新丘'; main.dataset.region = '新原'; main.dataset.mode = '';
      main.innerHTML = '<h1>新丘</h1>' + (window.combat ? '<p>正在探索</p><button>撤退</button>' : '<button>开始探索</button>') + '<button id="map">山河图</button>';
      main.querySelector('#map').onclick = map;
    };
    window.map = () => {
      main.dataset.mode = 'map'; delete main.dataset.region; main.innerHTML = '<h1>山河图</h1><div class="map-viewport" style="position:relative;overflow:hidden;width:440px;height:300px"></div><button id="back">返回战斗</button><button id="overview">全图</button>';
      main.querySelector('#back').onclick = () => { actions.push('back'); show(); };
      const map = main.querySelector('.map-viewport');
      const regions = () => {
        map.dataset.mapLevel = 'regions'; map.innerHTML = '';
        for (const [name, left] of [['旧山', -650], ['新原', currentClipped ? 660 : 200]]) {
          const button = document.createElement('button'); button.setAttribute('aria-label', '展开' + name);
          button.style.cssText = `position:absolute;top:100px;left:${left}px`;
          button.textContent = name; button.onclick = () => { actions.push('region:' + name); locations(); }; map.append(button);
        }
      };
      const locations = () => {
        map.dataset.mapLevel = 'locations'; map.innerHTML = '<span class="map-region-label">旧山</span><span class="map-region-label">新原</span>';
        for (const [name, region, safe] of [['旧台', '旧山', false], ['新丘', '新原', false], ['新泉', '新原', true]]) {
          const button = document.createElement('button'); button.className = 'map-node'; button.dataset.region = region;
          button.setAttribute('aria-label', name + (safe ? '，安全区，可调息' : '，历练之地'));
          button.innerHTML = `<strong>${name}</strong>`;
          button.onclick = () => { actions.push('location:' + name); show(); main.dataset.location = name; main.querySelector('h1').textContent = name;
            if (safe) { main.querySelector('button').textContent = '调息'; }
          }; map.append(button);
        }
      };
      main.querySelector('#overview').onclick = () => { actions.push('overview'); regions(); };
      let drag;
      map.onpointerdown = e => { if (e.target === map) { drag = { x: e.clientX, positions: [...map.querySelectorAll('button')].map(b => [b, parseFloat(b.style.left)]) }; map.setPointerCapture(e.pointerId); window.drags++; } };
      map.onpointermove = e => { if (drag) for (const [b, x] of drag.positions) b.style.left = x + e.clientX - drag.x + 'px'; };
      map.onpointerup = () => { drag = null; };
      if (remembered) locations(); else regions();
    };
    show();
  }, { remembered, currentClipped, combat });
  const ui = new BattleUI(page, { characterName: '测试修士' }, { actionDelaySeconds: .001, responseTimeoutSeconds: 1 }, () => {}, new AbortController().signal);
  ui.ensureApp = async () => frame;
  return { page, frame, ui };
}

test('new-region catalog scan avoids the clipped first region and never enters locations', async () => {
  for (const currentClipped of [false, true]) {
    const h = await fixture({ currentClipped });
    try {
      const result = await h.ui.inspectCatalog(catalog);
      assert.ok(result.nodes.every(n => n.availability === 'visible'));
      assert.deepEqual(await h.frame.evaluate(() => actions), ['region:新原', 'back']);
      assert.equal((await h.ui.observe()).mode, 'combat');
      if (currentClipped) assert.ok(await h.frame.evaluate(() => drags) > 0);
    } finally { await h.page.close(); }
  }
});
test('remembered location layer is read directly, preserving combat and avoiding overview clicks', async () => {
  const h = await fixture({ remembered: true });
  try {
    assert.equal((await h.ui.inspectCatalog(catalog)).nodes.length, 3);
    assert.deepEqual(await h.frame.evaluate(() => actions), ['back']);
    await h.ui.returnToRest(); // Already returned by a person or game: no second click.
    assert.deepEqual(await h.frame.evaluate(() => actions), ['back']);
  } finally { await h.page.close(); }
});
test('cross-region healing navigation pans the region node before clicking, including iframe offsets', async () => {
  const h = await fixture({ currentClipped: true, combat: false });
  try {
    await h.ui.travelToHealing({ regionName: '新原', locationName: '新泉' });
    assert.deepEqual(await h.frame.evaluate(() => actions), ['region:新原', 'location:新泉']);
    assert.ok(await h.frame.evaluate(() => drags) > 0);
  } finally { await h.page.close(); }
});
test('failed map cleanup preserves the original scan failure instead of reporting a missing back button', async () => {
  const h = await fixture();
  try {
    h.ui.returnToRest = async () => { throw new Error('missing back button'); };
    await assert.rejects(h.ui.inspectCatalog({ ...catalog, regions: [] }), /地图区域定义无法核实/u);
    assert.deepEqual(await h.frame.evaluate(() => actions), []);
  } finally { await h.page.close(); }
});
