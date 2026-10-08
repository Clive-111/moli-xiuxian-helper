import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { fetchGameResource, parseCatalog } from './catalog.js';

const key = p => p?.computed ? null : p?.key?.name ?? p?.key?.value;
const properties = n => new Map((n?.properties ?? []).filter(p=>p.type==='Property').map(p=>[key(p),p.value]));
function walk(n, fn) { if(!n||typeof n!=='object')return; if(n.type)fn(n); for(const v of Object.values(n))if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn); }
const has = (n, names) => names.every(x=>properties(n).has(x));
const unsafe = value => ['__proto__','prototype','constructor'].includes(String(value));

// A bounded AST data projector, not a JavaScript runtime. No eval, imports,
// arbitrary methods, statements, browser globals or downloaded code execution.
// Only literal data, expression-only data constructors and finite array tables
// are supported. Assignments are collected as new item records, never executed.
export function parseKnowledge(source, resourceUrl='') {
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}), declarations=new Map(), cache=new Map(), resolving=new Set();
  for(const statement of ast.body)if(statement.type==='VariableDeclaration')for(const d of statement.declarations)if(d.id.type==='Identifier')declarations.set(d.id.name,d.init);
  let budget=500000;
  const generated=[];
  function bind(pattern,value,env){
    if(pattern.type==='Identifier')env.set(pattern.name,value);
    else if(pattern.type==='AssignmentPattern')bind(pattern.left,value===undefined?read(pattern.right,env):value,env);
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach((p,i)=>p&&bind(p,value?.[i],env));
    else if(pattern.type==='ObjectPattern')pattern.properties.forEach(p=>bind(p.value,value?.[key(p)],env));
    else throw new Error('不支持的数据参数');
  }
  function resolve(name){
    if(cache.has(name))return cache.get(name);
    if(resolving.has(name)||!declarations.has(name))throw new Error('无法解析数据引用');
    resolving.add(name);try{const value=read(declarations.get(name));cache.set(name,value);return value;}finally{resolving.delete(name);}
  }
  function arrow(fn,args,env){
    if(fn?.type!=='ArrowFunctionExpression')throw new Error('仅支持静态数据构造式');
    const local=new Map(env);fn.params.forEach((p,i)=>bind(p,args[i],local));
    if(fn.body.type!=='BlockStatement')return read(fn.body,local);
    for(const st of fn.body.body){
      if(st.type==='VariableDeclaration')for(const d of st.declarations)bind(d.id,read(d.init,local),local);
      else if(st.type==='ReturnStatement')return read(st.argument,local);
      else throw new Error('不支持的数据构造语句');
    }
  }
  function read(n,env=new Map()){
    if(!n||--budget<0)throw new Error('静态解析超出限制');
    if(n.type==='Literal')return n.value;
    if(n.type==='Identifier')return env.has(n.name)?env.get(n.name):resolve(n.name);
    if(n.type==='ArrowFunctionExpression')return n;
    if(n.type==='UnaryExpression'&&['!','-','+'].includes(n.operator)){const v=read(n.argument,env);return n.operator==='!'?!v:n.operator==='-'?-v:+v;}
    if(n.type==='ArrayExpression')return n.elements.flatMap(e=>e?.type==='SpreadElement'?read(e.argument,env):[read(e,env)]);
    if(n.type==='ObjectExpression'){
      const result=Object.create(null);
      for(const p of n.properties){
        if(p.type==='SpreadElement'){Object.assign(result,read(p.argument,env));continue;}
        const k=p.computed?read(p.key,env):key(p);if(unsafe(k))throw new Error('无效数据键');
        // Unrelated descriptive/economic fields may be dynamic. Required fields
        // are checked explicitly below before a snapshot is accepted.
        try{result[k]=read(p.value,env);}catch{result[k]=undefined;}
      }return result;
    }
    if(n.type==='MemberExpression'){const object=read(n.object,env),k=n.computed?read(n.property,env):n.property.name;if(unsafe(k))throw new Error('未知数据字段');return Object.hasOwn(object??{},k)?object[k]:undefined;}
    if(n.type==='TemplateLiteral')return n.quasis.map((q,i)=>q.value.cooked+(n.expressions[i]?String(read(n.expressions[i],env)):'')).join('');
    if(n.type==='LogicalExpression'){const a=read(n.left,env);return n.operator==='??'?(a??read(n.right,env)):n.operator==='||'?(a||read(n.right,env)):(a&&read(n.right,env));}
    if(n.type==='BinaryExpression'&&['+','-','*','/'].includes(n.operator)){const a=read(n.left,env),b=read(n.right,env);return n.operator==='+'?a+b:n.operator==='-'?a-b:n.operator==='*'?a*b:a/b;}
    if(n.type==='SequenceExpression'){let result;for(const x of n.expressions)result=read(x,env);return result;}
    if(n.type==='AssignmentExpression'&&n.operator==='='){
      if(n.right.type==='ObjectExpression'&&has(n.right,['name','kind'])&&n.left.type==='MemberExpression'&&n.left.computed){const id=read(n.left.property,env),value=read(n.right,env);generated.push({id,...value});return value;}
      return undefined; // Descriptive property assignments have no effect.
    }
    if(n.type==='CallExpression'){
      if(n.callee.type==='Identifier'){
        const args=n.arguments.map(a=>read(a,env));
        if(n.callee.name==='String')return String(args[0]);if(n.callee.name==='Number')return Number(args[0]);
        return arrow(env.get(n.callee.name)??declarations.get(n.callee.name),args,env);
      }
      if(n.callee.type==='MemberExpression'&&!n.callee.computed){
        const method=n.callee.property.name;
        if(n.callee.object.type==='Identifier'&&n.callee.object.name==='Array'&&method==='from'){
          // Project finite repeated rows, including separate rolls of the same
          // drop. Never invoke a downloaded callback or an arbitrary iterator.
          if(declarations.has('Array')||env.has('Array')||n.arguments.length!==2||n.arguments[1]?.type!=='ArrowFunctionExpression')throw new Error('不支持的重复数据构造式');
          const shape=read(n.arguments[0],env);
          if(!shape||typeof shape!=='object'||Array.isArray(shape)||Object.keys(shape).length!==1||!Object.hasOwn(shape,'length')||!Number.isSafeInteger(shape.length)||shape.length<0||shape.length>3000)throw new Error('重复数据表长度无效');
          return Array.from({length:shape.length},(_,i)=>arrow(n.arguments[1],[undefined,i],env));
        }
        if(n.callee.object.name==='Object'&&['freeze','fromEntries'].includes(method)){const value=read(n.arguments[0],env);return method==='freeze'?value:Object.fromEntries(value);}
        if(['map','flatMap'].includes(method)){const list=read(n.callee.object,env);if(!Array.isArray(list)||list.length>3000)throw new Error('数据表过大');const results=list.map((v,i)=>arrow(n.arguments[0],[v,i],env));return method==='flatMap'?results.flat():results;}
      }
    }
    throw new Error(`不支持的静态结构 ${n.type}`);
  }
  function unique(predicate,label){const found=[...declarations].filter(([,n])=>n && predicate(n));if(found.length!==1)throw new Error(`${label}定义无法唯一识别（${found.length}）`);return found[0];}
  const [itemSymbol]=unique(n=>n.type==='ObjectExpression'&&n.properties.filter(p=>p.type==='Property'&&has(p.value,['name','kind','slot'])).length>2,'物品');
  const [recipeSymbol]=unique(n=>n.type==='ObjectExpression'&&n.properties.filter(p=>has(p.value,['output','materials','difficulty'])).length>2,'配方');
  const [mapSymbol]=unique(n=>n.type==='ObjectExpression'&&n.properties.some(p=>has(p.value,['encounterPools'])),'遭遇地图');
  const [enemySymbol]=unique(n=>{
    if(n.type!=='CallExpression'||n.callee?.object?.name!=='Object'||n.callee?.property?.name!=='fromEntries')return false;
    let found=false;walk(n,x=>{if(x.type==='MemberExpression'&&x.object?.type==='MemberExpression'&&x.object.property?.name==='definition'&&x.property?.name==='id')found=true;});return found;
  },'敌人');
  const itemData=resolve(itemSymbol),enemyData=resolve(enemySymbol),mapData=resolve(mapSymbol),recipeData=resolve(recipeSymbol);
  const unresolved=(value,fields)=>fields.some(field=>Object.hasOwn(value,field)&&value[field]===undefined);
  if(Object.values(mapData).some(m=>unresolved(m,['groups','groupSize','randomGroupSize','enemyMultiplier','challenge','encounterPools']))||Object.values(recipeData).some(r=>unresolved(r,['outputCount','path'])||!['ordinary','component'].includes(r.path))||Object.values(enemyData).some(e=>e.loot?.some(l=>unresolved(l,['ignoreLuck','chance','itemId']))))throw new Error('关键数据结构发生变化，保留旧数据');
  // New armor families use nested finite tables, local ID fragments and push
  // calls. Project their item records, never execute the pushes/game code.
  const isGeneratedItem=n=>n.type==='AssignmentExpression'&&n.operator==='='&&n.left?.object?.name===itemSymbol
    && has(n.right,['name','kind']) && (has(n.right,['blade','hilt'])||has(n.right,['interior','exterior']));
  const containsGeneratedItem=n=>{let found=false;walk(n,x=>{if(isGeneratedItem(x))found=true;});return found;};
  let tableRows=0;
  function projectTable(n,env=new Map()){
    if(n.type==='BlockStatement'){const local=new Map(env);for(const st of n.body)projectTable(st,local);}
    else if(n.type==='ForOfStatement'){
      const list=read(n.right,env),pattern=n.left?.declarations?.[0]?.id;
      if(!Array.isArray(list)||list.length>1000||!pattern)throw new Error('器物表无效');
      for(const row of list){if(++tableRows>10000)throw new Error('器物表超出限制');const local=new Map(env);bind(pattern,row,local);projectTable(n.body,local);}
    }else if(n.type==='VariableDeclaration'){
      for(const d of n.declarations){let value;try{value=read(d.init,env);}catch{/* Ignore unsupported economic calculations; required fields are validated below. */}bind(d.id,value,env);}
    }else if(n.type==='ExpressionStatement')projectTable(n.expression,env);
    else if(n.type==='SequenceExpression')for(const expression of n.expressions)projectTable(expression,env);
    else if(isGeneratedItem(n))read(n,env);
    else if(containsGeneratedItem(n))throw new Error('器物表包含不支持的条件结构');
  }
  for(const st of ast.body)if(st.type==='ForOfStatement'&&containsGeneratedItem(st))projectTable(st);
  // Armor tables have explicit interior/exterior/output return records.
  const armorTables=[];
  for(const [symbol,n] of declarations){let armor=false;walk(n,x=>{if(has(x,['interior','exterior','output']))armor=true;});if(armor)armorTables.push(...resolve(symbol));}
  for(const item of generated){if(typeof item.id!=='string'||!item.name)throw new Error('生成器物无法识别');itemData[item.id]=item;}
  if(Object.values(itemData).some(x=>unresolved(x,['name','kind','slot','blade','hilt','interior','exterior'])))throw new Error('器物材料或部位定义不完整');
  const items=Object.entries(itemData).map(([id,x])=>({id,name:x.name,kind:x.kind,slot:x.slot,description:x.description??'',...(x.kind==='marrow'?{marrowValue:x.marrowValue}:{})}));
  if(items.some(x=>!x.name||!x.kind))throw new Error('物品名称或类型不完整');
  const recipes=Object.entries(recipeData).map(([id,x])=>({id,name:x.name,output:x.output,outputCount:x.outputCount??1,materials:x.materials,type:x.path==='component'?'精炼':'普通炼制',difficulty:x.difficulty}));
  for(const [id,x] of Object.entries(itemData))if(x.blade&&x.hilt)recipes.push({id:'assemble:'+id,name:x.name,output:id,outputCount:1,materials:{[x.blade]:1,[x.hilt]:1},type:'兵刃合炼'});
  const armorByOutput=new Map();
  for(const x of [...armorTables,...Object.entries(itemData).filter(([,x])=>x.interior&&x.exterior).map(([output,x])=>({output,interior:x.interior,exterior:x.exterior}))]){
    const old=armorByOutput.get(x.output);
    if(old&&(old.interior!==x.interior||old.exterior!==x.exterior))throw new Error('防具升炼关系冲突');
    armorByOutput.set(x.output,x);
  }
  for(const x of armorByOutput.values())recipes.push({id:'upgrade:'+x.output,name:itemData[x.output]?.name,output:x.output,outputCount:1,materials:{[x.interior]:1,[x.exterior]:1},type:'防具升炼'});
  const ids=new Set(items.map(x=>x.id));
  if(recipes.some(r=>!r.name||!ids.has(r.output)||!Number.isSafeInteger(r.outputCount)||r.outputCount<1||!r.materials||Object.entries(r.materials).some(([id,n])=>!ids.has(id)||!Number.isSafeInteger(n)||n<1)))throw new Error('配方关系不完整');
  const enemies=Object.entries(enemyData).map(([id,x])=>({id,name:x.name,realm:x.realm,realmLabel:x.visibleRealm??'',description:x.description,stats:x.definition?.stats,abilities:x.definition?.abilities??{},loot:x.loot}));
  if(enemies.some(e=>!e.name||!Number.isFinite(e.realm)||!e.stats||['maxHp','attack','defense','agility'].some(k=>!Number.isFinite(Number(e.stats[k])))||!Array.isArray(e.loot)||e.loot.some(l=>!ids.has(l.itemId)||!Number.isFinite(Number(l.chance))||Number(l.chance)<0)))throw new Error('敌人数据不完整');
  const enemyIds=new Set(enemies.map(e=>e.id));
  const maps=Object.entries(mapData).map(([id,x])=>({id,name:x.name,pool:x.pool,groups:x.groups,groupSize:x.groupSize,randomGroupSize:x.randomGroupSize===true,encounterPools:x.encounterPools??{},enemyMultiplier:Number(x.enemyMultiplier??1),challenge:x.challenge===true}));
  if(maps.some(m=>!Array.isArray(m.pool)||!m.pool.length||!Number.isSafeInteger(m.groups)||m.groups<1||m.groups>10000||!Number.isSafeInteger(m.groupSize)||m.groupSize<1||!Number.isFinite(m.enemyMultiplier)||m.enemyMultiplier<0||[m.pool,...Object.values(m.encounterPools)].some(p=>!Array.isArray(p)||!p.length||p.some(id=>!enemyIds.has(id)))))throw new Error('地图遭遇数据不完整');
  return {version:1,revision:createHash('sha256').update(source).digest('hex'),resourceUrl,updatedAt:Date.now(),items,recipes,enemies,maps};
}

export async function fetchKnowledge(proxy){const {source,resourceUrl}=await fetchGameResource(proxy);return parseKnowledge(source,resourceUrl);}

// Both projections must come from the same download: a deployment between two
// independent fetches otherwise leaves the map and loot on different versions.
export function parseGameDefinitions(source, resourceUrl) {
  return {knowledge:parseKnowledge(source,resourceUrl),catalog:parseCatalog(source,resourceUrl)};
}
export async function fetchGameDefinitions(proxy) {
  const {source,resourceUrl}=await fetchGameResource(proxy);
  return parseGameDefinitions(source,resourceUrl);
}
