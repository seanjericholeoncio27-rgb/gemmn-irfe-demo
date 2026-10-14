// FILE: app/api/admin/update-user/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { authorizeManager } from '@/lib/authorizeManager'

export async function POST(req: NextRequest) {
  const auth = await authorizeManager(req)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin, callerId } = auth

  try {
    const { userId, full_name, role, status, username } = await req.json()
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })

    const { data: target } = await admin.from('profiles').select('*, roles(full_access)').eq('id', userId).single()
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // Accountant (full_access) accounts are permanently protected — no role or
    // status change can ever be applied to them from this endpoint.
    if ((target as any).roles?.full_access) {
      return NextResponse.json({ error: 'This account has full access by design and cannot be modified here.' }, { status: 403 })
    }
    if (status === 'disabled' && userId === callerId) {
      return NextResponse.json({ error: "You can't disable your own access." }, { status: 400 })
    }

    const update: Record<string, any> = {}
    if (full_name !== undefined) update.full_name = full_name
    if (status !== undefined) update.status = status
    if (username !== undefined) update.username = username
    if (role !== undefined) {
      const { data: roleRow } = await admin.from('roles').select('name, full_access').eq('name', role).single()
      if (!roleRow) return NextResponse.json({ error: `Role "${role}" does not exist` }, { status: 400 })
      if (roleRow.full_access) {
        return NextResponse.json({ error: 'Accounts cannot be promoted to a full-access role from this screen.' }, { status: 403 })
      }
      update.role = role
    }

    const { error } = await admin.from('profiles').update(update).eq('id', userId)
    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update user' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await authorizeManager(req)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin, callerId } = auth

  try {
    const { userId } = await req.json()
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })

    if (userId === callerId) {
      return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 })
    }

    const { data: target } = await admin.from('profiles').select('*, roles(full_access)').eq('id', userId).single()
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // Accountant (full_access) accounts can never be deleted from this screen —
    // same permanent protection as role/status changes above.
    if ((target as any).roles?.full_access) {
      return NextResponse.json({ error: 'This account has full access by design and cannot be deleted here.' }, { status: 403 })
    }

    // Delete the Auth user first — Supabase Auth is the source of truth for
    // login. The profiles row is removed by the on-delete cascade if one
    // exists; if not, we clean it up explicitly right after as a fallback.
    const { error: authError } = await admin.auth.admin.deleteUser(userId)
    if (authError) throw authError

    await admin.from('profiles').delete().eq('id', userId)

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to delete user' }, { status: 500 })
  }
}
