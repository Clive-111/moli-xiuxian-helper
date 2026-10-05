import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {BrowserSession} from '../src/browser-session.js';
import {BattleUI} from '../src/battle-ui.js';
import {SetupControl} from '../src/setup-control.js';
import {startControlServer} from '../src/control-server.js';

test('real persistent browser can close and reopen while the HTTP panel and login storage survive',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'moli-browser-lifecycle-'));
 const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>手动登录页面</h1>');});
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const channelUrl='http://127.0.0.1:'+fixture.address().port+'/channels/1/2';
 let control,launches=0;const errors=[];
 const browser=new BrowserSession(async()=>{
  launches++;return chromium.launchPersistentContext(path.join(directory,'browser'),{channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});
 },()=>control.handleBrowserClosed(),error=>errors.push(error));
 const signal=new AbortController().signal;
 control=new SetupControl({base:{channelUrl,appName:'App'},directory:path.join(directory,'control'),runtime:{profilePath:path.join(directory,'browser')},signal,log:()=>{},makeUI:async()=>{
  const context=await browser.get(),page=context.pages()[0]??await context.newPage();
  return new BattleUI(page,{channelUrl},{responseTimeoutSeconds:1},()=>{},signal);
 }});
 await control.initialize();const server=await startControlServer(control,{port:0});
 const origin='http://127.0.0.1:'+server.server.address().port;
 try{
  assert.equal((await control.command('setup-open-game').promise).ok,true);
  const first=browser.context;await first.pages()[0].waitForLoadState();
  await first.addCookies([{name:'fixture-login',value:'preserved',url:channelUrl,expires:Math.floor(Date.now()/1000)+3600}]);
  await first.close();await control.tail;
  assert.equal(browser.context,null);assert.equal(control.getSetup().browserClosed,true);
  assert.equal((await fetch(origin+'/health')).status,200);assert.equal((await fetch(origin)).status,200);
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0];
  const state=await(await fetch(origin+'/api/state',{headers:{cookie}})).json();
  assert.equal(state.busy,null);assert.equal(state.desired,'stopped');assert.equal(state.setup.bound,false);
  assert.equal(launches,1);await assert.rejects(readFile(path.join(directory,'control','identity.json')),{code:'ENOENT'});
  assert.equal((await control.command('setup-open-game').promise).ok,true);
  assert.equal(launches,2);assert.notEqual(browser.context,first);
  assert.equal((await browser.context.cookies(channelUrl)).find(cookie=>cookie.name==='fixture-login')?.value,'preserved');
  assert.equal(control.getSetup().browserClosed,false);assert.deepEqual(errors,[]);
 }finally{control.close();await browser.close();await server.close();await new Promise(resolve=>fixture.close(resolve));}
});

test('shutdown during browser launch closes the new process and does not report a user disconnection',async()=>{
 let resolveLaunch,closes=0,disconnections=0;
 const browser=new BrowserSession(()=>new Promise(resolve=>{resolveLaunch=resolve;}),()=>{disconnections++;});
 const launching=browser.get(),rejected=assert.rejects(launching,/正在停止/u),closing=browser.close();
 resolveLaunch({async close(){closes++;}});await rejected;await closing;
 assert.equal(closes,1);assert.equal(disconnections,0);
 await assert.rejects(browser.get(),/正在停止/u);
});
