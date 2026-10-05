// Choose from account-visible locations and current public UI evidence only.
// Selecting a destination never travels, opens a shop or sells an item.
export function automaticSaleShop(catalog,state,{allowFallback=false}={}){
 const shops=catalog?.shops??[];
 const unique=shop=>shops.filter(s=>s.regionName===shop.regionName&&s.locationName===shop.locationName&&s.name===shop.name).length===1;
 const local=shops.filter(s=>unique(s)&&s.regionName===state.region&&s.locationName===state.location).filter(s=>{
  const entries=(state.localServices??[]).filter(e=>e.name===s.name);return entries.length===1&&entries[0].enabled===true;
 });
 if(local.length===1)return local[0];
 if(!allowFallback||local.length)return null;
 return shops.filter(s=>unique(s)&&!s.prerequisiteId&&catalog.nodes?.some(n=>n.id===s.locationId&&n.regionName===s.regionName&&n.name===s.locationName&&['rest','healing'].includes(n.type)&&n.availability==='visible'))
  .filter(s=>!(s.regionName===state.region&&s.locationName===state.location))
  .sort((a,b)=>Number(b.regionName===state.region)-Number(a.regionName===state.region)||a.id.localeCompare(b.id))[0]??null;
}
