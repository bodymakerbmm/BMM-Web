(() => {
  "use strict";

  const DB_NAME = "bmm-web-db";
  const DB_VERSION = 1;
  const RECORDS = "records";
  const META = "meta";
  const SYNC_LOG = "syncLog";

  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onerror=()=>reject(req.error);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains(RECORDS)){
          const store=db.createObjectStore(RECORDS,{keyPath:"_id"});
          store.createIndex("date","date",{unique:false});
          store.createIndex("store","store",{unique:false});
          store.createIndex("storeDate",["store","date"],{unique:false});
        }
        if(!db.objectStoreNames.contains(META)){
          db.createObjectStore(META,{keyPath:"key"});
        }
        if(!db.objectStoreNames.contains(SYNC_LOG)){
          db.createObjectStore(SYNC_LOG,{keyPath:"id",autoIncrement:true});
        }
      };
      req.onsuccess=()=>resolve(req.result);
    });
  }

  function txPromise(tx){
    return new Promise((resolve,reject)=>{
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error||new Error("IndexedDB transaction aborted"));
    });
  }

  async function getAll(storeName){
    const db=await openDB();
    try{
      const tx=db.transaction(storeName,"readonly");
      const req=tx.objectStore(storeName).getAll();
      const result=await new Promise((resolve,reject)=>{
        req.onsuccess=()=>resolve(req.result||[]);
        req.onerror=()=>reject(req.error);
      });
      await txPromise(tx);
      return result;
    }finally{db.close();}
  }

  async function replaceStoreDates(storeName,records){
    const db=await openDB();
    try{
      const dates=[...new Set(records.map(r=>r.date).filter(Boolean))];
      const hasNoDate=records.some(r=>!r.date);
      const tx=db.transaction(RECORDS,"readwrite");
      const store=tx.objectStore(RECORDS);
      const idx=store.index("storeDate");

      for(const date of dates){
        const range=IDBKeyRange.only([storeName,date]);
        await deleteCursor(idx,range);
      }
      if(hasNoDate){
        const allReq=store.openCursor();
        await new Promise((resolve,reject)=>{
          allReq.onerror=()=>reject(allReq.error);
          allReq.onsuccess=()=>{
            const cursor=allReq.result;
            if(!cursor){resolve();return;}
            const v=cursor.value;
            if(v.store===storeName&&!v.date) cursor.delete();
            cursor.continue();
          };
        });
      }

      for(const record of records){
        store.put({...record,_id:window.BMMCore.recordKey(record)});
      }
      await txPromise(tx);
    }finally{db.close();}
  }

  function deleteCursor(index,range){
    return new Promise((resolve,reject)=>{
      const req=index.openCursor(range);
      req.onerror=()=>reject(req.error);
      req.onsuccess=()=>{
        const cursor=req.result;
        if(!cursor){resolve();return;}
        cursor.delete();
        cursor.continue();
      };
    });
  }

  async function pruneBefore(cutoff){
    const db=await openDB();
    let deleted=0;
    try{
      const tx=db.transaction(RECORDS,"readwrite");
      const store=tx.objectStore(RECORDS);
      const idx=store.index("date");
      const range=IDBKeyRange.upperBound(cutoff,true);
      const req=idx.openCursor(range);
      await new Promise((resolve,reject)=>{
        req.onerror=()=>reject(req.error);
        req.onsuccess=()=>{
          const cursor=req.result;
          if(!cursor){resolve();return;}
          cursor.delete();
          deleted++;
          cursor.continue();
        };
      });
      await txPromise(tx);
      return deleted;
    }finally{db.close();}
  }

  async function setMeta(key,value){
    const db=await openDB();
    try{
      const tx=db.transaction(META,"readwrite");
      tx.objectStore(META).put({key,value});
      await txPromise(tx);
    }finally{db.close();}
  }

  async function getMeta(key){
    const db=await openDB();
    try{
      const tx=db.transaction(META,"readonly");
      const req=tx.objectStore(META).get(key);
      const result=await new Promise((resolve,reject)=>{
        req.onsuccess=()=>resolve(req.result?.value);
        req.onerror=()=>reject(req.error);
      });
      await txPromise(tx);
      return result;
    }finally{db.close();}
  }

  async function addSyncLog(entry){
    const db=await openDB();
    try{
      const tx=db.transaction(SYNC_LOG,"readwrite");
      tx.objectStore(SYNC_LOG).add(entry);
      await txPromise(tx);
    }finally{db.close();}
  }

  async function getSyncLog(limit=200){
    const all=await getAll(SYNC_LOG);
    return all.sort((a,b)=>String(b.syncedAt).localeCompare(String(a.syncedAt))).slice(0,limit);
  }

  async function clearAll(){
    const db=await openDB();
    try{
      const tx=db.transaction([RECORDS,META,SYNC_LOG],"readwrite");
      tx.objectStore(RECORDS).clear();
      tx.objectStore(META).clear();
      tx.objectStore(SYNC_LOG).clear();
      await txPromise(tx);
    }finally{db.close();}
  }

  async function importAll(payload){
    await clearAll();
    const grouped=new Map();
    for(const record of payload.records||[]){
      const key=record.store||"未設定";
      if(!grouped.has(key)) grouped.set(key,[]);
      grouped.get(key).push(record);
    }
    for(const [store,records] of grouped){
      await replaceStoreDates(store,records);
    }
    for(const log of payload.syncLog||[]){
      await addSyncLog(log);
    }
    if(payload.config) await setMeta("config",payload.config);
    await setMeta("lastSynced",payload.lastSynced||new Date().toISOString());
  }

  window.BMMDB={
    openDB,getAll,replaceStoreDates,pruneBefore,setMeta,getMeta,
    addSyncLog,getSyncLog,clearAll,importAll,
    stores:{records:RECORDS,meta:META,syncLog:SYNC_LOG}
  };
})();
