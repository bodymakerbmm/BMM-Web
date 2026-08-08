(function(root,factory){
  if(typeof module==="object"&&module.exports){module.exports=factory();}
  else{root.BMMCore=factory();}
})(typeof self!=="undefined"?self:this,function(){
  "use strict";

  const EXCLUDED_SHELVES = new Set();
  const SALES_SCHEMA = Object.freeze({headerRow:-1,jan:"A",sku:"B",qty:"C",sales:"D",store:"E",date:"F",shelf:null,name:null});

  function normalizeText(value){
    return String(value??"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();
  }

  function localToday(date=new Date()){
    const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,"0"),d=String(date.getDate()).padStart(2,"0");
    return `${y}-${m}-${d}`;
  }

  function parseNumber(value){
    if(typeof value==="number") return Number.isFinite(value)?value:0;
    const cleaned=String(value??"").normalize("NFKC").replace(/[¥￥,\s]/g,"").replace(/[^\d.\-]/g,"");
    if(!cleaned||cleaned==="-"||cleaned===".") return 0;
    const n=Number(cleaned);
    return Number.isFinite(n)?n:0;
  }

  function parseStrictNumber(value){
    if(typeof value==="number") return Number.isFinite(value)?value:NaN;
    const cleaned=String(value??"").normalize("NFKC").replace(/[¥￥,\s]/g,"");
    if(!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return NaN;
    const n=Number(cleaned);return Number.isFinite(n)?n:NaN;
  }

  function normalizeCode(value){
    if(value===null||value===undefined) return "";
    if(typeof value==="number"){
      if(!Number.isFinite(value)) return "";
      if(Number.isSafeInteger(value)) return String(value);
      return "";
    }
    let s=String(value).normalize("NFKC").trim();
    if(!s) return "";
    if(/^\d+(?:\.0+)?$/.test(s)) return s.replace(/\.0+$/,"");
    if(/^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(s)){
      const mantissa=s.split(/[eE]/)[0].replace(".","").replace(/^0+/,"");
      if(mantissa.length<12) return ""; // truncated scientific notation cannot safely recover a JAN/UPC.
      const n=Number(s);
      return Number.isSafeInteger(n)?String(Math.trunc(n)):"";
    }
    return s.replace(/\.0$/,"");
  }

  function parseDate(value){
    if(value instanceof Date&&!Number.isNaN(value.getTime())) return localToday(value);
    let s=String(value??"").normalize("NFKC").trim();
    if(!s) return "";
    s=s.replace(/[年月.]/g,"/").replace(/日/g,"").replace(/-/g,"/");
    let m=s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if(!m){
      m=s.match(/^(\d{4})(\d{2})(\d{2})$/);
      if(m) return validYmd(+m[1],+m[2],+m[3]);
      return ""; // no permissive new Date(string) fallback: avoids "48" becoming year 2048.
    }
    return validYmd(+m[1],+m[2],+m[3]);
  }

  function validYmd(y,m,d){
    if(y<2000||y>2100||m<1||m>12||d<1||d>31) return "";
    const dt=new Date(y,m-1,d);
    if(dt.getFullYear()!==y||dt.getMonth()!==m-1||dt.getDate()!==d) return "";
    return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  function isDateInAllowedRange(date,today=localToday(),pastYears=10,futureDays=0){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||""))) return false;
    const t=parseDate(today); if(!t) return false;
    const [ty,tm,td]=t.split("-").map(Number);
    const min=new Date(ty-pastYears,tm-1,td),max=new Date(ty,tm-1,td+futureDays),x=new Date(`${date}T12:00:00`);
    return x>=min&&x<=max;
  }

  function parseCSV(text){
    const rows=[];let row=[],cell="",quoted=false;
    const src=String(text||"").replace(/^\uFEFF/,"");
    for(let i=0;i<src.length;i++){
      const ch=src[i];
      if(quoted){
        if(ch==='"'&&src[i+1]==='"'){cell+='"';i++;}
        else if(ch==='"'){quoted=false;}
        else cell+=ch;
      }else{
        if(ch==='"') quoted=true;
        else if(ch===','){row.push(cell);cell="";}
        else if(ch==='\n'){row.push(cell);rows.push(row);row=[];cell="";}
        else if(ch!=='\r') cell+=ch;
      }
    }
    if(cell!==""||row.length){row.push(cell);rows.push(row);}
    return rows.filter(r=>r.some(v=>String(v??"").trim()!==""));
  }

  function colToIndex(value){
    if(value===null||value===undefined||value==="") return -1;
    const text=String(value).trim().toUpperCase();
    if(/^\d+$/.test(text)) return Math.max(0,Number(text)-1);
    let n=0;
    for(const ch of text){if(ch<"A"||ch>"Z")return -1;n=n*26+(ch.charCodeAt(0)-64);}
    return n-1;
  }

  function indexToCol(index){
    if(index<0)return "";let n=index+1,text="";
    while(n>0){const rem=(n-1)%26;text=String.fromCharCode(65+rem)+text;n=Math.floor((n-1)/26);}return text;
  }

  function sheetUrlToCsv(url){
    const text=String(url||"").trim();
    const idMatch=text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if(!idMatch) throw new Error("GoogleスプレッドシートURLを確認してください。");
    const gidMatch=text.match(/[?&#]gid=(\d+)/);
    const params=new URLSearchParams({tqx:"out:csv",headers:"0",_:""+Date.now()});
    if(gidMatch)params.set("gid",gidMatch[1]);
    return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/gviz/tq?${params.toString()}`;
  }

  function detectSalesMapping(rows){
    // Verified against all three supplied public store sheets on 2026-08-08.
    // A=JAN / B=品番 / C=数量 / D=売上 / E=店舗 / F=日付 / G/H=未使用。商品名は共通商品マスタからJAN一致で取得。
    return {...SALES_SCHEMA};
  }

  function isOptionalSalesHeader(row){
    const a=normalizeText(row?.[0]),b=normalizeText(row?.[1]),c=normalizeText(row?.[2]),d=normalizeText(row?.[3]);
    return a.includes("jan")||a.includes("バーコード")||b.includes("品番")||c.includes("数量")||d.includes("売上");
  }

  function rowsToRecords(rows,mapping=SALES_SCHEMA,configuredStore){
    const ix={};for(const k of ["jan","sku","qty","sales","store","date","shelf","name"])ix[k]=colToIndex(mapping[k]);
    const source=(rows||[]).filter((row,i)=>!(i===0&&isOptionalSalesHeader(row)));
    return source.map((row,i)=>{
      const get=k=>ix[k]>=0?(row[ix[k]]??""):"";
      const rawJan=get("jan"),rawSku=get("sku"),rawQty=get("qty"),rawSales=get("sales"),rawStore=get("store"),rawDate=get("date");
      const hasCore=[rawJan,rawSku,rawQty,rawSales,rawStore,rawDate].some(v=>String(v??"").trim()!=="");
      return {
        jan:normalizeCode(rawJan),sku:String(rawSku).normalize("NFKC").trim(),name:"",
        qty:parseStrictNumber(rawQty),sales:parseStrictNumber(rawSales),
        store:String(rawStore).trim(),date:parseDate(rawDate),shelf:String(get("shelf")).trim(),stock:null,
        _row:i+1,_hasCore:hasCore
      };
    }).filter(r=>r._hasCore).map(({_hasCore,...r})=>r);
  }

  function inspectSalesRecords(records,configuredStore,today=localToday()){
    const valid=[],ignored=[],invalid=[];

    for(const r of records){
      const janOk=/^\d{8,14}$/.test(String(r.jan||""));
      const skuOk=Boolean(String(r.sku||"").trim());
      const qtyOk=Number.isFinite(r.qty) && r.qty>0 && Math.abs(r.qty)<=10000;
      const salesOk=Number.isFinite(r.sales) && Math.abs(r.sales)<=1000000000;
      const dateOk=Boolean(r.date) && isDateInAllowedRange(r.date,today,10,0);

      // 売上行の最低条件は「商品IDがある」「数量が1以上」。
      // 店舗名・日付だけが残った行は、parseNumber("")=0 の影響を受けず必ず無視する。
      if(!(janOk||skuOk) || !qtyOk){
        ignored.push(r);
        continue;
      }

      // 0円売上は正常。金額異常または日付異常だけ除外。
      if(!salesOk || !dateOk){
        const reasons=[];
        if(!salesOk) reasons.push("売上");
        if(!dateOk) reasons.push("日付");
        invalid.push({record:r,reasons});
        continue;
      }

      // URLが店舗を一意に決めるため、E列の表記差で同期を止めない。
      valid.push({...r,store:configuredStore||r.store});
    }

    return {
      ok:valid.length>0,
      valid,
      invalid,
      ignored,
      total:records.length,
      ratio:records.length?valid.length/records.length:0
    };
  }

  function isPlausibleSalesRecord(r,today=localToday()){
    return inspectSalesRecords([r],null,today).valid.length===1;
  }

  function validateSalesRecords(records,configuredStore,today=localToday()){
    return inspectSalesRecords(records,configuredStore,today);
  }

  function productKey(r){return r.jan||r.sku||r.name||`row-${r._row||""}`;}
  function recordKey(r){return [normalizeText(r.store),r.date||"",String(r._row||""),normalizeText(r.jan),normalizeText(r.sku)].join("|");}

  function filterRecords(records,filter={}){
    return records.filter(r=>{if(filter.store&&r.store!==filter.store)return false;if(filter.from&&(!r.date||r.date<filter.from))return false;if(filter.to&&(!r.date||r.date>filter.to))return false;return true;});
  }

  function aggregateProducts(records){
    const map=new Map();
    for(const r of records){
      const key=productKey(r);
      const x=map.get(key)||{key,jan:r.jan,sku:r.sku,name:r.name||"（商品名未登録）",qty:0,sales:0,stores:new Set()};
      x.qty+=r.qty;x.sales+=r.sales;x.stores.add(r.store);
      if((!x.name||x.name==="（商品名未登録）")&&r.name)x.name=r.name;
      map.set(key,x);
    }
    return [...map.values()].map(x=>({...x,stores:[...x.stores]}));
  }

  function aggregateBy(records,field){
    const map=new Map();
    for(const r of records){
      const key=String(r[field]||"未設定"),x=map.get(key)||{key,qty:0,sales:0,products:new Set(),rows:0};
      x.qty+=r.qty;x.sales+=r.sales;x.products.add(productKey(r));x.rows++;map.set(key,x);
    }
    return [...map.values()].map(x=>({...x,productCount:x.products.size,products:undefined}));
  }

  function kpis(records){
    const sales=records.reduce((s,r)=>s+r.sales,0),qty=records.reduce((s,r)=>s+r.qty,0);
    return {sales,qty,productCount:new Set(records.map(productKey)).size,avgPrice:qty?sales/qty:0};
  }

  function abcAnalysis(records){
    const products=aggregateProducts(records).sort((a,b)=>b.sales-a.sales),total=products.reduce((s,p)=>s+p.sales,0);let cum=0;
    return products.map(p=>{const share=total?p.sales/total:0;cum+=share;return {...p,share,cumulative:cum,rank:cum<=.7?"A":cum<=.9?"B":"C"};});
  }

  function comparePeriods(records,a,b){
    const A=kpis(filterRecords(records,a)),B=kpis(filterRecords(records,b));
    const d=(x,y)=>y===0?(x===0?0:null):(x-y)/y;
    return {a:A,b:B,delta:{sales:d(A.sales,B.sales),qty:d(A.qty,B.qty),productCount:d(A.productCount,B.productCount),avgPrice:d(A.avgPrice,B.avgPrice)}};
  }

  function matchesSearch(r,q){
    const terms=normalizeText(q).split(" ").filter(Boolean);if(!terms.length)return true;
    const hay=normalizeText([r.jan,r.sku,r.name].join(" "));return terms.every(t=>hay.includes(t));
  }

  function dataRange(records){
    const ds=records.map(r=>r.date).filter(Boolean).sort();return {from:ds[0]||"",to:ds[ds.length-1]||"",days:new Set(ds).size};
  }

  function cutoffDateForYears(referenceDate,years=3){
    const p=parseDate(referenceDate);if(!p)return "";const [y,m,d]=p.split("-").map(Number);
    const dt=new Date(y-years,m-1,d);
    if(dt.getMonth()!==m-1) dt.setDate(0);
    return localToday(dt);
  }

  function maxRecordDate(records){const ds=records.map(r=>r.date).filter(Boolean).sort();return ds[ds.length-1]||"";}

  // DAT1 format: 1,1,S001,DATE,TIME,SHELF,JAN,QTY
  function parseShelfText(text,storeName){
    return parseCSV(text).map((r,i)=>({
      store:storeName||String(r[2]||"").trim()||"未設定",storeCode:String(r[2]||"").trim(),date:parseDate(r[3]),time:String(r[4]||"").trim(),
      shelf:String(r[5]||"").trim(),jan:normalizeCode(r[6]),qty:parseNumber(r[7]),_line:i+1
    })).filter(r=>r.date&&/^\d{8,14}$/.test(r.jan)&&r.shelf&&r.qty!==0);
  }

  function shelfRowKey(r){return [normalizeText(r.store),r.date,r.time,normalizeText(r.shelf),normalizeText(r.jan),r._line||""].join("|");}

  function parseExcludedShelves(value){
    if(value instanceof Set)return new Set([...value].map(v=>String(v).trim()).filter(Boolean));
    if(Array.isArray(value))return new Set(value.map(v=>String(v).trim()).filter(Boolean));
    return new Set(String(value||"").normalize("NFKC").split(/[,\s、，]+/).map(v=>v.trim()).filter(Boolean));
  }

  function allocateShelfSales(salesRecords,shelfRows,exclude=EXCLUDED_SHELVES){
    exclude=parseExcludedShelves(exclude);
    const salesMap=new Map();
    for(const s of salesRecords){
      const key=[normalizeText(s.store),s.date,normalizeText(s.jan)].join("|"),x=salesMap.get(key)||{sales:0,qty:0,name:s.name,sku:s.sku};
      x.sales+=s.sales;x.qty+=s.qty;if(!x.name&&s.name)x.name=s.name;if(!x.sku&&s.sku)x.sku=s.sku;salesMap.set(key,x);
    }
    const shelfGroups=new Map();
    for(const r of shelfRows){
      const key=[normalizeText(r.store),r.date,normalizeText(r.jan)].join("|");if(!shelfGroups.has(key))shelfGroups.set(key,[]);shelfGroups.get(key).push(r);
    }
    const result=[];let matchedSales=0,totalSales=salesRecords.reduce((s,r)=>s+r.sales,0);
    for(const [key,allRows] of shelfGroups){
      const sale=salesMap.get(key);if(!sale)continue;
      const allQty=allRows.reduce((s,r)=>s+r.qty,0);if(!allQty)continue;
      const included=allRows.filter(r=>!exclude.has(String(r.shelf)));
      const includedQty=included.reduce((s,r)=>s+r.qty,0);
      if(!includedQty)continue;
      const includedSales=sale.sales*(includedQty/allQty);matchedSales+=includedSales;
      for(const r of included){
        result.push({store:r.store,date:r.date,shelf:r.shelf,jan:r.jan,sku:sale.sku,name:sale.name,qty:r.qty,sales:sale.sales*(r.qty/allQty)});
      }
    }
    return {records:result,matchedSales,totalSales,coverage:totalSales?matchedSales/totalSales:0};
  }

  function findHeaderRow(rows,requiredGroups,limit=15){
    for(let r=0;r<Math.min(rows.length,limit);r++){
      const cells=(rows[r]||[]).map(normalizeText);let hits=0;
      for(const group of requiredGroups){if(cells.some(v=>group.some(t=>v===normalizeText(t)||v.includes(normalizeText(t)))))hits++;}
      if(hits>=requiredGroups.length)return r;
    }
    return -1;
  }

  function findHeaderIndex(headers,terms,{exactFirst=true}={}){
    const h=headers.map(normalizeText),norm=terms.map(normalizeText);
    if(exactFirst){for(const t of norm){const i=h.findIndex(v=>v===t);if(i>=0)return i;}}
    for(const t of norm){const i=h.findIndex(v=>v.includes(t));if(i>=0)return i;}return -1;
  }

  function detectMasterLayout(rows){
    const hr=findHeaderRow(rows,[["upcコード","jan"],["外部id","頭品番","品番"],["表示名","商品名","品名","名前"]],20);
    const header=(rows[hr>=0?hr:0]||[]).map(v=>String(v??""));
    return {
      headerRow:hr>=0?hr:0,
      jan:findHeaderIndex(header,["UPCコード","JAN","バーコード"]),
      sku:findHeaderIndex(header,["外部ID","品番","頭品番","商品コード"]),
      name:findHeaderIndex(header,["表示名","商品名","品名","名前"]),
      price:findHeaderIndex(header,["オンライン価格","価格"]),
      category:findHeaderIndex(header,["商品分類"])
    };
  }

  function masterRowsToRecords(rows){
    const m=detectMasterLayout(rows),src=rows.slice(m.headerRow+1),out=[];
    for(const row of src){
      const jan=m.jan>=0?normalizeCode(row[m.jan]):"",sku=m.sku>=0?String(row[m.sku]??"").normalize("NFKC").trim():"",name=m.name>=0?String(row[m.name]??"").trim():"";
      if(!(jan||sku||name))continue;
      out.push({jan,sku,name,price:m.price>=0?parseNumber(row[m.price]):0,category:m.category>=0?String(row[m.category]??"").trim():""});
    }
    return out;
  }

  function buildMasterIndex(records){
    const byJan=new Map(),bySku=new Map();for(const r of records){if(r.jan)byJan.set(normalizeText(r.jan),r);if(r.sku)bySku.set(normalizeText(r.sku),r);}return {byJan,bySku};
  }

  function enrichWithMaster(records,index){
    // 商品名は売上シートから取得せず、JANコードが一致する共通商品マスタのみを正とする。
    if(!index) return records.map(r=>({...r,name:""}));
    return records.map(r=>{
      const m=r.jan ? index.byJan.get(normalizeText(r.jan)) : null;
      if(!m) return {...r,name:""};
      return {...r,name:m.name||"",sku:r.sku||m.sku,jan:r.jan||m.jan};
    });
  }

  function inferDateFromFilename(name){
    const s=String(name||"");let m=s.match(/(20\d{2})[^\d]?(\d{2})[^\d]?(\d{2})/);return m?validYmd(+m[1],+m[2],+m[3]):"";
  }

  function detectInventoryLayout(rows,configuredStores=[]){
    let hr=-1;
    for(let r=0;r<Math.min(rows.length,20);r++){
      const h=(rows[r]||[]).map(normalizeText);if(h.some(v=>v==="jan"||v.includes("jan"))&&h.some(v=>v.includes("品番"))&&h.some(v=>v.includes("品名"))){hr=r;break;}
    }
    if(hr<0)return {headerRow:-1,jan:-1,sku:-1,name:-1,price:-1,storeCols:[]};
    const raw=rows[hr]||[],h=raw.map(normalizeText);
    const find=terms=>findHeaderIndex(raw,terms);
    const jan=find(["JAN"]),sku=find(["品番"]),name=find(["品名","商品名"]),price=find(["オンライン価格","オンライン"]),parent=find(["親コード"]);
    const known=new Set([jan,sku,name,price,parent].filter(i=>i>=0)),storeCols=[];
    for(let i=0;i<raw.length;i++){
      if(known.has(i))continue;const label=String(raw[i]??"").trim();if(!label)continue;
      if(label.includes("店")||configuredStores.some(s=>normalizeText(label)===normalizeText(s)))storeCols.push({index:i,name:label});
    }
    return {headerRow:hr,jan,sku,name,price,storeCols};
  }

  function inventoryRowsToRecords(rows,snapshotDate,configuredStores=[]){
    const date=parseDate(snapshotDate),m=detectInventoryLayout(rows,configuredStores);
    if(!date)throw new Error("在庫基準日を確認してください。");
    if(m.headerRow<0||m.jan<0||!m.storeCols.length)throw new Error("在庫ExcelのJAN列または店舗列を判定できません。");
    const out=[];
    for(const row of rows.slice(m.headerRow+1)){
      const jan=normalizeCode(row[m.jan]),sku=m.sku>=0?String(row[m.sku]??"").normalize("NFKC").trim():"",name=m.name>=0?String(row[m.name]??"").trim():"";
      if(!jan&&!sku)continue;
      for(const c of m.storeCols){out.push({snapshotDate:date,store:c.name,jan,sku,name,stock:parseNumber(row[c.index]),price:m.price>=0?parseNumber(row[m.price]):0});}
    }
    return out;
  }

  function stockRowKey(r){return [r.snapshotDate,normalizeText(r.store),normalizeText(r.jan||r.sku)].join("|");}
  function latestSnapshotDate(rows){return rows.map(r=>r.snapshotDate).filter(Boolean).sort().pop()||"";}

  return {
    EXCLUDED_SHELVES,SALES_SCHEMA,normalizeText,localToday,parseNumber,parseStrictNumber,normalizeCode,parseDate,isDateInAllowedRange,parseCSV,colToIndex,indexToCol,
    sheetUrlToCsv,detectSalesMapping,rowsToRecords,inspectSalesRecords,isPlausibleSalesRecord,validateSalesRecords,productKey,recordKey,
    filterRecords,aggregateProducts,aggregateBy,kpis,abcAnalysis,comparePeriods,matchesSearch,dataRange,cutoffDateForYears,maxRecordDate,
    parseShelfText,shelfRowKey,parseExcludedShelves,allocateShelfSales,detectMasterLayout,masterRowsToRecords,buildMasterIndex,enrichWithMaster,
    inferDateFromFilename,detectInventoryLayout,inventoryRowsToRecords,stockRowKey,latestSnapshotDate
  };
});
