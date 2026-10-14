// FILE: app/api/admin/list-users/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { authorizeManager } from '@/lib/authorizeManager'

export async function GET(req: NextRequest) {
  const auth = await authorizeManager(req)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin } = auth

  try {
    const { data: profiles, error: e1 } = await admin
      .from('profiles')
      .select('*, roles(label, is_system, full_access)')
      .order('full_name')
    if (e1) throw e1

    // Auth emails live separately from profiles — pull them via the admin API
    // so the Access page can show who's who without needing an `email` column
    // to be perfectly in sync.
    const { data: authList, error: e2 } = await admin.auth.admin.listUsers({ perPage: 200 })
    if (e2) throw e2
    const emailMap: Record<string, string> = {}
    authList.users.forEach(u => { emailMap[u.id] = u.email || '' })

    const merged = (profiles || []).map(p => ({ ...p, email: emailMap[p.id] || p.email || '' }))
    return NextResponse.json({ users: merged })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to list users' }, { status: 500 })
  }
}
