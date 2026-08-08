(() => {
"use strict";
const C=window.BMMCore,$=id=>document.getElementById(id);
const APP_VERSION="2.1.0", SALES_SCHEMA_VERSION="sales-audit-20260808-v2";
const yen=n=>new Intl.NumberFormat("ja-JP",{style:"currency",currency:"JPY",maximumFractionDigits:0}).format(n||0);
const num=n=>new Intl.NumberFormat("ja-JP").format(n||0);
const pct=n=>n===null?"—":`${(n*100).toFixed(1)}%`;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const DEFAULT_STORES=[
  {name:"東大阪店",url:"https://docs.google.com/spreadsheets/d/1GYGlpQv95bRDOHRAexdPb6tciBzhPItBPY5YcSYi6UE/edit?gid=1770925758#gid=1770925758",excludedShelves:""},
  {name:"ららぽーと堺店",url:"https://docs.google.com/spreadsheets/d/1fb5XVcmwpqi-MOFifStk39Rr5fUzU0b7/edit?gid=465268523#gid=465268523",excludedShelves:""},
  {name:"江坂店",url:"https://docs.google.com/spreadsheets/d/1LSpa6rt6c9ZOEzT5oRVDElYqNcULDKSK/edit?gid=465268523#gid=465268523",excludedShelves:""}
];
let state={config:{stores:[...DEFAULT_STORES],commonMasterUrl:""},records:[],filtered:[],shelfRows:[],stockRows:[],masterRows:[],syncLog:[],lastSynced:""};

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
  $("shelfStoreSelect").innerHTML=stores.map(s=>`<option>${esc(s)}</option>`).join("");
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
  renderDaily(r);renderProducts(products);renderRanking(products);renderStores(stores);renderShelves(r);renderABC(r);renderStockSnapshots();renderStock();renderHistory();
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
function renderShelves(sales){
  const filter={store:$("storeFilter").value,from:$("dateFrom").value,to:$("dateTo").value};
  const shelf=state.shelfRows.filter(r=>(!filter.store||r.store===filter.store)&&(!filter.from||r.date>=filter.from)&&(!filter.to||r.date<=filter.to));

  const configuredStores=new Map(state.config.stores.map(s=>[s.name,s]));
  let allocated=[],matchedSales=0,totalSales=sales.reduce((sum,r)=>sum+r.sales,0);
  const targetStores=filter.store?[filter.store]:[...new Set(sales.map(r=>r.store).filter(Boolean))];

  for(const storeName of targetStores){
    const storeSales=sales.filter(r=>r.store===storeName);
    const storeShelf=shelf.filter(r=>r.store===storeName);
    const exclusion=configuredStores.get(storeName)?.excludedShelves||"";
    const result=C.allocateShelfSales(storeSales,storeShelf,C.parseExcludedShelves(exclusion));
    allocated.push(...result.records);
    matchedSales+=result.matchedSales;
  }

  const coverage=totalSales?matchedSales/totalSales:0;
  const agg=C.aggregateBy(allocated,"shelf").sort((x,y)=>y.sales-x.sales);

  let excludedLabel="";
  if(filter.store){
    excludedLabel=configuredStores.get(filter.store)?.excludedShelves||"なし";
  }else{
    const labels=state.config.stores.filter(s=>s.excludedShelves).map(s=>`${s.name}: ${s.excludedShelves}`);
    excludedLabel=labels.length?labels.join(" / "):"なし";
  }

  $("shelfCoverage").innerHTML=`<div class="coverage"><span>棚照合率 <b class="${coverage>=.9?"good":coverage>=.6?"warn":"danger"}">${pct(coverage)}</b></span><span>除外棚 ${esc(excludedLabel)}</span><span>棚データ ${num(shelf.length)}行</span></div>`;
  $("shelfTable").innerHTML=table([{label:"棚番号"},{label:"売上",num:true},{label:"売れ数",num:true},{label:"商品種類",num:true},{label:"平均単価",num:true}],
    agg.map(x=>[esc(x.key),yen(x.sales),num(x.qty),num(x.productCount),yen(x.qty?x.sales/x.qty:0)]));
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
  const sales=C.aggregateProducts(state.filtered),smap=new Map();
  for(const p of sales){if(p.jan)smap.set(C.normalizeText(p.jan),p);if(p.sku)smap.set(C.normalizeText(p.sku),p);}
  const grouped=new Map();
  for(const r of rows){
    const k=C.normalizeText(r.jan||r.sku),x=grouped.get(k)||{jan:r.jan,sku:r.sku,name:r.name,stock:0,stores:new Set()};
    x.stock+=r.stock;x.stores.add(r.store);if(!x.name&&r.name)x.name=r.name;grouped.set(k,x);
  }
  const list=[...grouped.values()].map(x=>{const s=smap.get(C.normalizeText(x.jan||x.sku))||{qty:0,sales:0};return {...x,qty:s.qty,sales:s.sales};}).sort((a,b)=>a.stock-b.stock);
  $("stockTable").innerHTML=table([{label:"JAN"},{label:"品番"},{label:"商品名"},{label:"在庫",num:true},{label:"期間売れ数",num:true},{label:"期間売上",num:true},{label:"店舗"}],
    list.map(x=>[esc(x.jan),esc(x.sku),esc(x.name),num(x.stock),num(x.qty),yen(x.sales),esc([...x.stores].join("・"))]));
}
function renderHistory(){
  const sr=C.dataRange(state.records),sh=C.dataRange(state.shelfRows),stockDates=[...new Set(state.stockRows.map(r=>r.snapshotDate))].filter(Boolean).sort();
  $("historySummary").innerHTML=[
    ["売上保存期間",`${sr.from||"未保存"} ～ ${sr.to||"未保存"}`],["売上行数",num(state.records.length)],["棚データ行数",num(state.shelfRows.length)],
    ["在庫保存期間",stockDates.length?`${stockDates[0]} ～ ${stockDates.at(-1)}`:"未保存"],["在庫行数",num(state.stockRows.length)],["商品マスタ",`${num(state.masterRows.length)}件`]
  ].map(x=>`<div class="history-stat"><span>${x[0]}</span><strong>${x[1]}</strong></div>`).join("");
  $("syncLogTable").innerHTML=table([{label:"日時"},{label:"種別"},{label:"対象"},{label:"件数",num:true}],state.syncLog.map(l=>[esc(new Date(l.syncedAt).toLocaleString("ja-JP")),esc(l.type||"売上"),esc(l.store||l.target||""),num(l.rows||0)]));
}
function updateStatus(msg){
  $("syncStatus").textContent=msg||(state.lastSynced?`最終同期 ${new Date(state.lastSynced).toLocaleString("ja-JP")}`:"未同期");
}

async function fetchCsvRows(url,label){
  const res=await fetch(C.sheetUrlToCsv(url),{cache:"no-store"});if(!res.ok)throw new Error(`${label}: 読込失敗（${res.status}）`);
  const text=await res.text();if(/<!doctype html|<html/i.test(text))throw new Error(`${label}: 共有設定またはURLを確認してください。`);return C.parseCSV(text);
}
async function masterIndex(){
  if(state.config.commonMasterUrl){
    const rows=await fetchCsvRows(state.config.commonMasterUrl,"商品マスタ");
    const records=C.masterRowsToRecords(rows);
    if(!records.length) throw new Error("商品マスタを判定できません。");
    await BMMDB.replaceMaster(records);state.masterRows=records;return C.buildMasterIndex(records);
  }
  return state.masterRows.length?C.buildMasterIndex(state.masterRows):null;
}
async function fetchStore(store,midx){
  const rows=await fetchCsvRows(store.url,`${store.name} 売上`);
  const mapping=C.detectSalesMapping(rows);
  const parsed=C.rowsToRecords(rows,mapping,store.name);
  const inspected=C.validateSalesRecords(parsed,store.name,C.localToday());
  if(!inspected.ok){
    const sample=inspected.invalid.slice(0,3).map(x=>`行${x.record._row}: ${x.reasons.join("/")}`).join("、");
    throw new Error(`${store.name}: 売上データ検証失敗（有効 ${inspected.valid.length}/${inspected.total}）。${sample||"A=JAN / B=品番 / C=数量 / D=売上 / E=店舗 / F=日付 / H=商品名 を確認してください。"}`);
  }
  const normalized=inspected.valid.map(r=>({...r,store:store.name}));
  return C.enrichWithMaster(normalized,midx);
}
async function syncAll(options={}){
  await repairSavedSalesData();
  if(!state.config.stores.length){if(!options.silent)$("settingsDialog").showModal();updateStatus("店舗設定が必要です");return;}
  $("refreshBtn").disabled=true;updateStatus(options.silent?"自動更新中…":"同期中…");
  try{
    const midx=await masterIndex(),results=await Promise.allSettled(state.config.stores.map(s=>fetchStore(s,midx)));let total=0,errors=[],updated=[];
    for(let i=0;i<results.length;i++){const r=results[i],s=state.config.stores[i];if(r.status==="rejected"){errors.push(r.reason.message);continue;}
      await BMMDB.replaceStoreRange(s.name,r.value);await BMMDB.addSyncLog({syncedAt:new Date().toISOString(),type:"売上",store:s.name,rows:r.value.length});total+=r.value.length;updated.push(`${s.name} ${r.value.length}行`);}
    if(!total)throw new Error(errors.join("\n")||"データを取得できません。");
    const cut=C.cutoffDateForYears(C.localToday(),3);await BMMDB.pruneBefore(cut);
    state.lastSynced=new Date().toISOString();await BMMDB.setMeta("lastSynced",state.lastSynced);await loadState();renderAll();
    updateStatus(errors.length?`一部失敗 ${errors.length}店舗 / ${updated.join("・")}`:`${total}行更新（${updated.join("・")}）`);if(errors.length&&!options.silent)alert(errors.join("\n"));
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

function openCommon(){ $("commonMasterUrl").value=state.config.commonMasterUrl||"";$("commonDataMessage").textContent=`現在 ${state.masterRows.length}件保存`;$("commonDataDialog").showModal(); }
async function saveMasterUrl(){state.config.commonMasterUrl=$("commonMasterUrl").value.trim();await saveConfig();$("commonDataMessage").textContent="URLを保存しました。";if(state.config.commonMasterUrl)await syncAll();}
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
async function importMasterFile(){
  const f=$("masterFileInput").files[0];if(!f){$("commonDataMessage").textContent="ファイルを選択してください。";return;}
  try{const rows=/\.csv$/i.test(f.name)?C.parseCSV(await readTextSmart(f)):await rowsFromSpreadsheetFile(f,"master"),records=C.masterRowsToRecords(rows);if(!records.length)throw new Error("商品マスタを判定できません。");
    await BMMDB.replaceMaster(records);await BMMDB.addSyncLog({syncedAt:new Date().toISOString(),type:"商品マスタ",target:f.name,rows:records.length});await loadState();$("commonDataMessage").textContent=`${records.length}件取り込みました。`;renderAll();
  }catch(e){$("commonDataMessage").textContent=e.message;}
}

function openImport(){
  renderStoreOptions();const today=C.localToday();if(!$("stockSnapshotDate").value)$("stockSnapshotDate").value=today;
  $("shelfImportMessage").textContent="";$("stockImportMessage").textContent="";$("importDataDialog").showModal();
}
async function importShelf(){
  const f=$("shelfFileInput").files[0],store=$("shelfStoreSelect").value;if(!f||!store){$("shelfImportMessage").textContent="店舗とTXTファイルを指定してください。";return;}
  try{const rows=C.parseShelfText(await readTextSmart(f),store);if(!rows.length)throw new Error("棚データを判定できません。");
    await BMMDB.replaceShelfDates(store,rows);await BMMDB.addSyncLog({syncedAt:new Date().toISOString(),type:"棚データ",store,rows:rows.length});await loadState();renderAll();$("shelfImportMessage").textContent=`${rows.length}行取り込みました。`;
  }catch(e){$("shelfImportMessage").textContent=e.message;}
}
async function importStock(){
  const f=$("stockFileInput").files[0];if(!f){$("stockImportMessage").textContent="在庫Excelを選択してください。";return;}
  let date=$("stockSnapshotDate").value||C.inferDateFromFilename(f.name);if(!date){$("stockImportMessage").textContent="在庫基準日を指定してください。";return;}
  try{const rows=await rowsFromSpreadsheetFile(f,"inventory"),records=C.inventoryRowsToRecords(rows,date,state.config.stores.map(s=>s.name));if(!records.length)throw new Error("在庫データを判定できません。");
    await BMMDB.replaceStockSnapshot(date,records);await BMMDB.addSyncLog({syncedAt:new Date().toISOString(),type:"在庫",target:date,rows:records.length});await loadState();renderAll();$("stockSnapshotSelect").value=date;renderStock();$("stockImportMessage").textContent=`${date}：${records.length}件取り込みました。`;
  }catch(e){$("stockImportMessage").textContent=e.message;}
}

async function exportAll(){
  const d=await BMMDB.exportAll(),payload={format:"BMM-Web-V2",version:APP_VERSION,exportedAt:new Date().toISOString(),...d},blob=new Blob([JSON.stringify(payload)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`BMM全データ_${C.localToday()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function importAll(file){
  const p=JSON.parse(await file.text());if(!["BMM-Web-V2","BMM-Web-V1","BMM-Web-History"].includes(p.format))throw new Error("BMMバックアップではありません。");
  if(!confirm("現在の保存データをバックアップ内容で置き換えます。よろしいですか？"))return;await BMMDB.importAll(p);await repairSavedSalesData();await BMMDB.setMeta("salesSchemaVersion",SALES_SCHEMA_VERSION);await loadState();renderAll();alert("復元しました。");
}

function bind(){
  $("refreshBtn").onclick=()=>syncAll();$("settingsBtn").onclick=openSettings;$("saveSettingsBtn").onclick=saveSettings;$("addStoreBtn").onclick=()=>addStoreRow();
  $("commonDataBtn").onclick=openCommon;$("saveCommonMasterUrlBtn").onclick=saveMasterUrl;$("importMasterFileBtn").onclick=importMasterFile;
  $("importDataBtn").onclick=openImport;$("importShelfBtn").onclick=importShelf;$("importStockBtn").onclick=importStock;
  $("applyFilterBtn").onclick=applyFilter;$("clearFilterBtn").onclick=()=>{$("dateFrom").value="";$("dateTo").value="";applyFilter();};
  $("productSearch").oninput=()=>renderProducts(C.aggregateProducts(state.filtered).sort((a,b)=>b.sales-a.sales));$("rankingType").onchange=()=>renderRanking(C.aggregateProducts(state.filtered));
  $("comparePeriodsBtn").onclick=comparePeriods;$("stockSnapshotSelect").onchange=()=>{renderStock();renderProducts(C.aggregateProducts(state.filtered));};
  $("exportHistoryBtn").onclick=exportAll;$("importHistoryInput").onchange=async e=>{if(e.target.files[0])try{await importAll(e.target.files[0]);}catch(err){alert(err.message);}e.target.value="";};
  $("stockFileInput").onchange=e=>{const f=e.target.files[0],d=f&&C.inferDateFromFilename(f.name);if(d)$("stockSnapshotDate").value=d;};
  document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab,.tab-panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");$(b.dataset.tab).classList.add("active");});
}
async function start(){
  await migrateSalesSchema();
  await repairSavedSalesData();
  await loadState();
  bind();
  renderAll();
  if(!state.config.stores.length&&!state.records.length){openSettings();return;}
  if(state.config.stores.length) await syncAll({silent:true});
}
start().catch(e=>{console.error(e);updateStatus("起動エラー");alert(`BMM起動エラー\n${e.message}`);});
})();