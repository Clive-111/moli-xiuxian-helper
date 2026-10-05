import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireLock, sleep, pauseUntilRestart } from '../src/runtime.js';

test('non-interactive manual pause stays pending without stdin until shutdown', async () => {
  const abort = new AbortController();
  const logs = [];
  let completed = false;
  const paused = pauseUntilRestart(abort.signal, (line) => logs.push(line));
  paused.then(() => { completed = true; }, () => { completed = true; });
  await sleep(30);
  assert.equal(completed, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Restart/u);
  abort.abort();
  await assert.rejects(paused, { name: 'AbortError' });
});

test('same browser profile rejects a second instance and can be reopened after release', async () => {
  const identity = `test-profile-${randomUUID()}`;
  const release = await acquireLock(identity);
  try { await assert.rejects(acquireLock(identity.toUpperCase()), /已有脚本实例/u); }
  finally { await release(); }
  const reopened = await acquireLock(identity);
  await reopened();
});

test('two-hour sleep is immediately cancellable', async () => {
  const abort = new AbortController();
  const waiting = sleep(7_200_000, abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});
