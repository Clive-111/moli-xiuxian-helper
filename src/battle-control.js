import { EventEmitter } from 'node:events';
import path from 'node:path';
import { atomicJson, readJson } from './control-store.js';
import { fetchCatalog, targetNode, saleShop } from './catalog.js';
import { BattleRunner, entryOutcome } from './battle.js';
import { runBattleIteration } from './battle-view.js';
import { ConsumableRunner, consumableStatePath } from './consumables.js';
import { PauseError, retryDelay } from './errors.js';
import { ControlInterrupted } from './control-errors.js';
import { LibraryUI, LIBRARY_VIEWS } from './library-ui.js';
import { LibraryImages } from './library-images.js';
import { CraftingControl } from './crafting-control.js';
import { InventoryControl } from './inventory-control.js';
import { fetchGameDefinitions } from './knowledge.js';
import { BestiaryUI } from './bestiary-ui.js';
import { bestiaryView, farmingPlan, marrowFarming, materialFarming, mapFarming, linkLibrary } from './farming.js';

export const LIBRARY_INTERVAL_MS = 60000;
export const LIBRARY_SYNC_VIEWS = ['inventory', 'crafting', 'bestiary'];

export function initialSettings(battle) {
  return { target: structuredClone(battle.target ?? null), healingTarget: structuredClone(battle.healingTarget ?? null),
    consumables: { enabled: battle.consumables?.enabled ?? false, itemNames: [...(battle.consumables?.itemNames ?? [])], intervalMinutes: 10, quantity: 'all' },
    ...(battle.saleTarget ? {saleTarget:structuredClone(battle.saleTarget)} : {}) };
}
export function validateSettings(value, catalog, {allowEmptyTarget=false}={}) {
  if (!value || typeof value !== 'object') throw new Error('设置不能为空');
  if (value.target) targetNode(catalog, value.target, 'battle');
  else if (!allowEmptyTarget) throw new Error('请先选择战斗目标并保存。');
  if (value.healingTarget) targetNode(catalog, value.healingTarget, 'healing');
  if (value.saleTarget) saleShop(catalog,value.saleTarget);
  const c = value.consumables;
  if (!c || typeof c.enabled !== 'boolean' || !Array.isArray(c.itemNames) || c.enabled && !c.itemNames.length || new Set(c.itemNames).size !== c.itemNames.length || c.itemNames.some(name => !catalog.items.some(i => i.name === name))) throw new Error('启用自动使用时，请选择目录中至少一种灵髓');
  return { target: value.target ? { regionName: value.target.regionName, stageName: value.target.stageName } : null,
    healingTarget: value.healingTarget ? { regionName: value.healingTarget.regionName, locationName: value.healingTarget.locationName } : null,
    consumables: { enabled: c.enabled, itemNames: [...c.itemNames], intervalMinutes: 10, quantity: 'all' },
    ...(value.saleTarget?{saleTarget:{regionName:value.saleTarget.regionName,locationName:value.saleTarget.locationName,shopName:value.saleTarget.shopName}}:{}) };
}

// Commands and the recurring tick share one promise tail. HTTP never touches Playwright.
export class BattleControl extends EventEmitter {
  constructor({ base, runtime, directory, makeUI, closeGamePage = async ui => { await ui?.page?.close({runBeforeUnload:false}); }, log, signal, diagnostics, catalogLoader = fetchCatalog, write = atomicJson, now = Date.now, libraryReader = ui => new LibraryUI(ui), craftingOptions, inventoryOptions, knowledgeLoader=fetchGameDefinitions, bestiaryReader=ui=>new BestiaryUI(ui) }) {
    super(); Object.assign(this, { base, runtime, directory, makeUI, closeGamePage, externalLog: log, signal, diagnostics, catalogLoader, write, now });
    this.tail = Promise.resolve(); this.pending = new Map(); this.logs = []; this.sequence = 0;
    this.phase = 'stopped'; this.reason = ''; this.nextTick = 0; this.failures = 0; this.stopRequests = 0;
    this.closeRequests = 0;
    this.dataSync = {phase:'idle',stage:'',completed:[],errors:{}};
    this.libraryReader=libraryReader;
    this.knowledgeLoader=knowledgeLoader;this.bestiaryReader=bestiaryReader;this.bestiaryError='';
    this.images=new LibraryImages(path.join(directory,'images'),runtime.browserProxyServer);
    this.library={version:1,revision:0,views:{},details:{}};
    this.libraryErrors={};
    this.crafting=new CraftingControl(this,craftingOptions);
    this.inventoryActions=new InventoryControl(this,inventoryOptions);
    this.log = message => {
      this.externalLog(message); this.logs.push({ id: ++this.sequence, at: this.now(), message });
      if (this.logs.length > 200) this.logs.shift(); this.publish();
    };
  }
  async initialize() {
    this.record = await readJson(path.join(this.directory, 'settings.json'));
    if (!this.record) {
      this.record = { version: 1, revision: 1, desired: this.base.enabled ? 'running' : 'stopped', settings: initialSettings(this.base) };
      await this.persist(this.record);
    }
    if (this.record.version !== 1 || !['running', 'stopped'].includes(this.record.desired) || !Number.isInteger(this.record.revision)) throw new Error('面板设置记录无效，未覆盖原文件');
    if (this.record.gameClosed != null && typeof this.record.gameClosed !== 'boolean') throw new Error('游戏关闭状态无效，未自动连接');
    if (this.record.gameClosed) {
      this.record = {...this.record, desired:'stopped'};
      await this.persist(this.record);
      await this.closeGamePage();
    }
    this.catalog = await readJson(path.join(this.directory, 'catalog.json'));
    if (this.catalog) validateSettings(this.record.settings, this.catalog, {allowEmptyTarget:this.record.desired==='stopped'});
    this.configure(this.record.settings);
    let library;
    try { library=await readJson(path.join(this.directory,'library.json')); }
    catch { this.libraryErrors={inventory:'上次查看缓存无法读取，请重新刷新',crafting:'上次查看缓存无法读取，请重新刷新'}; }
    if (library?.version===1 && library.views && library.details && Object.values(library.views).every(value=>Array.isArray(value?.items))) {
      this.library=library;
      for (const value of Object.values(library.views)) this.images.prepare(value);
      for (const value of Object.values(library.details)) this.images.register(value.imageSource);
    }
    try {this.knowledge=await readJson(path.join(this.directory,'knowledge.json'));this.bestiary=await readJson(path.join(this.directory,'bestiary.json'));}
    catch {this.bestiaryError='上次图鉴缓存无法读取，请刷新图鉴';}
    for(const entry of this.bestiary?.entries??[])entry.image=this.images.register(entry.imageSource);
    this.consumables = new ConsumableRunner(this.config.consumables, consumableStatePath(this.runtime.profilePath, this.base), this.log);
    const state = await readJson(this.consumables.filename);
    if (state) {
      if (state.version !== 1 || !Number.isFinite(state.nextAt)) throw new Error('灵髓计时记录无效，未重置计时');
      this.consumables.state = state;
    }
    this.phase = this.record.desired === 'running' ? 'checking' : 'stopped';
    await this.crafting.initialize();
    await this.inventoryActions.initialize();
    if(this.inventoryActions.active){this.phase='attention';this.reason='存在待处理物品清单，请仅核对结果或取消剩余；不会自动重放卖出或换装';}
    if(this.record.gameClosed){this.phase='closed';this.reason=this.closedReason();}
    this.needsPreflight = true;
    this.nextStatusRead = 0;
    this.timer = setInterval(() => {
      if(this.record.gameClosed || this.closeRequests) return;
      if(this.crafting.startupReviewId&&!this.signal.aborted&&!this.pending.size&&!this.tickQueued&&!this.stopRequests&&!this.inventoryActions.active){
        const operationId=this.crafting.startupReviewId;this.crafting.startupReviewId=null;this.command('craft-review',{operationId});return;
      }
      if(this.libraryDeferred?.automatic&&!this.automaticLibraryAllowed())this.libraryDeferred=null;
      if(this.libraryDeferred&&!this.signal.aborted&&!this.pending.size&&!this.tickQueued&&!this.stopRequests&&!this.crafting.active&&!this.inventoryActions.active&&!this.state?.blocked&&!this.state?.view?.dialogs?.length&&['running','stopped'].includes(this.phase)&&(this.record.desired==='stopped'||this.state?.mode==='combat')){
        const payload=this.libraryDeferred;this.libraryDeferred=null;this.command('library',payload,{continuation:true});return;
      }
      if (!this.signal.aborted && !this.tickQueued && !this.pending.size && this.record.desired === 'running' && this.phase !== 'attention' && this.now() >= this.nextTick) {
        this.tickQueued = true;
        void this.serial(() => this.tick()).finally(() => { this.tickQueued = false; });
      }
      if (this.statusReadAllowed() && !this.tickQueued && !this.pending.size && this.now() >= this.nextStatusRead) {
        this.tickQueued=true;
        void this.serial(()=>this.readStatus()).catch(()=>{}).finally(()=>{this.tickQueued=false;});
      }
    }, 250);
    this.signal.addEventListener('abort', () => this.close(), { once: true });
    this.log(`控制面板已接管战斗任务，保存的状态：${this.record.gameClosed ? '游戏已关闭，不自动连接' : this.record.desired === 'running' ? '运行' : '停止'}。`);
  }
  configure(settings) {
    this.config = { ...this.base, ...structuredClone(settings), enabled: true };
    if (this.ui) { this.ui.config = this.config; this.ui.consumables = this.config.consumables; }
    if (this.runner) this.runner.config = this.config;
    if (this.consumables) this.consumables.config = this.config.consumables;
  }
  persist(record) { return this.write(path.join(this.directory, 'settings.json'), record); }
  automaticLibraryAllowed() { return !this.record.gameClosed&&this.record.desired==='running'&&!this.stopRequests; }
  statusReadAllowed() {
    return !this.signal.aborted && !this.record?.gameClosed && !this.closeRequests && !this.stopRequests
      && this.record?.desired==='stopped' && ['stopped','attention'].includes(this.phase)
      && !this.crafting.active && !this.inventoryActions.active && typeof this.ui?.observeExisting==='function';
  }
  async readStatus() {
    // Never launch/recover/navigate from the stopped-state polling loop.
    if (this.record?.gameClosed || this.closeRequests || this.stopRequests || this.signal.aborted) return {skipped:'stopped'};
    if (!this.ui?.observeExisting) return {skipped:'no-browser'};
    try {
      const ui=this.ui,state=await ui.observeExisting();
      if (ui!==this.ui || this.record.gameClosed || this.closeRequests || this.stopRequests || this.signal.aborted) return {skipped:'stopped'};
      this.state=state;this.updatedAt=this.now();this.statusError='';
    } catch (error) {
      this.statusError=error.message.split('\n')[0];
      if (error instanceof PauseError && this.record.desired==='running') {this.phase='attention';this.reason=this.statusError;}
      throw error;
    } finally {this.nextStatusRead=this.now()+5000;this.publish();}
  }
  closedReason() {
    return '战斗游戏连接已关闭，可在其他设备游玩；点击「打开游戏」后才能操作。' +
      (this.inventoryActions.active||this.crafting.active ? ' 未确认操作记录已保留，重新打开后仅核对，不自动重做。' : '');
  }
  serial(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  snapshot() {
    return { phase: this.phase, desired: this.record?.desired, gameClosed: this.record?.gameClosed===true, closingGame: this.closeRequests>0, reason: this.reason, busy: this.activeCommand ?? null,
      revision: this.record?.revision, settings: this.record?.settings, state: this.state, updatedAt: this.updatedAt ?? null,statusError:this.statusError ?? '',dataSync:this.dataSync,
      catalog: this.catalog ?? null, catalogError: this.catalogError ?? '', logs: this.logs, lastCommand: this.lastCommand,
      library: {revision:this.library.revision,errors:this.libraryErrors,sync:{intervalMs:LIBRARY_INTERVAL_MS,nextAt:this.librarySyncAt??0,deferred:this.libraryDeferred?.views??[]},views:Object.fromEntries(Object.entries(this.library.views).map(([key,value])=>[key,{updatedAt:value.updatedAt,count:value.items.length}]))},
      bestiary:{revision:this.bestiary?.revision??0,updatedAt:this.bestiary?.updatedAt??null,error:this.bestiaryError,knowledgeRevision:this.knowledge?.revision??null},
      crafting:this.crafting.snapshot(),
      inventoryActions:this.inventoryActions.snapshot(),
      consumables: { ...this.consumables?.state, disabledReason: this.consumables?.disabled ? '记录写入失败，已暂停使用灵髓' : null } };
  }
  publish() { this.emit('change', this.snapshot()); }
  async connect(reconnect = false) {
    if(this.record.gameClosed) throw new ControlInterrupted('游戏已关闭，请先点击「打开游戏」；不会自动连接');
    this.ui = await this.makeUI(this.config, this.log, this.ui, reconnect);
    this.ui.getCatalog = () => this.catalog;
    this.ui.beforeAction = (label, {cleanup=false} = {}) => {
      const completing=cleanup&&(['sync','library','bestiary'].includes(this.activeCommand)||this.activeCommand?.startsWith('craft-')||this.activeCommand?.startsWith('inventory-'));
      if (this.signal.aborted || this.stopRequests && this.activeCommand !== 'stop' && !completing) throw new ControlInterrupted('已收到停止请求，禁止继续发起游戏操作');
      this.log(`操作：${label}`);
    };
    this.ui.onSnapshot = state => { this.state = state; this.updatedAt = this.now(); this.statusError=''; this.publish(); };
    if (!this.runner) this.runner = new BattleRunner(this.ui, this.config, this.log);
    else this.runner.ui = this.ui;
  }
  async refreshCatalog() {
    try {
      const next = await this.catalogLoader(this.runtime.browserProxyServer);
      if(this.catalog?.shops?.length&&!next.shops?.length)throw new Error('未读取到商店定义，保留上次有效目录');
      if(next.resourceUrl&&next.resourceUrl===this.catalog?.resourceUrl){
        next.nodes=next.nodes.map(node=>{const old=this.catalog.nodes.find(n=>n.id===node.id&&n.regionId===node.regionId&&n.name===node.name&&n.type===node.type);return old?{...node,availability:old.availability,checkedAt:old.checkedAt}:node;});
      }
      // Static extraction is saved even when login temporarily prevents account verification.
      await this.write(path.join(this.directory, 'catalog.json'), next);
      this.catalog = next; this.catalogError = '';
      this.log(`目录更新：${next.regions.length} 个区域、${next.nodes.length} 个地点、${next.items.length} 种灵髓。`);
    } catch (error) { this.catalogError = error.message; this.publish(); throw error; }
  }
  async inspect() {
    await this.connect();
    const next = await this.ui.inspectCatalog(this.catalog);
    await this.write(path.join(this.directory, 'catalog.json'), next);
    this.catalog = next; this.catalogError = ''; this.publish();
    this.log(`地图核实完成：${next.nodes.filter(n => n.availability === 'visible').length} 个当前可见地点。`);
  }
  async verify(settings) {
    if (!settings.target) throw new Error('请先选择战斗目标并保存。');
    if (!this.catalog) await this.refreshCatalog();
    validateSettings(settings, this.catalog);
    await this.inspect();
    for (const [target, type] of [[settings.target, 'battle'], [settings.healingTarget, 'healing']]) if (target) {
      const node = targetNode(this.catalog, target, type);
      if (node.availability !== 'visible') throw new PauseError(`${node.regionName} / ${node.name}：${node.availability === 'locked' ? '已锁定' : '尚未核实或未解锁'}，不会进入。`);
    }
  }
  reconcile(state) {
    const runner = this.runner;
    if (!runner || !state || !['combat', 'rest', 'ready'].includes(state.mode)) return;
    if (runner.pendingHealingStop && !state.heal?.running) runner.pendingHealingStop = null;
    if (runner.pendingRetreat && state.mode !== 'combat') runner.pendingRetreat = null;
    runner.reconcileHealingTravel(state);
    if (runner.pendingEntry && entryOutcome(state, runner.pendingEntry)) {
      runner.pendingEntry = null;
      if (state.mode === 'rest') this.log('当前已在休整地点，恢复按气血调息或再战的流程。');
    }
  }
  async tick() {
    if (this.signal.aborted || this.record.gameClosed || this.stopRequests || this.crafting.active || this.inventoryActions.active || this.record.desired !== 'running' || this.phase === 'attention') return;
    try {
      await this.connect();
      if (this.needsPreflight) { this.phase = 'checking'; await this.verify(this.record.settings); this.needsPreflight = false; }
      const result = await runBattleIteration(this.ui, this.runner, this.consumables, { diagnostics: reason => this.diagnostics?.(this.ui, reason) });
      this.reconcile(this.state);
      this.failures = 0; this.reason = '';
      this.phase = this.ui.viewRecovery ? 'recovering' : this.state?.mode === 'combat' ? 'running'
        : this.runner.pendingHealingTravel || this.runner.pendingEntry || this.runner.pendingRetreat || this.state?.mode === 'map' ? 'switching'
        : this.state?.heal?.running || this.runner.healing ? 'healing' : 'switching';
      this.nextTick = this.now() + (result?.delayMs ?? 5000);
    } catch (error) {
      if (error instanceof ControlInterrupted || this.signal.aborted) return;
      this.reason = error.message.split('\n')[0];
      this.log(`战斗${error instanceof PauseError ? '需要处理' : '暂缓'}：${this.reason}`);
      await Promise.resolve(this.diagnostics?.(this.ui, this.reason)).catch(() => {});
      if (error instanceof PauseError) this.phase = 'attention';
      else { this.phase = 'retrying'; this.nextTick = this.now() + retryDelay(++this.failures, this.runtime); }
    } finally { this.publish(); }
  }
  command(kind, payload = {}, {continuation=false}={}) {
    if(this.closeRequests&&kind!=='close-game')throw new ControlInterrupted('正在关闭游戏，请等待关闭完成');
    if (!['start', 'stop', 'resume', 'restart', 'open-game', 'close-game', 'status', 'sync', 'settings', 'refresh', 'library','bestiary','craft-preview','craft-execute','craft-review','craft-confirm','craft-sync','craft-delete','inventory-preview','inventory-execute','inventory-equip','inventory-review','inventory-continue','inventory-cancel'].includes(kind)) throw new Error('未知控制命令');
    if(kind==='library'&&payload.views!=null){
      if(!Array.isArray(payload.views)||!payload.views.length||payload.views.length>LIBRARY_SYNC_VIEWS.length||new Set(payload.views).size!==payload.views.length||payload.views.some(v=>!LIBRARY_SYNC_VIEWS.includes(v))||payload.key||payload.view)throw new Error('批量查看页面无效');
      payload={...payload,views:LIBRARY_SYNC_VIEWS.filter(v=>payload.views.includes(v))};
    }
    if (kind==='library' && ((!payload.views&&!Object.hasOwn(LIBRARY_VIEWS,payload.view)) || payload.key!=null && !/^[a-f0-9]{64}$/u.test(payload.key))) throw new Error('查看页面或物品标识无效');
    if (kind==='library' && (payload.automatic!=null && typeof payload.automatic!=='boolean' || payload.automatic && payload.key)) throw new Error('自动同步只允许读取列表');
    if(kind==='craft-preview'&&(!/^[a-f0-9]{64}$/u.test(payload.key??'')||payload.quantity!=='all'&&(!Number.isInteger(payload.quantity??1)||payload.quantity<1||payload.quantity>10000)))throw new Error('配方或炉数无效');
    if(['craft-execute','craft-review','craft-confirm','craft-sync','craft-delete'].includes(kind)&&! /^[a-f0-9-]{36}$/u.test(payload.previewId??payload.operationId??''))throw new Error('操作编号无效');
    if(kind==='craft-confirm'&&(payload.confirmed!==true||!Number.isSafeInteger(payload.reviewedAt)))throw new Error('需要明确确认本次核对记录');
    if(['inventory-execute','inventory-review','inventory-continue','inventory-cancel'].includes(kind)&&! /^[a-f0-9-]{36}$/u.test(payload.previewId??payload.operationId??''))throw new Error('物品操作编号无效');
    if(kind==='inventory-preview'&&(!['sell','equip'].includes(payload.kind)||payload.kind==='sell'&&(!Array.isArray(payload.ids)||!payload.ids.length||payload.ids.length>2000||payload.ids.some(id=>typeof id!=='string'||id.length>200))||payload.kind==='equip'&&(typeof payload.id!=='string'||payload.id.length>200)))throw new Error('物品选择无效');
    if(kind==='inventory-equip'&&(!/^[a-f0-9-]{36}$/u.test(payload.requestId??'')||typeof payload.id!=='string'||!/^instance:.+/u.test(payload.id)||payload.id.length>200||!['weapon','head','body','legs','feet','accessory','artifact','special'].includes(payload.slot)))throw new Error('换装编号或部位无效');
    if(['library','bestiary'].includes(kind)&&payload.automatic&&!this.automaticLibraryAllowed())return {id:0,kind,skipped:'stopped',promise:Promise.resolve({ok:true,skipped:'stopped'})};
    const pendingKey=kind==='library'?`${kind}:${payload.views?.join(',')??payload.view}:${payload.key??''}`:(kind.startsWith('craft-')||kind.startsWith('inventory-'))?`${kind}:${JSON.stringify(payload)}`:kind;
    if (this.pending.has(pendingKey)) {const job=this.pending.get(pendingKey);if(kind==='library'&&!payload.automatic)job.payload.automatic=false;return job;}
    if (kind==='library' && payload.automatic && !continuation) {
      const fresh=(payload.views??[payload.view]).every(view=>{const at=view==='bestiary'?this.bestiary?.updatedAt:this.library.views[view]?.updatedAt;return Number.isFinite(at)&&this.now()-at<LIBRARY_INTERVAL_MS;});
      const busy=this.activeCommand || this.pending.size || this.tickQueued || this.stopRequests || this.crafting.active || this.inventoryActions.active || this.libraryDeferred;
      const waiting=['checking','switching','healing','recovering','retrying','attention','stopping'].includes(this.phase);
      if (fresh || this.now()<(this.librarySyncAt??0) || busy || waiting) return {id:0,kind,skipped:fresh?'fresh':busy||waiting?'busy':'throttled',promise:Promise.resolve({ok:true})};
      // One global budget across all browser tabs, not one timer per client.
      this.librarySyncAt=this.now()+LIBRARY_INTERVAL_MS;
    }
    if (this.pending.size >= 10 && !['stop','close-game'].includes(kind)) throw new Error('操作正在排队，请稍后再试');
    let stopFence;
    if (['stop','close-game'].includes(kind)) {this.stopRequests++;stopFence=Promise.all([this.crafting.requestStop(),this.inventoryActions.requestStop()]);stopFence.catch(()=>{});}
    if(kind==='close-game'){this.closeRequests++;this.libraryDeferred=null;}
    if(kind==='inventory-cancel'){stopFence=this.inventoryActions.requestCancel(payload.operationId);stopFence.catch(()=>{});}
    const id = ++this.sequence;
    const job = { id, kind, promise: null, payload };
    this.pending.set(pendingKey, job);
    if(kind==='sync')this.dataSync={phase:'queued',stage:'',completed:[],errors:{}};
    job.promise = this.serial(async () => {
      this.activeCommand = kind; this.publish();
      try {
        if (this.signal.aborted) throw new Error('容器正在停止');
        if(stopFence)try{await stopFence;}catch(error){if(kind!=='close-game')throw error;this.log(`停止标记保存失败，仍关闭游戏连接：${error.message}`);}
        const result=await this.execute(kind, payload);
        this.lastCommand = { id, kind, ok: true, at: this.now(), ...(kind==='library'?{view:payload.view,key:payload.key,automatic:payload.automatic===true}: {}),...result };
      } catch (error) {
        this.lastCommand = { id, kind, ok: false, error: error.message.split('\n')[0], at: this.now(), ...(kind==='library'?{view:payload.view,key:payload.key,automatic:payload.automatic===true}: {}) };
        this.log(`控制操作未完成：${this.lastCommand.error}`);
        if (['start', 'resume', 'restart', 'stop','open-game','close-game'].includes(kind)) { this.phase = this.record.gameClosed&&kind!=='close-game'?'closed':'attention'; this.reason = this.lastCommand.error; }
        if (kind === 'refresh') this.catalogError = this.lastCommand.error;
        if (kind === 'sync') this.dataSync={...this.dataSync,phase:'paused',stage:'',errors:{...this.dataSync.errors,sync:this.lastCommand.error}};
        if (kind === 'library') {for(const view of payload.views??[payload.view]){if(view==='bestiary')this.bestiaryError=this.lastCommand.error;else this.libraryErrors[view]=this.lastCommand.error;}this.librarySyncAt=this.now()+LIBRARY_INTERVAL_MS;}
        if (kind === 'bestiary') this.bestiaryError=this.lastCommand.error;
      } finally {
        if (['stop','close-game'].includes(kind)) this.stopRequests--;
        if(kind==='close-game')this.closeRequests--;
        this.pending.delete(pendingKey); this.activeCommand = null; this.publish();
      }
      return this.lastCommand;
    });
    return job;
  }
  async execute(kind, payload) {
    // Recheck at execution: a request can have been queued before Stop, or sent
    // by an older panel that still refreshes while the battle task is stopped.
    if(['library','bestiary'].includes(kind)&&payload.automatic&&!this.automaticLibraryAllowed())return {skipped:'stopped'};
    if(kind==='close-game')return this.disconnectGame();
    // Cancel older queued commands too, while allowing the in-flight operation
    // to finish its existing result/save checks before the close queue boundary.
    if(this.closeRequests)throw new ControlInterrupted('正在关闭游戏，已取消尚未开始的操作');
    if(kind==='open-game'){
      if(!this.record.gameClosed)return {already:true};
      const record={...this.record,gameClosed:false,desired:'stopped'};
      await this.persist(record);this.record=record;
      this.phase='checking';this.reason='';this.publish();
      await this.connect(true);
      for(let attempt=0;;attempt++){
        try {this.reconcile(await this.ui.observe({allowObstructed:true}));break;}
        catch(error){
          if(!error.launchStateChanged||attempt>=2||this.stopRequests||this.closeRequests||this.signal.aborted)throw error;
          this.log('Discord 应用菜单已变化，重新确认当前启动状态。');
        }
      }
      this.phase=this.inventoryActions.active||this.crafting.active?'attention':'stopped';
      this.reason=this.phase==='attention'?'已打开游戏，原操作仍待核对，不会自动重做。':'';
      this.needsPreflight=true;
      this.log('已打开战斗游戏；挂机保持停止，可手动操作或点击启动挂机。');return;
    }
    if(this.record.gameClosed){
      if(kind==='stop'){this.phase='closed';this.reason=this.closedReason();return;}
      throw new ControlInterrupted('游戏已关闭，请先点击「打开游戏」；不会自动连接');
    }
    if(kind==='status'){
      if(this.stopRequests)throw new ControlInterrupted('正在停止，请稍后读取状态');
      await this.connect();return this.readStatus();
    }
    if(kind==='sync')return this.syncAll();
    // These two operations only edit panel settings / download public definitions.
    // They are safe while a batch is paused and never resume or alter its lines.
    if(kind==='refresh'&&payload.shopsOnly===true){await this.refreshCatalog();this.publish();return;}
    if(kind==='settings'&&Object.hasOwn(payload,'saleTarget')){
      if(payload.revision!==this.record.revision)throw new Error('设置已在另一页面修改，请重新载入后保存');
      const shop=saleShop(this.catalog,payload.saleTarget);
      const saleTarget={regionName:shop.regionName,locationName:shop.locationName,shopName:shop.name};
      const record={...this.record,revision:this.record.revision+1,settings:{...this.record.settings,saleTarget}};
      await this.persist(record);this.record=record;this.config.saleTarget=saleTarget;
      this.log(`默认卖出地点已保存：${shop.regionName} / ${shop.locationName} / ${shop.name}；现有批次不自动改店或继续。`);return;
    }
    if(kind.startsWith('inventory-')){
      if(this.crafting.active)throw new Error('炼制结果仍待核对，暂不操作物品');
      const method={'inventory-preview':'prepare','inventory-execute':'execute','inventory-equip':'equip','inventory-review':'review','inventory-continue':'continue','inventory-cancel':'cancel'}[kind];
      return this.inventoryActions[method](payload);
    }
    if(this.inventoryActions.active&&kind!=='stop')throw new Error('物品清单尚未结束，请仅核对结果、继续剩余或取消剩余');
    if(kind==='craft-delete')return this.crafting.remove(payload);
    if(this.crafting.active&&!['stop','craft-review','craft-confirm','craft-sync','craft-execute'].includes(kind))throw new Error('上一笔炼制待核对，暂缓其他战斗操作；请使用「仅核对结果」');
    if(kind==='craft-preview')return this.crafting.prepare(payload);
    if(kind==='craft-execute')return this.crafting.execute(payload);
    if(kind==='craft-review'||kind==='craft-sync')return this.crafting.retry(payload); // Legacy sync also only reviews local results.
    if(kind==='craft-confirm')return this.crafting.confirm(payload);
    if(kind==='bestiary')return this.readBestiary(payload);
    if(kind==='library'&&payload.views)return this.readLibraryBatch(payload);
    if (kind==='library') {
      if (this.stopRequests) throw new ControlInterrupted('正在停止战斗，稍后再查看');
      const selected=payload.key?this.library.views[payload.view]?.items.find(item=>item.key===payload.key):null;
      if (payload.key && !selected) throw new Error('未找到该物品，请先刷新列表');
      await this.connect();
      const state=await this.ui.observe({allowObstructed:true});
      this.reconcile(state);
      if (payload.automatic && (this.stopRequests || this.crafting.active || this.inventoryActions.active || state.blocked || state.view?.dialogs?.length || this.record.desired==='running' && state.mode!=='combat')) return {skipped:'等待游戏操作完成后自动同步'};
      if (this.runner.pendingEntry || this.runner.pendingHealingTravel || this.runner.pendingRetreat || this.runner.healPending || this.runner.pendingHealingStop) throw new Error('上一游戏动作仍在核实，请稍后刷新');
      const raw=await this.libraryReader(this.ui).read(payload.view,selected);
      if(raw.detail?.ingredients?.length){
        const inventory=await this.libraryReader(this.ui).read('inventory');
        for(const group of raw.detail.ingredients)for(const candidate of group.candidates??[]){const item=inventory.items.find(i=>i.identity===candidate.id);if(item){candidate.imageSource=item.imageSource;candidate.image=this.images.register(item.imageSource);}}
        await this.cacheLibrary('inventory',inventory);
      }
      const result=await this.cacheLibrary(payload.view,raw),{detail}=result;
      this.log(`${LIBRARY_VIEWS[payload.view].tab}查看完成：${result.items.length} 项${detail?`，已读取「${detail.name}」详情`:''}；已返回游历。`);
      if (this.record.desired==='running') this.nextTick=0;
      return;
    }
    if (kind === 'stop') {
      this.libraryDeferred=null;
      const record = { ...this.record, desired: 'stopped' };
      try { await this.persist(record); }
      catch (error) { this.phase = 'attention'; this.record = record; throw new Error(`自动操作已停止，但停止状态无法保存：${error.message}；请勿重启容器`); }
      this.record = record; this.phase = 'stopping'; this.reason = ''; this.publish();
      if(this.inventoryActions.active){this.phase='attention';this.reason='自动操作已停止，已发出的物品操作仍待核对';return;}
      if(this.crafting.active){this.phase='attention';this.reason='自动操作已停止；炼制保存仍待核对，请使用「仅核对结果」';return;}
      try {
        await this.connect();
        const result = await this.ui.ensureMonitoringView();
        if (!result.ready) throw new Error('界面无法恢复');
        this.reconcile(await this.ui.observe());
        // If an earlier retreat timed out, only observe. Never issue it twice.
        if (this.state.mode === 'combat' && this.runner.pendingRetreat) throw new Error('上次撤退结果仍未确认');
        if (this.state.mode === 'combat') {
          this.runner.pendingRetreat = { at: this.now() };
          try { await this.ui.retreatForTarget(this.config.target, { force: true }); }
          catch (error) { if (error.beforeRetreat) this.runner.pendingRetreat = null; throw error; }
        }
        const state = await this.ui.observe();
        if (!['rest', 'ready'].includes(state.mode)) throw new Error('仍未确认离开战斗');
        for (const key of ['pendingRetreat', 'pendingEntry', 'pendingHealingTravel', 'healPending', 'pendingHealingStop', 'healing']) this.runner[key] = null;
        this.phase = 'stopped'; this.reason = '';
        this.log('已确认撤退并停止战斗挂机；页面保留，游历继续。');
      } catch (error) {
        // A click may have succeeded despite timeout. Read once more before reporting uncertainty.
        const state = await this.ui?.observe().catch(() => null);
        if (state && ['rest', 'ready'].includes(state.mode)) {
          for (const key of ['pendingRetreat', 'pendingEntry', 'pendingHealingTravel', 'healPending', 'pendingHealingStop', 'healing']) this.runner[key] = null;
          this.phase = 'stopped'; this.reason = ''; this.log('重新读取已确认离开战斗，挂机已停止。');
        }
        else throw new Error(`自动操作已停止，撤退未确认：${error.message}`);
      }
      return;
    }
    if (kind === 'refresh') {
      // A failed account scan must not erase the last usable catalog.
      const next = await this.catalogLoader(this.runtime.browserProxyServer);
      if(this.catalog?.shops?.length&&!next.shops?.length)throw new Error('未读取到商店定义，保留上次有效目录');
      await this.connect();
      const checked = await this.ui.inspectCatalog(next);
      await this.write(path.join(this.directory, 'catalog.json'), checked);
      this.catalog = checked; this.catalogError = ''; this.publish();
      this.log(`目录刷新完成：${checked.regions.length} 个区域、${checked.nodes.length} 个地点、${checked.items.length} 种灵髓。`);
      if(this.knowledge&&this.bestiary&&(this.knowledge.resourceUrl!==checked.resourceUrl||this.bestiary.resourceUrl!==checked.resourceUrl||this.bestiary.knowledgeRevision!==this.knowledge.revision)){
        try{await this.readBestiary();}
        catch(error){this.bestiaryError=error.message;this.publish();throw new Error(`地点目录已更新，推荐资料尚未同步：${error.message}`);}
      }
      return;
    }
    if (kind === 'settings') {
      if (payload.revision !== this.record.revision) throw new Error('设置已在另一页面修改，请重新载入后保存');
      const settings = validateSettings(payload.settings, this.catalog);
      await this.connect();
      this.reconcile(await this.ui.observe({ allowObstructed: true }));
      if (this.runner.pendingEntry || this.runner.pendingHealingTravel || this.runner.pendingRetreat) throw new Error('上一动作尚未确认，暂不应用设置；请先恢复任务');
      await this.verify(settings);
      const record = { ...this.record, revision: this.record.revision + 1, settings };
      await this.persist(record); // Active config changes only after the durable write.
      this.record = record; this.configure(settings); this.nextTick = 0;
      this.log(`设置已生效：战斗 ${settings.target.regionName} / ${settings.target.stageName}；调息 ${settings.healingTarget?.locationName ?? '就地'}；灵髓 ${settings.consumables.enabled ? settings.consumables.itemNames.join('、') : '关闭（保留名单和计时）'}。`);
      return;
    }
    // Start/resume/restart never close the shared browser or reset consumable records.
    await this.connect(kind === 'restart');
    this.ui.viewRecovery = null;
    await this.verify(this.record.settings);
    this.reconcile(await this.ui.observe());
    if (kind === 'restart') {
      const old = this.runner;
      this.runner = new BattleRunner(this.ui, this.config, this.log);
      for (const key of ['pendingEntry', 'pendingRetreat', 'pendingHealingTravel', 'healPending', 'pendingHealingStop', 'healing', 'lastHealAt']) this.runner[key] = old[key];
    }
    const record = { ...this.record, desired: 'running' };
    await this.persist(record); this.record = record;
    await this.crafting.clearStop();
    await this.inventoryActions.clearStop();
    this.phase = 'checking'; this.reason = ''; this.failures = 0; this.needsPreflight = false; this.nextTick = 0;
    this.log('战斗任务已恢复；先读取实际状态，沿用原灵髓计时。');
  }
  async disconnectGame() {
    this.libraryDeferred=null;
    const record={...this.record,desired:'stopped',gameClosed:true};
    let saveError;
    try{await this.persist(record);}catch(error){saveError=error;}
    // Even disk failure must stop this process reconnecting, but is not reported
    // as a durable close. Never discard pending transaction/navigation evidence.
    this.record=record;this.phase='closing';this.reason='正在关闭战斗游戏连接';this.publish();
    await this.closeGamePage(this.ui);
    this.ui=null;this.needsPreflight=true;
    this.statusError='';
    this.phase='closed';this.reason=this.closedReason();
    this.log('战斗游戏页面已关闭；面板、登录资料和原游历保留，不再自动连接。');
    if(saveError)throw new Error(`游戏已断开，但关闭状态无法保存：${saveError.message}；请勿重启容器，修复后重新点击关闭游戏`);
  }
  async cacheLibrary(kind,raw){
    const result=this.images.prepare(linkLibrary({...raw,view:kind},this.knowledge)),{detail,...view}=result;
    const details={...this.library.details,...(detail?{[detail.key]:detail}:{})};
    const entries=Object.entries(details).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,200);
    const next={version:1,revision:this.library.revision+1,views:{...this.library.views,[kind]:view},details:Object.fromEntries(entries)};
    await this.write(path.join(this.directory,'library.json'),next);this.library=next;delete this.libraryErrors[kind];this.publish();return result;
  }
  async syncAll() {
    const completed=[],errors={};
    this.dataSync={phase:'reading',stage:'',completed,errors};this.publish();
    try {
      for(const stage of ['catalog',...LIBRARY_SYNC_VIEWS]) {
        this.dataSync.stage=stage;this.publish();
        try {
          if(this.signal.aborted||this.stopRequests||this.closeRequests||this.record.gameClosed)throw new ControlInterrupted('已停止剩余资料读取');
          if(this.crafting.active||this.inventoryActions.active)throw new PauseError('存在待核对的物品操作，请先处理后再刷新资料');
          await this.connect();
          const state=await this.ui.observe({allowObstructed:true});this.reconcile(state);
          if(state.character!==this.config.characterName||state.blocked||state.view?.dialogs?.length)throw new PauseError('当前人物或游戏弹窗需要确认，资料读取已暂停');
          if(this.runner.pendingEntry||this.runner.pendingHealingTravel||this.runner.pendingRetreat||this.runner.healPending||this.runner.pendingHealingStop)throw new PauseError('上一游戏动作仍在核实，请稍后刷新资料');
          await this.execute(stage==='catalog'?'refresh':stage==='bestiary'?'bestiary':'library',{view:stage});
          completed.push(stage);
        } catch(error) {
          errors[stage]=error.message.split('\n')[0];
          if(stage==='catalog')this.catalogError=errors[stage];
          else if(stage==='bestiary')this.bestiaryError=errors[stage];
          else this.libraryErrors[stage]=errors[stage];
          if(error instanceof PauseError||error instanceof ControlInterrupted||this.signal.aborted)throw error;
        }
        this.publish();
      }
      this.dataSync.phase=Object.keys(errors).length?'partial':'done';
      this.dataSync.updatedAt=this.now();
      this.librarySyncAt=this.now()+LIBRARY_INTERVAL_MS;
      return {completed,errors,...(Object.keys(errors).length?{partial:true}:{})};
    } catch(error) {this.dataSync.phase='paused';throw error;}
    finally {this.dataSync.stage='';this.publish();}
  }
  async readLibraryBatch(payload){
    this.libraryDeferred=null;const errors={},completed=[];
    for(let i=0;i<payload.views.length;i++){
      if(payload.automatic&&!this.automaticLibraryAllowed())return {completed,errors,skipped:'stopped'};
      if(this.stopRequests||this.signal.aborted)throw new ControlInterrupted('正在停止，取消剩余读取');
      await this.connect();const state=await this.ui.observe({allowObstructed:true});this.reconcile(state);
      const pending=this.runner.pendingEntry||this.runner.pendingHealingTravel||this.runner.pendingRetreat||this.runner.healPending||this.runner.pendingHealingStop;
      if(pending&&this.record.desired==='stopped')throw new Error('上一游戏动作仍在核实，请处理后重新刷新');
      if(pending||this.record.desired==='running'&&state.mode!=='combat'){
        if(!['attention','recovering'].includes(this.phase)&&!state.blocked&&!state.view?.dialogs?.length)this.libraryDeferred={views:payload.views.slice(i),automatic:payload.automatic===true};
        else throw new Error('游戏需要人工处理，刷新已暂停');
        this.nextTick=0;this.publish();return {completed,deferred:true,errors};
      }
      const view=payload.views[i];
      try{const result=await this.execute(view==='bestiary'?'bestiary':'library',{view,automatic:payload.automatic===true});if(result?.skipped){this.libraryDeferred={views:payload.views.slice(i),automatic:payload.automatic===true};return {completed,deferred:true,errors};}completed.push(view);}
      catch(error){errors[view]=error.message;if(view==='bestiary')this.bestiaryError=error.message;else this.libraryErrors[view]=error.message;if(error instanceof ControlInterrupted)throw error;}
    }
    this.librarySyncAt=this.now()+LIBRARY_INTERVAL_MS;
    return {completed,errors,...(Object.keys(errors).length?{partial:true}: {})};
  }
  async readBestiary({automatic=false}={}){
    if(automatic&&!this.automaticLibraryAllowed())return {skipped:'stopped'};
    if(this.stopRequests)throw new ControlInterrupted('正在停止，请稍后读取图鉴');
    const loaded=await this.knowledgeLoader(this.runtime.browserProxyServer);
    // Keep the single-projection loader supported for existing embedders/tests.
    const knowledge=loaded.knowledge??loaded, definitionCatalog=loaded.catalog;
    if(definitionCatalog&&definitionCatalog.resourceUrl!==knowledge.resourceUrl)throw new Error('地图与掉落定义不是同一资源版本，保留原资料');
    if(automatic&&!this.automaticLibraryAllowed())return {skipped:'stopped'};
    await this.connect();const state=await this.ui.observe({allowObstructed:true});this.reconcile(state);
    if(this.stopRequests||this.signal.aborted)throw new ControlInterrupted('正在停止，取消图鉴读取');
    if(automatic&&(state.blocked||state.view?.dialogs?.length||this.record.desired==='running'&&state.mode!=='combat'))return {skipped:'等待游戏操作完成后自动同步图鉴'};
    if(this.runner.pendingEntry||this.runner.pendingHealingTravel||this.runner.pendingRetreat||this.runner.healPending||this.runner.pendingHealingStop)throw new Error('上一游戏动作仍在核实，请稍后刷新图鉴');
    const raw=await this.bestiaryReader(this.ui).read();
    if(raw.resourceUrl!==knowledge.resourceUrl)throw new Error('游戏页面与公开资源版本不一致，请先刷新游戏后重试；已保留旧图鉴');
    let catalog=this.catalog;
    if(definitionCatalog&&(catalog?.resourceUrl!==knowledge.resourceUrl||!catalog.checkedAt)){
      if(this.stopRequests||this.signal.aborted)throw new ControlInterrupted('正在停止，取消推荐资料同步');
      if(catalog?.shops?.length&&!definitionCatalog.shops?.length)throw new Error('未读取到商店定义，保留上次推荐资料');
      // Never carry old unlocked flags across resource versions or merely
      // relabel the old catalog URL. Inspect the freshly parsed nodes in-game.
      catalog=await this.ui.inspectCatalog(definitionCatalog);
      if(catalog.resourceUrl!==knowledge.resourceUrl)throw new Error('地图核实版本已变化，保留原推荐资料');
    }
    const unknown=[],entries=[];
    for(const seen of raw.entries){const matches=knowledge.enemies.filter(e=>e.name===seen.name);if(matches.length!==1){unknown.push(seen.name);continue;}
      const enemy=matches[0],names=[...new Set(enemy.loot.filter(l=>Number(l.chance)>0).map(l=>knowledge.items.find(i=>i.id===l.itemId)?.name))];
      if(names.some(name=>!seen.lootText.includes(name))){unknown.push(seen.name+'（掉落定义不一致）');continue;}
      entries.push({...seen,id:enemy.id,image:this.images.register(seen.imageSource)});
    }
    const bestiary={version:1,revision:(this.bestiary?.revision??0)+1,knowledgeRevision:knowledge.revision,...raw,entries,unknown};
    if(this.stopRequests||this.signal.aborted)throw new ControlInterrupted('正在停止，取消推荐资料同步');
    if(catalog!==this.catalog)await this.write(path.join(this.directory,'catalog.json'),catalog);
    await this.write(path.join(this.directory,'knowledge.json'),knowledge);await this.write(path.join(this.directory,'bestiary.json'),bestiary);
    const catalogChanged=catalog!==this.catalog;
    this.knowledge=knowledge;this.bestiary=bestiary;this.catalog=catalog;this.bestiaryError='';if(catalogChanged)this.catalogError='';this.nextTick=0;this.publish();
    if(catalogChanged)this.log(`推荐资料版本已同步：地图 ${catalog.nodes.length} 个地点，已重新核实可用状态。`);
    this.log(`图鉴读取完成：${entries.length} 种已遭遇敌人，${unknown.length} 项待核实；已返回游历。`);
  }
  getBestiary(){return {...bestiaryView(this.knowledge,this.bestiary,this.catalog),error:this.bestiaryError};}
  planFarming(payload){return farmingPlan(this,payload);}
  planMarrow(payload){return marrowFarming(this,payload);}
  planMaterials(payload){return materialFarming(this,payload);}
  planMaps(payload){return mapFarming(this,payload);}
  close() { clearInterval(this.timer); this.publish(); }
}
