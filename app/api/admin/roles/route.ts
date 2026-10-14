// FILE: app/api/admin/roles/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { authorizeManager } from '@/lib/authorizeManager'
import { createAdminClient } from '@/lib/supabaseAdmin'

// Any authenticated user can read the role list (needed for dropdowns, badges, etc.)
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data: { user }, error } = await anon.auth.getUser(token)
  if (error || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })

  const admin = createAdminClient()
  const { data: roles, error: e2 } = await admin.from('roles').select('*').order('is_system', { ascending: false }).order('label')
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
  return NextResponse.json({ roles })
}

// Only accountant/manager (can_manage_users) may create or edit CUSTOM roles.
// System roles (accountant, manager) are always protected here.
export async function POST(req: NextRequest) {
  const auth = await authorizeManager(req)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin } = auth

  try {
    const { name, label, modules, editModules, canManageUsers, isUpdate } = await req.json()
    if (!label?.trim()) return NextResponse.json({ error: 'Label is required' }, { status: 400 })

    const roleName = name?.trim() || label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!roleName) return NextResponse.json({ error: 'Could not derive a valid role name from that label' }, { status: 400 })

    const { data: existing } = await admin.from('roles').select('*').eq('name', roleName).maybeSingle()
    if (existing?.is_system) {
      return NextResponse.json({ error: 'System roles (Accountant, Manager) cannot be modified.' }, { status: 403 })
    }
    if (!isUpdate && existing) {
      return NextResponse.json({ error: `A role named "${roleName}" already exists.` }, { status: 400 })
    }

    // editModules is the real per-module edit grant now. can_edit stays set
    // (true if the role can edit anything at all) purely for any older code
    // path that might still read it directly — the per-module check is what
    // actually gates access going forward.
    const editModulesList: string[] = editModules || []
    const { error } = await admin.from('roles').upsert({
      name: roleName, label: label.trim(), is_system: false, full_access: false,
      can_edit: editModulesList.length > 0, can_manage_users: !!canManageUsers,
      modules: modules || [], edit_modules: editModulesList,
    })
    if (error) throw error

    return NextResponse.json({ success: true, name: roleName })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to save role' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await authorizeManager(req)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin } = auth

  try {
    const { name } = await req.json()
    const { data: existing } = await admin.from('roles').select('is_system').eq('name', name).maybeSingle()
    if (existing?.is_system) return NextResponse.json({ error: 'System roles cannot be deleted.' }, { status: 403 })

    const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', name)
    if (count && count > 0) return NextResponse.json({ error: `${count} user(s) still have this role. Reassign them first.` }, { status: 400 })

    const { error } = await admin.from('roles').delete().eq('name', name)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to delete role' }, { status: 500 })
  }
}
