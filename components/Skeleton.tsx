import type { CSSProperties } from 'react'

// Shimmering placeholders shown while module data loads. Pure presentational
// (no hooks) so it works in both client pages and route-level loading.tsx.
const CSS = `
@keyframes gemmn-shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
.gemmn-sk{background:linear-gradient(90deg,#e8ede9 25%,#f4f7f5 50%,#e8ede9 75%);background-size:800px 100%;animation:gemmn-shimmer 1.3s infinite linear;border-radius:6px}
@media (prefers-reduced-motion:reduce){.gemmn-sk{animation:none}}
`
const card: CSSProperties = { background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }

export function Bone({ w = '100%', h = 14, style }: { w?: number | string; h?: number; style?: CSSProperties }) {
  return <div className="gemmn-sk" style={{ width: w, height: h, ...style }} />
}

export function SkeletonKpis({ count = 4 }: { count?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 14, marginBottom: 18 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={card}><Bone w="55%" h={11} /><Bone w="75%" h={24} style={{ marginTop: 12 }} /></div>
      ))}
    </div>
  )
}

export function SkeletonTable({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},1fr)`, gap: 16, padding: '10px 4px', borderBottom: '1px solid #e8ede9' }}>
        {Array.from({ length: cols }).map((_, c) => <Bone key={c} w="60%" h={11} />)}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},1fr)`, gap: 16, padding: '14px 4px', borderBottom: '1px solid #f1f4f2' }}>
          {Array.from({ length: cols }).map((_, c) => <Bone key={c} w={c === 0 ? '80%' : `${50 + ((r * 7 + c * 13) % 40)}%`} h={13} />)}
        </div>
      ))}
    </div>
  )
}

export function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 16 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={card}>
          <Bone w="45%" h={12} /><Bone w="80%" h={18} style={{ marginTop: 12 }} />
          <Bone w="100%" h={8} style={{ marginTop: 18 }} /><Bone w="65%" h={12} style={{ marginTop: 14 }} />
        </div>
      ))}
    </div>
  )
}

/** Table panel inside a white card, optionally with KPI tiles on top. */
export function SkeletonPanel({ kpis = 0, rows = 8, cols = 5, cards = 0, label = 'Loading' }: { kpis?: number; rows?: number; cols?: number; cards?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <style>{CSS}</style>
      {kpis > 0 && <SkeletonKpis count={kpis} />}
      {cards > 0 ? <SkeletonCards count={cards} /> : <div style={card}><SkeletonTable rows={rows} cols={cols} /></div>}
    </div>
  )
}

/** Full-page skeleton for route-level loading.tsx (title bar + panel). */
export function SkeletonPage(props: { kpis?: number; rows?: number; cols?: number; cards?: number; label?: string }) {
  return (
    <div style={{ padding: '4px 0' }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <Bone w={220} h={26} /><Bone w={120} h={34} style={{ borderRadius: 8 }} />
      </div>
      <SkeletonPanel {...props} />
    </div>
  )
}
