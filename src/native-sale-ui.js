import {saleRow,shopBulkSaleProof} from './sale-evidence.js';
import {displayMatchesPrice} from './inventory-ui.js';

export const NATIVE_SALE_LIMIT=1000;
const identity=/^item-\d+$/u;
const total=lines=>lines.reduce((sum,line)=>sum+BigInt(line.unitPrice),0n).toString();
const sameIds=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&a.every(id=>b.includes(id));
export function readBulkSelectionDOM(){
 const root=document.querySelector('.shop-view'),tools=root?.querySelectorAll('.shop-bulk-tools');
 if(tools?.length!==1)throw new Error('批量售出工具不唯一');
 const checked=[...root.querySelectorAll('.shop-instance-entry input[type=checkbox]:checked')];
 return {ids:checked.map(el=>/，编号(item-\d+)$/u.exec(el.getAttribute('aria-label')??'')?.[1]??''),disabled:checked.some(el=>el.disabled),count:Number(/已选\s*(\d+)\s*件/u.exec(tools[0].textContent)?.[1]),price:tools[0].querySelector('.wallet')?.getAttribute('title')};
}
export function readBulkReviewDOM(dialog){
 const rows=[...dialog.querySelectorAll('.shop-sale-review > div')];
 return {rows:rows.map(el=>{const meta=el.querySelector('small')?.textContent.trim()??'',match=/^品质\s*([\d.]+)\s*·\s*#(\d+)$/u.exec(meta);return {name:el.querySelector('strong')?.textContent.trim(),quality:match?.[1],identity:match?'item-'+match[2]:'',price:el.querySelector('.entry-price')?.getAttribute('title')};}),errors:[...dialog.querySelectorAll('[role=alert]')].map(el=>el.textContent.trim()).filter(Boolean)};
}
function checkReview(value,lines){
 if(value.errors.length||!sameIds(value.rows.map(i=>i.identity),lines.map(i=>i.identity)))throw new Error('批量确认名单已变化，未提交售出');
 for(const line of lines){const row=value.rows.find(i=>i.identity===line.identity);if(row.name!==line.name||row.quality!==String(line.quality)||row.price!==`${line.unitPrice} 灵石`)throw new Error('批量确认的编号、名称、品质或单价不符');}
}

// The only consuming control is the verified confirmation button, clicked once
// after the whole group has been saved as pending. Never call the game store/API.
export class NativeSaleUI {
 constructor(adapter){this.a=adapter;this.ui=adapter.ui;this.reader=adapter.reader;}
 dialog(){return this.ui.frame.locator('dialog[open]').filter({has:this.ui.frame.locator('header').getByRole('heading',{name:'确认批量售出',exact:true})});}
 async supported(){
  const tools=this.ui.frame.locator('.shop-view .shop-bulk-tools');
  if(!await tools.count()){
    if(await this.ui.frame.locator('.shop-instance-entry input[type=checkbox]').count())throw new Error('批量售出工具尚未完整显示，未退回逐件出售');
    return false;
  }
  if(await tools.count()!==1||!await tools.isVisible()||await tools.getByRole('button',{name:'批量售出',exact:true}).count()!==1)throw new Error('批量售出界面无法确认，未退回逐件出售');
  return true;
 }
 async checkLines(snapshot,lines){
  for(const line of lines){saleRow(snapshot,line);if(!displayMatchesPrice(saleRow(snapshot,line).price,line.unitPrice))throw new Error('批量回收单价已变化：'+line.name);}
 }
 async verifyDialog(lines){
  const dialog=await this.ui.unique(this.dialog(),'批量售出确认');
  await this.reader.verify({dialog});checkReview(await dialog.evaluate(readBulkReviewDOM),lines);
  return dialog;
 }
 async prepare(lines,shop){
  if(!lines.length||lines.length>NATIVE_SALE_LIMIT||lines.some(l=>!identity.test(l.identity)||l.quantity-(l.completed??0)!==1)||new Set(lines.map(l=>l.identity)).size!==lines.length)throw new Error('批量售出只接受不重复的具体器物或炼材编号');
  this.reader.completionOnly=false;
  await this.a.openShop(shop);await this.reader.verify();
  if(!await this.supported())throw new Error('当前游戏没有批量售出入口');
  await this.checkLines(await this.a.readSale(shop),lines);
  const tools=this.ui.frame.locator('.shop-bulk-tools'),clear=tools.getByRole('button',{name:'清空出售选择',exact:true});
  if(await clear.count()!==1)throw new Error('无法清除旧的出售选择');
  if(await clear.isEnabled())await this.a.saleClick(clear,'清空旧的出售选择');
  if((await this.ui.frame.evaluate(readBulkSelectionDOM)).ids.length)throw new Error('旧选择尚未清空');
  for(const line of lines){
   await this.reader.verify();
   const checkbox=await this.ui.unique(this.ui.frame.locator('.shop-instance-entry').getByRole('checkbox',{name:`选择${line.name}，品质${line.quality}，编号${line.identity}`,exact:true}),'勾选售出 '+line.identity);
   if(!await checkbox.isEnabled())throw new Error('物品已经穿戴或不能批量售出：'+line.identity);
   this.ui.beforeAction?.('勾选售出 '+line.identity);await checkbox.setChecked(true,{timeout:this.ui.runtime.responseTimeoutSeconds*1000});
  }
  const selection=await this.ui.frame.evaluate(readBulkSelectionDOM);
  if(selection.disabled||!sameIds(selection.ids,lines.map(l=>l.identity))||selection.count!==lines.length||selection.price!==`${total(lines)} 灵石`)throw new Error('勾选数量、编号或总价不符，未提交售出');
  const before=await this.a.readSale(shop);await this.checkLines(before,lines);
  try{await this.a.saleClick(tools.getByRole('button',{name:'批量售出',exact:true}),'打开批量售出确认');}
  catch(error){if(await this.dialog().count()!==1)throw error;}
  const dialog=await this.verifyDialog(lines),button=await this.ui.unique(dialog.getByRole('button',{name:new RegExp(`^售出\\s+${lines.length}\\s+件\\s*·`,'u')}),'确认批量售出');
  if(!await button.isEnabled())throw new Error('批量售出确认尚未就绪');
  return {before,button};
 }
 async sell(lines,shop,onIssued){
  const {before,button}=await this.prepare(lines,shop);
  const pending={kind:'sell',evidenceSource:'shop-bulk-v1',beforeSale:before,shop,lines:structuredClone(lines),line:lines[0],quantity:lines.length};
  this.ui.beforeAction?.('提交批量售出');await onIssued(pending);
  await this.verifyDialog(lines);await this.checkLines(await this.a.readSale(shop),lines);
  this.ui.beforeAction?.('提交批量售出');this.reader.completionOnly=true;
  try{await button.click({timeout:this.ui.runtime.responseTimeoutSeconds*1000});}catch{/* Only reconcile; never replay a submitted group. */}
  return this.recover(pending);
 }
 async recover(pending){
  this.reader.completionOnly=true;await this.ui.observe({allowObstructed:true});
  const dialogs=this.ui.frame.locator('dialog[open]');
  if(!await dialogs.count())await this.a.openShop(pending.shop);
  let stable=0;
  const result=await this.a.pollSale(async()=>{
   if(await dialogs.count()){
    const dialog=await this.verifyDialog(pending.lines);
    if(await dialog.getByRole('button',{name:/^售出\s+\d+\s+件\s*·/u}).isDisabled()){stable=0;return false;}
   }else await this.reader.verify();
   let after;try{after=await this.a.readSale(pending.shop);}catch{stable=0;return false;}
   if(shopBulkSaleProof(pending.beforeSale,after,pending.lines)){if(++stable>=2)return {saved:true,verifiedAt:Date.now(),after,evidenceSource:'shop-bulk-v1'};}else stable=0;
   return false;
  },'批量售出名单或本地保存尚未全部核实');
  if(await dialogs.count()){const dialog=await this.verifyDialog(pending.lines);await this.reader.click(dialog.getByRole('button',{name:'关闭窗口',exact:true}),'关闭已核对的批量确认',{dialog,cleanup:true,browsing:true});}
  return result;
 }
}
