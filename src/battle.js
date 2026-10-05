import { PauseError } from './errors.js';
import { ViewRecoveryError, requireBattleView } from './battle-view.js';

export function parseHealthNumber(text) {
  const match = /^([\d]+(?:\.\d+)?)\s*([万亿kKmM]?)$/u.exec(String(text ?? '').normalize('NFKC').replace(/[,，\s]/gu, ''));
  if (!match) return null;
  const scale = { '': 1, 万: 1e4, 亿: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[match[2]];
  const value = Number(match[1]) * scale;
  return Number.isFinite(value) ? { value, exact: !match[2] } : null;
}

export function healthStatus(health) {
  if (!health) throw new PauseError('无法读取本角色气血。');
  const current = parseHealthNumber(health.current);
  const maximum = parseHealthNumber(health.maximum);
  if (!current || !maximum || maximum.value <= 0 || current.value > maximum.value) throw new PauseError('气血数值无效或矛盾。');
  const exact = current.exact && maximum.exact;
  const percent = health.percent;
  if (percent != null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw new PauseError('气血进度无效。');
  // A raw, verified DOM progress value or an explicit full-health state can disambiguate 万/亿.
  const full = percent != null ? percent === 100 : exact ? current.value === maximum.value : health.explicitFull === true;
  // Numeric tooltips can round the last decimal too. Prefer raw progress, while
  // rejecting a material disagreement instead of treating it as full health.
  if (exact && percent != null && Math.abs(current.value / maximum.value * 100 - percent) > 0.01) throw new PauseError('气血文本与血条矛盾。');
  const ratioPercent = percent ?? current.value / maximum.value * 100;
  // Entering now needs >95%, not proof of exact full health. Abbreviated text
  // can supply the ratio when the game does not expose a raw progress value.
  const ready = ratioPercent > 95;
  return { full, ready, known: true, percent: ratioPercent, key: JSON.stringify([health.current, health.maximum, percent, health.explicitFull]), maximumKey: String(health.maximum), display: `${health.current}/${health.maximum} (${Number(ratioPercent.toFixed(2))}%)` };
}

// Instant defeats need not leave an observable combat frame or a fresh log.
// A recognized resting view is enough to resume the normal HP-based flow;
// this does not claim that the previous click successfully started a battle.
export function entryOutcome(state, attempt) {
  if (!attempt?.target) return null;
  const target = attempt.target;
  if (state.mode === 'combat') {
    if (state.region !== target.regionName || state.location !== target.stageName) throw new PauseError('进入后的关卡与配置不符。');
    return { kind: 'combat' };
  }
  return state.mode === 'rest' ? { kind: 'returned' } : null;
}

export class BattleRunner {
  constructor(ui, config, log, { readOnly = false, now = Date.now } = {}) {
    Object.assign(this, { ui, config, log, readOnly, now });
    this.lastLogAt = -Infinity;
  }

  reconcileHealingTravel(state) {
    if (!this.pendingHealingTravel || state.character !== this.config.characterName || state.blocked || state.view?.dialogs?.length || state.view?.activeTab && state.view.activeTab !== '游历') return false;
    const destination = this.config.healingTarget;
    const arrived = state.mode === 'rest' && destination && state.region === destination.regionName && state.location === destination.locationName;
    const resumed = state.mode === 'combat' && state.region === this.config.target?.regionName && state.location === this.config.target?.stageName;
    if (!arrived && !resumed) return false;
    // A view interruption/manual re-entry can overtake a safe travel request.
    // Confirm the current battle rather than retrying the old map click or
    // claiming we arrived at the healer. Unknown/wrong destinations stay fenced.
    this.pendingHealingTravel = null; this.healing = null; this.healPending = false;
    this.log(arrived ? `已确认到达调息点：${destination.regionName} / ${destination.locationName}。`
      : '已重新确认正在配置关卡战斗，结束旧调息行程核对，继续监测。');
    return true;
  }

  async step() {
    const state = await this.ui.observe();
    requireBattleView(state, this.config.characterName);
    if (!['combat', 'rest', 'map', 'ready', 'inventory'].includes(state.mode)) throw new ViewRecoveryError('游戏界面暂不可识别。');
    const delayMs = this.config.pollIntervalSeconds * 1000;
    const destination = this.config.healingTarget;
    const status = `${state.mode}；当前位置：${state.region || '未知区域'} / ${state.location || '未知地点'}；目标：${this.config.target.regionName} / ${this.config.target.stageName}${destination ? `；调息点：${destination.regionName} / ${destination.locationName}` : ''}`;
    if (status !== this.lastStatus || this.now() - this.lastLogAt >= 60000) {
      this.log(`${this.readOnly ? '只读检查：' : ''}${status}；气血：${state.health?.current ?? '?'}/${state.health?.maximum ?? '?'}。`);
      this.lastStatus = status; this.lastLogAt = this.now();
    }
    if (this.readOnly) return { delayMs };
    if (state.mode === 'inventory') { await this.ui.returnToExplore(); return { delayMs: 0 }; }
    this.reconcileHealingTravel(state);
    if (this.pendingHealingTravel) {
      if (state.mode === 'combat' || this.now() - this.pendingHealingTravel.at >= 30000) throw new PauseError('前往调息点后未能确认安全到达，避免重复点击，暂停本任务。');
      return { delayMs };
    }
    if (state.mode === 'combat') {
      const onTarget = state.region === this.config.target.regionName && state.location === this.config.target.stageName;
      if (this.pendingEntry && !onTarget) throw new PauseError('进入后的关卡与配置不符。');
      if (!onTarget) {
        if (!state.region || !state.location) throw new PauseError('无法确认当前战斗区域或关卡，暂不撤退。');
        if (this.pendingRetreat) {
          if (this.now() - this.pendingRetreat.at >= 30000) throw new PauseError('撤退后未能确认结果，避免重复点击，暂停本任务。');
          return { delayMs };
        }
        this.log(`当前关卡与配置不同，立即撤退换图：${state.region} / ${state.location} → ${this.config.target.regionName} / ${this.config.target.stageName}。`);
        this.pendingRetreat = { at: this.now() };
        try { await this.ui.retreatForTarget(this.config.target); }
        catch (error) { if (error.beforeRetreat) this.pendingRetreat = null; throw error; }
        return { delayMs: 0 };
      }
      if (this.pendingEntry) this.log('已确认进入目标关卡，交由游戏自动重复战斗。');
      this.pendingRetreat = null;
      this.pendingEntry = null; this.healPending = false; this.healing = null; this.pendingHealingStop = null;
      return { delayMs };
    }
    if (['rest', 'ready'].includes(state.mode)) this.pendingRetreat = null;
    if (this.pendingEntry) {
      if (entryOutcome(state, this.pendingEntry)) {
        this.pendingEntry = null; this.healing = null; this.healPending = false;
        this.log('当前已在休整地点，直接按气血决定调息或再战。');
      } else {
        if (this.now() - this.pendingEntry.at >= 30000) throw new PauseError('进入关卡后未能确认结果，避免重复点击，暂停本任务。');
        return { delayMs };
      }
    }
    if (state.mode === 'map') {
      await this.ui.returnToRest();
      return { delayMs: 0 };
    }
    if (this.pendingHealingStop) {
      if (!state.heal?.running) this.pendingHealingStop = null;
      else {
        if (this.now() - this.pendingHealingStop.at >= 30000) throw new PauseError('停止调息后未能确认结果，暂停本任务，避免重复点击。');
        return { delayMs };
      }
    }
    const hp = healthStatus(state.health);
    if (hp.ready) {
      this.healing = null; this.healPending = false;
      if (state.heal?.running) {
        this.log(`气血已大于 95%：${hp.display}，停止调息。`);
        this.pendingHealingStop = { at: this.now() };
        try { await this.ui.stopHealing(); this.pendingHealingStop = null; }
        catch (error) { if (error.beforeHealingStop) this.pendingHealingStop = null; throw error; }
        // Yield to queued controls, then reread HP and enter without a full poll delay.
        return { delayMs: 0 };
      }
      this.log(`气血已大于 95%：${hp.display}，准备进入配置目标。`);
      // The adapter rechecks character, current health and destination immediately before clicking.
      this.pendingEntry = { at: this.now(), target: { ...this.config.target }, before: { health: state.health, battleFeedback: state.battleFeedback } };
      try {
        const result = await this.ui.enterTarget(this.config.target, this.pendingEntry);
        if (['combat', 'defeated', 'returned'].includes(result?.kind)) {
          this.pendingEntry = null;
          this.log(result.kind === 'combat' ? '已确认进入目标关卡，交由游戏自动重复战斗。' : '当前已在休整地点，下一轮按气血决定调息或再战。');
          if (result.kind !== 'combat') return { delayMs: 0 };
        }
      }
      catch (error) {
        if (error.beforeEntry) this.pendingEntry = null;
        throw error;
      }
      return { delayMs };
    }
    if (destination && (state.region !== destination.regionName || state.location !== destination.locationName)) {
      this.log(`气血未超过 95%，前往调息点：${destination.regionName} / ${destination.locationName}。`);
      this.pendingHealingTravel = { at: this.now() };
      try { await this.ui.travelToHealing(destination); }
      catch (error) { if (error.beforeHealingTravel) this.pendingHealingTravel = null; throw error; }
      return { delayMs: 0 };
    }
    if (state.mode === 'ready') throw new PauseError('当前地点不能调息且气血未超过 95%，请手动返回休整地点。');
    if (!this.healing || this.healing.key !== hp.key) {
      this.healing = { key: hp.key, changedAt: this.now() };
      this.healPending = false;
      this.log(`调息进度：${hp.display}。`);
    }
    if (this.now() - this.healing.changedAt >= 60000) throw new PauseError('调息 60 秒气血没有变化，暂停本任务。');
    if (state.heal?.running || !state.heal?.enabled || this.healPending) return { delayMs };
    if (this.lastHealAt != null && this.now() - this.lastHealAt < this.config.healActionIntervalSeconds * 1000) return { delayMs };
    this.lastHealAt = this.now(); this.healPending = true;
    await this.ui.heal(state);
    this.healPending = false;
    return { delayMs };
  }
}
