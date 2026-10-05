import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SetupControl } from '../src/setup-control.js';
import { initialSettings, validateSettings } from '../src/battle-control.js';
import { atomicJson } from '../src/control-store.js';
import { loadConfig } from '../src/config.js';
import { startControlServer } from '../src/control-server.js';

const base={channelUrl:'https://discord.com/channels/1/2',appName:'测试App',enabled:false,target:null,consumables:{enabled:false,itemNames:[]}};
const catalog={version:1,regions:[{id:'n',name:'新区域'}],nodes:[{id:'a',regionName:'新区域',name:'起点',type:'battle',availability:'visible'}],items:[],shops:[]};
async function harness(options={}) {
 const directory=options.directory??await mkdtemp(path.join(os.tmpdir(),'moli-setup-'));
 let name='青松Player🌙',reads=0,opens=0;
 const ui={config:{},async detectCharacter(){reads++;if(options.error)throw Error(options.error);return name;},async openForLogin(){opens++;},async ensureApp(){throw Error('首次打开不能等待游戏启动器');},async inspectCatalog(value){return value;},async observe(){return {character:name,mode:'rest',health:{current:'100',maximum:'100'},view:{dialogs:[],activeTab:'游历'},heal:{running:false}};}};
 const params={base:{...base,...options.base},directory,runtime:{profilePath:path.join(directory,'browser'),retrySeconds:[10],recoveryIntervalSeconds:300},signal:new AbortController().signal,log:()=>{},makeUI:async()=>ui,catalogLoader:async()=>structuredClone(catalog)};
 const control=new SetupControl(params);await control.initialize();
 return {control,directory,params,ui,setName:v=>{name=v;},get reads(){return reads;},get opens(){return opens;}};
}
async function bind(h) {
 assert.equal((await h.control.command('setup-detect').promise).ok,true);
 const result=await h.control.command('setup-bind',{token:h.control.getSetup().candidate.token}).promise;
 assert.ok(result.ok,result.error);h.control.close();return result;
}
test('clean start does not open a browser, write character caches or allow game commands',async()=>{
 const h=await harness();try{
  assert.equal(h.control.isBound,false);assert.equal(h.opens,0);assert.equal(h.reads,0);
  assert.equal(h.control.snapshot().settings.target,null);
  assert.deepEqual(await readdir(h.directory),[]);
  for(const kind of ['start','refresh','library','inventory-preview','craft-execute'])assert.throws(()=>h.control.command(kind),/绑定/u);
 }finally{h.control.close();}
});
test('open login releases setup queue without reading identity or waiting for the game launcher',async()=>{
 const h=await harness();try{
  const result=await h.control.command('setup-open-game').promise;
  assert.equal(result.ok,true);assert.equal(h.opens,1);assert.equal(h.reads,0);
  assert.equal(h.control.snapshot().busy,null);assert.equal(h.control.isBound,false);
  assert.match(result.message,/手动登录/u);assert.deepEqual(await readdir(h.directory),[]);
  await h.control.command('setup-detect').promise;
  assert.equal(h.reads,1);assert.match(h.control.reason,/核对完整姓名/u);
 }finally{h.control.close();}
});
test('read then confirm rechecks full name; binding remains stopped, with no preset target or consumables',async()=>{
 const h=await harness();try{
  await bind(h);assert.equal(h.reads,2);assert.equal(h.control.isBound,true);
  assert.equal(h.control.record.desired,'stopped');assert.equal(h.control.record.settings.target,null);
  assert.deepEqual(h.control.record.settings.consumables,{enabled:false,itemNames:[],intervalMinutes:10,quantity:'all'});
  assert.equal(h.control.base.characterName,'青松Player🌙');
  assert.equal((await h.control.command('start').promise).ok,false);
  assert.equal((await h.control.command('refresh').promise).ok,true);
  const settings={...h.control.record.settings,target:{regionName:'新区域',stageName:'起点'}};
  const saved=await h.control.command('settings',{revision:h.control.record.revision,settings}).promise;assert.ok(saved.ok,saved.error);
  assert.equal(h.control.record.desired,'stopped');
  assert.throws(()=>h.control.command('setup-detect'),/已经绑定/u);
 }finally{h.control.close();}
});
test('confirmation rejects changed names, stale tokens and absent candidates without writing identity',async()=>{
 for(const variant of ['changed','token','absent','expired']){
  const h=await harness();try{
   if(variant!=='absent')await h.control.command('setup-detect').promise;
   const token=h.control.candidate?.token;
   if(variant==='changed')h.setName('青松Player🌙2');
   if(variant==='expired')h.control.candidate.at-=300001;
   const result=await h.control.command('setup-bind',{token:variant==='token'?'wrong':token}).promise;
   assert.equal(result.ok,false);assert.equal(h.control.isBound,false);
   await assert.rejects(readFile(path.join(h.directory,'identity.json')),{code:'ENOENT'});
  }finally{h.control.close();}
 }
});
test('binding restart preserves character, null target, intent and ownership; tampering blocks cache loading',async()=>{
 const h=await harness();await bind(h);
 await h.control.command('refresh').promise;
 const next=new SetupControl(h.params);await next.initialize();next.close();
 assert.equal(next.isBound,true);assert.equal(next.record.desired,'stopped');assert.equal(next.record.settings.target,null);
 const identity=JSON.parse(await readFile(path.join(h.directory,'identity.json'),'utf8'));
 await atomicJson(path.join(h.directory,'identity.json'),{...identity,characterName:'另一个人'});
 const wrong=new SetupControl(h.params);await assert.rejects(wrong.initialize(),/归属不符/u);wrong.close();
 await atomicJson(path.join(h.directory,'identity.json'),identity);
 const channel=new SetupControl({...h.params,base:{...base,channelUrl:'https://discord.com/channels/1/3'}});
 await assert.rejects(channel.initialize(),/频道或游戏不符/u);channel.close();
});
test('unbound legacy data is never claimed and public config rejects private character imports',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'moli-old-'));await atomicJson(path.join(dir,'settings.json'),{desired:'running'});
 await assert.rejects(harness({directory:dir}),/未绑定的旧记录/u);
 const file=path.join(dir,'config.json');await atomicJson(file,{battle:{characterName:'旧人物'}});
 await assert.rejects(loadConfig(file,{}),/面板绑定/u);
 const {config}=await loadConfig('config.json',{});
 assert.equal(config.battle.characterName,'');assert.equal(config.battle.target,null);assert.equal(config.controlPort,7081);
 await assert.rejects(loadConfig('config.json',{CONTROL_PORT:'6081bad'}),/端口/u);
});
test('empty targets only pass stopped initialization, and enabled empty consumable lists always fail',()=>{
 const settings=initialSettings(base);assert.doesNotThrow(()=>validateSettings(settings,catalog,{allowEmptyTarget:true}));
 assert.throws(()=>validateSettings(settings,catalog),/战斗目标/u);
 assert.throws(()=>validateSettings({...settings,consumables:{enabled:true,itemNames:[]}},catalog,{allowEmptyTarget:true}),/至少一种/u);
});
test('setup API shares session/CSRF gates; normal mutations reject until bound',async()=>{
 const h=await harness(),server=await startControlServer(h.control,{port:0});
 const origin='http://127.0.0.1:'+server.server.address().port;
 try{
  assert.equal((await fetch(origin+'/api/setup')).status,401);
  const session=await fetch(origin+'/api/session'),{token}=await session.json(),cookie=session.headers.get('set-cookie').split(';')[0];
  const headers={cookie,origin,'Content-Type':'application/json','X-CSRF-Token':token};
  assert.equal((await fetch(origin+'/api/setup',{headers})).status,200);
  assert.equal((await fetch(origin+'/api/commands/start',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(origin+'/api/setup/detect',{method:'POST',headers:{...headers,origin:'http://evil.test'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/api/setup/detect',{method:'POST',headers,body:'{}'})).status,202);
  await h.control.tail;assert.equal(h.reads,1);assert.equal(h.control.isBound,false);
 }finally{h.control.close();await server.close();}
});
