import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {openDB} from '../src/db.js';
import {seed} from '../src/seed.js';
import {verify} from '../src/coordination.js';
test('R01 停止写入后的 SQLite 备份可恢复账目、运单与事件',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'warehouse-restore-'));
  const source=join(folder,'original.db'), backup=join(folder,'restore.db');
  try{
    let db=await openDB({SQLITE_PATH:source});let original;
    try{await seed(db,'restore-test');original=await db.tx(verify);}finally{await db.close();}
    await copyFile(source,backup);db=await openDB({SQLITE_PATH:backup});
    try{const restored=await db.tx(verify);assert.equal(restored.ok,true);assert.equal(restored.events,original.events);assert.equal(restored.lots,original.lots);
      assert.equal(Number((await db.tx(tx=>tx.one('SELECT COUNT(*) n FROM shipments'))).n),1);
    }finally{await db.close();}
  }finally{await rm(folder,{recursive:true,force:true});}
});
