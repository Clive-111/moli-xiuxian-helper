export function marrowFixture(){
  const enemy=(id,loot)=>({id,name:id==='a'?'灵鹿':'灵猿',realm:1,realmLabel:'炼气',stats:{maxHp:'100',attack:'10'},abilities:{},loot});
  const map=(id,pool,extra={})=>({id,name:'同名山谷',pool,groups:2,groupSize:2,randomGroupSize:false,encounterPools:{},enemyMultiplier:2,challenge:false,...extra});
  const knowledge={revision:'v1',resourceUrl:'r1',recipes:[],items:[{id:'red',name:'赤灵髓',kind:'marrow'},{id:'green',name:'碧灵髓',kind:'marrow'},{id:'other',name:'矿石',kind:'material'}],
    enemies:[enemy('a',[{itemId:'red',chance:.2},{itemId:'red',chance:.3},{itemId:'red',chance:.5,ignoreLuck:true},{itemId:'green',chance:.1}]),enemy('b',[{itemId:'red',chance:2,ignoreLuck:true},{itemId:'green',chance:1}])],
    maps:[map('north',['a','b'],{encounterPools:{2:['a']}}),map('south',['b'],{randomGroupSize:true,enemyMultiplier:1}),map('locked',['b'],{groups:20}),map('challenge',['b'],{groups:30,challenge:true})]};
  const bestiary={revision:1,knowledgeRevision:'v1',resourceUrl:'r1',updatedAt:1,entries:[{id:'a'},{id:'b'}]};
  const catalog={resourceUrl:'r1',updatedAt:1,checkedAt:1,regions:[{id:'n',name:'北境'},{id:'s',name:'南境'}],items:knowledge.items.filter(i=>i.kind==='marrow'),nodes:knowledge.maps.map(m=>({id:m.id,name:m.name,regionName:m.id==='north'?'北境':'南境',type:m.challenge?'challenge':'battle',availability:m.id==='locked'?'locked':'visible'}))};
  return {knowledge,bestiary,catalog};
}
