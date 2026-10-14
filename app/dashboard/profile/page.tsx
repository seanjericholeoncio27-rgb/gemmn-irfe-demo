'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'

const C = {
  darkGreen: '#1a4d2e', midGreen: '#2d6a4f', accent: '#39b54a',
  white: '#ffffff', dark: '#0d1f14', gray: '#6b7c72',
  lightGray: '#e8ede9', red: '#e53e3e', amber: '#d97706', blue: '#2563eb',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 8,
  fontSize: 14, fontFamily: 'inherit', color: C.dark, background: '#fafcfb', boxSizing: 'border-box', outline: 'none',
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: C.gray, marginTop: 5 }}>{hint}</div>}
    </div>
  )
}

export default function ProfilePage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<any>(null)

  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [savingInfo, setSavingInfo] = useState(false)
  const [infoMsg, setInfoMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const [zoomLevel, setZoomLevel] = useState(100)
  const [savingZoom, setSavingZoom] = useState(false)
  const applyZoom = (val: number) => {
    setZoomLevel(val)
    // Live preview across the whole app immediately — DashboardShell listens
    // for this so the change is visible without needing a page reload.
    window.dispatchEvent(new CustomEvent('gemmn-zoom-change', { detail: val }))
  }
  const saveZoom = async (val: number) => {
    setSavingZoom(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      await fetch('/api/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ zoom_level: val }),
      })
    }
    setSavingZoom(false)
  }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }
      const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      setProfile(prof)
      setFullName(prof?.full_name || '')
      setUsername(prof?.username || '')
      setEmail(user.email || '')
      setZoomLevel(prof?.zoom_level || 100)
      setLoading(false)
    })()
  }, [])

  const saveInfo = async () => {
    setSavingInfo(true); setInfoMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Session expired — please sign in again.')

      // Name/username go through a self-service API route (whitelisted fields only)
      const res = await fetch('/api/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ full_name: fullName, username }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not save changes.')

      // Email changes go through Supabase Auth directly — this triggers a
      // confirmation email to the NEW address; the change only takes effect
      // once that link is clicked, so the current session's email won't
      // update immediately even though the request succeeds.
      const { data: { user } } = await supabase.auth.getUser()
      if (email && email !== user?.email) {
        const { error: emailErr } = await supabase.auth.updateUser({ email })
        if (emailErr) throw emailErr
        setInfoMsg({ type: 'ok', text: 'Saved. Check your new email inbox to confirm the address change.' })
      } else {
        setInfoMsg({ type: 'ok', text: 'Saved.' })
      }
    } catch (err: any) {
      setInfoMsg({ type: 'error', text: err.message })
    }
    setSavingInfo(false)
  }

  const savePassword = async () => {
    setPwMsg(null)
    if (newPassword.length < 6) return setPwMsg({ type: 'error', text: 'Password must be at least 6 characters.' })
    if (newPassword !== confirmPassword) return setPwMsg({ type: 'error', text: "Passwords don't match." })
    setSavingPw(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) setPwMsg({ type: 'error', text: error.message })
    else { setPwMsg({ type: 'ok', text: 'Password updated.' }); setNewPassword(''); setConfirmPassword('') }
    setSavingPw(false)
  }

  if (loading) {
    return <div style={{ padding: 60, textAlign: 'center', color: C.gray }}>Loading…</div>
  }
  if (!profile) {
    return <div style={{ padding: 60, textAlign: 'center', color: C.gray }}>Could not load your profile. Try signing in again.</div>
  }

  const initials = (fullName || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      {/* Header — Facebook-style */}
      <div style={{ background: `linear-gradient(135deg, ${C.dark}, ${C.darkGreen})`, borderRadius: 16, padding: '32px 28px', textAlign: 'center', marginBottom: 20 }}>
        <div style={{ width: 76, height: 76, borderRadius: '50%', background: `linear-gradient(135deg, ${C.accent}, ${C.midGreen})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 900, color: C.white, margin: '0 auto 14px' }}>
          {initials}
        </div>
        <div style={{ color: C.white, fontSize: 19, fontWeight: 800 }}>{fullName || 'Unnamed User'}</div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4 }}>{profile.role}</div>
      </div>

      {/* Profile Info — Google-style simple fields */}
      <div style={{ background: C.white, borderRadius: 14, padding: '26px 28px', boxShadow: '0 2px 16px rgba(0,0,0,0.06)', marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.dark, marginBottom: 18 }}>Profile Information</div>

        <Row label="Full Name">
          <input value={fullName} onChange={e => setFullName(e.target.value.toUpperCase())} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setFullName('N/A')}} style={inputStyle} />
        </Row>
        <Row label="Username" hint="Used to sign in instead of your email.">
          {/* Casing preserved: /api/auth/resolve-username matches this value with an exact .eq() lookup, so forcing uppercase here would break sign-in for anyone who typed their username in lowercase. */}
          <input value={username} onChange={e => setUsername(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setUsername('N/A')}} style={inputStyle} />
        </Row>
        <Row label="Email" hint="Changing this sends a confirmation link to the new address before it takes effect.">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setEmail('N/A')}} style={inputStyle} />
        </Row>

        {infoMsg && (
          <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, background: infoMsg.type === 'ok' ? `${C.accent}12` : `${C.red}12`, color: infoMsg.type === 'ok' ? C.darkGreen : C.red }}>
            {infoMsg.text}
          </div>
        )}
        <button onClick={saveInfo} disabled={savingInfo} style={{ padding: '10px 24px', background: `linear-gradient(135deg,${C.accent},${C.midGreen})`, border: 'none', borderRadius: 8, color: C.white, fontSize: 12, fontWeight: 800, letterSpacing: 0.5, cursor: 'pointer' }}>
          {savingInfo ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {/* Password */}
      <div style={{ background: C.white, borderRadius: 14, padding: '26px 28px', boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.dark, marginBottom: 18 }}>Change Password</div>

        <Row label="New Password">
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} onFocus={e=>e.target.select()} style={inputStyle} placeholder="At least 6 characters" />
        </Row>
        <Row label="Confirm New Password">
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} onFocus={e=>e.target.select()} style={inputStyle} />
        </Row>

        {pwMsg && (
          <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, background: pwMsg.type === 'ok' ? `${C.accent}12` : `${C.red}12`, color: pwMsg.type === 'ok' ? C.darkGreen : C.red }}>
            {pwMsg.text}
          </div>
        )}
        <button onClick={savePassword} disabled={savingPw} style={{ padding: '10px 24px', background: `linear-gradient(135deg,${C.blue},#1d4ed8)`, border: 'none', borderRadius: 8, color: C.white, fontSize: 12, fontWeight: 800, letterSpacing: 0.5, cursor: 'pointer' }}>
          {savingPw ? 'Updating…' : 'Update Password'}
        </button>
      </div>

      {/* Accessibility — Display Size */}
      <div style={{ background: C.white, borderRadius: 14, padding: '26px 28px', boxShadow: '0 2px 16px rgba(0,0,0,0.06)', marginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.dark, marginBottom: 6 }}>Display Size</div>
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 18 }}>Makes everything on screen bigger or smaller — text, buttons, and spacing all together. Useful if you're working without your glasses handy.</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
          <button onClick={() => { const v = Math.max(80, zoomLevel - 10); applyZoom(v); saveZoom(v) }}
            style={{ width: 40, height: 40, borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, fontSize: 18, fontWeight: 900, color: C.dark, cursor: 'pointer' }}>A−</button>
          <div style={{ flex: 1 }}>
            <input type="range" min={80} max={150} step={10} value={zoomLevel}
              onChange={e => applyZoom(Number(e.target.value))}
              onMouseUp={e => saveZoom(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={e => saveZoom(Number((e.target as HTMLInputElement).value))}
              style={{ width: '100%' }} />
          </div>
          <button onClick={() => { const v = Math.min(150, zoomLevel + 10); applyZoom(v); saveZoom(v) }}
            style={{ width: 40, height: 40, borderRadius: 8, border: `1.5px solid ${C.lightGray}`, background: C.white, fontSize: 20, fontWeight: 900, color: C.dark, cursor: 'pointer' }}>A+</button>
          <div style={{ minWidth: 50, textAlign: 'right', fontSize: 16, fontWeight: 900, color: C.accent }}>{zoomLevel}%</div>
        </div>
        {zoomLevel !== 100 && (
          <button onClick={() => { applyZoom(100); saveZoom(100) }} style={{ fontSize: 11, fontWeight: 700, color: C.blue, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Reset to default (100%)</button>
        )}
        {savingZoom && <span style={{ fontSize: 11, color: C.gray, marginLeft: 12 }}>Saving…</span>}
      </div>
    </div>
  )
}
