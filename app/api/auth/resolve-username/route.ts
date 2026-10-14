// FILE: app/api/auth/resolve-username/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'

// Supabase Auth is email-based under the hood, but staff only need to
// remember a username. This route is intentionally public (no session yet —
// the user hasn't logged in) and just maps username -> email so the login
// page can call signInWithPassword with a real email address.
export async function POST(req: NextRequest) {
  try {
    const { username } = await req.json()
    if (!username?.trim()) return NextResponse.json({ error: 'Username is required' }, { status: 400 })

    const admin = createAdminClient()
    const { data: profile } = await admin.from('profiles').select('id, email').eq('username', username.trim()).maybeSingle()
    if (!profile) return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 })

    let email = profile.email
    if (!email) {
      const { data } = await admin.auth.admin.getUserById(profile.id)
      email = data.user?.email || null
    }
    if (!email) return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 })

    return NextResponse.json({ email })
  } catch (err: any) {
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 })
  }
}
