import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BattleControl, initialSettings } from './battle-control.js';
import { readJson, atomicJson } from './control-store.js';
import { LibraryImages } from './library-images.js';
import { CraftingControl } from './crafting-control.js';
import { InventoryControl } from './inventory-control.js';

const bindingValid = b => b?.version === 1 && /^[a-f0-9-]{36}$/u.test(b.id ?? '')
  && typeof b.characterName === 'string' && b.characterName.trim() === b.characterName && b.characterName.length > 0 && b.characterName.length <= 200;
async function entries(directory) {
  try { return await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Bootstrap uses BattleControl's promise tail. Before binding, no task timer or
// character cache is loaded; after binding, the existing controller owns them.
export class SetupControl extends BattleControl {
  constructor(options) {
    super(options);
    this.dataRoot = options.directory;
    this.record = {version:1,revision:0,desired:'stopped',settings:initialSettings(options.base)};
    this.phase = 'setup';
    this.browserEpoch = 0;
  }
  get isBound() { return Boolean(this.binding && this.initialized); }
  getSetup() {
    return {bound:this.isBound,characterName:this.binding?.characterName ?? null,
      candidate:this.candidate ? {characterName:this.candidate.characterName,token:this.candidate.token} : null,
      channelUrl:this.base.channelUrl,appName:this.base.appName,
      browserClosed:this.browserClosed === true,
      browserViewPort:this.runtime.browserViewPort ?? null};
  }
  snapshot() { return {...super.snapshot(),setup:this.getSetup()}; }
  handleBrowserClosed() {
    this.browserEpoch++;
    this.browserClosed = true;
    this.candidate = null;
    this.log('独立浏览器已关闭；控制面板保持运行，等待手动重新打开游戏。');
    // Bound characters use the existing stop fences and durable close record,
    // preserving uncertain transactions and cancelling queued game operations.
    if (this.binding) return super.command('close-game').promise;
    return this.serial(async () => {
      // A confirmation may have finished saving while the window was closing.
      if (this.binding) return this.disconnectGame();
      this.ui = null;
      this.phase = 'setup';
      this.reason = '游戏窗口已关闭，控制面板仍在运行。点击「打开游戏 / 登录」即可重新打开。';
      this.publish();
    });
  }
  async initialize() {
    this.binding = await readJson(path.join(this.dataRoot,'identity.json'));
    if (!this.binding) {
      if ((await entries(this.dataRoot)).length) throw new Error('数据目录包含未绑定的旧记录，不能自动认领；请使用新的独立数据目录。');
      this.initialized = true;
      this.reason = '请打开游戏，手动登录后读取并确认绑定人物。';
      return;
    }
    await this.initializeBound();
    if(!this.record.gameClosed&&!this.inventoryActions.active&&!this.crafting.active)this.queueDataSync();
  }
  async initializeBound() {
    const b = this.binding;
    if (!bindingValid(b) || b.channelUrl !== this.base.channelUrl || b.appName !== this.base.appName) throw new Error('人物绑定记录与当前频道或游戏不符；未读取旧库存和操作历史。请使用独立运行目录。');
    const directory = path.join(this.dataRoot,'profiles',b.id);
    const owner = await readJson(path.join(directory,'owner.json'));
    if (owner) {
      if (['version','id','channelUrl','appName','characterName'].some(k => owner[k] !== b[k])) throw new Error('缓存和操作历史的归属不符，已阻止加载。');
    } else {
      if ((await entries(directory)).length) throw new Error('缓存目录缺少归属记录，未自动认领。');
      await atomicJson(path.join(directory,'owner.json'),b);
    }
    this.directory = directory;
    this.base = {...this.base,characterName:b.characterName,enabled:false,target:null,healingTarget:null,consumables:{enabled:false,itemNames:[],intervalMinutes:10,quantity:'all'}};
    await this.images.close();
    this.images = new LibraryImages(path.join(directory,'images'),this.runtime.browserProxyServer);
    this.crafting = new CraftingControl(this);
    this.inventoryActions = new InventoryControl(this);
    await super.initialize();
    this.initialized = true;
    this.candidate = null;
    if (!this.record.gameClosed && !this.record.settings.target) this.reason = '人物已绑定；资料读取完成后，选择战斗目标并保存，再启动挂机。';
    this.publish();
  }
  queueDataSync() {
    try {
      if(this.stopRequests||this.closeRequests||this.signal.aborted)throw new Error('已收到停止请求，未继续自动读取资料');
      this.command('sync');
    }
    catch(error) { this.dataSync={phase:'paused',stage:'',completed:[],errors:{sync:error.message}};this.publish(); }
  }
  async execute(kind,payload) {
    const result=await super.execute(kind,payload);
    if(kind==='open-game'){this.browserClosed=false;this.queueDataSync();}
    return result;
  }
  command(kind,payload={},options={}) {
    if (!this.initialized) throw Object.assign(new Error('面板正在初始化，请稍后重试。'),{statusCode:409});
    if (!kind.startsWith('setup-')) {
      if (!this.isBound) throw Object.assign(new Error('请先读取并确认绑定人物。'),{statusCode:409});
      return super.command(kind,payload,options);
    }
    if (!['setup-open-game','setup-detect','setup-bind'].includes(kind)) throw new Error('未知设置操作。');
    if (this.binding) throw new Error('当前目录已经绑定人物；换号请使用独立运行目录。');
    if (this.browserClosed && kind !== 'setup-open-game') throw new Error('游戏窗口已关闭，请先点击「打开游戏 / 登录」。');
    if (this.pending.has(kind)) return this.pending.get(kind);
    if (this.pending.size >= 3) throw new Error('设置操作正在排队。');
    const job = {id:++this.sequence,kind,payload,browserEpoch:this.browserEpoch};
    this.pending.set(kind,job);
    job.promise = this.serial(async () => {
      this.activeCommand = kind;
      this.reason = kind === 'setup-open-game' ? '正在打开独立浏览器窗口…' : kind === 'setup-detect' ? '正在读取人物；如浏览器提示登录、授权或存档选择，请手动完成。' : '正在重新核对人物并保存绑定…';
      this.publish();
      try {
        this.signal.throwIfAborted();
        // Recheck inside the queue: a previous confirmation may have bound it.
        if (this.binding) throw new Error('人物已绑定，请刷新页面。');
        const checkBrowser = () => { if (job.browserEpoch !== this.browserEpoch) throw new Error('游戏窗口已关闭，请重新打开后读取人物。'); };
        checkBrowser();
        if (kind === 'setup-open-game') this.browserClosed = false;
        this.ui = await this.makeUI(this.base,this.log,this.ui,false);
        checkBrowser();
        if (kind === 'setup-open-game') {
          await this.ui.openForLogin();
          checkBrowser();
          this.reason = '浏览器已打开。请在浏览器中手动登录 Discord；完成后回到面板点击「读取人物」。首次授权或存档选择也需手动完成。';
        }
        else {
          const name = await this.ui.detectCharacter();
          checkBrowser();
          if (kind === 'setup-detect') {
            this.candidate = {characterName:name,token:randomUUID(),at:this.now()};
            this.reason = '已读取人物「'+name+'」，请核对完整姓名后确认绑定。';
          } else {
            if (!this.candidate || payload.token !== this.candidate.token || this.now()-this.candidate.at > 300000 || name !== this.candidate.characterName) {
              this.candidate = null;
              throw new Error('人物已变化或确认已过期，请重新读取。');
            }
            const binding = {version:1,id:randomUUID(),channelUrl:this.base.channelUrl,appName:this.base.appName,characterName:name};
            await atomicJson(path.join(this.dataRoot,'identity.json'),binding);
            this.binding = binding;
            this.initialized = false;
            await this.initializeBound();
            try { await this.readStatus(); }
            catch { this.reason='人物已绑定，状态尚未读到，请检查游戏画面或点击「读取状态」。挂机保持停止。'; }
            this.log('已绑定人物：'+name+'；挂机保持停止。');
            this.queueDataSync();
          }
        }
        this.lastCommand = {id:job.id,kind,ok:true,message:this.reason,at:this.now()};
      } catch (error) {
        if (!this.binding) this.candidate = null;
        this.lastCommand = {id:job.id,kind,ok:false,error:error.message.split('\n')[0],at:this.now()};
        this.reason = this.lastCommand.error;
        if (this.binding && !this.initialized) this.reason += ' 绑定已保存，请重启本实例完成初始化。';
        this.log('首次设置未完成：'+this.reason);
      } finally {
        this.pending.delete(kind); this.activeCommand = null; this.publish();
      }
      return this.lastCommand;
    });
    return job;
  }
}
