// Read-only venue activity: writes local quotes, never signs or submits orders.
// Run against a production server: node examples/event-api-benchmark.mjs http://localhost:3001
const base=process.argv[2]??'http://localhost:3001';
async function json(path,body){
 const start=performance.now();
 const response=await fetch(base+path,{signal:AbortSignal.timeout(30_000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
 const data=await response.json();
 if(!response.ok)throw Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
 return {data,ms:Math.round(performance.now()-start)};
}
console.log('health',JSON.stringify((await json('/api/health')).data));
for(const spec of [{id:'946004',kind:'binary',marketId:'4052413'},{id:'606422',kind:'categorical'},{id:'1033694',kind:'numeric'}]){
 const p=new URLSearchParams({kind:spec.kind,...(spec.marketId?{marketId:spec.marketId}:{})});
 const {data:detail}=await json(`/api/markets/${spec.id}?${p}`);
 if(!detail.eligible)throw Error(detail.reason);
 const body={eventId:spec.id,...spec,ruleHash:detail.ruleHash,budgetUsd:200,
  ...(spec.kind==='numeric'?{shape:{templateId:'threshold_digital',direction:'below',k:77000,payoutUsd:1000}}
  :{losses:detail.outcomes.map((o,i)=>({outcomeId:o.id,lossCents:i===0?100000:0}))})};
 const samples=[];let last;
 for(let i=0;i<3;i++){const q=await json('/api/hedges',body);last=q.data;
  samples.push({httpMs:q.ms,...q.data.timings,options:q.data.result.view.options.length});}
 const id=last.result.quoteId;
 const reprice=await json(`/api/quote/${id}/reprice`,{});
 const accept=await json(`/api/quote/${id}/accept`,{optionId:'primary'});
 console.log(JSON.stringify({kind:spec.kind,samples,repriceMs:reprice.ms,pinned:Boolean(accept.data.acceptedAt)}));
}
const catalogue=await json('/api/markets?limit=1');
console.log('catalogue',JSON.stringify({complete:catalogue.data.discoveryComplete,total:catalogue.data.total,progress:catalogue.data.discovery}));
if(catalogue.data.discoveryComplete){
 const times=[];let bytes=0;
 for(let i=0;i<100;i++){const result=await json(`/api/markets?q=${['BTC','weather','Fed'][i%3]}&limit=25&categoryVersion=${catalogue.data.catalogueVersion}`);times.push(result.ms);bytes=Math.max(bytes,JSON.stringify(result.data).length);}
 times.sort((a,b)=>a-b);console.log('search',JSON.stringify({count:times.length,p50:times[49],p95:times[94],maxBytes:bytes}));
}else console.log('Search percentiles deferred: full catalogue is still refreshing.');
