// Evidence from visible shop DOM only. A blank/loading/filtered list is never
// evidence of a sale. Equipped rows have no public instance ID in this game.
export function readSaleDOM() {
  const text=el=>(el?.innerText??el?.textContent??'').trim();
  const services=[...document.querySelectorAll('.service-page')],views=[...document.querySelectorAll('.shop-view')];
  if(services.length!==1||views.length!==1)throw new Error('售出页尚未就绪');
  const root=views[0],tabs=[...root.querySelectorAll('[role="tablist"][aria-label="商店买卖"] [role="tab"]')].filter(e=>text(e)==='售出');
  const search=root.querySelector('input[aria-label="查找交易物品"]');
  const lists=root.querySelectorAll('.entry-list');
  const categories=root.querySelector('[aria-label="售出物品类别"]');
  if(categories){const all=[...categories.querySelectorAll('button')].filter(el=>text(el)==='全部');if(all.length!==1||all[0].getAttribute('aria-pressed')!=='true')throw new Error('售出类别仍在筛选，不能核对库存');}
  if(tabs.length!==1||tabs[0].getAttribute('aria-selected')!=='true'||!search||search.value||lists.length!==1||root.querySelector('[aria-busy="true"],[role="progressbar"],.loading'))throw new Error('售出列表仍在加载、筛选或标签未就绪');
  const exact=value=>/^\d[\d,]*$/u.test(value)?value.replaceAll(',',''):null;
  const items=[...lists[0].querySelectorAll('button.entry')].map(el=>{
    const count=text(el.querySelector('.entry-count')),equipped=!!el.querySelector('.entry-count [aria-label="已装备"]');
    const identity=/^#(\d+)$/u.exec(count)?.[1];
    const all=el.parentElement.querySelector('button[aria-label^="售出全部"]');
    const titleCount=/[（(]([\d,]+)个[）)]/u.exec(all?.getAttribute('title')??'')?.[1];
    return {name:text(el.querySelector('.entry-name strong')),identity:identity?'item-'+identity:'',equipped,
      quality:/品质\s*([\d.]+)/u.exec(text(el.querySelector('.entry-name small')))?.[1]??null,
      quantity:identity?'1':exact(count.replace(/^×\s*/u,''))??(all&&!all.disabled&&titleCount?exact(titleCount):null),
      countText:count,price:text(el.querySelector('.entry-price')),category:text(el.querySelector('.entry-name small'))};
  });
  if(!items.length&&!/暂无对应物品/u.test(text(lists[0])))throw new Error('售出列表暂为空，不能确认物品已卖出');
  if(items.some(i=>!i.name||!i.equipped&&!i.identity&&!i.countText.startsWith('×'))||items.length>4000)throw new Error('售出列表结构变化');
  const ids=items.filter(i=>i.identity).map(i=>i.identity);
  if(new Set(ids).size!==ids.length)throw new Error('售出编号重复');
  return {source:'shop-v1',shopName:text(services[0].querySelector('h1')),locationName:text(services[0].querySelector('.eyebrow')),items,
    equipped:items.filter(i=>i.equipped).map(i=>[i.name,i.quality,i.category].join('|')).sort(),
    saved:text(document.querySelector('footer.statusbar')).includes('本地存档已就绪')};
}

export function saleRow(snapshot,line,{missing=false}={}) {
  const rows=snapshot.items.filter(i=>line.identity?i.identity===line.identity:!i.identity&&!i.equipped&&i.name===line.name);
  if(!rows.length&&missing)return null;
  if(rows.length!==1)throw new Error('售出编号缺失、不唯一或已经穿戴：'+line.name+' '+line.id);
  const row=rows[0];
  if(row.equipped||row.name!==line.name||row.quality!==line.quality)throw new Error('售出物品名称、品质或穿戴状态不符：'+line.id);
  return row;
}

export function shopSaleProof(before,after,line,quantity) {
  if(!after.saved||after.shopName!==before.shopName||after.locationName!==before.locationName||JSON.stringify(after.equipped)!==JSON.stringify(before.equipped))return false;
  const old=saleRow(before,line),next=saleRow(after,line,{missing:true});
  // Preserve all other identities; a transient partial render cannot count as
  // disappearance of the target. List order is deliberately irrelevant.
  const remaining=before.items.filter(i=>i.identity&&i.identity!==line.identity).map(i=>i.identity);
  if(remaining.some(id=>!after.items.some(i=>i.identity===id)))return false;
  // Stacks/equipped rows must also remain present: don't accept a partially
  // rendered list just because the remaining numbered equipment happens to fit.
  const otherStacks=before.items.filter(i=>!i.identity&&!i.equipped&&i.name!==line.name);
  if(otherStacks.some(old=>after.items.filter(i=>!i.identity&&!i.equipped&&i.name===old.name).length!==1))return false;
  if(line.identity)return !next;
  if(old.quantity==null||next&&next.quantity==null)return false;
  return BigInt(old.quantity)-BigInt(next?.quantity??'0')===BigInt(quantity);
}

export function shopBulkSaleProof(before,after,lines) {
  if(!lines.length||new Set(lines.map(l=>l.identity)).size!==lines.length||!after.saved||after.shopName!==before.shopName||after.locationName!==before.locationName||JSON.stringify(after.equipped)!==JSON.stringify(before.equipped))return false;
  const sold=new Set(lines.map(l=>l.identity));
  for(const line of lines){if(!line.identity||!saleRow(before,line)||saleRow(after,line,{missing:true}))return false;}
  // Equipped rows have no IDs; their sorted multiset above already preserves
  // duplicates (for example two identical accessories) and their quantities.
  for(const old of before.items.filter(i=>!i.equipped&&!sold.has(i.identity))){
    const next=after.items.filter(i=>old.identity?i.identity===old.identity:!i.identity&&i.equipped===old.equipped&&i.name===old.name&&i.quality===old.quality&&i.category===old.category);
    if(next.length!==1||next[0].name!==old.name||next[0].quality!==old.quality||next[0].equipped!==old.equipped||next[0].countText!==old.countText)return false;
  }
  return true;
}
