import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson} from './control-store.js';
import {InventoryUI} from './inventory-ui.js';
import {DEFAULT_SALE_TARGET,saleShop} from './catalog.js';
import {freezeSale,findItem,exactQuantity,TRADE_LIMIT,SLOT_LABELS} from './inventory-proof.js';

export class InventoryControl {
  constructor(control,{write=atomicJson,makeUI=(ui,knowledge)=>new InventoryUI(ui,{knowledge})}={}){
    Object.assign(this,{control,write,makeUI});this.file=path.join(control.directory,'inventory-actions.json');this.tail=Promise.resolve();
    this.data={version:1,activeId:null,previews:{},operations:{}};
  }
  get active(){return this.data.operations[this.data.activeId]??null;}
  change(fn){const promise=this.tail.then(async()=>{const next=structuredClone(this.data);fn(next);await this.write(this.file,next);this.data=next;this.control.publish();});this.tail=promise.catch(()=>{});return promise;}
  patch(id,values,finish=false){return this.change(d=>{Object.assign(d.operations[id],values,{updatedAt:Date.now()});if(finish&&d.activeId===id)d.activeId=null;});}
  async initialize(){
    const d=await readJson(this.file);if(d){if(d.version!==1||!d.previews||!d.operations||d.activeId&&!d.operations[d.activeId])throw new Error('物品操作记录无效，未覆盖');this.data=d;}
    if(this.data.stopRequested){const record={...this.control.record,desired:'stopped'};await this.control.persist(record);this.control.record=record;this.control.phase='stopped';}
    if(this.active)await this.patch(this.active.id,{stage:this.active.pending?'awaiting-review':'awaiting-continue',error:'进程已重启，未自动重放物品操作；请核对后继续或取消剩余'});
  }
  snapshot(){
    return {activeId:this.data.activeId,saleTarget:this.control.record?.settings?.saleTarget??DEFAULT_SALE_TARGET,
      previews:Object.values(this.data.previews).slice(-20),operations:Object.values(this.data.operations).slice(-50).reverse().map(o=>{
        const {pending,...rest}=o;return {...rest,pending:pending?{lineId:pending.line.id,quantity:pending.quantity,issuedAt:pending.issuedAt}:null};
      })};
  }
  requestStop(){return this.change(d=>{d.stopRequested=true;if(d.activeId){d.operations[d.activeId].cancelRequested=true;d.operations[d.activeId].resumeDesired=false;}});}
  clearStop(){return this.change(d=>{d.stopRequested=false;});}
  requestCancel(id){return this.change(d=>{if(d.activeId===id)d.operations[id].cancelRequested=true;});}
  guard(){if(this.control.signal.aborted||this.control.stopRequests||this.active?.cancelRequested)throw new Error('已取消尚未提交的物品操作');}
  async adapter(){
    await this.control.connect();this.control.reconcile(await this.control.ui.observe({allowObstructed:true}));
    const r=this.control.runner;if(!this.active&&['pendingEntry','pendingRetreat','pendingHealingTravel','healPending','pendingHealingStop'].some(k=>r?.[k]))throw new Error('上一游戏动作待核对，暂不操作物品');
    return this.makeUI(this.control.ui,this.control.knowledge);
  }
  async prepare(payload){
    this.guard();if(this.active||this.control.crafting.active)throw new Error('上一笔操作仍待核对');
    if(!['sell','equip'].includes(payload.kind))throw new Error('物品操作类型无效');
    const a=await this.adapter();let lines,shop,comparison='';
    if(payload.kind==='sell'){
      if(!this.control.catalog?.shops?.length)await this.control.refreshCatalog();
      shop=saleShop(this.control.catalog,this.control.record.settings.saleTarget??DEFAULT_SALE_TARGET);
      const inventory=await a.inventory(undefined,false);
      // A sale preview reads the bag once without expanding the equipment rack.
      // Keep its last display snapshot if the collapsed rack has no DOM tiles.
      if(!inventory.equipment?.length)inventory.equipment=this.control.library?.views?.inventory?.equipment??[];
      await this.control.cacheLibrary('inventory',inventory);
      lines=freezeSale(inventory,payload.ids);
    }else{
      const inventory=await a.inventory();await this.control.cacheLibrary('inventory',inventory);
      const current=findItem(inventory,payload.id);
      if(current.slot!==payload.slot)throw new Error('所选装备不适用于此部位');
      const value=await a.previewEquip(current);lines=[value.line];comparison=value.detail.comparison;
    }
    this.guard();const id=randomUUID(),preview={id,kind:payload.kind,createdAt:Date.now(),lines,shop,comparison};
    preview.lines=lines.map(l=>({...l,image:this.control.images.register(l.imageSource)}));
    await this.change(d=>{d.previews[id]=preview;for(const old of Object.keys(d.previews).slice(0,-20))delete d.previews[old];});
    return {previewId:id};
  }
  async execute({previewId,quantities}){
    if(this.data.operations[previewId])return {operationId:previewId};
    this.guard();if(this.active||this.control.crafting.active)throw new Error('已有物品或炼制操作未完成');
    const preview=this.data.previews[previewId];if(!preview||Date.now()-preview.createdAt>15*60000)throw new Error('预览已过期，请重新核对');
    if(quantities!=null&&(typeof quantities!=='object'||Array.isArray(quantities)||Object.keys(quantities).some(id=>!preview.lines.some(l=>l.id===id))))throw new Error('提交数量不属于本次清单');
    const lines=preview.lines.map(line=>{const quantity=exactQuantity(quantities?.[line.id]??line.quantity);if(quantity<1||quantity>line.quantity||line.identity&&quantity!==1)throw new Error('数量必须在本次已核实库存范围内');return {...line,quantity,completed:0};});
    await this.change(d=>{d.activeId=previewId;d.operations[previewId]={id:previewId,kind:preview.kind,shop:preview.shop,lines,stage:'preparing',createdAt:Date.now(),updatedAt:Date.now(),resumeDesired:this.control.record.desired==='running'&&this.control.phase!=='attention',pending:null};});
    return this.run(previewId);
  }
  async equip({id,slot,requestId}){
    const existing=this.data.operations[requestId]??this.data.previews[requestId];
    if(existing&&(existing.kind!=='equip'||existing.lines.length!==1||existing.lines[0].id!==id||existing.lines[0].slot!==slot))throw new Error('提交编号已用于其他物品操作');
    if(this.data.operations[requestId])return {operationId:requestId};
    this.guard();if(this.active||this.control.crafting.active)throw new Error('上一笔操作仍待核对');
    if(!SLOT_LABELS[slot]||!id?.startsWith('instance:'))throw new Error('请选择具体装备及适用部位');
    const a=await this.adapter(),inventory=await a.inventory(slot);
    // The adapter appends an internal slot proof to equipment; only publish
    // the rack's display rows, with the verified ID merged into that slot.
    const equipment=(inventory.equipment??[]).filter(i=>i.slot!==slot).map(i=>i.slot===SLOT_LABELS[slot]?{...i,identity:inventory.slot?.identity??null,identityVerified:Boolean(inventory.slot?.identity)}:i);
    await this.control.cacheLibrary('inventory',{...inventory,equipment});
    if(inventory.slot?.identity===id.slice('instance:'.length)&&inventory.slot.slot===slot)return {already:true};
    const item=findItem(inventory,id);
    if(item.slot!==slot||!item.identity||item.equipped!==false)throw new Error('所选装备不适用于此部位或已经不可用');
    this.guard();
    // One explicit replacement command owns both validation and execution in
    // the existing serial queue. No intermediate attribute comparison preview.
    const preview={id:requestId,kind:'equip',createdAt:Date.now(),lines:[{...item,id,quantity:1,original:inventory.slot,image:this.control.images.register(item.imageSource)}]};
    await this.change(d=>{d.previews[requestId]=preview;for(const old of Object.keys(d.previews).slice(0,-20))delete d.previews[old];});
    return this.execute({previewId:requestId});
  }
  async run(id){
    try{
      this.guard();const a=await this.adapter();this.control.phase='inventory-action';this.control.reason='正在处理已确认的物品清单';this.control.publish();
      await a.stopActivity(stage=>{this.guard();return this.patch(id,{stage});});
      const batch=this.data.operations[id];
      if(batch.kind==='sell'){this.guard();await a.beginSaleBatch(batch.lines,batch.shop);}
      for(let index=0;index<this.data.operations[id].lines.length;index++){
        while(true){
          this.guard();const op=this.data.operations[id],line=op.lines[index],remaining=line.quantity-line.completed;if(remaining<=0)break;
          if(op.pending)throw new Error('存在待核对动作，不能重复提交');
          await this.patch(id,{stage:'executing',error:''});const quantity=Math.min(remaining,TRADE_LIMIT);
          const issued=async evidence=>{
            this.guard();await this.patch(id,{pending:{...evidence,index,issuedAt:Date.now()},stage:'issued'});this.guard();
          };
          const local=op.kind==='sell'?await a.sell(line,quantity,op.shop,issued):await a.equip(line,issued);
          if(!local?.saved||!local.verifiedAt)throw new Error('本地保存或操作结果仍待核对');
          await this.confirm(id,index,quantity,local);
        }
      }
      await this.finish(id,a);
    }catch(error){
      const op=this.data.operations[id];
      if(op.cancelRequested&&!op.pending){const a=await this.adapter().catch(()=>null);await this.finish(id,a,true);}
      else {await this.patch(id,{stage:op.pending?'awaiting-review':'awaiting-continue',error:error.message});this.control.phase='attention';this.control.reason='物品操作已暂缓：'+error.message;this.control.publish();throw error;}
    }
    return {operationId:id};
  }
  async confirm(id,index,quantity,local){
    const pending=this.data.operations[id].pending,elapsed=pending?.issuedAt?Math.max(0,local.verifiedAt-pending.issuedAt):null;
    await this.change(d=>{const o=d.operations[id];o.lines[index].completed+=quantity;o.lines[index].verifiedAt=local.verifiedAt;o.pending=null;o.stage='verified';o.updatedAt=Date.now();});
    this.control.log(`物品${this.data.operations[id].kind==='sell'?'卖出':'换装'}已核对：${this.data.operations[id].lines[index].name} · ${this.data.operations[id].lines[index].id} × ${quantity}；本地保存已就绪${local.evidenceSource==='shop-v1'?'，售出页核对':''}${elapsed==null?'':`，提交至核对 ${elapsed} ms`}。`);
  }
  async review({operationId,inspectSale=false}){
    const op=this.active;if(!op||op.id!==operationId)throw new Error('没有对应的待处理批次');
    if(inspectSale){
      if(op.kind!=='sell'||op.pending||op.cancelRequested)throw new Error('请先核对已发出动作；只能检查尚未提交的卖出流程');
      this.guard();const line=op.lines.find(l=>l.completed<l.quantity);if(!line)throw new Error('本批没有待售物品');
      const a=await this.adapter();await a.stopActivity(()=>this.guard());await a.beginSaleBatch(op.lines,op.shop);
      const inspection=await a.inspectSale(line,Math.min(line.quantity-line.completed,TRADE_LIMIT),op.shop);
      await this.patch(op.id,{inspection,error:''});
      this.control.reason='售出流程检查通过，未卖出物品；请继续剩余或取消剩余';this.control.publish();
      this.control.log(`售出流程检查完成：${line.name} · ${line.id}；已找到最终售出按钮，未点击。`);
      return {operationId,inspection};
    }
    try{
      const a=await this.adapter();
      if(op.pending){const local=await a.recover(op.pending);await this.confirm(op.id,op.pending.index,op.pending.quantity,local);}
      const current=this.active;
      if(current.lines.every(l=>l.completed===l.quantity)||current.cancelRequested)await this.finish(op.id,a,Boolean(current.cancelRequested));
      else await this.patch(op.id,{stage:'awaiting-continue',error:'已核对已发出动作；剩余清单尚未执行，请继续或取消剩余'});
    }catch(error){await this.patch(op.id,{stage:op.pending?'awaiting-review':'awaiting-continue',error:error.message});throw error;}
    return {operationId};
  }
  async continue({operationId,shopId}){
    const op=this.active;if(!op||op.id!==operationId||op.pending||op.cancelRequested)throw new Error('请先核对已提交动作；已取消的清单不能继续');
    this.guard();
    if(shopId!=null){
      if(op.kind!=='sell')throw new Error('换装不需要选择商会');
      const shops=this.control.catalog?.shops?.filter(s=>s.id===shopId)??[];
      if(shops.length!==1)throw new Error('所选商会不在有效目录中，请刷新目录');
      const shop=saleShop(this.control.catalog,{regionName:shops[0].regionName,locationName:shops[0].locationName,shopName:shops[0].name});
      await this.patch(op.id,{shop,error:''});
      this.control.log(`本批剩余物品改到 ${shop.regionName} / ${shop.locationName} / ${shop.name}；清单及数量保持不变。`);
    }
    return this.run(operationId);
  }
  async cancel({operationId}){
    if(!this.active||this.active.id!==operationId)return {operationId};
    await this.requestCancel(operationId);
    if(!this.active.pending){await this.finish(operationId,null,true);return {operationId};}
    return this.review({operationId}); // Only reconcile the issued item; never execute remaining lines.
  }
  async finish(id,a,cancelled=false){
    const op=this.data.operations[id];if(op.pending)throw new Error('不能结束仍待核对的批次');
    await this.patch(id,{stage:cancelled?'cancelled':'completed',error:''},true);
    if(a){
      try{await a.leaveShop();}catch(e){this.control.libraryErrors.inventory='操作已核对，返回当地失败：'+e.message;}
      for(const view of ['inventory','crafting'])try{await this.control.cacheLibrary(view,await a.reader.read(view));}catch(e){this.control.libraryErrors[view]='操作已核对，列表刷新失败：'+e.message;}
    }
    this.control.crafting.restore(this.data.operations[id]);
  }
}
