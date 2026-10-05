import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {closeBattlePages} from '../src/browser.js';

let browser,server,origin;const pings={};
before(async()=>{
  server=createServer((req,res)=>{
    if(req.url.startsWith('/ping/')){pings[req.url]=(pings[req.url]??0)+1;res.end('ok');return;}
    res.setHeader('Content-Type','text/html');res.end('<title>Local game fixture</title><body>fixture</body>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL??'chrome',headless:true});
});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});

test('close disconnects game traffic and owned popups while travel and shared browser stay alive',async()=>{
  const context=await browser.newContext();
  try{
    const travel=await context.newPage(),battle=await context.newPage();
    await travel.goto(origin+'/travel');await battle.goto(origin+'/battle');
    for(const [page,id] of [[travel,'travel'],[battle,'battle']])await page.evaluate(id=>{
      setInterval(()=>fetch('/ping/'+id).catch(()=>{}),25);
    },id);
    const popupReady=context.waitForEvent('page');await battle.evaluate(()=>window.open('/popup'));const popup=await popupReady;await popup.waitForLoadState();
    const claimed=new Set([travel,battle]);await new Promise(r=>setTimeout(r,160));
    assert.ok(pings['/ping/battle']>0);assert.ok(pings['/ping/travel']>0);
    await closeBattlePages(context,{page:battle,channelUrl:origin+'/battle',claimed});
    await new Promise(r=>setTimeout(r,80));const before={...pings};await new Promise(r=>setTimeout(r,180));
    assert.equal(pings['/ping/battle'],before['/ping/battle']);assert.ok(pings['/ping/travel']>before['/ping/travel']);
    assert.equal(battle.isClosed(),true);assert.equal(popup.isClosed(),true);assert.equal(travel.isClosed(),false);
    assert.deepEqual([...claimed],[travel]);assert.equal(browser.isConnected(),true);
    // Reopening creates just a game page; travel's document survives untouched.
    const reopened=await context.newPage();await reopened.goto(origin+'/battle');assert.equal(await travel.title(),'Local game fixture');
  }finally{await context.close();}
});

test('startup cleanup closes matching restored channel without connecting and leaves unrelated pages alone',async()=>{
  const context=await browser.newContext();
  try{
    const travel=await context.newPage(),battle=await context.newPage(),unrelated=await context.newPage();
    await travel.goto(origin+'/travel');await battle.goto(origin+'/battle?restored=1');await unrelated.goto(origin+'/battle-other');
    await closeBattlePages(context,{channelUrl:origin+'/battle'});
    assert.equal(battle.isClosed(),true);assert.equal(travel.isClosed(),false);assert.equal(unrelated.isClosed(),false);
    await closeBattlePages(context,{channelUrl:origin+'/battle'});assert.equal(context.pages().length,2);
  }finally{await context.close();}
});
