(() => {
  "use strict";
  const C = window.BMMCore;
  const STORAGE = {
    config: "bmm-web-config-v1",
    records: "bmm-web-records-v1",
    synced: "bmm-web-synced-v1"
  };
  const defaultMapping = {jan:"A",sku:"B",qty:"C",sales:"D",store:"E",date:"F",shelf:"",name:"H",stock:""};
  let state = {config:{stores:[],mapping:{...defaultMapping}},records:[],filtered:[]};

  const $ = id => document.getElementById(id);
  const yen = n => new Intl.NumberFormat("ja-JP",{style:"currency",currency:"JPY",maximumFractionDigits:0}).format(n||0);
  const num = n => new Intl.NumberFormat("ja-JP").format(n||0);
  const pct = n => n===null?"—":`${(n*100).toFixed(1)}%`;
  const esc = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  function loadState(){
    try{state.config=JSON.parse(localStorage.getItem(STORAGE.config))||state.config;}catch(_){}
    try{state.records=JSON.parse(localStorage.getItem(STORAGE.records))||[];}catch(_){}
    state.config.mapping={...defaultMapping,...(state.config.mapping||{})};
    state.filtered=[...state.records];
  }

  function saveState(){
    localStorage.setItem(STORAGE.config,JSON.stringify(state.config));
    localStorage.setItem(STORAGE.records,JSON.stringify(state.records));
    localStorage.setItem(STORAGE.synced,new Date().toISOString());
  }

  function table(headers,rows){
    if(!rows.length) return '<div class="empty">表示できるデータがありません。</div>';
    return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th class="${h.num?"num":""}">${esc(h.label)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((v,i)=>`<td class="${headers[i]?.num?"num":""}">${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function applyFilter(){
    state.filtered=C.filterRecords(state.records,{
      store:$("storeFilter").value,
      from:$("dateFrom").value,
      to:$("dateTo").value
    });
    renderAll();
  }

  function renderStoreOptions(){
    const stores=[...new Set(state.records.map(r=>r.store).filter(Boolean))].sort();
    const old=$("storeFilter").value;
    $("storeFilter").innerHTML='<option value="">全店舗</option>'+stores.map(s=>`<option>${esc(s)}</option>`).join("");
    if(stores.includes(old)) $("storeFilter").value=old;
  }

  function renderAll(){
    renderStoreOptions();
    const r=state.filtered;
    const k=C.kpis(r);
    $("totalSales").textContent=yen(k.sales);
    $("totalQty").textContent=num(k.qty);
    $("productCount").textContent=num(k.productCount);
    $("avgPrice").textContent=yen(k.avgPrice);

    const products=C.aggregateProducts(r).sort((a,b)=>b.sales-a.sales);
    $("topProducts").innerHTML=products.slice(0,10).map((p,i)=>`<div class="rank"><span class="rank-no">${i+1}</span><div class="rank-main">${esc(p.name)}<small>${esc(p.sku||p.jan)} / ${num(p.qty)}点</small></div><div class="rank-value">${yen(p.sales)}</div></div>`).join("")||'<div class="empty">データなし</div>';

    const stores=C.aggregateBy(r,"store").sort((a,b)=>b.sales-a.sales);
    $("storeSummary").innerHTML=stores.map((s,i)=>`<div class="rank"><span class="rank-no">${i+1}</span><div class="rank-main">${esc(s.key)}<small>${num(s.qty)}点 / ${num(s.productCount)}商品</small></div><div class="rank-value">${yen(s.sales)}</div></div>`).join("")||'<div class="empty">データなし</div>';

    renderDaily(r);
    renderProducts(products);
    renderRanking(products);
    renderStores(stores);
    renderShelves(r);
    renderABC(r);
    renderStock(products);
    $("setupNotice").hidden=state.config.stores.length>0||state.records.length>0;
    updateStatus();
  }

  function renderDaily(records){
    const daily=C.aggregateBy(records,"date").filter(x=>x.key!=="未設定").sort((a,b)=>a.key.localeCompare(b.key));
    const max=Math.max(1,...daily.map(x=>x.sales));
    $("dailyTrend").innerHTML=daily.map(d=>`<div class="bar-item" title="${esc(d.key)} ${yen(d.sales)}"><div class="bar" style="height:${Math.max(2,d.sales/max*150)}px"></div><span class="bar-label">${esc(d.key.slice(5))}</span></div>`).join("")||'<div class="empty">日付データがありません。</div>';
  }

  function renderProducts(products){
    const q=$("productSearch").value.trim().toLowerCase();
    const list=products.filter(p=>!q||[p.jan,p.sku,p.name].some(v=>String(v).toLowerCase().includes(q))).slice(0,500);
    $("productTable").innerHTML=table(
      [{label:"JAN"},{label:"品番"},{label:"商品名"},{label:"売れ数",num:true},{label:"売上",num:true},{label:"店舗"}],
      list.map(p=>[esc(p.jan),esc(p.sku),esc(p.name),num(p.qty),yen(p.sales),esc(p.stores.join("・"))])
    );
  }

  function renderRanking(products){
    const type=$("rankingType").value;
    const list=[...products].sort((a,b)=>b[type]-a[type]).slice(0,100);
    $("rankingTable").innerHTML=table(
      [{label:"順位",num:true},{label:"商品"},{label:"品番/JAN"},{label:"売れ数",num:true},{label:"売上",num:true}],
      list.map((p,i)=>[num(i+1),esc(p.name),esc(p.sku||p.jan),num(p.qty),yen(p.sales)])
    );
  }

  function renderStores(stores){
    $("storeCompareTable").innerHTML=table(
      [{label:"店舗"},{label:"売上",num:true},{label:"売れ数",num:true},{label:"商品種類",num:true},{label:"平均単価",num:true}],
      stores.map(s=>[esc(s.key),yen(s.sales),num(s.qty),num(s.productCount),yen(s.qty?s.sales/s.qty:0)])
    );
  }

  function renderShelves(records){
    const shelves=C.aggregateBy(records,"shelf").sort((a,b)=>b.sales-a.sales);
    $("shelfTable").innerHTML=table(
      [{label:"棚番号"},{label:"売上",num:true},{label:"売れ数",num:true},{label:"商品種類",num:true}],
      shelves.map(s=>[esc(s.key),yen(s.sales),num(s.qty),num(s.productCount)])
    );
  }

  function renderABC(records){
    const list=C.abcAnalysis(records).slice(0,500);
    $("abcTable").innerHTML=table(
      [{label:"ランク"},{label:"商品"},{label:"売上",num:true},{label:"構成比",num:true},{label:"累計",num:true}],
      list.map(p=>[`<span class="badge badge-${p.rank.toLowerCase()}">${p.rank}</span>`,esc(p.name),yen(p.sales),pct(p.share),pct(p.cumulative)])
    );
  }

  function renderStock(products){
    const list=products.filter(p=>p.hasStock).sort((a,b)=>a.stock-b.stock);
    $("stockTable").innerHTML=table(
      [{label:"JAN"},{label:"品番"},{label:"商品名"},{label:"在庫",num:true},{label:"売れ数",num:true}],
      list.map(p=>[esc(p.jan),esc(p.sku),esc(p.name),num(p.stock),num(p.qty)])
    );
  }

  function comparePeriods(){
    const store=$("storeFilter").value;
    const result=C.comparePeriods(state.records,
      {from:$("periodAFrom").value,to:$("periodATo").value,store},
      {from:$("periodBFrom").value,to:$("periodBTo").value,store});
    $("periodCompare").innerHTML=table(
      [{label:"指標"},{label:"期間A",num:true},{label:"期間B",num:true},{label:"A-B 増減",num:true}],
      [
        ["売上",yen(result.a.sales),yen(result.b.sales),pct(result.delta.sales)],
        ["売れ数",num(result.a.qty),num(result.b.qty),pct(result.delta.qty)],
        ["商品種類",num(result.a.productCount),num(result.b.productCount),pct(result.delta.productCount)],
        ["平均単価",yen(result.a.avgPrice),yen(result.b.avgPrice),pct(result.delta.avgPrice)]
      ]);
  }

  function updateStatus(message){
    if(message){$("syncStatus").textContent=message;return;}
    const raw=localStorage.getItem(STORAGE.synced);
    $("syncStatus").textContent=raw?`最終同期 ${new Date(raw).toLocaleString("ja-JP")}`:"未同期";
  }

  async function fetchStore(store){
    const url=C.sheetUrlToCsv(store.url,store.sheet);
    const response=await fetch(url,{cache:"no-store"});
    if(!response.ok) throw new Error(`${store.name}: 読込失敗（${response.status}）`);
    const text=await response.text();
    if(/<!doctype html|<html/i.test(text)) throw new Error(`${store.name}: シートの共有設定またはURLを確認してください。`);
    const rows=C.parseCSV(text);
    return C.rowsToRecords(rows,state.config.mapping,store.name);
  }

  async function syncAll(){
    if(!state.config.stores.length){openSettings();return;}
    $("refreshBtn").disabled=true;updateStatus("同期中…");
    try{
      const settled=await Promise.allSettled(state.config.stores.map(fetchStore));
      const good=settled.filter(x=>x.status==="fulfilled").flatMap(x=>x.value);
      const errors=settled.filter(x=>x.status==="rejected").map(x=>x.reason.message);
      if(!good.length) throw new Error(errors.join("\n")||"データを取得できませんでした。");
      state.records=good;state.filtered=[...good];saveState();renderAll();
      updateStatus(errors.length?`一部失敗（${errors.length}店舗）`:`${good.length}行 同期完了`);
      if(errors.length) alert(errors.join("\n"));
    }catch(e){updateStatus("同期失敗");alert(e.message);}
    finally{$("refreshBtn").disabled=false;}
  }

  function addStoreRow(data={}){
    const node=$("storeRowTemplate").content.firstElementChild.cloneNode(true);
    node.querySelector(".store-name").value=data.name||"";
    node.querySelector(".store-url").value=data.url||"";
    node.querySelector(".store-sheet").value=data.sheet||"";
    node.querySelector(".remove-store").addEventListener("click",()=>node.remove());
    $("storeRows").appendChild(node);
  }

  function openSettings(){
    $("storeRows").innerHTML="";
    (state.config.stores.length?state.config.stores:[{}]).forEach(addStoreRow);
    const m=state.config.mapping;
    Object.keys(defaultMapping).forEach(k=>{const el=$(`map${k[0].toUpperCase()+k.slice(1)}`);if(el)el.value=m[k]||"";});
    $("settingsMessage").textContent="";
    $("settingsDialog").showModal();
  }

  function collectSettings(){
    const stores=[...document.querySelectorAll(".store-row")].map(row=>({
      name:row.querySelector(".store-name").value.trim(),
      url:row.querySelector(".store-url").value.trim(),
      sheet:row.querySelector(".store-sheet").value.trim()
    })).filter(x=>x.name&&x.url);
    const mapping={};
    Object.keys(defaultMapping).forEach(k=>{const el=$(`map${k[0].toUpperCase()+k.slice(1)}`);mapping[k]=el?el.value.trim():"";});
    return {stores,mapping};
  }

  function loadDemo(){
    const csv=`4570016338931,TG383BKWH,1,3990,東大阪店,2026/08/03,,ストレッチコロン ブラック×ホワイト
4570016339273,KM146FBKG,1,2200,東大阪店,2026/08/03,,フィットネスサンダル ブラック
4570016339242,KG098BLK,1,5500,名古屋店,2026/08/03,,フィットネスボクシンググローブ
4570016370894,BK098BK,2,3980,江坂店,2026/08/04,,トレーニングバッグ
4570016371112,TG161MBKB,1,1990,東大阪店,2026/08/04,,トレーニンググローブ
4570016375707,KG100108BL,1,11000,名古屋店,2026/08/05,,ボクシンググローブ
4570016338107,MM091LBLK,1,990,東大阪店,2026/08/05,,ボクサーパンツ
4570016338003,MM092XLBLK,1,990,江坂店,2026/08/05,,ボクサーパンツ`;
    state.records=C.rowsToRecords(C.parseCSV(csv),defaultMapping,"デモ店");
    state.filtered=[...state.records];saveState();renderAll();$("settingsDialog").close();
  }

  function bind(){
    $("refreshBtn").addEventListener("click",syncAll);
    $("settingsBtn").addEventListener("click",openSettings);
    $("applyFilterBtn").addEventListener("click",applyFilter);
    $("clearFilterBtn").addEventListener("click",()=>{$("dateFrom").value="";$("dateTo").value="";applyFilter();});
    $("productSearch").addEventListener("input",()=>renderProducts(C.aggregateProducts(state.filtered).sort((a,b)=>b.sales-a.sales)));
    $("rankingType").addEventListener("change",()=>renderRanking(C.aggregateProducts(state.filtered)));
    $("comparePeriodsBtn").addEventListener("click",comparePeriods);
    $("addStoreBtn").addEventListener("click",()=>addStoreRow());
    $("loadDemoBtn").addEventListener("click",loadDemo);
    $("saveSettingsBtn").addEventListener("click",async()=>{
      state.config=collectSettings();
      localStorage.setItem(STORAGE.config,JSON.stringify(state.config));
      if(!state.config.stores.length){$("settingsMessage").textContent="店舗名とURLを入力してください。";return;}
      $("settingsDialog").close();await syncAll();
    });
    document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{
      document.querySelectorAll(".tab,.tab-panel").forEach(x=>x.classList.remove("active"));
      btn.classList.add("active");$(btn.dataset.tab).classList.add("active");
    }));
  }

  loadState();bind();renderAll();
  if(!state.config.stores.length&&!state.records.length) openSettings();
})();
