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
type Line = { date: string; ref: string; particulars: string; account: string; group: Group; debit: number; credit: number }

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

function pair(date: string, ref: string, particulars: string, amount: number, debitAcct: string, creditAcct: string): Line[] {
  if (!amount) return []
  return [
    { date, ref, particulars, account: debitAcct, group: groupOf(debitAcct), debit: amount, credit: 0 },
    { date, ref, particulars, account: creditAcct, group: groupOf(creditAcct), debit: 0, credit: amount },
  ]
}

function buildLines(d: { invoices: any[]; poInvoices: any[]; poSupplier: Record<string, string>; expenses: any[]; txns: any[] }): Line[] {
  const lines: Line[] = []
  const paidInvoiceIds = new Set<string>()
  const payExpenseIds = new Set<string>(d.poInvoices.filter(p => p.expense_id).map(p => p.expense_id))

  // Receivables: invoice issued (Dr A/R, Cr Sales) and, once paid, collected (Dr Cash, Cr A/R)
  d.invoices.filter(i => i.status !== 'Cancelled').forEach(inv => {
    const grand = invoiceGrand(inv)
    const who = inv.company_name || inv.client || ''
    lines.push(...pair(inv.date || inv.created_at?.slice(0, 10) || '', inv.id, `Invoice issued — ${who}`, grand, 'Accounts Receivable', 'Sales Revenue'))
    if (inv.status === 'Paid') {
      paidInvoiceIds.add(inv.id)
      const amt = Number(inv.collection_amount) || grand
      lines.push(...pair(inv.collection_date || inv.date || '', inv.id, `Collection — ${who}`, amt, 'Cash & Bank', 'Accounts Receivable'))
    }
  })

  // Payables: supplier invoice recorded (Dr Purchases, Cr A/P); payment (Dr A/P, Cr Cash)
  d.poInvoices.forEach(p => {
    const sup = d.poSupplier[p.purchase_order_id] || 'Supplier'
    const amt = Number(p.amount) || 0
    if (p.expense_id) {
      lines.push(...pair(p.date, p.sales_invoice_number || p.purchase_order_id, `Supplier payment — ${sup} (PO ${p.purchase_order_id})`, amt, 'Accounts Payable', 'Cash & Bank'))
    } else {
      lines.push(...pair(p.date, p.invoice_number || p.purchase_order_id, `Supplier invoice — ${sup} (PO ${p.purchase_order_id})`, amt, 'Materials Purchases', 'Accounts Payable'))
    }
  })

  // Expenses not already shown as PO payments. Unpaid ones sit in A/P until paid.
  d.expenses.filter(e => !payExpenseIds.has(e.id)).forEach(e => {
    lines.push(...pair(e.date || '', e.id, e.description || e.category || 'Expense', Number(e.amount) || 0, `Expense: ${e.category || 'Miscellaneous'}`, e.status === 'Paid' ? 'Cash & Bank' : 'Accounts Payable'))
  })

  // Bank transactions not already represented above
  d.txns.forEach(t => {
    const amt = Number(t.amount) || 0
    if (t.direction === 'Deposit') {
      if (t.invoice_id && paidInvoiceIds.has(t.invoice_id)) return
      lines.push(...pair(t.date, t.id, t.particulars || 'Deposit', amt, 'Cash & Bank', t.invoice_id ? 'Accounts Receivable' : 'Other Income'))
    } else {
      if (t.expense_id) return // the linked expense already records both sides
      const debit = t.category === 'Cash Advance' ? 'Employee Cash Advances' : t.category === 'PCF Replenishment' ? 'Petty Cash Fund' : 'Other Disbursements'
      lines.push(...pair(t.date, t.id, t.particulars || t.category || 'Withdrawal', amt, debit, 'Cash & Bank'))
    }
  })

  return lines.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.ref.localeCompare(b.ref))
}

const FILTERS: [Group | 'All', string][] = [['All', 'All'], ['Receivables', 'Receivables'], ['Payables', 'Payables'], ['Cash', 'Cash & Bank'], ['Revenue', 'Revenue'], ['Expenses', 'Expenses']]

export default function GeneralLedgerTab() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [raw, setRaw] = useState<any>(null)
  const [view, setView] = useState<'journal' | 'accounts'>('journal')
  const [filter, setFilter] = useState<Group | 'All'>('All')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    (async () => {
      setLoading(true)
      const [inv, poi, pos, sups, exp, txn] = await Promise.all([
        fetchAllPages<any>((a, b) => supabase.from('invoices').select('*, invoice_items(*)').range(a, b)),
        fetchAllPages<any>((a, b) => supabase.from('purchase_order_invoices').select('*').range(a, b)),
        fetchAllPages<any>((a, b) => supabase.from('purchase_orders').select('id,supplier_id').range(a, b)),
        supabase.from('suppliers').select('id,name'),
        fetchAllPages<any>((a, b) => supabase.from('expenses').select('*').range(a, b)),
        fetchAllPages<any>((a, b) => supabase.from('bank_transactions').select('*').range(a, b)),
      ])
      const supName: Record<string, string> = {}
      ;(sups.data || []).forEach((s: any) => { supName[s.id] = s.name })
      const poSupplier: Record<string, string> = {}
      ;(pos.data || []).forEach((p: any) => { poSupplier[p.id] = supName[p.supplier_id] || 'Supplier' })
      setRaw({ invoices: inv.data || [], poInvoices: poi.data || [], poSupplier, expenses: exp.data || [], txns: txn.data || [] })
      setLoading(false)
    })()
  }, [])

  const all = useMemo(() => (raw ? buildLines(raw) : []), [raw])

  const inPeriod = useMemo(() => all.filter(l => (!from || l.date >= from) && (!to || l.date <= to)), [all, from, to])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inPeriod.filter(l => (filter === 'All' || l.group === filter) && (!q || `${l.ref} ${l.particulars} ${l.account}`.toLowerCase().includes(q)))
  }, [inPeriod, filter, search])

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
          ['Entries in Period', String(inPeriod.length / 2 | 0), C.purple],
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
          <button onClick={exportCsv} style={{ ...input, cursor: 'pointer', fontWeight: 800, color: C.darkGreen }}>⬇ CSV</button>
        </div>

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
                    <th style={th}>Date</th><th style={th}>Ref</th><th style={th}>Particulars</th><th style={th}>Account</th>
                    <th style={{ ...th, textAlign: 'right' }}>Debit</th><th style={{ ...th, textAlign: 'right' }}>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: C.gray, padding: 30 }}>No entries for this selection.</td></tr>}
                  {shown.map((l, i) => (
                    <tr key={i}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.date}</td>
                      <td style={{ ...td, fontWeight: 700, color: C.darkGreen, whiteSpace: 'nowrap' }}>{l.ref}</td>
                      <td style={td}>{l.particulars}</td>
                      <td style={{ ...td, paddingLeft: l.credit ? 32 : 12, color: l.credit ? C.gray : C.dark }}>{l.account}</td>
                      <td style={{ ...td, ...num }}>{money(l.debit)}</td>
                      <td style={{ ...td, ...num }}>{money(l.credit)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot style={{ position: 'sticky', bottom: 0 }}>
                  <tr style={{ background: C.lightGray }}>
                    <td colSpan={4} style={{ ...td, fontWeight: 900, textTransform: 'uppercase', fontSize: 11, borderTop: `2px solid ${C.darkGreen}` }}>
                      Total {filter === 'All' && Math.abs(totalDebit - totalCredit) < 0.005 ? '(balanced)' : ''}
                    </td>
                    <td style={{ ...td, ...num, fontWeight: 900, borderTop: `2px solid ${C.darkGreen}` }}>{fmt(totalDebit)}</td>
                    <td style={{ ...td, ...num, fontWeight: 900, borderTop: `2px solid ${C.darkGreen}` }}>{fmt(totalCredit)}</td>
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
          Built automatically from existing records — invoices and collections (receivables), supplier invoices and payments (payables), expenses, and the bank ledger. Nothing is entered twice; each event is shown as a balanced debit/credit pair.
        </div>
      </div>
    </div>
  )
}
