import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {atomicJson} from '../src/control-store.js';

const main=fileURLToPath(new URL('../src/main.js',import.meta.url));
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}
function launch(file,port,cwd){
 const env={...process.env,CONTROL_PORT:String(port)};delete env.CONTAINER_PROFILE_PATH;delete env.CONTROL_DATA_DIR;
 const child=spawn(process.execPath,[main,'--config',file],{cwd,env,stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 return {child,get output(){return output;}};
}
test('native entry starts from another directory, without login, and port conflict never stops the first process',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'moli startup ')),port=await freePort(),file=path.join(dir,'config.json');
 const profile=path.join(dir,'profile'),data=path.join(dir,'data');
 await atomicJson(file,{profileDir:profile,dataDir:data});
 const first=launch(file,port,dir);let second;
 const origin='http://127.0.0.1:'+port;
 try{
  const deadline=Date.now()+10000;
  while(!first.output.includes('控制面板：http')){
   if(first.child.exitCode!==null||Date.now()>deadline)throw Error(first.output||'Startup timed out');
   await delay(25);
  }
  assert.equal((await fetch(origin+'/health')).status,200);
  const s=await fetch(origin+'/api/session'),cookie=s.headers.get('set-cookie').split(';')[0];
  const setup=await(await fetch(origin+'/api/setup',{headers:{cookie}})).json();assert.equal(setup.bound,false);
  await assert.rejects(stat(profile),{code:'ENOENT'});await assert.rejects(stat(data),{code:'ENOENT'});
  const other=path.join(dir,'other.json');await atomicJson(other,{profileDir:path.join(dir,'other-profile'),dataDir:path.join(dir,'other-data')});
  second=launch(other,port,dir);const [code]=await once(second.child,'exit');
  assert.equal(code,1);assert.match(second.output,/端口已被占用/u);
  assert.equal((await fetch(origin+'/health')).status,200);
  await assert.rejects(stat(path.join(dir,'other-profile')),{code:'ENOENT'});
 }finally{
  if(second?.child.exitCode===null)second.child.kill();
  if(first.child.exitCode===null){const exited=once(first.child,'exit');first.child.kill();await exited;}
 }
});
