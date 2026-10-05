import {createHash} from 'node:crypto';

export const CRAFT_TYPES=['普通炼制','精炼','兵刃合炼','防具升炼'];
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const batchType=type=>['普通炼制','精炼'].includes(type);
export function craftSelection(item,detail,input,inventory) {
  if (!CRAFT_TYPES.includes(item.recipeType)) throw new Error('不支持或无法确认的炼制类型');
  if(detail.name!==item.name)throw new Error('配方名称已变化，请重新读取');
  const batch=batchType(item.recipeType),maximum=Math.min(10000,item.maxBatch);
  const quantity=batch?(input.quantity==='all'?maximum:Number(input.quantity)):1;
  if (!Number.isInteger(quantity)||quantity<1||quantity>maximum) throw new Error(`炉数或材料不足，本批最多 ${maximum} ${batch?'炉':'组'}`);
  const ids=batch?[]:input.instanceIds;
  if (!batch && (!Array.isArray(ids)||ids.length!==2||ids[0]===ids[1]||detail.ingredients.length!==2)) throw new Error('请分别选择两件不同的材料装备');
  const instances=batch?[]:ids.map((id,index)=>{
    const matches=detail.ingredients[index].candidates?.filter(c=>c.id===id)??[];
    const owned=inventory.items.filter(i=>i.identity===id);
    if (matches.length!==1||owned.length!==1||owned[0].quality!==matches[0].quality||owned[0].name!==matches[0].name) throw new Error('所选材料已变化、穿戴或不在行囊，请重新选择');
    return {...matches[0],image:owned[0].image,imageSource:owned[0].imageSource};
  });
  const materials=detail.materials.map(row=>({name:row.name,perUnit:row.required,owned:inventory.items.find(i=>i.name===row.name&&!i.identity)?.quantity??'0'}));
  const terms={key:item.key,name:item.name,type:item.recipeType,quantity,instances:instances.map(i=>({id:i.id,name:i.name,quality:i.quality})),materials:materials.map(({name,perUnit})=>({name,perUnit})),facts:detail.facts};
  return {...terms,instances,materials,signature:digest(terms)};
}
export function inventoryEvidence(value) {
  return {stacks:Object.fromEntries(value.items.filter(i=>!i.identity).map(i=>[i.name,String(i.quantity)])),
    instances:Object.fromEntries(value.items.filter(i=>i.identity).map(i=>[i.identity,{name:i.name,quality:i.quality}]))};
}
// Compare exact consumption; merely seeing a smaller stack is insufficient.
function consumedAsSelected(before,after,selection) {
  if(!before?.stacks||!after?.stacks||!before.instances||!after.instances)return false;
  if(batchType(selection.type)){
    if(!Number.isSafeInteger(selection.quantity)||selection.quantity<1||!selection.materials.length)return false;
    const required=new Map();
    for(const m of selection.materials){
      const amount=String(m.perUnit).replaceAll(',','');
      if(!/^\d+$/u.test(amount)||BigInt(amount)<=0n)return false;
      required.set(m.name,(required.get(m.name)??0n)+BigInt(amount)*BigInt(selection.quantity));
    }
    return [...required].every(([name,amount])=>{
      const old=before.stacks[name]??'0',next=after.stacks[name]??'0';
      return /^\d+$/u.test(old)&&/^\d+$/u.test(next)&&BigInt(old)-BigInt(next)===amount;
    });
  }
  return selection.instances.length===2&&new Set(selection.instances.map(i=>i.id)).size===2
    &&selection.instances.every(i=>before.instances[i.id]&&!after.instances[i.id]);
}
export function localOutcome(before,after,selection,{notice='',saved=false}={}) {
  if(!saved||notice!=='本批炼制已结算'||!consumedAsSelected(before,after,selection))return null;
  return {notice,source:'settlement',verifiedAt:Date.now(),inventory:after};
}
export function reviewLocalOutcome(before,after,selection,{saved=false}={}) {
  if(!saved||!consumedAsSelected(before,after,selection))return null;
  // Inventory does not reveal success rates or bonus production. Keep that
  // distinction explicit when a dialog acknowledgement was lost.
  return {notice:'本批耗材数量已核对，实际产出请查看行囊',source:'inventory-review',verifiedAt:Date.now(),inventory:after};
}

// Read-only diagnostics are retained even when proof is insufficient. Never
// turn unchanged/partial consumption into permission to repeat a craft.
export function craftReviewEvidence(before,after,selection,{saved=false}={}) {
  const exact=value=>/^\d+$/u.test(String(value))?BigInt(value):null;
  const required=new Map();
  for(const m of selection.materials??[]){
    const n=exact(String(m.perUnit).replaceAll(',',''));
    required.set(m.name,n==null?null:(required.get(m.name)??0n)+n*BigInt(selection.quantity));
  }
  const materials=[...required].map(([name,expected])=>{
    const old=before?.stacks?.[name]??'0',remaining=after?.stacks?.[name]??'0';
    const a=exact(old),b=exact(remaining),consumed=a!=null&&b!=null?a-b:null;
    return {name,before:old,after:remaining,expected:expected?.toString()??null,consumed:consumed?.toString()??null,matched:expected!=null&&consumed===expected};
  });
  const instances=(selection.instances??[]).map(i=>({id:i.id,name:i.name,existed:Boolean(before?.instances?.[i.id]),remaining:Boolean(after?.instances?.[i.id])}));
  return {checkedAt:Date.now(),saved,materials,instances};
}

export function craftReviewReason(evidence) {
  const problems=[];
  if(!evidence.saved)problems.push('游戏尚未显示本地存档已就绪');
  for(const m of evidence.materials.filter(m=>!m.matched))problems.push(`${m.name}：预计消耗 ${m.expected??'未知'}，实际 ${m.before} → ${m.after}（减少 ${m.consumed??'未知'}）`);
  for(const i of evidence.instances.filter(i=>!i.existed||i.remaining))problems.push(`材料 #${i.id} ${i.remaining?'仍在行囊':'缺少开炉前记录'}`);
  return `${problems.join('；')||'本批结果证据不足'}；仅作历史记录，不会再次炼制`;
}
