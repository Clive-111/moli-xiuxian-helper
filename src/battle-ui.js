import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { PauseError, RetryError } from './errors.js';
import { entryOutcome, healthStatus } from './battle.js';
import { sleep } from './runtime.js';
import { validateConsumables } from './consumables.js';
import { ViewRecoveryError, checkBattleIdentity, requireBattleView } from './battle-view.js';

const DIALOGS = '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';
const PLAYER = '[data-player-panel],aside.character-panel';
const MAP_BACK = /^(返回|返回当地|返回战斗|返回当前位置|关闭地图|返回游历)$/u;

// All game-specific DOM knowledge stays here, independent of region/stage names.
export function readGameSnapshot(expectedCharacter) {
  const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = el => (el?.innerText ?? el?.textContent ?? '').trim();
  const elements = [...document.querySelectorAll('body *')].filter(visible);
  const buttons = elements.filter(el => el.matches('button,[role="button"]'));
  const healButton = buttons.find(el => /^(调息|停止调息|结束调息|调息中(?:[.。…]*)|调息\s*\(.*\))$/u.test(text(el)));
  const activity = document.querySelector('main [aria-label="当前活动"]');
  const running = healButton?.getAttribute('aria-pressed') === 'true'
    || buttons.some(el => /^(停止调息|结束调息|调息中(?:[.。…]*))$/u.test(text(el)))
    || Boolean(activity && visible(activity) && /正在调息|调息中/u.test(text(activity)));
  const combat = (elements.some(el => text(el) === '正在探索') || [...document.querySelectorAll('main .battle-heading')].some(visible)) && buttons.some(el => text(el) === '撤退');
  let player = document.querySelector('[data-player-panel],aside.character-panel');
  if (!player) {
    const nameElements = elements.filter(el => text(el) === expectedCharacter && ![...el.children].some(child => text(child) === expectedCharacter));
    for (const name of nameElements) {
      let parent = name.parentElement;
      for (let i = 0; parent && i < 9; i++, parent = parent.parentElement) {
        if (text(parent).length > 3000) break;
        if (/气血/u.test(text(parent)) && /\//u.test(text(parent))) { player = parent; break; }
      }
      if (player) break;
    }
  }
  let hpRow;
  if (player) {
    for (const label of [...player.querySelectorAll('*')].filter(el => visible(el) && text(el) === '气血')) {
      let parent = label.parentElement;
      for (let i = 0; parent && player.contains(parent) && i < 5; i++, parent = parent.parentElement) {
        if (/\//u.test(text(parent)) && !/修为/u.test(text(parent))) { hpRow = parent.closest('.meter') ?? parent; break; }
      }
      if (hpRow) break;
    }
  }
  let health = null;
  if (hpRow) {
    const pair = /([\d,.，]+\s*[万亿kKmM]?)\s*\/\s*([\d,.，]+\s*[万亿kKmM]?)/u;
    let hp = pair.exec(text(hpRow));
    const exactHint = [...hpRow.querySelectorAll('[title],[aria-label]')].map(el => el.getAttribute('title') || el.getAttribute('aria-label')).find(value => pair.test(value) && !/[万亿kKmM]/u.test(value));
    if (exactHint) hp = pair.exec(exactHint);
    let percent = null;
    const progress = hpRow.querySelector('[role="progressbar"],progress');
    if (progress) {
      const max = Number(progress.getAttribute('aria-valuemax') ?? progress.getAttribute('max'));
      const now = Number(progress.getAttribute('aria-valuenow') ?? progress.getAttribute('value'));
      if (max > 0 && Number.isFinite(now)) percent = now / max * 100;
    }
    if (hp) health = { current: hp[1].trim(), maximum: hp[2].trim(), percent, explicitFull: /^(已满血|气血已满)$/u.test(hpRow.getAttribute('aria-label') ?? '') };
  }
  const root = document.querySelector('[data-game-main]') ?? document.querySelector('main') ?? document.body;
  const heading = [...root.querySelectorAll('h1,h2')].find(visible);
  const location = root.getAttribute('data-location') || text(heading);
  const pageHeading = [...root.querySelectorAll('.page-heading')].find(visible);
  const regionLabel = pageHeading?.querySelector('.eyebrow')?.textContent?.trim() ?? elements.filter(el => el.children.length === 0).map(text).find(value => /^[^\n]{1,40}[·・]\s*(休整|歇脚|历练)之地$/u.test(value));
  // Region names can contain separators themselves (for example subregions).
  // Remove only the game's trailing place type, never truncate the region.
  const region = root.getAttribute('data-region') || regionLabel?.replace(/\s*[·・]\s*(?:休整|歇脚|历练)之地$/u, '').trim() || '';
  const onMap = root.getAttribute('data-mode') === 'map' || [...root.querySelectorAll('.map-viewport,[data-map]')].some(visible) || (!healButton && !combat && location === '山河图');
  const profileName = player?.querySelector('.discord-profile h3');
  const character = profileName && visible(profileName) ? text(profileName) : player && [...player.querySelectorAll('*')].some(el => visible(el) && text(el) === expectedCharacter) ? expectedCharacter : '';
  const ready = buttons.some(el => text(el) === '开始探索');
  const safeRest = [...root.querySelectorAll('.location-safety')].some(el => visible(el) && /安全区/u.test(text(el)) && /普通歇息|可调息/u.test(text(el)));
  const inventory = [...root.querySelectorAll('.inventory-view')].some(visible);
  const dialogElements = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]')].filter(visible);
  const conflictPattern = /云端已有另一份保存版本|未能核对存档|存档冲突/u;
  const conflictNotice = elements.find(el => !el.closest('.log-entry,.chat-history') && conflictPattern.test(text(el)) && ![...el.children].some(child => visible(child) && conflictPattern.test(text(child))));
  const blocked = dialogElements.map(text).find(value => /存档|创建角色|重新开始|授权|验证/u.test(value)) || (conflictNotice && text(conflictNotice));
  const dialogs = dialogElements.map(el => ({
    title: text(el.querySelector('h1,h2,h3,[role="heading"]')) || el.getAttribute('aria-label') || '未知弹窗',
    controls: [...el.querySelectorAll('button,[role="button"],input,select,textarea')].filter(visible).map(b => ({ name: b.getAttribute('aria-label') || text(b), enabled: !b.disabled && b.getAttribute('aria-disabled') !== 'true' })),
  }));
  const nav = document.querySelector('nav.central-nav,nav[aria-label="主导航"]');
  const activeTab = text(nav?.querySelector('[aria-current="page"],.selected'));
  const mode = blocked ? 'unknown' : onMap ? 'map' : activeTab && activeTab !== '游历' ? inventory ? 'inventory' : 'unknown' : inventory ? 'inventory' : combat ? 'combat' : healButton || safeRest ? 'rest' : ready ? 'ready' : 'unknown';
  // Ignore HP, enemy waves and chat: these change continuously even when the
  // obstructing layout has not changed, and must not reset the retry budget.
  const controls = buttons.filter(el => (player?.contains(el) && el.getAttribute('aria-label') === '显示头像') || (nav?.contains(el) && text(el) === '游历') || (root.contains(el) && /^(返回|返回当地|返回当前位置|关闭地图|返回游历)$/u.test(el.getAttribute('aria-label') || text(el))))
    .map(el => ({ name: el.getAttribute('aria-label') || text(el), enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true', pressed: el.getAttribute('aria-pressed') }));
  const view = { dialogs, activeTab, key: JSON.stringify({ character, mode, activeTab, dialogs, controls, healthVisible: Boolean(health) }) };
  const inventoryStocks = [...(player?.querySelectorAll('.quick-item') ?? [])].map(el => ({
    name: text(el.querySelector('.quick-item-info strong')), count: Number(/持有\s*(\d+)\s*个/u.exec(el.querySelector('.quick-item-info small')?.getAttribute('title') ?? '')?.[1] ?? NaN),
  })).filter(item => item.name.endsWith('灵髓') && Number.isFinite(item.count));
  const repeat = [...root.querySelectorAll('.place-actions button')].find(el => visible(el) && /^再探\s*\S/u.test(text(el)));
  const battleFeedback = {
    repeatStage: repeat ? text(repeat).replace(/^再探\s*/u, '').trim() : '',
    defeats: [...document.querySelectorAll('.log-scroll article.log-entry')].filter(el => visible(el) && /^战败[，,]/u.test(text(el.querySelector('p'))))
      .slice(-32).map(el => `${text(el.querySelector('time'))}\n${text(el.querySelector('p'))}`),
  };
  const localServices=[...root.querySelectorAll('.place-links button,.place-services button,.place-actions button')].filter(visible)
    .map(el=>({name:text(el.querySelector('strong'))||text(el),enabled:!el.disabled&&el.getAttribute('aria-disabled')!=='true'}));
  return { character, region, location, mode, view, inventoryStocks, battleFeedback, localServices,
    health, heal: { running, enabled: Boolean(healButton && !healButton.disabled && healButton.getAttribute('aria-disabled') !== 'true'), label: text(healButton) }, blocked: blocked?.slice(0,150) };
}

export class BattleUI {
  constructor(page, config, runtime, log, signal, { recoveryWait = sleep } = {}) {
    Object.assign(this, { page, config, runtime, log, signal, recoveryWait });
    this.consumables = validateConsumables(config.consumables);
    this.needsNavigate = true;
  }
  async guard() {
    this.signal.throwIfAborted();
    if (this.page.isClosed()) throw new RetryError('战斗页面已关闭，重新建立本任务页面。');
    if (/\/(login|register)(?:[/?]|$)/u.test(this.page.url())) throw new PauseError('请在浏览器中登录 Discord。');
    if (await this.isDesktopHandoff()) throw new PauseError('当前页面打开了 Discord 桌面客户端，尚未进入网页版。请点击「打开游戏 / 登录」，在独立浏览器中登录后再读取人物。');
    for (const frame of await this.page.locator('iframe[src*="hcaptcha"],iframe[src*="recaptcha"]').all()) {
      if (await frame.isVisible()) throw new PauseError('页面需要手动验证。');
    }
    const dialog = this.page.getByRole('dialog').filter({ hasText: /授权|Authorize|授予.*权限/u });
    if (await dialog.count() && await dialog.first().isVisible()) throw new PauseError('App 首次授权需要手动处理，完成后从面板恢复任务或重启脚本。');
  }
  async waitFor(fn, label, timeout = this.runtime.responseTimeoutSeconds * 1000) {
    const deadline = Date.now() + timeout;
    do {
      await this.guard();
      const result = await fn();
      if (result) return result;
      await sleep(500, this.signal);
    } while (Date.now() < deadline);
    throw new RetryError(`等待${label}超时，先重新读取状态。`);
  }
  async unique(locator, label) {
    const items = [];
    for (const candidate of await locator.all()) if (await candidate.isVisible()) items.push(candidate);
    if (items.length !== 1) throw new PauseError(`无法唯一定位${label}（${items.length} 个），请检查页面。`);
    return items[0];
  }
  get battleActionDelayMs() { return (this.config.actionDelaySeconds ?? this.runtime.actionDelaySeconds) * 1000; }
  async action(locator, label, { game = false } = {}) {
    await sleep(game ? this.battleActionDelayMs : this.runtime.actionDelaySeconds * 1000, this.signal);
    await this.guard();
    if (game) await this.observe();
    const item = await this.unique(locator, label);
    if (!await item.isEnabled()) throw new PauseError(`${label}暂不可用或已锁定。`);
    this.beforeAction?.(label);
    await item.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
  }
  async findFrame() {
    const found = [];
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      try {
        const manual = frame.getByRole('heading', { name: /存档冲突|选择存档|创建角色|授权|验证/u });
        if (await manual.count() && await manual.first().isVisible()) throw new PauseError('游戏需要手动确认存档、角色或授权。');
        if (await frame.locator('body').count() && await frame.locator('body').evaluate(el => el.querySelector('aside.character-panel') && el.querySelector('main') || /气血/u.test(el.innerText) && /山河图|正在探索|调息/u.test(el.innerText))) found.push(frame);
      } catch (error) { if (!/detached|destroyed|closed/iu.test(error.message)) throw error; }
    }
    if (found.length > 1) throw new PauseError('发现多个游戏界面，无法确认唯一活动。');
    return found[0] ?? null;
  }
  async openForLogin() {
    this.signal.throwIfAborted();
    if (this.page.isClosed()) throw new RetryError('浏览器窗口已关闭，请重新打开游戏。');
    await this.page.bringToFront();
    const current = new URL(this.page.url());
    const channel = new URL(this.config.channelUrl);
    const atLogin = current.origin === channel.origin && /^\/(login|register)(?:\/|$)/u.test(current.pathname);
    const atChannel = current.origin === channel.origin && current.pathname === channel.pathname;
    // Opening the login window must not wait for, or click, the App launcher.
    // Repeated clicks also leave an in-progress manual login untouched.
    if (!atLogin && (!atChannel || this.needsNavigate || await this.isDesktopHandoff())) {
      try {
        // A cold /channels link can hand off to the installed Discord client.
        // The explicit web login entry keeps manual login in this browser.
        await this.page.goto(new URL('/login',channel.origin).href, {waitUntil:'commit',timeout:15000});
      } catch (error) {
        this.signal.throwIfAborted();
        this.needsNavigate = true;
        throw new RetryError('Discord 页面未能打开，请检查浏览器中的网络提示及本实例的代理配置后重试。',{cause:error});
      }
    }
    this.needsNavigate = false;
  }
  async isDesktopHandoff() {
    return this.page.getByText(/^(?:Discord\s*APP\s*已(?:开启|打开)|Discord\s*App\s*Launched)[!！]?$/iu).first().isVisible().catch(() => false);
  }
  async ensureApp() {
    await this.guard();
    let frame = await this.findFrame();
    if (frame) return frame;
    // A temporarily loading game frame is not a missing Discord App. Reopening
    // the launcher here would toggle its dialog while the activity reconnects.
    if (this.frame && !this.frame.isDetached()) return this.waitFor(() => this.findFrame(), '现有游戏界面恢复', 60000);
    if (this.needsNavigate && !this.config.characterName) {
      await this.openForLogin();
      await this.guard();
    }
    const wrongChannel = this.page.url().startsWith('https://discord.com/channels/')
      && new URL(this.page.url()).pathname !== new URL(this.config.channelUrl).pathname;
    if (this.needsNavigate || wrongChannel) {
      if (wrongChannel) this.log('游戏活动未打开且频道发生跳转，返回配置的战斗频道。');
      await this.page.goto(this.config.channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this.needsNavigate = false;
    }
    await this.guard();
    frame = await this.findFrame();
    if (frame) return frame;
    if (await this.page.getByText('有年龄限制的频道', { exact: true }).isVisible().catch(() => false)) {
      await this.action(this.page.getByRole('button', { name: '继续', exact: true }), '指定频道的继续按钮');
    }
    const appLauncher = this.page.getByRole('button', { name: /^(打开应用|打开应用启动器|应用启动器|启动应用|使用应用|Apps?|Open Apps|Open App Launcher)$/iu });
    const app = this.page.getByRole('dialog').getByRole('heading', { name: this.config.appName, exact: true });
    const profile = this.page.getByRole('dialog').filter({ has: this.page.getByRole('heading', { name: this.config.appName, exact: true }) });
    const start = profile.getByRole('button').filter({ hasText: /^(启动|加入|启动活动|开始活动|启动应用|加入活动|在频道中启动|Launch|Start|Join Activity|Launch Activity)$/iu });
    const visible = async locator => (await Promise.all((await locator.all()).map(item => item.isVisible()))).some(Boolean);
    const launchAction = async (locator, label) => {
      await sleep(this.runtime.actionDelaySeconds * 1000, this.signal);
      await this.guard();
      if (await this.findFrame()) return; // Activity opened during the slow-click delay.
      if (!await visible(locator)) throw new RetryError(`${label}界面发生变化，先重新读取 App 状态。`);
      const item = await this.unique(locator, label);
      if (!await item.isEnabled()) throw new RetryError(`${label}尚未就绪。`);
      this.beforeAction?.(label);
      await item.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
    };
    await this.waitFor(async () => await this.findFrame() || await visible(app) || await visible(start) || await visible(appLauncher), 'App 启动器', 60000);
    if (!await this.findFrame() && !await visible(app) && !await visible(start)) await launchAction(appLauncher, 'App 启动器');
    await this.waitFor(async () => await this.findFrame() || await visible(app) || await visible(start), '配置的 App');
    if (!await this.findFrame() && !await visible(start)) await launchAction(app, this.config.appName);
    await this.waitFor(async () => await this.findFrame() || await visible(start), 'App 启动按钮或已运行界面');
    if (!await this.findFrame()) await launchAction(start, '启动活动');
    // Never click Leave or launch a private-message activity.
    return this.waitFor(() => this.findFrame(), '游戏活动界面', 60000);
  }
  async observe({ allowObstructed = false } = {}) {
    await this.guard();
    const frame = await this.ensureApp();
    const snapshot = await frame.evaluate(readGameSnapshot, this.config.characterName);
    this.onSnapshot?.(snapshot);
    if (snapshot.blocked) throw new PauseError(`游戏需要人工处理：${snapshot.blocked}`);
    this.frame = frame;
    checkBattleIdentity(snapshot, this.config.characterName);
    if (!allowObstructed) requireBattleView(snapshot, this.config.characterName);
    return snapshot;
  }

  async detectCharacter() {
    await this.guard();
    const frame = await this.ensureApp();
    const names = await frame.evaluate(() => {
      const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      return [...document.querySelectorAll('[data-player-panel] .discord-profile h3, aside.character-panel .discord-profile h3')]
        .filter(visible).map(el => (el.innerText ?? '').trim()).filter(Boolean);
    });
    if (names.length !== 1 || names[0].length > 200) throw new PauseError('无法唯一读取人物全名；请在游戏中显示角色头像页，再点击读取人物。');
    const state = await frame.evaluate(readGameSnapshot,names[0]);
    if (state.blocked || state.view.dialogs.length || state.character !== names[0]) throw new PauseError('登录、存档或游戏弹窗需要手动处理，暂不绑定人物。');
    this.frame = frame;
    return names[0];
  }
  monitoringReady(state) {
    return state.character === this.config.characterName && state.health && !state.view.dialogs.length
      && (!state.view.activeTab || state.view.activeTab === '游历') && ['combat', 'rest', 'ready'].includes(state.mode);
  }
  recoveryAction(state) {
    if (state.view.dialogs.length) {
      const [dialog] = state.view.dialogs;
      // Only the observed, purely informational modal is approved. Extra
      // controls or stacked dialogs are not implicitly safe to dismiss.
      if (state.view.dialogs.length !== 1 || dialog.title !== '灵髓积蕴' || dialog.controls.length !== 1 || dialog.controls[0].name !== '关闭窗口') return null;
      return { label: '关闭「灵髓积蕴」说明弹窗', locator: this.frame.locator(DIALOGS).filter({ has: this.frame.getByRole('heading', { name: '灵髓积蕴', exact: true }) }).getByRole('button', { name: '关闭窗口', exact: true }) };
    }
    if (state.mode === 'map') return { label: '地图返回当前位置', locator: this.frame.locator('main,[data-game-main]').getByRole('button', { name: MAP_BACK }) };
    if (state.view.activeTab && state.view.activeTab !== '游历' || !['combat', 'rest', 'ready'].includes(state.mode)) {
      return { label: '返回游戏游历页', locator: this.frame.locator('nav.central-nav,nav[aria-label="主导航"]').getByRole('button', { name: '游历', exact: true }) };
    }
    if (!state.character) return { label: '恢复角色头像页', locator: this.frame.locator(PLAYER).getByRole('group', { name: '角色展示', exact: true }).getByRole('button', { name: '显示头像', exact: true }) };
    return null;
  }
  async ensureMonitoringView() {
    let state = await this.observe({ allowObstructed: true });
    const finish = () => {
      if (this.viewRecovery) this.log(`界面恢复成功：${state.character}；${state.region} / ${state.location}，继续挂机。`);
      this.viewRecovery = null;
      return { ready: true };
    };
    if (this.monitoringReady(state)) return finish();
    if (!this.viewRecovery || this.viewRecovery.key !== state.view.key) this.viewRecovery = { key: state.view.key, attempts: 0 };
    if (this.viewRecovery.attempts >= 3) return { ready: false, delayMs: 30000 };
    this.viewRecovery.attempts++;
    this.log(`恢复游戏界面（${this.viewRecovery.attempts}/3）：${state.view.dialogs.map(d => d.title).join('、') || (!state.character ? '角色姓名不可见' : `当前页面 ${state.view.activeTab || state.mode}`)}。`);
    try {
      // A pass can close the popup, exit a map/tab and reveal the profile.
      for (let step = 0; step < 4 && !this.monitoringReady(state); step++) {
        const action = this.recoveryAction(state);
        if (!action) break;
        const before = state.view.key;
        await this.recoveryWait(Math.max(2, this.runtime.actionDelaySeconds) * 1000, this.signal);
        state = await this.observe({ allowObstructed: true });
        if (state.view.key !== before) continue;
        const candidates = [];
        for (const item of await action.locator.all()) if (await item.isVisible()) candidates.push(item);
        if (candidates.length !== 1) throw new ViewRecoveryError(`${action.label}无法唯一定位（${candidates.length} 个）。`);
        const [button] = candidates;
        if (!await button.isEnabled()) throw new ViewRecoveryError(`${action.label}按钮暂不可用。`);
        if (action.label === '恢复角色头像页' && await button.getAttribute('aria-pressed') === 'true') break;
        this.log(action.label);
        this.beforeAction?.(action.label);
        await button.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
        await this.waitFor(async () => {
          state = await this.observe({ allowObstructed: true });
          return state.view.key !== before;
        }, action.label);
      }
    } catch (error) {
      if (this.signal.aborted || error instanceof PauseError) throw error;
      this.log(`界面恢复尚未确认：${error.message.split('\n')[0]}`);
      // A click can have succeeded before its response timed out.
      state = await this.observe({ allowObstructed: true });
    }
    if (this.monitoringReady(state)) return finish();
    this.viewRecovery.key = state.view.key;
    if (this.viewRecovery.attempts >= 3) {
      const reason = '界面恢复 3 轮未完成，改为每 30 秒只读检查；界面变化后自动重试。';
      this.log(reason);
      return { ready: false, delayMs: 30000, diagnosticReason: reason };
    }
    return { ready: false, delayMs: 5000 };
  }
  async requireEntryHealth() {
    const state = await this.observe();
    if (state.character !== this.config.characterName || state.mode === 'combat') throw new PauseError('操作前角色或战斗状态发生变化。');
    if (!healthStatus(state.health).ready || state.heal?.running) {
      const error = new RetryError('进入前气血未超过 95% 或仍在调息，返回回血流程。');
      error.beforeEntry = true;
      throw error;
    }
    return state;
  }
  async returnToExplore() {
    await this.observe();
    await this.action(this.frame.locator('nav.central-nav,nav[aria-label="主导航"]').getByRole('button', { name: '游历', exact: true }), '返回游戏游历页');
    await this.waitFor(async () => ['combat', 'rest', 'ready', 'map'].includes((await this.observe()).mode), '游戏游历页');
  }
  async consumeAllApproved(name) {
    if (!this.consumables.enabled || !this.consumables.itemNames.includes(name)) throw new PauseError('禁止使用未获授权的物品。');
    let state = await this.observe();
    if (state.mode === 'inventory') { await this.returnToExplore(); state = await this.observe(); }
    if (state.character !== this.config.characterName || !['combat', 'rest', 'ready'].includes(state.mode)) throw new PauseError('使用灵髓前无法确认角色和当前界面。');
    const rowLocator = () => this.frame.locator('aside.character-panel .quick-item,[data-player-panel] .quick-item').filter({ has: this.frame.getByText(name, { exact: true }) });
    const stock = async () => {
      const rows = rowLocator();
      if (!await rows.count()) return 0;
      const row = await this.unique(rows, `${name}库存`);
      const text = await row.locator('.quick-item-info small').getAttribute('title');
      const quantity = /持有\s*(\d+)\s*个/u.exec(text ?? '');
      if (!quantity) throw new PauseError(`无法读取${name}的精确库存。`);
      return Number(quantity[1]);
    };
    if (!await stock()) return { skipped: '快捷栏没有库存' };
    await sleep(this.runtime.actionDelaySeconds * 1000, this.signal);
    state = await this.observe();
    if (state.character !== this.config.characterName) throw new PauseError('使用前角色发生变化。');
    const before = await stock();
    if (!before) return { skipped: '库存已为空' };
    const button = await this.unique(rowLocator().getByRole('button', { name: `使用全部${name}`, exact: true }), `${name}的全部使用按钮`);
    if (!await button.isEnabled()) return { skipped: '使用按钮暂不可用' };
    // Never use a generic "全部" selector: nearby rows include unapproved items.
    this.beforeAction?.(`使用${name}`);
    await button.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
    let after;
    await this.waitFor(async () => {
      const fresh = await this.observe();
      if (fresh.character !== this.config.characterName) throw new PauseError('使用后角色无法确认。');
      after = await stock();
      return after < before;
    }, `${name}库存减少`);
    return { before, after };
  }
  async heal(previous) {
    await sleep(this.battleActionDelayMs, this.signal);
    const fresh = await this.observe();
    if (fresh.mode !== 'rest' || fresh.character !== this.config.characterName || fresh.heal.running || !fresh.heal.enabled || healthStatus(fresh.health).ready) return;
    const target = this.config.healingTarget;
    if (target && (fresh.region !== target.regionName || fresh.location !== target.locationName)) return;
    const button = await this.unique(this.frame.getByRole('button', { name: /^调息(?:\s*\(.*\))?$/u }), '调息');
    if (!await button.isEnabled()) return;
    this.beforeAction?.('调息');
    await button.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
    this.log('已点击调息，等待气血或调息状态变化。');
    await this.waitFor(async () => {
      const after = await this.observe();
      return after.mode !== 'rest' || after.heal.running || !after.heal.enabled || JSON.stringify(after.health) !== JSON.stringify(previous.health);
    }, '调息响应');
  }
  async returnToRest() {
    if (['rest', 'combat', 'ready'].includes((await this.observe()).mode)) return;
    await sleep(this.battleActionDelayMs, this.signal);
    const state = await this.observe();
    if (['rest', 'combat', 'ready'].includes(state.mode)) return;
    if (state.mode !== 'map') throw new RetryError('返回前界面发生变化，先重新读取状态。');
    const back = await this.unique(this.frame.locator('main,[data-game-main]').getByRole('button', { name: MAP_BACK }), '返回当前位置');
    this.beforeAction?.('返回当前位置');
    try { await back.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 }); }
    catch (error) {
      if (['rest', 'combat', 'ready'].includes((await this.observe()).mode)) return;
      throw error;
    }
    await this.waitFor(async () => ['rest', 'combat', 'ready'].includes((await this.observe()).mode), '当前位置');
  }
  async stopHealing() {
    let clicked = false;
    try {
      await sleep(this.battleActionDelayMs, this.signal);
      const fresh = await this.observe();
      if (fresh.character !== this.config.characterName || fresh.mode !== 'rest') throw new PauseError('停止调息前角色或当前位置发生变化。');
      if (!fresh.heal?.running) return;
      if (!healthStatus(fresh.health).ready) throw new RetryError('最新气血未超过 95%，继续调息。');
      const explicit = this.frame.getByRole('button', { name: /^(停止调息|结束调息)$/u });
      const locator = await explicit.count() ? explicit : this.frame.locator('.activity-view .ongoing-activity')
        .filter({ has: this.frame.getByRole('heading', { name: '调息中', exact: true }) })
        .getByRole('button', { name: '结束活动', exact: true });
      const button = await this.unique(locator, '停止调息');
      if (!await button.isEnabled()) throw new RetryError('停止调息按钮暂不可用。');
      this.beforeAction?.('气血超过 95%，停止调息');
      clicked = true;
      await button.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
      await this.waitFor(async () => !(await this.observe()).heal?.running, '调息结束');
    } catch (error) {
      if (!clicked) error.beforeHealingStop = true;
      else {
        const state = await this.observe().catch(() => null);
        if (state?.character === this.config.characterName && !state.heal?.running && state.mode === 'rest') return;
      }
      throw error;
    }
  }
  async retreatForTarget(target, { force = false } = {}) {
    let clicked = false;
    try {
      await sleep(this.battleActionDelayMs, this.signal);
      const fresh = await this.observe();
      if (fresh.character !== this.config.characterName) throw new PauseError('撤退前角色发生变化。');
      if (fresh.mode !== 'combat' || !force && fresh.region === target.regionName && fresh.location === target.stageName) return;
      if (!fresh.region || !fresh.location) throw new PauseError('撤退前无法确认当前关卡。');
      const retreat = await this.unique(this.frame.locator('main,[data-game-main]').getByRole('button', { name: '撤退', exact: true }), '当前战斗的撤退按钮');
      if (!await retreat.isEnabled()) throw new PauseError('撤退按钮暂不可用。');
      this.beforeAction?.('撤退');
      clicked = true;
      await retreat.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
      await this.waitFor(async () => {
        const state = await this.observe();
        if (state.character !== this.config.characterName) throw new PauseError('撤退后角色无法确认。');
        return ['rest', 'ready'].includes(state.mode);
      }, '撤退后的地点');
      this.log(force ? '已确认离开当前战斗。' : '已确认离开原关卡，气血恢复至大于 95% 后进入配置目标。');
    } catch (error) { if (!clicked) error.beforeRetreat = true; throw error; }
  }
  async stageRow(stageName) {
    const label = this.frame.locator('main,[data-game-main]').getByText(stageName, { exact: true });
    const candidates = [];
    for (const item of await label.all()) {
      if (!await item.isVisible()) continue;
      const row = item.locator('xpath=ancestor::*[.//button[normalize-space(.)="前往探索"]][1]');
      if (await row.count() === 1 && await row.getByRole('button', { name: '前往探索', exact: true }).count() === 1) candidates.push(row);
    }
    if (candidates.length > 1) throw new PauseError('当前区域存在多个同名关卡。');
    return candidates[0] ?? null;
  }
  async requireSafeTravel() {
    const state = await this.observe();
    if (state.character !== this.config.characterName || !['rest', 'ready', 'map'].includes(state.mode)) throw new PauseError('前往调息点前无法确认角色或已进入战斗。');
    return state;
  }
  async revealMapNode(map, node, verify) {
    // Pan from a verified empty part of the map. Shrinking the map can switch
    // it back to regions and lose location nodes; never force an offscreen click.
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(this.battleActionDelayMs, this.signal);
      await verify();
      const bounds = await map.boundingBox(), box = await node.boundingBox();
      if (!bounds || !box) throw new PauseError('地图目标地点不可见，未点击其他节点。');
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      if (x > bounds.x + 5 && x < bounds.x + bounds.width - 5 && y > bounds.y + 5 && y < bounds.y + bounds.height - 5) return;
      const point = await map.evaluate(el => {
        const rect = el.getBoundingClientRect();
        for (const px of [0.5, 0.3, 0.7]) for (const py of [0.5, 0.3, 0.7]) {
          const hit = document.elementFromPoint(rect.x + rect.width * px, rect.y + rect.height * py);
          if (hit && el.contains(hit) && !hit.closest('button,[role="button"]')) return { x: rect.width * px, y: rect.height * py };
        }
        return null;
      });
      if (!point) throw new PauseError('地图没有可确认的空白拖动区域。');
      const dx = Math.max(16 - point.x, Math.min(bounds.width - point.x - 16, bounds.x + bounds.width / 2 - x));
      const dy = Math.max(16 - point.y, Math.min(bounds.height - point.y - 16, bounds.y + bounds.height / 2 - y));
      await this.page.mouse.move(bounds.x + point.x, bounds.y + point.y);
      this.beforeAction?.('移动地图');
      await this.page.mouse.down();
      try { await this.page.mouse.move(bounds.x + point.x + dx, bounds.y + point.y + dy, { steps: 10 }); }
      finally { await this.page.mouse.up(); }
    }
    throw new PauseError('目标地点仍在地图可点击范围外，请调整地图。');
  }
  // Shared map selection; combat callers supply the entry-health guard. Healing
  // callers may travel wounded, but only to a node explicitly marked safe.
  async selectMapDestination(regionName, locationName, { healing = false, safeTravel = false, beforeClick = () => {} } = {}) {
    const verify = () => healing || safeTravel ? this.requireSafeTravel() : this.requireEntryHealth();
    let state = await verify();
    if (state.mode !== 'map') {
      await sleep(this.battleActionDelayMs, this.signal);
      state = await verify();
      // A person or an in-flight transition may already have opened the map.
      // Reuse it instead of looking for the entry on the previous screen.
      if (state.mode !== 'map') {
        const button = await this.unique(this.frame.getByRole('button', { name: '山河图', exact: true }), '山河图');
        if (!await button.isEnabled()) throw new PauseError('山河图暂不可用。');
        this.beforeAction?.('山河图');
        try { await button.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 }); }
        catch (error) { if ((await verify()).mode !== 'map') throw error; }
      }
      await this.waitFor(async () => (await this.observe()).mode === 'map', '山河图');
    }
    const map = this.frame.locator('.map-viewport,[data-map]');
    const realMap = await this.frame.locator('.map-viewport').count() > 0;
    if (realMap && await map.getAttribute('data-map-level') !== 'regions') {
      await this.action(this.frame.locator('main,[data-game-main]').getByRole('button', { name: '全图', exact: true }), '展开区域总图', { game: true });
      await this.waitFor(async () => await map.getAttribute('data-map-level') === 'regions', '区域总图');
    }
    await verify();
    const region = await this.unique(realMap ? map.getByRole('button', { name: `展开${regionName}`, exact: true }) : map.getByText(regionName, { exact: true }), `区域「${regionName}」（不存在或重名时暂停）`);
    if (realMap) await this.revealMapNode(map, region, verify);
    await this.action(region, `展开区域「${regionName}」`, { game: true });
    await this.waitFor(async () => realMap ? await this.frame.locator('.map-viewport[data-map-level="locations"]').count() : await map.getByText(locationName, { exact: true }).count(), '区域内地图');
    state = await verify();
    if (!realMap && state.region !== regionName) throw new PauseError('无法确认当前地图属于配置区域。');
    const namePattern = new RegExp(`^${locationName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:[，,].*)?$`, 'u');
    const node = await this.unique(realMap ? map.getByRole('button', { name: namePattern }) : map.getByText(locationName, { exact: true }), `地点「${locationName}」（不存在或重名时暂停）`);
    const inspect = () => node.evaluate(el => {
      const root = el.closest('button,[role="button"],[data-node]');
      const text = `${root?.textContent ?? ''} ${root?.getAttribute('aria-label') ?? ''}`;
      return {
        locked: Boolean(root?.disabled || root?.getAttribute('aria-disabled') === 'true' || /锁定|未解锁|独立挑战|需要.*(?:门票|道具|条件)/u.test(text)),
        safe: /安全|休整|歇脚/u.test(text) && /调息/u.test(text),
        safeRest: /安全|休整|歇脚/u.test(text),
      };
    });
    const checkNode = async () => {
      const info = await inspect();
      if (info.locked) throw new PauseError('目标地点已锁定或需要特殊条件。');
      if (healing && !info.safe) throw new PauseError('配置调息点未标明安全或休整，未点击地图节点。');
      if (safeTravel && !info.safeRest) throw new PauseError('商店地点未标明安全或休整，未点击地图节点。');
    };
    await checkNode();
    if (realMap) await this.revealMapNode(map, node, verify);
    await sleep(this.battleActionDelayMs, this.signal);
    await verify(); await checkNode();
    this.beforeAction?.(`前往${locationName}`);
    beforeClick();
    await node.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
    await this.waitFor(async () => (await this.observe()).mode !== 'map', '目标地点');
    return { realMap };
  }
  async travelToHealing(target) {
    let clicked = false;
    try {
      let state = await this.requireSafeTravel();
      if (state.region !== target.regionName || state.location !== target.locationName) {
        await this.selectMapDestination(target.regionName, target.locationName, { healing: true, beforeClick: () => { clicked = true; } });
        state = await this.observe();
      }
      if (state.region !== target.regionName || state.location !== target.locationName || state.mode !== 'rest' || !state.heal?.label) throw new PauseError('调息地点的区域、名称或调息入口与配置不符，未调息。');
      this.log(`已到达 ${target.regionName} / ${target.locationName}，下一轮读取最新气血。`);
    } catch (error) { if (!clicked) error.beforeHealingTravel = true; throw error; }
  }
  armEntry(attempt, target, state) {
    Object.assign(attempt, { at: Date.now(), target: { ...target }, before: { health: state.health, battleFeedback: state.battleFeedback }, combatConfirmed: false });
  }
  async waitForEntry(attempt, label) {
    // Give the click one normal action interval to settle, not a 30-second
    // combat-proof window. Resting after that is a valid state in its own right.
    await sleep(this.battleActionDelayMs, this.signal);
    return this.waitFor(async () => {
      const state = await this.observe();
      const result = entryOutcome(state, attempt);
      if (result?.kind === 'combat') attempt.combatConfirmed = true;
      return result;
    }, label);
  }
  async repeatButton(target) {
    // A repeat button only names a stage. The catalog resolves its region;
    // ambiguous/missing names use the normal region + destination route.
    const matches = this.getCatalog?.()?.nodes?.filter(node => node.name === target.stageName) ?? [];
    if (matches.length !== 1 || matches[0].regionName !== target.regionName || matches[0].type !== 'battle' || matches[0].availability !== 'visible') return null;
    const buttons = [];
    for (const button of await this.frame.locator('main .place-actions button,[data-game-main] .place-actions button').all()) {
      if (await button.isVisible() && (await button.innerText()).trim().replace(/^再探\s*/u, '') === target.stageName && /^再探\s*\S/u.test((await button.innerText()).trim())) buttons.push(button);
    }
    if (buttons.length > 1) throw new PauseError('目标关卡的再探按钮重名，无法唯一定位。');
    return buttons.length === 1 && await buttons[0].isEnabled() ? buttons[0] : null;
  }
  async enterTarget(target, attempt = {}) {
    let entryClicked = false;
    try {
      let state = await this.requireEntryHealth();
      if (state.mode === 'rest' && await this.repeatButton(target)) {
        await sleep(this.battleActionDelayMs, this.signal);
        state = await this.requireEntryHealth();
        const repeat = state.mode === 'rest' ? await this.repeatButton(target) : null;
        if (repeat) {
          this.beforeAction?.(`再探${target.stageName}`);
          entryClicked = true;
          this.armEntry(attempt, target, state);
          await repeat.click({ timeout: this.runtime.responseTimeoutSeconds * 1000 });
          return await this.waitForEntry(attempt, '再探响应');
        }
      }
      if (state.mode === 'ready' && state.region === target.regionName && state.location === target.stageName) {
        this.beforeAction?.('前往探索');
        entryClicked = true;
        return await this.startExploring(target, attempt);
      }
      let row = state.region === target.regionName ? await this.stageRow(target.stageName) : null;
      if (!row) {
        const { realMap } = await this.selectMapDestination(target.regionName, target.stageName, { beforeClick: () => { entryClicked = true; this.armEntry(attempt, target, state); } });
        if (realMap) {
          return await this.startExploring(target, attempt);
        }
      } else {
        await sleep(this.battleActionDelayMs, this.signal);
        state = await this.requireEntryHealth();
        if (state.region !== target.regionName) throw new PauseError('进入前区域已变化。');
        row = await this.stageRow(target.stageName);
        if (!row) throw new PauseError('进入前目标关卡已消失。');
        if (/独立挑战|门票|未解锁|剧情选择/u.test(await row.innerText())) throw new PauseError('目标关卡需要特殊进入条件，请手动确认。');
        const button = await this.unique(row.getByRole('button', { name: '前往探索', exact: true }), '目标关卡的探索按钮');
        if (!await button.isEnabled()) throw new PauseError('目标关卡当前不可进入。');
        this.beforeAction?.('前往探索');
        entryClicked = true;
        this.armEntry(attempt, target, state);
        await button.click();
        await sleep(this.battleActionDelayMs, this.signal);
        // Some locations open a preview from the nearby list; others start directly.
        const after = await this.waitFor(async () => {
          const fresh = await this.observe();
          if (fresh.mode === 'ready') return { preview: true };
          const result = entryOutcome(fresh, attempt);
          if (result?.kind === 'combat') attempt.combatConfirmed = true;
          return result;
        }, '目标关卡界面');
        return after.preview ? await this.startExploring(target, attempt) : after;
      }
      return await this.waitForEntry(attempt, '目标关卡战斗');
    } catch (error) { if (!entryClicked) error.beforeEntry = true; throw error; }
  }
  async startExploring(target, attempt = {}) {
    let clicked = false;
    try {
      let state = await this.requireEntryHealth();
      if (state.mode !== 'ready' || state.region !== target.regionName || state.location !== target.stageName) throw new PauseError('关卡介绍中的区域或名称与配置不符，未开始探索。');
      await sleep(this.battleActionDelayMs, this.signal);
      state = await this.requireEntryHealth();
      if (state.region !== target.regionName || state.location !== target.stageName) throw new PauseError('开始探索前目标发生变化。');
      const start = await this.unique(this.frame.getByRole('button', { name: '开始探索', exact: true }), '开始探索');
      if (!await start.isEnabled()) throw new PauseError('开始探索按钮不可用。');
      this.beforeAction?.('开始探索');
      this.armEntry(attempt, target, state);
      clicked = true;
      await start.click();
      return await this.waitForEntry(attempt, '开始探索响应');
    } catch (error) { if (!clicked) error.beforeEntry = true; throw error; }
  }
  async diagnostics(directory, reason) {
    if (/登录|授权|验证码|验证/u.test(reason) || /\/(login|register)/u.test(this.page.url()) || this.page.isClosed()) { this.log('登录或验证界面不保存截图。'); return; }
    await mkdir(directory, { recursive: true });
    const base = path.join(directory, `battle-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
    await this.page.screenshot({ path: `${base}.png` });
    const snapshot = this.frame && !this.frame.isDetached() ? await this.frame.evaluate(readGameSnapshot, this.config.characterName).catch(() => null) : null;
    await writeFile(`${base}.json`, JSON.stringify({ reason, snapshot }, null, 2));
    this.log(`诊断已保存：${base}.png`);
  }

  // Open only the map/region overview. Location nodes are never clicked to probe access.
  async inspectCatalog(catalog) {
    const ready = await this.ensureMonitoringView();
    if (!ready.ready) throw new PauseError('请先恢复游戏界面，再核实地点目录。');
    const origin = await this.observe(); // The map heading itself may omit the region.
    let opened = false, scanError;
    try {
      await this.action(this.frame.getByRole('button', { name: '山河图', exact: true }), '读取山河图', { game: true });
      opened = true;
      const map = this.frame.locator('.map-viewport');
      await this.waitFor(async () => await map.count(), '地图画布');
      // The location layer contains all unlocked regions, including clipped
      // nodes. Read it in place; do not jump to the first region in the catalog.
      if (await map.getAttribute('data-map-level') === 'regions') {
        const labels = await map.getByRole('button').evaluateAll(els => els.map(el => el.getAttribute('aria-label') ?? ''));
        const regions = catalog.regions.filter(r => labels.includes(`展开${r.name}`));
        if (!regions.length) throw new Error('地图区域定义无法核实，保留旧目录');
        const selected = regions.find(r => r.name === origin.region) ?? regions[0];
        const region = await this.unique(map.getByRole('button', { name: `展开${selected.name}`, exact: true }), `区域「${selected.name}」`);
        await this.revealMapNode(map, region, async () => {
          if ((await this.observe()).mode !== 'map') throw new RetryError('读取目录时已离开地图，请重新刷新。');
        });
        await this.action(region, `读取地点图「${selected.name}」`, { game: true });
      }
      await this.waitFor(async () => await map.getAttribute('data-map-level') === 'locations', '地点图');
      const raw = await map.evaluate(el => ({
        regions: [...el.querySelectorAll('.map-region-label')].map(x => x.textContent.trim()),
        nodes: [...el.querySelectorAll('button.map-node:not(.region-node)')].map(x => ({
          name: x.querySelector('strong')?.textContent.trim(), region: x.getAttribute('data-region'),
          label: `${x.getAttribute('aria-label')} ${x.textContent}`,
          locked: x.disabled || x.getAttribute('aria-disabled') === 'true',
        })),
      }));
      if (!raw.nodes.length || !raw.regions.length) throw new Error('地图节点为空或区域不可核实，未覆盖旧目录');
      const checkedAt = Date.now();
      const nodes = catalog.nodes.map(node => {
        const candidates = raw.nodes.filter(n => n.name === node.name && (!n.region || n.region === node.regionName));
        const uniqueDefinition = catalog.nodes.filter(n => n.name === node.name).length === 1;
        const match = candidates.length === 1 && (uniqueDefinition || candidates[0].region === node.regionName) && raw.regions.includes(node.regionName) ? candidates[0] : null;
        const safe = node.type !== 'healing' || match && /安全/u.test(match.label) && /调息/u.test(match.label);
        return { ...node, checkedAt, availability: !match || !safe ? 'unverified' : match.locked || /锁定|未解锁/u.test(match.label) ? 'locked' : 'visible' };
      });
      return { ...catalog, nodes, checkedAt };
    } catch (error) {
      scanError = error;
      throw error;
    } finally {
      if (opened) {
        try {
          const state = await this.observe({ allowObstructed: true });
          if (state.mode === 'map') await this.returnToRest();
        } catch (error) {
          if (!scanError) throw error;
          this.log(`目录读取后返回暂未确认：${error.message.split('\n')[0]}；保留原始失败原因。`);
        }
      }
    }
  }
}
