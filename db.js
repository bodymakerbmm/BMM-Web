(() => {
  "use strict";
  const DB_NAME="bmm-web-db", DB_VERSION=5;
  const RECORDS="records", META="meta", SYNC_LOG="syncLog", SHELF="shelfRows", STOCK="stockRows", MASTER="masterRows", SHELF_HISTORY="shelfHistory";

  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onerror=()=>reject(req.error);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains(RECORDS)){
          const s=db.createObjectStore(RECORDS,{keyPath:"_id"});
          s.createIndex("date","date");s.createIndex("store","store");s.createIndex("storeDate",["store","date"]);
        }else{
          const s=req.transaction.objectStore(RECORDS);
          if(!s.indexNames.contains("date"))s.createIndex("date","date");
          if(!s.indexNames.contains("store"))s.createIndex("store","store");
          if(!s.indexNames.contains("storeDate"))s.createIndex("storeDate",["store","date"]);
        }
        if(!db.objectStoreNames.contains(META))db.createObjectStore(META,{keyPath:"key"});
        if(!db.objectStoreNames.contains(SYNC_LOG))db.createObjectStore(SYNC_LOG,{keyPath:"id",autoIncrement:true});
        if(!db.objectStoreNames.contains(SHELF)){
          const s=db.createObjectStore(SHELF,{keyPath:"_id"});s.createIndex("date","date");s.createIndex("store","store");s.createIndex("storeDate",["store","date"]);
        }
        if(!db.objectStoreNames.contains(STOCK)){
          const s=db.createObjectStore(STOCK,{keyPath:"_id"});s.createIndex("snapshotDate","snapshotDate");s.createIndex("store","store");
        }
        if(!db.objectStoreNames.contains(MASTER))db.createObjectStore(MASTER,{keyPath:"_id"});
        if(!db.objectStoreNames.contains(SHELF_HISTORY)){
          const sh=db.createObjectStore(SHELF_HISTORY,{keyPath:"_id"});
          sh.createIndex("store","store");
          sh.createIndex("effectiveFrom","effectiveFrom");
          sh.createIndex("storeEffective",["store","effectiveFrom"]);
        }else{
          const sh=req.transaction.objectStore(SHELF_HISTORY);
          if(!sh.indexNames.contains("store"))sh.createIndex("store","store");
          if(!sh.indexNames.contains("effectiveFrom"))sh.createIndex("effectiveFrom","effectiveFrom");
          if(!sh.indexNames.contains("storeEffective"))sh.createIndex("storeEffective",["store","effectiveFrom"]);
        }
      };
      req.onsuccess=()=>resolve(req.result);
    });
  }

  function txDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async function getAll(name){const db=await openDB();try{const tx=db.transaction(name,"readonly"),req=tx.objectStore(name).getAll();const rows=await new Promise((res,rej)=>{req.onsuccess=()=>res(req.result||[]);req.onerror=()=>rej(req.error);});await txDone(tx);return rows;}finally{db.close();}}
  async function clearStore(name){const db=await openDB();try{const tx=db.transaction(name,"readwrite");tx.objectStore(name).clear();await txDone(tx);}finally{db.close();}}

  function asKeyRange(keyOrRange){
    // Avoid instanceof checks across browser realms. IDBKeyRange objects expose lower/upper.
    if(keyOrRange&&typeof keyOrRange==="object"&&(Object.prototype.hasOwnProperty.call(keyOrRange,"lower")||"lower" in keyOrRange))return keyOrRange;
    return IDBKeyRange.only(keyOrRange);
  }

  async function deleteByIndex(store,indexName,keyOrRange){
    const req=store.index(indexName).openCursor(asKeyRange(keyOrRange));
    return new Promise((resolve,reject)=>{req.onerror=()=>reject(req.error);req.onsuccess=()=>{const c=req.result;if(!c){resolve();return;}c.delete();c.continue();};});
  }

  async function deleteIndexRange(db,storeName,indexName,keyOrRange){
    const tx=db.transaction(storeName,"readwrite"),s=tx.objectStore(storeName);
    await deleteByIndex(s,indexName,keyOrRange);
    await txDone(tx);
  }

  async function putRows(db,storeName,rows,keyFn){
    const tx=db.transaction(storeName,"readwrite"),s=tx.objectStore(storeName);
    for(const r of rows)s.put({...r,_id:keyFn(r)});
    await txDone(tx);
  }

  async function replaceStoreRange(storeName,records){
    if(!records.length)return;
    const dates=records.map(r=>r.date).filter(Boolean).sort(),from=dates[0],to=dates[dates.length-1];
    if(!from||!to)return;
    const db=await openDB();
    try{
      // Delete and insert in separate transactions. This avoids TransactionInactiveError
      // after awaiting an IndexedDB cursor transaction.
      await deleteIndexRange(db,RECORDS,"storeDate",IDBKeyRange.bound([storeName,from],[storeName,to]));
      await putRows(db,RECORDS,records,r=>window.BMMCore.recordKey(r));
    }finally{db.close();}
  }

  async function replaceShelfDates(storeName,rows){
    if(!rows.length)return;
    const dates=[...new Set(rows.map(r=>r.date).filter(Boolean))];
    const db=await openDB();
    try{
      for(const d of dates)await deleteIndexRange(db,SHELF,"storeDate",[storeName,d]);
      await putRows(db,SHELF,rows,r=>window.BMMCore.shelfRowKey(r));
    }finally{db.close();}
  }

  async function replaceShelfSnapshot(storeName,effectiveFrom,rows){
    if(!storeName||!effectiveFrom)return;
    const db=await openDB();
    try{
      await deleteIndexRange(db,SHELF_HISTORY,"storeEffective",[storeName,effectiveFrom]);
      if(rows.length){
        await putRows(db,SHELF_HISTORY,rows,r=>
          [storeName,effectiveFrom,window.BMMCore.normalizeText(r.jan),String(r.shelf)].join("|")
        );
      }
    }finally{db.close();}
  }

  async function putRowsChunked(db,storeName,rows,keyFn,chunkSize=1500){
    for(let i=0;i<rows.length;i+=chunkSize){
      await putRows(db,storeName,rows.slice(i,i+chunkSize),keyFn);
    }
  }

  async function replaceStockSnapshot(snapshotDate,rows){
    if(!snapshotDate)return;
    const db=await openDB();
    try{
      await deleteIndexRange(db,STOCK,"snapshotDate",snapshotDate);
      if(rows.length)await putRowsChunked(db,STOCK,rows,r=>window.BMMCore.stockRowKey(r),1500);
    }finally{db.close();}
  }

  async function replaceMaster(rows){
    const db=await openDB();try{const tx=db.transaction(MASTER,"readwrite"),s=tx.objectStore(MASTER);s.clear();for(const r of rows){const id=window.BMMCore.normalizeText(r.sku||r.jan||r.name);if(id)s.put({...r,_id:id});}await txDone(tx);}finally{db.close();}
  }

  async function pruneBefore(cutoff){
    if(!cutoff)return 0;
    const prune=async(name,indexName)=>{const db=await openDB();let n=0;try{const tx=db.transaction(name,"readwrite"),s=tx.objectStore(name),req=s.index(indexName).openCursor(IDBKeyRange.upperBound(cutoff,true));await new Promise((res,rej)=>{req.onerror=()=>rej(req.error);req.onsuccess=()=>{const c=req.result;if(!c){res();return;}c.delete();n++;c.continue();};});await txDone(tx);return n;}finally{db.close();}};
    return (await prune(RECORDS,"date"))+(await prune(SHELF,"date"))+(await prune(STOCK,"snapshotDate"));
  }

  async function cleanInvalidSalesRecords(){
    const db=await openDB();let removed=0;
    try{const tx=db.transaction(RECORDS,"readwrite"),s=tx.objectStore(RECORDS),req=s.openCursor();await new Promise((res,rej)=>{req.onerror=()=>rej(req.error);req.onsuccess=()=>{const c=req.result;if(!c){res();return;}if(!window.BMMCore.isPlausibleSalesRecord(c.value||{})){c.delete();removed++;}c.continue();};});await txDone(tx);return removed;}finally{db.close();}
  }

  async function resetSalesForSchemaMigration(){
    await clearStore(RECORDS);await clearStore(SYNC_LOG);await setMeta("lastSynced","");
  }

  async function setMeta(key,value){const db=await openDB();try{const tx=db.transaction(META,"readwrite");tx.objectStore(META).put({key,value});await txDone(tx);}finally{db.close();}}
  async function getMeta(key){const db=await openDB();try{const tx=db.transaction(META,"readonly"),req=tx.objectStore(META).get(key);const v=await new Promise((res,rej)=>{req.onsuccess=()=>res(req.result?.value);req.onerror=()=>rej(req.error);});await txDone(tx);return v;}finally{db.close();}}
  async function addSyncLog(entry){const db=await openDB();try{const tx=db.transaction(SYNC_LOG,"readwrite");tx.objectStore(SYNC_LOG).add(entry);await txDone(tx);}finally{db.close();}}
  async function getSyncLog(limit=200){return (await getAll(SYNC_LOG)).sort((a,b)=>String(b.syncedAt).localeCompare(String(a.syncedAt))).slice(0,limit);}

  async function exportAll(){return {records:await getAll(RECORDS),shelfRows:await getAll(SHELF),shelfHistory:await getAll(SHELF_HISTORY),stockRows:await getAll(STOCK),masterRows:await getAll(MASTER),syncLog:await getSyncLog(),config:await getMeta("config"),lastSynced:await getMeta("lastSynced"),salesSchemaVersion:await getMeta("salesSchemaVersion")};}
  async function importAll(p){
    for(const s of [RECORDS,SHELF,SHELF_HISTORY,STOCK,MASTER,SYNC_LOG])await clearStore(s);
    const groups=new Map();for(const r of p.records||[]){const k=r.store||"未設定";if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}for(const [k,v] of groups)await replaceStoreRange(k,v);
    const sg=new Map();for(const r of p.shelfRows||[]){const k=r.store||"未設定";if(!sg.has(k))sg.set(k,[]);sg.get(k).push(r);}for(const [k,v] of sg)await replaceShelfDates(k,v);
    const hist=new Map();
    for(const r of p.shelfHistory||[]){
      const k=[r.store||"未設定",r.effectiveFrom||""].join("|");
      if(!hist.has(k))hist.set(k,[]);
      hist.get(k).push(r);
    }
    for(const [k,v] of hist){
      const [store,effectiveFrom]=k.split("|");
      await replaceShelfSnapshot(store,effectiveFrom,v);
    }

    const snaps=new Map();for(const r of p.stockRows||[]){const k=r.snapshotDate;if(!snaps.has(k))snaps.set(k,[]);snaps.get(k).push(r);}for(const [k,v] of snaps)await replaceStockSnapshot(k,v);
    if(p.masterRows?.length)await replaceMaster(p.masterRows);for(const l of p.syncLog||[])await addSyncLog(l);if(p.config)await setMeta("config",p.config);if(p.lastSynced)await setMeta("lastSynced",p.lastSynced);
  }

  window.BMMDB={openDB,getAll,clearStore,replaceStoreRange,replaceShelfDates,replaceShelfSnapshot,replaceStockSnapshot,replaceMaster,pruneBefore,cleanInvalidSalesRecords,resetSalesForSchemaMigration,setMeta,getMeta,addSyncLog,getSyncLog,exportAll,importAll,
    stores:{records:RECORDS,meta:META,syncLog:SYNC_LOG,shelf:SHELF,shelfHistory:SHELF_HISTORY,stock:STOCK,master:MASTER}};
})();
