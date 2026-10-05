import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

test('a crashed app exits despite a desktop process ignoring TERM, allowing Docker to recover', { skip: process.platform !== 'linux' || !process.env.CONTAINER_PROFILE_PATH }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-cleanup-'));
  for (const name of ['Xvfb', 'xdpyinfo', 'openbox', 'x11vnc', 'websockify']) {
    const body = name === 'xdpyinfo' ? 'exit 0' : `${name === 'x11vnc' ? "trap '' TERM" : "trap 'exit 0' TERM"}\nwhile true; do sleep 0.1; done`;
    await writeFile(path.join(directory, name), '#!/usr/bin/env bash\n' + body + '\n', { mode: 0o755 });
  }
  const started = Date.now();
  const child = spawn('bash', ['docker/entrypoint.sh', process.execPath, '-e', 'setTimeout(()=>process.exit(7),100)'], { env: { ...process.env, PATH: directory + ':' + process.env.PATH }, stdio: 'ignore' });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.ok(Date.now() - started < 8000);
  } finally { clearTimeout(deadline); }
});
