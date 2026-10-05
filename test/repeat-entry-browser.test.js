import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BattleUI } from '../src/battle-ui.js';
import { BattleRunner } from '../src/battle.js';

let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL ?? 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const config = { characterName: '测试修士', target: { regionName: '新原', stageName: '石原' }, pollIntervalSeconds: 5, healActionIntervalSeconds: 2 };
const node = { name: '石原', regionName: '新原', type: 'battle', availability: 'visible' };
async function setup({ crossRegion = false, label = '再探石原', disabled = false, duplicate = false, defeat = false } = {}) {
  const page = await browser.newPage();
  await page.setContent('<aside data-player-panel><b>测试修士</b><div><span>气血</span><span id="hp">99 / 100</span></div></aside><main data-game-main></main><footer><button>再探石原</button></footer>');
  await page.evaluate(options => {
    window.clicks = [];
    const main = document.querySelector('main');
    const showRest = () => {
      main.dataset.region = options.crossRegion ? '旧境' : '新原'; main.dataset.location = '泉室';
      main.innerHTML = '<h1>泉室</h1><div class="location-safety">安全区 可调息</div><div class="place-actions"><button id="repeat"></button><button id="heal">调息</button></div><article><b>石原</b><button id="nearby">前往探索</button></article>';
      const repeat = main.querySelector('#repeat'); repeat.textContent = options.label; repeat.disabled = options.disabled;
      if (options.duplicate) repeat.after(repeat.cloneNode(true));
      const enter = kind => {
        clicks.push(kind);
        if (options.defeat) { showRest(); document.querySelector('#hp').textContent = '1 / 100'; }
        else { main.dataset.region = '新原'; main.dataset.location = '石原'; main.innerHTML = '<h1>石原</h1><p>正在探索</p><button>撤退</button>'; }
      };
      repeat.onclick = () => enter('repeat');
      main.querySelector('#nearby').onclick = () => enter('nearby');
      main.querySelector('#heal').onclick = () => { clicks.push('heal'); document.querySelector('#hp').textContent = '20 / 100'; };
    };
    showRest(); document.querySelector('footer button').onclick = () => clicks.push('wrong-scope');
  }, { crossRegion, label, disabled, duplicate, defeat });
  const ui = new BattleUI(page, config, { actionDelaySeconds: .001, responseTimeoutSeconds: .2 }, () => {}, new AbortController().signal);
  ui.ensureApp = async () => page.mainFrame();
  ui.getCatalog = () => ({ nodes: [node] });
  ui.selectMapDestination = async () => { throw new Error('unexpected map navigation'); };
  return { page, ui, runner: new BattleRunner(ui, config, () => {}) };
}

test('matching repeat enters directly from another region, ignoring other-page buttons', async () => {
  const h = await setup({ crossRegion: true, label: '再探 石原' });
  try {
    await h.runner.step();
    assert.equal(h.runner.pendingEntry, null);
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['repeat']);
  } finally { await h.page.close(); }
});

test('repeat instant death without logs goes straight to healing instead of waiting for combat', async () => {
  const h = await setup({ crossRegion: true, defeat: true });
  try {
    await h.runner.step(); assert.equal(h.runner.pendingEntry, null);
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['repeat', 'heal']);
  } finally { await h.page.close(); }
});

test('lost repeat response is reconciled at rest without another entry or map click', async () => {
  const h = await setup({ defeat: true });
  try {
    const wait = h.ui.waitForEntry.bind(h.ui);
    h.ui.waitForEntry = async (...args) => { await wait(...args); throw new Error('response lost'); };
    await assert.rejects(h.runner.step(), /response lost/u);
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['repeat', 'heal']);
  } finally { await h.page.close(); }
});

test('nonmatching, unavailable, absent or ambiguous catalog repeat falls back to named nearby entry', async () => {
  for (const variant of ['wrong-label', 'disabled', 'missing', 'unknown', 'duplicate-region', 'wrong-region', 'challenge', 'locked']) {
    const h = await setup({ label: variant === 'wrong-label' ? '再探别处' : '再探石原', disabled: variant === 'disabled' });
    try {
      if (variant === 'missing') await h.page.locator('#repeat').evaluate(el => el.remove());
      if (variant === 'unknown') h.ui.getCatalog = () => null;
      if (variant === 'duplicate-region') h.ui.getCatalog = () => ({ nodes: [node, { ...node, regionName: '另一原' }] });
      if (variant === 'wrong-region') h.ui.getCatalog = () => ({ nodes: [{ ...node, regionName: '另一原' }] });
      if (variant === 'challenge') h.ui.getCatalog = () => ({ nodes: [{ ...node, type: 'challenge' }] });
      if (variant === 'locked') h.ui.getCatalog = () => ({ nodes: [{ ...node, availability: 'locked' }] });
      await h.runner.step();
      assert.deepEqual(await h.page.evaluate(() => clicks), ['nearby'], variant);
    } finally { await h.page.close(); }
  }
});

test('duplicate visible repeat buttons do not guess which one to click', async () => {
  const h = await setup({ duplicate: true });
  try {
    await assert.rejects(h.runner.step(), /再探按钮重名/u);
    assert.deepEqual(await h.page.evaluate(() => clicks), []);
    assert.equal(h.runner.pendingEntry, null);
  } finally { await h.page.close(); }
});

test('repeat rechecks new HP maximum, healing, character and stop request before clicking', async () => {
  for (const variant of ['maximum', 'healing', 'character', 'stop']) {
    const h = await setup();
    try {
      const read = h.ui.requireEntryHealth.bind(h.ui); let reads = 0;
      h.ui.requireEntryHealth = async () => {
        if (++reads === 2) {
          if (variant === 'maximum') await h.page.locator('#hp').evaluate(el => el.textContent = '99 / 200');
          if (variant === 'healing') await h.page.locator('#heal').evaluate(el => el.textContent = '停止调息');
          if (variant === 'character') await h.page.locator('aside b').evaluate(el => el.textContent = '别人');
        }
        return read();
      };
      if (variant === 'stop') h.ui.beforeAction = () => { throw new Error('已收到停止请求'); };
      await assert.rejects(h.runner.step());
      assert.deepEqual(await h.page.evaluate(() => clicks), [], variant);
      assert.equal(h.runner.pendingEntry, null);
    } finally { await h.page.close(); }
  }
});

test('repeat target disappearing during click delay uses the current target route', async () => {
  const h = await setup();
  try {
    const read = h.ui.requireEntryHealth.bind(h.ui); let reads = 0;
    h.ui.requireEntryHealth = async () => {
      if (++reads === 2) await h.page.locator('#repeat').evaluate(el => el.textContent = '再探旧目标');
      return read();
    };
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['nearby']);
  } finally { await h.page.close(); }
});

test('battle heal, stop and repeat use their own quick delay, keeping travel defaults untouched', async () => {
  const h = await setup();
  try {
    const travelRuntime = { actionDelaySeconds: 2, responseTimeoutSeconds: 1 };
    h.ui.runtime = travelRuntime;
    h.ui.config = { ...config, actionDelaySeconds: .01 };
    h.runner.config = h.ui.config;
    await h.page.evaluate(() => {
      document.querySelector('#hp').textContent = '1 / 100';
      document.querySelector('#heal').onclick = function () {
        if (this.textContent === '调息') {
          clicks.push('heal'); this.textContent = '停止调息'; document.querySelector('#hp').textContent = '96 / 100';
        } else { clicks.push('stop-heal'); this.textContent = '调息'; }
      };
    });
    const start = performance.now();
    await h.runner.step();
    assert.equal((await h.runner.step()).delayMs, 0);
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['heal', 'stop-heal', 'repeat']);
    assert.equal(travelRuntime.actionDelaySeconds, 2);
    assert.ok(performance.now() - start < 4500, 'must not add the old 2-second waits to each battle action');
  } finally { await h.page.close(); }
});

test('healing rechecks cooldown, continuous activity and HP after its click delay', async () => {
  const h = await setup();
  try {
    await h.page.locator('#hp').evaluate(el => el.textContent = '1 / 100');
    const previous = await h.ui.observe();
    for (const label of ['停止调息', '调息']) {
      await h.page.locator('#heal').evaluate((el, label) => el.textContent = label, label);
      await h.page.locator('#hp').evaluate((el, label) => el.textContent = label === '调息' ? '96 / 100' : '1 / 100', label);
      await h.ui.heal(previous);
    }
    assert.deepEqual(await h.page.evaluate(() => clicks), []);
  } finally { await h.page.close(); }
});
