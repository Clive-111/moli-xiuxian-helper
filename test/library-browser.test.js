import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {EventEmitter} from 'node:events';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {BattleUI} from '../src/battle-ui.js';
import {LibraryUI,libraryKey} from '../src/library-ui.js';
import {startControlServer} from '../src/control-server.js';
import {ControlInterrupted} from '../src/control-errors.js';

let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});
const fixture=`<!doctype html><meta charset="utf-8"><aside class="character-panel"><div class="discord-profile"><h3>测试修士</h3></div><div><span>气血</span><span>80 / 100</span></div></aside><nav class="central-nav"><button class="selected">游历</button><button>行囊</button><button>炉鼎</button></nav><main data-region="北境" data-location="银阶"></main><script>
window.actions=[];window.ticks=0;setInterval(()=>ticks++,10);let main=document.querySelector('main');
function danger(){actions.push('FORBIDDEN')}
function detail(name,craft=false){actions.push('detail:'+name);const d=document.createElement('dialog');d.innerHTML='<header><h2>'+ (craft?'普通炼制':'物品详情')+'</h2><button aria-label="关闭窗口">X</button></header><div class="dialog-body"><div class="item-detail-title"><h2>'+name+'</h2></div><p class="flavor">修行所用的物品</p><div class="bonus-lines">气血 +100</div>'+(craft?'<dl class="craft-facts"><div><dt>成功率</dt><dd>90%</dd></div></dl><table class="craft-materials"><tbody><tr><th>药草</th><td>4</td><td class="negative">5</td></tr></tbody></table>':'')+'</div><footer><button>'+ (craft?'开炉炼制':'全部使用')+'</button><button>回收</button></footer>';d.querySelector('header button').onclick=()=>{actions.push('close');d.remove()};d.querySelectorAll('footer button').forEach(b=>b.onclick=danger);document.body.append(d);d.showModal()}
function show(tab='游历'){document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.textContent===tab));
 if(tab==='游历'){main.innerHTML='<h1>银阶</h1><p>正在探索</p><button>撤退</button>';main.querySelector('button').onclick=danger;return;}
 if(tab==='行囊'){main.innerHTML='<div class="inventory-view"><div class="page-heading"><h1>行囊</h1><span class="muted">袋内 3 项</span></div><div class="bag-equipment"><button aria-label="展开配装">展开</button><div hidden id="gear"><button class="bag-equipment-slot filled"><span class="bag-slot-label">兵刃</span><strong>铁剑</strong></button></div></div><button aria-label="清除物品筛选">清除</button><div class="bag-grid"></div></div>';main.querySelector('[aria-label="展开配装"]').onclick=e=>{document.querySelector('#gear').hidden=false;e.currentTarget.remove();actions.push('gear')};main.querySelector('#gear button').onclick=danger;main.querySelector('[aria-label="清除物品筛选"]').onclick=e=>{e.currentTarget.disabled=true;actions.push('clear')};
 for(const [name,id,q] of [['铁剑','one','品质100，编号one'],['铁剑','two','品质90，编号two'],['碧灵髓','','持有12345份']]){const b=document.createElement('button');b.className='bag-item';b.setAttribute('aria-label','查看'+name+'，'+q+'，回收单价20灵石');b.innerHTML='<span class="item-glyph '+(id?'equipment':'marrow')+'"></span><span class="bag-item-amount">'+(id?'品'+(id==='one'?100:90):'×1.23万')+'</span><strong>'+name+'</strong><span class="bag-item-price" title="回收单价 20 灵石">20</span>';b.onclick=()=>detail(name);main.querySelector('.bag-grid').append(b);}}
 else {main.innerHTML='<div class="craft-view"><div class="page-heading"><h1>炉鼎</h1><span class="muted">炼制 4 级 · 2 式</span></div><div class="furnace-strip">青铜炉 <button>养鼎</button></div><button aria-label="清除配方筛选" disabled>清除</button><label><input type="checkbox">显示全部</label><div class="craft-grid"></div></div>';main.querySelector('.furnace-strip button').onclick=danger;main.querySelector('input').onchange=()=>{actions.push('all-recipes');recipes()};recipes();}
}
function recipes(){const grid=main.querySelector('.craft-grid');grid.innerHTML='';for(const [name,ready] of [['碧灵髓',true],['赤灵髓',false]]){if(!ready&&!main.querySelector('input').checked)continue;const article=document.createElement('article');article.className='craft-tile-wrap';article.innerHTML='<button class="craft-tile '+(ready?'ready':'')+'" aria-label="查看'+name+'，普通炼制，成功产出1份，材料可供 '+(ready?3:0)+' 炉"><span class="craft-tile-top"><span class="item-glyph marrow"></span><span>难度 2</span></span><strong>'+name+'</strong><span class="craft-tile-facts"><span title="当前成功率">90%</span><small>每炉 1 份</small></span><span class="craft-tile-stock">'+(ready?'可供 3 炉':'缺少材料')+'</span></button><div class="craft-quick-actions"><button>1</button><button>10</button><button>全部</button></div>';article.querySelector('.craft-tile').onclick=()=>detail(name,true);article.querySelectorAll('.craft-quick-actions button').forEach(b=>b.onclick=danger);grid.append(article)}}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{actions.push('tab:'+b.textContent);show(b.textContent)});show();</script>`;
async function setup(){
 const page=await browser.newPage();await page.setContent(fixture);
 const ui=new BattleUI(page,{characterName:'测试修士',target:{regionName:'北境',stageName:'银阶'}},{actionDelaySeconds:2,responseTimeoutSeconds:1},()=>{},new AbortController().signal);
 ui.ensureApp=async()=>page.mainFrame();const waits=[];
 return {page,ui,reader:new LibraryUI(ui,{wait:async ms=>waits.push(ms)}),waits};
}
test('inventory exact quantities, distinct same-name equipment and rack; viewer never uses items or retreats',async()=>{
 const h=await setup();try{const r=await h.reader.read('inventory');assert.equal(r.items.length,3);assert.equal(r.items[2].quantity,'12345');assert.notEqual(r.items[0].key,r.items[1].key);assert.equal(r.equipment[0].name,'铁剑');
 const detail=await h.reader.read('inventory',r.items[1]);assert.equal(detail.detail.name,'铁剑');assert.match(detail.detail.description,/气血/u);assert.equal((await h.ui.observe()).mode,'combat');assert.ok(h.waits.every(ms=>ms>=2000));assert.equal((await h.page.evaluate(()=>actions)).includes('FORBIDDEN'),false);
 }finally{await h.page.close();}
});
test('crafting includes recipes lacking materials; scoped detail reads demand, never quick-crafts or upgrades',async()=>{
 const h=await setup();try{const r=await h.reader.read('crafting');assert.equal(r.items.length,2);assert.equal(r.items[1].ready,false);assert.equal(r.items[0].chance,'90%');
 const detail=await h.reader.read('crafting',r.items[1]);assert.deepEqual(detail.detail.materials,[{name:'药草',owned:'4',required:'5',missing:true}]);assert.equal((await h.ui.observe()).mode,'combat');assert.equal((await h.page.evaluate(()=>actions)).includes('FORBIDDEN'),false);
 }finally{await h.page.close();}
});

test('equipment expands during the click delay: read the rack without toggling it again',async()=>{
 const h=await setup();try{
  const click=h.reader.click.bind(h.reader);let expanding=false;
  h.reader.click=async(locator,label,options)=>{expanding=label==='展开当前配装';try{return await click(locator,label,options);}finally{expanding=false;}};
  h.reader.wait=async()=>{if(expanding)await h.page.getByRole('button',{name:'展开配装',exact:true}).click();};
  const value=await h.reader.read('inventory');assert.equal(value.equipment[0].name,'铁剑');
  assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x==='gear').length,1);
  assert.equal((await h.ui.observe()).mode,'combat');
 }finally{await h.page.close();}
});

test('equipment click succeeds but times out: verify the visible rack without another click',async()=>{
 const h=await setup();try{
  const unique=h.ui.unique.bind(h.ui);
  h.ui.unique=async(locator,label)=>{const item=await unique(locator,label);if(label==='展开当前配装'){const click=item.click.bind(item);item.click=async options=>{await click(options);throw new Error('response timeout');};}return item;};
  const value=await h.reader.read('inventory');assert.equal(value.equipment[0].name,'铁剑');
  assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x==='gear').length,1);
 }finally{await h.page.close();}
});

test('an already open rack needs no toggle; duplicate or missing controls do not yield a false complete snapshot',async()=>{
 for(const mode of ['open','duplicate','missing']){
  const h=await setup();try{
   await h.page.evaluate(mode=>{const original=show;show=tab=>{original(tab);if(tab!=='行囊')return;const button=document.querySelector('[aria-label="展开配装"]');if(mode==='open')button.click();else if(mode==='duplicate')button.after(button.cloneNode(true));else button.remove();};},mode);
   if(mode==='open')assert.equal((await h.reader.read('inventory')).equipment[0].name,'铁剑');
   else await assert.rejects(h.reader.read('inventory'),/不唯一|无法唯一定位|不可见/u);
   assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x==='gear').length,mode==='open'?1:0);
   assert.equal((await h.ui.observe()).mode,'combat');
  }finally{await h.page.close();}
 }
});

test('a rack without a confirmed expanded result cannot silently return hidden equipment',async()=>{
 const h=await setup();try{
  await h.page.evaluate(()=>{const original=show;show=tab=>{original(tab);if(tab==='行囊')document.querySelector('[aria-label="展开配装"]').onclick=()=>actions.push('unconfirmed-expand');};});
  await assert.rejects(h.reader.read('inventory'),/当前配装展开超时/u);
  assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x==='unconfirmed-expand').length,1);
  assert.equal((await h.page.evaluate(()=>actions)).includes('FORBIDDEN'),false);
 }finally{await h.page.close();}
});

test('list navigation uses battle speed while crafting and uploads retain their separate delay',async()=>{
 const h=await setup();try{
  h.ui.config={...h.ui.config,actionDelaySeconds:.3};
  await h.reader.read('crafting');assert.ok(h.waits.length>=3);assert.ok(h.waits.every(ms=>ms===300));
  h.waits.length=0;
  await h.reader.click(h.ui.frame.locator('nav').getByRole('button',{name:'游历',exact:true}),'legacy action');
  assert.deepEqual(h.waits,[2000]);
 }finally{await h.page.close();}
});
test('detail click succeeded with timeout is read once and closed; stop during reading only permits cleanup',async()=>{
 const h=await setup();try{
  const r=await h.reader.read('inventory');const click=h.reader.click.bind(h.reader);
  h.reader.click=async(locator,label,options)=>{await click(locator,label,options);if(label.includes('」详情'))throw new Error('click response timeout');};
  const result=await h.reader.read('inventory',r.items[0]);assert.equal(result.detail.name,'铁剑');assert.equal((await h.page.evaluate(()=>actions)).filter(x=>x==='detail:铁剑').length,1);
  h.reader.click=click;h.ui.beforeAction=(label,{cleanup}={})=>{if(label==='展开当前配装'&&!cleanup)throw new ControlInterrupted('stop');};
  await assert.rejects(h.reader.read('inventory'),/stop/u);assert.equal((await h.ui.observe()).mode,'combat');
 }finally{await h.page.close();}
});
test('unknown dialog, changed character and ambiguous entries cannot trigger item operations',async()=>{
 const h=await setup();try{
  await h.page.evaluate(()=>{const d=document.createElement('dialog');d.innerHTML='<h2>选择存档</h2><button>覆盖</button>';d.querySelector('button').onclick=()=>actions.push('FORBIDDEN');document.body.append(d);d.showModal();});
  await assert.rejects(h.reader.read('inventory'),/人工处理|恢复/u);assert.deepEqual(await h.page.evaluate(()=>actions),[]);
  await h.page.locator('dialog').evaluate(d=>d.remove());await h.page.locator('.discord-profile h3').evaluate(el=>el.textContent='别人');
  await assert.rejects(h.reader.read('crafting'),/角色/u);assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}
});
test('panel displays image cards, search, categories and recipe detail on desktop and mobile without crafting controls',async()=>{
 const c=new EventEmitter(),commands=[];let id=0;
 const image='/api/library/images/'+'a'.repeat(64),at=Date.now();
 const names=['赤灵髓','碧灵髓','铁剑','精肉脯','凝灵髓','药草'];
 const inventory={updatedAt:at,summary:'袋内 6 项',equipment:[{name:'铁剑',slot:'兵刃',equipped:true,image}],items:names.map((name,i)=>({name,key:String(i+1).repeat(64),category:i<2?'灵髓':i===2?'器物':'材料',quantity:'18',quality:i===2?'100':null,image,price:'回收单价 50 灵石'}))};
 const recipe={...inventory.items[0],key:'b'.repeat(64),recipeType:'普通炼制',summary:'难度 4',chance:'98%',output:'每炉 1 份',stock:'可供 8 炉',ready:true};
 c.library={revision:1,views:{inventory,crafting:{updatedAt:at,summary:'炼制 4 级 · 1 式',items:[recipe],equipment:[],workshop:'青铜炉 · 可开炉'}},details:{[recipe.key]:{key:recipe.key,name:recipe.name,updatedAt:at,description:'蕴含灵力的红色灵髓。',facts:[{label:'成功率',value:'98%'}],materials:[{name:'药草',owned:'4',required:'5',missing:true}]}}};
 const state={phase:'running',desired:'running',revision:1,settings:{target:{regionName:'北境',stageName:'银阶'},healingTarget:null,consumables:{enabled:false,itemNames:['赤灵髓']}},catalog:{regions:[],nodes:[],items:[]},state:{character:'测试修士',region:'北境',location:'银阶'},logs:[],consumables:{},library:{revision:1}};
 c.snapshot=()=>state;c.command=(kind,payload)=>{commands.push({kind,payload});return {id:++id,kind};};
 c.images={close:async()=>{},get:async()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvS8AAAAASUVORK5CYII=','base64')};
 const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1440,height:1150}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.goto(`http://127.0.0.1:${server.server.address().port}/#library`);await page.locator('#library-grid button').first().waitFor();assert.equal(await page.locator('#library-grid button').count(),6);
  await page.locator('#library-search').fill('铁剑');assert.equal(await page.locator('#library-grid button').count(),1);await page.locator('#library-search').fill('');
  await page.locator('#library-category').selectOption('灵髓');assert.equal(await page.locator('#library-grid button').count(),2);
  await page.getByRole('tab',{name:/炼制/u}).click();await page.locator('#library-grid button').click();assert.equal(await page.locator('#library-detail').isVisible(),true);assert.equal(await page.locator('.materials-table .material-short').count(),1);
  await page.waitForTimeout(100);assert.equal(commands[0].kind,'library');assert.equal(commands[0].payload.key,recipe.key);assert.equal(await page.getByRole('button',{name:'开炉炼制',exact:true}).count(),0);
  await page.getByRole('button',{name:'关闭物品详情'}).click();await page.getByRole('tab',{name:/行囊/u}).click();await page.locator('#library').scrollIntoViewIfNeeded();
  const artifacts=process.env.CONTAINER_PROFILE_PATH?path.join(os.tmpdir(),'library-test'):'work';
  await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'library-panel-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('#library').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'library-panel-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{await page.close();await server.close();}
});
