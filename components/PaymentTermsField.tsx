'use client'
import { PAYMENT_TERM_PRESETS } from '@/lib/paymentTerms'

// Payment terms picker: common choices (including COD) plus "Other" for typing
// any terms by hand — letters and numbers, e.g. "50% down, balance upon delivery".
export default function PaymentTermsField({ value, onChange, inputStyle }: { value: string; onChange: (v: string) => void; inputStyle: React.CSSProperties }) {
  const isPreset = PAYMENT_TERM_PRESETS.includes(value)
  return (
    <div>
      <select value={isPreset ? value : 'Other'} onChange={e => onChange(e.target.value === 'Other' ? '' : e.target.value)} style={inputStyle}>
        {PAYMENT_TERM_PRESETS.map(p => <option key={p} value={p}>{p === 'COD' ? 'COD (Cash on Delivery)' : p}</option>)}
        <option value="Other">Other (type manually)…</option>
      </select>
      {!isPreset && (
        <input type="text" value={value} maxLength={80} autoFocus={value === ''} onFocus={e => e.target.select()}
          onChange={e => onChange(e.target.value)} onBlur={e => onChange(e.target.value.trim())}
          placeholder="Type payment terms, e.g. 50% DP, balance upon delivery" style={{ ...inputStyle, marginTop: 6 }} />
      )}
    </div>
  )
}
