import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {setup} from './helpers/inventory-game.js';
import {installNativeSale} from './helpers/native-sale-game.js';
import {freezeSale} from '../src/inventory-proof.js';
import {InventoryUI} from '../src/inventory-ui.js';
let browser;before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});after(async()=>browser?.close());
const shop={regionName:'百渠泽地',locationName:'千渠埠',name:'四海商盟·千渠商会'};
async function harness(){
 const h=await setup(browser);await h.page.evaluate(()=>{bag.find(i=>i.identity==='item-3').name=bag[0].name;bag.push({name:'精炼材料',identity:'item-99',quality:'160',slot:null,quantity:1,equipped:false});});
 const lines=freezeSale(await h.adapter.inventory(undefined,false),['instance:item-1','instance:item-3','instance:item-99']);
 await h.adapter.openShop(shop);await h.page.evaluate(installNativeSale);return {...h,lines};
}
test('gear and refined materials are selected by ID and sold with one confirmation, with no per-item details',async()=>{
 const h=await harness();try{
  await h.page.evaluate(()=>{window.reorder=true;const equipped=bag.filter(i=>i.equipped);equipped[1].name=equipped[0].name;renderRows();});
  await h.adapter.beginSaleBatch(h.lines,shop);assert.ok(await h.adapter.supportsBulkSale());let pending;
  const result=await h.adapter.sellInstances(h.lines,shop,async value=>{pending=structuredClone(value);assert.deepEqual(await h.page.evaluate(()=>actions),[]);});
  assert.equal(result.saved,true);assert.equal(pending.evidenceSource,'shop-bulk-v1');
  assert.deepEqual(await h.page.evaluate(()=>actions),[['sell-bulk',h.lines.map(l=>l.identity)]]);
  assert.equal((await h.page.evaluate(()=>visits)).filter(v=>v==='sale-detail').length,0);
  assert.ok(await h.page.evaluate(()=>bag.some(i=>i.identity==='item-7'))); // Preexisting selection was cleared.
 }finally{await h.page.close();}
});
test('changed confirmation names/prices/qualities and extra selection never reach the consuming button',async()=>{
 for(const fault of ['extra','quality','price']){const h=await harness();try{
  await h.page.evaluate(f=>{window.reviewFault=f;},fault);
  await assert.rejects(h.adapter.sellInstances(h.lines,shop,()=>assert.fail('must not mark issued')));
  assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}}
});
test('lost click response and delayed local save reconcile the entire group without reissuing',async()=>{
 const h=await harness();try{
  await h.page.evaluate(()=>{saved=false;tradeDelay=80;afterSale=()=>setTimeout(()=>document.querySelector('footer.statusbar').textContent='本地存档已就绪',200);});
  const unique=h.ui.unique.bind(h.ui);h.ui.unique=async(locator,label)=>{const button=await unique(locator,label);if(label==='确认批量售出'){const click=button.click.bind(button);button.click=async options=>{await click(options);throw Error('response lost');};}return button;};
  assert.ok((await h.adapter.sellInstances(h.lines,shop,async()=>{})).saved);assert.equal((await h.page.evaluate(()=>actions)).length,1);
 }finally{await h.page.close();}
});
test('partial sale, no sale, unrelated loss and blank lists remain pending; recovery never resubmits',async()=>{
 for(const fault of ['partial','none','unrelated','blank']){const h=await harness();try{
  await h.page.evaluate(f=>{if(f==='partial')window.partialSale=true;if(f==='none')window.noSale=true;if(f==='blank')window.afterSale=()=>document.querySelector('.entry-list').replaceChildren();if(f==='unrelated')window.afterSale=()=>{bag=bag.filter(i=>i.identity!=='item-7');renderRows();};},fault);let pending;
  await assert.rejects(h.adapter.sellInstances(h.lines,shop,async p=>{pending=structuredClone(p);}));assert.equal((await h.page.evaluate(()=>actions)).length,1);
  const restarted=new InventoryUI(h.ui,{reader:h.adapter.reader,knowledge:h.adapter.knowledge});
  if(['partial','none','unrelated'].includes(fault))await assert.rejects(restarted.recover(pending));
  else {await h.page.evaluate(()=>{nativeCategory='all';renderRows();});assert.ok((await restarted.recover(pending)).saved);}
  assert.equal((await h.page.evaluate(()=>actions)).length,1);
 }finally{await h.page.close();}}
});
test('incomplete native controls do not silently fall back to individual sales',async()=>{
 const h=await harness();try{
  await h.page.locator('.shop-bulk-tools').evaluate(el=>el.remove());
  await assert.rejects(h.adapter.supportsBulkSale(),/未退回逐件/u);assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}
});
test('category filters cannot prove a sale, and the adapter resets them to all before checking results',async()=>{
 const h=await harness();try{
  await assert.rejects(h.adapter.readSale(shop),/类别仍在筛选/u);
  await h.page.evaluate(()=>{window.afterSale=()=>{nativeCategory='equipment';renderRows();};});
  assert.ok((await h.adapter.sellInstances(h.lines,shop,async()=>{})).saved);
  assert.equal(await h.page.evaluate(()=>nativeCategory),'all');assert.equal((await h.page.evaluate(()=>actions)).length,1);
 }finally{await h.page.close();}
});
test('failure to persist the issued group and stop before confirmation do not sell anything',async()=>{
 for(const stop of [false,true]){const h=await harness();try{
  await assert.rejects(h.adapter.sellInstances(h.lines,shop,async()=>{if(stop)h.ui.beforeAction=()=>{throw Error('stop');};else throw Error('disk full');}));
  assert.deepEqual(await h.page.evaluate(()=>actions),[]);
 }finally{await h.page.close();}}
});
