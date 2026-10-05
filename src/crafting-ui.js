import {LibraryUI,readLibraryDetailDOM} from './library-ui.js';
import {craftSelection,inventoryEvidence,localOutcome,batchType} from './crafting-proof.js';

export class CraftingUI {
  constructor(ui,{reader=new LibraryUI(ui)}={}){Object.assign(this,{ui,reader});}
  // Crafting verifies bag quantities and exact ingredient instances. The
  // optional equipped-items rack is unrelated evidence and must not block
  // reconciliation after a consuming click has already completed.
  async inventory(){return this.reader.read('inventory',undefined,{includeEquipment:false});}
  async preview(item,input){
    const inventory=await this.inventory();
    const value=await this.reader.read('crafting',item);
    const selected=value.items.find(i=>i.key===item.key);
    try{return {selection:craftSelection(selected,value.detail,input,inventory),item:selected,detail:value.detail,inventory};}
    catch(error){error.review={inventory,crafting:value};throw error;}
  }
  async stopActivity(checkpoint){
    const ready=await this.ui.ensureMonitoringView();if(!ready.ready)throw new Error('请先恢复游戏页面');
    let state=await this.ui.observe();
    if(state.mode==='combat'){
      await checkpoint('retreating');
      try{await this.ui.retreatForTarget(this.ui.config.target,{force:true});}
      catch(error){state=await this.ui.observe();if(state.mode==='combat')throw error;}
    }
    state=await this.ui.observe();
    if(state.heal?.running){
      await checkpoint('stopping-heal');
      const explicit=this.ui.frame.getByRole('button',{name:/^(停止调息|结束调息)$/u});
      const button=await explicit.count()?explicit:this.ui.frame.locator('.activity-view .ongoing-activity').filter({has:this.ui.frame.getByRole('heading',{name:'调息中',exact:true})}).getByRole('button',{name:'结束活动',exact:true});
      await this.ui.action(button,'炼制前停止调息',{game:true});
      await this.ui.waitFor(async()=>!(await this.ui.observe()).heal.running,'停止持续调息');
    }
    state=await this.ui.observe();
    if(!['rest','ready'].includes(state.mode)||state.heal?.running)throw new Error('游戏尚未处于可炼制的休整状态');
  }
  async mutate(preview,onIssued,onLocal=async()=>{}){
    const freshInventory=await this.inventory(),before=inventoryEvidence(freshInventory);
    let notice='',saved=false,settledLocal=null;
    await this.reader.read('crafting',preview.item,{visit:async({dialog,item,detail,reader})=>{
      const inventory={items:[...Object.entries(before.stacks).map(([name,quantity])=>({name,quantity})),...Object.entries(before.instances).map(([identity,i])=>({...i,identity}))]};
      let current;
      try{
        current=craftSelection(item,detail,{quantity:preview.selection.quantity,instanceIds:preview.selection.instances.map(i=>i.id)},inventory);
        if(current.signature!==preview.selection.signature)throw new Error('配方、成功率或材料条件发生变化，请重新预览后提交');
      }catch(error){error.review={inventory:freshInventory};error.reviewDetail=detail;throw error;}
      if(batchType(current.type)){
        const input=await this.ui.unique(dialog.getByRole('spinbutton',{name:'炼制炉数',exact:true}),'炼制炉数');
        await reader.wait(2000,this.ui.signal);await reader.verify({dialog});this.ui.beforeAction?.('设置炼制炉数');
        await input.fill(String(current.quantity));await input.blur();
        if(await input.inputValue()!==String(current.quantity))throw new Error('游戏调整了炉数，未执行');
      }else{
        for(let index=0;index<2;index++){
          const candidate=detail.ingredients[index].candidates.find(c=>c.id===current.instances[index].id);
          const button=dialog.locator('.craft-ingredient').nth(index).getByRole('button',{name:candidate.aria,exact:true});
          await reader.click(button,`选择材料 #${candidate.id}`,{dialog});
          if(await button.getAttribute('aria-pressed')!=='true')throw new Error('材料选择未确认');
        }
      }
      const action=batchType(current.type)?'开炉炼制':current.type==='兵刃合炼'?'合炼兵刃':'升炼防具';
      const button=await this.ui.unique(dialog.locator('footer').getByRole('button',{name:action,exact:true}),action);
      await reader.wait(2000,this.ui.signal);await reader.verify({dialog});
      const latest=await dialog.evaluate(readLibraryDetailDOM);
      if(latest.name!==current.name||JSON.stringify(latest.facts)!==JSON.stringify(current.facts))throw new Error('开炉前成功率或配方已变化，请重新核对');
      if(batchType(current.type)){
        if(await dialog.getByRole('spinbutton',{name:'炼制炉数',exact:true}).inputValue()!==String(current.quantity)||latest.materials.some(m=>m.missing))throw new Error('开炉前炉数或材料已变化，请重新核对');
      }else if(latest.ingredients.some((g,index)=>g.candidates.filter(c=>c.selected).length!==1||!g.candidates.some(c=>c.selected&&c.id===current.instances[index].id)))throw new Error('开炉前所选材料装备已变化');
      if(!await button.isEnabled())throw new Error('开炉按钮不可用，未消耗材料');
      this.ui.beforeAction?.('提交本批炼制');
      await onIssued(before); // Durable fence BEFORE the potentially consuming click.
      this.ui.beforeAction?.('提交本批炼制');
      this.reader.completionOnly=true;
      try{await button.click({timeout:this.ui.runtime.responseTimeoutSeconds*1000});}catch{/* Observe once; never retry the click. */}
      await this.ui.waitFor(async()=>{
        await reader.verify({dialog});
        const notices=dialog.locator('.craft-notice');
        notice=await notices.count()===1?(await notices.textContent({timeout:1000}))?.trim()??'':'';
        saved=await this.ui.frame.locator('footer.statusbar').getByText('本地存档已就绪',{exact:true}).count()===1;
        return notice==='本批炼制已结算'&&saved;
      },'本批炼制结算与本地保存');
      // Capture exact material changes while the settled dialog is still
      // present, before its close/return navigation can time out. Rounded
      // counts or incomplete rows still require the normal bag verification.
      if(batchType(current.type)){
        const settled=await dialog.evaluate(readLibraryDetailDOM);
        const names=current.materials.map(m=>m.name);
        if(settled.name===current.name&&names.every(name=>settled.materials.filter(m=>m.name===name).length===1)){
          const after=inventoryEvidence({items:settled.materials.map(m=>({name:m.name,quantity:m.owned.replaceAll(',','')}))});
          settledLocal=localOutcome(before,after,current,{notice,saved});
          if(settledLocal){settledLocal.evidenceSource='recipe-materials';await onLocal(settledLocal);}
        }
      }
    }});
    if(settledLocal)return settledLocal;
    const after=inventoryEvidence(await this.inventory()),local=localOutcome(before,after,preview.selection,{notice,saved});
    if(!local)throw new Error('本次材料变化或本地保存尚未确认，不会再次炼制');
    await onLocal(local);
    return local;
  }
  async recoverInventory(){this.lastInventory=await this.inventory();return inventoryEvidence(this.lastInventory);}
  async localReady(){await this.ui.observe({allowObstructed:true});return await this.ui.frame.locator('footer.statusbar').getByText('本地存档已就绪',{exact:true}).count()===1;}
}
