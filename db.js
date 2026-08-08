(() => {
  "use strict";
  const DB_NAME="bmm-web-db", DB_VERSION=3;
  const RECORDS="records", META="meta", SYNC_LOG="syncLog", SHELF="shelfRows", STOCK="stockRows", MASTER="masterRows";

  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onerror=()=>reject(req.error);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains(RECORDS)){
          const s=db.createObjectStore(RECORDS,{keyPath:"_id"});
          s.createIndex("date","date");s.createIndex("store","store");s.createIndex("storeDate",["store","date"]);
        }
        if(!db.objectStoreNames.contains(META)) db.createObjectStore(META,{keyPath:"key"});
        if(!db.objectStoreNames.contains(SYNC_LOG)) db.createObjectStore(SYNC_LOG,{keyPath:"id",autoIncrement:true});
        if(!db.objectStoreNames.contains(SHELF)){
          const s=db.createObjectStore(SHELF,{keyPath:"_id"});s.createIndex("date","date");s.createIndex("store","store");s.createIndex("storeDate",["store","date"]);
        }
        if(!db.objectStoreNames.contains(STOCK)){
          const s=db.createObjectStore(STOCK,{keyPath:"_id"});s.createIndex("snapshotDate","snapshotDate");s.createIndex("store","store");
        }
        if(!db.objectStoreNames.contains(MASTER)) db.createObjectStore(MASTER,{keyPath:"_id"});
      };
      req.onsuccess=()=>resolve(req.result);
    });
  }

  function txDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async function getAll(name){
    const db=await openDB();
    try{
      const tx=db.transaction(name,"readonly"),req=tx.objectStore(name).getAll();
      const rows=await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);});
      await txDone(tx);return rows;
    }finally{db.close();}
  }
  async function clearStore(name){
    const db=await openDB();try{const tx=db.transaction(name,"readwrite");tx.objectStore(name).clear();await txDone(tx);}finally{db.close();}
  }
  async function deleteByIndex(store,indexName,key){
    const idx=store.index(indexName),req=idx.openCursor(IDBKeyRange.only(key));
    return new Promise((resolve,reject)=>{req.onerror=()=>reject(req.error);req.onsuccess=()=>{const c=req.result;if(!c){resolve();return;}c.delete();c.continue();};});
  }

  async function replaceStoreDates(storeName,records){
    const db=await openDB();
    try{
      const dates=[...new Set(records.map(r=>r.date).filter(Boolean))];
      const tx=db.transaction(RECORDS,"readwrite"),s=tx.objectStore(RECORDS);
      for(const d of dates) await deleteByIndex(s,"storeDate",[storeName,d]);
      for(const r of records) s.put({...r,_id:window.BMMCore.recordKey(r)});
      await txDone(tx);
    }finally{db.close();}
  }

  async function replaceShelfDates(storeName,rows){
    const db=await openDB();
    try{
      const dates=[...new Set(rows.map(r=>r.date).filter(Boolean))];
      const tx=db.transaction(SHELF,"readwrite"),s=tx.objectStore(SHELF);
      for(const d of dates) await deleteByIndex(s,"storeDate",[storeName,d]);
      for(const r of rows) s.put({...r,_id:window.BMMCore.shelfRowKey(r)});
      await txDone(tx);
    }finally{db.close();}
  }

  async function replaceStockSnapshot(snapshotDate,rows){
    const db=await openDB();
    try{
      const tx=db.transaction(STOCK,"readwrite"),s=tx.objectStore(STOCK);
      await deleteByIndex(s,"snapshotDate",snapshotDate);
      for(const r of rows) s.put({...r,_id:window.BMMCore.stockRowKey(r)});
      await txDone(tx);
    }finally{db.close();}
  }

  async function replaceMaster(rows){
    const db=await openDB();
    try{
      const tx=db.transaction(MASTER,"readwrite"),s=tx.objectStore(MASTER);s.clear();
      for(const r of rows){
        const id=window.BMMCore.normalizeText(r.jan||r.sku||r.name);
        if(id)s.put({...r,_id:id});
      }
      await txDone(tx);
    }finally{db.close();}
  }

  async function pruneBefore(cutoff){
    const prune=async(name,indexName,field)=>{
      const db=await openDB();let n=0;
      try{
        const tx=db.transaction(name,"readwrite"),s=tx.objectStore(name),idx=s.index(indexName),req=idx.openCursor(IDBKeyRange.upperBound(cutoff,true));
        await new Promise((resolve,reject)=>{req.onerror=()=>reject(req.error);req.onsuccess=()=>{const c=req.result;if(!c){resolve();return;}c.delete();n++;c.continue();};});
        await txDone(tx);return n;
      }finally{db.close();}
    };
    const a=await prune(RECORDS,"date","date"),b=await prune(SHELF,"date","date"),c=await prune(STOCK,"snapshotDate","snapshotDate");
    return a+b+c;
  }

  async function setMeta(key,value){
    const db=await openDB();try{const tx=db.transaction(META,"readwrite");tx.objectStore(META).put({key,value});await txDone(tx);}finally{db.close();}
  }
  async function getMeta(key){
    const db=await openDB();try{const tx=db.transaction(META,"readonly"),req=tx.objectStore(META).get(key);
      const v=await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result?.value);req.onerror=()=>reject(req.error);});await txDone(tx);return v;
    }finally{db.close();}
  }
  async function addSyncLog(entry){
    const db=await openDB();try{const tx=db.transaction(SYNC_LOG,"readwrite");tx.objectStore(SYNC_LOG).add(entry);await txDone(tx);}finally{db.close();}
  }
  async function getSyncLog(limit=200){return (await getAll(SYNC_LOG)).sort((a,b)=>String(b.syncedAt).localeCompare(String(a.syncedAt))).slice(0,limit);}

  async function exportAll(){
    return {
      records:await getAll(RECORDS),shelfRows:await getAll(SHELF),stockRows:await getAll(STOCK),
      masterRows:await getAll(MASTER),syncLog:await getSyncLog(),config:await getMeta("config"),lastSynced:await getMeta("lastSynced")
    };
  }
  async function importAll(p){
    for(const s of [RECORDS,SHELF,STOCK,MASTER,SYNC_LOG]) await clearStore(s);
    const groups=new Map();
    for(const r of p.records||[]){const k=r.store||"未設定";if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
    for(const [k,v] of groups) await replaceStoreDates(k,v);
    const sg=new Map();
    for(const r of p.shelfRows||[]){const k=r.store||"未設定";if(!sg.has(k))sg.set(k,[]);sg.get(k).push(r);}
    for(const [k,v] of sg) await replaceShelfDates(k,v);
    const snaps=new Map();
    for(const r of p.stockRows||[]){const k=r.snapshotDate;if(!snaps.has(k))snaps.set(k,[]);snaps.get(k).push(r);}
    for(const [k,v] of snaps) await replaceStockSnapshot(k,v);
    if(p.masterRows?.length) await replaceMaster(p.masterRows);
    for(const l of p.syncLog||[]) await addSyncLog(l);
    if(p.config) await setMeta("config",p.config);
    if(p.lastSynced) await setMeta("lastSynced",p.lastSynced);
  }

  window.BMMDB={openDB,getAll,replaceStoreDates,replaceShelfDates,replaceStockSnapshot,replaceMaster,pruneBefore,setMeta,getMeta,addSyncLog,getSyncLog,exportAll,importAll,
    stores:{records:RECORDS,meta:META,syncLog:SYNC_LOG,shelf:SHELF,stock:STOCK,master:MASTER}};
})();