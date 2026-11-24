import {day,encodePassword} from './common.js';
import {receive,createOrder,transition,temperature} from './domain.js';
import {dispatch} from './coordination.js';

export async function seed(db,password){
  const created=await db.tx(async tx=>{
    if(await tx.one('SELECT id FROM products LIMIT 1'))return false;
    for(const [name,role,label] of [['admin','ADMIN','仓储主管'],['operator','OPERATOR','仓库作业员'],['viewer','VIEWER','业务观察员']]){
      await tx.run('INSERT INTO users (id,username,name,role,password_hash) VALUES (?,?,?,?,?)',[name,name,label,role,encodePassword(password)]);
    }
    await tx.run("INSERT INTO users (id,username,name,role,password_hash) VALUES ('seed','seed','初始化样例','SYSTEM','disabled')");
    const products=[
      ['P01','挂耳咖啡','饮品','盒',30,0],['P02','全麦饼干','食品','箱',16,0],['P03','冷藏鲜奶','冷藏品','箱',12,1],
      ['P04','保温杯','器具','个',20,0],['P05','周转包装箱','耗材','只',24,0],['P06','无糖酸奶','冷藏品','箱',12,1]
    ];
    for(const p of products)await tx.run('INSERT INTO products (id,name,category,unit,min_stock,cold) VALUES (?,?,?,?,?,?)',p);
    for(const [zone,x] of [['A',2],['B',6],['C',10]])for(let n=1;n<=4;n++){
      await tx.run('INSERT INTO locations (id,zone,x,y,capacity,cold) VALUES (?,?,?,?,?,?)',[zone+'-0'+n,zone,x,n*2,500,Number(zone==='C')]);
    }
    const stock=[['P01','A-01',80,65],['P01','B-01',40,16],['P02','A-02',45,80],['P03','C-01',55,9],['P04','B-02',26,300],['P05','B-03',18,400],['P06','C-02',38,22]];
    for(const [product_id,location_id,quantity,d] of stock)await receive(tx,'seed',{product_id,location_id,quantity,batch:'BJ-'+location_id,expiry:day(d),supplier:'北辰供应中心'});
    for(const [customer,product_id,qty,steps] of [['滨海门店','P01',6,0],['学院路门店','P02',8,1],['南开配送站','P03',4,2],['海河服务站','P04',3,3]]){
      const order=await createOrder(tx,{customer,destination:customer+'收货区',priority:steps===0?'HIGH':'NORMAL',lines:[{product_id,qty}]});
      for(const action of ['reserve','pick','ship'].slice(0,steps))await transition(tx,'seed',order.id,action);
    }
    for(const t of [4.3,4.6,5.1,4.8,4.4])await temperature(tx,{temperature:t});
    return true;
  });
  if(created)await dispatch(db);
}
