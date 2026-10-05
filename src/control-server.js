import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function startControlServer(control, { port = 7081, host = '127.0.0.1' } = {}) {
  const sessions = new Map(), clients = new Set();
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'library.js', 'crafting.js', 'inventory-actions.js', 'bestiary.js', 'marrow-farming.js', 'material-farming.js', 'map-farming.js', 'style.css'].map(async name => [name, await readFile(new URL(`../web/${name}`, import.meta.url))])));
  const push = snapshot => { const event = `data: ${JSON.stringify(snapshot)}\n\n`; for (const res of clients) { if (res.writableLength > 1024 * 1024) { res.end(); clients.delete(res); } else res.write(event); } };
  control.on('change', push);
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const expectedPort = server.address().port;
    if (![ `localhost:${expectedPort}`, `127.0.0.1:${expectedPort}` ].includes(req.headers.host)) return json(403, { error: '只允许本机控制面板地址' });
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); }
    catch { return json(400, { error: '请求地址无效' }); }
    if (url.pathname === '/health' && req.method === 'GET') return json(200, { ok: true });
    const sid = /(?:^|;\s*)battle_session=([a-f0-9]{64})(?:;|$)/u.exec(req.headers.cookie ?? '')?.[1];
    let session = sessions.get(sid);
    if (session?.expires < Date.now()) { sessions.delete(sid); session = null; }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      if (!session) {
        for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
        if (sessions.size >= 64) return json(429, { error: '会话数量过多，请稍后再试' });
        const id = randomBytes(32).toString('hex'); session = { token: randomBytes(32).toString('hex'), expires: Date.now() + 12 * 3600000 }; sessions.set(id, session);
        res.setHeader('Set-Cookie', `battle_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      }
      return json(200, { token: session.token });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!session) return json(401, { error: '会话已过期，请刷新面板' });
      if (req.method === 'GET') {
        if (url.pathname === '/api/setup') return json(200, control.getSetup?.() ?? {bound:true});
        if (url.pathname === '/api/events') {
          if (clients.size >= 32) return json(429, { error: '连接过多' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify(control.snapshot())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
        }
        if (url.pathname === '/api/state') return json(200, control.snapshot());
        if (url.pathname === '/api/catalog') return json(200, control.catalog);
        if (url.pathname === '/api/library') return json(200, control.library);
        if (url.pathname === '/api/bestiary') return json(200, control.getBestiary());
        if (url.pathname === '/api/inventory-actions') return json(200, control.inventoryActions.snapshot());
        if (url.pathname === '/api/crafting') return json(200, control.crafting.snapshot());
        const image=/^\/api\/library\/images\/([a-f0-9]{64})$/u.exec(url.pathname);
        if (image) {
          try {
            const bytes=await control.images.get(image[1]);
            res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length,'Cache-Control':'private, max-age=86400'}); res.end(bytes);
          } catch { json(404,{error:'图片暂时不可用'}); }
          return;
        }
        if (url.pathname === '/api/settings') return json(200, { revision: control.record.revision, settings: control.record.settings });
      }
      if (req.method === 'POST') {
        const token = req.headers['x-csrf-token'] ?? '';
        if (req.headers.origin !== `http://${req.headers.host}` || typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))) return json(403, { error: '同源或会话校验失败，请刷新页面' });
        if (!/^application\/json(?:;|$)/iu.test(req.headers['content-type'] ?? '')) return json(415, { error: '需要 JSON 请求' });
        try {
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 262144) { json(413, { error: '请求过大' }); return; } }
          const payload = JSON.parse(body || '{}');
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400,{error:'请求必须为 JSON 对象'});
          const setup = /^\/api\/setup\/(open-game|detect|bind)$/u.exec(url.pathname)?.[1];
          if (setup) {
            if (!control.getSetup) return json(404,{error:'当前实例不支持首次设置'});
            const job = control.command('setup-'+setup,payload);
            return json(202,{id:job.id,kind:job.kind});
          }
          if (control.getSetup && !control.isBound) return json(409,{error:'请先读取并确认绑定人物'});
          if(url.pathname==='/api/farming/plan')return json(200,control.planFarming(payload));
          if(url.pathname==='/api/farming/marrow')return json(200,control.planMarrow(payload));
          if(url.pathname==='/api/farming/materials')return json(200,control.planMaterials(payload));
          if(url.pathname==='/api/farming/maps')return json(200,control.planMaps(payload));
          const craft=/^\/api\/crafting\/(preview|execute|review|confirm|sync|delete)$/u.exec(url.pathname)?.[1];
          const inventory=/^\/api\/inventory-actions\/(preview|execute|equip|review|continue|cancel)$/u.exec(url.pathname)?.[1];
          const kind = inventory?'inventory-'+inventory:craft?'craft-'+craft:url.pathname === '/api/settings' ? 'settings' : url.pathname === '/api/catalog/refresh' ? 'refresh' : url.pathname === '/api/library/read' ? 'library' : url.pathname === '/api/bestiary/read' ? 'bestiary' : /^\/api\/commands\/(start|stop|resume|restart|open-game|close-game|status|sync)$/u.exec(url.pathname)?.[1];
          if (!kind) return json(404, { error: '接口不存在' });
          const job = control.command(kind, payload); return json(202, { id: job.id, kind: job.kind, ...(job.skipped?{skipped:job.skipped}:{}) });
        } catch (error) { return json(error.statusCode ?? 400, { error: error.message }); }
      }
      return json(404, { error: '接口不存在' });
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (req.method !== 'GET' || !assets.has(name)) return json(404, { error: '页面不存在' });
    res.writeHead(200, { 'Content-Type': name.endsWith('.js')?'text/javascript; charset=utf-8': { 'index.html': 'text/html; charset=utf-8', 'style.css': 'text/css; charset=utf-8' }[name] }); res.end(assets.get(name));
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': keepalive\n\n'); }, 15000);
  return { server, async close() { clearInterval(heartbeat); control.off('change', push); for (const res of clients) res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await control.images?.close(); } };
}
