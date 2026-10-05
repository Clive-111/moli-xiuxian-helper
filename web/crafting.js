(() => {
  const stages={preparing:'核对游戏',retreating:'撤退中','stopping-heal':'停止调息',baseline:'核对游戏',ready:'复核材料',issued:'已提交，等待结算',reviewing:'核对结果与本地保存',refreshing:'更新行囊与可选材料',syncing:'刷新行囊',completed:'本批炼制已结算',cancelled:'未提交，已取消',refreshed:'行囊已刷新',unconfirmed:'结果未确认（不阻塞操作）','awaiting-review':'需要核对结果','awaiting-sync':'需要核对结果'};
  let current=null, draft={quantity:1,instanceIds:[]}, preview=null, pending=null, state={}, renderKey='', requestError='';
  let historyPending=null,historyMessage='';
  const finished=op=>['completed','cancelled','refreshed','unconfirmed'].includes(op.stage)&&state.crafting?.activeId!==op.id;
  const node=(tag,cls,value)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(value!=null)n.textContent=value;return n;};
  const button=(label,fn,cls='secondary')=>{const b=node('button',cls,label);b.type='button';b.onclick=fn;return b;};
  function settlePending(){
    const cmd=state.lastCommand;
    if(pending?.id&&cmd?.id===pending.id){
      pending=null;if(!cmd.ok)requestError=cmd.error;
      if(cmd.previewId)preview=state.crafting?.previews.find(p=>p.id===cmd.previewId)??null;
    }
    const submitted=preview?.id??pending?.previewId;
    if(submitted&&state.crafting?.operations?.some(op=>op.id===submitted)){preview=null;pending=null;}
  }
  function changed(){preview=null;requestError='';render();}
  function form(){
    const root=$('crafting-form'),focused=document.activeElement;
    const focusedRadio=root.contains(focused)&&focused.type==='radio'?{name:focused.name,value:focused.value}:null;
    const scrolls=[...root.querySelectorAll('.craft-candidates')].map(field=>field.scrollTop),detailScroll=$('library-detail').scrollTop;
    root.replaceChildren();
    if(current?.view!=='crafting'||!current.detail)return;
    const operation=state.crafting?.operations?.find(op=>op.selection.key===current.item.key);
    if(operation){const progress=record(operation);progress.classList.add('craft-result');progress.setAttribute('role','status');root.append(progress);}
    root.append(node('h3','','选择本批材料与数量'));
    // Choosing cached materials is local. Only lock the draft once this batch
    // is being checked/executed; game reads still block submitting the batch.
    const frozen=Boolean(state.crafting?.activeId)||Boolean(state.inventoryActions?.activeId)||Boolean(pending),submitBlocked=frozen||Boolean(state.busy);
    const batch=['普通炼制','精炼'].includes(current.item.recipeType);
    if(batch){
      const row=node('div','craft-quantity');
      for(const q of [1,10,'all']){const b=button(q==='all'?'全部（本批最多 10000 炉）':q+' 炉',()=>{draft.quantity=q;changed();},draft.quantity===q?'primary':'secondary');b.disabled=frozen;row.append(b);}
      const label=node('label','','自定义炉数');const input=node('input');input.type='number';input.min=1;input.max=10000;input.value=draft.quantity==='all'?'':draft.quantity;input.placeholder='1–10000';input.setAttribute('aria-label','自定义炼制炉数');input.disabled=frozen;
      input.onchange=()=>{draft.quantity=Number(input.value);changed();};label.append(input);root.append(row,label);
    }else{
      current.detail.ingredients.forEach((group,index)=>{
        const field=node('fieldset','craft-candidates');field.disabled=frozen;field.append(node('legend','',`${group.label||group.name} · 可选 ${group.candidates?.length??0} 件`));
        for(const candidate of group.candidates??[]){
          const label=node('label','craft-candidate'),radio=node('input');radio.type='radio';radio.name='material-'+index;radio.value=candidate.id;radio.checked=draft.instanceIds[index]===candidate.id;
          radio.onchange=()=>{draft.instanceIds[index]=candidate.id;changed();};
          const info=node('span','craft-candidate-info');info.append(node('strong','',candidate.name),node('small','',`品质 ${candidate.quality} · 编号 ${candidate.id}`),node('span','craft-selected','已选择'));label.append(radio,current.picture(candidate),info);field.append(label);
        }
        if(!group.candidates?.length)field.append(node('p','muted','没有可选的未装备材料；不会自动卸下装备。'));
        root.append(field);
      });
    }
    const verify=button('核对本批',async()=>{
      const key=current.item.key;
      requestError='';preview=null;pending={waiting:true};render();
      const job=await send('craft-preview',{key,quantity:draft.quantity,instanceIds:draft.instanceIds});
      if(current?.item.key===key){pending=job?{id:job.id}:null;settlePending();render();}
    });verify.disabled=submitBlocked;root.append(verify);
    if(state.busy&&!frozen)root.append(node('p','hint','材料可以先选好，当前游戏操作完成后即可核对本批。'));
    if(requestError)root.append(node('p','reason',requestError));
    if(preview){
      const s=preview.selection,box=node('div','craft-preview');box.append(node('strong','',`${s.name} · 本批 ${s.quantity} ${batch?'炉':'组'}`));
      for(const m of s.materials){const exact=/^\d+$/u.test(m.perUnit.replaceAll(',',''));box.append(node('p','',`${m.name}：${exact?String(BigInt(m.perUnit.replaceAll(',',''))*BigInt(s.quantity)):m.perUnit+' × '+s.quantity}（持有 ${m.owned}）`));}
      for(const i of s.instances)box.append(node('p','',`消耗：${i.name} · 品质 ${i.quality} · 编号 ${i.id}`));
      for(const fact of s.facts)box.append(node('p','',`${fact.label}：${fact.value}`));
      box.append(node('p','hint','必要时先撤退、停止调息，再进入炉鼎炼制。完成后恢复原先的挂机；原本停止就保持停止。概率失败也可能消耗材料，全部只执行本次核实的数量。'));
      const execute=button('执行本批炼制',async()=>{
        const id=preview.id,key=current.item.key;pending={waiting:true,previewId:id};render();
        const job=await send('craft-execute',{previewId:id});
        if(current?.item.key===key){pending=job?{id:job.id,previewId:id}:null;settlePending();render();}
      },'primary');execute.disabled=submitBlocked||Boolean(state.crafting?.operations?.some(o=>o.id===preview.id));box.append(execute);root.append(box);
    }
    root.append(node('p','hint','只操作你提交的这一批；完成后自动刷新行囊，库存差异不会阻塞后续操作，也不会自动重复开炉。'));
    [...root.querySelectorAll('.craft-candidates')].forEach((field,index)=>{field.scrollTop=scrolls[index]??0;});
    if(focusedRadio)[...root.querySelectorAll('input[type=radio]')].find(r=>r.name===focusedRadio.name&&r.value===focusedRadio.value)?.focus({preventScroll:true});
    $('library-detail').scrollTop=detailScroll;
  }
  function record(op,history=false){
      const box=node('article','craft-record');box.dataset.operationId=op.id;box.append(node('strong','',`${op.selection.name} · ${op.selection.quantity} ${op.selection.instances.length?'组':'炉'} · ${stages[op.stage]??op.stage}`));
      box.append(node('p','',op.issuedAt?`游戏本地保存：${op.localSaved||op.lastReview?.saved?'已确认':'未确认'}`:'未开炉，未消耗材料'));
      if(op.result)box.append(node('p','',op.result.message+(op.result.produced!=null?` · 产出 ${op.result.produced}，额外产出 ${op.result.bonusProduced}`:'')));
      if(op.refresh){
        const errors=Object.values(op.refresh.errors??{});
        if(errors.length)box.append(node('p','reason','炼制操作已结束，部分资料未更新：'+errors.join('；')+'。可使用「重新读取详情」，不会再次开炉。'));
        else if(op.refresh.detailUpdatedAt)box.append(node('p','hint','已自动刷新行囊和本配方的可选材料，可继续选择下一批。'));
      }
      if(op.error){
        if(op.stage==='cancelled'){const history=node('details');history.append(node('summary','','查看取消原因'),node('p','hint',op.error));box.append(history);}
        else box.append(node('p','reason',op.error));
      }
      if(op.warning){const warning=node('details');warning.append(node('summary','','查看本次库存变化'),node('p','hint',op.warning));box.append(warning);}
      box.append(node('small','muted',`${date(op.updatedAt)} · 操作 ${op.id}`));
      if(op.issuedAt&&(state.crafting.activeId===op.id||['refreshed','unconfirmed'].includes(op.stage))){const retry=button('刷新行囊核对',()=>send('craft-review',{operationId:op.id}));retry.disabled=Boolean(state.busy)||Boolean(state.crafting.activeId&&state.crafting.activeId!==op.id);box.append(retry);}
      if(history&&finished(op)){
        const remove=button(historyPending?.operationId===op.id?'正在排队删除…':'删除',()=>removeHistory(op.id),'quiet craft-delete');
        remove.setAttribute('aria-label','删除'+op.selection.name+'的炼制记录');remove.disabled=Boolean(historyPending);box.append(remove);
      }
      return box;
  }
  function settleHistory(){
    if(!historyPending?.jobId)return;
    const cmd=state.lastCommand;
    if(cmd?.id===historyPending.jobId){historyMessage=cmd.ok?'已删除这条炼制记录。':cmd.error;historyPending=null;}
    else if(!state.crafting?.operations?.some(op=>op.id===historyPending.operationId)){historyMessage='已删除这条炼制记录。';historyPending=null;}
  }
  async function removeHistory(operationId){
    if(historyPending)return;
    historyPending={operationId};historyMessage='';renderHistory();
    const job=await send('craft-delete',{operationId});
    if(job)historyPending.jobId=job.id;
    else{historyPending=null;historyMessage='删除请求未成功，请稍后重试。';}
    settleHistory();renderHistory();
  }
  function renderHistory(){
    const ops=state.crafting?.operations??[],root=$('crafting-history-list'),dialog=$('crafting-history');
    text('crafting-history-count',state.crafting?.historyCount??ops.length);
    if(!dialog.open)return;
    const opened=new Set([...root.querySelectorAll('details[open]')].map(e=>e.closest('[data-operation-id]').dataset.operationId)),scroll=dialog.scrollTop;
    root.replaceChildren(...ops.map(op=>record(op,true)));
    for(const box of root.children)if(opened.has(box.dataset.operationId))box.querySelector('details')?.setAttribute('open','');
    if(!ops.length)root.append(node('p','library-empty','暂无炼制历史'));
    text('crafting-history-hint',(state.crafting?.historyCount>ops.length?`展示最近 ${ops.length} 条记录。 `:'')+'历史结果不阻塞挂机；已结束的记录可删除，已提交操作不会自动重做。');
    text('crafting-history-message',historyMessage);$('crafting-history-message').hidden=!historyMessage;
    dialog.scrollTop=scroll;
  }
  function status(){
    const root=$('crafting-status'),ops=(state.crafting?.operations??[]).filter(op=>!finished(op));root.hidden=!ops.length;root.replaceChildren(...ops.map(op=>record(op)));
    renderHistory();
  }
  $('crafting-history-open').onclick=()=>{historyMessage='';$('crafting-history').showModal();renderHistory();};
  $('crafting-history-close').onclick=()=>$('crafting-history').close();
  function render(){form();status();}
  window.addEventListener('recipe-detail',event=>{
    const next=event.detail;if(next?.item.key!==current?.item.key){draft={quantity:1,instanceIds:[]};preview=null;pending=null;requestError='';}
    if(next?.view==='crafting'&&next.detail){
      // Keep valid choices across SSE reads, but never retain a consumed ID or
      // let an old preview survive a changed material list/count.
      if(current?.detail&&JSON.stringify([current.detail.ingredients,current.detail.materials,current.detail.facts])!==JSON.stringify([next.detail.ingredients,next.detail.materials,next.detail.facts]))preview=null;
      draft.instanceIds=(next.detail.ingredients??[]).map((group,index)=>group.candidates?.some(c=>c.id===draft.instanceIds[index])?draft.instanceIds[index]:undefined);
    }
    current=next;form();
  });
  window.addEventListener('battle-state',event=>{
    state=event.detail;
    settleHistory();
    settlePending();
    // Preserve focused inputs through heartbeat and combat SSE updates.
    const key=JSON.stringify([state.busy,state.crafting,state.inventoryActions?.activeId,pending,preview,requestError,historyPending,historyMessage]);
    if(key!==renderKey){renderKey=key;render();}
  });
})();
