'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'
import { usePermissions } from '@/lib/permissions'
import type { Expense } from '@/app/types/index'
import GeneralLedgerTab from './GeneralLedgerTab'

const C = {
  darkGreen: '#1a4d2e', midGreen: '#2d6a4f', accent: '#39b54a',
  white: '#ffffff', dark: '#0d1f14', gray: '#6b7c72',
  lightGray: '#e8ede9', red: '#e53e3e', amber: '#d97706', blue: '#2563eb', purple: '#7c3aed',
}

const fmt = (n: number) => `₱ ${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const EXP_CATS = ['Materials/BOM', 'Utilities', 'Payroll', 'Maintenance', 'Office', 'Transportation', 'Rent', 'Marketing', 'Internet', 'Equipment', 'Equipment Financing', 'Miscellaneous']
const DEPOSIT_CATS = ['Client Payment', 'Other']
const WITHDRAWAL_CATS = ['Payroll', 'Materials', 'Supplier Payment', 'Tax', 'Cash Advance', 'PCF Replenishment', 'Other']
// Bank withdrawal category -> Accounting expense category, for the linked
// Expense row created automatically on every real withdrawal.
const BANK_TO_EXP_CAT: Record<string,string> = {
  'Payroll':'Payroll', 'Materials':'Materials/BOM', 'Supplier Payment':'Materials/BOM', 'Tax':'Miscellaneous', 'Other':'Miscellaneous',
}
// PCF voucher line categories are freeform (they've grown organically:
// "R & M EXPENSE", "R&M", "Gas/Diesel" etc.) — keyword match instead of an
// exact lookup so new/slightly-differently-worded categories still map
// sensibly instead of always falling through to Miscellaneous.
const pcfCategoryToExpCat = (cat: string): string => {
  const c = (cat||'').toLowerCase()
  if (/gas|diesel|toll|rf\b|fuel|transport/.test(c)) return 'Transportation'
  if (/material/.test(c)) return 'Materials/BOM'
  if (/meralco|water|utilit/.test(c)) return 'Utilities'
  if (/salar|benefit|sss|pag-?ibig|philhealth|allowance/.test(c)) return 'Payroll'
  if (/internet|communication/.test(c)) return 'Internet'
  if (/r\s*&\s*m|maintenance|makina/.test(c)) return 'Maintenance'
  if (/pantry|office/.test(c)) return 'Office'
  if (/rent/.test(c)) return 'Rent'
  if (/equipment/.test(c)) return 'Equipment'
  return 'Miscellaneous'
}

const BLANK = {
  id: '',
  date: new Date().toISOString().split('T')[0],
  category: 'Utilities',
  description: '',
  amount: 0,
  payment_method: 'Cash',
  receipt: '',
  po_number: '',
  status: 'Paid',
  equipment_loan_id: '',
}

function Field({ label, type = 'text', value, onChange, options, placeholder, disabled, prefix, hint, required }: any) {
  const base: React.CSSProperties = { width: '100%', padding: '9px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', color: C.dark, background: disabled ? '#f4f7f5' : '#fafcfb', boxSizing: 'border-box', outline: 'none' }
  // Data-entry UX: numeric/plain-text fields select-on-focus (click to retype),
  // plain text is forced uppercase (except notes/remarks/description/comment,
  // email and password fields — left as typed for readability/casing), and
  // blank/whitespace-only input defaults to a real value (0 / N/A) on blur so
  // the field never holds placeholder ghost text — skipped for fields that
  // have their own required-field validation elsewhere (required={true}).
  const isNumber = type === 'number'
  const isPlainText = type !== 'select' && type !== 'date' && !isNumber
  const skipUpper = /notes|remarks|description|comment|email|password/i.test(label || '')
  const onInputChange = (e: any) => onChange(isPlainText && !skipUpper ? e.target.value.toUpperCase() : e.target.value)
  const onInputFocus = (isNumber || isPlainText) ? (e: any) => e.target.select() : undefined
  const onInputBlur = (isNumber || isPlainText) && !required ? (e: any) => { if (!e.target.value.trim()) onChange(isNumber ? '0' : 'N/A') } : undefined
  const effectivePlaceholder = (isNumber || isPlainText) && !required ? undefined : placeholder

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>{label}</label>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {prefix && <span style={{ position: 'absolute', left: 12, fontSize: 13, fontWeight: 700, color: C.gray }}>{prefix} </span>}
        {type === 'select'
          ? <select value={value} onChange={e => onChange(e.target.value)} style={base} disabled={disabled}><option value="">Select…</option>{options.map((o: any) => <option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}</select>
          : <input type={type} value={value} onChange={onInputChange} onFocus={onInputFocus} onBlur={onInputBlur} placeholder={effectivePlaceholder} style={{ ...base, paddingLeft: prefix ? '28px' : '12px' }} disabled={disabled} />}
      </div>
      {hint && <div style={{fontSize:10,color:C.gray,marginTop:4}}>{hint}</div>}
    </div>
  )
}

// Derives the next expense ID from the highest existing suffix rather than
// array length — length-based numbering collides silently after a deletion
// (e.g. delete #003 out of 5, and the "next" id would wrongly regenerate #005).
function nextExpenseId(expenses: Expense[]) {
  const year = new Date().getFullYear()
  const nums = expenses
    .map(e => {
      const m = /EXP-(\d{4})-(\d+)/.exec(e.id)
      return m && Number(m[1]) === year ? Number(m[2]) : null
    })
    .filter((n): n is number => n !== null)
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `EXP-${year}-${String(next).padStart(3, '0')}`
}

export default function ExpensesPage() {
  const supabase = createClient()
  const perms = usePermissions()
  const canEdit = perms.canEditModule('expenses')
  const canEditBank = perms.canEditModule('expenses-bank')
  const canEditPcf = perms.canEditModule('expenses-pcf')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [paidInvoicesForAccounting, setPaidInvoicesForAccounting] = useState<any[]>([])
  const [equipmentLoans, setEquipmentLoans] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [selected, setSelected] = useState<Expense | null>(null)
  const [form, setForm] = useState(BLANK)
  const [error, setError] = useState('')
  const [expensesPage, setExpensesPage] = useState(1)
  const [invoicesPage, setInvoicesPage] = useState(1)
  const PAGE_SIZE = 50

  const f = (k: string) => (v: any) => setForm(p => ({ ...p, [k]: v }))

  const fetchExpenses = useCallback(async () => {
    setLoading(true)
    // PostgREST caps an unranged .select() at 1000 rows — expenses has grown
    // past that after historical data migrations, which was silently
    // truncating every KPI/total on this page, so force the full set.
    const { data } = await fetchAllPages<any>((from, to) => supabase.from('expenses').select('*').order('date', { ascending: false }).range(from, to))
    setExpenses(data || [])
    const { data: loans } = await supabase.from('equipment_loans').select('*, equipment(name)').eq('status', 'Financing')
    setEquipmentLoans(loans || [])
    // Paid invoices, shown here purely for accounting/bookkeeping visibility —
    // this is income, so it's kept completely separate from expense totals
    // and never added into any of the overhead calculations on this page.
    // Same 1000-row PostgREST cap applies here, so it's ranged too — the
    // table-scoped filter (status='Paid') narrows it, but not reliably below
    // the cap as more invoices accumulate.
    const { data: paidInv } = await fetchAllPages<any>((from, to) => supabase.from('invoices').select('*, invoice_items(*)').eq('status','Paid').order('collection_date',{ascending:false}).range(from, to))
    setPaidInvoicesForAccounting(paidInv || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { fetchExpenses() }, [fetchExpenses])

  // ── Recurring Expense Templates ──────────────────────────────────────────
  const [templates, setTemplates] = useState<any[]>([])
  const [showTemplatesModal, setShowTemplatesModal] = useState(false)
  const [templateForm, setTemplateForm] = useState({ name: '', category: 'Utilities', description: '', amount: '', payment_method: 'Cash' })
  const fetchTemplates = useCallback(async () => {
    const { data } = await supabase.from('expense_templates').select('*').order('name')
    setTemplates(data || [])
  }, [supabase])
  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  const saveTemplate = async () => {
    if (!templateForm.name.trim()) return setError('Template name is required.')
    setSaving(true); setError('')
    const { error } = await supabase.from('expense_templates').insert({
      name: templateForm.name.trim(), category: templateForm.category,
      description: templateForm.description || null, amount: Number(templateForm.amount) || 0,
      payment_method: templateForm.payment_method,
    })
    if (error) setError(error.message)
    else { setTemplateForm({ name: '', category: 'Utilities', description: '', amount: '', payment_method: 'Cash' }); await fetchTemplates() }
    setSaving(false)
  }
  const deleteTemplate = async (id: string) => {
    if (!window.confirm('Delete this template?')) return
    await supabase.from('expense_templates').delete().eq('id', id)
    await fetchTemplates()
  }
  const useTemplate = (t: any) => {
    setForm({ ...BLANK, id: nextExpenseId(expenses), category: t.category, description: t.description || '', amount: t.amount, payment_method: t.payment_method })
    setSelected(null); setError(''); setShowTemplatesModal(false); setShowModal(true)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BANK LEDGER (Phase 1) — statements, deposits/withdrawals, outstanding checks
  // ══════════════════════════════════════════════════════════════════════════
  const [tab, setTab] = useState<'overview'|'expenses'|'bank'|'pcf'|'ledger'>(() => {
    const t = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null
    return (['overview','expenses','bank','pcf','ledger'].includes(t || '') ? t : 'overview') as any
  })
  const [bankAccount, setBankAccount] = useState<any>(null)
  const [bankAccountForm, setBankAccountForm] = useState({ name: '', account_number: '', maintaining_balance: '' })
  const [statements, setStatements] = useState<any[]>([])
  const [currentStatementId, setCurrentStatementId] = useState<string>('')
  const [bankTxns, setBankTxns] = useState<any[]>([])
  const [outstandingChecks, setOutstandingChecks] = useState<any[]>([])
  const [invoicesForLinking, setInvoicesForLinking] = useState<any[]>([])
  const [employeesForCA, setEmployeesForCA] = useState<any[]>([])
  const [showTxnModal, setShowTxnModal] = useState(false)
  const [txnForm, setTxnForm] = useState<any>({ direction: 'Deposit', date: new Date().toISOString().slice(0,10), particulars: '', bank_channel: '', check_number: '', amount: '', category: 'Client Payment', invoice_id: '', employee_id: '', document_no: '', po_number: '', payroll_run_id: '' })
  const [payrollRunsForLink, setPayrollRunsForLink] = useState<any[]>([])
  const [projectsForLink, setProjectsForLink] = useState<{po_number:string,name:string}[]>([])
  useEffect(() => { supabase.from('projects').select('po_number,name').not('po_number','is',null).order('po_number',{ascending:false}).then(({data}:any)=>setProjectsForLink((data||[]).filter((p:any)=>p.po_number))) }, [])
  const [showNewStatementModal, setShowNewStatementModal] = useState(false)
  const [newStatementForm, setNewStatementForm] = useState({ period_label: '', start_date: '', end_date: '', beginning_balance: '' })
  const [passbookInput, setPassbookInput] = useState('')
  const [showCheckModal, setShowCheckModal] = useState(false)
  const [checkForm, setCheckForm] = useState({ date_issued: new Date().toISOString().slice(0,10), particulars: '', check_number: '', amount: '' })

  const fetchBankAccount = useCallback(async () => {
    const { data } = await supabase.from('bank_accounts').select('*').limit(1).maybeSingle()
    setBankAccount(data || null)
  }, [supabase])
  const fetchStatements = useCallback(async (accountId: string) => {
    const { data } = await supabase.from('bank_statements').select('*').eq('bank_account_id', accountId).order('start_date', { ascending: false })
    setStatements(data || [])
    setCurrentStatementId(prev => prev || (data && data[0]?.id) || '')
  }, [supabase])
  const fetchOutstandingChecks = useCallback(async (accountId: string) => {
    const { data } = await supabase.from('outstanding_checks').select('*').eq('bank_account_id', accountId).order('date_issued', { ascending: false })
    setOutstandingChecks(data || [])
  }, [supabase])
  const fetchBankTxns = useCallback(async (statementId: string) => {
    const { data } = await supabase.from('bank_transactions').select('*').eq('bank_statement_id', statementId).order('date')
    setBankTxns(data || [])
  }, [supabase])

  useEffect(() => { if (tab === 'overview') fetchBankAccount() }, [tab])
  useEffect(() => { if (tab === 'bank') { fetchBankAccount(); supabase.from('invoices').select('id,client,company_name,po_number,status').order('created_at',{ascending:false}).then(({data}:any)=>setInvoicesForLinking(data||[])); supabase.from('employees').select('id,name').order('name').then(({data}:any)=>setEmployeesForCA(data||[])); supabase.from('payroll_runs').select('id,period_start,period_end').order('period_end',{ascending:false}).then(({data}:any)=>setPayrollRunsForLink(data||[])) } }, [tab])
  useEffect(() => { if (bankAccount) { fetchStatements(bankAccount.id); fetchOutstandingChecks(bankAccount.id) } }, [bankAccount])
  useEffect(() => { if (currentStatementId) fetchBankTxns(currentStatementId) }, [currentStatementId])

  const currentStatement = statements.find(s => s.id === currentStatementId) || null
  const deposits = bankTxns.filter(t => t.direction === 'Deposit')
  const withdrawals = bankTxns.filter(t => t.direction === 'Withdrawal')
  const totalDeposits = deposits.reduce((s,t)=>s+Number(t.amount),0)
  const totalWithdrawals = withdrawals.reduce((s,t)=>s+Number(t.amount),0)
  const availableFundInBank = (currentStatement?.beginning_balance||0) + totalDeposits
  const bankBalance = availableFundInBank - totalWithdrawals
  const totalOutstandingChecks = outstandingChecks.filter(c=>c.status==='Outstanding').reduce((s,c)=>s+Number(c.amount),0)
  const availableFund = bankBalance - totalOutstandingChecks
  const passbookVariance = passbookInput !== '' ? Number(passbookInput) - bankBalance : null

  const createBankAccount = async () => {
    if (!bankAccountForm.name.trim()) return setError('Bank account name is required.')
    setSaving(true); setError('')
    const { error } = await supabase.from('bank_accounts').insert({
      id: `BANK-${Date.now()}`, name: bankAccountForm.name.trim(),
      account_number: bankAccountForm.account_number || null,
      maintaining_balance: Number(bankAccountForm.maintaining_balance) || 0,
    })
    if (error) setError(error.message)
    else { setBankAccountForm({ name:'', account_number:'', maintaining_balance:'' }); await fetchBankAccount() }
    setSaving(false)
  }

  const openNewStatement = async () => {
    if (!newStatementForm.period_label.trim()) return setError('Period label is required, e.g. "AUGUST 2026".')
    setSaving(true); setError('')
    const id = `STMT-${Date.now()}`
    const { error } = await supabase.from('bank_statements').insert({
      id, bank_account_id: bankAccount.id, period_label: newStatementForm.period_label.trim(),
      start_date: newStatementForm.start_date || null, end_date: newStatementForm.end_date || null,
      beginning_balance: Number(newStatementForm.beginning_balance) || 0, status: 'Open',
    })
    if (error) setError(error.message)
    else {
      setShowNewStatementModal(false); setNewStatementForm({ period_label:'', start_date:'', end_date:'', beginning_balance:'' })
      await fetchStatements(bankAccount.id); setCurrentStatementId(id)
    }
    setSaving(false)
  }

  const addTransaction = async () => {
    if (!currentStatement) return setError('Open a statement period first.')
    if (currentStatement.status === 'Closed') return setError('This period is closed — open a new one to add transactions.')
    if (!txnForm.amount || Number(txnForm.amount) <= 0) return setError('Enter a valid amount.')
    const isW = txnForm.direction === 'Withdrawal', cat = txnForm.category
    const doc = (txnForm.document_no || '').trim()
    // Traceability: every peso in or out must point at something that explains it.
    if (isW && cat === 'Cash Advance' && !txnForm.employee_id) return setError('Select which employee this cash advance is for.')
    if (!isW && cat === 'Client Payment' && !txnForm.invoice_id) return setError('Select the invoice this client payment settles.')
    if (!isW && cat !== 'Client Payment' && !doc) return setError('Enter the bank memo / reference number for this deposit.')
    if (isW && cat === 'Payroll' && !txnForm.payroll_run_id) return setError('Select the payroll run this withdrawal pays for.')
    if (isW && cat !== 'Payroll' && cat !== 'Cash Advance' && !doc) return setError('Enter the receipt / invoice / document number that supports this withdrawal.')
    setSaving(true); setError('')
    const txnId = `TXN-${Date.now()}`
    const po = txnForm.po_number || null
    const isExpensePath = isW && cat !== 'PCF Replenishment' && cat !== 'Cash Advance'
    const caId = `CA-BANK-${Date.now()}`

    // Source this transaction traces back to
    let source_type: string | null = null, source_id: string | null = null
    if (!isW) { if (cat === 'Client Payment') { source_type = 'Invoice'; source_id = txnForm.invoice_id } else { source_type = 'Bank Memo'; source_id = doc } }
    else if (cat === 'Cash Advance') { source_type = 'Cash Advance'; source_id = caId }
    else if (cat === 'Payroll') { source_type = 'Payroll'; source_id = txnForm.payroll_run_id }
    else { source_type = cat === 'PCF Replenishment' ? 'Bank Memo' : 'Supplier Receipt'; source_id = doc }

    // Real withdrawals create their linked Accounting expense FIRST, so the
    // bank transaction is sealed already pointing at it. PCF Replenishment is
    // excluded (the PCF voucher lines are the real expense) and Cash Advance is
    // a receivable, not a cost.
    let expenseId: string | null = null
    if (isExpensePath) {
      const run = payrollRunsForLink.find((r:any) => r.id === txnForm.payroll_run_id)
      expenseId = nextExpenseId(expenses)
      const { error: expErr } = await supabase.from('expenses').insert({
        id: expenseId, date: txnForm.date, category: BANK_TO_EXP_CAT[cat] || 'Miscellaneous',
        description: txnForm.particulars || cat, amount: Number(txnForm.amount),
        payment_method: txnForm.bank_channel?.toLowerCase() === 'cash' ? 'Cash' : 'Bank Transfer', status: 'Paid',
        receipt: cat === 'Payroll' ? (run ? `PAYROLL ${run.period_start}–${run.period_end}` : 'PAYROLL') : doc,
        po_number: po, source_type: cat === 'Payroll' ? 'Payroll' : 'Supplier Receipt', source_id: cat === 'Payroll' ? txnForm.payroll_run_id : doc,
      })
      if (expErr) { setError(expErr.message); setSaving(false); return }
    }

    const { error } = await supabase.from('bank_transactions').insert({
      id: txnId, bank_statement_id: currentStatement.id, bank_account_id: bankAccount.id,
      date: txnForm.date, particulars: txnForm.particulars || null, bank_channel: txnForm.bank_channel || null,
      check_number: txnForm.check_number || null, amount: Number(txnForm.amount),
      direction: txnForm.direction, category: cat, invoice_id: txnForm.invoice_id || null,
      employee_id: cat === 'Cash Advance' ? txnForm.employee_id || null : null,
      expense_id: expenseId, po_number: po, source_type, source_id,
    })
    if (error) {
      if (expenseId) await supabase.from('expenses').delete().eq('id', expenseId)
      setError(error.message); setSaving(false); return
    }

    // Cash Advance withdrawals feed Payroll's existing cash_advances system
    // (liquidation by payroll deduction already lives there).
    if (isW && cat === 'Cash Advance') {
      await supabase.from('cash_advances').insert({
        id: caId, employee_id: txnForm.employee_id,
        date_issued: txnForm.date, amount: Number(txnForm.amount), balance: Number(txnForm.amount),
        status: 'Open', notes: `Cash advance via Bank Ledger — ${txnForm.particulars || ''}`.trim(),
        bank_transaction_id: txnId,
      })
    }
    if (isExpensePath) await fetchExpenses()

    setTxnForm({ direction:'Deposit', date:new Date().toISOString().slice(0,10), particulars:'', bank_channel:'', check_number:'', amount:'', category:'Client Payment', invoice_id:'', employee_id:'', document_no:'', po_number:'', payroll_run_id:'' })
    setShowTxnModal(false)
    await fetchBankTxns(currentStatement.id)
    setSaving(false)
  }

  const deleteTransaction = async (txn: any) => {
    if (!window.confirm('Delete this transaction? Its linked Accounting expense or cash advance (if any) will also be removed.')) return
    if (txn.expense_id) await supabase.from('expenses').delete().eq('id', txn.expense_id)
    if (txn.category === 'Cash Advance') await supabase.from('cash_advances').delete().eq('bank_transaction_id', txn.id)
    await supabase.from('bank_transactions').delete().eq('id', txn.id)
    await fetchBankTxns(currentStatement.id); await fetchExpenses()
  }

  const closeStatement = async () => {
    if (!currentStatement) return
    if (passbookInput === '') return setError('Enter the passbook ending balance to close this period.')
    if (Math.abs(Number(passbookVariance)) > 0.01) {
      if (!window.confirm(`Passbook (${fmt(Number(passbookInput))}) doesn't match the computed bank balance (${fmt(bankBalance)}) — a variance of ${fmt(Number(passbookVariance))}. Close anyway?`)) return
    }
    await supabase.from('bank_statements').update({ status: 'Closed', passbook_ending_balance: Number(passbookInput) }).eq('id', currentStatement.id)
    setPassbookInput('')
    await fetchStatements(bankAccount.id)
  }

  // ── Edit / Reopen / Delete a statement period ────────────────────────────
  const [showEditStatementModal,setShowEditStatementModal]=useState(false)
  const [editStatementForm,setEditStatementForm]=useState({period_label:'',start_date:'',end_date:'',beginning_balance:''})
  const openEditStatement = () => {
    if (!currentStatement) return
    setEditStatementForm({
      period_label: currentStatement.period_label || '',
      start_date: currentStatement.start_date || '',
      end_date: currentStatement.end_date || '',
      beginning_balance: String(currentStatement.beginning_balance ?? ''),
    })
    setShowEditStatementModal(true)
  }
  const saveEditStatement = async () => {
    if (!currentStatement) return
    if (!editStatementForm.period_label.trim()) return setError('Period label is required.')
    setSaving(true); setError('')
    const { error } = await supabase.from('bank_statements').update({
      period_label: editStatementForm.period_label.trim(),
      start_date: editStatementForm.start_date || null,
      end_date: editStatementForm.end_date || null,
      beginning_balance: Number(editStatementForm.beginning_balance) || 0,
    }).eq('id', currentStatement.id)
    if (error) setError(error.message)
    else { setShowEditStatementModal(false); await fetchStatements(bankAccount.id) }
    setSaving(false)
  }
  const reopenStatement = async () => {
    if (!currentStatement) return
    if (!window.confirm('Reopen this closed period? You can add or edit transactions again, and will need to re-close it with a fresh passbook match.')) return
    await supabase.from('bank_statements').update({ status: 'Open', passbook_ending_balance: null }).eq('id', currentStatement.id)
    await fetchStatements(bankAccount.id)
  }
  const deleteStatement = async () => {
    if (!currentStatement) return
    setSaving(true); setError('')
    const { data: txns } = await supabase.from('bank_transactions').select('*').eq('bank_statement_id', currentStatement.id)
    const count = txns?.length || 0
    if (!window.confirm(`Permanently delete "${currentStatement.period_label}"${count>0 ? ` and its ${count} transaction${count===1?'':'s'} (including any linked Accounting expenses / cash advances)` : ''}? This can't be undone.`)) { setSaving(false); return }
    // Clean up every transaction's linked expense/cash advance first, same
    // as deleting one transaction at a time would — nothing gets orphaned.
    for (const txn of (txns||[])) {
      if (txn.expense_id) await supabase.from('expenses').delete().eq('id', txn.expense_id)
      if (txn.category === 'Cash Advance') await supabase.from('cash_advances').delete().eq('bank_transaction_id', txn.id)
    }
    await supabase.from('bank_transactions').delete().eq('bank_statement_id', currentStatement.id)
    const { error } = await supabase.from('bank_statements').delete().eq('id', currentStatement.id)
    if (error) { setError(error.message); setSaving(false); return }
    setCurrentStatementId('')
    await fetchStatements(bankAccount.id)
    await fetchExpenses()
    setSaving(false)
  }

  const addOutstandingCheck = async () => {
    if (!checkForm.amount || Number(checkForm.amount) <= 0) return setError('Enter a valid check amount.')
    setSaving(true); setError('')
    await supabase.from('outstanding_checks').insert({
      id: `CHK-${Date.now()}`, bank_account_id: bankAccount.id, date_issued: checkForm.date_issued,
      particulars: checkForm.particulars || null, check_number: checkForm.check_number || null,
      amount: Number(checkForm.amount), status: 'Outstanding',
    })
    setCheckForm({ date_issued: new Date().toISOString().slice(0,10), particulars:'', check_number:'', amount:'' })
    setShowCheckModal(false)
    await fetchOutstandingChecks(bankAccount.id)
    setSaving(false)
  }

  const clearCheck = async (chk: any) => {
    if (!currentStatement || currentStatement.status === 'Closed') return alert('Open (or select) the current open period first — clearing a check records a withdrawal against it.')
    if (!window.confirm(`Mark check ${chk.check_number || chk.id} as cleared? This adds a ${fmt(chk.amount)} withdrawal to the current open period.`)) return
    const txnId = `TXN-${Date.now()}`
    await supabase.from('bank_transactions').insert({
      id: txnId, bank_statement_id: currentStatement.id, bank_account_id: bankAccount.id,
      date: new Date().toISOString().slice(0,10), particulars: chk.particulars, check_number: chk.check_number,
      amount: chk.amount, direction: 'Withdrawal', category: 'Other', source_type: 'Check', source_id: chk.id,
    })
    await supabase.from('outstanding_checks').update({ status: 'Cleared', cleared_bank_transaction_id: txnId }).eq('id', chk.id)
    await fetchOutstandingChecks(bankAccount.id); await fetchBankTxns(currentStatement.id)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PETTY CASH FUND (Phase 2) — imprest system: vouchers, dynamic categories,
  // period-close replenishment back into the Bank Ledger
  // ══════════════════════════════════════════════════════════════════════════
  const [pcfFund, setPcfFund] = useState<any>(null)
  const [pcfFundForm, setPcfFundForm] = useState({ target_float: '200000' })
  const [pcfPeriods, setPcfPeriods] = useState<any[]>([])
  const [currentPcfPeriodId, setCurrentPcfPeriodId] = useState('')
  const [pcfVouchers, setPcfVouchers] = useState<any[]>([])
  const [pcfCategories, setPcfCategories] = useState<string[]>([])
  const [allPcvNumbers, setAllPcvNumbers] = useState<string[]>([])
  const [showNewPcfPeriodModal, setShowNewPcfPeriodModal] = useState(false)
  const [newPcfPeriodForm, setNewPcfPeriodForm] = useState({ period_label: '', start_date: '', end_date: '' })
  const [showVoucherModal, setShowVoucherModal] = useState(false)
  const BLANK_VOUCHER = { date: new Date().toISOString().slice(0,10), payee: '', pcv_number: '', notes: '', lines: [{ category:'', amount:'' }] }
  const [voucherForm, setVoucherForm] = useState<any>(BLANK_VOUCHER)

  const fetchPcfFund = useCallback(async () => {
    const { data } = await supabase.from('petty_cash_fund').select('*').limit(1).maybeSingle()
    setPcfFund(data || null)
  }, [supabase])
  const fetchPcfPeriods = useCallback(async (fundId: string) => {
    const { data } = await supabase.from('petty_cash_periods').select('*').eq('petty_cash_fund_id', fundId).order('start_date', { ascending: false })
    setPcfPeriods(data || [])
    setCurrentPcfPeriodId(prev => prev || (data && data[0]?.id) || '')
  }, [supabase])
  const fetchPcfVouchers = useCallback(async (periodId: string) => {
    const { data } = await supabase.from('petty_cash_vouchers').select('*, petty_cash_voucher_lines(*)').eq('petty_cash_period_id', periodId).order('date')
    setPcfVouchers(data || [])
  }, [supabase])
  const fetchPcfCategories = useCallback(async () => {
    const { data } = await supabase.from('petty_cash_voucher_lines').select('category')
    setPcfCategories(Array.from(new Set((data||[]).map((r:any)=>r.category).filter(Boolean))).sort())
  }, [supabase])
  const fetchAllPcvNumbers = useCallback(async () => {
    const { data } = await supabase.from('petty_cash_vouchers').select('pcv_number')
    setAllPcvNumbers((data||[]).map((r:any)=>r.pcv_number).filter(Boolean))
  }, [supabase])

  useEffect(() => { if (tab==='overview') fetchPcfFund() }, [tab])
  useEffect(() => { if (tab==='pcf') { fetchPcfFund(); fetchPcfCategories(); fetchAllPcvNumbers() } }, [tab])
  useEffect(() => { if (pcfFund) fetchPcfPeriods(pcfFund.id) }, [pcfFund])
  useEffect(() => { if (currentPcfPeriodId) fetchPcfVouchers(currentPcfPeriodId) }, [currentPcfPeriodId])

  const currentPcfPeriod = pcfPeriods.find(p=>p.id===currentPcfPeriodId) || null
  const voucherTotal = (v: any) => (v.petty_cash_voucher_lines||[]).reduce((s:number,l:any)=>s+Number(l.amount||0),0)
  const currentPeriodSpent = pcfVouchers.reduce((s,v)=>s+voucherTotal(v),0)
  const remainingFloat = (pcfFund?.target_float||0) - currentPeriodSpent
  const nextPcvNumber = () => {
    const nums = allPcvNumbers.map(n=>Number(n)).filter(n=>!isNaN(n))
    return String((nums.length?Math.max(...nums):0)+1).padStart(3,'0')
  }

  const createPcfFund = async () => {
    if (!bankAccount) return setError('Set up the Bank Account first (Bank Ledger tab) — the fund replenishes from it.')
    if (!pcfFundForm.target_float || Number(pcfFundForm.target_float)<=0) return setError('Enter a valid target float.')
    setSaving(true); setError('')
    const { error } = await supabase.from('petty_cash_fund').insert({
      id: `PCF-${Date.now()}`, bank_account_id: bankAccount.id, target_float: Number(pcfFundForm.target_float),
    })
    if (error) setError(error.message)
    else await fetchPcfFund()
    setSaving(false)
  }

  const openNewPcfPeriod = async () => {
    if (!newPcfPeriodForm.period_label.trim()) return setError('Period label is required, e.g. "JULY 21-31".')
    setSaving(true); setError('')
    const id = `PCFP-${Date.now()}`
    const { error } = await supabase.from('petty_cash_periods').insert({
      id, petty_cash_fund_id: pcfFund.id, period_label: newPcfPeriodForm.period_label.trim(),
      start_date: newPcfPeriodForm.start_date || null, end_date: newPcfPeriodForm.end_date || null, status: 'Open',
    })
    if (error) setError(error.message)
    else {
      setShowNewPcfPeriodModal(false); setNewPcfPeriodForm({ period_label:'', start_date:'', end_date:'' })
      await fetchPcfPeriods(pcfFund.id); setCurrentPcfPeriodId(id)
    }
    setSaving(false)
  }

  const addVoucherLine = () => setVoucherForm((p:any)=>({...p, lines:[...p.lines, {category:'',amount:''}]}))
  const updateVoucherLine = (idx:number, field:string, value:string) => setVoucherForm((p:any)=>({...p, lines: p.lines.map((l:any,i:number)=> i===idx?{...l,[field]:value}:l)}))
  const removeVoucherLine = (idx:number) => setVoucherForm((p:any)=>({...p, lines: p.lines.filter((_:any,i:number)=>i!==idx)}))

  const saveVoucher = async () => {
    if (!currentPcfPeriod) return setError('Open a PCF period first.')
    if (currentPcfPeriod.status === 'Closed') return setError('This period is closed — open a new one to add vouchers.')
    const validLines = voucherForm.lines.filter((l:any)=>l.category.trim() && Number(l.amount)>0)
    if (validLines.length===0) return setError('Add at least one category line with an amount.')
    if (!voucherForm.payee.trim()) return setError('Payee is required.')
    setSaving(true); setError('')
    const voucherId = `PCV-${Date.now()}`
    const { error: vErr } = await supabase.from('petty_cash_vouchers').insert({
      id: voucherId, petty_cash_period_id: currentPcfPeriod.id, date: voucherForm.date,
      payee: voucherForm.payee.trim(), pcv_number: voucherForm.pcv_number || nextPcvNumber(), notes: voucherForm.notes || null,
    })
    if (vErr) { setError(vErr.message); setSaving(false); return }

    // Each line is its own real cost — auto-create a linked Accounting
    // expense per line, the same way a Bank withdrawal does. This is what
    // the eventual "PCF Replenishment" bank withdrawal is standing in for,
    // so that transfer itself must never also create an expense.
    for (const line of validLines) {
      const { data: savedLine } = await supabase.from('petty_cash_voucher_lines').insert({
        id: `PCVL-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, voucher_id: voucherId,
        category: line.category.trim(), amount: Number(line.amount),
      }).select().single()
      const { data: savedExpense } = await supabase.from('expenses').insert({
        id: nextExpenseId(expenses), date: voucherForm.date, category: pcfCategoryToExpCat(line.category),
        description: `${voucherForm.payee.trim()} — ${line.category.trim()} (PCV ${voucherForm.pcv_number || nextPcvNumber()})`,
        amount: Number(line.amount), payment_method: 'Cash', status: 'Paid',
        receipt: voucherForm.pcv_number || nextPcvNumber(), source_type: 'Petty Cash Voucher', source_id: voucherId,
      }).select().single()
      if (savedLine && savedExpense) await supabase.from('petty_cash_voucher_lines').update({ expense_id: savedExpense.id }).eq('id', savedLine.id)
    }
    await fetchExpenses()

    setVoucherForm(BLANK_VOUCHER); setShowVoucherModal(false)
    await fetchPcfVouchers(currentPcfPeriod.id); await fetchPcfCategories(); await fetchAllPcvNumbers()
    setSaving(false)
  }

  const deleteVoucher = async (v: any) => {
    if (!window.confirm(`Delete voucher PCV#${v.pcv_number}? Its linked Accounting expenses will also be removed.`)) return
    for (const line of (v.petty_cash_voucher_lines||[])) {
      if (line.expense_id) await supabase.from('expenses').delete().eq('id', line.expense_id)
    }
    await supabase.from('petty_cash_voucher_lines').delete().eq('voucher_id', v.id)
    await supabase.from('petty_cash_vouchers').delete().eq('id', v.id)
    await fetchPcfVouchers(currentPcfPeriod.id); await fetchExpenses()
  }

  const closePcfPeriod = async () => {
    if (!currentPcfPeriod) return
    if (!currentStatement || currentStatement.status === 'Closed') return setError('Open a Bank Ledger period first (Bank Ledger tab) — the replenishment withdrawal needs an open period to go into.')
    if (!window.confirm(`Close "${currentPcfPeriod.period_label}" and replenish ${fmt(currentPeriodSpent)} from the bank? This creates a "PCF Replenishment" withdrawal in the current open Bank Ledger period (${currentStatement.period_label}) and resets the float to ${fmt(pcfFund.target_float)} for the next period.`)) return
    setSaving(true); setError('')
    const txnId = `TXN-${Date.now()}`
    await supabase.from('bank_transactions').insert({
      id: txnId, bank_statement_id: currentStatement.id, bank_account_id: bankAccount.id,
      date: new Date().toISOString().slice(0,10), particulars: `PCF Replenishment — ${currentPcfPeriod.period_label}`,
      amount: currentPeriodSpent, direction: 'Withdrawal', category: 'PCF Replenishment',
      source_type: 'Petty Cash', source_id: currentPcfPeriod.id,
    })
    await supabase.from('petty_cash_periods').update({ status: 'Closed', replenishment_bank_transaction_id: txnId }).eq('id', currentPcfPeriod.id)
    await fetchPcfPeriods(pcfFund.id); await fetchBankTxns(currentStatement.id)
    setSaving(false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OVERVIEW DASHBOARD — cash position trend, spend by category, PCF trend
  // ══════════════════════════════════════════════════════════════════════════
  const [overviewCashTrend, setOverviewCashTrend] = useState<{label:string,value:number}[]>([])
  const [overviewPcfTrend, setOverviewPcfTrend] = useState<{label:string,value:number}[]>([])
  const fetchOverviewData = useCallback(async () => {
    const { data: stmts } = await supabase.from('bank_statements').select('*').order('start_date')
    const stmtIds = (stmts||[]).map((s:any)=>s.id)
    const txnsByStmt: Record<string,{dep:number,wd:number}> = {}
    if (stmtIds.length) {
      const { data: txns } = await supabase.from('bank_transactions').select('bank_statement_id,amount,direction').in('bank_statement_id', stmtIds)
      ;(txns||[]).forEach((t:any) => {
        if (!txnsByStmt[t.bank_statement_id]) txnsByStmt[t.bank_statement_id] = { dep:0, wd:0 }
        if (t.direction==='Deposit') txnsByStmt[t.bank_statement_id].dep += Number(t.amount)
        else txnsByStmt[t.bank_statement_id].wd += Number(t.amount)
      })
    }
    setOverviewCashTrend((stmts||[]).map((s:any) => {
      const agg = txnsByStmt[s.id] || { dep:0, wd:0 }
      // Closed periods use the passbook-confirmed ending balance when it's
      // there — that's the number that's actually been verified — falling
      // back to the computed figure for anything still open.
      const ending = s.status==='Closed' && s.passbook_ending_balance!=null ? Number(s.passbook_ending_balance) : Number(s.beginning_balance) + agg.dep - agg.wd
      return { label: s.period_label, value: ending }
    }))

    const { data: periods } = await supabase.from('petty_cash_periods').select('*').order('start_date')
    const periodIds = (periods||[]).map((p:any)=>p.id)
    const vouchersByPeriod: Record<string,number> = {}
    if (periodIds.length) {
      const { data: vouchers } = await supabase.from('petty_cash_vouchers').select('id,petty_cash_period_id,petty_cash_voucher_lines(amount)').in('petty_cash_period_id', periodIds)
      ;(vouchers||[]).forEach((v:any) => {
        const total = (v.petty_cash_voucher_lines||[]).reduce((s:number,l:any)=>s+Number(l.amount||0),0)
        vouchersByPeriod[v.petty_cash_period_id] = (vouchersByPeriod[v.petty_cash_period_id]||0) + total
      })
    }
    setOverviewPcfTrend((periods||[]).map((p:any)=>({ label: p.period_label, value: vouchersByPeriod[p.id]||0 })))
  }, [supabase])
  useEffect(() => { if (tab === 'overview') fetchOverviewData() }, [tab])

  const openNew = () => {
    setForm({ ...BLANK, id: nextExpenseId(expenses) })
    setSelected(null)
    setError('')
    setShowModal(true)
  }

  const openEdit = (e: Expense) => {
    if (!canEdit) return
    setForm({ ...BLANK, ...e, equipment_loan_id: '' })
    setSelected(e)
    setError('')
    setShowModal(true)
  }

  const save = async () => {
    setSaving(true)
    setError('')

    const { equipment_loan_id, ...rest } = form
    const payload: any = {
      ...rest,
      amount: Number(form.amount) || 0,
      description: form.description.trim(),
      po_number: form.po_number || null,
    }
    // Traceability: a new expense needs a supporting document number, which
    // becomes its source record (PO payments, payroll and petty cash vouchers
    // set their own source automatically).
    if (!selected && !String(form.receipt || '').trim()) {
      setError('Receipt / document no. is required so this expense can be traced back.')
      setSaving(false)
      return
    }
    if (String(form.receipt || '').trim() && !payload.source_id) {
      payload.source_type = 'Supplier Receipt'
      payload.source_id = String(form.receipt).trim()
    }

    if (!payload.description) {
      setError('Description is required.')
      setSaving(false)
      return
    }
    if (payload.category === 'Equipment Financing' && !equipment_loan_id) {
      setError('Select which equipment loan this payment applies to.')
      setSaving(false)
      return
    }

    try {
      // Insert vs update, instead of a blanket upsert — an upsert on a
      // colliding ID would silently overwrite someone else's expense record.
      const { data: savedExpense, error } = selected
        ? await supabase.from('expenses').update(payload).eq('id', selected.id).select().single()
        : await supabase.from('expenses').insert(payload).select().single()

      if (error) {
        if ((error as any).code === '23505') {
          throw new Error(`Reference "${payload.id}" already exists. Please try saving again to get a fresh ID.`)
        }
        throw error
      }

      // Linking to an equipment loan writes a payment row, which fires the
      // DB trigger that reduces the loan balance automatically — same
      // mechanism as payroll cash-advance/loan deductions.
      if (equipment_loan_id) {
        const { error: eLoanPay } = await supabase.from('equipment_loan_payments').insert({
          loan_id: equipment_loan_id, expense_id: savedExpense.id,
          amount: payload.amount, date: payload.date, method: 'Linked Expense',
        })
        if (eLoanPay) throw eLoanPay
      }

      await fetchExpenses()
      setShowModal(false)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!selected || !window.confirm('Are you sure you want to delete this expense?')) return
    setSaving(true)
    const { error } = await supabase.from('expenses').delete().eq('id', selected.id)
    if (!error) { await fetchExpenses(); setShowModal(false) }
    else setError(error.message)
    setSaving(false)
  }

  // A Cancelled/voided expense never actually happened, so it shouldn't
  // count toward "all-in" totals any more than it counts toward Real Cash
  // Out below — it used to be the only one of the four KPI tiles here that
  // didn't exclude Cancelled rows, inflating Total Expenses (and the
  // category breakdown) and, downstream, understating Net Income on the
  // main dashboard.
  const nonCancelledExpenses = expenses.filter(e => e.status !== 'Cancelled')
  const totalExp = nonCancelledExpenses.reduce((s, e) => s + Number(e.amount), 0)
  // Internal Transfer entries (BOM fulfilled from existing inventory) document
  // project cost but aren't real cash leaving the business today — that cash
  // already went out when the stock was originally purchased. Cash-out totals
  // exclude them; the all-in total above still includes them for costing.
  // "Real" cash out means cash that has actually left the business — only
  // Paid rows qualify; a Pending expense hasn't moved yet and a Cancelled
  // one never will, so both are excluded here too (not just Internal Transfer).
  const totalRealCashOut = expenses.filter(e => e.payment_method !== 'Internal Transfer' && e.status === 'Paid').reduce((s, e) => s + Number(e.amount), 0)
  const expByCategory: Record<string, number> = {}
  nonCancelledExpenses.forEach(e => { expByCategory[e.category] = (expByCategory[e.category] || 0) + Number(e.amount) })

  // Most-recent-first by the expense's own business date — a bulk historical
  // import can land many rows within the same batch, so `date` (not
  // created_at) is what actually orders them correctly.
  const sortedExpenses = expenses.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  const expensesPageCount = Math.max(1, Math.ceil(sortedExpenses.length / PAGE_SIZE))
  const expensesCurrentPage = Math.min(expensesPage, expensesPageCount)
  const pagedExpenses = sortedExpenses.slice((expensesCurrentPage - 1) * PAGE_SIZE, expensesCurrentPage * PAGE_SIZE)

  // Already queried most-recent-first by collection_date; re-sort defensively
  // client-side too, same reasoning as above (and in case collection_date is
  // ever blank on an older/migrated record).
  const sortedPaidInvoices = paidInvoicesForAccounting.slice().sort((a: any, b: any) => (b.collection_date || '').localeCompare(a.collection_date || ''))
  const invoicesPageCount = Math.max(1, Math.ceil(sortedPaidInvoices.length / PAGE_SIZE))
  const invoicesCurrentPage = Math.min(invoicesPage, invoicesPageCount)
  const pagedPaidInvoices = sortedPaidInvoices.slice((invoicesCurrentPage - 1) * PAGE_SIZE, invoicesCurrentPage * PAGE_SIZE)

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [expensesPage, invoicesPage])

  return (
    <div>
      {/* Tab Nav */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {[['overview','Overview'],['expenses','Overhead & Income'],['bank','Bank Ledger'],['pcf','Petty Cash Fund'],['ledger','Accounting Ledger']].map(([key,label])=>(
          <button key={key} onClick={()=>setTab(key as any)} style={{
            padding: '9px 20px', fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
            border: `1.5px solid ${tab===key?C.accent:C.lightGray}`, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
            background: tab===key ? `linear-gradient(135deg,${C.accent},${C.midGreen})` : C.white, color: tab===key ? C.white : C.gray,
          }}>{label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <AccountingOverviewTab cashTrend={overviewCashTrend} pcfTrend={overviewPcfTrend} expByCategory={expByCategory} totalExp={totalExp} bankBalance={bankAccount ? bankBalance : null} remainingFloat={pcfFund ? remainingFloat : null} />
      )}

      {tab === 'expenses' && (<>
      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 22 }}>
        {[
          ['Total Expenses', fmt(totalExp), `${nonCancelledExpenses.length} transactions (incl. internal transfers)`, C.red],
          ['Real Cash Out', fmt(totalRealCashOut), 'excludes internal transfers', C.purple],
          ['Pending', fmt(expenses.filter(e => e.status === 'Pending').reduce((s, e) => s + Number(e.amount), 0)), `${expenses.filter(e => e.status === 'Pending').length} items`, C.amber],
          ['Paid', fmt(expenses.filter(e => e.status === 'Paid').reduce((s, e) => s + Number(e.amount), 0)), `${expenses.filter(e => e.status === 'Paid').length} items`, C.blue],
        ].map(([l, v, s, c]) => (
          <div key={l as string} style={{ background: C.white, borderRadius: 12, padding: '18px 22px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', borderTop: `4px solid ${c}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: C.gray, textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontSize: 24, fontWeight: 900, color: C.dark, marginTop: 4 }}>{v}</div>
            <div style={{ fontSize: 11, color: C.gray, marginTop: 2 }}>{s}</div>
          </div>
        ))}
      </div>

      <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
        <SectionHeader title="Overhead Expenses" action={canEdit ? '+ Add Expense' : ''} onAction={openNew} secondaryAction="📋 Templates" onSecondaryAction={() => setShowTemplatesModal(true)} />

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: C.gray }}>Loading expenses…</div>
        ) : (
          <>
          <div style={{ fontSize: 11, color: C.gray, fontWeight: 700, marginBottom: 10 }}>
            {sortedExpenses.length === 0 ? 'No expenses recorded.' : `Showing ${(expensesCurrentPage - 1) * PAGE_SIZE + 1}–${Math.min(expensesCurrentPage * PAGE_SIZE, sortedExpenses.length)} of ${sortedExpenses.length}`}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: `linear-gradient(90deg, ${C.darkGreen}, ${C.midGreen})` }}>
                {['Ref', 'Date', 'Category', 'Description', 'Amount', 'Payment', 'Receipt', 'Status'].map(h => (
                  <th key={h} style={{ padding: '9px 12px', textAlign: 'left', color: C.white, fontWeight: 800, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedExpenses.map((e, i) => (
                <tr key={e.id} onClick={() => openEdit(e)}
                  style={{ background: i % 2 === 0 ? C.white : '#f9fbf9', borderBottom: `1px solid ${C.lightGray}`, cursor: canEdit ? 'pointer' : 'default' }}>
                  <td style={{ padding: '9px 12px', fontWeight: 800, color: C.darkGreen }}>{e.id}</td>
                  <td style={{ padding: '9px 12px', color: C.gray }}>{e.date}</td>
                  <td style={{ padding: '9px 12px' }}>{e.category}</td>
                  <td style={{ padding: '9px 12px', fontWeight: 600 }}>{e.description}</td>
                  <td style={{ padding: '9px 12px', fontWeight: 800, color: C.red }}>{fmt(e.amount)}</td>
                  <td style={{ padding: '9px 12px', color: C.gray }}>{e.payment_method}</td>
                  <td style={{ padding: '9px 12px', color: C.gray }}>{e.receipt || '—'}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <span style={{ padding: '3px 10px', borderRadius: 20, background: e.status === 'Paid' ? `${C.blue}22` : `${C.amber}22`, color: e.status === 'Paid' ? C.blue : C.amber, fontSize: 10, fontWeight: 800 }}>{e.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {expensesPageCount > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 18 }}>
              <button onClick={() => setExpensesPage(p => Math.max(1, p - 1))} disabled={expensesCurrentPage === 1} style={{ padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, color: expensesCurrentPage === 1 ? C.lightGray : C.dark, fontSize: 11, fontWeight: 700, cursor: expensesCurrentPage === 1 ? 'default' : 'pointer' }}>← Prev</button>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.gray }}>Page {expensesCurrentPage} of {expensesPageCount}</span>
              <button onClick={() => setExpensesPage(p => Math.min(expensesPageCount, p + 1))} disabled={expensesCurrentPage === expensesPageCount} style={{ padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, color: expensesCurrentPage === expensesPageCount ? C.lightGray : C.dark, fontSize: 11, fontWeight: 700, cursor: expensesCurrentPage === expensesPageCount ? 'default' : 'pointer' }}>Next →</button>
            </div>
          )}
          </>
        )}
      </div>

      <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginTop: 20 }}>
        <SectionHeader title="Income — Paid Invoices (for Accounting)" />
        <div style={{ fontSize: 11, color: C.gray, marginBottom: 14, marginTop: -8 }}>Read-only record of every invoice that's been collected, kept here for bookkeeping visibility. This never counts toward any expense total on this page.</div>
        {sortedPaidInvoices.length === 0
          ? <div style={{ textAlign: 'center', padding: 30, color: C.gray, fontSize: 12 }}>No paid invoices yet.</div>
          : <>
          <div style={{ fontSize: 11, color: C.gray, fontWeight: 700, marginBottom: 10 }}>
            {`Showing ${(invoicesCurrentPage - 1) * PAGE_SIZE + 1}–${Math.min(invoicesCurrentPage * PAGE_SIZE, sortedPaidInvoices.length)} of ${sortedPaidInvoices.length}`}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: `linear-gradient(90deg,${C.darkGreen},${C.midGreen})` }}>
              {['Invoice', 'Client', 'PO', 'DR#', 'CR#', 'Collected', 'Amount'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: C.white, fontWeight: 800, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>{h}</th>)}
            </tr></thead>
            <tbody>{pagedPaidInvoices.map((inv, i) => {
              const sub = (inv.invoice_items || []).filter((it: any) => it.kind === 'item').reduce((s: number, it: any) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0)
              const total = inv.vat_mode === 'exempt' || inv.vat_mode === 'included' ? sub : sub * 1.12
              return (
                <tr key={inv.id} style={{ background: i % 2 === 0 ? C.white : '#f9fbf9', borderBottom: `1px solid ${C.lightGray}` }}>
                  <td style={{ padding: '8px 12px', fontWeight: 800, color: C.darkGreen }}>{inv.id}</td>
                  <td style={{ padding: '8px 12px' }}>{inv.client}</td>
                  <td style={{ padding: '8px 12px', color: C.gray }}>{inv.po_number || '—'}</td>
                  <td style={{ padding: '8px 12px', color: C.gray }}>{inv.dr_number || '—'}</td>
                  <td style={{ padding: '8px 12px', color: C.gray }}>{inv.cr_number || '—'}</td>
                  <td style={{ padding: '8px 12px', color: C.gray }}>{inv.collection_date || '—'}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 800, color: C.accent }}>{fmt(inv.collection_amount || total)}</td>
                </tr>
              )
            })}</tbody>
          </table>
          {invoicesPageCount > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 18 }}>
              <button onClick={() => setInvoicesPage(p => Math.max(1, p - 1))} disabled={invoicesCurrentPage === 1} style={{ padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, color: invoicesCurrentPage === 1 ? C.lightGray : C.dark, fontSize: 11, fontWeight: 700, cursor: invoicesCurrentPage === 1 ? 'default' : 'pointer' }}>← Prev</button>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.gray }}>Page {invoicesCurrentPage} of {invoicesPageCount}</span>
              <button onClick={() => setInvoicesPage(p => Math.min(invoicesPageCount, p + 1))} disabled={invoicesCurrentPage === invoicesPageCount} style={{ padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, color: invoicesCurrentPage === invoicesPageCount ? C.lightGray : C.dark, fontSize: 11, fontWeight: 700, cursor: invoicesCurrentPage === invoicesPageCount ? 'default' : 'pointer' }}>Next →</button>
            </div>
          )}
          </>}
      </div>
      </>)}

      {tab === 'bank' && (
        <BankLedgerTab
          canEdit={canEditBank} saving={saving} error={error} setError={setError}
          bankAccount={bankAccount} bankAccountForm={bankAccountForm} setBankAccountForm={setBankAccountForm} createBankAccount={createBankAccount}
          statements={statements} currentStatement={currentStatement} currentStatementId={currentStatementId} setCurrentStatementId={setCurrentStatementId}
          showNewStatementModal={showNewStatementModal} setShowNewStatementModal={setShowNewStatementModal} newStatementForm={newStatementForm} setNewStatementForm={setNewStatementForm} openNewStatement={openNewStatement}
          showEditStatementModal={showEditStatementModal} setShowEditStatementModal={setShowEditStatementModal} editStatementForm={editStatementForm} setEditStatementForm={setEditStatementForm} openEditStatement={openEditStatement} saveEditStatement={saveEditStatement}
          reopenStatement={reopenStatement} deleteStatement={deleteStatement}
          deposits={deposits} withdrawals={withdrawals} totalDeposits={totalDeposits} totalWithdrawals={totalWithdrawals}
          availableFundInBank={availableFundInBank} bankBalance={bankBalance} totalOutstandingChecks={totalOutstandingChecks} availableFund={availableFund}
          showTxnModal={showTxnModal} setShowTxnModal={setShowTxnModal} txnForm={txnForm} setTxnForm={setTxnForm} addTransaction={addTransaction} deleteTransaction={deleteTransaction}
          passbookInput={passbookInput} setPassbookInput={setPassbookInput} passbookVariance={passbookVariance} closeStatement={closeStatement}
          outstandingChecks={outstandingChecks} showCheckModal={showCheckModal} setShowCheckModal={setShowCheckModal} checkForm={checkForm} setCheckForm={setCheckForm} addOutstandingCheck={addOutstandingCheck} clearCheck={clearCheck}
          invoicesForLinking={invoicesForLinking} employeesForCA={employeesForCA} payrollRunsForLink={payrollRunsForLink} projectsForLink={projectsForLink}
        />
      )}

      {tab === 'ledger' && <GeneralLedgerTab />}

      {tab === 'pcf' && (
        <PettyCashFundTab
          canEdit={canEditPcf} saving={saving} error={error} setError={setError}
          bankAccount={bankAccount}
          pcfFund={pcfFund} pcfFundForm={pcfFundForm} setPcfFundForm={setPcfFundForm} createPcfFund={createPcfFund}
          pcfPeriods={pcfPeriods} currentPcfPeriod={currentPcfPeriod} currentPcfPeriodId={currentPcfPeriodId} setCurrentPcfPeriodId={setCurrentPcfPeriodId}
          showNewPcfPeriodModal={showNewPcfPeriodModal} setShowNewPcfPeriodModal={setShowNewPcfPeriodModal} newPcfPeriodForm={newPcfPeriodForm} setNewPcfPeriodForm={setNewPcfPeriodForm} openNewPcfPeriod={openNewPcfPeriod}
          pcfVouchers={pcfVouchers} voucherTotal={voucherTotal} currentPeriodSpent={currentPeriodSpent} remainingFloat={remainingFloat}
          showVoucherModal={showVoucherModal} setShowVoucherModal={setShowVoucherModal} voucherForm={voucherForm} setVoucherForm={setVoucherForm}
          addVoucherLine={addVoucherLine} updateVoucherLine={updateVoucherLine} removeVoucherLine={removeVoucherLine} saveVoucher={saveVoucher} deleteVoucher={deleteVoucher}
          pcfCategories={pcfCategories} nextPcvNumber={nextPcvNumber} closePcfPeriod={closePcfPeriod}
        />
      )}

      {showModal && (
        <Modal title={selected ? 'Edit Expense' : 'Add Expense'} onClose={() => setShowModal(false)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
            <Field label="Reference ID" value={form.id} disabled />
            <Field label="Date" type="date" value={form.date} onChange={f('date')} />
            <Field label="Category" type="select" value={form.category} onChange={f('category')} options={EXP_CATS} />
            <Field label="Amount" type="number" value={form.amount} onChange={f('amount')} prefix="₱" />
            {form.category === 'Equipment Financing' && (
              <div style={{ gridColumn: '1/-1', marginBottom: 14 }}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.amber, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Apply Payment To</label>
                {equipmentLoans.length === 0 ? (
                  <div style={{ fontSize: 11, color: C.gray, fontStyle: 'italic', padding: '9px 12px', background: '#f9fbf9', borderRadius: 6 }}>No equipment currently financing.</div>
                ) : (
                  <select value={form.equipment_loan_id} onChange={e => f('equipment_loan_id')(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', border: `1.5px solid ${C.amber}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', background: `${C.amber}08`, boxSizing: 'border-box' }}>
                    <option value="">Select equipment loan…</option>
                    {equipmentLoans.map((l: any) => <option key={l.id} value={l.id}>{l.equipment?.name || l.equipment_id} — {l.id} (Balance: {fmt(l.balance)})</option>)}
                  </select>
                )}
                <div style={{ fontSize: 10, color: C.gray, marginTop: 4 }}>Saving this expense reduces that equipment's loan balance automatically.</div>
              </div>
            )}
            <div style={{ gridColumn: '1/-1' }}>
              <Field label="Description" value={form.description} onChange={f('description')} placeholder="e.g. Material purchase for PRJ-101" required />
            </div>
            <Field label="Payment Method" type="select" value={form.payment_method} onChange={f('payment_method')} options={['Cash', 'Bank Transfer', 'GCash', 'Maya', 'Check', 'Internal Transfer']} />
            <Field label="Receipt / Document No. *" value={form.receipt} onChange={f('receipt')} />
            <Field label="Project PO (optional)" type="select" value={form.po_number || ''} onChange={f('po_number')} options={projectsForLink.map(p=>({value:p.po_number,label:`${p.po_number} — ${p.name}`}))} />
            <div style={{ gridColumn: '1/-1' }}>
              <Field label="Status" type="select" value={form.status} onChange={f('status')} options={['Paid', 'Pending', 'Cancelled']} />
            </div>
          </div>
          {error && <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            {selected && canEdit && <GreenBtn danger onClick={remove} disabled={saving}>Delete</GreenBtn>}
            <button onClick={() => setShowModal(false)} style={{ padding: '9px 18px', borderRadius: 6, border: `1px solid ${C.lightGray}`, cursor: 'pointer' }}>Cancel</button>
            {canEdit && <GreenBtn onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Expense'}</GreenBtn>}
          </div>
        </Modal>
      )}

      {showTemplatesModal && (
        <Modal title="Recurring Expense Templates" onClose={() => setShowTemplatesModal(false)}>
          {templates.length === 0
            ? <div style={{ fontSize: 12, color: C.gray, fontStyle: 'italic', marginBottom: 16 }}>No templates yet — save one below for expenses you enter every period (rent, utilities, subscriptions).</div>
            : (
              <div style={{ marginBottom: 16 }}>
                {templates.map(t => (
                  <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: `1px solid ${C.lightGray}`, borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: C.gray }}>{t.category} · {fmt(t.amount)} · {t.payment_method}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => useTemplate(t)} style={{ padding: '6px 14px', fontSize: 10, fontWeight: 700, background: `${C.accent}18`, border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 5, cursor: 'pointer' }}>Use</button>
                      {canEdit && <button onClick={() => deleteTemplate(t.id)} style={{ padding: '6px 10px', fontSize: 10, fontWeight: 700, background: `${C.red}18`, border: `1px solid ${C.red}44`, color: C.red, borderRadius: 5, cursor: 'pointer' }}>✕</button>}
                    </div>
                  </div>
                ))}
              </div>
            )}

          {canEdit && (
            <>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.gray, textTransform: 'uppercase', marginBottom: 10, paddingTop: 10, borderTop: `1px solid ${C.lightGray}` }}>+ New Template</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
                <Field label="Template Name" value={templateForm.name} onChange={(v: string) => setTemplateForm(p => ({ ...p, name: v }))} placeholder="e.g. Monthly Rent" required />
                <Field label="Category" type="select" value={templateForm.category} onChange={(v: string) => setTemplateForm(p => ({ ...p, category: v }))} options={EXP_CATS} />
                <Field label="Amount" type="number" value={templateForm.amount} onChange={(v: string) => setTemplateForm(p => ({ ...p, amount: v }))} prefix="₱" />
                <Field label="Payment Method" type="select" value={templateForm.payment_method} onChange={(v: string) => setTemplateForm(p => ({ ...p, payment_method: v }))} options={['Cash', 'Bank Transfer', 'GCash', 'Maya', 'Check', 'Internal Transfer']} />
                <div style={{ gridColumn: '1/-1' }}>
                  <Field label="Description" value={templateForm.description} onChange={(v: string) => setTemplateForm(p => ({ ...p, description: v }))} />
                </div>
              </div>
              {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{error}</div>}
              <GreenBtn onClick={saveTemplate} disabled={saving}>{saving ? 'Saving...' : '+ Save Template'}</GreenBtn>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

function BankLedgerTab(props: any) {
  const {
    canEdit, saving, error, setError,
    bankAccount, bankAccountForm, setBankAccountForm, createBankAccount,
    statements, currentStatement, currentStatementId, setCurrentStatementId,
    showNewStatementModal, setShowNewStatementModal, newStatementForm, setNewStatementForm, openNewStatement,
    showEditStatementModal, setShowEditStatementModal, editStatementForm, setEditStatementForm, openEditStatement, saveEditStatement,
    reopenStatement, deleteStatement,
    deposits, withdrawals, totalDeposits, totalWithdrawals,
    availableFundInBank, bankBalance, totalOutstandingChecks, availableFund,
    showTxnModal, setShowTxnModal, txnForm, setTxnForm, addTransaction, deleteTransaction,
    passbookInput, setPassbookInput, passbookVariance, closeStatement,
    outstandingChecks, showCheckModal, setShowCheckModal, checkForm, setCheckForm, addOutstandingCheck, clearCheck,
    invoicesForLinking,
    employeesForCA, payrollRunsForLink, projectsForLink,
  } = props

  if (!bankAccount) {
    return (
      <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', maxWidth: 480 }}>
        <SectionHeader title="Set Up Bank Account" />
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>One-time setup — this becomes the account this ledger tracks.</div>
        <Field label="Account Name" value={bankAccountForm.name} onChange={(v:string)=>setBankAccountForm((p:any)=>({...p,name:v}))} placeholder="e.g. GEMMN ENGINEERING WORKS" required />
        <Field label="Account Number" value={bankAccountForm.account_number} onChange={(v:string)=>setBankAccountForm((p:any)=>({...p,account_number:v}))} />
        <Field label="Maintaining Balance" type="number" value={bankAccountForm.maintaining_balance} onChange={(v:string)=>setBankAccountForm((p:any)=>({...p,maintaining_balance:v}))} prefix="₱" />
        {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{error}</div>}
        <GreenBtn onClick={createBankAccount} disabled={saving}>{saving?'Saving…':'Create Bank Account'}</GreenBtn>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 15, color: C.darkGreen }}>{bankAccount.name} {bankAccount.account_number && `(${bankAccount.account_number})`}</div>
          <div style={{ fontSize: 11, color: C.gray }}>Maintaining balance: {fmt(bankAccount.maintaining_balance)}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={currentStatementId} onChange={e=>setCurrentStatementId(e.target.value)} style={{ padding: '8px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 12, fontFamily:'inherit' }}>
            {statements.length===0 && <option value="">No periods yet</option>}
            {statements.map((s:any)=><option key={s.id} value={s.id}>{s.period_label} {s.status==='Closed'?'✓ Closed':'(Open)'}</option>)}
          </select>
          {canEdit && <GreenBtn onClick={()=>setShowNewStatementModal(true)}>+ New Period</GreenBtn>}
          {canEdit && currentStatement && <button onClick={openEditStatement} style={{padding:'9px 14px',fontSize:11,fontWeight:700,background:'transparent',border:`1px solid ${C.lightGray}`,color:C.gray,borderRadius:6,cursor:'pointer'}}>✎ Edit</button>}
          {canEdit && currentStatement?.status==='Closed' && <button onClick={reopenStatement} style={{padding:'9px 14px',fontSize:11,fontWeight:700,background:'transparent',border:`1px solid ${C.amber}66`,color:C.amber,borderRadius:6,cursor:'pointer'}}>↺ Reopen</button>}
          {canEdit && currentStatement && <button onClick={deleteStatement} disabled={saving} style={{padding:'9px 14px',fontSize:11,fontWeight:700,background:'transparent',border:`1px solid ${C.red}66`,color:C.red,borderRadius:6,cursor:'pointer'}}>🗑 Delete</button>}
        </div>
      </div>

      {!currentStatement ? (
        <div style={{ background: C.white, borderRadius: 12, padding: 40, textAlign: 'center', color: C.gray, boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>No statement period yet — click "+ New Period" to start one.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
            {[
              ['Beginning Balance', fmt(currentStatement.beginning_balance), C.gray],
              ['Available Fund in Bank', fmt(availableFundInBank), C.blue],
              ['Bank Balance', fmt(bankBalance), C.accent],
              ['Available Fund (after checks)', fmt(availableFund), C.purple],
            ].map(([l,v,c]:any)=>(
              <div key={l} style={{ background: C.white, borderRadius: 12, padding: '16px 20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', borderTop: `4px solid ${c}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase' }}>{l}</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: C.dark, marginTop: 4 }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 16 }}>
            <SectionHeader title={`Add: Deposits (${fmt(totalDeposits)})`} action={canEdit && currentStatement.status==='Open' ? '+ Add Deposit' : ''} onAction={()=>{setTxnForm((p:any)=>({...p,direction:'Deposit',category:'Client Payment'})); setShowTxnModal(true)}} />
            {deposits.length===0 ? <div style={{textAlign:'center',padding:20,color:C.gray,fontSize:12}}>No deposits recorded this period.</div> : (
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                  {['Date','Particulars','Bank','Chk#','Amount',''].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                </tr></thead>
                <tbody>{deposits.map((t:any,i:number)=>(
                  <tr key={t.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                    <td style={{padding:'8px 12px',color:C.gray}}>{t.date}</td>
                    <td style={{padding:'8px 12px',fontWeight:600}}>{t.particulars||'—'} {t.invoice_id && <span style={{color:C.blue,fontSize:10}}>({t.invoice_id})</span>}</td>
                    <td style={{padding:'8px 12px',color:C.gray}}>{t.bank_channel||'—'}</td>
                    <td style={{padding:'8px 12px',color:C.gray}}>{t.check_number||'—'}</td>
                    <td style={{padding:'8px 12px',fontWeight:800,color:C.accent}}>{fmt(t.amount)}</td>
                    <td style={{padding:'8px 12px'}}>{canEdit && currentStatement.status==='Open' && <button onClick={()=>deleteTransaction(t)} style={{background:'none',border:'none',color:C.red,cursor:'pointer',fontSize:11}}>✕</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>

          <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 16 }}>
            <SectionHeader title={`Less: Payments and Withdrawals (${fmt(totalWithdrawals)})`} action={canEdit && currentStatement.status==='Open' ? '+ Add Withdrawal' : ''} onAction={()=>{setTxnForm((p:any)=>({...p,direction:'Withdrawal',category:'Other'})); setShowTxnModal(true)}} />
            {withdrawals.length===0 ? <div style={{textAlign:'center',padding:20,color:C.gray,fontSize:12}}>No withdrawals recorded this period.</div> : (
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                  {['Date','Particulars','Category','Bank','Chk#','Amount',''].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                </tr></thead>
                <tbody>{withdrawals.map((t:any,i:number)=>(
                  <tr key={t.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                    <td style={{padding:'8px 12px',color:C.gray}}>{t.date}</td>
                    <td style={{padding:'8px 12px',fontWeight:600}}>{t.particulars||'—'}</td>
                    <td style={{padding:'8px 12px'}}><span style={{padding:'2px 8px',borderRadius:20,background:`${C.purple}18`,color:C.purple,fontSize:10,fontWeight:700}}>{t.category}</span> {t.expense_id && <span style={{fontSize:9,color:C.gray}}>→ {t.expense_id}</span>} {t.category==='Cash Advance' && t.employee_id && <span style={{fontSize:9,color:C.gray}}>→ {employeesForCA.find((e:any)=>e.id===t.employee_id)?.name || t.employee_id}</span>}</td>
                    <td style={{padding:'8px 12px',color:C.gray}}>{t.bank_channel||'—'}</td>
                    <td style={{padding:'8px 12px',color:C.gray}}>{t.check_number||'—'}</td>
                    <td style={{padding:'8px 12px',fontWeight:800,color:C.red}}>{fmt(t.amount)}</td>
                    <td style={{padding:'8px 12px'}}>{canEdit && currentStatement.status==='Open' && <button onClick={()=>deleteTransaction(t)} style={{background:'none',border:'none',color:C.red,cursor:'pointer',fontSize:11}}>✕</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>

          <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 16 }}>
            <SectionHeader title="Outstanding Checks (issued, not yet cleared)" action={canEdit ? '+ Add Check' : ''} onAction={()=>setShowCheckModal(true)} />
            {outstandingChecks.filter((c:any)=>c.status==='Outstanding').length===0 ? <div style={{textAlign:'center',padding:20,color:C.gray,fontSize:12}}>No outstanding checks.</div> : (
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                  {['Date Issued','Particulars','Chk#','Amount',''].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                </tr></thead>
                <tbody>{outstandingChecks.filter((c:any)=>c.status==='Outstanding').map((c:any,i:number)=>(
                  <tr key={c.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                    <td style={{padding:'8px 12px',color:C.gray}}>{c.date_issued}</td>
                    <td style={{padding:'8px 12px',fontWeight:600}}>{c.particulars||'—'}</td>
                    <td style={{padding:'8px 12px',color:C.gray}}>{c.check_number||'—'}</td>
                    <td style={{padding:'8px 12px',fontWeight:800,color:C.amber}}>{fmt(c.amount)}</td>
                    <td style={{padding:'8px 12px'}}>{canEdit && <button onClick={()=>clearCheck(c)} style={{padding:'4px 10px',fontSize:10,fontWeight:700,background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:5,cursor:'pointer'}}>Mark Cleared</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <div style={{fontSize:11,color:C.gray,marginTop:10}}>Total Outstanding: <strong style={{color:C.amber}}>{fmt(totalOutstandingChecks)}</strong></div>
          </div>

          <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
            <SectionHeader title="Passbook Match" />
            {currentStatement.status === 'Closed' ? (
              <div style={{fontSize:12,color:C.accent,fontWeight:700}}>✓ Closed — Passbook Ending Balance: {fmt(currentStatement.passbook_ending_balance)}</div>
            ) : (
              <>
                <div style={{fontSize:11,color:C.gray,marginBottom:10}}>Bank Balance must always match the ending balance on the physical passbook. Enter it here to close this period.</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr auto',gap:10,alignItems:'end'}}>
                  <Field label="Passbook Ending Balance" type="number" value={passbookInput} onChange={setPassbookInput} prefix="₱" />
                  {canEdit && <GreenBtn onClick={closeStatement} disabled={saving} style={{marginBottom:14}}>Close Period</GreenBtn>}
                </div>
                {passbookVariance !== null && Math.abs(passbookVariance) > 0.01 && (
                  <div style={{fontSize:12,color:C.red,fontWeight:700}}>⚠ Variance of {fmt(passbookVariance)} vs. computed Bank Balance ({fmt(bankBalance)}).</div>
                )}
                {passbookVariance !== null && Math.abs(passbookVariance) <= 0.01 && (
                  <div style={{fontSize:12,color:C.accent,fontWeight:700}}>✓ Matches computed Bank Balance.</div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {error && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.red, marginTop: 16 }}>{error}</div>}

      {showNewStatementModal && (
        <Modal title="Open New Statement Period" onClose={()=>setShowNewStatementModal(false)}>
          <Field label="Period Label" value={newStatementForm.period_label} onChange={(v:string)=>setNewStatementForm((p:any)=>({...p,period_label:v}))} placeholder='e.g. "AUGUST 2026"' required />
          <Field label="Start Date" type="date" value={newStatementForm.start_date} onChange={(v:string)=>setNewStatementForm((p:any)=>({...p,start_date:v}))} />
          <Field label="End Date" type="date" value={newStatementForm.end_date} onChange={(v:string)=>setNewStatementForm((p:any)=>({...p,end_date:v}))} />
          <Field label="Beginning Balance" type="number" value={newStatementForm.beginning_balance} onChange={(v:string)=>setNewStatementForm((p:any)=>({...p,beginning_balance:v}))} prefix="₱" hint={currentStatement ? `Previous period's Bank Balance was ${fmt(bankBalance)}` : undefined} />
          {error && <div style={{color:C.red,fontSize:12,marginBottom:10}}>{error}</div>}
          <GreenBtn onClick={openNewStatement} disabled={saving}>{saving?'Saving…':'Open Period'}</GreenBtn>
        </Modal>
      )}

      {showEditStatementModal && currentStatement && (
        <Modal title={`Edit ${currentStatement.period_label}`} onClose={()=>setShowEditStatementModal(false)}>
          <Field label="Period Label" value={editStatementForm.period_label} onChange={(v:string)=>setEditStatementForm((p:any)=>({...p,period_label:v}))} required />
          <Field label="Start Date" type="date" value={editStatementForm.start_date} onChange={(v:string)=>setEditStatementForm((p:any)=>({...p,start_date:v}))} />
          <Field label="End Date" type="date" value={editStatementForm.end_date} onChange={(v:string)=>setEditStatementForm((p:any)=>({...p,end_date:v}))} />
          <Field label="Beginning Balance" type="number" value={editStatementForm.beginning_balance} onChange={(v:string)=>setEditStatementForm((p:any)=>({...p,beginning_balance:v}))} prefix="₱" hint="Changing this shifts every computed balance for this period — deposits/withdrawals themselves aren't affected." />
          {error && <div style={{color:C.red,fontSize:12,marginBottom:10}}>{error}</div>}
          <GreenBtn onClick={saveEditStatement} disabled={saving}>{saving?'Saving…':'Save Changes'}</GreenBtn>
        </Modal>
      )}

      {showTxnModal && (
        <Modal title={txnForm.direction==='Deposit' ? 'Add Deposit' : 'Add Withdrawal'} onClose={()=>setShowTxnModal(false)}>
          <Field label="Date" type="date" value={txnForm.date} onChange={(v:string)=>setTxnForm((p:any)=>({...p,date:v}))} />
          <Field label="Particulars" value={txnForm.particulars} onChange={(v:string)=>setTxnForm((p:any)=>({...p,particulars:v}))} />
          <Field label="Category" type="select" value={txnForm.category} onChange={(v:string)=>setTxnForm((p:any)=>({...p,category:v}))} options={txnForm.direction==='Deposit'?DEPOSIT_CATS:WITHDRAWAL_CATS} />
          {txnForm.direction==='Deposit' && txnForm.category==='Client Payment' && (
            <Field label="Invoice this payment settles *" type="select" value={txnForm.invoice_id} onChange={(v:string)=>setTxnForm((p:any)=>({...p,invoice_id:v}))} options={invoicesForLinking.map((i:any)=>({value:i.id,label:`${i.id} — ${i.client||i.company_name}`}))} />
          )}
          {txnForm.direction==='Withdrawal' && txnForm.category==='Cash Advance' && (
            <Field label="Employee" type="select" value={txnForm.employee_id} onChange={(v:string)=>setTxnForm((p:any)=>({...p,employee_id:v}))} options={employeesForCA.map((e:any)=>({value:e.id,label:e.name}))} />
          )}
          {txnForm.direction==='Withdrawal' && txnForm.category==='Payroll' && (
            <Field label="Payroll Run *" type="select" value={txnForm.payroll_run_id} onChange={(v:string)=>setTxnForm((p:any)=>({...p,payroll_run_id:v}))} options={payrollRunsForLink.map((r:any)=>({value:r.id,label:`${r.period_start} to ${r.period_end}`}))} />
          )}
          {((txnForm.direction==='Withdrawal' && txnForm.category!=='Payroll' && txnForm.category!=='Cash Advance') || (txnForm.direction==='Deposit' && txnForm.category!=='Client Payment')) && (
            <Field label={txnForm.direction==='Deposit' ? 'Bank Memo / Reference No. *' : 'Receipt / Invoice / Document No. *'} value={txnForm.document_no} onChange={(v:string)=>setTxnForm((p:any)=>({...p,document_no:v}))} />
          )}
          {txnForm.direction==='Withdrawal' && txnForm.category!=='PCF Replenishment' && txnForm.category!=='Cash Advance' && (
            <Field label="Project PO (optional)" type="select" value={txnForm.po_number} onChange={(v:string)=>setTxnForm((p:any)=>({...p,po_number:v}))} options={projectsForLink.map((p:any)=>({value:p.po_number,label:`${p.po_number} — ${p.name}`}))} />
          )}
          <Field label="Bank / Channel" value={txnForm.bank_channel} onChange={(v:string)=>setTxnForm((p:any)=>({...p,bank_channel:v}))} />
          <Field label="Check #" value={txnForm.check_number} onChange={(v:string)=>setTxnForm((p:any)=>({...p,check_number:v}))} />
          <Field label="Amount" type="number" value={txnForm.amount} onChange={(v:string)=>setTxnForm((p:any)=>({...p,amount:v}))} prefix="₱" />
          {txnForm.direction==='Withdrawal' && txnForm.category!=='PCF Replenishment' && txnForm.category!=='Cash Advance' && (
            <div style={{fontSize:10,color:C.gray,marginTop:-8,marginBottom:14}}>This will create a linked Accounting expense automatically.</div>
          )}
          {txnForm.direction==='Withdrawal' && txnForm.category==='Cash Advance' && (
            <div style={{fontSize:10,color:C.gray,marginTop:-8,marginBottom:14}}>This creates an Open cash advance for this employee in Payroll — it'll be deducted from a future payroll run, not logged as an expense.</div>
          )}
          {error && <div style={{color:C.red,fontSize:12,marginBottom:10}}>{error}</div>}
          <GreenBtn onClick={addTransaction} disabled={saving}>{saving?'Saving…':`Add ${txnForm.direction}`}</GreenBtn>
        </Modal>
      )}

      {showCheckModal && (
        <Modal title="Add Outstanding Check" onClose={()=>setShowCheckModal(false)}>
          <Field label="Date Issued" type="date" value={checkForm.date_issued} onChange={(v:string)=>setCheckForm((p:any)=>({...p,date_issued:v}))} />
          <Field label="Particulars" value={checkForm.particulars} onChange={(v:string)=>setCheckForm((p:any)=>({...p,particulars:v}))} />
          <Field label="Check #" value={checkForm.check_number} onChange={(v:string)=>setCheckForm((p:any)=>({...p,check_number:v}))} />
          <Field label="Amount" type="number" value={checkForm.amount} onChange={(v:string)=>setCheckForm((p:any)=>({...p,amount:v}))} prefix="₱" />
          {error && <div style={{color:C.red,fontSize:12,marginBottom:10}}>{error}</div>}
          <GreenBtn onClick={addOutstandingCheck} disabled={saving}>{saving?'Saving…':'Add Check'}</GreenBtn>
        </Modal>
      )}
    </div>
  )
}

function PettyCashFundTab(props: any) {
  const {
    canEdit, saving, error, setError, bankAccount,
    pcfFund, pcfFundForm, setPcfFundForm, createPcfFund,
    pcfPeriods, currentPcfPeriod, currentPcfPeriodId, setCurrentPcfPeriodId,
    showNewPcfPeriodModal, setShowNewPcfPeriodModal, newPcfPeriodForm, setNewPcfPeriodForm, openNewPcfPeriod,
    pcfVouchers, voucherTotal, currentPeriodSpent, remainingFloat,
    showVoucherModal, setShowVoucherModal, voucherForm, setVoucherForm,
    addVoucherLine, updateVoucherLine, removeVoucherLine, saveVoucher, deleteVoucher,
    pcfCategories, nextPcvNumber, closePcfPeriod,
  } = props

  if (!pcfFund) {
    return (
      <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', maxWidth: 480 }}>
        <SectionHeader title="Set Up Petty Cash Fund" />
        {!bankAccount ? (
          <div style={{ fontSize: 12, color: C.gray }}>Set up the Bank Account first, in the Bank Ledger tab — the fund replenishes from it.</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>One-time setup — the target weekly float this fund replenishes back up to (e.g. ₱200,000).</div>
            <Field label="Target Float" type="number" value={pcfFundForm.target_float} onChange={(v:string)=>setPcfFundForm((p:any)=>({...p,target_float:v}))} prefix="₱" />
            {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{error}</div>}
            <GreenBtn onClick={createPcfFund} disabled={saving}>{saving?'Saving…':'Create Petty Cash Fund'}</GreenBtn>
          </>
        )}
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 15, color: C.darkGreen }}>Petty Cash Fund</div>
          <div style={{ fontSize: 11, color: C.gray }}>Target float: {fmt(pcfFund.target_float)} / period</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={currentPcfPeriodId} onChange={e=>setCurrentPcfPeriodId(e.target.value)} style={{ padding: '8px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 12, fontFamily:'inherit' }}>
            {pcfPeriods.length===0 && <option value="">No periods yet</option>}
            {pcfPeriods.map((p:any)=><option key={p.id} value={p.id}>{p.period_label} {p.status==='Closed'?'✓ Closed':'(Open)'}</option>)}
          </select>
          {canEdit && <GreenBtn onClick={()=>setShowNewPcfPeriodModal(true)}>+ New Period</GreenBtn>}
        </div>
      </div>

      {!currentPcfPeriod ? (
        <div style={{ background: C.white, borderRadius: 12, padding: 40, textAlign: 'center', color: C.gray, boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>No period yet — click "+ New Period" to start one.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
            {[
              ['Target Float', fmt(pcfFund.target_float), C.gray],
              ['Spent This Period', fmt(currentPeriodSpent), C.red],
              ['Remaining Float', fmt(remainingFloat), remainingFloat < 0 ? C.red : C.accent],
            ].map(([l,v,c]:any)=>(
              <div key={l} style={{ background: C.white, borderRadius: 12, padding: '16px 20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', borderTop: `4px solid ${c}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase' }}>{l}</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: C.dark, marginTop: 4 }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 16 }}>
            <SectionHeader title={`Vouchers (${pcfVouchers.length})`} action={canEdit && currentPcfPeriod.status==='Open' ? '+ Add Voucher' : ''} onAction={()=>{setVoucherForm((p:any)=>({...p, pcv_number: nextPcvNumber()})); setShowVoucherModal(true)}} />
            {pcfVouchers.length===0 ? <div style={{textAlign:'center',padding:20,color:C.gray,fontSize:12}}>No vouchers this period.</div> : (
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                  {['PCV#','Date','Payee','Categories','Amount',''].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                </tr></thead>
                <tbody>{pcfVouchers.map((v:any,i:number)=>(
                  <tr key={v.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                    <td style={{padding:'8px 12px',fontWeight:800,color:C.darkGreen}}>{v.pcv_number}</td>
                    <td style={{padding:'8px 12px',color:C.gray}}>{v.date}</td>
                    <td style={{padding:'8px 12px',fontWeight:600}}>{v.payee}</td>
                    <td style={{padding:'8px 12px',color:C.gray,fontSize:11}}>{(v.petty_cash_voucher_lines||[]).map((l:any)=>l.category).join(', ')}</td>
                    <td style={{padding:'8px 12px',fontWeight:800,color:C.red}}>{fmt(voucherTotal(v))}</td>
                    <td style={{padding:'8px 12px'}}>{canEdit && currentPcfPeriod.status==='Open' && <button onClick={()=>deleteVoucher(v)} style={{background:'none',border:'none',color:C.red,cursor:'pointer',fontSize:11}}>✕</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>

          <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
            <SectionHeader title="Close Period & Replenish" />
            {currentPcfPeriod.status === 'Closed' ? (
              <div style={{fontSize:12,color:C.accent,fontWeight:700}}>✓ Closed — replenished via Bank Ledger transaction {currentPcfPeriod.replenishment_bank_transaction_id}.</div>
            ) : (
              <>
                <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Closing tops the float back up to target — replenishment = amount actually spent ({fmt(currentPeriodSpent)}), not a flat {fmt(pcfFund.target_float)}. This creates one "PCF Replenishment" withdrawal in whatever Bank Ledger period is currently open.</div>
                {canEdit && <GreenBtn onClick={closePcfPeriod} disabled={saving}>{saving?'Closing…':`Close & Replenish ${fmt(currentPeriodSpent)}`}</GreenBtn>}
              </>
            )}
          </div>
        </>
      )}

      {error && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.red, marginTop: 16 }}>{error}</div>}

      {showNewPcfPeriodModal && (
        <Modal title="Open New PCF Period" onClose={()=>setShowNewPcfPeriodModal(false)}>
          <Field label="Period Label" value={newPcfPeriodForm.period_label} onChange={(v:string)=>setNewPcfPeriodForm((p:any)=>({...p,period_label:v}))} placeholder='e.g. "JULY 21-31"' required />
          <Field label="Start Date" type="date" value={newPcfPeriodForm.start_date} onChange={(v:string)=>setNewPcfPeriodForm((p:any)=>({...p,start_date:v}))} />
          <Field label="End Date" type="date" value={newPcfPeriodForm.end_date} onChange={(v:string)=>setNewPcfPeriodForm((p:any)=>({...p,end_date:v}))} />
          {error && <div style={{color:C.red,fontSize:12,marginBottom:10}}>{error}</div>}
          <GreenBtn onClick={openNewPcfPeriod} disabled={saving}>{saving?'Saving…':'Open Period'}</GreenBtn>
        </Modal>
      )}

      {showVoucherModal && (
        <Modal title="Add Petty Cash Voucher" onClose={()=>setShowVoucherModal(false)}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
            <Field label="Date" type="date" value={voucherForm.date} onChange={(v:string)=>setVoucherForm((p:any)=>({...p,date:v}))} />
            <Field label="PCV#" value={voucherForm.pcv_number} onChange={(v:string)=>setVoucherForm((p:any)=>({...p,pcv_number:v}))} />
          </div>
          <Field label="Payee" value={voucherForm.payee} onChange={(v:string)=>setVoucherForm((p:any)=>({...p,payee:v}))} placeholder="Name of person who drew the cash" required />

          <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 8, marginTop: 4 }}>Category Lines</label>
          <datalist id="pcf-category-list">{pcfCategories.map((c:string)=><option key={c} value={c} />)}</datalist>
          {voucherForm.lines.map((line:any,idx:number)=>(
            <div key={idx} style={{display:'grid',gridTemplateColumns:'2fr 1fr auto',gap:8,marginBottom:8,alignItems:'center'}}>
              <input list="pcf-category-list" value={line.category} onChange={e=>updateVoucherLine(idx,'category',e.target.value.toUpperCase())} onFocus={e=>e.target.select()} placeholder="Category (e.g. Materials, Gas/Diesel, Meals…)"
                style={{padding:'8px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',boxSizing:'border-box'}}/>
              <input type="number" value={line.amount} onChange={e=>updateVoucherLine(idx,'amount',e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) updateVoucherLine(idx,'amount','0')}}
                style={{padding:'8px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',boxSizing:'border-box'}}/>
              {voucherForm.lines.length>1 && <button onClick={()=>removeVoucherLine(idx)} style={{background:'none',border:'none',color:C.red,cursor:'pointer',fontSize:14}}>✕</button>}
            </div>
          ))}
          <button onClick={addVoucherLine} style={{padding:'6px 12px',fontSize:10,fontWeight:700,background:`${C.purple}12`,border:`1px solid ${C.purple}44`,color:C.purple,borderRadius:5,cursor:'pointer',marginBottom:14}}>+ Add Line</button>

          <div style={{fontSize:12,fontWeight:800,color:C.dark,marginBottom:14}}>Total: {fmt(voucherForm.lines.reduce((s:number,l:any)=>s+(Number(l.amount)||0),0))}</div>
          <Field label="Notes (optional)" value={voucherForm.notes} onChange={(v:string)=>setVoucherForm((p:any)=>({...p,notes:v}))} />
          <div style={{fontSize:10,color:C.gray,marginTop:-8,marginBottom:14}}>Each line auto-creates its own linked Accounting expense.</div>
          {error && <div style={{color:C.red,fontSize:12,marginBottom:10}}>{error}</div>}
          <GreenBtn onClick={saveVoucher} disabled={saving}>{saving?'Saving…':'Save Voucher'}</GreenBtn>
        </Modal>
      )}
    </div>
  )
}

// ── SHARED HOVER TOOLTIP (same mechanism as the Reports module) ────────────
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
    }}>{tip.content}</div>
  )
}
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
          <linearGradient id={`lg-acct-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#lg-acct-${color.replace('#', '')})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={i}>
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

const DONUT_PALETTE = [C.accent, C.blue, C.purple, C.amber, C.red, C.midGreen, C.darkGreen, '#0891b2', '#be185d', '#65a30d', '#7c2d12', '#4338ca']

function AccountingOverviewTab({ cashTrend, pcfTrend, expByCategory, totalExp, bankBalance, remainingFloat }: any) {
  const categoryData = Object.entries(expByCategory as Record<string,number>)
    .sort((a,b) => b[1]-a[1])
    .map(([label,value],i) => ({ label, value: value as number, color: DONUT_PALETTE[i % DONUT_PALETTE.length] }))

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 22 }}>
        {[
          ['Current Bank Balance', bankBalance!=null ? fmt(bankBalance) : '—', C.blue],
          ['Current PCF Remaining Float', remainingFloat!=null ? fmt(remainingFloat) : '—', remainingFloat!=null && remainingFloat<0 ? C.red : C.accent],
          ['Total Recorded Expenses (all-time)', fmt(totalExp), C.red],
        ].map(([l,v,c]:any) => (
          <div key={l} style={{ background: C.white, borderRadius: 12, padding: '18px 22px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', borderTop: `4px solid ${c}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: C.gray, textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: C.dark, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 20 }}>
        <SectionHeader title="Cash Position — Bank Balance by Period" />
        <LineChart data={cashTrend} height={180} color={C.blue} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
          <SectionHeader title="Spend by Category" />
          <DonutChart data={categoryData} size={170} />
        </div>
        <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
          <SectionHeader title="Petty Cash Fund — Spend by Period" />
          <BarChart data={pcfTrend} height={180} color={C.purple} />
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ title, action, onAction, secondaryAction, onSecondaryAction }: any) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 4, height: 22, background: C.accent, borderRadius: 2 }} />
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 900, textTransform: 'uppercase' }}>{title}</h2>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {secondaryAction && <button onClick={onSecondaryAction} style={{ padding: '9px 16px', fontSize: 11, fontWeight: 800, letterSpacing: 1, border: `1.5px solid ${C.purple}`, background: 'transparent', color: C.purple, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'uppercase' }}>{secondaryAction}</button>}
        {action && <GreenBtn onClick={onAction}>{action}</GreenBtn>}
      </div>
    </div>
  )
}

function GreenBtn({ children, onClick, danger, disabled, style }: any) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '9px 20px', background: danger ? C.red : `linear-gradient(135deg, ${C.accent}, ${C.midGreen})`,
      color: 'white', border: 'none', borderRadius: 6, fontWeight: 800, fontSize: 11, cursor: 'pointer', textTransform: 'uppercase', ...style
    }}>{children}</button>
  )
}

function Modal({ title, children, onClose }: any) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'white', borderRadius: 12, width: '100%', maxWidth: 500, overflow: 'hidden' }}>
        <div style={{ background: C.dark, color: 'white', padding: '15px 20px', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 900 }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  )
}