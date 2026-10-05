import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {materialFarming,recommendMaps} from '../src/farming.js';
import {startControlServer} from '../src/control-server.js';
import {materialFixture} from './helpers/material-fixture.js';

test('each material ranks its own yields, sharing encounter, multiplier and drop-roll rules',()=>{
  const c=materialFixture(),before=structuredClone(c),p=materialFarming(c);
  const red=p.items.find(i=>i.id==='red'),green=p.items.find(i=>i.id==='green');
  assert.equal(red.best.mapId,'north');assert.equal(red.best.expected,6.5);
  assert.equal(green.best.mapId,'south');assert.equal(green.best.expected,3);
  const maps=recommendMaps(c.knowledge,c.bestiary,c.catalog,p.items.map(i=>({itemId:i.id,name:i.name,quantity:1})));
  for(const map of p.maps)for(const output of map.outputs)assert.equal(output.expected,maps.find(m=>m.id===map.id).outputs.find(o=>o.itemId===output.itemId).expected);
  assert.deepEqual(c,before);assert.equal(p.items.length,5);assert.ok(!p.items.some(i=>['equipment','marrow'].includes(i.id)));
  const proof=p.maps.find(m=>m.id==='north').outputs.find(o=>o.itemId==='red').enemies.find(e=>e.id==='a').loot;
  assert.equal(proof.length,3);assert.equal(proof[0].extraChance,.2);assert.equal(proof[2].ignoreLuck,true);
});

test('no direct drop, crafted materials and unencountered sources are distinct, not zero-probability claims',()=>{
  const p=materialFarming(materialFixture());
  assert.match(p.items.find(i=>i.id==='crafted').reason,/可通过炼制/u);
  assert.match(p.items.find(i=>i.id==='hidden').reason,/当前图鉴/u);
  assert.match(p.items.find(i=>i.id==='other').reason,/没有直接掉落/u);
  for(const id of ['crafted','hidden','other'])assert.equal(p.items.find(i=>i.id===id).best,null);
});

test('locked, unverified, challenge, unknown-enemy and mismatched-version maps cannot win',()=>{
  const c=materialFixture(),p=materialFarming(c);
  assert.ok(p.maps.filter(m=>['locked','challenge'].includes(m.id)).every(m=>!m.eligible));
  c.catalog.nodes.forEach(n=>n.availability='unverified');assert.ok(materialFarming(c).items.every(i=>!i.best));
  c.catalog.nodes.forEach(n=>n.availability='visible');c.bestiary.entries=[{id:'a'}];assert.ok(materialFarming(c).items.every(i=>!i.best));
  c.bestiary.entries=[{id:'a'},{id:'b'}];c.catalog.resourceUrl='old';const stale=materialFarming(c);assert.equal(stale.stale,true);assert.ok(stale.items.every(i=>!i.best));
  assert.match(stale.warnings.join(''),/版本/u);
});

test('tied maps, same-name regions/items and future materials are keyed by ID',()=>{
  const c=materialFixture();c.knowledge.maps.push({...c.knowledge.maps[0],id:'twin'});c.catalog.nodes.push({...c.catalog.nodes[0],id:'twin',regionName:'另一境'});
  c.knowledge.items.push({id:'future',name:'赤精料',kind:'part'});c.knowledge.enemies[0].loot.push({itemId:'future',chance:.1});
  const p=materialFarming(c);assert.equal(p.items.find(i=>i.id==='red').ties,2);assert.equal(p.items.find(i=>i.id==='red').best.regionName,'北境');
  assert.equal(p.items.filter(i=>i.name==='赤精料').length,2);assert.ok(p.items.find(i=>i.id==='future').best);
  assert.equal(materialFarming({...c,knowledge:{...c.knowledge,items:[]}}).items.length,0);
  for(const payload of [null,[],{itemIds:['red']}])assert.throws(()=>materialFarming(c,payload));assert.throws(()=>materialFarming({}),/同步图鉴/u);
});

test('material API uses cached evidence with session/CSRF protection and cannot enter the game queue',async()=>{
  const c=Object.assign(new EventEmitter(),materialFixture());c.planMaterials=p=>materialFarming(c,p);c.command=()=>assert.fail('must not operate game');
  const server=await startControlServer(c,{port:0}),base=`http://127.0.0.1:${server.server.address().port}`,url=base+'/api/farming/materials';
  try{
    assert.equal((await fetch(url,{method:'POST'})).status,401);
    const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();
    const headers={Cookie:cookie,Origin:base,'X-CSRF-Token':token,'Content-Type':'application/json'};
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'http://foreign.test'},body:'{}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:'{}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"itemIds":["red"]}'})).status,400);
    const result=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(result.status,200);assert.equal((await result.json()).items.length,5);
  }finally{await server.close();}
});
