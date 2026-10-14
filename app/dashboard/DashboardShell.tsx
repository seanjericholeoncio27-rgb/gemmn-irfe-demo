'use client'
import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { usePermissions } from '@/lib/permissions'
import type { Profile } from '@/app/types/index'

const C = {
  darkGreen: '#1a4d2e', midGreen: '#2d6a4f', accent: '#39b54a',
  lightGreen: '#a8e6b3', white: '#ffffff', dark: '#0d1f14',
  gray: '#6b7c72', lightGray: '#e8ede9',red: '#EF4444',
  amber: '#F59E0B',
  blue: '#3B82F6',
  purple: '#8B5CF6',
}

// Nav items — visibility is now driven by the role's `modules` array from the
// roles table (see lib/permissions.ts), not a hardcoded list of role names.
const navItems = [
  { href: '/dashboard',            label: 'DASHBOARD',   icon: '⊞', module: 'dashboard' },
  { href: '/dashboard/projects',   label: 'PROJECTS',    icon: '📁', module: 'projects' },
  { href: '/dashboard/quotations', label: 'QUOTATIONS',  icon: '📋', module: 'quotations' },
  { href: '/dashboard/invoices',   label: 'INVOICES',    icon: '🧾', module: 'invoices' },
  { href: '/dashboard/payroll',    label: 'PAYROLL',     icon: '👥', module: 'payroll' },
  { href: '/dashboard/expenses',   label: 'ACCOUNTING',    icon: '💸', module: 'expenses' },
  { href: '/dashboard/purchasing', label: 'PURCHASING',  icon: '🛒', module: 'purchasing' },
  { href: '/dashboard/inventory',  label: 'INVENTORY',   icon: '📦', module: 'inventory' },
  { href: '/dashboard/resources',  label: 'RESOURCES',   icon: '🔧', module: 'resources' },
  { href: '/dashboard/reports',    label: 'REPORTS',     icon: '📊', module: 'reports' },
  { href: '/dashboard/access',     label: 'USER ACCESS', icon: '🔐', module: 'access' },
  { href: '/dashboard/audit-log',  label: 'AUDIT LOG',   icon: '📜', module: 'audit' },
]

export default function DashboardShell({ children, profile }: { children: React.ReactNode; profile: Profile }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const perms = usePermissions()

  // ── Accessibility: content zoom ────────────────────────────────────────────
  // Applied via CSS zoom rather than rewriting every hardcoded pixel font-size
  // across the app — scales text, buttons, and spacing all together. Starts
  // from the saved profile value; the Profile page can update it live via a
  // custom event without needing a full page reload.
  const [zoomLevel, setZoomLevel] = useState((profile as any)?.zoom_level || 100)
  useEffect(() => {
    const handler = (e: any) => setZoomLevel(e.detail)
    window.addEventListener('gemmn-zoom-change', handler)
    return () => window.removeEventListener('gemmn-zoom-change', handler)
  }, [])

  // ── Global Search ─────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  // Every module a role can actually see gets a slice of the global search —
  // gated the same way the sidebar nav itself is (perms.fullAccess or the
  // module key listed in perms.modules), so a role without e.g. Inventory
  // access never sees inventory rows surface here either. Each entry names
  // the module key it's gated behind, the table/columns to search, and how
  // to render a hit.
  const canSee = (moduleKey: string) => perms.fullAccess || perms.modules.includes(moduleKey)

  useEffect(() => {
    const q = searchQuery.trim()
    if (q.length < 2 || perms.loading) { setSearchResults([]); return }
    const timer = setTimeout(async () => {
      setSearching(true)
      const like = `%${q}%`
      type Lookup = { type: string; href: string; label: (r: any) => string; sub: (r: any) => string }
      const jobs: { lookup: Lookup; promise: any }[] = []

      if (canSee('quotations')) jobs.push({
        lookup: { type: 'Quotation', href: '/dashboard/quotations', label: r => r.id, sub: r => r.company_name || r.client },
        promise: supabase.from('quotations').select('id, client, company_name').or(`id.ilike.${like},client.ilike.${like},company_name.ilike.${like}`).limit(5),
      })
      if (canSee('invoices')) jobs.push({
        lookup: { type: 'Invoice', href: '/dashboard/invoices', label: r => r.id, sub: r => r.company_name || r.client },
        promise: supabase.from('invoices').select('id, client, company_name').or(`id.ilike.${like},client.ilike.${like},company_name.ilike.${like}`).limit(5),
      })
      if (canSee('projects')) jobs.push({
        lookup: { type: 'Project', href: '/dashboard/projects', label: r => r.name || r.id, sub: r => r.po_number ? `PO ${r.po_number}` : r.client },
        promise: supabase.from('projects').select('id, name, client, po_number').or(`id.ilike.${like},name.ilike.${like},client.ilike.${like},po_number.ilike.${like}`).limit(5),
      })
      if (canSee('payroll')) jobs.push({
        lookup: { type: 'Employee', href: '/dashboard/payroll', label: r => r.name, sub: r => r.id },
        promise: supabase.from('employees').select('id, name').ilike('name', like).limit(5),
      })
      if (canSee('expenses')) jobs.push({
        lookup: { type: 'Expense', href: '/dashboard/expenses', label: r => r.id, sub: r => r.description },
        promise: supabase.from('expenses').select('id, description').or(`id.ilike.${like},description.ilike.${like}`).limit(5),
      })
      // Materials Registry — this is the table behind Inventory's main tab;
      // previously missing from search entirely.
      if (canSee('inventory')) jobs.push({
        lookup: { type: 'Material', href: '/dashboard/inventory', label: r => r.name, sub: r => [r.id, r.supplier].filter(Boolean).join(' · ') },
        promise: supabase.from('inventory').select('id, name, supplier').or(`id.ilike.${like},name.ilike.${like},supplier.ilike.${like}`).limit(5),
      })
      if (canSee('purchasing')) {
        jobs.push({
          lookup: { type: 'Material Request', href: '/dashboard/purchasing', label: r => r.material_name, sub: r => r.po_number ? `PO ${r.po_number} · ${r.status}` : r.status },
          promise: supabase.from('material_requests').select('id, material_name, po_number, status').or(`id.ilike.${like},material_name.ilike.${like},po_number.ilike.${like}`).limit(5),
        })
        jobs.push({
          lookup: { type: 'Purchase Order', href: '/dashboard/purchasing', label: r => r.id, sub: r => r.po_number ? `Client PO ${r.po_number} · ${r.status}` : r.status },
          promise: supabase.from('purchase_orders').select('id, po_number, status').or(`id.ilike.${like},po_number.ilike.${like}`).limit(5),
        })
        jobs.push({
          lookup: { type: 'Supplier', href: '/dashboard/purchasing', label: r => r.name, sub: () => 'Supplier' },
          promise: supabase.from('suppliers').select('id, name').ilike('name', like).limit(5),
        })
      }
      if (canSee('resources')) jobs.push({
        lookup: { type: 'Equipment', href: '/dashboard/resources', label: r => r.name, sub: r => r.brand || r.status },
        promise: supabase.from('equipment').select('id, name, brand, status').or(`id.ilike.${like},name.ilike.${like},brand.ilike.${like}`).limit(5),
      })

      const settled: { data: any[] | null }[] = await Promise.all(jobs.map(j => j.promise))
      setSearchResults(
        settled.flatMap(({ data }, i) => {
          const { type, href, label, sub } = jobs[i].lookup
          return (data || []).map((r: any) => ({ type, href, label: label(r), sub: sub(r) }))
        })
      )
      setSearching(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, perms.loading, perms.fullAccess, perms.modules])

  // ── Notifications — computed live from current data, not a stored/dismissable
  // log. Simpler and more reliable than tracking read/unread state per user;
  // an alert just disappears on its own once the underlying condition clears. ──
  const [notifications, setNotifications] = useState<any[]>([])
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifLoading, setNotifLoading] = useState(false)
  const fetchNotifications = async () => {
    setNotifLoading(true)
    const today = new Date().toISOString().slice(0, 10)
    const soon = new Date(); soon.setDate(soon.getDate() + 3)
    const soonStr = soon.toISOString().slice(0, 10)

    const [{ data: overdueInv }, { data: lowStock }, { data: pendingQuotes }, { data: expiringQuo }, { data: pendingApproval }, { data: approvedReqs }, { data: poItemReqs }, { data: quoWithPo }] = await Promise.all([
      supabase.from('invoices').select('id, client, date, payment_terms').neq('status', 'Paid'),
      supabase.from('inventory').select('id, name, quantity, min_stock'),
      supabase.from('material_requests').select('id, material_name, status').eq('status', 'Pending Quotes'),
      supabase.from('quotations').select('id, valid_until').eq('status', 'Sent').lte('valid_until', soonStr),
      supabase.from('purchase_orders').select('id, purchase_order_items(qty,unit_price)').eq('status', 'Pending Approval'),
      // Ready to Buy: approved quote + live client PO, no supplier PO yet (shown to Purchasing users only)
      supabase.from('material_requests').select('id, material_name, po_number, quotation_id').eq('status', 'Approved').or('archived.is.null,archived.eq.false'),
      supabase.from('purchase_order_items').select('material_request_id').not('material_request_id', 'is', null),
      supabase.from('quotations').select('id, po_number').not('po_number', 'is', null),
    ])

    const items: any[] = []
    // Each alert is only shown to users who can open the module it points to
    const seeInv = canSee('invoices'), seeInventory = canSee('inventory'), seePurch = canSee('purchasing'), seeQuo = canSee('quotations')
    ;(seeInv ? (overdueInv || []) : []).forEach((inv: any) => {
      const days = Number((inv.payment_terms || '30 Days').match(/\d+/)?.[0] || 30)
      const due = new Date(inv.date); due.setDate(due.getDate() + days)
      if (due < new Date()) items.push({ type: 'Overdue Invoice', text: `${inv.id} — ${inv.client}`, href: '/dashboard/invoices', color: C.red })
    })
    ;(seeInventory ? (lowStock || []) : []).forEach((i: any) => {
      if (i.min_stock > 0 && i.quantity < i.min_stock) items.push({ type: 'Low Stock', text: `${i.name} — ${i.quantity} left (min ${i.min_stock})`, href: '/dashboard/inventory', color: C.amber })
    })
    ;(seePurch ? (pendingQuotes || []) : []).forEach((r: any) => items.push({ type: 'Awaiting Quotes', text: r.material_name, href: '/dashboard/purchasing', color: C.blue }))
    ;(seeQuo ? (expiringQuo || []) : []).forEach((q: any) => items.push({ type: q.valid_until < today ? 'Quotation Expired' : 'Quotation Expiring', text: q.id, href: '/dashboard/quotations', color: q.valid_until < today ? C.red : C.amber }))
    ;(seePurch ? (pendingApproval || []) : []).forEach((o: any) => {
      const total = (o.purchase_order_items||[]).reduce((s: number, i: any) => s + Number(i.qty) * Number(i.unit_price), 0)
      items.push({ type: 'Needs Approval', text: `${o.id} — ${total.toLocaleString('en-PH', { style: 'currency', currency: 'PHP' })}`, href: '/dashboard/purchasing', color: C.purple })
    })

    if (seePurch) {
      const ordered = new Set((poItemReqs || []).map((r: any) => r.material_request_id))
      const quoPo: Record<string, string> = Object.fromEntries((quoWithPo || []).filter((q: any) => (q.po_number || '').trim()).map((q: any) => [q.id, q.po_number]))
      const ready = (approvedReqs || []).filter((r: any) => !ordered.has(r.id) && ((r.po_number || '').trim() || (r.quotation_id && quoPo[r.quotation_id])))
      if (ready.length > 0) items.push({ type: 'Ready to Buy', text: `${ready.length} approved material${ready.length === 1 ? '' : 's'} with an active PO — release a supplier PO`, href: '/dashboard/purchasing', color: C.accent })
    }

    setNotifications(items)
    setNotifLoading(false)
  }
  useEffect(() => { if (!perms.loading) fetchNotifications() }, [perms.loading])

  // Sidebar collapse — defaults open on first render (server-safe), then
  // syncs from localStorage right after mount so it persists across pages
  // without causing a hydration mismatch.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const saved = localStorage.getItem('gemmn-sidebar-collapsed')
    if (saved === 'true') setCollapsed(true)
  }, [])
  const toggleCollapsed = () => {
    setCollapsed(p => {
      localStorage.setItem('gemmn-sidebar-collapsed', String(!p))
      return !p
    })
  }
  const sidebarWidth = collapsed ? 68 : 220

  const visibleNav = navItems.filter(item => perms.fullAccess || perms.modules.includes(item.module))

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  // Page title map
  const titles: Record<string, string> = {
    '/dashboard': 'Dashboard',
    '/dashboard/projects': 'Projects',
    '/dashboard/quotations': 'Quotation Builder',
    '/dashboard/invoices': 'Invoice Generator',
    '/dashboard/payroll': 'Payroll Management',
    '/dashboard/expenses': 'Accounting',
    '/dashboard/purchasing': 'Purchasing',
    '/dashboard/inventory': 'Materials Inventory',
    '/dashboard/resources': 'Equipment Resources',
    '/dashboard/reports': 'Reports & Analytics',
    '/dashboard/access': 'User Access',
    '/dashboard/audit-log': 'Audit Log',
    '/dashboard/profile': 'My Profile',
  }
  const pageTitle = titles[pathname] || 'Dashboard'
  const now = new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'Barlow Condensed', sans-serif" }}>
      {/* Sidebar */}
      <div style={{ width: sidebarWidth, background: `linear-gradient(180deg, ${C.dark} 0%, ${C.darkGreen} 100%)`, display: 'flex', flexDirection: 'column', position: 'fixed', top: 0, left: 0, height: '100vh', zIndex: 100, boxShadow: '4px 0 20px rgba(0,0,0,0.3)', transition: 'width 0.2s ease' }}>
        {/* Logo */}
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: collapsed ? 'center' : 'flex-start' }}>
            <img
              src="/gemmn-logo.png"
              alt="GEMMN Engineering Works"
              style={{ width: 44, height: 44, flexShrink: 0, filter: `drop-shadow(0 0 8px ${C.accent}66)` }}
            />
            {!collapsed && (
              <div>
                <div style={{ color: C.accent, fontWeight: 900, fontSize: 15, letterSpacing: 2, whiteSpace: 'nowrap' }}>GEMMN</div>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 8, letterSpacing: 1.5, marginTop: 1, whiteSpace: 'nowrap' }}>ENGINEERING WORKS</div>
              </div>
            )}
          </div>
          {!collapsed && (
            <>
              <div style={{ marginTop: 10, background: `linear-gradient(90deg, ${C.accent}, transparent)`, height: 2, borderRadius: 2 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <span style={{ padding: '2px 8px', borderRadius: 10, background: profile.role === 'accountant' ? `${C.accent}33` : `rgba(255,255,255,0.1)`, color: profile.role === 'accountant' ? C.accent : 'rgba(255,255,255,0.5)', fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>
                  {profile.role}
                </span>
              </div>
            </>
          )}
        </div>
        {/* Nav */}
        <nav style={{ flex: 1, padding: '10px 0', overflowY: 'auto' }}>
          {visibleNav.map(item => {
            const isActive = pathname === item.href
            return (
              <a key={item.href} href={item.href} title={collapsed ? item.label : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: collapsed ? 'center' : 'flex-start', padding: '10px 16px', background: isActive ? `linear-gradient(90deg, ${C.accent}22, transparent)` : 'transparent', borderLeft: isActive ? `3px solid ${C.accent}` : '3px solid transparent', color: isActive ? C.accent : 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textDecoration: 'none', transition: 'all 0.2s' }}>
                <span style={{ fontSize: 14 }}>{item.icon}</span>
                {!collapsed && item.label}
              </a>
            )
          })}
        </nav>
        {/* User + Logout */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <a href="/dashboard/profile" title={collapsed ? `${profile.full_name} — View Profile` : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, justifyContent: collapsed ? 'center' : 'flex-start', textDecoration: 'none', borderRadius: 8, padding: '4px 6px', margin: '-4px -6px 6px', background: pathname==='/dashboard/profile' ? 'rgba(57,181,74,0.15)' : 'transparent', transition: 'background 0.2s' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: `linear-gradient(135deg, ${C.darkGreen}, ${C.accent})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 900, color: C.white, flexShrink: 0 }}>
              {profile.full_name?.split(' ').map((n: string) => n[0]).slice(0, 2).join('') || '??'}
            </div>
            {!collapsed && (
              <div>
                <div style={{ color: C.white, fontSize: 11, fontWeight: 700, lineHeight: 1.2, whiteSpace: 'nowrap' }}>{profile.full_name}</div>
                <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>{profile.role}</div>
              </div>
            )}
          </a>
          <button onClick={handleLogout} title={collapsed ? 'Sign Out' : undefined}
            style={{ width: '100%', padding: '7px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'uppercase', transition: 'all 0.2s' }}>
            {collapsed ? '⎋' : 'Sign Out'}
          </button>
        </div>
      </div>

      {/* Collapse toggle — sits on the sidebar's edge, moves with it */}
      <button onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{ position: 'fixed', top: 24, left: sidebarWidth - 13, zIndex: 101, width: 26, height: 26, borderRadius: '50%', background: C.white, border: `1.5px solid ${C.lightGray}`, color: C.darkGreen, fontSize: 11, fontWeight: 900, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.15)', transition: 'left 0.2s ease', padding: 0 }}>
        {collapsed ? '›' : '‹'}
      </button>

      {/* Main */}
      <div style={{ marginLeft: sidebarWidth, flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh', transition: 'margin-left 0.2s ease' }}>
        {/* Topbar */}
        <div style={{ background: C.white, borderBottom: `3px solid ${C.accent}`, padding: '0 28px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 2px 10px rgba(0,0,0,0.08)', position: 'sticky', top: 0, zIndex: 50 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: 2, color: C.dark, textTransform: 'uppercase' }}>{pageTitle}</div>
            <div style={{ fontSize: 11, color: C.gray, marginTop: 1 }}>{now}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, justifyContent: 'center', maxWidth: 420, position: 'relative' }}>
            <div style={{ position: 'relative', width: '100%' }}>
              <input
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true) }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
                placeholder="🔍  Search quotations, invoices, materials, POs…"
                style={{ width: '100%', padding: '8px 14px', border: `1.5px solid ${C.lightGray}`, borderRadius: 20, fontSize: 12, fontFamily: 'inherit', color: C.dark, outline: 'none', background: '#fafcfb', boxSizing: 'border-box' }}
              />
              {searchOpen && searchQuery.trim().length >= 2 && (
                <div style={{ position: 'absolute', top: '110%', left: 0, right: 0, background: C.white, borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', border: `1px solid ${C.lightGray}`, maxHeight: 340, overflowY: 'auto', zIndex: 200 }}>
                  {searching ? (
                    <div style={{ padding: 16, fontSize: 12, color: C.gray, textAlign: 'center' }}>Searching…</div>
                  ) : searchResults.length === 0 ? (
                    <div style={{ padding: 16, fontSize: 12, color: C.gray, textAlign: 'center' }}>No matches.</div>
                  ) : (
                    searchResults.map((r, i) => (
                      <a key={i} href={r.href} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', textDecoration: 'none', borderBottom: i < searchResults.length - 1 ? `1px solid ${C.lightGray}` : 'none' }}>
                        <span style={{ fontSize: 9, fontWeight: 800, color: C.accent, background: `${C.accent}18`, padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', flexShrink: 0 }}>{r.type}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.dark, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</div>
                          {r.sub && <div style={{ fontSize: 10, color: C.gray, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sub}</div>}
                        </div>
                      </a>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              <button onClick={() => { setNotifOpen(o => !o); if (!notifOpen) fetchNotifications() }}
                style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: 6, display: 'flex' }}>
                🔔
                {notifications.length > 0 && (
                  <span style={{ position: 'absolute', top: 0, right: 0, background: C.red, color: C.white, fontSize: 9, fontWeight: 800, borderRadius: 10, minWidth: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>
                    {notifications.length}
                  </span>
                )}
              </button>
              {notifOpen && (
                <div onMouseLeave={() => setNotifOpen(false)} style={{ position: 'absolute', top: '130%', right: 0, width: 320, background: C.white, borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', border: `1px solid ${C.lightGray}`, maxHeight: 400, overflowY: 'auto', zIndex: 200 }}>
                  <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.lightGray}`, fontSize: 11, fontWeight: 800, color: C.gray, textTransform: 'uppercase' }}>Notifications</div>
                  {notifLoading ? (
                    <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: C.gray }}>Loading…</div>
                  ) : notifications.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: C.gray }}>All clear — nothing needs attention.</div>
                  ) : (
                    notifications.map((n, i) => (
                      <a key={i} href={n.href} style={{ display: 'block', padding: '10px 14px', textDecoration: 'none', borderBottom: i < notifications.length - 1 ? `1px solid ${C.lightGray}` : 'none' }}>
                        <span style={{ fontSize: 9, fontWeight: 800, color: n.color, textTransform: 'uppercase' }}>{n.type}</span>
                        <div style={{ fontSize: 12, color: C.dark, marginTop: 2 }}>{n.text}</div>
                      </a>
                    ))
                  )}
                </div>
              )}
            </div>
            {!perms.loading && !perms.canEdit && (
              <span style={{ padding: '4px 12px', borderRadius: 20, background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.3)', color: '#2563eb', fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>VIEW ONLY</span>
            )}
            <span style={{ padding: '4px 14px', borderRadius: 20, background: `${C.accent}18`, border: `1px solid ${C.accent}44`, color: C.accent, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>● LIVE DATA</span>
          </div>
        </div>
        {/* Page Content */}
        <div style={{ padding: '26px 30px', flex: 1, zoom: `${zoomLevel}%` } as React.CSSProperties}>{children}</div>
        {/* Footer */}
        <div style={{ background: C.white, borderTop: `1px solid ${C.lightGray}`, padding: '10px 30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: C.gray }}>© 2024 GEMMN ENGINEERING WORKS · IRFE SYSTEM v2.0 · Guiguinto, Bulacan</span>
          <span style={{ fontSize: 10, color: C.accent, fontWeight: 700 }}>GEMMNEngineeringWorks@gmail.com</span>
        </div>
      </div>
    </div>
  )
}