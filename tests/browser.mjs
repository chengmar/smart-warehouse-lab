import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {openDB} from '../src/db.js';
import {day} from '../src/common.js';
import {createApp} from '../src/server.js';

const artifacts='artifacts';
await mkdir(artifacts,{recursive:true});
const db=await openDB({SQLITE_PATH:':memory:'}), runtime=await createApp(db,{password:'Browser-lab!'});
const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||(existsSync(chrome)?chrome:undefined)});
  const page=await browser.newPage({viewport:{width:1440,height:960},locale:'zh-CN'});
  page.setDefaultTimeout(9000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/api/me'))errors.push(r.status()+' '+r.url());});
  const button=(name,scope=page)=>scope.getByRole('button',{name,exact:true});
  const click=(name,scope)=>button(name,scope).click();
  const drawer=page.locator('dialog'), closed=()=>drawer.waitFor({state:'hidden'});
  async function capture(name){await page.screenshot({path:artifacts+'/'+name+'.png'});}
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByLabel('密码',{exact:true}).fill('Browser-lab!');await click('进入工作台');await page.getByRole('heading',{name:'调度总览'}).waitFor();
  await capture('01-dashboard');
  await click('登记入库');await drawer.getByLabel('商品',{exact:true}).selectOption('P01');await drawer.getByLabel('货位').selectOption('A-04');
  await drawer.getByLabel('到货批号').fill('E2E-COFFEE');await drawer.getByLabel('有效期').fill(day(1));await drawer.getByLabel('到货数量').fill('11');await drawer.getByLabel('供应商').fill('北辰验收供应商');await click('确认入库',drawer);await closed();
  await click('库存货位');await page.getByRole('searchbox').fill('E2E-COFFEE');await page.getByRole('row').filter({hasText:'E2E-COFFEE'}).waitFor();await capture('02-inventory');
  await click('出库订单');await click('创建订单');await drawer.getByLabel('客户',{exact:true}).fill('端到端验收门店');await drawer.getByLabel('目的地').fill('天津北辰收货台');await drawer.getByLabel('订购数量').fill('4');await click('创建订单',drawer);await closed();
  const row=page.getByRole('row').filter({hasText:'端到端验收门店'});
  for(const [i,label] of ['分配库存','确认拣货','复核出库'].entries()){
    await click('查看订单',row);
    if(i===1){await drawer.getByText(/E2E-COFFEE/).waitFor();await capture('03-allocation');}
    await click(label,drawer);await click('确认',drawer);await closed();
  }
  const shippedAt=Date.now();
  await click('物流跟踪');const shipment=page.getByRole('row').filter({hasText:'端到端验收门店'});
  await click('查看轨迹',shipment);const visibleMs=Date.now()-shippedAt;await click('模拟揽收',drawer);await closed();
  await click('查看轨迹',shipment);await click('确认签收',drawer);await closed();
  await click('查看轨迹',shipment);await drawer.getByText('收件人已签收').waitFor();await capture('04-tracking');await click('关闭',drawer);
  await click('流水与核对');await click('运行核对');await page.getByText('库存和事件核对通过').waitFor();await capture('05-audit');
  await click('冷链监测');await click('上报温度');await drawer.getByLabel('COLD-01 采样值（℃）').fill('9.1');
  await click('提交采样',drawer);await closed();await page.getByText('冷藏区温度异常 9.1℃').waitFor();await capture('07-cold');
  await click('确认处理');await page.getByText('已处理',{exact:true}).waitFor();
  await click('事件中心');await page.getByRole('heading',{name:'事件队列'}).waitFor();await capture('08-events');
  const lot=await db.tx(tx=>tx.one("SELECT on_hand,reserved FROM lots WHERE batch='E2E-COFFEE'"));assert.equal(lot.on_hand,7);assert.equal(lot.reserved,0);
  const final=await db.tx(tx=>tx.one("SELECT status FROM orders WHERE customer='端到端验收门店'"));assert.equal(final.status,'DELIVERED');
  await page.setViewportSize({width:390,height:844});await click('调度总览');await page.getByRole('heading',{name:'调度总览'}).waitFor();await capture('06-mobile');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await click('退出登录',page.locator('.mobile-brand'));await page.getByLabel('账号',{exact:true}).fill('viewer');await page.getByLabel('密码',{exact:true}).fill('Browser-lab!');
  await click('进入工作台');await page.getByRole('heading',{name:'调度总览'}).waitFor();assert.equal(await button('登记入库').count(),0);
  assert.deepEqual(errors,[]);assert.ok(visibleMs<5000,'正常建单超过 5 秒');
  const result={tested_at:new Date().toISOString(),browser:browser.version(),driver:db.driver,receipt:11,shipped:4,stock:7,reserved:0,order:final.status,shipment_visible_ms:visibleMs,mobile:'390×844',errors};
  console.log(JSON.stringify(result));await writeFile(artifacts+'/browser.json',JSON.stringify(result,null,2));
}finally{await browser?.close();runtime.stop();await new Promise(r=>server.close(r));await db.close();}
