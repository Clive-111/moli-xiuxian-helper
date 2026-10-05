import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBattle } from './battle-config.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function normalizeChannelUrl(value) {
  const url = typeof value === 'string' ? value.trim().replace(/\/$/u, '') : '';
  if (!/^https:\/\/discord\.com\/channels\/\d+\/\d+$/u.test(url)) throw new Error('请输入完整的 Discord 服务器频道 URL。');
  return url;
}
function port(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(label+' 必须为 1024–65535 的整数端口。');
  return n;
}
export async function loadConfig(filename = 'config.json', env = process.env) {
  const defaults = JSON.parse(await readFile(path.join(root, 'config.example.json'), 'utf8'));
  const configPath = path.resolve(root, filename);
  let custom = {};
  try { custom = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/u, '')); }
  catch (error) { if (error.code !== 'ENOENT' || filename !== 'config.json') throw error; }
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) throw new Error('配置必须是 JSON 对象。');
  const config = { ...defaults, ...custom };
  config.battle = validateBattle({ ...defaults.battle, ...custom.battle });
  // Character and targets are owned by the panel, never imported from a personal config.
  if (custom.battle && ['characterName','target','healingTarget','consumables','enabled'].some(k => Object.hasOwn(custom.battle,k))) throw new Error('人物和目标请在面板绑定和设置；不要导入旧的个人 battle 配置。');
  config.battle = { ...config.battle, enabled: false, characterName: '', target: null, healingTarget: null, consumables: {enabled:false,itemNames:[],intervalMinutes:10,quantity:'all'} };
  config.browserChannel = env.CONTAINER_PROFILE_PATH ? 'chromium' : config.browserChannel;
  if (!['chrome','msedge','chromium'].includes(config.browserChannel)) throw new Error('browserChannel 应为 chrome、msedge 或 chromium。');
  config.browserProxyServer = env.BROWSER_PROXY_SERVER ?? config.browserProxyServer;
  if (config.browserProxyServer) {
    const proxy = new URL(config.browserProxyServer);
    if (!['http:','https:','socks5:'].includes(proxy.protocol) || proxy.username || proxy.password) throw new Error('代理必须为不含账号密码的 http、https 或 socks5 地址。');
  } else if (config.browserProxyServer != null && config.browserProxyServer !== '') throw new Error('代理必须为地址字符串或 null。');
  for (const key of ['profileDir','dataDir']) if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(key+' 不能为空。');
  config.profilePath = path.resolve(root, env.CONTAINER_PROFILE_PATH ?? config.profileDir);
  config.dataPath = path.resolve(root, env.CONTROL_DATA_DIR ?? config.dataDir);
  config.controlPort = port(env.CONTROL_PORT ?? config.controlPort, 'CONTROL_PORT');
  config.browserViewPort = env.CONTAINER_PROFILE_PATH ? port(env.VNC_PORT ?? 7080, 'VNC_PORT') : null;
  for (const key of ['responseTimeoutSeconds','recoveryIntervalSeconds','actionDelaySeconds']) if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(key+' 必须大于 0。');
  if (!Array.isArray(config.retrySeconds) || !config.retrySeconds.length || config.retrySeconds.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('retrySeconds 必须为正数数组。');
  return {config,configPath};
}
