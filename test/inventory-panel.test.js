import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';import {startControlServer} from '../src/control-server.js';
let browser;before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});after(async()=>browser?.close());
async function setup(){
 const c=new EventEmitter(),calls=[],errors=[];
 const items=[{name:'护衣',identity:'item-1',slot:'body',quality:'100',quantity:'1',key:'a'.repeat(64),gameItemId:'armor',unitPrice:'100',equipped:false,category:'器物'},{name:'护衣',identity:'item-2',slot:'body',quality:'100',quantity:'1',key:'b'.repeat(64),gameItemId:'armor',unitPrice:'100',equipped:false,category:'器物'},{name:'矿石',identity:'',slot:null,quality:null,quantity:'20',key:'c'.repeat(64),gameItemId:'ore',unitPrice:'10',equipped:false,category:'材料'}];
 c.library={revision:1,views:{inventory:{items,equipment:[{slot:'上身',name:'旧护衣',equipped:true}],updatedAt:Date.now()},crafting:{items:[],updatedAt:Date.now()}},details:{}};
 const state={settings:{target:{regionName:'北',stageName:'山'},healingTarget:null,consumables:{enabled:false,itemNames:[]}},catalog:{regions:[],nodes:[],items:[],shops:[{id:'shop',name:'商店',regionName:'北',locationName:'镇'}]},consumables:{},library:{revision:1},phase:'stopped',desired:'stopped',revision:1,logs:[],crafting:{previews:[],operations:[]},inventoryActions:{activeId:null,previews:[],operations:[],saleTarget:{regionName:'北',locationName:'镇',shopName:'商店'}}};
 c.snapshot=()=>state;c.inventoryActions={snapshot:()=>state.inventoryActions};c.command=(kind,payload)=>{calls.push({kind,payload});return {id:calls.length,kind};};
 const server=await startControlServer(c,{port:0}),url=`http://127.0.0.1:${server.server.address().port}`,page=await browser.newPage({viewport:{width:1360,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url+'/#library');await page.locator('#library-grid .collection-item').first().waitFor();
 return {c,state,calls,items,page,url,errors,publish(){state.library.revision=c.library.revision;c.emit('change',state);},async close(){await page.close();await server.close();}};
}
test('selection keeps exact IDs through filters and SSE; keyboard and narrow screen checkboxes',async()=>{
 const h=await setup();try{const p=h.page;await p.getByRole('button',{name:'批量选择',exact:true}).click();await p.locator('#library-search').fill('护衣');await p.getByRole('button',{name:'全选当前筛选',exact:true}).click();assert.equal(await p.locator('.inventory-checkbox input:checked').count(),2);
  await p.locator('#library-search').fill('矿石');assert.match(await p.locator('.inventory-selection').innerText(),/已选 2 项/u);await p.locator('.inventory-checkbox input').focus();await p.keyboard.press('Space');assert.match(await p.locator('.inventory-selection').innerText(),/已选 3 项/u);
  h.c.library.views.inventory.items[2].quantity='25';h.c.library.revision++;h.publish();await p.waitForFunction(()=>document.querySelector('.item-amount').textContent==='× 25');assert.equal(await p.locator('.inventory-checkbox input').isChecked(),true);
  await p.locator('#library-search').fill('');assert.equal(await p.locator('.inventory-checkbox input:checked').count(),3);await p.setViewportSize({width:390,height:844});await p.screenshot({path:'work/inventory-panel-mobile.png',fullPage:true});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(const checkbox of await p.locator('.inventory-checkbox').all()){assert.ok(await checkbox.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.parentElement.getBoundingClientRect();return a.right<=b.right&&a.bottom<=b.bottom&&a.left>=b.left;}));}
  await p.getByRole('button',{name:'卖出已选',exact:true}).click();await p.waitForTimeout(80);assert.deepEqual(h.calls.at(-1).payload.ids,['instance:item-1','instance:item-2','stack:ore']);assert.equal(h.calls.some(c=>c.kind==='inventory-execute'),false);assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});
test('sale preview shows frozen counts and keeps quantity edits through SSE; execute needs explicit confirmation',async()=>{
 const h=await setup();try{const p=h.page;await p.getByRole('button',{name:'查看矿石详情',exact:true}).click();await p.getByRole('button',{name:'卖出',exact:true}).click();await p.waitForTimeout(80);
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';h.state.inventoryActions.previews=[{id,kind:'sell',lines:[{...h.items[2],id:'stack:ore',quantity:20}],shop:h.state.catalog.shops[0]}];h.state.lastCommand={id:h.calls.length,kind:'inventory-preview',ok:true,previewId:id};h.publish();
  const quantity=p.locator('#inventory-action-dialog input[type=number]');await quantity.waitFor();assert.equal(await quantity.inputValue(),'20');await quantity.fill('7');h.state.busy='library';h.publish();await p.waitForTimeout(80);assert.equal(await quantity.inputValue(),'7');h.state.busy=null;h.publish();await p.waitForTimeout(80);assert.equal(await quantity.inputValue(),'7');
  await p.screenshot({path:'work/inventory-sale-confirm.png'});await p.getByRole('button',{name:'确认卖出本批',exact:true}).click();await p.waitForTimeout(80);assert.equal(h.calls.at(-1).kind,'inventory-execute');assert.deepEqual(h.calls.at(-1).payload.quantities,{'stack:ore':7});assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});
test('rack selection submits replacement directly once, preserves ID across SSE and shows the result',async()=>{
 const h=await setup();try{const p=h.page;await p.getByRole('button',{name:'更换上身装备',exact:true}).click();assert.equal(await p.locator('.inventory-candidates input').count(),2);assert.equal(await p.locator('.inventory-candidates').getByText('矿石').count(),0);
  const replace=p.getByRole('button',{name:'替换装备',exact:true});assert.equal(await replace.isDisabled(),true);
  const radio=p.locator('.inventory-candidates input[value="instance:item-2"]');await radio.check();assert.equal(h.calls.length,0);
  h.state.busy='library';h.publish();await p.waitForTimeout(80);assert.equal(await radio.isChecked(),true);assert.equal(await replace.isDisabled(),true);
  h.state.busy=null;h.publish();await p.waitForTimeout(80);await replace.evaluate(el=>{el.click();el.click();});await p.waitForTimeout(80);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].kind,'inventory-equip');assert.equal(h.calls[0].payload.id,'instance:item-2');assert.equal(h.calls[0].payload.slot,'body');
  const requestId=h.calls[0].payload.requestId;assert.match(requestId,/^[a-f0-9-]{36}$/u);assert.equal(await p.getByRole('button',{name:'核对装备与属性对比'}).count(),0);
  h.state.inventoryActions.activeId=requestId;h.state.inventoryActions.operations=[{id:requestId,kind:'equip',stage:'issued',lines:[{...h.items[1],id:'instance:item-2',completed:0}],pending:{lineId:'instance:item-2',quantity:1},updatedAt:1}];
  h.state.lastCommand={id:999,kind:'library',ok:true};h.publish();await p.locator('#inventory-action-dialog').getByText(/已提交，核对结果/u).waitFor();
  const op=h.state.inventoryActions.operations[0];op.stage='completed';op.pending=null;op.lines[0].completed=1;h.state.inventoryActions.activeId=null;h.publish();
  await p.locator('#inventory-action-dialog').getByText('装备已替换，本地保存已确认。',{exact:true}).waitFor();assert.equal(h.calls.length,1);assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});
test('inventory API enforces session, CSRF, origin and command paths',async()=>{
 const h=await setup();try{assert.equal((await fetch(h.url+'/api/inventory-actions')).status,401);const session=await fetch(h.url+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();
  assert.equal((await fetch(h.url+'/api/inventory-actions',{headers:{cookie}})).status,200);const body=JSON.stringify({operationId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});
  const post=(origin,csrf)=>fetch(h.url+'/api/inventory-actions/review',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':csrf},body});
  assert.equal((await post('http://evil.invalid',token)).status,403);assert.equal((await post(h.url,'0'.repeat(64))).status,403);assert.equal((await post(h.url,token)).status,202);assert.equal(h.calls.at(-1).kind,'inventory-review');
  const equip=(origin,csrf)=>fetch(h.url+'/api/inventory-actions/equip',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({id:'instance:item-2',slot:'body',requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})});
  assert.equal((await equip('http://evil.invalid',token)).status,403);assert.equal((await equip(h.url,'0'.repeat(64))).status,403);assert.equal((await equip(h.url,token)).status,202);assert.equal(h.calls.at(-1).kind,'inventory-equip');
 }finally{await h.close();}
});

test('bulk card clicks select without detail requests, double-click edits quantity and preview keeps it',async()=>{
 const h=await setup();try{const p=h.page;await p.getByRole('button',{name:'批量选择',exact:true}).click();const card=p.locator('.inventory-card').last().locator('.collection-item');
  await card.click();assert.equal(await p.locator('.inventory-card').last().locator('input').isChecked(),true);assert.equal(await p.locator('#library-detail').isVisible(),false);assert.equal(h.calls.length,0);
  await card.dblclick();await p.getByRole('spinbutton',{name:'选中数量',exact:true}).fill('7');h.state.busy='library';h.publish();await p.waitForTimeout(60);assert.equal(await p.getByRole('spinbutton',{name:'选中数量',exact:true}).inputValue(),'7');
  await p.getByRole('button',{name:'保存数量',exact:true}).click();assert.equal(await p.locator('.inventory-card').last().locator('input').isChecked(),true);assert.match(await p.locator('.inventory-card').last().innerText(),/× 7/u);assert.equal(h.calls.length,0);
  h.state.busy=null;h.publish();await p.getByRole('button',{name:'卖出已选',exact:true}).click();await p.waitForTimeout(60);const id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  h.state.inventoryActions.previews=[{id,kind:'sell',lines:[{...h.items[2],id:'stack:ore',quantity:25}],shop:h.state.catalog.shops[0]}];h.state.lastCommand={id:h.calls.length,ok:true,kind:'inventory-preview',previewId:id};h.publish();
  const quantity=p.locator('#inventory-action-dialog [data-line-id]');await quantity.waitFor();assert.equal(await quantity.inputValue(),'7');await p.getByRole('button',{name:'确认卖出本批',exact:true}).click();await p.waitForTimeout(60);assert.deepEqual(h.calls.at(-1).payload.quantities,{'stack:ore':7});assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});

test('mouse hold-drag paints once per ID, can deselect, stops on release, and never opens detail',async()=>{
 const h=await setup();try{const p=h.page;await p.getByRole('button',{name:'批量选择',exact:true}).click();await p.locator('#library-grid').scrollIntoViewIfNeeded();
  const cards=p.locator('.inventory-card'),points=[];for(const card of await cards.all()){const b=await card.boundingBox();points.push({x:b.x+b.width/2,y:b.y+b.height/2});}
  const move=q=>p.mouse.move(q.x,q.y,{steps:12});await move(points[0]);await p.mouse.down();await move(points[2]);await move(points[0]);await p.mouse.up();assert.equal(await p.locator('.inventory-checkbox input:checked').count(),3);assert.equal(await p.locator('#library-detail').isVisible(),false);assert.equal(h.calls.length,0);
  await move(points[0]);await p.mouse.down();await move(points[1]);await p.mouse.up();assert.equal(await p.locator('.inventory-checkbox input:checked').count(),1);await move(points[2]);assert.equal(await cards.last().locator('input').isChecked(),true);
  await cards.first().locator('.collection-item').focus();await p.keyboard.press('Space');assert.equal(await cards.first().locator('input').isChecked(),true);
  await p.getByRole('button',{name:'退出选择',exact:true}).click();await cards.first().locator('.collection-item').click();assert.equal(await p.locator('#library-detail').isVisible(),true);assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});

test('touch long hold paints selection and equipment quantity stays one; wide selection bar fits mobile',async()=>{
 const h=await setup();try{const p=h.page;await p.setViewportSize({width:390,height:844});await p.getByRole('button',{name:'批量选择',exact:true}).click();await p.locator('#library-grid').scrollIntoViewIfNeeded();
  const first=p.locator('.inventory-card').first(),second=p.locator('.inventory-card').nth(1),a=await first.boundingBox(),b=await second.boundingBox();
  const event={pointerId:91,pointerType:'touch',isPrimary:true,button:0,buttons:1,clientX:a.x+a.width/2,clientY:a.y+a.height/2};
  await first.dispatchEvent('pointerdown',event);await p.waitForTimeout(400);assert.equal(await first.locator('input').isChecked(),true);
  await second.dispatchEvent('pointermove',{...event,clientX:b.x+b.width/2,clientY:b.y+b.height/2});await second.dispatchEvent('pointerup',{...event,buttons:0});assert.equal(await p.locator('.inventory-checkbox input:checked').count(),2);
  await p.waitForTimeout(350);await first.locator('.collection-item').dblclick();const quantity=p.getByRole('spinbutton',{name:'选中数量',exact:true});assert.equal(await quantity.inputValue(),'1');assert.equal(await quantity.isDisabled(),true);await p.getByRole('button',{name:'保存数量',exact:true}).click();
  assert.ok(await first.locator('.inventory-checkbox').evaluate(el=>el.clientWidth>el.parentElement.clientWidth*.7));assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await p.locator('#library-grid').screenshot({path:'work/inventory-drag-selection-mobile.png'});assert.equal(h.calls.length,0);assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});

test('all map shops are selectable during paused sale; save only default, explicit continue carries chosen shop',async()=>{
 const h=await setup();try{const p=h.page,id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  h.state.catalog.shops=Array.from({length:6},(_,i)=>({id:i?'shop-'+i:'shop',name:i===5?'村口货摊':i?'商会'+i:'商店',regionName:i?'南'+i:'北',locationName:i?'港'+i:'镇'}));
  h.state.inventoryActions.activeId=id;h.state.inventoryActions.operations=[{id,kind:'sell',stage:'awaiting-continue',shop:h.state.catalog.shops[0],lines:[{...h.items[0],id:'instance:item-1',completed:0,quantity:1}],pending:null}];h.state.catalog.updatedAt=2;h.publish();
  await p.waitForFunction(()=>document.querySelectorAll('[aria-label="卖出商店"] option').length===7);
  await p.getByRole('combobox',{name:'卖出商店',exact:true}).selectOption('shop-4');
  await p.getByRole('button',{name:'保存卖出地点',exact:true}).click();await p.waitForTimeout(80);
  assert.equal(h.calls.at(-1).kind,'settings');assert.deepEqual(h.calls.at(-1).payload,{revision:1,saleTarget:{regionName:'南4',locationName:'港4',shopName:'商会4'}});
  assert.equal(h.calls.some(c=>c.kind==='inventory-continue'||c.kind==='inventory-execute'),false);
  h.publish();await p.waitForTimeout(80);assert.equal(await p.getByRole('combobox',{name:'卖出商店',exact:true}).inputValue(),'shop-4');
  assert.match(await p.locator('#inventory-status').innerText(),/本批卖出地点：北 \/ 镇 \/ 商店/u);
  await p.getByRole('button',{name:'改到所选商会并继续剩余',exact:true}).click();await p.waitForTimeout(80);
  assert.deepEqual(h.calls.at(-1).payload,{operationId:id,shopId:'shop-4'});
  await p.getByRole('button',{name:'刷新商会目录',exact:true}).click();await p.waitForTimeout(80);assert.deepEqual(h.calls.at(-1),{kind:'refresh',payload:{shopsOnly:true}});
  await p.setViewportSize({width:390,height:844});await p.screenshot({path:'work/shop-picker-mobile.png',fullPage:true});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(h.errors,[]);
 }finally{await h.close();}
});

test('paused-sale inspection button only requests inspection and never continues or executes',async()=>{
 const h=await setup();try{const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';h.state.inventoryActions.activeId=id;h.state.inventoryActions.operations=[{id,kind:'sell',shop:h.state.catalog.shops[0],stage:'awaiting-continue',lines:[{...h.items[0],id:'instance:item-1',completed:0,quantity:1}],pending:null}];h.publish();
  const button=h.page.getByRole('button',{name:'检查售出流程（不卖出）',exact:true});await button.click();await h.page.waitForTimeout(80);
  assert.deepEqual(h.calls.at(-1),{kind:'inventory-review',payload:{operationId:id,inspectSale:true}});assert.equal(h.calls.some(c=>['inventory-execute','inventory-continue'].includes(c.kind)),false);
  h.state.inventoryActions.operations[0].pending={lineId:'instance:item-1',quantity:1};h.publish();await h.page.waitForTimeout(80);assert.equal(await button.isDisabled(),true);
 }finally{await h.close();}
});
