import {marrowFixture} from './marrow-fixture.js';
export function materialFixture(){
  const c=marrowFixture();
  Object.assign(c.knowledge.items[0],{kind:'part',name:'赤精料'});Object.assign(c.knowledge.items[1],{kind:'material',name:'碧矿'});
  c.knowledge.items.push({id:'crafted',name:'合炼料',kind:'part'},{id:'hidden',name:'未知矿',kind:'material'},
    {id:'equipment',name:'成品剑',kind:'equipment'},{id:'marrow',name:'赤灵髓',kind:'marrow'});
  c.knowledge.recipes=[{id:'crafted',output:'crafted',materials:{other:2}}];
  c.knowledge.enemies.push({id:'unseen',name:'未遭遇怪',loot:[{itemId:'hidden',chance:1}]});
  return c;
}
