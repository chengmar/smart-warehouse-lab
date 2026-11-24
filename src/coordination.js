import {id,stamp,requireThat as check} from './common.js';
import {eventDigest} from './domain.js';

export async function dispatch(db,{force=false,fail=false}={}){
  const due=force?'9999':stamp();
  const jobs=await db.tx(tx=>tx.rows("SELECT id FROM outbox WHERE status IN ('PENDING','RETRY') AND available_at<=? ORDER BY seq LIMIT 30",[due]));
  let consumed=0,failed=0;
  for(const job of jobs){
    let attempt;
    try{
      consumed+=await db.tx(async tx=>{
        const e=await tx.one('SELECT * FROM outbox WHERE id=?',[job.id]);
        if(!['PENDING','RETRY'].includes(e.status)||e.available_at>due)return 0;
        attempt=e.attempts;
        if(fail)throw Error('模拟承运服务暂时离线');
        if(e.type==='OrderShipped' && !await tx.one('SELECT id FROM shipments WHERE order_id=?',[e.aggregate_id])){
          const shipment=id('WB-'), time=stamp();
          await tx.run("INSERT INTO shipments (id,order_id,carrier,status,created_at) VALUES (?,?,?,'CREATED',?)",[shipment,e.aggregate_id,'北辰配送（模拟）',time]);
          await tx.run("INSERT INTO tracking (id,shipment_id,status,message,created_at) VALUES (?,?,'CREATED',?,?)",[id(),shipment,'仓库已交接发运清单',time]);
        }
        await tx.run("UPDATE outbox SET status='DONE', consumed_at=?,attempts=attempts+1,error=NULL WHERE id=?",[stamp(),e.id]);
        return 1;
      });
    }catch(error){
      if(attempt===undefined)throw error;
      const n=attempt+1, next=new Date(Date.now()+Math.min(60000,1000*2**n)).toISOString();
      failed+=await db.tx(tx=>tx.run("UPDATE outbox SET status=?,attempts=?,available_at=?,error=? WHERE id=? AND attempts=? AND status IN ('PENDING','RETRY')",
        [n>=5?'DEAD':'RETRY',n,next,error.message.slice(0,256),job.id,attempt]));
    }
  }
  return {consumed,failed};
}
export async function replay(tx,event){
  const updated=await tx.run("UPDATE outbox SET status='RETRY',available_at=?,attempts=0 WHERE id=? AND status='DEAD'",[stamp(),event]);
  check(updated===1,'只有死信事件可以重放',409);return {id:event,status:'RETRY'};
}
export async function verify(tx){
  const rows=await tx.rows(`SELECT l.id,l.on_hand,l.reserved,COALESCE(m.h,0) AS ledger_hand,COALESCE(m.r,0) AS ledger_reserved,COALESCE(a.qty,0) AS active
    FROM lots l LEFT JOIN (SELECT lot_id,SUM(delta_hand) h,SUM(delta_reserved) r FROM stock_moves GROUP BY lot_id) m ON m.lot_id=l.id
    LEFT JOIN (SELECT a.lot_id,SUM(a.qty) qty FROM allocations a JOIN orders o ON a.order_id=o.id WHERE o.status IN ('RESERVED','PICKED') GROUP BY a.lot_id) a ON a.lot_id=l.id`);
  const differences=rows.filter(r=>r.on_hand!==Number(r.ledger_hand)||r.reserved!==Number(r.ledger_reserved)||r.reserved!==Number(r.active)||r.reserved<0||r.reserved>r.on_hand);
  const events=await tx.rows('SELECT * FROM outbox ORDER BY seq');
  let prior='GENESIS';const broken=[];
  for(const [i,e] of events.entries()){if(e.seq!==i+1||e.previous_hash!==prior||eventDigest(e)!==e.hash)broken.push(e.seq);prior=e.hash;}
  return {ok:!differences.length&&!broken.length,lots:rows.length,events:events.length,differences,broken,at:stamp()};
}
export function route(locations){
  const base=[...new Map(locations.map(p=>[p.id,p])).values()].sort((a,b)=>a.id.localeCompare(b.id));
  const dock={id:'复核台',x:0,y:0};
  const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
  const length=points=>[...points,dock].reduce((sum,p,i)=>sum+distance(i?points[i-1]:dock,p),0);
  let remaining=[...base], path=[], last=dock;
  while(remaining.length){remaining.sort((a,b)=>distance(last,a)-distance(last,b)||a.id.localeCompare(b.id));last=remaining.shift();path.push(last);}
  let best=length(path), improved=true;
  while(improved){
    improved=false;
    for(let i=0;i<path.length;i++)for(let j=i+1;j<path.length;j++){
      const candidate=[...path.slice(0,i),...path.slice(i,j+1).reverse(),...path.slice(j+1)];
      const steps=length(candidate);if(steps<best){best=steps;path=candidate;improved=true;}
    }
  }
  const baseline=length(base);if(best>baseline){path=base;best=baseline;}
  return {points:[dock,...path,dock],distance:best,baseline};
}
