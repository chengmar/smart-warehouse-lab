import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openDB} from '../src/db.js';
import {createApp} from '../src/server.js';
import {id,day} from '../src/common.js';
import {receive,count,createOrder,transition,temperature,tracking,command} from '../src/domain.js';
import {dispatch,replay,verify,route} from '../src/coordination.js';

let db,runtime,server,url,adminCookie,operatorCookie,viewerCookie;
const receipt=(extra={})=>({product_id:'P01',location_id:'A-04',batch:id('T-'),quantity:5,expiry:day(50),supplier:'验收供货方',...extra});
const order=(lines=[{product_id:'P01',qty:2}])=>({customer:'验收门店',destination:'收货台',lines});
const create=(lines)=>db.tx(tx=>createOrder(tx,order(lines)));
const act=(o,a)=>db.tx(tx=>transition(tx,'operator',o.id,a));
const arrive=b=>db.tx(tx=>receive(tx,'operator',b));
const get=(sql,args)=>db.tx(tx=>tx.one(sql,args));
async function request(path,{body,cookie,key=id(),headers={}}={}){
  const r=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...cookie&&{Cookie:cookie},...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function freshProduct(){
  const product=id('P');
  await db.tx(tx=>tx.run("INSERT INTO products (id,name,category,unit,min_stock,cold) VALUES (?,?,'测试','盒',0,0)",[product,product]));
  return product;
}
before(async()=>{
  if(process.env.DB_DRIVER==='mysql' && process.env.MYSQL_DATABASE!=='warehouse_test')throw Error('测试仅允许专用 warehouse_test 库');
  db=await openDB({...process.env,SQLITE_PATH:':memory:'});
  if(db.driver==='mysql')await db.tx(async tx=>{
    for(const t of ['sessions','idempotency','alerts','readings','tracking','shipments','stock_moves','allocations','order_lines','orders','receipts','lots','locations','products','outbox','users'])await tx.run('DELETE FROM '+t);
  });
  runtime=await createApp(db,{worker:false,password:'Test-course-2026!'});
  server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  [adminCookie,operatorCookie,viewerCookie]=await Promise.all(['admin','operator','viewer'].map(async username=>(await request('login',{body:{username,password:'Test-course-2026!'}})).cookie));
});
after(async()=>{runtime?.stop();if(server)await new Promise(r=>server.close(r));await db?.close();});

test('M01 同商品同货位批次合并，单据逐次保留',async()=>{const b=receipt(),a=await arrive(b),c=await arrive(b);assert.equal(a.lot_id,c.lot_id);assert.equal((await get('SELECT on_hand FROM lots WHERE id=?',[a.lot_id])).on_hand,10);assert.equal(Number((await get('SELECT COUNT(*) n FROM receipts WHERE lot_id=?',[a.lot_id])).n),2);});
for(const [name,patch,msg] of [
 ['零数量',{quantity:0},/整数/],['小数数量',{quantity:0.5},/整数/],['超过上限',{quantity:100001},/整数/],
 ['冷链货位不兼容',{product_id:'P03'},/冷链/],['货位溢出',{quantity:501},/容量/],['当日到期',{expiry:day()},/效期/],
 ['非法日历日期',{expiry:'2030-02-30'},/效期/],['商品缺失',{product_id:'missing'},/不存在/]
])test('M02 入库边界 · '+name,async()=>{await assert.rejects(arrive(receipt(patch)),msg);});
test('M03 跨货位同批号须使用同一效期',async()=>{const b=receipt();await arrive(b);await assert.rejects(arrive({...b,location_id:'B-04',expiry:day(51)}),/效期/);});
test('M04 重复商品合并成一行且校验合计上限',async()=>{const rows=q=>[{product_id:'P01',qty:q},{product_id:'P01',qty:2}];const o=await create(rows(1));assert.equal((await get('SELECT qty FROM order_lines WHERE order_id=?',[o.id])).qty,3);await assert.rejects(create(rows(100000)),/整数/);await assert.rejects(create([]),/商品/);});
test('M05 FEFO 拆批并按货位破同效期平局',async()=>{const product_id=await freshProduct();const inbound=receipt({product_id,expiry:day(1),quantity:2});const b=await arrive({...inbound,location_id:'B-04'}),a=await arrive(inbound);await arrive({...inbound,batch:'Z',expiry:day(80)});const o=await create([{product_id,qty:3}]);await act(o,'reserve');assert.equal((await get('SELECT reserved FROM lots WHERE id=?',[a.lot_id])).reserved,2);assert.equal((await get('SELECT reserved FROM lots WHERE id=?',[b.lot_id])).reserved,1);});
test('M06 到期批次从分配中排除',async()=>{const product_id=await freshProduct(),l=await arrive(receipt({product_id}));await db.tx(tx=>tx.run('UPDATE lots SET expiry=? WHERE id=?',[day(),l.lot_id]));const o=await create([{product_id,qty:1}]);await assert.rejects(act(o,'reserve'),/库存不足/);});
test('M07 多行缺货时回滚已做的分配和流水',async()=>{const last=await freshProduct(),o=await create([{product_id:'P01',qty:1},{product_id:last,qty:1}]);await assert.rejects(act(o,'reserve'),/库存不足/);assert.equal(Number((await get('SELECT COUNT(*) n FROM allocations WHERE order_id=?',[o.id])).n),0);assert.equal(Number((await get('SELECT COUNT(*) n FROM stock_moves WHERE order_id=?',[o.id])).n),0);});
test('M08 并发争抢5件库存，仅一张4件订单成功',async()=>{const product_id=await freshProduct();await arrive(receipt({product_id}));const orders=await Promise.all(Array.from({length:6},()=>create([{product_id,qty:4}])));const results=await Promise.allSettled(orders.map(o=>act(o,'reserve')));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);});
test('M09 拣货不扣库存，归位取消释放占用',async()=>{const product_id=await freshProduct(),l=await arrive(receipt({product_id})),o=await create([{product_id,qty:3}]);await act(o,'reserve');await act(o,'pick');assert.equal((await get('SELECT on_hand FROM lots WHERE id=?',[l.lot_id])).on_hand,5);await act(o,'cancel');assert.equal((await get('SELECT reserved FROM lots WHERE id=?',[l.lot_id])).reserved,0);});
test('M10 越级出库及出库后取消均拒绝',async()=>{const o=await create();await assert.rejects(act(o,'ship'),/状态/);for(const a of ['reserve','pick','ship'])await act(o,a);await assert.rejects(act(o,'cancel'),/状态/);});
test('M11 盘点差额、旧版本和零库存',async()=>{const l=await arrive(receipt());const v=(await get('SELECT version FROM lots WHERE id=?',[l.lot_id])).version;const input={lot_id:l.lot_id,version:v,counted:0,reason:'现场复核'};assert.equal((await db.tx(tx=>count(tx,'admin',input))).delta,-5);await assert.rejects(db.tx(tx=>count(tx,'admin',input)),/版本/);});
test('M12 实盘不能挤占预留或突破库容',async()=>{const product_id=await freshProduct(),l=await arrive(receipt({product_id})),o=await create([{product_id,qty:3}]);await act(o,'reserve');const v=(await get('SELECT version FROM lots WHERE id=?',[l.lot_id])).version;for(const [counted,msg] of [[2,/预留/],[501,/容量/]])await assert.rejects(db.tx(tx=>count(tx,'admin',{lot_id:l.lot_id,counted,version:v,reason:'现场'})),msg);});
test('M13 阈值含端点，连续异常合并，恢复正常后人工关闭',async()=>{for(const t of [2,8])assert.equal((await db.tx(tx=>temperature(tx,{temperature:t}))).alert,null);const a=await db.tx(tx=>temperature(tx,{temperature:1.9})),b=await db.tx(tx=>temperature(tx,{temperature:8.1}));assert.equal(a.alert,b.alert);await db.tx(tx=>temperature(tx,{temperature:4}));assert.equal((await get('SELECT status FROM alerts WHERE id=?',[a.alert])).status,'OPEN');assert.equal((await request('alerts/'+a.alert+'/resolve',{cookie:adminCookie,body:{}})).data.status,'RESOLVED');});
test('M14 未注册设备及超出量程拒绝',async()=>{await assert.rejects(db.tx(tx=>temperature(tx,{temperature:4,device_id:'NO'})),/设备/);await assert.rejects(db.tx(tx=>temperature(tx,{temperature:81})),/温度/);});
test('M15 事件五次失败转死信，重放只生成一张运单',async()=>{
  while((await dispatch(db,{force:true})).consumed){}
  const o=await create();for(const a of ['reserve','pick','ship'])await act(o,a);
  for(let i=0;i<5;i++)await dispatch(db,{force:true,fail:true});
  const e=await get("SELECT * FROM outbox WHERE aggregate_id=? AND type='OrderShipped'",[o.id]);assert.equal(e.status,'DEAD');assert.equal(e.attempts,5);
  await db.tx(tx=>replay(tx,e.id));await dispatch(db,{force:true});
  await db.tx(tx=>tx.run("UPDATE outbox SET status='RETRY' WHERE id=?",[e.id]));await dispatch(db,{force:true});
  assert.equal(Number((await get('SELECT COUNT(*) n FROM shipments WHERE order_id=?',[o.id])).n),1);
});
test('M16 物流拒绝跳步，签收后订单同步且库存不变',async()=>{const s=await get("SELECT * FROM shipments WHERE status='CREATED' LIMIT 1");const before=await get('SELECT SUM(on_hand) n FROM lots');const send=status=>db.tx(tx=>tracking(tx,s.id,{status,message:'门店回传'}));await assert.rejects(send('DELIVERED'),/顺序/);await send('IN_TRANSIT');await send('DELIVERED');assert.equal((await get('SELECT status FROM orders WHERE id=?',[s.order_id])).status,'DELIVERED');assert.equal((await get('SELECT SUM(on_hand) n FROM lots')).n,before.n);});
test('M17 同键重复请求只执行一次，同键异载荷拒绝',async()=>{const b=receipt(),key=id();const call=input=>command(db,'operator',key,'receive','',input,tx=>receive(tx,'operator',input));assert.deepEqual(await call(b),await call(b));await assert.rejects(call({...b,quantity:3}),/请求键/);});
test('M18 路线去重，从复核台往返且不长于编号基线',()=>{const a={id:'A',x:9,y:2},r=route([a,{id:'B',x:2,y:1},a]);assert.equal(r.points.length,4);assert.equal(r.points[0].id,r.points.at(-1).id);assert.ok(r.distance<=r.baseline);assert.equal(route([]).distance,0);});
test('M19 对账可定位数量差异和事件摘要变动',async()=>{assert.equal((await db.tx(verify)).ok,true);
  await assert.rejects(db.tx(async tx=>{const l=await tx.one('SELECT id FROM lots LIMIT 1');await tx.run('UPDATE lots SET on_hand=on_hand+1 WHERE id=?',[l.id]);await tx.run("UPDATE outbox SET payload='{}' WHERE seq=1");const r=await verify(tx);assert.equal(r.differences[0].id,l.id);assert.ok(r.broken.includes(1));throw Error('回滚测试变更');}),/回滚测试/);
});
test('F01 未登录、无效口令、注销后访问',async()=>{assert.equal((await request('state')).status,401);assert.equal((await request('login',{body:{username:'operator',password:'错误'}})).status,401);const r=await request('login',{body:{username:'viewer',password:'Test-course-2026!'}});await request('logout',{cookie:r.cookie,body:{}});assert.equal((await request('state',{cookie:r.cookie})).status,401);});
test('F02 作业员入库后流水记录会话身份，伪造操作人无效',async()=>{const r=await request('receipts',{cookie:operatorCookie,body:receipt({operator_id:'admin'})});assert.equal(r.status,200);assert.equal((await get('SELECT operator_id FROM stock_moves WHERE lot_id=?',[r.data.lot_id])).operator_id,'operator');});
test('F03 权限覆盖三种角色及跨站检查',async()=>{for(const path of ['orders','receipts','readings','shipments/missing/tracking'])assert.equal((await request(path,{cookie:viewerCookie,body:{}})).status,403);for(const path of ['counts','events/worker','events/dispatch','events/missing/retry','alerts/missing/resolve'])assert.equal((await request(path,{cookie:operatorCookie,body:{}})).status,403);assert.equal((await request('orders',{cookie:adminCookie,body:order(),headers:{Origin:'https://invalid.example'}})).status,403);assert.equal((await request('reconcile',{cookie:viewerCookie})).data.ok,true);});
test('F04 入库、建单、出库、回传和签收全流程',async()=>{
  const product_id=await freshProduct(),cookie=operatorCookie;const post=async(path,body)=>{const r=await request(path,{body,cookie});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
  const arrival=await post('receipts',receipt({product_id}));const o=await post('orders',order([{product_id,qty:4}]));
  for(const a of ['reserve','pick','ship'])await post('orders/'+o.id+'/'+a,{});
  await dispatch(db,{force:true});const s=await get('SELECT * FROM shipments WHERE order_id=?',[o.id]);
  for(const status of ['IN_TRANSIT','DELIVERED'])await post('shipments/'+s.id+'/tracking',{status,message:'验收'});
  assert.equal((await get('SELECT on_hand FROM lots WHERE id=?',[arrival.lot_id])).on_hand,1);assert.equal((await request('reconcile',{cookie})).data.ok,true);
});
test('F05 幂等键缺失、错误文本、对象不存在',async()=>{assert.equal((await request('receipts',{body:receipt(),cookie:adminCookie,key:'a'})).status,400);assert.equal((await request('orders',{cookie:adminCookie,body:{...order(),customer:' '}})).status,400);assert.equal((await request('orders/absent/route',{cookie:viewerCookie})).status,404);});
