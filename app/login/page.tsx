// ============================================================
// FILE: app/login/page.tsx
// ============================================================
'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

const C = {
  darkGreen: '#1a4d2e', accent: '#39b54a', dark: '#0d1f14',
  white: '#ffffff', gray: '#6b7c72', lightGray: '#e8ede9', red: '#e53e3e',
}

const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === 'true'
const DEMO_PASSWORD = 'Demo#2026'
const DEMO_ACCOUNTS = [
  { username: 'admin', label: 'Admin', note: 'full access, all modules' },
  { username: 'accountant', label: 'Accountant', note: 'finance, payroll, billing' },
  { username: 'viewer', label: 'Viewer', note: 'read-only' },
]

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('') // username OR email
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [su, setSu] = useState({ fullName: '', username: '', email: '', password: '', confirm: '' })
  const [notice, setNotice] = useState('')
  const router = useRouter()
  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      // If it looks like an email, use it directly. Otherwise resolve the
      // username to its underlying email via the server (Supabase Auth is
      // email-based under the hood even though staff only see a username).
      let email = identifier.trim()
      if (!email.includes('@')) {
        const res = await fetch('/api/auth/resolve-username', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: email }),
        })
        const result = await res.json()
        if (!res.ok) throw new Error(result.error || 'Invalid username or password')
        email = result.email
      }

      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) throw new Error(signInError.message)

      const { data: profile } = await supabase.from('profiles').select('status').eq('id', data.user.id).single()
      if (profile?.status === 'pending') {
        await supabase.auth.signOut()
        throw new Error('Your account is awaiting approval. An administrator will activate it and assign your access.')
      }
      if (profile?.status === 'disabled') {
        await supabase.auth.signOut()
        throw new Error('Your access has been disabled. Please contact an administrator.')
      }

      router.push('/dashboard')
    } catch (err: any) {
      setError(err.message || 'Invalid username or password')
      setLoading(false)
    }
  }

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setNotice('')
    if (su.password !== su.confirm) { setError('Passwords do not match'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: su.fullName, username: su.username, email: su.email, password: su.password }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Sign-up failed')
      setNotice('Request sent! An administrator must approve your account before you can sign in.')
      setIdentifier(su.username.trim()); setPassword('')
      setSu({ fullName: '', username: '', email: '', password: '', confirm: '' })
      setMode('login')
    } catch (err: any) { setError(err.message || 'Sign-up failed') }
    setLoading(false)
  }

  const inputStyle: React.CSSProperties = { width: '100%', padding: '11px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: C.dark, boxSizing: 'border-box', outline: 'none' }
  const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 6 }

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
        {/* Form */}
        {mode === 'signup' ? (
        <form onSubmit={handleSignup} style={{ padding: '28px 36px 32px' }}>
          <div style={{ fontSize: 13, color: C.gray, marginBottom: 16 }}>Request access. An administrator will approve your account and assign your role.</div>
          <div style={{ marginBottom: 14 }}><label style={labelStyle}>Full Name</label>
            <input style={inputStyle} required value={su.fullName} onChange={e => setSu({ ...su, fullName: e.target.value })} /></div>
          <div style={{ marginBottom: 14 }}><label style={labelStyle}>Username</label>
            <input style={inputStyle} required autoCapitalize="none" autoCorrect="off" value={su.username} onChange={e => setSu({ ...su, username: e.target.value })} placeholder="3–30 letters/numbers" /></div>
          <div style={{ marginBottom: 14 }}><label style={labelStyle}>Email (optional)</label>
            <input style={inputStyle} type="email" autoCapitalize="none" value={su.email} onChange={e => setSu({ ...su, email: e.target.value })} /></div>
          <div style={{ marginBottom: 14 }}><label style={labelStyle}>Password</label>
            <input style={inputStyle} type="password" required minLength={6} value={su.password} onChange={e => setSu({ ...su, password: e.target.value })} /></div>
          <div style={{ marginBottom: 18 }}><label style={labelStyle}>Confirm Password</label>
            <input style={inputStyle} type="password" required minLength={6} value={su.confirm} onChange={e => setSu({ ...su, confirm: e.target.value })} /></div>
          {error && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.red, marginBottom: 16 }}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '13px', background: `linear-gradient(135deg, ${C.accent}, ${C.darkGreen})`, border: 'none', borderRadius: 8, color: C.white, fontSize: 13, fontWeight: 800, letterSpacing: 2, textTransform: 'uppercase', cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Sending…' : 'Request Access'}
          </button>
          <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: C.gray }}>
            Already have an account? <a href="#" onClick={e => { e.preventDefault(); setError(''); setMode('login') }} style={{ color: C.darkGreen, fontWeight: 700 }}>Sign in</a>
          </div>
        </form>
        ) : (
        <form onSubmit={handleLogin} style={{ padding: '32px 36px' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Username or Email</label>
            <input type="text" value={identifier} onChange={e => setIdentifier(e.target.value)} required
              style={{ width: '100%', padding: '11px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: C.dark, boxSizing: 'border-box', outline: 'none' }}
              placeholder="username or user@gemmn.com" />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.gray, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{ width: '100%', padding: '11px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: C.dark, boxSizing: 'border-box', outline: 'none' }}
              placeholder="••••••••" />
          </div>
          {notice && <div style={{ background: `${C.accent}14`, border: `1px solid ${C.accent}55`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.darkGreen, marginBottom: 16 }}>{notice}</div>}
          {error && <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.red, marginBottom: 16 }}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '13px', background: `linear-gradient(135deg, ${C.accent}, ${C.darkGreen})`, border: 'none', borderRadius: 8, color: C.white, fontSize: 13, fontWeight: 800, letterSpacing: 2, textTransform: 'uppercase', cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: loading ? 0.7 : 1, boxShadow: `0 4px 16px ${C.accent}44` }}>
            {loading ? 'Signing In…' : 'Sign In'}
          </button>
          {DEMO ? (
            <div style={{ marginTop: 18, border: `1.5px dashed ${C.accent}88`, borderRadius: 10, padding: '12px 14px', background: `${C.accent}0d` }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: C.darkGreen, textTransform: 'uppercase', marginBottom: 8 }}>Portfolio demo — fictional data</div>
              {DEMO_ACCOUNTS.map(a => (
                <button key={a.username} type="button" onClick={() => { setIdentifier(a.username); setPassword(DEMO_PASSWORD); setError('') }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 6, background: C.white, border: `1px solid ${C.lightGray}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
                  <b style={{ color: C.darkGreen, fontSize: 12 }}>{a.label}</b> <span style={{ color: C.gray, fontSize: 11 }}>— {a.note}</span>
                </button>
              ))}
              <div style={{ fontSize: 10, color: C.gray }}>Tap a role to fill the form, then press Sign In. Shared password: <b>{DEMO_PASSWORD}</b></div>
            </div>
          ) : (
          <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: C.gray }}>
            New here? <a href="#" onClick={e => { e.preventDefault(); setError(''); setNotice(''); setMode('signup') }} style={{ color: C.darkGreen, fontWeight: 700 }}>Request access</a>
          </div>
          )}
        </form>
        )}
      </div>
    </div>
  )
}
