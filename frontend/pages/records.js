import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../context/AuthContext';
import SiteFrame from '../components/SiteFrame';
import { request } from '../lib/api';

const stamp = value => value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'Unavailable';
const patientColumns = [['patient_name','Patient'],['queue_number','Ticket'],['service_type','Service'],['doctor','Assigned doctor'],['priority_score','Priority score'],['status','Status'],['created_at','Registered'],['called_at','Called'],['consultation_started_at','Consultation started'],['completed_at','Completed / cancelled']];
const identityColumns = [['id','Account / staff ID'],['display_name','Display name'],['role','Stored role'],['position','Position'],['doctor','Assigned doctor / counter'],['account_status','Account status'],['online','Presence'],['authenticated','Authentication'],['last_login','Last login'],['last_seen','Last seen'],['created_at','Account created']];
const activityColumns = [['account','Account'],['event','Activity'],['occurred_at','Time']];
function cell(row,key) {
  if (['created_at','called_at','consultation_started_at','completed_at','last_login','last_seen','occurred_at'].includes(key)) return stamp(row[key]);
  if (key==='online') return row.online ? 'Online' : 'Offline';
  if (key==='authenticated') return row.authenticated ? 'Active session' : 'No active session';
  return row[key] ?? 'Unavailable';
}
export default function RecordsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const category = ['patients','staff','accounts'].includes(router.query.category) ? router.query.category : 'patients';
  const [filters,setFilters] = useState({});
  const [applied,setApplied] = useState({});
  const [page,setPage] = useState(1);
  const [data,setData] = useState({ rows:[],total:0 });
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState('');
  const [detail,setDetail] = useState(null);
  const [refresh,setRefresh] = useState(0);
  useEffect(() => { if (!loading && user?.role!=='superadmin') router.replace('/login'); },[loading,user,router]);
  useEffect(() => { setFilters({});setApplied({});setPage(1);setDetail(null); },[category]);
  useEffect(() => {
    if (user?.role!=='superadmin') return;
    let stale=false;
    setBusy(true);setError('');setData({rows:[],total:0});
    const params=new URLSearchParams({...applied,page:String(page),limit:'20'});
    request(`/records/${category}?${params}`).then(result => { if (result?.error) throw new Error(result.error); if (!stale) setData(result); }).catch(err => { if (!stale) setError(err.message); }).finally(() => { if (!stale) setBusy(false); });
    return () => { stale=true; };
  },[user,category,applied,page,refresh]);
  useEffect(() => {
    if (user?.role!=='superadmin') return;
    const timer=setInterval(() => setRefresh(value=>value+1),30000);
    return () => clearInterval(timer);
  },[user]);
  async function inspect(row, detailPage=1) {
    setDetail({title:category==='patients' ? 'Stored ticket' : 'Login / logout activity',busy:true});
    try {
      const path=category==='patients' ? `/records/patients?visit=${encodeURIComponent(row.id)}` : `/records/activity?account=${encodeURIComponent(row.id)}&limit=20&page=${detailPage}`;
      const result=await request(path);
      if (result?.error) throw new Error(result.error);
      setDetail({title:category==='patients' ? 'Stored ticket' : 'Login / logout activity',rows:result.rows,total:result.total,patient:category==='patients',account:row.id,page:detailPage});
    } catch(err) { setDetail({title:'Details',error:err.message}); }
  }
  const field = (key,label,type='text') => <label className="text-sm" key={key}>{label}<input className="block border brand-input rounded p-2 w-full" type={type} value={filters[key]||''} onChange={event=>setFilters({...filters,[key]:event.target.value})}/></label>;
  const select = (key,label,options) => <label className="text-sm" key={key}>{label}<select className="block border brand-input rounded p-2 w-full" value={filters[key]||''} onChange={event=>setFilters({...filters,[key]:event.target.value})}><option value="">All</option>{options.map(value=><option key={value} value={value}>{value}</option>)}</select></label>;
  const columns=category==='patients' ? patientColumns : identityColumns;
  function table(rows,cols,actions=false) {
    return <div className="overflow-x-auto border brand-border rounded"><table className="w-full text-sm text-left"><thead className="brand-bg-subtle"><tr>{cols.map(([key,label])=><th className="p-3 whitespace-nowrap" key={key}>{label}</th>)}{actions&&<th className="p-3">Details</th>}</tr></thead><tbody>{rows.map(row=><tr key={row.id} className="border-t brand-border">{cols.map(([key])=><td className="p-3 whitespace-nowrap" key={key}>{cell(row,key)}</td>)}{actions&&<td className="p-3"><button className="brand-button rounded px-3 py-1" onClick={()=>inspect(row)}>{category==='patients' ? 'Retrieve ticket' : 'Activity'}</button></td>}</tr>)}{!rows.length&&<tr><td className="p-6 text-center" colSpan={cols.length+1}>No records found.</td></tr>}</tbody></table></div>;
  }
  if (loading || user?.role!=='superadmin') return <div role="status">Loading authorized records…</div>;
  return <SiteFrame title="Records Management" icon="fas fa-folder" showSidebar sidebarLinks={[]}>
    <div className="max-w-7xl mx-auto px-3 space-y-4">
      <nav aria-label="Records categories" className="flex flex-wrap gap-2">{[['patients','Patient Records'],['staff','Staff Records'],['accounts','User Accounts']].map(([key,label])=><button key={key} aria-current={category===key?'page':undefined} className={`px-4 py-2 rounded ${category===key?'brand-button':'bg-white border brand-border'}`} onClick={()=>router.push(`/records?category=${key}`)}>{label}</button>)}</nav>
      <p className="text-sm brand-text-muted">{category==='patients' ? 'Each row is a stored visit and its ticket history. The current schema has no separate patient profile; this read-only view creates no duplicate identities or visits.' : 'Staff and user accounts share the existing account identity. Presence expires after 75 seconds; account status, authentication and counter availability are separate. Account disabling and account creation dates are not stored in the current schema.'}</p>
      <form className="bg-white rounded shadow p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" onSubmit={event=>{event.preventDefault();setPage(1);setApplied({...filters});}}>
        {field('search',category==='patients'?'Patient name or ticket':'Name or account ID')}
        {category==='patients' ? <>{field('date','Registration date (Manila)','date')}{field('service','Service type')}{field('doctor','Assigned doctor (exact)')}{select('status','Queue status',['waiting','serving','completed','cancelled','no-show'])}</> : <>{select('role','Stored role',['superadmin','admin'])}{select('position','Position',['Super Admin','Admin','Doctor'])}{field('doctor','Doctor assignment (exact)')}{select('presence','Presence',['online','offline'])}</>}
        <div className="flex gap-2 items-end"><button className="brand-button px-4 py-2 rounded">Search</button><button type="button" className="border px-4 py-2 rounded" onClick={()=>{setFilters({});setApplied({});setPage(1);}}>Reset</button></div>
      </form>
      {error&&<p role="alert" className="bg-red-50 text-red-700 p-3">{error}</p>}
      <div className="bg-white rounded shadow p-3" aria-busy={busy}>
        {busy?<p role="status" className="p-6">Loading records…</p>:table(data.rows||[],columns,true)}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-3"><span>{data.total||0} records · Page {page} · Times shown in Manila</span><div className="flex gap-3"><button disabled={busy||page===1} onClick={()=>setPage(page-1)}>Previous</button><button disabled={busy||page*20>=(data.total||0)} onClick={()=>setPage(page+1)}>Next</button><button onClick={()=>setRefresh(refresh+1)}>Refresh</button></div></div>
      </div>
      {detail&&<section aria-label={detail.title} className="bg-white shadow rounded p-4"><div className="flex justify-between"><h2 className="font-bold">{detail.title}</h2><button onClick={()=>setDetail(null)}>Close</button></div>{detail.busy?<p role="status">Loading…</p>:detail.error?<p role="alert">{detail.error}</p>:<>{table(detail.rows||[],detail.patient?patientColumns:activityColumns)}{!detail.patient&&<p className="text-sm mt-2">Page {detail.page} ? {detail.total} events. Activity recording begins with Phase B; expiry and administrative revocation are not explicit logouts.</p>}{!detail.patient&&<div className="flex gap-4 mt-2"><button disabled={detail.page===1} onClick={()=>inspect({id:detail.account},detail.page-1)}>Previous activity</button><button disabled={detail.page*20>=detail.total} onClick={()=>inspect({id:detail.account},detail.page+1)}>Next activity</button></div>}</>}</section>}
    </div>
  </SiteFrame>;
}
