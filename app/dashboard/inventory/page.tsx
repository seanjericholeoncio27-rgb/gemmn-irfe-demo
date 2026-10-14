'use client'
import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'
import { usePermissions } from '@/lib/permissions'
import type { InventoryItem } from '@/app/types/index'

const C={darkGreen:'#1a4d2e',midGreen:'#2d6a4f',accent:'#39b54a',white:'#ffffff',dark:'#0d1f14',gray:'#6b7c72',lightGray:'#e8ede9',red:'#e53e3e',amber:'#d97706',blue:'#2563eb'}
const fmt=(n:number)=>`₱${Number(n||0).toLocaleString('en-PH',{minimumFractionDigits:2})}`
const UNIT_OPTIONS = ['PCS', 'LOT', 'SET', 'KG', 'M', 'FT', 'ROLL', 'BOX', 'UNIT']

const BLANK:Omit<InventoryItem,'id'>={name:'',unit:'',quantity:0,min_stock:0,unit_cost:0,supplier:'',category:''}
const CATEGORY_SUGGESTIONS = ['ENDMILL','BOLTS, NUTS & WASHERS','LATHE MATERIALS','FABRICATION CONSUMABLES','TOOLS & MATERIALS','TUNGATIP','DRILL BITS','USED MATERIALS','MOMAX','SUS MATERIALS']
const inputStyle:React.CSSProperties={width:'100%',padding:'9px 12px',border:'1.5px solid #e8ede9',borderRadius:6,fontSize:13,fontFamily:'inherit',color:'#0d1f14',background:'#fafcfb',boxSizing:'border-box',outline:'none'}

function Field({label,type='text',value,onChange,options,placeholder,span,disabled,hint}:any){
  const ll=(label||'').toLowerCase()
  const skipCase=/notes|remarks|description|comment|email|password|login/.test(ll)
  const rawType=type==='date'||type==='time'
  const handleChange=(e:any)=>{
    if(rawType) return onChange(e.target.value)
    if(type==='number') return onChange(e.target.value)
    onChange(skipCase?e.target.value:e.target.value.toUpperCase())
  }
  const handleFocus=(e:any)=>{ if(!disabled && !rawType) e.target.select() }
  const handleBlur=(e:any)=>{
    if(disabled||rawType) return
    if(type==='number'){ if(!e.target.value.trim()) onChange('0') }
    else { if(!e.target.value.trim()) onChange('N/A') }
  }
  return(
    <div style={{marginBottom:14,gridColumn:span?'1/-1':'auto'}}>
      <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>{label}</label>
      {type==='select'
        ?<select value={value} onChange={e=>onChange(e.target.value)} style={inputStyle} disabled={disabled}><option value="">Select…</option>{options.map((o:any)=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}</select>
        :<input type={type} value={value} onChange={handleChange} onFocus={handleFocus} onBlur={handleBlur} placeholder={rawType?placeholder:undefined} style={{...inputStyle,background:disabled?'#f4f7f5':inputStyle.background}} disabled={disabled}/>}
      {hint && <div style={{fontSize:10,color:C.gray,marginTop:4}}>{hint}</div>}
    </div>
  )
}

function StockBadge({qty,min}:{qty:number,min:number}){
  const pct=min>0?qty/min*100:100
  const color=pct<60?C.red:pct<100?C.amber:C.accent
  const label=pct<60?'Critical':pct<100?'Low':'OK'
  return <span style={{padding:'3px 10px',borderRadius:20,background:`${color}22`,color,fontSize:10,fontWeight:800,border:`1px solid ${color}44`,whiteSpace:'nowrap'}}>{label}</span>
}

// Duplicate-detection key: case, spaces, hyphens and punctuation are all
// ignored, so "Steel Plate 5mm", "STEEL-PLATE 5 MM" and "steel plate 5mm" are
// the same material. Must stay in sync with the unique index in
// inventory_merge_duplicates.sql (regexp_replace(lower(name),'[^a-z0-9]','','g')).
const materialKey = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Derives the next material ID from the highest existing suffix rather than
// array length, so it can't collide after a deletion shifts the count down.
function nextMaterialId(items: InventoryItem[]) {
  const nums = items
    .map(i => { const m = /MAT-(\d+)/.exec(i.id); return m ? Number(m[1]) : null })
    .filter((n): n is number => n !== null)
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `MAT-${String(next).padStart(3, '0')}`
}

export default function InventoryPage(){
  const supabase=createClient()
  const canEdit = usePermissions().canEditModule('inventory')
  const [tab,setTab]=useState<'registry'|'release'|'excess'|'receiving'>('registry')
  const [items,setItems]=useState<InventoryItem[]>([])
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [showModal,setShowModal]=useState(false)
  const [selected,setSelected]=useState<InventoryItem|null>(null)
  const [form,setForm]=useState<any>(BLANK)
  const [error,setError]=useState('')
  const [search,setSearch]=useState('')
  const [catFilter,setCatFilter]=useState('All')
  const [relCatFilter,setRelCatFilter]=useState('All')
  const PAGE_SIZE = 50
  const [registryPage,setRegistryPage]=useState(1)
  const [releasePage,setReleasePage]=useState(1)
  const [excessPage,setExcessPage]=useState(1)
  const f=(k:string)=>(v:any)=>setForm((p:any)=>({...p,[k]:v}))

  // For Material Release dropdowns — replaces free-text PO/requestor entry
  const [employees,setEmployees]=useState<any[]>([])
  const [activeProjects,setActiveProjects]=useState<any[]>([])
  useEffect(()=>{
    supabase.from('employees').select('id,name').eq('status','Active').order('name').then(({data})=>setEmployees(data||[]))
    supabase.from('projects').select('po_number,name,client').not('po_number','is',null).order('po_number').then(({data})=>setActiveProjects(data||[]))
  },[])

  // ── Receiving — the Tool Keeper checks in stock here; it reconciles
  // straight against Purchasing's open supplier POs rather than being a
  // separate free-form stock add. Same underlying tables Purchasing itself
  // uses (material_replenishments, purchase_orders, purchase_order_invoices,
  // expenses) so both entry points stay in sync automatically. ─────────────
  const [openSupplierPOs,setOpenSupplierPOs]=useState<any[]>([])
  const [suppliersForReceiving,setSuppliersForReceiving]=useState<any[]>([])
  const [receivingForm,setReceivingForm]=useState<Record<string,{qty:string,material_id?:string,newMaterialName?:string,newMaterialUnit?:string}>>({})
  const fetchOpenSupplierPOs = useCallback(async()=>{
    const {data} = await supabase.from('purchase_orders').select('*, purchase_order_items(*)').in('status',['Released','Partially Delivered','Delivered','Partially Invoiced']).order('created_at',{ascending:false})
    setOpenSupplierPOs(data||[])
    const {data:sups} = await supabase.from('suppliers').select('*')
    setSuppliersForReceiving(sups||[])
  },[supabase])
  useEffect(()=>{ if(tab==='receiving') fetchOpenSupplierPOs() },[tab])

  // Receiving now happens per LINE ITEM, not per PO — a multi-line PO can
  // have different items arrive on different days (exactly like a real
  // supplier delivery), so each item tracks its own qty_received, and the
  // PO header's status is recomputed from all its items after each receipt.
  const receiveItem = async (order:any, item:any) => {
    const f = receivingForm[item.id]
    const remainingQty = Number(item.qty) - Number(item.qty_received||0)
    const qty = Number(f?.qty) || remainingQty
    if (qty <= 0 || qty > remainingQty + 0.0001) return alert(`Enter a quantity up to ${remainingQty} ${item.unit||''}.`)

    // Auto-match to an existing registered material by name as a default,
    // but the Tool Keeper can override via the dropdown, or register a
    // brand-new material right here if this delivery doesn't match anything.
    const autoMatched = items.find(i=>materialKey(i.name) === materialKey(item.material_name))
    let materialId = f?.material_id || autoMatched?.id || ''
    let materialName = items.find(i=>i.id===materialId)?.name

    if (materialId === '__new__') {
      // The name box is pre-filled with the PO line's material name, so use it as-is
      // when the user hasn't retyped it — no more "enter a name" error for text they can see.
      const typedName = (f?.newMaterialName ?? item.material_name ?? '').trim().toUpperCase()
      if (!typedName) return alert('Enter a name for the new material.')
      // Same wall as Add Material: a delivery of something already registered
      // must top up THAT material, never spawn a second line item for it.
      const existing = items.find(i=>materialKey(i.name) === materialKey(typedName))
      if (existing) return alert(`"${existing.name}" (${existing.id}) is already registered. Select it from the "Matches Registered Material" list instead of registering a duplicate.`)
      materialId = `MAT-${Date.now()}`
      materialName = typedName
      const { error: invErr } = await supabase.from('inventory').insert({
        id: materialId, name: materialName, unit: f?.newMaterialUnit || item.unit || '',
        quantity: 0, min_stock: 0, // starts at 0 — the replenishment below brings it to the real received qty
      })
      if (invErr) return alert(invErr.message)
    } else if (!materialId) {
      return alert('No matching registered material found — select one from the list, or choose "+ Register New Material".')
    }

    await supabase.from('material_replenishments').insert({
      material_id: materialId, material_name: materialName, qty, unit_cost: item.unit_price,
      po_number: order.po_number, purchase_order_id: order.id,
      date: new Date().toISOString().slice(0,10), notes: `Received via Inventory from Supplier PO ${order.id} — ${item.material_name}`,
    })
    const newQtyReceived = Number(item.qty_received||0) + qty
    const itemFullyReceived = newQtyReceived >= Number(item.qty) - 0.0001
    await supabase.from('purchase_order_items').update({ qty_received:newQtyReceived }).eq('id',item.id)

    // Invoice Number entry happens in Purchasing now, not here — receiving
    // is purely "did the goods arrive". But the linked Purchasing material
    // request DOES need to know THIS item arrived, so BOM fulfillment can
    // proceed on it — independent of whether the PO's other items have.
    if (item.material_request_id) {
      const { data: mr } = await supabase.from('material_requests').select('bom_id').eq('id', item.material_request_id).maybeSingle()
      if (itemFullyReceived) {
        await supabase.from('material_requests').update({ status: 'Fulfilled' }).eq('id', item.material_request_id)
      }
      // Auto-update the linked Project BOM line's fulfillment — same
      // qty_purchased/status logic already used when an excess return
      // reverses a release, just adding instead of subtracting.
      if (mr?.bom_id) {
        const { data: bomRow } = await supabase.from('project_bom').select('*').eq('id', mr.bom_id).maybeSingle()
        if (bomRow) {
          const newQtyPurchased = Number(bomRow.qty_purchased||0) + qty
          const newStatus = newQtyPurchased <= 0 ? 'Not Purchased' : newQtyPurchased >= Number(bomRow.qty_needed) ? 'Purchased' : 'Partial'
          await supabase.from('project_bom').update({ qty_purchased: newQtyPurchased, status: newStatus }).eq('id', mr.bom_id)
        }
      }
    }

    // Recompute the PO header's aggregate status from every item now that
    // this one has changed.
    const { data: freshItems } = await supabase.from('purchase_order_items').select('qty,qty_received').eq('purchase_order_id', order.id)
    const allFullyReceived = (freshItems||[]).every((i:any) => Number(i.qty_received||0) >= Number(i.qty) - 0.0001)
    const anyReceived = (freshItems||[]).some((i:any) => Number(i.qty_received||0) > 0)
    await supabase.from('purchase_orders').update({ status: allFullyReceived ? 'Delivered' : anyReceived ? 'Partially Delivered' : order.status }).eq('id', order.id)

    setReceivingForm(p=>({...p,[item.id]:{qty:''}}))
    await fetchOpenSupplierPOs(); await fetch()
  }

  // ── Ledgers: Release, Excess Returns ──────────────────────────────────────
  const [releases,setReleases]=useState<any[]>([])
  const [excessReturns,setExcessReturns]=useState<any[]>([])
  const fetchLedgers = useCallback(async()=>{
    // fetchAll — these ledgers grow unbounded over time, and PostgREST caps
    // any single request at 1000 rows (server-side, regardless of .range()),
    // so pulling the full table means paging through it in 1000-row batches.
    const [{data:rel},{data:exc}] = await Promise.all([
      fetchAllPages<any>((from, to) => supabase.from('material_releases').select('*').order('date',{ascending:false}).range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('material_excess_returns').select('*').order('date',{ascending:false}).range(from, to)),
    ])
    setReleases(rel||[]); setExcessReturns(exc||[])
  },[supabase])
  useEffect(()=>{ fetchLedgers() },[fetchLedgers])

  // Release form
  const [relForm,setRelForm]=useState({material_id:'',requestor:'',po_number:'',qty:'',date:new Date().toISOString().slice(0,10),notes:''})
  const [relUseExcess,setRelUseExcess]=useState<string|null>(null) // excess_return_id chosen, if any
  // Link a manual release to the project's BOM line so Projects' fulfillment stays in step
  const [relBomLines,setRelBomLines]=useState<any[]>([])
  const [relBomId,setRelBomId]=useState<string>('') // '' = not linked
  useEffect(()=>{
    let cancelled=false
    const po=relForm.po_number
    if(!po){ setRelBomLines([]); setRelBomId(''); return }
    supabase.from('project_bom').select('*').eq('po_number',po).then(({data})=>{ if(!cancelled) setRelBomLines(data||[]) })
    return ()=>{cancelled=true}
  },[relForm.po_number])
  const relBomCandidates=relBomLines.filter(b=>Number(b.qty_purchased||0)<Number(b.qty_needed||0)-0.0001)
  // Default to the BOM line whose description matches the chosen material
  useEffect(()=>{
    const mat=items.find(i=>i.id===relForm.material_id)
    if(!mat){ setRelBomId(''); return }
    const m=relBomCandidates.find(b=>materialKey(b.description)===materialKey(mat.name))
    setRelBomId(m?m.id:'')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[relForm.material_id,relBomLines])

  // Excess Return form
  const [excForm,setExcForm]=useState({release_id:'',qty_returned:'',date:new Date().toISOString().slice(0,10),notes:''})

  const fetch=useCallback(async()=>{
    setLoading(true)
    // fetchAll — this table already had a historical-data import land in one
    // batch (see byRecency below), and PostgREST caps any single request at
    // 1000 rows server-side regardless of .range(), so a plain select would
    // undercount every KPI tile above (Total Items / Critical / Low Stock)
    // the moment the table crosses that; page through it instead.
    const {data}=await fetchAllPages<any>((from, to) => supabase.from('inventory').select('*').order('created_at',{ascending:false}).range(from, to))
    if(data) setItems(data)
    setLoading(false)
  },[supabase])
  useEffect(()=>{fetch()},[fetch])

  const openNew=()=>{
    setForm({...BLANK, id: nextMaterialId(items)})
    setSelected(null);setError('');setShowModal(true)
  }
  const openEdit=(item:InventoryItem)=>{
    if(!canEdit) return
    setForm({...item});setSelected(item);setError('');setShowModal(true)
  }

  // Live duplicate check for the Add/Edit modal — the wall that stops a
  // top-up being keyed in as a brand-new "material".
  const duplicateOf = (name:string, excludeId?:string) => {
    const k = materialKey(name)
    if (!k) return undefined
    return items.find(i=>i.id!==excludeId && materialKey(i.name)===k)
  }
  const formDuplicate = showModal ? duplicateOf(form.name, selected?.id) : undefined

  const save=async()=>{
    setError('')
    if(!String(form.name||'').trim() || materialKey(form.name)==='' || materialKey(form.name)==='na') return setError('Enter the material name.')
    if(formDuplicate) return setError(`"${formDuplicate.name}" (${formDuplicate.id}) is already registered. Top it up through the Receiving tab instead of adding it again.`)
    setSaving(true)
    try{
      // Re-check against the live table, not just what this screen loaded —
      // someone else may have registered it since the page was opened.
      const {data:fresh}=await fetchAllPages<any>((from,to)=>supabase.from('inventory').select('id,name').range(from,to))
      const clash=(fresh||[]).find((r:any)=>r.id!==selected?.id && materialKey(r.name)===materialKey(form.name))
      if(clash) throw new Error(`"${clash.name}" (${clash.id}) is already registered. Top it up through the Receiving tab instead of adding it again.`)
      if(selected){
        const {error:e}=await supabase.from('inventory').update({
          name:form.name,unit:form.unit,quantity:form.quantity,
          min_stock:form.min_stock,unit_cost:form.unit_cost,supplier:form.supplier,category:form.category||null
        }).eq('id',selected.id)
        if(e) throw e
      } else {
        const {error:e}=await supabase.from('inventory').insert(form)
        if(e){
          if((e as any).code==='23505') throw new Error(String((e as any).message||'').includes('inventory_name_key')
            ? 'That material is already registered. Top it up through the Receiving tab instead of adding it again.'
            : `Reference "${form.id}" already exists. Please try saving again to get a fresh ID.`)
          throw e
        }
      }
      await fetch();setShowModal(false)
    } catch(err:any){setError(err.message)}
    setSaving(false)
  }

  const remove=async()=>{
    if(!selected) return;setSaving(true)
    const {error}=await supabase.from('inventory').delete().eq('id',selected.id)
    if(!error){await fetch();setShowModal(false)} else setError(error.message)
    setSaving(false)
  }

  // ── Excess pool lookup — used to prompt when releasing a material that has
  // returned-but-unused stock sitting from an earlier release ──────────────
  const excessPoolFor = (materialId:string) => excessReturns.filter(e=>e.material_id===materialId && Number(e.qty_remaining)>0)

  // ── Release (Requisition) ────────────────────────────────────────────────
  const saveRelease = async () => {
    setError('')
    const mat = items.find(i=>i.id===relForm.material_id)
    if (!mat) return setError('Select a material.')
    const qty = Number(relForm.qty)
    if (!qty || qty<=0) return setError('Enter a valid quantity.')
    if (!relForm.requestor.trim()) return setError('Requestor is required.')
    const availableStock = relUseExcess ? Number(excessReturns.find(e=>e.id===relUseExcess)?.qty_remaining||0) : Number(mat.quantity)
    if (qty > availableStock) return setError(`Only ${availableStock} ${mat.unit} available${relUseExcess?' in that excess pool':' in stock'}.`)
    setSaving(true)
    const { error } = await supabase.from('material_releases').insert({
      material_id: mat.id, material_name: mat.name, qty, unit: mat.unit,
      requestor: relForm.requestor.trim(), po_number: relForm.po_number.trim()||null,
      date: relForm.date, notes: relForm.notes||null,
      source: relUseExcess ? 'Excess Pool' : 'Fresh Stock',
      excess_return_id: relUseExcess,
      bom_id: relBomId || null,
    })
    if (error) setError(error.message)
    else {
      // Release counts toward the linked BOM line's fulfillment (reversed again if the release is deleted)
      if (relBomId) {
        const bomRow = relBomLines.find(b=>b.id===relBomId)
        if (bomRow) {
          const newQtyPurchased = Number(bomRow.qty_purchased||0) + qty
          const newStatus = newQtyPurchased >= Number(bomRow.qty_needed) ? 'Purchased' : 'Partial'
          await supabase.from('project_bom').update({ qty_purchased: newQtyPurchased, status: newStatus }).eq('id', relBomId)
        }
      }
      setRelBomId('')
      setRelForm({material_id:'',requestor:'',po_number:'',qty:'',date:new Date().toISOString().slice(0,10),notes:''})
      setRelUseExcess(null)
      await fetch(); await fetchLedgers()
    }
    setSaving(false)
  }
  const deleteRelease = async (id:string) => {
    if(!window.confirm('Delete this release? Stock (or excess pool) will be restored.')) return
    const { error } = await supabase.from('material_releases').delete().eq('id',id)
    if (error) alert(error.message)
    else { await fetch(); await fetchLedgers() }
  }
  const updateRelease = async (id:string, field:string, value:any) => {
    setReleases(p=>p.map(r=>r.id===id?{...r,[field]:value}:r))
    await supabase.from('material_releases').update({[field]:value}).eq('id',id)
    // qty edits don't retroactively adjust stock — safest path is delete+recreate for that
  }

  // ── Excess Return ─────────────────────────────────────────────────────────
  const saveExcessReturn = async () => {
    setError('')
    const release = releases.find(r=>r.id===excForm.release_id)
    if (!release) return setError('Select which release this excess is coming back from.')
    const qty = Number(excForm.qty_returned)
    if (!qty || qty<=0) return setError('Enter a valid quantity.')
    if (qty > Number(release.qty)) return setError(`Can't return more than the ${release.qty} ${release.unit} originally released.`)
    setSaving(true)
    const { error } = await supabase.from('material_excess_returns').insert({
      release_id: release.id, material_id: release.material_id, material_name: release.material_name,
      qty_returned: qty, qty_remaining: qty, po_number: release.po_number,
      date: excForm.date, notes: excForm.notes||null,
    })
    if (error) { setError(error.message); setSaving(false); return }

    // If this release came from a project's BOM fulfillment (drawn from
    // existing stock), returning it back means that BOM line is no longer
    // actually fulfilled by that amount — reverse it, floored at 0, so the
    // BOM doesn't keep showing material as Purchased that's since come back.
    if (release.bom_id) {
      const { data: bomRow } = await supabase.from('project_bom').select('*').eq('id', release.bom_id).maybeSingle()
      if (bomRow) {
        const newQtyPurchased = Math.max(0, Number(bomRow.qty_purchased||0) - qty)
        const newStatus = newQtyPurchased <= 0 ? 'Not Purchased' : newQtyPurchased >= Number(bomRow.qty_needed) ? 'Purchased' : 'Partial'
        await supabase.from('project_bom').update({ qty_purchased: newQtyPurchased, status: newStatus }).eq('id', release.bom_id)
      }
    }

    setExcForm({release_id:'',qty_returned:'',date:new Date().toISOString().slice(0,10),notes:''})
    await fetch(); await fetchLedgers()
    setSaving(false)
  }
  const deleteExcessReturn = async (id:string) => {
    if(!window.confirm('Delete this excess return? Stock will be reduced back down (blocked if any of it has already been reused).')) return
    const { error } = await supabase.from('material_excess_returns').delete().eq('id',id)
    if (error) alert(error.message.includes('already been reused') ? error.message.split('CONTEXT')[0] : error.message)
    else { await fetch(); await fetchLedgers() }
  }

  // Historical-data imports can land every row's created_at within the same
  // minute — there's no more meaningful date field on a material record, so
  // created_at is the fallback (not a compromise here, the intended sort key).
  const byRecency = (a:any,b:any) => {
    const ad = (a as any).created_at || ''
    const bd = (b as any).created_at || ''
    return bd.localeCompare(ad)
  }

  const filtered=items.filter(i=>i.name.toLowerCase().includes(search.toLowerCase())||i.supplier?.toLowerCase().includes(search.toLowerCase())).filter(i=>catFilter==='All'||((i.category&&i.category.trim())||'UNCATEGORIZED')===catFilter).slice().sort(byRecency)
  const critical=items.filter(i=>i.quantity<i.min_stock*0.6)
  const low=items.filter(i=>i.quantity>=i.min_stock*0.6&&i.quantity<i.min_stock)

  const suppliers = Array.from(new Set(items.map((i: any) => i.supplier).filter(Boolean))) as string[]
  const categories = Array.from(new Set(items.map(i=>(i.category&&i.category.trim())||'UNCATEGORIZED'))).sort()

  // Releases don't carry category directly — look it up via material_id
  // against the Registry, same UNCATEGORIZED fallback used there.
  const categoryForRelease = (r:any) => {
    const mat = items.find(i=>i.id===r.material_id)
    return (mat?.category && mat.category.trim()) || 'UNCATEGORIZED'
  }
  const releaseCategories = Array.from(new Set(releases.map(categoryForRelease))).sort()
  const byRecencyDate = (a:any,b:any) => {
    const ad = a.date || a.created_at || ''
    const bd = b.date || b.created_at || ''
    return bd.localeCompare(ad)
  }
  const filteredReleases = releases.filter(r=>relCatFilter==='All'||categoryForRelease(r)===relCatFilter).slice().sort(byRecencyDate)
  const sortedExcessReturns = excessReturns.slice().sort(byRecencyDate)

  // ── Pagination (Registry / Release / Excess Returns) ─────────────────────
  const registryPageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const registryCurrentPage = Math.min(registryPage, registryPageCount)
  const registryPaged = filtered.slice((registryCurrentPage-1)*PAGE_SIZE, registryCurrentPage*PAGE_SIZE)

  const releasePageCount = Math.max(1, Math.ceil(filteredReleases.length / PAGE_SIZE))
  const releaseCurrentPage = Math.min(releasePage, releasePageCount)
  const releasePaged = filteredReleases.slice((releaseCurrentPage-1)*PAGE_SIZE, releaseCurrentPage*PAGE_SIZE)

  const excessPageCount = Math.max(1, Math.ceil(sortedExcessReturns.length / PAGE_SIZE))
  const excessCurrentPage = Math.min(excessPage, excessPageCount)
  const excessPaged = sortedExcessReturns.slice((excessCurrentPage-1)*PAGE_SIZE, excessCurrentPage*PAGE_SIZE)

  useEffect(()=>{ setRegistryPage(1) },[search, catFilter])
  useEffect(()=>{ setReleasePage(1) },[relCatFilter])
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[registryPage, releasePage, excessPage])

  return (
    <div>
      {/* Tabs */}
      <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
        {(['registry','release','excess','receiving'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'8px 18px',borderRadius:6,border:`1.5px solid ${tab===t?C.accent:C.lightGray}`,background:tab===t?C.accent:C.white,color:tab===t?C.white:C.gray,fontSize:11,fontWeight:800,cursor:'pointer',fontFamily:'inherit',letterSpacing:1,textTransform:'uppercase',transition:'all 0.2s'}}>
            {({registry:'Materials Registry',release:'Material Release',excess:'Excess Returns',receiving:'Receiving'})[t]}
          </button>
        ))}
      </div>

      {/* KPIs */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginBottom:22}}>
        {([['Total Items',items.length,'material types',C.accent],['Critical Stock',critical.length,'below 60% min',C.red],['Low Stock',low.length,'below minimum',C.amber]] as any[]).map(([l,v,s,c])=>(
          <div key={l} style={{background:C.white,borderRadius:12,padding:'18px 22px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',borderTop:`4px solid ${c}`}}>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:2,color:C.gray,textTransform:'uppercase'}}>{l}</div>
            <div style={{fontSize:22,fontWeight:900,color:C.dark,marginTop:4}}>{v}</div>
            <div style={{fontSize:11,color:C.gray,marginTop:2}}>{s}</div>
          </div>
        ))}
      </div>

      {tab==='registry' && (<>
      {/* Critical Alerts */}
      {critical.length>0&&(
        <div style={{background:`${C.red}0a`,border:`1.5px solid ${C.red}33`,borderRadius:12,padding:'14px 20px',marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:C.red,letterSpacing:1,textTransform:'uppercase',marginBottom:8}}>⚠ Critical Stock Alert</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
            {critical.map(i=>(
              <span key={i.id} style={{padding:'4px 12px',borderRadius:20,background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,fontSize:11,fontWeight:700}}>
                {i.name} — {i.quantity} {i.unit} left
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Category tabs */}
      {categories.length>0 && (
        <div style={{display:'flex',gap:6,marginBottom:14,flexWrap:'wrap'}}>
          {['All',...categories].map(c=>{
            const count = c==='All' ? items.length : items.filter(i=>((i.category&&i.category.trim())||'UNCATEGORIZED')===c).length
            return (
              <button key={c} onClick={()=>setCatFilter(c)} style={{padding:'7px 14px',borderRadius:20,border:`1.5px solid ${catFilter===c?C.accent:C.lightGray}`,background:catFilter===c?C.accent:C.white,color:catFilter===c?C.white:C.gray,fontSize:10,fontWeight:800,cursor:'pointer',fontFamily:'inherit',letterSpacing:0.5,whiteSpace:'nowrap'}}>{c} ({count})</button>
            )
          })}
        </div>
      )}

      {/* Table */}
      <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18,flexWrap:'wrap',gap:10}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
            <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Materials Inventory</h2>
          </div>
          <div style={{display:'flex',gap:10,alignItems:'center'}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search materials or supplier…"
              style={{padding:'8px 14px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',color:C.dark,outline:'none',width:220}}/>
            {canEdit&&<button onClick={openNew} style={{padding:'9px 20px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit',boxShadow:`0 3px 10px ${C.accent}44`,whiteSpace:'nowrap'}}>+ Add Material</button>}
          </div>
        </div>

        {loading?<div style={{textAlign:'center',padding:40,color:C.gray}}>Loading inventory…</div>
        :filtered.length===0?<div style={{textAlign:'center',padding:40,color:C.gray}}>No materials found.</div>
        :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
          <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
            {['ID','Material Name','Category','Unit','Qty','Min Stock','Stock Level','Supplier','Status'].map(h=>(
              <th key={h} style={{padding:'9px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>{registryPaged.map((item,i)=>{
            const pct=item.min_stock>0?Math.min(100,Math.round(item.quantity/item.min_stock*100)):100
            const barColor=pct<60?C.red:pct<100?C.amber:C.accent
            return <tr key={item.id}
              onClick={()=>openEdit(item)}
              style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`,cursor:canEdit?'pointer':'default'}}
              onMouseEnter={e=>{if(canEdit)e.currentTarget.style.background=`${C.accent}10`}}
              onMouseLeave={e=>{e.currentTarget.style.background=i%2===0?C.white:'#f9fbf9'}}>
              <td style={{padding:'9px 12px',fontWeight:800,color:C.darkGreen,fontSize:10}}>{item.id}</td>
              <td style={{padding:'9px 12px',fontWeight:700}}>{item.name}</td>
              <td style={{padding:'9px 12px',color:C.gray,fontSize:11}}>{(item.category&&item.category.trim())||'—'}</td>
              <td style={{padding:'9px 12px',color:C.gray}}>{item.unit}</td>
              <td style={{padding:'9px 12px',fontWeight:800,color:item.quantity<item.min_stock?C.red:C.dark}}>{item.quantity}</td>
              <td style={{padding:'9px 12px',color:C.gray}}>{item.min_stock}</td>
              <td style={{padding:'9px 12px',minWidth:120}}>
                <div style={{display:'flex',alignItems:'center',gap:6}}>
                  <div style={{flex:1,background:C.lightGray,borderRadius:4,height:8,overflow:'hidden'}}>
                    <div style={{width:`${pct}%`,height:'100%',background:`linear-gradient(90deg,${barColor},${barColor}cc)`,borderRadius:4,transition:'width 0.5s'}}/>
                  </div>
                  <span style={{fontSize:10,fontWeight:700,color:barColor,minWidth:28}}>{pct}%</span>
                </div>
              </td>
              <td style={{padding:'9px 12px',color:C.gray,fontSize:11}}>{item.supplier}</td>
              <td style={{padding:'9px 12px'}}><StockBadge qty={item.quantity} min={item.min_stock}/></td>
            </tr>
          })}</tbody>
        </table>}

        {!loading && filtered.length>0 && (
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14,flexWrap:'wrap',gap:10}}>
            <div style={{fontSize:11,color:C.gray,fontWeight:700}}>
              Showing {(registryCurrentPage-1)*PAGE_SIZE+1}–{Math.min(registryCurrentPage*PAGE_SIZE, filtered.length)} of {filtered.length}
            </div>
            {registryPageCount>1 && (
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <button onClick={()=>setRegistryPage(p=>Math.max(1,p-1))} disabled={registryCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:registryCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:registryCurrentPage===1?'default':'pointer'}}>← Prev</button>
                <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {registryCurrentPage} of {registryPageCount}</span>
                <button onClick={()=>setRegistryPage(p=>Math.min(registryPageCount,p+1))} disabled={registryCurrentPage===registryPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:registryCurrentPage===registryPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:registryCurrentPage===registryPageCount?'default':'pointer'}}>Next →</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Supplier Summary */}
      {suppliers.length>0&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',marginTop:18}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
            <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
            <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Supplier Summary</h2>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:12}}>
            {suppliers.map(sup=>{
              const supItems=items.filter(i=>i.supplier===sup)
              const supValue=supItems.reduce((s,i)=>s+i.quantity*i.unit_cost,0)
              return(
                <div key={sup} style={{border:`1.5px solid ${C.lightGray}`,borderRadius:8,padding:'14px 16px'}}>
                  <div style={{fontWeight:800,fontSize:12,color:C.dark,marginBottom:6}}>{sup}</div>
                  <div style={{fontSize:11,color:C.gray}}>{supItems.length} material types</div>
                  <div style={{fontSize:13,fontWeight:900,color:C.accent,marginTop:4}}>{fmt(supValue)}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Modal */}
      {showModal&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div style={{background:C.white,borderRadius:14,width:'100%',maxWidth:540,maxHeight:'92vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
            <div style={{background:`linear-gradient(135deg,${C.dark},${C.darkGreen})`,padding:'18px 24px',borderRadius:'14px 14px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div><div style={{color:C.accent,fontSize:10,fontWeight:700,letterSpacing:2}}>GEMMN IRFE</div>
              <div style={{color:C.white,fontSize:16,fontWeight:900,letterSpacing:1.5,textTransform:'uppercase'}}>{selected?'Edit Material':'Add Material'}</div></div>
              <button onClick={()=>setShowModal(false)} style={{background:'rgba(255,255,255,0.1)',border:'none',color:C.white,width:32,height:32,borderRadius:'50%',cursor:'pointer',fontSize:16}}>✕</button>
            </div>
            <div style={{padding:24}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
                <Field label="Reference ID" value={form.id} onChange={()=>{}} disabled/>
                <Field label="Material Name" value={form.name} onChange={f('name')} placeholder="e.g. Steel Plate 5mm" span/>
                <Field label="Category" value={form.category} onChange={f('category')} placeholder="e.g. Endmill, Lathe Materials" hint="Groups this item into a tab on the Materials Registry."/>
                <Field label="Unit of Measure" type="select" value={form.unit} onChange={f('unit')} options={UNIT_OPTIONS}/>
                <Field label="Supplier" value={form.supplier} onChange={f('supplier')} placeholder="Supplier name"/>
                <Field label="Current Quantity" type="number" value={form.quantity} onChange={f('quantity')} disabled={!!selected}
                  hint={selected ? 'Locked — adjust via Release/Excess Return/Replenish so the ledger stays accurate.' : 'Starting quantity for a brand-new material.'}/>
                <Field label="Minimum Stock Level" type="number" value={form.min_stock} onChange={f('min_stock')}/>
              </div>
              <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:14,marginTop:-6}}>
                {CATEGORY_SUGGESTIONS.map(c=>(
                  <button key={c} type="button" onClick={()=>f('category')(c)} style={{padding:'3px 10px',borderRadius:20,border:`1px solid ${C.lightGray}`,background:form.category===c?`${C.accent}18`:C.white,color:form.category===c?C.accent:C.gray,fontSize:9,fontWeight:700,cursor:'pointer'}}>{c}</button>
                ))}
              </div>
              <div style={{background:'#f4f7f5',borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:11,color:C.gray}}>
                Cost and pricing are managed in the Purchasing module — Inventory only tracks quantity on hand.
              </div>
              {!selected && !formDuplicate && (
                <div style={{background:`${C.amber}12`,border:`1px solid ${C.amber}44`,borderRadius:6,padding:'10px 14px',fontSize:11,color:C.amber,marginBottom:14,fontWeight:700}}>
                  Only for materials that are NOT in the registry yet. Restocking an existing material? Don't add it here — check it in under the Receiving tab.
                </div>
              )}
              {formDuplicate && (
                <div style={{background:`${C.red}12`,border:`2px solid ${C.red}`,borderRadius:8,padding:'12px 14px',fontSize:12,color:C.red,marginBottom:14}}>
                  <div style={{fontWeight:900,marginBottom:4}}>{selected?'Another material already has this name':'This material is already registered'}</div>
                  <div style={{color:C.dark,fontSize:12}}><b>{formDuplicate.name}</b> ({formDuplicate.id}) — {formDuplicate.quantity} {formDuplicate.unit} in stock. {selected?'Pick a different name, or delete one of the two if they are the same item.':'Adding it again would create a duplicate line item and split its stock.'}</div>
                  {!selected && (
                    <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
                      <button type="button" onClick={()=>{setShowModal(false);setTab('receiving')}} style={{padding:'7px 14px',fontSize:10,fontWeight:800,letterSpacing:1,border:'none',background:C.blue,color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Top up via Receiving</button>
                      <button type="button" onClick={()=>openEdit(formDuplicate)} style={{padding:'7px 14px',fontSize:10,fontWeight:800,letterSpacing:1,border:`2px solid ${C.red}`,background:'transparent',color:C.red,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Open existing material</button>
                    </div>
                  )}
                </div>
              )}
              {error&&<div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
                {selected&&canEdit&&<button onClick={remove} disabled={saving} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.red}`,background:'transparent',color:C.red,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Delete</button>}
                <button onClick={()=>setShowModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Cancel</button>
                {canEdit&&<button onClick={save} disabled={saving||!!formDuplicate} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:formDuplicate?C.gray:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:formDuplicate?'not-allowed':'pointer',opacity:formDuplicate?0.5:1,fontFamily:'inherit',textTransform:'uppercase',boxShadow:formDuplicate?'none':`0 3px 10px ${C.accent}44`}}>{saving?'Saving…':'Save Material'}</button>}
              </div>
            </div>
          </div>
        </div>
      )}
      </>)}

      {tab==='release' && (
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:18}}>
            <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
            <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Material Release (Requisition)</h2>
          </div>
          {canEdit && (
            <div style={{background:'#f9fbf9',border:`1px solid ${C.lightGray}`,borderRadius:10,padding:16,marginBottom:20}}>
              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr',gap:'0 14px'}}>
                <div style={{marginBottom:14}}>
                  <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Material</label>
                  <select value={relForm.material_id} onChange={e=>{setRelForm(p=>({...p,material_id:e.target.value})); setRelUseExcess(null)}} style={inputStyle}>
                    <option value="">Select material…</option>
                    {items.map(i=><option key={i.id} value={i.id}>{i.name} ({i.quantity} {i.unit} in stock)</option>)}
                  </select>
                </div>
                <Field label="Qty" type="number" value={relForm.qty} onChange={(v:any)=>setRelForm(p=>({...p,qty:v}))}/>
                <Field label="Date" type="date" value={relForm.date} onChange={(v:any)=>setRelForm(p=>({...p,date:v}))}/>
                <Field label="Requestor" type="select" value={relForm.requestor} onChange={(v:any)=>setRelForm(p=>({...p,requestor:v}))} options={employees.map(e=>({value:e.name, label:e.name}))}/>
                <Field label="Project / PO Number" type="select" value={relForm.po_number} onChange={(v:any)=>setRelForm(p=>({...p,po_number:v}))} options={activeProjects.map(p=>({value:p.po_number, label:`${p.po_number} — ${p.client||p.name}`}))}/>
                <Field label="Notes" value={relForm.notes} onChange={(v:any)=>setRelForm(p=>({...p,notes:v}))} placeholder="Optional"/>
              </div>
              {relForm.po_number && relForm.material_id && (
                <div style={{background:`${C.blue}0a`,border:`1px solid ${C.blue}33`,borderRadius:8,padding:'10px 14px',marginBottom:14}}>
                  <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.blue,textTransform:'uppercase',display:'block',marginBottom:5}}>Counts toward project BOM line</label>
                  {relBomCandidates.length===0
                    ? <div style={{fontSize:11,color:C.gray}}>No open BOM lines on {relForm.po_number} — this release won&apos;t update the project&apos;s fulfillment.</div>
                    : <select value={relBomId} onChange={e=>setRelBomId(e.target.value)} style={inputStyle}>
                        <option value="">Don&apos;t link to a BOM line</option>
                        {relBomCandidates.map(b=><option key={b.id} value={b.id}>{b.description}{b.dimension?` (${b.dimension})`:''} — {Number(b.qty_purchased||0)} of {b.qty_needed} {b.unit||''} fulfilled</option>)}
                      </select>}
                </div>
              )}
              {relForm.material_id && excessPoolFor(relForm.material_id).length>0 && (
                <div style={{background:`${C.amber}12`,border:`1px solid ${C.amber}44`,borderRadius:8,padding:'10px 14px',marginBottom:14}}>
                  <div style={{fontSize:11,fontWeight:800,color:C.amber,marginBottom:6}}>⚠ Excess available for this material — use it instead of fresh stock?</div>
                  {excessPoolFor(relForm.material_id).map(e=>(
                    <label key={e.id} style={{display:'flex',alignItems:'center',gap:8,fontSize:11,padding:'4px 0',cursor:'pointer'}}>
                      <input type="radio" name="excessPool" checked={relUseExcess===e.id} onChange={()=>setRelUseExcess(e.id)}/>
                      {e.qty_remaining} {items.find(i=>i.id===e.material_id)?.unit} remaining from release on {e.date}{e.po_number?` (PO ${e.po_number})`:''}
                    </label>
                  ))}
                  <label style={{display:'flex',alignItems:'center',gap:8,fontSize:11,padding:'4px 0',cursor:'pointer'}}>
                    <input type="radio" name="excessPool" checked={relUseExcess===null} onChange={()=>setRelUseExcess(null)}/>
                    No — draw from fresh stock
                  </label>
                </div>
              )}
              {error && <div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
              <button onClick={saveRelease} disabled={saving} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>{saving?'Saving…':'+ Log Release'}</button>
            </div>
          )}
          {releaseCategories.length>0 && (
            <div style={{display:'flex',gap:6,marginBottom:14,flexWrap:'wrap'}}>
              {['All',...releaseCategories].map(c=>{
                const count = c==='All' ? releases.length : releases.filter(r=>categoryForRelease(r)===c).length
                return (
                  <button key={c} onClick={()=>setRelCatFilter(c)} style={{padding:'7px 14px',borderRadius:20,border:`1.5px solid ${relCatFilter===c?C.accent:C.lightGray}`,background:relCatFilter===c?C.accent:C.white,color:relCatFilter===c?C.white:C.gray,fontSize:10,fontWeight:800,cursor:'pointer',fontFamily:'inherit',letterSpacing:0.5,whiteSpace:'nowrap'}}>{c} ({count})</button>
                )
              })}
            </div>
          )}
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
              {['Date','Material','Category','Qty','Requestor','Project/PO','Source','Notes',''].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
            </tr></thead>
            <tbody>{filteredReleases.length===0
              ? <tr><td colSpan={9} style={{textAlign:'center',padding:24,color:C.gray}}>No releases logged yet.</td></tr>
              : releasePaged.map((r,i)=>(
                <tr key={r.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                  <td style={{padding:'7px 10px',color:C.gray}}>{r.date}</td>
                  <td style={{padding:'7px 10px',fontWeight:700}}>{r.material_name}</td>
                  <td style={{padding:'7px 10px',color:C.gray,fontSize:11}}>{categoryForRelease(r)}</td>
                  <td style={{padding:'7px 10px',fontWeight:800}}>{r.qty} {r.unit}</td>
                  <td style={{padding:'7px 10px'}}>{r.requestor}</td>
                  <td style={{padding:'7px 10px',color:C.gray}}>{r.po_number||'—'}</td>
                  <td style={{padding:'7px 10px'}}><span style={{fontSize:9,fontWeight:700,color:r.source==='Excess Pool'?C.amber:C.blue}}>{r.source}</span></td>
                  <td style={{padding:'7px 10px',color:C.gray,fontSize:11}}>{r.notes||'—'}</td>
                  <td style={{padding:'7px 10px'}}>{canEdit && <button onClick={()=>deleteRelease(r.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:10,fontWeight:700}}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredReleases.length>0 && (
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14,flexWrap:'wrap',gap:10}}>
              <div style={{fontSize:11,color:C.gray,fontWeight:700}}>
                Showing {(releaseCurrentPage-1)*PAGE_SIZE+1}–{Math.min(releaseCurrentPage*PAGE_SIZE, filteredReleases.length)} of {filteredReleases.length}
              </div>
              {releasePageCount>1 && (
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <button onClick={()=>setReleasePage(p=>Math.max(1,p-1))} disabled={releaseCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:releaseCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:releaseCurrentPage===1?'default':'pointer'}}>← Prev</button>
                  <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {releaseCurrentPage} of {releasePageCount}</span>
                  <button onClick={()=>setReleasePage(p=>Math.min(releasePageCount,p+1))} disabled={releaseCurrentPage===releasePageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:releaseCurrentPage===releasePageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:releaseCurrentPage===releasePageCount?'default':'pointer'}}>Next →</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab==='excess' && (
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:18}}>
            <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.amber},${C.darkGreen})`,borderRadius:2}}/>
            <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Excess Returns</h2>
          </div>
          {canEdit && (
            <div style={{background:'#f9fbf9',border:`1px solid ${C.lightGray}`,borderRadius:10,padding:16,marginBottom:20}}>
              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr',gap:'0 14px'}}>
                <div style={{marginBottom:14,gridColumn:'1/-1'}}>
                  <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Original Release</label>
                  <select value={excForm.release_id} onChange={e=>setExcForm(p=>({...p,release_id:e.target.value}))} style={inputStyle}>
                    <option value="">Select the release this excess is coming back from…</option>
                    {releases.map(r=><option key={r.id} value={r.id}>{r.date} — {r.material_name} ({r.qty} {r.unit}) — {r.requestor}{r.po_number?` — PO ${r.po_number}`:''}</option>)}
                  </select>
                </div>
                <Field label="Qty Returned" type="number" value={excForm.qty_returned} onChange={(v:any)=>setExcForm(p=>({...p,qty_returned:v}))}/>
                <Field label="Date" type="date" value={excForm.date} onChange={(v:any)=>setExcForm(p=>({...p,date:v}))}/>
                <Field label="Notes" value={excForm.notes} onChange={(v:any)=>setExcForm(p=>({...p,notes:v}))} placeholder="Optional"/>
              </div>
              {error && <div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
              <button onClick={saveExcessReturn} disabled={saving} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>{saving?'Saving…':'+ Log Excess Return'}</button>
            </div>
          )}
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
              {['Date','Material','Qty Returned','Remaining','Project/PO','Notes',''].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
            </tr></thead>
            <tbody>{sortedExcessReturns.length===0
              ? <tr><td colSpan={7} style={{textAlign:'center',padding:24,color:C.gray}}>No excess returns logged yet.</td></tr>
              : excessPaged.map((r,i)=>(
                <tr key={r.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                  <td style={{padding:'7px 10px',color:C.gray}}>{r.date}</td>
                  <td style={{padding:'7px 10px',fontWeight:700}}>{r.material_name}</td>
                  <td style={{padding:'7px 10px',fontWeight:800}}>{r.qty_returned}</td>
                  <td style={{padding:'7px 10px',fontWeight:800,color:Number(r.qty_remaining)>0?C.accent:C.gray}}>{r.qty_remaining}{Number(r.qty_remaining)<Number(r.qty_returned) && Number(r.qty_remaining)>0 && <span style={{fontSize:9,color:C.amber}}> (partially reused)</span>}{Number(r.qty_remaining)===0 && <span style={{fontSize:9,color:C.gray}}> (fully reused)</span>}</td>
                  <td style={{padding:'7px 10px',color:C.gray}}>{r.po_number||'—'}</td>
                  <td style={{padding:'7px 10px',color:C.gray,fontSize:11}}>{r.notes||'—'}</td>
                  <td style={{padding:'7px 10px'}}>{canEdit && <button onClick={()=>deleteExcessReturn(r.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:10,fontWeight:700}}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {sortedExcessReturns.length>0 && (
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14,flexWrap:'wrap',gap:10}}>
              <div style={{fontSize:11,color:C.gray,fontWeight:700}}>
                Showing {(excessCurrentPage-1)*PAGE_SIZE+1}–{Math.min(excessCurrentPage*PAGE_SIZE, sortedExcessReturns.length)} of {sortedExcessReturns.length}
              </div>
              {excessPageCount>1 && (
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <button onClick={()=>setExcessPage(p=>Math.max(1,p-1))} disabled={excessCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:excessCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:excessCurrentPage===1?'default':'pointer'}}>← Prev</button>
                  <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {excessCurrentPage} of {excessPageCount}</span>
                  <button onClick={()=>setExcessPage(p=>Math.min(excessPageCount,p+1))} disabled={excessCurrentPage===excessPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:excessCurrentPage===excessPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:excessCurrentPage===excessPageCount?'default':'pointer'}}>Next →</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab==='receiving' && (
        <div>
          <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Check in deliveries against Purchasing's open supplier orders. Partial deliveries are fine — receive what's arrived now, the rest stays open for later. A multi-item PO can have items arrive on different days; each line is received independently.</div>
          {openSupplierPOs.length===0
            ? <div style={{background:C.white,borderRadius:12,padding:40,textAlign:'center',color:C.gray,boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>No open supplier orders awaiting delivery.</div>
            : openSupplierPOs.map(o=>{
              const sup = suppliersForReceiving.find(s=>s.id===o.supplier_id)
              const poItems = o.purchase_order_items||[]
              const total = poItems.reduce((s:number,i:any)=>s+Number(i.qty)*Number(i.unit_price),0)
              const totalReceived = poItems.reduce((s:number,i:any)=>s+Number(i.qty_received||0),0)
              const totalQty = poItems.reduce((s:number,i:any)=>s+Number(i.qty),0)
              return (
                <div key={o.id} style={{background:C.white,borderRadius:12,padding:'16px 20px',marginBottom:12,boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10,marginBottom:8}}>
                    <div>
                      <div style={{fontWeight:800,fontSize:13,color:C.darkGreen}}>{o.id} — {sup?.name||'—'}</div>
                      <div style={{fontSize:11,color:C.gray,marginTop:2}}>Received {totalReceived} of {totalQty} units (across {poItems.length} item{poItems.length===1?'':'s'}) · Invoiced {fmt(Number(o.amount_invoiced||0))} of {fmt(total)}</div>
                    </div>
                    <span style={{padding:'3px 12px',borderRadius:20,background:`${C.amber}18`,color:C.amber,fontSize:10,fontWeight:800}}>{o.status}</span>
                  </div>

                  {poItems.map((item:any)=>{
                    const remainingQty = Number(item.qty)-Number(item.qty_received||0)
                    const itemFullyReceived = remainingQty <= 0.0001
                    return (
                      <div key={item.id} style={{borderTop:`1px solid ${C.lightGray}`,paddingTop:10,marginTop:10}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                          <div style={{fontSize:12,fontWeight:700}}>{item.material_name}{item.dimension?` (${item.dimension})`:''}</div>
                          <div style={{fontSize:10,color:itemFullyReceived?C.accent:C.gray,fontWeight:itemFullyReceived?800:400}}>{Number(item.qty_received||0)} of {item.qty} {item.unit}</div>
                        </div>
                        {canEdit && (
                          <div style={{background:'#f9fbf9',borderRadius:8,padding:12}}>
                            {!itemFullyReceived && (
                              <>
                              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr auto',gap:8,alignItems:'end'}}>
                                <div>
                                  <label style={{fontSize:9,color:C.gray,fontWeight:700}}>Matches Registered Material</label>
                                  <select value={receivingForm[item.id]?.material_id ?? (items.find(i=>materialKey(i.name)===materialKey(item.material_name))?.id||'')} onChange={e=>setReceivingForm(p=>({...p,[item.id]:{...p[item.id],material_id:e.target.value}}))} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}>
                                    <option value="">Select…</option>
                                    <option value="__new__" style={{fontWeight:700,color:C.amber}}>+ Register New Material</option>
                                    {items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label style={{fontSize:9,color:C.gray,fontWeight:700}}>Qty Received Now ({remainingQty} {item.unit} remaining)</label>
                                  <input type="number" value={receivingForm[item.id]?.qty||''} onChange={e=>setReceivingForm(p=>({...p,[item.id]:{...p[item.id],qty:e.target.value}}))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim())setReceivingForm(p=>({...p,[item.id]:{...p[item.id],qty:'0'}}))}} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>
                                </div>
                                <button onClick={()=>receiveItem(o,item)} style={{padding:'8px 16px',background:C.blue,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:700,cursor:'pointer'}}>✓ Mark Received</button>
                              </div>
                              {receivingForm[item.id]?.material_id==='__new__' && (
                                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:10,background:`${C.amber}0a`,padding:10,borderRadius:6}}>
                                  <div>
                                    <label style={{fontSize:9,color:C.amber,fontWeight:700}}>New Material Name</label>
                                    <input value={receivingForm[item.id]?.newMaterialName ?? (item.material_name||'').toUpperCase()} onChange={e=>setReceivingForm(p=>({...p,[item.id]:{...p[item.id],newMaterialName:e.target.value.toUpperCase()}}))} onFocus={e=>e.target.select()} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>
                                  </div>
                                  <div>
                                    <label style={{fontSize:9,color:C.amber,fontWeight:700}}>Unit</label>
                                    <select value={receivingForm[item.id]?.newMaterialUnit ?? (item.unit||'')} onChange={e=>setReceivingForm(p=>({...p,[item.id]:{...p[item.id],newMaterialUnit:e.target.value}}))} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',boxSizing:'border-box'}}>
                                      <option value="">Unit…</option>
                                      {UNIT_OPTIONS.map(u=><option key={u} value={u}>{u}</option>)}
                                    </select>
                                  </div>
                                </div>
                              )}
                              </>
                            )}
                            {itemFullyReceived && (
                              <div style={{fontSize:11,color:C.accent,fontWeight:700}}>✓ Fully received</div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {poItems.every((i:any)=>Number(i.qty_received||0) >= Number(i.qty)-0.0001) && (
                    <div style={{fontSize:11,color:C.accent,fontWeight:700,marginTop:10}}>✓ All items fully received — invoice number is entered in Purchasing to close this out.</div>
                  )}
                </div>
              )
            })}
        </div>
      )}

    </div>
  )
}