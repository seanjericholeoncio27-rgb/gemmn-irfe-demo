'use client'
import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import { MODULES } from '@/lib/permissions'

const C = {
  darkGreen: '#1a4d2e', midGreen: '#2d6a4f', accent: '#39b54a',
  white: '#ffffff', dark: '#0d1f14', gray: '#6b7c72',
  lightGray: '#e8ede9', red: '#e53e3e', amber: '#d97706', blue: '#2563eb', purple: '#7c3aed',
}

function Badge({ label, tone = 'status' }: { label: string; tone?: 'status' | 'plain' }) {
  const statusColors: Record<string, string> = { active: C.accent, disabled: C.red, pending: '#d97706' }
  const c = tone === 'status' ? (statusColors[label] || C.gray) : C.blue
  return <span style={{ padding: '3px 10px', borderRadius: 20, background: `${c}22`, color: c, fontSize: 10, fontWeight: 800, border: `1px solid ${c}44`, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
}

const BLANK_NEW_USER = { fullName: '', username: '', email: '', role: 'manager', mode: 'invite', password: '', noEmail: false }
const BLANK_ROLE = { name: '', label: '', modules: [] as string[], editModules: [] as string[], canManageUsers: false }

export default function UserAccessPage() {
  const supabase = createClient()
  const [users, setUsers] = useState<any[]>([])
  const [roles, setRoles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'users' | 'roles'>('users')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const [showAdd, setShowAdd] = useState(false)
  const [newUser, setNewUser] = useState<any>(BLANK_NEW_USER)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState('')
  const [addSuccess, setAddSuccess] = useState('')

  const [showRoleModal, setShowRoleModal] = useState(false)
  const [roleForm, setRoleForm] = useState<any>(BLANK_ROLE)
  const [roleSaving, setRoleSaving] = useState(false)
  const [roleError, setRoleError] = useState('')

  const authHeader = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Session expired — please refresh and try again.')
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }
  }, [supabase])

  const fetchUsers = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/list-users', { headers })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      setUsers(result.users || [])
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }, [authHeader])

  const fetchRoles = useCallback(async () => {
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/roles', { headers })
      const result = await res.json()
      if (res.ok) setRoles(result.roles || [])
    } catch { /* non-fatal */ }
  }, [authHeader])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => { if (user) setCurrentUserId(user.id) })
    fetchUsers(); fetchRoles()
  }, [supabase, fetchUsers, fetchRoles])

  const isFullAccess = (u: any) => u.roles?.full_access

  const changeRole = async (u: any, newRole: string) => {
    setSaving(u.id); setError('')
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/update-user', { method: 'POST', headers, body: JSON.stringify({ userId: u.id, role: newRole }) })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await fetchUsers()
    } catch (err: any) { setError(err.message) }
    setSaving(null)
  }

  const toggleStatus = async (u: any) => {
    if (u.id === currentUserId) { setError("You can't disable your own access."); return }
    const next = u.status === 'disabled' || u.status === 'pending' ? 'active' : 'disabled'
    if (u.status === 'pending' && u.role === 'pending') { setError(`Pick a role for ${u.full_name} first, then approve.`); return }
    if (next === 'disabled' && !window.confirm(`Disable access for ${u.full_name}? They will be signed out and blocked from logging in until re-enabled.`)) return
    setSaving(u.id); setError('')
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/update-user', { method: 'POST', headers, body: JSON.stringify({ userId: u.id, status: next }) })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await fetchUsers()
    } catch (err: any) { setError(err.message) }
    setSaving(null)
  }

  const deleteUser = async (u: any) => {
    if (u.id === currentUserId) { setError("You can't delete your own account."); return }
    const typed = window.prompt(
      `This permanently deletes ${u.full_name}'s login — this cannot be undone.\n\nType their full name exactly to confirm: "${u.full_name}"`
    )
    if (typed !== u.full_name) {
      if (typed !== null) setError('Name did not match — deletion cancelled.')
      return
    }
    setSaving(u.id); setError('')
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/update-user', { method: 'DELETE', headers, body: JSON.stringify({ userId: u.id }) })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await fetchUsers()
    } catch (err: any) { setError(err.message) }
    setSaving(null)
  }

  const startEditName = (u: any) => { setEditingId(u.id); setEditName(u.full_name || '') }
  const cancelEditName = () => { setEditingId(null); setEditName('') }
  const saveEditName = async (u: any) => {
    if (!editName.trim()) return
    setSaving(u.id); setError('')
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/update-user', { method: 'POST', headers, body: JSON.stringify({ userId: u.id, full_name: editName.trim() }) })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await fetchUsers()
    } catch (err: any) { setError(err.message) }
    setSaving(null); setEditingId(null)
  }

  const submitNewUser = async () => {
    if (!newUser.fullName.trim()) return setAddError('Full name is required.')
    if (!newUser.username.trim()) return setAddError('Username is required.')
    if (!newUser.noEmail && newUser.mode === 'invite' && !newUser.email.trim()) return setAddError('Email is required for an email invite.')
    if (newUser.mode === 'create' && newUser.password.length < 6) return setAddError('Password must be at least 6 characters.')

    setAddSaving(true); setAddError(''); setAddSuccess('')
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/create-user', {
        method: 'POST', headers,
        body: JSON.stringify({
          username: newUser.username.trim(),
          email: newUser.noEmail ? '' : newUser.email.trim(),
          fullName: newUser.fullName.trim(),
          role: newUser.role,
          mode: newUser.noEmail ? 'create' : newUser.mode,
          password: newUser.mode === 'create' || newUser.noEmail ? newUser.password : undefined,
        }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)

      setAddSuccess(
        newUser.noEmail ? `Account created. They log in with username "${newUser.username}" and the password you set.`
        : newUser.mode === 'invite' ? `Invite sent to ${newUser.email}.`
        : `Account created for ${newUser.email}. Share the password with them directly.`
      )
      setNewUser(BLANK_NEW_USER)
      await fetchUsers()
    } catch (err: any) { setAddError(err.message) }
    setAddSaving(false)
  }

  const openNewRole = () => { setRoleForm(BLANK_ROLE); setRoleError(''); setShowRoleModal(true) }
  const openEditRole = (role: any) => {
    setRoleForm({ name: role.name, label: role.label, modules: role.modules || [], editModules: role.edit_modules || [], canManageUsers: !!role.can_manage_users })
    setRoleError(''); setShowRoleModal(true)
  }
  const toggleModule = (key: string) => setRoleForm((p: any) => {
    const hasIt = p.modules.includes(key)
    return {
      ...p,
      modules: hasIt ? p.modules.filter((m: string) => m !== key) : [...p.modules, key],
      // Revoking view access should always revoke edit access for that module too
      editModules: hasIt ? p.editModules.filter((m: string) => m !== key) : p.editModules,
    }
  })
  const toggleEditModule = (key: string) => setRoleForm((p: any) => ({
    ...p, editModules: p.editModules.includes(key) ? p.editModules.filter((m: string) => m !== key) : [...p.editModules, key]
  }))

  const saveRole = async () => {
    if (!roleForm.label.trim()) return setRoleError('Role name is required.')
    setRoleSaving(true); setRoleError('')
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/roles', {
        method: 'POST', headers,
        body: JSON.stringify({ name: roleForm.name || undefined, isUpdate: !!roleForm.name, label: roleForm.label, modules: roleForm.modules, editModules: roleForm.editModules, canManageUsers: roleForm.canManageUsers }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      setShowRoleModal(false)
      await fetchRoles()
    } catch (err: any) { setRoleError(err.message) }
    setRoleSaving(false)
  }

  const deleteRole = async (role: any) => {
    if (!window.confirm(`Delete the "${role.label}" role? Users must be reassigned first.`)) return
    try {
      const headers = await authHeader()
      const res = await fetch('/api/admin/roles', { method: 'DELETE', headers, body: JSON.stringify({ name: role.name }) })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await fetchRoles()
    } catch (err: any) { setError(err.message) }
  }

  return (
    <div>
      <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 4, height: 22, background: `linear-gradient(180deg,${C.accent},${C.darkGreen})`, borderRadius: 2 }} />
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 900, letterSpacing: 2, color: C.dark, textTransform: 'uppercase' }}>User Access</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['users', 'roles'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: '7px 18px', borderRadius: 6, border: `1.5px solid ${tab === t ? C.accent : C.lightGray}`, background: tab === t ? C.accent : C.white, color: tab === t ? C.white : C.gray, fontSize: 11, fontWeight: 800, cursor: 'pointer', letterSpacing: 1, textTransform: 'uppercase' }}>
              {t === 'users' ? 'Users' : 'Roles'}
            </button>
          ))}
        </div>
      </div>

      {error && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 8, padding: '10px 16px', fontSize: 12, color: C.red, marginBottom: 16 }}>{error}</div>}

      {tab === 'users' && (
        <>
          <div style={{ background: `${C.blue}08`, border: `1px solid ${C.blue}33`, borderRadius: 10, padding: '14px 18px', marginBottom: 20, fontSize: 12, color: C.dark, lineHeight: 1.6 }}>
            Staff can log in with either their <b>username</b> or <b>email</b>. If you skip email entirely, an internal address is generated automatically — that account just won't be able to use "forgot password," so make sure they know their password.
          </div>
          <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
              <button onClick={() => { setShowAdd(true); setAddError(''); setAddSuccess('') }}
                style={{ padding: '9px 20px', background: `linear-gradient(135deg,${C.accent},${C.midGreen})`, border: 'none', borderRadius: 6, color: C.white, fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', cursor: 'pointer', boxShadow: `0 3px 10px ${C.accent}44` }}>
                + Add New User
              </button>
            </div>
            {loading ? <div style={{ textAlign: 'center', padding: 40, color: C.gray }}>Loading…</div>
              : users.length === 0 ? <div style={{ textAlign: 'center', padding: 40, color: C.gray }}>No users found.</div>
                : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ background: `linear-gradient(90deg,${C.darkGreen},${C.midGreen})` }}>
                    {['Name', 'Username', 'Email', 'Role', 'Status', 'Actions'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: 'left', color: C.white, fontWeight: 800, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>{users.map((u, i) => {
                    const locked = isFullAccess(u)
                    const isSelf = u.id === currentUserId
                    const isEditing = editingId === u.id
                    return (
                      <tr key={u.id} style={{ background: i % 2 === 0 ? C.white : '#f9fbf9', borderBottom: `1px solid ${C.lightGray}` }}>
                        <td style={{ padding: '10px 12px', fontWeight: 700 }}>
                          {isEditing ? (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <input value={editName} onChange={e => setEditName(e.target.value.toUpperCase())} autoFocus
                                onFocus={e=>e.target.select()}
                                onKeyDown={e => { if (e.key === 'Enter') saveEditName(u); if (e.key === 'Escape') cancelEditName() }}
                                style={{ padding: '5px 9px', border: `1.5px solid ${C.accent}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', width: 140 }} />
                              <button onClick={() => saveEditName(u)} disabled={saving === u.id} style={{ padding: '5px 9px', fontSize: 11, fontWeight: 800, background: `${C.accent}18`, border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 6, cursor: 'pointer' }}>✓</button>
                              <button onClick={cancelEditName} style={{ padding: '5px 9px', fontSize: 11, fontWeight: 800, background: `${C.gray}18`, border: `1px solid ${C.gray}44`, color: C.gray, borderRadius: 6, cursor: 'pointer' }}>✕</button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span>{u.full_name}{isSelf && <span style={{ fontSize: 10, color: C.gray, fontWeight: 600 }}> (you)</span>}</span>
                              {!locked && <button onClick={() => startEditName(u)} title="Edit display name" style={{ background: 'none', border: 'none', color: C.gray, cursor: 'pointer', fontSize: 12, padding: 2 }}>✏️</button>}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px', color: C.gray, fontSize: 11 }}>{u.username || '—'}</td>
                        <td style={{ padding: '10px 12px', color: C.gray, fontSize: 11 }}>{u.email?.endsWith('@gemmn.local') ? <span title={u.email}>username-only</span> : (u.email || '—')}</td>
                        <td style={{ padding: '10px 12px' }}>
                          {locked
                            ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Badge label={u.roles?.label || u.role} tone="plain" /><span style={{ fontSize: 10, color: C.gray }}>🔒 locked</span></div>
                            : <select value={u.role} disabled={saving === u.id} onChange={e => changeRole(u, e.target.value)}
                                style={{ padding: '6px 10px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', background: '#fafcfb' }}>
                                {roles.filter(r => !r.full_access && (r.name !== 'pending' || u.role === 'pending')).map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
                              </select>}
                        </td>
                        <td style={{ padding: '10px 12px' }}><Badge label={u.status || 'active'} /></td>
                        <td style={{ padding: '10px 12px' }}>
                          {locked
                            ? <span style={{ fontSize: 11, color: C.gray, fontStyle: 'italic' }}>Full access — always enabled</span>
                            : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button onClick={() => toggleStatus(u)} disabled={saving === u.id || isSelf}
                                style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: isSelf ? 'not-allowed' : 'pointer', border: `1.5px solid ${u.status === 'disabled' || u.status === 'pending' ? C.accent : C.red}44`, background: `${u.status === 'disabled' || u.status === 'pending' ? C.accent : C.red}12`, color: u.status === 'disabled' || u.status === 'pending' ? C.accent : C.red, opacity: isSelf ? 0.4 : 1 }}>
                                {saving === u.id ? '…' : u.status === 'pending' ? 'Approve' : u.status === 'disabled' ? 'Re-enable' : 'Disable Access'}
                              </button>
                              <button onClick={() => deleteUser(u)} disabled={saving === u.id || isSelf} title="Permanently delete this login"
                                style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: isSelf ? 'not-allowed' : 'pointer', border: `1.5px solid ${C.gray}44`, background: `${C.gray}12`, color: C.gray, opacity: isSelf ? 0.4 : 1 }}>
                                🗑 Delete
                              </button>
                            </div>}
                        </td>
                      </tr>
                    )
                  })}</tbody>
                </table>}
          </div>
        </>
      )}

      {tab === 'roles' && (
        <div style={{ background: C.white, borderRadius: 12, padding: '20px 24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <p style={{ fontSize: 12, color: C.gray, margin: 0, maxWidth: 480 }}>
              Accountant and Manager are system roles — always available, never editable. Create custom roles (e.g. "Clerk") with whatever module access they need.
            </p>
            <button onClick={openNewRole} style={{ padding: '9px 20px', background: `linear-gradient(135deg,${C.purple},#5b21b6)`, border: 'none', borderRadius: 6, color: C.white, fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', cursor: 'pointer', boxShadow: `0 3px 10px ${C.purple}44` }}>
              + New Role
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {roles.map(r => (
              <div key={r.name} style={{ border: `1.5px solid ${C.lightGray}`, borderRadius: 10, padding: '14px 18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 900, fontSize: 13, color: C.dark }}>{r.label}</span>
                    {r.is_system && <span style={{ fontSize: 9, color: C.gray, fontWeight: 700 }}>🔒 SYSTEM ROLE</span>}
                    {r.full_access && <Badge label="Full Access" tone="plain" />}
                  </div>
                  {!r.is_system && (
                    <div style={{ display: 'flex', gap: 12 }}>
                      <button onClick={() => openEditRole(r)} style={{ fontSize: 10, fontWeight: 700, color: C.blue, background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>
                      <button onClick={() => deleteRole(r)} style={{ fontSize: 10, fontWeight: 700, color: C.red, background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                    </div>
                  )}
                </div>
                {!r.full_access && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {MODULES.map(m => {
                      const canView = r.modules?.includes(m.key)
                      const canEditThis = r.edit_modules?.includes(m.key)
                      if (!canView) return <span key={m.key} style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: C.lightGray, color: C.gray }}>{m.label}</span>
                      return (
                        <span key={m.key} style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: canEditThis ? `${C.accent}18` : `${C.blue}12`, color: canEditThis ? C.accent : C.blue }}>
                          {m.label}{canEditThis ? ' ✎' : ' 👁'}
                        </span>
                      )
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 14, fontSize: 10, color: C.gray }}>
                  <span>✎ = can edit · 👁 = view only</span>
                  <span>Manage Users: <b style={{ color: r.can_manage_users || r.full_access ? C.accent : C.gray }}>{r.can_manage_users || r.full_access ? 'Yes' : 'No'}</b></span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ADD NEW USER MODAL */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: C.white, borderRadius: 14, width: '100%', maxWidth: 480, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ background: `linear-gradient(135deg,${C.dark},${C.darkGreen})`, padding: '18px 24px', borderRadius: '14px 14px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: C.white, fontSize: 16, fontWeight: 900, letterSpacing: 1.5, textTransform: 'uppercase' }}>Add New User</div>
              <button onClick={() => setShowAdd(false)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: C.white, width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', fontSize: 16 }}>✕</button>
            </div>
            <div style={{ padding: 24 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Full Name</label>
                  <input value={newUser.fullName} onChange={e => setNewUser((p: any) => ({ ...p, fullName: e.target.value.toUpperCase() }))}
                    onFocus={e=>e.target.select()}
                    style={{ width: '100%', padding: '9px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Username</label>
                  <input value={newUser.username} onChange={e => setNewUser((p: any) => ({ ...p, username: e.target.value.replace(/\s/g, '') }))}
                    onFocus={e=>e.target.select()}
                    placeholder="username"
                    style={{ width: '100%', padding: '9px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: C.dark }}>
                  <input type="checkbox" checked={newUser.noEmail} onChange={e => setNewUser((p: any) => ({ ...p, noEmail: e.target.checked }))} />
                  No real email — username + password only (no "forgot password" support)
                </label>
              </div>

              {!newUser.noEmail && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Email</label>
                  <input type="email" value={newUser.email} onChange={e => setNewUser((p: any) => ({ ...p, email: e.target.value }))}
                    onFocus={e=>e.target.select()}
                    style={{ width: '100%', padding: '9px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                </div>
              )}

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Role</label>
                <select value={newUser.role} onChange={e => setNewUser((p: any) => ({ ...p, role: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}>
                  {roles.filter(r => !r.full_access).map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
                </select>
              </div>

              {!newUser.noEmail && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>How should they get access?</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={() => setNewUser((p: any) => ({ ...p, mode: 'invite' }))}
                      style={{ flex: 1, padding: '9px 0', fontSize: 11, fontWeight: 800, borderRadius: 6, cursor: 'pointer', border: `1.5px solid ${newUser.mode === 'invite' ? C.accent : C.lightGray}`, background: newUser.mode === 'invite' ? C.accent : C.white, color: newUser.mode === 'invite' ? C.white : C.gray }}>
                      ✉️ Email Invite
                    </button>
                    <button type="button" onClick={() => setNewUser((p: any) => ({ ...p, mode: 'create' }))}
                      style={{ flex: 1, padding: '9px 0', fontSize: 11, fontWeight: 800, borderRadius: 6, cursor: 'pointer', border: `1.5px solid ${newUser.mode === 'create' ? C.accent : C.lightGray}`, background: newUser.mode === 'create' ? C.accent : C.white, color: newUser.mode === 'create' ? C.white : C.gray }}>
                      🔑 Set Password Now
                    </button>
                  </div>
                </div>
              )}

              {(newUser.mode === 'create' || newUser.noEmail) && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Password</label>
                  <input type="text" value={newUser.password} onChange={e => setNewUser((p: any) => ({ ...p, password: e.target.value }))}
                    onFocus={e=>e.target.select()}
                    placeholder="At least 6 characters"
                    style={{ width: '100%', padding: '9px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                </div>
              )}

              {addError && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.red, marginBottom: 14 }}>{addError}</div>}
              {addSuccess && <div style={{ background: `${C.accent}12`, border: `1px solid ${C.accent}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.accent, marginBottom: 14 }}>{addSuccess}</div>}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowAdd(false)} style={{ padding: '9px 18px', fontSize: 11, fontWeight: 800, letterSpacing: 1, border: `2px solid ${C.gray}`, background: 'transparent', color: C.gray, borderRadius: 6, cursor: 'pointer', textTransform: 'uppercase' }}>Close</button>
                <button onClick={submitNewUser} disabled={addSaving} style={{ padding: '9px 22px', fontSize: 11, fontWeight: 800, letterSpacing: 1, background: `linear-gradient(135deg,${C.accent},${C.midGreen})`, border: 'none', color: C.white, borderRadius: 6, cursor: 'pointer', textTransform: 'uppercase', opacity: addSaving ? 0.6 : 1 }}>
                  {addSaving ? 'Creating…' : 'Create User'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NEW ROLE MODAL */}
      {showRoleModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: C.white, borderRadius: 14, width: '100%', maxWidth: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ background: `linear-gradient(135deg,${C.dark},${C.purple})`, padding: '18px 24px', borderRadius: '14px 14px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: C.white, fontSize: 16, fontWeight: 900, letterSpacing: 1.5, textTransform: 'uppercase' }}>{roleForm.name ? 'Edit Role' : 'New Custom Role'}</div>
              <button onClick={() => setShowRoleModal(false)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: C.white, width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', fontSize: 16 }}>✕</button>
            </div>
            <div style={{ padding: 24 }}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Role Name</label>
                <input value={roleForm.label} onChange={e => setRoleForm((p: any) => ({ ...p, label: e.target.value.toUpperCase() }))} onFocus={e=>e.target.select()} placeholder="Clerk"
                  style={{ width: '100%', padding: '9px 12px', border: `1.5px solid ${C.lightGray}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>Module Access</label>
                <div style={{ border: `1px solid ${C.lightGray}`, borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '6px 12px', background: '#f4f7f5', fontSize: 9, fontWeight: 800, color: C.gray, textTransform: 'uppercase' }}>
                    <span>Module</span><span style={{ textAlign: 'center' }}>View</span><span style={{ textAlign: 'center' }}>Edit</span>
                  </div>
                  {MODULES.map(m => {
                    const canView = roleForm.modules.includes(m.key)
                    const canEditThis = roleForm.editModules.includes(m.key)
                    return (
                      <div key={m.key} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '7px 12px', borderTop: `1px solid ${C.lightGray}`, alignItems: 'center', fontSize: 12 }}>
                        <span>{m.label}</span>
                        <input type="checkbox" style={{ justifySelf: 'center', cursor: 'pointer' }} checked={canView} onChange={() => toggleModule(m.key)} />
                        <input type="checkbox" style={{ justifySelf: 'center', cursor: canView ? 'pointer' : 'not-allowed' }} checked={canEditThis} disabled={!canView} onChange={() => toggleEditModule(m.key)} title={!canView ? 'Grant View first' : undefined} />
                      </div>
                    )
                  })}
                </div>
                <div style={{ fontSize: 10, color: C.gray, marginTop: 6 }}>Edit rights can only be granted for a module the role can also view — turning off View clears Edit for that module too.</div>
              </div>
              <div style={{ display: 'flex', gap: 20, marginBottom: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                  <input type="checkbox" checked={roleForm.canManageUsers} onChange={e => setRoleForm((p: any) => ({ ...p, canManageUsers: e.target.checked }))} />
                  Can manage users
                </label>
              </div>
              {roleError && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.red, marginBottom: 14 }}>{roleError}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowRoleModal(false)} style={{ padding: '9px 18px', fontSize: 11, fontWeight: 800, letterSpacing: 1, border: `2px solid ${C.gray}`, background: 'transparent', color: C.gray, borderRadius: 6, cursor: 'pointer', textTransform: 'uppercase' }}>Cancel</button>
                <button onClick={saveRole} disabled={roleSaving} style={{ padding: '9px 22px', fontSize: 11, fontWeight: 800, letterSpacing: 1, background: `linear-gradient(135deg,${C.purple},#5b21b6)`, border: 'none', color: C.white, borderRadius: 6, cursor: 'pointer', textTransform: 'uppercase', opacity: roleSaving ? 0.6 : 1 }}>
                  {roleSaving ? 'Saving…' : roleForm.name ? 'Save Changes' : 'Create Role'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
