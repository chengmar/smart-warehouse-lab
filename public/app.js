const root=document.querySelector('#app'), dialog=document.querySelector('#drawer');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=n=>`<img alt="" class="ico" src="/icons/${n}.svg">`;
const btn=(label,action,options={})=>`<button type="button" class="btn ${options.cls||''}" data-act="${action}" data-id="${esc(options.id)}" ${options.extra||''}>${options.icon?icon(options.icon):''}${esc(label)}</button>`;
const short=id=>id ? id.replace(/^([A-Z]+-)(.{8}).*$/,'$1$2').toUpperCase() : '—';
const fmt=t=>t?new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'}):'—';
const labels={CREATED:'待分配',RESERVED:'待拣货',PICKED:'待出库',SHIPPED:'已出库',DELIVERED:'已签收',CANCELLED:'已取消',IN_TRANSIT:'运输中',OPEN:'待处理',RESOLVED:'已处理',DONE:'已消费',DEAD:'死信',PENDING:'待投递',RETRY:'待重试',RECEIVE:'入库',COUNT:'盘点',RESERVE:'预留',SHIP:'出库',RELEASE:'释放'};
const badge=(s,label)=>`<span class="badge ${['DEAD','OPEN'].includes(s)?'bad':['CREATED','PICKED','RETRY'].includes(s)?'warn':['CANCELLED','PENDING'].includes(s)?'neutral':''}">${esc(label||labels[s]||s)}</span>`;
const pages={overview:['调度总览','layout-dashboard'],inventory:['库存货位','warehouse'],orders:['出库订单','clipboard-list'],logistics:['物流跟踪','truck'],cold:['冷链监测','thermometer'],audit:['流水与核对','list-checks'],events:['事件中心','activity']};
let user,state,page='overview',search='',filter='',report=null,noticeTimer,selected=null,refreshing=false,generation=0;
const admin=()=>user.role==='ADMIN', staff=()=>user.role!=='VIEWER';
const p=id=>state.products.find(x=>x.id===id)||{};
const lot=id=>state.lots.find(x=>x.id===id)||{};
const days=date=>Math.round((Date.parse(date)-Date.parse(state.today))/86400000);
const empty=text=>`<div class="empty">${esc(text||'暂无记录')}</div>`;
function toast(text){const box=document.querySelector('#notice');box.textContent=text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>box.textContent='',3300);}
async function api(path,body,key){
  const options={method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{}};
  if(body!==undefined){options.body=JSON.stringify(body);options.headers={'Content-Type':'application/json','Idempotency-Key':key||crypto.randomUUID()};}
  const response=await fetch('/api/'+path,options);const data=await response.json();
  if(!response.ok){if(response.status===401 && path!=='login'){generation++;user=null;if(dialog.open)dialog.close();login();}throw Error(data.error||'请求失败');}return data;
}
const brand=`<div class="brand"><i>${icon('boxes')}</i><div>仓序<small>WAREHOUSE</small></div></div>`;
function login(){
  root.innerHTML=`<main class="login"><section class="login-art">${brand}<h1>智慧仓储<br><span>与物流协同</span></h1><div class="map" aria-hidden="true">${['A','B','C'].map(z=>`<div class="zone"><b>${z} 区</b>${[1,2,3,4].map(n=>`<span class="bin ${z==='C'?'cold':''}" style="text-align:center">${z}-0${n}</span>`).join('')}</div>`).join('')}</div></section><section class="login-form"><h2>登录仓储工作台</h2><form id="login" class="stack"><label class="field"><span>账号</span><input name="username" autocomplete="username" required value="admin"></label><label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label><p class="error" role="alert"></p><button class="btn primary">进入工作台</button></form><details><summary>课程演示账号</summary><p>主管 admin · 作业员 operator · 观察员 viewer</p><p>初始演示密码 <code>Warehouse2026!</code></p></details></section></main>`;
}
async function load(){
  const version=++generation;const fresh=await api('state');if(version!==generation||!user)return;
  state=fresh;render();
}
function go(next){location.hash=next;if(page===next){search='';filter='';render();}}
function nav(){return Object.entries(pages).map(([k,[title,i]])=>`<button class="nav-link ${k===page?'active':''}" data-page="${k}" ${k===page?'aria-current="page"':''}>${icon(i)}${title}</button>`).join('');}
function card(title,content,extra=''){return `<section class="card"><header class="card-head"><h2>${title}</h2>${extra}</header>${content}</section>`;}
function table(head,rows){return rows.length?`<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:empty('没有符合条件的记录');}
function actions(){
  const config={overview:staff()?btn('登记入库','receive',{cls:'primary',icon:'package-plus'}):'',inventory:btn('导出 CSV','export',{icon:'download'})+(staff()?btn('登记入库','receive',{cls:'primary',icon:'plus'}):''),orders:staff()?btn('创建订单','new-order',{cls:'primary',icon:'plus'}):'',cold:staff()?btn('上报温度','temperature',{cls:'primary',icon:'thermometer'}):'',audit:btn('运行核对','verify',{cls:'primary',icon:'list-checks'})};
  return config[page]||'';
}
function render(){
  const titles={overview:'北辰一号仓的库存、作业与货位使用情况。',inventory:'按商品、批次和货位查询库存。',orders:'查看订单分配、拣货和出库进度。',logistics:'从出库交接到收件签收。',cold:'查看冷藏区采样和待处理告警。',audit:'按批次核对库存数量、预留记录和操作人。',events:'查看业务事件、物流建单和失败重试。'};
  root.innerHTML=`<div class="shell"><aside class="rail">${brand}<nav aria-label="主导航">${nav()}</nav><div class="profile"><span class="avatar">${esc(user.name[0])}</span><div><b>${esc(user.name)}</b><br><small>${esc(user.username)}</small></div>${btn('','logout',{icon:'log-out',extra:'aria-label="退出登录"'})}</div></aside><main class="main"><div class="topbar"><div class="location">${icon('warehouse')}北辰一号仓 <span class="sep">/</span> ${pages[page][0]}</div><div class="group"><i class="online"></i><span class="db-label">${state.driver==='mysql'?'MySQL':'SQLite'} 已连接</span>${btn('','refresh',{cls:'quiet',icon:'refresh-cw',extra:'aria-label="刷新数据"'})}<span class="mobile-brand">${btn('','logout',{cls:'quiet',icon:'log-out',extra:'aria-label="退出登录"'})}</span></div></div><header class="page-head"><div><h1>${pages[page][0]}</h1><p>${titles[page]}</p></div><div class="actions">${actions()}</div></header><div id="view">${view()}</div></main></div>`;
}
function map(){
  return `<div class="map">${['A','B','C'].map(z=>`<div class="zone"><b>${z} 区</b>${state.locations.filter(l=>l.zone===z).map(l=>`<button class="bin ${state.lots.some(b=>b.location_id===l.id&&b.on_hand)?l.cold?'cold':'':'empty'}" data-act="bin" data-id="${l.id}">${l.id}</button>`).join('')}</div>`).join('')}<div class="map-foot"><span>${icon('move-up-right')} 收发复核台</span><div class="legend"><span><i></i>常温</span><span><i class="cold"></i>冷藏</span><span><i class="free"></i>空位</span></div></div></div>`;
}
function overview(){
  const open=state.orders.filter(o=>['CREATED','RESERVED','PICKED'].includes(o.status));
  const reminders=state.products.filter(pr=>state.lots.filter(l=>l.product_id===pr.id&&days(l.expiry)>0).reduce((n,l)=>n+l.on_hand-l.reserved,0)<pr.min_stock);
  const near=state.lots.filter(l=>l.on_hand>0&&days(l.expiry)<=30);
  const metrics=[['在库总量',state.lots.reduce((n,l)=>n+l.on_hand,0),'件','boxes',state.products.length+' 种商品'],['待办订单',open.length,'单','clipboard-list','待分配、拣货和出库'],['在途运单',state.shipments.filter(s=>s.status!=='DELIVERED').length,'单','truck','包含待揽收运单'],['冷藏区温度',state.readings[0]?.temperature??'—','℃','thermometer','COLD-01 · 最近采样']];
  const tiles=`<div class="metrics">${metrics.map(([t,n,u,i,note])=>`<article class="metric"><header>${t}${icon(i)}</header><strong>${n}<em>${u}</em></strong><small>${note}</small></article>`).join('')}</div>`;
  const list=open.slice().sort((a,b)=>Number(b.priority==='HIGH')-Number(a.priority==='HIGH')).slice(0,4);
  const tasks=list.map(o=>`<div class="task"><span class="token">${icon('package')}</span><div class="text"><b>${esc(o.customer)}</b><small class="mono">${short(o.id)}</small></div>${badge(o.status)}${btn('','detail',{id:o.id,cls:'quiet',icon:'chevron-right',extra:'aria-label="查看订单"'})}</div>`).join('');
  const alerts=[...reminders.map(x=>[x.name,'可用库存低于 '+x.min_stock+x.unit]),...near.map(l=>[p(l.product_id).name,l.location_id+' · '+l.expiry+' 到期'])];
  return tiles+`<div class="dashboard"><div>${card('库区货位图',map(),'<small>12 个货位</small>')}${card('库存提醒',table(['商品','关注事项'],alerts.map(a=>a.map(esc))))}</div><div>${card('待办作业',`<div class="cardbody">${tasks||empty()}</div>`,btn('全部订单','go-orders',{cls:'quiet'}))}${card('最近入库',table(['商品 / 供应商','数量'],state.receipts.slice(0,3).map(r=>[`${esc(p(lot(r.lot_id).product_id).name)}<small>${esc(r.supplier)}</small>`,'+'+r.qty])))}</div></div>`;
}
function filters(choices,placeholder){return `<div class="filters"><input id="search" type="search" aria-label="搜索" placeholder="${placeholder}" value="${esc(search)}"><select id="filter" aria-label="筛选">${[['','全部'],...choices].map(([v,t])=>`<option value="${v}" ${v===filter?'selected':''}>${t}</option>`).join('')}</select></div>`;}
function inventoryRows(){
  return state.lots.filter(l=>(!filter||l.location_id.startsWith(filter))&&[l.batch,l.location_id,l.product_id,p(l.product_id).name].some(v=>v.toLowerCase().includes(search.toLowerCase())));
}
function inventoryTable(){return table(['商品 / 编号','货位','批次 / 效期','在库','预留','可用','效期',...(admin()?['操作']:[])],inventoryRows().map(l=>[`${esc(p(l.product_id).name)}<small>${l.product_id}</small>`,l.location_id,`${esc(l.batch)}<small>${l.expiry}</small>`,l.on_hand,l.reserved,l.on_hand-l.reserved,days(l.expiry)<=0?badge('DEAD','已到期'):days(l.expiry)<=30?badge('RETRY','临期'):badge('DONE','正常'),...(admin()?[btn('盘点','count',{id:l.id,cls:'quiet'})]:[])]));}
function orderTable(){return table(['订单 / 客户','目的地','件数','优先级','状态','操作'],state.orders.filter(o=>(!filter||filter===o.status)&&[o.customer,o.destination,o.id].join(' ').toLowerCase().includes(search.toLowerCase())).map(o=>[`${short(o.id)}<small>${esc(o.customer)}</small>`,esc(o.destination),state.lines.filter(l=>l.order_id===o.id).reduce((n,l)=>n+l.qty,0),o.priority==='HIGH'?badge('RETRY','加急'):'普通',badge(o.status),btn('查看订单','detail',{id:o.id,cls:'quiet'})]));}
function logistics(){
  const waiting=state.orders.filter(o=>o.status==='SHIPPED'&&!state.shipments.some(s=>s.order_id===o.id));
  return (waiting.length?card('等待物流建单',`<div class="cardbody">${waiting.map(o=>esc(o.customer)+' · '+short(o.id)).join('<br>')}</div>`):'')+
    card('发运清单',table(['运单 / 订单','收货方','状态','操作'],state.shipments.map(s=>[`${short(s.id)}<small>${short(s.order_id)}</small>`,esc(state.orders.find(o=>o.id===s.order_id)?.customer),badge(s.status,s.status==='CREATED'?'待揽收':null),btn('查看轨迹','shipment',{id:s.id,cls:'quiet'})])));
}
function cold(){
  const readings=state.readings.slice(0,16).reverse();
  return `<div class="dashboard"><div>${card('冷藏区采样',`<div class="cardbody"><div class="keyline"><b>COLD-01</b><span>正常范围 2～8℃</span></div><div class="chart">${readings.map(r=>`<span class="${r.temperature<2||r.temperature>8?'hot':''}" title="${r.temperature}℃" style="height:${Math.min(100,Math.max(5,(r.temperature+5)*6))}%"></span>`).join('')}</div></div>`)}${card('采样记录',table(['设备','温度','时间'],state.readings.map(r=>[r.device_id,r.temperature+' ℃',fmt(r.created_at)])))}</div><div>${card('温度告警',table(['内容 / 时间','状态','操作'],state.alerts.map(a=>[`${esc(a.message)}<small>${fmt(a.created_at)}</small>`,badge(a.status),admin()&&a.status==='OPEN'?btn('确认处理','resolve',{id:a.id}):'—'])))}</div></div>`;
}
function audit(){
  const summary=report?`<div class="cardbody"><b>${report.ok?'库存和事件核对通过':'发现差异'}</b><p>${report.lots} 个批次 · ${report.events} 条事件 · ${report.differences.length} 项库存差异 · ${report.broken.length} 条异常事件</p>${report.ok?'':`<pre>${esc(JSON.stringify(report,null,2))}</pre>`}</div>`:'<p class="cardbody muted">运行核对后可查看库存流水、有效预留与事件摘要是否一致。</p>';
  return card('一致性结果',summary)+card('库存流水',table(['业务 / 时间','商品 / 批次','在库变动','预留变动','操作人','原因'],state.moves.map(m=>[`${esc(labels[m.kind]||m.kind)}<small>${fmt(m.created_at)}</small>`,`${esc(p(lot(m.lot_id).product_id).name)}<small>${esc(lot(m.lot_id).batch)}</small>`,m.delta_hand,m.delta_reserved,esc(m.operator),esc(m.reason)])));
}
function events(){return card('事件队列',table(['序号','事件 / 对象','状态','尝试','时间','操作'],state.events.map(e=>[e.seq,`${esc(e.type)}<small>${short(e.aggregate_id)}</small>`,badge(e.status),e.attempts,fmt(e.created_at),btn('详情','event',{id:e.id,cls:'quiet'})+(admin()&&e.status==='DEAD'?btn('重放','replay',{id:e.id}):'')])),admin()?`<div class="actions">${btn(state.paused?'继续消费':'暂停消费','worker')}${btn('消费一批','dispatch')}${btn('模拟故障','fault',{cls:'danger'})}</div>`:`<small>${state.paused?'已暂停':'自动消费中'}</small>`);}
function view(){
  if(page==='inventory')return card('批次库存',filters(['A','B','C'].map(s=>[s,s+' 区']),'商品、批次或货位')+`<div id="results">${inventoryTable()}</div>`);
  if(page==='orders')return card('订单清单',filters(['CREATED','RESERVED','PICKED','SHIPPED','DELIVERED','CANCELLED'].map(s=>[s,labels[s]]),'订单、客户或目的地')+`<div id="results">${orderTable()}</div>`);
  return ({overview,logistics,cold,audit,events})[page]();
}
function modal(title,html){
  dialog.innerHTML=`<header class="card-head"><h2 id="dialog-title">${esc(title)}</h2>${btn('','close',{icon:'x',cls:'quiet',extra:'aria-label="关闭"'})}</header><div class="dialog-body">${html}</div>`;
  if(!dialog.open)dialog.showModal();
}
const options=rows=>rows.map(([v,t])=>`<option value="${esc(v)}">${esc(t)}</option>`).join('');
const field=(label,name,type='text',extra='')=>`<label class="field"><span>${label}</span><input name="${name}" type="${type}" required ${extra}></label>`;
const select=(label,name,list)=>`<label class="field"><span>${label}</span><select name="${name}" required>${options(list)}</select></label>`;
const form=(kind,fields,submit,id='')=>`<form data-kind="${kind}" data-id="${esc(id)}">${fields}<p role="alert" class="error"></p><div class="form-foot">${btn('返回','close')}<button class="btn primary" type="submit">${submit}</button></div></form>`;
const products=()=>state.products.map(x=>[x.id,x.name+' · '+x.id]);
function line(){return `<div class="line"><select name="product_id" aria-label="订单商品">${options(products())}</select><input name="qty" aria-label="订购数量" type="number" step="1" min="1" max="100000" value="1" required>${btn('移除','remove',{cls:'quiet'})}</div>`;}
function orderDetail(id){
  const o=state.orders.find(x=>x.id===id);
  const next={CREATED:['reserve','分配库存'],RESERVED:['pick','确认拣货'],PICKED:['ship','复核出库']}[o.status];
  const lines=state.lines.filter(l=>l.order_id===id).map(l=>[esc(p(l.product_id).name),l.qty,state.allocations.filter(a=>a.order_id===id && lot(a.lot_id).product_id===l.product_id).map(a=>`${esc(lot(a.lot_id).batch)} / ${lot(a.lot_id).location_id} × ${a.qty}`).join('<br>')||'待分配']);
  modal('订单详情',`<div class="keyline"><b>${short(id)} · ${esc(o.customer)}</b>${badge(o.status)}</div><p class="muted">${esc(o.destination)}</p>${table(['商品','需求','分配批次'],lines)}<div class="actions row-gap">${staff()&&next?btn(next[1],next[0],{id,cls:'primary'}):''}${['RESERVED','PICKED'].includes(o.status)?btn('拣货路线','route',{id}):''}${staff()&&next?btn('取消订单','cancel',{id,cls:'danger'}):''}</div>`);
}
function shipmentDetail(id){
  const s=state.shipments.find(x=>x.id===id), next=s.status==='CREATED'?'IN_TRANSIT':'DELIVERED';
  modal('物流轨迹',`<b>${short(id)}</b> · ${esc(s.carrier)}${state.tracking.filter(t=>t.shipment_id===id).map(t=>`<div class="history"><span class="token">${icon('map-pin')}</span><div class="text"><b>${esc(t.message)}</b><small>${fmt(t.created_at)}</small></div></div>`).join('')}${staff()&&s.status!=='DELIVERED'?form('tracking',`<input type="hidden" name="status" value="${next}">${field('回传说明','message','text',`maxlength="256" value="${next==='IN_TRANSIT'?'承运商已揽收':'收件人已签收'}"`)}`,next==='IN_TRANSIT'?'模拟揽收':'确认签收',id):''}`);
}
function exportCsv(){
  const rows=[['商品编号','商品','货位','批次','效期','在库','预留','可用'],...inventoryRows().map(l=>[l.product_id,p(l.product_id).name,l.location_id,l.batch,l.expiry,l.on_hand,l.reserved,l.on_hand-l.reserved])];
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/^[\s]*[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='北辰仓-批次库存.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),200);
}
async function action(el){
  const {act,id}=el.dataset;
  if(act==='close')return dialog.close();
  if(act==='logout'){await api('logout',{});generation++;user=null;state=null;report=null;login();return;}
  if(act==='refresh')return load();
  if(act==='go-orders')return go('orders');
  if(act==='export')return exportCsv();
  if(act==='bin'){
    const loc=state.locations.find(l=>l.id===id);
    return modal(id+' 货位',`<p>${loc.cold?'冷藏区':'常温区'} · 容量 ${loc.capacity} 件</p>`+table(['商品','批次','在库','可用'],state.lots.filter(l=>l.location_id===id).map(l=>[esc(p(l.product_id).name),esc(l.batch),l.on_hand,l.on_hand-l.reserved])));
  }
  if(act==='receive')return modal('登记入库',form('receive',`<div class="fields">${select('商品','product_id',products())}${select('货位','location_id',state.locations.map(x=>[x.id,x.id+(x.cold?' · 冷藏':' · 常温')]))}${field('到货批号','batch','text','maxlength="64"')}${field('有效期','expiry','date')}${field('到货数量','quantity','number','min="1" max="100000" step="1"')}${field('供应商','supplier','text','maxlength="128"')}</div>`,'确认入库'));
  if(act==='count'){const l=lot(id);return modal('库存盘点',form('count',`<p class="info">${esc(p(l.product_id).name)} · ${esc(l.batch)} · ${l.location_id}<br>账面 ${l.on_hand}，已预留 ${l.reserved}，版本 ${l.version}</p><input name="version" type="hidden" value="${l.version}">${field('实盘数量','counted','number',`min="0" max="100000" value="${l.on_hand}"`)}${field('调整原因','reason','text','maxlength="256"')}`,'提交盘点',id));}
  if(act==='new-order')return modal('创建出库订单',form('order',field('客户','customer')+field('目的地','destination')+select('优先级','priority',[['NORMAL','普通'],['HIGH','加急']])+`<div><b>商品明细</b><div id="lines">${line()}</div>${btn('添加商品','add',{icon:'plus'})}</div>`,'创建订单'));
  if(act==='add'){const list=dialog.querySelector('#lines');if(list.children.length<20)list.insertAdjacentHTML('beforeend',line());return;}
  if(act==='remove'){if(el.parentElement.parentElement.children.length>1)el.parentElement.remove();return;}
  if(act==='detail')return orderDetail(id);
  if(act==='shipment')return shipmentDetail(id);
  if(act==='route'){const r=await api('orders/'+id+'/route');return modal('拣货路线',`<p>${r.points.map(x=>`<span class="route-stop">${esc(x.id)}</span>`).join(' → ')}</p><p class="row-gap">建议 ${r.distance} 步 · 货位编号顺序 ${r.baseline} 步</p><p class="muted">按货位网格计算往返距离。</p>`);}
  if(['reserve','pick','ship','cancel'].includes(act)){
    const o=state.orders.find(x=>x.id===id),title={reserve:'确认分配库存',pick:'确认已拣货',ship:'确认复核出库',cancel:'确认取消订单'}[act];
    const prompt={reserve:'按效期从近到远分配，缺货时整单退回。',pick:'请核对实际拣取的货位与数量。',ship:'本次出库将扣减库存，提交后不能取消。',cancel:o.status==='PICKED'?'请先将已拣货物放回原货位，确认后释放预留。':'取消后释放这张订单占用的库存。'}[act];
    return modal(title,form('transition',`<p>${esc(o.customer)} · ${short(id)}</p><p class="info">${prompt}</p><input type="hidden" name="action" value="${act}">`,'确认',id));
  }
  if(act==='temperature')return modal('上报温度',form('temperature',field('COLD-01 采样值（℃）','temperature','number','min="-50" max="80" step="0.01"'),'提交采样'));
  if(act==='verify'){report=await api('reconcile');render();return;}
  if(act==='event'){
    const e=state.events.find(x=>x.id===id);
    return modal('事件详情',`<b>${esc(e.type)} · #${e.seq}</b><p class="muted">${fmt(e.created_at)} · 尝试 ${e.attempts} 次</p><pre>${esc(JSON.stringify(JSON.parse(e.payload),null,2))}</pre><p class="wrap">前序摘要 ${esc(e.previous_hash)}<br>当前摘要 ${esc(e.hash)}</p>${e.error?`<p class="error">${esc(e.error)}</p>`:''}`);
  }
  if(act==='resolve')await api('alerts/'+id+'/resolve',{});
  if(act==='replay')await api('events/'+id+'/retry',{});
  if(act==='worker')await api('events/worker',{paused:!state.paused});
  if(act==='dispatch'||act==='fault')await api('events/dispatch',{fail:act==='fault'});
  await load();toast('操作已保存');
}
document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-act],[data-page]');if(!button)return;
  if(button.dataset.page){go(button.dataset.page);return;}
  button.disabled=true;try{await action(button);}catch(error){toast(error.message);}finally{button.disabled=false;}
});
document.addEventListener('submit',async e=>{
  e.preventDefault();const el=e.target,button=e.submitter, fields=new FormData(el), values=Object.fromEntries(fields);
  const errorBox=el.querySelector('.error');errorBox.textContent='';if(button)button.disabled=true;
  try{
    if(el.id==='login'){user=await api('login',values);await load();return;}
    const k=el.dataset.kind,id=el.dataset.id;let endpoint,body=values;
    if(k==='receive'){endpoint='receipts';body.quantity=Number(body.quantity);}
    if(k==='count'){endpoint='counts';body={lot_id:id,version:Number(values.version),counted:Number(values.counted),reason:values.reason};}
    if(k==='order'){endpoint='orders';body={customer:values.customer,destination:values.destination,priority:values.priority,lines:fields.getAll('product_id').map((product_id,i)=>({product_id,qty:Number(fields.getAll('qty')[i])}))};}
    if(k==='transition'){endpoint='orders/'+id+'/'+values.action;body={};}
    if(k==='temperature'){endpoint='readings';body.temperature=Number(body.temperature);}
    if(k==='tracking')endpoint='shipments/'+id+'/tracking';
    const signature=JSON.stringify([endpoint,body]);
    if(el.dataset.signature!==signature){el.dataset.signature=signature;el.dataset.key=crypto.randomUUID();}
    await api(endpoint,body,el.dataset.key);dialog.close();await load();toast('已保存');
  }catch(error){errorBox.textContent=error.message;}finally{if(button)button.disabled=false;}
});
function updateFilter(){document.querySelector('#results').innerHTML=page==='inventory'?inventoryTable():orderTable();}
document.addEventListener('input',e=>{if(e.target.id==='search'){search=e.target.value;updateFilter();}});
document.addEventListener('change',e=>{if(e.target.id==='filter'){filter=e.target.value;updateFilter();}});
function syncPage(){page=Object.hasOwn(pages,location.hash.slice(1))?location.hash.slice(1):'overview';search='';filter='';if(dialog.open)dialog.close();if(state&&user)render();}
window.addEventListener('hashchange',syncPage);
syncPage();
try{user=await api('me');await load();}catch{login();}
setInterval(async()=>{if(page!=='logistics'||!user||dialog.open||document.hidden||refreshing)return;refreshing=true;try{await load();}catch{}finally{refreshing=false;}},1800);
