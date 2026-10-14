'use client'
import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'
import { usePermissions } from '@/lib/permissions'
import type { Project } from '@/app/types/index'

// ── TOKENS ───────────────────────────────────────────────────────────────────
const UNIT_OPTIONS = ['PCS', 'LOT', 'SET', 'KG', 'M', 'FT', 'ROLL', 'BOX', 'UNIT']
const C = {
  darkGreen:'#1a4d2e', midGreen:'#2d6a4f', accent:'#39b54a',
  white:'#ffffff', dark:'#0d1f14', gray:'#6b7c72',
  lightGray:'#e8ede9', red:'#e53e3e', amber:'#d97706', blue:'#2563eb', purple:'#7c3aed',
}

const fmt = (n:number) => `₱ ${Number(n||0).toLocaleString('en-PH',{minimumFractionDigits:2, maximumFractionDigits:2})}`
// Postgres date columns reject '' outright — only a real date string or null.
const nz = (v:any) => (v === '' || v === undefined) ? null : v

// Ported from QuotationsPage — only 'item' rows count toward the client-facing
// total; material sub-rows are reference-only (their cost is already folded
// into the item's own price via the Cost Builder).
function computeDueDate(dateStr:string, paymentTerms:string): string | null {
  if (!dateStr) return null
  const daysMatch = /(\d+)/.exec(paymentTerms || '')
  const days = daysMatch ? Number(daysMatch[1]) : 30
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0,10)
}
function isInvoiceOverdue(inv:any): boolean {
  if (inv.status === 'Paid' || inv.status === 'Cancelled') return false
  const due = computeDueDate(inv.date, inv.payment_terms)
  if (!due) return false
  const dueDate = new Date(due + 'T00:00:00')
  dueDate.setDate(dueDate.getDate() + 1)
  return new Date() >= dueDate
}

function quotationTotal(q:any) {
  const items = q.quotation_items || []
  const sum = items.reduce((s:number,i:any)=> i.kind==='item' ? s+(Number(i.qty)||0)*(Number(i.price)||0) : s, 0)
  const discounted = sum * (1 - (Number(q.discount_pct)||0)/100)
  const total = q.vat_mode === 'included' || q.vat_mode === 'exempt' ? discounted : discounted * 1.12
  return Math.round(total * 100) / 100
}

const BLANK:Omit<Project,'id'> = {
  name:'', client:'', type:'Fabrication', status:'Active', start_date: new Date().toISOString().split('T')[0],
  end_date:'', value:0, progress:0, progress_manual:false, manager:'C. Ramos', notes:'',
  po_number:'', quotation_id:'', invoice_id:'', dr_number:'',
  delivery_date_needed:'', actual_delivery_date:'',
  payment_terms_days:30, cr_number:'', collection_date:'',
  collection_amount:0, date_collected:'', payment_status:'Unpaid'
}
const MANAGERS = ['A. Reyes','B. Santos','C. Ramos','D. Navarro']
const TERMS_PRESETS = [15,30,60,90]

// ── PROGRESS / STAGE LOGIC ───────────────────────────────────────────────────
// Automatic by default: derived from what has actually happened — the
// project's own fields plus timeline events, which Purchasing, Inventory and
// Invoices now write on their own (so acting in those modules moves this bar).
// The furthest milestone reached wins. A project can be switched to Manual
// (progress_manual) to hold a hand-set percentage instead.
function autoStage(p:any, quotations:any[], events:Set<string>) {
  const q = p.quotation_id ? quotations.find(q=>q.id===p.quotation_id) : null
  const steps: { on:boolean, pct:number, label:string }[] = [
    { on: !!p.date_collected || events.has('Payment Collected'), pct: 100, label: 'Payment Collected' },
    { on: !!p.actual_delivery_date || events.has('Delivered'),   pct: 85,  label: 'Delivered – Awaiting Payment' },
    { on: events.has('Fabrication Complete'),                    pct: 80,  label: 'Fabrication Complete' },
    { on: !!p.invoice_id || events.has('Invoiced'),              pct: 70,  label: 'Invoiced – In Fabrication' },
    { on: events.has('Fabrication Started'),                     pct: 65,  label: 'Fabrication Started' },
    { on: events.has('Material Received') || events.has('Material Released') || events.has('Material Purchased'), pct: 60, label: 'Materials In Hand' },
    { on: events.has('Supplier PO Issued') || events.has('Quote Approved'), pct: 50, label: 'Materials Ordered' },
    { on: events.has('Material Requested'),                      pct: 40,  label: 'Materials Requested' },
    { on: !!p.po_number,                                         pct: 30,  label: 'PO Received' },
    { on: !!p.quotation_id && q?.status === 'Approved',          pct: 25,  label: 'Quotation Approved' },
    { on: !!p.quotation_id,                                      pct: 15,  label: 'Quotation Sent' },
  ]
  return steps.find(s => s.on) || { pct: 0, label: 'Not Started' }
}

function computeProgress(p:any, quotations:any[], events:Set<string> = new Set()) {
  if (p.progress_manual) return Math.min(Math.max(Number(p.progress)||0,0),100)
  return autoStage(p, quotations, events).pct
}

function getStageLabel(p:any, quotations:any[], events:Set<string> = new Set()) {
  const auto = autoStage(p, quotations, events).label
  return p.progress_manual ? `${auto} · manual %` : auto
}

function getPaymentStatus(p:any) {
  if (p.date_collected) return 'Paid'
  if (!p.actual_delivery_date) return 'N/A'
  const due = new Date(p.actual_delivery_date)
  due.setDate(due.getDate() + (Number(p.payment_terms_days)||30))
  return new Date() > due ? 'Overdue' : 'Pending'
}

function getDueDate(p:any) {
  if (!p.actual_delivery_date) return null
  const due = new Date(p.actual_delivery_date)
  due.setDate(due.getDate() + (Number(p.payment_terms_days)||30))
  return due.toISOString().split('T')[0]
}

// ── VISUAL COMPONENTS ────────────────────────────────────────────────────────
function Field({label, type='text', value, onChange, options, placeholder, span, prefix, disabled, hint, error, skipDefault}:any){
  const base:React.CSSProperties={width:'100%',padding:'9px 12px',border:`1.5px solid ${error ? C.red : C.lightGray}`,borderRadius:6,fontSize:13,fontFamily:'inherit',color:C.dark,background: disabled ? '#f4f7f5' : (error ? `${C.red}08` : '#fafcfb'),boxSizing:'border-box',outline:'none'}
  // Data-entry UX: plain text fields select-all-on-focus, force uppercase (except
  // email/password/notes-style free text, left readable as typed), and default
  // blank/whitespace to "N/A" on blur unless the caller marks it skipDefault
  // (required-elsewhere fields, or fields whose blank state carries its own
  // meaning — e.g. a nullable reference number or a fallback-driven override).
  const lbl = (label||'').toLowerCase()
  const isFreeformLabel = /email|password|notes|remarks|description|comment/.test(lbl)
  const isPlainText = type!=='select' && type!=='textarea' && type!=='date' && type!=='time' && type!=='file' && type!=='color' && type!=='checkbox' && type!=='radio' && type!=='number' && type!=='range'
  const isNumber = type==='number'
  const handleChange = (e:any) => {
    if (isPlainText) onChange(isFreeformLabel ? e.target.value : e.target.value.toUpperCase())
    else onChange(e.target.value)
  }
  const handleBlur = (e:any) => {
    if (isPlainText && !skipDefault && !e.target.value.trim()) onChange('N/A')
  }
  return(
    <div style={{marginBottom:14,gridColumn:span?'1/-1':'auto'}}>
      <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: error ? C.red : C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>{label}{error && ' *'}</label>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {prefix && <span style={{ position: 'absolute', left: 12, fontSize: 13, fontWeight: 700, color: C.gray }}>{prefix} </span>}
        {type==='select'
          ?<select value={value} onChange={e=>onChange(e.target.value)} style={base} disabled={disabled}><option value="">Select…</option>{options.map((o:any)=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}</select>
          :type==='textarea'
            ?<textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={3} style={{...base,resize:'vertical'}} disabled={disabled}/>
            :<input type={type} value={value} onChange={handleChange} onFocus={(isPlainText||isNumber) ? (e:any)=>e.target.select() : undefined} onBlur={isPlainText ? handleBlur : undefined} placeholder={placeholder} style={{...base, paddingLeft: prefix ? "28px" : "12px"}} disabled={disabled}/>}
      </div>
      {error ? <div style={{fontSize:10,color:C.red,marginTop:4,fontWeight:700}}>{typeof error === 'string' ? error : 'Required'}</div> : hint && <div style={{fontSize:10,color:C.gray,marginTop:4}}>{hint}</div>}
    </div>
  )
}

function Badge({label}:{label:string}){
  const colors:Record<string,string>={Active:C.accent,Completed:C.blue,'On Hold':C.amber,Cancelled:C.red,Paid:C.accent,Pending:C.amber,Overdue:C.red,'N/A':C.gray}
  const color=colors[label]||C.gray
  return <span style={{padding:'3px 10px',borderRadius:20,background:`${color}22`,color,fontSize:10,fontWeight:800,border:`1px solid ${color}44`,whiteSpace:'nowrap'}}>{label}</span>
}

function DocChip({label, value, color}:{label:string, value:string, color:string}){
  if (!value) return null
  return (
    <div style={{display:'flex',alignItems:'center',gap:5,padding:'3px 9px',borderRadius:6,background:`${color}12`,border:`1px solid ${color}33`}}>
      <span style={{fontSize:8,fontWeight:800,color,letterSpacing:0.5,textTransform:'uppercase'}}>{label}</span>
      <span style={{fontSize:10,fontWeight:800,color:C.dark}}>{value}</span>
    </div>
  )
}

const TIMELINE_EVENT_PRESETS = ['PO Received','Purchasing Started','Material Purchased','Fabrication Started','Fabrication Complete','Delivered','Invoiced','Payment Collected','Other']

function ManualTimelineForm({po, onAdd}:{po:string, onAdd:(po:string,eventType:string,date:string,notes:string)=>Promise<void>}){
  const [eventType,setEventType]=useState('PO Received')
  const [customType,setCustomType]=useState('')
  const [date,setDate]=useState(new Date().toISOString().slice(0,10))
  const [notes,setNotes]=useState('')
  const [saving,setSaving]=useState(false)
  const submit = async () => {
    const finalType = eventType==='Other' ? customType.trim() : eventType
    if (!finalType) return
    setSaving(true)
    await onAdd(po, finalType, date, notes)
    setNotes(''); setCustomType('')
    setSaving(false)
  }
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1.3fr 1fr 1.5fr auto', gap:6, marginBottom:14 }}>
      <select value={eventType} onChange={e=>setEventType(e.target.value)} style={{ padding:'7px 9px', border:`1.5px solid ${C.lightGray}`, borderRadius:6, fontSize:11, fontFamily:'inherit' }}>
        {TIMELINE_EVENT_PRESETS.map(t=><option key={t} value={t}>{t}</option>)}
      </select>
      {eventType==='Other'
        ? <input value={customType} onChange={e=>setCustomType(e.target.value.toUpperCase())} onFocus={e=>e.target.select()} placeholder="Event name" style={{ padding:'7px 9px', border:`1.5px solid ${C.lightGray}`, borderRadius:6, fontSize:11 }}/>
        : <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{ padding:'7px 9px', border:`1.5px solid ${C.lightGray}`, borderRadius:6, fontSize:11 }}/>}
      <input value={notes} onChange={e=>setNotes(e.target.value)} onFocus={e=>e.target.select()} placeholder="Notes (optional)" style={{ padding:'7px 9px', border:`1.5px solid ${C.lightGray}`, borderRadius:6, fontSize:11 }}/>
      <button type="button" onClick={submit} disabled={saving} style={{ padding:'7px 14px', fontSize:10, fontWeight:700, background:`${C.accent}18`, border:`1px solid ${C.accent}44`, color:C.accent, borderRadius:6, cursor:'pointer' }}>{saving?'...':'+ Log'}</button>
    </div>
  )
}

// ── PAGE COMPONENT ───────────────────────────────────────────────────────────
export default function ProjectsPage(){
  const supabase = createClient()
  const [projects,setProjects]=useState<Project[]>([])
  const [quotations,setQuotations]=useState<any[]>([])
  const [invoices,setInvoices]=useState<any[]>([])
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [showModal,setShowModal]=useState(false)
  const [selected,setSelected]=useState<any>(null)
  const [form,setForm]=useState<any>(BLANK)
  const [filter,setFilter] = useState('All')
  const [clientFilter,setClientFilter] = useState('All')
  const [page,setPage] = useState(1)
  const PAGE_SIZE = 50
  const canEdit = usePermissions().canEditModule('projects')
  const [error,setError]=useState('')
  const [idAvailable,setIdAvailable]=useState(true)
  const [checkingId,setCheckingId]=useState(false)

  // ── PHASE 1: PO-driven project creation ──────────────────────────────────
  const [showNewPOFlow,setShowNewPOFlow]=useState(false)
  const [poForm,setPoForm]=useState({po_number:'', client:'', project_name:''})
  const [poFormAttempted,setPoFormAttempted]=useState(false)
  const [poQtyOverrides,setPoQtyOverrides]=useState<Record<string,string>>({})
  const [poNumberTaken,setPoNumberTaken]=useState(false)
  const [availableQuotations,setAvailableQuotations]=useState<any[]>([])
  const [selectedQuoIds,setSelectedQuoIds]=useState<string[]>([])
  const [showAddQuoToProject,setShowAddQuoToProject]=useState(false)

  // ── Project BOM (Bill of Materials) ──────────────────────────────────────
  const [bomRows,setBomRows]=useState<any[]>([])

  // ── Equipment — read-only viewer. Assignment (occupancy, operator) is now
  // managed entirely from Resources by the Tool Keeper; this just displays
  // whatever machines are currently/previously assigned to this PO. ─────────
  const [equipmentAssignedToProject,setEquipmentAssignedToProject]=useState<any[]>([])
  const fetchEquipmentForProject = useCallback(async(po:string)=>{
    const {data} = await supabase.from('equipment_assignments').select('*, equipment(name,brand)').eq('po_number',po).order('start_date',{ascending:false})
    setEquipmentAssignedToProject(data||[])
  },[supabase])

  // ── Document Attachments ──────────────────────────────────────────────────
  const [attachments,setAttachments]=useState<any[]>([])
  const [uploadingFile,setUploadingFile]=useState(false)
  const fetchAttachments = useCallback(async(po:string)=>{
    const {data} = await supabase.from('attachments').select('*').eq('record_type','project').eq('record_id',po).order('created_at',{ascending:false})
    setAttachments(data||[])
  },[supabase])
  const uploadAttachment = async (po:string, file:File) => {
    setUploadingFile(true)
    const path = `project/${po}/${Date.now()}-${file.name}`
    const { error: upErr } = await supabase.storage.from('attachments').upload(path, file)
    if (upErr) { alert(upErr.message); setUploadingFile(false); return }
    await supabase.from('attachments').insert({ record_type:'project', record_id:po, file_name:file.name, file_path:path })
    await fetchAttachments(po)
    setUploadingFile(false)
  }
  const openAttachment = async (att:any) => {
    const { data } = await supabase.storage.from('attachments').createSignedUrl(att.file_path, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  const deleteAttachment = async (att:any, po:string) => {
    if (!window.confirm(`Delete "${att.file_name}"?`)) return
    await supabase.storage.from('attachments').remove([att.file_path])
    await supabase.from('attachments').delete().eq('id',att.id)
    await fetchAttachments(po)
  }

  const fetchBom = useCallback(async (po:string) => {
    const {data} = await supabase.from('project_bom').select('*').eq('po_number', po).order('created_at')
    setBomRows(data||[])
  },[supabase])

  // All quotations under this PO, including superseded ones — needed to
  // detect when the BOM is referencing a quotation that's since been
  // revised, so we can prompt a re-sync rather than silently going stale.
  const [poQuotationsAll,setPoQuotationsAll]=useState<any[]>([])
  const fetchPoQuotations = useCallback(async (po:string) => {
    const {data} = await supabase.from('quotations').select('*, quotation_items(*)').eq('po_number', po)
    setPoQuotationsAll(data||[])
  },[supabase])
  const currentPoQuotations = poQuotationsAll.filter(q=>q.status!=='Superseded')
  const bomNeedsSync = bomRows.some(r => r.source_quotation_id && poQuotationsAll.find(q=>q.id===r.source_quotation_id)?.status==='Superseded')

  const syncBomWithLatestVersions = async (po:string) => {
    if (!window.confirm('Sync the BOM with the latest quotation version(s)? Prices/quantities update to match; anything already purchased or released stays untouched.')) return
    const currentLineUids = new Set<string>()
    const inserts:any[] = []
    for (const q of currentPoQuotations) {
      for (const m of (q.quotation_items||[]).filter((it:any)=>it.kind==='material')) {
        if (!m.line_uid) continue
        currentLineUids.add(m.line_uid)
        const existing = bomRows.find(r=>r.source_line_uid===m.line_uid)
        if (existing) {
          await supabase.from('project_bom').update({
            source_quotation_id: q.id, description: m.description||'', dimension: m.dimension||'',
            qty_needed: Number(m.qty)||0, unit: m.unit||'', estimated_unit_cost: Number(m.price)||0,
            status_note: null,
          }).eq('id', existing.id)
        } else {
          inserts.push({
            po_number: po, source_quotation_id: q.id, source_line_uid: m.line_uid,
            description: m.description||'', dimension: m.dimension||'',
            qty_needed: Number(m.qty)||0, unit: m.unit||'', estimated_unit_cost: Number(m.price)||0,
          })
        }
      }
    }
    // Lines that came from a quotation but no longer appear in any current
    // version — flag rather than delete, since purchase history may exist.
    for (const r of bomRows) {
      if (r.source_line_uid && !currentLineUids.has(r.source_line_uid)) {
        await supabase.from('project_bom').update({ status_note: 'Removed in a newer quotation version — verify before deleting' }).eq('id', r.id)
      }
    }
    if (inserts.length > 0) await supabase.from('project_bom').insert(inserts)
    await fetchBom(po)
    await fetchPoQuotations(po)
    await logTimelineEvent(po, 'BOM Synced', `Bill of Materials refreshed to match the latest quotation version(s)`)
  }

  // ── Project Timeline ──────────────────────────────────────────────────────
  const [timelineRows,setTimelineRows]=useState<any[]>([])
  const fetchTimeline = useCallback(async (po:string) => {
    const {data} = await supabase.from('project_timeline').select('*').eq('po_number', po).order('event_date',{ascending:false})
    setTimelineRows(data||[])
  },[supabase])
  const logTimelineEvent = async (po:string, event_type:string, notes?:string) => {
    await supabase.from('project_timeline').insert({po_number:po, event_type, notes: notes||null})
  }
  const f=(k:string)=>(v:any)=>setForm((p:any)=>({...p,[k]:v}))

  const [allInvoicesForList,setAllInvoicesForList]=useState<any[]>([])
  const [eventsByPo,setEventsByPo]=useState<Record<string,Set<string>>>({})
  const eventsFor = (po?:string|null) => (po && eventsByPo[po]) || new Set<string>()
  const fetch = useCallback(async()=>{
    setLoading(true)
    // Supabase's PostgREST layer caps an unranged select at 1000 rows — the
    // live projects table has already passed that (1,246+ after the
    // historical migration), so without an explicit range this list and its
    // KPI counts would silently be short by however many rows sort last.
    const [{data},{data:invs},{data:tl}]=await Promise.all([
      fetchAllPages<any>((from, to) => supabase.from('projects').select('*').order('created_at',{ascending:false}).range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('invoices').select('*, invoice_items(*)').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('project_timeline').select('po_number,event_type').range(from, to)),
    ])
    if(data) setProjects(data)
    setAllInvoicesForList(invs||[])
    const ev:Record<string,Set<string>> = {}
    ;(tl||[]).forEach((t:any)=>{ (ev[t.po_number] ||= new Set()).add(t.event_type) })
    setEventsByPo(ev)
    setLoading(false)
  },[supabase])

  // Live invoiced total for a PO-driven project — computed the same way as
  // the edit modal's own tracker, but available right on the list card so
  // the number shown there is never a stale, frozen figure.
  const invoicedTotalForPO = (po:string) => {
    const forThisPo = allInvoicesForList.filter(inv=>inv.po_number===po)
    return forThisPo.reduce((s,inv)=>{
      const sub=(inv.invoice_items||[]).filter((it:any)=>it.kind==='item').reduce((ss:number,it:any)=>ss+(Number(it.qty)||0)*(Number(it.price)||0),0)
      const discounted = sub * (1-(Number(inv.discount_pct)||0)/100)
      return s + (inv.vat_mode==='included'||inv.vat_mode==='exempt' ? discounted : discounted*1.12)
    },0)
  }

  // ── Monitoring view (PO-monitoring-sheet layout: one row per item line) ──
  const [viewMode,setViewMode]=useState<'cards'|'monitor'>('cards')
  const [monitorQuos,setMonitorQuos]=useState<any[]>([])
  const [monitorInvs,setMonitorInvs]=useState<any[]>([])
  const [monitorLoading,setMonitorLoading]=useState(false)
  const loadMonitor = useCallback(async()=>{
    setMonitorLoading(true)
    const {data:q}=await fetchAllPages<any>((from, to) => supabase.from('quotations').select('id,po_number,status,vat_mode,quotation_items(kind,description,qty,unit,price,position)').not('po_number','is',null).neq('status','Superseded').range(from, to))
    setMonitorQuos(q||[])
    const {data:i}=await fetchAllPages<any>((from, to) => supabase.from('invoices').select('id,po_number').not('po_number','is',null).range(from, to))
    setMonitorInvs(i||[])
    setMonitorLoading(false)
  },[supabase])
  useEffect(()=>{ if(viewMode==='monitor') loadMonitor() },[viewMode, loadMonitor])

  const fetchDocs = useCallback(async()=>{
    const {data:q}=await fetchAllPages<any>((from, to) => supabase.from('quotations').select('id,client,company_name,status').order('created_at',{ascending:false}).range(from, to))
    if(q) setQuotations(q)
    const {data:i}=await supabase.from('invoices').select('id,client,company_name,status,quotation_id').order('created_at',{ascending:false})
    if(i) setInvoices(i)
  },[supabase])

  useEffect(()=>{ fetch(); fetchDocs() },[fetch, fetchDocs])

  const fetchAvailableQuotations = useCallback(async (poBeingCreated?:string) => {
    let query = supabase.from('quotations').select('*, quotation_items(*)').eq('status','Approved')
    // Show untagged quotations (ready to be freshly attached) AND anything
    // someone already pre-tagged with this exact PO number directly on the
    // quotation itself — otherwise a quotation typed with a PO number first
    // becomes invisible here, even though it's exactly what should show up.
    query = poBeingCreated && poBeingCreated.trim()
      ? query.or(`po_number.is.null,po_number.eq.${poBeingCreated.trim()}`)
      : query.is('po_number', null)
    const {data} = await query.order('created_at',{ascending:false})
    setAvailableQuotations(data||[])
  },[supabase])

  const checkPoNumber = useCallback(async (po:string) => {
    if (!po || po.trim()==='') { setPoNumberTaken(false); return }
    const {data} = await supabase.from('projects').select('po_number').eq('po_number', po.trim()).maybeSingle()
    setPoNumberTaken(!!data)
  },[supabase])

  // Debounced uniqueness check while typing a new ID
  const checkId = useCallback(async (id:string) => {
    if (selected || !id || id.trim() === '') { setIdAvailable(true); return }
    setCheckingId(true)
    const { data } = await supabase.from('projects').select('id').eq('id', id.trim()).maybeSingle()
    setIdAvailable(!data)
    setCheckingId(false)
  }, [supabase, selected])

  const openNew=()=>{
    const id=`PRJ-${new Date().getFullYear()}-${String(projects.length + 1).padStart(3,'0')}`
    setForm({...BLANK, id: id})
    setSelected(null); setError(''); setIdAvailable(true); setShowModal(true)
  }

  const openEdit=(p:any)=>{
    setForm({...BLANK, ...p}); setSelected(p); setError(''); setIdAvailable(true); setShowModal(true)
    if (p.po_number) { fetchBom(p.po_number); fetchTimeline(p.po_number); fetchPoInvoicedTotal(p.po_number); fetchPoQuotations(p.po_number); fetchEquipmentForProject(p.po_number); fetchAttachments(p.po_number) } else { setBomRows([]); setTimelineRows([]); setPoInvoicedTotal(0); setPoCollectedTotal(0); setPoInvoicesList([]); setPoQuotationsAll([]); setEquipmentAssignedToProject([]); setAttachments([]) }
  }

  const openNewPOFlow = () => {
    setPoForm({po_number:'', client:'', project_name:''}); setPoNumberTaken(false); setSelectedQuoIds([]); setPoQtyOverrides({})
    fetchAvailableQuotations()
    setError(''); setPoFormAttempted(false); setShowNewPOFlow(true)
  }

  // Pairs each 'item' line with the 'material' sub-lines immediately
  // following it — same convention Quotations itself uses to associate
  // materials with their parent item.
  const itemLinesWithMaterials = (q:any) => {
    const items = (q.quotation_items||[]).slice().sort((a:any,b:any)=>(a.position||0)-(b.position||0))
    const result:{item:any, materials:any[]}[] = []
    let i = 0
    while (i < items.length) {
      if (items[i].kind === 'item') {
        const materials:any[] = []
        let j = i+1
        while (j < items.length && items[j].kind === 'material') { materials.push(items[j]); j++ }
        result.push({ item: items[i], materials })
        i = j
      } else i++
    }
    return result
  }

  // ── PHASE 3: quantity-aware partial invoicing ────────────────────────────
  const [showInvoiceFlow,setShowInvoiceFlow]=useState(false)
  const [invoicingLines,setInvoicingLines]=useState<any[]>([])
  const [invoiceQtyPicked,setInvoiceQtyPicked]=useState<Record<string,number>>({}) // line_uid -> qty chosen this round
  const [newInvForm,setNewInvForm]=useState({id:'', date:new Date().toISOString().slice(0,10), payment_terms:'30 Days', dr_number:''})
  const [invIdAvail,setInvIdAvail]=useState(true)
  const [poInvoicedTotal,setPoInvoicedTotal]=useState(0)

  const [poInvoicesList,setPoInvoicesList]=useState<any[]>([])
  const [poCollectedTotal,setPoCollectedTotal]=useState(0)
  const fetchPoInvoicedTotal = useCallback(async (po:string) => {
    const {data} = await supabase.from('invoices').select('*, invoice_items(*)').eq('po_number', po).order('date')
    const invTotal = (inv:any) => {
      const sub = (inv.invoice_items||[]).filter((it:any)=>it.kind==='item').reduce((ss:number,it:any)=>ss+(Number(it.qty)||0)*(Number(it.price)||0),0)
      const discounted = sub * (1-(Number(inv.discount_pct)||0)/100)
      return inv.vat_mode==='included'||inv.vat_mode==='exempt' ? discounted : discounted*1.12
    }
    const total = (data||[]).reduce((s:number,inv:any)=>s+invTotal(inv),0)
    const collected = (data||[]).reduce((s:number,inv:any)=>{
      if (inv.collection_amount != null) return s + Number(inv.collection_amount)
      if (inv.status === 'Paid') return s + invTotal(inv)
      return s
    },0)
    setPoInvoicedTotal(total)
    setPoCollectedTotal(collected)
    setPoInvoicesList((data||[]).map((inv:any)=>({...inv, _total: invTotal(inv)})))
    return data||[]
  },[supabase])

  const openInvoiceFlow = async (po:string) => {
    setInvoicingLines([]); setInvoiceQtyPicked({}); setError('')
    setNewInvForm({id:`INV-${new Date().getFullYear()}-${String(invoices.length+1).padStart(3,'0')}`, date:new Date().toISOString().slice(0,10), payment_terms:'30 Days', dr_number:''})

    const existingInvoices = await fetchPoInvoicedTotal(po)
    const invoicedQtyByLine: Record<string,number> = {}
    existingInvoices.forEach((inv:any) => (inv.invoice_items||[]).forEach((it:any) => {
      if (it.source_line_uid) invoicedQtyByLine[it.source_line_uid] = (invoicedQtyByLine[it.source_line_uid]||0) + Number(it.qty||0)
    }))

    const {data: linkedQuotes} = await supabase.from('quotations').select('*, quotation_items(*)').eq('po_number', po)
    const lines:any[] = []
    ;(linkedQuotes||[]).filter((q:any)=>q.status!=='Superseded').forEach((q:any) => {
      (q.quotation_items||[]).filter((it:any)=>it.kind==='item' && it.line_uid).forEach((it:any) => {
        const alreadyInvoiced = invoicedQtyByLine[it.line_uid] || 0
        const remaining = Number(it.qty||0) - alreadyInvoiced
        if (remaining > 0.0001) {
          lines.push({ line_uid: it.line_uid, description: it.description, unit: it.unit, price: Number(it.price)||0, qtyTotal: Number(it.qty)||0, alreadyInvoiced, remaining, quotation_id: q.id })
        }
      })
    })
    setInvoicingLines(lines)
    const defaults: Record<string,number> = {}
    lines.forEach(l => defaults[l.line_uid] = l.remaining)
    setInvoiceQtyPicked(defaults)
    setShowInvoiceFlow(true)
  }

  const checkNewInvId = useCallback(async (id:string) => {
    if (!id) { setInvIdAvail(true); return }
    const {data} = await supabase.from('invoices').select('id').eq('id', id.trim()).maybeSingle()
    setInvIdAvail(!data)
  },[supabase])

  const updatePoInvoiceField = async (invId:string, field:string, value:any) => {
    const patch:any = {[field]:value}
    if (field==='cr_number' && value.trim()) patch.status = 'Paid'
    const updatedList = poInvoicesList.map(inv=>inv.id===invId?{...inv,...patch}:inv)
    setPoInvoicesList(updatedList)
    await supabase.from('invoices').update(patch).eq('id', invId)
    if (selected?.po_number) await fetchPoInvoicedTotal(selected.po_number)

    // Once every invoice under this PO is Paid, the project itself is done —
    // this is the natural completion point, not something that should need
    // a separate manual status change after the fact.
    if (field==='cr_number' && value.trim() && selected?.po_number && updatedList.length>0 && updatedList.every(inv=>inv.status==='Paid')) {
      await supabase.from('projects').update({status:'Completed'}).eq('po_number', selected.po_number)
      setForm((p:any)=>({...p,status:'Completed'}))
      await fetch()
    }
  }

  const createPartialInvoice = async () => {
    if (!selected?.po_number) return
    if (!newInvForm.id.trim()) return setError('Invoice ID is required.')
    if (!invIdAvail) return setError('That Invoice ID is already taken.')
    const chosen = invoicingLines.filter(l => Number(invoiceQtyPicked[l.line_uid]) > 0)
    if (chosen.length === 0) return setError('Pick at least one line with a quantity greater than zero.')
    for (const l of chosen) {
      if (Number(invoiceQtyPicked[l.line_uid]) > l.remaining + 0.0001) return setError(`${l.description}: can't invoice more than the ${l.remaining} remaining.`)
    }

    setSaving(true); setError('')
    try {
      const po = selected.po_number
      const { error: e1 } = await supabase.from('invoices').insert({
        id: newInvForm.id.trim(), po_number: po, quotation_id: chosen[0]?.quotation_id || null,
        client: selected.client, company_name: selected.client, address: '',
        date: newInvForm.date, payment_terms: newInvForm.payment_terms, status: 'Pending',
        dr_number: newInvForm.dr_number.trim() || null,
      })
      if (e1) { if ((e1 as any).code==='23505') throw new Error(`Invoice ID "${newInvForm.id}" already exists.`); throw e1 }

      const invItemsPayload = chosen.map((l,idx) => ({
        invoice_id: newInvForm.id.trim(), kind:'item', description: l.description,
        source_line_uid: l.line_uid, qty: Number(invoiceQtyPicked[l.line_uid]), unit: l.unit, price: l.price, position: idx,
      }))
      const { error: e2 } = await supabase.from('invoice_items').insert(invItemsPayload)
      if (e2) throw e2

      // The 'Invoiced' timeline entry is written by the database when the invoice is created.

      await fetch(); await fetchDocs(); await fetchPoInvoicedTotal(po); await fetchTimeline(po)
      setShowInvoiceFlow(false)
    } catch (err:any) { setError(err.message) }
    setSaving(false)
  }

  // Project name fallback: first real item line of the selected quotations (headings/materials/images
  // are skipped), plus "(+ n other items)" for the remaining item lines. A typed name always wins.
  const autoProjectName = (quotes: any[]) => {
    const lines = quotes.flatMap(q => (q.quotation_items || []).slice().sort((a: any, b: any) => (a.position || 0) - (b.position || 0)).filter((i: any) => i.kind === 'item' && (i.description || '').trim()))
    if (lines.length === 0) return ''
    let base = String(lines[0].description).replace(/\s+/g, ' ').trim()
    if (base.length > 80) base = base.slice(0, 77).trimEnd() + '…'
    const n = lines.length - 1
    return n > 0 ? `${base} (+ ${n} other item${n === 1 ? '' : 's'})` : base
  }
  const autoNameForSelection = autoProjectName(availableQuotations.filter(q => selectedQuoIds.includes(q.id)))
  const effectiveProjectName = poForm.project_name.trim() || autoNameForSelection

  const createProjectFromPO = async () => {
    setPoFormAttempted(true)
    const po = poForm.po_number.trim()
    if (!po) return setError('PO Number is required.')
    if (poNumberTaken) return setError(`PO Number "${po}" is already linked to a project.`)
    if (selectedQuoIds.length === 0) return setError('Select at least one approved quotation to attach.')
    if (!effectiveProjectName) return setError('Project Name is required — type one, or attach a quotation that has item descriptions.')

    setSaving(true); setError('')
    try {
      const selectedQuotes = availableQuotations.filter(q => selectedQuoIds.includes(q.id))
      const totalValue = selectedQuotes.reduce((s,q) => s + quotationTotal(q), 0)
      const client = poForm.client.trim() || selectedQuotes[0]?.company_name || selectedQuotes[0]?.client || ''
      // PO number now doubles as the project's own ID — it's already
      // guaranteed unique, so there's no need for a separately generated one.
      const projectId = po

      const { error: e1 } = await supabase.from('projects').insert({
        ...BLANK, id: projectId, name: effectiveProjectName, client,
        end_date: nz(BLANK.end_date), delivery_date_needed: nz(BLANK.delivery_date_needed),
        actual_delivery_date: nz(BLANK.actual_delivery_date), collection_date: nz(BLANK.collection_date),
        date_collected: nz(BLANK.date_collected),
        po_number: po, value: totalValue, po_total_value: totalValue,
        invoice_id: null, // BLANK's '' default fails the FK constraint — must be null or a real invoice id
        quotation_id: selectedQuotes[0]?.id || null, // legacy single-ref field, best-effort for older display paths
      })
      if (e1) throw e1

      await supabase.from('quotations').update({ po_number: po }).in('id', selectedQuoIds)

      // One Job Order Number per quotation, assigned the moment it's linked
      // to a project — atomic system-wide daily sequence, safe under concurrency.
      for (const q of selectedQuotes) {
        if (!q.job_order_number) {
          const { data: jo } = await supabase.rpc('get_next_job_order_number')
          if (jo) await supabase.from('quotations').update({ job_order_number: jo }).eq('id', q.id)
        }
      }

      // BOM material quantities scale by (PO qty / Quoted qty) per item —
      // a quoted qty of 1 needing 1 sheet becomes 10 sheets if the client's
      // actual PO asks for 10. Blank PO qty just falls back to quoted qty
      // (multiplier of 1, no change). Still fully editable afterward.
      const bomInserts:any[] = []
      const itemQtyInserts:any[] = []
      for (const q of selectedQuotes) {
        for (const { item, materials } of itemLinesWithMaterials(q)) {
          const quotedQty = Number(item.qty) || 1
          const poQtyRaw = poQtyOverrides[item.line_uid]
          const poQty = poQtyRaw && poQtyRaw.trim() !== '' ? Number(poQtyRaw) : quotedQty
          const multiplier = quotedQty > 0 ? poQty / quotedQty : 1

          itemQtyInserts.push({
            po_number: po, quotation_id: q.id, item_line_uid: item.line_uid,
            description: item.description, quoted_qty: quotedQty, po_qty: poQty,
          })
          materials.forEach(m => {
            bomInserts.push({
              po_number: po, source_quotation_id: q.id, source_line_uid: m.line_uid || null,
              description: m.description || '', dimension: m.dimension || '',
              qty_needed: (Number(m.qty)||0) * multiplier, unit: m.unit || '', estimated_unit_cost: Number(m.price)||0,
            })
          })
        }
      }
      if (bomInserts.length > 0) await supabase.from('project_bom').insert(bomInserts)
      if (itemQtyInserts.length > 0) await supabase.from('project_item_quantities').upsert(itemQtyInserts, { onConflict: 'po_number,item_line_uid' })

      await logTimelineEvent(po, 'PO Received', `Project created — ${selectedQuoIds.length} quotation(s) linked: ${selectedQuoIds.join(', ')}`)

      await fetch(); await fetchDocs()
      setShowNewPOFlow(false)
    } catch (err:any) { setError(err.message) }
    setSaving(false)
  }

  const updateBomRow = async (id:string, field:string, value:any) => {
    setBomRows(p => p.map(r => r.id===id ? {...r, [field]:value} : r))
    await supabase.from('project_bom').update({[field]:value}).eq('id', id)
  }

  // ── BOM Fulfillment — the Projects/Inventory/Expenses connective tissue ──
  const [inventoryItems,setInventoryItems]=useState<any[]>([])
  const fetchInventory = useCallback(async()=>{
    const {data} = await supabase.from('inventory').select('*').order('name')
    setInventoryItems(data||[])
  },[supabase])
  const [fulfillingRow,setFulfillingRow]=useState<any>(null)
  const [fulfillMode,setFulfillMode]=useState<'stock'|'purchase'>('stock')
  const [fulfillForm,setFulfillForm]=useState({material_id:'', qty:0, unit_cost:0, supplier:'', payment_method:'Cash', requested_by:''})
  const [fulfillError,setFulfillError]=useState('')
  const [fulfillSaving,setFulfillSaving]=useState(false)

  const openFulfill = async (row:any) => {
    await fetchInventory()
    const remaining = Number(row.qty_needed) - Number(row.qty_purchased||0)
    // Best-effort auto-match by name — clerk can always override
    const guess = inventoryItems.find(i => i.name.toLowerCase().trim() === row.description.toLowerCase().trim())
    setFulfillForm({ material_id: guess?.id || '', qty: remaining, unit_cost: guess?.unit_cost || row.estimated_unit_cost || 0, supplier: '', payment_method: 'Cash', requested_by: '' })
    setFulfillMode('stock'); setFulfillError('')
    setFulfillingRow(row)
  }

  const submitFulfillment = async () => {
    if (!fulfillingRow) return
    const mat = inventoryItems.find(i => i.id === fulfillForm.material_id)
    const qty = Number(fulfillForm.qty)
    if (!qty || qty <= 0) return setFulfillError('Enter a valid quantity.')
    const po = fulfillingRow.po_number

    setFulfillSaving(true); setFulfillError('')
    try {
      if (fulfillMode === 'stock') {
        if (!mat) return setFulfillError('Select which registered material this fulfills.')
        if (qty > Number(mat.quantity)) throw new Error(`Only ${mat.quantity} ${mat.unit} available in stock. Send to Purchasing instead, or reduce the quantity.`)
        // Draw from existing stock: a Release against the project, plus an
        // Internal Transfer expense so project costing reflects the true
        // material cost even though no new cash left the business today.
        await supabase.from('material_releases').insert({
          material_id: mat.id, material_name: mat.name, qty, unit: mat.unit,
          requestor: `Project ${po} (BOM fulfillment)`, po_number: po, bom_id: fulfillingRow.id,
          date: new Date().toISOString().slice(0,10), notes: `BOM: ${fulfillingRow.description}`,
        })
        const { data: exp } = await supabase.from('expenses').insert({
          date: new Date().toISOString().slice(0,10), category: 'Materials/BOM',
          description: `${mat.name} — ${qty} ${mat.unit} for PO ${po} (from existing stock)`,
          amount: qty * Number(mat.unit_cost), payment_method: 'Internal Transfer', status: 'Paid',
        }).select().single()

        const newQtyPurchased = Number(fulfillingRow.qty_purchased||0) + qty
        const newStatus = newQtyPurchased >= Number(fulfillingRow.qty_needed) ? 'Purchased' : 'Partial'
        await supabase.from('project_bom').update({
          qty_purchased: newQtyPurchased, status: newStatus, expense_id: exp?.id||null, inventory_id: mat.id,
        }).eq('id', fulfillingRow.id)
        // 'Material Released' timeline entry is written by the database from the release row above.
      } else {
        // Not in stock: this no longer buys anything directly — it hands off
        // to the Purchasing module, where an officer compares supplier quotes
        // before anything gets bought. The BOM line just reflects that a
        // request is now in flight, not that it's fulfilled yet.
        const { error: reqErr } = await supabase.from('material_requests').insert({
          po_number: po, bom_id: fulfillingRow.id, quotation_id: fulfillingRow.source_quotation_id || null,
          material_name: fulfillingRow.description, dimension: fulfillingRow.dimension,
          qty_needed: qty, unit: fulfillingRow.unit,
          requested_by: fulfillForm.requested_by || null,
        })
        if (reqErr) throw reqErr
        // The pre-sale request(s) made while quoting this same quotation have
        // now served their purpose — archive (not delete) them so Purchasing's
        // active list isn't cluttered with stale pre-sale requests, while
        // keeping their supplier_quotes price history intact for future cost
        // comparisons.
        if (fulfillingRow.source_quotation_id) {
          await supabase.from('material_requests').update({ archived: true })
            .eq('quotation_id', fulfillingRow.source_quotation_id).is('po_number', null)
        }
        await supabase.from('project_bom').update({ status: 'Requested' }).eq('id', fulfillingRow.id)
        // 'Material Requested' timeline entry is written by the database from the request row above.
      }

      await fetchBom(po); await fetchTimeline(po)
      setFulfillingRow(null)
    } catch (err:any) { setFulfillError(err.message) }
    setFulfillSaving(false)
  }

  const addManualBomRow = async (po:string) => {
    const { data, error } = await supabase.from('project_bom').insert({
      po_number: po, source_quotation_id: null, description: '', dimension: '',
      qty_needed: 0, unit: '', estimated_unit_cost: 0,
    }).select().single()
    if (!error && data) setBomRows(p => [...p, data])
  }
  const removeBomRow = async (id:string) => {
    if (!window.confirm('Remove this material line from the BOM?')) return
    await supabase.from('project_bom').delete().eq('id', id)
    setBomRows(p => p.filter(r => r.id !== id))
  }
  const addManualTimelineEntry = async (po:string, event_type:string, event_date:string, notes:string) => {
    if (!event_type.trim()) return
    const { data, error } = await supabase.from('project_timeline').insert({
      po_number: po, event_type: event_type.trim(), event_date: event_date || new Date().toISOString().slice(0,10), notes: notes || null,
    }).select().single()
    if (!error && data) setTimelineRows(p => [data, ...p])
  }

  const addQuotationsToPO = async () => {
    if (!selected?.po_number || selectedQuoIds.length === 0) return
    setSaving(true); setError('')
    try {
      const po = selected.po_number
      const selectedQuotes = availableQuotations.filter(q => selectedQuoIds.includes(q.id))
      const addedValue = selectedQuotes.reduce((s,q) => s + quotationTotal(q), 0)

      await supabase.from('quotations').update({ po_number: po }).in('id', selectedQuoIds)

      // One Job Order Number per quotation, assigned the moment it's linked
      // to a project — atomic system-wide daily sequence, safe under concurrency.
      for (const q of selectedQuotes) {
        if (!q.job_order_number) {
          const { data: jo } = await supabase.rpc('get_next_job_order_number')
          if (jo) await supabase.from('quotations').update({ job_order_number: jo }).eq('id', q.id)
        }
      }

      const bomInserts:any[] = []
      const itemQtyInserts:any[] = []
      for (const q of selectedQuotes) {
        for (const { item, materials } of itemLinesWithMaterials(q)) {
          const quotedQty = Number(item.qty) || 1
          const poQtyRaw = poQtyOverrides[item.line_uid]
          const poQty = poQtyRaw && poQtyRaw.trim() !== '' ? Number(poQtyRaw) : quotedQty
          const multiplier = quotedQty > 0 ? poQty / quotedQty : 1

          itemQtyInserts.push({
            po_number: po, quotation_id: q.id, item_line_uid: item.line_uid,
            description: item.description, quoted_qty: quotedQty, po_qty: poQty,
          })
          materials.forEach(m => {
            bomInserts.push({
              po_number: po, source_quotation_id: q.id, source_line_uid: m.line_uid || null,
              description: m.description || '', dimension: m.dimension || '',
              qty_needed: (Number(m.qty)||0) * multiplier, unit: m.unit || '', estimated_unit_cost: Number(m.price)||0,
            })
          })
        }
      }
      if (bomInserts.length > 0) await supabase.from('project_bom').insert(bomInserts)
      if (itemQtyInserts.length > 0) await supabase.from('project_item_quantities').upsert(itemQtyInserts, { onConflict: 'po_number,item_line_uid' })

      const newTotal = Number(selected.po_total_value||0) + addedValue
      const patch:any = { po_total_value: newTotal }
      if (!selected.invoice_id) patch.value = newTotal // don't override a value already synced from an invoice
      await supabase.from('projects').update(patch).eq('po_number', po)

      await logTimelineEvent(po, 'Quotation Added', `Added ${selectedQuoIds.length} quotation(s): ${selectedQuoIds.join(', ')}`)

      await fetch(); await fetchDocs(); await fetchBom(po); await fetchTimeline(po)
      setShowAddQuoToProject(false); setSelectedQuoIds([])
    } catch (err:any) { setError(err.message) }
    setSaving(false)
  }

  const save = async () => {
    if (!form.name || form.name.trim() === "") { setError("Project Name is required."); return }
    if (!form.id || form.id.trim() === "") { setError("Project ID is required."); return }
    if (!selected && !idAvailable) { setError(`Project ID "${form.id}" is already taken.`); return }

    setSaving(true); setError('')
    const nz = (v:any) => (v === '' || v === undefined) ? null : v

    const payload:any = {
      ...form,
      progress: Number(form.progress) || 0,
      progress_manual: !!form.progress_manual,
      name: form.name.trim(),
      id: form.id.trim(),
      po_number: nz(form.po_number),
      quotation_id: nz(form.quotation_id),
      invoice_id: nz(form.invoice_id),
      dr_number: nz(form.dr_number),
      delivery_date_needed: nz(form.delivery_date_needed),
      actual_delivery_date: nz(form.actual_delivery_date),
      payment_terms_days: Number(form.payment_terms_days) || 30,
      cr_number: nz(form.cr_number),
      collection_date: nz(form.collection_date),
      collection_amount: Number(form.collection_amount) || 0,
      date_collected: nz(form.date_collected),
      end_date: nz(form.end_date),
      status: form.date_collected ? 'Completed' : form.status,
      payment_status: getPaymentStatus(form),
    }

    // IMPORTANT: once an invoice is linked, its total OWNS the Contract Value —
    // the trg_sync_project_from_invoice / trg_sync_project_from_invoice_items DB
    // triggers keep it correct automatically. If we also send `value` here from
    // the (possibly stale) form field, we'd overwrite that synced number with
    // whatever was on screen when the modal opened. So we simply omit it.
    if (!payload.invoice_id) {
      payload.value = Number(form.value) || 0
    } else {
      delete payload.value
    }

    try {
      const { error } = selected
        ? await supabase.from('projects').update(payload).eq('id', selected.id).select()
        : await supabase.from('projects').insert(payload).select()

      if (error) {
        if (error.code === '23505') throw new Error(`Project ID "${payload.id}" already exists. Please choose a different ID.`)
        throw error
      }
      await fetch()
      setShowModal(false)
    } catch(err:any){ setError(err.message) } finally { setSaving(false) }
  }

  const remove = async () => {
    if(!selected || !window.confirm("Delete project?")) return
    setSaving(true)
    const {error}=await supabase.from('projects').delete().eq('id',selected.id)
    if(!error){ await fetch(); setShowModal(false) } else setError(error.message)
    setSaving(false)
  }

  // Most-recent-first by the project's own business date (when the PO/project
  // actually started), falling back to created_at — a bulk historical import
  // lands every row's created_at within the same minute, so sorting on that
  // alone would leave decades of real history in near-random order.
  const byRecency = (a:any,b:any) => {
    const ad = a.start_date || a.created_at || ''
    const bd = b.start_date || b.created_at || ''
    return bd.localeCompare(ad)
  }

  const clientOptions = Array.from(new Set(projects.map(p=>p.client).filter(Boolean))).sort((a,b)=>a.localeCompare(b))

  const filtered=projects
    .filter(p=>filter==='All'||p.status===filter)
    .filter(p=>clientFilter==='All'||p.client===clientFilter)
    .slice()
    .sort(byRecency)

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const paged = filtered.slice((currentPage-1)*PAGE_SIZE, currentPage*PAGE_SIZE)

  useEffect(()=>{ setPage(1) },[filter, clientFilter])
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[page])

  const counts = {
    Active: projects.filter(p => p.status === 'Active').length,
    'On Hold': projects.filter(p => p.status === 'On Hold').length,
    Completed: projects.filter(p => p.status === 'Completed').length,
    Cancelled: projects.filter(p => p.status === 'Cancelled').length
  }

  // Events driving the modal's live status bar: this project's own freshly
  // loaded timeline while it's open (reflects entries the moment they land),
  // otherwise whatever the list already knows for that PO.
  const modalEvents: Set<string> = (selected && form.po_number && form.po_number === selected.po_number && timelineRows.length > 0)
    ? new Set<string>(timelineRows.map((t:any)=>t.event_type))
    : eventsFor(form.po_number)

  // One row per item line of each project's linked quotations; projects with no
  // quotation items fall back to a single row so nothing disappears from the list.
  const monitorRows = filtered.flatMap((p:any)=>{
    const quos = p.po_number ? monitorQuos.filter(q=>q.po_number===p.po_number) : []
    const lines = quos.flatMap(q=>(q.quotation_items||[]).slice().sort((a:any,b:any)=>(a.position||0)-(b.position||0))
      .filter((i:any)=>i.kind==='item').map((i:any)=>({ ...i, vat_mode:q.vat_mode })))
    const base = lines.length>0 ? lines : [{ description:p.name, qty:1, unit:'', price:Number(p.po_number?p.po_total_value:p.value)||0, vat_mode:'excluded' }]
    const invs = p.po_number ? monitorInvs.filter(i=>i.po_number===p.po_number).map(i=>i.id).join(', ') : (p.invoice_id||'')
    return base.map((l:any,idx:number)=>{
      const total=(Number(l.qty)||0)*(Number(l.price)||0)
      const withVat = l.vat_mode==='included'||l.vat_mode==='exempt' ? total : total*1.12
      return { p, first: idx===0, span: base.length, desc:l.description||'', qty:l.qty, unit:l.unit||'', price:Number(l.price)||0, total, withVat, invs }
    })
  })
  const saveProjectPatch = async (p:any, patch:any)=>{
    const merged={...p,...patch}
    const payload:any={...patch, status: merged.date_collected ? 'Completed' : p.status, payment_status: getPaymentStatus(merged)}
    const { error } = await supabase.from('projects').update(payload).eq('id',p.id)
    if (error) alert(error.message); else await fetch()
  }
  const exportMonitor = async ()=>{
    const XLSX = await import('xlsx')
    const header=['PROJECT BY','PO#','DESCRIPTION','QTY','UNIT','DATE RECEIVED','DELIVERY DATE NEEDED','AMOUNT','TOTAL','WITH 12% VAT','STATUS','ACTUAL DELIVERY DATE','DR #','INVOICE #','TERMS','COLLECTION DATE','CR #','COLLECTION AMOUNT','DATE COLLECTED']
    const rows=monitorRows.map((r:any)=>{ const p=r.p; return [p.client,p.po_number||'',r.desc,r.qty,r.unit,p.start_date||'',p.delivery_date_needed||'',r.price,r.total,r.withVat,p.date_collected?'COLLECTED':p.actual_delivery_date?'DELIVERED':p.status,p.actual_delivery_date||'',p.dr_number||'',r.invs,p.payment_terms_days||'',p.collection_date||getDueDate(p)||'',p.cr_number||'',r.first?Number(p.collection_amount)||0:'',p.date_collected||''] })
    const ws=XLSX.utils.aoa_to_sheet([header,...rows])
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'P.O. MONITORING')
    XLSX.writeFile(wb,`PO-MONITORING-${new Date().toISOString().slice(0,10)}.xlsx`)
  }
  const mth:React.CSSProperties={padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:0.8,textTransform:'uppercase',whiteSpace:'nowrap'}
  const mtd:React.CSSProperties={padding:'7px 10px',fontSize:11,whiteSpace:'nowrap',borderRight:`1px solid ${C.lightGray}`}
  const cellIn:React.CSSProperties={padding:'4px 6px',border:`1px solid ${C.lightGray}`,borderRadius:5,fontSize:11,width:110,boxSizing:'border-box'}
  const monitorUI = (
    <div style={{background:C.white,borderRadius:12,boxShadow:'0 2px 16px rgba(0,0,0,0.07)',overflow:'hidden'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 16px'}}>
        <span style={{fontSize:11,color:C.gray,fontWeight:700}}>{monitorLoading?'Loading…':`${monitorRows.length} line${monitorRows.length===1?'':'s'} across ${filtered.length} project${filtered.length===1?'':'s'} — delivery, DR#, CR# and collection cells apply to the whole PO and also update the project card`}</span>
        <button onClick={exportMonitor} disabled={monitorRows.length===0} style={{padding:'8px 16px',fontSize:11,fontWeight:800,background:`${C.accent}18`,border:`1px solid ${C.accent}55`,color:C.accent,borderRadius:6,cursor:'pointer'}}>⬇ Export to Excel</button>
      </div>
      <div style={{overflowX:'auto'}}>
        <table style={{borderCollapse:'collapse',minWidth:1900,width:'100%'}}>
          <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
            {['Project By','PO#','Description','Qty','Unit','Date Received','Delivery Needed','Amount','Total','With 12% VAT','Status','Actual Delivery','DR #','Invoice #','Terms','Collection Date','CR #','Collection Amt','Date Collected'].map(h=><th key={h} style={{...mth,textAlign:['Amount','Total','With 12% VAT','Collection Amt'].includes(h)?'right':'left'}}>{h}</th>)}
          </tr></thead>
          <tbody>
            {monitorRows.map((r:any,i:number)=>{
              const p=r.p
              const status=p.date_collected?'COLLECTED':p.actual_delivery_date?'DELIVERED':p.status
              const sc=p.date_collected?C.blue:p.actual_delivery_date?C.accent:C.amber
              const m=(node:React.ReactNode)=> r.first ? <td rowSpan={r.span} style={{...mtd,verticalAlign:'top',background:C.white}}>{node}</td> : null
              return (
                <tr key={`${p.id}-${i}`} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`,borderTop:r.first?`2px solid ${C.lightGray}`:undefined}}>
                  <td style={{...mtd,fontWeight:700}}>{r.first?p.client:''}</td>
                  <td style={{...mtd,fontWeight:800,color:C.darkGreen}}>{r.first?(p.po_number||'—'):''}</td>
                  <td style={{...mtd,whiteSpace:'normal',minWidth:240,fontWeight:600}}>{r.desc}</td>
                  <td style={mtd}>{r.qty}</td><td style={mtd}>{r.unit}</td>
                  <td style={mtd}>{r.first?(p.start_date||''):''}</td><td style={mtd}>{r.first?(p.delivery_date_needed||''):''}</td>
                  <td style={{...mtd,textAlign:'right'}}>{fmt(r.price)}</td>
                  <td style={{...mtd,textAlign:'right',fontWeight:700}}>{fmt(r.total)}</td>
                  <td style={{...mtd,textAlign:'right'}}>{fmt(r.withVat)}</td>
                  <td style={mtd}>{r.first && <span style={{padding:'2px 9px',borderRadius:20,background:`${sc}22`,color:sc,fontSize:10,fontWeight:800}}>{status}</span>}</td>
                  {m(<input type="date" disabled={!canEdit} defaultValue={p.actual_delivery_date||''} onBlur={e=>{ if((e.target.value||'')!==(p.actual_delivery_date||'')) saveProjectPatch(p,{actual_delivery_date:e.target.value||null}) }} style={cellIn}/>)}
                  {m(<input disabled={!canEdit} defaultValue={p.dr_number||''} onBlur={e=>{ const v=e.target.value.trim().toUpperCase(); if(v!==(p.dr_number||'')) saveProjectPatch(p,{dr_number:v||null}) }} style={{...cellIn,width:80}}/>)}
                  <td style={mtd}>{r.first?r.invs:''}</td>
                  <td style={mtd}>{r.first?(p.payment_terms_days||''):''}</td>
                  <td style={mtd}>{r.first?(p.collection_date||getDueDate(p)||''):''}</td>
                  {m(<input disabled={!canEdit} defaultValue={p.cr_number||''} onBlur={e=>{ const v=e.target.value.trim().toUpperCase(); if(v!==(p.cr_number||'')) saveProjectPatch(p,{cr_number:v||null}) }} style={{...cellIn,width:80}}/>)}
                  {m(<input type="number" disabled={!canEdit} defaultValue={Number(p.collection_amount)||0} onBlur={e=>{ const v=Number(e.target.value)||0; if(v!==(Number(p.collection_amount)||0)) saveProjectPatch(p,{collection_amount:v}) }} style={{...cellIn,width:100,textAlign:'right'}}/>)}
                  {m(<input type="date" disabled={!canEdit} defaultValue={p.date_collected||''} onBlur={e=>{ if((e.target.value||'')!==(p.date_collected||'')) saveProjectPatch(p,{date_collected:e.target.value||null}) }} style={cellIn}/>)}
                </tr>
              )
            })}
            {monitorRows.length===0 && !monitorLoading && <tr><td colSpan={19} style={{padding:30,textAlign:'center',color:C.gray}}>No projects match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )

  const availableInvoices = form.quotation_id
    ? invoices.filter(i => i.quotation_id === form.quotation_id)
    : invoices

  return(
    <div style={{ paddingBottom: 40 }}>
      {/* KPI STATUS CARDS */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:22}}>
        {([['Active',C.accent],['On Hold',C.amber],['Completed',C.blue],['Cancelled',C.red]] as [string,string][]).map(([s,c])=>(
          <div key={s} style={{background:C.white,borderRadius:12,padding:'18px 22px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',borderTop:`4px solid ${c}`}}>
            <div style={{fontSize:28,fontWeight:900,color:C.dark}}>{counts[s as keyof typeof counts] || 0}</div>
            <div style={{fontSize:10,fontWeight:700,color:C.gray,letterSpacing:1.5,textTransform:'uppercase',marginTop:2}}>{s}</div>
          </div>
        ))}
      </div>

      {/* ACTION BAR */}
      <div style={{display:'flex',gap:8,marginBottom:22,justifyContent:'space-between',alignItems:'center'}}>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          {['All','Active','On Hold','Completed'].map(s=>(
            <button key={s} onClick={()=>setFilter(s)} style={{padding:'7px 16px',borderRadius:20,border:`1.5px solid ${filter===s?C.accent:C.lightGray}`,background:filter===s?C.accent:C.white,color:filter===s?C.white:C.gray,fontSize:11,fontWeight:700,cursor:'pointer'}}>{s}</button>
          ))}
          <select value={clientFilter} onChange={e=>setClientFilter(e.target.value)} style={{padding:'7px 12px',borderRadius:20,border:`1.5px solid ${C.lightGray}`,background:C.white,color:C.dark,fontSize:11,fontWeight:700,cursor:'pointer',marginLeft:4}}>
            <option value="All">All Clients</option>
            {clientOptions.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{display:'flex',gap:4,background:'#eef3ef',borderRadius:20,padding:3}}>
          {([['cards','▦ Cards'],['monitor','☰ Monitoring']] as const).map(([k,l])=>(
            <button key={k} onClick={()=>setViewMode(k)} style={{padding:'6px 14px',borderRadius:18,border:'none',background:viewMode===k?C.white:'transparent',boxShadow:viewMode===k?'0 1px 4px rgba(0,0,0,0.12)':'none',color:viewMode===k?C.dark:C.gray,fontSize:11,fontWeight:800,cursor:'pointer'}}>{l}</button>
          ))}
        </div>
        {canEdit && <div style={{display:'flex',gap:8}}>
          <button onClick={openNewPOFlow} style={{padding:'10px 22px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:8,color:C.white,fontSize:12,fontWeight:800,textTransform:'uppercase',cursor:'pointer',boxShadow:`0 4px 12px ${C.accent}44`}}>+ New Project from PO</button>
          <button onClick={openNew} style={{padding:'10px 18px',background:'transparent',border:`1.5px solid ${C.gray}`,borderRadius:8,color:C.gray,fontSize:11,fontWeight:700,cursor:'pointer'}}>Manual (no PO)</button>
        </div>}
      </div>

      {/* RESULT COUNT */}
      {!loading && viewMode==='cards' && (
        <div style={{ fontSize: 11, color: C.gray, fontWeight: 700, marginBottom: 12 }}>
          {filtered.length === 0 ? 'No projects match.' : `Showing ${(currentPage-1)*PAGE_SIZE+1}–${Math.min(currentPage*PAGE_SIZE, filtered.length)} of ${filtered.length}`}
        </div>
      )}

      {/* PROJECT TILE GRID */}
      {viewMode==='monitor' ? monitorUI : loading ? <div style={{textAlign:'center',padding:40, color: C.gray}}>Syncing GEMMN Cloud...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 20 }}>
          {paged.map((p:any) => {
            const prog = computeProgress(p, quotations, eventsFor(p.po_number))
            const stage = getStageLabel(p, quotations, eventsFor(p.po_number))
            const payStatus = getPaymentStatus(p)
            const due = getDueDate(p)
            return (
            <div key={p.id} onClick={()=>openEdit(p)} style={{ background: C.white, borderRadius: 15, overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.08)', cursor: 'pointer', transition: 'transform 0.2s' }}>
              <div style={{ background: `linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`, padding: '15px 20px', color: 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.accent, letterSpacing: 1 }}>{p.id}</span>
                  <Badge label={p.status}/>
                </div>
                <div style={{ fontWeight: 900, fontSize: 16, textTransform: 'uppercase' }}>{p.name}</div>
              </div>

              <div style={{ padding: '20px' }}>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 9, color: C.gray, fontWeight: 800, textTransform: 'uppercase' }}>Client</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{p.client}</div>
                </div>

                {/* Linked Documents */}
                <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom: 14 }}>
                  <DocChip label="PO" value={p.po_number} color={C.gray}/>
                  <DocChip label="QUO" value={p.quotation_id} color={C.purple}/>
                  <DocChip label="INV" value={p.invoice_id} color={C.blue}/>
                  <DocChip label="DR" value={p.dr_number} color={C.amber}/>
                  <DocChip label="CR" value={p.cr_number} color={C.accent}/>
                </div>

                <div style={{ background: '#f8faf9', padding: '12px', borderRadius: 10, marginBottom: 15 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom: 5 }}>
                    <div style={{ fontSize: 9, color: C.gray, fontWeight: 800, textTransform: 'uppercase' }}>{p.po_number ? 'PO Total' : 'Contract Value'}</div>
                    {p.invoice_id && <div style={{ fontSize: 8, color: C.blue, fontWeight: 800 }}>SYNCED FROM {p.invoice_id}</div>}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: C.darkGreen }}>{fmt(p.po_number ? (p.po_total_value||0) : p.value)}</div>
                  {p.po_number && (
                    <div style={{ fontSize: 10, color: C.gray, marginTop: 3 }}>Invoiced: <b style={{ color: C.accent }}>{fmt(invoicedTotalForPO(p.po_number))}</b></div>
                  )}
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: C.gray }}>{stage}</span>
                    <span style={{ fontSize: 11, fontWeight: 900, color: C.accent }}>{prog}%</span>
                  </div>
                  <div style={{ background: C.lightGray, height: 8, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${prog}%`, height: '100%', background: C.accent, borderRadius: 4, transition:'width 0.3s' }}/>
                  </div>
                </div>

                {p.actual_delivery_date && (
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', paddingTop: 10, borderTop: `1px solid ${C.lightGray}` }}>
                    <div>
                      <div style={{ fontSize: 9, color: C.gray, fontWeight: 800, textTransform: 'uppercase' }}>Payment Due</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.dark }}>{due || '—'}</div>
                    </div>
                    <Badge label={payStatus}/>
                  </div>
                )}
              </div>
            </div>
          )})}
        </div>
      )}

      {/* PAGINATION */}
      {!loading && viewMode==='cards' && pageCount > 1 && (
        <div style={{ display:'flex', justifyContent:'center', alignItems:'center', gap:10, marginTop:26 }}>
          <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={currentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:currentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:currentPage===1?'default':'pointer'}}>← Prev</button>
          <span style={{ fontSize:11, fontWeight:700, color:C.gray }}>Page {currentPage} of {pageCount}</span>
          <button onClick={()=>setPage(p=>Math.min(pageCount,p+1))} disabled={currentPage===pageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:currentPage===pageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:currentPage===pageCount?'default':'pointer'}}>Next →</button>
        </div>
      )}

      {/* MODAL */}
      {showModal && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
          <div style={{background:'white',borderRadius:16,width:'100%',maxWidth:820,maxHeight:'92vh',overflowY:'auto',boxShadow:'0 25px 50px -12px rgba(0,0,0,0.5)'}}>
            <div style={{background:`linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`,color:'white',padding:'18px 24px',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontWeight:900,textTransform:'uppercase',letterSpacing:1}}>{selected ? 'Update Project' : 'Initiate New Project'}</span>
              <button onClick={()=>setShowModal(false)} style={{background:'none',border:'none',color:'white',cursor:'pointer',fontSize:18}}>✕</button>
            </div>
            <div style={{padding:24}}>

              {/* Live stage preview */}
              <div style={{ background:'#f8faf9', borderRadius:10, padding:'12px 16px', marginBottom:18 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                  <span style={{ fontSize:11, fontWeight:800, color:C.dark }}>{getStageLabel(form, quotations, modalEvents)}</span>
                  <span style={{ fontSize:12, fontWeight:900, color:C.accent }}>{computeProgress(form, quotations, modalEvents)}%</span>
                </div>
                <div style={{ background: C.lightGray, height: 7, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${computeProgress(form, quotations, modalEvents)}%`, height: '100%', background: C.accent, borderRadius: 4 }}/>
                </div>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
                <div>
                  <Field label="System ID" value={form.id} onChange={(v:string)=>{ f('id')(v); checkId(v) }} disabled={!!selected} skipDefault/>
                  {!selected && form.id && (
                    <div style={{fontSize:11,marginTop:-10,marginBottom:12,fontWeight:700,color: checkingId ? C.gray : (idAvailable ? C.accent : C.red)}}>
                      {checkingId ? 'Checking availability…' : (idAvailable ? '✓ ID available' : '⚠ This ID is already taken')}
                    </div>
                  )}
                </div>
                <Field label="Status" type="select" value={form.status} onChange={f('status')} options={['Active','On Hold','Completed','Cancelled']} />
                <Field label="Project Name" value={form.name} onChange={f('name')} span skipDefault/>
                <Field label="Client" value={form.client} onChange={f('client')} />
                <Field label="Manager" type="select" value={form.manager} onChange={f('manager')} options={MANAGERS} />
                <Field
                  label="Contract Value"
                  type="number"
                  value={form.value}
                  onChange={f('value')}
                  prefix="₱"
                  disabled={!!form.invoice_id}
                  hint={form.invoice_id ? `Synced automatically from Invoice ${form.invoice_id} — edit the invoice to change this.` : undefined}
                />
                <Field label="PO Number" value={form.po_number} onChange={f('po_number')} placeholder="5500002423" skipDefault/>
                <Field label="Start Date" type="date" value={form.start_date} onChange={f('start_date')} />
                <Field label="End Date" type="date" value={form.end_date} onChange={f('end_date')} />
              </div>

              {!form.po_number && (
              <>
              {/* LINKED DOCUMENTS — legacy single-reference fields, manual (no-PO) projects only */}
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'8px 0 10px' }}>Linked Documents</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
                <Field label="Quotation" type="select" value={form.quotation_id} onChange={f('quotation_id')}
                  options={quotations.map(q=>({value:q.id, label:`${q.id} — ${q.company_name || q.client} (${q.status})`}))} />
                <Field label="Invoice" type="select" value={form.invoice_id} onChange={f('invoice_id')}
                  options={availableInvoices.map(i=>({value:i.id, label:`${i.id} — ${i.company_name || i.client} (${i.status})`}))} />
                <Field label="DR Number (Delivery Receipt)" value={form.dr_number} onChange={f('dr_number')} skipDefault/>
                <Field label="CR Number (Collection Receipt)" value={form.cr_number} onChange={f('cr_number')}
                  hint="Also set this on the Invoice itself — that's what auto-marks the invoice Paid." skipDefault/>
              </div>

              <div style={{marginBottom:14}}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Status Bar</label>
                <div style={{display:'flex',gap:8,marginBottom: form.progress_manual ? 10 : 0}}>
                  {([[false,'Automatic'],[true,'Manual override']] as [boolean,string][]).map(([m,l])=>(
                    <button key={l} type="button" disabled={!canEdit} onClick={()=>f('progress_manual')(m)} style={{padding:'6px 14px',borderRadius:20,border:`1.5px solid ${!!form.progress_manual===m?C.accent:C.lightGray}`,background:!!form.progress_manual===m?C.accent:C.white,color:!!form.progress_manual===m?C.white:C.gray,fontSize:11,fontWeight:700,cursor:canEdit?'pointer':'default'}}>{l}</button>
                  ))}
                </div>
                {form.progress_manual
                  ? <>
                      <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Fabrication Progress ({form.progress}%)</label>
                      <input type="range" min={0} max={100} value={form.progress} onChange={e=>f('progress')(e.target.value)} style={{width:'100%'}} />
                    </>
                  : <div style={{fontSize:10,color:C.gray,marginTop:6}}>Moves on its own as quotations, purchasing, inventory releases and invoices are actioned for this PO.</div>}
              </div>

              {/* DELIVERY & PAYMENT — legacy, manual (no-PO) projects only */}
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'8px 0 10px' }}>Delivery & Payment</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
                <Field label="Delivery Date Needed" type="date" value={form.delivery_date_needed} onChange={f('delivery_date_needed')} />
                <Field label="Actual Delivery Date" type="date" value={form.actual_delivery_date} onChange={f('actual_delivery_date')} />
                <div style={{marginBottom:14}}>
                  <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Payment Terms (days)</label>
                  <div style={{display:'flex', gap:6, marginBottom:6}}>
                    {TERMS_PRESETS.map(d=>(
                      <button key={d} type="button" onClick={()=>f('payment_terms_days')(d)} style={{flex:1,padding:'6px 0',fontSize:11,fontWeight:800,borderRadius:6,cursor:'pointer',border:`1.5px solid ${Number(form.payment_terms_days)===d?C.accent:C.lightGray}`,background:Number(form.payment_terms_days)===d?C.accent:C.white,color:Number(form.payment_terms_days)===d?C.white:C.gray}}>{d}d</button>
                    ))}
                  </div>
                  <input type="number" value={form.payment_terms_days} onChange={e=>f('payment_terms_days')(e.target.value)} onFocus={e=>e.target.select()} placeholder="Custom # of days" style={{width:'100%',padding:'9px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:13,fontFamily:'inherit',boxSizing:'border-box'}}/>
                </div>
                <Field label="Collection Date" type="date" value={form.collection_date} onChange={f('collection_date')} />
                <Field label="Collection Amount" type="number" value={form.collection_amount} onChange={f('collection_amount')} prefix="₱" />
                <Field label="Date Collected (Payment Received)" type="date" value={form.date_collected} onChange={f('date_collected')} />
              </div>
              {form.actual_delivery_date && (
                <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:14 }}>
                  <span style={{fontSize:11,color:C.gray,fontWeight:700}}>Payment due: <b style={{color:C.dark}}>{getDueDate(form)}</b></span>
                  <Badge label={getPaymentStatus(form)}/>
                </div>
              )}
              </>
              )}

              {selected && form.po_number && (
                <>
                  {/* ── PROJECT BOM ── */}
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', margin:'18px 0 10px' }}>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase' }}>Bill of Materials (PO {form.po_number})</span>
                    {canEdit && <button type="button" onClick={()=>addManualBomRow(form.po_number)} style={{ fontSize: 10, fontWeight: 700, color: C.blue, background:'none', border:'none', cursor:'pointer' }}>+ Add material manually</button>}
                  </div>
                  {bomNeedsSync && (
                    <div style={{ background:`${C.amber}12`, border:`1px solid ${C.amber}44`, borderRadius:8, padding:'10px 14px', marginBottom:12, display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                      <span style={{ fontSize:11, color:C.amber }}>⚠ A newer version of one or more linked quotations is available — this BOM may be outdated.</span>
                      {canEdit && <button type="button" onClick={()=>syncBomWithLatestVersions(form.po_number)} style={{ padding:'6px 14px', fontSize:10, fontWeight:800, color:C.white, background:C.amber, border:'none', borderRadius:6, cursor:'pointer', whiteSpace:'nowrap' }}>🔄 Sync BOM Now</button>}
                    </div>
                  )}
                  {bomRows.length === 0
                    ? <div style={{ fontSize: 11, color: C.gray, marginBottom: 14, fontStyle:'italic' }}>No material lines yet.</div>
                    : (() => {
                      const groups: {key:string, quotation:any, rows:any[]}[] = []
                      bomRows.forEach(r => {
                        const key = r.source_quotation_id || '__manual__'
                        let g = groups.find(g=>g.key===key)
                        if (!g) { g = { key, quotation: currentPoQuotations.find(q=>q.id===r.source_quotation_id) || poQuotationsAll.find(q=>q.id===r.source_quotation_id) || null, rows: [] }; groups.push(g) }
                        g.rows.push(r)
                      })
                      return (
                        <div style={{ marginBottom: 14 }}>
                          {groups.map(g => (
                            <div key={g.key} style={{ marginBottom: 16 }}>
                              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingBottom:5, borderBottom:`1.5px solid ${C.lightGray}` }}>
                                {g.key==='__manual__' ? (
                                  <span style={{ fontSize:10, fontWeight:800, color:C.gray, textTransform:'uppercase' }}>Manually Added</span>
                                ) : (
                                  <>
                                    <span style={{ fontSize:10, fontWeight:800, color:C.darkGreen }}>{g.quotation?.id || g.key}</span>
                                    {g.quotation?.job_order_number && <span style={{ fontSize:9, fontWeight:700, color:C.blue, background:`${C.blue}12`, padding:'2px 8px', borderRadius:10 }}>JO# {g.quotation.job_order_number}</span>}
                                    {g.quotation?.version_number>1 && <span style={{ fontSize:9, fontWeight:700, color:C.purple }}>V{g.quotation.version_number}</span>}
                                  </>
                                )}
                              </div>
                              {g.rows.map(r => (
                          <div key={r.id} style={{ border:`1px solid ${r.status_note?C.amber:C.lightGray}`, borderRadius: 8, padding:'10px 12px', marginBottom:8 }}>
                            {r.status_note && <div style={{ fontSize:9, fontWeight:700, color:C.amber, marginBottom:6 }}>⚠ {r.status_note}</div>}
                            <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 0.6fr 0.7fr 0.8fr auto', gap:6, marginBottom:8 }}>
                              <div>
                                <label style={{fontSize:8,color:C.gray,fontWeight:700,textTransform:'uppercase'}}>Description</label>
                                <input defaultValue={r.description} onFocus={e=>e.target.select()} onBlur={e=>{ const v=e.target.value.trim()||'N/A'; e.target.value=v; updateBomRow(r.id,'description',v) }} style={{ width:'100%', padding:'6px 8px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11, boxSizing:'border-box' }}/>
                              </div>
                              <div>
                                <label style={{fontSize:8,color:C.gray,fontWeight:700,textTransform:'uppercase'}}>Dimension</label>
                                <input defaultValue={r.dimension||''} onFocus={e=>e.target.select()} onBlur={e=>{ const v=e.target.value.trim()?e.target.value.trim().toUpperCase():'N/A'; e.target.value=v; updateBomRow(r.id,'dimension',v) }} style={{ width:'100%', padding:'6px 8px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11, boxSizing:'border-box' }}/>
                              </div>
                              <div>
                                <label style={{fontSize:8,color:C.gray,fontWeight:700,textTransform:'uppercase'}}>Qty</label>
                                <input type="number" defaultValue={r.qty_needed} onFocus={e=>e.target.select()} onBlur={e=>updateBomRow(r.id,'qty_needed',Number(e.target.value))} style={{ width:'100%', padding:'6px 8px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11, boxSizing:'border-box' }}/>
                              </div>
                              <div>
                                <label style={{fontSize:8,color:C.gray,fontWeight:700,textTransform:'uppercase'}}>Unit</label>
                                <select defaultValue={r.unit||''} onChange={e=>updateBomRow(r.id,'unit',e.target.value)} style={{ width:'100%', padding:'6px 8px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11, fontFamily:'inherit', boxSizing:'border-box' }}>
                                  <option value="">Unit…</option>
                                  {UNIT_OPTIONS.map(u=><option key={u} value={u}>{u}</option>)}
                                </select>
                              </div>
                              <div>
                                <label style={{fontSize:8,color:C.gray,fontWeight:700,textTransform:'uppercase'}}>Est. Cost</label>
                                <input type="number" defaultValue={r.estimated_unit_cost} onFocus={e=>e.target.select()} onBlur={e=>updateBomRow(r.id,'estimated_unit_cost',Number(e.target.value))} style={{ width:'100%', padding:'6px 8px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11, boxSizing:'border-box' }}/>
                              </div>
                              {canEdit && (
                                <div style={{display:'flex',alignItems:'flex-end'}}>
                                  <button type="button" onClick={()=>removeBomRow(r.id)} title="Delete this material line" style={{ background:`${C.red}18`, border:`1px solid ${C.red}44`, color:C.red, borderRadius:5, cursor:'pointer', fontSize:12, padding:'6px 10px', fontWeight:800 }}>✕</button>
                                </div>
                              )}
                            </div>
                            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                              <select value={r.status} onChange={e=>updateBomRow(r.id,'status',e.target.value)} style={{ padding:'5px 8px', border:`1px solid ${r.status==='Requested'?C.purple:C.lightGray}`, borderRadius:5, fontSize:10, fontFamily:'inherit', color:r.status==='Requested'?C.purple:C.dark, fontWeight:r.status==='Requested'?700:400 }}>
                                <option value="Not Purchased">Not Purchased</option>
                                <option value="Requested">Requested (Purchasing)</option>
                                <option value="Partial">Partial</option>
                                <option value="Purchased">Purchased</option>
                              </select>
                              {canEdit ? (
                                <button type="button" onClick={()=>openFulfill(r)} style={{ background:`${C.blue}18`, border:`1px solid ${C.blue}44`, color:C.blue, borderRadius:5, cursor:'pointer', fontSize:10, padding:'5px 10px', fontWeight:700 }}>
                                  Fulfill — {Number(r.qty_purchased||0)}/{r.qty_needed} {r.unit}
                                </button>
                              ) : <span style={{fontSize:10,color:C.gray}}>{Number(r.qty_purchased||0)}/{r.qty_needed} {r.unit} fulfilled</span>}
                            </div>
                          </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  {canEdit && <button type="button" onClick={()=>{fetchAvailableQuotations(); setSelectedQuoIds([]); setPoQtyOverrides({}); setShowAddQuoToProject(true)}} style={{ fontSize: 10, fontWeight: 700, color: C.purple, background:'none', border:'none', cursor:'pointer', marginBottom: 14 }}>+ Attach another approved quotation to this PO</button>}

                  {/* ── EQUIPMENT (read-only — managed from Resources by the Tool Keeper) ── */}
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'18px 0 10px' }}>Equipment Assigned</div>
                  {equipmentAssignedToProject.length === 0
                    ? <div style={{fontSize:11,color:C.gray,fontStyle:'italic',marginBottom:16}}>No machines currently assigned — occupancy is managed from Resources.</div>
                    : (
                      <div style={{marginBottom:16}}>
                        {equipmentAssignedToProject.map(a => {
                          const isCurrent = !a.end_date
                          return (
                            <div key={a.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', border:`1px solid ${isCurrent?C.accent:C.lightGray}`, background:isCurrent?`${C.accent}0a`:'transparent', borderRadius:8, padding:'8px 12px', marginBottom:6, fontSize:12 }}>
                              <div>
                                <span style={{fontWeight:700}}>{a.equipment?.name || a.equipment_id}</span>
                                {isCurrent && <span style={{fontSize:9,color:C.accent,marginLeft:6}}>● CURRENT</span>}
                                <div style={{fontSize:10,color:C.gray,marginTop:1}}>{a.operator_name ? `Operator: ${a.operator_name} · ` : ''}{a.start_date}{a.end_date ? ` to ${a.end_date}` : ' (ongoing)'}</div>
                              </div>
                            </div>
                          )
                        })}
                        <div style={{fontSize:10,color:C.gray,marginTop:4}}>To assign or release equipment, go to Resources → select the machine → Occupancy.</div>
                      </div>
                    )}

                  {/* ── ATTACHMENTS ── */}
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'18px 0 10px' }}>Attachments</div>
                  {attachments.length === 0 && <div style={{fontSize:11,color:C.gray,fontStyle:'italic',marginBottom:10}}>No files attached yet — client PO scans, contracts, etc.</div>}
                  {attachments.map(att => (
                    <div key={att.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', border:`1px solid ${C.lightGray}`, borderRadius:8, padding:'8px 12px', marginBottom:6, fontSize:12 }}>
                      <button type="button" onClick={()=>openAttachment(att)} style={{background:'none',border:'none',color:C.blue,cursor:'pointer',fontSize:12,textDecoration:'underline',padding:0,textAlign:'left'}}>📎 {att.file_name}</button>
                      {canEdit && <button type="button" onClick={()=>deleteAttachment(att, form.po_number)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'3px 8px',cursor:'pointer',fontSize:10}}>✕</button>}
                    </div>
                  ))}
                  {canEdit && (
                    <div style={{marginBottom:16}}>
                      <input type="file" disabled={uploadingFile} onChange={e=>{ const file=e.target.files?.[0]; if(file) uploadAttachment(form.po_number, file); e.target.value='' }} style={{fontSize:11}}/>
                      {uploadingFile && <span style={{fontSize:11,color:C.gray,marginLeft:8}}>Uploading…</span>}
                    </div>
                  )}

                  {/* ── INVOICING PROGRESS ── */}
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'18px 0 10px' }}>Invoicing</div>
                  <div style={{ background:'#f8faf9', borderRadius:10, padding:'12px 16px', marginBottom:14 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                      <span style={{ fontSize:11, fontWeight:800, color:C.dark }}>Invoiced {fmt(poInvoicedTotal)} of {fmt(form.po_total_value||0)} PO Total</span>
                      <span style={{ fontSize:12, fontWeight:900, color:C.accent }}>{form.po_total_value>0 ? Math.min(100,Math.round(poInvoicedTotal/form.po_total_value*100)) : 0}%</span>
                    </div>
                    <div style={{ background: C.lightGray, height: 8, borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${form.po_total_value>0?Math.min(100,poInvoicedTotal/form.po_total_value*100):0}%`, height: '100%', background: C.accent, borderRadius: 4 }}/>
                    </div>
                  </div>
                  {canEdit && <button type="button" onClick={()=>openInvoiceFlow(form.po_number)} style={{ fontSize: 11, fontWeight: 700, color: C.white, background:C.accent, border:'none', borderRadius:6, cursor:'pointer', marginBottom: 14, padding:'8px 16px' }}>+ Create Invoice from Remaining Items</button>}

                  <div style={{ background:'#f8faf9', borderRadius:10, padding:'12px 16px', marginBottom:14 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                      <span style={{ fontSize:11, fontWeight:800, color:C.dark }}>Collected {fmt(poCollectedTotal)} of {fmt(poInvoicedTotal)} Invoiced</span>
                      <span style={{ fontSize:12, fontWeight:900, color:C.blue }}>{poInvoicedTotal>0 ? Math.min(100,Math.round(poCollectedTotal/poInvoicedTotal*100)) : 0}%</span>
                    </div>
                    <div style={{ background: C.lightGray, height: 8, borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${poInvoicedTotal>0?Math.min(100,poCollectedTotal/poInvoicedTotal*100):0}%`, height: '100%', background: C.blue, borderRadius: 4 }}/>
                    </div>
                  </div>

                  {poInvoicesList.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      {poInvoicesList.map(inv => {
                        const overdue = isInvoiceOverdue(inv)
                        const statusLabel = overdue ? 'Overdue' : inv.status
                        const statusColor = statusLabel==='Paid'?C.accent:overdue?C.red:C.amber
                        return (
                          <div key={inv.id} style={{ border:`1px solid ${C.lightGray}`, borderRadius:8, padding:'10px 14px', marginBottom:8 }}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                              <span style={{ fontSize:12, fontWeight:800, color:C.accent }}>{inv.id}</span>
                              <span style={{ fontSize:12, fontWeight:800 }}>{fmt(inv._total)}</span>
                              <span style={{ padding:'2px 8px', borderRadius:20, background:`${statusColor}22`, color:statusColor, fontSize:9, fontWeight:800 }}>{statusLabel}</span>
                            </div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:6 }}>
                              <input defaultValue={inv.dr_number||''} onFocus={e=>e.target.select()} onBlur={e=>{ const v=e.target.value.trim()?e.target.value.toUpperCase():'N/A'; e.target.value=v; updatePoInvoiceField(inv.id,'dr_number',v) }} disabled={!canEdit} style={{ padding:'5px 7px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11 }}/>
                              <input type="date" defaultValue={inv.delivery_date||''} onBlur={e=>updatePoInvoiceField(inv.id,'delivery_date',e.target.value)} disabled={!canEdit} style={{ padding:'5px 7px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11 }}/>
                              <input placeholder="CR Number" defaultValue={inv.cr_number||''} onFocus={e=>e.target.select()} onBlur={e=>{ const v=e.target.value.toUpperCase(); e.target.value=v; updatePoInvoiceField(inv.id,'cr_number',v) }} disabled={!canEdit} style={{ padding:'5px 7px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11 }}/>
                              <input type="date" defaultValue={inv.collection_date||''} onBlur={e=>updatePoInvoiceField(inv.id,'collection_date',e.target.value)} disabled={!canEdit} style={{ padding:'5px 7px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11 }}/>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* ── PROJECT TIMELINE ── */}
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'18px 0 10px' }}>Timeline</div>
                  <div style={{ marginBottom: 10 }}>
                    {timelineRows.length === 0
                      ? <div style={{ fontSize: 11, color: C.gray, fontStyle:'italic' }}>No timeline entries yet.</div>
                      : timelineRows.map(t => (
                        <div key={t.id} style={{ display:'flex', gap:10, padding:'6px 0', borderBottom:`1px solid ${C.lightGray}`, fontSize:11 }}>
                          <span style={{ color:C.gray, minWidth:80 }}>{t.event_date}</span>
                          <span style={{ fontWeight:700, color:C.dark, minWidth:130 }}>{t.event_type}</span>
                          <span style={{ color:C.gray, flex:1 }}>{t.notes}</span>
                          <span style={{ color:C.gray, fontSize:10, whiteSpace:'nowrap' }}>{t.created_by_name ? `by ${t.created_by_name}` : ''}{t.source==='auto' ? ' · auto' : ''}</span>
                        </div>
                      ))}
                  </div>
                  {canEdit && <ManualTimelineForm po={form.po_number} onAdd={addManualTimelineEntry} />}
                </>
              )}

              <Field label="Notes" type="textarea" value={form.notes} onChange={f('notes')} span placeholder="Additional remarks (not for QUO/INV numbers — use the fields above)" />

              {error && <div style={{padding:10,background:`${C.red}12`,color:C.red,fontSize:12,marginBottom:15,borderRadius:6}}>{error}</div>}
              <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:10}}>
                {selected && canEdit && <button onClick={remove} style={{padding:'10px 20px',color:C.red,background:'none',border:`1.5px solid ${C.red}`,borderRadius:8,fontWeight:800,cursor:'pointer'}}>DELETE</button>}
                <button onClick={()=>setShowModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`1px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer'}}>{canEdit ? 'CANCEL' : 'CLOSE'}</button>
                {canEdit && <button onClick={save} disabled={saving || (!selected && !idAvailable)} style={{padding:'10px 25px',background:C.accent,color:C.white,border:'none',borderRadius:8,fontWeight:800,cursor:'pointer', textTransform: 'uppercase', opacity:(!selected && !idAvailable)?0.5:1}}>{saving?'SAVING...':'SAVE PROJECT'}</button>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── NEW PROJECT FROM PO ── */}
      {showNewPOFlow && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20}}>
          <div style={{background:'white',borderRadius:16,width:'100%',maxWidth:620,maxHeight:'88vh',overflowY:'auto',boxShadow:'0 25px 50px -12px rgba(0,0,0,0.5)'}}>
            <div style={{background:`linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`,color:'white',padding:'18px 24px',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontWeight:900,textTransform:'uppercase',letterSpacing:1}}>New Project from PO</span>
              <button onClick={()=>setShowNewPOFlow(false)} style={{background:'none',border:'none',color:'white',cursor:'pointer',fontSize:18}}>✕</button>
            </div>
            <div style={{padding:24}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
                <div>
                  <Field label="PO Number" value={poForm.po_number} onChange={(v:string)=>{setPoForm(p=>({...p,po_number:v})); checkPoNumber(v); fetchAvailableQuotations(v)}} placeholder="e.g. PO-2026-014" error={poFormAttempted && !poForm.po_number.trim() ? 'Required' : undefined} skipDefault/>
                  {poForm.po_number && (
                    <div style={{fontSize:11,marginTop:-10,marginBottom:12,fontWeight:700,color:poNumberTaken?C.red:C.accent}}>
                      {poNumberTaken?'⚠ Already linked to a project':'✓ Available — this becomes the Project ID'}
                    </div>
                  )}
                </div>
                <Field label="Client (optional override)" value={poForm.client} onChange={(v:string)=>setPoForm(p=>({...p,client:v}))} placeholder="Auto-fills from selected quotations" skipDefault/>
              </div>
              <Field label="Project Name" value={poForm.project_name} onChange={(v:string)=>setPoForm(p=>({...p,project_name:v}))} placeholder={autoNameForSelection ? `Leave blank to use: ${autoNameForSelection}` : "Use the client's own project description from their PO"} span error={poFormAttempted && !effectiveProjectName ? 'Required' : undefined} skipDefault/>

              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'10px 0 8px' }}>
                Select Approved Quotations to Attach ({selectedQuoIds.length} selected)
              </div>
              {availableQuotations.length === 0
                ? <div style={{ fontSize: 12, color: C.gray, fontStyle:'italic', padding:'10px 0' }}>No approved, unlinked quotations available. A quotation must be Approved status and not already attached to another PO.</div>
                : (
                  <div style={{ maxHeight: 260, overflowY:'auto', border:`1px solid ${C.lightGray}`, borderRadius: 8 }}>
                    {availableQuotations.map(q => {
                      const total = quotationTotal(q)
                      const checked = selectedQuoIds.includes(q.id)
                      return (
                        <label key={q.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderBottom:`1px solid ${C.lightGray}`, cursor:'pointer', background:checked?`${C.accent}0a`:'transparent' }}>
                          <input type="checkbox" checked={checked} onChange={()=>setSelectedQuoIds(p=> checked ? p.filter(id=>id!==q.id) : [...p,q.id])}/>
                          <div style={{flex:1}}>
                            <div style={{fontSize:12,fontWeight:800,color:C.accent}}>{q.id}</div>
                            <div style={{fontSize:11,color:C.gray}}>{q.company_name || q.client}</div>
                          </div>
                          <div style={{fontSize:12,fontWeight:800,color:C.dark}}>{fmt(total)}</div>
                        </label>
                      )
                    })}
                  </div>
                )}
              {selectedQuoIds.length > 0 && (
                <div style={{ marginTop: 10, padding:'10px 14px', background:`${C.accent}0a`, borderRadius:8, fontSize:12, fontWeight:800, color:C.darkGreen }}>
                  PO Total: {fmt(availableQuotations.filter(q=>selectedQuoIds.includes(q.id)).reduce((s,q)=>s+quotationTotal(q),0))}
                </div>
              )}

              {selectedQuoIds.length > 0 && (() => {
                const selectedQuotes = availableQuotations.filter(q=>selectedQuoIds.includes(q.id))
                const allItems = selectedQuotes.flatMap(q => itemLinesWithMaterials(q).map(x => ({...x, quotationId:q.id})))
                if (allItems.length === 0) return null
                return (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', marginBottom: 8 }}>
                      PO Quantity vs. Quoted Quantity
                    </div>
                    <div style={{ fontSize: 11, color: C.gray, marginBottom: 8 }}>If the client's actual PO asks for a different quantity than what was quoted, enter it here — materials on the Bill of Materials will scale automatically. Leave blank to keep the quoted quantity.</div>
                    <div style={{ border:`1px solid ${C.lightGray}`, borderRadius: 8, overflow:'hidden' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:6, padding:'6px 12px', background:'#f4f7f5', fontSize:9, fontWeight:800, color:C.gray, textTransform:'uppercase' }}>
                        <span>Item</span><span>Quoted Qty</span><span>PO Qty</span>
                      </div>
                      {allItems.map(({item, quotationId}) => (
                        <div key={item.line_uid} style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:6, padding:'6px 12px', borderTop:`1px solid ${C.lightGray}`, alignItems:'center' }}>
                          <div>
                            <div style={{fontSize:11,fontWeight:700}}>{item.description}</div>
                            <div style={{fontSize:9,color:C.gray}}>{quotationId}</div>
                          </div>
                          <span style={{fontSize:12,color:C.gray}}>{item.qty} {item.unit}</span>
                          <input type="number" placeholder={`${item.qty}`} value={poQtyOverrides[item.line_uid]||''}
                            onChange={e=>setPoQtyOverrides(p=>({...p,[item.line_uid]:e.target.value}))}
                            onFocus={e=>e.target.select()}
                            style={{ width:'100%', boxSizing:'border-box', padding:'6px 8px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:12 }}/>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}

              {error && <div style={{padding:10,background:`${C.red}12`,color:C.red,fontSize:12,marginTop:15,borderRadius:6}}>{error}</div>}
              <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:16}}>
                <button onClick={()=>setShowNewPOFlow(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`1px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer'}}>CANCEL</button>
                <button onClick={createProjectFromPO} disabled={saving || poNumberTaken || !poForm.po_number.trim() || !effectiveProjectName || selectedQuoIds.length===0} style={{padding:'10px 25px',background:C.accent,color:C.white,border:'none',borderRadius:8,fontWeight:800,cursor:'pointer',textTransform:'uppercase',opacity:(poNumberTaken||!poForm.po_number.trim()||!effectiveProjectName||selectedQuoIds.length===0)?0.5:1}}>{saving?'CREATING...':'CREATE PROJECT'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CREATE INVOICE FROM REMAINING ITEMS ── */}
      {showInvoiceFlow && selected && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200,padding:20}}>
          <div style={{background:'white',borderRadius:16,width:'100%',maxWidth:760,maxHeight:'88vh',overflowY:'auto',boxShadow:'0 25px 50px -12px rgba(0,0,0,0.5)'}}>
            <div style={{background:`linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`,color:'white',padding:'18px 24px',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontWeight:900,textTransform:'uppercase',letterSpacing:1}}>Create Invoice — PO {selected.po_number}</span>
              <button onClick={()=>setShowInvoiceFlow(false)} style={{background:'none',border:'none',color:'white',cursor:'pointer',fontSize:18}}>✕</button>
            </div>
            <div style={{padding:24}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
                <div>
                  <Field label="Invoice ID" value={newInvForm.id} onChange={(v:string)=>{setNewInvForm(p=>({...p,id:v})); checkNewInvId(v)}} skipDefault/>
                  {newInvForm.id && <div style={{fontSize:11,marginTop:-10,marginBottom:12,fontWeight:700,color:invIdAvail?C.accent:C.red}}>{invIdAvail?'✓ Available':'⚠ Already taken'}</div>}
                </div>
                <Field label="Invoice Date" type="date" value={newInvForm.date} onChange={(v:string)=>setNewInvForm(p=>({...p,date:v}))} />
              </div>
              <Field label="Payment Terms" type="select" value={newInvForm.payment_terms} onChange={(v:string)=>setNewInvForm(p=>({...p,payment_terms:v}))} options={['15 Days','30 Days','60 Days','90 Days']} />
              <Field label="DR Number (Delivery Receipt) — marks this as received by the client" value={newInvForm.dr_number} onChange={(v:string)=>setNewInvForm(p=>({...p,dr_number:v}))} placeholder="Optional — enter if delivering now" span skipDefault/>

              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin:'14px 0 8px' }}>Lines With Remaining Quantity</div>
              {invoicingLines.length === 0
                ? <div style={{fontSize:12,color:C.gray,fontStyle:'italic',padding:'10px 0'}}>Everything under this PO has already been fully invoiced.</div>
                : (
                  <div style={{ border:`1px solid ${C.lightGray}`, borderRadius:8, overflow:'hidden', marginBottom:14 }}>
                    <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 1fr', gap:6, padding:'6px 10px', background:'#f4f7f5', fontSize:9, fontWeight:800, color:C.gray, textTransform:'uppercase' }}>
                      <span>Description</span><span>Remaining</span><span>Unit Price</span><span>Qty to Invoice</span>
                    </div>
                    {invoicingLines.map(l => (
                      <div key={l.line_uid} style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 1fr', gap:6, padding:'6px 10px', borderTop:`1px solid ${C.lightGray}`, alignItems:'center' }}>
                        <span style={{fontSize:11,fontWeight:700}}>{l.description}</span>
                        <span style={{fontSize:11,color:C.gray}}>{l.remaining} of {l.qtyTotal} {l.unit}</span>
                        <span style={{fontSize:11}}>{fmt(l.price)}</span>
                        <input type="number" min={0} max={l.remaining} value={invoiceQtyPicked[l.line_uid]??0}
                          onChange={e=>setInvoiceQtyPicked(p=>({...p,[l.line_uid]:Number(e.target.value)}))}
                          onFocus={e=>e.target.select()}
                          style={{ padding:'5px 7px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:11 }}/>
                      </div>
                    ))}
                  </div>
                )}

              {(() => {
                const thisInvoiceTotal = invoicingLines.reduce((s,l)=>s+(Number(invoiceQtyPicked[l.line_uid])||0)*l.price,0) * 1.12
                return (
                  <div style={{ background:`${C.accent}0a`, borderRadius:8, padding:'12px 16px', marginBottom:14, fontSize:12 }}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span style={{color:C.gray}}>This Invoice (incl. VAT)</span><b style={{color:C.darkGreen}}>{fmt(thisInvoiceTotal)}</b></div>
                    <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:C.gray}}>Already Invoiced</span><span>{fmt(poInvoicedTotal)}</span></div>
                    <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:C.gray}}>PO Total</span><span>{fmt(selected.po_total_value||0)}</span></div>
                  </div>
                )
              })()}

              {error && <div style={{padding:10,background:`${C.red}12`,color:C.red,fontSize:12,marginBottom:15,borderRadius:6}}>{error}</div>}
              <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
                <button onClick={()=>setShowInvoiceFlow(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`1px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer'}}>CANCEL</button>
                <button onClick={createPartialInvoice} disabled={saving || invoicingLines.length===0} style={{padding:'10px 25px',background:C.accent,color:C.white,border:'none',borderRadius:8,fontWeight:800,cursor:'pointer',textTransform:'uppercase',opacity:invoicingLines.length===0?0.5:1}}>{saving?'CREATING...':'CREATE INVOICE'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── BOM FULFILLMENT ── */}
      {fulfillingRow && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200,padding:20}}>
          <div style={{background:'white',borderRadius:16,width:'100%',maxWidth:520,maxHeight:'88vh',overflowY:'auto',boxShadow:'0 25px 50px -12px rgba(0,0,0,0.5)'}}>
            <div style={{background:`linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`,color:'white',padding:'18px 24px',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontWeight:900,textTransform:'uppercase',letterSpacing:1}}>Fulfill: {fulfillingRow.description}</span>
              <button onClick={()=>setFulfillingRow(null)} style={{background:'none',border:'none',color:'white',cursor:'pointer',fontSize:18}}>✕</button>
            </div>
            <div style={{padding:24}}>
              <div style={{fontSize:12,color:C.gray,marginBottom:16}}>
                Needed: <b style={{color:C.dark}}>{fulfillingRow.qty_needed} {fulfillingRow.unit}</b> · Already fulfilled: <b style={{color:C.accent}}>{fulfillingRow.qty_purchased||0} {fulfillingRow.unit}</b>
              </div>

              <div style={{display:'flex',gap:8,marginBottom:16}}>
                <button type="button" onClick={()=>setFulfillMode('stock')} style={{flex:1,padding:'10px',fontSize:11,fontWeight:800,borderRadius:8,cursor:'pointer',border:`1.5px solid ${fulfillMode==='stock'?C.accent:C.lightGray}`,background:fulfillMode==='stock'?`${C.accent}12`:C.white,color:fulfillMode==='stock'?C.accent:C.gray}}>Draw from Existing Stock</button>
                <button type="button" onClick={()=>setFulfillMode('purchase')} style={{flex:1,padding:'10px',fontSize:11,fontWeight:800,borderRadius:8,cursor:'pointer',border:`1.5px solid ${fulfillMode==='purchase'?C.purple:C.lightGray}`,background:fulfillMode==='purchase'?`${C.purple}12`:C.white,color:fulfillMode==='purchase'?C.purple:C.gray}}>Send to Purchasing</button>
              </div>

              {fulfillMode==='stock' && (
                <Field label="Matches Registered Material" type="select" value={fulfillForm.material_id} onChange={(v:string)=>{
                  const mat = inventoryItems.find(i=>i.id===v)
                  setFulfillForm(p=>({...p, material_id:v, unit_cost: mat?.unit_cost || p.unit_cost}))
                }} options={inventoryItems.map(i=>({value:i.id, label:`${i.name} (${i.quantity} ${i.unit} in stock)`}))} />
              )}

              <Field label={`Qty to Fulfill (${fulfillingRow.unit})`} type="number" value={fulfillForm.qty} onChange={(v:string)=>setFulfillForm(p=>({...p,qty:Number(v)}))} />

              {fulfillMode==='stock' ? (
                <div style={{fontSize:11,color:C.gray,marginBottom:14,background:'#f9fbf9',padding:'10px 14px',borderRadius:8}}>
                  Deducts stock and logs an <b>Internal Transfer</b> expense (documents project cost without double-counting real cash — that already went out when this stock was originally purchased).
                </div>
              ) : (
                <>
                  <Field label="Requested By" value={fulfillForm.requested_by||''} onChange={(v:string)=>setFulfillForm(p=>({...p,requested_by:v}))} />
                  <div style={{fontSize:11,color:C.purple,marginBottom:14,background:`${C.purple}0a`,padding:'10px 14px',borderRadius:8}}>
                    This won't buy anything directly — it sends a Material Request to the Purchasing module, where an officer compares supplier quotes before releasing a Purchase Order. This BOM line will show as "Requested" until that's fulfilled.
                  </div>
                </>
              )}

              {fulfillError && <div style={{padding:10,background:`${C.red}12`,color:C.red,fontSize:12,marginBottom:15,borderRadius:6}}>{fulfillError}</div>}
              <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
                <button onClick={()=>setFulfillingRow(null)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`1px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer'}}>CANCEL</button>
                <button onClick={submitFulfillment} disabled={fulfillSaving} style={{padding:'10px 25px',background:fulfillMode==='stock'?C.accent:C.purple,color:C.white,border:'none',borderRadius:8,fontWeight:800,cursor:'pointer',textTransform:'uppercase'}}>{fulfillSaving?'PROCESSING...':fulfillMode==='stock'?'CONFIRM FULFILLMENT':'SEND REQUEST'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── ADD QUOTATION TO EXISTING PO ── */}
      {showAddQuoToProject && selected && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1100,padding:20}}>
          <div style={{background:'white',borderRadius:16,width:'100%',maxWidth:560,maxHeight:'80vh',overflowY:'auto',boxShadow:'0 25px 50px -12px rgba(0,0,0,0.5)'}}>
            <div style={{background:`linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`,color:'white',padding:'18px 24px',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontWeight:900,textTransform:'uppercase',letterSpacing:1}}>Attach Quotation to PO {selected.po_number}</span>
              <button onClick={()=>setShowAddQuoToProject(false)} style={{background:'none',border:'none',color:'white',cursor:'pointer',fontSize:18}}>✕</button>
            </div>
            <div style={{padding:24}}>
              {availableQuotations.length === 0
                ? <div style={{ fontSize: 12, color: C.gray, fontStyle:'italic', padding:'10px 0' }}>No approved, unlinked quotations available.</div>
                : (
                  <div style={{ maxHeight: 320, overflowY:'auto', border:`1px solid ${C.lightGray}`, borderRadius: 8 }}>
                    {availableQuotations.map(q => {
                      const total = quotationTotal(q)
                      const checked = selectedQuoIds.includes(q.id)
                      return (
                        <label key={q.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderBottom:`1px solid ${C.lightGray}`, cursor:'pointer', background:checked?`${C.accent}0a`:'transparent' }}>
                          <input type="checkbox" checked={checked} onChange={()=>setSelectedQuoIds(p=> checked ? p.filter(id=>id!==q.id) : [...p,q.id])}/>
                          <div style={{flex:1}}>
                            <div style={{fontSize:12,fontWeight:800,color:C.accent}}>{q.id}</div>
                            <div style={{fontSize:11,color:C.gray}}>{q.company_name || q.client}</div>
                          </div>
                          <div style={{fontSize:12,fontWeight:800,color:C.dark}}>{fmt(total)}</div>
                        </label>
                      )
                    })}
                  </div>
                )}
              {selectedQuoIds.length > 0 && (() => {
                const selectedQuotes = availableQuotations.filter(q=>selectedQuoIds.includes(q.id))
                const allItems = selectedQuotes.flatMap(q => itemLinesWithMaterials(q).map(x => ({...x, quotationId:q.id})))
                if (allItems.length === 0) return null
                return (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', marginBottom: 8 }}>
                      PO Quantity vs. Quoted Quantity
                    </div>
                    <div style={{ border:`1px solid ${C.lightGray}`, borderRadius: 8, overflow:'hidden' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:6, padding:'6px 12px', background:'#f4f7f5', fontSize:9, fontWeight:800, color:C.gray, textTransform:'uppercase' }}>
                        <span>Item</span><span>Quoted Qty</span><span>PO Qty</span>
                      </div>
                      {allItems.map(({item, quotationId}) => (
                        <div key={item.line_uid} style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:6, padding:'6px 12px', borderTop:`1px solid ${C.lightGray}`, alignItems:'center' }}>
                          <div>
                            <div style={{fontSize:11,fontWeight:700}}>{item.description}</div>
                            <div style={{fontSize:9,color:C.gray}}>{quotationId}</div>
                          </div>
                          <span style={{fontSize:12,color:C.gray}}>{item.qty} {item.unit}</span>
                          <input type="number" placeholder={`${item.qty}`} value={poQtyOverrides[item.line_uid]||''}
                            onChange={e=>setPoQtyOverrides(p=>({...p,[item.line_uid]:e.target.value}))}
                            onFocus={e=>e.target.select()}
                            style={{ width:'100%', boxSizing:'border-box', padding:'6px 8px', border:`1px solid ${C.lightGray}`, borderRadius:5, fontSize:12 }}/>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
              {error && <div style={{padding:10,background:`${C.red}12`,color:C.red,fontSize:12,marginTop:15,borderRadius:6}}>{error}</div>}
              <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:16}}>
                <button onClick={()=>setShowAddQuoToProject(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`1px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer'}}>CANCEL</button>
                <button onClick={addQuotationsToPO} disabled={saving || selectedQuoIds.length===0} style={{padding:'10px 25px',background:C.accent,color:C.white,border:'none',borderRadius:8,fontWeight:800,cursor:'pointer',textTransform:'uppercase',opacity:selectedQuoIds.length===0?0.5:1}}>{saving?'ATTACHING...':'ATTACH SELECTED'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}