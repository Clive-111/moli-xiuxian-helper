import { PauseError, retryDelay } from './errors.js';
import { sleep, pauseUntilRestart } from './runtime.js';

// Each worker catches its own failures. A pause never blocks a sibling worker.
export async function runTask(task, { config, signal, log, pause = () => pauseUntilRestart(signal, log), wait = sleep }) {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const result = await task.step();
      failures = 0;
      if (result?.done) return;
      if (result?.nextCheck) log(`下一次检查：${new Date(Date.now() + result.delayMs).toLocaleString('zh-CN', { hour12: false })}。`);
      await wait(result?.delayMs ?? 5000, signal);
    } catch (error) {
      if (signal.aborted) return;
      log(`${error instanceof PauseError ? '已暂停' : '操作失败'}：${error.message}`);
      await task.diagnostics?.(error.message).catch(e => log(`诊断保存失败：${e.message}`));
      try {
        if (error instanceof PauseError) {
          await pause();
          failures = 0;
        } else {
          const delay = retryDelay(++failures, config);
          log(`${delay / 1000} 秒后重新读取本任务状态（连续失败 ${failures} 次）。`);
          await wait(delay, signal);
          await task.recover?.(error);
        }
      } catch (recoveryError) {
        if (signal.aborted) return;
        log(`恢复失败，暂停本任务：${recoveryError.message}`);
        try { await pause(); } catch (e) { if (!signal.aborted) throw e; }
      }
    }
  }
}
