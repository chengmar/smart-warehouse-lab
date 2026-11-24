import {cpus,totalmem} from 'node:os';
import {performance} from 'node:perf_hooks';
import {once} from 'node:events';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {openDB} from '../src/db.js';
import {stamp,day,id} from '../src/common.js';
import {createApp} from '../src/server.js';

const db=await openDB({SQLITE_PATH:':memory:'});
const app=await createApp(db,{worker:false,password:'Load-test!'});
const server=app.app.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port+'/api/';
try{
  await db.tx(async tx=>{
    const time=stamp(),expiry=day(100);
    const previous=await tx.one('SELECT COUNT(*) n FROM lots');
    for(let i=previous.n;i<10000;i++){
      const loc='L-'+Math.floor(i/200),batch='LOAD-'+i;
      if(i===previous.n||i%200===0)await tx.run("INSERT INTO locations VALUES (?,'A',1,1,500,0)",[loc]);
      await tx.run('INSERT INTO lots (id,product_id,location_id,batch,expiry,on_hand) VALUES (?,?,?,?,?,1)',[batch,'P01',loc,batch,expiry]);
      await tx.run("INSERT INTO stock_moves (id,lot_id,operator_id,kind,delta_hand,delta_reserved,reason,created_at) VALUES (?,?,'seed','RECEIVE',1,0,'样本期初',?)",[batch,batch,time]);
    }
    const orders=await tx.one('SELECT COUNT(*) n FROM orders');
    for(let i=orders.n;i<10000;i++){
      const key='LOAD-ORDER-'+i;
      await tx.run("INSERT INTO orders VALUES (?,'压测样本','北辰','NORMAL','CREATED',?)",[key,time]);
      await tx.run("INSERT INTO order_lines VALUES (?,?, 'P01',1)",[key,key]);
    }
  });
  const cookies=[];
  for(let i=0;i<50;i++){
    const r=await fetch(origin+'login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'operator',password:'Load-test!'})});
    assert.equal(r.status,200);cookies.push(r.headers.get('set-cookie').split(';')[0]);
  }
  const run=async(write)=>{
    const elapsed=[];let errors=0;
    await Promise.all(cookies.map(async (cookie,i)=>{
      for(let j=0;j<4;j++){
        const headers={Cookie:cookie};const opts={headers};let path='inventory?q=LOAD-&limit=50&offset='+(i+j)*10;
        if(write){path='orders';headers['Idempotency-Key']=id();headers['Content-Type']='application/json';opts.method='POST';
          opts.body=JSON.stringify({customer:'并发测量',destination:'北辰',lines:[{product_id:'P01',qty:1}]});}
        const start=performance.now();const r=await fetch(origin+path,opts);const body=await r.json();
        elapsed.push(performance.now()-start);if(!r.ok || (write?body.status!=='CREATED':body.rows?.length!==50))errors++;
      }
    }));
    elapsed.sort((a,b)=>a-b);return {requests:elapsed.length,errors,p95_ms:Math.round(elapsed[Math.ceil(elapsed.length*.95)-1]),max_ms:Math.round(elapsed.at(-1))};
  };
  const result={at:stamp(),driver:'SQLite in-memory',node:process.version,os:process.platform,cpu:cpus()[0].model,ram_gib:Math.round(totalmem()/2**30),initial_lots:10000,initial_orders:10000,sessions:50,read:await run(false),write:await run(true)};
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/load.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  assert.equal(result.read.errors+result.write.errors,0);assert.ok(result.read.p95_ms<=2000);assert.ok(result.write.p95_ms<=3000);
}finally{app.stop();await new Promise(r=>server.close(r));await db.close();}
