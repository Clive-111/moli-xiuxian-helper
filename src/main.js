import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, root } from './config.js';
import { acquireLock, createLogger } from './runtime.js';
import { bypassHttpCache, closeBattlePages } from './browser.js';
import { BattleUI } from './battle-ui.js';
import { SetupControl } from './setup-control.js';
import { startControlServer } from './control-server.js';

try { process.loadEnvFile(path.join(root,'.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node src/main.js [--config 路径]\n启动本地战斗面板；首次登录、绑定人物、选择地图后手动启动挂机。');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--'))) throw new Error('参数无效，请使用 --help。');
const abort = new AbortController();
let context, logger, control, server;
const releases = [];
let closing = false;
const stop = () => { closing = true; abort.abort(); };
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,stop);
try {
  const {config,configPath} = await loadConfig(args[1]);
  releases.push(await acquireLock(config.profilePath));
  releases.push(await acquireLock(config.dataPath));
  logger = await createLogger();
  const {log} = logger;
  log('配置：'+configPath+'；未提供个人配置时使用公开默认值。');
  async function browserContext() {
    if (context) return context;
    await mkdir(config.profilePath,{recursive:true});
    context = await chromium.launchPersistentContext(config.profilePath,{
      channel:config.browserChannel === 'chromium' ? undefined : config.browserChannel,
      headless:false,viewport:{width:1280,height:900},locale:'zh-CN',
      handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,
      ...(config.browserProxyServer ? {proxy:{server:config.browserProxyServer}} : {}),
    });
    context.on('close',() => { if (!closing) { log('浏览器已关闭，停止脚本。'); stop(); } });
    return context;
  }
  control = new SetupControl({
    base:config.battle,runtime:config,directory:config.dataPath,signal:abort.signal,log,
    diagnostics:(ui,reason) => ui?.diagnostics(path.join(logger.directory,'battle'),reason),
    closeGamePage:async ui => { if (context) await closeBattlePages(context,{page:ui?.page,channelUrl:config.battle.channelUrl}); },
    makeUI:async (battle,taskLog,previous,reconnect) => {
      if (previous && !reconnect && !previous.page.isClosed() && !previous.crashed) return previous;
      const browser = await browserContext();
      let page = previous?.page;
      if (!page || page.isClosed() || previous.crashed) {
        await page?.close().catch(()=>{});
        page = browser.pages().find(p => p.url() === battle.channelUrl || p.url() === 'about:blank') ?? await browser.newPage();
        if (process.env.CONTAINER_PROFILE_PATH) await bypassHttpCache(browser,page);
      }
      page.setDefaultTimeout(config.responseTimeoutSeconds * 1000);
      const ui = new BattleUI(page,battle,config,taskLog,abort.signal);
      page.on('crash',() => { ui.crashed = true; });
      return ui;
    },
  });
  server = await startControlServer(control,{port:config.controlPort,host:process.env.CONTAINER_PROFILE_PATH ? '0.0.0.0' : '127.0.0.1'});
  await control.initialize();
  log('控制面板：http://localhost:'+config.controlPort+'；按 Ctrl+C 停止。');
  if (config.browserViewPort) log('浏览器画面：http://localhost:'+config.browserViewPort+'/vnc.html');
  await new Promise(resolve => { if (abort.signal.aborted) resolve(); else abort.signal.addEventListener('abort',resolve,{once:true}); });
} catch (error) {
  (logger?.log ?? console.error)(error.code === 'EADDRINUSE' ? '面板端口已被占用，请修改 CONTROL_PORT；不会关闭其他进程。' : '启动失败：'+error.message);
  process.exitCode = 1;
} finally {
  closing = true; abort.abort(); control?.close();
  await context?.close().catch(()=>{});
  await control?.tail;
  // A pending first launch may have finished after the first close attempt.
  await context?.close().catch(()=>{});
  await server?.close();
  await control?.images.close();
  for (const release of releases.reverse()) await release();
  logger?.log('脚本已停止。'); await logger?.flush();
  for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.removeListener(signal,stop);
}
