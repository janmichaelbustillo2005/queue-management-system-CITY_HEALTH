const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
function load(file, imports, context = {}) {
 const module={exports:{}};
 vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(path.resolve(__dirname, '..', file),'utf8')}\n})`, context)((name)=>{if (!(name in imports)) throw Error(name); return imports[name];},module,module.exports);
 return module.exports;
}
const secret='phase-b-isolated-tests';
const okResult={data:{rows:[],total:0,page:1,limit:20,observed_at:'2026-10-23T00:00:00Z'}};
function harness(rpc=async()=>okResult, doctorDispatchMode) {
 const auth=load('src/middleware/auth.js',{jsonwebtoken:jwt,'../config/env':{jwtSecret:secret},'../services/presenceService':{validateAuthSession:async claims=>{if(claims.jti==='revoked') throw Object.assign(Error('Revoked'),{statusCode:401});return {};}}});
 let chain, calls=[], logs=[];
 const router={use:(...handlers)=>chain=handlers,get:(_path,handler)=>chain.push(handler)};
 const console={warn:(...args)=>logs.push(['warn',...args]),error:(...args)=>logs.push(['error',...args])};
 load('src/routes/records.js',{express:{Router:()=>router},'../middleware/auth':auth,'../config/env':{doctorDispatchMode},'../lib/supabase':{rpc:async(name,args)=>{calls.push({name,args});return rpc(name,args);}}},{console});
 return {calls,logs,async request(role,query={},category='patients',session='valid') {
 const token=role?jwt.sign({role,id_num:'safe-test',jti:session},secret):null;
 const req={headers:token?{authorization:`Bearer ${token}`}:{},params:{category},query};
 const res={code:200,headers:{},status(code){this.code=code;return this;},json(body){this.body=body;return this;},setHeader(key,value){this.headers[key]=value;}};
 async function run(i){if(chain[i]) await chain[i](req,res,()=>run(i+1));}
 await run(0);return res;
 }};
}
test('all records categories reject unauthenticated and non-superadmin identities before storage',async()=>{
 for(const category of ['patients','staff','accounts','activity']) {
  const h=harness();
  assert.equal((await h.request(null,{},category)).code,401);
  assert.equal((await h.request('admin',{},category)).code,403);
  assert.equal(h.calls.length,0);
 }
});
test('revoked sessions cannot read records',async()=>{const h=harness();assert.equal((await h.request('superadmin',{},'accounts','revoked')).code,401);assert.equal(h.calls.length,0);});
test('validated superadmin forwards bounded filters and pagination',async()=>{
 const h=harness();assert.equal((await h.request('superadmin',{page:'2',limit:'10',search:' Ana ',doctor:'Doctor 1',date:'2026-10-14'})).code,200);
 assert.equal(h.calls[0].args.p_filters.search,'Ana');assert.equal(h.calls[0].args.p_page,2);
 for(const query of [{page:'-1'},{limit:'101'},{search:['bad']},{date:'invalid'}]) assert.equal((await h.request('superadmin',query)).code,400);
 assert.equal(h.calls.length,1);
});

// Phase B.2 compatibility.
test('impossible calendar dates and unknown filter values are rejected with 400 before storage',async()=>{
 const h=harness();
 for(const query of [{date:'2026-02-31'},{date:'2026-13-01'},{date:'2026-1-01'},{date:'0099-01-01'},{status:'bogus'},{status:'No-show'},
  {position:'Admin'},{position:'frontdesk'},{presence:'maybe'},{role:'root'},{visit:'abc'},{visit:'1'.repeat(19)},{page:'1.5'},{search:'x'.repeat(101)}]) {
  const res=await h.request('superadmin',query);
  assert.equal(res.code,400,JSON.stringify(query));
  assert.match(res.body.message,/^Invalid/);
 }
 assert.equal(h.calls.length,0);
});
test('every value the Records toolbar sends is accepted, including no-show before its enum exists',async()=>{
 const h=harness();
 const accepted=[{status:'no-show'},{status:'cancelled'},{position:'Frontdesk'},{position:'Super Admin'},{position:'Doctor'},{presence:'online'},
  {role:'admin'},{date:'2024-02-29'},{visit:'42'},{doctor:'doctor 01'},{service:'family_planning'},{account:'admin1'}];
 for(const query of accepted) assert.equal((await h.request('superadmin',query)).code,200,JSON.stringify(query));
 assert.equal(h.calls.length,accepted.length);
 assert.deepEqual(Object.keys(h.calls[0].args.p_filters).sort(),['account','date','doctor','position','presence','role','search','service','status','visit']);
});
test('the response contract passes through unchanged with no-store caching',async()=>{
 const data={rows:[{id:1,patient_name:'Juan Dela Cruz',doctor:'Doctor 1',doctor_source:'service'}],total:1,page:1,limit:20,observed_at:'2026-10-23T00:00:00Z'};
 const h=harness(async()=>({data}));
 const res=await h.request('superadmin',{});
 assert.equal(res.code,200);assert.deepEqual(res.body,data);assert.equal(res.headers['Cache-Control'],'no-store');
});
test('database errors map to defined status codes without leaking database text',async()=>{
 const secretText='patients.first_name SELECT * FROM secret Juan Dela Cruz';
 const cases=[
  ['22023',400,/^Invalid records filter$/],['22007',400,/^Invalid records filter$/],['22008',400,/^Invalid records filter$/],
  ['PGRST202',503,/missing or incompatible; install Phase B\.2/],['PGRST205',503,/missing or incompatible/],
  ['42883',503,/missing or incompatible/],['42P01',503,/missing or incompatible/],['42703',503,/missing or incompatible/],
  ['XX000',503,/^Records storage unavailable\. Please retry\.$/],['42501',503,/^Records storage unavailable\. Please retry\.$/]
 ];
 for(const [code,status,message] of cases) {
  const h=harness(async()=>({data:null,error:{code,message:secretText,details:secretText,hint:secretText}}));
  const res=await h.request('superadmin',{doctor:'Doctor 9'},'staff');
  assert.equal(res.code,status,code);assert.match(res.body.message,message,code);
  assert.doesNotMatch(JSON.stringify(res.body),/secret|first_name|Juan/);
  assert.equal(h.logs.length,1,code);
  assert.deepEqual(h.logs[0],[status===400?'warn':'error',`[records] GET /api/records/staff failed: ${code}`]);
 }
});
test('transport failures, malformed codes and unexpected results are 503 and logged by code only',async()=>{
 let h=harness(async()=>{throw new Error('fetch failed for https://project.supabase.co?apikey=secret');});
 let res=await h.request('superadmin',{},'activity');
 assert.equal(res.code,503);assert.deepEqual(h.logs,[['error','[records] GET /api/records/activity failed: transport']]);
 h=harness(async()=>({error:{code:'bad code; DROP TABLE',message:'x'}}));
 res=await h.request('superadmin');
 assert.equal(res.code,503);assert.deepEqual(h.logs,[['error','[records] GET /api/records/patients failed: unknown']]);
 for(const data of [null,{rows:'x',total:1},{rows:[],total:null},{rows:[]}]) {
  h=harness(async()=>({data}));
  res=await h.request('superadmin');
  assert.equal(res.code,503,JSON.stringify(data));assert.match(res.body.message,/unexpected result/);
  assert.deepEqual(h.logs,[['error','[records] GET /api/records/patients failed: invalid-result']]);
 }
});
test('D1 shared dispatch reports a never-called visit as unassigned; stored doctors are unchanged',async()=>{
 const rows=[{id:1,service_type:'prenatal',doctor:'Doctor 2',doctor_source:'service'},{id:2,service_type:'prenatal',doctor:'Doctor 3',doctor_source:'assigned'},{id:3,service_type:'consultation',doctor:'Doctor 9',doctor_source:'unresolved'}];
 const result=()=>({data:{rows:rows.map((row)=>({...row})),total:3,page:1,limit:20}});
 const shared=await harness(async()=>result(),'shared').request('superadmin');
 assert.equal(shared.code,200);
 assert.deepEqual(shared.body.rows.map(({doctor,doctor_source})=>[doctor,doctor_source]),[[null,'unassigned'],['Doctor 3','assigned'],['Doctor 9','unresolved']]);
 const service=await harness(async()=>result()).request('superadmin');
 assert.deepEqual(service.body.rows,rows,'service mode keeps the Phase B.2 routing label');
 const staff=await harness(async()=>({data:{rows:[{id_num:'admin2',doctor:'Doctor 2',doctor_source:'service'}],total:1}}),'shared').request('superadmin',{},'staff');
 assert.equal(staff.body.rows[0].doctor_source,'service','only patient visits are relabelled');
});
