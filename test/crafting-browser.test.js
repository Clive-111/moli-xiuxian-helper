import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BattleUI} from '../src/battle-ui.js';
import {LibraryUI} from '../src/library-ui.js';
import {CraftingUI} from '../src/crafting-ui.js';
import {GAME_ENTRY} from '../src/catalog.js';
import {EventEmitter} from 'node:events';
import {startControlServer} from '../src/control-server.js';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const screenshotDirectory=process.env.CONTAINER_PROFILE_PATH?path.join(os.tmpdir(),'crafting-tests'):path.resolve('work');

let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>browser?.close());
const fixture=type=>`<!doctype html><meta charset="utf-8"><header><button aria-label="上传云存档">上传</button></header><aside class="character-panel"><div class="discord-profile"><h3>测试修士</h3></div><div><span>气血</span><span>80 / 100</span></div></aside><nav class="central-nav"><button class="selected">游历</button><button>行囊</button><button>炉鼎</button></nav><main data-region="北境" data-location="泉亭"></main><footer class="statusbar"><span>本地存档已就绪</span></footer><script>
window.actions=[];window.flags={sleep:false,combat:true,success:true,localFail:false,limit:12};window.stock=24;window.instances={A:{itemId:'knife',quality:9},B:{itemId:'knife',quality:8},C:{itemId:'knife',quality:7}};let history={},logs=[],revision=0,main=document.querySelector('main');const type=${JSON.stringify(type)},batch=['普通炼制','精炼'].includes(type);
window.upload=async()=>{actions.push('upload');const body={characterId:'role',requestId:crypto.randomUUID(),baseRevision:String(revision),save:{format:'f',character:{schemaVersion:'s',contentVersion:'v',life:{number:'1',startedAt:1},fateId:'f',inventory:{herb:String(stock)},instances,history:{crafting:history},log:logs}}};const response=await fetch('/api/client/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(response.ok)revision=Number((await response.json()).revision);};document.querySelector('header button').onclick=upload;
function end(){flags.sleep=false;actions.push('end-heal');show()}
function dialog(){const d=document.createElement('dialog');d.innerHTML='<header><h2>'+type+'</h2><button aria-label="关闭窗口">X</button></header><div class="dialog-body"><div class="item-detail-title"><h2>成品</h2></div><dl class="craft-facts"><div><dt>成功率</dt><dd>80%</dd></div></dl>'+(batch?'<label>炼制炉数<input aria-label="炼制炉数" type="number" min="1" value="1" max="'+Math.min(flags.limit,Math.floor(stock/2))+'"></label><table class="craft-materials"><tbody><tr><th>草药</th><td>'+stock+'</td><td>2</td></tr></tbody></table>':'')+'</div><footer><button class="primary">'+(batch?'开炉炼制':type==='兵刃合炼'?'合炼兵刃':'升炼防具')+'</button></footer>';
const selected=['',''];if(!batch)for(let i=0;i<2;i++){const g=document.createElement('section');g.className='craft-ingredient';g.setAttribute('aria-label',i?'淬炼辅料':'精炼主材');g.innerHTML='<h3>刀</h3><div class="craft-instance-grid"></div>';for(const [id,item] of Object.entries(instances)){const b=document.createElement('button');b.className='craft-instance';b.setAttribute('aria-label','刀，品质'+item.quality+'，编号'+id);b.setAttribute('aria-pressed','false');b.textContent='刀 '+id;b.onclick=()=>{selected[i]=id;g.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)))};g.querySelector('div').append(b)}d.querySelector('.dialog-body').append(g)}
const input=d.querySelector('input');if(input)input.onchange=()=>{input.value=Math.min(flags.limit,Math.floor(stock/2),Number(input.value));};d.querySelector('header button').onclick=()=>d.remove();d.querySelector('footer button').onclick=()=>{if(flags.combat||flags.sleep){actions.push('FORBIDDEN');return;}const quantity=batch?Number(input.value):1;if(!batch&&(selected.some(x=>!x)||selected[0]===selected[1])){actions.push('FORBIDDEN');return;}actions.push('consume:'+quantity+':'+selected.join(','));if(batch)stock-=quantity*2;else{delete instances[selected[0]];delete instances[selected[1]];}
const key=batch?'recipe:potion':type==='兵刃合炼'?'assemble:weapon':'upgrade:armor';history[key]={attempts:String(quantity),successes:flags.success?String(quantity):'0',produced:flags.success?String(quantity):'0',bonusProduced:'0'};logs.push({at:10,message:batch?'不同配方名：完成 '+(flags.success?quantity:0)+'/'+quantity:(type==='兵刃合炼'?'炼器 ':'升炼 ')+'成品，品质 20'});
if(flags.localFail){document.querySelector('footer.statusbar span').textContent='进度已暂停';return;}localStorage.setItem('fixture-save',JSON.stringify({stock,instances,history,logs}));const notice=document.createElement('p');notice.className='craft-notice';notice.textContent='本批炼制已结算';d.querySelector('.dialog-body').append(notice);};document.body.append(d);d.showModal();}
function show(tab='游历'){document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.textContent===tab));
if(tab==='游历'){main.innerHTML='<h1>泉亭</h1>'+(flags.combat?'<section class="activity-view"><span>正在探索</span><button>撤退</button></section>':'<button '+(flags.sleep?'disabled':'')+'>'+(flags.sleep?'调息中':'调息')+'</button>'+(flags.sleep?'<section class="activity-view"><div class="ongoing-activity"><h3>调息中</h3><button>结束活动</button></div></section>':''));if(flags.combat)main.querySelector('button').onclick=()=>{actions.push('retreat');flags.combat=false;show()};else if(flags.sleep)main.querySelector('.ongoing-activity button').onclick=end;return;}
if(tab==='行囊'){main.innerHTML='<div class="inventory-view"><div class="bag-grid"></div></div>';for(const [name,id,qty] of [['草药','',stock],...Object.entries(instances).map(([id,i])=>['刀',id,i.quality])]){const b=document.createElement('button');b.className='bag-item';b.setAttribute('aria-label','查看'+name+'，'+(id?'品质'+qty+'，编号'+id:'持有'+qty+'份'));b.innerHTML='<span class="item-glyph '+(id?'equipment':'material')+'"></span><strong>'+name+'</strong>';main.querySelector('.bag-grid').append(b)}return;}
main.innerHTML='<div class="craft-view"><div class="furnace-strip">可开炉</div><label><input type="checkbox" checked>显示全部</label><div class="craft-grid"><button class="craft-tile ready" aria-label="查看成品，'+type+'，成功产出1份，材料可供 '+(batch?Math.min(flags.limit,Math.floor(stock/2)):Math.floor(Object.keys(instances).length/2))+' 炉"><span class="craft-tile-top"><span>难度 2</span></span><strong>成品</strong><span class="item-glyph material"></span></button><div class="craft-quick-actions"><button>全部</button></div></div></div>';main.querySelector('.craft-tile').onclick=dialog;main.querySelector('.craft-quick-actions button').onclick=()=>actions.push('FORBIDDEN');}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>show(b.textContent));show();</script>`;
async function setup(type){
  const page=await browser.newPage();let uploads=0,fail=false;
  await page.route('**/*',async route=>{
    if(new URL(route.request().url()).pathname==='/api/client/save'){
      uploads++;const b=route.request().postDataJSON();return route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify({characterId:b.characterId,requestId:b.requestId,revision:String(BigInt(b.baseRevision)+1n),savedAt:Date.now()})});
    }
    await route.fulfill({contentType:'text/html',body:fixture(type)});
  });await page.goto(GAME_ENTRY);
  const ui=new BattleUI(page,{characterName:'测试修士',target:{regionName:'北境',stageName:'泉亭'}},{actionDelaySeconds:0,responseTimeoutSeconds:1},()=>{},new AbortController().signal);
  ui.ensureApp=async()=>page.mainFrame();await ui.observe();
  const reader=new LibraryUI(ui,{wait:async()=>{}}),adapter=new CraftingUI(ui,{reader});
  const list=await reader.read('crafting');return {page,ui,reader,adapter,item:list.items[0],get uploads(){return uploads;},failUpload(){fail=true;},fixUpload(){fail=false;}};
}
for(const type of ['普通炼制','精炼','兵刃合炼','防具升炼'])test(`${type}: actual scoped UI consumes selected batch only, verifies local persistence with zero cloud uploads`,async()=>{
  const h=await setup(type);try{
    const p=await h.adapter.preview(h.item,{quantity:2,instanceIds:['A','B']});assert.equal((await h.page.evaluate(()=>actions)).some(x=>x.startsWith('consume')),false);
    await h.adapter.stopActivity(async()=>{});let sealed=0;
    const local=await h.adapter.mutate(p,async()=>{sealed++;});assert.equal(sealed,1);assert.ok(local.verifiedAt);
    const actions=await h.page.evaluate(()=>window.actions);assert.equal(actions.filter(x=>x.startsWith('consume')).length,1);assert.equal(actions.includes('FORBIDDEN'),false);assert.equal((await h.ui.observe()).mode,'rest');
    assert.equal(h.uploads,0);assert.equal(actions.includes('upload'),false);
    assert.ok(await h.page.evaluate(()=>localStorage.getItem('fixture-save')));
    if(!['普通炼制','精炼'].includes(type))assert.deepEqual(await h.page.evaluate(()=>Object.keys(instances)),['C']);
  }finally{await h.page.close();}
});
test('continuous healing uses the confirmed activity stop; changed maximum prevents consuming',async()=>{
  const h=await setup('普通炼制');try{
    await h.page.evaluate(()=>{flags.combat=false;flags.sleep=true;show();});await h.adapter.stopActivity(async()=>{});assert.ok((await h.page.evaluate(()=>actions)).includes('end-heal'));
    const p=await h.adapter.preview(h.item,{quantity:10});await h.page.evaluate(()=>flags.limit=2);
    await assert.rejects(h.adapter.mutate(p,()=>assert.fail('must not issue')),/材料不足/u);assert.equal((await h.page.evaluate(()=>actions)).some(x=>x.startsWith('consume')),false);
  }finally{await h.page.close();}
});

test('armor settlement and recovery read exact bag instances without depending on the optional equipment rack',async()=>{
 const h=await setup('防具升炼');try{
  await h.page.evaluate(()=>{const original=show;show=tab=>{original(tab);if(tab==='行囊'){const rack=document.createElement('section');rack.className='bag-equipment collapsed';rack.innerHTML='<h2>当前配装</h2><button aria-label="展开配装" hidden>展开</button>';document.querySelector('.inventory-view').prepend(rack);}};});
  h.reader.expandEquipment=async()=>assert.fail('craft verification must not toggle the unrelated rack');
  const preview=await h.adapter.preview(h.item,{instanceIds:['A','B']});
  await h.adapter.stopActivity(async()=>{});
  const local=await h.adapter.mutate(preview,async()=>{});assert.ok(local.verifiedAt);
  const inventory=await h.adapter.recoverInventory();assert.deepEqual(Object.keys(inventory.instances),['C']);
  assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x.startsWith('consume')).length,1);
  assert.equal(h.uploads,0);assert.equal(await h.adapter.localReady(),true);
 }finally{await h.page.close();}
});

test('idle character enters the selected recipe directly without retreat or healing actions',async()=>{
  const h=await setup('普通炼制');try{
    await h.page.evaluate(()=>{flags.combat=false;show();});
    const p=await h.adapter.preview(h.item,{quantity:1});await h.adapter.stopActivity(async()=>assert.fail('idle activity must not be interrupted'));
    await h.adapter.mutate(p,async()=>{});
    assert.deepEqual(await h.page.evaluate(()=>actions),['consume:1:,']);assert.equal(h.uploads,0);
    assert.equal(await h.page.locator('nav button.selected').textContent(),'游历');
  }finally{await h.page.close();}
});
test('probability failure still settles locally when cloud service is unavailable',async()=>{
  const h=await setup('普通炼制');try{
    await h.adapter.stopActivity(async()=>{});await h.page.evaluate(()=>flags.success=false);h.failUpload();
    const p=await h.adapter.preview(h.item,{quantity:2}),done=await h.adapter.mutate(p,async()=>{});
    assert.equal(done.source,'settlement');assert.equal(done.inventory.stacks.草药,'20');
    assert.equal(await h.page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-save')).history['recipe:potion'].successes),'0');
    assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x.startsWith('consume')).length,1);assert.equal(h.uploads,0);
  }finally{await h.page.close();}
});

test('click took effect but response timeout never retries; local save failure does not claim success',async()=>{
  for(const localFail of [false,true]){
    const h=await setup('普通炼制');try{
      await h.adapter.stopActivity(async()=>{});await h.page.evaluate(v=>flags.localFail=v,localFail);const p=await h.adapter.preview(h.item,{quantity:1});
      const unique=h.ui.unique.bind(h.ui);h.ui.unique=async(locator,label)=>{const el=await unique(locator,label);if(label==='开炉炼制'){const click=el.click.bind(el);el.click=async()=>{await click();throw new Error('response timeout');};}return el;};
      if(localFail)await assert.rejects(h.adapter.mutate(p,async()=>{}),/超时/u);else assert.ok(await h.adapter.mutate(p,async()=>{}));
      assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x.startsWith('consume')).length,1);
    }finally{await h.page.close();}
  }
});

test('settled material counts are persisted before cleanup; a failed close cannot discard that proof',async()=>{
  const h=await setup('普通炼制');try{
    await h.adapter.stopActivity(async()=>{});
    // Mirror the game: its materials table updates owned counts after settlement.
    const originalRead=h.reader.read.bind(h.reader);
    h.reader.read=async(view,item,options={})=>originalRead(view,item,{...options,visit:options.visit?async args=>{
      await h.page.evaluate(()=>{const b=document.querySelector('dialog footer button'),old=b.onclick;b.onclick=()=>{old();document.querySelector('.craft-materials td').textContent=String(stock);};});
      return options.visit(args);
    }:undefined});
    const p=await h.adapter.preview(h.item,{quantity:2});let sealed=null;
    h.reader.closeDetail=async()=>{assert.ok(sealed?.verifiedAt);throw new Error('close timeout');};
    await assert.rejects(h.adapter.mutate(p,async()=>{},async local=>{sealed=local;}),/close timeout/u);
    assert.equal(sealed.evidenceSource,'recipe-materials');assert.equal(sealed.inventory.stacks.草药,'20');
    assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x.startsWith('consume')).length,1);assert.equal(h.uploads,0);
  }finally{await h.page.close();}
});

test('read-only close reconciles a response timeout and never clicks a replacement modal',async()=>{
  for(const replace of [false,true]){
    const h=await setup('普通炼制');try{
      const original=h.reader.click.bind(h.reader);let closes=0;
      h.reader.click=async(locator,label,options)=>{
        await original(locator,label,options);
        if(label==='关闭查看详情'){
          closes++;
          if(replace)await h.page.evaluate(()=>{const d=document.createElement('dialog');d.innerHTML='<h2>未知确认</h2><button onclick="actions.push(\'FORBIDDEN\')">确认</button>';document.body.append(d);d.showModal();});
          throw new Error('close response timeout');
        }
      };
      if(replace)await assert.rejects(h.adapter.preview(h.item,{quantity:1}),/弹窗|人工处理/u);
      else assert.equal((await h.adapter.preview(h.item,{quantity:1})).selection.quantity,1);
      assert.equal(closes,1);assert.deepEqual(await h.page.evaluate(()=>actions),[]);
    }finally{await h.page.close();}
  }
});
test('panel requires a user preview and a second explicit submit; SSE does not lose choices',async()=>{
  const control=new EventEmitter(),calls=[];
  const item={key:'a'.repeat(64),name:'试炼灵髓',recipeType:'普通炼制',category:'灵髓',maxBatch:12};
  control.library={revision:1,views:{crafting:{items:[item],updatedAt:Date.now()},inventory:{items:[]}},details:{[item.key]:{key:item.key,name:item.name,materials:[{name:'草药',owned:'24',required:'2'}],facts:[],ingredients:[],updatedAt:Date.now()}}};
  const snapshot={settings:{target:{regionName:'北境',stageName:'阶'},healingTarget:null,consumables:{enabled:false,itemNames:[]}},catalog:{regions:[],nodes:[],items:[]},consumables:{},library:{revision:1},phase:'stopped',desired:'stopped',revision:1,logs:[],crafting:{previews:[],operations:[]}};
  control.snapshot=()=>snapshot;control.crafting={snapshot:()=>snapshot.crafting};control.command=(kind,payload)=>{calls.push({kind,payload});return {id:calls.length,kind};};
  const server=await startControlServer(control,{port:0}),page=await browser.newPage();
  try{
    await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.getByRole('tab',{name:/炼制/u}).click();await page.getByRole('button',{name:'查看试炼灵髓详情'}).click();
    await page.getByRole('button',{name:'10 炉',exact:true}).click();await page.getByRole('button',{name:'核对本批',exact:true}).click();
    await page.waitForTimeout(50);const request=calls.at(-1);assert.equal(request.kind,'craft-preview');assert.equal(request.payload.quantity,10);assert.equal(calls.some(c=>c.kind==='craft-execute'),false);
    const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';snapshot.crafting.previews=[{id,selection:{name:item.name,key:item.key,quantity:10,type:'普通炼制',materials:[{name:'草药',perUnit:'2',owned:'24'}],instances:[],facts:[{label:'成功率',value:'80%'}]}}];snapshot.lastCommand={id:calls.length,kind:'craft-preview',ok:true,previewId:id};control.emit('change',snapshot);
    await page.getByRole('button',{name:'执行本批炼制'}).waitFor();assert.match(await page.locator('#crafting-form').textContent(),/草药：20/u);
    await mkdir(screenshotDirectory,{recursive:true});await page.screenshot({path:path.join(screenshotDirectory,'crafting-panel-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'执行本批炼制'}).click();await page.waitForTimeout(50);assert.equal(calls.at(-1).payload.previewId,id);
    await page.setViewportSize({width:412,height:900});await page.screenshot({path:path.join(screenshotDirectory,'crafting-panel-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.getByRole('button',{name:'关闭物品详情',exact:true}).click();
    const selected=snapshot.crafting.previews[0].selection;
    snapshot.crafting.activeId=id;snapshot.crafting.operations=[{id,selection:selected,stage:'awaiting-review',issuedAt:1,updatedAt:Date.now(),localSaved:false,error:'等待核对结果'},
      {id:'old',selection:selected,stage:'cancelled',updatedAt:Date.now(),cloudStatus:'pending',error:'游戏需要人工处理：存档管理'}];
    snapshot.lastCommand={id:calls.length,kind:'craft-execute',ok:false,error:'等待核对结果'};control.emit('change',snapshot);
    await page.getByRole('button',{name:'刷新行囊核对',exact:true}).click();await page.waitForTimeout(50);
    assert.equal(calls.at(-1).kind,'craft-review');assert.equal(calls.at(-1).payload.operationId,id);
    assert.doesNotMatch(await page.locator('#crafting-status').textContent(),/云同步|云存档|undefined/u);
    snapshot.crafting.activeId=null;Object.assign(snapshot.crafting.operations[0],{stage:'refreshed',lastReview:{checkedAt:123,saved:true},error:'',warning:'材料库存增加，无法用净差判断本批产出'});control.emit('change',snapshot);
    await page.waitForFunction(()=>document.getElementById('crafting-status').hidden);
    assert.equal(await page.getByRole('button',{name:'确认完成，结束核对'}).count(),0);
    await page.getByRole('button',{name:'查看试炼灵髓详情'}).click();
    assert.equal(await page.getByRole('button',{name:'核对本批',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'关闭物品详情',exact:true}).click();
    await page.getByRole('button',{name:/炼制历史/u}).click();
    assert.match(await page.locator('#crafting-history-list').textContent(),/未开炉，未消耗材料/u);
    assert.match(await page.locator('#crafting-history-list').textContent(),/行囊已刷新/u);
    await page.locator('#crafting-history-list').getByRole('button',{name:'刷新行囊核对',exact:true}).click();await page.waitForTimeout(50);
    assert.equal(calls.at(-1).kind,'craft-review');
    assert.equal(await page.locator('#crafting-history-list details').filter({has:page.getByText('查看取消原因',{exact:true})}).getAttribute('open'),null);
    await page.screenshot({path:path.join(screenshotDirectory,'crafting-local-status-mobile.png'),fullPage:true});
  }finally{await page.close();await server.close();}
});

test('open recipe updates remaining materials and confirms completion through SSE without manual refresh',async()=>{
  for(const type of ['普通炼制','精炼','兵刃合炼','防具升炼']){
    const batch=['普通炼制','精炼'].includes(type),control=new EventEmitter(),calls=[];
    const item={key:'c'.repeat(64),name:'回辉碧苇长裤',recipeType:type,category:'器物',maxBatch:12};
    const candidate=id=>({id,name:id[0]==='A'?'碧苇长裤':'回辉护腿砂',quality:'108'});
    const ingredients=[{label:'原装备',candidates:['A1','A2','A3'].map(candidate)},{label:'升炼材料',candidates:['B1','B2'].map(candidate)}];
    const detail={key:item.key,name:item.name,materials:batch?[{name:'草药',owned:'24',required:'2'}]:[],ingredients:batch?[]:ingredients,facts:[],updatedAt:1};
    control.library={revision:1,views:{crafting:{items:[item],updatedAt:1},inventory:{items:[]}},details:{[item.key]:detail}};
    const state={settings:{target:{regionName:'北境',stageName:'阶'},healingTarget:null,consumables:{enabled:false,itemNames:[]}},catalog:{regions:[],nodes:[],items:[]},consumables:{},library:{revision:1},phase:'stopped',desired:'stopped',revision:1,logs:[],crafting:{previews:[],operations:[],activeId:null}};
    const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';let selection;
    control.snapshot=()=>state;control.command=(kind,payload)=>{
      calls.push({kind,payload});const jobId=calls.length;
      if(kind==='craft-preview'){
        selection={key:item.key,name:item.name,type,quantity:1,materials:batch?[{name:'草药',perUnit:'2',owned:'24'}]:[],instances:batch?[]:['A1','B1'].map(candidate),facts:[]};
        state.crafting.previews=[{id,selection}];state.lastCommand={id:jobId,kind,ok:true,previewId:id};control.emit('change',state);
      }
      if(kind==='craft-execute'){
        state.busy=kind;state.crafting.activeId=id;state.crafting.operations=[{id,selection,stage:'issued',issuedAt:1,updatedAt:1,localSaved:false}];
        control.emit('change',state); // Can arrive before the POST response.
      }
      return {id:jobId,kind};
    };
    const server=await startControlServer(control,{port:0}),page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    try{
      await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.getByRole('tab',{name:/炼制/u}).click();await page.getByRole('button',{name:'查看'+item.name+'详情'}).click();
      if(!batch){await page.locator('input[value="A1"]').check();await page.locator('input[value="B1"]').check();}
      await page.getByRole('button',{name:'核对本批',exact:true}).click();await page.getByRole('button',{name:'执行本批炼制'}).click();
      await page.locator('#crafting-form .craft-result').getByText(/已提交，等待结算/u).waitFor();
      assert.equal(await page.getByRole('button',{name:'执行本批炼制'}).count(),0);
      const op=state.crafting.operations[0];op.stage='refreshing';op.localSaved=true;control.emit('change',state);
      await page.locator('#crafting-form .craft-result').getByText(/更新行囊与可选材料/u).waitFor();
      const fresh={...detail,updatedAt:2,materials:batch?[{name:'草药',owned:'22',required:'2'}]:[],ingredients:batch?[]:ingredients.map(g=>({...g,candidates:g.candidates.slice(1)}))};
      control.library.details[item.key]=fresh;control.library.revision=2;state.library.revision=2;
      op.stage='completed';op.refresh={detailUpdatedAt:2,updatedAt:2,errors:{}};state.crafting.activeId=null;state.busy=null;
      // Completion must not depend on lastCommand still belonging to this tab.
      state.lastCommand={id:999,kind:'library',ok:true};control.emit('change',state);
      await page.waitForFunction(batch=>batch?document.querySelector('.materials-table tbody')?.textContent.includes('22'):document.querySelectorAll('#crafting-form .craft-candidates input').length===3,batch);
      if(batch){assert.match(await page.locator('.materials-table tbody').innerText(),/22/u);}
      else{
        assert.equal(await page.locator('.craft-candidates').nth(0).locator('input').count(),2);
        assert.equal(await page.locator('.craft-candidates').nth(1).locator('input').count(),1);
        assert.equal(await page.locator('#crafting-form input:checked').count(),0);
        assert.equal(await page.locator('input[value="A1"],input[value="B1"]').count(),0);
        assert.match(await page.locator('.craft-candidates').nth(1).locator('legend').textContent(),/可选 1 件/u);
        await page.locator('input[value="A2"]').check();await page.locator('input[value="B2"]').check();
        control.library.details[item.key]={...fresh,updatedAt:3};control.library.revision=3;state.library.revision=3;control.emit('change',state);
        await page.waitForTimeout(100);
        assert.equal(await page.locator('input[value="A2"]').isChecked(),true);assert.equal(await page.locator('input[value="B2"]').isChecked(),true);
      }
      assert.equal(await page.getByRole('button',{name:'核对本批',exact:true}).isEnabled(),true);
      assert.match(await page.locator('#crafting-form .craft-result').innerText(),/已自动刷新行囊和本配方的可选材料/u);
      assert.equal(calls.filter(c=>c.kind==='craft-execute').length,1);
      assert.equal(calls.filter(c=>c.kind==='library'&&c.payload.key===item.key).length,1);
      assert.deepEqual(errors,[]);
    }finally{await page.close();await server.close();}
  }
});

test('history dialog hides finished logs, deletes one record, retains filters and protects pending work',async()=>{
  const control=new EventEmitter(),calls=[],selection={name:'苏灵木',quantity:8,instances:[]};
  const operations=Array.from({length:6},(_,i)=>({id:`00000000-0000-0000-0000-00000000000${i}`,selection,stage:i?'completed':'cancelled',issuedAt:i?1:undefined,updatedAt:Date.now(),localSaved:Boolean(i),error:i?'':'条件已变化'}));
  const active={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',selection:{...selection,name:'苏灵淬液'},stage:'awaiting-review',issuedAt:1,updatedAt:Date.now(),localSaved:false,error:'等待核对结果'};
  const snapshot={settings:{target:{regionName:'北境',stageName:'阶'},healingTarget:null,consumables:{enabled:false,itemNames:[]}},catalog:{regions:[],nodes:[],items:[]},consumables:{},library:{revision:1,sync:{intervalMs:60000}},phase:'stopped',desired:'stopped',revision:1,logs:[],crafting:{previews:[],operations:[active,...operations],activeId:active.id,historyCount:7}};
  control.library={revision:1,views:{inventory:{items:[],updatedAt:Date.now()},crafting:{items:[],updatedAt:Date.now()}},details:{}};
  control.snapshot=()=>snapshot;control.crafting={snapshot:()=>snapshot.crafting};let fail=true;
  control.command=(kind,payload)=>{const id=calls.length+1;calls.push({kind,payload});if(kind==='craft-delete')setTimeout(()=>{
    if(!fail){snapshot.crafting.operations=snapshot.crafting.operations.filter(op=>op.id!==payload.operationId);snapshot.crafting.historyCount--;}
    snapshot.lastCommand={id,kind,ok:!fail,error:fail?'记录写入失败，请重试':undefined};control.emit('change',snapshot);
  },50);return {id,kind};};
  const server=await startControlServer(control,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.getByRole('tab',{name:/炼制/u}).click();await page.locator('#library-search').fill('苏灵');
    assert.equal(await page.locator('#crafting-history').isVisible(),false);assert.equal(await page.locator('#crafting-status .craft-record').count(),1);
    assert.match(await page.locator('#crafting-history-open').innerText(),/7/u);await page.locator('#crafting-history-open').click();
    assert.equal(await page.locator('#crafting-history-list .craft-record').count(),7);assert.equal(await page.locator('#crafting-history-list .craft-delete').count(),6);
    assert.equal(await page.locator(`#crafting-history-list [data-operation-id="${active.id}"] .craft-delete`).count(),0);
    await page.locator('#crafting-history-list details summary').click();
    const first=`#crafting-history-list [data-operation-id="${operations[1].id}"]`;
    await page.locator(first+' .craft-delete').click();await page.waitForFunction(()=>document.getElementById('crafting-history-message').textContent.includes('写入失败'));
    assert.equal(await page.locator(first).count(),1);fail=false;
    await page.locator(first+' .craft-delete').click();await page.waitForFunction(()=>document.getElementById('crafting-history-message').textContent.includes('已删除'));
    assert.equal(await page.locator(first).count(),0);assert.equal(calls.at(-1).kind,'craft-delete');assert.equal(calls.at(-1).payload.operationId,operations[1].id);
    assert.equal(await page.locator('#crafting-history-list details').getAttribute('open'),'');
    assert.equal(await page.locator('#library-search').inputValue(),'苏灵');assert.equal(await page.locator('#tab-crafting').getAttribute('aria-selected'),'true');
    await mkdir(screenshotDirectory,{recursive:true});await page.screenshot({path:path.join(screenshotDirectory,'crafting-history-desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(screenshotDirectory,'crafting-history-mobile.png')});
    assert.equal(await page.locator('#crafting-history').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#crafting-history').isVisible(),false);
    assert.equal(await page.locator('#crafting-history-open').evaluate(e=>document.activeElement===e),true);
    snapshot.crafting.operations=[];snapshot.crafting.activeId=null;snapshot.crafting.historyCount=0;control.emit('change',snapshot);
    await page.waitForFunction(()=>document.getElementById('crafting-status').hidden);await page.locator('#crafting-history-open').click();
    assert.match(await page.locator('#crafting-history-list').innerText(),/暂无炼制历史/u);await page.locator('#crafting-history-close').click();
    assert.deepEqual(errors,[]);
  }finally{await page.close();await server.close();}
});

test('equipment material radios show green, preserve both groups and scroll, and stay selectable during reads',async()=>{
  for(const type of ['兵刃合炼','防具升炼']){
    const control=new EventEmitter(),calls=[],item={key:'b'.repeat(64),name:type==='兵刃合炼'?'苏灵鸣金重剑':'测试护甲',recipeType:type,category:'器物'};
    const candidates=Array.from({length:6},(_,i)=>({id:'B'+(i+1),name:'苏灵淬液',quality:120-i}));
    const detail={key:item.key,name:item.name,materials:[],facts:[],ingredients:[{label:'精炼主材',candidates:[{id:'A',name:'鸣金重料',quality:112}]},{label:'淬炼辅料',candidates}],updatedAt:Date.now()};
    control.library={revision:1,views:{crafting:{items:[item],updatedAt:Date.now()},inventory:{items:[]}},details:{[item.key]:detail}};
    const state={settings:{target:{regionName:'北境',stageName:'阶'},healingTarget:null,consumables:{enabled:false,itemNames:[]}},catalog:{regions:[],nodes:[],items:[]},consumables:{},library:{revision:1},phase:'stopped',desired:'stopped',revision:1,logs:[],busy:'library',crafting:{previews:[],operations:[],activeId:null}};
    control.snapshot=()=>state;control.command=(kind,payload)=>{calls.push({kind,payload});return {id:calls.length,kind};};
    const server=await startControlServer(control,{port:0}),page=await browser.newPage({viewport:{width:1200,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.getByRole('tab',{name:/炼制/u}).click();await page.getByRole('button',{name:'查看'+item.name+'详情'}).click();
      const radio=id=>page.locator('#crafting-form input[value="'+id+'"]'),row=id=>page.locator('.craft-candidate').filter({has:page.locator('input[value="'+id+'"]')});
      await radio('A').waitFor();assert.equal(await radio('A').isEnabled(),true);assert.equal(await page.getByRole('button',{name:'核对本批',exact:true}).isEnabled(),false);
      await radio('A').click();assert.equal(await radio('A').isChecked(),true);assert.equal(await row('A').locator('.craft-selected').isVisible(),true);
      assert.match(await radio('A').evaluate(e=>getComputedStyle(e).backgroundImage),/168, 217, 189/u);
      await row('B6').click();assert.equal(await radio('B6').isChecked(),true);assert.equal(await radio('A').isChecked(),true);
      assert.ok(await page.locator('.craft-candidates').nth(1).evaluate(e=>e.scrollTop)>0);
      await radio('B6').focus();await page.keyboard.press('ArrowUp');assert.equal(await radio('B5').isChecked(),true);assert.equal(await radio('B6').isChecked(),false);
      assert.equal(await radio('B5').evaluate(e=>document.activeElement===e),true);
      const scroll=await page.locator('.craft-candidates').nth(1).evaluate(e=>e.scrollTop);
      state.busy='refresh';control.emit('change',state);await page.waitForTimeout(80);
      assert.equal(await radio('A').isChecked(),true);assert.equal(await radio('B5').isChecked(),true);assert.equal(await page.locator('.craft-candidates').nth(1).evaluate(e=>e.scrollTop),scroll);
      state.busy=null;control.emit('change',state);await page.waitForFunction(()=>!document.querySelector('#crafting-form button').disabled);
      await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#library-detail').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
      await page.getByRole('button',{name:'核对本批',exact:true}).click();await page.waitForTimeout(80);
      assert.deepEqual(calls.at(-1),{kind:'craft-preview',payload:{key:item.key,quantity:1,instanceIds:['A','B5']}});
      assert.equal(await radio('A').isEnabled(),false);assert.equal(calls.some(c=>c.kind==='craft-execute'),false);assert.deepEqual(errors,[]);
    }finally{await page.close();await server.close();}
  }
});
