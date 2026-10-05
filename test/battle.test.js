import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleRunner, entryOutcome, healthStatus, parseHealthNumber } from '../src/battle.js';
import { validateBattle } from '../src/battle-config.js';
import { PauseError, RetryError } from '../src/errors.js';
import { runTask } from '../src/task-runner.js';
import { sleep } from '../src/runtime.js';

const config = { characterName: '测试修士', target: { regionName: '北境', stageName: '银阶' }, pollIntervalSeconds: 5, healActionIntervalSeconds: 2 };
const rest = (current = '100', maximum = '100') => ({ character: '测试修士', mode: 'rest', region: '南境', location: '城镇', health: { current, maximum }, heal: { enabled: true, running: false } });
function harness(initial = rest(), options = {}) {
  let state = initial, now = 0;
  const calls = [];
  const ui = { observe: async () => structuredClone(state), heal: async () => { calls.push('heal'); }, returnToRest: async () => { calls.push('back'); }, retreatForTarget: async () => { calls.push('retreat'); state = rest('50'); }, enterTarget: async target => { calls.push(structuredClone(target)); state = { ...state, mode: 'combat', region: target.regionName, location: target.stageName }; return { kind: 'combat' }; } };
  const runner = new BattleRunner(ui, config, () => {}, { ...options, now: () => now });
  return { runner, ui, calls, set: value => { state = value; }, tick: async (ms = 5000) => { now += ms; return runner.step(); } };
}
test('battle config accepts arbitrary regions and stages and old missing config stays off', () => {
  assert.deepEqual(validateBattle(undefined), { enabled: false });
  const base = { ...config, enabled: true, appName: 'App', channelUrl: 'https://discord.com/channels/123/456' };
  assert.equal(validateBattle(base).target.stageName, '银阶');
  assert.equal(validateBattle({ ...base, target: { regionName: '新地图', stageName: '未预设的新关卡' } }).target.stageName, '未预设的新关卡');
  assert.throws(() => validateBattle({ ...base, healActionIntervalSeconds: 0 }), /至少/u);
  assert.throws(() => validateBattle({ ...base, target: { regionName: '' } }), /不能为空/u);
  assert.equal(validateBattle(base).healingTarget, undefined);
  assert.deepEqual(validateBattle({...base,healingTarget:{regionName:' 西境 ',locationName:' 泉室 '}}).healingTarget,{regionName:'西境',locationName:'泉室'});
  for (const healingTarget of [[], '泉室', {}, {regionName:'西境',locationName:''}]) assert.throws(()=>validateBattle({...base,healingTarget}));
});

test('battle timing can be fast without changing travel timing or allowing a busy loop', () => {
  const base = { ...config, enabled: true, appName: 'App', channelUrl: 'https://discord.com/channels/123/456' };
  const fast = validateBattle({ ...base, pollIntervalSeconds: 1, healActionIntervalSeconds: .5, actionDelaySeconds: .3 });
  assert.equal(fast.pollIntervalSeconds, 1); assert.equal(fast.healActionIntervalSeconds, .5); assert.equal(fast.actionDelaySeconds, .3);
  for (const [key, value] of [['pollIntervalSeconds', .1], ['healActionIntervalSeconds', 0], ['actionDelaySeconds', 0], ['actionDelaySeconds', NaN]]) assert.throws(() => validateBattle({ ...base, [key]: value }), /必须至少/u);
});

test('confirmed transitions yield immediately, while combat and ongoing healing keep a bounded poll', async () => {
  const h = harness({ ...rest('96'), heal: { enabled: false, running: true } });
  h.runner.config = { ...config, pollIntervalSeconds: 1, healActionIntervalSeconds: .5 };
  h.ui.stopHealing = async () => { h.calls.push('stop-heal'); h.set(rest('96')); };
  assert.equal((await h.tick()).delayMs, 0);
  assert.equal((await h.tick()).delayMs, 1000);
  assert.deepEqual(h.calls, ['stop-heal', config.target]);
  h.set({ ...rest('20'), heal: { enabled: false, running: true } });
  assert.equal((await h.tick()).delayMs, 1000);
  assert.deepEqual(h.calls, ['stop-heal', config.target]);
  h.set(rest('96'));
  h.ui.enterTarget = async () => { h.set(rest('1')); return { kind: 'returned' }; };
  assert.equal((await h.tick()).delayMs, 0);
  await h.tick(); assert.deepEqual(h.calls, ['stop-heal', config.target, 'heal']);
});

test('wounded ready/rest locations travel to the configured healer, then use the latest maximum', async () => {
  for (const mode of ['rest','ready']) {
    const h=harness({...rest('10'),mode});
    const target={regionName:'西境',locationName:'泉室'};
    h.runner.config={...config,healingTarget:target};
    h.ui.travelToHealing=async value=>{h.calls.push(value);h.set({...rest('10','200'),region:'西境',location:'泉室'});};
    await h.tick(); assert.deepEqual(h.calls,[target]);
    await h.tick(); assert.deepEqual(h.calls,[target,'heal']);
    h.set({...rest('190','300'),region:'西境',location:'泉室'});await h.tick();assert.deepEqual(h.calls,[target,'heal','heal']);
    h.set({...rest('286','300'),region:'西境',location:'泉室'});await h.tick();assert.deepEqual(h.calls,[target,'heal','heal',config.target]);
  }
});

test('full health skips the healer and combat damage never triggers a healing trip', async () => {
  const h=harness();h.runner.config={...config,healingTarget:{regionName:'西境',locationName:'泉室'}};
  h.ui.travelToHealing=assert.fail;
  await h.tick();await h.tick();assert.deepEqual(h.calls,[config.target]);
  h.set({...rest('1'),mode:'combat',region:'北境',location:'银阶'});
  await h.tick();assert.equal(h.calls.length,1);
});

test('uncertain healing travel is not repeated and arriving later recovers', async () => {
  const h=harness(rest('10'));h.runner.config={...config,healingTarget:{regionName:'西境',locationName:'泉室'}};
  h.ui.travelToHealing=async()=>{h.calls.push('travel');throw new RetryError('response timeout');};
  await assert.rejects(h.tick(),/timeout/u);await h.tick();assert.deepEqual(h.calls,['travel']);
  h.set({...rest('20'),region:'西境',location:'泉室',heal:{running:true,enabled:true}});
  await h.tick();assert.equal(h.runner.pendingHealingTravel,null);assert.deepEqual(h.calls,['travel']);
  const stuck=harness(rest('10'));stuck.runner.config=h.runner.config;
  stuck.ui.travelToHealing=async()=>{stuck.calls.push('travel');throw new RetryError('timeout');};
  await assert.rejects(stuck.tick());await assert.rejects(stuck.tick(30000),/未能确认安全到达/u);
  assert.deepEqual(stuck.calls,['travel']);
});
test('interrupted healing travel followed by confirmed target combat resumes monitoring without any click', async () => {
  const h=harness(rest('10'));h.runner.config={...config,healingTarget:{regionName:'西境',locationName:'泉室'}};
  h.ui.travelToHealing=async()=>{h.calls.push('travel');throw new RetryError('view interrupted');};
  await assert.rejects(h.tick(),/interrupted/u);
  const combat={...rest('7'),mode:'combat',region:'北境',location:'银阶',view:{activeTab:'游历',dialogs:[]}};
  for(const state of [{...combat,character:'别人'},{...combat,blocked:'存档冲突'},{...combat,location:'另一关'},{...combat,view:{activeTab:'行囊',dialogs:[]}},{...combat,view:{dialogs:[{title:'确认'}]}}]) {
    assert.equal(h.runner.reconcileHealingTravel(state),false);assert.ok(h.runner.pendingHealingTravel);
  }
  h.set(combat);await h.tick(40000);await h.tick();
  assert.equal(h.runner.pendingHealingTravel,null);assert.deepEqual(h.calls,['travel']);
  h.set(rest('10'));await assert.rejects(h.tick(),/interrupted/u);
  assert.deepEqual(h.calls,['travel','travel']); // A later death starts its own normal healing trip.
});

test('health parsing supports units, separators and changing maxima without rounded equality', () => {
  assert.equal(parseHealthNumber('1,234.5').value, 1234.5);
  assert.equal(parseHealthNumber('2亿').value, 2e8);
  assert.equal(parseHealthNumber('5.56万').exact, false);
  assert.equal(healthStatus({ current: '5.56万', maximum: '5.56万' }).ready, true);
  assert.equal(healthStatus({ current: '5.56万', maximum: '5.56万', percent: 99.99 }).full, false);
  assert.equal(healthStatus({ current: '5.56万', maximum: '5.56万', percent: 100 }).full, true);
  assert.equal(healthStatus({ current: '100', maximum: '101' }).full, false);
  assert.equal(healthStatus({ current: '100.00', maximum: '100.00', percent: 99.999 }).full, false);
  assert.throws(() => healthStatus({ current: '1', maximum: '0' }), PauseError);
  assert.throws(() => healthStatus({ current: '100', maximum: '100', percent: 95 }), /矛盾/u);
});
test('greater than 95 percent enters immediately, without two full-health observations', async () => {
  const h = harness(rest('96'));
  await h.tick(); assert.deepEqual(h.calls, [config.target]);
  for(const [current,maximum,ready] of [['95','100',false],['95.001','100',true],['190','200',false],['191','200',true],['191','300',false]])assert.equal(healthStatus({current,maximum}).ready,ready);
  assert.equal(healthStatus({current:'9.5万',maximum:'10万'}).ready,false);
  assert.equal(healthStatus({current:'9.6万',maximum:'10万'}).ready,true);
  assert.equal(healthStatus({current:'5.56万',maximum:'5.56万',percent:94.9}).ready,false);
});
test('continuous healing stops once above 95 percent, then rechecks latest HP before entering',async()=>{
  const h=harness({...rest('95'),heal:{running:true,enabled:false}});
  h.ui.stopHealing=async()=>{h.calls.push('stop-heal');h.set(rest('96'));};
  await h.tick();assert.deepEqual(h.calls,[]);
  h.set({...rest('96'),heal:{running:true,enabled:false}});await h.tick();assert.deepEqual(h.calls,['stop-heal']);
  h.set(rest('96','200'));await h.tick();assert.deepEqual(h.calls,['stop-heal','heal']);
  h.set(rest('191','200'));await h.tick();assert.deepEqual(h.calls,['stop-heal','heal',config.target]);
});
test('uncertain healing stop is observed without repeating the click',async()=>{
  const h=harness({...rest('96'),heal:{running:true,enabled:false}});
  h.ui.stopHealing=async()=>{h.calls.push('stop-heal');throw new RetryError('lost response');};
  await assert.rejects(h.tick(),/lost response/u);await h.tick();assert.deepEqual(h.calls,['stop-heal']);
  h.set(rest('96'));await h.tick();assert.deepEqual(h.calls,['stop-heal',config.target]);
});
test('combat in the configured stage and repeated clears never cause retreat', async () => {
  const h = harness({ ...rest('50'), mode: 'combat', region: '北境', location: '银阶' });
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(h.calls.length, 0);
  h.set(rest('50')); await h.tick(); assert.deepEqual(h.calls, ['heal']);
  h.set(rest()); await h.tick(); await h.tick();
  assert.deepEqual(h.calls, ['heal', config.target]);
});

test('another stage retreats immediately, heals, then enters the configured destination', async () => {
  for (const current of [{region:'北境',location:'别的关卡'},{region:'南境',location:'银阶'}]) {
    const h=harness({...rest('50'),mode:'combat',...current});
    await h.tick(); assert.deepEqual(h.calls,['retreat']);
    await h.tick(); assert.deepEqual(h.calls,['retreat','heal']);
    h.set(rest()); await h.tick(); await h.tick();
    assert.deepEqual(h.calls,['retreat','heal',config.target]);
  }
});

test('an uncertain retreat is re-read without another click, then recovers or pauses', async () => {
  const h=harness({...rest('50'),mode:'combat',location:'旧关卡'});
  h.ui.retreatForTarget=async()=>{h.calls.push('retreat');throw new RetryError('timeout');};
  await assert.rejects(h.tick(),/timeout/u);await h.tick();
  assert.deepEqual(h.calls,['retreat']);
  h.set(rest('50'));await h.tick();assert.deepEqual(h.calls,['retreat','heal']);
  const stuck=harness({...rest('50'),mode:'combat',location:'旧关卡'});
  stuck.ui.retreatForTarget=async()=>{stuck.calls.push('retreat');throw new RetryError('timeout');};
  await assert.rejects(stuck.tick()); await assert.rejects(stuck.tick(30000),/撤退后未能确认/u);
  assert.deepEqual(stuck.calls,['retreat']);
});

test('read-only or unidentified battle never retreats', async () => {
  const readOnly=harness({...rest(),mode:'combat',location:'旧关卡'},{readOnly:true});
  await readOnly.tick();assert.deepEqual(readOnly.calls,[]);
  const unknown=harness({...rest(),mode:'combat',region:'',location:'旧关卡'});
  await assert.rejects(unknown.tick(),/无法确认/u);assert.deepEqual(unknown.calls,[]);
});
test('continuous healing and cooldown do not cause toggle clicks; stagnant healing pauses', async () => {
  const h = harness({ ...rest('20'), heal: { enabled: false, running: true } });
  await h.tick(); await h.tick(59000); assert.equal(h.calls.length, 0);
  await assert.rejects(h.tick(1000), /60 秒/u);
  const cooling = harness({ ...rest('20'), heal: { enabled: false, running: false } });
  await cooling.tick(); assert.equal(cooling.calls.length, 0);
});
test('heal response timeout is not blindly repeated and progress permits recovery', async () => {
  const h = harness(rest('10'));
  h.ui.heal = async () => { h.calls.push('heal'); throw new RetryError('timeout'); };
  await assert.rejects(h.tick(), /timeout/u);
  await h.tick(); assert.deepEqual(h.calls, ['heal']);
  h.set({ ...rest('20'), heal: { enabled: false, running: true } });
  await h.tick(); assert.deepEqual(h.calls, ['heal']);
});
test('entry timeout re-reads combat without duplicate entry and rejects a wrong destination', async () => {
  const h = harness();
  h.ui.enterTarget = async target => { h.calls.push(target); throw new RetryError('timeout'); };
  await assert.rejects(h.tick(), /timeout/u);
  h.set({ ...rest(), mode: 'combat', region: '北境', location: '银阶' });
  await h.tick(); await h.tick(); assert.equal(h.calls.length, 1);
  const wrong = harness(); wrong.runner.pendingEntry = { at: 0, target: config.target };
  wrong.set({ ...rest(), mode: 'combat', region: '南境', location: '银阶' });
  await assert.rejects(wrong.tick(), /关卡与配置不符/u);
});

test('rest after an ambiguous entry heals immediately without battle feedback or another entry', async () => {
  const h = harness();
  h.ui.enterTarget = async target => { h.calls.push(target); throw new RetryError('response lost'); };
  await assert.rejects(h.tick(), /response lost/u);
  h.set(rest('10'));
  await h.tick();
  assert.equal(h.runner.pendingEntry, null);
  assert.deepEqual(h.calls, [config.target, 'heal']);
});
test('rest resumes regardless of old logs or HP change; previews and unknown views do not', () => {
  const before = { ...rest(), battleFeedback: { repeatStage: '银阶', defeats: ['old'] } };
  const attempt = { target: config.target, before };
  const fresh = { ...rest('10'), battleFeedback: { repeatStage: '银阶', defeats: ['old', 'new'] } };
  for (const state of [before, fresh, rest(), { ...fresh, battleFeedback: { repeatStage: '别的关卡', defeats: [] } }]) assert.equal(entryOutcome(state, attempt).kind, 'returned');
  for (const mode of ['ready', 'map', 'inventory', 'unknown']) assert.equal(entryOutcome({ ...fresh, mode }, attempt), null);
});

test('healthy rest after an ambiguous entry can re-enter without waiting for death evidence', async () => {
  const h = harness();
  h.runner.pendingEntry = { at: 0, target: config.target };
  h.ui.enterTarget = async target => { h.calls.push(target); return { kind: 'combat' }; };
  await h.tick();
  assert.deepEqual(h.calls, [config.target]);
  assert.equal(h.runner.pendingEntry, null);
});
test('confirmed entry does not require combat to remain visible at the next polling interval', async () => {
  for (const kind of ['combat', 'defeated']) {
    const h = harness();
    h.ui.enterTarget = async target => { h.calls.push(target); h.set(rest('5')); return { kind }; };
    await h.tick(); assert.equal(h.runner.pendingEntry, null);
    await h.tick(); assert.deepEqual(h.calls, [config.target, 'heal']);
  }
  const h = harness();
  h.ui.enterTarget = async (target, attempt) => { h.calls.push(target); attempt.combatConfirmed = true; h.set(rest('5')); throw new RetryError('late timeout'); };
  await assert.rejects(h.tick(), /late timeout/u);
  await h.tick(31000); assert.deepEqual(h.calls, [config.target, 'heal']);
});
test('unknown health, changed character and read-only mode never start a battle', async () => {
  const h = harness({...rest(),health:null});
  await assert.rejects(h.tick(), /气血暂不可读/u);
  h.set({ ...rest(), character: '别人' }); await assert.rejects(h.tick(), /角色不符/u);
  const readOnly = harness(rest('20'), { readOnly: true });
  for (let i = 0; i < 5; i++) await readOnly.tick();
  assert.equal(readOnly.calls.length, 0);
});
test('one task pausing or retrying does not block its sibling and stop cancels both', async () => {
  const abort = new AbortController();
  let pauses = 0, ticks = 0;
  const opts = { signal: abort.signal, config: { retrySeconds: [0.001], recoveryIntervalSeconds: 0.001 }, log() {}, pause: async () => { pauses++; await sleep(60000, abort.signal); } };
  const paused = runTask({ step: async () => { throw new PauseError('manual'); } }, opts);
  const active = runTask({ step: async () => { ticks++; return { delayMs: 1 }; } }, opts);
  await sleep(25); abort.abort(); await Promise.all([paused, active]);
  assert.equal(pauses, 1); assert.ok(ticks > 1);
});
