const assert=require("assert");
const C=require("./core.js");

assert.equal(C.colToIndex("A"),0);
assert.equal(C.colToIndex("H"),7);
assert.equal(C.colToIndex("AA"),26);

const rows=C.parseCSV('a,"b,c",1\nx,y,2');
assert.deepEqual(rows,[["a","b,c","1"],["x","y","2"]]);

assert.equal(C.parseNumber("¥1,990"),1990);
assert.equal(C.parseDate("2026/8/3"),"2026-08-03");

const map={jan:"A",sku:"B",qty:"C",sales:"D",store:"E",date:"F",shelf:"G",name:"H",stock:"I"};
const records=C.rowsToRecords([
  ["1","A",2,1000,"東大阪店","2026/8/3","4","商品A","10"],
  ["2","B",1,500,"名古屋店","2026/8/4","5","商品B","4"]
],map);
assert.equal(records.length,2);
assert.equal(records[0].sales,1000);
assert.equal(records[0].stock,10);

const k=C.kpis(records);
assert.equal(k.sales,1500);
assert.equal(k.qty,3);
assert.equal(k.productCount,2);

const stores=C.aggregateBy(records,"store");
assert.equal(stores.length,2);

const abc=C.abcAnalysis(records);
assert.equal(abc[0].rank,"A");

const url=C.sheetUrlToCsv("https://docs.google.com/spreadsheets/d/abc123/edit?gid=456");
assert(url.includes("/abc123/gviz/tq?"));
assert(url.includes("gid=456"));


assert(C.matchesSearch({jan:"4570016",sku:"TG458BK",name:"ボクシング グローブ"},"tg458"));
assert(C.matchesSearch({jan:"4570016",sku:"TG458BK",name:"ボクシング グローブ"},"グローブ TG"));
assert(C.matchesSearch({jan:"４５７００１６",sku:"ＴＧ４５８",name:"商品"},"4570016"));

const oldHistory=[
  {store:"東大阪店",date:"2026-08-01",jan:"1",sku:"A",name:"旧週",qty:1,sales:100,shelf:"",stock:null},
  {store:"東大阪店",date:"2026-08-08",jan:"2",sku:"B",name:"今週旧内容",qty:1,sales:200,shelf:"",stock:null},
  {store:"名古屋店",date:"2026-08-08",jan:"3",sku:"C",name:"他店",qty:1,sales:300,shelf:"",stock:null}
];
const incoming=[
  {store:"東大阪店",date:"2026-08-08",jan:"2",sku:"B",name:"今週修正版",qty:2,sales:400,shelf:"",stock:null},
  {store:"東大阪店",date:"2026-08-09",jan:"4",sku:"D",name:"新規",qty:1,sales:500,shelf:"",stock:null}
];
const merged=C.mergeHistory(oldHistory,incoming,"東大阪店");
assert.equal(merged.length,4);
assert(merged.some(r=>r.date==="2026-08-01"&&r.name==="旧週"));
assert(!merged.some(r=>r.name==="今週旧内容"));
assert(merged.some(r=>r.name==="今週修正版"&&r.sales===400));
assert(merged.some(r=>r.store==="名古屋店"&&r.name==="他店"));

const range=C.dataRange(merged);
assert.equal(range.from,"2026-08-01");
assert.equal(range.to,"2026-08-09");


const retained=C.keepRecentYears([
  {date:"2023-08-05"},
  {date:"2023-08-06"},
  {date:"2026-08-06"},
  {date:""}
],3,"2026-08-06");
assert.equal(retained.length,3);
assert(!retained.some(r=>r.date==="2023-08-05"));
assert(retained.some(r=>r.date==="2023-08-06"));
assert.equal(C.cutoffDateForYears("2026-08-06",3),"2023-08-06");
assert.equal(C.maxRecordDate([{date:"2026-01-01"},{date:"2026-08-06"}]),"2026-08-06");

console.log("ALL_CORE_TESTS_PASSED");
