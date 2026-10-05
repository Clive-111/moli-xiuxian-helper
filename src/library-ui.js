import { createHash } from 'node:crypto';
import { sleep } from './runtime.js';
import { PauseError } from './errors.js';

export const LIBRARY_VIEWS = Object.freeze({ inventory: { tab: '行囊', root: '.inventory-view', tile: '.bag-grid button.bag-item' }, crafting: { tab: '炉鼎', root: '.craft-view', tile: '.craft-grid button.craft-tile' } });

// DOM-only extraction: no game commands, stores, tokens or React internals.
export function readLibraryDOM(view) {
  const root = document.querySelector(view === 'inventory' ? '.inventory-view' : '.craft-view');
  if (!root) throw new Error('查看页尚未加载');
  const text = el => (el?.innerText ?? el?.textContent ?? '').trim();
  const clean = value => String(value ?? '').slice(0, 1500);
  const image = el => el.querySelector('img')?.currentSrc || el.querySelector('img')?.src || null;
  const kindNames = { equipment:'器物', food:'补给', marrow:'灵髓', insight:'灵露', 'foundation-pill':'筑基丹', part:'炼材', material:'材料' };
  const items = [...root.querySelectorAll(view === 'inventory' ? '.bag-grid button.bag-item' : '.craft-grid button.craft-tile')].map(el => {
    const aria = el.getAttribute('aria-label') ?? '';
    const category = [...(el.querySelector('.item-glyph')?.classList ?? el.classList)].find(c => kindNames[c]);
    const top = text(el.querySelector('.bag-item-amount,.craft-tile-top > span:last-child'));
    return { name: clean(text(el.querySelector('strong'))), aria: clean(aria), category: kindNames[category] ?? '其他', imageSource: image(el),
      quantity: view === 'inventory' ? /持有\s*([\d,]+)\s*份/u.exec(aria)?.[1]?.replaceAll(',', '') ?? '1' : null,
      quality: /品质\s*([\d.]+)/u.exec(aria)?.[1] ?? null,
      identity: /编号([^，,]+)/u.exec(aria)?.[1] ?? '',
      equipped: false,
      unitPrice: /回收单价\s*([\d,]+)\s*灵石/u.exec(aria)?.[1]?.replaceAll(',','') ?? null,
      price: clean(el.querySelector('.bag-item-price,.craft-tile-price')?.getAttribute('title') ?? ''),
      summary: clean(top), chance: clean(text(el.querySelector('[title="当前成功率"]'))),
      output: clean(text(el.querySelector('.craft-tile-facts small'))), stock: clean(text(el.querySelector('.craft-tile-stock'))),
      ready: view === 'crafting' ? el.classList.contains('ready') : null,
      recipeType: view === 'crafting' ? aria.split('，')[1] ?? '' : '',
      maxBatch: view === 'crafting' ? Number(/材料可供\s*([\d,]+)/u.exec(aria)?.[1]?.replaceAll(',','') ?? NaN) : null,
    };
  });
  const equipment = view === 'inventory' ? [...root.querySelectorAll('.bag-equipment-slot')].map(el => ({ name:text(el.querySelector('strong')), slot:text(el.querySelector('.bag-slot-label')), equipped:el.classList.contains('filled'), identity:null, identityVerified:false, imageSource:image(el) })) : [];
  const summary = text(root.querySelector('.page-heading .muted'));
  // An empty list is valid only with the game's explicit empty state.
  if (!items.length && !/行囊空空|没有符合条件的配方/u.test(text(root))) throw new Error('物品列表结构变化，保留上次快照');
  if (items.some(i => !i.name || !i.aria.startsWith('查看'))) throw new Error('物品名称或查看入口无法核实');
  if (items.length > 2000) throw new Error('列表过大，停止读取');
  return { summary, items, equipment, workshop: view === 'crafting' ? text(root.querySelector('.furnace-strip')).replace(/养鼎\s*$/u, '').trim() : '' };
}

export function readLibraryDetailDOM(el) {
  const text = element => (element?.innerText ?? element?.textContent ?? '').trim();
  const body = el.querySelector('.dialog-body');
  if (!body) throw new Error('详情结构无法确认');
  return {
    name: text(body.querySelector('.item-detail-title h2')),
    identity: /#\s*(\d+)/u.exec(text(body.querySelector('.item-detail-title .quality')))?.[1] ? 'item-'+/#\s*(\d+)/u.exec(text(body.querySelector('.item-detail-title .quality')))[1] : null,
    quality: /品质\s*([\d.]+)/u.exec(text(body.querySelector('.item-detail-title .quality')))?.[1] ?? null,
    slotLabel: text(body.querySelector('.item-detail-title .eyebrow')),
    comparison: text(body.querySelector('.bag-comparison')),
    description: [...body.querySelectorAll('.flavor,.effect-description,.bonus-lines,.craft-consumable-effects .cost-warning')].map(text).filter(Boolean).join('\n').slice(0, 10000),
    facts: [...body.querySelectorAll('.craft-facts > div')].map(row => ({ label:text(row.querySelector('dt')), value:text(row.querySelector('dd')) })),
    materials: [...body.querySelectorAll('.craft-materials tbody tr')].map(row => { const cells=[...row.querySelectorAll('th,td')].map(text);return {name:cells[0],owned:cells[1],required:cells[2],missing:row.querySelector('td:last-child')?.classList.contains('negative')}; }),
    ingredients: [...body.querySelectorAll('.craft-ingredient')].map(row => ({name:text(row.querySelector('h3')),label:row.getAttribute('aria-label'),summary:text(row.querySelector('.craft-ingredient-heading')),available:row.querySelectorAll('.craft-instance').length,
      candidates:[...row.querySelectorAll('button.craft-instance')].map(button=>{const aria=button.getAttribute('aria-label')??'';return {aria,id:/编号([^，,]+)/u.exec(aria)?.[1],quality:/品质([\d.]+)/u.exec(aria)?.[1],name:aria.split('，')[0],selected:button.getAttribute('aria-pressed')==='true'};})})),
    notes: [...body.querySelectorAll('.cost-warning,.negative,.muted.small')].map(text).filter(Boolean).slice(0, 15),
    text: text(body).slice(0, 14000),
  };
}

export function libraryKey(view, item) {
  // Inventory quantities change while combat advances. Instance IDs distinguish identical equipment.
  return createHash('sha256').update(JSON.stringify([view,item.name,item.identity,item.category,item.recipeType,item.summary?.replace(/^×.*$/u,'')])).digest('hex');
}

export class LibraryUI {
  constructor(ui, { wait = sleep } = {}) { this.ui=ui; this.wait=wait; }
  async verify({ dialog } = {}) {
    const state = await this.ui.observe({ allowObstructed:true });
    if (state.character !== this.ui.config.characterName) throw new PauseError('查看物品前无法确认当前角色');
    if (state.view.dialogs.length && !dialog) throw new PauseError('有未确认的弹窗，请在游戏中处理后再刷新');
    if (dialog && (state.view.dialogs.length !== 1 || !await dialog.isVisible())) throw new PauseError('详情弹窗已变化，停止查看');
    return state;
  }
  async click(locator, label, { dialog, cleanup=false, browsing=false, isComplete } = {}) {
    // Only list navigation/inspection uses the short delay. Crafting calls this
    // method too; material selection keeps its own pacing.
    await this.wait(browsing ? Math.max(100, this.ui.battleActionDelayMs ?? 300) : Math.max(2,this.ui.runtime.actionDelaySeconds)*1000,this.ui.signal);
    await this.verify({ dialog });
    // A read-only toggle may change while waiting (for example the rack is
    // already expanded). Reconcile the visible result instead of toggling back.
    if (isComplete && await isComplete()) return;
    let item;
    try { item=await this.ui.unique(locator,label); }
    catch (error) {
      if (!isComplete) throw error;
      await this.verify({ dialog });
      if (await isComplete()) return;
      throw error;
    }
    if (!await item.isEnabled()) throw new PauseError(`${label}暂不可用`);
    this.ui.beforeAction?.(label,{cleanup:cleanup||this.completionOnly===true});
    try { await item.click({timeout:this.ui.runtime.responseTimeoutSeconds*1000}); }
    catch (error) {
      if (!isComplete) throw error;
      await this.verify({ dialog });
      if (!await isComplete()) throw error;
    }
  }
  async expandEquipment(root) {
    const section=root.locator('.bag-equipment');
    if (!await section.count()) return;
    if (await section.count()!==1) throw new PauseError('当前配装区域不唯一，停止读取');
    if (!await section.isVisible()) throw new PauseError('当前配装区域暂不可见，保留上次快照');
    const expanded=async()=>{
      if (await section.count()!==1) return false;
      const expand=section.getByRole('button',{name:'展开配装',exact:true}).filter({visible:true});
      const collapse=section.getByRole('button',{name:'收起配装',exact:true}).filter({visible:true});
      if (await expand.count()>1 || await collapse.count()>1) throw new PauseError('配装展开按钮不唯一，停止读取');
      return !await expand.count() && await section.locator('.bag-equipment-slot:visible').count()>0;
    };
    if (await expanded()) return;
    await this.click(section.getByRole('button',{name:'展开配装',exact:true}).filter({visible:true}),
      '展开当前配装',{browsing:true,isComplete:expanded});
    await this.ui.waitFor(async()=>{await this.verify();return expanded();},'当前配装展开');
  }
  async closeDetail(dialog) {
    const closed=async()=>{
      if(await dialog.isVisible())return false;
      // A replacement/unknown modal is never accepted as successful cleanup.
      await this.verify();return true;
    };
    if(await closed())return;
    try{await this.click(dialog.getByRole('button',{name:'关闭窗口',exact:true}),'关闭查看详情',{dialog,cleanup:true,browsing:true});}
    catch(error){if(!await closed())throw error;}
    await this.ui.waitFor(closed,'详情关闭');
  }
  async read(view, selected, {visit,visitRoot,includeEquipment=true} = {}) {
    const spec=LIBRARY_VIEWS[view]; if (!spec) throw new Error('不支持的查看页');
    const ui=this.ui; let changed=false, ownedDialog=null;
    try {
      const restored=await ui.ensureMonitoringView();
      if (!restored.ready) throw new PauseError('请先恢复游戏界面，再查看行囊或炼制');
      changed=true;
      await this.click(ui.frame.locator('nav.central-nav,nav[aria-label="主导航"]').getByRole('button',{name:spec.tab,exact:true}),`查看${spec.tab}`,{browsing:true});
      const root=ui.frame.locator(spec.root);
      await ui.waitFor(()=>root.isVisible(),`${spec.tab}列表`);
      await this.verify();
      const reset=root.getByRole('button',{name:view==='inventory'?'清除物品筛选':'清除配方筛选',exact:true});
      if (await reset.count()===1 && await reset.isEnabled()) await this.click(reset,'清除查看筛选',{browsing:true});
      if (view==='inventory') {
        if (includeEquipment) await this.expandEquipment(root);
      } else {
        const all=root.getByRole('checkbox',{name:'显示全部',exact:true});
        if (await all.count()!==1) throw new Error('无法确认全部配方筛选，保留上次快照');
        if (!await all.isChecked()) await this.click(all,'显示全部配方',{browsing:true});
      }
      await this.verify();
      const result=await ui.frame.evaluate(readLibraryDOM,view);
      result.items=result.items.map(item=>({...item,key:libraryKey(view,item)}));
      if (visitRoot) result.slot=await visitRoot({root,reader:this});
      if (selected) {
        const matches=result.items.filter(item=>item.key===selected.key);
        if (matches.length!==1) throw new Error('物品已变化或同名配方无法唯一定位，请刷新后重试');
        const current=matches[0];
        const tile=root.locator(spec.tile).filter({has:ui.frame.getByText(current.name,{exact:true})});
        const exact=tile.and(root.getByRole('button',{name:current.aria,exact:true}));
        // A click can finish in the game while Playwright reports a timeout. Read the
        // resulting dialog once instead of opening the item a second time.
        let clickError;
        try { await this.click(exact,`查看「${current.name}」详情`,{browsing:true}); }
        catch (error) { clickError=error; }
        if (clickError && !await ui.frame.locator('dialog[open]').count()) throw clickError;
        await ui.waitFor(()=>ui.frame.locator('dialog[open]').count(),'物品详情');
        const dialogs=ui.frame.locator('dialog[open]');
        if (await dialogs.count()!==1) throw new PauseError('详情弹窗不唯一，等待手动处理');
        const candidate=dialogs.first();
        const name=await candidate.locator('.item-detail-title h2').textContent();
        if (name?.trim()!==current.name) throw new PauseError('详情物品名称不符，等待手动处理');
        const title=(await candidate.locator(':scope > header h2').textContent())?.trim();
        if (!['物品详情','已装备器物','普通炼制','精炼','兵刃合炼','防具升炼'].includes(title)) throw new PauseError('未知确认弹窗，未点击任何操作');
        // Keep the verified headings in the locator so a replacement confirmation
        // dialog cannot inherit this reader's permission to close it.
        ownedDialog=dialogs.filter({has:ui.frame.locator('.item-detail-title').getByRole('heading',{name:current.name,exact:true})})
          .filter({has:ui.frame.locator('header').getByRole('heading',{name:title,exact:true})});
        await this.verify({dialog:ownedDialog});
        result.detail={...await ownedDialog.evaluate(readLibraryDetailDOM),key:current.key,view,updatedAt:Date.now(),imageSource:current.imageSource};
        if (visit) result.visit=await visit({dialog:ownedDialog,detail:result.detail,item:current,reader:this});
      }
      return {...result,view,character:ui.config.characterName,updatedAt:Date.now()};
    } finally {
      // Only close a verified informational detail that this reader opened. Never touch craft/use/sell controls.
      if (ownedDialog && await ownedDialog.isVisible().catch(()=>false)) {
        await this.closeDetail(ownedDialog);
      }
      if (changed && !ui.signal.aborted) {
        await this.verify();
        await this.click(ui.frame.locator('nav.central-nav,nav[aria-label="主导航"]').getByRole('button',{name:'游历',exact:true}),'查看后返回游历',{cleanup:true,browsing:true});
        await ui.waitFor(async()=>['combat','rest','ready','map'].includes((await ui.observe()).mode),'查看后返回当前地点');
      }
    }
  }
}
