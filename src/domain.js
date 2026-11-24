import {day, stamp, id, digest, sortedJSON, requireThat as check, string, units} from './common.js';

export const eventDigest = e => digest(JSON.stringify([e.seq,e.type,e.aggregate_id,e.payload,e.created_at,e.previous_hash]));
export async function recordEvent(tx,type,aggregate,data) {
  const last=await tx.one('SELECT seq,hash FROM outbox ORDER BY seq DESC LIMIT 1');
  const e={seq:(last?.seq||0)+1,type,aggregate_id:aggregate,payload:JSON.stringify(data),created_at:stamp(),previous_hash:last?.hash||'GENESIS'};
  await tx.run("INSERT INTO outbox (id,seq,type,aggregate_id,payload,created_at,previous_hash,hash,status,attempts,available_at) VALUES (?,?,?,?,?,?,?,?,'PENDING',0,?)",
    [id(),e.seq,type,aggregate,e.payload,e.created_at,e.previous_hash,eventDigest(e),e.created_at]);
}
export async function command(db,actor,key,action,resource,body,perform) {
  check(typeof key==='string' && key.length>=8 && key.length<=64,'需要 8～64 字符的幂等键');
  const fingerprint=digest(JSON.stringify([actor,action,resource,sortedJSON(body)]));
  return db.tx(async tx=>{
    const old=await tx.one('SELECT fingerprint,response FROM idempotency WHERE id=?',[key]);
    if(old){check(old.fingerprint===fingerprint,'该请求键已用于其他操作',409);return JSON.parse(old.response);}
    const result=await perform(tx);
    await tx.run('INSERT INTO idempotency (id,fingerprint,response,created_at) VALUES (?,?,?,?)',[key,fingerprint,JSON.stringify(result),stamp()]);
    return result;
  });
}
async function adjust(tx,actor,lot,kind,hand,reserved,reason,orderId=null) {
  const changed=await tx.run('UPDATE lots SET on_hand=on_hand+?, reserved=reserved+?, version=version+1 WHERE id=? AND version=? AND on_hand+?>=reserved+? AND reserved+?>=0',
    [hand,reserved,lot.id,lot.version,hand,reserved,reserved]);
  check(changed===1,'库存版本已变化，请刷新后核对',409);
  await tx.run('INSERT INTO stock_moves (id,lot_id,order_id,operator_id,kind,delta_hand,delta_reserved,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id(),lot.id,orderId,actor,kind,hand,reserved,reason,stamp()]);
}
async function capacity(tx,location,delta){
  const row=await tx.one('SELECT COALESCE(SUM(on_hand),0) AS used FROM lots WHERE location_id=?',[location.id]);
  check(Number(row.used)+delta<=location.capacity,'货位容量不足',409);
}
export async function receive(tx,actor,input){
  const productId=string(input.product_id,64), locationId=string(input.location_id,64);
  const batch=string(input.batch,64), supplier=string(input.supplier), qty=units(input.quantity), expiry=input.expiry;
  check(typeof expiry==='string' && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && Number.isFinite(Date.parse(expiry)) &&
    new Date(expiry).toISOString().startsWith(expiry+'T') && expiry>day(),'效期必须是晚于今天的有效日期');
  const product=await tx.one('SELECT * FROM products WHERE id=?',[productId]);
  const location=await tx.one('SELECT * FROM locations WHERE id=?',[locationId]);
  check(product && location,'商品或货位不存在',404);
  check(!product.cold || location.cold,'冷链商品须存入冷藏货位',409);
  await capacity(tx,location,qty);
  check(!await tx.one('SELECT id FROM lots WHERE product_id=? AND batch=? AND expiry<>?',[productId,batch,expiry]),'该批号在其他记录中的效期不同',409);
  let lot=await tx.one('SELECT id,version FROM lots WHERE product_id=? AND location_id=? AND batch=?',[productId,locationId,batch]);
  if(!lot){lot={id:id(),version:1};await tx.run('INSERT INTO lots (id,product_id,location_id,batch,expiry) VALUES (?,?,?,?,?)',[lot.id,productId,locationId,batch,expiry]);}
  await adjust(tx,actor,lot,'RECEIVE',qty,0,supplier);
  const receipt=id('IN-');
  await tx.run('INSERT INTO receipts (id,lot_id,qty,supplier,created_at) VALUES (?,?,?,?,?)',[receipt,lot.id,qty,supplier,stamp()]);
  await recordEvent(tx,'StockReceived',lot.id,{receipt,qty});
  return {id:receipt,lot_id:lot.id,qty};
}
export async function count(tx,actor,input){
  const value=units(input.counted,0), reason=string(input.reason,256);
  const lot=await tx.one('SELECT * FROM lots WHERE id=?',[string(input.lot_id,64)]);
  check(lot,'批次不存在',404);check(lot.version===input.version,'库存版本已变化，请刷新后核对',409);
  check(value>=lot.reserved,'实盘数量低于订单预留量',409);
  const delta=value-lot.on_hand;
  await capacity(tx,await tx.one('SELECT * FROM locations WHERE id=?',[lot.location_id]),delta);
  await adjust(tx,actor,lot,'COUNT',delta,0,reason);
  await recordEvent(tx,'StockCounted',lot.id,{before:lot.on_hand,counted:value,reason});
  return {lot_id:lot.id,delta};
}
export async function createOrder(tx,input){
  const customer=string(input.customer), destination=string(input.destination), priority=input.priority||'NORMAL';
  check(['NORMAL','HIGH'].includes(priority),'订单优先级无效');
  check(Array.isArray(input.lines) && input.lines.length>=1 && input.lines.length<=20,'订单需要 1～20 行商品');
  const amounts=new Map();
  for(const line of input.lines){
    const product=string(line?.product_id,64);
    amounts.set(product,units((amounts.get(product)||0)+units(line.qty)));
  }
  const order=id('SO-');
  await tx.run("INSERT INTO orders (id,customer,destination,priority,status,created_at) VALUES (?,?,?,?,'CREATED',?)",[order,customer,destination,priority,stamp()]);
  for(const [product,qty] of amounts){
    check(await tx.one('SELECT id FROM products WHERE id=?',[product]),'商品不存在',404);
    await tx.run('INSERT INTO order_lines (id,order_id,product_id,qty) VALUES (?,?,?,?)',[id(),order,product,qty]);
  }
  await recordEvent(tx,'OrderCreated',order,{customer,items:[...amounts]});
  return {id:order,status:'CREATED'};
}
async function reserve(tx,actor,order){
  const lines=await tx.rows('SELECT product_id,qty FROM order_lines WHERE order_id=? ORDER BY product_id',[order]);
  const cutoff=day();
  for(const line of lines){
    let needed=line.qty;
    const lots=await tx.rows('SELECT * FROM lots WHERE product_id=? AND expiry>? AND on_hand>reserved ORDER BY expiry,batch,location_id,id',[line.product_id,cutoff]);
    for(const lot of lots){
      const take=Math.min(needed,lot.on_hand-lot.reserved);
      await adjust(tx,actor,lot,'RESERVE',0,take,'订单预留',order);
      await tx.run('INSERT INTO allocations (id,order_id,lot_id,qty) VALUES (?,?,?,?)',[id(),order,lot.id,take]);
      needed-=take;if(!needed)break;
    }
    check(!needed,'商品 '+line.product_id+' 库存不足，整单未分配',409);
  }
}
const transitions={
  reserve:{from:['CREATED'],to:'RESERVED',event:'InventoryReserved'},pick:{from:['RESERVED'],to:'PICKED',event:'OrderPicked'},
  ship:{from:['PICKED'],to:'SHIPPED',event:'OrderShipped'},cancel:{from:['CREATED','RESERVED','PICKED'],to:'CANCELLED',event:'OrderCancelled'}
};
export async function transition(tx,actor,order,action){
  const current=await tx.one('SELECT status FROM orders WHERE id=?',[order]);
  check(current,'订单不存在',404);const rule=transitions[action];check(rule?.from.includes(current.status),'当前订单状态不支持该操作',409);
  if(action==='reserve')await reserve(tx,actor,order);
  if(action==='ship' || action==='cancel'){
    const lots=await tx.rows('SELECT l.*,a.qty FROM allocations a JOIN lots l ON l.id=a.lot_id WHERE a.order_id=?',[order]);
    for(const lot of lots) {
      const shipping=action==='ship';
      await adjust(tx,actor,lot,shipping?'SHIP':'RELEASE',shipping?-lot.qty:0,-lot.qty,shipping?'复核出库':'取消订单释放预留',order);
    }
  }
  await tx.run('UPDATE orders SET status=? WHERE id=?',[rule.to,order]);
  await recordEvent(tx,rule.event,order,{from:current.status,to:rule.to});
  return {id:order,status:rule.to};
}
export async function temperature(tx,input){
  const {temperature:t,device_id='COLD-01'}=input;
  check(device_id==='COLD-01','设备不存在',404);check(Number.isFinite(t)&&t>=-50&&t<=80,'温度须在 -50～80℃');
  const time=stamp();await tx.run('INSERT INTO readings (id,device_id,temperature,created_at) VALUES (?,?,?,?)',[id(),device_id,t,time]);
  let alert=null;
  if(t<2 || t>8){
    const existing=await tx.one("SELECT id FROM alerts WHERE status='OPEN' AND kind='TEMPERATURE'");
    alert=existing?.id || id();
    if(!existing)await tx.run("INSERT INTO alerts (id,kind,message,status,created_at) VALUES (?,'TEMPERATURE',?,'OPEN',?)",[alert,'冷藏区温度异常 '+t+'℃',time]);
  }
  await recordEvent(tx,'TemperatureRecorded',device_id,{temperature:t,alert});return {temperature:t,alert};
}
export async function resolveAlert(tx,alert){
  check(await tx.run("UPDATE alerts SET status='RESOLVED',resolved_at=? WHERE id=? AND status='OPEN'",[stamp(),alert])===1,'告警不存在或已处理',409);
  await recordEvent(tx,'AlertResolved',alert,{});return {id:alert,status:'RESOLVED'};
}
export async function tracking(tx,shipment,input){
  const current=await tx.one('SELECT * FROM shipments WHERE id=?',[shipment]);check(current,'运单不存在',404);
  const next={CREATED:'IN_TRANSIT',IN_TRANSIT:'DELIVERED'}[current.status];
  check(next && input.status===next,'运单状态重复或顺序错误',409);const message=string(input.message,256);
  await tx.run('UPDATE shipments SET status=? WHERE id=?',[next,shipment]);
  await tx.run('INSERT INTO tracking (id,shipment_id,status,message,created_at) VALUES (?,?,?,?,?)',[id(),shipment,next,message,stamp()]);
  if(next==='DELIVERED')check(await tx.run("UPDATE orders SET status='DELIVERED' WHERE id=? AND status='SHIPPED'",[current.order_id])===1,'订单状态冲突',409);
  await recordEvent(tx,'TrackingUpdated',shipment,{status:next,message});return {id:shipment,status:next};
}
