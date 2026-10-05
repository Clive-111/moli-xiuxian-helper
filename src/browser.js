// Keep login storage, but bypass HTTP resource caches that can leave Discord blank.
// Retain the CDP session for the lifetime of this page: detaching resets the override.
export async function bypassHttpCache(context, page) {
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  return session;
}

export function isGamePage(page, channelUrl) {
  if (page.isClosed()) return false;
  try {
    const current=new URL(page.url()),channel=new URL(channelUrl);
    return current.origin===channel.origin && (current.pathname===channel.pathname || current.pathname==='/popout');
  } catch { return false; }
}

// Closing one game must never close the shared context or the travel page.
// Also dispose any game-owned popups, including pages restored at startup.
export async function closeBattlePages(context, { page, channelUrl, claimed = new Set() }) {
  const pages=context.pages(), targets=new Set(pages.filter(p=>p===page||p.url().split(/[?#]/u)[0]===channelUrl));
  for(let changed=true;changed;){
    changed=false;
    for(const candidate of pages)if(!targets.has(candidate)&&targets.has(await candidate.opener())){targets.add(candidate);changed=true;}
  }
  for(const target of [...targets].reverse()){
    if(!target.isClosed())await target.close({runBeforeUnload:false});
    claimed.delete(target);
  }
  if([...targets].some(target=>!target.isClosed()))throw new Error('战斗游戏页面尚未关闭，请重试');
}
