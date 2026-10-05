(() => {
  const slots={weapon:'兵刃',head:'头部',body:'上身',legs:'腿部',feet:'足部',accessory:'饰品',artifact:'法宝',special:'特殊'};
  const names={preparing:'核对中',retreating:'撤退中','stopping-heal':'停止调息',executing:'执行中',issued:'已提交，核对结果',verified:'本地保存已确认','awaiting-review':'需要核对结果','awaiting-continue':'等待继续剩余',completed:'已完成',cancelled:'剩余已取消'};
  const n=(tag,cls,value)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(value!=null)el.textContent=value;return el;};
  const button=(title,fn,cls='secondary')=>{const b=n('button',cls,title);b.type='button';b.onclick=fn;return b;};
  const id=i=>i.identity?'instance:'+i.identity:i.gameItemId?'stack:'+i.gameItemId:null;
  let state={},selected=new Set(),bulk=false,list={view:'inventory',items:[],all:[]},current=null,preview=null,pending=null,error='',dialogMode='',slot='',choice='',stamp='',shopChoice='';
  let equipSubmission=null;
  const quantities=new Map();let quantityItem=null,quantityValue='',gesture=null,suppressClick=false,blockDoubleUntil=0,scrollFrame=0;
  const dialog=n('dialog','library-detail inventory-dialog');dialog.id='inventory-action-dialog';dialog.setAttribute('aria-labelledby','inventory-action-title');
  const header=n('header'),title=n('h2');title.id='inventory-action-title';header.append(title,button('✕',()=>dialog.close(),'quiet'));
  header.lastChild.setAttribute('aria-label','关闭物品操作');const body=n('div','inventory-action-body');dialog.append(header,body);document.body.append(dialog);
  const blocked=()=>Boolean(state.busy||state.crafting?.activeId||state.inventoryActions?.activeId||pending);
  function art(i){return window.InventoryLibrary.picture(i);}
  function summary(i){const row=n('div','inventory-line');row.append(art(i));const desc=n('div');desc.append(n('strong','',i.name),n('small','muted',`${i.quality?'品质 '+i.quality+' · ':''}${i.identity?'编号 '+i.identity:'类型 '+(i.gameItemId??'待核实')}`));row.append(desc);return row;}
  async function request(kind,payload){
    if(pending)return;error='';pending={waiting:true};renderDialog();const result=await send('inventory-'+kind,payload);pending=result?{job:result.id,kind}:null;settle();renderDialog();
  }
  function settle(){const cmd=state.lastCommand;if(pending?.job&&cmd?.id===pending.job){pending=null;if(!cmd.ok)error=cmd.error;else if(cmd.previewId){preview=state.inventoryActions?.previews.find(p=>p.id===cmd.previewId);dialogMode='confirm';}else if(cmd.operationId||cmd.already){dialogMode='submitted';if(equipSubmission)equipSubmission.already=Boolean(cmd.already);}}
    if(equipSubmission&&state.inventoryActions?.operations.some(o=>o.id===equipSubmission.requestId)){pending=null;dialogMode='submitted';}
  }
  function previewSale(ids){equipSubmission=null;preview=null;dialogMode='loading';title.textContent='核对卖出清单';if(!dialog.open)dialog.showModal();void request('preview',{kind:'sell',ids});}
  const shopTitle=s=>s?`${s.regionName} / ${s.locationName} / ${s.name??s.shopName}`:'尚未选择';
  function chosenShop(){const shops=state.catalog?.shops??[],target=state.inventoryActions?.saleTarget;return shops.find(s=>s.id===shopChoice)||shops.find(s=>s.regionName===target?.regionName&&s.locationName===target?.locationName&&s.name===target?.shopName);}
  function shopStatus(s){
    if(state.state?.region===s.regionName&&state.state?.location===s.locationName){const entries=(state.state.localServices??[]).filter(e=>e.name===s.name);if(entries.length===1)return entries[0].enabled?'入口当前可用':'入口暂不可用';}
    const node=state.catalog?.nodes?.find(n=>n.id===s.locationId);
    return node?.availability==='locked'?'地点锁定':node?.availability==='visible'?'地点可见，入口到达后核实':'地点尚未核实';
  }
  function toolbar(){
    const root=$('inventory-toolbar');root.hidden=list.view!=='inventory';root.replaceChildren();if(root.hidden)return;
    const store=n('div','inventory-shop'),label=n('label','','卖出地点（地图中的全部商会与货摊）'),select=n('select');select.setAttribute('aria-label','卖出商店');
    const shops=state.catalog?.shops??[],target=state.inventoryActions?.saleTarget;
    const active=shops.find(s=>s.regionName===target?.regionName&&s.locationName===target?.locationName&&s.name===target?.shopName);
    const ordered=[...shops].sort((a,b)=>(state.catalog?.regions??[]).findIndex(r=>r.name===a.regionName)-(state.catalog?.regions??[]).findIndex(r=>r.name===b.regionName));
    options(select,[{value:'',label:shops.length?'选择卖出地点':'目录待刷新'},...ordered.map(s=>({value:s.id,label:shopTitle(s)+' · '+shopStatus(s)}))],shopChoice||active?.id||'');
    select.onchange=()=>{shopChoice=select.value;toolbar();records();};label.append(select);store.append(label);
    const save=button('保存卖出地点',()=>{const s=shops.find(s=>s.id===select.value);if(s)void send('settings',{revision:state.revision,saleTarget:{regionName:s.regionName,locationName:s.locationName,shopName:s.name}});});save.disabled=Boolean(state.busy||pending||!select.value||select.value===active?.id);store.append(save);
    const refresh=button('刷新商会目录',()=>send('refresh',{shopsOnly:true}));refresh.disabled=Boolean(state.busy||pending);store.append(refresh);
    root.append(store);
    root.append(n('p','hint',`已收录 ${shops.length} 处 · 当前生效：${shopTitle(target)}`));
    if(select.value&&select.value!==active?.id)root.append(n('p','hint','地点尚未保存；保存后用于下一批卖出。已暂停的批次可在下方明确选择改店后继续。'));
    const chosen=chosenShop();if(chosen?.prerequisiteName)root.append(n('p','hint',`商会开放条件：${chosen.prerequisiteName}；地点可见不代表商会已开放。`));
    const row=n('div','inventory-selection');row.append(n('span','muted',`已选 ${selected.size} 项${selected.size?'（含筛选隐藏项）':''}`));
    row.append(button(bulk?'退出选择':'批量选择',()=>{bulk=!bulk;window.InventoryLibrary.render();}));
    if(bulk){row.append(button('全选当前筛选',()=>{for(const i of list.items)if(id(i)&&i.equipped===false)selected.add(id(i));window.InventoryLibrary.render();}),button('清空',()=>{selected.clear();quantities.clear();window.InventoryLibrary.render();}));const sell=button('卖出已选',()=>previewSale([...selected]),'danger');sell.disabled=!selected.size||blocked();row.append(sell);}
    root.append(row);
    if(bulk)root.append(n('p','hint','单击选中 / 取消 · 双击设置数量 · 按住拖过多张卡片连续选择'));
  }
  const selectable=item=>Boolean(item&&id(item)&&item.equipped===false);
  function paintSelection(){
    for(const wrap of $('library-grid').querySelectorAll('.inventory-card')){
      const item=list.items.find(i=>i.key===wrap.dataset.itemKey);if(!item)continue;const checked=selected.has(id(item));wrap.classList.toggle('selected',checked);
      const check=wrap.querySelector('input[type=checkbox]');if(check)check.checked=checked;
      const card=wrap.querySelector('.collection-item');if(bulk)card.setAttribute('aria-pressed',String(checked));
      const amount=wrap.querySelector('.selection-quantity');if(amount)amount.textContent=item.identity?'1 件':quantities.has(id(item))?`× ${quantities.get(id(item))}`:'全部';
    }
  }
  function selectItem(item,checked){if(!selectable(item))return;const key=id(item);if(checked)selected.add(key);else selected.delete(key);paintSelection();toolbar();}
  function openQuantity(item){
    if(!selectable(item)||Date.now()<blockDoubleUntil)return;
    equipSubmission=null;
    selectItem(item,true);quantityItem=item;quantityValue=String(quantities.get(id(item))??(item.identity?1:item.quantity));dialogMode='quantity';error='';
    title.textContent='设置选中数量';renderDialog();if(!dialog.open)dialog.showModal();body.querySelector('input')?.focus();
  }
  function decorate(value){endGesture();list=value;toolbar();if(list.view!=='inventory')return;
    for(const item of list.items){const wrap=[...$('library-grid').children].find(el=>el.dataset.itemKey===item.key);if(!wrap)continue;wrap.classList.toggle('selection-mode',bulk);if(!bulk)continue;
      const label=n('label','inventory-checkbox'),check=n('input');check.type='checkbox';check.checked=selected.has(id(item));check.disabled=!id(item)||item.equipped!==false;check.setAttribute('aria-label','选择'+item.name+' '+(item.identity??item.gameItemId??'待核实'));
      check.onchange=()=>selectItem(item,check.checked);label.append(n('span','selection-quantity'),check);wrap.append(label);
      const card=wrap.querySelector('.collection-item');card.setAttribute('aria-label','选择'+item.name+' '+(item.identity||item.gameItemId||'待核实'));card.setAttribute('aria-disabled',String(!selectable(item)));
      card.onclick=e=>{e.preventDefault();if(e.detail<2)selectItem(item,!selected.has(id(item)));};
      wrap.ondblclick=e=>{e.preventDefault();openQuantity(item);};
      card.onkeydown=e=>{if(e.key==='F2'){e.preventDefault();openQuantity(item);}};
    }
    paintSelection();
  }
  // Paint selection is local UI state only. Every visited ID gets the same
  // select/deselect intent, so crossing a card twice never toggles it back.
  const grid=$('library-grid');
  function itemAt(x,y){const wrap=document.elementFromPoint(x,y)?.closest('.inventory-card');return wrap&&grid.contains(wrap)?list.items.find(i=>i.key===wrap.dataset.itemKey):null;}
  function paintItem(item){if(!gesture||!selectable(item)||gesture.visited.has(id(item)))return;gesture.visited.add(id(item));selectItem(item,gesture.checked);}
  function beginPaint(){if(!gesture||gesture.painting)return;gesture.painting=true;paintItem(gesture.item);scrollFrame=requestAnimationFrame(edgeScroll);}
  function edgeScroll(){if(!gesture?.painting)return;const dy=gesture.y<64?-12:gesture.y>innerHeight-64?12:0;if(dy){window.scrollBy(0,dy);paintItem(itemAt(gesture.x,gesture.y));}scrollFrame=requestAnimationFrame(edgeScroll);}
  function endGesture(){if(!gesture)return;clearTimeout(gesture.timer);cancelAnimationFrame(scrollFrame);if(gesture.painting){suppressClick=true;blockDoubleUntil=Date.now()+300;}const pointer=gesture.pointer;gesture=null;if(grid.hasPointerCapture(pointer))grid.releasePointerCapture(pointer);}
  grid.addEventListener('pointerdown',e=>{
    if(!bulk||list.view!=='inventory'||!e.isPrimary||e.button!==0)return;const item=itemAt(e.clientX,e.clientY);if(!selectable(item))return;
    suppressClick=false;gesture={pointer:e.pointerId,item,checked:!selected.has(id(item)),visited:new Set(),startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,painting:false};
    // Keep normal click and double-click targeting intact. Capture only after
    // movement starts; touch already uses implicit capture.
    if(e.pointerType!=='mouse')gesture.timer=setTimeout(beginPaint,350);
  });
  window.addEventListener('pointermove',e=>{
    if(!gesture||e.pointerId!==gesture.pointer)return;if(!e.buttons&&e.pointerType==='mouse'){endGesture();return;}
    const from={x:gesture.x,y:gesture.y};gesture.x=e.clientX;gesture.y=e.clientY;
    if(!gesture.painting&&Math.hypot(e.clientX-gesture.startX,e.clientY-gesture.startY)>6){beginPaint();grid.setPointerCapture(e.pointerId);}
    if(!gesture.painting)return;e.preventDefault();const steps=Math.max(1,Math.ceil(Math.hypot(e.clientX-from.x,e.clientY-from.y)/18));
    for(let i=1;i<=steps;i++)paintItem(itemAt(from.x+(e.clientX-from.x)*i/steps,from.y+(e.clientY-from.y)*i/steps));
  },{passive:false});
  window.addEventListener('pointerup',endGesture);window.addEventListener('pointercancel',endGesture);window.addEventListener('blur',endGesture);
  grid.addEventListener('dragstart',e=>{if(bulk)e.preventDefault();});
  grid.addEventListener('contextmenu',e=>{if(bulk)e.preventDefault();});
  grid.addEventListener('click',e=>{if(suppressClick&&bulk){suppressClick=false;e.preventDefault();e.stopImmediatePropagation();requestAnimationFrame(paintSelection);}},{capture:true});
  function detail(){const root=$('inventory-detail-actions');root.replaceChildren();if(current?.view!=='inventory')return;
    const item=current.item;root.append(n('p','muted',`${item.identity?'实例编号：'+item.identity:'物品类型：'+(item.gameItemId??'待核实')} · 库存 ${item.quantity}`));
    const sell=button('卖出',()=>previewSale([id(item)]),'danger');sell.disabled=blocked()||!id(item)||item.equipped!==false;root.append(sell);
    if(item.slot&&item.identity){const equip=button('更换装备',()=>chooseSlot({slot:slots[item.slot]},id(item)));equip.disabled=blocked();root.append(equip);}
    if(!id(item)||item.equipped!==false)root.append(n('p','hint','操作字段待核实，请刷新行囊；不会出售已穿戴装备。'));
  }
  function chooseSlot(rack,preselect=''){
    slot=Object.keys(slots).find(s=>slots[s]===rack.slot);choice=preselect;equipSubmission=null;preview=null;error='';dialogMode='equip';title.textContent='更换'+rack.slot+'装备';renderDialog();if(!dialog.open)dialog.showModal();
  }
  function renderDialog(){
    if(!dialogMode)return;const scroll=dialog.scrollTop;body.replaceChildren();
    if(dialogMode==='quantity'&&quantityItem){
      const item=quantityItem;body.append(summary(item));const label=n('label','quantity-picker','选中数量'),input=n('input');input.type='number';input.min=1;input.step=1;input.max=item.identity?1:item.quantity;input.value=quantityValue;input.disabled=Boolean(item.identity);input.setAttribute('aria-label','选中数量');input.oninput=()=>{quantityValue=input.value;};label.append(input);body.append(label);
      body.append(n('p','hint',item.identity?'独立装备或炼材按编号选择，固定 1 件。':'此处只设置本次选择，不会立即卖出；提交前仍会重新核对库存。'));
      const actions=n('div','controls');if(!item.identity)actions.append(button('使用全部库存',()=>{quantities.delete(id(item));dialog.close();paintSelection();}));
      actions.append(button('保存数量',()=>{if(!input.reportValidity())return;quantities.set(id(item),Number(input.value));dialog.close();paintSelection();},'primary'));body.append(actions);
    }else if(dialogMode==='equip'){
      const items=(window.InventoryLibrary.inventory()?.items??[]).filter(i=>i.slot===slot&&i.identity&&i.equipped===false);
      const replace=button('替换装备',()=>{
        if(blocked()||!items.some(i=>id(i)===choice))return;
        equipSubmission??={requestId:crypto.randomUUID(),id:choice,slot};
        void request('equip',equipSubmission);
      },'primary');replace.disabled=blocked()||!items.some(i=>id(i)===choice);
      const field=n('fieldset','inventory-candidates');field.disabled=Boolean(pending);field.append(n('legend','','选择具体装备'));
      for(const i of items){const label=n('label','craft-candidate'),radio=n('input');radio.type='radio';radio.name='inventory-equipment';radio.value=id(i);radio.checked=choice===id(i);radio.onchange=()=>{choice=id(i);equipSubmission=null;replace.disabled=blocked();};label.append(radio,summary(i));field.append(label);}body.append(field);
      if(!items.length)body.append(n('p','hint','当前快照没有可用装备；旧缓存的部位待核实，请先刷新行囊。'));
      body.append(replace,n('p','hint','选中后直接替换到游戏中，完成后自动刷新配装并恢复原挂机状态。'));
    }else if(dialogMode==='confirm'&&preview){
      title.textContent=preview.kind==='sell'?'确认卖出清单':'确认更换装备';
      if(preview.shop)body.append(n('p','hint',`${preview.shop.regionName} / ${preview.shop.locationName} / ${preview.shop.name}`));
      for(const line of preview.lines){const row=summary(line);
        if(preview.kind==='sell'){
          const label=n('label','','本批数量'),input=n('input');input.type='number';input.min=1;input.max=line.quantity;input.value=quantities.get(line.id)??line.quantity;input.disabled=Boolean(line.identity||pending);input.dataset.lineId=line.id;input.setAttribute('aria-label',line.name+' '+line.id+' 卖出数量');
          const total=n('small','muted');const update=()=>{try{total.textContent='预计回收 '+(BigInt(line.unitPrice)*BigInt(input.value)).toString()+' 灵石';}catch{total.textContent='请输入整数数量';}};input.oninput=update;update();label.append(input,total);row.append(label);
        }else row.append(n('small','muted','当前：'+(line.original?.identity??'未装备')));
        body.append(row);
      }
      if(preview.comparison)body.append(n('pre','inventory-comparison',preview.comparison));
      body.append(n('p','hint',preview.kind==='sell'?'器物和炼材优先勾选后统一售出，每组最多 1000 件；叠加物品按确认数量处理。不追加后来获得的物品，也不卸下已穿戴装备。':'通过游戏内装备按钮更换；核对编号及旧装备回包。'));
      body.append(n('p','hint','操作完成后核对游戏本地保存，再恢复原挂机状态；不上传云存档。'));
      const execute=button(preview.kind==='sell'?'确认卖出本批':'更换装备',()=>{const quantities={};for(const input of body.querySelectorAll('[data-line-id]')){if(!input.reportValidity())return;quantities[input.dataset.lineId]=Number(input.value);}void request('execute',{previewId:preview.id,quantities});},preview.kind==='sell'?'danger':'primary');
      execute.disabled=blocked()||Boolean(state.inventoryActions?.operations.some(o=>o.id===preview.id));body.append(execute);
    }else if(dialogMode==='submitted'){
      const operation=equipSubmission&&state.inventoryActions?.operations.find(o=>o.id===equipSubmission.requestId);
      if(operation){
        const result=n('div','craft-record');result.setAttribute('role','status');
        result.append(n('strong','',`换装 · ${names[operation.stage]??operation.stage}`),summary(operation.lines[0]));
        if(operation.stage==='completed')result.append(n('p','','装备已替换，本地保存已确认。'));
        if(operation.error)result.append(n('p','reason',operation.error));body.append(result);
      }else body.append(n('p','',equipSubmission?.already?'所选装备已经穿戴，无需再次替换。':'已提交。批次进度显示在行囊的操作记录中。'));
    }
    else body.append(n('p','','正在重新读取游戏库存与条件，尚未执行卖出或换装。'));
    if(pending)body.append(n('p','hint',equipSubmission?'正在排队替换装备…':'正在排队核对游戏…'));if(error)body.append(n('p','reason',error));dialog.scrollTop=scroll;
  }
  function records(){const root=$('inventory-status');root.replaceChildren();const ops=state.inventoryActions?.operations??[];if(!ops.length)return;
    const active=ops.find(o=>o.id===state.inventoryActions.activeId),history=n('details');history.append(n('summary','',`物品操作记录 · ${ops.length}`));
    const record=o=>{const box=n('article','craft-record');box.append(n('strong','',`${o.kind==='sell'?'卖出':'换装'} · ${names[o.stage]??o.stage}`));
      for(const l of o.lines){const waiting=o.pending?.lineIds?o.pending.lineIds.includes(l.id)?1:0:o.pending?.lineId===l.id?o.pending.quantity:0;box.append(n('p','',`${l.name} · ${l.identity||l.gameItemId} · ${l.quality?'品质 '+l.quality+' · ':''}已确认 ${l.completed} / ${l.quantity}${waiting?' · 待核对 '+waiting:''}${o.stage==='cancelled'?' · 其余已取消':''}`));}
      if(o.kind==='sell')box.append(n('p','hint','本批卖出地点：'+shopTitle(o.shop)));
      box.append(n('p','hint',o.pending?'本次动作及本地保存仍待核对':'已确认的项目均已核对游戏本地保存。'));if(o.error)box.append(n('p','reason',o.error));box.append(n('small','muted',`${date(o.updatedAt)} · ${o.id}`));
      const selectedShop=o.kind==='sell'?chosenShop():null,changeShop=selectedShop&&selectedShop.id!==o.shop?.id;
      if(o.inspection)box.append(n('p','hint',`售出流程已检查：${o.inspection.name} · ${date(o.inspection.checkedAt)}，检查未出售物品。`));
      if(o===active&&o.kind==='sell'){const inspect=button('检查售出流程（不卖出）',()=>send('inventory-review',{operationId:o.id,inspectSale:true}));inspect.disabled=Boolean(state.busy||o.pending||o.cancelRequested);box.append(inspect);}
      if(o===active&&changeShop)box.append(n('p','hint','继续时将前往：'+shopTitle(selectedShop)+'；只处理原清单中的剩余数量。'));
      if(o===active)for(const [label,kind] of [['仅核对结果','review'],[changeShop?'改到所选商会并继续剩余':'继续剩余','continue'],['取消剩余','cancel']]){const b=button(label,()=>send('inventory-'+kind,{operationId:o.id,...(kind==='continue'&&changeShop?{shopId:selectedShop.id}:{})}));b.disabled=kind==='continue'?Boolean(state.busy||o.pending||o.cancelRequested):kind==='review'?Boolean(state.busy):false;box.append(b);}return box;};
    if(active)root.append(record(active));for(const o of ops.filter(o=>o!==active))history.append(record(o));root.append(history);
  }
  window.InventoryActions={decorate,chooseSlot};
  window.addEventListener('recipe-detail',e=>{current=e.detail;detail();});
  window.addEventListener('battle-state',e=>{
    state=e.detail;settle();const key=JSON.stringify([state.busy,state.inventoryActions,state.crafting?.activeId,state.catalog?.updatedAt,state.state?.localServices,state.state?.region,state.state?.location,state.revision,pending,error]);
    if(key!==stamp){stamp=key;toolbar();detail();records();
      // SSE must not erase edited quantities, selected equipment or scroll.
      const values=new Map([...body.querySelectorAll('[data-line-id]')].map(i=>[i.dataset.lineId,i.value]));
      if(dialog.open)renderDialog();for(const input of body.querySelectorAll('[data-line-id]'))if(values.has(input.dataset.lineId)){input.value=values.get(input.dataset.lineId);input.dispatchEvent(new Event('input'));}
    }
  });
})();
