import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConsumableRunner, validateConsumables } from '../src/consumables.js';
import { ViewRecoveryError } from '../src/battle-view.js';
import { PauseError } from '../src/errors.js';

const config = validateConsumables({ enabled: true, itemNames: ['莹灵髓', '玉灵髓'] });
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'consumables-test-'));
  try { await run(path.join(directory, 'schedule.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('explicit marrow allowlists are configurable; omitted names never enable consumption', () => {
  assert.throws(() => validateConsumables({enabled:true}), /白名单/u);
  assert.deepEqual(config.itemNames, ['莹灵髓', '玉灵髓']);
  assert.deepEqual(validateConsumables(undefined), { enabled: false });
  assert.deepEqual(validateConsumables({enabled:true,itemNames:['赤灵髓','碧灵髓']}).itemNames,['赤灵髓','碧灵髓']);
  for (const override of [{ itemNames:['全部','玉灵髓'] }, { itemNames:[] }, {itemNames:[null]}, { itemNames:['莹灵髓','莹灵髓'] }, { quantity:1 }, { intervalMinutes:1 }]) assert.throws(()=>validateConsumables({ enabled:true, ...override }));
});

test('changing the allowlist keeps the persisted deadline and only uses the new pair when due', async () => fixture(async filename => {
  const used=[]; let now=1000000;
  const ui={consumeAllApproved:async name=>{used.push(name);return {before:3,after:0};}};
  await new ConsumableRunner(config,filename,()=>{}, {now:()=>now}).runIfDue(ui);
  const changed=validateConsumables({enabled:true,itemNames:['赤灵髓','碧灵髓']});
  now+=10000;
  const runner=new ConsumableRunner(changed,filename,()=>{}, {now:()=>now});
  await runner.runIfDue(ui); assert.deepEqual(used,config.itemNames);
  now+=590000; await runner.runIfDue(ui);
  assert.deepEqual(used,[...config.itemNames,'赤灵髓','碧灵髓']);
}));

test('all-stock checks occur only once per ten minutes and survive a restart', async () => fixture(async filename => {
  let now=1000000; const used=[];
  const ui={ consumeAllApproved:async name=>{used.push(name);return {before:11,after:0};} };
  let runner=new ConsumableRunner(config,filename,()=>{}, {now:()=>now});
  await runner.runIfDue(ui); assert.deepEqual(used,config.itemNames);
  now+=599999; runner=new ConsumableRunner(config,filename,()=>{}, {now:()=>now});
  await runner.runIfDue(ui); assert.equal(used.length,2);
  now++; await runner.runIfDue(ui); assert.equal(used.length,4);
}));

test('uncertain use is not repeated after timeout or process restart', async () => fixture(async filename => {
  const used=[];const now=1000000;
  const ui={consumeAllApproved:async name=>{used.push(name);throw Error('clicked but response timed out');}};
  await new ConsumableRunner(config,filename,()=>{}, {now:()=>now}).runIfDue(ui);
  await new ConsumableRunner(config,filename,()=>{}, {now:()=>now+10000}).runIfDue(ui);
  assert.equal(used.length,2);
  assert.equal(JSON.parse(await readFile(filename,'utf8')).nextAt,now+600000);
}));

test('reservation is persisted before the first use; empty inventory does not change the interval', async () => fixture(async filename => {
  let checked=0;
  const runner=new ConsumableRunner(config,filename,()=>{}, {now:()=>1000000});
  await runner.runIfDue({consumeAllApproved:async()=>{
    assert.equal(JSON.parse(await readFile(filename,'utf8')).nextAt,1600000);checked++;
    return {skipped:'快捷栏没有库存'};
  }});
  assert.equal(checked,2);await runner.runIfDue({consumeAllApproved:assert.fail});
}));

test('disabled feature or a corrupt schedule does not use items or throw into battle', async () => fixture(async filename => {
  await new ConsumableRunner({enabled:false},filename,()=>{}).runIfDue({consumeAllApproved:assert.fail});
  await writeFile(filename,'broken');const logs=[];
  await new ConsumableRunner(config,filename,m=>logs.push(m)).runIfDue({consumeAllApproved:assert.fail});
  assert.ok(logs.some(message=>message.includes('功能暂停')));
}));

test('layout interruption or sensitive state stops remaining uses and persists uncertain results', async () => {
  for (const ErrorType of [ViewRecoveryError, PauseError]) await fixture(async filename => {
    const used=[];const now=1000000;
    const ui={consumeAllApproved:async name=>{used.push(name);throw new ErrorType('使用后界面改变');}};
    const runner=new ConsumableRunner(config,filename,()=>{}, {now:()=>now});
    await assert.rejects(runner.runIfDue(ui),ErrorType);
    const saved=JSON.parse(await readFile(filename,'utf8'));
    assert.equal(saved.nextAt,now+600000);
    assert.equal(saved.results['莹灵髓'].uncertain,'使用后界面改变');
    assert.deepEqual(used,['莹灵髓']);
    await new ConsumableRunner(config,filename,()=>{}, {now:()=>now+5000}).runIfDue(ui);
    assert.deepEqual(used,['莹灵髓']);
  });
});
