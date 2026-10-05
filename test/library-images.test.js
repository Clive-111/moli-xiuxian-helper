import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LibraryImages,imageURL} from '../src/library-images.js';
import {GAME_ENTRY} from '../src/catalog.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvS8AAAAASUVORK5CYII=','base64');
test('image allowlist accepts only observed public game PNG art; no arbitrary URLs, traversal, credentials or redirects',()=>{
 assert.equal(imageURL(GAME_ENTRY+'assets/art/icons/test-v1.png'),GAME_ENTRY+'assets/art/icons/test-v1.png');
 for(const value of ['http://127.0.0.1/private','file:///D:/secret',GAME_ENTRY+'assets/art/icons/../secret.png',GAME_ENTRY+'assets/art/icons/a.svg',GAME_ENTRY+'assets/art/icons/a.png?secret=1',GAME_ENTRY.replace('https://','https://user:pass@')+'assets/art/icons/a.png'])assert.equal(imageURL(value),null,value);
});
test('images are downloaded once, coalesced, persisted and reused after restart; unregistered hashes never fetch',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'library-images-'));let count=0;
 const images=new LibraryImages(dir,null,async()=>{count++;return png;});const route=images.register(GAME_ENTRY+'assets/art/icons/item-v1.png'),id=route.split('/').at(-1);
 const [first,second]=await Promise.all([images.get(id),images.get(id)]);assert.deepEqual(first,png);assert.deepEqual(second,png);assert.equal(count,1);assert.deepEqual(await readFile(path.join(dir,id+'.png')),png);
 await assert.rejects(images.get('b'.repeat(64)),/不存在/u);assert.equal(count,1);
 const again=new LibraryImages(dir,null,async()=>{throw new Error('must use cached image');});again.register(GAME_ENTRY+'assets/art/icons/item-v1.png');assert.deepEqual(await again.get(id),png);await images.close();await again.close();
});
test('invalid or excessive image payload is rejected and never cached as art',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'library-images-'));
 const images=new LibraryImages(dir,null,async()=>Buffer.from('<html>Login</html>'));const id=images.register(GAME_ENTRY+'assets/art/icons/item.png').split('/').at(-1);
 await assert.rejects(images.get(id),/图片格式/u);images.download=async()=>Buffer.alloc(3*1024*1024);await assert.rejects(images.get(id),/图片格式/u);await images.close();
});
