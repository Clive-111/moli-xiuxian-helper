import {spawnSync} from 'node:child_process';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const roots=['src','web','test','docker','scripts','docs'];
const files=['package.json','package-lock.json','config.example.json','.env.example','.gitignore','.gitattributes','.dockerignore','Dockerfile','compose.yaml','start.cmd','install.cmd','docker-setup.cmd','README.md','LICENSE'];
async function walk(relative){
 for(const item of await readdir(path.join(root,relative),{withFileTypes:true})){
  const name=relative+'/'+item.name;
  if(item.isSymbolicLink())throw Error('发布目录不能包含符号链接：'+name);
  if(item.isDirectory())await walk(name);
  else if(/\.(?:js|mjs|json|html|css|md|sh|ps1)$/u.test(name))files.push(name);
  else throw Error('发布目录存在未批准文件：'+name);
 }
}
for(const dir of roots)await walk(dir);
function git(args){const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout||'Git check failed');return r.stdout.trim();}
git(['ls-files','--error-unmatch','--',...files]);
git(['diff','--quiet','HEAD','--',...files]);
const commit=git(['rev-parse','HEAD']);
await mkdir(path.join(root,'outputs'),{recursive:true});
const filename='moli-xiuxian-helper-source.zip';
git(['archive','--format=zip','--prefix=moli-xiuxian-helper/','--output='+path.join(root,'outputs',filename),'HEAD','--',...files]);
const digest=createHash('sha256').update(await readFile(path.join(root,'outputs',filename))).digest('hex');
await writeFile(path.join(root,'outputs',filename+'.sha256'),digest+'  '+filename+'\n');
await writeFile(path.join(root,'outputs','release-manifest.json'),JSON.stringify({commit,archive:filename,sha256:digest,files:files.sort()},null,2)+'\n');
console.log(filename+'\nSHA-256: '+digest+'\nCommit: '+commit);
