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

  return {colToIndex,parseCSV,parseNumber,parseDate,sheetUrlToCsv,rowsToRecords,filterRecords,aggregateProducts,aggregateBy,kpis,abcAnalysis,comparePeriods};
});
