import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PauseError } from './errors.js';
import { ViewRecoveryError } from './battle-view.js';
import { ControlInterrupted } from './control-errors.js';

export function validateConsumables(value) {
  if (value == null) return { enabled: false };
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') throw new Error('battle.consumables.enabled 必须为布尔值。');
  if (!value.enabled) return { enabled: false };
  const result = { intervalMinutes: 10, quantity: 'all', itemNames: [], ...value };
  if (!Number.isFinite(result.intervalMinutes) || result.intervalMinutes < 10) throw new Error('自动使用灵髓间隔至少为 10 分钟。');
  if (result.quantity !== 'all') throw new Error('自动灵髓 quantity 必须为 all（全部库存）。');
  if (!Array.isArray(result.itemNames) || !result.itemNames.length || result.itemNames.some(name => typeof name !== 'string' || !/^[\p{Script=Han}]+灵髓$/u.test(name))) throw new Error('itemNames 必须为灵髓完整名称的非空白名单。');
  if (new Set(result.itemNames).size !== result.itemNames.length) throw new Error('itemNames 不能包含重复名称。');
  result.itemNames = [...result.itemNames];
  return result;
}

export function consumableStatePath(profilePath, battle) {
  const key = createHash('sha256').update(`${battle.channelUrl}\n${battle.characterName}`).digest('hex').slice(0, 20);
  return path.join(profilePath, 'automation', `consumables-${key}.json`);
}

// Reserve the next run on disk BEFORE touching a use button. A timeout or process
// exit must not turn a successful but unacknowledged use into a rapid second use.
export class ConsumableRunner {
  constructor(config, filename, log, { now = Date.now } = {}) {
    Object.assign(this, { config, filename, log, now });
  }
  async save(state) {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.filename);
    this.state = state;
  }
  async runIfDue(ui) {
    if (!this.config?.enabled || this.disabled) return;
    try {
      if (!this.state) {
        try { this.state = JSON.parse(await readFile(this.filename, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { version: 1, nextAt: 0 }; }
        if (this.state.version !== 1 || !Number.isFinite(this.state.nextAt) || this.state.nextAt < 0) throw new Error('灵髓执行记录无效');
        if (this.state.nextAt > this.now()) this.log(`灵髓下次检查：${new Date(this.state.nextAt).toLocaleString('zh-CN', { hour12: false })}。`);
      }
      if (this.now() < this.state.nextAt) return;
      await this.save({ version: 1, startedAt: this.now(), nextAt: this.now() + this.config.intervalMinutes * 60000, results: {} });
    } catch (error) {
      this.disabled = true;
      this.log(`灵髓功能暂停：无法安全保存执行时间（${error.message}）；战斗流程继续。`);
      return;
    }
    this.log(`每 ${this.config.intervalMinutes} 分钟检查灵髓：仅使用${this.config.itemNames.join('、')}的全部库存。`);
    let interrupted;
    for (const name of this.config.itemNames) {
      try {
        const result = await ui.consumeAllApproved(name);
        this.state.results[name] = result;
        this.log(result.skipped ? `${name}：${result.skipped}，本轮跳过。` : `${name}已确认使用，库存 ${result.before} → ${result.after}。`);
      } catch (error) {
        this.state.results[name] = { uncertain: error.message };
        this.log(`${name}本轮未确认：${error.message}；不重复点击，下轮重新核查。`);
        if (ui.signal?.aborted) return;
        if (error instanceof ViewRecoveryError || error instanceof PauseError || error instanceof ControlInterrupted) { interrupted = error; break; }
      }
    }
    try { await this.save(this.state); }
    catch (error) { this.disabled = true; this.log(`灵髓结果记录失败，暂停自动使用：${error.message}`); }
    this.log(`灵髓下次检查：${new Date(this.state.nextAt).toLocaleString('zh-CN', { hour12: false })}。`);
    if (interrupted) throw interrupted;
  }
}
