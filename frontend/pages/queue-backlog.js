import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../context/AuthContext';
import SiteFrame from '../components/SiteFrame';
import RecordsFilters from '../components/RecordsFilters';
import BacklogVisitDialog from '../components/BacklogVisitDialog';
import { recordsButtonClass, recordsPagination, recordsTable } from '../components/RecordsTable';
import { request } from '../lib/api';
import { cleanRecordFilters } from '../lib/recordsFilters';
import { BACKLOG_PAGE_SIZE, backlogPath, describeBacklogError } from '../lib/historicalBacklog';

const EMPTY_RESULT = { rows: [], total: 0, total_backlog: null };
const columns = [['queue_number','Ticket'],['patient_name','Patient'],['service_type','Service'],['doctor','Assigned doctor'],['priority_score','Base priority'],['created_at','Registered'],['status','Status'],['flags','Historical warnings']];

// Historical Waiting Backlog (Superadmin only; the API enforces this too). Lists visits still
// waiting that registered before today in Manila, for review and individual cancellation.
// Nothing on this page changes a visit except the confirmed Cancel in the dialog.
export default function QueueBacklogPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [draft,setDraft] = useState({});
  const [view,setView] = useState({ applied:{}, page:1 });
  const requestPath = backlogPath(view.applied, view.page, BACKLOG_PAGE_SIZE);
  const loadedPath = useRef('');
  const [data,setData] = useState(EMPTY_RESULT);
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState(null);
  const [refresh,setRefresh] = useState(0);
  const [dialog,setDialog] = useState(null);
  const [notice,setNotice] = useState('');
  useEffect(() => { if (!loading && user?.role!=='superadmin') router.replace('/login'); },[loading,user,router]);
  useEffect(() => {
    if (user?.role!=='superadmin') return;
    let stale=false;
    setBusy(true); setError(null);
    // A refresh keeps the rows on screen; a new query clears them first.
    if (loadedPath.current!==requestPath) setData(EMPTY_RESULT);
    request(requestPath).then(result => {
      if (stale) return;
      if (result?.error) { loadedPath.current=''; setData(EMPTY_RESULT); setError({ message:result.error, status:result.status }); return; }
      if (!Array.isArray(result?.rows)) { setData(EMPTY_RESULT); setError({ message:'The server returned an unexpected backlog response.' }); return; }
      loadedPath.current=requestPath; setData(result);
    }).catch(err => { if (!stale) { loadedPath.current=''; setData(EMPTY_RESULT); setError({ message:err.message || 'Request failed' }); } })
      .finally(() => { if (!stale) setBusy(false); });
    return () => { stale=true; };
  },[user,requestPath,refresh]);
  // Background refresh pauses while a visit is open, so the list never shifts under a review.
  useEffect(() => {
    if (user?.role!=='superadmin' || dialog) return;
    const timer=setInterval(() => setRefresh(value=>value+1),30000);
    return () => clearInterval(timer);
  },[user,dialog]);
  const changeDraft = (key,value) => setDraft(values => ({ ...values, [key]:value }));
  const applyFilters = () => { setView({ applied:cleanRecordFilters('backlog',draft), page:1 }); setRefresh(value=>value+1); };
  const resetFilters = () => { setDraft({}); setView({ applied:{}, page:1 }); setRefresh(value=>value+1); };
  const removeFilter = key => {
    const { [key]:_applied, ...applied } = view.applied, { [key]:_draft, ...values } = draft;
    setView({ applied, page:1 }); setDraft(values);
  };
  function changed(message) {
    setDialog(null); setNotice(message); setRefresh(value=>value+1);
  }
  const filtered = Object.keys(view.applied).length>0;
  const failure = error ? describeBacklogError(error.message, error.status) : null;
  const count = failure || data.total_backlog==null ? null : data.total_backlog;
  const actions = [
    { label:'Review visit', icon:'fas fa-clipboard-check', describe:row=>`Review visit ${row.queue_number}`, onClick:row=>{ setNotice(''); setDialog({ id:row.id, mode:'review' }); } },
    { label:'Cancel visit', icon:'fas fa-ban', tone:'danger', describe:row=>`Cancel visit ${row.queue_number}`, onClick:row=>{ setNotice(''); setDialog({ id:row.id, mode:'cancel' }); } }
  ];
  if (loading || user?.role!=='superadmin') return <div role="status">Loading authorized backlog…</div>;
  return <SiteFrame title="Historical Backlog" icon="fas fa-history">
    <div className="w-full min-w-0 max-w-7xl mx-auto px-3 space-y-4">
      <section className="bg-white rounded shadow p-4 flex flex-wrap items-start justify-between gap-4" aria-labelledby="backlog-heading">
        <div className="min-w-0 flex-1" style={{ minWidth:'16rem' }}>
          <h1 id="backlog-heading" className="text-xl font-bold m-0">Historical Waiting Backlog</h1>
          <p className="text-sm brand-text-muted mt-1 mb-0">Patients still marked <strong>Waiting</strong> who registered before today (Manila time{data.business_date ? `, ${data.business_date}` : ''}). They are not counted in today&apos;s registrations. Some may be valid carry-over visits: review each one, keep it waiting, or cancel it individually. Cancelling keeps the visit&apos;s full history.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-right" role="status" aria-live="polite">
            <div className="text-3xl font-bold leading-none">{count==null ? '—' : count}</div>
            <div className="text-xs brand-text-muted">{count==null ? 'Backlog count unavailable' : `historical waiting visit${count===1?'':'s'}${data.requires_review ? ` · ${data.requires_review} require${data.requires_review===1?'s':''} review` : ''}`}</div>
          </div>
          <button type="button" className={recordsButtonClass} disabled={busy} onClick={()=>setRefresh(value=>value+1)}>
            <i className={`fas fa-sync-alt${busy?' fa-spin':''}`} aria-hidden="true"/>Refresh
          </button>
        </div>
      </section>
      {notice ? <div role="status" className="border border-green-200 bg-green-50 text-green-800 rounded p-3 flex items-start gap-3"><i className="fas fa-check-circle mt-1" aria-hidden="true"/><span className="flex-1">{notice}</span><button type="button" className={recordsButtonClass} onClick={()=>setNotice('')}><i className="fas fa-times" aria-hidden="true"/>Dismiss</button></div> : null}
      {data.truncated ? <div role="alert" className="border border-amber-200 bg-amber-50 text-amber-900 rounded p-3 text-sm"><i className="fas fa-exclamation-triangle mr-2" aria-hidden="true"/>Only the oldest 500 historical visits are listed. Resolve these first; the rest appear after a refresh.</div> : null}
      <RecordsFilters category="backlog" draft={draft} applied={view.applied}
        onChange={changeDraft} onApply={applyFilters} onReset={resetFilters} onRemove={removeFilter}/>
      <div className="bg-white rounded shadow p-3" aria-busy={busy}>
        {failure ? <div role="alert" className="border border-red-200 bg-red-50 text-red-800 rounded p-4 flex flex-wrap items-start gap-3"><i className="fas fa-exclamation-triangle mt-1" aria-hidden="true"/><div className="flex-1 min-w-0"><p className="font-semibold">{failure.title}</p><p className="text-sm">{failure.advice}</p><p className="text-xs mt-1 break-words">Details: {error.message}</p></div><button type="button" className={recordsButtonClass} disabled={busy} onClick={()=>setRefresh(value=>value+1)}><i className="fas fa-redo" aria-hidden="true"/>Retry</button></div>
          : busy && !data.rows.length ? <p role="status" className="p-6 brand-text-muted">Loading historical backlog…</p>
          : recordsTable({ label:'Historical waiting visits', columns, rows:data.rows, actions, actionsHeading:'Actions',
              emptyMessage:filtered ? 'No historical visits match the applied filters. Remove a filter or select Reset.' : 'No historical waiting visits. Every waiting patient registered today.' })}
        {recordsPagination({ page:view.page, total:data.total||0, limit:data.limit||BACKLOG_PAGE_SIZE, rowCount:data.rows.length, busy, failed:Boolean(failure),
          onPrevious:()=>setView({ ...view, page:view.page-1 }), onNext:()=>setView({ ...view, page:view.page+1 }), onRefresh:()=>setRefresh(value=>value+1) })}
      </div>
      {dialog ? <BacklogVisitDialog key={`${dialog.id}-${dialog.mode}`} visitId={dialog.id} mode={dialog.mode}
        onClose={()=>{ setDialog(null); setRefresh(value=>value+1); }} onChanged={changed}/> : null}
    </div>
  </SiteFrame>;
}
