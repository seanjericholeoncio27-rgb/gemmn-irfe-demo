'use client'
import { useEffect } from 'react'

// Adds the shared button motion (see .fx-btn in globals.css) to every primary
// gradient button in the app without touching each page: event delegation,
// so buttons rendered later (modals, tabs, lists) are picked up automatically.
export default function ButtonMotion() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    let current: HTMLButtonElement | null = null

    const eligible = (b: HTMLButtonElement) => {
      if (b.dataset.fx === '0' || b.disabled) return false
      if (b.classList.contains('fx-btn')) return true
      const cs = getComputedStyle(b)
      if (!cs.backgroundImage.includes('gradient')) return false
      if (cs.position === 'static') b.style.position = 'relative'
      b.classList.add('fx-btn')
      return true
    }

    const over = (e: PointerEvent) => {
      const b = (e.target as HTMLElement | null)?.closest?.('button') as HTMLButtonElement | null
      if (b && eligible(b)) current = b
    }
    const move = (e: PointerEvent) => {
      const b = current
      if (!b || !b.isConnected) return
      const r = b.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      b.style.setProperty('--mx', `${x}px`)
      b.style.setProperty('--my', `${y}px`)
      if (fine) {
        const dx = (x - r.width / 2) / (r.width / 2), dy = (y - r.height / 2) / (r.height / 2)
        b.style.translate = `${(dx * 3).toFixed(2)}px ${(dy * 3).toFixed(2)}px`
      }
    }
    const out = (e: PointerEvent) => {
      const b = (e.target as HTMLElement | null)?.closest?.('button') as HTMLButtonElement | null
      if (b && b === current && !b.contains(e.relatedTarget as Node | null)) {
        b.style.translate = ''
        current = null
      }
    }

    document.addEventListener('pointerover', over)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerout', out)
    return () => {
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
    }
  }, [])
  return null
}
