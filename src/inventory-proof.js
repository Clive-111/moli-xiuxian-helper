export const SLOT_LABELS=Object.freeze({weapon:'兵刃',head:'头部',body:'上身',legs:'腿部',feet:'足部',accessory:'饰品',artifact:'法宝',special:'特殊'});
export const TRADE_LIMIT=10000;
export function itemId(item){return item.identity?`instance:${item.identity}`:item.gameItemId?`stack:${item.gameItemId}`:null;}
export function exactQuantity(value){if(!/^\d+$/u.test(String(value)))throw new Error('数量不是精确整数，请重新读取');const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error('数量超出可核对范围');return n;}
export function findItem(inventory,id){const found=inventory.items.filter(i=>itemId(i)===id);if(found.length!==1)throw new Error('物品编号已变化、不唯一或已经穿戴，请重新核对');return found[0];}
export function freezeSale(inventory,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>2000||new Set(ids).size!==ids.length)throw new Error('请选择不重复的物品');
  return ids.map(id=>{const i=findItem(inventory,id);if(i.equipped!==false||!/^\d+$/u.test(i.unitPrice??''))throw new Error('穿戴状态或精确回收单价未核实');
    const quantity=i.identity?1:exactQuantity(i.quantity);if(quantity<1)throw new Error('物品已无库存');
    return {id,identity:i.identity??'',gameItemId:i.gameItemId,name:i.name,quality:i.quality,slot:i.slot??null,quantity,unitPrice:i.unitPrice,image:i.image??null,imageSource:i.imageSource??null};});
}
export function validateLine(inventory,line,quantity){const i=findItem(inventory,line.id);
  if(i.equipped!==false||i.name!==line.name||i.quality!==line.quality||i.unitPrice!==line.unitPrice||exactQuantity(i.quantity)<quantity)throw new Error('编号、品质、数量或单价变化，已停止剩余卖出');return i;
}
export function saleProof(before,after,line,quantity,saved){
  if(!saved)return false;
  const old=findItem(before,line.id),found=after.items.filter(i=>itemId(i)===line.id);
  if(found.length>1||after.equipment?.some(i=>i.identity&&i.identity===line.identity))return false;
  if(line.identity)return found.length===0;
  const next=found.length?exactQuantity(found[0].quantity):0;
  return exactQuantity(old.quantity)-next===quantity;
}
export function equipProof(before,after,line,saved){
  if(!saved||after.slot?.identity!==line.identity||after.slot?.slot!==line.slot)return false;
  if(after.items.some(i=>i.identity===line.identity))return false;
  return !before.slot?.identity||before.slot.identity===line.identity||after.items.filter(i=>i.identity===before.slot.identity&&i.equipped===false).length===1;
}
