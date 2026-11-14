// Payment terms are free text on quotations and invoices ("30 Days", "COD",
// "50% down, balance 30 days", …). This is the ONE place that turns them into
// a due date, so the Invoices page, Dashboard, Reports, Projects and the
// notification bell always agree.
//
//   • a number of days in the text ("30 Days", "net 45", "45")   → invoice date + that many days
//   • COD / Cash on Delivery with no day count                   → the invoice's delivery date
//                                                                    once entered, otherwise invoice date + 30 days
//   • anything else (free text with no day count)                → invoice date + 30 days

export const PAYMENT_TERM_PRESETS = ['15 Days', '30 Days', '60 Days', '90 Days', 'COD']
export const DEFAULT_TERM_DAYS = 30

export const isCOD = (terms?: string | null) => /\bc\.?o\.?d\b|cash\s*on\s*delivery/i.test(terms || '')

// Days written in the terms, or null when there is no day count.
export function termDays(terms?: string | null): number | null {
  const s = terms || ''
  const m = /(\d+)\s*-?\s*(?:calendar\s*|working\s*|banking\s*)?days?\b/i.exec(s) || /\bnet\s*(\d+)\b/i.exec(s) || /^\s*(\d+)\s*$/.exec(s)
  return m ? Number(m[1]) : null
}

const isoDate = (v?: string | null) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null)

// UTC arithmetic so the result is the same in every timezone (local-midnight +
// toISOString() shifts dates by a day east of UTC, e.g. in Manila).
export function computeDueDate(dateStr?: string | null, terms?: string | null, deliveryDate?: string | null): string | null {
  const start = isoDate(dateStr)
  if (!start) return null
  const days = termDays(terms)
  if (days === null && isCOD(terms)) {
    const delivery = isoDate(deliveryDate)
    if (delivery) return delivery
  }
  const d = new Date(start + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + (days ?? DEFAULT_TERM_DAYS))
  return d.toISOString().slice(0, 10)
}

// Overdue starts the day AFTER the due date; paid/cancelled invoices never are.
export function isInvoiceOverdue(inv: { status?: string; date?: string; payment_terms?: string; delivery_date?: string | null }): boolean {
  if (inv.status === 'Paid' || inv.status === 'Cancelled') return false
  const due = computeDueDate(inv.date, inv.payment_terms, inv.delivery_date)
  if (!due) return false
  const dueDate = new Date(due + 'T00:00:00')
  dueDate.setDate(dueDate.getDate() + 1)
  return new Date() >= dueDate
}

// One-line explanation of how the due date was worked out, for forms.
export function dueDateNote(terms?: string | null, deliveryDate?: string | null): string {
  if (termDays(terms) === null && isCOD(terms)) {
    return isoDate(deliveryDate) ? 'COD — due on the delivery date' : 'COD — no delivery date yet, so it defaults to 30 days from the invoice date until one is entered'
  }
  if (termDays(terms) === null && (terms || '').trim()) return 'No day count in the terms — defaults to 30 days from the invoice date'
  return 'auto-computed from the invoice date'
}
