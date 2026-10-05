import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request } from 'playwright';
import { GAME_ENTRY } from './catalog.js';

const MAX_BYTES = 2 * 1024 * 1024;
export function imageURL(value) {
  try {
    const url = new URL(value);
    if (url.origin !== new URL(GAME_ENTRY).origin || url.username || url.password || url.search || url.hash
      || !/^\/assets\/art\/(?:icons|enemies)\/[a-z0-9._-]+\.png$/u.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
function validPNG(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_BYTES || buffer.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('图片格式或大小不符合要求');
  return buffer;
}

// Only images observed on the game's item cards may be requested. The HTTP API
// accepts a hash, never a URL or filesystem path. No login cookies are forwarded.
export class LibraryImages {
  constructor(directory, proxy, download) {
    this.directory=directory; this.proxy=proxy; this.download=download;
    this.allowed=new Map(); this.pending=new Map(); this.tail=Promise.resolve();
  }
  register(source) {
    const url=imageURL(source); if (!url) return null;
    const id=createHash('sha256').update(url).digest('hex');
    if (this.allowed.size>=2048 && !this.allowed.has(id)) return null;
    this.allowed.set(id,url); return `/api/library/images/${id}`;
  }
  prepare(value) {
    return {...value,items:value.items.map(item=>({...item,image:this.register(item.imageSource)})),
      equipment:(value.equipment??[]).map(item=>({...item,image:this.register(item.imageSource)})),
      ...(value.detail ? {detail:{...value.detail,image:this.register(value.detail.imageSource)}} : {})};
  }
  async fetch(url) {
    if (this.download) return this.download(url);
    this.context ??= request.newContext({proxy:this.proxy?{server:this.proxy}:undefined,timeout:20000});
    const context=await this.context;
    const response=await context.get(url,{maxRedirects:0});
    try {
      if (!response.ok() || !/^image\/png(?:;|$)/iu.test(response.headers()['content-type']??'') || Number(response.headers()['content-length']??0)>MAX_BYTES) throw new Error('原始图片暂时不可用');
      return await response.body();
    } finally { await response.dispose(); }
  }
  get(id) {
    if (this.closed) return Promise.reject(new Error('图片服务已关闭'));
    if (!/^[a-f0-9]{64}$/u.test(id) || !this.allowed.has(id)) return Promise.reject(new Error('图片不存在'));
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.pending.size>=100) return Promise.reject(new Error('图片正在加载，请稍后再试'));
    // Bound image downloads independently of the game's action queue.
    const result=this.tail.then(async()=>{
      if (this.closed) throw new Error('图片服务已关闭');
      const filename=path.join(this.directory,`${id}.png`);
      try { return validPNG(await readFile(filename)); } catch (error) { if (error.code!=='ENOENT') throw error; }
      const buffer=validPNG(await this.fetch(this.allowed.get(id)));
      await mkdir(this.directory,{recursive:true}); await writeFile(filename,buffer,{mode:0o600}); return buffer;
    });
    this.tail=result.catch(()=>{}); this.pending.set(id,result);
    result.finally(()=>this.pending.delete(id)).catch(()=>{}); return result;
  }
  async close() { this.closed=true; if (this.context) await (await this.context).dispose(); }
}
