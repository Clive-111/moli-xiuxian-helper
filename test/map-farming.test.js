import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mapFarming,materialFarming} from '../src/farming.js';
import {startControlServer} from '../src/control-server.js';
import {materialFixture} from './helpers/material-fixture.js';

test('map totals and per-enemy contributions use the same weighted waves and material model',()=>{
  const c=materialFixture(),before=structuredClone(c),p=mapFarming(c),north=p.maps.find(m=>m.id==='north');
  assert.equal(p.maps.length,c.knowledge.maps.length);assert.equal(north.totalEnemies,4);assert.equal(north.unknownCount,0);
  assert.deepEqual(north.enemies.map(e=>[e.id,e.count]),[['a',3],['b',1]]);
  assert.equal(north.enemies[0].loot.find(l=>l.itemId==='red').perKill,1.5);
  assert.equal(north.enemies[0].loot.find(l=>l.itemId==='red').expected,4.5);
  assert.equal(north.outputs.find(o=>o.itemId==='red').expected,6.5);
  for(const map of p.maps){
    const reference=materialFarming(c).maps.find(m=>m.id===map.id);
    for(const row of map.outputs){
      const sum=map.enemies.flatMap(e=>e.loot).filter(l=>l.itemId===row.itemId).reduce((n,l)=>n+l.expected,0);
      assert.ok(Math.abs(sum-row.expected)<1e-9);assert.equal(row.expected,reference.outputs.find(o=>o.itemId===row.itemId).expected);
    }
    assert.equal(map.expectedTotal,map.outputs.reduce((sum,o)=>sum+o.expected,0));
  }
  assert.deepEqual(c,before);
});

test('random group sizes, repeated independent rolls and ignore-luck drops retain correct per-kill evidence',()=>{
  const c=materialFixture();c.knowledge.enemies[1].loot.push({itemId:'red',chance:2,ignoreLuck:true});
  const south=mapFarming(c).maps.find(m=>m.id==='south'),red=south.enemies[0].loot.find(l=>l.itemId==='red');
  assert.equal(south.groupSize,'1–2');assert.equal(south.totalEnemies,3);assert.equal(red.perKill,4);assert.equal(red.expected,12);
  assert.equal(red.rolls[0].rolls,2);assert.equal(red.rolls[0].guaranteed,2);assert.equal(red.rolls[0].ignoreLuck,true);
});

test('every map remains listed: no material drops, unencountered enemies and empty pools are distinguished',()=>{
  const c=materialFixture(),base=c.knowledge.maps[0];
  c.knowledge.enemies.push({...structuredClone(c.knowledge.enemies[0]),id:'empty',name:'护卫',loot:[{itemId:'equipment',chance:1}]});c.bestiary.entries.push({id:'empty'});
  for(const [id,pool] of [['no-drops',['empty']],['partial',['a','unseen']],['no-pool',[]]]){
    c.knowledge.maps.push({...base,id,pool,encounterPools:{}});c.catalog.nodes.push({...c.catalog.nodes[0],id});
  }
  const p=mapFarming(c),empty=p.maps.find(m=>m.id==='no-drops'),partial=p.maps.find(m=>m.id==='partial'),missing=p.maps.find(m=>m.id==='no-pool');
  assert.equal(empty.enemies.length,1);assert.equal(empty.enemies[0].known,true);assert.equal(empty.outputs.length,0);assert.equal(empty.unknown,false);
  assert.equal(partial.unknownCount,2);assert.equal(partial.eligible,false);assert.equal(partial.enemies.find(e=>e.id==='unseen').loot.length,0);
  assert.equal(partial.enemies.find(e=>e.id==='unseen').name,'未遭遇或未识别的怪物');assert.equal(partial.outputs.find(o=>o.itemId==='red').expected,3);
  assert.equal(missing.unknownCount,4);assert.equal(missing.eligible,false);assert.equal(missing.outputs.length,0);
});

test('same-name maps keep regional IDs; locked, challenge, unverified and stale maps are explicit reference data',()=>{
  const c=materialFixture(),p=mapFarming(c);assert.equal(p.maps[0].name,p.maps[1].name);assert.notEqual(p.maps[0].id,p.maps[1].id);assert.notEqual(p.maps[0].regionName,p.maps[1].regionName);
  for(const id of ['locked','challenge'])assert.ok(p.maps.find(m=>m.id===id).reasons.length);
  c.catalog.nodes[0].availability='unverified';assert.equal(mapFarming(c).maps[0].eligible,false);
  c.catalog.resourceUrl='old';const stale=mapFarming(c);assert.equal(stale.stale,true);assert.ok(stale.maps.every(m=>!m.eligible));assert.match(stale.warnings.join(''),/版本/u);
  assert.throws(()=>mapFarming({}),/同步/u);for(const payload of [null,[],{mapId:'north'}])assert.throws(()=>mapFarming(c,payload));
  c.knowledge.maps=[];assert.equal(mapFarming(c).maps.length,0);
});

test('map statistics API reads only caches and retains same-origin/session/CSRF protection',async()=>{
  const c=Object.assign(new EventEmitter(),materialFixture());c.planMaps=p=>mapFarming(c,p);c.command=()=>assert.fail('must not operate game');
  const server=await startControlServer(c,{port:0}),base=`http://127.0.0.1:${server.server.address().port}`,url=base+'/api/farming/maps';
  try{
    assert.equal((await fetch(url,{method:'POST'})).status,401);
    const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();
    const headers={Cookie:cookie,Origin:base,'X-CSRF-Token':token,'Content-Type':'application/json'};
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'http://foreign.test'},body:'{}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:'{}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"mapId":"north"}'})).status,400);
    const result=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(result.status,200);assert.equal((await result.json()).maps.length,4);
  }finally{await server.close();}
});
