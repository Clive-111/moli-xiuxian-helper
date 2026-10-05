import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BattleUI } from '../src/battle-ui.js';
import { BattleRunner } from '../src/battle.js';

let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL ?? 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const config = { characterName: '测试修士', target: { regionName: '新原', stageName: '石原' }, pollIntervalSeconds: 5, healActionIntervalSeconds: 2 };
async function setup({ nearby = false, fresh = true } = {}) {
  const page = await browser.newPage();
  await page.setContent('<aside data-player-panel><b>测试修士</b><div><span>气血</span><span id="hp">99 / 100</span></div></aside><main data-game-main></main><aside class="log-scroll"><article class="log-entry combat"><time>10:00:00</time><p>战败，返回泉室歇息</p></article></aside>');
  await page.evaluate(({ nearby, fresh }) => {
    window.clicks = []; const main = document.querySelector('main');
    main.dataset.region = '新原'; main.dataset.location = nearby ? '泉室' : '石原';
    main.innerHTML = nearby ? '<h1>泉室</h1><button id="heal">调息</button><article><b>石原</b><button id="entry">前往探索</button></article>' : '<h1>石原</h1><button id="entry">开始探索</button>';
    document.querySelector('#entry').onclick = () => {
      clicks.push('enter'); document.querySelector('#hp').textContent = '5 / 100';
      main.dataset.region = '旧境'; main.dataset.location = '泉室';
      main.innerHTML = '<h1>泉室</h1><div class="place-actions"><button>再探石原</button><button id="heal">调息</button></div>';
      main.querySelector('#heal').onclick = () => { clicks.push('heal'); document.querySelector('#hp').textContent = '20 / 100'; };
      if (fresh) document.querySelector('.log-scroll').insertAdjacentHTML('beforeend', '<article class="log-entry combat"><time>10:00:30</time><p>战败，返回泉室歇息</p></article>');
    };
  }, { nearby, fresh });
  const ui = new BattleUI(page, config, { actionDelaySeconds: .001, responseTimeoutSeconds: .2 }, () => {}, new AbortController().signal);
  ui.ensureApp = async () => page.mainFrame();
  return { page, ui, runner: new BattleRunner(ui, config, () => {}) };
}
test('defeat within the entry click response resumes healing for both previews and nearby entries', async () => {
  for (const nearby of [false, true]) {
    const h = await setup({ nearby });
    try {
      await h.runner.step(); assert.equal(h.runner.pendingEntry, null);
      assert.equal((await h.ui.observe()).battleFeedback.repeatStage, '石原');
      await h.runner.step();
      assert.deepEqual(await h.page.evaluate(() => clicks), ['enter', 'heal']);
    } finally { await h.page.close(); }
  }
});
test('instant return to rest heals even without a new defeat log', async () => {
  const h = await setup({ fresh: false });
  try {
    await h.runner.step();
    assert.equal(h.runner.pendingEntry, null);
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['enter', 'heal']);
  } finally { await h.page.close(); }
});
test('a response lost after fresh defeat is reread without repeating exploration', async () => {
  const h = await setup();
  try {
    const wait = h.ui.waitForEntry.bind(h.ui);
    h.ui.waitForEntry = async (...args) => { await wait(...args); throw new Error('response lost'); };
    await assert.rejects(h.runner.step(), /response lost/u);
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['enter', 'heal']);
  } finally { await h.page.close(); }
});

test('combat confirmed once is sufficient even when the player dies before the next read', async () => {
  const h = await setup();
  try {
    await h.page.evaluate(() => {
      document.querySelector('#entry').onclick = () => {
        clicks.push('enter'); document.querySelector('main').innerHTML = '<h1>石原</h1><p>正在探索</p><button>撤退</button>';
      };
    });
    const observe = h.ui.observe.bind(h.ui); let witnessed = false;
    h.ui.observe = async (...args) => {
      const state = await observe(...args);
      if (!witnessed && state.mode === 'combat') {
        witnessed = true;
        await h.page.evaluate(() => {
          document.querySelector('#hp').textContent = '5 / 100';
          const main = document.querySelector('main'); main.dataset.location = '泉室';
          main.innerHTML = '<h1>泉室</h1><button id="heal">调息</button>';
          main.querySelector('#heal').onclick = () => { clicks.push('heal'); document.querySelector('#hp').textContent = '20 / 100'; };
        });
      }
      return state;
    };
    await h.runner.step(); assert.equal(h.runner.pendingEntry, null);
    await h.runner.step();
    assert.deepEqual(await h.page.evaluate(() => clicks), ['enter', 'heal']);
  } finally { await h.page.close(); }
});

test('a Discord startup redirect retries the configured channel instead of waiting in a read-only channel', async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://discord.com/channels/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>当前频道</h1>' }));
    await page.goto('https://discord.com/channels/1/999');
    const ui = new BattleUI(page, { ...config, channelUrl: 'https://discord.com/channels/1/2' }, { actionDelaySeconds: .001, responseTimeoutSeconds: 1 }, () => {}, new AbortController().signal);
    ui.needsNavigate = false;
    // Simulate an already loaded activity once the browser returns to its channel.
    ui.findFrame = async () => page.url().endsWith('/1/2') ? page.mainFrame() : null;
    assert.equal(await ui.ensureApp(), page.mainFrame());
    assert.equal(page.url(), 'https://discord.com/channels/1/2');
  } finally { await page.close(); }
});
