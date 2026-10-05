import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {BattleUI} from '../src/battle-ui.js';
import {SetupControl} from '../src/setup-control.js';
import {startControlServer} from '../src/control-server.js';
let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});
test('opening login returns before an App exists and preserves manual login on repeated clicks',async()=>{
 const page=await browser.newPage();let navigations=0,channelRequests=0;
 const fixture=createServer((req,res)=>{
  navigations++;
  if(req.url.includes('/channels/')){channelRequests++;res.end('<h1>Discord APP已开启</h1>');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>登录</h1><input aria-label="账号"><button>登录</button>');
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+fixture.address().port;
 const ui=new BattleUI(page,{channelUrl:origin+'/channels/1/2'},{responseTimeoutSeconds:1},()=>{},new AbortController().signal);
 ui.ensureApp=async()=>{throw Error('Opening login must not launch the game');};
 try{
  await ui.openForLogin();await page.getByRole('heading',{name:'登录'}).waitFor();
  assert.equal(channelRequests,0);assert.equal(new URL(page.url()).pathname,'/login');
  await page.getByRole('textbox',{name:'账号'}).fill('manual-login-in-progress');
  const before=navigations;await ui.openForLogin();
  assert.equal(navigations,before);assert.equal(await page.getByRole('textbox').inputValue(),'manual-login-in-progress');
  await assert.rejects(ui.detectCharacter(),/登录 Discord/u);
 }finally{await page.close();await new Promise(resolve=>fixture.close(resolve));}
});

test('opening web login never clicks a launcher; navigation errors remain retryable',async()=>{
 const page=await browser.newPage();let unavailable=true;
 const fixture=createServer((req,res)=>{
  if(unavailable){req.socket.destroy();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<button onclick="this.textContent=\'clicked\'">打开应用</button>');
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+fixture.address().port+'/channels/1/2';
 const ui=new BattleUI(page,{channelUrl:url},{responseTimeoutSeconds:1},()=>{},new AbortController().signal);
 try{
  const errorPage=page.waitForEvent('framenavigated');
  await assert.rejects(ui.openForLogin(),/网络提示.*代理配置/u);
  await errorPage;
  unavailable=false;await ui.openForLogin();await page.getByRole('button',{name:'打开应用',exact:true}).waitFor();
  assert.equal(page.url(),new URL('/login',url).href);assert.equal(ui.needsNavigate,false);
 }finally{await page.close();await new Promise(resolve=>fixture.close(resolve));}
});
test('desktop-app handoff pauses immediately and the open button recovers to web login',async()=>{
 const page=await browser.newPage();let channelRequests=0;
 const fixture=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url.startsWith('/channels/')){channelRequests++;res.end('<h1>Discord APP已开启</h1><p>您可关闭本浏览器页面。</p>');}
  else res.end('<h1>登录</h1><input aria-label="账号">');
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const channelUrl='http://127.0.0.1:'+fixture.address().port+'/channels/1/2';
 const ui=new BattleUI(page,{channelUrl},{responseTimeoutSeconds:1},()=>{},new AbortController().signal);
 try{
  await page.goto(channelUrl);ui.needsNavigate=false;
  await assert.rejects(ui.detectCharacter(),/尚未进入网页版/u);
  await ui.openForLogin();await page.getByRole('heading',{name:'登录'}).waitFor();
  assert.equal(channelRequests,1);assert.equal(new URL(page.url()).pathname,'/login');
  await page.goto('about:blank');ui.needsNavigate=true;
  await assert.rejects(ui.detectCharacter(),/登录 Discord/u);
  assert.equal(channelRequests,1);assert.equal(new URL(page.url()).pathname,'/login');
 }finally{await page.close();await new Promise(resolve=>fixture.close(resolve));}
});

test('setup panel releases buttons and reports login instructions even when SSE finishes before the HTTP receipt',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'moli-login-panel-'));
 let releaseOpen,releaseReceipt,receiptHeld=false;
 const ui={config:{},openForLogin:()=>new Promise(resolve=>{releaseOpen=resolve;}),async detectCharacter(){throw Error('请在浏览器中登录 Discord。');}};
 const c=new SetupControl({base:{channelUrl:'https://discord.test/channels/1/2',appName:'App'},directory:dir,runtime:{profilePath:dir},makeUI:async()=>ui,log:()=>{},signal:new AbortController().signal});
 await c.initialize();const server=await startControlServer(c,{port:0}),page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/setup/open-game',async route=>{
  const response=await route.fetch();receiptHeld=true;
  await new Promise(resolve=>{releaseReceipt=resolve;});
  await route.fulfill({response});
 });
 try{
  await page.goto('http://127.0.0.1:'+server.server.address().port);
  await page.locator('#setup-card').waitFor({state:'visible'});
  await page.locator('#setup-open').click();
  await page.waitForFunction(()=>document.querySelector('#setup-open').disabled&&document.querySelector('#setup-message').textContent.includes('正在打开'));
  assert.equal(await page.locator('#setup-detect').isDisabled(),true);
  releaseOpen();await c.tail;
  await page.waitForFunction(()=>!document.querySelector('#setup-open').disabled&&document.querySelector('#notice').textContent.includes('手动登录'));
  while(!receiptHeld)await new Promise(resolve=>setTimeout(resolve,10));
  const receipt=page.waitForResponse('**/api/setup/open-game');releaseReceipt();await receipt;
  await page.waitForTimeout(50);
  assert.match(await page.locator('#notice').textContent(),/手动登录/u);
  assert.doesNotMatch(await page.locator('#notice').textContent(),/已排队|已提交/u);
  await page.locator('#setup-detect').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent==='请在浏览器中登录 Discord。');
  assert.equal(await page.locator('#setup-open').isDisabled(),false);
  assert.equal(await page.locator('#setup-bind').isDisabled(),true);
  assert.equal(c.isBound,false);assert.equal(c.record.desired,'stopped');assert.deepEqual(errors,[]);
  await c.handleBrowserClosed();
  await page.waitForFunction(()=>document.querySelector('#setup-message').textContent.includes('面板仍在运行'));
  assert.equal(await page.locator('#setup-open').isDisabled(),false);
  assert.equal(await page.locator('#setup-detect').isDisabled(),true);
  assert.match(await page.locator('#notice').textContent(),/重新打开/u);
 }finally{releaseOpen?.();releaseReceipt?.();c.close();await page.close();await server.close();}
});
test('bootstrap identity detects arbitrary visible full names and rejects hidden, duplicate and blocked identity',async()=>{
 const page=await browser.newPage();
 const ui=new BattleUI(page,{},{actionDelaySeconds:.001,responseTimeoutSeconds:1},()=>{},new AbortController().signal);
 ui.ensureApp=async()=>page.mainFrame();
 try{
  for(const name of ['测试修士','Player One','青松Player🌙','甲·乙']){
   await page.setContent('<aside class="character-panel"><div class="discord-profile"><h3></h3></div></aside><main></main>');
   await page.locator('h3').evaluate((el,value)=>{el.textContent=value;},name);
   assert.equal(await ui.detectCharacter(),name);
  }
  await page.locator('h3').evaluate(el=>el.hidden=true);await assert.rejects(ui.detectCharacter(),/无法唯一/u);
  await page.locator('h3').evaluate(el=>{el.hidden=false;el.after(el.cloneNode(true));});await assert.rejects(ui.detectCharacter(),/无法唯一/u);
  await page.setContent('<aside class="character-panel"><div class="discord-profile"><h3>测试修士</h3></div></aside><main></main><div role="dialog">存档冲突</div>');
  await assert.rejects(ui.detectCharacter(),/弹窗/u);
 }finally{await page.close();}
});
test('fresh panel completes read and confirm, renders empty settings on desktop/mobile without JS errors',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'moli-panel-'));
 const ui={config:{},async ensureApp(){},async detectCharacter(){return '新玩家🌙';}};
 const c=new SetupControl({base:{channelUrl:'https://discord.com/channels/1/2',appName:'App'},directory:dir,runtime:{profilePath:dir},makeUI:async()=>ui,log:()=>{},signal:new AbortController().signal});
 c.syncAll=async()=>({}); // This fixture tests onboarding layout, not game lists.
 await c.initialize();const server=await startControlServer(c,{port:0}),page=await browser.newPage({viewport:{width:1360,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto('http://127.0.0.1:'+server.server.address().port);
  await page.locator('#setup-card').waitFor({state:'visible'});
  assert.equal(await page.locator('#setup-bind').isDisabled(),true);
  assert.equal(await page.locator('#library').isVisible(),false);
  await page.screenshot({path:path.join(dir,'onboarding-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'2. 读取人物',exact:true}).click();
  await page.getByText('新玩家🌙',{exact:true}).waitFor();
  await page.getByRole('button',{name:'3. 确认绑定此人物',exact:true}).click();
  await page.locator('#setup-card').waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-command="start"]').isDisabled(),true);
  assert.equal(await page.locator('#items input:checked').count(),0);
  assert.match(await page.locator('#active-battle').textContent(),/尚未选择/u);
  assert.equal(await page.locator('#battle-stage option:checked').textContent(),'请先选择区域');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(dir,'onboarding-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{c.close();await page.close();await server.close();}
});
