// ============================================================
// FILE: app/auth/set-password/page.tsx
// ============================================================
'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

const C = {
  darkGreen: '#1a4d2e', accent: '#39b54a', dark: '#0d1f14',
  white: '#ffffff', gray: '#6b7c72', lightGray: '#e8ede9', red: '#e53e3e',
}

export default function SetPasswordPage() {
  const supabase = createClient()
  const router = useRouter()

  // 'checking' → still verifying the invite link produced a valid session
  // 'ready'    → session confirmed, show the form
  // 'invalid'  → link expired, already used, or opened directly with no session
  // 'success'  → password set, about to redirect in
  const [status, setStatus] = useState<'checking' | 'ready' | 'invalid' | 'success'>('checking')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // The Supabase client auto-detects the invite token in the URL on load
    // (detectSessionInUrl defaults to true) and turns it into a real,
    // temporary session — we just need to confirm one actually landed.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setStatus('ready')
        const metaName = data.session.user.user_metadata?.full_name
        if (metaName) setFullName(metaName)
      } else {
        setStatus('invalid')
      }
    })
  }, [supabase])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 6) return setError('Password must be at least 6 characters.')
    if (password !== confirm) return setError('Passwords do not match.')

    setSaving(true)
    try {
      const updates: any = { password }
      if (fullName.trim()) updates.data = { full_name: fullName.trim() }
      const { error: updateError } = await supabase.auth.updateUser(updates)
      if (updateError) throw updateError

      // Keep profiles.full_name in sync if they adjusted it here
      const { data: userData } = await supabase.auth.getUser()
      if (userData.user && fullName.trim()) {
        await supabase.from('profiles').update({ full_name: fullName.trim() }).eq('id', userData.user.id)
      }

      setStatus('success')
      setTimeout(() => router.push('/dashboard'), 1200)
    } catch (err: any) {
      setError(err.message || 'Could not set password. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: `linear-gradient(135deg, ${C.dark} 0%, ${C.darkGreen} 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.white, borderRadius: 16, width: '100%', maxWidth: 420, overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
        {/* Header */}
        <div style={{ background: `linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`, padding: '32px 36px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: -20, right: -20, width: 100, height: 100, borderRadius: '50%', background: `${C.accent}22` }} />
          <div style={{ width: 64, height: 64, margin: '0 auto 14px' }}>
            <img src="/gemmn-logo.png" alt="GEMMN Engineering Works" style={{ width: '100%', height: '100%', filter: `drop-shadow(0 0 14px ${C.accent}66)` }} />
          </div>
          <div style={{ color: C.accent, fontWeight: 900, fontSize: 22, letterSpacing: 3 }}>GEMMN</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, letterSpacing: 2, marginTop: 2 }}>ENGINEERING WORKS — IRFE SYSTEM</div>
        </div>

        <div style={{ padding: '32px 36px' }}>
          {status === 'checking' && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: C.gray, fontSize: 13 }}>Verifying your invite…</div>
          )}

          {status === 'invalid' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>⚠</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.dark, marginBottom: 6 }}>This invite link isn't valid</div>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 20, lineHeight: 1.6 }}>
                It may have already been used, or it's expired. Ask an administrator to send a new invite from User Access, then open the link straight from that new email.
              </div>
              <button onClick={() => router.push('/login')}
                style={{ width: '100%', padding: '11px', background: 'transparent', border: `1.5px solid ${C.accent}`, borderRadius: 8, color: C.accent, fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit' }}>
                Go to Login
              </button>
            </div>
          )}

          {status === 'success' && (
            <div style={{ textAlign: 'center', padding: '10px 0' }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>✓</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.accent }}>Password set — signing you in…</div>
            </div>
          )}

          {status === 'ready' && (
            <form onSubmit={handleSubmit}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 20, lineHeight: 1.6 }}>Welcome to GEMMN IRFE. Set a password to finish creating your account.</div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Full Name</label>
                <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} required
                  style={{ width: '100%', padding: '11px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: C.dark, boxSizing: 'border-box', outline: 'none' }}
                  placeholder="Juan Dela Cruz" />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>New Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6}
                  style={{ width: '100%', padding: '11px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: C.dark, boxSizing: 'border-box', outline: 'none' }}
                  placeholder="At least 6 characters" />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Confirm Password</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                  style={{ width: '100%', padding: '11px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: C.dark, boxSizing: 'border-box', outline: 'none' }}
                  placeholder="••••••••" />
              </div>

              {error && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.red, marginBottom: 16 }}>{error}</div>}

              <button type="submit" disabled={saving}
                style={{ width: '100%', padding: '13px', background: `linear-gradient(135deg, ${C.accent}, ${C.darkGreen})`, border: 'none', borderRadius: 8, color: C.white, fontSize: 13, fontWeight: 800, letterSpacing: 2, textTransform: 'uppercase', cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: saving ? 0.7 : 1, boxShadow: `0 4px 16px ${C.accent}44` }}>
                {saving ? 'Setting Password…' : 'Set Password & Continue'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
