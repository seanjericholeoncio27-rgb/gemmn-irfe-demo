'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'

const C = {
  darkGreen: '#1a4d2e', midGreen: '#2d6a4f', accent: '#39b54a',
  white: '#ffffff', dark: '#0d1f14', gray: '#6b7c72',
  lightGray: '#e8ede9', red: '#e53e3e', amber: '#d97706', blue: '#2563eb', purple: '#7c3aed',
}
const fmt = (n: number) => `₱ ${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money = (n: number) => (n ? Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '')

type Group = 'Receivables' | 'Payables' | 'Cash' | 'Revenue' | 'Expenses' | 'Other'
type Line = { date: string; ref: string; particulars: string; account: string; group: Group; debit: number; credit: number; key: string; po: string }
type Block = { seq: number; block_type: string; ref_table: string; ref_id: string; amount: number | null; po_number: string | null; parents: { t: string; id: string }[]; payload: any; prev_hash: string; hash: string }

// Account -> filter group. Anything unlisted that starts with "Expense:" is Expenses.
const GROUP_OF: Record<string, Group> = {
  'Accounts Receivable': 'Receivables',
  'Accounts Payable': 'Payables',
  'Cash & Bank': 'Cash',
  'Sales Revenue': 'Revenue',
  'Other Income': 'Revenue',
  'Materials Purchases': 'Expenses',
}
const groupOf = (account: string): Group => GROUP_OF[account] || (account.startsWith('Expense:') ? 'Expenses' : 'Other')

const invoiceGrand = (inv: any) => {
  const sub = (inv.invoice_items || []).filter((it: any) => it.kind === 'item').reduce((s: number, it: any) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0)
  return inv.vat_mode === 'exempt' || inv.vat_mode === 'included' ? sub : sub * 1.12
}

function pair(date: string, ref: string, particulars: string, amount: number, debitAcct: string, creditAcct: string, key = '', po = ''): Line[] {
  if (!amount) return []
  return [
    { date, ref, particulars, account: debitAcct, group: groupOf(debitAcct), debit: amount, credit: 0, key, po },
    { date, ref, particulars, account: creditAcct, group: groupOf(creditAcct), debit: 0, credit: amount, key, po },
  ]
}

function buildLines(d: { invoices: any[]; poInvoices: any[]; poSupplier: Record<string, string>; poProject: Record<string, string>; expenses: any[]; txns: any[] }): Line[] {
  const lines: Line[] = []
  const paidInvoiceIds = new Set<string>()
  const payExpenseIds = new Set<string>(d.poInvoices.filter(p => p.expense_id).map(p => p.expense_id))

  // Receivables: invoice issued (Dr A/R, Cr Sales) and, once paid, collected (Dr Cash, Cr A/R)
  d.invoices.filter(i => i.status !== 'Cancelled').forEach(inv => {
    const grand = invoiceGrand(inv)
    const who = inv.company_name || inv.client || ''
    lines.push(...pair(inv.date || inv.created_at?.slice(0, 10) || '', inv.id, `Invoice issued — ${who}`, grand, 'Accounts Receivable', 'Sales Revenue', `invoices:${inv.id}#r`, inv.po_number || ''))
    if (inv.status === 'Paid') {
      paidInvoiceIds.add(inv.id)
      const amt = Number(inv.collection_amount) || grand
      lines.push(...pair(inv.collection_date || inv.date || '', inv.id, `Collection — ${who}`, amt, 'Cash & Bank', 'Accounts Receivable', `invoices:${inv.id}#c`, inv.po_number || ''))
    }
  })

  // Payables: supplier invoice recorded (Dr Purchases, Cr A/P); payment (Dr A/P, Cr Cash)
  d.poInvoices.forEach(p => {
    const sup = d.poSupplier[p.purchase_order_id] || 'Supplier'
    const amt = Number(p.amount) || 0
    if (p.expense_id) {
      lines.push(...pair(p.date, p.sales_invoice_number || p.purchase_order_id, `Supplier payment — ${sup} (PO ${p.purchase_order_id})`, amt, 'Accounts Payable', 'Cash & Bank', `purchase_order_invoices:${p.id}#r`, d.poProject[p.purchase_order_id] || ''))
    } else {
      lines.push(...pair(p.date, p.invoice_number || p.purchase_order_id, `Supplier invoice — ${sup} (PO ${p.purchase_order_id})`, amt, 'Materials Purchases', 'Accounts Payable', `purchase_order_invoices:${p.id}#r`, d.poProject[p.purchase_order_id] || ''))
    }
  })

  // Expenses not already shown as PO payments. Unpaid ones sit in A/P until paid.
  d.expenses.filter(e => !payExpenseIds.has(e.id)).forEach(e => {
    lines.push(...pair(e.date || '', e.id, e.description || e.category || 'Expense', Number(e.amount) || 0, `Expense: ${e.category || 'Miscellaneous'}`, e.payment_method === 'Internal Transfer' ? 'Inventory (Stock)' : e.status === 'Paid' ? 'Cash & Bank' : 'Accounts Payable', `expenses:${e.id}#r`, e.po_number || ''))
  })

  // Bank transactions not already represented above
  d.txns.forEach(t => {
    const amt = Number(t.amount) || 0
    if (t.direction === 'Deposit') {
      if (t.invoice_id && paidInvoiceIds.has(t.invoice_id)) return
      lines.push(...pair(t.date, t.id, t.particulars || 'Deposit', amt, 'Cash & Bank', t.invoice_id ? 'Accounts Receivable' : 'Other Income', `bank_transactions:${t.id}#r`, t.po_number || ''))
    } else {
      if (t.expense_id) return // the linked expense already records both sides
      const debit = t.category === 'Cash Advance' ? 'Employee Cash Advances' : t.category === 'PCF Replenishment' ? 'Petty Cash Fund' : 'Other Disbursements'
      lines.push(...pair(t.date, t.id, t.particulars || t.category || 'Withdrawal', amt, debit, 'Cash & Bank', `bank_transactions:${t.id}#r`, t.po_number || ''))
    }
  })

  return lines.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.ref.localeCompare(b.ref))
}

const FILTERS: [Group | 'All' | 'Untraced', string][] = [['All', 'All'], ['Receivables', 'Receivables'], ['Payables', 'Payables'], ['Cash', 'Cash & Bank'], ['Revenue', 'Revenue'], ['Expenses', 'Expenses'], ['Untraced', 'Untraced']]

export default function GeneralLedgerTab() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [raw, setRaw] = useState<any>(null)
  const [view, setView] = useState<'journal' | 'accounts'>('journal')
  const [filter, setFilter] = useState<Group | 'All' | 'Untraced'>('All')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [blocks, setBlocks] = useState<Block[] | null>(null)      // null = chain not installed yet
  const [untraced, setUntraced] = useState<any[]>([])
  const [verify, setVerify] = useState<{ ok: boolean; problems: any[]; at: string } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [traceKey, setTraceKey] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      const [inv, poi, pos, sups, exp, txn, chain, unt] = await Promise.all([
        fetchAllPages<any>((a, b) => supabase.from('invoices').select('*, invoice_items(*)').range(a, b)),
        fetchAllPages<any>((a, b) => supabase.from('purchase_order_invoices').select('*').range(a, b)),
        fetchAllPages<any>((a, b) => supabase.from('purchase_orders').select('id,supplier_id').range(a, b)),
        supabase.from('suppliers').select('id,name'),
        fetchAllPages<any>((a, b) => supabase.from('expenses').select('*').range(a, b)),
        fetchAllPages<any>((a, b) => supabase.from('bank_transactions').select('*').range(a, b)),
        fetchAllPages<any>((a, b) => supabase.from('ledger_chain').select('*').order('seq').range(a, b)).then((r: any) => ({ data: r.data, error: null as any })).catch((e: any) => ({ data: [] as any[], error: e })),
        supabase.from('ledger_untraced').select('*'),
      ])
      const supName: Record<string, string> = {}
      ;(sups.data || []).forEach((s: any) => { supName[s.id] = s.name })
      const poSupplier: Record<string, string> = {}
      const poProject: Record<string, string> = {}
      ;(pos.data || []).forEach((p: any) => { poSupplier[p.id] = supName[p.supplier_id] || 'Supplier'; poProject[p.id] = p.po_number || '' })
      setRaw({ invoices: inv.data || [], poInvoices: poi.data || [], poSupplier, poProject, expenses: exp.data || [], txns: txn.data || [] })
      setBlocks(chain.error ? null : ((chain.data || []) as Block[]))
      setUntraced(unt.error ? [] : (unt.data || []))
      setLoading(false)
    })()
  }, [])

  const all = useMemo(() => (raw ? buildLines(raw) : []), [raw])

  // ── chain index: first block per record/stream, plus parent/child links ──
  const streamOf = (t: string) => (t === 'Collection' || t === 'Collection Amendment' ? 'c' : 'r')
  const chain = useMemo(() => {
    const byKey: Record<string, Block[]> = {}
    const children: Record<string, Block[]> = {}
    ;(blocks || []).forEach(b => {
      const k = `${b.ref_table}:${b.ref_id}#${streamOf(b.block_type)}`
      ;(byKey[k] = byKey[k] || []).push(b)
      ;(b.parents || []).forEach(pr => {
        const pk = `${pr.t}:${pr.id}`
        ;(children[pk] = children[pk] || []).push(b)
      })
    })
    return { byKey, children }
  }, [blocks])
  const untracedIds = useMemo(() => new Set(untraced.map((u: any) => String(u.ref_id))), [untraced])
  const isUntraced = (l: Line) => untracedIds.has(l.key.split(':').slice(1).join(':').replace(/#.$/, ''))

  const runVerify = async () => {
    setVerifying(true)
    const { data, error } = await supabase.rpc('verify_ledger_chain')
    setVerify({ ok: !error && (data || []).length === 0, problems: error ? [{ problem: error.message }] : (data || []), at: new Date().toLocaleTimeString() })
    setVerifying(false)
  }

  const inPeriod = useMemo(() => all.filter(l => (!from || l.date >= from) && (!to || l.date <= to)), [all, from, to])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inPeriod.filter(l => (filter === 'All' || (filter === 'Untraced' ? isUntraced(l) : l.group === filter)) && (!q || `${l.ref} ${l.particulars} ${l.account}`.toLowerCase().includes(q)))
  }, [inPeriod, filter, search, untracedIds])

  const totalDebit = shown.reduce((s, l) => s + l.debit, 0)
  const totalCredit = shown.reduce((s, l) => s + l.credit, 0)

  // Per-account balances (always across the selected period, ignoring group filter)
  const accounts = useMemo(() => {
    const m: Record<string, { account: string; group: Group; debit: number; credit: number }> = {}
    inPeriod.forEach(l => {
      m[l.account] = m[l.account] || { account: l.account, group: l.group, debit: 0, credit: 0 }
      m[l.account].debit += l.debit
      m[l.account].credit += l.credit
    })
    const order = ['Cash & Bank', 'Accounts Receivable', 'Accounts Payable', 'Sales Revenue', 'Other Income', 'Materials Purchases']
    return Object.values(m).sort((a, b) => {
      const ia = order.indexOf(a.account), ib = order.indexOf(b.account)
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      return a.account.localeCompare(b.account)
    })
  }, [inPeriod])
  const bal = (acct: string) => { const a = accounts.find(x => x.account === acct); return a ? a.debit - a.credit : 0 }
  const receivable = bal('Accounts Receivable')
  const payable = -bal('Accounts Payable')
  const cashNet = bal('Cash & Bank')

  const exportCsv = () => {
    const rows = view === 'journal'
      ? [['Date', 'Ref', 'Particulars', 'Account', 'Debit', 'Credit'], ...shown.map(l => [l.date, l.ref, l.particulars, l.account, l.debit || '', l.credit || ''])]
      : [['Account', 'Debit', 'Credit', 'Balance'], ...accounts.map(a => [a.account, a.debit, a.credit, a.debit - a.credit])]
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = `accounting-ledger-${view}.csv`; a.click(); URL.revokeObjectURL(url)
  }

  const th: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: C.white, background: C.darkGreen, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, borderBottom: `1px solid ${C.lightGray}` }
  const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
  const input: React.CSSProperties = { padding: '8px 10px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit' }
  const pill = (active: boolean): React.CSSProperties => ({ padding: '7px 14px', fontSize: 11, fontWeight: 800, border: `1.5px solid ${active ? C.accent : C.lightGray}`, borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit', background: active ? C.accent : C.white, color: active ? C.white : C.gray })

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>Loading ledger…</div>

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        {[
          ['Receivables (owed to us)', fmt(receivable), C.blue],
          ['Payables (we owe)', fmt(payable), C.amber],
          ['Net Cash Movement', fmt(cashNet), cashNet >= 0 ? C.accent : C.red],
          ['Untraced Entries', blocks === null ? 'n/a' : String(untraced.length), untraced.length ? C.red : C.purple],
        ].map(([l, v, c]: any) => (
          <div key={l} style={{ background: C.white, borderRadius: 12, padding: '16px 20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', borderTop: `4px solid ${c}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: C.dark, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ background: C.white, borderRadius: 12, padding: '16px 20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <button onClick={() => setView('journal')} style={pill(view === 'journal')}>Journal (Debit / Credit)</button>
          <button onClick={() => setView('accounts')} style={pill(view === 'accounts')}>By Account</button>
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: 11, color: C.gray, fontWeight: 700 }}>From <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={input} /></label>
          <label style={{ fontSize: 11, color: C.gray, fontWeight: 700 }}>To <input type="date" value={to} onChange={e => setTo(e.target.value)} style={input} /></label>
          {(from || to) && <button onClick={() => { setFrom(''); setTo('') }} style={{ ...input, cursor: 'pointer', background: 'transparent' }}>Clear</button>}
          {blocks !== null && <button onClick={runVerify} disabled={verifying} style={{ ...input, cursor: 'pointer', fontWeight: 800, color: C.purple, borderColor: C.purple }}>{verifying ? 'Verifying…' : '⛓ Verify chain'}</button>}
          <button onClick={exportCsv} style={{ ...input, cursor: 'pointer', fontWeight: 800, color: C.darkGreen }}>⬇ CSV</button>
        </div>

        {blocks === null && (
          <div style={{ background: '#fef3c7', color: '#92400e', borderRadius: 8, padding: '10px 14px', fontSize: 12, marginBottom: 12 }}>
            The audit chain isn't installed on this database yet — run <b>05_traceability.sql</b> to seal every entry and enable tracing and verification.
          </div>
        )}
        {verify && (
          <div style={{ background: verify.ok ? '#dcfce7' : '#fee2e2', color: verify.ok ? '#166534' : '#991b1b', borderRadius: 8, padding: '10px 14px', fontSize: 12, marginBottom: 12 }}>
            {verify.ok
              ? <>✓ Chain intact — {blocks?.length ?? 0} blocks checked at {verify.at}. Every record still matches what was sealed.</>
              : <><b>✗ {verify.problems.length} problem{verify.problems.length === 1 ? '' : 's'} found</b> (checked {verify.at}):
                  <ul style={{ margin: '6px 0 0 18px' }}>{verify.problems.slice(0, 8).map((pb: any, i: number) => <li key={i}>{pb.ref_table ? `${pb.ref_table} ${pb.ref_id}: ` : ''}{pb.problem}</li>)}</ul></>}
          </div>
        )}

        {view === 'journal' && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              {FILTERS.map(([k, label]) => <button key={k} onClick={() => setFilter(k)} style={pill(filter === k)}>{label}</button>)}
              <input placeholder="Search ref, particulars, account…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...input, marginLeft: 'auto', minWidth: 230 }} />
            </div>
            <div style={{ overflowX: 'auto', maxHeight: '60vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0 }}>
                  <tr>
                    <th style={th}>Date</th><th style={th}>Ref</th><th style={th}>Particulars</th><th style={th}>Project</th><th style={th}>Account</th>
                    <th style={{ ...th, textAlign: 'right' }}>Debit</th><th style={{ ...th, textAlign: 'right' }}>Credit</th><th style={th}>Block</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: C.gray, padding: 30 }}>No entries for this selection.</td></tr>}
                  {shown.map((l, i) => (
                    <tr key={i}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.date}</td>
                      <td style={{ ...td, fontWeight: 700, color: C.darkGreen, whiteSpace: 'nowrap' }}>{l.ref}</td>
                      <td style={td}>{l.particulars}{blocks !== null && isUntraced(l) && <span title="No source record or document behind this entry" style={{ marginLeft: 6, color: C.red, fontWeight: 800 }}>⚠ untraced</span>}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: C.gray, fontSize: 11 }}>{l.po || '—'}</td>
                      <td style={{ ...td, paddingLeft: l.credit ? 32 : 12, color: l.credit ? C.gray : C.dark }}>{l.account}</td>
                      <td style={{ ...td, ...num }}>{money(l.debit)}</td>
                      <td style={{ ...td, ...num }}>{money(l.credit)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {(() => {
                          const b = chain.byKey[l.key]?.[0]
                          if (!b) return <span style={{ color: C.gray }}>—</span>
                          const n = chain.byKey[l.key].length
                          return <button onClick={() => setTraceKey(l.key)} title="Trace this entry" style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.purple, fontWeight: 800, fontSize: 11, fontFamily: 'monospace' }}>⛓ #{b.seq} · {b.hash.slice(0, 8)}{n > 1 ? ` · ${n - 1} edit${n > 2 ? 's' : ''}` : ''}</button>
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot style={{ position: 'sticky', bottom: 0 }}>
                  <tr style={{ background: C.lightGray }}>
                    <td colSpan={5} style={{ ...td, fontWeight: 900, textTransform: 'uppercase', fontSize: 11, borderTop: `2px solid ${C.darkGreen}` }}>
                      Total {filter === 'All' && Math.abs(totalDebit - totalCredit) < 0.005 ? '(balanced)' : ''}
                    </td>
                    <td style={{ ...td, ...num, fontWeight: 900, borderTop: `2px solid ${C.darkGreen}` }}>{fmt(totalDebit)}</td>
                    <td style={{ ...td, ...num, fontWeight: 900, borderTop: `2px solid ${C.darkGreen}` }}>{fmt(totalCredit)}</td>
                    <td style={{ ...td, borderTop: `2px solid ${C.darkGreen}` }} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        {view === 'accounts' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr><th style={th}>Account</th><th style={{ ...th, textAlign: 'right' }}>Debit</th><th style={{ ...th, textAlign: 'right' }}>Credit</th><th style={{ ...th, textAlign: 'right' }}>Balance</th></tr>
              </thead>
              <tbody>
                {accounts.map(a => {
                  const b = a.debit - a.credit
                  return (
                    <tr key={a.account}>
                      <td style={{ ...td, fontWeight: 700 }}>{a.account}</td>
                      <td style={{ ...td, ...num }}>{money(a.debit)}</td>
                      <td style={{ ...td, ...num }}>{money(a.credit)}</td>
                      <td style={{ ...td, ...num, fontWeight: 800 }}>{fmt(Math.abs(b))} {b === 0 ? '' : b > 0 ? 'Dr' : 'Cr'}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: C.lightGray }}>
                  <td style={{ ...td, fontWeight: 900, textTransform: 'uppercase', fontSize: 11, borderTop: `2px solid ${C.darkGreen}` }}>Total</td>
                  <td style={{ ...td, ...num, fontWeight: 900, borderTop: `2px solid ${C.darkGreen}` }}>{fmt(accounts.reduce((s, a) => s + a.debit, 0))}</td>
                  <td style={{ ...td, ...num, fontWeight: 900, borderTop: `2px solid ${C.darkGreen}` }}>{fmt(accounts.reduce((s, a) => s + a.credit, 0))}</td>
                  <td style={{ ...td, borderTop: `2px solid ${C.darkGreen}` }} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div style={{ fontSize: 10, color: C.gray, marginTop: 12, lineHeight: 1.5 }}>
          Built automatically from existing records — invoices and collections (receivables), supplier invoices and payments (payables), expenses, and the bank ledger. Nothing is entered twice; each event is shown as a balanced debit/credit pair. Each entry is sealed in a hash chain (⛓): every block records the earlier records it came from and the previous block's hash, so edits and deletions leave a visible trail and can't be made quietly.
        </div>
      </div>
      {traceKey && <TraceModal startKey={traceKey} chain={chain} onClose={() => setTraceKey(null)} />}
    </div>
  )
}

const TABLE_LABEL: Record<string, string> = {
  invoices: 'Invoice', quotations: 'Quotation', projects: 'Project', purchase_orders: 'Purchase Order', purchase_order_invoices: 'Supplier Invoice / Payment',
  expenses: 'Expense', bank_transactions: 'Bank Transaction', material_releases: 'Material Release', payroll_runs: 'Payroll Run',
  petty_cash_periods: 'Petty Cash Period', petty_cash_vouchers: 'Petty Cash Voucher', documents: 'Source Document', inventory: 'Inventory Item', project_bom: 'BOM Line', cash_advances: 'Cash Advance', outstanding_checks: 'Check',
}

// Follows the chain both ways: what this record came from, and what came after it.
function TraceModal({ startKey, chain, onClose }: { startKey: string; chain: { byKey: Record<string, Block[]>; children: Record<string, Block[]> }; onClose: () => void }) {
  const [tbl, rest] = [startKey.split(':')[0], startKey.split(':').slice(1).join(':').replace(/#.$/, '')]
  const start = chain.byKey[startKey]?.[0]
  const idx = (t: string, id: string) => chain.byKey[`${t}:${id}#r`]?.[0] || chain.byKey[`${t}:${id}#c`]?.[0]

  const ancestors: { b: Block | null; t: string; id: string; depth: number }[] = []
  const seen = new Set<string>()
  const up = (b: Block, depth: number) => {
    ;(b.parents || []).forEach(pr => {
      const k = `${pr.t}:${pr.id}`
      if (seen.has(k) || depth > 6) return
      seen.add(k)
      const pb = idx(pr.t, pr.id) || null
      ancestors.push({ b: pb, t: pr.t, id: pr.id, depth })
      if (pb) up(pb, depth + 1)
    })
  }
  if (start) up(start, 0)

  const descendants: { b: Block; depth: number }[] = []
  const seenD = new Set<string>([`${tbl}:${rest}`])
  const down = (t: string, id: string, depth: number) => {
    ;(chain.children[`${t}:${id}`] || []).forEach(c => {
      const k = `${c.ref_table}:${c.ref_id}`
      if (seenD.has(k) || depth > 6) return
      seenD.add(k)
      descendants.push({ b: c, depth })
      down(c.ref_table, c.ref_id, depth + 1)
    })
  }
  down(tbl, rest, 0)

  const node = (b: Block | null, t: string, id: string, depth: number, key: string, tone: string) => (
    <div key={key} style={{ marginLeft: depth * 18, borderLeft: `3px solid ${tone}`, background: '#f7faf8', borderRadius: 6, padding: '6px 10px', marginBottom: 6, fontSize: 12 }}>
      <div style={{ fontWeight: 800, color: C.dark }}>{TABLE_LABEL[t] || t} <span style={{ color: C.darkGreen }}>{id}</span>{b?.block_type && b.block_type !== 'Expense' ? <span style={{ color: C.gray, fontWeight: 600 }}> · {b.block_type}</span> : null}</div>
      <div style={{ color: C.gray, fontSize: 11 }}>
        {b ? <>block #{b.seq} · <span style={{ fontFamily: 'monospace' }}>{b.hash.slice(0, 12)}</span>{b.amount ? <> · {fmt(Number(b.amount))}</> : null}{b.po_number ? <> · {b.po_number}</> : null}</> : 'not sealed as a block (referenced document)'}
      </div>
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: 'white', borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ background: C.dark, color: 'white', padding: '15px 20px', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 900 }}>⛓ Trace — {TABLE_LABEL[tbl] || tbl} {rest}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto' }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', marginBottom: 8 }}>Came from</div>
          {ancestors.length === 0 && <div style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>Nothing earlier — this is where the trail starts.</div>}
          {ancestors.map((a, i) => node(a.b, a.t, a.id, a.depth, `a${i}`, C.blue))}

          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin: '14px 0 8px' }}>This entry</div>
          {node(start || null, tbl, rest, 0, 'self', C.accent)}
          {start && (chain.byKey[startKey] || []).slice(1).map((b, i) => <div key={i} style={{ fontSize: 11, color: C.amber, marginLeft: 18, marginBottom: 4 }}>✎ {b.block_type} sealed as block #{b.seq}</div>)}
          {start && <div style={{ fontSize: 10, color: C.gray, fontFamily: 'monospace', wordBreak: 'break-all', marginTop: 6 }}>prev {start.prev_hash.slice(0, 24)}… → hash {start.hash}</div>}

          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', margin: '16px 0 8px' }}>Led to</div>
          {descendants.length === 0 && <div style={{ fontSize: 12, color: C.gray }}>Nothing recorded after this yet.</div>}
          {descendants.map((d, i) => node(d.b, d.b.ref_table, d.b.ref_id, d.depth, `d${i}`, C.purple))}
        </div>
      </div>
    </div>
  )
}
