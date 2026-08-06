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

console.log("ALL_CORE_TESTS_PASSED");
