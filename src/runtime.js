import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { root } from './config.js';

export async function acquireLock(identity) {
  const directory = path.join(root, '.runtime');
  await mkdir(directory, { recursive: true });
  const name = createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 20);
  const file = path.join(directory, `${name}.lock`);
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); }
      finally { await handle.close(); }
      return async () => {
        try {
          const data = JSON.parse(await readFile(file, 'utf8'));
          if (data.token === token) await unlink(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(await readFile(file, 'utf8')); }
      catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw new Error(`锁文件暂不可读，请检查是否已有脚本启动：${file}`);
      }
      if (!Number.isInteger(existing.pid) || existing.pid <= 0) throw new Error(`锁文件无效：${file}`);
      try { process.kill(existing.pid, 0); }
      catch (probeError) {
        if (probeError.code !== 'ESRCH') throw new Error('已有实例运行，或无法确认锁的进程状态。');
        // Recheck token so a replaced lock is not removed.
        const latest = JSON.parse(await readFile(file, 'utf8'));
        if (latest.token === existing.token) await unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
        continue;
      }
      throw new Error(`已有脚本实例运行（PID ${existing.pid}），请先停止该实例。`);
    }
  }
  throw new Error('无法取得运行锁，请稍后重试。');
}

export async function createLogger() {
  const directory = path.join(root, 'logs');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${new Date().toISOString().slice(0, 10)}.log`);
  let pending = Promise.resolve();
  const log = (message) => {
    const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`;
    console.log(line);
    pending = pending.then(() => appendFile(file, `${line}\n`, 'utf8')).catch((error) => console.error(`日志写入失败：${error.message}`));
  };
  return { log, flush: () => pending, directory };
}

export async function sleep(ms, signal) {
  await setTimeout(Math.max(0, ms), undefined, { signal });
}

export async function pauseUntilRestart(signal, log) {
  log('等待手动处理：在游戏画面完成登录或处理提示，然后恢复任务或重启脚本（Restart）。暂停期间不执行游戏操作。');
  while (true) await sleep(86_400_000, signal);
}
