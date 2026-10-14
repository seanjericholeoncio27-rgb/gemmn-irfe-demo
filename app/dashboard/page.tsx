'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'

const C = {
  darkGreen: '#1a4d2e', midGreen: '#2d6a4f', accent: '#39b54a',
  limeGreen: '#4caf50', white: '#ffffff', dark: '#0d1f14',
  gray: '#6b7c72', lightGray: '#e8ede9', red: '#e53e3e',
  amber: '#d97706', blue: '#2563eb', purple: '#7c3aed',
}

const fmt = (n: number) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── Shared math, mirrored exactly from each module's own authoritative page ──
// These figures kept drifting into their own independently-wrong copies (no
// vat_mode handling, a stale "Overdue" status that's never actually stored,
// a payroll formula missing half its pay/deduction fields) — every KPI below
// now goes through the same math as the page that owns that data.
const VAT_RATE = 0.12
// Mirrors InvoicesPage/QuotationsPage's calcTotals(sum, vat_mode).
function grandTotal(sum: number, vat_mode: string | null | undefined) {
  if (vat_mode === 'included') return sum
  if (vat_mode === 'exempt') return sum
  return sum * (1 + VAT_RATE) // default 'excluded'
}
// Invoices have no 'Overdue' status value in the database at all — it's a
// derived, due-date-based classification computed on the fly (see
// InvoicesPage's own isOverdue/computeDueDate). Filtering on a literal
// status==='Overdue' string, as this page used to, can never match anything.
function computeDueDate(dateStr: string, paymentTerms: string): string | null {
  if (!dateStr) return null
  const daysMatch = /(\d+)/.exec(paymentTerms || '')
  const days = daysMatch ? Number(daysMatch[1]) : 30
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
function isOverdue(inv: any): boolean {
  if (inv.status === 'Paid' || inv.status === 'Cancelled') return false
  const due = computeDueDate(inv.date, inv.payment_terms)
  if (!due) return false
  const dueDate = new Date(due + 'T00:00:00')
  dueDate.setDate(dueDate.getDate() + 1)
  return new Date() >= dueDate
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

// ── HELPERS ─────────────────────────────────────────────────────────────────

function SectionCard({ title, children, span }: { title: string; children: React.ReactNode; span?: boolean }) {
  return (
    <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', gridColumn: span ? '1/-1' : 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <div style={{ width: 4, height: 22, background: `linear-gradient(180deg,${C.accent},${C.darkGreen})`, borderRadius: 2 }} />
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 900, letterSpacing: 2, color: C.dark, textTransform: 'uppercase' }}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

function KpiCard({ label, value, sub, color = C.accent, icon, delta, higherIsBetter = true }: any) {
  const hasDelta = delta !== undefined && delta !== null && isFinite(delta)
  const isUp = hasDelta && delta > 0.5
  const isDown = hasDelta && delta < -0.5
  const isGood = (isUp && higherIsBetter) || (isDown && !higherIsBetter)
  const deltaColor = !hasDelta || (!isUp && !isDown) ? C.gray : isGood ? C.accent : C.red
  return (
    <div style={{ background: C.white, borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', borderTop: `4px solid ${color}`, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 14, right: 16, fontSize: 22, opacity: 0.12 }}>{icon}</div>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: C.gray, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: C.dark, marginTop: 5, lineHeight: 1 }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <div style={{ fontSize: 10, color: C.gray }}>{sub}</div>
        {hasDelta && (
          <span style={{ fontSize: 9, fontWeight: 800, color: deltaColor, display: 'flex', alignItems: 'center', gap: 1 }}>
            {isUp ? '▲' : isDown ? '▼' : '–'} {Math.abs(delta).toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  )
}

function Badge({ label }: { label: string }) {
  const colors: Record<string, string> = { Active: C.accent, Completed: C.blue, 'On Hold': C.amber, Paid: C.blue, Pending: C.amber, Overdue: C.red }
  const color = colors[label] || C.gray
  return <span style={{ padding: '3px 10px', borderRadius: 20, background: `${color}22`, color, fontSize: 10, fontWeight: 800, border: `1px solid ${color}44` }}>{label}</span>
}

const CAT_COLORS = ['#39b54a', '#2563eb', '#d97706', '#7c3aed', '#e53e3e', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#6366f1']

// ════════════════════════════════════════════════════════════════════════════
export default function DashboardPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)

  const today = new Date().toISOString().slice(0, 10)
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
  const [dateFrom, setDateFrom] = useState(firstOfMonth)
  const [dateTo, setDateTo] = useState(today)

  const [invoices, setInvoices] = useState<any[]>([])
  const [invoiceItems, setInvoiceItems] = useState<any[]>([])
  const [expenses, setExpenses] = useState<any[]>([])
  const [payroll, setPayroll] = useState<any[]>([])
  const [employees, setEmployees] = useState<any[]>([])
  const [quotations, setQuotations] = useState<any[]>([])
  const [inventory, setInventory] = useState<any[]>([])
  const [projects, setProjects] = useState<any[]>([])
  // Previous period (same length, immediately before the current range) —
  // powers the trend deltas on the KPI cards so numbers aren't just static.
  const [prevInvoices, setPrevInvoices] = useState<any[]>([])
  const [prevExpenses, setPrevExpenses] = useState<any[]>([])

  // Real-time cash position — point-in-time balances, deliberately NOT tied
  // to the date-range filter above (a "current bank balance" doesn't mean
  // anything for "last month"; it's always "right now").
  const [liveBankBalance, setLiveBankBalance] = useState<number | null>(null)
  const [liveOpenStatementLabel, setLiveOpenStatementLabel] = useState<string>('')
  const [livePcfFloat, setLivePcfFloat] = useState<number | null>(null)
  const [livePcfTarget, setLivePcfTarget] = useState<number | null>(null)
  const [liveCAOutstanding, setLiveCAOutstanding] = useState<number>(0)

  const fetchLiveCashPosition = useCallback(async () => {
    const { data: acct } = await supabase.from('bank_accounts').select('id').limit(1).maybeSingle()
    if (acct) {
      const { data: stmt } = await supabase.from('bank_statements').select('*').eq('bank_account_id', acct.id).eq('status', 'Open').order('start_date', { ascending: false }).limit(1).maybeSingle()
      if (stmt) {
        const { data: txns } = await supabase.from('bank_transactions').select('amount,direction').eq('bank_statement_id', stmt.id)
        const dep = (txns || []).filter((t: any) => t.direction === 'Deposit').reduce((s: number, t: any) => s + Number(t.amount), 0)
        const wd = (txns || []).filter((t: any) => t.direction === 'Withdrawal').reduce((s: number, t: any) => s + Number(t.amount), 0)
        setLiveBankBalance(Number(stmt.beginning_balance) + dep - wd)
        setLiveOpenStatementLabel(stmt.period_label)
      }
    }
    const { data: fund } = await supabase.from('petty_cash_fund').select('*').limit(1).maybeSingle()
    if (fund) {
      const { data: period } = await supabase.from('petty_cash_periods').select('*').eq('petty_cash_fund_id', fund.id).eq('status', 'Open').order('start_date', { ascending: false }).limit(1).maybeSingle()
      setLivePcfTarget(Number(fund.target_float))
      if (period) {
        const { data: vouchers } = await supabase.from('petty_cash_vouchers').select('id,petty_cash_voucher_lines(amount)').eq('petty_cash_period_id', period.id)
        const spent = (vouchers || []).reduce((s: number, v: any) => s + (v.petty_cash_voucher_lines || []).reduce((a: number, l: any) => a + Number(l.amount || 0), 0), 0)
        setLivePcfFloat(Number(fund.target_float) - spent)
      }
    }
    const { data: cas } = await supabase.from('cash_advances').select('balance').eq('status', 'Open')
    setLiveCAOutstanding((cas || []).reduce((s: number, c: any) => s + Number(c.balance || 0), 0))
  }, [])
  useEffect(() => { fetchLiveCashPosition() }, [fetchLiveCashPosition])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const spanDays = Math.max(1, Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000) + 1)
    const prevTo = new Date(dateFrom); prevTo.setDate(prevTo.getDate() - 1)
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - spanDays + 1)
    const prevFromStr = prevFrom.toISOString().slice(0, 10), prevToStr = prevTo.toISOString().slice(0, 10)

    const [
      { data: inv }, { data: invItems }, { data: exp }, { data: pay },
      { data: emps }, { data: quo }, { data: inven }, { data: proj },
      { data: pInv }, { data: pExp },
    ] = await Promise.all([
      // .range() guards against Supabase's 1000-row default cap — invoices,
      // expenses, payroll and inventory all accumulate unbounded over the
      // company's history (or, for payroll, aren't date-filtered server-side
      // at all) and can realistically pass 1000 rows the same way
      // quotations/projects already did.
      fetchAllPages<any>((from, to) => supabase.from('invoices').select('*').gte('date', dateFrom).lte('date', dateTo).order('date').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('invoice_items').select('*').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('expenses').select('*').gte('date', dateFrom).lte('date', dateTo).order('date').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('payroll').select('*, employees(*), payroll_runs(period_start,period_end)').order('created_at', { ascending: false }).range(from, to)),
      supabase.from('employees').select('*'),
      // Deliberately NOT scoped to dateFrom/dateTo like invoices/expenses
      // above — Quotation Pipeline is a current-state snapshot ("what's
      // still out there awaiting a client decision right now"), not a
      // period flow. A quotation sent last month that's still unanswered
      // belongs in Pipeline today just as much as one sent this morning;
      // filtering this fetch by the selected period silently dropped it
      // and was the real source of this card disagreeing with the
      // Quotations page's own (unscoped) Pipeline figure.
      fetchAllPages<any>((from, to) => supabase.from('quotations').select('*, quotation_items(*)').order('date').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('inventory').select('*').range(from, to)),
      fetchAllPages<any>((from, to) => supabase.from('projects').select('*').order('created_at', { ascending: false }).range(from, to)),
      supabase.from('invoices').select('*').gte('date', prevFromStr).lte('date', prevToStr),
      supabase.from('expenses').select('*').gte('date', prevFromStr).lte('date', prevToStr),
    ])
    setInvoices(inv || []); setInvoiceItems(invItems || []); setExpenses(exp || [])
    // Only payroll runs whose period actually overlaps the selected range —
    // payroll has no plain date field of its own, it's tied to payroll_runs.
    const payrollInRange = (pay || []).filter((r: any) => {
      const start = r.payroll_runs?.period_start, end = r.payroll_runs?.period_end
      if (!start || !end) return false
      return start <= dateTo && end >= dateFrom
    })
    setPayroll(payrollInRange); setEmployees(emps || []); setQuotations(quo || [])
    setInventory(inven || []); setProjects(proj || [])
    setPrevInvoices(pInv || []); setPrevExpenses(pExp || [])
    setLoading(false)
  }, [dateFrom, dateTo])

  useEffect(() => { fetchAll() }, [fetchAll])

  // ── COMPUTED METRICS ────────────────────────────────────────────────────
  const getInvTotal = (inv: any) => {
    // Only real item rows count — material sub-rows are reference-only and
    // must never be added a second time. Same fix already applied in
    // InvoicesPage/QuotationsPage; this was the missing piece here. VAT now
    // goes through the shared grandTotal() instead of always adding 12% —
    // it previously ignored vat_mode entirely, overcounting any 'included'
    // or 'exempt' invoice.
    const items = invoiceItems.filter(i => i.invoice_id === inv.id && i.kind === 'item')
    const sum = items.reduce((s: number, i: any) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0)
    return grandTotal(sum, inv.vat_mode)
  }

  // Invoices only ever store status Pending/Paid/Cancelled — 'Overdue' is a
  // derived classification (see isOverdue above), so filtering on a literal
  // status==='Overdue' string, as this page used to, always matched nothing
  // and permanently under-reported the Overdue card (and folded genuinely
  // overdue invoices into "Pending" instead). Mirrors InvoicesPage's own split.
  const paidInv = invoices.filter(i => i.status === 'Paid')
  const pendingInv = invoices.filter(i => i.status === 'Pending' && !isOverdue(i))
  const overdueInv = invoices.filter(isOverdue)
  const totalRevenue = paidInv.reduce((s, i) => s + getInvTotal(i), 0)
  const totalPending = pendingInv.reduce((s, i) => s + getInvTotal(i), 0)
  const totalOverdue = overdueInv.reduce((s, i) => s + getInvTotal(i), 0)
  // A Cancelled/voided expense never actually happened — counting it here
  // inflated Total Overhead and understated Net Income. Same fix needed on
  // the Expenses page's own "Total Expenses" tile.
  const totalExpenses = expenses.filter(e => e.status !== 'Cancelled').reduce((s, e) => s + Number(e.amount), 0)
  const netIncome = totalRevenue - totalExpenses

  // Period-over-period deltas — the "dynamic" part of the KPI cards.
  const pctDelta = (curr: number, prev: number): number | null => {
    if (prev === 0) return curr === 0 ? 0 : null // avoid a meaningless divide-by-zero jump
    return ((curr - prev) / Math.abs(prev)) * 100
  }
  const prevPaidTotal = prevInvoices.filter(i => i.status === 'Paid').reduce((s, i) => s + getInvTotal(i), 0)
  const prevPendingTotal = prevInvoices.filter(i => i.status === 'Pending' && !isOverdue(i)).reduce((s, i) => s + getInvTotal(i), 0)
  const prevExpensesTotal = prevExpenses.filter(e => e.status !== 'Cancelled').reduce((s, e) => s + Number(e.amount), 0)
  const prevNetIncome = prevPaidTotal - prevExpensesTotal
  const revenueDelta = pctDelta(totalRevenue, prevPaidTotal)
  const pendingDelta = pctDelta(totalPending, prevPendingTotal)
  const expensesDelta = pctDelta(totalExpenses, prevExpensesTotal)
  const netIncomeDelta = pctDelta(netIncome, prevNetIncome)

  // calcNet/calcGross now come from the shared, PayrollPage-mirroring
  // versions above — this used to be its own copy that treated salaried pay
  // as the full monthly rate (double the correct semi-monthly cutoff) and
  // never subtracted loan/cash-advance/other deductions.
  const totalNetPayroll = payroll.reduce((s, r) => s + calcNet(r.employees, r), 0)

  const activeProjects = projects.filter(p => p.status === 'Active')
  // Critical = below 60% of min stock, same threshold as the Inventory
  // page's own "Critical Stock" tile — this used to use the Low-Stock
  // threshold (quantity < min_stock) instead, so it silently reported
  // Critical+Low combined under the "Critical" label.
  const criticalInventory = inventory.filter(i => i.quantity < i.min_stock * 0.6)

  // Same fix already applied on the Quotations page itself — a Superseded
  // row is an old version whose value now belongs to whatever version
  // replaced it, so it must never count a second time here either.
  const currentQuotations = quotations.filter(q => q.status !== 'Superseded')
  // Pipeline = quotations actively out for a client decision only ('Sent').
  // Draft hasn't gone out yet, Approved has already flowed into Projects,
  // and Invoiced/Cancelled are terminal — counting any of those here
  // double-counts value (same fix already applied on the Quotations page).
  //
  // The grand-total math below mirrors calcTotalsWithDiscount/calcTotals on
  // the Quotations page exactly — it previously just did itemsTotal*(1+tax),
  // which skipped discount_pct entirely and always added VAT even for a
  // quotation marked vat_mode 'included' or 'exempt'. That mismatch is why
  // this card and the Quotations page's own Pipeline figure disagreed.
  const QUOTATION_VAT_RATE = 0.12
  const quotationGrandTotal = (q: any): number => {
    const itemsTotal = (q.quotation_items || [])
      .filter((i: any) => i.kind === 'item')
      .reduce((s: number, i: any) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0)
    const discountAmount = itemsTotal * (Number(q.discount_pct) || 0) / 100
    const sum = itemsTotal - discountAmount
    if (q.vat_mode === 'included' || q.vat_mode === 'exempt') return sum
    return sum * (1 + QUOTATION_VAT_RATE) // default 'excluded'
  }
  const quotationPipeline = currentQuotations
    .filter(q => q.status === 'Sent')
    .reduce((s, q) => s + quotationGrandTotal(q), 0)

  // Expense by category
  const expByCategory: Record<string, number> = {}
  expenses.forEach(e => { expByCategory[e.category] = (expByCategory[e.category] || 0) + Number(e.amount) })
  const expCatData = Object.entries(expByCategory).sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({ label, value, color: CAT_COLORS[i % CAT_COLORS.length] }))

  // Monthly revenue/expense trend
  const monthlyMap: Record<string, { revenue: number; expense: number }> = {}
  invoices.forEach(inv => {
    const m = inv.date?.slice(0, 7); if (!m) return
    if (!monthlyMap[m]) monthlyMap[m] = { revenue: 0, expense: 0 }
    if (inv.status === 'Paid') monthlyMap[m].revenue += getInvTotal(inv)
  })
  expenses.forEach(e => {
    const m = e.date?.slice(0, 7); if (!m) return
    if (!monthlyMap[m]) monthlyMap[m] = { revenue: 0, expense: 0 }
    monthlyMap[m].expense += Number(e.amount)
  })
  const monthlyData = Object.entries(monthlyMap).sort().map(([k, v]) => ({
    label: new Date(k + '-01').toLocaleDateString('en-PH', { month: 'short', year: '2-digit' }),
    a: v.revenue, b: v.expense,
  }))

  // Invoice status donut
  const invStatusData = [
    { label: 'Paid', value: paidInv.reduce((s, i) => s + getInvTotal(i), 0), color: C.blue },
    { label: 'Pending', value: totalPending, color: C.amber },
    { label: 'Overdue', value: totalOverdue, color: C.red },
  ].filter(d => d.value > 0)

  // Daily expense trend
  const dailyExpMap: Record<string, number> = {}
  expenses.forEach(e => { dailyExpMap[e.date] = (dailyExpMap[e.date] || 0) + Number(e.amount) })
  const dailyExpData = Object.entries(dailyExpMap).sort().map(([label, value]) => ({ label: label.slice(5), value }))

  return (
    <div>
      {/* Hero Banner */}
      <div style={{ background: `linear-gradient(135deg, ${C.dark} 0%, ${C.darkGreen} 60%, ${C.midGreen} 100%)`, borderRadius: 14, padding: '22px 30px', marginBottom: 20, boxShadow: `0 4px 24px ${C.dark}55` }}>
        <div style={{ color: C.accent, fontSize: 10, fontWeight: 700, letterSpacing: 3, marginBottom: 6 }}>INTEGRATED RESOURCE & FINANCIAL ECOSYSTEM — LIVE DATA</div>
        <div style={{ color: C.white, fontSize: 24, fontWeight: 900, letterSpacing: 1.5 }}>GEMMN ENGINEERING WORKS</div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 4, fontStyle: 'italic' }}>"Precision in Fabrication, Strength in Service, & Shaping Communities."</div>
      </div>

      {/* Date Range Controls */}
      <div style={{ background: C.white, borderRadius: 12, padding: '16px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2, color: C.gray, textTransform: 'uppercase', marginBottom: 8 }}>Date Range Filter</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: C.gray }}>From</label>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  style={{ padding: '8px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', color: C.dark, outline: 'none' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: C.gray }}>To</label>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                  style={{ padding: '8px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', color: C.dark, outline: 'none' }} />
              </div>
              {([
                ['This Month', () => { setDateFrom(firstOfMonth); setDateTo(today) }],
                ['Last 3 Months', () => { const d = new Date(); d.setMonth(d.getMonth() - 3); setDateFrom(d.toISOString().slice(0, 10)); setDateTo(today) }],
                ['This Year', () => { setDateFrom(`${new Date().getFullYear()}-01-01`); setDateTo(today) }],
                ['All Time', () => { setDateFrom('2020-01-01'); setDateTo(today) }],
              ] as [string, () => void][]).map(([l, fn]) => (
                <button key={l} onClick={fn}
                  style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${C.lightGray}`, background: C.white, color: C.gray, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.lightGray; e.currentTarget.style.color = C.gray }}>{l}</button>
              ))}
              <button onClick={fetchAll}
                style={{ padding: '8px 18px', background: `linear-gradient(135deg,${C.accent},${C.midGreen})`, border: 'none', borderRadius: 6, color: C.white, fontSize: 11, fontWeight: 800, letterSpacing: 1, cursor: 'pointer', fontFamily: 'inherit', boxShadow: `0 3px 10px ${C.accent}44` }}>
                {loading ? 'Loading…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ background: C.white, borderRadius: 12, padding: 60, textAlign: 'center', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <div style={{ fontSize: 13, color: C.gray, fontWeight: 700 }}>Loading dashboard data…</div>
        </div>
      ) : (
        <>
          {/* Cash Position — real-time, not affected by the date range above */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: C.accent, boxShadow: `0 0 0 3px ${C.accent}33` }} />
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2, color: C.gray, textTransform: 'uppercase' }}>Cash Position — Right Now</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
            <KpiCard label="Bank Balance" value={liveBankBalance!=null ? fmt(liveBankBalance) : '—'} sub={liveOpenStatementLabel ? `Open period: ${liveOpenStatementLabel}` : 'No open bank period'} color={C.blue} icon="🏦" />
            <KpiCard label="PCF Remaining Float" value={livePcfFloat!=null ? fmt(livePcfFloat) : '—'} sub={livePcfTarget!=null ? `Target: ${fmt(livePcfTarget)}` : 'Not set up'} color={livePcfFloat!=null && livePcfFloat<0 ? C.red : C.purple} icon="💵" />
            <KpiCard label="Cash Advances Outstanding" value={fmt(liveCAOutstanding)} sub="Pending payroll deduction" color={C.amber} icon="🧾" />
          </div>

          {/* KPI Row 1 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 16 }}>
            <KpiCard label="Revenue (Paid)" value={fmt(totalRevenue)} sub={`${paidInv.length} paid invoices`} color={C.accent} icon="💰" delta={revenueDelta} higherIsBetter />
            <KpiCard label="Pending Receivables" value={fmt(totalPending)} sub={`${pendingInv.length} unpaid invoices`} color={C.amber} icon="⏳" delta={pendingDelta} higherIsBetter={false} />
            <KpiCard label="Total Overhead" value={fmt(totalExpenses)} sub={`${expenses.length} transactions`} color={C.red} icon="📉" delta={expensesDelta} higherIsBetter={false} />
            <KpiCard label="Net Payroll" value={fmt(totalNetPayroll)} sub={`${payroll.length} records in range`} color={C.midGreen} icon="👥" />
          </div>

          {/* KPI Row 2 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
            <KpiCard label="Active Projects" value={activeProjects.length} sub={`${projects.length} total projects`} color={C.blue} icon="📁" />
            <KpiCard label="Quotation Pipeline" value={fmt(quotationPipeline)} sub={`${currentQuotations.length} quotations`} color={C.purple} icon="📋" />
            <KpiCard label="Critical Stock" value={criticalInventory.length} sub="Items below minimum" color={C.red} icon="📦" />
            <KpiCard label="Net Income" value={fmt(netIncome)} sub="Revenue minus overhead" color={netIncome >= 0 ? C.accent : C.red} icon="📊" delta={netIncomeDelta} higherIsBetter />
          </div>

          {/* Charts Row 1: Monthly Trend + Invoice Status */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 18, marginBottom: 18 }}>
            <SectionCard title="Revenue vs Expenses — Monthly Trend">
              {monthlyData.length >= 2
                ? <GroupedBar data={monthlyData} height={180} colors={[C.accent, C.red]} labels={['Revenue', 'Expenses']} windowSize={6} />
                : <div style={{ padding: '40px 0', textAlign: 'center', color: C.gray, fontSize: 12 }}>Not enough monthly data for selected range</div>}
            </SectionCard>
            <SectionCard title="Invoice Status Breakdown">
              <DonutChart data={invStatusData} size={150} />
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.lightGray}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}>
                  <span style={{ color: C.gray }}>Gross Invoiced</span>
                  {/* "Gross Invoiced" means every invoice billed in range regardless
                      of status — Overdue is still billed, just unpaid, so it must
                      be included alongside Paid and Pending, not dropped. */}
                  <span style={{ fontWeight: 800 }}>{fmt(totalRevenue + totalPending + totalOverdue)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}>
                  <span style={{ color: C.gray }}>Collection Rate</span>
                  <span style={{ fontWeight: 800, color: C.accent }}>
                    {totalRevenue + totalPending + totalOverdue > 0 ? Math.round(totalRevenue / (totalRevenue + totalPending + totalOverdue) * 100) : 0}%
                  </span>
                </div>
              </div>
            </SectionCard>
          </div>

          {/* Charts Row 2: Expense Breakdown + Daily Trend */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>
            <SectionCard title="Expense Breakdown by Category">
              <DonutChart data={expCatData} size={140} />
            </SectionCard>
            <SectionCard title="Daily Expense Trend">
              {dailyExpData.length >= 2
                ? <LineChart data={dailyExpData.slice(-14)} height={160} color={C.red} label="Last 14 Days" />
                : <div style={{ padding: '40px 0', textAlign: 'center', color: C.gray, fontSize: 12 }}>No expense data in range</div>}
            </SectionCard>
          </div>

          {/* Tables Row: Recent Invoices + Active Projects */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>
            <SectionCard title="Recent Invoices">
              {invoices.length === 0
                ? <p style={{ color: C.gray, fontSize: 12 }}>No invoices in selected range.</p>
                : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead><tr style={{ background: `linear-gradient(90deg, ${C.darkGreen}, ${C.midGreen})` }}>
                    {['Invoice', 'Client', 'Amount', 'Status'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: C.white, fontWeight: 800, fontSize: 10, letterSpacing: 1 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>{invoices.slice(0, 6).map((inv: any, i: number) => (
                    <tr key={inv.id} style={{ background: i % 2 === 0 ? C.white : '#f9fbf9', borderBottom: `1px solid ${C.lightGray}` }}>
                      <td style={{ padding: '8px 12px', fontWeight: 800, color: C.darkGreen, fontSize: 10 }}>{inv.id}</td>
                      <td style={{ padding: '8px 12px' }}>{inv.client}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: C.accent }}>{fmt(getInvTotal(inv))}</td>
                      <td style={{ padding: '8px 12px' }}><Badge label={inv.status} /></td>
                    </tr>
                  ))}</tbody>
                </table>}
            </SectionCard>

            <SectionCard title="Active Projects">
              {activeProjects.length === 0
                ? <p style={{ color: C.gray, fontSize: 12 }}>No active projects in selected range.</p>
                : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead><tr style={{ background: `linear-gradient(90deg, ${C.darkGreen}, ${C.midGreen})` }}>
                    {['Project', 'Client', 'Value', 'Progress', 'Status'].map(h => <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: C.white, fontWeight: 800, fontSize: 10, letterSpacing: 1 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>{projects.slice(0, 6).map((p: any, i: number) => (
                    <tr key={p.id} style={{ background: i % 2 === 0 ? C.white : '#f9fbf9', borderBottom: `1px solid ${C.lightGray}` }}>
                      <td style={{ padding: '8px 10px', fontWeight: 700, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</td>
                      <td style={{ padding: '8px 10px', color: C.gray, fontSize: 10 }}>{p.client}</td>
                      <td style={{ padding: '8px 10px', fontWeight: 800, color: C.accent }}>{fmt(p.value || 0)}</td>
                      <td style={{ padding: '8px 10px', minWidth: 100 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, background: C.lightGray, borderRadius: 4, height: 7, overflow: 'hidden' }}>
                            <div style={{ width: `${p.progress || 0}%`, height: '100%', background: `linear-gradient(90deg, ${C.accent}, ${C.limeGreen})`, borderRadius: 4 }} />
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, color: C.gray }}>{p.progress || 0}%</span>
                        </div>
                      </td>
                      <td style={{ padding: '8px 10px' }}><Badge label={p.status} /></td>
                    </tr>
                  ))}</tbody>
                </table>}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  )
}