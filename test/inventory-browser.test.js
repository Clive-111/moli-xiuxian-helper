import {setup as createGame} from './helpers/inventory-game.js';
import {test,before,after} from 'node:test';import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BattleUI} from '../src/battle-ui.js';import {LibraryUI} from '../src/library-ui.js';
import {InventoryUI} from '../src/inventory-ui.js';import {freezeSale,SLOT_LABELS,itemId} from '../src/inventory-proof.js';
let browser;before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});after(async()=>browser?.close());
const setup=()=>createGame(browser);
const shop={regionName:'百渠泽地',locationName:'千渠埠',name:'四海商盟·千渠商会'};
test('real DOM adapters preview and equip every slot by instance; old equipment returns to bag',async()=>{
 const h=await setup();try{for(const slot of Object.keys(SLOT_LABELS)){const inv=await h.adapter.inventory(slot),item=inv.items.find(i=>i.slot===slot),p=await h.adapter.previewEquip(item);assert.match(p.detail.comparison,/100 → 120/u);let issued=0;const result=await h.adapter.equip(p.line,async evidence=>{issued++;assert.equal(evidence.before.slot.identity,p.line.original.identity);});assert.ok(result.saved);assert.equal(issued,1);assert.equal(result.after.slot.identity,item.identity);assert.ok(result.after.items.some(i=>i.identity===p.line.original.identity));const again=await h.adapter.equip(p.line,()=>assert.fail('already equipped'));assert.ok(again.already);}
 }finally{await h.page.close();}
});
test('sell exact same-quality instance and explicit stack quantity at wounded safe town',async()=>{
 const h=await setup();try{const inv=await h.adapter.inventory(),lines=freezeSale(inv,['instance:item-1','stack:ore']);let issued=0;
  const result=await h.adapter.sell(lines[0],1,shop,async()=>issued++);assert.ok(result.saved);assert.ok(result.after.items.some(i=>i.identity==='item-3'));assert.equal(result.evidenceSource,'shop-v1');
  assert.ok((await h.adapter.sell(lines[1],10000,shop,async()=>issued++)).saved);assert.equal(issued,2);assert.deepEqual(await h.page.evaluate(()=>actions),[['sell','item-1',1],['sell','ore',10000]]);
 }finally{await h.page.close();}
});
test('missing shop, wrong character, changed detail ID and save pending never report success',async()=>{
 for(const fault of ['shop','character','identity','save']){const h=await setup();try{const line=freezeSale(await h.adapter.inventory(),['instance:item-1'])[0];await h.page.evaluate(f=>{if(f==='shop'){shopAvailable=false;show('游历');}if(f==='character')document.querySelector('.discord-profile h3').textContent='其他人';if(f==='identity')mismatch=true;if(f==='save')saved=false;},fault);let issued=0;await assert.rejects(h.adapter.sell(line,1,shop,async()=>issued++));assert.equal(issued,fault==='save'?1:0);}finally{await h.page.close();}}
});
test('successful sale with Playwright timeout is reconciled without a second sell click',async()=>{
 const h=await setup();try{const line=freezeSale(await h.adapter.inventory(),['instance:item-1'])[0],unique=h.ui.unique.bind(h.ui);h.ui.unique=async(locator,label)=>{const b=await unique(locator,label);if(label==='确认售出'){const click=b.click.bind(b);b.click=async opts=>{await click(opts);throw new Error('timeout');};}return b;};let issued=0;const result=await h.adapter.sell(line,1,shop,async()=>issued++);assert.ok(result.saved);assert.equal(issued,1);assert.equal((await h.page.evaluate(()=>actions)).length,1);}finally{await h.page.close();}
});

test('shop entry uses full name within local services, reconciles click timeout, and never chooses consignment',async()=>{
 const h=await setup();try{
  const state=await h.ui.observe();assert.ok(state.localServices.some(s=>s.name===shop.name&&s.enabled));
  const unique=h.ui.unique.bind(h.ui);let entries=0;
  h.ui.unique=async(locator,label)=>{const b=await unique(locator,label);if(label==='进入'+shop.name){const click=b.click.bind(b);b.click=async opts=>{entries++;await click(opts);throw new Error('timeout after successful entry');};}return b;};
  await h.adapter.openShop(shop);assert.equal(entries,1);assert.equal(await h.page.locator('.shop-view').count(),1);assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}
});

test('duplicate or disabled shop entries stop before entering, including service-section layout',async()=>{
 for(const kind of ['duplicate','disabled','section']){const h=await setup();try{
  await h.page.evaluate(kind=>{const nav=document.querySelector('.place-links');if(kind==='duplicate')nav.append(nav.querySelector('.shop-entry').cloneNode(true));if(kind==='disabled')nav.querySelector('.shop-entry').disabled=true;if(kind==='section'){nav.className='place-services';nav.removeAttribute('aria-label');}},kind);
  if(kind==='section')await h.adapter.openShop(shop);else await assert.rejects(h.adapter.openShop(shop),/不唯一|暂不可用/u);
  assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}}
});

test('sale tab is an ARIA tab, clears retained search, and reconciles selection timeout without a second click',async()=>{
 const h=await setup();try{const unique=h.ui.unique.bind(h.ui);let switches=0;
  h.ui.unique=async(locator,label)=>{const b=await unique(locator,label);if(label==='打开商店售出页'){const click=b.click.bind(b);b.click=async opts=>{switches++;await click(opts);throw new Error('timeout after tab selected');};}return b;};
  await h.adapter.openShop(shop);assert.equal(switches,1);assert.equal(await h.page.getByRole('tab',{name:'售出',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await h.page.getByRole('searchbox',{name:'查找交易物品'}).inputValue(),'');await h.adapter.openSaleTab();assert.equal(switches,1);
  assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}
});

test('an unselected or duplicate sell tab never opens items or consumes stock',async()=>{
 for(const fault of ['ignore','duplicate']){const h=await setup();try{
  if(fault==='ignore')await h.page.evaluate(()=>{window.ignoreSaleTab=true;});
  else{const click=h.adapter.reader.click.bind(h.adapter.reader);h.adapter.reader.click=async(...args)=>{const r=await click(...args);if(args[1]==='进入'+shop.name)await h.page.evaluate(()=>{const t=document.querySelector('.sell-tab');t.parentElement.append(t.cloneNode(true));});return r;};}
  await assert.rejects(h.adapter.openShop(shop));assert.equal(await h.page.locator('dialog[open]').count(),0);assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}}
});

test('inspection reaches final sale control for exact instance and stack amount without selling, even when detail click times out',async()=>{
 const h=await setup();try{const inventory=await h.adapter.inventory(),lines=freezeSale(inventory,['instance:item-1','stack:ore']),before=await h.page.evaluate(()=>JSON.stringify(bag)),unique=h.ui.unique.bind(h.ui);let opened=0;
  h.ui.unique=async(locator,label)=>{const b=await unique(locator,label);if(label.startsWith('核对待售')){const click=b.click.bind(b);b.click=async opts=>{opened++;await click(opts);throw new Error('detail click response lost');};}return b;};
  for(const [index,line] of lines.entries()){const result=await h.adapter.inspectSale(line,index?7:1,shop);assert.equal(result.issued,false);assert.equal(result.lineId,line.id);assert.equal(result.quantity,index?7:1);}
  assert.equal(opened,2);assert.equal(await h.page.locator('dialog[open]').count(),0);assert.deepEqual(await h.page.evaluate(()=>actions),[]);assert.equal(await h.page.evaluate(()=>JSON.stringify(bag)),before);
 }finally{await h.page.close();}
});
