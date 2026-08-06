(() => {
  "use strict";
  const C = window.BMMCore;
  const STORAGE = {
    config: "bmm-web-config-v1",
    oldRecordsV1: "bmm-web-records-v1",
    oldRecordsV2: "bmm-web-records-v2"
  };
  const defaultMapping = {jan:"A",sku:"B",qty:"C",sales:"D",store:"E",date:"F",shelf:"",name:"H",stock:""};
  let state = {config:{stores:[],mapping:{...defaultMapping}},records:[],filtered:[],syncLog:[],lastSynced:""};

  const $ = id => document.getElementById(id);
  const yen = n => new Intl.NumberFormat("ja-JP",{style:"currency",currency:"JPY",maximumFractionDigits:0}).format(n||0);
  const num = n => new Intl.NumberFormat("ja-JP").format(n||0);
  const pct = n => n===null?"—":`${(n*100).toFixed(1)}%`;
  const esc = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  async function loadState(){
    try{
      state.config=await BMMDB.getMeta("config")||JSON.parse(localStorage.getItem(STORAGE.config))||state.config;
    }catch(_){
      state.config=state.config;
    }
    state.config.mapping={...defaultMapping,...(state.config.mapping||{})};

    state.records=await BMMDB.getAll(BMMDB.stores.records);
    state.syncLog=await BMMDB.getSyncLog();
    state.lastSynced=await BMMDB.getMeta("lastSynced")||"";

    if(!state.records.length){
      let legacy=[];
      try{legacy=JSON.parse(localStorage.getItem(STORAGE.oldRecordsV2))||[];}catch(_){}
      if(!legacy.length){
        try{legacy=JSON.parse(localStorage.getItem(STORAGE.oldRecordsV1))||[];}catch(_){}
      }
      if(legacy.length){
        const groups=new Map();
        legacy.forEach(r=>{
          const key=r.store||"未設定";
          if(!groups.has(key)) groups.set(key,[]);
          groups.get(key).push(r);
        });
        for(const [store,records] of groups){
          await BMMDB.replaceStoreDates(store,records);
        }
        state.records=await BMMDB.getAll(BMMDB.stores.records);
      }
    }
    state.filtered=[...state.records];
  }

  async function saveConfig(){
    localStorage.setItem(STORAGE.config,JSON.stringify(state.config));
    await BMMDB.setMeta("config",state.config);
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
    renderHistory();
    $("setupNotice").hidden=state.config.stores.length>0||state.records.length>0;
    updateStatus();
  }

  function renderDaily(records){
    const daily=C.aggregateBy(records,"date").filter(x=>x.key!=="未設定").sort((a,b)=>a.key.localeCompare(b.key));
    const max=Math.max(1,...daily.map(x=>x.sales));
    $("dailyTrend").innerHTML=daily.map(d=>`<div class="bar-item" title="${esc(d.key)} ${yen(d.sales)}"><div class="bar" style="height:${Math.max(2,d.sales/max*150)}px"></div><span class="bar-label">${esc(d.key.slice(5))}</span></div>`).join("")||'<div class="empty">日付データがありません。</div>';
  }

  function renderProducts(products){
    const q=$("productSearch").value;
    const list=products.filter(p=>C.matchesSearch(p,q)).slice(0,500);
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

  function renderHistory(){
    const range=C.dataRange(state.records);
    const stores=C.aggregateBy(state.records,"store").sort((a,b)=>a.key.localeCompare(b.key));
    $("historySummary").innerHTML=`
      <div class="history-stat"><span>保存期間</span><strong>${range.from||"未保存"} ～ ${range.to||"未保存"}</strong></div>
      <div class="history-stat"><span>保存日数</span><strong>${num(range.days)}日</strong></div>
      <div class="history-stat"><span>保存行数</span><strong>${num(state.records.length)}行</strong></div>
      <div class="history-stat"><span>店舗数</span><strong>${num(stores.length)}店舗</strong></div>
    `;
    $("syncLogTable").innerHTML=table(
      [{label:"同期日時"},{label:"店舗"},{label:"対象期間"},{label:"取得行数",num:true}],
      state.syncLog.map(log=>[
        esc(new Date(log.syncedAt).toLocaleString("ja-JP")),
        esc(log.store),
        esc(`${log.from||"日付なし"} ～ ${log.to||"日付なし"}`),
        num(log.rows)
      ])
    );
  }

  async function exportHistory(){
    const payload={
      format:"BMM-Web-History",
      version:2,
      exportedAt:new Date().toISOString(),
      config:state.config,
      records:await BMMDB.getAll(BMMDB.stores.records),
      syncLog:await BMMDB.getSyncLog(),
      lastSynced:state.lastSynced
    };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`BMM履歴バックアップ_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  async function importHistory(file){
    const payload=JSON.parse(await file.text());
    if(payload?.format!=="BMM-Web-History"||!Array.isArray(payload.records)){
      throw new Error("BMM Webの履歴バックアップではありません。");
    }
    if(!confirm(`保存履歴 ${payload.records.length}行を復元します。現在の履歴は置き換わります。よろしいですか？`)) return;
    await BMMDB.importAll(payload);
    await loadState();
    renderAll();
    alert("履歴を復元しました。");
  }

  function updateStatus(message){
    if(message){$("syncStatus").textContent=message;return;}
    $("syncStatus").textContent=state.lastSynced
      ? `最終同期 ${new Date(state.lastSynced).toLocaleString("ja-JP")}`
      : "未同期";
  }

  async function fetchCsvRows(sourceUrl,label){
    const url=C.sheetUrlToCsv(sourceUrl,"");
    const response=await fetch(url,{cache:"no-store"});
    if(!response.ok) throw new Error(`${label}: 読込失敗（${response.status}）`);
    const text=await response.text();
    if(/<!doctype html|<html/i.test(text)) throw new Error(`${label}: 共有設定またはURLを確認してください。`);
    return C.parseCSV(text);
  }

  async function loadCommonMasterIndex(){
    const url=String(state.config.commonMasterUrl||"").trim();
    if(!url) return null;
    const masterRows=await fetchCsvRows(url,"共通商品マスタ");
    const masterMapping=C.detectMasterMapping(masterRows);
    return C.buildMasterIndex(masterRows,masterMapping);
  }

  async function fetchStore(store,masterIndex){
    const salesRows=await fetchCsvRows(store.url,`${store.name} 売上`);
    const detected=C.detectSalesMapping(salesRows);
    const mapping={...detected,...Object.fromEntries(Object.entries(state.config.mapping||{}).filter(([,v])=>String(v||"").trim()))};
    let records=C.rowsToRecords(salesRows,mapping,store.name);
    const validation=C.validateSalesRecords(records);
    if(!validation.ok){
      throw new Error(`${store.name}: 売上タブを判定できません。売上データのタブを開いた状態でURLをコピーしてください。`);
    }
    records=validation.valid;
    if(masterIndex){
      records=C.enrichWithMaster(records,masterIndex);
    }
    return {records,mapping,hasNames:records.some(r=>String(r.name||"").trim())};
  }

  async function syncAll(options={}){
    const silent=Boolean(options.silent);
    if(!state.config.stores.length){
      if(!silent) openSettings();
      updateStatus("店舗設定が必要です");
      return;
    }

    $("refreshBtn").disabled=true;
    updateStatus(silent?"自動更新中…":"同期中…");

    try{
      let masterIndex=null;
      try{
        masterIndex=await loadCommonMasterIndex();
      }catch(masterError){
        if(!silent) alert(masterError.message);
        else console.error(masterError);
      }
      const settled=await Promise.allSettled(
        state.config.stores.map(store=>fetchStore(store,masterIndex))
      );
      const errors=[];
      let totalRows=0;

      for(let i=0;i<settled.length;i++){
        const result=settled[i];
        const store=state.config.stores[i];
        if(result.status==="rejected"){
          errors.push(result.reason.message);
          continue;
        }
        const payload=result.value;
        const rows=payload.records;
        await BMMDB.replaceStoreDates(store.name,rows);
        const range=C.dataRange(rows);
        await BMMDB.addSyncLog({
          syncedAt:new Date().toISOString(),
          store:store.name,
          from:range.from,
          to:range.to,
          rows:rows.length
        });
        totalRows+=rows.length;
      }

      if(!totalRows) throw new Error(errors.join("\n")||"データを取得できませんでした。");

      const newest=await BMMDB.getAll(BMMDB.stores.records);
      const reference=C.maxRecordDate(newest)||new Date().toISOString().slice(0,10);
      const cutoff=C.cutoffDateForYears(reference,3);
      const deleted=await BMMDB.pruneBefore(cutoff);

      state.lastSynced=new Date().toISOString();
      await BMMDB.setMeta("lastSynced",state.lastSynced);
      await loadState();
      renderAll();

      updateStatus(
        errors.length
          ? `一部失敗（${errors.length}店舗）`
          : `${totalRows}行更新${deleted?`・古い${deleted}行整理`:""}`
      );

      if(errors.length&&!silent) alert(errors.join("\n"));
    }catch(e){
      updateStatus("更新失敗");
      if(!silent) alert(e.message);
      else console.error(e);
    }finally{
      $("refreshBtn").disabled=false;
    }
  }

  function addStoreRow(data={}){
    const node=$("storeRowTemplate").content.firstElementChild.cloneNode(true);
    node.querySelector(".store-name").value=data.name||"";
    node.querySelector(".store-url").value=data.url||"";
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
      url:row.querySelector(".store-url").value.trim()
    })).filter(x=>x.name&&x.url);
    const mapping={};
    Object.keys(defaultMapping).forEach(k=>{const el=$(`map${k[0].toUpperCase()+k.slice(1)}`);mapping[k]=el?el.value.trim():"";});
    return {
      ...state.config,
      stores,
      mapping,
      commonMasterUrl:String(state.config.commonMasterUrl||"").trim()
    };
  }

  function openCommonData(){
    $("commonMasterUrl").value=state.config.commonMasterUrl||"";
    $("commonDataMessage").textContent="";
    $("commonDataDialog").showModal();
  }

  async function saveCommonMaster(){
    state.config.commonMasterUrl=$("commonMasterUrl").value.trim();
    await saveConfig();
    $("commonDataDialog").close();
    await syncAll();
  }

  async function clearCommonMaster(){
    state.config.commonMasterUrl="";
    await saveConfig();
    $("commonMasterUrl").value="";
    $("commonDataMessage").textContent="共通商品マスタの登録を解除しました。";
  }

  async function loadDemo(){
    const csv=`4570016338931,TG383BKWH,1,3990,東大阪店,2026/08/03,,ストレッチコロン ブラック×ホワイト
4570016339273,KM146FBKG,1,2200,東大阪店,2026/08/03,,フィットネスサンダル ブラック
4570016339242,KG098BLK,1,5500,名古屋店,2026/08/03,,フィットネスボクシンググローブ
4570016370894,BK098BK,2,3980,江坂店,2026/08/04,,トレーニングバッグ
4570016371112,TG161MBKB,1,1990,東大阪店,2026/08/04,,トレーニンググローブ
4570016375707,KG100108BL,1,11000,名古屋店,2026/08/05,,ボクシンググローブ
4570016338107,MM091LBLK,1,990,東大阪店,2026/08/05,,ボクサーパンツ
4570016338003,MM092XLBLK,1,990,江坂店,2026/08/05,,ボクサーパンツ`;
    const demo=C.rowsToRecords(C.parseCSV(csv),defaultMapping,"デモ店");
    for(const store of ["東大阪店","名古屋店","江坂店"]){
      const rows=demo.filter(r=>r.store===store);
      await BMMDB.replaceStoreDates(store,rows);
    }
    await BMMDB.addSyncLog({syncedAt:new Date().toISOString(),store:"デモデータ",from:"2026-08-03",to:"2026-08-05",rows:demo.length});
    state.lastSynced=new Date().toISOString();
    await BMMDB.setMeta("lastSynced",state.lastSynced);
    await loadState();renderAll();$("settingsDialog").close();
  }

  function bind(){
    $("refreshBtn").addEventListener("click",syncAll);
    $("commonDataBtn").addEventListener("click",openCommonData);
    $("settingsBtn").addEventListener("click",openSettings);
    $("saveCommonMasterBtn").addEventListener("click",saveCommonMaster);
    $("clearCommonMasterBtn").addEventListener("click",clearCommonMaster);
    $("applyFilterBtn").addEventListener("click",applyFilter);
    $("clearFilterBtn").addEventListener("click",()=>{$("dateFrom").value="";$("dateTo").value="";applyFilter();});
    $("productSearch").addEventListener("input",()=>renderProducts(C.aggregateProducts(state.filtered).sort((a,b)=>b.sales-a.sales)));
    $("rankingType").addEventListener("change",()=>renderRanking(C.aggregateProducts(state.filtered)));
    $("comparePeriodsBtn").addEventListener("click",comparePeriods);
    $("exportHistoryBtn").addEventListener("click",exportHistory);
    $("importHistoryInput").addEventListener("change",async e=>{
      const file=e.target.files?.[0];
      if(!file) return;
      try{await importHistory(file);}catch(err){alert(err.message);}
      e.target.value="";
    });
    $("addStoreBtn").addEventListener("click",()=>addStoreRow());
    $("loadDemoBtn").addEventListener("click",loadDemo);
    $("saveSettingsBtn").addEventListener("click",async()=>{
      state.config=collectSettings();
      await saveConfig();
      if(!state.config.stores.length){$("settingsMessage").textContent="店舗名とURLを入力してください。";return;}
      $("settingsDialog").close();await syncAll();
    });
    document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{
      document.querySelectorAll(".tab,.tab-panel").forEach(x=>x.classList.remove("active"));
      btn.classList.add("active");$(btn.dataset.tab).classList.add("active");
    }));
  }

  async function start(){
    await loadState();
    bind();
    renderAll();
    if(!state.config.stores.length&&!state.records.length){
      openSettings();
      return;
    }
    if(state.config.stores.length){
      await syncAll({silent:true});
    }
  }

  start().catch(err=>{
    console.error(err);
    updateStatus("起動エラー");
    alert(`BMM Webの起動に失敗しました。
${err.message}`);
  });
})();
