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
  }
  get isBound() { return Boolean(this.binding && this.initialized); }
  getSetup() {
    return {bound:this.isBound,characterName:this.binding?.characterName ?? null,
      candidate:this.candidate ? {characterName:this.candidate.characterName,token:this.candidate.token} : null,
      channelUrl:this.base.channelUrl,appName:this.base.appName,
      browserViewPort:this.runtime.browserViewPort ?? null};
  }
  snapshot() { return {...super.snapshot(),setup:this.getSetup()}; }
  async initialize() {
    this.binding = await readJson(path.join(this.dataRoot,'identity.json'));
    if (!this.binding) {
      if ((await entries(this.dataRoot)).length) throw new Error('数据目录包含未绑定的旧记录，不能自动认领；请使用新的独立数据目录。');
      this.initialized = true;
      this.reason = '请打开游戏，手动登录后读取并确认绑定人物。';
      return;
    }
    await this.initializeBound();
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
    if (!this.record.settings.target) this.reason = '人物已绑定；请刷新地点目录，选择战斗目标并保存，然后启动挂机。';
    this.publish();
  }
  command(kind,payload={},options={}) {
    if (!this.initialized) throw Object.assign(new Error('面板正在初始化，请稍后重试。'),{statusCode:409});
    if (!kind.startsWith('setup-')) {
      if (!this.isBound) throw Object.assign(new Error('请先读取并确认绑定人物。'),{statusCode:409});
      return super.command(kind,payload,options);
    }
    if (!['setup-open-game','setup-detect','setup-bind'].includes(kind)) throw new Error('未知设置操作。');
    if (this.binding) throw new Error('当前目录已经绑定人物；换号请使用独立运行目录。');
    if (this.pending.has(kind)) return this.pending.get(kind);
    if (this.pending.size >= 3) throw new Error('设置操作正在排队。');
    const job = {id:++this.sequence,kind,payload};
    this.pending.set(kind,job);
    job.promise = this.serial(async () => {
      this.activeCommand = kind; this.publish();
      try {
        this.signal.throwIfAborted();
        // Recheck inside the queue: a previous confirmation may have bound it.
        if (this.binding) throw new Error('人物已绑定，请刷新页面。');
        this.ui = await this.makeUI(this.base,this.log,this.ui,false);
        if (kind === 'setup-open-game') await this.ui.ensureApp();
        else {
          const name = await this.ui.detectCharacter();
          if (kind === 'setup-detect') {
            this.candidate = {characterName:name,token:randomUUID(),at:this.now()};
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
            this.log('已绑定人物：'+name+'；挂机保持停止。');
          }
        }
        this.lastCommand = {id:job.id,kind,ok:true,at:this.now()};
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
