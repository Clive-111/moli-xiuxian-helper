import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {BattleControl} from '../src/battle-control.js';
import {atomicJson} from '../src/control-store.js';
import {freezeSale,validateLine,saleProof,equipProof,SLOT_LABELS,itemId} from '../src/inventory-proof.js';
import {displayMatchesPrice} from '../src/inventory-ui.js';
import {parseCatalog,saleShop} from '../src/catalog.js';
const gear=(identity,quality='100',slot='body')=>({identity,quality,slot,name:'同名器物',quantity:'1',unitPrice:'100',equipped:false,gameItemId:'armor',key:identity});
const stack=()=>({identity:'',gameItemId:'ore',name:'矿石',quantity:'25001',unitPrice:'10',equipped:false,key:'ore',quality:null});
const shop={id:'north-shop',name:'四海商盟·千渠商会',regionName:'百渠泽地',locationName:'千渠埠'};
test('freeze exact instance IDs, same name/quality, stack all and protect equipped/legacy entries',()=>{
 const inv={items:[gear('item-1'),gear('item-2'),gear('item-3','90'),stack()]};const lines=freezeSale(inv,inv.items.map(itemId));assert.deepEqual(lines.map(l=>l.quantity),[1,1,1,25001]);
 assert.throws(()=>freezeSale(inv,['instance:item-1','instance:item-1']));for(const equipped of [true,null,undefined])assert.throws(()=>freezeSale({items:[{...gear('item-1'),equipped}]},['instance:item-1']));
 assert.throws(()=>validateLine({items:[gear('item-1','99')]},lines[0],1));assert.throws(()=>validateLine({items:[{...stack(),unitPrice:'11'}]},lines[3],10));
 assert.equal(lines[3].quantity,25001);inv.items[3].quantity='26000';assert.equal(lines[3].quantity,25001);
});
test('proof uses exact counts, equipped ID, old equipment return and save, never rounded money',()=>{
 const before={items:[gear('item-1'),gear('item-2'),stack()]},line=freezeSale(before,['instance:item-1'])[0];
 assert.equal(saleProof(before,{items:[gear('item-1')]},line,1,true),false);assert.equal(saleProof(before,{items:[gear('item-2')]},line,1,false),false);
 assert.equal(saleProof(before,{items:[],equipment:[gear('item-1')]},line,1,true),false);assert.equal(saleProof(before,{items:[gear('item-2')]},line,1,true),true);
 const s=freezeSale(before,['stack:ore'])[0];assert.equal(saleProof(before,{items:[{...stack(),quantity:'15001'}]},s,10000,true),true);assert.equal(saleProof(before,{items:[{...stack(),quantity:'15002'}]},s,10000,true),false);
 for(const slot of Object.keys(SLOT_LABELS)){const l=gear('item-1','100',slot),old={slot,identity:'item-2'},next={slot,identity:'item-1'};assert.equal(equipProof({slot:old},{slot:next,items:[gear('item-2')]},l,true),true);assert.equal(equipProof({slot:old},{slot:next,items:[]},l,true),false);assert.equal(equipProof({slot:old},{slot:{slot,identity:'item-3'},items:[gear('item-2')]},l,true),false);}
 assert.ok(displayMatchesPrice('1.23万 灵石','12399'));assert.equal(displayMatchesPrice('1.2万 灵石','12999'),false);assert.equal(displayMatchesPrice('1兆 灵石','1000000000000'),true);assert.equal(displayMatchesPrice('100 灵石','99'),false);
});
test('shops are parsed by data shape and associated with safe regions, no remote code execution',()=>{
 const source=`const regions=[{id:'n',name:'北',locations:['a','b']},{id:'s',name:'南',locations:['c']}];const places={a:{name:'镇',prerequisite:'',meditation:true},b:{...helper('山','a',[])},c:{name:'镇',prerequisite:'',meditation:false}};const items={red:{kind:'marrow',name:'赤灵髓'}};const shops={x:{name:'商店',locationId:'a',stock:[],stateKey:'x'},y:{name:'商店',locationId:'c',stock:[],stateKey:'y'}};throw new Error('never execute');`;
 const catalog=parseCatalog(source);assert.equal(catalog.shops.length,2);assert.equal(saleShop(catalog,{regionName:'南',locationName:'镇',shopName:'商店'}).id,'y');assert.throws(()=>saleShop(catalog,{regionName:'未知',locationName:'镇',shopName:'商店'}));assert.throws(()=>parseCatalog(source.replace("locationId:'c'","locationId:'b'")));
});
async function setup(options={}){
 const directory=options.directory??await mkdtemp(path.join(os.tmpdir(),'inventory-test-')),actions=[];let items=[gear('item-1'),gear('item-2'),stack()],issued=0;
 const state={mode:'combat',character:'测试修士',view:{dialogs:[]},heal:{running:false}};
 const ui={async observe(){this.onSnapshot?.(state);return state;},async ensureMonitoringView(){return {ready:true};},async retreatForTarget(){state.mode='rest';actions.push('retreat');}};
 const adapter={async beginSaleBatch(){actions.push('beginSaleBatch');},async leaveShop(){actions.push('leaveShop');},reader:{async read(view){actions.push('refresh:'+view);return {items:structuredClone(items),equipment:[],updatedAt:Date.now()};}},async inventory(slot,equipment){actions.push('inventory-read:'+String(equipment));return {items:structuredClone(items)};},async stopActivity(check){await check('retreating');await options.beforeActivity?.();await ui.retreatForTarget();},
  async sell(line,quantity,store,fence){await options.beforeIssued?.(store);const before={items:structuredClone(items)};await fence({kind:'sell',before,line,quantity});issued++;actions.push([line.id,quantity]);items=items.filter(i=>i.identity!==line.identity||!line.identity).map(i=>itemId(i)===line.id?{...i,quantity:String(Number(i.quantity)-quantity)}:i).filter(i=>i.quantity!=='0');await options.afterIssued?.(issued);if(options.failAt===issued)throw new Error('response timeout');return {saved:true,verifiedAt:Date.now()};},
  async recover(p){if(options.reviewFails)throw new Error('save not ready');assert.ok(saleProof(p.before,{items},p.line,p.quantity,true));return {saved:true,verifiedAt:Date.now()};}
 };
 const base={enabled:false,characterName:'测试修士',target:{regionName:'北',stageName:'山'},saleTarget:{regionName:shop.regionName,locationName:shop.locationName,shopName:shop.name},consumables:{enabled:false,itemNames:['赤灵髓']}};
 const params={base,directory,runtime:{profilePath:directory},signal:new AbortController().signal,log:()=>{},makeUI:async()=>ui,inventoryOptions:{makeUI:()=>adapter,...options.inventoryOptions}};
 const c=new BattleControl(params);await c.initialize();c.close();c.catalog={shops:[shop]};return {c,params,directory,actions,options,adapter,get issued(){return issued;},addStock(n){items.find(i=>i.gameItemId==='ore').quantity=String(n);}};
}
async function preview(h,ids=['instance:item-1','instance:item-2']){const r=await h.c.command('inventory-preview',{kind:'sell',ids}).promise;assert.ok(r.ok,r.error);return r.previewId;}

async function equipmentHarness(options={}){
 const h=await setup(options),slot=options.slot??'body';let bag=[gear('item-1','100',slot),gear('item-2','100',slot)],worn={...gear('old','90',slot),equipped:true},equips=0;
 const inventory=()=>({items:structuredClone(bag),slot:structuredClone(worn),equipment:[structuredClone(worn)],updatedAt:Date.now()});
 h.adapter.inventory=async requested=>{assert.equal(requested,slot);return inventory();};
 h.adapter.previewEquip=()=>assert.fail('direct replacement must not request an attribute preview');
 h.adapter.reader.read=async view=>view==='inventory'?inventory():{items:[],updatedAt:Date.now()};
 h.adapter.equip=async(line,fence)=>{
  assert.equal(line.original.identity,worn.identity);assert.equal(line.slot,slot);
  const before=inventory();await fence({kind:'equip',before,line,quantity:1});equips++;
  const next=bag.find(i=>i.identity===line.identity);bag=bag.filter(i=>i!==next);bag.push({...worn,equipped:false});worn={...next,equipped:true};
  await options.afterEquip?.();if(options.timeout)throw new Error('equip response timeout');
  assert.ok(equipProof(before,inventory(),line,true));return {saved:true,verifiedAt:Date.now(),after:inventory()};
 };
 h.adapter.recover=async p=>{assert.ok(equipProof(p.before,inventory(),p.line,true));return {saved:true,verifiedAt:Date.now(),after:inventory()};};
 return {...h,get equips(){return equips;}};
}

test('direct equipment replacement supports all slots, uses one queue and request ID, and resumes original state',async()=>{
 for(const slot of Object.keys(SLOT_LABELS)){
  const h=await equipmentHarness({slot}),payload={id:'instance:item-2',slot,requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
  h.c.record.desired='running';h.c.phase='running';h.c.consumables.state={nextAt:1234};
  const job=h.c.command('inventory-equip',payload);assert.equal(h.c.command('inventory-equip',payload),job);
  assert.ok((await job.promise).ok);assert.equal(h.equips,1);assert.equal(h.c.inventoryActions.active,null);assert.equal(h.c.phase,'checking');assert.equal(h.c.consumables.state.nextAt,1234);
  assert.ok(h.c.library.views.inventory.items.some(i=>i.identity==='old'));assert.equal(h.c.library.views.inventory.items.some(i=>i.identity==='item-2'),false);
  assert.ok((await h.c.command('inventory-equip',payload).promise).ok);assert.equal(h.equips,1);
  assert.equal((await h.c.command('inventory-equip',{...payload,id:'instance:item-1'}).promise).ok,false);
  assert.equal((await h.c.command('inventory-equip',{...payload,requestId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}).promise).already,true);assert.equal(h.equips,1);
 }
});

test('direct replacement timeout and restart preserve the issued fence; review never replaces twice',async()=>{
 const h=await equipmentHarness({timeout:true}),payload={id:'instance:item-2',slot:'body',requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
 assert.equal((await h.c.command('inventory-equip',payload).promise).ok,false);assert.equal(h.equips,1);assert.equal(h.c.inventoryActions.active.stage,'awaiting-review');
 const c=new BattleControl(h.params);await c.initialize();c.close();
 assert.ok((await c.command('inventory-equip',payload).promise).ok);assert.equal(h.equips,1);
 assert.ok((await c.command('inventory-review',{operationId:payload.requestId}).promise).ok);assert.equal(c.inventoryActions.active,null);assert.equal(h.equips,1);assert.equal(c.phase,'stopped');
});

test('direct replacement validates slot, respects other transactions and stop before or after issue',async()=>{
 const invalid=await equipmentHarness();
 assert.throws(()=>invalid.c.command('inventory-equip',{id:'instance:item-2',slot:'invalid',requestId:'a'.repeat(36)}),/部位/u);
 const payload={id:'instance:item-2',slot:'body',requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
 invalid.c.crafting.data.activeId='craft';invalid.c.crafting.data.operations.craft={id:'craft',preview:{selection:{}}};
 assert.equal((await invalid.c.command('inventory-equip',payload).promise).ok,false);assert.equal(invalid.equips,0);
 for(const issued of [false,true]){
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),pause=async()=>{enter();await gate;};
  const h=await equipmentHarness(issued?{afterEquip:pause}:{beforeActivity:pause});h.c.record.desired='running';h.c.phase='running';
  const job=h.c.command('inventory-equip',payload);await entered;const stop=h.c.command('stop');await h.c.inventoryActions.tail;release();
  assert.ok((await job.promise).ok);assert.ok((await stop.promise).ok);assert.equal(h.equips,issued?1:0);assert.equal(h.c.record.desired,'stopped');assert.equal(h.c.inventoryActions.active,null);
 }
});
test('serialized stack batches freeze all, adjusted quantities, duplicate submission, preserve timer/running state',async()=>{
 const h=await setup(),id=await preview(h,['stack:ore']);h.addStock(26001);h.c.record.desired='running';h.c.phase='running';h.c.consumables.state={nextAt:1234};
 const job=h.c.command('inventory-execute',{previewId:id});assert.equal(h.c.command('inventory-execute',{previewId:id}),job);assert.ok((await job.promise).ok);
 assert.deepEqual(h.actions.filter(Array.isArray).map(x=>x[1]),[10000,10000,5001]);assert.equal(h.c.consumables.state.nextAt,1234);assert.equal(h.c.phase,'checking');
 assert.ok((await h.c.command('inventory-execute',{previewId:id}).promise).ok);assert.equal(h.issued,3);
 const h2=await setup(),id2=await preview(h2,['stack:ore']);assert.ok((await h2.c.command('inventory-execute',{previewId:id2,quantities:{'stack:ore':7}}).promise).ok);assert.equal(h2.actions.find(Array.isArray)[1],7);assert.equal(h2.c.phase,'stopped');
});
test('lost response pauses entire batch, review only does not sell remaining, continue is explicit',async()=>{
 const h=await setup({failAt:1}),id=await preview(h);assert.equal((await h.c.command('inventory-execute',{previewId:id}).promise).ok,false);assert.equal(h.issued,1);
 for(const [kind,payload] of [['craft-preview',{key:'a'.repeat(64)}],['library',{view:'inventory'}],['start',{}],['settings',{}]])assert.equal((await h.c.command(kind,payload).promise).ok,false);
 await h.c.tick();assert.equal(h.issued,1);assert.ok((await h.c.command('inventory-review',{operationId:id}).promise).ok);assert.equal(h.issued,1);assert.equal(h.c.inventoryActions.active.stage,'awaiting-continue');
 assert.ok((await h.c.command('inventory-continue',{operationId:id}).promise).ok);assert.equal(h.issued,2);assert.equal(h.c.inventoryActions.active,null);
});
test('container restart never replays sale; durable pending can be reviewed and remainder cancelled',async()=>{
 const h=await setup({failAt:1}),id=await preview(h);await h.c.command('inventory-execute',{previewId:id}).promise;
 const c=new BattleControl(h.params);await c.initialize();c.close();assert.equal(c.phase,'attention');assert.ok((await c.command('inventory-execute',{previewId:id}).promise).ok);assert.equal(h.issued,1);
 assert.ok((await c.command('inventory-cancel',{operationId:id}).promise).ok);assert.equal(h.issued,1);assert.equal(c.inventoryActions.data.operations[id].stage,'cancelled');assert.equal(c.inventoryActions.data.operations[id].lines[0].completed,1);
});
test('stop mid-batch verifies issued item, cancels remaining, cannot resume battle',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const h=await setup({afterIssued:async()=>{entered();await gate;}}),id=await preview(h);h.c.record.desired='running';h.c.phase='running';const execute=h.c.command('inventory-execute',{previewId:id});await ready;
 const stop=h.c.command('stop');await h.c.inventoryActions.tail;release();assert.ok((await execute.promise).ok);assert.ok((await stop.promise).ok);assert.equal(h.issued,1);assert.equal(h.c.record.desired,'stopped');assert.equal(h.c.inventoryActions.data.operations[id].stage,'cancelled');
 const record=JSON.parse(await readFile(path.join(h.directory,'inventory-actions.json')));assert.equal(record.stopRequested,true);assert.equal(record.operations[id].pending,null);
});
test('write failure fences consumption; crafted pending blocks sale; invalid quantities rejected',async()=>{
 const h=await setup({inventoryOptions:{write:async(file,d)=>{if(d.operations[d.activeId]?.pending)throw new Error('disk full');await atomicJson(file,d);}}}),id=await preview(h);
 assert.equal((await h.c.command('inventory-execute',{previewId:id}).promise).ok,false);assert.equal(h.issued,0);assert.equal(h.c.inventoryActions.active.pending,null);
 const h2=await setup(),p=await preview(h2,['stack:ore']);assert.equal((await h2.c.command('inventory-execute',{previewId:p,quantities:{'stack:ore':26000}}).promise).ok,false);assert.equal(h2.issued,0);
 h2.c.crafting.data.activeId='craft';h2.c.crafting.data.operations.craft={id:'craft',preview:{selection:{}}};assert.equal((await h2.c.command('inventory-execute',{previewId:p}).promise).ok,false);
});
test('cancelling unissued remainder works even while login is unavailable',async()=>{
 const h=await setup({beforeIssued:async()=>{throw new Error('shop unavailable');}}),id=await preview(h);await h.c.command('inventory-execute',{previewId:id}).promise;
 h.c.makeUI=async()=>{throw new Error('login required');};assert.ok((await h.c.command('inventory-cancel',{operationId:id}).promise).ok);assert.equal(h.c.inventoryActions.active,null);assert.equal(h.issued,0);
});

test('paused batch can save a new default without game actions, then explicitly continue at another shop with frozen quantities',async()=>{
 const seen=[],h=await setup({beforeIssued:async store=>{seen.push(store.id);throw new Error('old entrance unavailable');}}),id=await preview(h,['stack:ore']);
 await h.c.command('inventory-execute',{previewId:id,quantities:{'stack:ore':7}}).promise;
 const next={...shop,id:'other-shop',name:'另一商会',regionName:'南',locationName:'港'};h.c.catalog.shops.push(next);
 const frozen=structuredClone(h.c.inventoryActions.active.lines),target={regionName:next.regionName,locationName:next.locationName,shopName:next.name},revision=h.c.record.revision;
 h.c.makeUI=async()=>{throw new Error('saving default must not inspect game');};
 const saved=await h.c.command('settings',{revision,saleTarget:target}).promise;assert.ok(saved.ok,saved.error);
 assert.equal(h.c.inventoryActions.active.shop.id,shop.id);assert.deepEqual(h.c.inventoryActions.active.lines,frozen);assert.equal(h.issued,0);
 assert.deepEqual(h.c.record.settings.saleTarget,target);assert.equal(h.c.record.desired,'stopped');
 assert.equal((await h.c.command('settings',{revision,saleTarget:target}).promise).ok,false);
 h.c.makeUI=h.params.makeUI;h.options.beforeIssued=async store=>seen.push(store.id);h.addStock(30000);
 assert.ok((await h.c.command('inventory-continue',{operationId:id,shopId:next.id}).promise).ok);
 assert.deepEqual(seen,[shop.id,next.id]);assert.equal(h.issued,1);assert.deepEqual(h.actions.filter(Array.isArray),[['stack:ore',7]]);
 assert.equal(h.c.record.desired,'stopped');
});

test('unknown shop or an unconfirmed sale cannot change the batch shop or issue remaining sales',async()=>{
 const h=await setup({failAt:1}),id=await preview(h);await h.c.command('inventory-execute',{previewId:id}).promise;
 const before=structuredClone(h.c.inventoryActions.active);assert.equal((await h.c.command('inventory-continue',{operationId:id,shopId:'missing'}).promise).ok,false);
 assert.deepEqual(h.c.inventoryActions.active,before);assert.equal(h.issued,1);
 await h.c.command('inventory-review',{operationId:id}).promise;
 assert.equal((await h.c.command('inventory-continue',{operationId:id,shopId:'missing'}).promise).ok,false);assert.equal(h.issued,1);assert.equal(h.c.inventoryActions.active.shop.id,shop.id);
});

test('public shop refresh works during paused batch, preserves visibility on same resource and retains catalog on empty result',async()=>{
 const h=await setup({beforeIssued:async()=>{throw new Error('unavailable');}}),id=await preview(h);await h.c.command('inventory-execute',{previewId:id}).promise;
 h.c.catalog={resourceUrl:'https://game/assets/v1.js',updatedAt:1,regions:[],items:[],nodes:[{id:'town',name:'镇',regionId:'n',type:'rest',availability:'visible',checkedAt:2}],shops:[shop]};
 const original=structuredClone(h.c.catalog),batch=structuredClone(h.c.inventoryActions.active);
 h.c.catalogLoader=async()=>({...structuredClone(original),updatedAt:3,nodes:original.nodes.map(n=>({...n,availability:'unverified'}))});
 h.c.makeUI=async()=>{throw new Error('public refresh must not touch game');};
 assert.ok((await h.c.command('refresh',{shopsOnly:true}).promise).ok);assert.equal(h.c.catalog.nodes[0].availability,'visible');
 const good=structuredClone(h.c.catalog);h.c.catalogLoader=async()=>({...good,shops:[]});
 assert.equal((await h.c.command('refresh',{shopsOnly:true}).promise).ok,false);assert.deepEqual(h.c.catalog,good);assert.deepEqual(h.c.inventoryActions.active,batch);assert.equal(h.issued,0);
});

test('inspection of a paused sale uses only preparation and preserves frozen lines and pending markers',async()=>{
 const h=await setup({beforeIssued:async()=>{throw new Error('sale tab missing');}}),id=await preview(h,['stack:ore']);await h.c.command('inventory-execute',{previewId:id,quantities:{'stack:ore':7}}).promise;
 const before=structuredClone(h.c.inventoryActions.active.lines);let inspections=0;
 h.adapter.inspectSale=async(line,quantity,shop)=>{inspections++;assert.equal(quantity,7);return {checkedAt:Date.now(),lineId:line.id,name:line.name,quantity,shopName:shop.name,stock:'25001',issued:false};};
 const result=await h.c.command('inventory-review',{operationId:id,inspectSale:true}).promise;assert.ok(result.ok,result.error);assert.equal(result.inspection.issued,false);
 assert.equal(inspections,1);assert.equal(h.issued,0);assert.deepEqual(h.c.inventoryActions.active.lines,before);assert.equal(h.c.inventoryActions.active.pending,null);assert.equal(h.c.record.desired,'stopped');
 const pending=await setup({failAt:1}),otherId=await preview(pending);await pending.c.command('inventory-execute',{previewId:otherId}).promise;
 pending.adapter.inspectSale=()=>assert.fail('must review issued action first');assert.equal((await pending.c.command('inventory-review',{operationId:otherId,inspectSale:true}).promise).ok,false);assert.equal(pending.issued,1);
});

 test('sale preview reads inventory once without equipment; execution enters shop once and refreshes once at end',async()=>{
 const h=await setup(),id=await preview(h);assert.deepEqual(h.actions,['inventory-read:false']);h.actions.length=0;
 assert.ok((await h.c.command('inventory-execute',{previewId:id}).promise).ok);
 assert.deepEqual(h.actions.filter(x=>typeof x==='string'),['retreat','beginSaleBatch','leaveShop','refresh:inventory','refresh:crafting']);assert.equal(h.issued,2);
 });
