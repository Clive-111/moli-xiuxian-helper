import { LibraryUI } from './library-ui.js';
import { PauseError } from './errors.js';

export function readBestiaryDOM(){
  const root=document.querySelector('.bestiary-view');if(!root)throw new Error('敌人图鉴尚未加载');
  const text=el=>(el?.innerText??el?.textContent??'').trim();
  const entries=[...root.querySelectorAll('button.bestiary-entry')].map(el=>({name:text(el.querySelector('strong')),summary:text(el.querySelector('small')),
    kills:/击败\s*(.*?)\s*次/u.exec(text(el))?.[1]??'',lootText:text(el.querySelector('.bestiary-entry-loot')),imageSource:el.querySelector('img')?.currentSrc||el.querySelector('img')?.src||null}));
  // The game's responsive CSS hides the eyebrow on narrow desktops. Its DOM
  // counter still describes the encountered list; innerText omits that span.
  const headingText=root.querySelector('.page-heading')?.textContent??root.textContent??'';
  const count=Number(/历世见闻\s*·\s*(\d+)\s*种/u.exec(headingText)?.[1]);
  if(!Number.isInteger(count)||count!==entries.length||entries.some(x=>!x.name)||new Set(entries.map(x=>x.name)).size!==entries.length||entries.length>2000)throw new Error(`图鉴名单待核实：标题 ${count}，列表 ${entries.length}，空名称 ${entries.filter(x=>!x.name).length}，唯一名称 ${new Set(entries.map(x=>x.name)).size}；标题原文 ${text(root.querySelector('.page-heading'))||text(root).slice(0,80)}`);
  return entries;
}
export class BestiaryUI extends LibraryUI {
  async read(){
    const ui=this.ui;let changed=false;
    try{
      const restored=await ui.ensureMonitoringView();if(!restored.ready)throw new PauseError('请先恢复游戏界面，再读取图鉴');
      changed=true;
      const nav=ui.frame.locator('nav.central-nav,nav[aria-label="主导航"]');
      await this.click(nav.getByRole('button',{name:'履历',exact:true}),'查看履历',{browsing:true});
      const entry=ui.frame.getByRole('button',{name:'敌人图鉴',exact:true});await ui.waitFor(()=>entry.isVisible(),'敌人图鉴入口');
      await this.click(entry,'查看敌人图鉴',{browsing:true});
      await ui.waitFor(()=>ui.frame.locator('.bestiary-view').isVisible(),'敌人图鉴列表');await this.verify();
      const search=ui.frame.getByRole('searchbox',{name:'搜索已遭遇敌人或掉落物',exact:true});
      if(await search.count()!==1)throw new Error('无法核实图鉴筛选');
      if(await search.inputValue()){ui.beforeAction?.('清除图鉴搜索');await search.fill('');}
      await this.verify();
      const entries=await ui.frame.evaluate(readBestiaryDOM);
      const resourceUrls=await ui.frame.locator('script[src]').evaluateAll(elements=>elements.map(el=>el.src).filter(x=>/\/assets\/[^/]+\.js(?:\?|$)/u.test(x)));
      if(resourceUrls.length!==1)throw new Error('无法核实游戏当前资源版本');
      return {entries,resourceUrl:resourceUrls[0],updatedAt:Date.now()};
    }finally{
      if(changed&&!ui.signal.aborted){await this.verify();await this.click(ui.frame.locator('nav.central-nav,nav[aria-label="主导航"]').getByRole('button',{name:'游历',exact:true}),'图鉴读取后返回游历',{cleanup:true,browsing:true});await ui.waitFor(async()=>['combat','rest','ready','map'].includes((await ui.observe()).mode),'返回当前地点');}
    }
  }
}
