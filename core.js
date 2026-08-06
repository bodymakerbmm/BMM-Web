(function(root,factory){
  if(typeof module==="object"&&module.exports){module.exports=factory();}
  else{root.BMMCore=factory();}
})(typeof self!=="undefined"?self:this,function(){
  "use strict";

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

  function parseCSV(text){
    const rows=[]; let row=[],cell="",quoted=false;
    const src=String(text||"").replace(/^\uFEFF/,"");
    for(let i=0;i<src.length;i++){
      const ch=src[i];
      if(quoted){
        if(ch==='"'&&src[i+1]==='"'){cell+='"';i++;}
        else if(ch==='"'){quoted=false;}
        else{cell+=ch;}
      }else{
        if(ch==='"'){quoted=true;}
        else if(ch===','){row.push(cell);cell="";}
        else if(ch==='\n'){row.push(cell);rows.push(row);row=[];cell="";}
        else if(ch!=='\r'){cell+=ch;}
      }
    }
    if(cell!==""||row.length){row.push(cell);rows.push(row);}
    return rows.filter(r=>r.some(v=>String(v).trim()!==""));
  }

  function parseNumber(value){
    if(typeof value==="number") return Number.isFinite(value)?value:0;
    const cleaned=String(value??"").replace(/[¥￥,\s]/g,"").replace(/[^\d.\-]/g,"");
    const n=Number(cleaned); return Number.isFinite(n)?n:0;
  }

  function parseDate(value){
    if(value instanceof Date&&!isNaN(value)) return value.toISOString().slice(0,10);
    let s=String(value??"").trim();
    if(!s) return "";
    s=s.replace(/[年月.]/g,"/").replace(/日/g,"").replace(/-/g,"/");
    const m=s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if(m){
      const y=m[1],mo=String(Number(m[2])).padStart(2,"0"),d=String(Number(m[3])).padStart(2,"0");
      return `${y}-${mo}-${d}`;
    }
    const dt=new Date(value);
    return isNaN(dt)?"":dt.toISOString().slice(0,10);
  }

  function sheetUrlToCsv(url,sheetName){
    const text=String(url||"").trim();
    const idMatch=text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if(!idMatch) throw new Error("GoogleスプレッドシートURLを確認してください。");
    const id=idMatch[1];
    const gidMatch=text.match(/[?&#]gid=(\d+)/);
    const params=new URLSearchParams({tqx:"out:csv"});
    if(sheetName) params.set("sheet",sheetName);
    else if(gidMatch) params.set("gid",gidMatch[1]);
    params.set("_",String(Date.now()));
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${params.toString()}`;
  }

  function rowsToRecords(rows,mapping,configuredStore){
    const ix={};
    Object.keys(mapping).forEach(k=>ix[k]=colToIndex(mapping[k]));
    return rows.map((row,i)=>{
      const get=k=>ix[k]>=0?(row[ix[k]]??""):"";
      const jan=String(get("jan")).trim();
      const sku=String(get("sku")).trim();
      const name=String(get("name")).trim();
      const qty=parseNumber(get("qty"));
      const sales=parseNumber(get("sales"));
      const date=parseDate(get("date"));
      const store=String(get("store")).trim()||configuredStore||"未設定";
      const shelf=String(get("shelf")).trim();
      const stockRaw=get("stock");
      const stock=ix.stock>=0?parseNumber(stockRaw):null;
      return {jan,sku,name,qty,sales,date,store,shelf,stock,_row:i+1};
    }).filter(r=>r.jan||r.sku||r.name||r.sales||r.qty);
  }

  function filterRecords(records,filter={}){
    return records.filter(r=>{
      if(filter.store&&r.store!==filter.store) return false;
      if(filter.from&&(!r.date||r.date<filter.from)) return false;
      if(filter.to&&(!r.date||r.date>filter.to)) return false;
      return true;
    });
  }

  function productKey(r){return r.jan||r.sku||r.name||`row-${r._row}`;}

  function aggregateProducts(records){
    const map=new Map();
    for(const r of records){
      const key=productKey(r);
      const item=map.get(key)||{key,jan:r.jan,sku:r.sku,name:r.name||r.sku||r.jan,qty:0,sales:0,stock:0,hasStock:false,stores:new Set()};
      item.qty+=r.qty; item.sales+=r.sales; item.stores.add(r.store);
      if(r.stock!==null){item.stock+=r.stock;item.hasStock=true;}
      map.set(key,item);
    }
    return [...map.values()].map(x=>({...x,stores:[...x.stores]}));
  }

  function aggregateBy(records,field){
    const map=new Map();
    for(const r of records){
      const key=String(r[field]||"未設定");
      const item=map.get(key)||{key,qty:0,sales:0,products:new Set(),rows:0};
      item.qty+=r.qty;item.sales+=r.sales;item.products.add(productKey(r));item.rows++;
      map.set(key,item);
    }
    return [...map.values()].map(x=>({...x,productCount:x.products.size,products:undefined}));
  }

  function kpis(records){
    const sales=records.reduce((s,r)=>s+r.sales,0);
    const qty=records.reduce((s,r)=>s+r.qty,0);
    const productCount=new Set(records.map(productKey)).size;
    return {sales,qty,productCount,avgPrice:qty?sales/qty:0};
  }

  function abcAnalysis(records){
    const products=aggregateProducts(records).sort((a,b)=>b.sales-a.sales);
    const total=products.reduce((s,p)=>s+p.sales,0);
    let cumulative=0;
    return products.map(p=>{
      const share=total?p.sales/total:0;
      cumulative+=share;
      const rank=cumulative<=0.70?"A":cumulative<=0.90?"B":"C";
      return {...p,share,cumulative,rank};
    });
  }

  function comparePeriods(records,a,b){
    const ra=filterRecords(records,{from:a.from,to:a.to,store:a.store||""});
    const rb=filterRecords(records,{from:b.from,to:b.to,store:b.store||""});
    const ka=kpis(ra),kb=kpis(rb);
    function delta(x,y){return y===0?(x===0?0:null):(x-y)/y;}
    return {a:ka,b:kb,delta:{sales:delta(ka.sales,kb.sales),qty:delta(ka.qty,kb.qty),productCount:delta(ka.productCount,kb.productCount),avgPrice:delta(ka.avgPrice,kb.avgPrice)}};
  }


  function normalizeText(value){
    return String(value??"")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g," ")
      .trim();
  }

  function matchesSearch(record,query){
    const terms=normalizeText(query).split(" ").filter(Boolean);
    if(!terms.length) return true;
    const haystack=normalizeText([record.jan,record.sku,record.name].join(" "));
    return terms.every(term=>haystack.includes(term));
  }

  function recordKey(record){
    return [
      normalizeText(record.store),
      record.date||"",
      normalizeText(record.jan),
      normalizeText(record.sku),
      normalizeText(record.shelf),
      normalizeText(record.name)
    ].join("|");
  }

  function mergeHistory(existing,incoming,configuredStore){
    const store=String(configuredStore||incoming[0]?.store||"未設定");
    const incomingDates=new Set(incoming.map(r=>r.date).filter(Boolean));
    const incomingHasNoDate=incoming.some(r=>!r.date);

    const preserved=existing.filter(r=>{
      if(String(r.store)!==store) return true;
      if(r.date && incomingDates.has(r.date)) return false;
      if(!r.date && incomingHasNoDate) return false;
      return true;
    });

    const latest=new Map();
    for(const record of incoming){
      latest.set(recordKey(record),record);
    }
    return [...preserved,...latest.values()].sort((a,b)=>
      String(a.date||"").localeCompare(String(b.date||"")) ||
      String(a.store||"").localeCompare(String(b.store||""))
    );
  }

  function dataRange(records){
    const dates=records.map(r=>r.date).filter(Boolean).sort();
    return {
      from:dates[0]||"",
      to:dates[dates.length-1]||"",
      days:new Set(dates).size
    };
  }

  function cutoffDateForYears(referenceDate,years){
    const ref = referenceDate ? new Date(`${referenceDate}T00:00:00`) : new Date();
    if(Number.isNaN(ref.getTime())) throw new Error("基準日が不正です。");
    const cutoff = new Date(ref);
    cutoff.setFullYear(cutoff.getFullYear()-Number(years||3));
    return cutoff.toISOString().slice(0,10);
  }

  function keepRecentYears(records,years=3,referenceDate){
    const cutoff=cutoffDateForYears(referenceDate,years);
    return records.filter(r=>!r.date||r.date>=cutoff);
  }

  function maxRecordDate(records){
    const dates=records.map(r=>r.date).filter(Boolean).sort();
    return dates[dates.length-1]||"";
  }


  function cellScore(rows,index,test){
    const sample=rows.slice(0,Math.min(rows.length,80));
    if(index<0||!sample.length) return 0;
    let hit=0,total=0;
    for(const row of sample){
      const value=row[index];
      if(String(value??"").trim()==="") continue;
      total++;
      if(test(value)) hit++;
    }
    return total?hit/total:0;
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

  function detectSalesMapping(rows){
    const width=Math.max(0,...rows.map(r=>r.length));
    const indexes=[...Array(width).keys()];
    const header=(rows[0]||[]).map(v=>normalizeText(v));
    const findHeader=terms=>header.findIndex(v=>terms.some(t=>v.includes(t)));
    const choose=(headerIndex,scorer,fallback)=>{
      if(headerIndex>=0) return headerIndex;
      let best={index:fallback,score:-1};
      for(const i of indexes){
        const score=scorer(i);
        if(score>best.score) best={index:i,score};
      }
      return best.score>=0.45?best.index:fallback;
    };
    const jan=choose(findHeader(["jan","バーコード"]),i=>cellScore(rows,i,v=>/^\d{8,14}$/.test(String(v).replace(/\D/g,""))),0);
    const date=choose(findHeader(["日付","売上日"]),i=>cellScore(rows,i,v=>/^\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}/.test(String(v).trim())),5);
    const qty=choose(findHeader(["売れ数","数量","個数"]),i=>cellScore(rows,i,v=>{const n=parseNumber(v);return Number.isFinite(n)&&Math.abs(n)<=9999;}),2);
    const sales=choose(findHeader(["売上金額","金額","売上"]),i=>cellScore(rows,i,v=>parseNumber(v)!==0),3);
    const store=choose(findHeader(["店舗名","店舗"]),i=>cellScore(rows,i,v=>/[店店舗]|東大阪|名古屋|江坂|堺|岸和田/.test(String(v))),4);
    const sku=choose(findHeader(["品番","商品コード"]),i=>cellScore(rows,i,v=>/[A-Za-z]/.test(String(v))&&/[0-9]/.test(String(v))),1);
    const name=choose(findHeader(["商品名","名称"]),i=>cellScore(rows,i,v=>String(v).trim().length>=3&&!/^\d+$/.test(String(v).trim())),7);
    const shelf=findHeader(["棚番号","棚"]);
    const stock=findHeader(["在庫","在庫数"]);
    const toCol=i=>i<0?"":indexToCol(i);
    return {jan:toCol(jan),sku:toCol(sku),qty:toCol(qty),sales:toCol(sales),store:toCol(store),date:toCol(date),shelf:toCol(shelf),name:toCol(name),stock:toCol(stock)};
  }

  function validateSalesRecords(records){
    const valid=records.filter(r=>r.date&&(r.jan||r.sku||r.name)&&(r.qty!==0||r.sales!==0));
    const dateRate=records.length?records.filter(r=>r.date).length/records.length:0;
    return {valid,validCount:valid.length,dateRate,hasNames:valid.some(r=>String(r.name||"").trim()),ok:valid.length>0&&dateRate>=0.5};
  }

  function detectMasterMapping(rows){
    const width=Math.max(0,...rows.map(r=>r.length));
    let jan=-1,sku=-1,name=-1;
    for(let i=0;i<width;i++){
      const janScore=cellScore(rows,i,v=>/^\d{8,14}$/.test(String(v).replace(/\D/g,"")));
      if(janScore>0.55) jan=i;
      const skuScore=cellScore(rows,i,v=>/[A-Za-z]/.test(String(v))&&/[0-9]/.test(String(v)));
      if(skuScore>0.45&&sku<0) sku=i;
      const nameScore=cellScore(rows,i,v=>String(v).trim().length>=4&&!/^\d+$/.test(String(v).trim()));
      if(nameScore>0.6) name=i;
    }
    return {jan:indexToCol(jan),sku:indexToCol(sku),name:indexToCol(name)};
  }

  function buildMasterIndex(rows,mapping){
    const janI=colToIndex(mapping.jan),skuI=colToIndex(mapping.sku),nameI=colToIndex(mapping.name);
    const byJan=new Map(),bySku=new Map();
    for(const row of rows){
      const item={jan:String(row[janI]??"").trim(),sku:String(row[skuI]??"").trim(),name:String(row[nameI]??"").trim()};
      if(item.jan) byJan.set(item.jan,item);
      if(item.sku) bySku.set(normalizeText(item.sku),item);
    }
    return {byJan,bySku};
  }

  function enrichWithMaster(records,index){
    return records.map(r=>{
      const item=index?.byJan?.get(r.jan)||index?.bySku?.get(normalizeText(r.sku));
      if(!item) return r;
      return {...r,jan:r.jan||item.jan,sku:r.sku||item.sku,name:r.name||item.name};
    });
  }

  return {
    colToIndex,parseCSV,parseNumber,parseDate,sheetUrlToCsv,rowsToRecords,
    filterRecords,aggregateProducts,aggregateBy,kpis,abcAnalysis,comparePeriods,
    normalizeText,matchesSearch,recordKey,mergeHistory,dataRange,
    cutoffDateForYears,keepRecentYears,maxRecordDate,
    indexToCol,detectSalesMapping,validateSalesRecords,detectMasterMapping,buildMasterIndex,enrichWithMaster
  };
});