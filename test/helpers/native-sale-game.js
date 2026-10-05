// Local fixture mirrors the public game's batch-sale DOM, not its game store.
export function installNativeSale(){
 window.selectedIds=['item-7'];window.nativeCategory='equipment';
 const view=document.querySelector('.shop-view'),list=view.querySelector('.entry-list'),oldRender=window.renderRows;
 const categories=document.createElement('div');categories.setAttribute('role','group');categories.setAttribute('aria-label','售出物品类别');
 for(const [id,label] of [['all','全部'],['equipment','器物'],['part','炼材']]){const button=document.createElement('button');button.textContent=label;button.dataset.category=id;button.onclick=()=>{nativeCategory=id;renderRows();};categories.append(button);}
 const tools=document.createElement('div');tools.className='shop-bulk-tools';tools.innerHTML='<span class="muted small"></span><span class="wallet"></span><button aria-label="清空出售选择">清空</button><button class="bulk">批量售出</button>';
 view.insertBefore(categories,list);view.insertBefore(tools,list);
 const update=()=>{tools.querySelector('.small').textContent='已选 '+selectedIds.length+' 件';tools.querySelector('.wallet').title=(selectedIds.length*100)+' 灵石';tools.querySelector('[aria-label]').disabled=!selectedIds.length;tools.querySelector('.bulk').disabled=!selectedIds.length;for(const b of categories.children)b.setAttribute('aria-pressed',String(b.dataset.category===nativeCategory));};
 tools.querySelector('[aria-label]').onclick=()=>{selectedIds=[];renderRows();};
 tools.querySelector('.bulk').onclick=()=>{
  visits.push('bulk-review');const chosen=bag.filter(i=>selectedIds.includes(i.identity)),d=document.createElement('dialog');
  const review=chosen.map(i=>({...i}));if(window.reviewFault==='extra')review.push({...bag.find(i=>i.identity==='item-7')});if(window.reviewFault==='quality')review[0].quality='99';if(window.reviewFault==='price')review[0].price='101';
  d.innerHTML='<header><h2>确认批量售出</h2><button aria-label="关闭窗口">X</button></header><div class="shop-sale-review">'+review.map(i=>'<div class="quality-marked"><span><strong>'+i.name+'</strong><small>品质 '+i.quality+' · #'+i.identity.slice(5)+'</small></span><span class="entry-price" title="'+(i.price??100)+' 灵石">100 灵石</span></div>').join('')+'</div><footer><button class="commit">售出 '+review.length+' 件 · '+(review.length*100)+' 灵石</button></footer>';
  d.querySelector('header button').onclick=()=>d.remove();
  d.querySelector('.commit').onclick=async()=>{
   actions.push(['sell-bulk',chosen.map(i=>i.identity)]);d.querySelector('.commit').disabled=true;
   if(window.tradeDelay)await new Promise(resolve=>setTimeout(resolve,tradeDelay));
   if(window.noSale){d.querySelector('.commit').disabled=false;return;}
   const ids=(window.partialSale?chosen.slice(0,1):chosen).map(i=>i.identity);bag=bag.filter(i=>!ids.includes(i.identity));
   if(window.reorder)bag.reverse();selectedIds=[];renderRows();d.remove();
   document.querySelector('footer.statusbar').textContent=saved?'本地存档已就绪':'正在保存';window.afterSale?.();
  };
  document.body.append(d);d.showModal();
 };
 window.renderRows=()=>{
  oldRender();
  for(const entry of list.querySelectorAll('button.entry')){
   const row=entry.parentElement,id=/^#(\d+)$/u.exec(entry.querySelector('.entry-count').textContent)?.[1];
   const item=id?bag.find(i=>i.identity==='item-'+id):null;
   if(nativeCategory!=='all'&&(!item||Boolean(item.slot)!==(nativeCategory==='equipment'))){row.remove();continue;}
   if(!item)continue;
   row.className='shop-instance-entry';const box=document.createElement('input');box.type='checkbox';box.setAttribute('aria-label',`选择${item.name}，品质${item.quality}，编号${item.identity}`);box.checked=selectedIds.includes(item.identity);box.disabled=item.equipped;
   box.onchange=()=>{selectedIds=box.checked?[...new Set([...selectedIds,item.identity])]:selectedIds.filter(id=>id!==item.identity);update();};row.prepend(box);
  }
  if(!list.children.length)list.innerHTML='<p>暂无对应物品</p>';update();
 };
 view.querySelector('input[type=search]').oninput=()=>renderRows();renderRows();
}
