'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'

const C={darkGreen:'#1a4d2e',midGreen:'#2d6a4f',accent:'#39b54a',limeGreen:'#4caf50',white:'#ffffff',dark:'#0d1f14',gray:'#6b7c72',lightGray:'#e8ede9',red:'#e53e3e',amber:'#d97706',blue:'#2563eb',purple:'#7c3aed'}
const fmt=(n:number)=>`₱${Number(n||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`

// ── Shared math, mirrored exactly from each module's own authoritative page ──
// This file had accumulated several of its own drifted copies of these
// calculations — some skipping vat_mode, one skipping discount_pct too, and
// two DIFFERENT quotation-total formulas disagreeing with each other within
// this same file. Every figure below now goes through one of these.
const VAT_RATE = 0.12
// Mirrors InvoicesPage's calcTotals(sum, vat_mode).
function grandTotal(sum: number, vat_mode: string | null | undefined) {
  if (vat_mode === 'included') return sum
  if (vat_mode === 'exempt') return sum
  return sum * (1 + VAT_RATE) // default 'excluded'
}
function itemsOnlySum(items: any[]) {
  return (items || []).filter((i: any) => i.kind === 'item').reduce((s: number, i: any) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0)
}
// Mirrors QuotationsPage's calcTotalsWithDiscount/calcTotals — discount off
// the item subtotal first, THEN VAT only for the default 'excluded' mode.
function quotationGrandTotal(q: any): number {
  const sum = itemsOnlySum(q.quotation_items || [])
  const discountAmount = sum * (Number(q.discount_pct) || 0) / 100
  return grandTotal(sum - discountAmount, q.vat_mode)
}
function invoiceGrandTotal(inv: any, items: any[]) {
  return grandTotal(itemsOnlySum(items), inv.vat_mode)
}
// Mirrors PayrollPage's calcGross/calcNet exactly.
function calcGross(emp: any, rec: any) {
  if (!emp) return 0
  const otPay = rec.overtime_pay != null ? Number(rec.overtime_pay) : Number(rec.overtime_hours || 0) * (Number(emp.rate) / 8 * 1.25)
  const base = emp.employment_type === 'Salaried' ? Number(emp.rate) / 2
    : rec.regular_pay != null ? Number(rec.regular_pay) : Number(emp.rate) * Number(rec.days_worked || 0)
  const extras = Number(rec.sunday_pay || 0) + Number(rec.night_diff_pay || 0) + Number(rec.regular_holiday_pay || 0) + Number(rec.special_holiday_pay || 0) + Number(rec.leave_pay || 0)
  return base + otPay + extras
}
function calcNet(emp: any, rec: any) {
  const gross = calcGross(emp, rec)
  const dedLines = (rec.deduction_lines || []).reduce((s: number, d: any) => s + Number(d?.amount || 0), 0)
  return gross + Number(rec.allowance || 0) - Number(rec.sss || 0) - Number(rec.philhealth || 0) - Number(rec.pagibig || 0) - Number(rec.tax || 0)
    - Number(rec.cash_advance_deduction || 0) - Number(rec.loan_deduction || 0) - Number(rec.company_deduction || 0) - Number(rec.other_deductions || 0) - dedLines
}
// Total deductions, matching everything calcNet actually subtracts — the
// standalone "Total Deductions" KPI previously only summed SSS+PhilHealth+
// Pagibig+Tax, so Gross − Deductions never equaled the Net column on the
// same screen whenever a loan/cash-advance/other deduction was present.
function totalDeductions(emp: any, rec: any) {
  const dedLines = (rec.deduction_lines || []).reduce((s: number, d: any) => s + Number(d?.amount || 0), 0)
  return Number(rec.sss || 0) + Number(rec.philhealth || 0) + Number(rec.pagibig || 0) + Number(rec.tax || 0)
    + Number(rec.cash_advance_deduction || 0) + Number(rec.loan_deduction || 0) + Number(rec.company_deduction || 0) + Number(rec.other_deductions || 0) + dedLines
}

// ── SHARED HOVER TOOLTIP ─────────────────────────────────────────────────────
// Every chart below uses this same mechanism so hover behavior is identical
// across the dashboard: a small dark tooltip that follows the cursor within
// the chart's bounding box, positioned via onMouseMove on chart elements.
function useChartTooltip() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; content: React.ReactNode } | null>(null)
  const show = (e: React.MouseEvent, content: React.ReactNode) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, content })
  }
  const hide = () => setTip(null)
  return { wrapRef, tip, show, hide }
}

function ChartTooltip({ tip }: { tip: { x: number; y: number; content: React.ReactNode } | null }) {
  if (!tip) return null
  return (
    <div style={{
      position: 'absolute', left: tip.x + 14, top: Math.max(0, tip.y - 12), zIndex: 60,
      background: C.dark, color: C.white, padding: '7px 11px', borderRadius: 7,
      fontSize: 11, fontWeight: 700, pointerEvents: 'none', whiteSpace: 'nowrap',
      boxShadow: '0 6px 18px rgba(0,0,0,0.3)', lineHeight: 1.5,
    }}>
      {tip.content}
    </div>
  )
}

// ── CHART COMPONENTS ────────────────────────────────────────────────────────

function BarChart({ data, height = 160, color = C.accent, label = '' }: { data: { label: string; value: number }[]; height?: number; color?: string; label?: string }) {
  const { wrapRef, tip, show, hide } = useChartTooltip()
  if (!data.length) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontSize: 12 }}>No data</div>
  const max = Math.max(...data.map(d => d.value), 1)
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {label && <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', marginBottom: 12 }}>{label}</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height, padding: '0 4px' }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.gray, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', textAlign: 'center' }}>
              {d.value > 0 ? fmt(d.value).slice(0, 8) : ''}
            </div>
            <div
              onMouseMove={e => show(e, <span>{d.label}: <b>{fmt(d.value)}</b></span>)}
              onMouseLeave={hide}
              style={{ width: '100%', height: `${Math.max(4, (d.value / max) * (height - 40))}px`, background: `linear-gradient(180deg,${color},${color}99)`, borderRadius: '4px 4px 0 0', transition: 'height 0.5s, opacity 0.15s', minHeight: 4, cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.75' }}
              onMouseOut={e => { e.currentTarget.style.opacity = '1' }}
            />
            <div style={{ fontSize: 9, fontWeight: 700, color: C.gray, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', textAlign: 'center' }}>{d.label}</div>
          </div>
        ))}
      </div>
      <ChartTooltip tip={tip} />
    </div>
  )
}

// Fixed-window grouped bar chart with a slider — does NOT grow wider as the
// date range expands. Instead it always shows `windowSize` bars and lets the
// user scrub through history via the range slider underneath.
function GroupedBar({ data, height = 160, colors = [C.accent, C.red], labels = ['Income', 'Expense'], windowSize = 6 }: { data: { label: string; a: number; b: number }[]; height?: number; colors?: string[]; labels?: string[]; windowSize?: number }) {
  const { wrapRef, tip, show, hide } = useChartTooltip()
  const [start, setStart] = useState(Math.max(0, data.length - windowSize))
  useEffect(() => { setStart(Math.max(0, data.length - windowSize)) }, [data.length])

  if (!data.length) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontSize: 12 }}>No data</div>

  const maxStart = Math.max(0, data.length - windowSize)
  const visible = data.slice(start, start + windowSize)
  const max = Math.max(...visible.flatMap(d => [d.a, d.b]), 1)

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 16 }}>
          {labels.map((l, i) => <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, color: C.gray }}><div style={{ width: 10, height: 10, borderRadius: 2, background: colors[i] }} />{l}</div>)}
        </div>
        {data.length > windowSize && (
          <div style={{ fontSize: 10, color: C.gray, fontWeight: 700 }}>
            Showing {visible[0]?.label} – {visible[visible.length - 1]?.label} of {data.length} periods
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height, padding: '0 2px' }}>
        {visible.map((d, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, width: '100%', height: height - 24, justifyContent: 'center' }}>
              {[d.a, d.b].map((v, j) => (
                <div key={j}
                  onMouseMove={e => show(e, <span>{d.label} — {labels[j]}: <b>{fmt(v)}</b></span>)}
                  onMouseLeave={hide}
                  style={{ flex: 1, height: `${Math.max(2, (v / max) * (height - 40))}px`, background: `linear-gradient(180deg,${colors[j]},${colors[j]}99)`, borderRadius: '3px 3px 0 0', transition: 'height 0.5s, opacity 0.15s', minHeight: 2, cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = '0.75' }}
                  onMouseOut={e => { e.currentTarget.style.opacity = '1' }}
                />
              ))}
            </div>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.gray, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', textAlign: 'center' }}>{d.label}</div>
          </div>
        ))}
      </div>
      {data.length > windowSize && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 9, color: C.gray, fontWeight: 700 }}>◀ Older</span>
          <input
            type="range" min={0} max={maxStart} value={start}
            onChange={e => setStart(Number(e.target.value))}
            style={{ flex: 1, accentColor: C.accent, cursor: 'pointer' }}
          />
          <span style={{ fontSize: 9, color: C.gray, fontWeight: 700 }}>Newer ▶</span>
        </div>
      )}
      <ChartTooltip tip={tip} />
    </div>
  )
}

function DonutChart({ data, size = 160 }: { data: { label: string; value: number; color: string }[]; size?: number }) {
  const { wrapRef, tip, show, hide } = useChartTooltip()
  const total = data.reduce((s, d) => s + d.value, 0)
  if (!total) return <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontSize: 12 }}>No data</div>
  const cx = size / 2, cy = size / 2, r = size * 0.38, inner = size * 0.24
  let angle = -Math.PI / 2
  const slices = data.map(d => {
    const sweep = (d.value / total) * Math.PI * 2
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle)
    angle += sweep
    const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle)
    const xi1 = cx + inner * Math.cos(angle - sweep), yi1 = cy + inner * Math.sin(angle - sweep)
    const xi2 = cx + inner * Math.cos(angle), yi2 = cy + inner * Math.sin(angle)
    const large = sweep > Math.PI ? 1 : 0
    return { ...d, path: `M${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} L${xi2},${yi2} A${inner},${inner} 0 ${large},0 ${xi1},${yi1} Z` }
  })
  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <svg width={size} height={size} style={{ flexShrink: 0 }}>
        {slices.map((s, i) => (
          <path key={i} d={s.path} fill={s.color} stroke={C.white} strokeWidth={2}
            onMouseMove={e => show(e, <span>{s.label}: <b>{fmt(s.value)}</b> ({total > 0 ? Math.round(s.value / total * 100) : 0}%)</span>)}
            onMouseLeave={hide}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '0.8' }}
            onMouseOut={e => { e.currentTarget.style.opacity = '1' }}
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={C.gray}>TOTAL</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize={9} fontWeight={900} fill={C.dark}>{fmt(total).slice(0, 9)}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 120 }}>
        {data.map((d, i) => (
          <div key={i}
            onMouseMove={e => show(e, <span>{d.label}: <b>{fmt(d.value)}</b> ({total > 0 ? Math.round(d.value / total * 100) : 0}%)</span>)}
            onMouseLeave={hide}
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', borderRadius: 6, padding: '2px 4px', transition: 'background 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f4f7f5' }}
            onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{ width: 10, height: 10, borderRadius: 2, background: d.color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.dark, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</div>
              <div style={{ fontSize: 10, color: C.gray }}>{fmt(d.value)} ({total > 0 ? Math.round(d.value / total * 100) : 0}%)</div>
            </div>
          </div>
        ))}
      </div>
      <ChartTooltip tip={tip} />
    </div>
  )
}

function LineChart({ data, height = 100, color = C.accent, label = '' }: { data: { label: string; value: number }[]; height?: number; color?: string; label?: string }) {
  const { wrapRef, tip, show, hide } = useChartTooltip()
  if (data.length < 2) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontSize: 12 }}>Not enough data</div>
  const w = 600, h = height, pad = 30
  const max = Math.max(...data.map(d => d.value), 1)
  const min = Math.min(...data.map(d => d.value), 0)
  const range = max - min || 1
  const pts = data.map((d, i) => ({
    x: pad + (i / (data.length - 1)) * (w - pad * 2),
    y: h - pad - ((d.value - min) / range) * (h - pad * 2),
    label: d.label, value: d.value,
  }))
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const areaD = `${pathD} L${pts[pts.length - 1].x},${h - pad} L${pts[0].x},${h - pad} Z`
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {label && <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', marginBottom: 8 }}>{label}</div>}
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height }} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`lg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#lg-${color.replace('#', '')})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={i}>
            <line x1={p.x} y1={pad} x2={p.x} y2={h - pad} stroke={color} strokeWidth={1} opacity={0} className="crosshair" />
            <circle
              cx={p.x} cy={p.y} r={9} fill="transparent"
              onMouseMove={e => show(e, <span>{p.label}: <b>{fmt(p.value)}</b></span>)}
              onMouseLeave={hide}
              style={{ cursor: 'pointer' }}
            />
            <circle cx={p.x} cy={p.y} r={4} fill={C.white} stroke={color} strokeWidth={2} pointerEvents="none" />
            <text x={p.x} y={h - 4} textAnchor="middle" fontSize={9} fill={C.gray} fontWeight={700} pointerEvents="none">{p.label}</text>
          </g>
        ))}
        <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke={C.lightGray} strokeWidth={1} />
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke={C.lightGray} strokeWidth={1} />
        <text x={pad - 4} y={pad} textAnchor="end" fontSize={8} fill={C.gray}>{fmt(max).slice(0, 8)}</text>
        <text x={pad - 4} y={h - pad} textAnchor="end" fontSize={8} fill={C.gray}>{fmt(min).slice(0, 8)}</text>
      </svg>
      <ChartTooltip tip={tip} />
    </div>
  )
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function SectionCard({title,children,span}:{title:string,children:React.ReactNode,span?:boolean}){
  return(
    <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',gridColumn:span?'1/-1':'auto'}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:18}}>
        <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
        <h2 style={{margin:0,fontSize:13,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

function KpiCard({label,value,sub,color=C.accent,icon,delta,higherIsBetter=true}:any){
  const hasDelta = delta !== undefined && delta !== null && isFinite(delta)
  const isUp = hasDelta && delta > 0.5
  const isDown = hasDelta && delta < -0.5
  const isGood = (isUp && higherIsBetter) || (isDown && !higherIsBetter)
  const deltaColor = !hasDelta || (!isUp && !isDown) ? C.gray : isGood ? C.accent : C.red
  return(
    <div style={{background:C.white,borderRadius:12,padding:'18px 20px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',borderTop:`4px solid ${color}`,position:'relative',overflow:'hidden'}}>
      <div style={{position:'absolute',top:14,right:16,fontSize:22,opacity:0.12}}>{icon}</div>
      <div style={{fontSize:9,fontWeight:700,letterSpacing:2,color:C.gray,textTransform:'uppercase'}}>{label}</div>
      <div style={{fontSize:22,fontWeight:900,color:C.dark,marginTop:5,lineHeight:1}}>{value}</div>
      <div style={{display:'flex',alignItems:'center',gap:6,marginTop:4}}>
        <div style={{fontSize:10,color:C.gray}}>{sub}</div>
        {hasDelta && (
          <span style={{fontSize:9,fontWeight:800,color:deltaColor,display:'flex',alignItems:'center',gap:1}}>
            {isUp?'▲':isDown?'▼':'–'} {Math.abs(delta).toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  )
}

const OFFICIAL_HEADER_URI = 'data:image/png;base64,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'

// Print the report
function printReport(title:string,html:string){
  const w=window.open('','_blank','width=1000,height=700')
  if(!w) return
  w.document.write(`<html><head><title>${title}</title>
  <style>*{margin:0;padding:0;box-sizing:border-box;font-family:Arial,sans-serif}
  body{padding:32px;color:#0d1f14;font-size:12px}
  .hdr{background:linear-gradient(135deg,#0d1f14,#1a4d2e);padding:18px 24px;border-radius:10px;color:#fff;margin-bottom:20px}
  .hdr h1{font-size:18px;font-weight:900;color:#39b54a;letter-spacing:2px}
  .hdr .sub{font-size:10px;color:rgba(255,255,255,0.6);margin-top:3px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#1a4d2e}thead th{padding:8px 12px;color:#fff;font-size:10px;font-weight:700;text-align:left;text-transform:uppercase;letter-spacing:1px}
  tbody tr:nth-child(even){background:#f9fbf9}tbody td{padding:8px 12px;border-bottom:1px solid #e8ede9}
  tfoot td{padding:10px 12px;font-weight:900;background:#f0fdf4;border-top:2px solid #39b54a}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
  .kpi{border:1.5px solid #e8ede9;border-radius:8px;padding:12px 14px}
  .kpi .lbl{font-size:9px;font-weight:700;color:#6b7c72;text-transform:uppercase;letter-spacing:1.5px}
  .kpi .val{font-size:18px;font-weight:900;color:#0d1f14;margin-top:4px}
  .section{margin-bottom:20px;page-break-inside:avoid}
  .section h2{font-size:11px;font-weight:800;color:#6b7c72;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e8ede9}
  .letterhead{width:340px;margin-bottom:14px}
  @media print{body{padding:16px}}</style></head><body>
  <img class="letterhead" src="${OFFICIAL_HEADER_URI}"/>
  <div class="hdr">
    <div class="sub">Integrated Resource & Financial Ecosystem (IRFE) · ${title}</div>
    <div class="sub">Generated: ${new Date().toLocaleDateString('en-PH',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
  </div>
  ${html}
  </body></html>`)
  w.document.close();w.focus();setTimeout(()=>{w.print();w.close()},500)
}

// CHART COLORS for expense categories
const CAT_COLORS=['#39b54a','#2563eb','#d97706','#7c3aed','#e53e3e','#0891b2','#db2777','#65a30d','#ea580c','#6366f1']

// ════════════════════════════════════════════════════════════════════════════
export default function ReportsPage(){
  const supabase=createClient()
  const [loading,setLoading]=useState(true)
  const [activeReport,setActiveReport]=useState('financial')

  // Date range
  const today=new Date().toISOString().slice(0,10)
  const firstOfMonth=new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString().slice(0,10)
  const [dateFrom,setDateFrom]=useState(firstOfMonth)
  const [dateTo,setDateTo]=useState(today)
  const [payrollPeriodFilter,setPayrollPeriodFilter]=useState('')
  useEffect(()=>{setPayrollPeriodFilter('')},[dateFrom,dateTo])

  // Row-level report tables (Project Status, Quotation Pipeline) can run into
  // the thousands after the historical-data migration, so they're paginated
  // the same way app/dashboard/projects/page.tsx paginates the main list.
  const PAGE_SIZE = 50
  const [projectsPage,setProjectsPage]=useState(1)
  const [quotationsPage,setQuotationsPage]=useState(1)
  useEffect(()=>{ setProjectsPage(1); setQuotationsPage(1) },[dateFrom,dateTo])
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[projectsPage, quotationsPage])

  // Raw data
  const [invoices,setInvoices]=useState<any[]>([])
  const [invoiceItems,setInvoiceItems]=useState<any[]>([])
  const [expenses,setExpenses]=useState<any[]>([])
  const [payroll,setPayroll]=useState<any[]>([])
  const [quotations,setQuotations]=useState<any[]>([])
  const [projects,setProjects]=useState<any[]>([])
  const [inventory,setInventory]=useState<any[]>([])
  const [equipment,setEquipment]=useState<any[]>([])
  // Forecast-specific — these need their own broader/unfiltered fetches since
  // the pipeline and obligations aren't bound to the Financial tab's date range.
  const [allQuotations,setAllQuotations]=useState<any[]>([])
  const [allInvoicesWide,setAllInvoicesWide]=useState<any[]>([])
  const [allExpensesWide,setAllExpensesWide]=useState<any[]>([])
  const [recentPayroll,setRecentPayroll]=useState<any[]>([])
  const [openEmpLoans,setOpenEmpLoans]=useState<any[]>([])
  const [openEquipLoans,setOpenEquipLoans]=useState<any[]>([])
  const [salesTargets,setSalesTargets]=useState<any[]>([])
  // Previous period (same length, immediately before the current range) —
  // powers the trend deltas on the Financial Summary KPI cards.
  const [prevInvoices,setPrevInvoices]=useState<any[]>([])
  const [prevExpenses,setPrevExpenses]=useState<any[]>([])
  // Treasury — bankTxnsRange/pcfVouchersRange respect the date-range filter
  // like expenses/invoices do; the statement/period history and outstanding
  // advances are fetched independently since a balance trend and "what's
  // outstanding right now" both need to see beyond just the selected range.
  const [bankTxnsRange,setBankTxnsRange]=useState<any[]>([])
  const [bankStatementsAll,setBankStatementsAll]=useState<any[]>([])
  const [pcfVouchersRange,setPcfVouchersRange]=useState<any[]>([])
  const [pcfPeriodsAll,setPcfPeriodsAll]=useState<any[]>([])
  const [caOutstandingList,setCaOutstandingList]=useState<any[]>([])

  const fetchAll=useCallback(async()=>{
    setLoading(true)
    const spanDays = Math.max(1, Math.round((new Date(dateTo).getTime()-new Date(dateFrom).getTime())/86400000)+1)
    const prevTo = new Date(dateFrom); prevTo.setDate(prevTo.getDate()-1)
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate()-spanDays+1)
    const prevFromStr = prevFrom.toISOString().slice(0,10), prevToStr = prevTo.toISOString().slice(0,10)
    const [
      {data:inv},{data:invItems},{data:exp},{data:pay},
      {data:quo},{data:proj},{data:inven},{data:equip},
      {data:pInv},{data:pExp},{data:bankTxns},{data:pcfVouchers},
    ]=await Promise.all([
      supabase.from('invoices').select('*').gte('date',dateFrom).lte('date',dateTo).order('date'),
      fetchAllPages<any>((from, to) => supabase.from('invoice_items').select('*').range(from, to)),
      supabase.from('expenses').select('*').gte('date',dateFrom).lte('date',dateTo).order('date'),
      fetchAllPages<any>((from, to) => supabase.from('payroll').select('*, employees(*)').order('created_at',{ascending:false}).range(from, to)),
      // .range() guards against Supabase's 1000-row default cap — both
      // tables have already passed 1000 rows since the historical migration.
      fetchAllPages<any>((from, to) => supabase.from('quotations').select('*, quotation_items(*)').gte('date',dateFrom).lte('date',dateTo).order('date').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('projects').select('*').order('created_at',{ascending:false}).range(from, to)),
      supabase.from('inventory').select('*'),
      supabase.from('equipment').select('*'),
      supabase.from('invoices').select('*').gte('date',prevFromStr).lte('date',prevToStr),
      supabase.from('expenses').select('*').gte('date',prevFromStr).lte('date',prevToStr),
      supabase.from('bank_transactions').select('*').gte('date',dateFrom).lte('date',dateTo).order('date'),
      supabase.from('petty_cash_vouchers').select('*, petty_cash_voucher_lines(*), petty_cash_periods(period_label)').gte('date',dateFrom).lte('date',dateTo).order('date'),
    ])
    setInvoices(inv||[]);setInvoiceItems(invItems||[]);setExpenses(exp||[])
    setPayroll(pay||[]);setQuotations(quo||[]);setProjects(proj||[])
    setInventory(inven||[]);setEquipment(equip||[])
    setPrevInvoices(pInv||[]);setPrevExpenses(pExp||[])
    setBankTxnsRange(bankTxns||[]); setPcfVouchersRange(pcfVouchers||[])

    // Forecast data — six months back, unbound to the Financial tab's range
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth()-6)
    const sixMoStr = sixMonthsAgo.toISOString().slice(0,10)
    const [
      {data:allQuo},{data:wideInv},{data:wideExp},{data:recentPay},
      {data:empLoans},{data:equipLoans},{data:targets}
    ] = await Promise.all([
      fetchAllPages<any>((from, to) => supabase.from('quotations').select('*, quotation_items(*)').order('date',{ascending:false}).range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('invoices').select('*, invoice_items(*)').gte('date',sixMoStr).order('date').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('expenses').select('*').gte('date',sixMoStr).order('date').range(from, to)),
      // Intentional recent-80-records window for the Forecast baseline, not a bug.
      supabase.from('payroll').select('*, employees(*)').order('created_at',{ascending:false}).limit(80),
      supabase.from('employee_loans').select('*').eq('status','Open'),
      supabase.from('equipment_loans').select('*').eq('status','Financing'),
      supabase.from('sales_targets').select('*'),
    ])
    setAllQuotations(allQuo||[]); setAllInvoicesWide(wideInv||[]); setAllExpensesWide(wideExp||[])
    setRecentPayroll(recentPay||[]); setOpenEmpLoans(empLoans||[]); setOpenEquipLoans(equipLoans||[])
    setSalesTargets(targets||[])

    // Treasury history — independent of the Financial tab's date range. A
    // balance trend needs the full statement history to mean anything, and
    // "cash advances outstanding" is a live figure, not a period sum.
    const [
      {data:stmts},{data:periods},{data:cas},
    ] = await Promise.all([
      supabase.from('bank_statements').select('*').order('start_date'),
      supabase.from('petty_cash_periods').select('*, petty_cash_vouchers(id, petty_cash_voucher_lines(amount))').order('start_date'),
      supabase.from('cash_advances').select('*, employees(name)').eq('status','Open'),
    ])
    // Per-statement deposit/withdrawal totals across ALL history, needed to
    // compute a live ending balance for whichever statement is still Open
    // (closed ones use the passbook-confirmed figure instead, see below).
    const stmtIds = (stmts||[]).map((s:any)=>s.id)
    let allTxnsByStmt: Record<string,{dep:number,wd:number}> = {}
    if (stmtIds.length) {
      const { data: allTxns } = await supabase.from('bank_transactions').select('bank_statement_id,amount,direction').in('bank_statement_id', stmtIds)
      ;(allTxns||[]).forEach((t:any) => {
        if (!allTxnsByStmt[t.bank_statement_id]) allTxnsByStmt[t.bank_statement_id] = { dep:0, wd:0 }
        if (t.direction==='Deposit') allTxnsByStmt[t.bank_statement_id].dep += Number(t.amount)
        else allTxnsByStmt[t.bank_statement_id].wd += Number(t.amount)
      })
    }
    setBankStatementsAll((stmts||[]).map((s:any)=>({...s, _agg: allTxnsByStmt[s.id]||{dep:0,wd:0}})))
    setPcfPeriodsAll(periods||[]); setCaOutstandingList(cas||[])

    setLoading(false)
  },[dateFrom,dateTo])

  useEffect(()=>{fetchAll()},[fetchAll])

  // ── COMPUTED METRICS ─────────────────────────────────────────────────────
  const getInvTotal=(inv:any)=>{
    // Only real item rows count — material sub-rows are reference-only.
    const items=invoiceItems.filter(i=>i.invoice_id===inv.id && i.kind==='item')
    return invoiceGrandTotal(inv, items)
  }
  // Mirrors InvoicesPage's isOverdue — invoices never store a literal
  // 'Overdue' status; it's a derived classification from due date vs today.
  const computeDueDate = (dateStr: string, paymentTerms: string): string | null => {
    if (!dateStr) return null
    const daysMatch = /(\d+)/.exec(paymentTerms || '')
    const days = daysMatch ? Number(daysMatch[1]) : 30
    const d = new Date(dateStr + 'T00:00:00')
    d.setDate(d.getDate() + days)
    return d.toISOString().slice(0, 10)
  }
  const isOverdue = (inv: any): boolean => {
    if (inv.status === 'Paid' || inv.status === 'Cancelled') return false
    const due = computeDueDate(inv.date, inv.payment_terms)
    if (!due) return false
    const dueDate = new Date(due + 'T00:00:00')
    dueDate.setDate(dueDate.getDate() + 1)
    return new Date() >= dueDate
  }
  const paidInv=invoices.filter(i=>i.status==='Paid')
  const pendingInv=invoices.filter(i=>i.status==='Pending' && !isOverdue(i))
  const overdueInv=invoices.filter(isOverdue)
  const totalRevenue=paidInv.reduce((s,i)=>s+getInvTotal(i),0)
  const totalPending=pendingInv.reduce((s,i)=>s+getInvTotal(i),0)
  const nonCancelledExpenses=expenses.filter(e=>e.status!=='Cancelled')
  const totalExpenses=nonCancelledExpenses.reduce((s,e)=>s+Number(e.amount),0)
  const netIncome=totalRevenue-totalExpenses

  // ── TREASURY METRICS ─────────────────────────────────────────────────────
  const bankDepositsRange = bankTxnsRange.filter(t=>t.direction==='Deposit').reduce((s,t)=>s+Number(t.amount),0)
  const bankWithdrawalsRange = bankTxnsRange.filter(t=>t.direction==='Withdrawal').reduce((s,t)=>s+Number(t.amount),0)
  const netCashFlowRange = bankDepositsRange - bankWithdrawalsRange
  const caOutstandingTotal = caOutstandingList.reduce((s,c)=>s+Number(c.balance||0),0)
  const pcfSpendRange = pcfVouchersRange.reduce((s,v)=>s+(v.petty_cash_voucher_lines||[]).reduce((a:number,l:any)=>a+Number(l.amount||0),0),0)

  const withdrawalsByCat: Record<string,number> = {}
  bankTxnsRange.filter(t=>t.direction==='Withdrawal').forEach(t=>{ withdrawalsByCat[t.category] = (withdrawalsByCat[t.category]||0) + Number(t.amount) })
  const withdrawalCatData = Object.entries(withdrawalsByCat).sort((a,b)=>b[1]-a[1]).map(([label,value],i)=>({label,value,color:CAT_COLORS[i%CAT_COLORS.length]}))

  // Bank Balance trend — full statement history (a trend needs continuity
  // beyond just the selected range). Closed periods use the passbook-
  // confirmed ending balance (the verified figure); the still-Open one is
  // computed live from its own transactions.
  const bankBalanceTrend = bankStatementsAll.map((s:any)=>{
    const agg = s._agg || { dep:0, wd:0 }
    const value = s.status==='Closed' && s.passbook_ending_balance!=null
      ? Number(s.passbook_ending_balance)
      : Number(s.beginning_balance) + agg.dep - agg.wd
    return { label: s.period_label, value }
  })
  const pcfSpendByPeriod = pcfPeriodsAll.map((p:any) => ({
    label: p.period_label,
    value: (p.petty_cash_vouchers||[]).reduce((s:number,v:any)=>s+(v.petty_cash_voucher_lines||[]).reduce((a:number,l:any)=>a+Number(l.amount||0),0),0),
  }))


  // Period-over-period deltas for the Financial Summary KPI row
  const pctDelta = (curr:number, prev:number): number | null => {
    if (prev === 0) return curr === 0 ? 0 : null
    return ((curr-prev)/Math.abs(prev))*100
  }
  const prevPaidTotal = prevInvoices.filter(i=>i.status==='Paid').reduce((s,i)=>s+getInvTotal(i),0)
  const prevPendingTotal = prevInvoices.filter(i=>i.status==='Pending' && !isOverdue(i)).reduce((s,i)=>s+getInvTotal(i),0)
  const prevExpensesTotal = prevExpenses.filter(e=>e.status!=='Cancelled').reduce((s,e)=>s+Number(e.amount),0)
  const prevNetIncome = prevPaidTotal - prevExpensesTotal
  const revenueDelta = pctDelta(totalRevenue, prevPaidTotal)
  const pendingDelta = pctDelta(totalPending, prevPendingTotal)
  const expensesDelta = pctDelta(totalExpenses, prevExpensesTotal)
  const netIncomeDelta = pctDelta(netIncome, prevNetIncome)

  // payroll — calcNet/calcGross are the module-level shared helpers above.
  const totalNetPayroll=payroll.reduce((s,r)=>s+calcNet(r.employees,r),0)

  // ── FORECAST ──────────────────────────────────────────────────────────────
  const now = new Date()
  const monthStr = (d:Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
  const currentMonthStr = monthStr(now)
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1)
  const lastMonthStr = monthStr(lastMonthDate)
  const nextMonthDate = new Date(now.getFullYear(), now.getMonth()+1, 1)
  const nextMonthLabel = nextMonthDate.toLocaleDateString('en-PH',{month:'long',year:'numeric'})

  const invoiceTotalForMonth = (list:any[], ym:string) => list.filter(i=>(i.date||'').startsWith(ym))
    .reduce((s,i)=>s+invoiceGrandTotal(i, i.invoice_items||[]),0)

  const thisMonthInvoiced = invoiceTotalForMonth(allInvoicesWide, currentMonthStr)
  const lastMonthInvoiced = invoiceTotalForMonth(allInvoicesWide, lastMonthStr)

  // Weighted pipeline — quotations not yet converted, weighted by how likely
  // that status is to actually convert into a real invoice.
  const PIPELINE_WEIGHTS:Record<string,number> = {Draft:0.10, Sent:0.30, Approved:0.70}
  const quoteTotal = (q:any) => quotationGrandTotal(q)
  const openQuotes = allQuotations.filter(q=>PIPELINE_WEIGHTS[q.status]!=null)
  const weightedPipeline = openQuotes.reduce((s,q)=>s+quoteTotal(q)*PIPELINE_WEIGHTS[q.status],0)
  const rawPipelineValue = openQuotes.reduce((s,q)=>s+quoteTotal(q),0)

  const projectedThisMonth = thisMonthInvoiced + weightedPipeline

  // Target — manually saved for this month, else auto-suggested from last month's actual
  const savedTarget = salesTargets.find(t=>t.month===currentMonthStr)
  const suggestedTarget = lastMonthInvoiced

  // Next month's obligations
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate()-30)
  const payrollBaseline = recentPayroll
    .filter(r=>new Date(r.created_at) >= thirtyDaysAgo)
    .reduce((s,r)=>s+calcNet(r.employees,r),0)
  const last3MoExpenses = [0,1,2].map(i=>{
    const d=new Date(now.getFullYear(),now.getMonth()-i,1)
    return allExpensesWide.filter(e=>(e.date||'').startsWith(monthStr(d)) && e.status!=='Cancelled').reduce((s,e)=>s+Number(e.amount),0)
  })
  const expenseBaseline = last3MoExpenses.reduce((s,v)=>s+v,0)/3
  const empLoanObligation = openEmpLoans.reduce((s,l)=>s+Math.min(Number(l.installment_amount),Number(l.balance)),0)*2 // 2 cutoffs/month
  const equipLoanObligation = openEquipLoans.reduce((s,l)=>s+Math.min(Number(l.installment_amount),Number(l.balance)),0)
  const loanObligation = empLoanObligation + equipLoanObligation
  const totalObligations = payrollBaseline + expenseBaseline + loanObligation

  const [targetInput,setTargetInput]=useState<number|null>(null)
  const effectiveTarget = targetInput ?? (savedTarget ? Number(savedTarget.target_amount) : suggestedTarget)
  const saveTarget = async (val:number) => {
    await supabase.from('sales_targets').upsert({month:currentMonthStr, target_amount:val}, {onConflict:'month'})
    const {data} = await supabase.from('sales_targets').select('*')
    setSalesTargets(data||[])
  }

  // quotation pipeline
  const quoPipeline=quotations.filter(q=>!['Invoiced','Cancelled'].includes(q.status))
    .reduce((s,q)=>s+quotationGrandTotal(q),0)

  // expense by category
  const expByCategory:Record<string,number>={}
  nonCancelledExpenses.forEach(e=>{expByCategory[e.category]=(expByCategory[e.category]||0)+Number(e.amount)})
  const expCatData=Object.entries(expByCategory).sort((a,b)=>b[1]-a[1]).map(([label,value],i)=>({label,value,color:CAT_COLORS[i%CAT_COLORS.length]}))

  // monthly revenue/expense trend (group by month)
  const monthlyMap:Record<string,{revenue:number,expense:number}>= {}
  invoices.forEach(inv=>{
    const m=inv.date?.slice(0,7)
    if(!m) return
    if(!monthlyMap[m]) monthlyMap[m]={revenue:0,expense:0}
    if(inv.status==='Paid') monthlyMap[m].revenue+=getInvTotal(inv)
  })
  nonCancelledExpenses.forEach(e=>{
    const m=e.date?.slice(0,7)
    if(!m) return
    if(!monthlyMap[m]) monthlyMap[m]={revenue:0,expense:0}
    monthlyMap[m].expense+=Number(e.amount)
  })
  const monthlyData=Object.entries(monthlyMap).sort().map(([k,v])=>({
    label:new Date(k+'-01').toLocaleDateString('en-PH',{month:'short',year:'2-digit'}),
    a:v.revenue,b:v.expense
  }))

  // invoice status donut
  const invStatusData=[
    {label:'Paid',value:paidInv.reduce((s,i)=>s+getInvTotal(i),0),color:C.blue},
    {label:'Pending',value:totalPending,color:C.amber},
    {label:'Overdue',value:overdueInv.reduce((s,i)=>s+getInvTotal(i),0),color:C.red},
  ].filter(d=>d.value>0)

  // quotation status donut
  const quoStatusData=['Draft','Sent','Approved','Invoiced','Cancelled'].map((s,i)=>({
    label:s,
    value:quotations.filter(q=>q.status===s).reduce((a,q)=>a+quotationGrandTotal(q),0),
    color:[C.gray,C.blue,C.accent,C.purple,C.red][i]
  })).filter(d=>d.value>0)

  // project status counts
  const projCounts=['Active','On Hold','Completed','Cancelled'].map(s=>({label:s,value:projects.filter(p=>p.status===s).length,color:[C.accent,C.amber,C.blue,C.red][['Active','On Hold','Completed','Cancelled'].indexOf(s)]}))

  // Most-recent-first by the project's own business date, falling back to
  // created_at — same reasoning (and same fallback order) as the Projects
  // list page: a bulk historical import lands every row's created_at within
  // the same minute, so sorting on that alone would scramble real history.
  const projectsByRecency=(a:any,b:any)=>{
    const ad=a.start_date||a.created_at||''
    const bd=b.start_date||b.created_at||''
    return bd.localeCompare(ad)
  }
  const sortedProjects=projects.slice().sort(projectsByRecency)
  const projectsPageCount=Math.max(1,Math.ceil(sortedProjects.length/PAGE_SIZE))
  const projectsCurrentPage=Math.min(projectsPage,projectsPageCount)
  const pagedProjects=sortedProjects.slice((projectsCurrentPage-1)*PAGE_SIZE,projectsCurrentPage*PAGE_SIZE)

  // Most-recent-first by quotation date (the business date the row's own
  // query already filters/orders by) — the raw fetch orders oldest-first,
  // so this re-sorts descending for display, falling back to created_at.
  const quotationsByRecency=(a:any,b:any)=>{
    const ad=a.date||a.created_at||''
    const bd=b.date||b.created_at||''
    return bd.localeCompare(ad)
  }
  const sortedQuotations=quotations.slice().sort(quotationsByRecency)
  const quotationsPageCount=Math.max(1,Math.ceil(sortedQuotations.length/PAGE_SIZE))
  const quotationsCurrentPage=Math.min(quotationsPage,quotationsPageCount)
  const pagedQuotations=sortedQuotations.slice((quotationsCurrentPage-1)*PAGE_SIZE,quotationsCurrentPage*PAGE_SIZE)

  // inventory value by supplier
  const supMap:Record<string,number>={}
  inventory.forEach(i=>{supMap[i.supplier||'Unknown']=(supMap[i.supplier||'Unknown']||0)+i.quantity*i.unit_cost})
  const supData=Object.entries(supMap).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label:label.slice(0,12),value}))

  // daily expense trend
  const dailyExpMap:Record<string,number>={}
  nonCancelledExpenses.forEach(e=>{dailyExpMap[e.date]=(dailyExpMap[e.date]||0)+Number(e.amount)})
  const dailyExpData=Object.entries(dailyExpMap).sort().map(([label,value])=>({label:label.slice(5),value}))

  // payroll dept breakdown
  const deptMap:Record<string,number>={}
  payroll.forEach(r=>{
    const dept=r.employees?.department||'Unknown'
    const net=calcNet(r.employees,r)
    deptMap[dept]=(deptMap[dept]||0)+net
  })
  const deptData=Object.entries(deptMap).sort((a,b)=>b[1]-a[1]).map(([label,value],i)=>({label:label.slice(0,8),value,color:CAT_COLORS[i]}))

  // ── PRINT HELPERS ─────────────────────────────────────────────────────────
  // ── Data Export for Backup / Handoff ────────────────────────────────────
  const downloadCSV = (filename:string, rows:any[], columns:string[]) => {
    if (rows.length === 0) return
    const esc = (v:any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s }
    const csv = [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
  const exportAllData = () => {
    downloadCSV(`invoices_${dateFrom}_to_${dateTo}.csv`, invoices, ['id','client','date','status','payment_terms','dr_number','cr_number'])
    setTimeout(() => downloadCSV(`expenses_${dateFrom}_to_${dateTo}.csv`, expenses, ['id','date','category','description','amount','payment_method','status']), 300)
    setTimeout(() => downloadCSV(`payroll_${dateFrom}_to_${dateTo}.csv`, payroll.map(r=>({...r, employee_name: r.employees?.name})), ['employee_name','period','days_worked','overtime_hours','regular_pay','overtime_pay','sss','philhealth','pagibig','tax','status']), 600)
    setTimeout(() => downloadCSV(`quotations_${dateFrom}_to_${dateTo}.csv`, quotations, ['id','client','date','valid_until','status','po_number','version_number']), 900)
    setTimeout(() => downloadCSV(`projects_${dateFrom}_to_${dateTo}.csv`, projects, ['id','name','client','po_number','po_total_value','status','start_date','end_date']), 1200)
  }

  const printFinancial=()=>{
    const rows=invoices.map(inv=>`<tr><td>${inv.id}</td><td>${inv.client}</td><td>${inv.date}</td><td>${fmt(getInvTotal(inv))}</td><td>${inv.status}</td></tr>`).join('')
    const expRows=nonCancelledExpenses.map(e=>`<tr><td>${e.id}</td><td>${e.date}</td><td>${e.category}</td><td>${e.description}</td><td>${fmt(e.amount)}</td></tr>`).join('')
    printReport(`Financial Summary Report · ${dateFrom} to ${dateTo}`,`
      <div class="kpis">
        <div class="kpi"><div class="lbl">Revenue (Paid)</div><div class="val">${fmt(totalRevenue)}</div></div>
        <div class="kpi"><div class="lbl">Pending</div><div class="val">${fmt(totalPending)}</div></div>
        <div class="kpi"><div class="lbl">Total Expenses</div><div class="val">${fmt(totalExpenses)}</div></div>
        <div class="kpi"><div class="lbl">Net Income</div><div class="val">${fmt(netIncome)}</div></div>
      </div>
      <div class="section"><h2>Invoices</h2>
        <table><thead><tr><th>ID</th><th>Client</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">TOTAL</td><td>${fmt(totalRevenue+totalPending)}</td><td></td></tr></tfoot></table></div>
      <div class="section"><h2>Expenses</h2>
        <table><thead><tr><th>ID</th><th>Date</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead>
        <tbody>${expRows}</tbody>
        <tfoot><tr><td colspan="4">TOTAL</td><td>${fmt(totalExpenses)}</td></tr></tfoot></table></div>
    `)
  }

  const printPayrollReport=()=>{
    const rows=payroll.map(r=>{
      const emp=r.employees; if(!emp) return ''
      const g=calcGross(emp,r)
      const ded=totalDeductions(emp,r)
      return`<tr><td>${emp.name}</td><td>${emp.role}</td><td>${emp.employment_type}</td><td>${r.period}</td><td>${fmt(g)}</td><td>${fmt(r.allowance)}</td><td>${fmt(ded)}</td><td>${fmt(calcNet(emp,r))}</td><td>${r.status}</td></tr>`
    }).join('')
    printReport('Payroll Summary Report',`
      <div class="kpis">
        <div class="kpi"><div class="lbl">Employees</div><div class="val">${new Set(payroll.map(r=>r.employee_id)).size}</div></div>
        <div class="kpi"><div class="lbl">Net Payroll</div><div class="val">${fmt(totalNetPayroll)}</div></div>
      </div>
      <div class="section"><h2>Payroll Records</h2>
        <table><thead><tr><th>Name</th><th>Role</th><th>Type</th><th>Period</th><th>Gross</th><th>Allowance</th><th>Deductions</th><th>Net Pay</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="7">TOTAL NET</td><td>${fmt(totalNetPayroll)}</td><td></td></tr></tfoot></table></div>
    `)
  }

  const printInventoryReport=()=>{
    const rows=inventory.map(i=>`<tr><td>${i.id}</td><td>${i.name}</td><td>${i.unit}</td><td>${i.quantity}</td><td>${i.min_stock}</td><td>${fmt(i.unit_cost)}</td><td>${fmt(i.quantity*i.unit_cost)}</td><td>${i.quantity<i.min_stock*0.6?'CRITICAL':i.quantity<i.min_stock?'LOW':'OK'}</td></tr>`).join('')
    const total=inventory.reduce((s,i)=>s+i.quantity*i.unit_cost,0)
    printReport('Inventory Status Report',`
      <div class="kpis">
        <div class="kpi"><div class="lbl">Total Items</div><div class="val">${inventory.length}</div></div>
        <div class="kpi"><div class="lbl">Total Value</div><div class="val">${fmt(total)}</div></div>
        <div class="kpi"><div class="lbl">Critical</div><div class="val">${inventory.filter(i=>i.quantity<i.min_stock*0.6).length}</div></div>
      </div>
      <div class="section"><h2>Materials Inventory</h2>
        <table><thead><tr><th>ID</th><th>Name</th><th>Unit</th><th>Qty</th><th>Min</th><th>Unit Cost</th><th>Value</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="6">TOTAL VALUE</td><td>${fmt(total)}</td><td></td></tr></tfoot></table></div>
    `)
  }

  const REPORT_TYPES=[
    {id:'financial',label:'Financial Summary',icon:'💰'},
    {id:'treasury',label:'Treasury Report',icon:'🏦'},
    {id:'forecast',label:'Sales Forecast',icon:'🎯'},
    {id:'payroll',label:'Payroll Report',icon:'👥'},
    {id:'quotations',label:'Quotation Pipeline',icon:'📋'},
    {id:'projects',label:'Project Status',icon:'📁'},
    {id:'inventory',label:'Inventory Report',icon:'📦'},
  ]

  return(
    <div>
      {/* Controls */}
      <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',marginBottom:20}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:14}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,letterSpacing:2,color:C.gray,textTransform:'uppercase',marginBottom:4}}>Date Range Filter</div>
            <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <label style={{fontSize:11,fontWeight:700,color:C.gray}}>From</label>
                <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}
                  style={{padding:'8px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',color:C.dark,outline:'none'}}/>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <label style={{fontSize:11,fontWeight:700,color:C.gray}}>To</label>
                <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}
                  style={{padding:'8px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',color:C.dark,outline:'none'}}/>
              </div>
              {/* Quick ranges */}
              {[['This Month',()=>{setDateFrom(firstOfMonth);setDateTo(today)}],
                ['Last 3 Months',()=>{const d=new Date();d.setMonth(d.getMonth()-3);setDateFrom(d.toISOString().slice(0,10));setDateTo(today)}],
                ['This Year',()=>{setDateFrom(`${new Date().getFullYear()}-01-01`);setDateTo(today)}],
                ['All Time',()=>{setDateFrom('2020-01-01');setDateTo(today)}],
              ].map(([l,fn])=>(
                <button key={l as string} onClick={fn as any} style={{padding:'7px 14px',borderRadius:20,border:`1.5px solid ${C.lightGray}`,background:C.white,color:C.gray,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all 0.2s'}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;e.currentTarget.style.color=C.accent}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.lightGray;e.currentTarget.style.color=C.gray}}>{l as string}</button>
              ))}
              <button onClick={fetchAll} style={{padding:'8px 18px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1,cursor:'pointer',fontFamily:'inherit',boxShadow:`0 3px 10px ${C.accent}44`}}>
                {loading?'Loading…':'Apply'}
              </button>
            </div>
          </div>
          {/* Print buttons */}
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <button onClick={printFinancial} style={{padding:'8px 16px',border:`1.5px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit',letterSpacing:1}}>🖨 Financial PDF</button>
            <button onClick={printPayrollReport} style={{padding:'8px 16px',border:`1.5px solid ${C.blue}`,background:'transparent',color:C.blue,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit',letterSpacing:1}}>🖨 Payroll PDF</button>
            <button onClick={printInventoryReport} style={{padding:'8px 16px',border:`1.5px solid ${C.amber}`,background:'transparent',color:C.amber,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit',letterSpacing:1}}>🖨 Inventory PDF</button>
            <button onClick={exportAllData} style={{padding:'8px 16px',border:`1.5px solid ${C.purple}`,background:'transparent',color:C.purple,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit',letterSpacing:1}}>📦 Export All (CSV)</button>
          </div>
        </div>
      </div>

      {/* Report Type Tabs */}
      <div style={{display:'flex',gap:8,marginBottom:20,flexWrap:'wrap'}}>
        {REPORT_TYPES.map(r=>(
          <button key={r.id} onClick={()=>setActiveReport(r.id)}
            style={{padding:'9px 18px',borderRadius:8,border:`1.5px solid ${activeReport===r.id?C.accent:C.lightGray}`,background:activeReport===r.id?C.accent:C.white,color:activeReport===r.id?C.white:C.gray,fontSize:11,fontWeight:800,cursor:'pointer',fontFamily:'inherit',letterSpacing:1,transition:'all 0.2s',display:'flex',alignItems:'center',gap:6}}>
            {r.icon} {r.label}
          </button>
        ))}
      </div>

      {loading?(
        <div style={{background:C.white,borderRadius:12,padding:60,textAlign:'center',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{fontSize:32,marginBottom:12}}>⏳</div>
          <div style={{fontSize:13,color:C.gray,fontWeight:700}}>Loading report data…</div>
        </div>
      ):(
        <>
          {/* ── FINANCIAL SUMMARY ── */}
          {activeReport==='financial'&&(
            <div>
              {/* KPI Row */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
                <KpiCard label="Total Revenue" value={fmt(totalRevenue)} sub={`${paidInv.length} paid invoices`} color={C.accent} icon="💰" delta={revenueDelta} higherIsBetter/>
                <KpiCard label="Pending Collection" value={fmt(totalPending)} sub={`${pendingInv.length} invoices`} color={C.amber} icon="⏳" delta={pendingDelta} higherIsBetter={false}/>
                <KpiCard label="Total Expenses" value={fmt(totalExpenses)} sub={`${nonCancelledExpenses.length} transactions`} color={C.red} icon="📉" delta={expensesDelta} higherIsBetter={false}/>
                <KpiCard label="Net Income" value={fmt(netIncome)} sub="Revenue minus expenses" color={netIncome>=0?C.accent:C.red} icon="📊" delta={netIncomeDelta} higherIsBetter/>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Revenue vs Expenses — Monthly Trend">
                  {monthlyData.length>=2
                    ?<GroupedBar data={monthlyData} height={180} colors={[C.accent,C.red]} labels={['Revenue','Expenses']}/>
                    :<div style={{padding:'40px 0',textAlign:'center',color:C.gray,fontSize:12}}>Not enough monthly data for selected range</div>}
                </SectionCard>
                <SectionCard title="Invoice Status Breakdown">
                  <DonutChart data={invStatusData} size={150}/>
                  <div style={{marginTop:16,paddingTop:16,borderTop:`1px solid ${C.lightGray}`}}>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'4px 0'}}><span style={{color:C.gray}}>Gross Invoiced</span><span style={{fontWeight:800}}>{fmt(totalRevenue+totalPending)}</span></div>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'4px 0'}}><span style={{color:C.gray}}>Collection Rate</span><span style={{fontWeight:800,color:C.accent}}>{totalRevenue+totalPending>0?Math.round(totalRevenue/(totalRevenue+totalPending)*100):0}%</span></div>
                  </div>
                </SectionCard>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Expense Breakdown by Category">
                  <DonutChart data={expCatData} size={140}/>
                </SectionCard>
                <SectionCard title="Daily Expense Trend">
                  {dailyExpData.length>=2
                    ?<LineChart data={dailyExpData.slice(-14)} height={160} color={C.red} label="Last 14 Days"/>
                    :<div style={{padding:'40px 0',textAlign:'center',color:C.gray,fontSize:12}}>No expense data in range</div>}
                </SectionCard>
              </div>

              {/* Invoice Table */}
              <SectionCard title={`Invoices — ${dateFrom} to ${dateTo}`} span>
                {invoices.length===0?<div style={{textAlign:'center',padding:30,color:C.gray}}>No invoices in selected range.</div>
                :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                    {['Invoice ID','Client','Date','Due Date','Amount','Status'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                  </tr></thead>
                  <tbody>{invoices.map((inv,i)=>(
                    <tr key={inv.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                      <td style={{padding:'8px 12px',fontWeight:800,color:C.darkGreen,fontSize:11}}>{inv.id}</td>
                      <td style={{padding:'8px 12px',fontWeight:600}}>{inv.client}</td>
                      <td style={{padding:'8px 12px',color:C.gray}}>{inv.date}</td>
                      <td style={{padding:'8px 12px',color:C.gray}}>{inv.due_date}</td>
                      <td style={{padding:'8px 12px',fontWeight:800,color:C.accent}}>{fmt(getInvTotal(inv))}</td>
                      <td style={{padding:'8px 12px'}}>
                        <span style={{padding:'3px 10px',borderRadius:20,background:inv.status==='Paid'?`${C.blue}22`:inv.status==='Pending'?`${C.amber}22`:`${C.red}22`,color:inv.status==='Paid'?C.blue:inv.status==='Pending'?C.amber:C.red,fontSize:10,fontWeight:800,border:`1px solid ${inv.status==='Paid'?C.blue:inv.status==='Pending'?C.amber:C.red}44`}}>{inv.status}</span>
                      </td>
                    </tr>
                  ))}</tbody>
                  <tfoot><tr style={{background:`${C.accent}0a`,borderTop:`2px solid ${C.accent}44`}}>
                    <td colSpan={4} style={{padding:'10px 12px',fontWeight:900,color:C.darkGreen,textTransform:'uppercase',fontSize:11,letterSpacing:1}}>Total</td>
                    <td style={{padding:'10px 12px',fontWeight:900,color:C.accent,fontSize:13}}>{fmt(invoices.reduce((s,i)=>s+getInvTotal(i),0))}</td>
                    <td/>
                  </tr></tfoot>
                </table>}
              </SectionCard>
            </div>
          )}

          {/* ── TREASURY REPORT ── */}
          {activeReport==='treasury'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
                <KpiCard label="Deposits (in range)" value={fmt(bankDepositsRange)} sub={`${bankTxnsRange.filter(t=>t.direction==='Deposit').length} transactions`} color={C.accent} icon="⬇️"/>
                <KpiCard label="Withdrawals (in range)" value={fmt(bankWithdrawalsRange)} sub={`${bankTxnsRange.filter(t=>t.direction==='Withdrawal').length} transactions`} color={C.red} icon="⬆️"/>
                <KpiCard label="Net Cash Flow (in range)" value={fmt(netCashFlowRange)} sub="Deposits minus withdrawals" color={netCashFlowRange>=0?C.accent:C.red} icon="📊"/>
                <KpiCard label="Cash Advances Outstanding" value={fmt(caOutstandingTotal)} sub={`${caOutstandingList.length} employees, live figure`} color={C.amber} icon="🧾"/>
              </div>

              <div style={{marginBottom:18}}>
                <SectionCard title="Bank Balance — Full History">
                  {bankBalanceTrend.length>=2
                    ?<LineChart data={bankBalanceTrend} height={180} color={C.blue}/>
                    :<div style={{padding:'40px 0',textAlign:'center',color:C.gray,fontSize:12}}>Need at least 2 statement periods for a trend — check the Bank Ledger tab in Accounting.</div>}
                </SectionCard>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Withdrawals by Category (in range)">
                  <DonutChart data={withdrawalCatData} size={150}/>
                </SectionCard>
                <SectionCard title="Petty Cash Fund — Spend by Period (all-time)">
                  <div style={{fontSize:11,color:C.gray,marginTop:-8,marginBottom:10}}>Spend within {dateFrom} to {dateTo}: <b style={{color:C.purple}}>{fmt(pcfSpendRange)}</b></div>
                  {pcfSpendByPeriod.length>0
                    ?<BarChart data={pcfSpendByPeriod} height={160} color={C.purple}/>
                    :<div style={{padding:'40px 0',textAlign:'center',color:C.gray,fontSize:12}}>No PCF periods yet.</div>}
                </SectionCard>
              </div>

              <SectionCard title={`Bank Transactions — ${dateFrom} to ${dateTo}`} span>
                {bankTxnsRange.length===0
                  ?<p style={{color:C.gray,fontSize:12}}>No bank transactions in selected range.</p>
                  :<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                      {['Date','Particulars','Category','Direction','Amount'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1}}>{h}</th>)}
                    </tr></thead>
                    <tbody>{bankTxnsRange.map((t:any,i:number)=>(
                      <tr key={t.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                        <td style={{padding:'7px 12px',color:C.gray}}>{t.date}</td>
                        <td style={{padding:'7px 12px',fontWeight:600}}>{t.particulars||'—'}</td>
                        <td style={{padding:'7px 12px'}}><span style={{padding:'2px 8px',borderRadius:20,background:`${C.purple}18`,color:C.purple,fontSize:10,fontWeight:700}}>{t.category}</span></td>
                        <td style={{padding:'7px 12px',fontWeight:700,color:t.direction==='Deposit'?C.accent:C.red}}>{t.direction}</td>
                        <td style={{padding:'7px 12px',fontWeight:800,color:t.direction==='Deposit'?C.accent:C.red}}>{fmt(t.amount)}</td>
                      </tr>
                    ))}</tbody>
                    <tfoot><tr style={{background:`${C.accent}0a`,borderTop:`2px solid ${C.accent}44`}}>
                      <td colSpan={4} style={{padding:'10px 12px',fontWeight:900,color:C.darkGreen,textTransform:'uppercase',fontSize:11,letterSpacing:1}}>Net Cash Flow</td>
                      <td style={{padding:'10px 12px',fontWeight:900,color:netCashFlowRange>=0?C.accent:C.red,fontSize:13}}>{fmt(netCashFlowRange)}</td>
                    </tr></tfoot>
                  </table>}
              </SectionCard>

              {caOutstandingList.length>0 && (
                <div style={{marginTop:18}}>
                  <SectionCard title="Cash Advances Outstanding — by Employee" span>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                      <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                        {['Reference','Employee','Date Issued','Original Amount','Balance'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1}}>{h}</th>)}
                      </tr></thead>
                      <tbody>{caOutstandingList.map((c:any,i:number)=>(
                        <tr key={c.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                          <td style={{padding:'7px 12px',fontWeight:800,color:C.darkGreen}}>{c.id}</td>
                          <td style={{padding:'7px 12px',fontWeight:600}}>{c.employees?.name||'—'}</td>
                          <td style={{padding:'7px 12px',color:C.gray}}>{c.date_issued}</td>
                          <td style={{padding:'7px 12px',color:C.gray}}>{fmt(c.amount)}</td>
                          <td style={{padding:'7px 12px',fontWeight:800,color:C.amber}}>{fmt(c.balance)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </SectionCard>
                </div>
              )}
            </div>
          )}

          {/* ── SALES FORECAST ── */}
          {activeReport==='forecast'&&(
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
              <SectionCard title={`This Month's Target — ${now.toLocaleDateString('en-PH',{month:'long',year:'numeric'})}`} span>
                <div style={{display:'flex',gap:14,alignItems:'center',flexWrap:'wrap',marginBottom:16}}>
                  <div>
                    <label style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:4}}>
                      Target {!savedTarget && '(auto-suggested from last month — edit and save)'}
                    </label>
                    <input type="number" value={effectiveTarget} onChange={e=>setTargetInput(Number(e.target.value))}
                      onFocus={e=>e.target.select()}
                      style={{padding:'9px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:14,fontWeight:700,width:200}}/>
                  </div>
                  <button onClick={()=>saveTarget(effectiveTarget)} style={{padding:'9px 18px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,cursor:'pointer',letterSpacing:1}}>Save Target</button>
                  {savedTarget && <span style={{fontSize:10,color:C.accent,fontWeight:700}}>✓ Saved for this month</span>}
                </div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14}}>
                  <div style={{background:'#f9fbf9',borderRadius:8,padding:'14px 16px'}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>Confirmed (Invoiced)</div>
                    <div style={{fontSize:18,fontWeight:900,color:C.dark,marginTop:4}}>{fmt(thisMonthInvoiced)}</div>
                  </div>
                  <div style={{background:'#f9fbf9',borderRadius:8,padding:'14px 16px'}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>Weighted Pipeline</div>
                    <div style={{fontSize:18,fontWeight:900,color:C.purple,marginTop:4}}>{fmt(weightedPipeline)}</div>
                    <div style={{fontSize:9,color:C.gray,marginTop:2}}>of {fmt(rawPipelineValue)} raw pipeline</div>
                  </div>
                  <div style={{background:`${C.accent}0a`,borderRadius:8,padding:'14px 16px',border:`1px solid ${C.accent}33`}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>Projected Total</div>
                    <div style={{fontSize:18,fontWeight:900,color:C.darkGreen,marginTop:4}}>{fmt(projectedThisMonth)}</div>
                  </div>
                  <div style={{background:projectedThisMonth>=effectiveTarget?`${C.accent}0a`:`${C.red}0a`,borderRadius:8,padding:'14px 16px',border:`1px solid ${projectedThisMonth>=effectiveTarget?C.accent:C.red}33`}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>vs. Target</div>
                    <div style={{fontSize:18,fontWeight:900,color:projectedThisMonth>=effectiveTarget?C.accent:C.red,marginTop:4}}>{projectedThisMonth>=effectiveTarget?'+':''}{fmt(projectedThisMonth-effectiveTarget)}</div>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title={`Estimated Obligations — ${nextMonthLabel}`} span>
                <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Payroll and recurring expenses are estimated from recent history — loan installments are known exact amounts, not estimates.</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14}}>
                  <div style={{background:'#f9fbf9',borderRadius:8,padding:'14px 16px'}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>Payroll (est.)</div>
                    <div style={{fontSize:16,fontWeight:900,color:C.dark,marginTop:4}}>{fmt(payrollBaseline)}</div>
                  </div>
                  <div style={{background:'#f9fbf9',borderRadius:8,padding:'14px 16px'}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>Recurring Expenses (est.)</div>
                    <div style={{fontSize:16,fontWeight:900,color:C.dark,marginTop:4}}>{fmt(expenseBaseline)}</div>
                    <div style={{fontSize:9,color:C.gray,marginTop:2}}>3-month average</div>
                  </div>
                  <div style={{background:'#f9fbf9',borderRadius:8,padding:'14px 16px'}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>Loan Installments (known)</div>
                    <div style={{fontSize:16,fontWeight:900,color:C.blue,marginTop:4}}>{fmt(loanObligation)}</div>
                    <div style={{fontSize:9,color:C.gray,marginTop:2}}>{openEmpLoans.length} employee + {openEquipLoans.length} equipment</div>
                  </div>
                  <div style={{background:`${C.amber}0a`,borderRadius:8,padding:'14px 16px',border:`1px solid ${C.amber}33`}}>
                    <div style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase'}}>Total Est. Obligations</div>
                    <div style={{fontSize:18,fontWeight:900,color:C.amber,marginTop:4}}>{fmt(totalObligations)}</div>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Bottom Line" span>
                <div style={{background:projectedThisMonth>=totalObligations?`${C.accent}12`:`${C.red}12`,border:`2px solid ${projectedThisMonth>=totalObligations?C.accent:C.red}44`,borderRadius:10,padding:20,textAlign:'center'}}>
                  <div style={{fontSize:11,color:C.gray,marginBottom:6}}>This month's projected revenue ({fmt(projectedThisMonth)}) vs. {nextMonthLabel}'s estimated obligations ({fmt(totalObligations)})</div>
                  <div style={{fontSize:28,fontWeight:900,color:projectedThisMonth>=totalObligations?C.darkGreen:C.red}}>
                    {projectedThisMonth>=totalObligations?'✓ Surplus of ':'⚠ Shortfall of '}{fmt(Math.abs(projectedThisMonth-totalObligations))}
                  </div>
                </div>
              </SectionCard>
            </div>
          )}

          {activeReport==='payroll'&&(() => {
            const payrollPeriods = Array.from(new Set(payroll.map((p:any)=>p.period))).sort()
            const filteredPayroll = payrollPeriodFilter ? payroll.filter((p:any)=>p.period===payrollPeriodFilter) : payroll
            const filteredNetPayroll = filteredPayroll.reduce((s,r)=>s+calcNet(r.employees,r),0)
            return (
            <div>
              <div style={{marginBottom:14}}>
                <select value={payrollPeriodFilter} onChange={e=>setPayrollPeriodFilter(e.target.value)} style={{padding:'7px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',minWidth:260}}>
                  <option value="">All Periods (within date range above)</option>
                  {payrollPeriods.map(period=>{
                    const count = payroll.filter((p:any)=>p.period===period).length
                    return <option key={period} value={period}>{period} — {count} record{count===1?'':'s'}</option>
                  })}
                </select>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
                <KpiCard label="Employees" value={new Set(filteredPayroll.map((p:any)=>p.employee_id)).size} sub={`${filteredPayroll.length} payroll record${filteredPayroll.length===1?'':'s'}`} color={C.accent} icon="👤"/>
                <KpiCard label="Gross Payroll" value={fmt(filteredPayroll.reduce((s,r)=>s+calcGross(r.employees,r)+Number(r.allowance||0),0))} sub="before deductions" color={C.midGreen} icon="💵"/>
                <KpiCard label="Total Deductions" value={fmt(filteredPayroll.reduce((s,r)=>s+totalDeductions(r.employees,r),0))} sub="all statutory + loan/other deductions" color={C.red} icon="📉"/>
                <KpiCard label="Net Payroll" value={fmt(filteredNetPayroll)} sub="take-home total" color={C.blue} icon="💰"/>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Net Pay by Department">
                  {(()=>{
                    const deptMap2:Record<string,number>={}
                    filteredPayroll.forEach(r=>{const d=r.employees?.role||'Other';deptMap2[d]=(deptMap2[d]||0)+calcNet(r.employees,r)})
                    const data=Object.entries(deptMap2).sort((a,b)=>b[1]-a[1]).map(([label,value],i)=>({label,value,color:CAT_COLORS[i%CAT_COLORS.length]}))
                    return data.length>0?<DonutChart data={data} size={150}/>:<div style={{padding:40,textAlign:'center',color:C.gray,fontSize:12}}>No payroll data</div>
                  })()}
                </SectionCard>
                <SectionCard title="Employment Type Breakdown">
                  {(()=>{
                    const types=['Salaried','Daily','Part-Time'].map((t,i)=>({label:t,value:filteredPayroll.filter(r=>r.employees?.employment_type===t).reduce((s,r)=>s+calcNet(r.employees,r),0),color:[C.accent,C.blue,C.amber][i]})).filter(d=>d.value>0)
                    return types.length>0?<DonutChart data={types} size={150}/>:<div style={{padding:40,textAlign:'center',color:C.gray,fontSize:12}}>No data</div>
                  })()}
                </SectionCard>
              </div>

              <SectionCard title="Payroll Register" span>
                {filteredPayroll.length===0?<div style={{textAlign:'center',padding:30,color:C.gray}}>{payrollPeriodFilter?'No records for this period.':'No payroll records.'}</div>
                :<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                  <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                    {['Employee','Role','Type','Period','Gross','Allowance','SSS','PhilHealth','Pag-IBIG','Tax','Net Pay','Status'].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:9,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>)}
                  </tr></thead>
                  <tbody>{filteredPayroll.map((r,i)=>{
                    const emp=r.employees; if(!emp) return null
                    const g=calcGross(emp,r)
                    return<tr key={r.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                      <td style={{padding:'8px 10px',fontWeight:700}}>{emp.name}</td>
                      <td style={{padding:'8px 10px',color:C.gray,fontSize:10}}>{emp.role}</td>
                      <td style={{padding:'8px 10px'}}><span style={{padding:'2px 6px',borderRadius:20,background:`${C.blue}18`,color:C.blue,fontSize:9,fontWeight:800}}>{emp.employment_type}</span></td>
                      <td style={{padding:'8px 10px',color:C.gray}}>{r.period}</td>
                      <td style={{padding:'8px 10px'}}>{fmt(g)}</td>
                      <td style={{padding:'8px 10px',color:C.accent}}>{fmt(r.allowance)}</td>
                      <td style={{padding:'8px 10px',color:C.red,fontSize:10}}>{fmt(r.sss)}</td>
                      <td style={{padding:'8px 10px',color:C.red,fontSize:10}}>{fmt(r.philhealth)}</td>
                      <td style={{padding:'8px 10px',color:C.red,fontSize:10}}>{fmt(r.pagibig)}</td>
                      <td style={{padding:'8px 10px',color:C.red,fontSize:10}}>{fmt(r.tax)}</td>
                      <td style={{padding:'8px 10px',fontWeight:900,color:C.darkGreen}}>{fmt(calcNet(emp,r))}</td>
                      <td style={{padding:'8px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,background:r.status==='Paid'?`${C.blue}22`:`${C.amber}22`,color:r.status==='Paid'?C.blue:C.amber,fontSize:9,fontWeight:800,border:`1px solid ${r.status==='Paid'?C.blue:C.amber}44`}}>{r.status}</span></td>
                    </tr>
                  })}</tbody>
                  <tfoot><tr style={{background:`${C.accent}0a`,borderTop:`2px solid ${C.accent}44`}}>
                    <td colSpan={10} style={{padding:'10px',fontWeight:900,color:C.darkGreen,textTransform:'uppercase',fontSize:11,letterSpacing:1}}>Total Net Payroll</td>
                    <td style={{padding:'10px',fontWeight:900,color:C.darkGreen,fontSize:13}}>{fmt(filteredNetPayroll)}</td>
                    <td/>
                  </tr></tfoot>
                </table>}
              </SectionCard>
            </div>
            )
          })()}

          {/* ── QUOTATION PIPELINE ── */}
          {activeReport==='quotations'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
                {['Draft','Sent','Approved','Invoiced'].map((s,i)=>{
                  const qs=quotations.filter(q=>q.status===s)
                  const val=qs.reduce((a,q)=>a+quotationGrandTotal(q),0)
                  return<KpiCard key={s} label={s} value={qs.length} sub={fmt(val)} color={[C.gray,C.blue,C.accent,C.purple][i]} icon={['📝','📤','✅','🧾'][i]}/>
                })}
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Pipeline Value by Status">
                  {quoStatusData.length>0?<DonutChart data={quoStatusData} size={150}/>:<div style={{padding:40,textAlign:'center',color:C.gray}}>No data</div>}
                </SectionCard>
                <SectionCard title="Quotation Value Trend">
                  {(()=>{
                    const m:Record<string,number>={}
                    quotations.forEach(q=>{
                      const mo=q.date?.slice(0,7); if(!mo) return
                      m[mo]=(m[mo]||0)+quotationGrandTotal(q)
                    })
                    const d=Object.entries(m).sort().map(([k,v])=>({label:k.slice(5),value:v}))
                    return d.length>=2?<LineChart data={d} height={160} color={C.blue}/>:<div style={{padding:40,textAlign:'center',color:C.gray,fontSize:12}}>Not enough data</div>
                  })()}
                </SectionCard>
              </div>

              <SectionCard title="Quotation List" span>
                {quotations.length===0?<div style={{textAlign:'center',padding:30,color:C.gray}}>No quotations in selected range.</div>
                :<>
                <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>
                  {`Showing ${(quotationsCurrentPage-1)*PAGE_SIZE+1}–${Math.min(quotationsCurrentPage*PAGE_SIZE,sortedQuotations.length)} of ${sortedQuotations.length}`}
                </div>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                    {['ID','Client','Date','Valid Until','Items','Subtotal','VAT','Total','Status'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>)}
                  </tr></thead>
                  <tbody>{pagedQuotations.map((q,i)=>{
                    const sub=itemsOnlySum(q.quotation_items||[])
                    const discountAmount=sub*(Number(q.discount_pct)||0)/100
                    const total=quotationGrandTotal(q)
                    const tax=total-(sub-discountAmount)
                    return<tr key={q.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                      <td style={{padding:'8px 12px',fontWeight:800,color:C.darkGreen,fontSize:11}}>{q.id}</td>
                      <td style={{padding:'8px 12px',fontWeight:600}}>{q.client}</td>
                      <td style={{padding:'8px 12px',color:C.gray}}>{q.date}</td>
                      <td style={{padding:'8px 12px',color:C.gray}}>{q.valid_until}</td>
                      <td style={{padding:'8px 12px',color:C.gray,textAlign:'center'}}>{(q.quotation_items||[]).filter((it:any)=>it.kind==='item').length}</td>
                      <td style={{padding:'8px 12px'}}>{fmt(sub)}</td>
                      <td style={{padding:'8px 12px',color:C.gray}}>{fmt(tax)}</td>
                      <td style={{padding:'8px 12px',fontWeight:800,color:C.accent}}>{fmt(total)}</td>
                      <td style={{padding:'8px 12px'}}>
                        <span style={{padding:'3px 10px',borderRadius:20,background:`${[C.gray,C.blue,C.accent,C.purple,C.red][['Draft','Sent','Approved','Invoiced','Cancelled'].indexOf(q.status)]||C.gray}22`,color:[C.gray,C.blue,C.accent,C.purple,C.red][['Draft','Sent','Approved','Invoiced','Cancelled'].indexOf(q.status)]||C.gray,fontSize:10,fontWeight:800,border:'1px solid currentColor'}}>{q.status}</span>
                      </td>
                    </tr>
                  })}</tbody>
                  <tfoot><tr style={{background:`${C.accent}0a`,borderTop:`2px solid ${C.accent}44`}}>
                    <td colSpan={7} style={{padding:'10px 12px',fontWeight:900,color:C.darkGreen,textTransform:'uppercase',fontSize:11}}>Pipeline Total</td>
                    <td style={{padding:'10px 12px',fontWeight:900,color:C.accent,fontSize:13}}>{fmt(quoPipeline)}</td>
                    <td/>
                  </tr></tfoot>
                </table>
                {quotationsPageCount>1 && (
                  <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:16}}>
                    <button onClick={()=>setQuotationsPage(p=>Math.max(1,p-1))} disabled={quotationsCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:quotationsCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:quotationsCurrentPage===1?'default':'pointer'}}>← Prev</button>
                    <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {quotationsCurrentPage} of {quotationsPageCount}</span>
                    <button onClick={()=>setQuotationsPage(p=>Math.min(quotationsPageCount,p+1))} disabled={quotationsCurrentPage===quotationsPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:quotationsCurrentPage===quotationsPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:quotationsCurrentPage===quotationsPageCount?'default':'pointer'}}>Next →</button>
                  </div>
                )}
                </>}
              </SectionCard>
            </div>
          )}

          {/* ── PROJECT STATUS ── */}
          {activeReport==='projects'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
                {['Active','On Hold','Completed','Cancelled'].map((s,i)=>{
                  const ps=projects.filter(p=>p.status===s)
                  const val=ps.reduce((a,p)=>a+Number(p.value||0),0)
                  return<KpiCard key={s} label={s} value={ps.length} sub={`${fmt(val)} total value`} color={[C.accent,C.amber,C.blue,C.red][i]} icon={['🚧','⏸','✅','❌'][i]}/>
                })}
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Project Count by Status">
                  <DonutChart data={projCounts.filter(d=>d.value>0).map(d=>({...d,value:d.value}))} size={150}/>
                </SectionCard>
                <SectionCard title="Project Value by Status">
                  <BarChart data={['Active','On Hold','Completed','Cancelled'].map((s,i)=>({label:s,value:projects.filter(p=>p.status===s).reduce((a,p)=>a+Number(p.value||0),0)}))} height={160} color={C.accent}/>
                </SectionCard>
              </div>

              <SectionCard title="All Projects" span>
                {projects.length===0?<div style={{textAlign:'center',padding:30,color:C.gray}}>No projects found.</div>
                :<>
                <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>
                  {`Showing ${(projectsCurrentPage-1)*PAGE_SIZE+1}–${Math.min(projectsCurrentPage*PAGE_SIZE,sortedProjects.length)} of ${sortedProjects.length}`}
                </div>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                    {['ID','Project Name','Client','Type','Value','Start','End','Progress','Manager','Status'].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>)}
                  </tr></thead>
                  <tbody>{pagedProjects.map((p,i)=>(
                    <tr key={p.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                      <td style={{padding:'8px 10px',fontWeight:800,color:C.darkGreen,fontSize:10}}>{p.id}</td>
                      <td style={{padding:'8px 10px',fontWeight:700}}>{p.name}</td>
                      <td style={{padding:'8px 10px',color:C.gray}}>{p.client}</td>
                      <td style={{padding:'8px 10px',color:C.gray}}>{p.type}</td>
                      <td style={{padding:'8px 10px',fontWeight:800,color:C.accent}}>{fmt(p.value||0)}</td>
                      <td style={{padding:'8px 10px',color:C.gray,fontSize:11}}>{p.start_date}</td>
                      <td style={{padding:'8px 10px',color:C.gray,fontSize:11}}>{p.end_date}</td>
                      <td style={{padding:'8px 10px',minWidth:110}}>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <div style={{flex:1,background:C.lightGray,borderRadius:4,height:7,overflow:'hidden'}}>
                            <div style={{width:`${p.progress||0}%`,height:'100%',background:`linear-gradient(90deg,${C.accent},${C.limeGreen})`,borderRadius:4}}/>
                          </div>
                          <span style={{fontSize:10,fontWeight:700,color:C.gray}}>{p.progress||0}%</span>
                        </div>
                      </td>
                      <td style={{padding:'8px 10px',color:C.gray,fontSize:11}}>{p.manager}</td>
                      <td style={{padding:'8px 10px'}}>
                        <span style={{padding:'3px 10px',borderRadius:20,background:`${[C.accent,C.amber,C.blue,C.red][['Active','On Hold','Completed','Cancelled'].indexOf(p.status)]||C.gray}22`,color:[C.accent,C.amber,C.blue,C.red][['Active','On Hold','Completed','Cancelled'].indexOf(p.status)]||C.gray,fontSize:10,fontWeight:800}}>{p.status}</span>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
                {projectsPageCount>1 && (
                  <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:16}}>
                    <button onClick={()=>setProjectsPage(p=>Math.max(1,p-1))} disabled={projectsCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:projectsCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:projectsCurrentPage===1?'default':'pointer'}}>← Prev</button>
                    <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {projectsCurrentPage} of {projectsPageCount}</span>
                    <button onClick={()=>setProjectsPage(p=>Math.min(projectsPageCount,p+1))} disabled={projectsCurrentPage===projectsPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:projectsCurrentPage===projectsPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:projectsCurrentPage===projectsPageCount?'default':'pointer'}}>Next →</button>
                  </div>
                )}
                </>}
              </SectionCard>
            </div>
          )}

          {/* ── INVENTORY REPORT ── */}
          {activeReport==='inventory'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
                <KpiCard label="Total Items" value={inventory.length} sub="material types" color={C.accent} icon="📦"/>
                <KpiCard label="Total Value" value={fmt(inventory.reduce((s,i)=>s+i.quantity*i.unit_cost,0))} sub="estimated stock" color={C.blue} icon="💰"/>
                <KpiCard label="Critical Stock" value={inventory.filter(i=>i.quantity<i.min_stock*0.6).length} sub="< 60% minimum" color={C.red} icon="⚠"/>
                <KpiCard label="Equipment Total" value={equipment.length} sub={`${equipment.filter(e=>e.status==='Available').length} available`} color={C.midGreen} icon="⚙"/>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Inventory Value by Supplier">
                  {supData.length>0?<BarChart data={supData} height={160} color={C.blue}/>:<div style={{padding:40,textAlign:'center',color:C.gray}}>No data</div>}
                </SectionCard>
                <SectionCard title="Stock Status Overview">
                  <DonutChart data={[
                    {label:'OK (≥ min)',value:inventory.filter(i=>i.quantity>=i.min_stock).length,color:C.accent},
                    {label:'Low (< min)',value:inventory.filter(i=>i.quantity>=i.min_stock*0.6&&i.quantity<i.min_stock).length,color:C.amber},
                    {label:'Critical (< 60%)',value:inventory.filter(i=>i.quantity<i.min_stock*0.6).length,color:C.red},
                  ].filter(d=>d.value>0)} size={140}/>
                </SectionCard>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
                <SectionCard title="Materials Inventory">
                  {inventory.length===0?<div style={{textAlign:'center',padding:30,color:C.gray}}>No inventory.</div>
                  :<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                      {['ID','Name','Qty','Min','Value','Status'].map(h=><th key={h} style={{padding:'7px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:9,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                    </tr></thead>
                    <tbody>{inventory.map((item,i)=>{
                      const pct=item.min_stock>0?item.quantity/item.min_stock*100:100
                      const c=pct<60?C.red:pct<100?C.amber:C.accent
                      return<tr key={item.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                        <td style={{padding:'7px 10px',fontWeight:800,color:C.darkGreen,fontSize:9}}>{item.id}</td>
                        <td style={{padding:'7px 10px',fontWeight:600}}>{item.name}</td>
                        <td style={{padding:'7px 10px',fontWeight:800,color:item.quantity<item.min_stock?C.red:C.dark}}>{item.quantity}</td>
                        <td style={{padding:'7px 10px',color:C.gray}}>{item.min_stock}</td>
                        <td style={{padding:'7px 10px',fontWeight:700,color:C.accent}}>{fmt(item.quantity*item.unit_cost)}</td>
                        <td style={{padding:'7px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,background:`${c}22`,color:c,fontSize:9,fontWeight:800,border:`1px solid ${c}44`}}>{pct<60?'Critical':pct<100?'Low':'OK'}</span></td>
                      </tr>
                    })}</tbody>
                  </table>}
                </SectionCard>
                <SectionCard title="Equipment Status">
                  {equipment.length===0?<div style={{textAlign:'center',padding:30,color:C.gray}}>No equipment.</div>
                  :<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                      {['ID','Name','Brand','Status','Assigned'].map(h=><th key={h} style={{padding:'7px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:9,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                    </tr></thead>
                    <tbody>{equipment.map((e,i)=>{
const statusColors = {
  Available: C.accent,
  'In Use': C.blue,
  Maintenance: C.amber,
  Retired: C.red
};
const c = statusColors[e.status as keyof typeof statusColors] || C.gray;                      return<tr key={e.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                        <td style={{padding:'7px 10px',fontWeight:800,color:C.darkGreen,fontSize:9}}>{e.id}</td>
                        <td style={{padding:'7px 10px',fontWeight:600}}>{e.name}</td>
                        <td style={{padding:'7px 10px',color:C.gray}}>{e.brand}</td>
                        <td style={{padding:'7px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,background:`${c}22`,color:c,fontSize:9,fontWeight:800,border:`1px solid ${c}44`}}>{e.status}</span></td>
                        <td style={{padding:'7px 10px',color:C.gray,fontSize:10}}>{e.assigned_to||'—'}</td>
                      </tr>
                    })}</tbody>
                  </table>}
                </SectionCard>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}