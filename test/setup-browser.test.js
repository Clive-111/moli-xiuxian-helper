import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {BattleUI} from '../src/battle-ui.js';
import {SetupControl} from '../src/setup-control.js';
import {startControlServer} from '../src/control-server.js';
let browser;
before(async()=>{browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});});
after(async()=>{await browser?.close();});
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
