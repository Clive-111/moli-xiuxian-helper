import {LibraryUI,readLibraryDetailDOM} from './library-ui.js';
import {CraftingUI} from './crafting-ui.js';
import {linkLibrary} from './farming.js';
import {SLOT_LABELS,itemId,findItem,validateLine,saleProof,equipProof} from './inventory-proof.js';
import {sleep} from './runtime.js';
import {readSaleDOM,saleRow,shopSaleProof} from './sale-evidence.js';

// Only visible game controls and DOM evidence. Never invoke game commands or
// read/write the game's store, and never upload a cloud save.
export class InventoryUI {
  constructor(ui,{knowledge,reader=new LibraryUI(ui)}={}){Object.assign(this,{ui,knowledge,reader});}
  async stopActivity(checkpoint){return new CraftingUI(this.ui,{reader:this.reader}).stopActivity(checkpoint);}
  async localReady(){await this.ui.observe({allowObstructed:true});return await this.ui.frame.locator('footer.statusbar').getByText('本地存档已就绪',{exact:true}).count()===1;}
  async slot(root,slot){
    const label=SLOT_LABELS[slot];if(!label)throw new Error('装备部位未知');
    const tile=await this.ui.unique(root.locator('.bag-equipment-slot').filter({has:this.ui.frame.locator('.bag-slot-label').getByText(label,{exact:true})}),label+'配装');
    if(!await tile.evaluate(el=>el.classList.contains('filled')))return {slot,identity:null};
    await this.reader.click(tile,'核对'+label+'装备编号',{browsing:true});
    const d=await this.ui.unique(this.ui.frame.locator('dialog[open]').filter({has:this.ui.frame.locator('header').getByRole('heading',{name:'已装备器物',exact:true})}),'已装备器物详情');
    await this.reader.verify({dialog:d});const value=await d.evaluate(readLibraryDetailDOM);
    if(!value.identity||value.slotLabel!==label)throw new Error('穿戴编号或部位无法核实');
    await this.reader.click(d.getByRole('button',{name:'关闭窗口',exact:true}),'关闭已装备详情',{dialog:d,cleanup:true,browsing:true});
    return {...value,slot,equipped:true};
  }
  async inventory(slot,includeEquipment=true){
    const value=linkLibrary(await this.reader.read('inventory',null,{includeEquipment,visitRoot:slot?({root})=>this.slot(root,slot):undefined}),this.knowledge);
    if(value.slot?.identity)value.equipment=[...(value.equipment??[]),value.slot];
    return value;
  }
  async previewEquip(item){
    if(!SLOT_LABELS[item.slot]||!item.identity||item.equipped!==false)throw new Error('装备编号或适用部位待核实');
    const inventory=await this.inventory(item.slot),fresh=findItem(inventory,itemId(item));
    const value=await this.reader.read('inventory',fresh);
    if(value.detail.identity!==item.identity||value.detail.slotLabel!==SLOT_LABELS[item.slot]||value.detail.quality!==fresh.quality)throw new Error('详情装备编号、品质或部位不符');
    return {inventory,detail:value.detail,line:{...fresh,id:itemId(fresh),quantity:1,original:inventory.slot}};
  }
  async closeIssuedDialog(pending){
    const dialogs=this.ui.frame.locator('dialog[open]');if(!await dialogs.count())return;
    const d=await this.ui.unique(dialogs,'已提交物品详情'),title=(await d.locator(':scope > header h2').textContent())?.trim();
    const detail=await d.evaluate(readLibraryDetailDOM),line=pending.line;
    if(!['售出物品','物品详情','已装备器物'].includes(title)||detail.name!==line.name||(line.identity&&detail.identity!==line.identity))throw new Error('未知或已变化的弹窗，请人工处理后仅核对结果');
    await this.reader.click(d.getByRole('button',{name:'关闭窗口',exact:true}),'核对前关闭本次详情',{dialog:d,cleanup:true,browsing:true});
  }
  async leaveShop(){
    const service=this.ui.frame.locator('.service-page');
    if(await service.isVisible().catch(()=>false))await this.reader.click(service.getByRole('button',{name:'返回当地',exact:true}),'返回商店所在地点',{cleanup:true,browsing:true});
  }
  async recover(pending){
    this.reader.completionOnly=true;
    if(pending.kind==='sell'&&pending.evidenceSource==='shop-v1')return this.recoverSale(pending);
    await this.ui.observe({allowObstructed:true});await this.closeIssuedDialog(pending);await this.leaveShop();
    const after=await this.inventory(pending.line.slot),saved=await this.localReady();
    const verified=pending.kind==='sell'?saleProof(pending.before,after,pending.line,pending.quantity,saved):equipProof(pending.before,after,pending.line,saved);
    if(!verified)throw new Error('库存、穿戴编号或本地保存未能确认；不会重复提交');
    return {verifiedAt:Date.now(),saved:true,after};
  }
  async openShop(shop){
    const ui=this.ui;await ui.observe({allowObstructed:true});
    if(await ui.frame.locator('.service-page h1').getByText(shop.name,{exact:true}).count()===1){await this.openSaleTab();return;}
    if(await ui.frame.locator('.service-page').count())throw new Error('当前商店与本批商店不符');
    let s=await ui.requireSafeTravel();
    if(s.region!==shop.regionName||s.location!==shop.locationName){
      try{await ui.selectMapDestination(shop.regionName,shop.locationName,{safeTravel:true});}
      catch(error){s=await ui.observe();if(s.region!==shop.regionName||s.location!==shop.locationName)throw error;}
    }
    s=await ui.observe();if(s.region!==shop.regionName||s.location!==shop.locationName||s.mode!=='rest')throw new Error('未确认到达安全商店地点');
    // Current game versions place commerce in the local-services navigation,
    // separate from exploration/healing actions. Match the full shop name, not
    // the entire accessible name (which also contains “货物买卖”).
    const local=ui.frame.locator('main .place-links,main .place-services,main .place-actions,main nav[aria-label="当地往来"],[data-game-main] .place-links,[data-game-main] .place-services,[data-game-main] .place-actions');
    const entry=local.getByRole('button').filter({has:ui.frame.getByText(shop.name,{exact:true})}).filter({visible:true});
    const count=await entry.count();
    if(count!==1)throw new Error(`${shop.regionName} / ${shop.locationName}：${shop.name}${count?'入口不唯一':'入口未出现，可能尚未解锁或页面已变化'}；未进入其他商店，请选择商会后再继续`);
    const opened=()=>ui.frame.locator('.service-page h1').getByText(shop.name,{exact:true}).isVisible();
    await this.reader.click(entry,'进入'+shop.name,{browsing:true,isComplete:opened});
    await ui.waitFor(opened,'卖出商店');
    await this.openSaleTab();
  }
  async openSaleTab(){
    const ui=this.ui,view=ui.frame.locator('.shop-view');
    const tab=await ui.unique(view.getByRole('tablist',{name:'商店买卖',exact:true}).getByRole('tab',{name:'售出',exact:true}),'商店售出标签');
    const selected=async()=>await tab.getAttribute('aria-selected')==='true';
    await this.reader.click(tab,'打开商店售出页',{browsing:true,isComplete:selected});
    await ui.waitFor(selected,'商店售出标签已选中');
    const search=await ui.unique(view.getByRole('searchbox',{name:'查找交易物品',exact:true}),'商店物品筛选');
    if(await search.inputValue()){
      await this.reader.verify();ui.beforeAction?.('清除商店物品筛选',{cleanup:this.reader.completionOnly===true});await search.fill('');
      await ui.waitFor(async()=>await search.inputValue()==='','商店筛选清空');
    }
  }
  async prepareSale(line,quantity,shop){
    this.reader.completionOnly=false;
    if(!this.saleBatch||this.saleBatch.shop.name!==shop.name)await this.beginSaleBatch([line],shop);
    let before=await this.readSale(shop),row=saleRow(before,line);
    if(row.quantity!=null&&BigInt(row.quantity)<BigInt(quantity))throw new Error('售出数量不足');
    const entries=this.ui.frame.locator('.shop-view .entry-list button.entry').filter({has:this.ui.frame.locator('strong').getByText(line.name,{exact:true})});
    const entry=line.identity?entries.filter({has:this.ui.frame.locator('.entry-count').getByText('#'+line.identity.replace(/^item-/u,''),{exact:true})}):entries;
    const dialog=this.ui.frame.locator('dialog[open]').filter({has:this.ui.frame.locator('header').getByRole('heading',{name:'售出物品',exact:true})});
    const detailOpened=async()=>{if(await dialog.count()!==1)return false;const detail=await dialog.evaluate(readLibraryDetailDOM);return detail.name===line.name&&(!line.identity||detail.identity===line.identity);};
    try{await this.saleClick(entry,'核对待售 '+line.name+(line.identity?' #'+line.identity:''));}
    catch(error){if(!await detailOpened())throw error;await this.reader.verify({dialog});}
    const d=await this.ui.unique(dialog,'售出物品详情');
    const verify=async()=>{
      await this.reader.verify({dialog:d});const detail=await d.evaluate(readLibraryDetailDOM);
      if(detail.name!==line.name||line.identity&&(detail.identity!==line.identity||detail.quality!==line.quality)||/须先卸下/u.test(await d.innerText()))throw new Error('售出物品编号、品质或穿戴状态不符');
      if(await this.ui.frame.locator('.service-page h1').getByText(shop.name,{exact:true}).count()!==1)throw new Error('商店已变化');
      const price=await d.locator('.item-valuation strong').innerText();
      if(!displayMatchesPrice(price,line.unitPrice))throw new Error('商店回收单价变化');
    };
    await verify();
    if(!line.identity){
      const input=await this.ui.unique(d.getByRole('spinbutton',{name:'交易数量',exact:true}),'交易数量');
      const max=Number(await input.getAttribute('max'));
      if(!Number.isSafeInteger(max)||max<quantity)throw new Error('商店可售数量不足');
      if(row.quantity==null&&max<10000)row.quantity=String(max);
      // Large abbreviated stacks have no exact total in the shop DOM. Obtain
      // a baseline only for that exceptional stack; never inspect equipment.
      if(row.quantity==null){
        await this.closeIssuedDialog({line});await this.leaveShop();
        const inventory=await this.inventory(undefined,false),fresh=validateLine(inventory,line,quantity);
        await this.openShop(shop);before=await this.readSale(shop);row=saleRow(before,line);
        if(!displayMatchesPrice(row.countText.replace(/^×\s*/u,'')+' 灵石',String(fresh.quantity)))throw new Error('补读期间库存变化，未提交售出');
        row.quantity=String(fresh.quantity);before.exactFallback=true;
        await this.saleClick(entry,'核对待售 '+line.name);await verify();
      }
      await input.fill(String(quantity));await input.blur();if(await input.inputValue()!==String(quantity))throw new Error('商店调整了交易数量，未售出');
    }
    await verify();
    if(!line.identity&&await d.getByRole('spinbutton',{name:'交易数量',exact:true}).inputValue()!==String(quantity))throw new Error('交易数量已变化');
    const button=await this.ui.unique(d.getByRole('button',{name:'售出',exact:true}),'确认售出');
    await this.pollSale(()=>button.isEnabled(),'售出按钮不可用');
    await verify();
    if(!line.identity&&await d.getByRole('spinbutton',{name:'交易数量',exact:true}).inputValue()!==String(quantity))throw new Error('交易数量已变化');
    return {before,button};
  }
  // Run the same preparation as a real sale but stop before the durable issue
  // marker and consuming click. Useful for checking a paused batch in the UI.
  async inspectSale(line,quantity,shop){
    const {before}=await this.prepareSale(line,quantity,shop);
    await this.closeIssuedDialog({line});
    return {checkedAt:Date.now(),lineId:line.id,name:line.name,quantity,shopName:shop.name,stock:saleRow(before,line).quantity,issued:false,evidenceSource:'shop-v1'};
  }
  async sell(line,quantity,shop,onIssued){
    const {before,button}=await this.prepareSale(line,quantity,shop);
    this.ui.beforeAction?.('提交售出 '+line.name);const pending={kind:'sell',evidenceSource:'shop-v1',beforeSale:before,shop,line,quantity};await onIssued(pending);
    this.ui.beforeAction?.('提交售出 '+line.name);this.reader.completionOnly=true;
    try{await button.click({timeout:this.ui.runtime.responseTimeoutSeconds*1000});}catch{/* Never replay. */}
    return this.recover(pending);
  }
  async saleClick(locator,label){
    await this.reader.verify();const button=await this.ui.unique(locator,label);
    await this.pollSale(()=>button.isEnabled(),label+'暂不可用');
    this.ui.beforeAction?.(label,{cleanup:this.reader.completionOnly===true});
    await button.click({timeout:this.ui.runtime.responseTimeoutSeconds*1000});
  }
  async pollSale(check,message){
    const end=Date.now()+this.ui.runtime.responseTimeoutSeconds*1000;
    do{const result=await check();if(result)return result;await sleep(100,this.ui.signal);}while(Date.now()<end);
    throw new Error(message+'；不会重复提交');
  }
  async readSale(shop){
    const value=await this.ui.frame.evaluate(readSaleDOM);
    if(value.shopName!==shop.name||value.locationName!==shop.locationName)throw new Error('商店或所在地点已变化');
    return value;
  }
  async beginSaleBatch(lines,shop){
    this.reader.completionOnly=false;await this.openShop(shop);await this.reader.verify();
    const before=await this.readSale(shop);
    for(const line of lines.filter(l=>(l.quantity-(l.completed??0))>0)){
      const row=saleRow(before,line),remaining=line.quantity-(line.completed??0);
      if(!line.identity){const defs=this.knowledge?.items?.filter(i=>i.name===line.name)??[];if(defs.length!==1||defs[0].id!==line.gameItemId)throw new Error('叠加物品类型无法唯一匹配');}
      if(row.quantity!=null&&BigInt(row.quantity)<BigInt(remaining))throw new Error('本批物品数量不足：'+line.name);
      if(!displayMatchesPrice(row.price,line.unitPrice))throw new Error('本批回收单价变化：'+line.name);
    }
    this.saleBatch={shop};return before;
  }
  async recoverSale(pending){
    this.fallbackResult=null;
    await this.ui.observe({allowObstructed:true});
    // Reconnect after restart/review without consuming anything. If already in
    // the verified shop, retain the issued stack dialog for its exact input max.
    if(!await this.ui.frame.locator('.service-page h1').getByText(pending.shop.name,{exact:true}).count()){
      await this.closeIssuedDialog(pending);await this.openShop(pending.shop);
    }
    let stable=0,last=null,fallback=false;
    const result=await this.pollSale(async()=>{
      const dialogs=this.ui.frame.locator('dialog[open]');
      if(await dialogs.count()){
        const d=await this.ui.unique(dialogs,'已提交售出详情'),detail=await d.evaluate(readLibraryDetailDOM);
        if((await d.locator(':scope > header h2').textContent())?.trim()!=='售出物品'||detail.name!==pending.line.name||pending.line.identity&&detail.identity!==pending.line.identity)throw new Error('待确认期间出现未知弹窗');
        await this.reader.verify({dialog:d});
      }else await this.reader.verify();
      let after;try{after=await this.readSale(pending.shop);}catch(error){last=error.message;stable=0;return false;}
      const row=saleRow(after,pending.line,{missing:true});
      if(row&&!pending.line.identity&&row.quantity==null&&await dialogs.count()){
        const max=Number(await dialogs.getByRole('spinbutton',{name:'交易数量',exact:true}).getAttribute('max'));
        if(Number.isSafeInteger(max)&&max>0&&max<10000)row.quantity=String(max);
      }
      const busy=await dialogs.getByRole('button',{name:'售出',exact:true}).count()&& !await dialogs.getByRole('button',{name:'售出',exact:true}).isEnabled();
      if(row&&!pending.line.identity&&row.quantity==null&&after.saved&&!busy&&!fallback){
        // One fallback per issued action. It can only read/confirm, never sell.
        fallback=true;await this.closeIssuedDialog(pending);await this.leaveShop();
        const inventory=await this.inventory(undefined,false),items=inventory.items.filter(i=>itemId(i)===pending.line.id);
        if(items.length>1)throw new Error('补读库存编号不唯一');
        const next=items[0]?.quantity??'0';
        if(!/^\d+$/u.test(String(next))||BigInt(saleRow(pending.beforeSale,pending.line).quantity)-BigInt(next)!==BigInt(pending.quantity)||!await this.localReady())throw new Error('补读精确库存仍无法确认本次售出；不会再次点击');
        await this.openShop(pending.shop);after=await this.readSale(pending.shop);
        const fresh=saleRow(after,pending.line,{missing:true});
        if(fresh){if(!displayMatchesPrice(fresh.countText.replace(/^×\s*/u,'')+' 灵石',String(next)))throw new Error('返回售出页后库存变化');fresh.quantity=String(next);}
        else if(BigInt(next)!==0n)throw new Error('返回售出页后编号缺失');
        this.fallbackResult={id:pending.line.id,quantity:String(next)};
      }
      if(fallback&&row?.quantity==null&&this.fallbackResult?.id===pending.line.id){
        const fresh=saleRow(after,pending.line,{missing:true});
        if(fresh&&displayMatchesPrice(fresh.countText.replace(/^×\s*/u,'')+' 灵石',this.fallbackResult.quantity))fresh.quantity=this.fallbackResult.quantity;
      }
      if(shopSaleProof(pending.beforeSale,after,pending.line,pending.quantity)&&!busy){if(++stable>=2)return {verifiedAt:Date.now(),saved:true,after,evidenceSource:'shop-v1'};}else stable=0;
      return false;
    },'售出列表或本地保存未能确认'+(last?'：'+last:''));
    await this.closeIssuedDialog(pending);return result;
  }
  async equip(line,onIssued){
    this.reader.completionOnly=false;const before=await this.inventory(line.slot);
    if(before.slot?.identity===line.identity)return {verifiedAt:Date.now(),saved:await this.localReady(),already:true,after:before};
    if(before.slot?.identity!==line.original?.identity)throw new Error('原配装已改变，请重新核对');
    const item=findItem(before,line.id);if(item.slot!==line.slot||item.quality!==line.quality)throw new Error('装备适用部位或品质变化');
    let pending;
    await this.reader.read('inventory',item,{visit:async({dialog:d,detail})=>{
      if(detail.identity!==line.identity||detail.slotLabel!==SLOT_LABELS[line.slot]||detail.quality!==line.quality)throw new Error('详情装备编号、部位或品质不符');
      const button=await this.ui.unique(d.locator('.bag-detail-actions').getByRole('button',{name:/^(装备|替换装备)$/u}),'更换装备');
      await this.reader.wait(2000,this.ui.signal);await this.reader.verify({dialog:d});if(!await button.isEnabled())throw new Error('装备按钮不可用');
      const latest=await d.evaluate(readLibraryDetailDOM);if(latest.identity!==line.identity)throw new Error('装备详情已变化');
      this.ui.beforeAction?.('更换装备 '+line.identity);pending={kind:'equip',before,line,quantity:1};await onIssued(pending);
      this.ui.beforeAction?.('更换装备 '+line.identity);this.reader.completionOnly=true;
      try{await button.click({timeout:this.ui.runtime.responseTimeoutSeconds*1000});}catch{/* Reconcile exact slot, never re-equip. */}
      await this.closeIssuedDialog(pending);
    }});
    return this.recover(pending);
  }
}

// The exact quote comes from the bag's accessible label. The rounded shop
// quote is an extra consistency check, never evidence that a sale succeeded.
export function displayMatchesPrice(text,exact){
  const m=/^\s*([\d,]+)(?:\.(\d{1,2}))?\s*(垓|京|兆|万亿|亿|万)?\s*灵石\s*$/u.exec(text);if(!m||!/^\d+$/u.test(exact))return false;
  const scale={万:10000n,亿:100000000n,万亿:1000000000000n,兆:1000000000000n,京:10000000000000000n,垓:100000000000000000000n}[m[3]]??1n;
  if(!m[3])return BigInt(m[1].replaceAll(',',''))===BigInt(exact)&&!m[2];
  // The game truncates to two decimal places and then removes trailing zeros.
  const shown=BigInt(m[1].replaceAll(',',''))*100n+BigInt((m[2]??'').padEnd(2,'0'));
  return BigInt(exact)*100n/scale===shown;
}
