'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'

export const MODULES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'projects', label: 'Projects' },
  { key: 'quotations', label: 'Quotations' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'expenses-bank', label: 'Accounting: Bank Ledger' },
  { key: 'expenses-pcf', label: 'Accounting: Petty Cash Fund' },
  { key: 'purchasing', label: 'Purchasing' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'resources', label: 'Resources' },
  { key: 'reports', label: 'Reports' },
  { key: 'access', label: 'User Access' },
  { key: 'audit', label: 'Audit Log' },
] as const

const ALL_MODULE_KEYS = MODULES.map(m => m.key)

export type Permissions = {
  role: string
  roleLabel: string
  fullAccess: boolean   // accountant — always true regardless of stored config
  canEdit: boolean      // true if this role can edit ANY module — kept for convenience/back-compat
  canEditModule: (moduleKey: string) => boolean  // the real per-module check — use this in pages
  canManageUsers: boolean
  modules: string[]
  editModules: string[]
  loading: boolean
}

const DEFAULT: Permissions = {
  role: '', roleLabel: '', fullAccess: false, canEdit: false, canEditModule: () => false,
  canManageUsers: false, modules: [], editModules: [], loading: true,
}

// Use this in any page/component instead of checking `profile.role === 'accountant'`.
// Prefer canEditModule('your-module-key') over the bare canEdit — canEdit only
// tells you whether the role can edit ANYTHING, not whether it can edit THIS page.
// Example: const { canEditModule } = usePermissions(); const canEdit = canEditModule('projects')
export function usePermissions(): Permissions {
  const supabase = createClient()
  const [state, setState] = useState<Permissions>(DEFAULT)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setState(s => ({ ...s, loading: false })); return }

      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
      if (!profile) { if (active) setState(s => ({ ...s, loading: false })); return }

      const { data: role } = await supabase.from('roles').select('*').eq('name', profile.role).single()
      if (!active) return

      if (!role) { setState({ ...DEFAULT, role: profile.role, loading: false }); return }

      const fullAccess = !!role.full_access
      const modules = fullAccess ? ALL_MODULE_KEYS : (role.modules || [])
      const editModules = fullAccess ? ALL_MODULE_KEYS : (role.edit_modules || [])
      setState({
        role: role.name,
        roleLabel: role.label,
        fullAccess,
        canEdit: fullAccess || editModules.length > 0,
        canEditModule: (moduleKey: string) => fullAccess || editModules.includes(moduleKey),
        canManageUsers: fullAccess || !!role.can_manage_users,
        modules,
        editModules,
        loading: false,
      })
    })()
    return () => { active = false }
  }, [])

  return state
}