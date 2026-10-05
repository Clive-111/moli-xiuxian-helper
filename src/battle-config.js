import { normalizeChannelUrl } from './config.js';
import { validateConsumables } from './consumables.js';

export function validateBattle(value) {
  if (value == null) return { enabled: false };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('battle 必须为配置对象。');
  const result = { enabled:false, pollIntervalSeconds:1, healActionIntervalSeconds:0.5, actionDelaySeconds:0.3, ...value };
  if (typeof result.enabled !== 'boolean') throw new Error('battle.enabled 必须为布尔值。');
  if (typeof result.appName !== 'string' || !result.appName.trim()) throw new Error('battle.appName 不能为空。');
  result.appName = result.appName.trim();
  result.channelUrl = normalizeChannelUrl(result.channelUrl);
  if (result.characterName != null) {
    if (typeof result.characterName !== 'string') throw new Error('battle.characterName 必须为字符串。');
    result.characterName = result.characterName.trim();
  }
  result.consumables = validateConsumables(value.consumables);
  for (const [field,nameKey] of [['target','stageName'],['healingTarget','locationName']]) {
    if (value[field] == null) continue;
    if (typeof value[field] !== 'object' || Array.isArray(value[field])) throw new Error('battle.'+field+' 必须为地点配置。');
    result[field] = {...value[field]};
    for (const key of ['regionName',nameKey]) {
      if (typeof result[field][key] !== 'string' || !result[field][key].trim()) throw new Error('battle.'+field+'.'+key+' 不能为空。');
      result[field][key] = result[field][key].trim();
    }
  }
  for (const [key,min] of [['pollIntervalSeconds',0.5],['healActionIntervalSeconds',0.5],['actionDelaySeconds',0.1]]) if (!Number.isFinite(result[key]) || result[key] < min) throw new Error('battle.'+key+' 必须至少为 '+min+' 秒。');
  return result;
}
