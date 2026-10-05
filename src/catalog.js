import { parse } from 'acorn';
import { request } from 'playwright';
import { orderMarrows } from './marrow-order.js';

export const GAME_ENTRY = 'https://1551954275754573874.discordsays.com/';
const propName = p => p?.computed ? null : p?.key?.name ?? p?.key?.value;
const fields = n => new Map((n?.properties ?? []).filter(p => p.type === 'Property').map(p => [propName(p), p.value]));
function literal(n) {
  if (n?.type === 'Literal') return n.value;
  if (n?.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal') return !n.argument.value;
  return undefined;
}
function walk(n, visit) {
  if (!n || typeof n !== 'object') return;
  if (n.type) visit(n);
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
// Only inspect AST literals and known data shapes. Never eval/import remote code.
export function parseCatalog(source, resourceUrl = '') {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const regionSets = [], definitions = new Map(), items = new Map(), shopDefinitions = [];
  walk(ast, n => {
    if (n.type === 'ArrayExpression' && n.elements.length > 1 && n.elements.every(e => {
      const f = fields(e);
      return typeof literal(f.get('id')) === 'string' && typeof literal(f.get('name')) === 'string'
        && f.get('locations')?.type === 'ArrayExpression' && f.get('locations').elements.every(x => typeof literal(x) === 'string');
    })) regionSets.push(n.elements.map(e => {
      const f = fields(e); return { id: literal(f.get('id')), name: literal(f.get('name')), locationIds: f.get('locations').elements.map(literal) };
    }));
    if (n.type !== 'Property' || n.value?.type !== 'ObjectExpression') return;
    const id = propName(n), f = fields(n.value), name = literal(f.get('name'));
    if (typeof name === 'string' && typeof literal(f.get('locationId')) === 'string' && f.has('stock') && f.has('stateKey')) {
      shopDefinitions.push({id,name,locationId:literal(f.get('locationId')),prerequisiteId:literal(f.get('prerequisite'))??null});
    }
    if (literal(f.get('kind')) === 'marrow' && typeof name === 'string') items.set(id, { id, name, marrowValue: literal(f.get('marrowValue')) });
    const spread = n.value.properties.find(p => p.type === 'SpreadElement' && p.argument.type === 'CallExpression'
      && typeof literal(p.argument.arguments[0]) === 'string' && typeof literal(p.argument.arguments[1]) === 'string');
    if (typeof name === 'string' && f.has('prerequisite') || spread) {
      const node = { id, name: name ?? literal(spread.argument.arguments[0]), type: spread ? literal(f.get('challenge')) === true ? 'challenge' : 'battle' : literal(f.get('meditation')) === true ? 'healing' : 'rest' };
      const list = definitions.get(id) ?? []; list.push(node); definitions.set(id, list);
    }
  });
  if (regionSets.length !== 1) throw new Error(`地图区域定义无法唯一识别（${regionSets.length}）`);
  const regions = regionSets[0], nodes = [];
  for (const region of regions) for (const id of region.locationIds) {
    const matches = definitions.get(id) ?? [];
    // The starting village may omit a prerequisite. Resolve it by its exact map key.
    if (!matches.length) walk(ast, n => {
      if (n.type !== 'Property' || propName(n) !== id || n.value?.type !== 'ObjectExpression') return;
      const f = fields(n.value), name = literal(f.get('name'));
      if (typeof name === 'string' && f.has('meditation')) matches.push({ id, name, type: literal(f.get('meditation')) === true ? 'healing' : 'rest' });
    });
    if (matches.length !== 1) throw new Error(`地点 ${id} 定义缺失或重名（${matches.length}），保留原目录`);
    nodes.push({ ...matches[0], regionId: region.id, regionName: region.name, availability: 'unverified' });
  }
  if (new Set(regions.map(r => r.id)).size !== regions.length || new Set(nodes.map(n => n.id)).size !== nodes.length || !nodes.some(n => n.type === 'battle') || !nodes.some(n => n.type === 'healing') || !items.size) throw new Error('目录不完整，保留原目录');
  const shops=shopDefinitions.map(shop=>{
    const node=nodes.find(n=>n.id===shop.locationId);
    if(!node||!['healing','rest'].includes(node.type))throw new Error(`商店 ${shop.name} 的安全地点无法核实`);
    return {...shop,regionName:node.regionName,locationName:node.name,prerequisiteName:nodes.find(n=>n.id===shop.prerequisiteId)?.name??null};
  });
  if(new Set(shops.map(s=>s.id)).size!==shops.length)throw new Error('商店目录重名，保留旧目录');
  return { version: 1, resourceUrl, updatedAt: Date.now(), regions, nodes, shops, items: orderMarrows([...items.values()]) };
}

export const DEFAULT_SALE_TARGET=null;
export function saleShop(catalog,target){
  const matches=catalog?.shops?.filter(s=>s.regionName===target?.regionName&&s.locationName===target?.locationName&&s.name===target?.shopName)??[];
  if(matches.length!==1)throw new Error('卖出商店尚未核实或不唯一，请刷新目录并选择商店');
  return matches[0];
}
export async function fetchGameResource(proxyServer) {
  const client = await request.newContext({ ...(proxyServer ? { proxy: { server: proxyServer } } : {}), timeout: 45000 });
  try {
    const get = async url => {
      const response = await client.get(url);
      if (!response.ok()) throw new Error(`游戏目录下载失败：HTTP ${response.status()}`);
      const body = await response.body();
      if (body.length > 30 * 1024 * 1024) throw new Error('资源过大，停止解析');
      return body.toString('utf8');
    };
    const html = await get(GAME_ENTRY);
    const paths = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/gu)].map(m => new URL(m[1], GAME_ENTRY));
    const candidates = paths.filter(url => url.origin === new URL(GAME_ENTRY).origin && url.pathname.startsWith('/assets/'));
    if (candidates.length !== 1) throw new Error('游戏入口资源不能唯一识别，保留原目录');
    return {source:await get(candidates[0].href),resourceUrl:candidates[0].href};
  } finally { await client.dispose(); }
}
export async function fetchCatalog(proxyServer) { const {source,resourceUrl}=await fetchGameResource(proxyServer);return parseCatalog(source,resourceUrl); }
export function targetNode(catalog, target, type) {
  const name = type === 'battle' ? target?.stageName : target?.locationName;
  const matches = catalog?.nodes.filter(n => n.regionName === target?.regionName && n.name === name) ?? [];
  if (matches.length !== 1 || matches[0].type !== type) throw new Error(`无法确认${target?.regionName} / ${name}是唯一的${type === 'battle' ? '普通战斗' : '可调息'}地点`);
  return matches[0];
}
