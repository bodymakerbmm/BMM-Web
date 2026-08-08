(function(root,factory){
  if(typeof module==="object"&&module.exports){module.exports=factory();}
  else{root.BMMCore=factory();}
})(typeof self!=="undefined"?self:this,function(){
  "use strict";

  const EXCLUDED_SHELVES = new Set();

  function normalizeText(value){
    return String(value??"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();
  }

  function parseNumber(value){
    if(typeof value==="number") return Number.isFinite(value)?value:0;
    const cleaned=String(value??"").normalize("NFKC").replace(/[¥￥,\s]/g,"").replace(/[^\d.\-]/g,"");
    const n=Number(cleaned);
    return Number.isFinite(n)?n:0;
  }

  function parseDate(value){
    if(value instanceof Date&&!Number.isNaN(value.getTime())) return value.toISOString().slice(0,10);
    let s=String(value??"").normalize("NFKC").trim();
    if(!s) return "";
    s=s.replace(/[年月.]/g,"/").replace(/日/g,"").replace(/-/g,"/");
    let m=s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if(m) return `${m[1]}-${String(+m[2]).padStart(2,"0")}-${String(+m[3]).padStart(2,"0")}`;
    m=s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    const d=new Date(value);
    return Number.isNaN(d.getTime())?"":d.toISOString().slice(0,10);
  }

  function parseCSV(text){
    const rows=[]; let row=[],cell="",quoted=false;
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
    for(const ch of text){
      if(ch<"A"||ch>"Z") return -1;
      n=n*26+(ch.charCodeAt(0)-64);
    }
    return n-1;
  }

  function indexToCol(index){
    if(index<0) return "";
    let n=index+1,text="";
    while(n>0){
      const rem=(n-1)%26;
      text=String.fromCharCode(65+rem)+text;
      n=Math.floor((n-1)/26);
    }
    return text;
  }

  function sheetUrlToCsv(url){
    const text=String(url||"").trim();
    const idMatch=text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if(!idMatch) throw new Error("GoogleスプレッドシートURLを確認してください。");
    const gidMatch=text.match(/[?&#]gid=(\d+)/);
    const params=new URLSearchParams({tqx:"out:csv",_:""+Date.now()});
    if(gidMatch) params.set("gid",gidMatch[1]);
    return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/gviz/tq?${params.toString()}`;
  }

  function cellScore(rows,index,test){
    const sample=rows.slice(0,Math.min(rows.length,80));
    let hit=0,total=0;
    for(const row of sample){
      const v=row[index];
      if(String(v??"").trim()==="") continue;
      total++;
      if(test(v)) hit++;
    }
    return total?hit/total:0;
  }

  function findHeaderRow(rows,terms,limit=12){
    for(let r=0;r<Math.min(rows.length,limit);r++){
      const cells=(rows[r]||[]).map(normalizeText);
      let hits=0;
      for(const group of terms){
        if(cells.some(v=>group.some(t=>v.includes(normalizeText(t))))) hits++;
      }
      if(hits>=Math.min(2,terms.length)) return r;
    }
    return -1;
  }

  function detectSalesMapping(rows){
    // BODYMAKER 売上シート実データ仕様（2026-08-08確認）
    // 1行目からデータ。ヘッダーなし。
    // A=JAN / B=品番 / C=数量 / D=売上金額 / E=店舗名 / F=日付 / G=未使用 / H=商品名
    // 自動推測は行わず、JANコードを売上金額として読む事故を防止する。
    return {
      headerRow:-1,
      jan:"A",
      sku:"B",
      qty:"C",
      sales:"D",
      store:"E",
      date:"F",
      shelf:null,
      name:"H"
    };
  }

  function rowsToRecords(rows,mapping,configuredStore){
    const headerRow=Number.isInteger(mapping.headerRow)?mapping.headerRow:-1;
    const source=headerRow>=0?rows.slice(headerRow+1):rows;
    const ix={};
    for(const k of ["jan","sku","qty","sales","store","date","shelf","name"]) ix[k]=colToIndex(mapping[k]);
    return source.map((row,i)=>{
      const get=k=>ix[k]>=0?(row[ix[k]]??""):"";
      const jan=String(get("jan")).replace(/\.0$/,"").trim();
      const sku=String(get("sku")).trim();
      return {
        jan, sku,
        name:String(get("name")).trim(),
        qty:parseNumber(get("qty")),
        sales:parseNumber(get("sales")),
        store:String(get("store")).trim()||configuredStore||"未設定",
        date:parseDate(get("date")),
        shelf:String(get("shelf")).trim(),
        stock:null,
        _row:i+1
      };
    }).filter(r=>r.jan||r.sku||r.sales||r.qty);
  }

  function isPlausibleSalesRecord(r){
    if(!r.date || !(r.jan||r.sku)) return false;
    if(!Number.isFinite(r.qty)||!Number.isFinite(r.sales)) return false;
    if(Math.abs(r.qty)>100000) return false;
    // 1行の売上が10億円を超える場合は列誤判定の可能性が極めて高い。
    if(Math.abs(r.sales)>1000000000) return false;
    return true;
  }

  function validateSalesRecords(records){
    const valid=records.filter(isPlausibleSalesRecord);
    return {ok:valid.length>0,valid};
  }

  function productKey(r){return r.jan||r.sku||r.name||`row-${r._row||""}`;}

  function recordKey(r){
    return [normalizeText(r.store),r.date||"",normalizeText(r.jan),normalizeText(r.sku),normalizeText(r.shelf),normalizeText(r.name)].join("|");
  }

  function filterRecords(records,filter={}){
    return records.filter(r=>{
      if(filter.store&&r.store!==filter.store) return false;
      if(filter.from&&(!r.date||r.date<filter.from)) return false;
      if(filter.to&&(!r.date||r.date>filter.to)) return false;
      return true;
    });
  }

  function aggregateProducts(records){
    const map=new Map();
    for(const r of records){
      const key=productKey(r);
      const x=map.get(key)||{key,jan:r.jan,sku:r.sku,name:r.name||r.sku||r.jan,qty:0,sales:0,stores:new Set()};
      x.qty+=r.qty;x.sales+=r.sales;x.stores.add(r.store);
      if(!x.name&&r.name)x.name=r.name;
      map.set(key,x);
    }
    return [...map.values()].map(x=>({...x,stores:[...x.stores]}));
  }

  function aggregateBy(records,field){
    const map=new Map();
    for(const r of records){
      const key=String(r[field]||"未設定");
      const x=map.get(key)||{key,qty:0,sales:0,products:new Set(),rows:0};
      x.qty+=r.qty;x.sales+=r.sales;x.products.add(productKey(r));x.rows++;
      map.set(key,x);
    }
    return [...map.values()].map(x=>({...x,productCount:x.products.size,products:undefined}));
  }

  function kpis(records){
    const sales=records.reduce((s,r)=>s+r.sales,0);
    const qty=records.reduce((s,r)=>s+r.qty,0);
    return {sales,qty,productCount:new Set(records.map(productKey)).size,avgPrice:qty?sales/qty:0};
  }

  function abcAnalysis(records){
    const products=aggregateProducts(records).sort((a,b)=>b.sales-a.sales);
    const total=products.reduce((s,p)=>s+p.sales,0);
    let cum=0;
    return products.map(p=>{
      const share=total?p.sales/total:0;cum+=share;
      return {...p,share,cumulative:cum,rank:cum<=.7?"A":cum<=.9?"B":"C"};
    });
  }

  function comparePeriods(records,a,b){
    const A=kpis(filterRecords(records,a)),B=kpis(filterRecords(records,b));
    const d=(x,y)=>y===0?(x===0?0:null):(x-y)/y;
    return {a:A,b:B,delta:{sales:d(A.sales,B.sales),qty:d(A.qty,B.qty),productCount:d(A.productCount,B.productCount),avgPrice:d(A.avgPrice,B.avgPrice)}};
  }

  function matchesSearch(r,q){
    const terms=normalizeText(q).split(" ").filter(Boolean);
    if(!terms.length) return true;
    const hay=normalizeText([r.jan,r.sku,r.name].join(" "));
    return terms.every(t=>hay.includes(t));
  }

  function dataRange(records){
    const ds=records.map(r=>r.date).filter(Boolean).sort();
    return {from:ds[0]||"",to:ds[ds.length-1]||"",days:new Set(ds).size};
  }

  function cutoffDateForYears(referenceDate,years=3){
    const d=new Date(`${referenceDate}T00:00:00`);
    d.setFullYear(d.getFullYear()-years);
    return d.toISOString().slice(0,10);
  }

  function maxRecordDate(records){
    const ds=records.map(r=>r.date).filter(Boolean).sort();
    return ds[ds.length-1]||"";
  }

  // DAT1: 1,1,S001,DATE,TIME,SHELF,JAN,QTY
  function parseShelfText(text,storeName){
    return parseCSV(text).map((r,i)=>({
      store:storeName||String(r[2]||"").trim()||"未設定",
      storeCode:String(r[2]||"").trim(),
      date:parseDate(r[3]),
      time:String(r[4]||"").trim(),
      shelf:String(r[5]||"").trim(),
      jan:String(r[6]||"").replace(/\.0$/,"").trim(),
      qty:parseNumber(r[7]),
      _line:i+1
    })).filter(r=>r.date&&r.jan&&r.shelf&&r.qty!==0);
  }

  function shelfRowKey(r){
    return [normalizeText(r.store),r.date,r.time,normalizeText(r.shelf),normalizeText(r.jan),r._line||""].join("|");
  }

  function parseExcludedShelves(value){
    if(value instanceof Set) return new Set([...value].map(v=>String(v).trim()).filter(Boolean));
    if(Array.isArray(value)) return new Set(value.map(v=>String(v).trim()).filter(Boolean));
    return new Set(String(value||"").normalize("NFKC").split(/[,\s、，]+/).map(v=>v.trim()).filter(Boolean));
  }

  function allocateShelfSales(salesRecords,shelfRows,exclude=EXCLUDED_SHELVES){
    exclude=parseExcludedShelves(exclude);
    const salesMap=new Map();
    for(const s of salesRecords){
      const key=[normalizeText(s.store),s.date,normalizeText(s.jan)].join("|");
      const x=salesMap.get(key)||{sales:0,qty:0,name:s.name,sku:s.sku};
      x.sales+=s.sales;x.qty+=s.qty;
      if(!x.name&&s.name)x.name=s.name;if(!x.sku&&s.sku)x.sku=s.sku;
      salesMap.set(key,x);
    }
    const shelfGroups=new Map();
    for(const r of shelfRows){
      if(exclude&&exclude.has(String(r.shelf))) continue;
      const key=[normalizeText(r.store),r.date,normalizeText(r.jan)].join("|");
      if(!shelfGroups.has(key)) shelfGroups.set(key,[]);
      shelfGroups.get(key).push(r);
    }
    const result=[];
    let matchedSales=0,totalSales=salesRecords.reduce((s,r)=>s+r.sales,0);
    for(const [key,rows] of shelfGroups){
      const sale=salesMap.get(key);
      if(!sale) continue;
      const totalShelfQty=rows.reduce((s,r)=>s+r.qty,0);
      if(!totalShelfQty) continue;
      matchedSales+=sale.sales;
      for(const r of rows){
        result.push({
          store:r.store,date:r.date,shelf:r.shelf,jan:r.jan,sku:sale.sku,name:sale.name,
          qty:r.qty,sales:sale.sales*(r.qty/totalShelfQty)
        });
      }
    }
    return {records:result,matchedSales,totalSales,coverage:totalSales?matchedSales/totalSales:0};
  }

  function detectMasterLayout(rows){
    const hr=findHeaderRow(rows,[["jan","upc","バーコード"],["品番","頭品番"],["商品名","品名","表示名","名前"]],15);
    const h=(rows[hr>=0?hr:0]||[]).map(normalizeText);
    const find=terms=>h.findIndex(v=>terms.some(t=>v.includes(normalizeText(t))));
    return {
      headerRow:hr>=0?hr:0,
      jan:find(["jan","upcコード","upc","バーコード"]),
      sku:find(["品番","頭品番","外部id","商品コード"]),
      name:find(["商品名","品名","表示名","名前"]),
      price:find(["オンライン価格","価格"]),
      category:find(["商品分類","分類"])
    };
  }

  function masterRowsToRecords(rows){
    const m=detectMasterLayout(rows), src=rows.slice(m.headerRow+1), out=[];
    for(const row of src){
      const jan=m.jan>=0?String(row[m.jan]??"").replace(/\.0$/,"").trim():"";
      const sku=m.sku>=0?String(row[m.sku]??"").trim():"";
      const name=m.name>=0?String(row[m.name]??"").trim():"";
      if(!(jan||sku||name)) continue;
      out.push({jan,sku,name,price:m.price>=0?parseNumber(row[m.price]):0,category:m.category>=0?String(row[m.category]??"").trim():""});
    }
    return out;
  }

  function buildMasterIndex(records){
    const byJan=new Map(),bySku=new Map();
    for(const r of records){
      if(r.jan)byJan.set(normalizeText(r.jan),r);
      if(r.sku)bySku.set(normalizeText(r.sku),r);
    }
    return {byJan,bySku};
  }

  function enrichWithMaster(records,index){
    if(!index) return records;
    return records.map(r=>{
      const m=(r.jan&&index.byJan.get(normalizeText(r.jan)))||(r.sku&&index.bySku.get(normalizeText(r.sku)));
      return m?{...r,name:r.name||m.name,sku:r.sku||m.sku,jan:r.jan||m.jan}:{...r};
    });
  }

  function inferDateFromFilename(name){
    const s=String(name||"");
    let m=s.match(/(20\d{2})[^\d]?(\d{2})[^\d]?(\d{2})/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    return "";
  }

  function detectInventoryLayout(rows,configuredStores=[]){
    let hr=-1;
    for(let r=0;r<Math.min(rows.length,12);r++){
      const h=(rows[r]||[]).map(normalizeText);
      if(h.some(v=>v==="jan"||v.includes("jan"))&&h.some(v=>v.includes("品番"))&&h.some(v=>v.includes("品名"))) {hr=r;break;}
    }
    if(hr<0) hr=0;
    const raw=rows[hr]||[],h=raw.map(normalizeText);
    const find=terms=>h.findIndex(v=>terms.some(t=>v.includes(normalizeText(t))));
    const jan=find(["jan"]),sku=find(["品番"]),name=find(["品名","商品名"]),price=find(["オンライン"]);
    const known=new Set([jan,sku,name,price,find(["親コード"])].filter(i=>i>=0));
    const storeCols=[];
    for(let i=0;i<raw.length;i++){
      if(known.has(i)) continue;
      const label=String(raw[i]??"").trim();
      if(!label) continue;
      if(label.includes("店")||configuredStores.some(s=>normalizeText(label)===normalizeText(s))) storeCols.push({index:i,name:label});
    }
    return {headerRow:hr,jan,sku,name,price,storeCols};
  }

  function inventoryRowsToRecords(rows,snapshotDate,configuredStores=[]){
    const m=detectInventoryLayout(rows,configuredStores);
    if(m.jan<0||!m.storeCols.length) throw new Error("在庫ExcelのJAN列または店舗列を判定できません。");
    const out=[];
    for(const row of rows.slice(m.headerRow+1)){
      const jan=String(row[m.jan]??"").replace(/\.0$/,"").trim();
      const sku=m.sku>=0?String(row[m.sku]??"").trim():"";
      const name=m.name>=0?String(row[m.name]??"").trim():"";
      if(!jan&&!sku) continue;
      for(const c of m.storeCols){
        const stock=parseNumber(row[c.index]);
        out.push({snapshotDate,store:c.name,jan,sku,name,stock,price:m.price>=0?parseNumber(row[m.price]):0});
      }
    }
    return out;
  }

  function stockRowKey(r){return [r.snapshotDate,normalizeText(r.store),normalizeText(r.jan||r.sku)].join("|");}

  function latestSnapshotDate(rows){
    return rows.map(r=>r.snapshotDate).filter(Boolean).sort().pop()||"";
  }

  return {
    EXCLUDED_SHELVES,normalizeText,parseNumber,parseDate,parseCSV,colToIndex,indexToCol,
    sheetUrlToCsv,detectSalesMapping,rowsToRecords,isPlausibleSalesRecord,validateSalesRecords,productKey,recordKey,
    filterRecords,aggregateProducts,aggregateBy,kpis,abcAnalysis,comparePeriods,matchesSearch,
    dataRange,cutoffDateForYears,maxRecordDate,parseShelfText,shelfRowKey,parseExcludedShelves,allocateShelfSales,
    detectMasterLayout,masterRowsToRecords,buildMasterIndex,enrichWithMaster,inferDateFromFilename,
    detectInventoryLayout,inventoryRowsToRecords,stockRowKey,latestSnapshotDate
  };
});