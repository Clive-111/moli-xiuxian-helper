import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson} from './control-store.js';
import {CraftingUI} from './crafting-ui.js';
import {PauseError} from './errors.js';
import {reviewLocalOutcome,craftReviewEvidence,craftReviewReason} from './crafting-proof.js';

// This class never creates a loop: BattleControl's queue owns every call. Its
// separate write tail also makes an immediate stop fence durable during a job.
export class CraftingControl {
  constructor(control,{write=atomicJson,makeUI=ui=>new CraftingUI(ui)}={}) {
    this.control=control;this.write=write;this.makeUI=makeUI;
    this.file=path.join(control.directory,'crafting.json');this.tail=Promise.resolve();
    this.data={version:1,activeId:null,previews:{},operations:{}};
  }
  async initialize() {
    const data=await readJson(this.file);
    if(data){
      if(data.version!==1||!data.previews||!data.operations||data.activeId&&!data.operations[data.activeId])throw new Error('炼制记录无效，未覆盖或自动执行');
      this.data=data;
    }
    if(this.data.stopRequested){this.control.record={...this.control.record,desired:'stopped'};await this.control.persist(this.control.record);this.control.phase='stopped';}
    if(this.active){
      // Cancellation is safe before the issued fence. Never replay an issued action.
      if(!this.active.issuedAt)await this.patch(this.active.id,{stage:'cancelled',error:'进程已重启，未提交的炼制已取消'},true);
      else {
        this.startupReviewId=this.active.id;
        await this.patch(this.active.id,{stage:'unconfirmed',error:'进程已重启，稍后刷新行囊；不会重复炼制'},true);
      }
    }
  }
  get active(){return this.data.operations[this.data.activeId]??null;}
  change(fn) {
    const result=this.tail.then(async()=>{
      const next=structuredClone(this.data);fn(next);await this.write(this.file,next);this.data=next;this.control.publish();
    });this.tail=result.catch(()=>{});return result;
  }
  patch(id,value,finish=false){return this.change(data=>{Object.assign(data.operations[id],value,{updatedAt:Date.now()});if(finish&&data.activeId===id)data.activeId=null;});}
  snapshot(){
    const expose=o=>{const {baseline,beforeInventory,local,preview,cloudStatus,receipt,...safe}=o;return {...safe,localSaved:Boolean(local),selection:preview.selection};};
    const visible=Object.values(this.data.operations).filter(o=>!o.deletedAt);
    return {activeId:this.data.activeId,historyCount:visible.length,operations:visible.slice(-100).reverse().map(expose),
      previews:Object.values(this.data.previews).slice(-30).map(p=>({id:p.id,createdAt:p.createdAt,selection:p.selection}))};
  }
  async remove({operationId}){
    await this.change(data=>{
      const operation=data.operations[operationId];
      if(!operation)throw new Error('未找到这条炼制记录');
      if(data.activeId===operationId||!['completed','cancelled','refreshed','unconfirmed'].includes(operation.stage))throw new Error('进行中或待核对的炼制不能删除');
      if(operation.deletedAt)return;
      // Remove history details, but retain the consumed/cancelled ID fence so
      // a stale browser or replay after restart can never issue this batch again.
      data.operations[operationId]={id:operationId,stage:operation.stage,deletedAt:Date.now()};
      delete data.previews[operationId];
    });
    return {operationId,deleted:true};
  }
  requestStop(){return this.change(data=>{data.stopRequested=true;if(data.activeId)data.operations[data.activeId].resumeDesired=false;});}
  clearStop(){return this.change(data=>{data.stopRequested=false;});}
  guard(){if(this.control.stopRequests||this.control.signal.aborted)throw new Error('已收到停止请求，本批尚未提交的操作已取消');}
  async prepare(payload){
    this.guard();if(this.active)throw new Error('上一笔炼制尚未核对，请使用「仅核对结果」');
    const item=this.control.library.views.crafting?.items.find(i=>i.key===payload.key);
    if(!item)throw new Error('请先刷新配方并选择具体配方');
    const adapter=await this.adapter();
    let preview;
    try{preview=await adapter.preview(item,{quantity:payload.quantity??1,instanceIds:payload.instanceIds});}
    catch(error){await this.review(error,adapter);throw error;}
    this.guard();
    preview.selection.instances=preview.selection.instances.map(i=>({...i,image:this.control.images.register(i.imageSource)}));
    const id=randomUUID(),value={...preview,id,createdAt:Date.now()};
    await this.change(data=>{data.previews[id]=value;const ids=Object.keys(data.previews);for(const old of ids.slice(0,-30))delete data.previews[old];});
    this.control.log(`炼制预览：${preview.selection.name} · ${preview.selection.quantity} ${preview.selection.instances.length?'组':'炉'}，等待明确提交。`);
    return {previewId:id};
  }
  async adapter(){
    await this.control.connect();
    this.control.reconcile(await this.control.ui.observe({allowObstructed:true}));
    const r=this.control.runner;
    if(!this.active&&['pendingEntry','pendingRetreat','pendingHealingTravel','healPending','pendingHealingStop'].some(key=>r?.[key]))throw new Error('上一游戏动作仍待核实，暂不炼制');
    return this.makeUI(this.control.ui);
  }
  async execute({previewId}){
    if(this.data.operations[previewId])return {operationId:previewId}; // Idempotent even after failure or restart.
    this.guard();if(this.active)throw new Error('已有炼制正在核对，不接受第二笔提交');
    const preview=this.data.previews[previewId];
    if(!preview||Date.now()-preview.createdAt>15*60000)throw new Error('预览已失效，请重新核对材料');
    const adapter=await this.adapter();
    await this.change(data=>{data.activeId=previewId;data.operations[previewId]={id:previewId,preview,stage:'preparing',createdAt:Date.now(),updatedAt:Date.now(),resumeDesired:this.control.record.desired==='running'&&this.control.phase!=='attention',local:null};});
    try{
      this.control.phase='crafting';this.control.reason='正在游戏内炼制';this.control.publish();
      await adapter.stopActivity(stage=>{this.guard();return this.patch(previewId,{stage});});
      await this.patch(previewId,{stage:'ready'});
      this.guard();
      const local=await adapter.mutate(preview,async beforeInventory=>{
        this.guard();await this.patch(previewId,{beforeInventory,issuedAt:Date.now(),stage:'issued'});
      },async local=>{await this.patch(previewId,{local,stage:'reviewing'});});
      await this.patch(previewId,{local,stage:'reviewing'});
      await this.complete(previewId,local,adapter);
    }catch(error){
      if(this.data.operations[previewId]?.issuedAt&&!this.control.signal.aborted){
        // A consuming click is never replayed. Read the bag once and release
        // this job even if later manual activity changed the inventory delta.
        this.control.log(`炼制响应未完整确认，自动刷新行囊：${error.message.split('\n')[0]}`);
        return this.retry({operationId:previewId});
      }
      await this.failed(previewId,error);await this.review(error,adapter);throw error;
    }
    return {operationId:previewId};
  }
  async retry({operationId}){
    const operation=this.data.operations[operationId],wasActive=this.data.activeId===operationId;
    if(!operation||operation.id!==operationId||!operation.issuedAt||!operation.beforeInventory)throw new Error('没有可核对结果的已提交操作');
    if(operation.stage==='completed')return {operationId};
    if(this.active&&!wasActive)throw new Error('当前炼制正在执行，请稍后刷新历史记录');
    try{
      const adapter=await this.adapter();adapter.reader.completionOnly=true;
      await this.patch(operationId,{stage:'reviewing',error:''});
      const inventory=await adapter.recoverInventory();
      if(adapter.lastInventory)await this.control.cacheLibrary('inventory',adapter.lastInventory);
      // Review exact consumption from the visible bag. This does not invent a
      // settlement notice, success count, or a second consuming click.
      const saved=await adapter.localReady();
      const evidence=craftReviewEvidence(operation.beforeInventory,inventory,operation.preview.selection,{saved});
      await this.patch(operationId,{lastReview:evidence});
      const local=saved?(operation.local??reviewLocalOutcome(operation.beforeInventory,inventory,operation.preview.selection,{saved})):null;
      if(local)await this.complete(operationId,local,adapter,{restoreState:wasActive,skipInventory:Boolean(adapter.lastInventory)});
      else {
        await this.patch(operationId,{stage:'refreshing',error:'',warning:craftReviewReason(evidence),result:{message:'行囊已刷新，本批具体结果以当前库存为准；不阻塞其他操作，不重复开炉'}});
        const refresh=await this.refresh(adapter,{skipInventory:Boolean(adapter.lastInventory),item:operation.preview.item});
        await this.patch(operationId,{stage:'refreshed',refresh},true);
        if(wasActive)this.restore(operation);
        this.control.log(`炼制后行囊已刷新：${operation.preview.selection.name}；库存差异仅保留在历史，不阻塞挂机。`);
      }
    }catch(error){await this.failed(operationId,error,{restoreState:wasActive});throw error;}
    return {operationId};
  }
  async confirm({operationId,reviewedAt,confirmed}){
    if(confirmed!==true||!Number.isSafeInteger(reviewedAt))throw new Error('请明确确认已在游戏中核对本批炼制结果');
    if(this.data.operations[operationId]?.stage==='completed')return {operationId};
    const operation=this.data.operations[operationId],wasActive=this.data.activeId===operationId;
    if(!operation||operation.id!==operationId||!operation.issuedAt||!operation.lastReview?.saved||operation.lastReview.checkedAt!==reviewedAt)throw new Error('核对记录已变化，请先使用「仅核对结果」');
    try{
      const adapter=await this.adapter();adapter.reader.completionOnly=true;
      const inventory=await adapter.recoverInventory(),saved=await adapter.localReady();
      const evidence=craftReviewEvidence(operation.beforeInventory,inventory,operation.preview.selection,{saved});
      if(!saved||JSON.stringify(evidence.materials)!==JSON.stringify(operation.lastReview.materials)||JSON.stringify(evidence.instances)!==JSON.stringify(operation.lastReview.instances)){
        await this.patch(operationId,{lastReview:evidence});throw new Error('库存或保存状态已变化，请重新核对后确认');
      }
      const local={verifiedAt:Date.now(),source:'manual-review',notice:'用户已在游戏中核对本批炼制完成；材料差异由用户确认，本地存档已就绪',inventory};
      await this.patch(operationId,{local,manualConfirmation:{confirmedAt:Date.now(),reviewedAt,evidence},stage:'reviewing'});
      await this.complete(operationId,local,adapter,{restoreState:wasActive});
    }catch(error){await this.failed(operationId,error,{restoreState:wasActive});throw error;}
    return {operationId};
  }
  async complete(id,local,adapter,{restoreState=true,skipInventory=false}={}){
    if(!local?.verifiedAt)throw new Error('炼制结果尚未核对');
    await this.patch(id,{stage:'refreshing',local,result:{message:local.notice},error:''});
    this.control.log(`炼制本地结果已确认：${this.data.operations[id].preview.selection.name} · ${local.notice}`);
    const refresh=await this.refresh(adapter,{skipInventory,item:this.data.operations[id].preview.item});
    await this.patch(id,{stage:'completed',refresh},true);
    if(restoreState)this.restore(this.data.operations[id]);
  }
  async refresh(adapter,{skipInventory=false,item}={}){
    const refresh={errors:{}};
    for(const view of skipInventory?['crafting']:['inventory','crafting']){
      try{
        // Refresh the actual recipe candidates as part of the existing read,
        // so an open panel cannot keep offering already consumed instances.
        const raw=await adapter.reader.read(view,view==='crafting'?item:undefined);
        if(view==='crafting'&&item&&raw.detail?.key!==item.key)throw new Error('本批配方详情尚未刷新');
        await this.control.cacheLibrary(view,raw);
        if(view==='crafting')refresh.detailUpdatedAt=raw.detail?.updatedAt;
      }
      catch(error){refresh.errors[view]=this.control.libraryErrors[view]=`刷新失败：${error.message}`;if(error instanceof PauseError)throw error;}
    }
    return {...refresh,updatedAt:Date.now()};
  }
  async review(error,adapter){
    if(!error.review)return;
    for(const [view,value] of Object.entries(error.review))await this.control.cacheLibrary(view,value).catch(()=>{});
    if(error.reviewDetail){
      // Refresh all card limits, keeping the newly read conditions in the detail.
      try{const value=await adapter.reader.read('crafting');value.detail=error.reviewDetail;await this.control.cacheLibrary('crafting',value);}catch{/* A stopped or changed UI is left for the next explicit refresh. */}
    }
  }
  restore(operation){
    const c=this.control;
    if(c.runner){for(const key of ['pendingRetreat','pendingEntry','pendingHealingTravel','healPending','pendingHealingStop','healing'])c.runner[key]=null;}
    const resume=operation.resumeDesired&&c.record.desired==='running'&&!c.stopRequests;
    c.phase=resume?'checking':c.record.desired==='stopped'||c.stopRequests?'stopped':'attention';
    c.reason=c.phase==='attention'?'炼制核对已结束；此前任务已暂停，请手动恢复':'';c.needsPreflight=true;c.nextTick=0;c.publish();
  }
  async failed(id,error,{restoreState=true}={}){
    const op=this.data.operations[id];
    if(!op)return;
    try{
      if(!op.issuedAt)await this.patch(id,{stage:'cancelled',error:error.message},true);
      else await this.patch(id,{stage:'unconfirmed',error:`本次刷新未完成：${error.message}；可稍后刷新，不会再次开炉`},true);
      if(restoreState)this.restore(op);
      // Identity, login, save conflict and unknown dialogs remain real game
      // blockers; an old quantity discrepancy is no longer one.
      if(error instanceof PauseError){this.control.phase='attention';this.control.reason=error.message;}
    }catch(writeError){this.control.phase='attention';this.control.reason=`操作记录写入失败：${writeError.message}，请勿删除记录`;}
    finally{this.control.publish();}
  }
}
