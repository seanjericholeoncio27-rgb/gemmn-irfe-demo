// FILE: app/api/auth/signup/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'

// Public self-registration. The account is created with the "pending" role and
// status, which has no module access and cannot sign in until a manager
// approves it and assigns a real role on the User Access page.
export async function POST(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') return NextResponse.json({ error: 'Sign-up is disabled in the public demo. Use one of the demo accounts.' }, { status: 403 })
  try {
    const { fullName, username, email, password } = await req.json()
    const name = String(fullName || '').trim()
    const uname = String(username || '').trim()
    const mail = String(email || '').trim()
    if (!name) return NextResponse.json({ error: 'Full name is required' }, { status: 400 })
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(uname)) return NextResponse.json({ error: 'Username must be 3–30 letters, numbers, dot, dash or underscore' }, { status: 400 })
    if (mail && !/^\S+@\S+\.\S+$/.test(mail)) return NextResponse.json({ error: 'Email looks invalid' }, { status: 400 })
    if (!password || String(password).length < 6) return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })

    const admin = createAdminClient()
    const { data: pendingRole } = await admin.from('roles').select('name').eq('name', 'pending').maybeSingle()
    if (!pendingRole) return NextResponse.json({ error: 'Sign-up is not enabled yet. Please contact an administrator.' }, { status: 503 })

    const { data: taken } = await admin.from('profiles').select('id').ilike('username', uname).maybeSingle()
    if (taken) return NextResponse.json({ error: `Username "${uname}" is already taken` }, { status: 400 })

    const finalEmail = mail || `${uname}@gemmn.local`
    const { data, error } = await admin.auth.admin.createUser({
      email: finalEmail, password, email_confirm: true, user_metadata: { full_name: name },
    })
    if (error) {
      const msg = /already|registered|exists/i.test(error.message) ? 'That email is already registered' : error.message
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    const { error: pErr } = await admin.from('profiles').upsert({
      id: data.user.id, full_name: name, username: uname, email: finalEmail, role: 'pending', status: 'pending',
    })
    if (pErr) {
      await admin.auth.admin.deleteUser(data.user.id)
      throw pErr
    }
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Sign-up failed' }, { status: 500 })
  }
}
