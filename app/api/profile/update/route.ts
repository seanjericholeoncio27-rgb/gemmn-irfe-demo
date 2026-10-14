// FILE: app/api/profile/update/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabaseAdmin'

// Self-service: a user editing their OWN name/username. Deliberately never
// accepts a userId from the client — the row to update is always derived
// from the caller's own verified session token, so there's no way to use
// this endpoint to edit anyone else's profile, role, or status.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data: { user }, error: authErr } = await anon.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })

  try {
    const { full_name, username, zoom_level } = await req.json()
    const admin = createAdminClient()

    if (username !== undefined && username.trim()) {
      const { data: taken } = await admin.from('profiles').select('id').eq('username', username.trim()).neq('id', user.id).maybeSingle()
      if (taken) return NextResponse.json({ error: `Username "${username}" is already taken.` }, { status: 400 })
    }

    const update: Record<string, any> = {}
    if (full_name !== undefined) update.full_name = full_name.trim()
    if (username !== undefined) update.username = username.trim()
    if (zoom_level !== undefined) update.zoom_level = Math.min(150, Math.max(80, Number(zoom_level) || 100))

    const { error } = await admin.from('profiles').update(update).eq('id', user.id)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Update failed' }, { status: 500 })
  }
}
