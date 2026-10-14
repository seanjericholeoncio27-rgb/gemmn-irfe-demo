'use client'
import { useEffect, useState, useCallback, Fragment } from 'react'
import { createClient } from '@/lib/supabase'

const C = {
  darkGreen: '#1a4d2e', midGreen: '#2d6a4f', accent: '#39b54a',
  white: '#ffffff', dark: '#0d1f14', gray: '#6b7c72',
  lightGray: '#e8ede9', red: '#e53e3e', amber: '#d97706', blue: '#2563eb', purple: '#7c3aed',
}

const TABLE_LABELS: Record<string, string> = {
  payroll: 'Payroll', expenses: 'Expenses', invoices: 'Invoices', quotations: 'Quotations',
  projects: 'Projects', cash_advances: 'Cash Advances', employee_loans: 'Employee Loans',
  purchase_orders: 'Purchase Orders', inventory: 'Inventory',
}

const ACTION_COLOR: Record<string, string> = { INSERT: C.accent, UPDATE: C.blue, DELETE: C.red }

function diffFields(oldData: any, newData: any): { field: string; before: any; after: any }[] {
  if (!oldData || !newData) return []
  const keys = new Set([...Object.keys(oldData), ...Object.keys(newData)])
  const diffs: { field: string; before: any; after: any }[] = []
  keys.forEach(k => {
    const before = oldData[k], after = newData[k]
    if (JSON.stringify(before) !== JSON.stringify(after)) diffs.push({ field: k, before, after })
  })
  return diffs
}

const fmtVal = (v: any) => {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export default function AuditLogPage() {
  const supabase = createClient()
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [tableFilter, setTableFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [limit, setLimit] = useState(100)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 50

  const fetchLogs = useCallback(async () => {
    setLoading(true); setError('')
    let query = supabase.from('audit_log').select('*').order('changed_at', { ascending: false }).limit(limit)
    if (tableFilter) query = query.eq('table_name', tableFilter)
    if (actionFilter) query = query.eq('action', actionFilter)
    if (userFilter) query = query.ilike('changed_by_name', `%${userFilter}%`)
    if (dateFrom) query = query.gte('changed_at', dateFrom)
    if (dateTo) query = query.lte('changed_at', dateTo + 'T23:59:59')
    const { data, error } = await query
    if (error) setError(error.message === 'permission denied for table audit_log' || error.code === 'PGRST301'
      ? "You don't have access to the audit log."
      : error.message)
    else setLogs(data || [])
    setLoading(false)
  }, [supabase, tableFilter, actionFilter, userFilter, dateFrom, dateTo, limit])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  useEffect(() => { setPage(1) }, [tableFilter, actionFilter, userFilter, dateFrom, dateTo, limit])
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [page])

  // logs is already sorted most-recent-first (changed_at desc) by the query above.
  const pageCount = Math.max(1, Math.ceil(logs.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const paged = logs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const selectStyle: React.CSSProperties = { padding: '8px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', color: C.dark, background: C.white }

  return (
    <div>
      <div style={{ background: C.white, borderRadius: 12, padding: '18px 22px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 20 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2, color: C.gray, textTransform: 'uppercase', marginBottom: 10 }}>Filters</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={tableFilter} onChange={e => setTableFilter(e.target.value)} style={selectStyle}>
            <option value="">All Tables</option>
            {Object.entries(TABLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select value={actionFilter} onChange={e => setActionFilter(e.target.value)} style={selectStyle}>
            <option value="">All Actions</option>
            <option value="INSERT">Created</option>
            <option value="UPDATE">Updated</option>
            <option value="DELETE">Deleted</option>
          </select>
          <input value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="Filter by user…" style={{ ...selectStyle, width: 160 }} />
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={selectStyle} />
          <span style={{ color: C.gray, fontSize: 12 }}>to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={selectStyle} />
          <button onClick={fetchLogs} style={{ padding: '8px 18px', background: `linear-gradient(135deg,${C.accent},${C.midGreen})`, border: 'none', borderRadius: 6, color: C.white, fontSize: 11, fontWeight: 800, letterSpacing: 1, cursor: 'pointer' }}>
            {loading ? 'Loading…' : 'Apply'}
          </button>
        </div>
      </div>

      {error && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 8, padding: '14px 18px', fontSize: 12, color: C.red, marginBottom: 16 }}>{error}</div>}

      {!error && !loading && logs.length > 0 && (
        <div style={{ fontSize: 11, color: C.gray, fontWeight: 700, marginBottom: 12 }}>
          {`Showing ${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, logs.length)} of ${logs.length}`}
        </div>
      )}

      {!error && (
        <div style={{ background: C.white, borderRadius: 12, boxShadow: '0 2px 16px rgba(0,0,0,0.07)', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 50, textAlign: 'center', color: C.gray }}>Loading…</div>
          ) : logs.length === 0 ? (
            <div style={{ padding: 50, textAlign: 'center', color: C.gray }}>No matching activity found.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ background: `linear-gradient(90deg,${C.darkGreen},${C.midGreen})` }}>
                {['When', 'Who', 'Action', 'Table', 'Record', ''].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: 'left', color: C.white, fontWeight: 800, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {paged.map((log, i) => {
                  const isExpanded = expandedId === log.id
                  const diffs = log.action === 'UPDATE' ? diffFields(log.old_data, log.new_data) : []
                  return (
                    <Fragment key={log.id}>
                      <tr onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        style={{ background: i % 2 === 0 ? C.white : '#f9fbf9', borderBottom: `1px solid ${C.lightGray}`, cursor: 'pointer' }}>
                        <td style={{ padding: '9px 12px', color: C.gray, whiteSpace: 'nowrap' }}>{new Date(log.changed_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700 }}>{log.changed_by_name || 'System'}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, background: `${ACTION_COLOR[log.action]}18`, color: ACTION_COLOR[log.action], fontSize: 10, fontWeight: 800 }}>
                            {({ INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Deleted' } as any)[log.action]}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', color: C.dark }}>{TABLE_LABELS[log.table_name] || log.table_name}</td>
                        <td style={{ padding: '9px 12px', color: C.gray, fontFamily: 'monospace', fontSize: 11 }}>{log.record_id}</td>
                        <td style={{ padding: '9px 12px', color: C.gray }}>{isExpanded ? '▲' : '▼'}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={6} style={{ padding: '14px 20px', background: '#f9fbf9', borderBottom: `1px solid ${C.lightGray}` }}>
                            {log.action === 'UPDATE' && (
                              diffs.length === 0
                                ? <div style={{ fontSize: 11, color: C.gray, fontStyle: 'italic' }}>No field-level differences recorded.</div>
                                : (
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                                    <thead><tr style={{ color: C.gray }}>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 800, textTransform: 'uppercase', fontSize: 9 }}>Field</th>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 800, textTransform: 'uppercase', fontSize: 9 }}>Before</th>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 800, textTransform: 'uppercase', fontSize: 9 }}>After</th>
                                    </tr></thead>
                                    <tbody>
                                      {diffs.map(d => (
                                        <tr key={d.field} style={{ borderTop: `1px solid ${C.lightGray}` }}>
                                          <td style={{ padding: '5px 8px', fontWeight: 700 }}>{d.field}</td>
                                          <td style={{ padding: '5px 8px', color: C.red }}>{fmtVal(d.before)}</td>
                                          <td style={{ padding: '5px 8px', color: C.accent }}>{fmtVal(d.after)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )
                            )}
                            {log.action === 'INSERT' && (
                              <div style={{ fontSize: 11, color: C.gray }}>
                                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 10, background: C.white, padding: 10, borderRadius: 6, border: `1px solid ${C.lightGray}` }}>{JSON.stringify(log.new_data, null, 2)}</pre>
                              </div>
                            )}
                            {log.action === 'DELETE' && (
                              <div style={{ fontSize: 11, color: C.gray }}>
                                <div style={{ marginBottom: 6, color: C.red, fontWeight: 700 }}>This record was permanently deleted. Last known state:</div>
                                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 10, background: C.white, padding: 10, borderRadius: 6, border: `1px solid ${C.lightGray}` }}>{JSON.stringify(log.old_data, null, 2)}</pre>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
          {logs.length >= limit && (
            <div style={{ padding: 14, textAlign: 'center', borderTop: `1px solid ${C.lightGray}` }}>
              <button onClick={() => setLimit(l => l + 100)} style={{ padding: '8px 20px', background: 'transparent', border: `1.5px solid ${C.accent}`, borderRadius: 6, color: C.accent, fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Load More</button>
            </div>
          )}
        </div>
      )}

      {!error && !loading && pageCount > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 20 }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} style={{ padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, color: currentPage === 1 ? C.lightGray : C.dark, fontSize: 11, fontWeight: 700, cursor: currentPage === 1 ? 'default' : 'pointer' }}>← Prev</button>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.gray }}>Page {currentPage} of {pageCount}</span>
          <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={currentPage === pageCount} style={{ padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, color: currentPage === pageCount ? C.lightGray : C.dark, fontSize: 11, fontWeight: 700, cursor: currentPage === pageCount ? 'default' : 'pointer' }}>Next →</button>
        </div>
      )}
    </div>
  )
}
