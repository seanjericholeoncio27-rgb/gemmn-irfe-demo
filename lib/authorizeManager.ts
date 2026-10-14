import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabaseAdmin'

// Verifies the caller's session token and checks their role permits user/role
// management. Everything here uses the admin client, so it is NOT subject to
// RLS — this is intentional and is what fixes the "manager can't see all
// users" class of bug for good.
export async function authorizeManager(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) return { error: 'Not authenticated', status: 401 as const }

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data: { user }, error } = await anon.auth.getUser(token)
  if (error || !user) return { error: 'Invalid session', status: 401 as const }

  const admin = createAdminClient()
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).single()
  if (!profile) return { error: 'Profile not found', status: 403 as const }

  const { data: role } = await admin.from('roles').select('*').eq('name', profile.role).single()
  const authorized = !!(role?.full_access || role?.can_manage_users)
  if (!authorized) return { error: 'Not authorized to manage users or roles', status: 403 as const }

  return { admin, callerId: user.id, callerRole: role }
}
