(() => {
"use strict";
const C=window.BMMCore,$=id=>document.getElementById(id);
const APP_VERSION="3.0.2", SALES_SCHEMA_VERSION="sales-audit-20260808-v2";
const yen=n=>new Intl.NumberFormat("ja-JP",{style:"currency",currency:"JPY",maximumFractionDigits:0}).format(n||0);
const num=n=>new Intl.NumberFormat("ja-JP").format(n||0);
const pct=n=>n===null?"—":`${(n*100).toFixed(1)}%`;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const DEFAULT_STORES=[
  {name:"東大阪店",url:"https://docs.google.com/spreadsheets/d/1GYGlpQv95bRDOHRAexdPb6tciBzhPItBPY5YcSYi6UE/edit?gid=1770925758#gid=1770925758",excludedShelves:""},
  {name:"ららぽーと堺店",url:"https://docs.google.com/spreadsheets/d/1fb5XVcmwpqi-MOFifStk39Rr5fUzU0b7/edit?gid=465268523#gid=465268523",excludedShelves:""},
  {name:"江坂店",url:"https://docs.google.com/spreadsheets/d/1LSpa6rt6c9ZOEzT5oRVDElYqNcULDKSK/edit?gid=465268523#gid=465268523",excludedShelves:""},
  {name:"名古屋店",url:"https://docs.google.com/spreadsheets/d/1RzZZYlUH57LDG_4ReDZnCVR2koPaEU1r2KEbdQv8gZI/edit?gid=0#gid=0",excludedShelves:""}
];
const COMMON_DATA_SPREADSHEET_ID="1ZYzmDyYK2Oj8zGBsmb2EloI2jWHvFuXLj49pB5goWtw";
const COMMON_MASTER_GID="0";
const COMMON_SHELF_GID="61629702";

let state={config:{stores:[...DEFAULT_STORES],commonMasterUrl:""},records:[],filtered:[],shelfRows:[],shelfHistory:[],stockRows:[],masterRows:[],syncLog:[],lastSynced:""};

const PERSIST_CACHE="bmm-persistent-data-v1";
const PERSIST_KEYS={
  master:"/bmm-persist/master.json",
  shelf:"/bmm-persist/shelf.json",
  shelfHistory:"/bmm-persist/shelf-history.json"
};

async function requestPersistentStorage(){
  try{
    if(navigator.storage?.persist){
      await navigator.storage.persist();
    }
  }catch(e){console.warn("persistent storage request failed",e);}
}

async function cacheWriteJson(path,data){
  if(!("caches" in window)) return false;
  try{
    const cache=await caches.open(PERSIST_CACHE);
    await cache.put(path,new Response(JSON.stringify(data),{
      headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
    }));
    return true;
  }catch(e){
    console.warn("cacheWriteJson failed",path,e);
    return false;
  }
}

async function cacheReadJson(path){
  if(!("caches" in window)) return null;
  try{
    const cache=await caches.open(PERSIST_CACHE);
    const res=await cache.match(path);
    return res?await res.json():null;
  }catch(e){
    console.warn("cacheReadJson failed",path,e);
    return null;
  }
}

async function persistMasterSnapshot(records){
  await cacheWriteJson(PERSIST_KEYS.master,{version:1,savedAt:new Date().toISOString(),records});
}

async function persistShelfSnapshots(){
  await cacheWriteJson(PERSIST_KEYS.shelf,{version:1,savedAt:new Date().toISOString(),records:state.shelfRows});
  await cacheWriteJson(PERSIST_KEYS.shelfHistory,{version:1,savedAt:new Date().toISOString(),records:state.shelfHistory});
}

async function restorePersistentReferenceData(){
  let restored=false;

  let masters=await BMMDB.getAll(BMMDB.stores.master);
  if(!masters.length){
    const cached=await cacheReadJson(PERSIST_KEYS.master);
    if(Array.isArray(cached?.records)&&cached.records.length){
      await BMMDB.replaceMaster(cached.records);
      restored=true;
    }
  }

  let shelves=await BMMDB.getAll(BMMDB.stores.shelf);
  if(!shelves.length){
    const cached=await cacheReadJson(PERSIST_KEYS.shelf);
    if(Array.isArray(cached?.records)&&cached.records.length){
      const byStore=new Map();
      for(const r of cached.records){
        const k=r.store||"未設定";
        if(!byStore.has(k))byStore.set(k,[]);
        byStore.get(k).push(r);
      }
      for(const [store,rows] of byStore) await BMMDB.replaceShelfDates(store,rows);
      restored=true;
    }
  }

  let history=await BMMDB.getAll(BMMDB.stores.shelfHistory);
  if(!history.length){
    const cached=await cacheReadJson(PERSIST_KEYS.shelfHistory);
    if(Array.isArray(cached?.records)&&cached.records.length){
      const groups=new Map();
      for(const r of cached.records){
        const k=[r.store||"未設定",r.effectiveFrom||""].join("|");
        if(!groups.has(k))groups.set(k,[]);
        groups.get(k).push(r);
      }
      for(const [key,rows] of groups){
        const pos=key.indexOf("|");
        const store=key.slice(0,pos),effectiveFrom=key.slice(pos+1);
        if(effectiveFrom) await BMMDB.replaceShelfSnapshot(store,effectiveFrom,rows);
      }
      restored=true;
    }
  }
  return restored;
}


function table(headers,rows){
  if(!rows.length)return '<div class="empty">表示できるデータがありません。</div>';
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th class="${h.num?"num":""}">${esc(h.label)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((v,i)=>`<td class="${headers[i]?.num?"num":""}">${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

async function migrateSalesSchema(){
  const current=await BMMDB.getMeta("salesSchemaVersion");
  if(current===SALES_SCHEMA_VERSION) return false;
  await BMMDB.resetSalesForSchemaMigration();
  await BMMDB.setMeta("salesSchemaVersion",SALES_SCHEMA_VERSION);
  await BMMDB.addSyncLog({syncedAt:new Date().toISOString(),type:"システム修復",target:"売上保存形式を再構築",rows:0});
  return true;
}

async function repairSavedSalesData(){
  const removed=await BMMDB.cleanInvalidSalesRecords();
  if(removed>0){
    await BMMDB.addSyncLog({
      syncedAt:new Date().toISOString(),
      type:"自動修復",
      target:"異常な保存済み売上データ",
      rows:removed
    });
  }
  return removed;
}

async function loadState(){
  const savedConfig=await BMMDB.getMeta("config");
  if(savedConfig){
    const savedStores=Array.isArray(savedConfig.stores)?savedConfig.stores:[];
    const sheetId=url=>(String(url||"").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)||[])[1]||"";
    const aliases=new Map([["東大阪","東大阪店"],["堺店","ららぽーと堺店"],["ららぽーと堺","ららぽーと堺店"],["江坂","江坂店"]]);
    const defaultsById=new Map(DEFAULT_STORES.map(x=>[sheetId(x.url),x]));
    const defaultsByName=new Map(DEFAULT_STORES.map(x=>[x.name,x]));
    const merged=DEFAULT_STORES.map(def=>{
      const prior=savedStores.find(s=>sheetId(s.url)===sheetId(def.url)||s.name===def.name||aliases.get(s.name)===def.name);
      return {...def,excludedShelves:prior?.excludedShelves||def.excludedShelves||""};
    });
    for(const s of savedStores){
      const canonical=aliases.get(s.name)||s.name;
      if(defaultsById.has(sheetId(s.url))||defaultsByName.has(canonical)) continue;
      if(s.name&&s.url) merged.push({...s,name:canonical});
    }
    state.config={...state.config,...savedConfig,stores:merged};
    await BMMDB.setMeta("config",state.config);
  }else{
    state.config={...state.config,stores:DEFAULT_STORES.map(x=>({...x}))};
    await BMMDB.setMeta("config",state.config);
  }
  state.records=await BMMDB.getAll(BMMDB.stores.records);
  state.shelfRows=await BMMDB.getAll(BMMDB.stores.shelf);
  state.shelfHistory=await BMMDB.getAll(BMMDB.stores.shelfHistory);
  state.stockRows=await BMMDB.getAll(BMMDB.stores.stock);
  state.masterRows=await BMMDB.getAll(BMMDB.stores.master);
  state.syncLog=await BMMDB.getSyncLog();
  state.lastSynced=await BMMDB.getMeta("lastSynced")||"";
  state.filtered=[...state.records];
}
async function saveConfig(){await BMMDB.setMeta("config",state.config);}

function storesAll(){
  return [...new Set([...state.config.stores.map(s=>s.name),...state.records.map(r=>r.store),...state.stockRows.map(r=>r.store)].filter(Boolean))].sort();
}
function renderStoreOptions(){
  const stores=storesAll(),old=$("storeFilter").value;
  $("storeFilter").innerHTML='<option value="">全店舗</option>'+stores.map(s=>`<option>${esc(s)}</option>`).join("");
  if(stores.includes(old))$("storeFilter").value=old;
}
function applyFilter(){
  state.filtered=C.filterRecords(state.records,{store:$("storeFilter").value,from:$("dateFrom").value,to:$("dateTo").value});
  renderAll();
}
function renderAll(){
  renderStoreOptions();
  const r=state.filtered,k=C.kpis(r),products=C.aggregateProducts(r).sort((a,b)=>b.sales-a.sales),stores=C.aggregateBy(r,"store").sort((a,b)=>b.sales-a.sales);
  $("totalSales").textContent=yen(k.sales);$("totalQty").textContent=num(k.qty);$("productCount").textContent=num(k.productCount);$("avgPrice").textContent=yen(k.avgPrice);
  $("topProducts").innerHTML=products.slice(0,10).map((p,i)=>`<div class="rank"><span class="rank-no">${i+1}</span><div class="rank-main">${esc(p.name)}<small>${esc(p.sku||p.jan)} / ${num(p.qty)}点</small></div><div class="rank-value">${yen(p.sales)}</div></div>`).join("")||'<div class="empty">データなし</div>';
  $("storeSummary").innerHTML=stores.map((s,i)=>`<div class="rank"><span class="rank-no">${i+1}</span><div class="rank-main">${esc(s.key)}<small>${num(s.qty)}点 / ${num(s.productCount)}商品</small></div><div class="rank-value">${yen(s.sales)}</div></div>`).join("")||'<div class="empty">データなし</div>';
  renderDaily(r);renderProducts(products);renderRanking(products);renderStores(stores);renderShelves(r);renderABC(r);renderStockSnapshots();renderStock();renderInventoryAlerts();renderOrderCandidates();renderKPIDetail();renderHistory();
  $("setupNotice").hidden=state.config.stores.length>0||state.records.length>0;updateStatus();
}
function renderDaily(records){
  const daily=C.aggregateBy(records,"date").filter(x=>x.key!=="未設定").sort((a,b)=>a.key.localeCompare(b.key)),max=Math.max(1,...daily.map(x=>x.sales));
  $("dailyTrend").innerHTML=daily.map(d=>`<div class="bar-item" title="${esc(d.key)} ${yen(d.sales)}"><div class="bar" style="height:${Math.max(2,d.sales/max*150)}px"></div><span class="bar-label">${esc(d.key.slice(5))}</span></div>`).join("")||'<div class="empty">日付データがありません。</div>';
}
function renderProducts(products){
  const q=$("productSearch").value,list=products.filter(p=>C.matchesSearch(p,q)).slice(0,500);
  const stockIndex=currentStockIndex();
  $("productTable").innerHTML=table([{label:"JAN"},{label:"品番"},{label:"商品名"},{label:"売れ数",num:true},{label:"売上",num:true},{label:"現在庫",num:true},{label:"店舗"}],
    list.map(p=>[esc(p.jan),esc(p.sku),esc(p.name),num(p.qty),yen(p.sales),num(stockIndex.get(C.normalizeText(p.jan||p.sku))||0),esc(p.stores.join("・"))]));
}
function renderRanking(products){
  const t=$("rankingType").value,list=[...products].sort((a,b)=>b[t]-a[t]).slice(0,100);
  $("rankingTable").innerHTML=table([{label:"順位",num:true},{label:"商品"},{label:"品番/JAN"},{label:"売れ数",num:true},{label:"売上",num:true}],list.map((p,i)=>[i+1,esc(p.name),esc(p.sku||p.jan),num(p.qty),yen(p.sales)]));
}
function renderStores(stores){
  $("storeCompareTable").innerHTML=table([{label:"店舗"},{label:"売上",num:true},{label:"売れ数",num:true},{label:"商品種類",num:true},{label:"平均単価",num:true}],
    stores.map(s=>[esc(s.key),yen(s.sales),num(s.qty),num(s.productCount),yen(s.qty?s.sales/s.qty:0)]));
}
function shelfSnapshotForDate(storeName,saleDate){
  const history=state.shelfHistory.filter(r=>r.store===storeName&&r.effectiveFrom);
  if(!history.length)return state.shelfRows.filter(r=>r.store===storeName);

  const dates=[...new Set(history.map(r=>r.effectiveFrom))].sort();
  let effective="";
  for(const d of dates){
    if(d<=saleDate)effective=d;
    else break;
  }
  // 売上日より前の履歴が無い場合は、最初の登録日を暫定利用。
  if(!effective)effective=dates[0];
  return history.filter(r=>r.effectiveFrom===effective);
}


function renderShelves(sales){
  const filter={store:$("storeFilter").value};
  const configuredStores=new Map(state.config.stores.map(s=>[s.name,s]));
  let allocated=[],matchedSales=0,excludedSales=0,totalSales=sales.reduce((sum,r)=>sum+r.sales,0);
  const targetStores=filter.store?[filter.store]:[...new Set(sales.map(r=>r.store).filter(Boolean))];

  for(const storeName of targetStores){
    const storeSales=sales.filter(r=>r.store===storeName);
    const exclusion=configuredStores.get(storeName)?.excludedShelves||"";

    // 同じ有効棚配置を使う売上日ごとに分けて集計し、複数世代の棚配置を混ぜない。
    const bySnapshot=new Map();
    for(const sale of storeSales){
      const rows=shelfSnapshotForDate(storeName,sale.date);
      const signature=rows.length?(rows[0].effectiveFrom||"latest"):"none";
      if(!bySnapshot.has(signature))bySnapshot.set(signature,{sales:[],rows});
      bySnapshot.get(signature).sales.push(sale);
    }

    for(const g of bySnapshot.values()){
      const result=C.allocateShelfSales(g.sales,g.rows,C.parseExcludedShelves(exclusion));
      allocated.push(...result.records);
      matchedSales+=result.matchedSales;
      excludedSales+=result.excludedSales||0;
    }
  }

  // 除外棚に帰属した売上は、意図的に分析対象外なので照合率の分母から除く。
  const eligibleSales=Math.max(0,totalSales-excludedSales);
  const coverage=eligibleSales?matchedSales/eligibleSales:0;
  const agg=C.aggregateBy(allocated,"shelf").sort((a,b)=>b.sales-a.sales);
  const topByShelf=new Map();
  for(const r of allocated){
    const key=String(r.shelf||"未設定");
    if(!topByShelf.has(key))topByShelf.set(key,new Map());
    const pm=topByShelf.get(key),pk=C.normalizeText(r.jan||r.sku);
    const x=pm.get(pk)||{name:r.name||"（商品名未登録）",sku:r.sku||"",sales:0};
    x.sales+=r.sales;pm.set(pk,x);
  }

  let excludedLabel="";
  if(filter.store)excludedLabel=configuredStores.get(filter.store)?.excludedShelves||"なし";
  else{
    const labels=state.config.stores.filter(s=>s.excludedShelves).map(s=>`${s.name}: ${s.excludedShelves}`);
    excludedLabel=labels.length?labels.join(" / "):"なし";
  }

  $("shelfCoverage").innerHTML=`<div class="coverage"><span>棚照合率 <b class="${coverage>=.9?"good":coverage>=.6?"warn":"danger"}">${pct(coverage)}</b></span><span>除外棚 ${esc(excludedLabel)}</span><span>棚履歴 ${num(state.shelfHistory.length)}行</span></div>`;
  $("shelfTable").innerHTML=table(
    [{label:"順位"},{label:"棚番号"},{label:"売上",num:true},{label:"売れ数",num:true},{label:"商品種類",num:true},{label:"平均単価",num:true},{label:"主な商品"}],
    agg.map((x,i)=>{
      const tops=[...(topByShelf.get(String(x.key))||new Map()).values()].sort((a,b)=>b.sales-a.sales).slice(0,3)
        .map(p=>`${p.name}${p.sku?`（${p.sku}）`:""}`).join(" / ");
      return [num(i+1),esc(x.key),yen(x.sales),num(Math.round(x.qty)),num(x.productCount),yen(x.qty?x.sales/x.qty:0),esc(tops)];
    })
  );
}
function renderABC(records){
  $("abcTable").innerHTML=table([{label:"ランク"},{label:"商品"},{label:"売上",num:true},{label:"構成比",num:true},{label:"累計",num:true}],
    C.abcAnalysis(records).slice(0,500).map(p=>[`<span class="badge badge-${p.rank.toLowerCase()}">${p.rank}</span>`,esc(p.name),yen(p.sales),pct(p.share),pct(p.cumulative)]));
}
function comparePeriods(){
  const store=$("storeFilter").value,r=C.comparePeriods(state.records,{from:$("periodAFrom").value,to:$("periodATo").value,store},{from:$("periodBFrom").value,to:$("periodBTo").value,store});
  $("periodCompare").innerHTML=table([{label:"指標"},{label:"期間A",num:true},{label:"期間B",num:true},{label:"増減",num:true}],[
    ["売上",yen(r.a.sales),yen(r.b.sales),pct(r.delta.sales)],["売れ数",num(r.a.qty),num(r.b.qty),pct(r.delta.qty)],["商品種類",num(r.a.productCount),num(r.b.productCount),pct(r.delta.productCount)],["平均単価",yen(r.a.avgPrice),yen(r.b.avgPrice),pct(r.delta.avgPrice)]]);
}
function renderStockSnapshots(){
  const dates=[...new Set(state.stockRows.map(r=>r.snapshotDate).filter(Boolean))].sort().reverse(),old=$("stockSnapshotSelect").value;
  $("stockSnapshotSelect").innerHTML=dates.length?dates.map(d=>`<option>${d}</option>`).join(""):'<option value="">未取込</option>';
  if(dates.includes(old))$("stockSnapshotSelect").value=old;
}
function currentStockIndex(){
  const date=$("stockSnapshotSelect")?.value||C.latestSnapshotDate(state.stockRows),store=$("storeFilter")?.value||"",map=new Map();
  for(const r of state.stockRows){
    if(r.snapshotDate!==date)continue;if(store&&r.store!==store)continue;
    const k=C.normalizeText(r.jan||r.sku);map.set(k,(map.get(k)||0)+r.stock);
  }
  return map;
}
function renderStock(){
  const date=$("stockSnapshotSelect").value||C.latestSnapshotDate(state.stockRows),store=$("storeFilter").value,rows=state.stockRows.filter(r=>r.snapshotDate===date&&(!store||r.store===store));
  $("stockSnapshotInfo").textContent=date?`${date} 時点 / ${store||"全店舗"}`:"在庫Excel未取込";
  const periodMap=new Map();for(const p of C.aggregateProducts(state.filtered)){if(p.jan)periodMap.set(C.normalizeText(p.jan),p);}
  const historyMap=new Map();for(const p of C.aggregateProducts(state.records.filter(r=>!store||r.store===store))){if(p.jan)historyMap.set(C.normalizeText(p.jan),p);}
  const masterByJan=new Map();for(const m of state.masterRows){if(m.jan)masterByJan.set(C.normalizeText(m.jan),m);}
  const grouped=new Map();for(const r of rows){const k=C.normalizeText(r.jan||r.sku);if(!k)continue;const m=r.jan?masterByJan.get(C.normalizeText(r.jan)):null,x=grouped.get(k)||{jan:r.jan||m?.jan||"",sku:m?.sku||r.sku||"",name:m?.name||r.name||"（商品名未登録）",stock:0,stores:new Set()};x.stock+=r.stock;x.stores.add(r.store);grouped.set(k,x);}
  for(const [k,h] of historyMap){if(grouped.has(k))continue;const m=masterByJan.get(k);grouped.set(k,{jan:h.jan||m?.jan||"",sku:m?.sku||h.sku||"",name:m?.name||h.name||"（商品名未登録）",stock:0,stores:new Set(store?[store]:h.stores||[])});}
  const list=[...grouped.values()].map(x=>{const key=C.normalizeText(x.jan),p=periodMap.get(key)||{qty:0,sales:0},h=historyMap.get(key);return{...x,qty:p.qty||0,sales:p.sales||0,hasHistory:Boolean(h)};}).filter(x=>x.stock!==0||x.hasHistory).sort((a,b)=>(b.qty-a.qty)||(b.sales-a.sales)||(b.stock-a.stock));
  $("stockTable").innerHTML=table([{label:"順位"},{label:"商品名"},{label:"品番"},{label:"JAN"},{label:"期間売れ数",num:true},{label:"期間売上",num:true},{label:"現在庫",num:true},{label:"在庫状況"}],list.map((x,i)=>{const status=x.stock<=0?"在庫0":x.qty>0&&x.stock<x.qty?"少なめ":"在庫あり";return[num(i+1),esc(x.name),esc(x.sku),esc(x.jan),num(x.qty),yen(x.sales),num(x.stock),esc(status)];}));
}

function currentInventoryProductRows(){
  const date=$("stockSnapshotSelect").value||C.latestSnapshotDate(state.stockRows);
  const store=$("storeFilter").value;
  const stockRows=state.stockRows.filter(r=>r.snapshotDate===date&&(!store||r.store===store));
  const periodProducts=C.aggregateProducts(state.filtered);
  const historyProducts=C.aggregateProducts(state.records.filter(r=>!store||r.store===store));

  const periodMap=new Map(),historyMap=new Map(),masterByJan=new Map(),stockMap=new Map();
  for(const p of periodProducts)if(p.jan)periodMap.set(C.normalizeText(p.jan),p);
  for(const p of historyProducts)if(p.jan)historyMap.set(C.normalizeText(p.jan),p);
  for(const m of state.masterRows)if(m.jan)masterByJan.set(C.normalizeText(m.jan),m);
  for(const r of stockRows){
    const k=C.normalizeText(r.jan||r.sku);if(!k)continue;
    const x=stockMap.get(k)||{stock:0,stores:new Set(),jan:r.jan,sku:r.sku,name:r.name};
    x.stock+=Number(r.stock)||0;x.stores.add(r.store);stockMap.set(k,x);
  }

  const keys=new Set([...periodMap.keys(),...historyMap.keys(),...stockMap.keys()]);
  const out=[];
  for(const k of keys){
    const p=periodMap.get(k)||{qty:0,sales:0,jan:"",sku:"",name:""};
    const h=historyMap.get(k);
    const st=stockMap.get(k)||{stock:0,stores:new Set(),jan:"",sku:"",name:""};
    const m=masterByJan.get(k);
    const stock=Number(st.stock)||0,qty=Number(p.qty)||0,sales=Number(p.sales)||0;
    if(stock===0&&!h)continue;
    out.push({
      key:k,jan:p.jan||st.jan||m?.jan||"",sku:m?.sku||p.sku||st.sku||"",
      name:m?.name||p.name||st.name||"（商品名未登録）",
      qty,sales,stock,signal:C.inventorySignal(qty,stock)
    });
  }
  return out;
}

function renderInventoryAlerts(){
  const rows=currentInventoryProductRows().filter(x=>x.signal.level>0)
    .sort((a,b)=>(b.signal.level-a.signal.level)||(b.qty-a.qty)||(b.sales-a.sales)||(b.stock-a.stock));

  const counts={stockout:0,low:0,stagnant:0,excess:0};
  for(const x of rows)counts[x.signal.key]=(counts[x.signal.key]||0)+1;
  $("alertSummary").innerHTML=[
    ["欠品",counts.stockout],["在庫少",counts.low],["滞留",counts.stagnant],["在庫過多",counts.excess]
  ].map(x=>`<div class="mini-kpi"><span>${x[0]}</span><strong>${num(x[1])}</strong></div>`).join("");

  $("alertTable").innerHTML=table(
    [{label:"優先"},{label:"商品名"},{label:"品番"},{label:"JAN"},{label:"期間売れ数",num:true},{label:"期間売上",num:true},{label:"現在庫",num:true}],
    rows.map(x=>[
      `<span class="signal signal-${x.signal.key}">${esc(x.signal.label)}</span>`,
      esc(x.name),esc(x.sku),esc(x.jan),num(x.qty),yen(x.sales),num(x.stock)
    ])
  );
}

function renderOrderCandidates(){
  const periodDays=Math.max(1,C.dateSpanDays(state.filtered));
  const rows=currentInventoryProductRows().map(x=>{
    const r=C.reorderSuggestion(x.qty,x.stock,periodDays,2);
    return {...x,...r};
  }).filter(x=>x.orderQty>0&&x.qty>0)
    .sort((a,b)=>(b.orderQty-a.orderQty)||(b.weeklyQty-a.weeklyQty)||(b.sales-a.sales));

  const totalUnits=rows.reduce((s,x)=>s+x.orderQty,0);
  const stockouts=rows.filter(x=>x.stock<=0).length;
  $("orderSummary").innerHTML=[
    ["候補商品",rows.length],["推奨発注数合計",totalUnits],["うち欠品",stockouts],["計算期間",`${periodDays}日`]
  ].map(x=>`<div class="mini-kpi"><span>${x[0]}</span><strong>${typeof x[1]==="number"?num(x[1]):esc(x[1])}</strong></div>`).join("");

  $("orderTable").innerHTML=table(
    [{label:"順位"},{label:"商品名"},{label:"品番"},{label:"JAN"},{label:"期間売れ数",num:true},{label:"週換算売れ数",num:true},{label:"現在庫",num:true},{label:"目標在庫",num:true},{label:"発注候補",num:true}],
    rows.map((x,i)=>[
      num(i+1),esc(x.name),esc(x.sku),esc(x.jan),num(x.qty),x.weeklyQty.toFixed(1),num(x.stock),num(x.target),`<strong>${num(x.orderQty)}</strong>`
    ])
  );
}

function kpiDeltaClass(v){return v===null||Math.abs(v)<0.0001?"delta-flat":v>0?"delta-up":"delta-down";}
function kpiDeltaText(v){return v===null?"比較不可":`${v>=0?"+":""}${(v*100).toFixed(1)}%`; }

function renderKPIDetail(){
  const current=state.filtered;
  const store=$("storeFilter").value;
  const range=C.previousPeriodRange(current);
  const previous=range.days?C.filterRecords(state.records,{store,from:range.from,to:range.to}):[];
  const now=C.kpis(current),prev=C.kpis(previous);
  const delta=(a,b)=>b===0?(a===0?0:null):(a-b)/b;

  const cards=[
    ["売上",yen(now.sales),delta(now.sales,prev.sales)],
    ["売れ数",num(now.qty),delta(now.qty,prev.qty)],
    ["平均単価",yen(now.avgPrice),delta(now.avgPrice,prev.avgPrice)],
    ["商品種類",num(now.productCount),delta(now.productCount,prev.productCount)]
  ];
  $("kpiDetailCards").innerHTML=cards.map(x=>`<div class="kpi-detail-card"><span>${x[0]}</span><strong>${x[1]}</strong><small class="${kpiDeltaClass(x[2])}">前期間比 ${kpiDeltaText(x[2])}</small></div>`).join("");

  const inv=currentInventoryProductRows(),stockouts=inv.filter(x=>x.signal.key==="stockout").length,lows=inv.filter(x=>x.signal.key==="low").length,excess=inv.filter(x=>x.signal.key==="excess"||x.signal.key==="stagnant").length;
  $("kpiInventory").innerHTML=[
    ["欠品商品",stockouts],["在庫少",lows],["滞留・過多",excess],["在庫対象商品",inv.length]
  ].map(x=>`<div class="history-stat"><span>${x[0]}</span><strong>${num(x[1])}</strong></div>`).join("");

  const abc=C.abcAnalysis(current),aSales=abc.filter(x=>x.rank==="A").reduce((s,x)=>s+x.sales,0),total=now.sales;
  const top=C.aggregateProducts(current).sort((a,b)=>b.sales-a.sales)[0];
  const storeRank=C.aggregateBy(current,"store").sort((a,b)=>b.sales-a.sales)[0];
  $("kpiComposition").innerHTML=[
    ["Aランク売上比",total?`${(aSales/total*100).toFixed(1)}%`:"0.0%"],
    ["売上1位商品",top?`${esc(top.name)} / ${yen(top.sales)}`:"データなし"],
    ["売上1位店舗",storeRank?`${esc(storeRank.key)} / ${yen(storeRank.sales)}`:"データなし"],
    ["前期間",range.days?`${range.from} ～ ${range.to}`:"比較データなし"]
  ].map(x=>`<div class="history-stat"><span>${x[0]}</span><strong>${x[1]}</strong></div>`).join("");
}

function renderHistory(){
  const sr=C.dataRange(state.records),sh=C.dataRange(state.shelfRows),stockDates=[...new Set(state.stockRows.map(r=>r.snapshotDate))].filter(Boolean).sort();
  $("historySummary").innerHTML=[
    ["売上保存期間",`${sr.from||"未保存"} ～ ${sr.to||"未保存"}`],["売上行数",num(state.records.length)],["最新棚データ行数",num(state.shelfRows.length)],["棚履歴行数",num(state.shelfHistory.length)],
    ["在庫保存期間",stockDates.length?`${stockDates[0]} ～ ${stockDates.at(-1)}`:"未保存"],["在庫行数",num(state.stockRows.length)],["商品マスタ",`${num(state.masterRows.length)}件`]
  ].map(x=>`<div class="history-stat"><span>${x[0]}</span><strong>${x[1]}</strong></div>`).join("");
  $("syncLogTable").innerHTML=table([{label:"日時"},{label:"種別"},{label:"対象"},{label:"件数",num:true}],state.syncLog.map(l=>[esc(new Date(l.syncedAt).toLocaleString("ja-JP")),esc(l.type||"売上"),esc(l.store||l.target||""),num(l.rows||0)]));
}
function updateStatus(msg){
  $("syncStatus").textContent=msg||(state.lastSynced?`最終同期 ${new Date(state.lastSynced).toLocaleString("ja-JP")}`:"未同期");
}

async function fetchSheetGidRows(spreadsheetId,gid,label){
  const url=`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  const res=await fetch(url,{cache:"no-store"});
  if(!res.ok) throw new Error(`${label}: Googleスプレッドシートを取得できません（${res.status}）。`);
  const text=await res.text();
  const rows=C.parseCSV(text);
  if(!rows.length) throw new Error(`${label}: データが空です。`);
  return rows;
}

async function fetchCsvRows(url,label){
  const res=await fetch(C.sheetUrlToCsv(url),{cache:"no-store"});if(!res.ok)throw new Error(`${label}: 読込失敗（${res.status}）`);
  const text=await res.text();if(/<!doctype html|<html/i.test(text))throw new Error(`${label}: 共有設定またはURLを確認してください。`);return C.parseCSV(text);
}
async function masterIndex(){
  // Version 2.3.1:
  // 商品マスタの正本は共通BMMスプレッドシート「商品マスタ」タブ。
  // 旧ブラウザ設定 commonMasterUrl が残っていても、共通マスタを上書きしない。
  if(state.masterRows.length)return C.buildMasterIndex(state.masterRows);

  // 共通同期が一時的に失敗し、端末にも保存マスタが無い場合だけ旧URLを予備利用。
  if(state.config.commonMasterUrl){
    const rows=await fetchCsvRows(state.config.commonMasterUrl,"商品マスタ（予備）");
    const records=C.masterRowsToRecords(rows);
    if(records.length){
      await BMMDB.replaceMaster(records);
      await persistMasterSnapshot(records);
      state.masterRows=records;
      return C.buildMasterIndex(records);
    }
  }
  return null;
}
async function fetchStore(store,midx){
  const rows=await fetchCsvRows(store.url,`${store.name} 売上`);
  const mapping=C.detectSalesMapping(rows);
  const parsed=C.rowsToRecords(rows,mapping,store.name);
  const inspected=C.validateSalesRecords(parsed,store.name,C.localToday());

  if(!inspected.ok){
    const sample=inspected.invalid.slice(0,3).map(x=>`行${x.record._row}: ${x.reasons.join("/")}`).join("、");
    throw new Error(`${store.name}: 有効な売上データがありません。${sample||"A=JAN / B=品番 / C=数量 / D=売上 / E=店舗 / F=日付 を確認してください。"}`);
  }

  const normalized=inspected.valid.map(r=>({...r,store:store.name}));
  return {
    records:C.enrichWithMaster(normalized,midx),
    ignored:inspected.ignored.length,
    invalid:inspected.invalid,
    total:inspected.total
  };
}
async function syncCommonMasterAndShelves(){
  let masterCount=0,shelfCount=0;

  // 商品マスタ: gid=0 を正本として直接CSV取得
  const masterRows=await fetchSheetGidRows(COMMON_DATA_SPREADSHEET_ID,COMMON_MASTER_GID,"共通商品マスタ");
  const masterRecords=C.masterRowsToRecords(masterRows);
  if(!masterRecords.length) throw new Error("共通商品マスタ: JAN付き商品を1件も判定できません。商品マスタのAA列(UPC/JAN)を確認してください。");

  const masterIndex=C.buildMasterIndex(masterRecords);
  if(!masterIndex.byJan.size) throw new Error("共通商品マスタ: JAN索引を作成できません。");

  await BMMDB.replaceMaster(masterRecords);
  await persistMasterSnapshot(masterRecords);
  state.masterRows=masterRecords;
  masterCount=masterRecords.length;

  // 棚番号: gidを固定して横持ち店舗列を取得
  const shelfGrid=await fetchSheetGidRows(COMMON_DATA_SPREADSHEET_ID,COMMON_SHELF_GID,"共通棚データ");
  const shelfRecords=C.parseShelfGridRows(shelfGrid);
  if(shelfRecords.length){
    const byStore=new Map();
    for(const r of shelfRecords){
      if(!r.store) continue;
      if(!byStore.has(r.store)) byStore.set(r.store,[]);
      byStore.get(r.store).push(r);
    }
    const effectiveFrom=C.localToday();
    for(const [store,rows] of byStore){
      await BMMDB.replaceShelfDates(store,rows);
      await BMMDB.replaceShelfSnapshot(store,effectiveFrom,rows);
      shelfCount+=rows.length;
    }
  }

  await loadState();
  await persistMasterSnapshot(state.masterRows);
  await persistShelfSnapshots();

  await BMMDB.addSyncLog({
    syncedAt:new Date().toISOString(),
    type:"共通データ",
    target:"商品マスタ・棚番号",
    rows:masterCount+shelfCount
  });

  return {masterCount,shelfCount,masterJanCount:masterIndex.byJan.size};
}

async function syncAll(options={}){
  await repairSavedSalesData();
  let commonSync=null;
  try{
    commonSync=await syncCommonMasterAndShelves();
  }catch(e){
    console.warn(e);
    updateStatus(`共通データ同期失敗: ${e.message}`);
    if(!options.silent)alert(`共通データ同期失敗\n${e.message}`);
  }
  if(!state.config.stores.length){if(!options.silent)$("settingsDialog").showModal();updateStatus("店舗設定が必要です");return;}
  $("refreshBtn").disabled=true;updateStatus(options.silent?"自動更新中…":"同期中…");
  try{
    const midx=await masterIndex(),results=await Promise.allSettled(state.config.stores.map(s=>fetchStore(s,midx)));let total=0,errors=[],updated=[];
    const warnings=[];
    for(let i=0;i<results.length;i++){
      const r=results[i],s=state.config.stores[i];
      if(r.status==="rejected"){
        errors.push(r.reason.message);
        continue;
      }

      const payload=r.value;
      await BMMDB.upsertSalesRecords(payload.records);
      await BMMDB.addSyncLog({
        syncedAt:new Date().toISOString(),
        type:"売上",
        store:s.name,
        rows:payload.records.length,
        ignored:payload.ignored,
        invalid:payload.invalid.length
      });

      total+=payload.records.length;
      updated.push(`${s.name} ${payload.records.length}行`);

      if(payload.ignored||payload.invalid.length){
        warnings.push(
          `${s.name}: ${payload.records.length}行取込 / 空行等${payload.ignored}行無視 / 不正${payload.invalid.length}行除外`
        );
      }
    }
    if(!total)throw new Error(errors.join("\n")||"データを取得できません。");
    const cut=C.cutoffDateForYears(C.localToday(),3);await BMMDB.pruneBefore(cut);
    state.lastSynced=new Date().toISOString();await BMMDB.setMeta("lastSynced",state.lastSynced);await loadState();renderAll();
    if(errors.length){
      updateStatus(`一部失敗 ${errors.length}店舗 / ${updated.join("・")}${commonSync?` / マスタ${commonSync.masterCount}件(JAN${commonSync.masterJanCount}件)・棚${commonSync.shelfCount}行`:""}`);
      if(!options.silent) alert(errors.join("\n"));
    }else if(warnings.length){
      updateStatus(`${total}行更新（${updated.join("・")}）${commonSync?` / マスタ${commonSync.masterCount}件(JAN${commonSync.masterJanCount}件)・棚${commonSync.shelfCount}行`:""}`);
      if(!options.silent) alert(`同期完了\n\n${warnings.join("\n")}`);
    }else{
      updateStatus(`${total}行更新（${updated.join("・")}）${commonSync?` / マスタ${commonSync.masterCount}件(JAN${commonSync.masterJanCount}件)・棚${commonSync.shelfCount}行`:""}`);
    }
  }catch(e){updateStatus(`更新失敗：${String(e.message||e).slice(0,80)}`);if(!options.silent)alert(e.message);else console.error(e);}
  finally{$("refreshBtn").disabled=false;}
}

function addStoreRow(data={}){
  const n=$("storeRowTemplate").content.firstElementChild.cloneNode(true);
  n.querySelector(".store-name").value=data.name||"";
  n.querySelector(".store-url").value=data.url||"";
  n.querySelector(".store-excluded-shelves").value=data.excludedShelves||"";
  n.querySelector(".remove-store").onclick=()=>n.remove();
  $("storeRows").appendChild(n);
}
function openSettings(){
  $("storeRows").innerHTML="";(state.config.stores.length?state.config.stores:[{}]).forEach(addStoreRow);$("settingsMessage").textContent="";$("settingsDialog").showModal();
}
async function saveSettings(){
  const stores=[...document.querySelectorAll(".store-row")].map(r=>({
    name:r.querySelector(".store-name").value.trim(),
    url:r.querySelector(".store-url").value.trim(),
    excludedShelves:r.querySelector(".store-excluded-shelves").value.normalize("NFKC").split(/[、，,\s]+/).map(v=>v.trim()).filter(Boolean).join(",")
  })).filter(x=>x.name&&x.url);
  if(!stores.length){$("settingsMessage").textContent="店舗名とURLを入力してください。";return;}state.config={...state.config,stores};await saveConfig();$("settingsDialog").close();await syncAll();
}

async function readTextSmart(file){
  const buf=await file.arrayBuffer(),u8=new Uint8Array(buf);let text=new TextDecoder("utf-8").decode(u8);
  const bad=(text.match(/\uFFFD/g)||[]).length;
  if(bad>2)text=new TextDecoder("shift_jis").decode(u8);return text;
}
async function rowsFromSpreadsheetFile(file,kind="generic"){
  if(!window.XLSX)throw new Error("Excel読込ライブラリの読み込みに失敗しました。ネット接続を確認してください。");
  const wb=XLSX.read(await file.arrayBuffer(),{type:"array",cellDates:true});
  let best=null,bestScore=-1;
  for(const name of wb.SheetNames){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:""});
    let score=0;
    if(kind==="inventory"){const m=C.detectInventoryLayout(rows,state.config.stores.map(s=>s.name));score=(m.jan>=0?10:0)+m.storeCols.length;}
    else if(kind==="master"){const m=C.detectMasterLayout(rows);score=(m.sku>=0?5:0)+(m.name>=0?5:0)+(m.jan>=0?2:0);}
    else score=rows.length;
    if(score>bestScore){bestScore=score;best=rows;}
  }
  return best||[];
}
function openImport(){
  renderStoreOptions();const today=C.localToday();if(!$("stockSnapshotDate").value)$("stockSnapshotDate").value=today;
  $("stockImportMessage").textContent="";$("importDataDialog").showModal();
}
async function importStock(){
  const f=$("stockFileInput").files[0];if(!f){$("stockImportMessage").textContent="在庫Excelを選択してください。";return;}
  let date=$("stockSnapshotDate").value||C.inferDateFromFilename(f.name);if(!date){$("stockImportMessage").textContent="在庫基準日を指定してください。";return;}
  try{const rows=await rowsFromSpreadsheetFile(f,"inventory");let records=C.inventoryRowsToRecords(rows,date,state.config.stores.map(s=>s.name));if(!records.length)throw new Error("在庫データを判定できません。");records=C.compactInventoryRecords(records);
    await BMMDB.replaceStockSnapshot(date,records);await BMMDB.addSyncLog({syncedAt:new Date().toISOString(),type:"在庫",target:date,rows:records.length});await loadState();renderAll();$("stockSnapshotSelect").value=date;renderStock();$("stockImportMessage").textContent=`${date}：在庫あり ${records.length}件を保存しました（0在庫は保存せず、販売履歴から0在庫表示します）。`;
  }catch(e){$("stockImportMessage").textContent=e.message;}
}

async function exportAll(){
  const d=await BMMDB.exportAll(),payload={format:"BMM-Web-V2",version:APP_VERSION,exportedAt:new Date().toISOString(),...d},blob=new Blob([JSON.stringify(payload)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`BMM全データ_${C.localToday()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function importAll(file){
  const p=JSON.parse(await file.text());if(!["BMM-Web-V2","BMM-Web-V1","BMM-Web-History"].includes(p.format))throw new Error("BMMバックアップではありません。");
  if(!confirm("現在の保存データをバックアップ内容で置き換えます。よろしいですか？"))return;await BMMDB.importAll(p);await repairSavedSalesData();await BMMDB.setMeta("salesSchemaVersion",SALES_SCHEMA_VERSION);await loadState();if(state.masterRows.length)await persistMasterSnapshot(state.masterRows);await persistShelfSnapshots();renderAll();alert("復元しました。");
}

function bind(){
  $("refreshBtn").onclick=()=>syncAll();$("settingsBtn").onclick=openSettings;$("saveSettingsBtn").onclick=saveSettings;$("addStoreBtn").onclick=()=>addStoreRow();
  $("importDataBtn").onclick=openImport;$("importStockBtn").onclick=importStock;
  $("applyFilterBtn").onclick=applyFilter;$("clearFilterBtn").onclick=()=>{$("dateFrom").value="";$("dateTo").value="";applyFilter();};
  $("productSearch").oninput=()=>renderProducts(C.aggregateProducts(state.filtered).sort((a,b)=>b.sales-a.sales));$("rankingType").onchange=()=>renderRanking(C.aggregateProducts(state.filtered));
  $("comparePeriodsBtn").onclick=comparePeriods;$("stockSnapshotSelect").onchange=()=>{renderStock();renderProducts(C.aggregateProducts(state.filtered));};
  $("exportHistoryBtn").onclick=exportAll;$("importHistoryInput").onchange=async e=>{if(e.target.files[0])try{await importAll(e.target.files[0]);}catch(err){alert(err.message);}e.target.value="";};
  $("stockFileInput").onchange=e=>{const f=e.target.files[0],d=f&&C.inferDateFromFilename(f.name);if(d)$("stockSnapshotDate").value=d;};
  document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab,.tab-panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");$(b.dataset.tab).classList.add("active");});
}
async function start(){
  await requestPersistentStorage();
  await migrateSalesSchema();
  await repairSavedSalesData();
  await restorePersistentReferenceData();
  await loadState();
  bind();
  renderAll();
  if(!state.config.stores.length&&!state.records.length){openSettings();return;}
  if(state.config.stores.length) await syncAll({silent:true});
}
start().catch(e=>{console.error(e);updateStatus("起動エラー");alert(`BMM起動エラー\n${e.message}`);});
})();