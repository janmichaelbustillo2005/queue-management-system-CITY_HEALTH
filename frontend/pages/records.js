import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../context/AuthContext';
import SiteFrame from '../components/SiteFrame';
import RecordsFilters from '../components/RecordsFilters';
import { request } from '../lib/api';
import { cleanRecordFilters, recordsQuery } from '../lib/recordsFilters';

const PAGE_SIZE = 20;
const EMPTY_RESULT = { rows: [], total: 0 };
// A failed request is never shown as an empty result; this names what failed.
function describeRecordsError(message) {
  if (/failed to fetch|networkerror|load failed|cannot reach the api/i.test(message)) return { title: 'Records API unreachable', advice: 'The browser could not connect to the backend server. Check that it is running, then retry.' };
  if (/records storage unavailable/i.test(message)) return { title: 'Records storage unavailable', advice: 'The backend answered, but its Records database function is not available.' };
  return { title: 'Records could not be loaded', advice: 'No results are shown because the request failed.' };
}

const stamp = value => value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'Unavailable';
const patientColumns = [['patient_name','Patient'],['queue_number','Ticket'],['service_type','Service'],['doctor','Assigned doctor'],['priority_score','Priority score'],['status','Status'],['created_at','Registered'],['called_at','Called'],['consultation_started_at','Consultation started'],['completed_at','Completed / cancelled']];
const identityColumns = [['id','Account / staff ID'],['display_name','Display name'],['role','Stored role'],['position','Position'],['doctor','Assigned doctor / counter'],['account_status','Account status'],['online','Presence'],['authenticated','Authentication'],['last_login','Last login'],['last_seen','Last seen'],['created_at','Account created']];
const activityColumns = [['account','Account'],['event','Activity'],['occurred_at','Time']];
function cell(row,key) {
  // Accounts have no stored creation date (users.created_at does not exist).
  if (key==='created_at' && !row.created_at) return 'Not recorded';
  // Patients: a stored assignment, or the doctor the service routes to before one is stored.
  if (key==='doctor' && row.doctor_source==='service') return row.doctor ? `${row.doctor} (by service)` : 'Not assigned';
  if (key==='doctor' && row.doctor_source==='unresolved') return `${row.doctor} (no matching counter)`;
  if (['created_at','called_at','consultation_started_at','completed_at','last_login','last_seen','occurred_at'].includes(key)) return stamp(row[key]);
  if (key==='online') return row.online ? 'Online' : 'Offline';
  if (key==='authenticated') return row.authenticated ? 'Active session' : 'No active session';
  return row[key] ?? 'Unavailable';
}
export default function RecordsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const category = ['patients','staff','accounts'].includes(router.query.category) ? router.query.category : 'patients';
  // Draft (controls), applied filters and page all belong to one category, so a
  // category switch starts clean without sending the previous category's filters.
  const [draftState,setDraftState] = useState({ category:null, values:{} });
  const [view,setView] = useState({ category:null, applied:{}, page:1 });
  const draft = draftState.category===category ? draftState.values : {};
  const current = view.category===category ? view : { category, applied:{}, page:1 };
  const requestPath = `/records/${category}?${recordsQuery(category,current.applied,current.page,PAGE_SIZE)}`;
  const loadedPath = useRef('');
  const [data,setData] = useState(EMPTY_RESULT);
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState('');
  const [detail,setDetail] = useState(null);
  const [refresh,setRefresh] = useState(0);
  useEffect(() => { if (!loading && user?.role!=='superadmin') router.replace('/login'); },[loading,user,router]);
  useEffect(() => { setDetail(null); },[category]);
  useEffect(() => {
    if (user?.role!=='superadmin') return;
    let stale=false;
    setBusy(true);setError('');
    // A refresh keeps the rows on screen; a new query clears them first.
    if (loadedPath.current!==requestPath) setData(EMPTY_RESULT);
    request(requestPath).then(result => {
      if (result?.error) throw new Error(result.error);
      if (!Array.isArray(result?.rows)) throw new Error('The server returned an unexpected records response.');
      if (stale) return;
      loadedPath.current=requestPath; setData(result);
    }).catch(err => { if (stale) return; loadedPath.current=''; setData(EMPTY_RESULT); setError(err.message || 'Request failed'); }).finally(() => { if (!stale) setBusy(false); });
    return () => { stale=true; };
  },[user,requestPath,refresh]);
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
  const changeDraft = (key,value) => setDraftState(state => ({ category, values:{ ...(state.category===category ? state.values : {}), [key]:value } }));
  // Apply always re-runs the search, even when the filters are unchanged.
  const applyFilters = () => { setView({ category, applied:cleanRecordFilters(category,draft), page:1 }); setRefresh(value=>value+1); };
  const resetFilters = () => { setDraftState({ category, values:{} }); setView({ category, applied:{}, page:1 }); setRefresh(value=>value+1); };
  const removeFilter = key => {
    const { [key]:_applied, ...applied } = current.applied, { [key]:_draft, ...values } = draft;
    setView({ category, applied, page:1 }); setDraftState({ category, values });
  };
  const goToPage = page => setView({ ...current, page });
  const filtered = Object.keys(current.applied).length>0;
  const columns=category==='patients' ? patientColumns : identityColumns;
  function table(rows,cols,actions=false,emptyMessage='No records found.') {
    return <div className="overflow-x-auto border brand-border rounded"><table className="w-full text-sm text-left"><thead className="brand-bg-subtle"><tr>{cols.map(([key,label])=><th className="p-3 whitespace-nowrap" key={key}>{label}</th>)}{actions&&<th className="p-3">Details</th>}</tr></thead><tbody>{rows.map(row=><tr key={row.id} className="border-t brand-border">{cols.map(([key])=><td className="p-3 whitespace-nowrap" key={key}>{cell(row,key)}</td>)}{actions&&<td className="p-3"><button className="brand-button rounded px-3 py-1" onClick={()=>inspect(row)}>{category==='patients' ? 'Retrieve ticket' : 'Activity'}</button></td>}</tr>)}{!rows.length&&<tr><td className="p-6 text-center brand-text-muted" colSpan={cols.length+1}>{emptyMessage}</td></tr>}</tbody></table></div>;
  }
  const failure = error ? describeRecordsError(error) : null;
  if (loading || user?.role!=='superadmin') return <div role="status">Loading authorized records…</div>;
  return <SiteFrame title="Records Management" icon="fas fa-folder">
    <div className="max-w-7xl mx-auto px-3 space-y-4">
      <nav aria-label="Records categories" className="flex flex-wrap gap-2">{[['patients','Patient Records'],['staff','Staff Records'],['accounts','User Accounts']].map(([key,label])=><button key={key} aria-current={category===key?'page':undefined} className={`px-4 py-2 rounded ${category===key?'brand-button':'bg-white border brand-border'}`} onClick={()=>router.push(`/records?category=${key}`)}>{label}</button>)}</nav>
      <p className="text-sm brand-text-muted">{category==='patients' ? 'Each row is a stored visit and its ticket history. The current schema has no separate patient profile; this read-only view creates no duplicate identities or visits.' : 'Staff and user accounts share the existing account identity. Presence expires after 75 seconds; account status, authentication and counter availability are separate. Account disabling and account creation dates are not stored in the current schema.'}</p>
      <RecordsFilters key={category} category={category} draft={draft} applied={current.applied}
        onChange={changeDraft} onApply={applyFilters} onReset={resetFilters} onRemove={removeFilter}/>
      <div className="bg-white rounded shadow p-3" aria-busy={busy}>
        {failure ? <div role="alert" className="border border-red-200 bg-red-50 text-red-800 rounded p-4 flex flex-wrap items-start gap-3"><i className="fas fa-exclamation-triangle mt-1" aria-hidden="true"/><div className="flex-1 min-w-0"><p className="font-semibold">{failure.title}</p><p className="text-sm">{failure.advice}</p><p className="text-xs mt-1 break-words">Details: {error}</p></div><button type="button" className="bg-white border border-red-300 rounded px-3 py-1 text-sm" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>Retry</button></div>
          : busy && !data.rows.length ? <p role="status" className="p-6">Loading records…</p>
          : table(data.rows,columns,true,filtered ? 'No records match the applied filters. Remove a filter or select Reset.' : 'No records are stored in this category yet.')}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-3"><span>{busy ? (data.rows.length ? 'Refreshing…' : 'Loading…') : failure ? 'Results unavailable' : `${data.total||0} records`} · Page {current.page} · Times shown in Manila</span><div className="flex gap-3"><button disabled={busy||current.page===1} onClick={()=>goToPage(current.page-1)}>Previous</button><button disabled={busy||current.page*PAGE_SIZE>=(data.total||0)} onClick={()=>goToPage(current.page+1)}>Next</button><button onClick={()=>setRefresh(value=>value+1)}>Refresh</button></div></div>
      </div>
      {detail&&<section aria-label={detail.title} className="bg-white shadow rounded p-4"><div className="flex justify-between"><h2 className="font-bold">{detail.title}</h2><button onClick={()=>setDetail(null)}>Close</button></div>{detail.busy?<p role="status">Loading…</p>:detail.error?<p role="alert">{detail.error}</p>:<>{table(detail.rows||[],detail.patient?patientColumns:activityColumns)}{!detail.patient&&<p className="text-sm mt-2">Page {detail.page} ? {detail.total} events. Activity recording begins with Phase B; expiry and administrative revocation are not explicit logouts.</p>}{!detail.patient&&<div className="flex gap-4 mt-2"><button disabled={detail.page===1} onClick={()=>inspect({id:detail.account},detail.page-1)}>Previous activity</button><button disabled={detail.page*20>=detail.total} onClick={()=>inspect({id:detail.account},detail.page+1)}>Next activity</button></div>}</>}</section>}
    </div>
  </SiteFrame>;
}
