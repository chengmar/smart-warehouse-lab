import { createHash, randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
export const id = (prefix='') => prefix + randomUUID().replaceAll('-','');
export const stamp = () => new Date().toISOString();
const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export const day = (offset=0) => calendar.format(new Date(Date.now()+offset*86400000));
export const digest = value => createHash('sha256').update(value).digest('hex');
export class Failure extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
export function requireThat(condition,message,status=400){if(!condition)throw new Failure(message,status);}
export function string(value,limit=128){
  requireThat(typeof value==='string' && value.trim() && value.trim().length<=limit,'文本为空或过长');
  return value.trim();
}
export function units(value,min=1){
  requireThat(Number.isSafeInteger(value) && value>=min && value<=100000,'数量必须是 '+min+'～100000 的整数');
  return value;
}
export function encodePassword(password){
  const salt=randomBytes(16).toString('hex');
  return salt+':'+scryptSync(password,salt,32).toString('hex');
}
export function passwordMatches(password,hash){
  const [salt,hex]=hash.split(':');
  return Boolean(hex && timingSafeEqual(Buffer.from(hex,'hex'),scryptSync(password,salt,32)));
}
export function sortedJSON(value){
  if(Array.isArray(value))return value.map(sortedJSON);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortedJSON(value[k])]));
  return value;
}
