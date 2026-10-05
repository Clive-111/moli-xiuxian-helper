import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {setup} from './helpers/inventory-game.js';
import {InventoryUI} from '../src/inventory-ui.js';
import {freezeSale} from '../src/inventory-proof.js';
let browser;before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});after(async()=>browser?.close());
const shop={regionName:'百渠泽地',locationName:'千渠埠',name:'四海商盟·千渠商会'};
async function gearBatch(h){return freezeSale(await h.adapter.inventory(undefined,false),['instance:item-1','instance:item-3','instance:item-5','instance:item-7']);}

test('four-equipment batch stays in sale page, reselects reordered same-name same-quality IDs and never opens bag/rack per item',async()=>{
 const h=await setup(browser);try{
  h.adapter.reader.expandEquipment=()=>assert.fail('sale preview must not expand rack');
  const lines=await gearBatch(h);await h.page.evaluate(()=>{visits=[];reorder=true;bag.find(i=>i.identity==='item-3').name=bag.find(i=>i.identity==='item-1').name;});lines[1].name=lines[0].name;
  const waits=[];h.adapter.reader.wait=async ms=>waits.push(ms);
  await h.adapter.beginSaleBatch(lines,shop);waits.length=0;
  for(const line of lines){let fence=0;const result=await h.adapter.sell(line,1,shop,async p=>{fence++;assert.equal(p.evidenceSource,'shop-v1');assert.equal(p.before,undefined);assert.equal(p.line.identity,line.identity);});assert.ok(result.saved);assert.equal(fence,1);}
  const visits=await h.page.evaluate(()=>window.visits);assert.equal(visits.filter(x=>x==='shop').length,1);assert.equal(visits.filter(x=>x==='行囊'||x==='equipment-detail').length,0);assert.equal(visits.filter(x=>x==='sale-detail').length,4);assert.ok(!waits.includes(2000));
  assert.deepEqual(await h.page.evaluate(()=>actions.map(a=>a[1])),lines.map(l=>l.identity));
 }finally{await h.page.close();}
});

test('entire batch is checked before first sale: equipped, missing, duplicate ID or changed quality/price',async()=>{
 for(const fault of ['equipped','missing','duplicate','quality','price']){const h=await setup(browser);try{
  const lines=await gearBatch(h);await h.page.evaluate(f=>{const i=bag.find(i=>i.identity==='item-7');if(f==='equipped')i.equipped=true;if(f==='missing')bag=bag.filter(x=>x!==i);if(f==='duplicate')bag.push({...i});if(f==='quality')i.quality='90';},fault);
  if(fault==='price')lines[3].unitPrice='99';
  await assert.rejects(h.adapter.beginSaleBatch(lines,shop));assert.deepEqual(await h.page.evaluate(()=>actions),[]);assert.equal(await h.page.locator('dialog[open]').count(),0);
 }finally{await h.page.close();}}
});

test('exact stacks split at cap, keep frozen amount despite new stock, with no inventory round trips',async()=>{
 const h=await setup(browser);try{
  const line=freezeSale(await h.adapter.inventory(undefined,false),['stack:ore'])[0];await h.page.evaluate(()=>{bag.find(i=>!i.identity).quantity=16001;visits=[];});
  await h.adapter.beginSaleBatch([line],shop);await h.adapter.sell(line,10000,shop,async()=>{});await h.adapter.sell(line,5001,shop,async()=>{});
  assert.deepEqual(await h.page.evaluate(()=>actions.map(a=>a[2])),[10000,5001]);assert.equal(await h.page.evaluate(()=>bag.find(i=>!i.identity).quantity),1000);
  const visits=await h.page.evaluate(()=>window.visits);assert.equal(visits.filter(x=>x==='行囊').length,0);assert.equal(visits.filter(x=>x==='shop').length,1);
 }finally{await h.page.close();}
});

test('abbreviated stack uses exact input max or exceptional precise bag evidence, then returns to sale page',async()=>{
 for(const quantity of [10000,7]){const h=await setup(browser);try{
  const line=freezeSale(await h.adapter.inventory(undefined,false),['stack:ore'])[0];await h.page.evaluate(()=>{rounded=true;visits=[];});
  await h.adapter.beginSaleBatch([line],shop);let pending;
  const r=await h.adapter.sell(line,quantity,shop,async p=>{pending=structuredClone(p);});assert.ok(r.saved);assert.equal(pending.beforeSale.exactFallback,true);
  // One exact baseline for >10k, plus one result fallback only when still >10k.
  const visits=await h.page.evaluate(()=>window.visits);assert.equal(visits.filter(x=>x==='行囊').length,quantity===10000?1:2);assert.equal(visits.filter(x=>x==='equipment-detail').length,0);
  assert.equal(await h.page.locator('.shop-view').count(),1);assert.equal(await h.page.locator('dialog[open]').count(),0);assert.equal((await h.page.evaluate(()=>actions)).length,1);
 }finally{await h.page.close();}}
});

test('a successful click followed by delayed save waits and confirms without reissuing',async()=>{
 const h=await setup(browser);try{
  const [line]=await gearBatch(h);await h.page.evaluate(()=>{saved=false;tradeDelay=100;afterSale=()=>setTimeout(()=>document.querySelector('footer.statusbar').textContent='本地存档已就绪',350);});
  const start=Date.now(),result=await h.adapter.sell(line,1,shop,async()=>{});assert.ok(result.saved);assert.ok(Date.now()-start>=450);assert.equal((await h.page.evaluate(()=>actions)).length,1);
 }finally{await h.page.close();}
});

test('blank/partial/filtered sale list cannot prove disappearance; review after restart never replays',async()=>{
 for(const fault of ['blank','partial','filter']){const h=await setup(browser);try{
  const [line]=await gearBatch(h);await h.page.evaluate(f=>{afterSale=()=>{const list=document.querySelector('.entry-list');if(f==='blank')list.replaceChildren();if(f==='partial')list.innerHTML='<p>暂无对应物品</p>';if(f==='filter'){document.querySelector('input[type=search]').value='找不到';renderRows();}};},fault);let pending;
  await assert.rejects(h.adapter.sell(line,1,shop,async p=>{pending=JSON.parse(JSON.stringify(p));}));assert.equal((await h.page.evaluate(()=>actions)).length,1);
  await h.page.evaluate(()=>{document.querySelector('input[type=search]').value='';renderRows();});
  const restarted=new InventoryUI(h.ui,{reader:h.adapter.reader,knowledge:h.adapter.knowledge});const result=await restarted.recover(pending);assert.ok(result.saved);assert.equal((await h.page.evaluate(()=>actions)).length,1);
  assert.equal((await h.page.evaluate(()=>visits)).filter(x=>x==='shop').length,1);
 }finally{await h.page.close();}}
});

test('unconsumed click and ambiguous stack evidence pause without retry, legacy pending still uses backpack',async()=>{
 const h=await setup(browser);try{
  const [line]=await gearBatch(h);await h.page.evaluate(()=>{noSale=true;});let pending;await assert.rejects(h.adapter.sell(line,1,shop,async p=>{pending=structuredClone(p);}));
  await assert.rejects(h.adapter.recover(pending));assert.equal((await h.page.evaluate(()=>actions)).length,1);
  await h.adapter.closeIssuedDialog(pending);await h.adapter.leaveShop();
  const before=await h.adapter.inventory(line.slot);await h.page.evaluate(id=>{bag=bag.filter(i=>i.identity!==id);},line.identity);
  const legacy=await h.adapter.recover({kind:'sell',line,quantity:1,before});assert.ok(legacy.saved);assert.equal(legacy.after.slot.identity,'item-2');
 }finally{await h.page.close();}
});

test('nonconsuming flow inspection stays in shop and does not read bag before or after',async()=>{
 const h=await setup(browser);try{const lines=await gearBatch(h);await h.page.evaluate(()=>{visits=[];});await h.adapter.beginSaleBatch(lines,shop);const result=await h.adapter.inspectSale(lines[0],1,shop);assert.equal(result.issued,false);assert.deepEqual(await h.page.evaluate(()=>actions),[]);assert.deepEqual(await h.page.evaluate(()=>visits),['shop','sale-detail']);}finally{await h.page.close();}
});
