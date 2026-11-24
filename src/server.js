import express from 'express';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {openDB} from './db.js';
import {seed} from './seed.js';
import {stamp,day,passwordMatches,requireThat as check,Failure} from './common.js';
import * as domain from './domain.js';
import {dispatch,replay,verify,route} from './coordination.js';

export async function createApp(db,{worker=true,password=process.env.DEMO_PASSWORD||'Warehouse2026!'}={}){
  await seed(db,password);
  const app=express(), limits=new Map();
  let paused=false,active=false;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'"});
    if(req.method==='POST' && req.headers.origin!==undefined && req.headers.origin!==req.protocol+'://'+req.get('host'))return next(new Failure('跨站请求被拒绝',403));
    next();
  });
  app.use(express.json({limit:'64kb'}));
  app.use('/icons',express.static(fileURLToPath(new URL('../node_modules/lucide/icons/',import.meta.url))));
  app.use(express.static(fileURLToPath(new URL('../public/',import.meta.url))));
  app.get('/api/health',async(req,res)=>{await db.tx(tx=>tx.one('SELECT id FROM system_lock WHERE id=1'));res.json({status:'ok',driver:db.driver});});
  app.post('/api/login',async(req,res)=>{
    const {username,password}=req.body||{},ip=req.ip;
    check(typeof username==='string'&&username.length<=64&&typeof password==='string'&&password.length<=128,'请输入账号和密码');
    const recent=limits.get(ip);check(!recent||recent.until<Date.now()||recent.count<12,'登录过于频繁，请五分钟后重试',429);
    const user=await db.tx(tx=>tx.one("SELECT * FROM users WHERE username=? AND role IN ('ADMIN','OPERATOR','VIEWER')",[username]));
    if(!user||!passwordMatches(password,user.password_hash)){
      const limit=recent&&recent.until>Date.now()?recent:{until:Date.now()+300000,count:0};limit.count++;limits.set(ip,limit);throw new Failure('账号或密码不正确',401);
    }
    limits.delete(ip);const token=randomBytes(32).toString('hex');
    await db.tx(tx=>tx.run('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)',[token,user.id,new Date(Date.now()+28800000).toISOString()]));
    res.cookie('warehouse_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='1',maxAge:28800000});
    res.json({username:user.username,name:user.name,role:user.role});
  });
  app.use('/api',async(req,res,next)=>{
    req.token=(req.headers.cookie||'').match(/(?:^|;\s*)warehouse_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if(req.token)req.user=await db.tx(tx=>tx.one('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?',[req.token,stamp()]));
    check(req.user,'请先登录',401);res.set('Cache-Control','no-store');next();
  });
  app.get('/api/me',(req,res)=>res.json(req.user));
  app.post('/api/logout',async(req,res)=>{await db.tx(tx=>tx.run('DELETE FROM sessions WHERE id=?',[req.token]));res.clearCookie('warehouse_session');res.json({ok:true});});
  app.get('/api/state',async(req,res)=>{
    const queries={products:'SELECT * FROM products ORDER BY id',locations:'SELECT * FROM locations ORDER BY id',
      lots:'SELECT * FROM lots ORDER BY expiry,batch,location_id',orders:'SELECT * FROM orders ORDER BY created_at DESC,id',
      lines:'SELECT * FROM order_lines',allocations:'SELECT * FROM allocations',receipts:'SELECT * FROM receipts ORDER BY created_at DESC',
      moves:'SELECT m.*,u.name AS operator FROM stock_moves m JOIN users u ON u.id=m.operator_id ORDER BY m.created_at DESC,m.id',
      shipments:'SELECT * FROM shipments ORDER BY created_at DESC',tracking:'SELECT * FROM tracking ORDER BY created_at,id',
      events:'SELECT * FROM outbox ORDER BY seq DESC',readings:'SELECT * FROM readings ORDER BY created_at DESC,id',alerts:'SELECT * FROM alerts ORDER BY created_at DESC'};
    const state=await db.tx(async tx=>{
      const snapshot={driver:db.driver,today:day(),paused};for(const [key,sql] of Object.entries(queries))snapshot[key]=await tx.rows(sql);return snapshot;
    });res.json(state);
  });
  app.get('/api/reconcile',async(req,res)=>res.json(await db.tx(verify)));
  app.get('/api/orders/:id/route',async(req,res)=>res.json(await db.tx(async tx=>{
    check(await tx.one('SELECT id FROM orders WHERE id=?',[req.params.id]),'订单不存在',404);
    return route(await tx.rows('SELECT DISTINCT p.id,p.x,p.y FROM allocations a JOIN lots l ON l.id=a.lot_id JOIN locations p ON p.id=l.location_id WHERE a.order_id=?',[req.params.id]));
  })));
  function permit(req,admin){check(admin?req.user.role==='ADMIN':['ADMIN','OPERATOR'].includes(req.user.role),'当前角色无此权限',403);}
  function write(path,admin,fn){
    app.post('/api/'+path,async(req,res)=>{
      permit(req,admin);const body=req.body||{},resource=req.params.id||'';
      const result=await domain.command(db,req.user.id,req.get('Idempotency-Key'),path,resource,body,tx=>fn(tx,body,req.user.id,resource));res.json(result);
    });
  }
  write('receipts',false,(tx,b,u)=>domain.receive(tx,u,b));
  write('counts',true,(tx,b,u)=>domain.count(tx,u,b));
  write('orders',false,domain.createOrder);
  for(const action of ['reserve','pick','ship','cancel'])write('orders/:id/'+action,false,(tx,b,u,k)=>domain.transition(tx,u,k,action));
  write('readings',false,domain.temperature);write('alerts/:id/resolve',true,(tx,b,u,k)=>domain.resolveAlert(tx,k));
  write('shipments/:id/tracking',false,(tx,b,u,k)=>domain.tracking(tx,k,b));write('events/:id/retry',true,(tx,b,u,k)=>replay(tx,k));
  app.post('/api/events/worker',(req,res)=>{permit(req,true);check(typeof req.body?.paused==='boolean','需要工作器开关');paused=req.body.paused;res.json({paused});});
  app.post('/api/events/dispatch',async(req,res)=>{permit(req,true);check(typeof req.body?.fail==='boolean','需要指定故障模式');res.json(await dispatch(db,{force:true,fail:req.body.fail}));});
  app.use((req,res)=>res.status(404).json({error:'资源不存在'}));
  app.use((err,req,res,next)=>{const code=err.status||500;if(code>=500)console.error(err);res.status(code).json({error:code>=500?'数据库或服务暂时不可用':err.message});});
  const timer=worker && setInterval(async()=>{if(active||paused)return;active=true;try{await dispatch(db);}catch(e){console.error(e.message);}finally{active=false;}},1500);
  timer?.unref?.();return {app,stop:()=>clearInterval(timer)};
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url){
  const db=await openDB();const runtime=await createApp(db);
  const port=Number(process.env.PORT||3210);
  const server=runtime.app.listen(port,process.env.HOST||'127.0.0.1',()=>console.log('智慧仓储 http://localhost:'+port+' · '+db.driver));
  for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{runtime.stop();server.close(async()=>{await db.close();process.exit(0);});});
}
