import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {marrowFarming,recommendMaps} from '../src/farming.js';
import {startControlServer} from '../src/control-server.js';
import {marrowFixture} from './helpers/marrow-fixture.js';

test('marrow expectations reuse recipe model, additive rolls, multiplier exemptions, wave overrides and random group sizes',()=>{
 const c=marrowFixture(),p=marrowFarming(c),north=p.maps.find(m=>m.id==='north'),south=p.maps.find(m=>m.id==='south');
 assert.equal(p.bestMapId,'north');assert.equal(north.outputs.find(o=>o.itemId==='red').expected,6.5);assert.ok(Math.abs(north.outputs.find(o=>o.itemId==='green').expected-2.6)<1e-10);
 assert.equal(south.outputs.find(o=>o.itemId==='red').expected,6);assert.equal(south.outputs.find(o=>o.itemId==='green').expected,3);
 const existing=recommendMaps(c.knowledge,c.bestiary,c.catalog,p.selected.map(i=>({itemId:i.id,name:i.name,quantity:1})));
 for(const m of p.maps)assert.deepEqual(m.outputs,existing.find(r=>r.id===m.id).outputs);
 assert.equal(p.bestByItem.find(i=>i.id==='red').best.mapId,'north');assert.equal(p.bestByItem.find(i=>i.id==='green').best.mapId,'south');
 assert.equal(marrowFarming(c,{itemIds:['green']}).bestMapId,'south');assert.equal(marrowFarming(c,{itemIds:['green']}).maps[0].regionName,'南境');
});

test('locked/challenge/unknown/stale maps never receive a top recommendation; partial yields are explicitly qualified',()=>{
 const c=marrowFixture();let p=marrowFarming(c);assert.equal(p.maps.find(m=>m.id==='locked').eligible,false);assert.equal(p.maps.find(m=>m.id==='challenge').eligible,false);
 c.bestiary.entries=[{id:'a'}];p=marrowFarming(c);assert.equal(p.bestMapId,null);assert.ok(p.maps.every(m=>!m.eligible));assert.ok(p.maps[0].reasons.some(r=>r.includes('未遭遇')));
 c.bestiary.knowledgeRevision='old';p=marrowFarming(c);assert.ok(p.stale);assert.equal(p.bestMapId,null);
 c.bestiary.entries=[];p=marrowFarming(c);assert.deepEqual(p.maps,[]);assert.ok(p.bestByItem.every(i=>i.best===null));
});

test('requires marrow IDs, supports future definitions, no inventory/recipe dependency and no mutation',()=>{
 const c=marrowFixture(),original=structuredClone(c);marrowFarming(c,{itemIds:['red']});assert.deepEqual(c,original);
 for(const payload of [null,[],{itemIds:[]},{itemIds:['other']},{itemIds:['red','red']},{itemIds:'red'},{itemIds:['missing']}])assert.throws(()=>marrowFarming(c,payload));
 assert.throws(()=>marrowFarming({}),/图鉴/u);
 c.knowledge.items.push({id:'future',name:'新灵髓',kind:'marrow'});c.knowledge.enemies[0].loot.push({itemId:'future',chance:.1});
 assert.ok(marrowFarming(c,{itemIds:['future']}).maps.length);assert.equal(marrowFarming(c).selected.length,3);
});

test('marrow chooser and per-kind results share potency order without changing selection, data or map ranking',()=>{
 const c=marrowFixture(),before=marrowFarming(c,{itemIds:['green','red']});
 c.knowledge.items.find(i=>i.id==='red').marrowValue=100;
 c.knowledge.items.find(i=>i.id==='green').marrowValue=200;
 c.knowledge.items.reverse();c.knowledge.items.unshift({id:'new',name:'新灵髓',kind:'marrow',marrowValue:10000});
 const original=structuredClone(c),after=marrowFarming(c,{itemIds:['green','red']});
 assert.deepEqual(after.items.map(i=>i.id),['red','green','new']);
 assert.deepEqual(after.selected.map(i=>i.id),['red','green']);
 assert.deepEqual(after.bestByItem.map(i=>i.id),['red','green']);
 assert.equal(after.bestMapId,before.bestMapId);assert.deepEqual(c,original);
});

test('ties remain deterministic by map ID, and missing battle classification is reference only',()=>{
 const c=marrowFixture();c.knowledge.maps.push({...c.knowledge.maps[0],id:'twin'});c.catalog.nodes.push({...c.catalog.nodes[0],id:'twin',regionName:'另一境'});
 const p=marrowFarming(c);assert.equal(p.bestTies,2);assert.equal(p.bestMapId,'north');assert.equal(p.bestByItem[0].ties,2);
 c.catalog.nodes.forEach(n=>{n.type='rest';});assert.equal(marrowFarming(c).bestMapId,null);
});

test('read-only marrow API requires session, same origin and CSRF; it never enters the game queue',async()=>{
 const c=Object.assign(new EventEmitter(),marrowFixture());c.planMarrow=p=>marrowFarming(c,p);c.command=()=>assert.fail('cached expectation must not enter game queue');
 const server=await startControlServer(c,{port:0}),base=`http://127.0.0.1:${server.server.address().port}`;
 try{const path=base+'/api/farming/marrow';assert.equal((await fetch(path,{method:'POST'})).status,401);
  const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();
  const headers={Cookie:cookie,Origin:base,'X-CSRF-Token':token,'Content-Type':'application/json'};
  assert.equal((await fetch(path,{method:'POST',headers:{...headers,Origin:'http://foreign.test'},body:'{}'})).status,403);
  assert.equal((await fetch(path,{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:'{}'})).status,403);
  assert.equal((await fetch(path,{method:'POST',headers,body:'{"itemIds":["other"]}'})).status,400);
  const r=await fetch(path,{method:'POST',headers,body:'{"itemIds":["green"]}'});assert.equal(r.status,200);assert.equal((await r.json()).bestMapId,'south');
 }finally{await server.close();}
});
