// FILE: app/api/admin/create-user/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { authorizeManager } from '@/lib/authorizeManager'

export async function POST(req: NextRequest) {
  const auth = await authorizeManager(req)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin } = auth

  try {
    const { username, email, fullName, role, mode, password } = await req.json()
    if (!username?.trim()) return NextResponse.json({ error: 'Username is required' }, { status: 400 })
    if (!fullName?.trim()) return NextResponse.json({ error: 'Full name is required' }, { status: 400 })
    if (!role) return NextResponse.json({ error: 'Role is required' }, { status: 400 })

    // Role must exist in the roles table — no more hardcoded accountant/manager check
    const { data: roleRow } = await admin.from('roles').select('name').eq('name', role).single()
    if (!roleRow) return NextResponse.json({ error: `Role "${role}" does not exist` }, { status: 400 })

    const { data: existingUsername } = await admin.from('profiles').select('id').eq('username', username.trim()).maybeSingle()
    if (existingUsername) return NextResponse.json({ error: `Username "${username}" is already taken` }, { status: 400 })

    const hasRealEmail = !!email?.trim()
    const finalEmail = hasRealEmail ? email.trim() : `${username.trim()}@gemmn.local`

    if (!hasRealEmail && mode === 'invite') {
      return NextResponse.json({ error: 'Email invites require a real email address' }, { status: 400 })
    }
    if (mode === 'create' && (!password || password.length < 6)) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
    }

    let newUserId: string
    if (mode === 'invite') {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || req.headers.get('origin') || ''
      const { data, error } = await admin.auth.admin.inviteUserByEmail(finalEmail, {
        data: { full_name: fullName },
        redirectTo: `${siteUrl}/auth/set-password`,
      })
      if (error) throw error
      newUserId = data.user.id
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: finalEmail, password, email_confirm: true, user_metadata: { full_name: fullName },
      })
      if (error) throw error
      newUserId = data.user.id
    }

    const { error: profileError } = await admin.from('profiles').upsert({
      id: newUserId, full_name: fullName.trim(), username: username.trim(),
      email: finalEmail, role, status: 'active',
    })
    if (profileError) throw profileError

    return NextResponse.json({
      success: true, userId: newUserId,
      generatedEmail: hasRealEmail ? null : finalEmail,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create user' }, { status: 500 })
  }
}
