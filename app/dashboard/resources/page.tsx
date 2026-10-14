'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'
import { usePermissions } from '@/lib/permissions'
import type { Equipment } from '@/app/types/index'

const C={darkGreen:'#1a4d2e',midGreen:'#2d6a4f',accent:'#39b54a',white:'#ffffff',dark:'#0d1f14',gray:'#6b7c72',lightGray:'#e8ede9',red:'#e53e3e',amber:'#d97706',blue:'#2563eb'}
const fmt=(n:number)=>`₱${Number(n||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`

const BLANK:Omit<Equipment,'id'>={name:'',brand:'',status:'Available',assigned_to:'',last_maintenance:'',price:0,date_acquired:'',quantity:1}
const inputStyle:React.CSSProperties={width:'100%',padding:'9px 12px',border:'1.5px solid #e8ede9',borderRadius:6,fontSize:13,fontFamily:'inherit',color:'#0d1f14',background:'#fafcfb',boxSizing:'border-box',outline:'none'}

function Field({label,type='text',value,onChange,options,placeholder,span,disabled}:any){
  const touched = !disabled && (type==='text' || type==='number')
  return(
    <div style={{marginBottom:14,gridColumn:span?'1/-1':'auto'}}>
      <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>{label}</label>
      {type==='select'
        ?<select value={value} onChange={e=>onChange(e.target.value)} style={inputStyle} disabled={disabled}><option value="">Select…</option>{options.map((o:string)=><option key={o} value={o}>{o}</option>)}</select>
        :<input
            type={type}
            value={value}
            onChange={e=>onChange(type==='text'?e.target.value.toUpperCase():e.target.value)}
            onFocus={touched?(e=>e.target.select()):undefined}
            onBlur={touched?(e=>{
              if(!e.target.value.trim()){
                if(type==='number') onChange('0')
                else onChange('N/A')
              }
            }):undefined}
            placeholder={placeholder}
            style={inputStyle}
            disabled={disabled}
          />}
    </div>
  )
}

function StatusBadge({status}:{status:string}){
  const map:Record<string,string>={Available:C.accent,'In Use':C.blue,Maintenance:C.amber,Retired:C.red}
  const color=map[status]||C.gray
  return <span style={{padding:'3px 12px',borderRadius:20,background:`${color}22`,color,fontSize:10,fontWeight:800,border:`1px solid ${color}44`,whiteSpace:'nowrap'}}>{status}</span>
}

function daysSince(dateStr:string):number{
  if(!dateStr) return 0
  return Math.floor((Date.now()-new Date(dateStr).getTime())/(1000*60*60*24))
}

// Derives the next equipment ID from the highest existing suffix rather than
// array length, so it can't collide after a deletion shifts the count down.
function nextEquipmentId(equipment: Equipment[]) {
  const nums = equipment
    .map(e => { const m = /EQ-(\d+)/.exec(e.id); return m ? Number(m[1]) : null })
    .filter((n): n is number => n !== null)
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `EQ-${String(next).padStart(3, '0')}`
}

export default function ResourcesPage(){
  const supabase=createClient()
  const canEdit = usePermissions().canEditModule('resources')
  const [equipment,setEquipment]=useState<Equipment[]>([])
  const [loans,setLoans]=useState<any[]>([])

  // ── Occupancy — which projects a machine is/was assigned to, and by whom ──
  // Already fetched most-recent-first (by start_date); a frequently-used
  // machine can rack up years of assignment history, so this list is
  // paginated the same way the other long lists in the app are.
  const [assignments,setAssignments]=useState<any[]>([])
  const [assignPage,setAssignPage]=useState(1)
  const ASSIGN_PAGE_SIZE = 50
  const modalBodyRef = useRef<HTMLDivElement>(null)
  const [activeProjects,setActiveProjects]=useState<any[]>([])
  const [assignForm,setAssignForm]=useState({po_number:'',operator_name:'',daily_rate:'',start_date:new Date().toISOString().slice(0,10),end_date:'',notes:''})
  useEffect(()=>{ supabase.from('projects').select('po_number,name,client').not('po_number','is',null).order('po_number').then(({data})=>setActiveProjects(data||[])) },[])
  const fetchAssignments = useCallback(async(equipmentId:string)=>{
    const {data} = await supabase.from('equipment_assignments').select('*').eq('equipment_id',equipmentId).order('start_date',{ascending:false})
    setAssignments(data||[])
  },[supabase])
  useEffect(()=>{ modalBodyRef.current?.scrollTo({top:0, behavior:'smooth'}) },[assignPage])
  const saveAssignment = async(equipmentId:string) => {
    if(!assignForm.po_number) return
    await supabase.from('equipment_assignments').insert({
      equipment_id:equipmentId, po_number:assignForm.po_number, operator_name:assignForm.operator_name||null,
      daily_rate:Number(assignForm.daily_rate)||0, start_date:assignForm.start_date, end_date:assignForm.end_date||null, notes:assignForm.notes||null,
    })
    setAssignForm({po_number:'',operator_name:'',daily_rate:'',start_date:new Date().toISOString().slice(0,10),end_date:'',notes:''})
    await fetchAssignments(equipmentId)
  }
  const endAssignment = async(assignmentId:string, equipmentId:string) => {
    await supabase.from('equipment_assignments').update({end_date:new Date().toISOString().slice(0,10)}).eq('id',assignmentId)
    await fetchAssignments(equipmentId)
  }
  const deleteAssignment = async(assignmentId:string, equipmentId:string) => {
    if(!window.confirm('Delete this assignment record?')) return
    await supabase.from('equipment_assignments').delete().eq('id',assignmentId)
    await fetchAssignments(equipmentId)
  }

  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [showModal,setShowModal]=useState(false)
  const [selected,setSelected]=useState<Equipment|null>(null)
  const [form,setForm]=useState<any>(BLANK)
  const [error,setError]=useState('')
  const [filterStatus,setFilterStatus]=useState('All')
  const f=(k:string)=>(v:any)=>setForm((p:any)=>({...p,[k]:v}))

  // ── Financing (equipment_loans) ──────────────────────────────────────────
  const [acquisition,setAcquisition]=useState<'cash'|'financing'>('cash')
  const [loanForm,setLoanForm]=useState({principal:0,installment_amount:0,vendor:'',date_acquired:new Date().toISOString().slice(0,10)})
  const [showLoanPayModal,setShowLoanPayModal]=useState<any>(null)
  const [loanPayAmount,setLoanPayAmount]=useState(0)
  const [loanHistoryFor,setLoanHistoryFor]=useState<any>(null)
  const [loanHistory,setLoanHistory]=useState<any[]>([])
  const [loanSaving,setLoanSaving]=useState(false)

  const loanFor=(equipmentId:string)=>loans.find(l=>l.equipment_id===equipmentId)

  const fetchLoans=useCallback(async()=>{
    const {data}=await supabase.from('equipment_loans').select('*').order('date_acquired',{ascending:false})
    if(data) setLoans(data)
  },[supabase])

  const fetch=useCallback(async()=>{
    setLoading(true)
    // fetchAllPages guards against Supabase/PostgREST's silent 1000-row cap —
    // every KPI tile above (Available/In Use/Maintenance/Retired) is a count
    // over this same array, so a plain .select('*') would quietly undercount
    // all of them once the equipment table passes 1000 rows.
    const {data}=await fetchAllPages<any>((from,to)=>supabase.from('equipment').select('*').order('name').range(from,to))
    if(data) setEquipment(data)
    await fetchLoans()
    setLoading(false)
  },[supabase,fetchLoans])
  useEffect(()=>{fetch()},[fetch])

  const openNew=()=>{
    setForm({...BLANK, id: nextEquipmentId(equipment)})
    setSelected(null);setError('');setShowModal(true)
    setAcquisition('cash'); setLoanForm({principal:0,installment_amount:0,vendor:'',date_acquired:new Date().toISOString().slice(0,10)})
  }
  const openEdit=(e:Equipment)=>{
    if(!canEdit) return
    setForm({...e});setSelected(e);setError('');setShowModal(true)
    setAcquisition('cash'); setLoanForm({principal:0,installment_amount:0,vendor:'',date_acquired:new Date().toISOString().slice(0,10)})
    setAssignPage(1)
    fetchAssignments(e.id)
  }

  const save=async()=>{
    setSaving(true);setError('')
    try{
      if(selected){
        const {error:e}=await supabase.from('equipment').update({
          name:form.name,brand:form.brand,status:form.status,
          assigned_to:form.assigned_to,last_maintenance:form.last_maintenance||null,
          price:Number(form.price)||0, date_acquired:form.date_acquired||null, quantity:Number(form.quantity)||1
        }).eq('id',selected.id)
        if(e) throw e
      } else {
        const {error:e}=await supabase.from('equipment').insert({
          ...form, assigned_to:form.assigned_to||null, last_maintenance:form.last_maintenance||null,
          price:Number(form.price)||0, date_acquired:form.date_acquired||null, quantity:Number(form.quantity)||1
        })
        if(e){
          if((e as any).code==='23505') throw new Error(`Reference "${form.id}" already exists. Please try saving again to get a fresh ID.`)
          throw e
        }
        // New equipment bought on financing gets its own loan record —
        // same balance/payment-ledger pattern as employee loans/cash advances.
        if(acquisition==='financing' && Number(loanForm.principal)>0){
          const loanId=`EQL-${form.id}`
          const {error:eLoan}=await supabase.from('equipment_loans').insert({
            id:loanId, equipment_id:form.id, date_acquired:loanForm.date_acquired,
            principal:Number(loanForm.principal), installment_amount:Number(loanForm.installment_amount),
            balance:Number(loanForm.principal), vendor:loanForm.vendor,
          })
          if(eLoan) throw eLoan
        }
      }
      await fetch();setShowModal(false)
    } catch(err:any){setError(err.message)}
    setSaving(false)
  }

  const remove=async()=>{
    if(!selected) return;setSaving(true)
    const {error}=await supabase.from('equipment').delete().eq('id',selected.id)
    if(!error){await fetch();setShowModal(false)} else setError(error.message)
    setSaving(false)
  }

  // Manual payment recording, for cases outside the Expenses-module link
  // (e.g. a cash top-up payment not itself logged as an expense).
  const recordLoanPayment=async()=>{
    if(!showLoanPayModal||!loanPayAmount) return
    setLoanSaving(true)
    const {error}=await supabase.from('equipment_loan_payments').insert({loan_id:showLoanPayModal.id,amount:loanPayAmount,date:new Date().toISOString().slice(0,10),method:'Manual'})
    if(!error){ await fetchLoans(); setShowLoanPayModal(null); setLoanPayAmount(0) } else alert(error.message)
    setLoanSaving(false)
  }
  const openLoanHistory=async(loan:any)=>{
    setLoanHistoryFor(loan)
    const {data}=await supabase.from('equipment_loan_payments').select('*').eq('loan_id',loan.id).order('date',{ascending:false})
    setLoanHistory(data||[])
  }

  const assignPageCount = Math.max(1, Math.ceil(assignments.length / ASSIGN_PAGE_SIZE))
  const assignCurrentPage = Math.min(assignPage, assignPageCount)
  const pagedAssignments = assignments.slice((assignCurrentPage-1)*ASSIGN_PAGE_SIZE, assignCurrentPage*ASSIGN_PAGE_SIZE)

  // Purchase year = year of date_acquired. Year filter + newest/oldest sort.
  const [yearFilter,setYearFilter]=useState('All')
  const [yearSort,setYearSort]=useState<'name'|'newest'|'oldest'>('name')
  const yearOf=(e:Equipment)=>e.date_acquired?String(e.date_acquired).slice(0,4):'Unknown'
  const purchaseYears=Array.from(new Set(equipment.map(yearOf))).sort((a,b)=>b.localeCompare(a))
  const filtered=equipment
    .filter(e=>filterStatus==='All'||e.status===filterStatus)
    .filter(e=>yearFilter==='All'||yearOf(e)===yearFilter)
    .slice()
    .sort((a,b)=>{
      if(yearSort==='name')return 0
      const da=a.date_acquired||'',db=b.date_acquired||''
      if(!da&&!db)return 0
      if(!da)return 1
      if(!db)return -1
      return yearSort==='newest'?db.localeCompare(da):da.localeCompare(db)
    })
  const [eqPage,setEqPage]=useState(1)
  const EQ_PAGE_SIZE=24
  useEffect(()=>{ setEqPage(1) },[filterStatus,yearFilter,yearSort])
  const eqPageCount=Math.max(1,Math.ceil(filtered.length/EQ_PAGE_SIZE))
  const eqCurrentPage=Math.min(eqPage,eqPageCount)
  const pagedEquipment=filtered.slice((eqCurrentPage-1)*EQ_PAGE_SIZE,eqCurrentPage*EQ_PAGE_SIZE)
  const counts={Available:equipment.filter(e=>e.status==='Available').length,'In Use':equipment.filter(e=>e.status==='In Use').length,Maintenance:equipment.filter(e=>e.status==='Maintenance').length,Retired:equipment.filter(e=>e.status==='Retired').length}
  const needsMaint=equipment.filter(e=>e.last_maintenance&&daysSince(e.last_maintenance)>180)

  return(
    <div>
      {/* KPI cards */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:22}}>
        {([['Available',counts['Available'],C.accent,'⚙'],['In Use',counts['In Use'],C.blue,'🔧'],['Maintenance',counts['Maintenance'],C.amber,'🛠'],['Retired',counts['Retired'],C.red,'📦']] as any[]).map(([l,v,c,ic])=>(
          <div key={l} style={{background:C.white,borderRadius:12,padding:'18px 22px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',borderTop:`4px solid ${c}`,display:'flex',alignItems:'center',gap:16}}>
            <div style={{width:48,height:48,borderRadius:10,background:`${c}18`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}}>{ic}</div>
            <div>
              <div style={{fontSize:26,fontWeight:900,color:C.dark}}>{v}</div>
              <div style={{fontSize:10,fontWeight:700,color:C.gray,letterSpacing:1.5,textTransform:'uppercase',marginTop:2}}>{l}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Maintenance alert */}
      {needsMaint.length>0&&(
        <div style={{background:`${C.amber}0a`,border:`1.5px solid ${C.amber}33`,borderRadius:12,padding:'14px 20px',marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:C.amber,letterSpacing:1,textTransform:'uppercase',marginBottom:8}}>🛠 Maintenance Due (&gt;180 days)</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
            {needsMaint.map(e=>(
              <span key={e.id} style={{padding:'4px 12px',borderRadius:20,background:`${C.amber}18`,border:`1px solid ${C.amber}44`,color:C.amber,fontSize:11,fontWeight:700}}>
                {e.name} — {daysSince(e.last_maintenance)}d ago
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs + table */}
      <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18,flexWrap:'wrap',gap:10}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
            <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Equipment Registry</h2>
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            {['All','Available','In Use','Maintenance','Retired'].map(s=>(
              <button key={s} onClick={()=>setFilterStatus(s)} style={{padding:'6px 14px',borderRadius:20,border:`1.5px solid ${filterStatus===s?C.accent:C.lightGray}`,background:filterStatus===s?C.accent:C.white,color:filterStatus===s?C.white:C.gray,fontSize:10,fontWeight:700,cursor:'pointer',fontFamily:'inherit',letterSpacing:0.5,transition:'all 0.2s'}}>{s}</button>
            ))}
            <select value={yearFilter} onChange={e=>setYearFilter(e.target.value)} title="Filter by year of purchase" style={{padding:'6px 10px',border:`1.5px solid ${yearFilter==='All'?C.lightGray:C.accent}`,borderRadius:20,fontSize:10,fontWeight:700,fontFamily:'inherit',color:C.gray,background:C.white}}>
              <option value="All">All purchase years</option>
              {purchaseYears.map(y=><option key={y} value={y}>{y}</option>)}
            </select>
            <select value={yearSort} onChange={e=>setYearSort(e.target.value as any)} title="Sort by date of purchase" style={{padding:'6px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:20,fontSize:10,fontWeight:700,fontFamily:'inherit',color:C.gray,background:C.white}}>
              <option value="name">Sort: Name</option>
              <option value="newest">Sort: Newest purchase first</option>
              <option value="oldest">Sort: Oldest purchase first</option>
            </select>
            {canEdit&&<button onClick={openNew} style={{padding:'9px 18px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit',boxShadow:`0 3px 10px ${C.accent}44`,whiteSpace:'nowrap'}}>+ Add Equipment</button>}
          </div>
        </div>

        {loading?<div style={{textAlign:'center',padding:40,color:C.gray}}>Loading equipment…</div>
        :filtered.length===0?<div style={{textAlign:'center',padding:40,color:C.gray}}>No equipment found.</div>
        :<>
          <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>{`Showing ${(eqCurrentPage-1)*EQ_PAGE_SIZE+1}–${Math.min(eqCurrentPage*EQ_PAGE_SIZE,filtered.length)} of ${filtered.length}`}</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:14}}>
            {pagedEquipment.map(eq=>{
              const days=eq.last_maintenance?daysSince(eq.last_maintenance):null
              const maintColor=days===null?C.gray:days>180?C.red:days>90?C.amber:C.accent
              const loan=loanFor(eq.id)
              return(
                <div key={eq.id} onClick={()=>openEdit(eq)}
                  style={{border:`1.5px solid ${C.lightGray}`,borderRadius:10,overflow:'hidden',cursor:canEdit?'pointer':'default',transition:'all 0.2s',background:C.white}}
                  onMouseEnter={e=>{if(canEdit){e.currentTarget.style.border=`1.5px solid ${C.accent}`;e.currentTarget.style.boxShadow=`0 4px 20px ${C.accent}22`}}}
                  onMouseLeave={e=>{e.currentTarget.style.border=`1.5px solid ${C.lightGray}`;e.currentTarget.style.boxShadow='none'}}>
                  <div style={{background:`linear-gradient(135deg,${C.dark},${C.darkGreen})`,padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <div>
                      <div style={{fontSize:9,color:C.accent,fontWeight:700,letterSpacing:2}}>{eq.id}</div>
                      <div style={{fontSize:13,fontWeight:900,color:C.white,marginTop:2,lineHeight:1.3}}>{eq.name}</div>
                    </div>
                    <StatusBadge status={eq.status}/>
                  </div>
                  {loan && (
                    <div onClick={e=>e.stopPropagation()} style={{padding:'10px 16px',background:loan.status==='Fully Paid'?`${C.accent}0a`:`${C.amber}0a`,borderBottom:`1px solid ${C.lightGray}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <div>
                        <span style={{fontSize:10,fontWeight:800,color:loan.status==='Fully Paid'?C.accent:C.amber}}>{loan.status==='Fully Paid'?'✓ Fully Paid':`Financing — ${fmt(loan.balance)} left`}</span>
                        {loan.vendor && <div style={{fontSize:9,color:C.gray,marginTop:1}}>via {loan.vendor}</div>}
                      </div>
                      <button onClick={()=>openLoanHistory(loan)} style={{padding:'3px 9px',fontSize:9,fontWeight:700,background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:4,cursor:'pointer'}}>History</button>
                    </div>
                  )}
                  <div style={{padding:'12px 16px'}}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                      <span style={{fontSize:11,color:C.gray}}>Brand</span>
                      <span style={{fontSize:11,fontWeight:700,color:C.dark}}>{eq.brand||'—'}</span>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                      <span style={{fontSize:11,color:C.gray}}>Price</span>
                      <span style={{fontSize:11,fontWeight:700,color:C.dark}}>{eq.price?fmt(eq.price):'—'}</span>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                      <span style={{fontSize:11,color:C.gray}}>Quantity</span>
                      <span style={{fontSize:11,fontWeight:700,color:C.dark}}>{eq.quantity??1}</span>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                      <span style={{fontSize:11,color:C.gray}}>Date Acquired</span>
                      <span style={{fontSize:11,fontWeight:700,color:C.dark}}>{eq.date_acquired||'—'}</span>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                      <span style={{fontSize:11,color:C.gray}}>Assigned To</span>
                      <span style={{fontSize:11,fontWeight:700,color:C.dark}}>{eq.assigned_to||'—'}</span>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <span style={{fontSize:11,color:C.gray}}>Last Maintenance</span>
                      <div style={{textAlign:'right'}}>
                        <div style={{fontSize:11,fontWeight:700,color:C.dark}}>{eq.last_maintenance||'Not recorded'}</div>
                        {days!==null&&<div style={{fontSize:10,color:maintColor,fontWeight:700}}>{days} days ago{days>180?' ⚠':''}</div>}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div style={{marginTop:24}}>
            <div style={{fontSize:11,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',marginBottom:12}}>Table View</div>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                {['ID','Equipment Name','Brand','Price','Qty','Date Acquired','Status','Assigned To','Last Maintenance','Days Since Maint.'].map(h=>(
                  <th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>{pagedEquipment.map((eq,i)=>{
                const days=eq.last_maintenance?daysSince(eq.last_maintenance):null
                const daysColor=days===null?C.gray:days>180?C.red:days>90?C.amber:C.accent
                return <tr key={eq.id}
                  onClick={()=>openEdit(eq)}
                  style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`,cursor:canEdit?'pointer':'default'}}
                  onMouseEnter={e=>{if(canEdit)e.currentTarget.style.background=`${C.accent}10`}}
                  onMouseLeave={e=>{e.currentTarget.style.background=i%2===0?C.white:'#f9fbf9'}}>
                  <td style={{padding:'8px 12px',fontWeight:800,color:C.darkGreen,fontSize:10}}>{eq.id}</td>
                  <td style={{padding:'8px 12px',fontWeight:700}}>{eq.name}</td>
                  <td style={{padding:'8px 12px',color:C.gray}}>{eq.brand}</td>
                  <td style={{padding:'8px 12px',color:C.dark}}>{eq.price?fmt(eq.price):'—'}</td>
                  <td style={{padding:'8px 12px',color:C.dark}}>{eq.quantity??1}</td>
                  <td style={{padding:'8px 12px',color:C.gray}}>{eq.date_acquired||'—'}</td>
                  <td style={{padding:'8px 12px'}}><StatusBadge status={eq.status}/></td>
                  <td style={{padding:'8px 12px',color:C.gray}}>{eq.assigned_to||'—'}</td>
                  <td style={{padding:'8px 12px',color:C.gray}}>{eq.last_maintenance||'—'}</td>
                  <td style={{padding:'8px 12px',fontWeight:700,color:daysColor}}>{days!==null?`${days}d`:'—'}</td>
                </tr>
              })}</tbody>
            </table>
          </div>
          {eqPageCount>1&&(
            <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:20}}>
              <button onClick={()=>{setEqPage(p=>Math.max(1,p-1));window.scrollTo({top:0,behavior:'smooth'})}} disabled={eqCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:eqCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:eqCurrentPage===1?'default':'pointer'}}>← Prev</button>
              <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {eqCurrentPage} of {eqPageCount}</span>
              <button onClick={()=>{setEqPage(p=>Math.min(eqPageCount,p+1));window.scrollTo({top:0,behavior:'smooth'})}} disabled={eqCurrentPage===eqPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:eqCurrentPage===eqPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:eqCurrentPage===eqPageCount?'default':'pointer'}}>Next →</button>
            </div>
          )}
        </>}
      </div>

      {/* Modal */}
      {showModal&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div ref={modalBodyRef} style={{background:C.white,borderRadius:14,width:'100%',maxWidth:520,maxHeight:'92vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
            <div style={{background:`linear-gradient(135deg,${C.dark},${C.darkGreen})`,padding:'18px 24px',borderRadius:'14px 14px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div><div style={{color:C.accent,fontSize:10,fontWeight:700,letterSpacing:2}}>GEMMN IRFE</div>
              <div style={{color:C.white,fontSize:16,fontWeight:900,letterSpacing:1.5,textTransform:'uppercase'}}>{selected?'Edit Equipment':'Add Equipment'}</div></div>
              <button onClick={()=>setShowModal(false)} style={{background:'rgba(255,255,255,0.1)',border:'none',color:C.white,width:32,height:32,borderRadius:'50%',cursor:'pointer',fontSize:16}}>✕</button>
            </div>
            <div style={{padding:24}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
                <Field label="Reference ID" value={form.id} onChange={()=>{}} disabled span/>
                <Field label="Equipment Name" value={form.name} onChange={f('name')} span/>
                <Field label="Brand / Manufacturer" value={form.brand} onChange={f('brand')}/>
                <Field label="Status" type="select" value={form.status} onChange={f('status')} options={['Available','In Use','Maintenance','Retired']}/>
                <Field label="Assigned To (Project/Person)" value={form.assigned_to} onChange={f('assigned_to')} span/>
                <Field label="Price (₱)" type="number" value={form.price} onChange={f('price')}/>
                <Field label="Quantity / Count" type="number" value={form.quantity} onChange={f('quantity')}/>
                <Field label="Date Acquired" type="date" value={form.date_acquired} onChange={f('date_acquired')}/>
                <Field label="Last Maintenance Date" type="date" value={form.last_maintenance} onChange={f('last_maintenance')}/>
              </div>

              {!selected && (
                <div style={{marginBottom:14}}>
                  <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:8}}>How was this acquired?</label>
                  <div style={{display:'flex',gap:8,marginBottom:acquisition==='financing'?12:0}}>
                    <button onClick={()=>setAcquisition('cash')} style={{flex:1,padding:'9px',fontSize:11,fontWeight:800,borderRadius:6,border:`1.5px solid ${acquisition==='cash'?C.accent:C.lightGray}`,background:acquisition==='cash'?`${C.accent}12`:C.white,color:acquisition==='cash'?C.accent:C.gray,cursor:'pointer'}}>💵 Cash Purchase</button>
                    <button onClick={()=>setAcquisition('financing')} style={{flex:1,padding:'9px',fontSize:11,fontWeight:800,borderRadius:6,border:`1.5px solid ${acquisition==='financing'?C.amber:C.lightGray}`,background:acquisition==='financing'?`${C.amber}12`:C.white,color:acquisition==='financing'?C.amber:C.gray,cursor:'pointer'}}>📄 Financing / Loan</button>
                  </div>
                  {acquisition==='financing' && (
                    <div style={{background:`${C.amber}08`,border:`1px solid ${C.amber}33`,borderRadius:8,padding:12,display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                      <Field label="Principal (₱)" type="number" value={loanForm.principal} onChange={(v:any)=>setLoanForm(p=>({...p,principal:v}))}/>
                      <Field label="Installment per Cutoff (₱)" type="number" value={loanForm.installment_amount} onChange={(v:any)=>setLoanForm(p=>({...p,installment_amount:v}))}/>
                      <Field label="Vendor/Financier" value={loanForm.vendor} onChange={(v:any)=>setLoanForm(p=>({...p,vendor:v}))}/>
                      <Field label="Date Acquired" type="date" value={loanForm.date_acquired} onChange={(v:any)=>setLoanForm(p=>({...p,date_acquired:v}))}/>
                      <div style={{gridColumn:'1/-1',fontSize:10,color:C.gray}}>💡 Record payments later through the Expenses module (category: "Equipment Financing") — the balance updates automatically.</div>
                    </div>
                  )}
                </div>
              )}

              {form.last_maintenance&&(()=>{
                const days=daysSince(form.last_maintenance)
                const color=days>180?C.red:days>90?C.amber:C.accent
                return <div style={{background:`${color}0a`,border:`1px solid ${color}33`,borderRadius:8,padding:'10px 14px',marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:11,color:C.gray}}>Days since last maintenance</span>
                  <span style={{fontSize:13,fontWeight:900,color}}>{days} days {days>180?'⚠ Overdue':days>90?'⚠ Due soon':'✓ OK'}</span>
                </div>
              })()}

              {selected && (
                <div style={{marginBottom:16,paddingTop:8,borderTop:`1px solid ${C.lightGray}`}}>
                  <div style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',margin:'10px 0'}}>Occupancy — Project Assignments</div>
                  {assignments.length===0
                    ? <div style={{fontSize:11,color:C.gray,fontStyle:'italic',marginBottom:10}}>Not currently assigned to any project.</div>
                    : <>
                    <div style={{fontSize:10,color:C.gray,fontWeight:700,marginBottom:8}}>
                      {`Showing ${(assignCurrentPage-1)*ASSIGN_PAGE_SIZE+1}–${Math.min(assignCurrentPage*ASSIGN_PAGE_SIZE, assignments.length)} of ${assignments.length}`}
                    </div>
                    {pagedAssignments.map(a=>{
                      const proj = activeProjects.find(p=>p.po_number===a.po_number)
                      const isCurrent = !a.end_date
                      return (
                        <div key={a.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',border:`1px solid ${isCurrent?C.accent:C.lightGray}`,background:isCurrent?`${C.accent}0a`:'transparent',borderRadius:8,padding:'8px 12px',marginBottom:6}}>
                          <div>
                            <div style={{fontSize:12,fontWeight:800,color:isCurrent?C.accent:C.dark}}>{a.po_number} {proj?.name && <span style={{fontWeight:600,color:C.gray}}>— {proj.name}</span>} {isCurrent && <span style={{fontSize:9,color:C.accent}}>● CURRENT</span>}</div>
                            <div style={{fontSize:10,color:C.gray}}>{a.operator_name ? `Operator: ${a.operator_name} · ` : ''}{a.start_date}{a.end_date ? ` to ${a.end_date}` : ' (ongoing)'}</div>
                          </div>
                          <div style={{display:'flex',gap:6}}>
                            {isCurrent && canEdit && <button onClick={()=>endAssignment(a.id,selected.id)} style={{background:`${C.amber}18`,border:`1px solid ${C.amber}44`,color:C.amber,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:9,fontWeight:700}}>End Assignment</button>}
                            {canEdit && <button onClick={()=>deleteAssignment(a.id,selected.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:9,fontWeight:700}}>✕</button>}
                          </div>
                        </div>
                      )
                    })}
                    {assignPageCount > 1 && (
                      <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:8,marginBottom:10}}>
                        <button onClick={()=>setAssignPage(p=>Math.max(1,p-1))} disabled={assignCurrentPage===1} style={{padding:'5px 12px',borderRadius:6,border:`1.5px solid ${C.lightGray}`,background:C.white,color:assignCurrentPage===1?C.lightGray:C.dark,fontSize:10,fontWeight:700,cursor:assignCurrentPage===1?'default':'pointer'}}>← Prev</button>
                        <span style={{fontSize:10,fontWeight:700,color:C.gray}}>Page {assignCurrentPage} of {assignPageCount}</span>
                        <button onClick={()=>setAssignPage(p=>Math.min(assignPageCount,p+1))} disabled={assignCurrentPage===assignPageCount} style={{padding:'5px 12px',borderRadius:6,border:`1.5px solid ${C.lightGray}`,background:C.white,color:assignCurrentPage===assignPageCount?C.lightGray:C.dark,fontSize:10,fontWeight:700,cursor:assignCurrentPage===assignPageCount?'default':'pointer'}}>Next →</button>
                      </div>
                    )}
                    </>}
                  {canEdit && (
                    <div style={{background:'#f9fbf9',border:`1px solid ${C.lightGray}`,borderRadius:8,padding:12,marginTop:8}}>
                      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:8,marginBottom:8}}>
                        <select value={assignForm.po_number} onChange={e=>setAssignForm(p=>({...p,po_number:e.target.value}))} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}>
                          <option value="">Select project (PO)…</option>
                          {activeProjects.map(p=><option key={p.po_number} value={p.po_number}>{p.po_number} — {p.name || p.client}</option>)}
                        </select>
                        <input value={assignForm.operator_name} onChange={e=>setAssignForm(p=>({...p,operator_name:e.target.value.toUpperCase()}))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setAssignForm(p=>({...p,operator_name:'N/A'}))}} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                      </div>
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:8}}>
                        <input type="date" value={assignForm.start_date} onChange={e=>setAssignForm(p=>({...p,start_date:e.target.value}))} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                        <input type="number" value={assignForm.daily_rate} onChange={e=>setAssignForm(p=>({...p,daily_rate:e.target.value}))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setAssignForm(p=>({...p,daily_rate:'0'}))}} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                        <button onClick={()=>saveAssignment(selected.id)} style={{padding:'7px 12px',background:C.accent,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:700,cursor:'pointer'}}>+ Assign</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {error&&<div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
                {selected&&canEdit&&<button onClick={remove} disabled={saving} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.red}`,background:'transparent',color:C.red,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Delete</button>}
                <button onClick={()=>setShowModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Cancel</button>
                {canEdit&&<button onClick={save} disabled={saving} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',boxShadow:`0 3px 10px ${C.accent}44`}}>{saving?'Saving…':'Save Equipment'}</button>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loan Payment History */}
      {loanHistoryFor&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div style={{background:C.white,borderRadius:14,width:'100%',maxWidth:480,maxHeight:'85vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
            <div style={{background:`linear-gradient(135deg,${C.dark},${C.darkGreen})`,padding:'18px 24px',borderRadius:'14px 14px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{color:C.white,fontSize:15,fontWeight:900}}>Payment History — {loanHistoryFor.id}</div>
              <button onClick={()=>setLoanHistoryFor(null)} style={{background:'rgba(255,255,255,0.1)',border:'none',color:C.white,width:32,height:32,borderRadius:'50%',cursor:'pointer',fontSize:16}}>✕</button>
            </div>
            <div style={{padding:20}}>
              <div style={{background:`${C.accent}08`,borderRadius:8,padding:'10px 14px',marginBottom:14,display:'flex',justifyContent:'space-between'}}>
                <span style={{fontSize:11,color:C.gray}}>Remaining Balance</span>
                <span style={{fontSize:14,fontWeight:900,color:loanHistoryFor.status==='Fully Paid'?C.accent:C.amber}}>{fmt(loanHistoryFor.balance)}</span>
              </div>
              {loanHistoryFor.status==='Financing' && canEdit && (
                <button onClick={()=>{setShowLoanPayModal(loanHistoryFor);setLoanHistoryFor(null)}} style={{width:'100%',padding:'9px',fontSize:11,fontWeight:800,background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:6,cursor:'pointer',marginBottom:14}}>+ Record Manual Payment</button>
              )}
              {loanHistory.length===0?<div style={{textAlign:'center',padding:20,color:C.gray,fontSize:12}}>No payments recorded yet.</div>
              :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:C.lightGray}}>
                  {['Date','Amount','Source'].map(h=><th key={h} style={{padding:'7px 10px',textAlign:'left',fontWeight:800}}>{h}</th>)}
                </tr></thead>
                <tbody>{loanHistory.map(p=>(
                  <tr key={p.id} style={{borderBottom:`1px solid ${C.lightGray}`}}>
                    <td style={{padding:'6px 10px'}}>{p.date}</td>
                    <td style={{padding:'6px 10px',fontWeight:700}}>{fmt(p.amount)}</td>
                    <td style={{padding:'6px 10px',color:C.gray}}>{p.expense_id?`Expense ${p.expense_id}`:p.method}</td>
                  </tr>
                ))}</tbody>
              </table>}
            </div>
          </div>
        </div>
      )}

      {/* Manual Loan Payment */}
      {showLoanPayModal&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div style={{background:C.white,borderRadius:14,width:'100%',maxWidth:420,boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
            <div style={{background:`linear-gradient(135deg,${C.dark},${C.darkGreen})`,padding:'18px 24px',borderRadius:'14px 14px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{color:C.white,fontSize:15,fontWeight:900}}>Record Payment — {showLoanPayModal.id}</div>
              <button onClick={()=>setShowLoanPayModal(null)} style={{background:'rgba(255,255,255,0.1)',border:'none',color:C.white,width:32,height:32,borderRadius:'50%',cursor:'pointer',fontSize:16}}>✕</button>
            </div>
            <div style={{padding:20}}>
              <div style={{fontSize:12,color:C.gray,marginBottom:14}}>Balance: <b style={{color:C.dark}}>{fmt(showLoanPayModal.balance)}</b></div>
              <Field label="Payment Amount (₱)" type="number" value={loanPayAmount} onChange={(v:any)=>setLoanPayAmount(v)}/>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:10}}>
                <button onClick={()=>setShowLoanPayModal(null)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
                <button onClick={recordLoanPayment} disabled={loanSaving||!loanPayAmount} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>{loanSaving?'Saving…':'Record Payment'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}