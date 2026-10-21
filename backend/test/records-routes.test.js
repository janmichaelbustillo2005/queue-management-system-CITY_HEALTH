const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
function load(file, imports) {
 const module={exports:{}};
 vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(path.resolve(__dirname, '..', file),'utf8')}\n})`)((name)=>{if (!(name in imports)) throw Error(name); return imports[name];},module,module.exports);
 return module.exports;
}
const secret='phase-b-isolated-tests';
function harness() {
 const auth=load('src/middleware/auth.js',{jsonwebtoken:jwt,'../config/env':{jwtSecret:secret},'../services/presenceService':{validateAuthSession:async claims=>{if(claims.jti==='revoked') throw Object.assign(Error('Revoked'),{statusCode:401});return {};}}});
 let chain, calls=[];
 const router={use:(...handlers)=>chain=handlers,get:(_path,handler)=>chain.push(handler)};
 load('src/routes/records.js',{express:{Router:()=>router},'../middleware/auth':auth,'../lib/supabase':{rpc:async(name,args)=>{calls.push({name,args});return {data:{rows:[],total:0}};}}});
 return {calls,async request(role,query={},category='patients',session='valid') {
 const token=role?jwt.sign({role,id_num:'safe-test',jti:session},secret):null;
 const req={headers:token?{authorization:`Bearer ${token}`}:{},params:{category},query};
 const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;},setHeader(){}};
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
