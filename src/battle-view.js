import { PauseError } from './errors.js';

// Missing UI is recoverable; a positively identified different character is not.
export class ViewRecoveryError extends Error {}

export function checkBattleIdentity(state, expected) {
  if (state.blocked) throw new PauseError(`游戏需要人工处理：${state.blocked}`);
  if (state.character && state.character !== expected) throw new PauseError(`角色不符：期望 ${expected}，读取到 ${state.character}。`);
}

export function requireBattleView(state, expected) {
  checkBattleIdentity(state, expected);
  if (!state.character) throw new ViewRecoveryError('角色姓名暂不可见，需要恢复头像页。');
  if (state.view?.dialogs.length) throw new ViewRecoveryError('游戏弹窗遮挡界面，需要恢复。');
  if (state.view?.activeTab && state.view.activeTab !== '游历') throw new ViewRecoveryError('当前不在游历页，需要恢复。');
  if (['combat', 'rest', 'ready'].includes(state.mode) && !state.health) throw new ViewRecoveryError('气血暂不可读，等待界面恢复。');
}

// One serialized boundary for recovery, consumables and battle. Never call
// recovery from observe(): doing so would undo our own multi-step map navigation.
export async function runBattleIteration(ui, runner, consumables, { readOnly = false, diagnostics } = {}) {
  try {
    if (!readOnly) {
      const result = await ui.ensureMonitoringView();
      if (!result.ready) {
        if (result.diagnosticReason) await diagnostics?.(result.diagnosticReason);
        return { delayMs: result.delayMs };
      }
      if (!runner.pendingHealingTravel && !runner.pendingEntry) await consumables.runIfDue(ui);
    }
    return await runner.step();
  } catch (error) {
    if (readOnly || !(error instanceof ViewRecoveryError)) throw error;
    ui.log(`操作暂缓：${error.message} 下一轮恢复界面后重新核查状态。`);
    return { delayMs: 5000 };
  }
}
