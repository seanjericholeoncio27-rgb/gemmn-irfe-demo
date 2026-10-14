'use client'
import { useEffect, useState, useCallback, Fragment } from 'react'
import { createClient } from '@/lib/supabase'
import { fetchAll as fetchAllPages } from '@/lib/fetchAll'
import { usePermissions } from '@/lib/permissions'

const C={darkGreen:'#1a4d2e',midGreen:'#2d6a4f',accent:'#39b54a',white:'#ffffff',dark:'#0d1f14',gray:'#6b7c72',lightGray:'#e8ede9',red:'#e53e3e',amber:'#d97706',blue:'#2563eb',purple:'#7c3aed'}
const fmt=(n:number)=>`₱${Number(n||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`

// ── helpers ──────────────────────────────────────────────────────────────────
function calcGross(emp:any, rec:any){
  if(!emp) return 0
  // Prefer the real tiered-rate amount computed and saved at generation time.
  // Only fall back to the flat 1.25x approximation for older records saved
  // before overtime_pay existed — those never had the true figure stored.
  const otPay = rec.overtime_pay!=null ? Number(rec.overtime_pay) : Number(rec.overtime_hours||0)*(Number(emp.rate)/8*1.25)
  // Same reasoning for regular pay — days_worked gets rounded to 2 decimals
  // for storage/display, and re-multiplying days×rate downstream can drift a
  // hair from the true figure since both were rounded independently. Prefer
  // the actual computed regular_pay; only reconstruct for pre-existing
  // records saved before this column existed.
  const base = emp.employment_type==='Salaried' ? Number(emp.rate)/2
    : rec.regular_pay!=null ? Number(rec.regular_pay) : Number(emp.rate)*Number(rec.days_worked||0)
  const extras = Number(rec.sunday_pay||0)+Number(rec.night_diff_pay||0)+Number(rec.regular_holiday_pay||0)+Number(rec.special_holiday_pay||0)+Number(rec.leave_pay||0)
  return base + otPay + extras
}
function calcNet(emp:any, rec:any){
  const gross=calcGross(emp,rec)
  // deduction_lines is the ad-hoc "+ Add deduction line" list (benefits loans,
  // etc. entered directly on the record) — it must count against net pay just
  // like the named deduction fields below, or an added line silently does
  // nothing to the total shown/saved.
  const dedLines=(rec.deduction_lines||[]).reduce((s:number,d:any)=>s+Number(d?.amount||0),0)
  return gross+Number(rec.allowance||0)-Number(rec.sss||0)-Number(rec.philhealth||0)-Number(rec.pagibig||0)-Number(rec.tax||0)-Number(rec.cash_advance_deduction||0)-Number(rec.loan_deduction||0)-Number(rec.company_deduction||0)-Number(rec.other_deductions||0)-dedLines
}

// ── attendance import helpers ─────────────────────────────────────────────
// Biometric exports vary wildly — dates/times may arrive as JS Date objects,
// Excel serial numbers, or plain strings. These normalize whatever shows up
// into a consistent YYYY-MM-DD / HH:MM before anything gets saved.
function excelSerialToDate(n: number) {
  return new Date(Math.round((n - 25569) * 86400 * 1000))
}
function normalizeDate(v: any): string {
  if (!v && v !== 0) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return excelSerialToDate(v).toISOString().slice(0, 10)
  const s = String(v).trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return s.slice(0, 10)
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s)
  if (mdy) {
    const [, m, d, y] = mdy
    const yr = y.length === 2 ? `20${y}` : y
    return `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const parsed = new Date(s)
  return isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}
function normalizeTime(v: any): string {
  if (v === '' || v === null || v === undefined) return ''
  if (v instanceof Date) return v.toTimeString().slice(0, 5)
  if (typeof v === 'number') {
    // Excel time-only serials are a fraction of a day (0–1); full datetimes
    // include a date portion too — take just the fractional part either way.
    const frac = v - Math.floor(v)
    const totalMin = Math.round(frac * 24 * 60)
    return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`
  }
  const s = String(v).trim()
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s)
  if (!m) return ''
  let h = Number(m[1]); const min = m[2]
  if (m[3]) { if (/pm/i.test(m[3]) && h < 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0 }
  return `${String(h).padStart(2, '0')}:${min}`
}
// Loose name matching — biometric export uses "First M. Last" while internal
// records may use "Last, First M." or any other order. Compares word-token
// overlap instead of exact string equality so a best-guess match is possible.
function nameSimilarity(a: string, b: string): number {
  const tokens = (s: string) => new Set(s.toUpperCase().replace(/[.,]/g, '').split(/\s+/).filter(t => t.length > 1))
  const ta = tokens(a), tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let overlap = 0
  ta.forEach(t => { if (tb.has(t)) overlap++ })
  return overlap / Math.max(ta.size, tb.size)
}

// Parses the biometric device's native multi-block export ("Attend. Logs"
// sheet): each employee occupies a 4-row block — ID/Name/Dept header, day
// numbers, day-of-week labels, then a punch row where multiple punches in
// one day are newline-separated. Returns one entry per employee with their
// raw day-by-day punch lists, ready for the employee-mapping step.
function parseBiometricBlocks(sheetRows: any[][]): { biometricId: string, name: string, dept: string, days: { date: string, punches: string[] }[] }[] {
  // Find the period header ("Date  06/13/2026 ~ 06/28/2026") to know which
  // year/month each bare day-number belongs to.
  let startYear = 0, startMonth = 0, startDay = 0
  for (const row of sheetRows) {
    const cell = String(row?.[1] ?? '')
    const m = /(\d{2})\/(\d{2})\/(\d{4})\s*~/.exec(cell) || /(\d{2})\/(\d{2})\/(\d{4})\s*~/.exec(String(row?.[2] ?? ''))
    if (m) { startMonth = Number(m[1]); startDay = Number(m[2]); startYear = Number(m[3]); break }
  }
  const results: { biometricId: string, name: string, dept: string, days: { date: string, punches: string[] }[] }[] = []
  let i = 0
  while (i < sheetRows.length) {
    const row = sheetRows[i]
    if (row?.[0] === 'ID') {
      const biometricId = String(row[2] ?? '').trim()
      const name = String(row[10] ?? '').trim()
      const dept = String(row[20] ?? '').trim()
      const dayNumRow = sheetRows[i + 1] || []
      const punchRow = sheetRows[i + 3] || []
      const days: { date: string, punches: string[] }[] = []
      if (startYear) {
        // Build each date directly from the sheet's own day-of-month number —
        // never from a column-index offset, and never round-tripped through
        // a Date object's toISOString() (which silently shifts by a day
        // depending on the browser's local timezone).
        let year = startYear, month = startMonth
        let prevDayNum = -1
        for (let col = 0; col < 16; col++) {
          const raw0 = dayNumRow[col]
          if (raw0 == null || raw0 === '') continue
          const dayNum = Number(raw0)
          if (Number.isNaN(dayNum)) continue
          // Handle a period that crosses a month boundary (day number resets lower)
          if (prevDayNum !== -1 && dayNum < prevDayNum) {
            month += 1
            if (month > 12) { month = 1; year += 1 }
          }
          prevDayNum = dayNum
          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
          const raw = punchRow[col]
          const punches = raw ? String(raw).split('\n').map((p: string) => p.trim()).filter(Boolean) : []
          days.push({ date: dateStr, punches })
        }
      }
      results.push({ biometricId, name, dept, days })
      i += 4
    } else {
      i++
    }
  }
  return results
}

// Applies the confirmed parsing rule to one day's raw punch list:
// 2 punches = in/out (1hr default lunch). 4 punches = in/lunch-out/lunch-in/out
// (real lunch duration). Anything else gets flagged for clerk review.
// Paid time never starts before 8:00 AM, regardless of actual punch time —
// arriving early doesn't earn regular pay for that gap. The true punch is
// still preserved separately (raw_punches) for the clerk's reference.
function clampToShiftStart(timeIn: string, dateStr?: string): string {
  if (!timeIn) return timeIn
  const isSaturday = dateStr ? new Date(dateStr + 'T00:00:00').getDay() === 6 : false
  const floor = isSaturday ? 7 : 8
  const [h, m] = timeIn.split(':').map(Number)
  return (h < floor) ? `${String(floor).padStart(2, '0')}:00` : timeIn
}

// A few minutes past the shift end is normal clock drift and never auto-pays
// or flags anything. A full hour or more past it is worth a clerk's eyes —
// it might be a real OT form waiting to be cross-referenced, or it might not.
function shiftEndHour(dateStr?: string): number {
  const isSaturday = dateStr ? new Date(dateStr + 'T00:00:00').getDay() === 6 : false
  return isSaturday ? 16 : 17 // 4PM Saturday, 5PM other days
}

function hasMeaningfulOvertime(timeOut: string | null, dateStr?: string): boolean {
  if (!timeOut) return false
  const shiftEndHour_ = shiftEndHour(dateStr)
  const [h] = timeOut.split(':').map(Number)
  return h >= shiftEndHour_ + 1
}

// A slightly-early arrival or a slightly-late departure (not reaching the
// "meaningful OT" hour) is just normal clock drift — Mon-Fri normalizes to
// a clean 8AM-5PM regardless. Only when time_out actually reaches into real
// OT territory does the true punched time get retained and flagged for a
// clerk to review — matching clampToShiftStart's same logic, mirrored for
// the end of the shift instead of the start.
function clampToShiftEnd(timeOut: string, dateStr?: string): string {
  if (!timeOut) return timeOut
  if (hasMeaningfulOvertime(timeOut, dateStr)) return timeOut
  const endHour = shiftEndHour(dateStr)
  return `${String(endHour).padStart(2, '0')}:00`
}

function interpretPunches(punches: string[], dateStr?: string): { time_in: string | null, time_out: string | null, break_minutes: number, needs_review: boolean, hours_worked: number } {
  if (punches.length === 0) return { time_in: null, time_out: null, break_minutes: 0, needs_review: false, hours_worked: 0 }
  if (punches.length === 2) {
    const [rawIn, rawOut] = punches
    const tin = clampToShiftStart(rawIn, dateStr)
    const tout = clampToShiftEnd(rawOut, dateStr)
    return { time_in: tin, time_out: tout, break_minutes: 60, needs_review: hasMeaningfulOvertime(rawOut, dateStr), hours_worked: computeHours(tin, tout, 60) }
  }
  if (punches.length === 4) {
    const [rawIn, , , rawOut] = punches
    const tin = clampToShiftStart(rawIn, dateStr)
    const tout = clampToShiftEnd(rawOut, dateStr)
    // Break is always a fixed 60 minutes regardless of the actual gap between
    // the lunch-out/lunch-in punches — those two middle punches are only used
    // to confirm a lunch was taken, not to shorten or lengthen the deduction.
    return { time_in: tin, time_out: tout, break_minutes: 60, needs_review: hasMeaningfulOvertime(rawOut, dateStr), hours_worked: computeHours(tin, tout, 60) }
  }
  // 1, 3, 5, 6, 7+ punches — irregular, flag for the clerk
  const tin = clampToShiftStart(punches[0], dateStr)
  const tout = punches.length > 1 ? punches[punches.length - 1] : null
  return {
    time_in: tin, time_out: tout, break_minutes: 60, needs_review: true,
    hours_worked: tout ? computeHours(tin, tout, 60) : 0,
  }
}

function computeHours(timeIn: string, timeOut: string, breakMinutes: number): number {
  if (!timeIn || !timeOut) return 0
  const [hi, mi] = timeIn.split(':').map(Number)
  const [ho, mo] = timeOut.split(':').map(Number)
  let mins = (ho * 60 + mo) - (hi * 60 + mi)
  if (mins < 0) mins += 24 * 60 // overnight shift
  mins -= (breakMinutes || 0)
  return Math.max(0, Math.round((mins / 60) * 100) / 100)
}

// ── DATE-BASED DAILY RATE ───────────────────────────────────────────────────
// A probationary employee's daily rate can change mid-cutoff. Each employee may
// carry a rate_history ([{effective_from, rate}], oldest first, loaded from the
// employee_rates table). Every day is priced at the rate in force ON THAT DATE;
// with no history the single employees.rate is used, exactly as before.
function addMonthsClamped(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  t.setUTCDate(Math.min(d, last))
  return t.toISOString().slice(0, 10)
}
function addDays(dateStr: string, n: number): string {
  const t = new Date(dateStr + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10)
}
// Raise takes effect the day AFTER the 3-month (or 6-month) mark.
const raiseDateFor = (hire: string, months: number) => addDays(addMonthsClamped(hire, months), 1)
function rateOn(emp: any, date: string): number {
  const h: any[] = emp?.rate_history
  if (!h || h.length === 0) return Number(emp?.rate) || 0
  let r = Number(h[0].rate)
  for (const row of h) { if (String(row.effective_from) <= date) r = Number(row.rate); else break }
  return r
}

// ── PAYROLL COMPUTATION ENGINE ──────────────────────────────────────────────
// Turns a stretch of attendance_logs into the full earnings breakdown,
// applying the holiday rules from RULES sheet: regular holiday = 200% if
// worked / 100% if not, +30% OT premium; special (non-working) holiday =
// 130% if worked, +30% OT premium, no pay if unworked; special working
// holiday = ordinary rate, no premium; Sunday/rest day = 130%, +30% OT.
//
// Night differential is a MANUAL toggle (nightDiffOverride), not derived
// from clock time crossing 10PM — that auto-detection was folding an
// unpredictable premium silently into overtime_pay with no visible trace,
// which is what caused net salary to come out inconsistent between what
// Generate produced and what a manual payslip edit could reproduce. When
// the toggle is on, night diff (+10%) applies to ALL of that day's OT
// hours, tracked as its own separate, visible, editable line — regardless
// of what time the OT actually happened.
function computePayrollFromAttendance(emp: any, logs: any[], holidays: any[], periodStart?: string, periodEnd?: string, nightDiffOverride?: boolean) {
  // Salaried employees (owners/partners drawing a fixed salary) get paid a
  // flat rate every cutoff regardless of attendance — no clock-in tracking,
  // no presence requirement, no OT, no holiday adjustments. Pure fixed pay.
  if (emp.employment_type === 'Salaried') {
    const cutoffPay = Number(emp.rate) / 2
    return {
      regularDays: 13, regularPay: round2(cutoffPay), // 13 ≈ half of 26, shown for reference only
      otHours: 0, otPay: 0,
      sundayDays: 0, sundayPay: 0,
      nightDiffHours: 0, nightDiffPay: 0,
      regHolidayDays: 0, regHolidayPay: 0,
      specHolidayDays: 0, specHolidayPay: 0,
      leaveDays: 0, leavePay: 0, leaveDates: [],
      grossPay: round2(cutoffPay),
      flaggedDays: 0,
    }
  }

  let regularDays = 0, regularPay = 0
  // Regular-pay segments grouped by the daily rate in force, for the payslip
  const segMap = new Map<number, { rate: number, from: string, to: string, days: number, amount: number }>()
  const addSeg = (date: string, rate: number, days: number, amount: number) => {
    if (days <= 0) return
    const g = segMap.get(rate) || { rate, from: date, to: date, days: 0, amount: 0 }
    if (date < g.from) g.from = date
    if (date > g.to) g.to = date
    g.days += days; g.amount += amount
    segMap.set(rate, g)
  }
  let otHours = 0, otPay = 0, nightDiffHoursTotal = 0, nightDiffPayTotal = 0
  let sundayDays = 0, sundayPay = 0
  let regHolidayDays = 0, regHolidayPay = 0
  let specHolidayDays = 0, specHolidayPay = 0
  let leaveDays = 0, leavePay = 0, leaveDatesOut: string[] = []
  let flaggedDays = 0 // needs_review count, surfaced so the UI can warn before payslips print

  const loggedDates = new Set(logs.map(l => l.date))

  for (const log of logs) {
    if (log.needs_review) flaggedDays++
    const dailyRate = rateOn(emp, log.date)   // the rate in force on THIS day
    const hourlyRate = dailyRate / 8
    if (log.leave_type) {
      // Paid VL/SL day — full daily rate, no attendance math needed.
      leaveDays += 1
      leavePay += dailyRate
      leaveDatesOut.push(log.date)
      continue
    }
    const hrs = Number(log.hours_worked) || 0
    // Full-day-pay employees (owners, or a role with a legitimately shortened
    // schedule like a cook who leaves after the last meal) get paid for the
    // complete day whenever present — actual hours worked don't matter, no
    // proration for coming in "late" or leaving early by design.
    const reg = emp.full_day_pay ? (hrs > 0 ? 8 : 0) : Math.min(hrs, 8)
    // OT is NEVER auto-derived from clock time anymore — working late without
    // a confirmed OT form just goes unpaid for the excess (and gets flagged
    // for review below). Paid OT only exists when the clerk explicitly enters
    // it here, cross-referenced against an actual OT form or verbal approval.
    // Managerial/fixed-rate employees marked ot_exempt never get OT pay at
    // all, even if something was entered — this forces it to zero everywhere
    // downstream (ordinary day, holiday, Sunday all read from this one value).
    const ot = emp.ot_exempt ? 0 : Number(log.manual_ot_minutes || 0) / 60
    const dateObj = new Date(log.date + 'T00:00:00')
    const isSunday = dateObj.getDay() === 0
    const holiday = holidays.find(h => h.date === log.date)
    const holType = (log.holiday_type_override && log.holiday_type_override !== 'auto') ? log.holiday_type_override : (holiday?.type || 'none')

    if (holType === 'regular') {
      if (hrs > 0) {
        regHolidayDays += 1
        regHolidayPay += dailyRate * 2 // 200% for the first 8 hours worked
        otPay += ot * hourlyRate * 1.3 // +30% OT premium on a regular holiday
      } else {
        regHolidayDays += 1
        regHolidayPay += dailyRate * 1 // 100% even if not worked, per RULES sheet
      }
    } else if (holType === 'special_non_working') {
      if (hrs > 0) {
        specHolidayDays += 1
        specHolidayPay += dailyRate * 1.3
        otPay += ot * hourlyRate * 1.3
      }
      // no work, no pay on a special non-working holiday — matches RULES sheet
    } else if (holType === 'special_working') {
      regularDays += reg / 8
      regularPay += reg * hourlyRate
      addSeg(log.date, dailyRate, reg / 8, reg * hourlyRate)
      otPay += ot * hourlyRate * 1.25
    } else if (isSunday && hrs > 0) {
      sundayDays += reg / 8
      sundayPay += reg * hourlyRate * 1.3
      otHours += ot
      otPay += ot * hourlyRate * 1.3
    } else {
      // Ordinary day — OT is always 125% of hourly rate. Night differential
      // (+10%) is added on top of ALL this day's OT hours when the manual
      // toggle is on for this cutoff — not derived from what time it
      // happened, so it's predictable and independently visible/editable.
      regularDays += reg / 8
      regularPay += reg * hourlyRate
      addSeg(log.date, dailyRate, reg / 8, reg * hourlyRate)
      otHours += ot
      otPay += ot * hourlyRate * 1.25
      if (nightDiffOverride && ot > 0) {
        nightDiffHoursTotal += ot
        nightDiffPayTotal += ot * hourlyRate * 0.10
      }
    }
  }

  // DOLE: a regular holiday still pays 100% even when nobody worked it — but
  // that day usually has NO attendance row at all (no punch, nothing to loop
  // over above), so it would otherwise get silently skipped entirely. Credit
  // it here instead, as long as the employee meets DOLE's eligibility rule:
  // present (or on approved leave) on the workday immediately before it.
  if (periodStart && periodEnd) {
    const wasPresentOrOnLeave = (dateStr: string) => {
      const log = logs.find(l => l.date === dateStr)
      if (!log) return false
      return log.leave_type || Number(log.hours_worked) > 0
    }
    const previousWorkday = (dateStr: string) => {
      let d = new Date(dateStr + 'T00:00:00')
      d.setDate(d.getDate() - 1)
      // Sunday is the usual rest day — step back one more to the last actual workday
      if (d.getDay() === 0) d.setDate(d.getDate() - 1)
      return d.toISOString().slice(0, 10)
    }
    holidays
      .filter(h => h.type === 'regular' && h.date >= periodStart && h.date <= periodEnd && !loggedDates.has(h.date))
      .forEach(h => {
        if (wasPresentOrOnLeave(previousWorkday(h.date))) {
          regHolidayDays += 1
          regHolidayPay += rateOn(emp, h.date) * 1
        }
      })
  }

  const grossPay = regularPay + otPay + nightDiffPayTotal + sundayPay + regHolidayPay + specHolidayPay + leavePay

  return {
    regularDays: round2(regularDays), regularPay: round2(regularPay),
    otHours: round2(otHours), otPay: round2(otPay),
    sundayDays: round2(sundayDays), sundayPay: round2(sundayPay),
    nightDiffHours: round2(nightDiffHoursTotal), nightDiffPay: round2(nightDiffPayTotal),
    regHolidayDays, regHolidayPay: round2(regHolidayPay),
    specHolidayDays, specHolidayPay: round2(specHolidayPay),
    leaveDays, leavePay: round2(leavePay), leaveDates: leaveDatesOut,
    grossPay: round2(grossPay),
    flaggedDays,
    // Only meaningful when the rate actually changed inside the period (2+ rates)
    rateBreakdown: Array.from(segMap.values()).sort((a, b) => a.from.localeCompare(b.from))
      .map(g => ({ from: g.from, to: g.to, days: round2(g.days), rate: g.rate, amount: round2(g.amount) })),
  }
}
function round2(n: number) { return Math.round(n * 100) / 100 }

// SSS's Monthly Salary Credit is based on stable REGULAR compensation, not a
// gross figure that swings with however much OT or holiday premium happened
// in one specific cutoff. So this looks up the bracket using the employee's
// base monthly-equivalent rate (daily rate × 26), never the cutoff's actual
// gross pay — that keeps the deduction consistent every period regardless of
// how much overtime someone worked.
function lookupSSS(emp: any, brackets: any[]): number {
  if (emp?.sss_exempt) return 0
  const monthlyEquiv = Number(emp?.rate || 0) * 26
  const b = brackets.find(x => monthlyEquiv >= Number(x.salary_from) && (x.salary_to == null || monthlyEquiv <= Number(x.salary_to)))
  return b ? round2(Number(b.ee_contribution) / 2) : 0
}
// Flat ₱125/cutoff, doubled to ₱250 for employees who opted in, or ₱0 for
// employees marked exempt.
function lookupPhilHealth(emp: any, settings: any[]): number {
  if (emp?.philhealth_exempt) return 0
  const s = settings.find(x => x.key === 'philhealth')
  const base = s?.flat_amount != null ? Number(s.flat_amount) : 125
  return emp?.philhealth_doubled ? base * 2 : base
}
// Flat ₱100/cutoff, doubled to ₱200 for employees who opted in, or ₱0 for
// employees marked exempt (some don't pay Pag-IBIG at all).
function lookupPagIbig(emp: any, settings: any[]): number {
  if (emp?.pagibig_exempt) return 0
  const s = settings.find(x => x.key === 'pagibig')
  const base = s?.flat_amount != null ? Number(s.flat_amount) : 100
  return emp?.pagibig_doubled ? base * 2 : base
}

// ── payslip & attendance-sheet printers — match GEMMN's PAYSLIP sheet exactly ──
// Builds one payslip block's inner HTML (reused by both single-print and the
// 4-per-page batch print, so the two never visually drift apart).
const OFFICIAL_HEADER_URI = 'data:image/png;base64,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'

function payslipBlockHtml(emp:any, rec:any, loanBreakdown:{sss:number,pagibig:number,other:number}){
  const gross = calcGross(emp, rec)
  const totalDed = Number(rec.tax||0)+Number(rec.sss||0)+loanBreakdown.sss+Number(rec.pagibig||0)+loanBreakdown.pagibig+Number(rec.philhealth||0)+Number(rec.company_deduction||0)+Number(rec.other_deductions||0)+loanBreakdown.other+Number(rec.cash_advance_deduction||0)
  const net = gross+Number(rec.allowance||0)-totalDed
  const totalWorkingDays = round2(Number(rec.days_worked||0)+Number(rec.regular_holiday_days||0)+Number(rec.special_holiday_days||0)+Number(rec.sunday_days||0))
  const dailyRate = emp.employment_type==='Salaried'?Number(emp.rate)/26:Number(emp.rate)
  // Use the real stored per-component pay (matches calcGross's own preference
  // for the precise saved value) rather than re-deriving from days×rate,
  // which is what caused this to silently drift from the on-screen figures.
  const regularEarnings = emp.employment_type==='Salaried' ? Number(emp.rate)/2 : (rec.regular_pay!=null ? Number(rec.regular_pay) : Number(rec.days_worked||0)*dailyRate)
  const otEarnings = rec.overtime_pay!=null ? Number(rec.overtime_pay) : Number(rec.overtime_hours||0)*(dailyRate/8*1.25)

  return `
  <div class="slip">
    <div class="slip-hd"><img src="${OFFICIAL_HEADER_URI}" class="letterhead"/><span class="co">Salary Slip</span></div>
    <table class="info">
      <tr><td class="k">Employee ID</td><td>${emp.id}</td><td class="k">Payroll Period</td><td>${rec.period}</td></tr>
      <tr><td class="k">Employee Name</td><td>${emp.name}</td><td class="k">Total Working Days</td><td>${totalWorkingDays}</td></tr>
      <tr><td class="k">Department</td><td>${emp.department||''}</td><td class="k">Leave Taken</td><td>${rec.leave_days||0}</td></tr>
      <tr><td class="k">Rate/Day</td><td>${(rec.rate_breakdown?.length||0)>1 ? rec.rate_breakdown.map((g:any)=>fmt(g.rate)).join(' → ') : fmt(dailyRate)}</td><td class="k">Remaining Leave</td><td>${rec.remaining_leave??'—'}</td></tr>
    </table>
    <table class="earn-ded">
      <thead><tr><th colspan="3">Earnings</th><th colspan="2">Deductions</th></tr>
      <tr><th>Type</th><th>Days/Hrs</th><th>Amount</th><th>Type</th><th>Amount</th></tr></thead>
      <tbody>
        ${(rec.rate_breakdown?.length||0)>1
          ? rec.rate_breakdown.map((g:any,i:number)=>`<tr><td>Regular ${g.from.slice(5)} – ${g.to.slice(5)} @ ${fmt(g.rate)}</td><td>${g.days}</td><td>${fmt(g.amount)}</td>${i===0?`<td>Withholding Tax</td><td>${fmt(rec.tax||0)}</td>`:'<td></td><td></td>'}</tr>`).join('')
          : `<tr><td>Regular</td><td>${rec.days_worked||0}</td><td>${fmt(regularEarnings)}</td><td>Withholding Tax</td><td>${fmt(rec.tax||0)}</td></tr>`}
        <tr><td>Overtime</td><td>${rec.overtime_hours||0}</td><td>${fmt(otEarnings)}</td><td>SSS</td><td>${fmt(rec.sss||0)}</td></tr>
        <tr><td>Sunday</td><td>${rec.sunday_days||0}</td><td>${fmt(rec.sunday_pay||0)}</td><td>SSS Salary Loan</td><td>${fmt(loanBreakdown.sss)}</td></tr>
        <tr><td>Night Differential</td><td>${rec.night_diff_hours||0}</td><td>${fmt(rec.night_diff_pay||0)}</td><td>Pag-Ibig</td><td>${fmt(rec.pagibig||0)}</td></tr>
        <tr><td>VL/SL</td><td>${rec.leave_days||0}</td><td>${fmt(rec.leave_pay||0)}</td><td>Pag-Ibig Loan</td><td>${fmt(loanBreakdown.pagibig)}</td></tr>
        <tr><td>Holidays (Regular)</td><td>${rec.regular_holiday_days||0}</td><td>${fmt(rec.regular_holiday_pay||0)}</td><td>Phil. Health</td><td>${fmt(rec.philhealth||0)}</td></tr>
        <tr><td>Special Holiday</td><td>${rec.special_holiday_days||0}</td><td>${fmt(rec.special_holiday_pay||0)}</td><td>Other Deductions</td><td>${fmt(Number(rec.other_deductions||0)+loanBreakdown.other+Number(rec.cash_advance_deduction||0))}</td></tr>
        <tr class="tot"><td colspan="2">Gross Income</td><td>${fmt(gross+Number(rec.allowance||0))}</td><td>Total Deduction</td><td>${fmt(totalDed)}</td></tr>
      </tbody>
    </table>
    <div class="net-row"><span>NET SALARY</span><span>${fmt(net)}</span></div>
    <div class="sig-row"><div class="sig-line">Signature of Employee</div></div>
  </div>`
}
const payslipCss = `
  @page { size: auto; margin: 8mm; }
  *{margin:0;padding:0;box-sizing:border-box;font-family:Arial,sans-serif}
  body{padding:8px;color:#0d1f14}
  .slip{border:1.5px solid #0d1f14;border-radius:6px;padding:10px;margin-bottom:10px;page-break-inside:avoid}
  .slip-hd{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #0d1f14;padding-bottom:4px;margin-bottom:6px}
  .slip-hd .letterhead{width:170px;height:auto}
  .slip-hd .co{font-size:10px;font-weight:800;letter-spacing:1px;color:#0d1f14}
  table.info{width:100%;border-collapse:collapse;font-size:9px;margin-bottom:6px}
  table.info td{padding:2px 5px;border:1px solid #e8ede9}
  table.info td.k{font-weight:800;background:#f4f7f5;width:18%}
  table.earn-ded{width:100%;border-collapse:collapse;font-size:9px;margin-bottom:6px}
  table.earn-ded th,table.earn-ded td{padding:2.5px 5px;border:1px solid #e8ede9;text-align:left}
  table.earn-ded thead tr:first-child th{background:#1a4d2e;color:#fff;font-size:8px;letter-spacing:1px;text-transform:uppercase}
  table.earn-ded thead tr:last-child th{background:#f4f7f5;font-weight:800}
  table.earn-ded tr.tot td{font-weight:900;border-top:2px solid #0d1f14}
  .net-row{display:flex;justify-content:space-between;background:#dcfce7;border:1.5px solid #39b54a;border-radius:6px;padding:6px 12px;font-weight:900;font-size:12px;color:#1a4d2e;margin-bottom:6px}
  .sig-row{display:flex;justify-content:flex-end}
  .sig-line{border-top:1.5px solid #0d1f14;padding-top:3px;font-size:8px;color:#6b7c72;width:180px;text-align:center}
  @media print{.slip{page-break-inside:avoid}}
`

async function fetchLoanBreakdown(supabase:any, payrollRecordId:string, expectedTotal?: number){
  const {data} = await supabase.from('loan_payments').select('amount, employee_loans(loan_type)').eq('payroll_record_id',payrollRecordId)
  const out = {sss:0, pagibig:0, other:0}
  ;(data||[]).forEach((p:any)=>{
    const t = p.employee_loans?.loan_type
    if(t==='SSS') out.sss += Number(p.amount)
    else if(t==='Pag-IBIG') out.pagibig += Number(p.amount)
    else out.other += Number(p.amount)
  })
  // The payroll record's own loan_deduction is the ground truth saved at
  // generation time — net pay was already computed against it. If the live
  // loan_payments rows don't fully account for that total (a failed insert,
  // a loan edited/deleted afterward, an RLS-blocked join), fold the shortfall
  // into "other" so the printed total and Net Salary always match what was
  // actually saved, instead of silently showing a lower deduction than real.
  if (expectedTotal != null) {
    const shortfall = round2(Number(expectedTotal||0) - (out.sss + out.pagibig + out.other))
    if (shortfall > 0.01) out.other += shortfall
  }
  return out
}

async function printPayslip(emp:any, rec:any, supabase:any){
  const loanBreakdown = await fetchLoanBreakdown(supabase, rec.id, rec.loan_deduction)
  const w=window.open('','_blank','width=900,height=700')
  if(!w) return
  w.document.write(`<html><head><title>Payslip – ${emp.name}</title><style>${payslipCss}</style></head><body>${payslipBlockHtml(emp,rec,loanBreakdown)}</body></html>`)
  w.document.close(); w.focus(); setTimeout(()=>{w.print()},400)
}

// Attendance sheet: same breakdown, for wet-signature before cash is released.
// No digital signature capture — a blank line is printed for physical signing.
async function printAttendanceSheet(emp:any, rec:any, supabase:any){
  const {data:logs} = await supabase.from('attendance_logs').select('*').eq('employee_id',emp.id)
  const [pStart,pEnd] = (rec.period||'').split(' to ')
  const rangeLogs = (logs||[]).filter((l:any)=> (!pStart||l.date>=pStart) && (!pEnd||l.date<=pEnd)).sort((a:any,b:any)=>a.date.localeCompare(b.date))
  const w=window.open('','_blank','width=900,height=700')
  if(!w) return
  const rows = rangeLogs.map((l:any)=>`<tr><td>${l.date}</td><td>${l.time_in||'—'}</td><td>${l.time_out||'—'}</td><td>${l.hours_worked??0}</td><td>${l.source==='biometric_import'?'Biometric':'Manual'}</td></tr>`).join('')
  w.document.write(`<html><head><title>Attendance Sheet – ${emp.name}</title><style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:Arial,sans-serif}
    body{padding:24px;color:#0d1f14}
    h1{font-size:15px;font-weight:900;border-bottom:2px solid #0d1f14;padding-bottom:8px;margin-bottom:12px}
    .meta{font-size:11px;color:#6b7c72;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px}
    th,td{border:1px solid #e8ede9;padding:6px 10px;text-align:left}
    th{background:#1a4d2e;color:#fff;font-size:9px;letter-spacing:1px;text-transform:uppercase}
    tfoot td{font-weight:900;border-top:2px solid #0d1f14}
    .sig-block{display:flex;justify-content:space-between;margin-top:40px}
    .sig-line{border-top:1.5px solid #0d1f14;padding-top:4px;font-size:10px;color:#6b7c72;width:220px;text-align:center}
  </style></head><body>
    <h1>ATTENDANCE SHEET — For Signature Prior to Release</h1>
    <div class="meta">${emp.name} (${emp.id}) — ${emp.department||''} · Period: ${rec.period}</div>
    <table><thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Hours</th><th>Source</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">Total Hours</td><td>${rangeLogs.reduce((s:number,l:any)=>s+(Number(l.hours_worked)||0),0)}</td><td></td></tr></tfoot></table>
    <div class="sig-block">
      <div class="sig-line">Employee Signature & Date</div>
      <div class="sig-line">Released By & Date</div>
    </div>
  </body></html>`)
  w.document.close(); w.focus(); setTimeout(()=>{w.print()},400)
}

// Consolidated register — every employee's payroll for one period on a single
// printable sheet with a signature column, for wet-signing at cash release.
// Mirrors the Excel "CURRENT PAYROLL PERIOD" master sheet.
function printPayrollRegister(records: any[], period: string) {
  const w = window.open('', '_blank', 'width=1200,height=800')
  if (!w) return
  const rows = records.map((r: any) => {
    const emp = r.employees
    const gross = calcGross(emp, r) + Number(r.allowance || 0)
    const net = calcNet(emp, r)
    const otherDed = Number(r.other_deductions || 0)
    return `<tr>
      <td>${emp?.id || ''}</td>
      <td class="name">${emp?.name || ''}</td>
      <td>${r.days_worked ?? 0}</td>
      <td>${r.overtime_hours ?? 0}</td>
      <td>${r.sunday_days ?? 0}</td>
      <td>${r.leave_days ?? 0}</td>
      <td>${r.regular_holiday_days ?? 0}</td>
      <td>${r.special_holiday_days ?? 0}</td>
      <td class="num">${fmt(gross)}</td>
      <td class="num">${fmt(r.tax || 0)}</td>
      <td class="num">${fmt(r.sss || 0)}</td>
      <td class="num">${fmt(r.pagibig || 0)}</td>
      <td class="num">${fmt(r.philhealth || 0)}</td>
      <td class="num">${fmt(otherDed)}</td>
      <td class="num">${fmt(r.loan_deduction || 0)}</td>
      <td class="num">${fmt(r.cash_advance_deduction || 0)}</td>
      <td class="num net">${fmt(net)}</td>
      <td class="sigcell"></td>
    </tr>`
  }).join('')
  const totalNet = records.reduce((s, r) => s + calcNet(r.employees, r), 0)
  w.document.write(`<html><head><title>Payroll Register — ${period}</title><style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:Arial,sans-serif}
    @page{size:A4 landscape;margin:10mm}
    body{padding:16px;color:#0d1f14}
    .letterhead{width:300px;margin-bottom:10px}
    h1{font-size:15px;font-weight:900;border-bottom:2px solid #0d1f14;padding-bottom:6px;margin-bottom:4px}
    .meta{font-size:11px;color:#6b7c72;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;font-size:9px}
    th,td{border:1px solid #ccc;padding:4px 5px;text-align:right;white-space:nowrap}
    th{background:#1a4d2e;color:#fff;font-size:8px;letter-spacing:0.5px;text-transform:uppercase;text-align:center}
    td.name{text-align:left;font-weight:700}
    td:first-child{text-align:left}
    td.sigcell{min-width:70px}
    tfoot td{font-weight:900;border-top:2px solid #0d1f14}
    .net{color:#1a4d2e;font-weight:900}
  </style></head><body>
    <img class="letterhead" src="${OFFICIAL_HEADER_URI}"/>
    <h1>PAYROLL REGISTER — ${period}</h1>
    <div class="meta">${records.length} employee(s) · Signature required before cash release</div>
    <table><thead><tr>
      <th>ID#</th><th>Name</th><th>Days</th><th>OT Hrs</th><th>Sun.</th><th>VL/SL</th><th>Reg.Hol</th><th>Spec.Hol</th>
      <th>Gross</th><th>W/Tax</th><th>SSS</th><th>Pag-IBIG</th><th>PhilHealth</th><th>Other Ded.</th><th>Loan</th><th>Cash Adv.</th><th>Net Salary</th><th>Signature</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="16">TOTAL NET PAYOUT</td><td class="num net">${fmt(totalNet)}</td><td></td></tr></tfoot>
    </table>
  </body></html>`)
  w.document.close(); w.focus(); setTimeout(()=>{w.print()},400)
}

const inputStyle:React.CSSProperties={width:'100%',padding:'9px 12px',border:'1.5px solid #e8ede9',borderRadius:6,fontSize:13,fontFamily:'inherit',color:'#0d1f14',background:'#fafcfb',boxSizing:'border-box',outline:'none'}

function Field({label,type='text',value,onChange,options,placeholder,span,disabled}:any){
  const isNum = type==='number'
  const isTxt = type==='text'
  const lbl = (label||'').toString().toLowerCase()
  const skipUpper = lbl.includes('note')||lbl.includes('remark')||lbl.includes('description')||lbl.includes('email')||lbl.includes('password')
  const handleChange = (e:any)=>{
    let v:any = e.target.value
    if(isTxt && !skipUpper) v = v.toUpperCase()
    onChange(v)
  }
  const handleFocus = (e:any)=>{ e.target.select() }
  const handleBlur = (e:any)=>{
    const v = e.target.value
    if(isNum && v.trim()==='') onChange('0')
    else if(isTxt && v.trim()==='') onChange('N/A')
  }
  return(
    <div style={{marginBottom:14,gridColumn:span?'1/-1':'auto'}}>
      <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>{label}</label>
      {type==='select'
        ?<select value={value} onChange={e=>onChange(e.target.value)} style={inputStyle} disabled={disabled}><option value="">Select…</option>{options.map((o:any)=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}</select>
        :<input type={type} value={value} onChange={handleChange} onFocus={(isNum||isTxt)?handleFocus:undefined} onBlur={(isNum||isTxt)?handleBlur:undefined} style={{...inputStyle, background: disabled?'#f4f7f5':inputStyle.background}} disabled={disabled}/>}
    </div>
  )
}

function Badge({label}:{label:string}){
  const colors:Record<string,string>={Paid:C.blue,Pending:C.amber,Open:C.amber,Closed:C.accent}
  const c=colors[label]||C.gray
  return <span style={{padding:'3px 10px',borderRadius:20,background:`${c}22`,color:c,fontSize:10,fontWeight:800,border:`1px solid ${c}44`,whiteSpace:'nowrap'}}>{label}</span>
}

// ── BLANK forms ───────────────────────────────────────────────────────────────
const BLANK_EMP={name:'',role:'',department:'',employment_type:'Salaried',employment_status:'Regular',rate:0,contact:'',status:'Active',sss_exempt:false,philhealth_exempt:false,philhealth_doubled:false,pagibig_doubled:false,pagibig_exempt:false,ot_exempt:false,full_day_pay:false,hire_date:''}
const BLANK_REC={employee_id:'',period:'',days_worked:22,regular_pay:0,overtime_hours:0,overtime_pay:0,sunday_days:0,sunday_pay:0,night_diff_hours:0,night_diff_pay:0,regular_holiday_days:0,regular_holiday_pay:0,special_holiday_days:0,special_holiday_pay:0,allowance:0,sss:0,philhealth:0,pagibig:0,tax:0,status:'Pending',cash_advance_deduction:0,deduction_lines:[],leave_dates:[]}
const BLANK_CA={id:'',employee_id:'',date_issued:new Date().toISOString().slice(0,10),amount:0,notes:''}
const DEPTS=['Management','Engineering','Operations','Quality','Admin']
const TYPES=['Daily','Salaried','Part-Time']
const DEDUCTION_PRESETS=['Sticker Fee','Uniform','Tools/Equipment','Cash Shortage','Damage/Breakage','Other (specify)']

// ════════════════════════════════════════════════════════════════════════════
// Defined at module scope (not inside the component) so React sees the same
// function identity across every render. Defining this inside the component
// body — as it was before — recreates it fresh on every keystroke into any
// input, which makes React treat it as a brand-new component type and
// remount the whole modal, wiping focus after every single character typed.
function ModalShell({title,onClose,children,accentColor}:any){
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:C.white,borderRadius:14,width:'100%',maxWidth:620,maxHeight:'92vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
        <div style={{background:`linear-gradient(135deg,${C.dark},${accentColor||C.darkGreen})`,padding:'18px 24px',borderRadius:'14px 14px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div><div style={{color:C.accent,fontSize:10,fontWeight:700,letterSpacing:2}}>GEMMN IRFE</div>
          <div style={{color:C.white,fontSize:16,fontWeight:900,letterSpacing:1.5,textTransform:'uppercase'}}>{title}</div></div>
          <button onClick={onClose} style={{background:'rgba(255,255,255,0.1)',border:'none',color:C.white,width:32,height:32,borderRadius:'50%',cursor:'pointer',fontSize:16}}>✕</button>
        </div>
        <div style={{padding:24}}>{children}</div>
      </div>
    </div>
  )
}

export default function PayrollPage(){
  const supabase=createClient()
  const [records,setRecords]=useState<any[]>([])
  const [employees,setEmployees]=useState<any[]>([])
  const [cashAdvances,setCashAdvances]=useState<any[]>([])
  const [caStatusFilter,setCaStatusFilter]=useState<'all'|'open'|'closed'>('all')
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const canEdit = usePermissions().canEditModule('payroll')
  const [error,setError]=useState('')

  // modal states
  const [showPayslip,setShowPayslip]=useState<{emp:any,rec:any}|null>(null)
  const [showRecModal,setShowRecModal]=useState(false)
  const [showEmpModal,setShowEmpModal]=useState(false)
  const [showCAModal,setShowCAModal]=useState(false)
  const [showPayModal,setShowPayModal]=useState<any>(null) // the cash advance being paid
  const [showLedger,setShowLedger]=useState<any>(null) // the cash advance whose ledger is shown
  const [ledgerRows,setLedgerRows]=useState<any[]>([])
  const [selectedRec,setSelectedRec]=useState<any>(null)
  const [selectedEmp,setSelectedEmp]=useState<any>(null)
  const [recForm,setRecForm]=useState<any>(BLANK_REC)
  const [recLeaveDateInput,setRecLeaveDateInput]=useState('')
  const [empForm,setEmpForm]=useState<any>(BLANK_EMP)
  const [rateRows,setRateRows]=useState<{effective_from:string,rate:string}[]>([])
  const [monthlyCalc,setMonthlyCalc]=useState(0)
  const [monthlyDivisor,setMonthlyDivisor]=useState(26)
  const [caForm,setCaForm]=useState<any>(BLANK_CA)
  const [caIdAvailable,setCaIdAvailable]=useState(true)
  const [payForm,setPayForm]=useState({amount:0,date:new Date().toISOString().slice(0,10),method:'Cash Payment',notes:''})
  const [caAllocations,setCaAllocations]=useState<Record<string,number>>({}) // { cash_advance_id: amount } for the payroll modal
  const [tab,setTab]=useState<'payroll'|'cash-advances'|'employees'|'attendance'|'holidays'|'contributions'|'loans'|'leave-tracker'|'payroll-yearly'|'thirteenth-month'>('payroll')
  const [splitView,setSplitView]=useState(false)

  // ── Pagination — one independent page counter per list, since the
  // historical-data migration made several of these too long to scroll
  // comfortably. Each list sorts most-recent-first by its own business
  // date before slicing, since bulk-imported rows can share near-identical
  // created_at timestamps.
  const PAGE_SIZE = 50
  const [recordsPage,setRecordsPage]=useState(1)
  const [caPage,setCaPage]=useState(1)
  const [employeesPage,setEmployeesPage]=useState(1)
  const [attPage,setAttPage]=useState(1)
  const [loansPage,setLoansPage]=useState(1)

  // ── Holidays ──────────────────────────────────────────────────────────────
  const [holidays,setHolidays]=useState<any[]>([])
  const [holidayForm,setHolidayForm]=useState({date:'',name:'',type:'regular'})
  const [editingHoliday,setEditingHoliday]=useState(false)
  const [showHolidayModal,setShowHolidayModal]=useState(false)

  // ── Contributions ─────────────────────────────────────────────────────────
  const [sssBrackets,setSssBrackets]=useState<any[]>([])
  const [contribSettings,setContribSettings]=useState<any[]>([])
  const [companyDeductions,setCompanyDeductions]=useState<any[]>([])
  const [newBracket,setNewBracket]=useState({salary_from:0,salary_to:'',ee_contribution:0})

  // ── Attendance import ────────────────────────────────────────────────────
  const [attendanceLogs,setAttendanceLogs]=useState<any[]>([])
  const [importRows,setImportRows]=useState<any[]>([])
  const [importHeaders,setImportHeaders]=useState<string[]>([])
  const [colMap,setColMap]=useState({employee:'',date:'',timeIn:'',timeOut:''})
  const [importStep,setImportStep]=useState<'upload'|'map'|'preview'>('upload')
  const [importMode,setImportMode]=useState<'generic'|'biometric'>('generic')
  const [biometricParsed,setBiometricParsed]=useState<{biometricId:string,name:string,dept:string,days:{date:string,punches:string[]}[]}[]>([])
  const [biometricMapping,setBiometricMapping]=useState<Record<string,string>>({})
  const [attFrom,setAttFrom]=useState(new Date(Date.now()-13*86400000).toISOString().slice(0,10))
  const [attEmpFilter,setAttEmpFilter]=useState('')
  const [attStatusFilter,setAttStatusFilter]=useState<'all'|'review'|'missing'>('all')
  const [leaveYear,setLeaveYear]=useState(new Date().getFullYear())
  const [leaveRecords,setLeaveRecords]=useState<any[]>([])
  const fetchLeaveRecords = useCallback(async()=>{
    const {data} = await supabase.from('attendance_logs').select('*, employees(name)')
      .not('leave_type','is',null)
      .neq('leave_type','')
      .gte('date',`${leaveYear}-01-01`).lte('date',`${leaveYear}-12-31`)
      .order('date')
    setLeaveRecords(data||[])
  },[supabase,leaveYear])
  useEffect(()=>{ if(tab==='leave-tracker'||tab==='employees') fetchLeaveRecords() },[tab,fetchLeaveRecords])
  const [reportYear,setReportYear]=useState(new Date().getFullYear())
  const [yearlyPayroll,setYearlyPayroll]=useState<any[]>([])
  const fetchYearlyPayroll = useCallback(async()=>{
    const {data} = await fetchAllPages<any>((from, to) => supabase.from('payroll').select('*, employees(name,rate,employment_type), payroll_runs(period_start,period_end)')
      .order('created_at').range(from, to))
    // Filter/group by the REAL pay period (via payroll_runs), not created_at —
    // a record generated late shouldn't get misattributed to the wrong year/month.
    const inYear = (data||[]).filter((r:any)=>(r.payroll_runs?.period_start||'').startsWith(String(reportYear)))
    setYearlyPayroll(inYear)
  },[supabase,reportYear])
  useEffect(()=>{ if(tab==='payroll-yearly'||tab==='thirteenth-month') fetchYearlyPayroll() },[tab,fetchYearlyPayroll])
  const [thirteenthOverrides,setThirteenthOverrides]=useState<any[]>([])
  const fetchThirteenthOverrides = useCallback(async()=>{
    const {data} = await supabase.from('thirteenth_month_overrides').select('*').eq('year',reportYear)
    setThirteenthOverrides(data||[])
  },[supabase,reportYear])
  useEffect(()=>{ if(tab==='thirteenth-month') fetchThirteenthOverrides() },[tab,fetchThirteenthOverrides])
  const saveThirteenthOverride = async (empId:string, amount:number) => {
    setThirteenthOverrides(p=>{
      const exists = p.some(o=>o.employee_id===empId)
      return exists ? p.map(o=>o.employee_id===empId?{...o,amount}:o) : [...p,{employee_id:empId,year:reportYear,amount}]
    })
    const {error} = await supabase.from('thirteenth_month_overrides').upsert({employee_id:empId,year:reportYear,amount},{onConflict:'employee_id,year'})
    if(error) alert(error.message)
  }
  const [attTo,setAttTo]=useState(new Date().toISOString().slice(0,10))
  const [attSaving,setAttSaving]=useState(false)
  const [showManualAtt,setShowManualAtt]=useState(false)
  const [otMode,setOtMode]=useState<'duration'|'time'>('duration')
  const [otHoursIn,setOtHoursIn]=useState(0)
  const [otMinsIn,setOtMinsIn]=useState(0)
  const [otUntilTime,setOtUntilTime]=useState('')
  const [manualAtt,setManualAtt]=useState({employee_id:'',date:new Date().toISOString().slice(0,10),time_in:'08:00',time_out:'17:00',break_minutes:60,straight_time:false,leave_type:'',manual_ot_minutes:0})
  const [manualAttMulti,setManualAttMulti]=useState<string[]>([])
  const [editingAttId,setEditingAttId]=useState<string|null>(null)

  const fetchHolidays=useCallback(async()=>{
    const {data}=await supabase.from('holidays').select('*').order('date')
    if(data) setHolidays(data)
  },[])
  const [contribFetchError,setContribFetchError]=useState('')
  const fetchContributions=useCallback(async()=>{
    const [{data:brk,error:e1},{data:cs,error:e2},{data:cd,error:e3}]=await Promise.all([
      supabase.from('sss_brackets').select('*').order('salary_from'),
      supabase.from('contribution_settings').select('*'),
      supabase.from('company_deductions').select('*'),
    ])
    if(brk) setSssBrackets(brk)
    if(cs) setContribSettings(cs)
    if(cd) setCompanyDeductions(cd)
    const firstError=e1||e2||e3
    setContribFetchError(firstError?firstError.message:'')
  },[])
  const fetchAttendance=useCallback(async()=>{
    const {data}=await supabase.from('attendance_logs').select('*, employees(name)').gte('date',attFrom).lte('date',attTo).order('date',{ascending:false})
    if(data) setAttendanceLogs(data)
  },[attFrom,attTo])

  useEffect(()=>{ fetchHolidays(); fetchContributions() },[fetchHolidays,fetchContributions])
  useEffect(()=>{ fetchAttendance() },[fetchAttendance])

  // ── Holiday CRUD ──────────────────────────────────────────────────────────
  const saveHoliday=async()=>{
    if(!holidayForm.date||!holidayForm.name.trim()) return
    const {error}=await supabase.from('holidays').upsert(holidayForm,{onConflict:'date'})
    if(!error){ await fetchHolidays(); setShowHolidayModal(false); setHolidayForm({date:'',name:'',type:'regular'}); setEditingHoliday(false) } else alert(error.message)
  }
  const openEditHoliday=(h:any)=>{
    setHolidayForm({date:h.date,name:h.name,type:h.type})
    setEditingHoliday(true)
    setShowHolidayModal(true)
  }
  const deleteHoliday=async(id:string)=>{
    if(!window.confirm('Remove this holiday from the calendar?')) return
    await supabase.from('holidays').delete().eq('id',id)
    await fetchHolidays()
  }

  // ── Contribution CRUD ─────────────────────────────────────────────────────
  const addBracket=async()=>{
    const {error}=await supabase.from('sss_brackets').insert({...newBracket, salary_to: newBracket.salary_to===''?null:Number(newBracket.salary_to), effective_year: new Date().getFullYear()})
    if(!error){ await fetchContributions(); setNewBracket({salary_from:0,salary_to:'',ee_contribution:0}) } else alert(`Could not add bracket: ${error.message}`)
  }
  const deleteBracket=async(id:string)=>{
    const {error}=await supabase.from('sss_brackets').delete().eq('id',id)
    if(error) alert(`Could not delete bracket: ${error.message}`)
    await fetchContributions()
  }
  const updateBracket=async(id:string, patch:any)=>{
    setSssBrackets(p=>p.map(b=>b.id===id?{...b,...patch}:b))
    const {error}=await supabase.from('sss_brackets').update(patch).eq('id',id)
    if(error) alert(`Could not save bracket: ${error.message}`)
  }
  const updateContribSetting=async(key:string,patch:any)=>{
    setContribSettings(p=>p.map(c=>c.key===key?{...c,...patch}:c))
    const {error}=await supabase.from('contribution_settings').update(patch).eq('key',key)
    if(error) alert(`Could not save setting: ${error.message}`)
  }
  const updateCompanyDeduction=async(key:string,amount:number)=>{
    setCompanyDeductions(p=>p.map(c=>c.key===key?{...c,amount}:c))
    const {error}=await supabase.from('company_deductions').update({amount}).eq('key',key)
    if(error) alert(`Could not save deduction: ${error.message}`)
  }
  const [newDeduction,setNewDeduction]=useState({key:'',label:'',amount:0})
  const addCompanyDeduction=async()=>{
    if(!newDeduction.key.trim()||!newDeduction.label.trim()) return
    const {error}=await supabase.from('company_deductions').insert(newDeduction)
    if(!error){ await fetchContributions(); setNewDeduction({key:'',label:'',amount:0}) } else alert(`Could not add deduction: ${error.message}`)
  }
  // Self-healing: if the original SQL seed for contribution_settings/company_deductions
  // was never run (or ran against a different DB), this lets the page bootstrap its
  // own defaults instead of staying permanently blank with no way to add them.
  const initContribDefaults=async()=>{
    const {error:e1}=await supabase.from('contribution_settings').upsert([
      {key:'philhealth', rate_pct:5, employee_share_pct:50, floor_salary:10000, ceiling_salary:100000},
      {key:'pagibig', rate_pct:2, employee_share_pct:50, flat_min:100, flat_max:200},
    ])
    if(e1) alert(`Could not initialize defaults:\n${e1.message}\n\nThis usually means the contribution_settings table doesn't exist yet in Supabase — check that the Payroll SQL migration was actually run.`)
    await fetchContributions()
  }

  // ── Attendance import ─────────────────────────────────────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const XLSX = await import('xlsx')
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })

    // The biometric device's own export has a distinctly-named sheet —
    // route to the specialized block parser instead of the generic mapper.
    const bioSheetName = wb.SheetNames.find(n => /attend.*logs?/i.test(n))
    if (bioSheetName) {
      const ws = wb.Sheets[bioSheetName]
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      const parsed = parseBiometricBlocks(rows)
      if (parsed.length > 0) {
        setImportMode('biometric')
        setBiometricParsed(parsed)
        // Pre-fill mapping from any previously-confirmed biometric IDs, then
        // best-guess anything new by name similarity against active employees.
        const { data: savedMap } = await supabase.from('biometric_employee_map').select('*')
        const mapping: Record<string, string> = {}
        parsed.forEach(p => {
          const saved = savedMap?.find((m: any) => m.biometric_id === p.biometricId)
          if (saved) { mapping[p.biometricId] = saved.employee_id; return }
          let best: any = null, bestScore = 0
          employees.forEach(emp => {
            const score = nameSimilarity(p.name, emp.name)
            if (score > bestScore) { bestScore = score; best = emp }
          })
          if (best && bestScore >= 0.4) mapping[p.biometricId] = best.id
        })
        setBiometricMapping(mapping)
        setImportStep('map')
        return
      }
    }

    // Fallback: generic flat CSV/XLSX with column headers
    setImportMode('generic')
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows: any[] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    if (!rows.length) return
    const headers = rows[0].map((h: any) => String(h).trim())
    const dataRows = rows.slice(1).filter(r => r.some((c: any) => c !== ''))
    setImportHeaders(headers)
    setImportRows(dataRows)
    const guess = (needle: string[]) => headers.find((h: string) => needle.some((n: string) => h.toLowerCase().includes(n))) || ''
    setColMap({
      employee: guess(['employee', 'id', 'emp']),
      date: guess(['date']),
      timeIn: guess(['time in', 'in', 'clock in', 'timein']),
      timeOut: guess(['time out', 'out', 'clock out', 'timeout']),
    })
    setImportStep('map')
  }

  // Flattens the biometric parse + confirmed mapping into normalized daily
  // attendance rows, applying the punch-count interpretation rule to each day.
  const normalizedBiometricRows = () => {
    const out: any[] = []
    biometricParsed.forEach(p => {
      const employee_id = biometricMapping[p.biometricId]
      if (!employee_id) return
      // Salaried employees are paid a fixed cutoff rate regardless of time
      // in/out — a day's punches (or lack of them) just mean "turned in" or
      // "absent" for them, never a flagged review.
      const isSalaried = employees.find(e=>e.id===employee_id)?.employment_type === 'Salaried'
      p.days.forEach(d => {
        if (d.punches.length === 0) return
        const interp = interpretPunches(d.punches, d.date)
        out.push({
          employee_id, date: d.date, name: p.name,
          time_in: interp.time_in, time_out: interp.time_out,
          break_minutes: interp.break_minutes, hours_worked: interp.hours_worked,
          needs_review: isSalaried ? false : interp.needs_review, raw_punches: d.punches.join(', '),
        })
      })
    })
    return out
  }

  const commitBiometricImport = async () => {
    setAttSaving(true)
    try {
      // Remember confirmed mappings for next time
      const mapRows = Object.entries(biometricMapping).map(([biometric_id, employee_id]) => {
        const p = biometricParsed.find(x => x.biometricId === biometric_id)
        return { biometric_id, employee_id, biometric_name: p?.name || '' }
      })
      if (mapRows.length) await supabase.from('biometric_employee_map').upsert(mapRows)

      const rawRows = normalizedBiometricRows().map(r => ({
        employee_id: r.employee_id, date: r.date, time_in: r.time_in, time_out: r.time_out,
        break_minutes: r.break_minutes, hours_worked: r.hours_worked,
        needs_review: r.needs_review, raw_punches: r.raw_punches, source: 'biometric_import',
      }))
      // A single upsert() call can't apply ON CONFLICT DO UPDATE to the same
      // row twice — de-dupe by employee_id+date first (keeps the last one
      // seen, which is fine since duplicates here are almost always the
      // same punches read twice from an overlapping block in the source file).
      const seen = new Map<string, any>()
      rawRows.forEach(r => seen.set(`${r.employee_id}|${r.date}`, r))
      const rows = Array.from(seen.values())
      const { error } = await supabase.from('attendance_logs').upsert(rows, { onConflict: 'employee_id,date' })
      if (error) throw error
      await fetchAttendance()
      const flagged = rows.filter(r => r.needs_review).length
      setImportStep('upload'); setImportMode('generic'); setBiometricParsed([]); setBiometricMapping({})
      alert(`Imported ${rows.length} attendance record${rows.length === 1 ? '' : 's'}.${flagged ? `\n\n⚠ ${flagged} day${flagged === 1 ? '' : 's'} flagged for review — irregular punch pattern detected.` : ''}`)
    } catch (err: any) {
      alert(err.message)
    }
    setAttSaving(false)
  }

  const normalizedImportRows = () => {
    if (!colMap.employee || !colMap.date) return []
    const idx = (name: string) => importHeaders.indexOf(name)
    return importRows.map(r => {
      const empRaw = r[idx(colMap.employee)]
      const dateRaw = r[idx(colMap.date)]
      const timeInRaw = colMap.timeIn ? r[idx(colMap.timeIn)] : ''
      const timeOutRaw = colMap.timeOut ? r[idx(colMap.timeOut)] : ''
      return { employee_id: String(empRaw).trim(), date: normalizeDate(dateRaw), time_in: normalizeTime(timeInRaw), time_out: normalizeTime(timeOutRaw) }
    }).filter(r => r.employee_id && r.date)
  }

  const commitImport = async () => {
    setAttSaving(true)
    const rows = normalizedImportRows().map(r => {
      const tin = clampToShiftStart(r.time_in, r.date)
      const isSalaried = employees.find(e=>e.id===r.employee_id)?.employment_type === 'Salaried'
      return {
        employee_id: r.employee_id, date: r.date, time_in: tin || null, time_out: r.time_out || null,
        hours_worked: computeHours(tin, r.time_out, 60), source: 'biometric_import',
        needs_review: isSalaried ? false : hasMeaningfulOvertime(r.time_out, r.date),
      }
    })
    const { error } = await supabase.from('attendance_logs').upsert(rows, { onConflict: 'employee_id,date' })
    if (!error) {
      await fetchAttendance()
      setImportStep('upload'); setImportRows([]); setImportHeaders([])
      alert(`Imported ${rows.length} attendance record${rows.length===1?'':'s'}.`)
    } else {
      alert(error.message)
    }
    setAttSaving(false)
  }

  // "Straight time" means the shift ran continuously with no lunch break
  // deducted (e.g. a client visit) — the hours past 8 must still be counted
  // as OT, not just folded invisibly into a longer "regular" span. Whenever
  // straight time is on and the times change, re-derive the suggested OT
  // from the actual span worked (clerk can still override it below).
  const applyStraightTimeOT = (next: any) => {
    if (next.straight_time && next.time_in && next.time_out) {
      const totalHrs = computeHours(next.time_in, next.time_out, 0)
      const otMin = Math.max(0, Math.round((totalHrs - 8) * 60))
      next.manual_ot_minutes = otMin
      setOtMode('duration'); setOtHoursIn(Math.floor(otMin / 60)); setOtMinsIn(otMin % 60)
    }
    return next
  }

  const saveManualAtt = async () => {
    setAttSaving(true)
    const { straight_time, employee_id, ...payloadRest } = manualAtt
    const isLeave = !!manualAtt.leave_type
    const common = {
      ...payloadRest,
      leave_type: manualAtt.leave_type || null,
      time_in: isLeave ? null : manualAtt.time_in,
      time_out: isLeave ? null : manualAtt.time_out,
      hours_worked: isLeave ? 8 : computeHours(manualAtt.time_in, manualAtt.time_out, manualAtt.break_minutes),
      source: 'manual', needs_review: false,
    }
    // Editing an existing record is always single-employee. Adding fresh can
    // target multiple employees at once with the same date/time/leave/OT.
    const targetIds = editingAttId ? [employee_id] : manualAttMulti
    if (targetIds.length === 0) { setAttSaving(false); return }
    const rows = targetIds.map(id => ({ ...common, employee_id: id }))
    const { error } = await supabase.from('attendance_logs').upsert(rows, { onConflict: 'employee_id,date' })
    if (!error) {
      await fetchAttendance(); setShowManualAtt(false); setEditingAttId(null); setManualAttMulti([])
      if (rows.length > 1) alert(`Saved for ${rows.length} employees.`)
    } else alert(error.message)
    setAttSaving(false)
  }

  const openEditAtt = (row: any) => {
    setManualAtt({
      employee_id: row.employee_id, date: row.date,
      time_in: row.time_in || '08:00', time_out: row.time_out || '17:00',
      break_minutes: row.break_minutes ?? 60, straight_time: (row.break_minutes ?? 60) === 0,
      leave_type: row.leave_type || '',
      manual_ot_minutes: row.manual_ot_minutes || 0,
    })
    const existingOt = row.manual_ot_minutes || 0
    setOtMode('duration'); setOtHoursIn(Math.floor(existingOt/60)); setOtMinsIn(existingOt%60); setOtUntilTime('')
    setEditingAttId(row.id)
    setShowManualAtt(true)
  }

  const deleteAttendance = async (id: string) => {
    if (!window.confirm('Delete this attendance record?')) return
    await supabase.from('attendance_logs').delete().eq('id', id)
    await fetchAttendance()
  }

  // Resolving a flagged (needs_review) day used to just clear the flag with
  // no record of why — a late/irregular checkout could hide real OT that
  // never got paid. Instead, suggest the OT implied by the extra hours
  // worked past 8, let the clerk confirm or adjust it, then save that as the
  // day's manual OT before clearing the flag.
  const resolveAttendanceReview = async (a: any) => {
    const suggestedHours = Math.max(0, Number(a.hours_worked || 0) - 8)
    const input = window.prompt(
      `This day showed ${a.hours_worked || 0} hours worked (time out ${a.time_out || '—'}), suggesting ~${suggestedHours.toFixed(2)} OT hours.\n\nConfirm the OT hours to pay for this day (0 if none):`,
      suggestedHours > 0 ? suggestedHours.toFixed(2) : String(Number(a.manual_ot_minutes || 0) / 60)
    )
    if (input === null) return // cancelled — leave flagged, don't silently resolve
    const otHours = Number(input)
    if (isNaN(otHours) || otHours < 0) { alert('Enter a valid number of hours (0 or more).'); return }
    await supabase.from('attendance_logs').update({ needs_review: false, manual_ot_minutes: Math.round(otHours * 60) }).eq('id', a.id)
    await fetchAttendance()
  }

  const [attBatchMode,setAttBatchMode]=useState(false)
  const [attBatchSelected,setAttBatchSelected]=useState<Record<string,boolean>>({})
  const toggleAttBatch = (id:string) => setAttBatchSelected(p=>({...p,[id]:!p[id]}))
  const deleteAttBatch = async () => {
    const ids = Object.entries(attBatchSelected).filter(([,v])=>v).map(([k])=>k)
    if(!ids.length) return
    if(!window.confirm(`Delete ${ids.length} attendance record(s)? This cannot be undone.`)) return
    await supabase.from('attendance_logs').delete().in('id',ids)
    setAttBatchSelected({}); setAttBatchMode(false)
    await fetchAttendance()
  }


  const rf=(k:string)=>(v:any)=>setRecForm((p:any)=>({...p,[k]:v}))
  const ef=(k:string)=>(v:any)=>setEmpForm((p:any)=>({...p,[k]:v}))
  const caf=(k:string)=>(v:any)=>setCaForm((p:any)=>({...p,[k]:v}))

  const [payrollRuns,setPayrollRuns]=useState<any[]>([])
  const fetchAll=useCallback(async()=>{
    setLoading(true)
    const [{data:recs},{data:emps},{data:cas},{data:runs},{data:rateRowsAll}]=await Promise.all([
      fetchAllPages<any>((from, to) => supabase.from('payroll').select('*, employees(*)').order('created_at',{ascending:false}).range(from, to)),
      supabase.from('employees').select('*').order('name'),
      fetchAllPages<any>((from, to) => supabase.from('cash_advances').select('*, employees(*)').order('created_at',{ascending:false}).range(from, to)),
      supabase.from('payroll_runs').select('*').order('period_start',{ascending:false}),
      // Optional table (rate schedule) — if it doesn't exist yet the result is just empty
      supabase.from('employee_rates').select('*').order('effective_from'),
    ])
    if(recs) setRecords(recs)
    if(emps){
      const today=new Date().toISOString().slice(0,10)
      const byEmp:Record<string,any[]>={}
      ;(rateRowsAll||[]).forEach((r:any)=>{(byEmp[r.employee_id]=byEmp[r.employee_id]||[]).push({effective_from:String(r.effective_from).slice(0,10),rate:Number(r.rate)})})
      // With a schedule, the "current" rate shown/used elsewhere is the one in force today
      setEmployees(emps.map((e:any)=>{
        const h=byEmp[e.id]||[]
        const withH={...e,rate_history:h}
        return h.length?{...withH,rate:rateOn(withH,today)}:withH
      }))
    }
    if(cas) setCashAdvances(cas)
    if(runs) setPayrollRuns(runs)
    setLoading(false)
  },[])
  useEffect(()=>{fetchAll()},[fetchAll])

  // ── Clear Payroll Register ──────────────────────────────────────────────
  const [showClearModal,setShowClearModal]=useState(false)
  const [payrollPeriodFilter,setPayrollPeriodFilter]=useState('')
  useEffect(()=>{ if(!payrollPeriodFilter && payrollRuns.length>0) setPayrollPeriodFilter(payrollRuns[0].id) },[payrollRuns])
  const [showExportModal,setShowExportModal]=useState(false)
  const [exportRunId,setExportRunId]=useState('')
  const [clearRunId,setClearRunId]=useState('')
  const [clearing,setClearing]=useState(false)
  const clearPayrollRegister = async () => {
    if(!clearRunId) return
    const run = payrollRuns.find(r=>r.id===clearRunId)
    const label = run ? `${run.period_start} to ${run.period_end}` : 'this period'
    const count = records.filter(r=>r.payroll_run_id===clearRunId).length
    const typed = window.prompt(`This permanently deletes all ${count} payroll record(s) for ${label} — including reversing any loan/cash-advance deductions tied to them. This cannot be undone.\n\nType CLEAR to confirm:`)
    if(typed !== 'CLEAR') return
    setClearing(true)
    try {
      const ids = records.filter(r=>r.payroll_run_id===clearRunId).map(r=>r.id)
      if(ids.length){
        // Delete child payment rows first so their reversal triggers restore
        // loan/cash-advance balances correctly before the parent rows go.
        await supabase.from('loan_payments').delete().in('payroll_record_id',ids)
        await supabase.from('cash_advance_payments').delete().in('payroll_id',ids)
        await supabase.from('payroll').delete().in('id',ids)
      }
      await fetchAll()
      setShowClearModal(false); setClearRunId('')
      alert(`Cleared ${count} record(s) for ${label}.`)
    } catch(err:any){ alert(err.message) }
    setClearing(false)
  }

  // ── Generate Payroll from Attendance ────────────────────────────────────
  const [showGenModal,setShowGenModal]=useState(false)
  const [genForm,setGenForm]=useState({employee_id:'',period_start:new Date(Date.now()-13*86400000).toISOString().slice(0,10),period_end:new Date().toISOString().slice(0,10)})
  const [genBreakdown,setGenBreakdown]=useState<any>(null)
  const [genLoans,setGenLoans]=useState<any[]>([])
  const [genLoanSel,setGenLoanSel]=useState<Record<string,number>>({})
  const [genCASel,setGenCASel]=useState<Record<string,number>>({})
  const [genAllowance,setGenAllowance]=useState(0)
  const [genNightDiff,setGenNightDiff]=useState(false)
  const [genCachedLogs,setGenCachedLogs]=useState<{emp:any,logs:any[]}|null>(null)
  const [genDeductionLines,setGenDeductionLines]=useState<{label:string,amount:number}[]>([])
  const [genLeaveDates,setGenLeaveDates]=useState<string[]>([])
  const [genLeaveDateInput,setGenLeaveDateInput]=useState('')
  const [genGenerating,setGenGenerating]=useState(false)
  const [genBatchMode,setGenBatchMode]=useState(false)
  const [genBatchProgress,setGenBatchProgress]=useState<{done:number,total:number,errors:string[]}|null>(null)
  // Every employee who had an Open loan/cash advance auto-deducted in a batch
  // run — shown afterward as a flagged review list (not just a count) so the
  // clerk can check each one against the Loans tab rather than trust a
  // one-line "no per-person review" process blindly.
  const [genBatchLoanReview,setGenBatchLoanReview]=useState<any[]|null>(null)
  const [genBatchSummary,setGenBatchSummary]=useState<{created:number,skipped:number,errors:string[]}|null>(null)

  // ── Loans module (separate from Cash Advances) ──────────────────────────
  const [allLoans,setAllLoans]=useState<any[]>([])
  const [loanStatusFilter,setLoanStatusFilter]=useState<'all'|'open'|'closed'>('all')
  const [empStatusFilter,setEmpStatusFilter]=useState<'active'|'on-leave'|'resigned'|'terminated'|'all'>('active')
  const [showLoanModal,setShowLoanModal]=useState(false)
  const [loanForm,setLoanForm]=useState({employee_id:'',loan_type:'SSS',date_issued:new Date().toISOString().slice(0,10),principal:0,installment_amount:0,notes:''})
  const [showLoanPayModal,setShowLoanPayModal]=useState<any>(null)
  const [loanPayAmount,setLoanPayAmount]=useState(0)
  const [loanHistoryFor,setLoanHistoryFor]=useState<any>(null)
  const [loanHistory,setLoanHistory]=useState<any[]>([])
  const [loanSaving,setLoanSaving]=useState(false)

  // ── Batch payslip printing ────────────────────────────────────────────────
  const [batchMode,setBatchMode]=useState(false)
  const [batchSelected,setBatchSelected]=useState<Record<string,boolean>>({})
  const toggleBatch=(id:string)=>setBatchSelected(p=>({...p,[id]:!p[id]}))
  const toggleBatchAll=()=>{
    const allSelected = records.length>0 && records.every(r=>batchSelected[r.id])
    const next:Record<string,boolean>={}
    if(!allSelected) records.forEach(r=>next[r.id]=true)
    setBatchSelected(next)
  }
  const batchSelectedCount = Object.values(batchSelected).filter(Boolean).length

  const [batchStatusTarget,setBatchStatusTarget]=useState('')
  const updateBatchStatus = async () => {
    if(!batchStatusTarget) return
    const ids = Object.entries(batchSelected).filter(([,v])=>v).map(([k])=>k)
    if(!ids.length) return
    const {error} = await supabase.from('payroll').update({status:batchStatusTarget}).in('id',ids)
    if(error){ alert(error.message); return }
    setBatchStatusTarget(''); setBatchSelected({}); setBatchMode(false)
    await fetchAll()
  }

  const printBatchPayslips = async () => {
    const selectedRecords = records.filter(r=>batchSelected[r.id])
    if(selectedRecords.length===0) return
    const blocks = await Promise.all(selectedRecords.map(async r=>{
      const loanBreakdown = await fetchLoanBreakdown(supabase, r.id, r.loan_deduction)
      return payslipBlockHtml(r.employees, r, loanBreakdown)
    }))
    // 4 per page: group into chunks of 4, each chunk in its own page grid
    const pages:string[] = []
    for(let i=0;i<blocks.length;i+=4){
      pages.push(`<div class="page">${blocks.slice(i,i+4).join('')}</div>`)
    }
    const w=window.open('','_blank','width=1000,height=800')
    if(!w) return
    w.document.write(`<html><head><title>Batch Payslips</title><style>${payslipCss}
      @page { size: A4 portrait; margin: 8mm; }
      .page{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8mm;page-break-after:always;height:277mm}
      .page:last-child{page-break-after:auto}
      .page .slip{margin-bottom:0;height:100%;overflow:hidden}
      body{padding:12px}
    </style></head><body>${pages.join('')}</body></html>`)
    w.document.close(); w.focus(); setTimeout(()=>{w.print()},500)
  }

  const fetchLoans=useCallback(async()=>{
    const {data}=await fetchAllPages<any>((from, to) => supabase.from('employee_loans').select('*, employees(name)').order('date_issued',{ascending:false}).range(from, to))
    if(data) setAllLoans(data)
  },[])
  useEffect(()=>{fetchLoans()},[fetchLoans])

  const openNewLoan=(employeeId?:string)=>{
    setLoanForm({employee_id:employeeId||'',loan_type:'SSS',date_issued:new Date().toISOString().slice(0,10),principal:0,installment_amount:0,notes:''})
    setShowLoanModal(true)
  }
  const saveLoan=async()=>{
    if(!loanForm.employee_id||!Number(loanForm.principal)) return
    setLoanSaving(true)
    const countForEmp = allLoans.filter(l=>l.employee_id===loanForm.employee_id).length+1
    const id=`LOAN-${loanForm.employee_id}-${String(countForEmp).padStart(2,'0')}`
    const {error}=await supabase.from('employee_loans').insert({...loanForm,id,balance:Number(loanForm.principal)})
    if(!error){ await fetchLoans(); setShowLoanModal(false) } else alert(error.message)
    setLoanSaving(false)
  }
  const recordLoanPayment=async()=>{
    if(!showLoanPayModal||!loanPayAmount) return
    setLoanSaving(true)
    const {error}=await supabase.from('loan_payments').insert({loan_id:showLoanPayModal.id,amount:loanPayAmount,date:new Date().toISOString().slice(0,10),method:'Cash Payment'})
    if(!error){ await fetchLoans(); setShowLoanPayModal(null); setLoanPayAmount(0) } else alert(error.message)
    setLoanSaving(false)
  }
  const openLoanHistory=async(loan:any)=>{
    setLoanHistoryFor(loan)
    const {data}=await supabase.from('loan_payments').select('*').eq('loan_id',loan.id).order('date',{ascending:false})
    setLoanHistory(data||[])
  }
  const deleteLoanHistoryPayment = async (paymentId:string) => {
    if(!window.confirm('Delete this payment? The loan balance will be restored.')) return
    await supabase.from('loan_payments').delete().eq('id',paymentId)
    const {data:freshLoan} = await supabase.from('employee_loans').select('*').eq('id',loanHistoryFor.id).single()
    if(freshLoan) setLoanHistoryFor(freshLoan)
    const {data} = await supabase.from('loan_payments').select('*').eq('loan_id',loanHistoryFor.id).order('date',{ascending:false})
    setLoanHistory(data||[])
    await fetchLoans()
  }

  const openGenModal=()=>{
    setGenForm({employee_id:'',period_start:new Date(Date.now()-13*86400000).toISOString().slice(0,10),period_end:new Date().toISOString().slice(0,10)})
    setGenBreakdown(null); setGenLoans([]); setGenLoanSel({}); setGenCASel({}); setGenAllowance(0)
    setGenDeductionLines([]); setGenLeaveDates([]); setGenLeaveDateInput('')
    setGenBatchMode(false); setGenBatchProgress(null); setGenNightDiff(false); setGenCachedLogs(null)
    setShowGenModal(true)
  }

  const runGenerate = async () => {
    if(!genForm.employee_id) return
    setGenGenerating(true)
    const emp = employees.find(e=>e.id===genForm.employee_id)
    const {data:logs} = await supabase.from('attendance_logs').select('*').eq('employee_id',genForm.employee_id).gte('date',genForm.period_start).lte('date',genForm.period_end)
    setGenCachedLogs({emp, logs: logs||[]})
    const breakdown = computePayrollFromAttendance(emp, logs||[], holidays, genForm.period_start, genForm.period_end, genNightDiff)
    const sss = lookupSSS(emp, sssBrackets)
    const philhealth = lookupPhilHealth(emp, contribSettings)
    const pagibig = lookupPagIbig(emp, contribSettings)
    setGenBreakdown({...breakdown, sss, philhealth, pagibig, daysLogged: (logs||[]).length})
    setGenLeaveDates(breakdown.leaveDates || [])

    const {data:loans} = await supabase.from('employee_loans').select('*').eq('employee_id',genForm.employee_id).eq('status','Open')
    setGenLoans(loans||[])
    setGenGenerating(false)
  }

  // Generate for every active employee in one pass — no per-employee review
  // step, so any Open loan/cash-advance auto-deducts its full installment /
  // balance. Skips anyone who already has a record for this exact period,
  // so re-running it after fixing one employee doesn't create duplicates.
  // Recomputes instantly from the already-fetched attendance when the night
  // diff toggle changes after Compute — no need to hit the DB again for
  // something that's now a pure client-side flag.
  const toggleGenNightDiff = (checked: boolean) => {
    setGenNightDiff(checked)
    if (!genCachedLogs || !genBreakdown) return
    const breakdown = computePayrollFromAttendance(genCachedLogs.emp, genCachedLogs.logs, holidays, genForm.period_start, genForm.period_end, checked)
    setGenBreakdown((p:any) => ({...p, ...breakdown}))
  }

  const runGenerateAllBatch = async () => {
    setGenGenerating(true)
    setGenBatchLoanReview(null); setGenBatchSummary(null)
    const active = employees.filter(e=>e.status==='Active')
    const errors:string[] = []
    const loanReview:any[] = []
    let created = 0, skipped = 0

    let runId:string
    const {data:existingRun} = await supabase.from('payroll_runs').select('id').eq('period_start',genForm.period_start).eq('period_end',genForm.period_end).maybeSingle()
    if(existingRun) runId = existingRun.id
    else {
      const {data:newRun,error:e1} = await supabase.from('payroll_runs').insert({period_start:genForm.period_start,period_end:genForm.period_end}).select().single()
      if(e1){ alert(`Could not create payroll run: ${e1.message}`); setGenGenerating(false); return }
      runId = newRun.id
    }

    const {data:existingRecords} = await supabase.from('payroll').select('employee_id').eq('payroll_run_id',runId)
    const alreadyDone = new Set((existingRecords||[]).map((r:any)=>r.employee_id))

    for (let i=0; i<active.length; i++) {
      const emp = active[i]
      setGenBatchProgress({done:i, total:active.length, errors})
      if (alreadyDone.has(emp.id)) { skipped++; continue }
      try {
        const {data:logs} = await supabase.from('attendance_logs').select('*').eq('employee_id',emp.id).gte('date',genForm.period_start).lte('date',genForm.period_end)
        if (emp.employment_type!=='Salaried' && (!logs || logs.length===0)) { skipped++; continue } // nothing to pay if no attendance in range (doesn't apply to fixed-salary employees)
        const b = computePayrollFromAttendance(emp, logs||[], holidays, genForm.period_start, genForm.period_end, genNightDiff)
        const sss = lookupSSS(emp, sssBrackets)
        const philhealth = lookupPhilHealth(emp, contribSettings)
        const pagibig = lookupPagIbig(emp, contribSettings)

        const {data:rec,error:eRec} = await supabase.from('payroll').insert({
          employee_id: emp.id, payroll_run_id: runId,
          period: `${genForm.period_start} to ${genForm.period_end}`,
          days_worked: b.regularDays, overtime_hours: b.otHours, overtime_pay: b.otPay, regular_pay: b.regularPay,
          sunday_days: b.sundayDays, sunday_pay: b.sundayPay,
          night_diff_hours: b.nightDiffHours, night_diff_pay: b.nightDiffPay,
          regular_holiday_days: b.regHolidayDays, regular_holiday_pay: b.regHolidayPay,
          special_holiday_days: b.specHolidayDays, special_holiday_pay: b.specHolidayPay,
          leave_days: b.leaveDays, leave_pay: b.leavePay, leave_dates: b.leaveDates,
          ...((b.rateBreakdown?.length||0)>1 ? { rate_breakdown: b.rateBreakdown } : {}),
          allowance: 0, sss, philhealth, pagibig, tax: 0,
          loan_deduction: 0, cash_advance_deduction: 0, other_deductions: 0, deduction_lines: [], status: 'Pending',
        }).select().single()
        if (eRec) throw eRec

        // Auto-deduct every Open loan/advance — installment_amount is entered
        // as the MONTHLY payment, and payroll runs twice a month, so every
        // loan/amortization (SSS, Pag-IBIG, or Other) halves per cutoff. No
        // per-employee review step in batch mode.
        const {data:loans} = await supabase.from('employee_loans').select('*').eq('employee_id',emp.id).eq('status','Open')
        const perCutoffAmt = (l:any) => Math.min(Number(l.installment_amount)/2, Number(l.balance))
        const loanTotal = (loans||[]).reduce((s,l)=>s+perCutoffAmt(l),0)
        if (loans && loans.length>0) {
          const {error:eLoan} = await supabase.from('loan_payments').insert(loans.map((l:any)=>({loan_id:l.id, amount:perCutoffAmt(l), payroll_record_id:rec.id, method:'Payroll Deduction', notes:`Batch-generated ${genForm.period_start} to ${genForm.period_end}`})))
          // Don't let this fail silently — the payroll row below still gets its
          // loan_deduction total set either way, so a silent insert failure here
          // would leave the saved total with no loan_payments rows behind it
          // (the payslip's per-loan breakdown would then show 0 even though the
          // net pay was correctly reduced).
          if (eLoan) errors.push(`${emp.name}: loan deduction total saved, but loan_payments insert failed (${eLoan.message}) — the payslip's per-loan breakdown won't show it until this is fixed.`)
          loans.forEach((l:any)=>loanReview.push({employee:emp.name, employeeId:emp.id, kind:'Loan', type:l.loan_type, loanId:l.id, amount:perCutoffAmt(l), balanceBefore:Number(l.balance), ok:!eLoan, error:eLoan?.message}))
        }
        const {data:cas} = await supabase.from('cash_advances').select('*').eq('employee_id',emp.id).eq('status','Open')
        const caTotal = (cas||[]).reduce((s,c)=>s+Number(c.balance),0)
        if (cas && cas.length>0) {
          const {error:eCA} = await supabase.from('cash_advance_payments').insert(cas.map((c:any)=>({cash_advance_id:c.id, amount:Number(c.balance), payroll_id:rec.id, method:'Payroll Deduction', date:new Date().toISOString().slice(0,10), notes:`Batch-generated ${genForm.period_start} to ${genForm.period_end}`})))
          if (eCA) errors.push(`${emp.name}: cash advance deduction total saved, but cash_advance_payments insert failed (${eCA.message}).`)
          cas.forEach((c:any)=>loanReview.push({employee:emp.name, employeeId:emp.id, kind:'Cash Advance', type:'Cash Advance', loanId:c.id, amount:Number(c.balance), balanceBefore:Number(c.balance), ok:!eCA, error:eCA?.message}))
        }
        if (loanTotal>0 || caTotal>0) {
          await supabase.from('payroll').update({loan_deduction:loanTotal, cash_advance_deduction:caTotal}).eq('id',rec.id)
        }
        created++
      } catch (err:any) {
        errors.push(`${emp.name}: ${err.message}`)
      }
    }

    setGenBatchProgress({done:active.length, total:active.length, errors})
    await fetchAll()
    setGenGenerating(false)
    if (loanReview.length > 0) {
      // Flag every affected employee for review instead of a plain summary
      // alert — batch mode deducts automatically with no per-person check, so
      // this is the clerk's one chance to confirm every loan/advance actually
      // posted before payslips go out.
      setGenBatchLoanReview(loanReview)
    } else {
      alert(`Batch generation complete.\n\nCreated: ${created}\nSkipped (no attendance or already done): ${skipped}\nErrors: ${errors.length}${errors.length?'\n\n'+errors.join('\n'):''}`)
    }
    setGenBatchSummary({created, skipped, errors})
  }

  const toggleGenLoan = (loan:any) => {
    setGenLoanSel(p=>{
      const next={...p}
      if(next[loan.id]!==undefined) delete next[loan.id]
      else {
        // installment_amount is entered as the MONTHLY payment — since
        // payroll runs twice a month, every loan/amortization (SSS, Pag-IBIG,
        // or Other) defaults to half per cutoff.
        const perCutoff = Number(loan.installment_amount)/2
        next[loan.id]=Math.min(perCutoff,Number(loan.balance))
      }
      return next
    })
  }
  const toggleGenCA = (ca:any) => {
    setGenCASel(p=>{
      const next={...p}
      if(next[ca.id]!==undefined) delete next[ca.id]
      else next[ca.id]=Number(ca.balance)
      return next
    })
  }

  const saveGeneratedPayroll = async () => {
    if(!genBreakdown) return
    setGenGenerating(true)
    try{
      // find-or-create the payroll run for this exact date range
      let runId:string
      const {data:existingRun} = await supabase.from('payroll_runs').select('id').eq('period_start',genForm.period_start).eq('period_end',genForm.period_end).maybeSingle()
      if(existingRun) runId = existingRun.id
      else {
        const {data:newRun,error:e1} = await supabase.from('payroll_runs').insert({period_start:genForm.period_start,period_end:genForm.period_end}).select().single()
        if(e1) throw e1
        runId = newRun.id
      }

      const loanDedTotal = Object.values(genLoanSel).reduce((s,v)=>s+Number(v),0)
      const caDedTotal = Object.values(genCASel).reduce((s,v)=>s+Number(v),0)
      const otherDedTotal = genDeductionLines.reduce((s,d)=>s+Number(d.amount||0),0)
      const b = genBreakdown
      const emp = employees.find(e=>e.id===genForm.employee_id)
      const leaveRateOn = (d:string) => emp?.employment_type==='Salaried' ? Number(emp.rate)/26 : rateOn(emp, d)
      const leavePay = round2(genLeaveDates.reduce((s2:number,d:string)=>s2+leaveRateOn(d),0))

      const {data:rec,error:e2} = await supabase.from('payroll').insert({
        employee_id: genForm.employee_id,
        payroll_run_id: runId,
        period: `${genForm.period_start} to ${genForm.period_end}`,
        days_worked: b.regularDays, overtime_hours: b.otHours, overtime_pay: b.otPay, regular_pay: b.regularPay,
        sunday_days: b.sundayDays, sunday_pay: b.sundayPay,
        night_diff_hours: b.nightDiffHours, night_diff_pay: b.nightDiffPay,
        regular_holiday_days: b.regHolidayDays, regular_holiday_pay: b.regHolidayPay,
        special_holiday_days: b.specHolidayDays, special_holiday_pay: b.specHolidayPay,
        leave_days: genLeaveDates.length, leave_pay: leavePay, leave_dates: genLeaveDates,
        ...((b.rateBreakdown?.length||0)>1 ? { rate_breakdown: b.rateBreakdown } : {}),
        allowance: genAllowance,
        sss: b.sss, philhealth: b.philhealth, pagibig: b.pagibig,
        tax: 0,
        loan_deduction: loanDedTotal, cash_advance_deduction: caDedTotal,
        other_deductions: otherDedTotal, deduction_lines: genDeductionLines,
        status: 'Pending',
      }).select().single()
      if(e2) throw e2

      if(loanDedTotal>0){
        const payments = Object.entries(genLoanSel).map(([loan_id,amount])=>({loan_id,amount,payroll_record_id:rec.id,method:'Payroll Deduction',notes:`Deducted from ${genForm.period_start} to ${genForm.period_end}`}))
        const {error:eLoan} = await supabase.from('loan_payments').insert(payments)
        // The payroll row above already has loan_deduction saved regardless —
        // surface this rather than let the record go out with a deduction
        // total that has no loan_payments rows behind it (which is exactly
        // what silently broke the payslip's per-loan breakdown before).
        if (eLoan) throw new Error(`Payroll record saved, but recording the loan payment(s) failed: ${eLoan.message}. The loan deduction total is correct, but it won't appear broken down on the payslip or in loan history until this is fixed.`)
      }
      if(caDedTotal>0){
        const payments = Object.entries(genCASel).map(([cash_advance_id,amount])=>({cash_advance_id,amount,payroll_id:rec.id,method:'Payroll Deduction',date:new Date().toISOString().slice(0,10),notes:`Deducted from ${genForm.period_start} to ${genForm.period_end}`}))
        const {error:eCA} = await supabase.from('cash_advance_payments').insert(payments)
        if (eCA) throw new Error(`Payroll record saved, but recording the cash advance payment(s) failed: ${eCA.message}.`)
      }

      await fetchAll()
      setShowGenModal(false)
      alert('Payroll record generated and saved.')
    } catch(err:any){ alert(err.message) }
    setGenGenerating(false)
  }

  // ── Payroll Record CRUD ──────────────────────────────────────────────────
  const openNewRec=()=>{
    setRecForm({...BLANK_REC,period:new Date().toLocaleDateString('en-PH',{month:'long',year:'numeric'})})
    setCaAllocations({})
    setSelectedRec(null);setError('');setShowRecModal(true)
  }
  const [recPaymentHistory,setRecPaymentHistory]=useState<{loans:any[],cas:any[]}>({loans:[],cas:[]})
  const openEditRec=async(r:any)=>{
    setRecForm({employee_id:r.employee_id,period:r.period,days_worked:r.days_worked,overtime_hours:r.overtime_hours,allowance:r.allowance,sss:r.sss,philhealth:r.philhealth,pagibig:r.pagibig,tax:r.tax,status:r.status,cash_advance_deduction:r.cash_advance_deduction||0,deduction_lines:r.deduction_lines||[],leave_dates:r.leave_dates||[],
      sunday_days:r.sunday_days||0,sunday_pay:r.sunday_pay||0,night_diff_hours:r.night_diff_hours||0,night_diff_pay:r.night_diff_pay||0,
      regular_holiday_days:r.regular_holiday_days||0,regular_holiday_pay:r.regular_holiday_pay||0,special_holiday_days:r.special_holiday_days||0,special_holiday_pay:r.special_holiday_pay||0,
      leave_pay:r.leave_pay||0,leave_days:r.leave_days||0,other_deductions:r.other_deductions||0,loan_deduction:r.loan_deduction||0,company_deduction:r.company_deduction||0,
      overtime_pay:r.overtime_pay, regular_pay:r.regular_pay,
    })
    setCaAllocations({})
    setSelectedRec(r);setError('');setShowRecModal(true)
    const [{data:loanPays},{data:caPays}] = await Promise.all([
      supabase.from('loan_payments').select('*, employee_loans(loan_type,id)').eq('payroll_record_id',r.id),
      supabase.from('cash_advance_payments').select('*, cash_advances(id)').eq('payroll_id',r.id),
    ])
    setRecPaymentHistory({loans:loanPays||[], cas:caPays||[]})
  }
  const deleteRecLoanPayment = async (paymentId:string) => {
    if(!window.confirm('Delete this loan payment? The loan balance will be restored.')) return
    await supabase.from('loan_payments').delete().eq('id',paymentId)
    const remaining = recPaymentHistory.loans.filter(l=>l.id!==paymentId)
    setRecPaymentHistory(p=>({...p, loans:remaining}))
    rf('loan_deduction')(remaining.reduce((s,l)=>s+Number(l.amount),0))
    await fetchAll()
  }
  const deleteRecCAPayment = async (paymentId:string) => {
    if(!window.confirm('Delete this cash advance payment? The balance will be restored.')) return
    await supabase.from('cash_advance_payments').delete().eq('id',paymentId)
    const remaining = recPaymentHistory.cas.filter(c=>c.id!==paymentId)
    setRecPaymentHistory(p=>({...p, cas:remaining}))
    rf('cash_advance_deduction')(remaining.reduce((s,c)=>s+Number(c.amount),0))
    await fetchAll()
  }

  // Open cash advances for whichever employee is selected in the payroll form
  const openCAsForSelected = cashAdvances.filter(ca=>ca.employee_id===recForm.employee_id && ca.status==='Open')

  const updateAllocation = (caId:string, amount:number, maxBalance:number) => {
    const clamped = Math.max(0, Math.min(amount, maxBalance))
    const next = {...caAllocations, [caId]: clamped}
    setCaAllocations(next)
    const total = Object.values(next).reduce((s:number,v:any)=>s+Number(v||0),0)
    setRecForm((p:any)=>({...p, cash_advance_deduction: total}))
  }

  const saveRec=async()=>{
    setSaving(true);setError('')
    try{
      if(selectedRec){
        // Editing an existing record: cash advance allocations are locked to avoid
        // double-booking the ledger. Adjust cash advances directly from that tab instead.
        const {error:e}=await supabase.from('payroll').update(recForm).eq('id',selectedRec.id)
        if(e) throw e
      } else {
        const {data,error:e}=await supabase.from('payroll').insert(recForm).select().single()
        if(e) throw e
        // Post each allocated cash-advance deduction to the ledger — the DB trigger
        // reduces the advance's balance (and auto-closes it) automatically.
        const allocations = Object.entries(caAllocations).filter(([,amt])=>Number(amt)>0)
        if (allocations.length){
          const payments = allocations.map(([caId,amt])=>({
            cash_advance_id: caId, payroll_id: data.id, amount: Number(amt),
            date: new Date().toISOString().slice(0,10), method: 'Payroll Deduction',
            notes: `Deducted from payroll period ${recForm.period}`
          }))
          const {error:e2}=await supabase.from('cash_advance_payments').insert(payments)
          if(e2) throw e2
        }
      }
      await fetchAll();setShowRecModal(false)
    } catch(err:any){setError(err.message)}
    setSaving(false)
  }

  const deleteRec=async()=>{
    if(!selectedRec) return;setSaving(true)
    const {error}=await supabase.from('payroll').delete().eq('id',selectedRec.id)
    if(!error){await fetchAll();setShowRecModal(false)} else setError(error.message)
    setSaving(false)
  }

  // ── Employee CRUD ────────────────────────────────────────────────────────
  const openNewEmp=()=>{setRateRows([]);setEmpForm({...BLANK_EMP});setMonthlyCalc(0);setMonthlyDivisor(26);setSelectedEmp(null);setError('');setShowEmpModal(true)}
  const openEditEmp=(e:any)=>{setRateRows((e.rate_history||[]).map((r:any)=>({effective_from:r.effective_from,rate:String(r.rate)})));setEmpForm({hire_date:e.hire_date||'',name:e.name,role:e.role,department:e.department,employment_type:e.employment_type,employment_status:e.employment_status||'Regular',rate:e.rate,contact:e.contact,status:e.status,sss_exempt:!!e.sss_exempt,philhealth_exempt:!!e.philhealth_exempt,philhealth_doubled:!!e.philhealth_doubled,pagibig_doubled:!!e.pagibig_doubled,pagibig_exempt:!!e.pagibig_exempt,ot_exempt:!!e.ot_exempt,full_day_pay:!!e.full_day_pay});setMonthlyCalc(0);setMonthlyDivisor(26);setSelectedEmp(e);setError('');setShowEmpModal(true)}

  const updateLeaveAllotment = async (empId:string, field:'vl_allotment'|'sl_allotment', value:number) => {
    setEmployees(p=>p.map(e=>e.id===empId?{...e,[field]:value}:e))
    const {error} = await supabase.from('employees').update({[field]:value}).eq('id',empId)
    if(error) alert(error.message)
  }

  const saveEmp=async()=>{
    setSaving(true);setError('')
    try{
      // Rate schedule: keep only complete rows; the rate in force today becomes the "current" rate
      const sched=rateRows.filter(r=>r.effective_from&&Number(r.rate)>0).map(r=>({effective_from:r.effective_from,rate:Number(r.rate)})).sort((a,b)=>a.effective_from.localeCompare(b.effective_from))
      const today=new Date().toISOString().slice(0,10)
      const {hire_date,...restForm}=empForm
      const payload:any={...restForm}
      if(hire_date) payload.hire_date=hire_date
      if(sched.length&&empForm.employment_type!=='Salaried') payload.rate=rateOn({rate_history:sched,rate:0},today)
      let empId=selectedEmp?.id
      if(selectedEmp){
        const {error:e}=await supabase.from('employees').update(payload).eq('id',selectedEmp.id)
        if(e) throw e
      } else {
        empId=`EMP-${String(employees.length+1).padStart(3,'0')}`
        const {error:e}=await supabase.from('employees').insert({...payload,id:empId})
        if(e) throw e
      }
      if(empId&&(sched.length||(selectedEmp?.rate_history||[]).length)){
        const {error:eDel}=await supabase.from('employee_rates').delete().eq('employee_id',empId)
        if(eDel) throw new Error('Could not save the rate schedule — has the employee_rates table been created? ('+eDel.message+')')
        if(sched.length){
          const {error:eIns}=await supabase.from('employee_rates').insert(sched.map(r=>({...r,employee_id:empId})))
          if(eIns) throw eIns
        }
      }
      await fetchAll();setShowEmpModal(false)
    } catch(err:any){setError(err.message)}
    setSaving(false)
  }

  const deleteEmp=async()=>{
    if(!selectedEmp) return;setSaving(true)
    const {error}=await supabase.from('employees').delete().eq('id',selectedEmp.id)
    if(!error){await fetchAll();setShowEmpModal(false)} else setError(error.message)
    setSaving(false)
  }

  // ── Cash Advance CRUD ────────────────────────────────────────────────────
  const checkCaId = async (id:string) => {
    if(!id) { setCaIdAvailable(true); return }
    const {data} = await supabase.from('cash_advances').select('id').eq('id',id.trim()).maybeSingle()
    setCaIdAvailable(!data)
  }

  const openNewCA = (employeeId?:string) => {
    const seq = cashAdvances.filter(ca=>ca.employee_id===employeeId).length + 1
    const suggested = employeeId ? `CA-${employeeId}-${String(seq).padStart(2,'0')}` : ''
    setCaForm({...BLANK_CA, id:suggested, employee_id: employeeId||''})
    setCaIdAvailable(true); setError(''); setShowCAModal(true)
  }

  const saveCA = async () => {
    if(!caForm.id.trim()) return setError('Reference number is required.')
    if(!caForm.employee_id) return setError('Employee is required.')
    if(Number(caForm.amount)<=0) return setError('Amount must be greater than zero.')
    if(!caIdAvailable) return setError(`Reference "${caForm.id}" is already in use.`)

    setSaving(true); setError('')
    try{
      const {error:e} = await supabase.from('cash_advances').insert({
        id: caForm.id.trim(), employee_id: caForm.employee_id,
        date_issued: caForm.date_issued, amount: Number(caForm.amount),
        balance: Number(caForm.amount), status: 'Open', notes: caForm.notes,
      })
      if(e){
        if((e as any).code==='23505') throw new Error(`Reference "${caForm.id}" already exists.`)
        throw e
      }
      await fetchAll(); setShowCAModal(false)
    } catch(err:any){ setError(err.message) }
    setSaving(false)
  }

  const submitPayment = async () => {
    if(!showPayModal) return
    if(Number(payForm.amount)<=0) return setError('Amount must be greater than zero.')
    if(Number(payForm.amount)>showPayModal.balance) return setError(`Amount can't exceed the remaining balance of ${fmt(showPayModal.balance)}.`)
    setSaving(true); setError('')
    try{
      const {error:e} = await supabase.from('cash_advance_payments').insert({
        cash_advance_id: showPayModal.id, amount: Number(payForm.amount),
        date: payForm.date, method: payForm.method, notes: payForm.notes,
      })
      if(e) throw e
      await fetchAll(); setShowPayModal(null)
      setPayForm({amount:0,date:new Date().toISOString().slice(0,10),method:'Cash Payment',notes:''})
    } catch(err:any){ setError(err.message) }
    setSaving(false)
  }

  const openLedger = async (ca:any) => {
    setShowLedger(ca)
    const {data} = await supabase.from('cash_advance_payments').select('*').eq('cash_advance_id',ca.id).order('date',{ascending:false})
    setLedgerRows(data||[])
  }
  const deleteLedgerPayment = async (paymentId:string) => {
    if(!window.confirm('Delete this payment? The advance balance will be restored.')) return
    await supabase.from('cash_advance_payments').delete().eq('id',paymentId)
    const {data:freshCA} = await supabase.from('cash_advances').select('*, employees(name)').eq('id',showLedger.id).single()
    if(freshCA) setShowLedger(freshCA)
    const {data} = await supabase.from('cash_advance_payments').select('*').eq('cash_advance_id',showLedger.id).order('date',{ascending:false})
    setLedgerRows(data||[])
    await fetchAll()
  }

  const deleteCashAdvance = async (ca:any) => {
    const warning = Number(ca.balance) > 0
      ? `⚠ This advance still has an outstanding balance of ${fmt(ca.balance)}. Deleting it erases that record entirely — this cannot be undone.\n\nDelete "${ca.id}" anyway?`
      : `Delete cash advance "${ca.id}"? This cannot be undone.`
    if (!window.confirm(warning)) return
    await supabase.from('cash_advance_payments').delete().eq('cash_advance_id',ca.id)
    const {error} = await supabase.from('cash_advances').delete().eq('id',ca.id)
    if (error) alert(error.message)
    await fetchAll()
  }

  // ── Totals — Gross/Deductions/Net respect the period filter; Employees
  // count and Outstanding CA stay global since neither is a "per period" idea.
  const periodRecords = payrollPeriodFilter ? records.filter(r=>r.payroll_run_id===payrollPeriodFilter) : records
  const totalGross=periodRecords.reduce((s,r)=>s+calcGross(r.employees,r)+Number(r.allowance),0)
  // Must mirror every component calcNet() subtracts — otherwise this tile
  // undercounts whenever a record has a loan deduction, company deduction,
  // or an ad-hoc "+ Add deduction line" entry, and Gross − Deductions stops
  // matching the Net Payroll tile right next to it.
  const totalDed=periodRecords.reduce((s,r)=>s+Number(r.sss)+Number(r.philhealth)+Number(r.pagibig)+Number(r.tax)+Number(r.cash_advance_deduction||0)+Number(r.loan_deduction||0)+Number(r.company_deduction||0)+Number(r.other_deductions||0)+(r.deduction_lines||[]).reduce((ds:number,d:any)=>ds+Number(d?.amount||0),0),0)
  const totalNet=periodRecords.reduce((s,r)=>s+calcNet(r.employees,r),0)
  const totalOutstandingCA = cashAdvances.filter(ca=>ca.status==='Open').reduce((s,ca)=>s+Number(ca.balance),0)
  const openCACount = cashAdvances.filter(ca=>ca.status==='Open').length
  const selectedPeriodLabel = payrollPeriodFilter ? payrollRuns.find(r=>r.id===payrollPeriodFilter) : null

  const employeeCABalance = (empId:string) => cashAdvances.filter(ca=>ca.employee_id===empId && ca.status==='Open').reduce((s,ca)=>s+Number(ca.balance),0)
  const employeeLoanBalance = (empId:string) => allLoans.filter(l=>l.employee_id===empId && l.status==='Open').reduce((s,l)=>s+Number(l.balance),0)

  // Reset each list's own page to 1 whenever its own filter/tab state changes.
  useEffect(()=>{ setRecordsPage(1) },[payrollPeriodFilter])
  useEffect(()=>{ setCaPage(1) },[caStatusFilter])
  useEffect(()=>{ setEmployeesPage(1) },[empStatusFilter])
  useEffect(()=>{ setAttPage(1) },[attEmpFilter, attStatusFilter, attFrom, attTo])
  useEffect(()=>{ setLoansPage(1) },[loanStatusFilter])

  // Scroll to top whenever any list's page number changes.
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[recordsPage])
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[caPage])
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[employeesPage])
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[attPage])
  useEffect(()=>{ window.scrollTo({top:0, behavior:'smooth'}) },[loansPage])

  return(
    <div>
      {/* KPIs */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:14,marginBottom:22}}>
        {([['Employees',employees.filter(e=>e.status==='Active').length,'registered',C.accent],['Gross Payroll',fmt(totalGross),selectedPeriodLabel?`${selectedPeriodLabel.period_start} to ${selectedPeriodLabel.period_end}`:'all periods, before deductions',C.midGreen],['Total Deductions',fmt(totalDed),selectedPeriodLabel?'this period, incl. cash advances':'all periods, incl. cash advances',C.red],['Net Payroll',fmt(totalNet),selectedPeriodLabel?'this period, take-home pay':'all periods, take-home pay',C.blue],['Outstanding CA',fmt(totalOutstandingCA),`${openCACount} open advances`,C.amber]] as any[]).map(([l,v,s,c])=>(
          <div key={l} style={{background:C.white,borderRadius:12,padding:'16px 18px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)',borderTop:`4px solid ${c}`}}>
            <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:C.gray,textTransform:'uppercase'}}>{l}</div>
            <div style={{fontSize:19,fontWeight:900,color:C.dark,marginTop:4}}>{v}</div>
            <div style={{fontSize:10,color:C.gray,marginTop:2}}>{s}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
        {(['payroll','cash-advances','loans','employees','attendance','leave-tracker','payroll-yearly','thirteenth-month','holidays','contributions'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'8px 18px',borderRadius:6,border:`1.5px solid ${tab===t?C.accent:C.lightGray}`,background:tab===t?C.accent:C.white,color:tab===t?C.white:C.gray,fontSize:11,fontWeight:800,cursor:'pointer',fontFamily:'inherit',letterSpacing:1,textTransform:'uppercase',transition:'all 0.2s'}}>
            {({payroll:'Payroll Records','cash-advances':'Cash Advances',loans:'Loans',employees:'Employee Directory',attendance:'Attendance','leave-tracker':'Leave Tracker','payroll-yearly':'Payroll Record','thirteenth-month':'13th Month Pay',holidays:'Holidays',contributions:'Contributions'})[t]}
          </button>
        ))}
        {(tab==='payroll'||tab==='attendance') && (
          <button onClick={()=>setSplitView(v=>!v)} style={{padding:'8px 18px',borderRadius:6,border:`1.5px solid ${splitView?C.blue:C.lightGray}`,background:splitView?C.blue:C.white,color:splitView?C.white:C.gray,fontSize:11,fontWeight:800,cursor:'pointer',fontFamily:'inherit',letterSpacing:1,textTransform:'uppercase'}}>⬛⬛ {splitView?'Exit Split View':'Split View'}</button>
        )}
      </div>

      {/* ── PAYROLL RECORDS TAB ── */}
      {(splitView && (tab==='payroll'||tab==='attendance')) && (
        <div style={{marginBottom:10}}>
          <span style={{fontSize:11,color:C.gray,fontWeight:700}}>Split view — Payroll Records and Attendance shown side by side.</span>
        </div>
      )}
      <div style={splitView && (tab==='payroll'||tab==='attendance') ? {display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,alignItems:'start'} : undefined}>
      {(tab==='payroll'||(splitView&&tab==='attendance'))&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Payroll Register</h2>
            </div>
            {canEdit&&<div style={{display:'flex',gap:8}}>
              <button onClick={openGenModal} style={{padding:'9px 20px',background:`linear-gradient(135deg,${C.blue},#1d4ed8)`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit',boxShadow:`0 3px 10px ${C.blue}44`}}>⚡ Generate from Attendance</button>
              <button onClick={openNewRec} style={{padding:'9px 20px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit',boxShadow:`0 3px 10px ${C.accent}44`}}>+ Add Record</button>
              <button onClick={()=>{setBatchMode(m=>!m);setBatchSelected({})}} style={{padding:'9px 20px',background:batchMode?`linear-gradient(135deg,${C.purple},#6d28d9)`:C.white,border:`1.5px solid ${C.purple}`,borderRadius:6,color:batchMode?C.white:C.purple,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit'}}>{batchMode?'✕ Cancel':'☑ Select Employees'}</button>
              <button onClick={()=>{setExportRunId('');setShowExportModal(true)}} style={{padding:'9px 20px',background:C.white,border:`1.5px solid ${C.darkGreen}`,borderRadius:6,color:C.darkGreen,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit'}}>🖨 Export Register</button>
            </div>}
          </div>
          <div style={{marginBottom:14}}>
            <select value={payrollPeriodFilter} onChange={e=>setPayrollPeriodFilter(e.target.value)} style={{padding:'7px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit',minWidth:220}}>
              <option value="">All Periods</option>
              {payrollRuns.map(r=>{
                const count = records.filter(rec=>rec.payroll_run_id===r.id).length
                return <option key={r.id} value={r.id}>{r.period_start} to {r.period_end} — {count} record{count===1?'':'s'}</option>
              })}
            </select>
          </div>
          {(()=>{ const filteredRecords = payrollPeriodFilter ? records.filter(r=>r.payroll_run_id===payrollPeriodFilter) : records
          // Most-recent-first by the record's own payroll period end date,
          // falling back to created_at — a bulk historical import lands every
          // row's created_at within the same minute, so sorting on that alone
          // would leave years of real history in near-random order.
          const recordRecencyKey = (r:any) => { const run = payrollRuns.find(pr=>pr.id===r.payroll_run_id); return run?.period_end || run?.period_start || r.created_at || '' }
          const recordsSorted = [...filteredRecords].sort((a,b)=>String(recordRecencyKey(b)).localeCompare(String(recordRecencyKey(a))))
          const recordsPageCount = Math.max(1, Math.ceil(recordsSorted.length / PAGE_SIZE))
          const recordsCurrentPage = Math.min(recordsPage, recordsPageCount)
          const recordsPaged = recordsSorted.slice((recordsCurrentPage-1)*PAGE_SIZE, recordsCurrentPage*PAGE_SIZE)
          return (<>
          {!loading && (
            <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>
              {filteredRecords.length===0?'':`Showing ${(recordsCurrentPage-1)*PAGE_SIZE+1}–${Math.min(recordsCurrentPage*PAGE_SIZE, recordsSorted.length)} of ${recordsSorted.length}`}
            </div>
          )}
          {loading?<div style={{textAlign:'center',padding:40,color:C.gray}}>Loading…</div>
          :filteredRecords.length===0?<div style={{textAlign:'center',padding:40,color:C.gray}}>{payrollPeriodFilter?'No records for this period.':'No payroll records yet.'}</div>
          :<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
            <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
              {batchMode&&<th style={{padding:'9px 10px'}}><input type="checkbox" checked={filteredRecords.length>0&&filteredRecords.every(r=>batchSelected[r.id])} onChange={()=>{ const allSel=filteredRecords.every(r=>batchSelected[r.id]); const next={...batchSelected}; filteredRecords.forEach(r=>{next[r.id]=!allSel}); setBatchSelected(next) }}/></th>}
              {['Employee','Period','Type','Gross','Allowance','Deductions','CA Ded.','Net Pay','Status','Actions'].map(h=>(
                <th key={h} style={{padding:'9px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>{[...recordsPaged].sort((a,b)=>((a.employees?.employment_type==='Salaried')?0:1)-((b.employees?.employment_type==='Salaried')?0:1)).map((r,i,arr)=>{
              const emp=r.employees
              const gross=calcGross(emp,r)
              const ded=Number(r.sss)+Number(r.philhealth)+Number(r.pagibig)+Number(r.tax)
              const net=calcNet(emp,r)
              const showGroupHeader = i===0 || arr[i-1].employees?.employment_type!==emp?.employment_type
              return <Fragment key={r.id}>
              {showGroupHeader && (
                <tr><td colSpan={batchMode?10:9} style={{padding:'8px 10px',background:'#f4f7f5',fontSize:10,fontWeight:900,letterSpacing:1.5,color:emp?.employment_type==='Salaried'?C.blue:C.accent,textTransform:'uppercase'}}>{emp?.employment_type==='Salaried'?'Salaried':'Daily / Part-Time'}</td></tr>
              )}
              <tr style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                {batchMode&&<td style={{padding:'9px 10px'}}><input type="checkbox" checked={!!batchSelected[r.id]} onChange={()=>toggleBatch(r.id)}/></td>}
                <td style={{padding:'9px 10px',fontWeight:700}}>{emp?.name||'—'}</td>
                <td style={{padding:'9px 10px',color:C.gray}}>{r.period}</td>
                <td style={{padding:'9px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,background:`${C.blue}18`,color:C.blue,fontSize:10,fontWeight:800,border:`1px solid ${C.blue}33`}}>{emp?.employment_type||'—'}</span></td>
                <td style={{padding:'9px 10px',fontWeight:700}}>{fmt(gross)}</td>
                <td style={{padding:'9px 10px',color:C.accent}}>{fmt(r.allowance)}</td>
                <td style={{padding:'9px 10px',color:C.red}}>{fmt(ded)}</td>
                <td style={{padding:'9px 10px',color:C.purple,fontWeight:700}}>{Number(r.cash_advance_deduction)>0?fmt(r.cash_advance_deduction):'—'}</td>
                <td style={{padding:'9px 10px',fontWeight:900,color:C.darkGreen}}>{fmt(net)}</td>
                <td style={{padding:'9px 10px'}}><Badge label={r.status}/></td>
                <td style={{padding:'9px 10px'}}>
                  <div style={{display:'flex',gap:5}}>
                    <button onClick={()=>setShowPayslip({emp,rec:r})} style={{padding:'4px 9px',fontSize:9,fontWeight:700,background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:4,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>Payslip</button>
                    {canEdit&&<button onClick={()=>openEditRec(r)} style={{padding:'4px 9px',fontSize:9,fontWeight:700,background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>Edit</button>}
                  </div>
                </td>
              </tr>
              </Fragment>
            })}</tbody>
            <tfoot><tr style={{background:`${C.accent}0a`,borderTop:`2px solid ${C.accent}44`}}>
              <td colSpan={batchMode?4:3} style={{padding:'10px',fontWeight:900,fontSize:11,color:C.darkGreen,textTransform:'uppercase',letterSpacing:1}}>TOTALS{payrollPeriodFilter?' (filtered)':''}</td>
              <td style={{padding:'10px',fontWeight:900}}>{fmt(filteredRecords.reduce((s,r)=>s+calcGross(r.employees,r)+Number(r.allowance),0))}</td>
              <td style={{padding:'10px',fontWeight:900,color:C.accent}}>{fmt(filteredRecords.reduce((s,r)=>s+Number(r.allowance),0))}</td>
              <td style={{padding:'10px',fontWeight:900,color:C.red}}>{fmt(filteredRecords.reduce((s,r)=>s+Number(r.sss)+Number(r.philhealth)+Number(r.pagibig)+Number(r.tax),0))}</td>
              <td style={{padding:'10px',fontWeight:900,color:C.purple}}>{fmt(filteredRecords.reduce((s,r)=>s+Number(r.cash_advance_deduction||0),0))}</td>
              <td style={{padding:'10px',fontWeight:900,color:C.darkGreen,fontSize:13}}>{fmt(filteredRecords.reduce((s,r)=>s+calcNet(r.employees,r),0))}</td>
              <td colSpan={2}/>
            </tr></tfoot>
          </table>}
          {!loading && recordsPageCount > 1 && (
            <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:18}}>
              <button onClick={()=>setRecordsPage(p=>Math.max(1,p-1))} disabled={recordsCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:recordsCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:recordsCurrentPage===1?'default':'pointer'}}>← Prev</button>
              <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {recordsCurrentPage} of {recordsPageCount}</span>
              <button onClick={()=>setRecordsPage(p=>Math.min(recordsPageCount,p+1))} disabled={recordsCurrentPage===recordsPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:recordsCurrentPage===recordsPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:recordsCurrentPage===recordsPageCount?'default':'pointer'}}>Next →</button>
            </div>
          )}
          </>)})()}
          {batchMode && batchSelectedCount>0 && (
            <div style={{position:'sticky',bottom:16,marginTop:16,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10,background:C.dark,borderRadius:10,padding:'12px 20px',boxShadow:'0 4px 20px rgba(0,0,0,0.25)'}}>
              <span style={{color:C.white,fontSize:12,fontWeight:700}}>{batchSelectedCount} record{batchSelectedCount===1?'':'s'} selected</span>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <button onClick={async()=>{ const ids=Object.keys(batchSelected).filter(id=>batchSelected[id]); await supabase.from('payroll').update({status:'Paid'}).in('id',ids); await fetchAll() }} style={{padding:'9px 18px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit'}}>✓ Mark {batchSelectedCount} as Paid</button>
                <select value={batchStatusTarget} onChange={e=>setBatchStatusTarget(e.target.value)} style={{padding:'8px 10px',borderRadius:6,border:'none',fontSize:11,fontFamily:'inherit',fontWeight:700}}>
                  <option value="">Or set status to…</option>
                  <option value="Pending">Pending</option>
                  <option value="Paid">Paid</option>
                </select>
                <button onClick={updateBatchStatus} disabled={!batchStatusTarget} style={{padding:'9px 18px',background:batchStatusTarget?`linear-gradient(135deg,${C.accent},${C.midGreen})`:'#555',border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1,textTransform:'uppercase',cursor:batchStatusTarget?'pointer':'not-allowed',fontFamily:'inherit'}}>Apply</button>
                <button onClick={printBatchPayslips} style={{padding:'9px 22px',background:`linear-gradient(135deg,${C.purple},#6d28d9)`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit'}}>🖨 Print {batchSelectedCount} Payslip{batchSelectedCount===1?'':'s'} (4/page)</button>
              </div>
            </div>
          )}
          {canEdit && (
            <div style={{marginTop:32,paddingTop:20,borderTop:`1px dashed ${C.lightGray}`,display:'flex',justifyContent:'flex-end'}}>
              <button onClick={()=>{setClearRunId('');setShowClearModal(true)}} style={{padding:'8px 16px',background:'transparent',border:`1.5px solid ${C.red}55`,borderRadius:6,color:`${C.red}bb`,fontSize:10,fontWeight:700,letterSpacing:1,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit'}}>🗑 Clear Register</button>
            </div>
          )}
        </div>
      )}

      {/* ── CASH ADVANCES TAB ── */}
      {tab==='cash-advances'&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.amber},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Cash Advances</h2>
            </div>
            {canEdit&&<button onClick={()=>openNewCA()} style={{padding:'9px 20px',background:`linear-gradient(135deg,${C.amber},#b45309)`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit',boxShadow:`0 3px 10px ${C.amber}44`}}>+ New Cash Advance</button>}
          </div>
          <div style={{display:'flex',gap:4,marginBottom:14}}>
            {[
              {id:'all',label:`All (${cashAdvances.length})`,color:C.gray},
              {id:'open',label:`Open (${cashAdvances.filter(c=>c.status==='Open').length})`,color:C.amber},
              {id:'closed',label:`Closed (${cashAdvances.filter(c=>c.status==='Closed').length})`,color:C.accent},
            ].map(f=>(
              <button key={f.id} onClick={()=>setCaStatusFilter(f.id as any)}
                style={{padding:'6px 12px',borderRadius:20,border:`1.5px solid ${caStatusFilter===f.id?f.color:C.lightGray}`,background:caStatusFilter===f.id?`${f.color}18`:C.white,color:caStatusFilter===f.id?f.color:C.gray,fontSize:10,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>{f.label}</button>
            ))}
          </div>
          {(()=>{
            const filteredCA = caStatusFilter==='all'?cashAdvances:cashAdvances.filter(c=>caStatusFilter==='open'?c.status==='Open':c.status==='Closed')
            // Most-recent-first by date issued, falling back to created_at.
            const caSorted = [...filteredCA].sort((a,b)=>String(b.date_issued||b.created_at||'').localeCompare(String(a.date_issued||a.created_at||'')))
            const caPageCount = Math.max(1, Math.ceil(caSorted.length / PAGE_SIZE))
            const caCurrentPage = Math.min(caPage, caPageCount)
            const caPaged = caSorted.slice((caCurrentPage-1)*PAGE_SIZE, caCurrentPage*PAGE_SIZE)
            return (<>
          {!loading && filteredCA.length>0 && (
            <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>
              {`Showing ${(caCurrentPage-1)*PAGE_SIZE+1}–${Math.min(caCurrentPage*PAGE_SIZE, caSorted.length)} of ${caSorted.length}`}
            </div>
          )}
          {loading?<div style={{textAlign:'center',padding:40,color:C.gray}}>Loading…</div>
          :filteredCA.length===0?<div style={{textAlign:'center',padding:40,color:C.gray}}>No cash advances {caStatusFilter==='all'?'recorded':caStatusFilter==='open'?'open':'closed'}.</div>
          :<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
            <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
              {['Reference','Employee','Date Issued','Original Amount','Balance','Status','Actions'].map(h=>(
                <th key={h} style={{padding:'9px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>{caPaged.map((ca,i)=>(
              <tr key={ca.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                <td style={{padding:'9px 10px',fontWeight:800,color:C.darkGreen}}>{ca.id}</td>
                <td style={{padding:'9px 10px',fontWeight:700}}>{ca.employees?.name||'—'}</td>
                <td style={{padding:'9px 10px',color:C.gray}}>{ca.date_issued}</td>
                <td style={{padding:'9px 10px'}}>{fmt(ca.amount)}</td>
                <td style={{padding:'9px 10px',fontWeight:900,color:ca.status==='Open'?C.amber:C.accent}}>{fmt(ca.balance)}</td>
                <td style={{padding:'9px 10px'}}><Badge label={ca.status}/></td>
                <td style={{padding:'9px 10px'}}>
                  <div style={{display:'flex',gap:5}}>
                    <button onClick={()=>openLedger(ca)} style={{padding:'4px 9px',fontSize:9,fontWeight:700,background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>Ledger</button>
                    {canEdit&&ca.status==='Open'&&<button onClick={()=>{setShowPayModal(ca);setPayForm({amount:ca.balance,date:new Date().toISOString().slice(0,10),method:'Cash Payment',notes:''})}} style={{padding:'4px 9px',fontSize:9,fontWeight:700,background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:4,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>Record Payment</button>}
                    {canEdit&&<button onClick={()=>deleteCashAdvance(ca)} style={{padding:'4px 9px',fontSize:9,fontWeight:700,background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>Delete</button>}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>}
          {!loading && caPageCount > 1 && (
            <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:18}}>
              <button onClick={()=>setCaPage(p=>Math.max(1,p-1))} disabled={caCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:caCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:caCurrentPage===1?'default':'pointer'}}>← Prev</button>
              <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {caCurrentPage} of {caPageCount}</span>
              <button onClick={()=>setCaPage(p=>Math.min(caPageCount,p+1))} disabled={caCurrentPage===caPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:caCurrentPage===caPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:caCurrentPage===caPageCount?'default':'pointer'}}>Next →</button>
            </div>
          )}
          </>)
          })()}
        </div>
      )}

      {/* ── EMPLOYEES TAB ── */}
      {tab==='employees'&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Employee Directory</h2>
            </div>
            {canEdit&&<button onClick={openNewEmp} style={{padding:'9px 20px',background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',borderRadius:6,color:C.white,fontSize:11,fontWeight:800,letterSpacing:1.5,textTransform:'uppercase',cursor:'pointer',fontFamily:'inherit',boxShadow:`0 3px 10px ${C.accent}44`}}>+ Add Employee</button>}
          </div>
          <div style={{display:'flex',gap:4,marginBottom:14,flexWrap:'wrap'}}>
            {[
              {id:'active',label:`Active (${employees.filter(e=>e.status==='Active').length})`,color:C.accent},
              {id:'on-leave',label:`On Leave (${employees.filter(e=>e.status==='On Leave').length})`,color:C.amber},
              {id:'resigned',label:`Resigned (${employees.filter(e=>e.status==='Resigned').length})`,color:C.gray},
              {id:'terminated',label:`Terminated (${employees.filter(e=>e.status==='Terminated').length})`,color:C.red},
              {id:'all',label:`All (${employees.length})`,color:C.blue},
            ].map(f=>(
              <button key={f.id} onClick={()=>setEmpStatusFilter(f.id as any)}
                style={{padding:'6px 12px',borderRadius:20,border:`1.5px solid ${empStatusFilter===f.id?f.color:C.lightGray}`,background:empStatusFilter===f.id?`${f.color}18`:C.white,color:empStatusFilter===f.id?f.color:C.gray,fontSize:10,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>{f.label}</button>
            ))}
          </div>
          {(()=>{
            const filteredEmployees = [...employees].filter(e=>{
              if(empStatusFilter==='all') return true
              if(empStatusFilter==='active') return e.status==='Active'
              if(empStatusFilter==='on-leave') return e.status==='On Leave'
              if(empStatusFilter==='resigned') return e.status==='Resigned'
              if(empStatusFilter==='terminated') return e.status==='Terminated'
              return true
            })
            // No hire-date field exists on employees — most-recent-first by
            // created_at is the best available business signal.
            const employeesSorted = [...filteredEmployees].sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))
            const employeesPageCount = Math.max(1, Math.ceil(employeesSorted.length / PAGE_SIZE))
            const employeesCurrentPage = Math.min(employeesPage, employeesPageCount)
            const employeesPaged = employeesSorted.slice((employeesCurrentPage-1)*PAGE_SIZE, employeesCurrentPage*PAGE_SIZE)
            return (<>
          {filteredEmployees.length>0 && (
            <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>
              {`Showing ${(employeesCurrentPage-1)*PAGE_SIZE+1}–${Math.min(employeesCurrentPage*PAGE_SIZE, employeesSorted.length)} of ${employeesSorted.length}`}
            </div>
          )}
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:14}}>
            {[...employeesPaged].sort((a,b)=>(a.employment_type==='Salaried'?0:1)-(b.employment_type==='Salaried'?0:1)).map((emp,idx,arr)=>{
              const caBalance = employeeCABalance(emp.id)
              const loanBalance = employeeLoanBalance(emp.id)
              const showGroupHeader = idx===0 || arr[idx-1].employment_type!==emp.employment_type
              return (<Fragment key={emp.id}>
              {showGroupHeader && (
                <div style={{gridColumn:'1/-1',display:'flex',alignItems:'center',gap:8,marginTop:idx===0?0:8,marginBottom:2}}>
                  <span style={{fontSize:11,fontWeight:900,letterSpacing:1.5,color:emp.employment_type==='Salaried'?C.blue:C.accent,textTransform:'uppercase'}}>{emp.employment_type==='Salaried'?'Salaried':'Daily / Part-Time'}</span>
                  <div style={{flex:1,height:1,background:C.lightGray}}/>
                </div>
              )}
              <div key={emp.id}
                style={{border:`1.5px solid ${C.lightGray}`,borderRadius:10,padding:'16px 18px',transition:'all 0.2s'}}>
                <div onClick={()=>canEdit&&openEditEmp(emp)} style={{cursor:canEdit?'pointer':'default'}}>
                  <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:10}}>
                    <div style={{width:42,height:42,borderRadius:'50%',background:`linear-gradient(135deg,${C.darkGreen},${C.accent})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,fontWeight:900,color:C.white,flexShrink:0}}>
                      {emp.name.split(' ').map((n:string)=>n[0]).slice(0,2).join('')}
                    </div>
                    <div>
                      <div style={{fontWeight:900,fontSize:13,color:C.dark,lineHeight:1.2}}>{emp.name}</div>
                      <div style={{fontSize:10,color:C.accent,fontWeight:700,letterSpacing:0.5,marginTop:2}}>{emp.role}</div>
                    </div>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                    <span style={{fontSize:11,color:C.gray}}>{emp.department}</span>
                    <div style={{display:'flex',gap:5,flexWrap:'wrap',justifyContent:'flex-end'}}>
                      {emp.status && emp.status !== 'Active' && (
                        <span style={{padding:'2px 8px',borderRadius:20,background:`${C.red}18`,color:C.red,fontSize:10,fontWeight:800,border:`1px solid ${C.red}33`}}>{emp.status}</span>
                      )}
                      {emp.employment_status && emp.employment_status !== 'Regular' && (
                        <span style={{padding:'2px 8px',borderRadius:20,background:`${C.amber}18`,color:C.amber,fontSize:10,fontWeight:800,border:`1px solid ${C.amber}33`}}>{emp.employment_status}</span>
                      )}
                      <span style={{padding:'2px 8px',borderRadius:20,background:`${C.blue}18`,color:C.blue,fontSize:10,fontWeight:800,border:`1px solid ${C.blue}33`}}>{emp.employment_type}</span>
                    </div>
                  </div>
                  <div style={{fontSize:11,color:C.gray}}>{emp.contact}</div>
                  <div style={{fontSize:12,fontWeight:800,color:C.accent,marginTop:4}}>{fmt(emp.rate)}{emp.employment_type==='Salaried'?'/mo':'/day'}</div>
                  {emp.employment_type==='Salaried' && <div style={{fontSize:10,color:C.gray,marginTop:1}}>{fmt(Number(emp.rate)/2)}/cutoff</div>}
                  {(()=>{ const used=leaveRecords.filter(l=>l.employee_id===emp.id).length; const allot=emp.vl_allotment??5; const remaining=allot-used
                    return <div style={{fontSize:10,color:remaining<0?C.red:C.blue,fontWeight:700,marginTop:4}}>🗓 Leave: {remaining} of {allot} left</div>
                  })()}
                </div>
                {caBalance>0 && (
                  <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${C.lightGray}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span style={{fontSize:10,color:C.amber,fontWeight:800}}>⚠ CA Balance: {fmt(caBalance)}</span>
                    {canEdit&&<button onClick={()=>openNewCA(emp.id)} style={{fontSize:9,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',textDecoration:'underline'}}>+ new advance</button>}
                  </div>
                )}
                {caBalance===0 && canEdit && (
                  <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${C.lightGray}`}}>
                    <button onClick={()=>openNewCA(emp.id)} style={{fontSize:10,fontWeight:700,color:C.gray,background:'none',border:'none',cursor:'pointer'}}>+ Issue cash advance</button>
                  </div>
                )}
                {loanBalance>0 && (
                  <div style={{marginTop:caBalance>0?4:10,paddingTop:caBalance>0?0:10,borderTop:caBalance>0?'none':`1px solid ${C.lightGray}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span style={{fontSize:10,color:C.purple,fontWeight:800}}>⚠ Loan Balance: {fmt(loanBalance)}</span>
                    {canEdit&&<button onClick={()=>openNewLoan(emp.id)} style={{fontSize:9,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',textDecoration:'underline'}}>+ new loan</button>}
                  </div>
                )}
                {loanBalance===0 && canEdit && (
                  <div style={{marginTop:caBalance===0?4:10,paddingTop:caBalance===0?0:10,borderTop:caBalance===0?'none':`1px solid ${C.lightGray}`}}>
                    <button onClick={()=>openNewLoan(emp.id)} style={{fontSize:10,fontWeight:700,color:C.gray,background:'none',border:'none',cursor:'pointer'}}>+ Issue loan</button>
                  </div>
                )}
              </div>
              </Fragment>
            )})}
          </div>
          {employeesPageCount > 1 && (
            <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:18}}>
              <button onClick={()=>setEmployeesPage(p=>Math.max(1,p-1))} disabled={employeesCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:employeesCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:employeesCurrentPage===1?'default':'pointer'}}>← Prev</button>
              <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {employeesCurrentPage} of {employeesPageCount}</span>
              <button onClick={()=>setEmployeesPage(p=>Math.min(employeesPageCount,p+1))} disabled={employeesCurrentPage===employeesPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:employeesCurrentPage===employeesPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:employeesCurrentPage===employeesPageCount?'default':'pointer'}}>Next →</button>
            </div>
          )}
          </>)
          })()}
        </div>
      )}

      {/* ── ATTENDANCE TAB ── */}
      {(tab==='attendance'||(splitView&&tab==='payroll'))&&(
        <div style={{display:'flex',flexDirection:'column',gap:18}}>
          <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.blue},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Import from Biometric Device</h2>
            </div>
            <div style={{fontSize:11,color:C.gray,marginBottom:14}}>
              Upload the CSV/Excel export from your time reader. Formats vary by device, so you'll confirm which column means what before anything is saved.
            </div>

            {importStep==='upload' && canEdit && (
              <label style={{display:'inline-block',padding:'10px 20px',background:`${C.blue}18`,border:`1.5px dashed ${C.blue}44`,color:C.blue,borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700}}>
                📁 Choose File (.csv, .xlsx)
                <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} style={{display:'none'}}/>
              </label>
            )}

            {importStep==='map' && importMode==='biometric' && (
              <div>
                <div style={{fontSize:11,fontWeight:800,color:C.gray,textTransform:'uppercase',marginBottom:6}}>Confirm Employee Mapping ({biometricParsed.length} people found)</div>
                <div style={{fontSize:10,color:C.gray,marginBottom:10}}>The biometric device uses its own ID numbers — match each one to your employee record. This is remembered for future imports.</div>
                <div style={{maxHeight:320,overflowY:'auto',border:`1px solid ${C.lightGray}`,borderRadius:8,marginBottom:14}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:C.lightGray,position:'sticky',top:0}}>
                      {['Biometric ID','Name (device)','Dept.','Maps To'].map(h=><th key={h} style={{padding:'6px 10px',textAlign:'left',fontWeight:800}}>{h}</th>)}
                    </tr></thead>
                    <tbody>{biometricParsed.map(p=>(
                      <tr key={p.biometricId} style={{borderBottom:`1px solid ${C.lightGray}`,background:biometricMapping[p.biometricId]?'#fff':`${C.amber}10`}}>
                        <td style={{padding:'5px 10px',fontWeight:700}}>{p.biometricId}</td>
                        <td style={{padding:'5px 10px'}}>{p.name}</td>
                        <td style={{padding:'5px 10px',color:C.gray}}>{p.dept}</td>
                        <td style={{padding:'5px 10px'}}>
                          <select value={biometricMapping[p.biometricId]||''} onChange={e=>setBiometricMapping(m=>({...m,[p.biometricId]:e.target.value}))}
                            style={{width:'100%',padding:'5px 8px',border:`1.5px solid ${biometricMapping[p.biometricId]?C.lightGray:C.amber}`,borderRadius:6,fontSize:11,fontFamily:'inherit'}}>
                            <option value="">— Skip this person —</option>
                            {employees.map(emp=><option key={emp.id} value={emp.id}>{emp.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>{setImportStep('upload');setBiometricParsed([]);setBiometricMapping({})}} style={{padding:'8px 16px',fontSize:11,fontWeight:700,border:`1.5px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer'}}>Cancel</button>
                  <button onClick={()=>setImportStep('preview')} style={{padding:'8px 20px',fontSize:11,fontWeight:800,background:`${C.blue}18`,border:`1.5px solid ${C.blue}44`,color:C.blue,borderRadius:6,cursor:'pointer'}}>Preview →</button>
                </div>
              </div>
            )}

            {importStep==='map' && importMode==='generic' && (
              <div>
                <div style={{fontSize:11,fontWeight:800,color:C.gray,textTransform:'uppercase',marginBottom:10}}>Map Columns ({importRows.length} rows detected)</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:10,marginBottom:14}}>
                  {(['employee','date','timeIn','timeOut'] as const).map(k=>(
                    <div key={k}>
                      <label style={{fontSize:9,fontWeight:700,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:4}}>
                        {({employee:'Employee ID',date:'Date',timeIn:'Time In',timeOut:'Time Out'})[k]}
                      </label>
                      <select value={colMap[k]} onChange={e=>setColMap(p=>({...p,[k]:e.target.value}))}
                        style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}>
                        <option value="">Select column…</option>
                        {importHeaders.map(h=><option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>{setImportStep('upload');setImportRows([]);setImportHeaders([])}} style={{padding:'8px 16px',fontSize:11,fontWeight:700,border:`1.5px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer'}}>Cancel</button>
                  <button onClick={()=>setImportStep('preview')} disabled={!colMap.employee||!colMap.date} style={{padding:'8px 20px',fontSize:11,fontWeight:800,background:`${C.blue}18`,border:`1.5px solid ${C.blue}44`,color:C.blue,borderRadius:6,cursor:'pointer',opacity:(!colMap.employee||!colMap.date)?0.5:1}}>Preview →</button>
                </div>
              </div>
            )}

            {importStep==='preview' && importMode==='biometric' && (()=>{ const norm = normalizedBiometricRows(); const flagged = norm.filter(r=>r.needs_review).length; return (
              <div>
                <div style={{fontSize:11,fontWeight:800,color:C.gray,textTransform:'uppercase',marginBottom:6}}>Preview — {norm.length} records{flagged>0?`, ${flagged} flagged`:''}</div>
                {flagged>0 && <div style={{fontSize:10,color:C.amber,marginBottom:10}}>⚠ Rows highlighted below have an irregular punch pattern (missing time-out, or an unusual number of punches). They'll still import, but need a clerk's review before payslips print clean.</div>}
                <div style={{maxHeight:340,overflowY:'auto',border:`1px solid ${C.lightGray}`,borderRadius:8,marginBottom:14}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:C.lightGray,position:'sticky',top:0}}>
                      {['Employee','Date','Time In','Time Out','Hours','Raw Punches'].map(h=><th key={h} style={{padding:'6px 10px',textAlign:'left',fontWeight:800}}>{h}</th>)}
                    </tr></thead>
                    <tbody>{norm.map((r,i)=>(
                      <tr key={i} style={{borderBottom:`1px solid ${C.lightGray}`,background:r.needs_review?`${C.red}12`:'transparent'}}>
                        <td style={{padding:'5px 10px',fontWeight:700}}>{r.name}</td>
                        <td style={{padding:'5px 10px'}}>{r.date}</td>
                        <td style={{padding:'5px 10px'}}>{r.time_in||'—'}</td>
                        <td style={{padding:'5px 10px'}}>{r.time_out||<span style={{color:C.red,fontWeight:700}}>missing</span>}</td>
                        <td style={{padding:'5px 10px',fontWeight:700}}>{r.hours_worked}</td>
                        <td style={{padding:'5px 10px',color:r.needs_review?C.red:C.gray,fontSize:10}}>{r.needs_review?`⚠ ${r.raw_punches}`:''}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>setImportStep('map')} style={{padding:'8px 16px',fontSize:11,fontWeight:700,border:`1.5px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer'}}>← Back</button>
                  <button onClick={commitBiometricImport} disabled={attSaving} style={{padding:'8px 20px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer'}}>{attSaving?'Importing…':`Import ${norm.length} Records`}</button>
                </div>
              </div>
            )})()}

            {importStep==='preview' && importMode==='generic' && (()=>{ const norm = normalizedImportRows(); return (
              <div>
                <div style={{fontSize:11,fontWeight:800,color:C.gray,textTransform:'uppercase',marginBottom:10}}>Preview — {norm.length} valid records</div>
                <div style={{maxHeight:300,overflowY:'auto',border:`1px solid ${C.lightGray}`,borderRadius:8,marginBottom:14}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:C.lightGray,position:'sticky',top:0}}>
                      {['Employee ID','Date','Time In','Time Out','Hours'].map(h=><th key={h} style={{padding:'6px 10px',textAlign:'left',fontWeight:800}}>{h}</th>)}
                    </tr></thead>
                    <tbody>{norm.slice(0,100).map((r,i)=>{ const tin=clampToShiftStart(r.time_in,r.date); return (
                      <tr key={i} style={{borderBottom:`1px solid ${C.lightGray}`}}>
                        <td style={{padding:'5px 10px'}}>{r.employee_id}</td>
                        <td style={{padding:'5px 10px'}}>{r.date}</td>
                        <td style={{padding:'5px 10px'}}>{tin||'—'}</td>
                        <td style={{padding:'5px 10px'}}>{r.time_out||'—'}</td>
                        <td style={{padding:'5px 10px',fontWeight:700}}>{computeHours(tin,r.time_out,60)}</td>
                      </tr>
                    )})}</tbody>
                  </table>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>setImportStep('map')} style={{padding:'8px 16px',fontSize:11,fontWeight:700,border:`1.5px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer'}}>← Back</button>
                  <button onClick={commitImport} disabled={attSaving} style={{padding:'8px 20px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer'}}>{attSaving?'Importing…':`Import ${norm.length} Records`}</button>
                </div>
              </div>
            )})()}
          </div>

          <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:10}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.accent},${C.darkGreen})`,borderRadius:2}}/>
                <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Attendance Records</h2>
              </div>
              <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                <div style={{display:'flex',gap:4}}>
                  {[
                    {id:'all',label:`All (${attendanceLogs.length})`,color:C.gray},
                    {id:'review',label:`⚠ To Review (${attendanceLogs.filter(a=>a.needs_review).length})`,color:C.red},
                    {id:'missing',label:`Missing Time-Out (${attendanceLogs.filter(a=>!a.time_out).length})`,color:C.amber},
                  ].map(f=>(
                    <button key={f.id} onClick={()=>setAttStatusFilter(f.id as any)}
                      style={{padding:'6px 12px',borderRadius:20,border:`1.5px solid ${attStatusFilter===f.id?f.color:C.lightGray}`,background:attStatusFilter===f.id?`${f.color}18`:C.white,color:attStatusFilter===f.id?f.color:C.gray,fontSize:10,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>{f.label}</button>
                  ))}
                </div>
                <select value={attEmpFilter} onChange={e=>setAttEmpFilter(e.target.value)} style={{padding:'6px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:11,fontFamily:'inherit',maxWidth:180}}>
                  <option value="">All Employees</option>
                  {employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <input type="date" value={attFrom} onChange={e=>setAttFrom(e.target.value)} style={{padding:'6px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:11}}/>
                <span style={{fontSize:11,color:C.gray}}>to</span>
                <input type="date" value={attTo} onChange={e=>setAttTo(e.target.value)} style={{padding:'6px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:11}}/>
                {canEdit && <button onClick={()=>{setManualAtt({employee_id:'',date:new Date().toISOString().slice(0,10),time_in:'08:00',time_out:'17:00',break_minutes:60,straight_time:false,leave_type:'',manual_ot_minutes:0});setManualAttMulti([]);setOtMode('duration');setOtHoursIn(0);setOtMinsIn(0);setOtUntilTime('');setEditingAttId(null);setShowManualAtt(true)}} style={{padding:'7px 14px',fontSize:11,fontWeight:700,background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:6,cursor:'pointer',whiteSpace:'nowrap'}}>+ Manual Entry</button>}
                {canEdit && <button onClick={()=>{setAttBatchMode(m=>!m);setAttBatchSelected({})}} style={{padding:'7px 14px',fontSize:11,fontWeight:700,background:attBatchMode?`linear-gradient(135deg,${C.red},#b91c1c)`:C.white,border:`1.5px solid ${C.red}`,color:attBatchMode?C.white:C.red,borderRadius:6,cursor:'pointer',whiteSpace:'nowrap'}}>{attBatchMode?'✕ Cancel':'☑ Select'}</button>}
              </div>
            </div>
            {(()=>{
              let filteredAtt = attEmpFilter ? attendanceLogs.filter(a=>a.employee_id===attEmpFilter) : attendanceLogs
              if (attStatusFilter==='review') filteredAtt = filteredAtt.filter(a=>a.needs_review)
              if (attStatusFilter==='missing') filteredAtt = filteredAtt.filter(a=>!a.time_out)
              // Most-recent-first by the log's own date, falling back to created_at.
              const attSorted = [...filteredAtt].sort((a,b)=>String(b.date||b.created_at||'').localeCompare(String(a.date||a.created_at||'')))
              const attPageCount = Math.max(1, Math.ceil(attSorted.length / PAGE_SIZE))
              const attCurrentPage = Math.min(attPage, attPageCount)
              const attPaged = attSorted.slice((attCurrentPage-1)*PAGE_SIZE, attCurrentPage*PAGE_SIZE)
              return (<>
            {attBatchMode && Object.values(attBatchSelected).some(Boolean) && (
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:`${C.red}12`,border:`1.5px solid ${C.red}44`,borderRadius:8,padding:'10px 14px',marginBottom:12}}>
                <span style={{fontSize:12,fontWeight:700,color:C.red}}>{Object.values(attBatchSelected).filter(Boolean).length} record(s) selected</span>
                <button onClick={deleteAttBatch} style={{padding:'7px 16px',fontSize:11,fontWeight:800,background:C.red,border:'none',color:C.white,borderRadius:6,cursor:'pointer'}}>🗑 Delete Selected</button>
              </div>
            )}
            {filteredAtt.length>0 && (
              <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>
                {`Showing ${(attCurrentPage-1)*PAGE_SIZE+1}–${Math.min(attCurrentPage*PAGE_SIZE, attSorted.length)} of ${attSorted.length}`}
              </div>
            )}
            {filteredAtt.length===0?<div style={{textAlign:'center',padding:30,color:C.gray,fontSize:12}}>No attendance records in this range.</div>
            :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                {attBatchMode && <th style={{padding:'8px 10px'}}><input type="checkbox" checked={filteredAtt.length>0 && filteredAtt.every(a=>attBatchSelected[a.id])} onChange={e=>{ const next:Record<string,boolean>={}; if(e.target.checked) filteredAtt.forEach(a=>next[a.id]=true); setAttBatchSelected(next) }}/></th>}
                {['Employee','Date','Time In','Time Out','Hours','Source','Actions'].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
              </tr></thead>
              <tbody>{attPaged.map((a,i)=>{
                const hol = holidays.find(h=>h.date===a.date)
                return <tr key={a.id} style={{background:a.needs_review?`${C.red}12`:(i%2===0?C.white:'#f9fbf9'),borderBottom:`1px solid ${C.lightGray}`,borderLeft:a.needs_review?`3px solid ${C.red}`:'none'}}>
                  {attBatchMode && <td style={{padding:'7px 10px'}}><input type="checkbox" checked={!!attBatchSelected[a.id]} onChange={()=>toggleAttBatch(a.id)}/></td>}
                  <td style={{padding:'7px 10px',fontWeight:700}}>{a.employees?.name||a.employee_id}{a.needs_review&&<span title={a.raw_punches?`Raw punches: ${a.raw_punches}`:'Needs review'} style={{marginLeft:6,fontSize:9,color:C.red,fontWeight:800}}>⚠ REVIEW</span>}</td>
                  <td style={{padding:'7px 10px',color:C.gray}}>{a.date}{hol&&<span title={hol.name} style={{marginLeft:6,fontSize:9,color:C.red,fontWeight:800}}>🎌 {hol.type==='regular'?'Reg. Hol.':hol.type==='special_non_working'?'Spec. Hol.':'Spec. Working'}</span>}</td>
                  <td style={{padding:'7px 10px'}}>{a.time_in||'—'}</td>
                  <td style={{padding:'7px 10px'}}>{a.time_out||<span style={{color:C.red,fontWeight:700}}>missing</span>}</td>
                  <td style={{padding:'7px 10px',fontWeight:700}}>{a.hours_worked??'—'}</td>
                  <td style={{padding:'7px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,background:a.source==='biometric_import'?`${C.blue}18`:`${C.gray}18`,color:a.source==='biometric_import'?C.blue:C.gray,fontSize:9,fontWeight:800}}>{a.source==='biometric_import'?'Biometric':'Manual'}</span></td>
                  <td style={{padding:'7px 10px',display:'flex',gap:6}}>
                    {canEdit&&a.needs_review&&<button onClick={()=>resolveAttendanceReview(a)} title="Confirm OT hours for this day and clear the flag" style={{background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:4,padding:'3px 8px',cursor:'pointer',fontSize:10,fontWeight:700}}>✓ Resolve</button>}
                    {canEdit&&<button onClick={()=>openEditAtt(a)} title="Correct this day's time (e.g. straight time for client visits)" style={{background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:4,padding:'3px 8px',cursor:'pointer',fontSize:10,fontWeight:700}}>✎ Edit</button>}
                    {canEdit&&<button onClick={()=>deleteAttendance(a.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'3px 8px',cursor:'pointer',fontSize:10}}>✕</button>}
                  </td>
                </tr>
              })}</tbody>
            </table>}
            {attPageCount > 1 && (
              <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:18}}>
                <button onClick={()=>setAttPage(p=>Math.max(1,p-1))} disabled={attCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:attCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:attCurrentPage===1?'default':'pointer'}}>← Prev</button>
                <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {attCurrentPage} of {attPageCount}</span>
                <button onClick={()=>setAttPage(p=>Math.min(attPageCount,p+1))} disabled={attCurrentPage===attPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:attCurrentPage===attPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:attCurrentPage===attPageCount?'default':'pointer'}}>Next →</button>
              </div>
            )}
            </>)})()}
          </div>
        </div>
      )}
      </div>

      {/* ── LEAVE TRACKER TAB ── */}
      {tab==='leave-tracker'&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:10}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.blue},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Leave Tracker</h2>
            </div>
            <select value={leaveYear} onChange={e=>setLeaveYear(Number(e.target.value))} style={{padding:'7px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}>
              {[0,1,2].map(i=>{ const y=new Date().getFullYear()-i; return <option key={y} value={y}>{y}</option> })}
            </select>
          </div>
          <div style={{fontSize:11,color:C.gray,marginBottom:14}}>VL and SL are tracked as one combined leave pool. Allotment is editable per employee. Hover "Used" to see the exact dates taken, grouped by month.</div>

          {(()=>{
            const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
            const forEmp = (empId:string) => leaveRecords.filter(l=>l.employee_id===empId)
            const byMonth = (records:any[]) => {
              const groups: Record<string,string[]> = {}
              records.forEach(r=>{
                const m = monthNames[Number(r.date.slice(5,7))-1]
                if(!groups[m]) groups[m]=[]
                groups[m].push(`${r.date.slice(8,10)} (${r.leave_type})`)
              })
              return groups
            }
            return (
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                  {['Employee','Leave Allotment','Used','Remaining'].map(h=>
                    <th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                </tr></thead>
                <tbody>{employees.filter(e=>e.status==='Active').map((emp,i)=>{
                  const recs = forEmp(emp.id)
                  const used = recs.length
                  const allot = emp.vl_allotment ?? 5
                  const groups = byMonth(recs)
                  const tooltipText = Object.entries(groups).map(([m,days])=>`${m}: ${days.join(', ')}`).join('\n') || 'No leave taken'
                  return (
                    <tr key={emp.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                      <td style={{padding:'8px 12px',fontWeight:700}}>{emp.name}</td>
                      <td style={{padding:'8px 12px'}}><input type="number" value={allot} onChange={e=>updateLeaveAllotment(emp.id,'vl_allotment',Number(e.target.value))} onFocus={e=>e.target.select()} disabled={!canEdit} style={{width:60,padding:'4px 6px',border:`1.5px solid ${C.lightGray}`,borderRadius:4,fontSize:11}}/></td>
                      <td style={{padding:'8px 12px',fontWeight:700,color:C.blue,cursor:used>0?'help':'default'}} title={tooltipText}>{used}{used>0 && ' ℹ'}</td>
                      <td style={{padding:'8px 12px',fontWeight:800,color:allot-used<0?C.red:C.accent}}>{allot-used}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            )
          })()}
        </div>
      )}


      {/* ── PAYROLL RECORD (MONTHLY PER YEAR) TAB ── */}
      {tab==='payroll-yearly'&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:10}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.blue},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Payroll Record — {reportYear}</h2>
            </div>
            <select value={reportYear} onChange={e=>setReportYear(Number(e.target.value))} style={{padding:'7px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}>
              {[0,1,2].map(i=>{ const y=new Date().getFullYear()-i; return <option key={y} value={y}>{y}</option> })}
            </select>
          </div>
          <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Total net pay per employee, by month (both cutoffs combined). Mirrors the "PAYROLL RECORD" sheet.</div>
          {(()=>{
            const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
            const empIds = Array.from(new Set(yearlyPayroll.map((r:any)=>r.employee_id)))
            const empRows = empIds.map(id=>employees.find(e=>e.id===id)).filter(Boolean) as any[]
            const netForMonth = (empId:string, monthIdx:number) => yearlyPayroll
              .filter((r:any)=>r.employee_id===empId && Number((r.payroll_runs?.period_start||'').slice(5,7))===monthIdx+1)
              .reduce((s:number,r:any)=>s+calcNet(r.employees,r),0)
            return (
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                  <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                    <th style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',position:'sticky',left:0,background:C.darkGreen}}>Employee</th>
                    {monthNames.map(m=><th key={m} style={{padding:'8px 10px',textAlign:'right',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase',whiteSpace:'nowrap'}}>{m}</th>)}
                    <th style={{padding:'8px 10px',textAlign:'right',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>Total</th>
                  </tr></thead>
                  <tbody>{empRows.length===0
                    ? <tr><td colSpan={14} style={{textAlign:'center',padding:30,color:C.gray}}>No payroll records for {reportYear}.</td></tr>
                    : empRows.map((emp,i)=>{
                      const monthVals = monthNames.map((_,mi)=>netForMonth(emp.id,mi))
                      const yearTotal = monthVals.reduce((s,v)=>s+v,0)
                      return (
                        <tr key={emp.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                          <td style={{padding:'7px 10px',fontWeight:700,position:'sticky',left:0,background:i%2===0?C.white:'#f9fbf9'}}>{emp.name}</td>
                          {monthVals.map((v,mi)=><td key={mi} style={{padding:'7px 10px',textAlign:'right',color:v>0?C.dark:C.lightGray}}>{v>0?fmt(v):'—'}</td>)}
                          <td style={{padding:'7px 10px',textAlign:'right',fontWeight:900,color:C.darkGreen}}>{fmt(yearTotal)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  {empRows.length>0 && (()=>{
                    const monthTotals = monthNames.map((_,mi)=>empRows.reduce((s,emp)=>s+netForMonth(emp.id,mi),0))
                    const grandTotal = monthTotals.reduce((s,v)=>s+v,0)
                    return (
                      <tfoot>
                        <tr style={{background:'#eef5f0',borderTop:`2px solid ${C.darkGreen}`}}>
                          <td style={{padding:'9px 10px',fontWeight:900,color:C.dark,position:'sticky',left:0,background:'#eef5f0'}}>Total</td>
                          {monthTotals.map((v,mi)=><td key={mi} style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:v>0?C.dark:C.lightGray}}>{v>0?fmt(v):'—'}</td>)}
                          <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:C.darkGreen}}>{fmt(grandTotal)}</td>
                        </tr>
                      </tfoot>
                    )
                  })()}
                </table>
              </div>
            )
          })()}
        </div>
      )}

      {/* ── 13TH MONTH PAY TAB ── */}
      {tab==='thirteenth-month'&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:10}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.amber},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>13th Month Pay — {reportYear}</h2>
            </div>
            <select value={reportYear} onChange={e=>setReportYear(Number(e.target.value))} style={{padding:'7px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}>
              {[0,1,2].map(i=>{ const y=new Date().getFullYear()-i; return <option key={y} value={y}>{y}</option> })}
            </select>
          </div>
          <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Formula: Total Basic Salary Earned this year ÷ 12 — computed only from actual recorded payroll (no employee shown here unless they have at least one saved payroll record for {reportYear}). Editable per employee if the computed figure needs a manual correction.</div>
          {(()=>{
            const empIds = Array.from(new Set(yearlyPayroll.map((r:any)=>r.employee_id)))
            const empRows = empIds.map(id=>employees.find(e=>e.id===id)).filter(Boolean) as any[]
            // Basic salary actually earned per record — must branch the same
            // way calcGross() does: Salaried employees earn a fixed rate/2
            // every cutoff regardless of days worked, so days_worked×rate
            // (a daily-paid formula) wildly overstates their basic pay here.
            // Non-salaried employees use the real stored regular_pay (same
            // preference calcGross gives it) rather than re-deriving it.
            const basicSalaryForYear = (emp:any) => yearlyPayroll
              .filter((r:any)=>r.employee_id===emp.id)
              .reduce((s:number,r:any)=>s+(emp.employment_type==='Salaried' ? Number(emp.rate)/2 : (r.regular_pay!=null ? Number(r.regular_pay) : Number(emp.rate)*Number(r.days_worked||0))),0)
            const overrideFor = (empId:string) => thirteenthOverrides.find(o=>o.employee_id===empId)
            const effectiveFor = (emp:any) => { const ov=overrideFor(emp.id); return ov ? Number(ov.amount) : round2(basicSalaryForYear(emp)/12) }
            return (
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                  {['Employee','Total Basic Salary Earned','Computed (÷12)','13th Month Pay (editable)'].map(h=>
                    <th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                </tr></thead>
                <tbody>{empRows.length===0
                  ? <tr><td colSpan={4} style={{textAlign:'center',padding:30,color:C.gray}}>No payroll records for {reportYear}.</td></tr>
                  : empRows.map((emp,i)=>{
                    const totalBasic = basicSalaryForYear(emp)
                    const computed = round2(totalBasic/12)
                    const ov = overrideFor(emp.id)
                    return (
                      <tr key={emp.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                        <td style={{padding:'8px 12px',fontWeight:700}}>{emp.name}</td>
                        <td style={{padding:'8px 12px'}}>{fmt(totalBasic)}</td>
                        <td style={{padding:'8px 12px',color:C.gray}}>{fmt(computed)}</td>
                        <td style={{padding:'8px 12px'}}>
                          <div style={{display:'flex',alignItems:'center',gap:6}}>
                            <input type="number" defaultValue={ov?Number(ov.amount):computed} onFocus={e=>e.target.select()} onBlur={e=>{
                              const val=Number(e.target.value)
                              if(val===computed && !ov) return
                              saveThirteenthOverride(emp.id,val)
                            }} style={{width:120,padding:'6px 8px',border:`1.5px solid ${ov?C.amber:C.lightGray}`,borderRadius:6,fontSize:12,fontWeight:800,color:ov?C.amber:C.dark}}/>
                            {ov && <span title="Manually overridden — differs from the computed value" style={{fontSize:10,color:C.amber}}>✎</span>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {empRows.length>0 && (
                  <tfoot><tr style={{background:`${C.amber}0a`,borderTop:`2px solid ${C.amber}44`}}>
                    <td style={{padding:'10px 12px',fontWeight:900,color:C.darkGreen,textTransform:'uppercase',fontSize:11}}>Total 13th Month Payout</td>
                    <td/><td/>
                    <td style={{padding:'10px 12px',fontWeight:900,color:C.amber,fontSize:13}}>{fmt(empRows.reduce((s,emp)=>s+effectiveFor(emp),0))}</td>
                  </tr></tfoot>
                )}
              </table>
            )
          })()}
        </div>
      )}

      {/* ── HOLIDAYS TAB ── */}
      {tab==='holidays'&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.red},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Holiday Calendar</h2>
            </div>
            {canEdit && <button onClick={()=>{setHolidayForm({date:'',name:'',type:'regular'});setEditingHoliday(false);setShowHolidayModal(true)}} style={{padding:'9px 18px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.red},#b91c1c)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',letterSpacing:1}}>+ Add Holiday</button>}
          </div>
          <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Attendance on these dates auto-applies the matching pay rule (200% regular, 130% special) — overridable per record if a day needs different treatment.</div>
          {holidays.length===0?<div style={{textAlign:'center',padding:30,color:C.gray,fontSize:12}}>No holidays configured yet.</div>
          :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
              {['Date','Name','Type','Actions'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
            </tr></thead>
            <tbody>{holidays.map((h,i)=>(
              <tr key={h.id} onClick={()=>canEdit&&openEditHoliday(h)} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`,cursor:canEdit?'pointer':'default'}}>
                <td style={{padding:'8px 12px',fontWeight:700}}>{h.date}</td>
                <td style={{padding:'8px 12px'}}>{h.name}</td>
                <td style={{padding:'8px 12px'}}>
                  <span style={{padding:'3px 10px',borderRadius:20,fontSize:10,fontWeight:800,background:h.type==='regular'?`${C.red}18`:h.type==='special_non_working'?`${C.amber}18`:`${C.blue}18`,color:h.type==='regular'?C.red:h.type==='special_non_working'?C.amber:C.blue}}>
                    {h.type==='regular'?'Regular Holiday':h.type==='special_non_working'?'Special Non-Working':'Special Working'}
                  </span>
                </td>
                <td style={{padding:'8px 12px',display:'flex',gap:6}} onClick={e=>e.stopPropagation()}>
                  {canEdit&&<button onClick={()=>openEditHoliday(h)} style={{background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:4,padding:'4px 10px',cursor:'pointer',fontSize:10,fontWeight:700}}>Edit</button>}
                  {canEdit&&<button onClick={()=>deleteHoliday(h.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'4px 10px',cursor:'pointer',fontSize:10,fontWeight:700}}>Delete</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>}
        </div>
      )}

      {/* ── CONTRIBUTIONS TAB ── */}
      {tab==='contributions'&&(
        <div style={{display:'flex',flexDirection:'column',gap:18}}>
          {contribFetchError && (
            <div style={{background:`${C.red}12`,border:`1.5px solid ${C.red}44`,borderRadius:10,padding:'14px 18px',color:C.red,fontSize:12,fontWeight:600}}>
              ⚠ Could not load contribution tables: <b>{contribFetchError}</b><br/>
              <span style={{fontWeight:400}}>This means the underlying database tables likely don't exist yet — re-run the Payroll SQL migration in Supabase (sss_brackets / contribution_settings / company_deductions), then reload this page.</span>
            </div>
          )}
          <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.purple},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>SSS Contribution Table</h2>
            </div>
            <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Sourced from the official 2025 SSS circular. This table is read-only in the app — if SSS issues a new schedule, it gets updated directly in the database, not edited here, to avoid a mistyped number silently throwing off everyone's deduction.</div>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,marginBottom:14}}>
              <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                {['Salary From','Salary To','Employee Contribution'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
              </tr></thead>
              <tbody>{sssBrackets.map((b,i)=>(
                <tr key={b.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                  <td style={{padding:'7px 12px'}}>{fmt(b.salary_from)}</td>
                  <td style={{padding:'7px 12px'}}>{b.salary_to==null?'No cap':fmt(b.salary_to)}</td>
                  <td style={{padding:'7px 12px',fontWeight:700,color:C.purple}}>{fmt(b.ee_contribution)}</td>
                </tr>
              ))}</tbody>
            </table>
            {sssBrackets.length===0 && <div style={{textAlign:'center',padding:20,color:C.red,fontSize:12,fontWeight:700}}>⚠ No brackets loaded — this table is empty. Contact your developer to run the SSS bracket seed script.</div>}
          </div>

          <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.blue},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>PhilHealth & Pag-IBIG Settings</h2>
            </div>
            <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Flat amount deducted per cutoff. Individual exemptions (PhilHealth) and doubling (Pag-IBIG) are set per employee in the Employee Directory.</div>
            {contribSettings.length===0 ? (
              <div style={{textAlign:'center',padding:20}}>
                <div style={{fontSize:12,color:C.gray,marginBottom:10}}>No settings found — the default seed rows may not have been created yet.</div>
                {canEdit && <button onClick={initContribDefaults} style={{padding:'8px 18px',fontSize:11,fontWeight:800,background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:6,cursor:'pointer'}}>Initialize Default Settings</button>}
              </div>
            ) : contribSettings.map(cs=>(
              <div key={cs.key} style={{display:'flex',alignItems:'center',gap:16,marginBottom:10,padding:'10px 0',borderBottom:`1px solid ${C.lightGray}`}}>
                <div style={{fontWeight:800,fontSize:12,textTransform:'capitalize',width:100}}>{cs.key}</div>
                <div>
                  <label style={{fontSize:9,color:C.gray}}>Flat Amount per Cutoff (₱)</label>
                  <input type="number" value={cs.flat_amount ?? (cs.key==='philhealth'?125:100)} onChange={e=>updateContribSetting(cs.key,{flat_amount:Number(e.target.value)})} disabled={!canEdit} onFocus={e=>e.target.select()} style={{width:160,padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontWeight:700,boxSizing:'border-box'}}/>
                </div>
                {cs.key==='pagibig' && <div style={{fontSize:10,color:C.gray}}>Doubled employees pay 2× this amount</div>}
              </div>
            ))}
          </div>

          <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.amber},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>Company Deductions</h2>
            </div>
            <div style={{fontSize:11,color:C.amber,marginBottom:14,background:`${C.amber}0a`,border:`1px solid ${C.amber}33`,borderRadius:6,padding:'8px 12px'}}>
              ⚠ Nothing here is auto-charged. Add a deduction type below (e.g. HMO) and it becomes available to enter per employee, per period, in "Generate from Attendance" and in the record editor.
            </div>
            {companyDeductions.length===0 ? (
              <div style={{textAlign:'center',padding:20}}>
                <div style={{fontSize:12,color:C.gray,marginBottom:10}}>No company deductions configured yet. Add one below.</div>
              </div>
            ) : companyDeductions.map(cd=>(
              <div key={cd.key} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                <span style={{fontSize:12,fontWeight:700,width:140}}>{cd.label}</span>
                <input type="number" value={cd.amount} onChange={e=>updateCompanyDeduction(cd.key,Number(e.target.value))} disabled={!canEdit} onFocus={e=>e.target.select()} style={{padding:'7px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,width:140}}/>
              </div>
            ))}
            {canEdit && (
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr auto',gap:8,marginTop:14,paddingTop:14,borderTop:`1px solid ${C.lightGray}`}}>
                <input value={newDeduction.key} onChange={e=>setNewDeduction(p=>({...p,key:e.target.value}))} onFocus={e=>e.target.select()} style={{padding:'8px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                <input value={newDeduction.label} onChange={e=>setNewDeduction(p=>({...p,label:e.target.value.toUpperCase()}))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setNewDeduction(p=>({...p,label:'N/A'}))}} style={{padding:'8px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                <input type="number" value={newDeduction.amount} onChange={e=>setNewDeduction(p=>({...p,amount:Number(e.target.value)}))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setNewDeduction(p=>({...p,amount:0}))}} style={{padding:'8px 10px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                <button onClick={addCompanyDeduction} style={{padding:'8px 16px',fontSize:11,fontWeight:800,background:`${C.amber}18`,border:`1px solid ${C.amber}44`,color:C.amber,borderRadius:6,cursor:'pointer'}}>+ Add Deduction</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── LOANS TAB ── */}
      {tab==='loans'&&(
        <div style={{background:C.white,borderRadius:12,padding:'20px 24px',boxShadow:'0 2px 16px rgba(0,0,0,0.07)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:4,height:22,background:`linear-gradient(180deg,${C.amber},${C.darkGreen})`,borderRadius:2}}/>
              <h2 style={{margin:0,fontSize:14,fontWeight:900,letterSpacing:2,color:C.dark,textTransform:'uppercase'}}>SSS / Pag-IBIG / Other Loans</h2>
            </div>
            {canEdit && <button onClick={()=>openNewLoan()} style={{padding:'9px 18px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.amber},#b45309)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',letterSpacing:1}}>+ New Loan</button>}
          </div>
          <div style={{fontSize:11,color:C.gray,marginBottom:14}}>Separate from Cash Advances — select which loans to deduct per employee when generating payroll from attendance.</div>
          <div style={{display:'flex',gap:4,marginBottom:14}}>
            {[
              {id:'all',label:`All (${allLoans.length})`,color:C.gray},
              {id:'open',label:`Open (${allLoans.filter(l=>l.status==='Open').length})`,color:C.amber},
              {id:'closed',label:`Closed (${allLoans.filter(l=>l.status==='Closed').length})`,color:C.accent},
            ].map(f=>(
              <button key={f.id} onClick={()=>setLoanStatusFilter(f.id as any)}
                style={{padding:'6px 12px',borderRadius:20,border:`1.5px solid ${loanStatusFilter===f.id?f.color:C.lightGray}`,background:loanStatusFilter===f.id?`${f.color}18`:C.white,color:loanStatusFilter===f.id?f.color:C.gray,fontSize:10,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>{f.label}</button>
            ))}
          </div>
          {(()=>{
            const filteredLoans = loanStatusFilter==='all'?allLoans:allLoans.filter(l=>loanStatusFilter==='open'?l.status==='Open':l.status==='Closed')
            // Most-recent-first by date issued, falling back to created_at.
            const loansSorted = [...filteredLoans].sort((a,b)=>String(b.date_issued||b.created_at||'').localeCompare(String(a.date_issued||a.created_at||'')))
            const loansPageCount = Math.max(1, Math.ceil(loansSorted.length / PAGE_SIZE))
            const loansCurrentPage = Math.min(loansPage, loansPageCount)
            const loansPaged = loansSorted.slice((loansCurrentPage-1)*PAGE_SIZE, loansCurrentPage*PAGE_SIZE)
            return (<>
          {filteredLoans.length>0 && (
            <div style={{fontSize:11,color:C.gray,fontWeight:700,marginBottom:10}}>
              {`Showing ${(loansCurrentPage-1)*PAGE_SIZE+1}–${Math.min(loansCurrentPage*PAGE_SIZE, loansSorted.length)} of ${loansSorted.length}`}
            </div>
          )}
          {filteredLoans.length===0?<div style={{textAlign:'center',padding:30,color:C.gray,fontSize:12}}>No loans {loanStatusFilter==='all'?'on file yet':loanStatusFilter==='open'?'open':'closed'}.</div>
          :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
              {['Loan ID','Employee','Type','Date Issued','Principal','Installment','Balance','Status','Actions'].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
            </tr></thead>
            <tbody>{loansPaged.map((l,i)=>(
              <tr key={l.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                <td style={{padding:'8px 10px',fontWeight:700}}>{l.id}</td>
                <td style={{padding:'8px 10px'}}>{l.employees?.name||l.employee_id}</td>
                <td style={{padding:'8px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,fontSize:10,fontWeight:800,background:`${C.blue}18`,color:C.blue}}>{l.loan_type}</span></td>
                <td style={{padding:'8px 10px'}}>{l.date_issued}</td>
                <td style={{padding:'8px 10px'}}>{fmt(l.principal)}</td>
                <td style={{padding:'8px 10px'}}>{fmt(l.installment_amount)}</td>
                <td style={{padding:'8px 10px',fontWeight:800,color:l.balance>0?C.amber:C.accent}}>{fmt(l.balance)}</td>
                <td style={{padding:'8px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,fontSize:10,fontWeight:800,background:l.status==='Open'?`${C.amber}18`:`${C.accent}18`,color:l.status==='Open'?C.amber:C.accent}}>{l.status}</span></td>
                <td style={{padding:'8px 10px',display:'flex',gap:6}}>
                  <button onClick={()=>openLoanHistory(l)} style={{background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:10,fontWeight:700}}>History</button>
                  {canEdit && l.status==='Open' && <button onClick={()=>setShowLoanPayModal(l)} style={{background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:10,fontWeight:700}}>Record Payment</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>}
          {loansPageCount > 1 && (
            <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:18}}>
              <button onClick={()=>setLoansPage(p=>Math.max(1,p-1))} disabled={loansCurrentPage===1} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:loansCurrentPage===1?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:loansCurrentPage===1?'default':'pointer'}}>← Prev</button>
              <span style={{fontSize:11,fontWeight:700,color:C.gray}}>Page {loansCurrentPage} of {loansPageCount}</span>
              <button onClick={()=>setLoansPage(p=>Math.min(loansPageCount,p+1))} disabled={loansCurrentPage===loansPageCount} style={{padding:'7px 14px',borderRadius:8,border:`1.5px solid ${C.lightGray}`,background:C.white,color:loansCurrentPage===loansPageCount?C.lightGray:C.dark,fontSize:11,fontWeight:700,cursor:loansCurrentPage===loansPageCount?'default':'pointer'}}>Next →</button>
            </div>
          )}
          </>)
          })()}
        </div>
      )}

      {/* ── NEW LOAN MODAL ── */}
      {showLoanModal&&(
        <ModalShell title="New Loan" onClose={()=>setShowLoanModal(false)} accentColor={C.amber}>
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Employee</label>
            <select value={loanForm.employee_id} onChange={e=>setLoanForm(p=>({...p,employee_id:e.target.value}))} style={inputStyle}>
              <option value="">Select employee…</option>
              {employees.map(e=><option key={e.id} value={e.id}>{e.name} — {e.role}</option>)}
            </select>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
            <Field label="Loan Type" type="select" value={loanForm.loan_type} onChange={(v:any)=>setLoanForm(p=>({...p,loan_type:v}))} options={['SSS','Pag-IBIG','Other']}/>
            <Field label="Date Issued" type="date" value={loanForm.date_issued} onChange={(v:any)=>setLoanForm(p=>({...p,date_issued:v}))}/>
            <Field label="Principal (₱)" type="number" value={loanForm.principal} onChange={(v:any)=>setLoanForm(p=>({...p,principal:v}))}/>
            <Field label="Installment per Cutoff (₱)" type="number" value={loanForm.installment_amount} onChange={(v:any)=>setLoanForm(p=>({...p,installment_amount:v}))}/>
          </div>
          <Field label="Notes" value={loanForm.notes} onChange={(v:any)=>setLoanForm(p=>({...p,notes:v}))} span placeholder="Optional"/>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowLoanModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={saveLoan} disabled={loanSaving} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.amber},#b45309)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>{loanSaving?'Saving…':'Save Loan'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── RECORD LOAN PAYMENT MODAL ── */}
      {showLoanPayModal&&(
        <ModalShell title={`Record Payment — ${showLoanPayModal.id}`} onClose={()=>setShowLoanPayModal(null)} accentColor={C.accent}>
          <div style={{fontSize:12,color:C.gray,marginBottom:14}}>Current balance: <b style={{color:C.dark}}>{fmt(showLoanPayModal.balance)}</b></div>
          <Field label="Payment Amount (₱)" type="number" value={loanPayAmount} onChange={(v:any)=>setLoanPayAmount(v)}/>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowLoanPayModal(null)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={recordLoanPayment} disabled={loanSaving||!loanPayAmount} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>{loanSaving?'Saving…':'Record Payment'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── LOAN PAYMENT HISTORY MODAL ── */}
      {loanHistoryFor&&(
        <ModalShell title={`Payment History — ${loanHistoryFor.id}`} onClose={()=>setLoanHistoryFor(null)} accentColor={C.blue}>
          {loanHistory.length===0?<div style={{textAlign:'center',padding:20,color:C.gray,fontSize:12}}>No payments recorded yet.</div>
          :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{background:C.lightGray}}>
              {['Date','Amount','Method','Notes',''].map(h=><th key={h} style={{padding:'7px 10px',textAlign:'left',fontWeight:800}}>{h}</th>)}
            </tr></thead>
            <tbody>{loanHistory.map(p=>(
              <tr key={p.id} style={{borderBottom:`1px solid ${C.lightGray}`}}>
                <td style={{padding:'6px 10px'}}>{p.date}</td>
                <td style={{padding:'6px 10px',fontWeight:700}}>{fmt(p.amount)}</td>
                <td style={{padding:'6px 10px'}}>{p.method}</td>
                <td style={{padding:'6px 10px',color:C.gray}}>{p.notes||'—'}</td>
                <td style={{padding:'6px 10px'}}>{canEdit&&<button onClick={()=>deleteLoanHistoryPayment(p.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:10,fontWeight:700}}>✕</button>}</td>
              </tr>
            ))}</tbody>
          </table>}
        </ModalShell>
      )}

      {/* ── MANUAL ATTENDANCE ENTRY MODAL ── */}
      {showManualAtt&&(
        <ModalShell title={editingAttId?'Correct Attendance Entry':'Add Attendance Entry'} onClose={()=>setShowManualAtt(false)} accentColor={C.blue}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
            {editingAttId ? (
              <div style={{marginBottom:14,gridColumn:'1/-1'}}>
                <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Employee</label>
                <select value={manualAtt.employee_id} disabled style={{...inputStyle,background:'#f4f7f5'}}>
                  <option value="">Select employee…</option>
                  {employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
            ) : (
              <div style={{marginBottom:14,gridColumn:'1/-1'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
                  <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase'}}>Employee{manualAttMulti.length>1?'s':''} {manualAttMulti.length>0 && `(${manualAttMulti.length} selected)`}</label>
                  <button type="button" onClick={()=>setManualAttMulti(p=>p.length===employees.length?[]:employees.map(e=>e.id))} style={{fontSize:10,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>{manualAttMulti.length===employees.length?'Deselect All':'Select All'}</button>
                </div>
                <div style={{maxHeight:160,overflowY:'auto',border:`1.5px solid ${C.lightGray}`,borderRadius:6,padding:8}}>
                  {employees.map(e=>(
                    <label key={e.id} style={{display:'flex',alignItems:'center',gap:8,padding:'5px 4px',fontSize:12,cursor:'pointer'}}>
                      <input type="checkbox" checked={manualAttMulti.includes(e.id)} onChange={()=>setManualAttMulti(p=>p.includes(e.id)?p.filter(id=>id!==e.id):[...p,e.id])}/>
                      {e.name}
                    </label>
                  ))}
                </div>
                <div style={{fontSize:10,color:C.gray,marginTop:4}}>Same date, time, leave type, and OT settings below get applied to everyone checked — useful for a shared holiday or a whole-team shift.</div>
              </div>
            )}
            <Field label="Date" type="date" value={manualAtt.date} onChange={(v:any)=>setManualAtt(p=>({...p,date:v}))} disabled={!!editingAttId}/>
            <div style={{marginBottom:14}}>
              <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Leave Type</label>
              <select value={manualAtt.leave_type} onChange={e=>setManualAtt(p=>({...p,leave_type:e.target.value}))} style={inputStyle}>
                <option value="">None — worked this day</option>
                <option value="VL">VL — Vacation Leave</option>
                <option value="SL">SL — Sick Leave</option>
              </select>
            </div>
            {!manualAtt.leave_type && <>
            <Field label="Break (minutes)" type="number" value={manualAtt.break_minutes} onChange={(v:any)=>setManualAtt(p=>({...p,break_minutes:v}))} disabled={!manualAtt.straight_time}/>
            <Field label="Time In" type="time" value={manualAtt.time_in} onChange={(v:any)=>setManualAtt(p=>applyStraightTimeOT({...p,time_in:v}))}/>
            <Field label="Time Out" type="time" value={manualAtt.time_out} onChange={(v:any)=>setManualAtt(p=>applyStraightTimeOT({...p,time_out:v}))}/>
            </>}
          </div>
          {manualAtt.leave_type && (
            <div style={{background:`${C.blue}0a`,border:`1px solid ${C.blue}33`,borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12,color:C.blue}}>
              Marked as paid {manualAtt.leave_type==='VL'?'Vacation':'Sick'} Leave — pays a full day at the employee's daily rate, no time punches needed.
            </div>
          )}
          {!manualAtt.leave_type && (
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,fontWeight:700,color:C.dark,marginBottom:14,cursor:'pointer',padding:'8px 12px',background:manualAtt.straight_time?`${C.amber}12`:'#f9fbf9',borderRadius:8,border:`1px solid ${manualAtt.straight_time?C.amber:C.lightGray}`}}>
            <input type="checkbox" checked={manualAtt.straight_time} onChange={e=>setManualAtt(p=>applyStraightTimeOT({...p,straight_time:e.target.checked,break_minutes:e.target.checked?0:60}))}/>
            Straight time (worked outside, no lunch break taken) — hours past 8 are counted as OT below
          </label>
          )}
          {!manualAtt.leave_type && (
          <div style={{background:`${C.accent}08`,borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12,color:C.gray}}>
            Computed hours: <b style={{color:C.dark}}>{computeHours(manualAtt.time_in,manualAtt.time_out,manualAtt.break_minutes)}</b>
          </div>
          )}
          {!manualAtt.leave_type && (()=>{
            const relevantEmps = editingAttId ? employees.filter(e=>e.id===manualAtt.employee_id) : employees.filter(e=>manualAttMulti.includes(e.id))
            const allExempt = relevantEmps.length>0 && relevantEmps.every(e=>e.ot_exempt)
            const someExempt = relevantEmps.some(e=>e.ot_exempt) && !allExempt
            if (allExempt) return (
              <div style={{marginBottom:14,background:`${C.amber}0a`,border:`1px solid ${C.amber}33`,borderRadius:8,padding:'10px 14px',fontSize:11,color:C.amber}}>
                ⚠ {relevantEmps.length>1?'All selected employees are':`${relevantEmps[0].name} is`} marked OT Exempt (fixed rate, managerial) — overtime never applies, so there's nothing to enter here.
              </div>
            )
            return (
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:8}}>Approved Overtime</label>
            {someExempt && <div style={{marginBottom:8,fontSize:10,color:C.amber}}>⚠ {relevantEmps.filter(e=>e.ot_exempt).length} of the selected employees are OT Exempt — this won't apply to them even if entered here.</div>}
            <div style={{display:'flex',gap:6,marginBottom:10}}>
              <button type="button" onClick={()=>setOtMode('duration')} style={{padding:'6px 14px',fontSize:11,fontWeight:700,borderRadius:6,border:`1.5px solid ${otMode==='duration'?C.accent:C.lightGray}`,background:otMode==='duration'?`${C.accent}12`:C.white,color:otMode==='duration'?C.accent:C.gray,cursor:'pointer'}}>Hours + Minutes</button>
              <button type="button" onClick={()=>setOtMode('time')} style={{padding:'6px 14px',fontSize:11,fontWeight:700,borderRadius:6,border:`1.5px solid ${otMode==='time'?C.accent:C.lightGray}`,background:otMode==='time'?`${C.accent}12`:C.white,color:otMode==='time'?C.accent:C.gray,cursor:'pointer'}}>Actual Time Out</button>
            </div>

            {otMode==='duration' ? (
              <div style={{display:'flex',gap:10,alignItems:'center'}}>
                <div>
                  <input type="number" min={0} value={otHoursIn} onFocus={e=>e.target.select()} onChange={e=>{
                    const h=Math.max(0,Number(e.target.value)); setOtHoursIn(h)
                    const totalMin=h*60+otMinsIn
                    const endHour=shiftEndHour(manualAtt.date)
                    const outTime=`${String(Math.floor((endHour*60+totalMin)/60)%24).padStart(2,'0')}:${String((endHour*60+totalMin)%60).padStart(2,'0')}`
                    setManualAtt(p=>({...p,manual_ot_minutes:totalMin,time_out:totalMin>0?outTime:p.time_out}))
                  }}
                    style={{width:80,padding:'9px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:13,fontFamily:'inherit',boxSizing:'border-box'}}/>
                  <div style={{fontSize:9,color:C.gray,marginTop:2}}>hours</div>
                </div>
                <div>
                  <input type="number" min={0} max={59} value={otMinsIn} onFocus={e=>e.target.select()} onChange={e=>{
                    const m=Math.min(59,Math.max(0,Number(e.target.value))); setOtMinsIn(m)
                    const totalMin=otHoursIn*60+m
                    const endHour=shiftEndHour(manualAtt.date)
                    const outTime=`${String(Math.floor((endHour*60+totalMin)/60)%24).padStart(2,'0')}:${String((endHour*60+totalMin)%60).padStart(2,'0')}`
                    setManualAtt(p=>({...p,manual_ot_minutes:totalMin,time_out:totalMin>0?outTime:p.time_out}))
                  }}
                    style={{width:80,padding:'9px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:13,fontFamily:'inherit',boxSizing:'border-box'}}/>
                  <div style={{fontSize:9,color:C.gray,marginTop:2}}>minutes</div>
                </div>
                <div style={{fontSize:10,color:C.gray,marginTop:14}}>Time Out updates automatically to match.</div>
              </div>
            ) : (
              <div>
                <input type="time" value={otUntilTime} onChange={e=>{
                  const val = e.target.value
                  setOtUntilTime(val)
                  if (val) {
                    const [h,m] = val.split(':').map(Number)
                    const endHour = shiftEndHour(manualAtt.date)
                    const mins = Math.max(0, (h*60+m) - (endHour*60))
                    // This IS the real clock-out time — reflect it on the record directly.
                    setManualAtt(p=>({...p,manual_ot_minutes:mins,time_out:val}))
                  }
                }} style={{width:160,padding:'9px 12px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:13,fontFamily:'inherit',boxSizing:'border-box'}}/>
                <div style={{fontSize:10,color:C.gray,marginTop:4}}>Shift ends at {shiftEndHour(manualAtt.date)===16?'4:00 PM (Saturday)':'5:00 PM'} — enter when they actually left; Time Out updates to match automatically.</div>
              </div>
            )}

            {manualAtt.manual_ot_minutes>0 && (
              <div style={{marginTop:8,fontSize:11,fontWeight:700,color:C.accent}}>= {Math.floor(manualAtt.manual_ot_minutes/60)}h {manualAtt.manual_ot_minutes%60}m approved OT</div>
            )}
            <div style={{fontSize:10,color:C.gray,marginTop:6}}>Time worked past the shift end never pays automatically — only fill this in after checking an OT form or getting verbal confirmation.</div>
          </div>
            )
          })()}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>{setShowManualAtt(false);setEditingAttId(null)}} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={saveManualAtt} disabled={attSaving||(editingAttId?!manualAtt.employee_id:manualAttMulti.length===0)} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>{attSaving?'Saving…':(editingAttId?'Save Correction':manualAttMulti.length>1?`Save for ${manualAttMulti.length} Employees`:'Save Entry')}</button>
          </div>
        </ModalShell>
      )}

      {/* ── HOLIDAY MODAL ── */}
      {showHolidayModal&&(
        <ModalShell title={editingHoliday?'Edit Holiday':'Add Holiday'} onClose={()=>setShowHolidayModal(false)} accentColor={C.red}>
          <Field label="Date" type="date" value={holidayForm.date} onChange={(v:any)=>setHolidayForm(p=>({...p,date:v}))} disabled={editingHoliday}/>
          {editingHoliday && <div style={{fontSize:10,color:C.gray,marginTop:-8,marginBottom:14}}>To move this holiday to a different date, delete it and add a new entry instead.</div>}
          <Field label="Holiday Name" value={holidayForm.name} onChange={(v:any)=>setHolidayForm(p=>({...p,name:v}))} placeholder="e.g. Rizal Day"/>
          <Field label="Type" type="select" value={holidayForm.type} onChange={(v:any)=>setHolidayForm(p=>({...p,type:v}))}
            options={[{value:'regular',label:'Regular Holiday (200%)'},{value:'special_non_working',label:'Special Non-Working (130%)'},{value:'special_working',label:'Special Working (100%, no premium)'}]}/>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:10}}>
            <button onClick={()=>setShowHolidayModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={saveHoliday} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.red},#b91c1c)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>{editingHoliday?'Save Changes':'Save Holiday'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── CLEAR PAYROLL REGISTER MODAL ── */}
      {showClearModal && (
        <ModalShell title="Clear Payroll Register" onClose={()=>setShowClearModal(false)} accentColor={C.red}>
          <div style={{fontSize:12,color:C.gray,marginBottom:14}}>Pick the period whose records you want to wipe. This also reverses any loan/cash-advance deductions that were applied from those records.</div>
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Payroll Period</label>
            <select value={clearRunId} onChange={e=>setClearRunId(e.target.value)} style={inputStyle}>
              <option value="">Select a period…</option>
              {payrollRuns.map(r=>{
                const count = records.filter(rec=>rec.payroll_run_id===r.id).length
                return <option key={r.id} value={r.id}>{r.period_start} to {r.period_end} — {count} record{count===1?'':'s'}</option>
              })}
            </select>
          </div>
          {clearRunId && (
            <div style={{background:`${C.red}12`,border:`1.5px solid ${C.red}44`,borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12,color:C.red,fontWeight:700}}>
              ⚠ This permanently deletes {records.filter(r=>r.payroll_run_id===clearRunId).length} record(s). You'll be asked to type CLEAR to confirm.
            </div>
          )}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowClearModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={clearPayrollRegister} disabled={!clearRunId||clearing} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:C.red,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase',opacity:(!clearRunId||clearing)?0.5:1}}>{clearing?'Clearing…':'Clear Records'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── EXPORT PAYROLL REGISTER MODAL ── */}
      {showExportModal && (
        <ModalShell title="Export Payroll Register" onClose={()=>setShowExportModal(false)} accentColor={C.darkGreen}>
          <div style={{fontSize:12,color:C.gray,marginBottom:14}}>Prints one consolidated sheet listing every employee's payroll for the selected period, with a signature column — for wet-signing before cash is released.</div>
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Payroll Period</label>
            <select value={exportRunId} onChange={e=>setExportRunId(e.target.value)} style={inputStyle}>
              <option value="">Select a period…</option>
              {payrollRuns.map(r=>{
                const count = records.filter(rec=>rec.payroll_run_id===r.id).length
                return <option key={r.id} value={r.id}>{r.period_start} to {r.period_end} — {count} record{count===1?'':'s'}</option>
              })}
            </select>
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowExportModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={()=>{
              const run = payrollRuns.find(r=>r.id===exportRunId)
              const periodRecords = records.filter(r=>r.payroll_run_id===exportRunId)
              if(!run||periodRecords.length===0) return
              printPayrollRegister(periodRecords, `${run.period_start} to ${run.period_end}`)
              setShowExportModal(false)
            }} disabled={!exportRunId} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase',opacity:!exportRunId?0.5:1}}>🖨 Print Register</button>
          </div>
        </ModalShell>
      )}

      {/* ── GENERATE FROM ATTENDANCE MODAL ── */}
      {showGenModal&&(
        <ModalShell title="Generate Payroll from Attendance" onClose={()=>setShowGenModal(false)} accentColor={C.blue}>
          <label style={{display:'flex',alignItems:'center',gap:8,marginBottom:16,padding:'10px 14px',background:genBatchMode?`${C.blue}12`:'#f9fbf9',border:`1.5px solid ${genBatchMode?C.blue:C.lightGray}`,borderRadius:8,cursor:'pointer'}}>
            <input type="checkbox" checked={genBatchMode} onChange={e=>{setGenBatchMode(e.target.checked);setGenBreakdown(null);setGenBatchProgress(null)}}/>
            <span style={{fontSize:12,fontWeight:700,color:genBatchMode?C.blue:C.dark}}>Generate for All Active Employees</span>
            <span style={{fontSize:10,color:C.gray}}>— skips anyone with no attendance in range, or already generated for this period</span>
          </label>

          {genBatchMode ? (
            <>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
                <Field label="Period Start" type="date" value={genForm.period_start} onChange={(v:any)=>setGenForm(p=>({...p,period_start:v}))}/>
                <Field label="Period End" type="date" value={genForm.period_end} onChange={(v:any)=>setGenForm(p=>({...p,period_end:v}))}/>
              </div>
              <div style={{background:`${C.amber}12`,border:`1px solid ${C.amber}44`,borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:11,color:C.amber}}>
                ⚠ Any Open loan auto-deducts half its monthly installment, and any Open cash advance deducts its full balance, for every employee — there's no per-person choice in this mode. Use single-employee generation if you need to pick which deductions apply. Everyone affected will be flagged for your review once generation finishes.
              </div>
              {genBatchProgress && (
                <div style={{marginBottom:16}}>
                  <div style={{height:8,background:C.lightGray,borderRadius:4,overflow:'hidden',marginBottom:6}}>
                    <div style={{width:`${genBatchProgress.total?genBatchProgress.done/genBatchProgress.total*100:0}%`,height:'100%',background:C.blue,transition:'width 0.3s'}}/>
                  </div>
                  <div style={{fontSize:11,color:C.gray}}>{genBatchProgress.done} / {genBatchProgress.total} processed{genBatchProgress.errors.length?` · ${genBatchProgress.errors.length} error(s)`:''}</div>
                </div>
              )}
              <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                <button onClick={()=>setShowGenModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
                <button onClick={runGenerateAllBatch} disabled={genGenerating} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.blue},#1d4ed8)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>{genGenerating?'Generating…':'Generate & Save All'}</button>
              </div>
            </>
          ) : (
          <>
          <div style={{marginBottom:14,display:'flex',alignItems:'center',gap:8,background:`${C.purple}0a`,border:`1px solid ${C.purple}33`,borderRadius:8,padding:'10px 14px'}}>
            <input type="checkbox" id="genNightDiff" checked={genNightDiff} onChange={e=>toggleGenNightDiff(e.target.checked)} style={{width:16,height:16,cursor:'pointer'}}/>
            <label htmlFor="genNightDiff" style={{fontSize:12,fontWeight:700,color:C.dark,cursor:'pointer'}}>Apply Night Differential (+10%) to this cutoff's overtime</label>
            <span style={{fontSize:10,color:C.gray}}>— manual, applies to all OT hours regardless of what time they happened</span>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'0 14px'}}>
            <div style={{marginBottom:14,gridColumn:'1/-1'}}>
              <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Employee</label>
              <select value={genForm.employee_id} onChange={e=>{setGenForm(p=>({...p,employee_id:e.target.value}));setGenBreakdown(null)}} style={inputStyle}>
                <option value="">Select employee…</option>
                {employees.map(e=><option key={e.id} value={e.id}>{e.name} — {e.role}</option>)}
              </select>
            </div>
            <Field label="Period Start" type="date" value={genForm.period_start} onChange={(v:any)=>setGenForm(p=>({...p,period_start:v}))}/>
            <Field label="Period End" type="date" value={genForm.period_end} onChange={(v:any)=>setGenForm(p=>({...p,period_end:v}))}/>
            <div style={{marginBottom:14,display:'flex',alignItems:'flex-end'}}>
              <button onClick={runGenerate} disabled={!genForm.employee_id||genGenerating} style={{width:'100%',padding:'9px',fontSize:11,fontWeight:800,background:`${C.blue}18`,border:`1.5px solid ${C.blue}44`,color:C.blue,borderRadius:6,cursor:'pointer'}}>{genGenerating?'Computing…':'Compute →'}</button>
            </div>
          </div>

          {genBreakdown && (
            <>
              <div style={{background:`${C.blue}08`,border:`1px solid ${C.blue}33`,borderRadius:8,padding:'12px 16px',marginBottom:14,fontSize:11}}>
                <div style={{fontWeight:800,color:C.gray,textTransform:'uppercase',fontSize:10,marginBottom:8}}>Auto-Computed from {genBreakdown.daysLogged} Attendance Record{genBreakdown.daysLogged===1?'':'s'}</div>
                {genBreakdown.flaggedDays>0 && (
                  <div style={{background:`${C.red}12`,border:`1.5px solid ${C.red}44`,borderRadius:6,padding:'8px 12px',marginBottom:10,color:C.red,fontSize:11,fontWeight:700}}>
                    ⚠ {genBreakdown.flaggedDays} day{genBreakdown.flaggedDays===1?'':'s'} in this period need clerk review (missing or irregular punches) — check the Attendance tab before printing this payslip.
                  </div>
                )}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:8}}>
                  <div>Regular: <b>{genBreakdown.regularDays}d</b> ({fmt(genBreakdown.regularPay)})</div>
                  <div>Sunday: <b>{genBreakdown.sundayDays}d</b> ({fmt(genBreakdown.sundayPay)})</div>
                  <div>Reg. Holiday: <b>{genBreakdown.regHolidayDays}d</b> ({fmt(genBreakdown.regHolidayPay)})</div>
                  <div>Spec. Holiday: <b>{genBreakdown.specHolidayDays}d</b> ({fmt(genBreakdown.specHolidayPay)})</div>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:6,alignItems:'end',background:`${C.white}`,borderRadius:6,padding:8,marginBottom:4}}>
                  <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>OT Hours</label><input onFocus={e=>e.target.select()} type="number" value={genBreakdown.otHours} onChange={e=>setGenBreakdown((p:any)=>({...p,otHours:Number(e.target.value)}))} style={{width:'100%',padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:5,fontSize:12,boxSizing:'border-box'}}/></div>
                  <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>OT Pay (₱)</label><input onFocus={e=>e.target.select()} type="number" value={genBreakdown.otPay} onChange={e=>{const v=Number(e.target.value); setGenBreakdown((p:any)=>({...p,otPay:v,grossPay:round2(p.regularPay+v+p.nightDiffPay+p.sundayPay+p.regHolidayPay+p.specHolidayPay+p.leavePay)}))}} style={{width:'100%',padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:5,fontSize:12,boxSizing:'border-box'}}/></div>
                  <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>Night Diff Hours</label><input onFocus={e=>e.target.select()} type="number" value={genBreakdown.nightDiffHours} onChange={e=>setGenBreakdown((p:any)=>({...p,nightDiffHours:Number(e.target.value)}))} style={{width:'100%',padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:5,fontSize:12,boxSizing:'border-box'}}/></div>
                  <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>Night Diff Pay (₱)</label><input onFocus={e=>e.target.select()} type="number" value={genBreakdown.nightDiffPay} onChange={e=>{const v=Number(e.target.value); setGenBreakdown((p:any)=>({...p,nightDiffPay:v,grossPay:round2(p.regularPay+p.otPay+v+p.sundayPay+p.regHolidayPay+p.specHolidayPay+p.leavePay)}))}} style={{width:'100%',padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:5,fontSize:12,boxSizing:'border-box'}}/></div>
                </div>
                <div style={{fontSize:9,color:C.gray,marginBottom:4}}>OT and Night Diff are editable — override the computed figures here if they don't match what actually happened. Gross Pay below updates automatically.</div>
                <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${C.blue}33`,fontWeight:900,fontSize:13,color:C.blue}}>Gross Pay: {fmt(genBreakdown.grossPay)}</div>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8,marginBottom:14}}>
                <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>SSS (auto)</label><input onFocus={e=>e.target.select()} type="number" value={genBreakdown.sss} onChange={e=>setGenBreakdown((p:any)=>({...p,sss:Number(e.target.value)}))} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/></div>
                <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>PhilHealth (auto)</label><input onFocus={e=>e.target.select()} type="number" value={genBreakdown.philhealth} onChange={e=>setGenBreakdown((p:any)=>({...p,philhealth:Number(e.target.value)}))} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/></div>
                <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>Pag-IBIG (auto)</label><input onFocus={e=>e.target.select()} type="number" value={genBreakdown.pagibig} onChange={e=>setGenBreakdown((p:any)=>({...p,pagibig:Number(e.target.value)}))} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/></div>
                <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>Allowance</label><input onFocus={e=>e.target.select()} type="number" value={genAllowance} onChange={e=>setGenAllowance(Number(e.target.value))} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/></div>
              </div>

              {/* VL/SL — pick actual dates instead of typing a day count */}
              <div style={{marginBottom:14}}>
                <label style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:6}}>VL/SL — Paid Leave Dates</label>
                <div style={{display:'flex',gap:8,marginBottom:8}}>
                  <input type="date" value={genLeaveDateInput} onChange={e=>setGenLeaveDateInput(e.target.value)} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                  <button onClick={()=>{ if(genLeaveDateInput && !genLeaveDates.includes(genLeaveDateInput)){ setGenLeaveDates(p=>[...p,genLeaveDateInput].sort()); setGenLeaveDateInput('') } }}
                    style={{padding:'7px 14px',fontSize:11,fontWeight:700,background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:6,cursor:'pointer'}}>+ Add Date</button>
                </div>
                {genLeaveDates.length>0 && (
                  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                    {genLeaveDates.map(d=>(
                      <span key={d} style={{padding:'4px 10px',borderRadius:20,background:`${C.blue}12`,border:`1px solid ${C.blue}44`,color:C.blue,fontSize:11,fontWeight:700,display:'flex',alignItems:'center',gap:6}}>
                        {d} <button onClick={()=>setGenLeaveDates(p=>p.filter(x=>x!==d))} style={{background:'none',border:'none',color:C.blue,cursor:'pointer',fontWeight:900,padding:0}}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {genLoans.length>0 && (
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:10,fontWeight:800,color:C.amber,textTransform:'uppercase',marginBottom:8}}>⚠ Open Loans — select which to deduct this cycle</div>
                  {genLoans.map(loan=>(
                    <label key={loan.id} style={{display:'flex',alignItems:'center',gap:10,marginBottom:6,padding:'8px 12px',background:genLoanSel[loan.id]!==undefined?`${C.amber}12`:'#f9fbf9',borderRadius:8,border:`1px solid ${genLoanSel[loan.id]!==undefined?C.amber:C.lightGray}44`,cursor:'pointer'}}>
                      <input type="checkbox" checked={genLoanSel[loan.id]!==undefined} onChange={()=>toggleGenLoan(loan)}/>
                      <span style={{flex:1,fontSize:11}}>{loan.loan_type} Loan — {loan.id} (Balance: {fmt(loan.balance)}) <span style={{color:C.gray}}> — monthly ₱{fmt(loan.installment_amount)}, halved per cutoff</span></span>
                      {genLoanSel[loan.id]!==undefined && <input type="number" step="1000" value={genLoanSel[loan.id]} onChange={e=>setGenLoanSel(p=>({...p,[loan.id]:Number(e.target.value)}))} onFocus={e=>e.target.select()} style={{width:100,padding:'5px 8px',border:`1.5px solid ${C.amber}44`,borderRadius:6,fontSize:11}}/>}
                    </label>
                  ))}
                </div>
              )}

              {cashAdvances.filter(ca=>ca.employee_id===genForm.employee_id&&ca.status==='Open').length>0 && (
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:10,fontWeight:800,color:C.purple,textTransform:'uppercase',marginBottom:8}}>Open Cash Advances — select which to deduct this cycle</div>
                  {cashAdvances.filter(ca=>ca.employee_id===genForm.employee_id&&ca.status==='Open').map(ca=>(
                    <label key={ca.id} style={{display:'flex',alignItems:'center',gap:10,marginBottom:6,padding:'8px 12px',background:genCASel[ca.id]!==undefined?`${C.purple}12`:'#f9fbf9',borderRadius:8,border:`1px solid ${genCASel[ca.id]!==undefined?C.purple:C.lightGray}44`,cursor:'pointer'}}>
                      <input type="checkbox" checked={genCASel[ca.id]!==undefined} onChange={()=>toggleGenCA(ca)}/>
                      <span style={{flex:1,fontSize:11}}>{ca.id} (Balance: {fmt(ca.balance)})</span>
                      {genCASel[ca.id]!==undefined && <input type="number" step="1000" value={genCASel[ca.id]} onChange={e=>setGenCASel(p=>({...p,[ca.id]:Number(e.target.value)}))} onFocus={e=>e.target.select()} style={{width:100,padding:'5px 8px',border:`1.5px solid ${C.purple}44`,borderRadius:6,fontSize:11}}/>}
                    </label>
                  ))}
                </div>
              )}

              {/* Ad-hoc named deductions — Sticker Fee etc., anything irregular */}
              <div style={{marginBottom:14}}>
                <label style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:6}}>Other Deduction Lines</label>
                {genDeductionLines.map((line,i)=>{
                  const isCustom = !!line.label && !DEDUCTION_PRESETS.slice(0,-1).includes(line.label)
                  return (
                  <div key={i} style={{marginBottom:6}}>
                    <div style={{display:'grid',gridTemplateColumns:'2fr 1fr auto',gap:8}}>
                      <select value={isCustom?'Other (specify)':line.label} onChange={e=>setGenDeductionLines(p=>p.map((l,j)=>j===i?{...l,label:e.target.value==='Other (specify)'?'':e.target.value}:l))} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}>
                        <option value="">Select…</option>
                        {DEDUCTION_PRESETS.map(p=><option key={p} value={p}>{p}</option>)}
                      </select>
                      <input type="number" value={line.amount} onChange={e=>setGenDeductionLines(p=>p.map((l,j)=>j===i?{...l,amount:Number(e.target.value)}:l))} onFocus={e=>e.target.select()} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                      <button onClick={()=>setGenDeductionLines(p=>p.filter((_,j)=>j!==i))} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:6,padding:'6px 10px',cursor:'pointer'}}>✕</button>
                    </div>
                    {isCustom && <input value={line.label} onChange={e=>setGenDeductionLines(p=>p.map((l,j)=>j===i?{...l,label:e.target.value.toUpperCase()}:l))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setGenDeductionLines(p=>p.map((l,j)=>j===i?{...l,label:'N/A'}:l))}} style={{marginTop:6,width:'100%',padding:'7px 9px',border:`1.5px solid ${C.amber}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>}
                  </div>
                )})}
                <button onClick={()=>setGenDeductionLines(p=>[...p,{label:'',amount:0}])} style={{fontSize:10,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>+ Add deduction line</button>
              </div>

              {(()=>{
                const emp = employees.find(e=>e.id===genForm.employee_id)
                const leaveRateOn = (d:string) => emp?.employment_type==='Salaried' ? Number(emp.rate)/26 : rateOn(emp, d)
                // genBreakdown.grossPay already includes pay for any leave dates that came
                // FROM attendance (leave_type flags) — only extra dates added manually here,
                // beyond what attendance already had, should add anything further.
                const attendanceLeaveDates: string[] = genBreakdown.leaveDates || []
                const extraLeaveDates = genLeaveDates.filter(d=>!attendanceLeaveDates.includes(d))
                const extraLeavePay = round2(extraLeaveDates.reduce((s2:number,d:string)=>s2+leaveRateOn(d),0))
                const totalLeavePay = round2(genLeaveDates.reduce((s2:number,d:string)=>s2+leaveRateOn(d),0))
                const totalDed = genBreakdown.sss+genBreakdown.philhealth+genBreakdown.pagibig+genDeductionLines.reduce((s,d)=>s+Number(d.amount||0),0)
                  + Object.values(genLoanSel).reduce((s,v)=>s+Number(v),0) + Object.values(genCASel).reduce((s,v)=>s+Number(v),0)
                const net = genBreakdown.grossPay + genAllowance + extraLeavePay - totalDed
                return (
                  <div style={{background:`${C.accent}12`,border:`2px solid ${C.accent}44`,borderRadius:10,padding:16,textAlign:'center',marginBottom:14}}>
                    {genLeaveDates.length>0 && (
                      <div style={{fontSize:11,color:C.gray,marginBottom:6}}>
                        + {genLeaveDates.length} VL/SL day{genLeaveDates.length===1?'':'s'} paid ({fmt(totalLeavePay)} total
                        {extraLeaveDates.length>0 && extraLeaveDates.length<genLeaveDates.length && `, ${fmt(extraLeavePay)} of that added manually`})
                      </div>
                    )}
                    <div style={{fontSize:10,fontWeight:800,letterSpacing:2,color:C.gray,textTransform:'uppercase'}}>Net Pay</div>
                    <div style={{fontSize:26,fontWeight:900,color:C.darkGreen,marginTop:4}}>{fmt(net)}</div>
                  </div>
                )
              })()}
            </>
          )}

          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowGenModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.gray}`,background:'transparent',color:C.gray,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={saveGeneratedPayroll} disabled={!genBreakdown||genGenerating} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.blue},#1d4ed8)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase',opacity:(!genBreakdown||genGenerating)?0.5:1}}>{genGenerating?'Saving…':'Save Payroll Record'}</button>
          </div>
          </>
          )}
        </ModalShell>
      )}

      {/* ── BATCH LOAN/ADVANCE REVIEW MODAL ── */}
      {/* Shown after "Generate for All" whenever it auto-deducted any Open
          loan or cash advance. Batch mode has no per-person approval step,
          so this is the clerk's chance to actually look at every affected
          employee — every row is flagged (not just failures) because the
          point is to check each one against the Loans tab, not just trust
          the math. A row whose insert failed is marked distinctly so it
          doesn't get mistaken for a normal, already-posted deduction. */}
      {genBatchLoanReview && (
        <ModalShell title="Review: Loan & Cash Advance Deductions" onClose={()=>{setGenBatchLoanReview(null);setGenBatchSummary(null)}} accentColor={C.red}>
          {genBatchSummary && (
            <div style={{fontSize:11,color:C.gray,marginBottom:14}}>
              Batch generation complete — Created: <b>{genBatchSummary.created}</b> · Skipped: <b>{genBatchSummary.skipped}</b>{genBatchSummary.errors.length?<> · <b style={{color:C.red}}>{genBatchSummary.errors.length} error(s)</b></>:null}
            </div>
          )}
          <div style={{fontSize:12,fontWeight:700,color:C.dark,marginBottom:4}}>{genBatchLoanReview.length} deduction{genBatchLoanReview.length===1?'':'s'} auto-applied — every row below needs a quick check against the Loans tab:</div>
          <div style={{fontSize:10,color:C.gray,marginBottom:12}}>Flagged in red for review. A ⚠ FAILED row means the payroll record's total still includes this amount, but it was not recorded as an actual payment — fix it manually before releasing that payslip.</div>
          <div style={{maxHeight:420,overflowY:'auto',border:`1px solid ${C.lightGray}`,borderRadius:8}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
              <thead><tr style={{background:C.darkGreen}}>
                {['Employee','Type','Amount','Balance Before','Status'].map(h=><th key={h} style={{padding:'7px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:9,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {genBatchLoanReview.map((row,i)=>(
                  <tr key={i} style={{background:row.ok?`${C.red}0f`:`${C.red}33`,borderLeft:`3px solid ${C.red}`,borderBottom:`1px solid ${C.lightGray}`}}>
                    <td style={{padding:'7px 10px',fontWeight:700}}>{row.employee}</td>
                    <td style={{padding:'7px 10px'}}>{row.kind==='Loan'?`${row.type} Loan`:'Cash Advance'} <span style={{color:C.gray,fontSize:9}}>({row.loanId})</span></td>
                    <td style={{padding:'7px 10px',fontWeight:700}}>{fmt(row.amount)}</td>
                    <td style={{padding:'7px 10px',color:C.gray}}>{fmt(row.balanceBefore)}</td>
                    <td style={{padding:'7px 10px',fontWeight:800,color:row.ok?C.amber:C.red}}>{row.ok?'⚠ Review':'⚠ FAILED'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:16}}>
            <button onClick={()=>{setGenBatchLoanReview(null);setGenBatchSummary(null)}} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',textTransform:'uppercase'}}>Done Reviewing</button>
          </div>
        </ModalShell>
      )}

      {/* ── PAYSLIP MODAL ── */}
      {showPayslip&&(
        <ModalShell title="Payslip Preview" onClose={()=>setShowPayslip(null)}>
          <div style={{background:`linear-gradient(135deg,${C.dark},${C.darkGreen})`,borderRadius:10,padding:'16px 20px',marginBottom:18}}>
            <div style={{fontSize:14,fontWeight:900,color:C.accent}}>{showPayslip.emp?.name}</div>
            <div style={{fontSize:11,color:'rgba(255,255,255,0.6)',marginTop:2}}>{showPayslip.emp?.role} · {showPayslip.emp?.id}</div>
            <div style={{fontSize:11,color:'rgba(255,255,255,0.6)',marginTop:2}}>Period: {showPayslip.rec.period}</div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
            {[['Earnings',[
              [showPayslip.emp?.employment_type==='Salaried'?'Salary (this cutoff)':`Daily Wage (${showPayslip.rec.days_worked}d)`, showPayslip.emp?.employment_type==='Salaried'?Number(showPayslip.emp?.rate)/2:(showPayslip.rec.regular_pay!=null?Number(showPayslip.rec.regular_pay):Number(showPayslip.emp?.rate)*Number(showPayslip.rec.days_worked||0))],
              Number(showPayslip.rec.overtime_hours)>0&&[`Overtime (${showPayslip.rec.overtime_hours}h)`,showPayslip.rec.overtime_pay!=null?Number(showPayslip.rec.overtime_pay):Number(showPayslip.rec.overtime_hours)*(Number(showPayslip.emp?.rate)/8*1.25)],
              Number(showPayslip.rec.sunday_pay)>0&&['Sunday Pay',showPayslip.rec.sunday_pay],
              Number(showPayslip.rec.regular_holiday_pay)>0&&['Regular Holiday',showPayslip.rec.regular_holiday_pay],
              Number(showPayslip.rec.special_holiday_pay)>0&&['Special Holiday',showPayslip.rec.special_holiday_pay],
              Number(showPayslip.rec.leave_pay)>0&&[`VL/SL (${showPayslip.rec.leave_days||0}d)`,showPayslip.rec.leave_pay],
              ['Allowance',showPayslip.rec.allowance],
            ].filter(Boolean),C.accent,calcGross(showPayslip.emp,showPayslip.rec)+Number(showPayslip.rec.allowance),'Gross Pay'],
            ['Deductions',[['SSS',showPayslip.rec.sss],['PhilHealth',showPayslip.rec.philhealth],['Pag-IBIG',showPayslip.rec.pagibig],['Withholding Tax',showPayslip.rec.tax],Number(showPayslip.rec.other_deductions)>0&&['Other Deductions',showPayslip.rec.other_deductions],Number(showPayslip.rec.cash_advance_deduction)>0&&['Cash Advance',showPayslip.rec.cash_advance_deduction],Number(showPayslip.rec.loan_deduction)>0&&['Loan',showPayslip.rec.loan_deduction]].filter(Boolean),C.red,Number(showPayslip.rec.sss)+Number(showPayslip.rec.philhealth)+Number(showPayslip.rec.pagibig)+Number(showPayslip.rec.tax)+Number(showPayslip.rec.other_deductions||0)+Number(showPayslip.rec.cash_advance_deduction||0)+Number(showPayslip.rec.loan_deduction||0),'Total Deductions']].map(([title,rows,color,total,totalLabel])=>(
              <div key={title as string} style={{border:`1.5px solid ${C.lightGray}`,borderRadius:8,padding:'14px 16px'}}>
                <div style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',marginBottom:10}}>{title as string}</div>
                {(rows as any[]).map(([l,v]:any,i:number)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'4px 0',borderBottom:`1px solid ${C.lightGray}`}}>
                    <span>{l}</span><span style={{fontWeight:700,color:color as string}}>{fmt(Number(v))}</span>
                  </div>
                ))}
                <div style={{display:'flex',justifyContent:'space-between',fontSize:13,fontWeight:900,color:color as string,marginTop:8}}>
                  <span>{totalLabel as string}</span><span>{fmt(Number(total))}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{background:`${C.accent}12`,border:`2px solid ${C.accent}44`,borderRadius:10,padding:16,textAlign:'center'}}>
            <div style={{fontSize:10,fontWeight:800,letterSpacing:2,color:C.gray,textTransform:'uppercase'}}>Net Pay — {showPayslip.rec.period}</div>
            <div style={{fontSize:30,fontWeight:900,color:C.darkGreen,marginTop:4}}>{fmt(calcNet(showPayslip.emp,showPayslip.rec))}</div>
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:16}}>
            <button onClick={()=>setShowPayslip(null)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',letterSpacing:1}}>Close</button>
            <button onClick={()=>printPayslip(showPayslip.emp,showPayslip.rec,supabase)} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',letterSpacing:1,boxShadow:`0 3px 10px ${C.accent}44`}}>🖨 Export Payslip</button>
            <button onClick={()=>printAttendanceSheet(showPayslip.emp,showPayslip.rec,supabase)} style={{padding:'9px 22px',fontSize:11,fontWeight:800,background:`linear-gradient(135deg,${C.blue},#1d4ed8)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',letterSpacing:1,boxShadow:`0 3px 10px ${C.blue}44`}}>🖨 Export Attendance Sheet</button>
          </div>
        </ModalShell>
      )}

      {/* ── PAYROLL RECORD MODAL ── */}
      {showRecModal&&(
        <ModalShell title={selectedRec?'Edit Payroll Record':'New Payroll Record'} onClose={()=>setShowRecModal(false)} accentColor={C.accent}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
            <div style={{marginBottom:14,gridColumn:'1/-1'}}>
              <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Employee</label>
              <select value={recForm.employee_id} onChange={e=>{rf('employee_id')(e.target.value); setCaAllocations({}); rf('cash_advance_deduction')(0)}} style={inputStyle} disabled={!!selectedRec}>
                <option value="">Select employee…</option>
                {employees.map(e=><option key={e.id} value={e.id}>{e.name} — {e.role}</option>)}
              </select>
            </div>
            <Field label="Payroll Period" value={recForm.period} onChange={rf('period')} placeholder="e.g. May 2024"/>
            <Field label="Status" type="select" value={recForm.status} onChange={rf('status')} options={['Pending','Paid']}/>
          </div>

          {(() => {
            const empForRec = employees.find(e=>e.id===recForm.employee_id)
            const dailyRate = Number(empForRec?.rate)||0
            const hourlyRate = dailyRate/8
            const grossPay = Number(recForm.regular_pay||0)+Number(recForm.overtime_pay||0)+Number(recForm.sunday_pay||0)+Number(recForm.night_diff_pay||0)+Number(recForm.regular_holiday_pay||0)+Number(recForm.special_holiday_pay||0)+Number(recForm.leave_pay||0)
            const pairInput = (hoursLabel:string, hoursKey:string, payLabel:string, payKey:string, payFromHours:(h:number)=>number) => (
              <>
                <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>{hoursLabel}</label><input onFocus={e=>e.target.select()} type="number" step="0.01" value={recForm[hoursKey]||0} onChange={e=>{const h=Number(e.target.value); setRecForm((p:any)=>({...p,[hoursKey]:h,[payKey]:round2(payFromHours(h))}))}} style={{width:'100%',padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:5,fontSize:12,boxSizing:'border-box'}}/></div>
                <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>{payLabel}</label><input onFocus={e=>e.target.select()} type="number" step="0.01" value={recForm[payKey]||0} onChange={e=>rf(payKey)(Number(e.target.value))} style={{width:'100%',padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:5,fontSize:12,boxSizing:'border-box'}}/></div>
              </>
            )
            return (
              <div style={{background:`${C.blue}08`,border:`1px solid ${C.blue}33`,borderRadius:8,padding:'12px 16px',marginBottom:14,fontSize:11}}>
                <div style={{fontWeight:800,color:C.gray,textTransform:'uppercase',fontSize:10,marginBottom:8}}>Hours & Pay</div>
                {!empForRec && <div style={{color:C.amber,fontSize:10,marginBottom:8}}>⚠ Select an employee above to enable auto-calculation from hours.</div>}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8,alignItems:'end',background:C.white,borderRadius:6,padding:8,marginBottom:8}}>
                  {pairInput('Regular Days','days_worked','Regular Pay (₱)','regular_pay', d=>d*dailyRate)}
                  {pairInput('OT Hours','overtime_hours','OT Pay (₱)','overtime_pay', h=>h*hourlyRate*1.25)}
                  {pairInput('Sunday Days','sunday_days','Sunday Pay (₱)','sunday_pay', d=>d*dailyRate*1.3)}
                  {pairInput('Night Diff Hours','night_diff_hours','Night Diff Pay (₱)','night_diff_pay', h=>h*hourlyRate*0.10)}
                  {pairInput('Reg. Holiday Days','regular_holiday_days','Reg. Holiday Pay (₱)','regular_holiday_pay', d=>d*dailyRate*2)}
                  {pairInput('Spec. Holiday Days','special_holiday_days','Spec. Holiday Pay (₱)','special_holiday_pay', d=>d*dailyRate*1.3)}
                </div>
                <div style={{fontSize:9,color:C.gray,marginBottom:8}}>Editing an hours/days field recalculates its pay automatically from the employee's rate — pay fields can still be overridden by hand afterward if needed.</div>
                <div style={{maxWidth:200}}><label style={{fontSize:9,color:C.gray,fontWeight:700}}>Allowance (₱)</label><input type="number" step="0.01" value={recForm.allowance} onChange={e=>rf('allowance')(Number(e.target.value))} onFocus={e=>e.target.select()} style={{width:'100%',padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:5,fontSize:12,boxSizing:'border-box'}}/></div>
                <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${C.blue}33`,fontWeight:900,fontSize:13,color:C.blue}}>Gross Pay: {fmt(grossPay)}</div>
              </div>
            )
          })()}

          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:8}}>
            <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>SSS (₱)</label><input type="number" value={recForm.sss} onChange={e=>rf('sss')(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) rf('sss')('0')}} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/></div>
            <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>PhilHealth (₱)</label><input type="number" value={recForm.philhealth} onChange={e=>rf('philhealth')(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) rf('philhealth')('0')}} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/></div>
            <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>Pag-IBIG (₱)</label><input type="number" value={recForm.pagibig} onChange={e=>rf('pagibig')(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) rf('pagibig')('0')}} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/></div>
            <div><label style={{fontSize:9,color:C.gray,fontWeight:700}}>Withholding Tax (₱)</label><input type="number" value={recForm.tax} onChange={e=>rf('tax')(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) rf('tax')('0')}} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/></div>
            {recPaymentHistory.loans.length===0 && (
              <div>
                <label style={{fontSize:9,color:C.gray,fontWeight:700}}>Loan Deduction (₱)</label>
                <input type="number" step="1000" value={recForm.loan_deduction||0} onChange={e=>rf('loan_deduction')(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) rf('loan_deduction')('0')}} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>
              </div>
            )}
            {recPaymentHistory.cas.length===0 && (
              <div>
                <label style={{fontSize:9,color:C.gray,fontWeight:700}}>Cash Advance Deduction (₱)</label>
                <input type="number" step="1000" value={recForm.cash_advance_deduction||0} onChange={e=>rf('cash_advance_deduction')(e.target.value)} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) rf('cash_advance_deduction')('0')}} style={{width:'100%',padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>
              </div>
            )}
          </div>
          {selectedRec && Number(recForm.loan_deduction||0)>0 && recPaymentHistory.loans.length===0 && (
            <div style={{marginBottom:14,padding:'8px 12px',background:`${C.amber}12`,border:`1px solid ${C.amber}44`,borderRadius:6,fontSize:11,color:C.amber}}>
              ⚠ This record shows ₱{fmt(recForm.loan_deduction)} loan deduction, but no actual loan payment is on file for it — there's no loan behind this number. Correct or clear it above; it won't appear in the payment-history section since there's nothing to link it to.
            </div>
          )}
          {selectedRec && Number(recForm.cash_advance_deduction||0)>0 && recPaymentHistory.cas.length===0 && (
            <div style={{marginBottom:14,padding:'8px 12px',background:`${C.amber}12`,border:`1px solid ${C.amber}44`,borderRadius:6,fontSize:11,color:C.amber}}>
              ⚠ This record shows ₱{fmt(recForm.cash_advance_deduction)} cash advance deduction, but no actual advance payment is on file for it.
            </div>
          )}

          {/* VL/SL — same picker as Generate, so edits here stay consistent with that flow */}
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:6}}>VL/SL — Paid Leave Dates</label>
            <div style={{display:'flex',gap:8,marginBottom:8}}>
              <input type="date" value={recLeaveDateInput} onChange={e=>setRecLeaveDateInput(e.target.value)} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
              <button onClick={()=>{ if(recLeaveDateInput && !(recForm.leave_dates||[]).includes(recLeaveDateInput)){ rf('leave_dates')([...(recForm.leave_dates||[]),recLeaveDateInput].sort()); setRecLeaveDateInput('') } }}
                style={{padding:'7px 14px',fontSize:11,fontWeight:700,background:`${C.accent}18`,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:6,cursor:'pointer'}}>+ Add Date</button>
            </div>
            {(recForm.leave_dates||[]).length>0 && (
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {(recForm.leave_dates||[]).map((d:string)=>(
                  <span key={d} style={{padding:'4px 10px',borderRadius:20,background:`${C.blue}12`,border:`1px solid ${C.blue}44`,color:C.blue,fontSize:11,fontWeight:700,display:'flex',alignItems:'center',gap:6}}>
                    {d} <button onClick={()=>rf('leave_dates')((recForm.leave_dates||[]).filter((x:string)=>x!==d))} style={{background:'none',border:'none',color:C.blue,cursor:'pointer',fontWeight:900,padding:0}}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Ad-hoc deduction lines — same as Generate */}
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:6}}>Other Deduction Lines</label>
            {(recForm.deduction_lines||[]).map((line:any,i:number)=>{
              const isCustom = !!line.label && !DEDUCTION_PRESETS.slice(0,-1).includes(line.label)
              return (
              <div key={i} style={{marginBottom:6}}>
                <div style={{display:'grid',gridTemplateColumns:'2fr 1fr auto',gap:8}}>
                  <select value={isCustom?'Other (specify)':line.label} onChange={e=>rf('deduction_lines')((recForm.deduction_lines||[]).map((l:any,j:number)=>j===i?{...l,label:e.target.value==='Other (specify)'?'':e.target.value}:l))} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}>
                    <option value="">Select…</option>
                    {DEDUCTION_PRESETS.map(p=><option key={p} value={p}>{p}</option>)}
                  </select>
                  <input type="number" value={line.amount} onChange={e=>rf('deduction_lines')((recForm.deduction_lines||[]).map((l:any,j:number)=>j===i?{...l,amount:Number(e.target.value)}:l))} onFocus={e=>e.target.select()} style={{padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                  <button onClick={()=>rf('deduction_lines')((recForm.deduction_lines||[]).filter((_:any,j:number)=>j!==i))} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:6,padding:'6px 10px',cursor:'pointer'}}>✕</button>
                </div>
                {isCustom && <input value={line.label} onChange={e=>rf('deduction_lines')((recForm.deduction_lines||[]).map((l:any,j:number)=>j===i?{...l,label:e.target.value.toUpperCase()}:l))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) rf('deduction_lines')((recForm.deduction_lines||[]).map((l:any,j:number)=>j===i?{...l,label:'N/A'}:l))}} style={{marginTop:6,width:'100%',padding:'7px 9px',border:`1.5px solid ${C.amber}`,borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>}
              </div>
            )})}
            <button onClick={()=>rf('deduction_lines')([...(recForm.deduction_lines||[]),{label:'',amount:0}])} style={{fontSize:10,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>+ Add deduction line</button>
          </div>

          {/* Cash advance deduction allocation — only for NEW records */}
          {!selectedRec && recForm.employee_id && openCAsForSelected.length>0 && (
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.amber,textTransform:'uppercase',marginBottom:8}}>⚠ Open Cash Advances — allocate deduction this cycle</div>
              {openCAsForSelected.map(ca=>(
                <div key={ca.id} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,padding:'8px 12px',background:`${C.amber}08`,borderRadius:8,border:`1px solid ${C.amber}33`}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:800,color:C.dark}}>{ca.id}</div>
                    <div style={{fontSize:10,color:C.gray}}>Balance: {fmt(ca.balance)}</div>
                  </div>
                  <input type="number" value={caAllocations[ca.id]||0}
                    onChange={e=>updateAllocation(ca.id, Number(e.target.value), Number(ca.balance))}
                    onFocus={e=>e.target.select()}
                    style={{width:110,padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,fontFamily:'inherit'}}/>
                  <button onClick={()=>updateAllocation(ca.id, Number(ca.balance), Number(ca.balance))}
                    style={{fontSize:9,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',textDecoration:'underline',whiteSpace:'nowrap'}}>full balance</button>
                </div>
              ))}
              <div style={{fontSize:11,color:C.gray,marginTop:4}}>Leave at 0 to defer this advance to a later payroll cycle.</div>
            </div>
          )}
          {selectedRec && (recPaymentHistory.loans.length>0 || recPaymentHistory.cas.length>0) && (
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',marginBottom:8}}>Loan & Cash Advance Payments Posted This Record</div>
              {recPaymentHistory.loans.map(lp=>(
                <div key={lp.id} style={{display:'grid',gridTemplateColumns:'2fr 1fr auto auto',gap:8,marginBottom:6,alignItems:'center',background:`${C.purple}08`,padding:'6px 10px',borderRadius:6}}>
                  <span style={{fontSize:11,color:C.dark}}>{lp.employee_loans?.loan_type||'Loan'} — {lp.employee_loans?.id||lp.loan_id}</span>
                  <input type="number" step="1000" defaultValue={lp.amount} onFocus={e=>e.target.select()} onBlur={async e=>{
                    const newAmt=Number(e.target.value)
                    if(newAmt===Number(lp.amount)) return
                    await supabase.from('loan_payments').delete().eq('id',lp.id)
                    await supabase.from('loan_payments').insert({loan_id:lp.loan_id, amount:newAmt, payroll_record_id:selectedRec.id, method:lp.method, notes:lp.notes})
                    const {data:freshLoans} = await supabase.from('loan_payments').select('*, employee_loans(loan_type,id)').eq('payroll_record_id',selectedRec.id)
                    setRecPaymentHistory(p=>({...p, loans:freshLoans||[]}))
                    rf('loan_deduction')((freshLoans||[]).reduce((s:number,l:any)=>s+Number(l.amount),0))
                    await fetchAll()
                  }} style={{padding:'5px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:11}}/>
                  <span style={{fontSize:9,color:C.gray}}>edit & tab out to save</span>
                  <button onClick={()=>deleteRecLoanPayment(lp.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:6,padding:'5px 9px',cursor:'pointer',fontSize:11}}>✕</button>
                </div>
              ))}
              {recPaymentHistory.cas.map(cp=>(
                <div key={cp.id} style={{display:'grid',gridTemplateColumns:'2fr 1fr auto auto',gap:8,marginBottom:6,alignItems:'center',background:`${C.amber}08`,padding:'6px 10px',borderRadius:6}}>
                  <span style={{fontSize:11,color:C.dark}}>Cash Advance — {cp.cash_advances?.id||cp.cash_advance_id}</span>
                  <input type="number" step="1000" defaultValue={cp.amount} onFocus={e=>e.target.select()} onBlur={async e=>{
                    const newAmt=Number(e.target.value)
                    if(newAmt===Number(cp.amount)) return
                    await supabase.from('cash_advance_payments').delete().eq('id',cp.id)
                    await supabase.from('cash_advance_payments').insert({cash_advance_id:cp.cash_advance_id, amount:newAmt, payroll_id:selectedRec.id, method:cp.method, date:cp.date, notes:cp.notes})
                    const {data:freshCAs} = await supabase.from('cash_advance_payments').select('*, cash_advances(id)').eq('payroll_id',selectedRec.id)
                    setRecPaymentHistory(p=>({...p, cas:freshCAs||[]}))
                    rf('cash_advance_deduction')((freshCAs||[]).reduce((s:number,c:any)=>s+Number(c.amount),0))
                    await fetchAll()
                  }} style={{padding:'5px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:11}}/>
                  <span style={{fontSize:9,color:C.gray}}>edit & tab out to save</span>
                  <button onClick={()=>deleteRecCAPayment(cp.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:6,padding:'5px 9px',cursor:'pointer',fontSize:11}}>✕</button>
                </div>
              ))}
              <div style={{fontSize:10,color:C.gray,marginTop:4}}>Editing or deleting here correctly restores the loan/advance balance — this is the real ledger, not just the number shown on the payslip.</div>
            </div>
          )}

          {recForm.employee_id&&(()=>{
            const emp=employees.find(e=>e.id===recForm.employee_id)
            if(!emp) return null
            const g=calcGross(emp,recForm); const net=calcNet(emp,recForm)
            const dedLinesTotal=(recForm.deduction_lines||[]).reduce((s:number,d:any)=>s+Number(d.amount||0),0)
            const totalDed=Number(recForm.sss||0)+Number(recForm.philhealth||0)+Number(recForm.pagibig||0)+Number(recForm.tax||0)+dedLinesTotal+Number(recForm.cash_advance_deduction||0)+Number(recForm.loan_deduction||0)
            return (
              <div style={{background:`${C.accent}12`,border:`2px solid ${C.accent}44`,borderRadius:10,padding:16,textAlign:'center',marginBottom:14}}>
                <div style={{display:'flex',justifyContent:'center',gap:20,flexWrap:'wrap',marginBottom:8,fontSize:12,color:C.gray}}>
                  <span>Gross: <b style={{color:C.dark}}>{fmt(g)}</b></span>
                  <span>+Allow: <b style={{color:C.accent}}>{fmt(recForm.allowance)}</b></span>
                  <span>Ded: <b style={{color:C.red}}>{fmt(totalDed)}</b></span>
                </div>
                <div style={{fontSize:10,fontWeight:800,letterSpacing:2,color:C.gray,textTransform:'uppercase'}}>Net Pay</div>
                <div style={{fontSize:26,fontWeight:900,color:C.darkGreen,marginTop:4}}>{fmt(net)}</div>
              </div>
            )
          })()}
          {error&&<div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            {selectedRec&&<button onClick={deleteRec} disabled={saving} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.red}`,background:'transparent',color:C.red,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Delete</button>}
            <button onClick={()=>setShowRecModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={saveRec} disabled={saving} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',boxShadow:`0 3px 10px ${C.accent}44`}}>{saving?'Saving…':'Save Record'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── EMPLOYEE MODAL ── */}
      {showEmpModal&&(
        <ModalShell title={selectedEmp?'Edit Employee':'Add Employee'} onClose={()=>setShowEmpModal(false)}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
            <Field label="Full Name" value={empForm.name} onChange={ef('name')} span/>
            <Field label="Role / Position" value={empForm.role} onChange={ef('role')}/>
            <Field label="Department" type="select" value={empForm.department} onChange={ef('department')} options={DEPTS}/>
            <Field label="Employment Type" type="select" value={empForm.employment_type} onChange={ef('employment_type')} options={TYPES}/>
            <Field label="Employment Status" type="select" value={empForm.employment_status} onChange={ef('employment_status')} options={['Regular','Probationary','Training','OJT']}/>
            <Field label={empForm.employment_type==='Salaried'?'Monthly Rate (₱)':'Daily Rate (₱)'} type="number" value={empForm.rate} onChange={ef('rate')}/>
            <Field label="Date Hired" type="date" value={empForm.hire_date||''} onChange={ef('hire_date')}/>
            <Field label="Contact Number" value={empForm.contact} onChange={ef('contact')} placeholder="09XX-XXX-XXXX"/>
            <Field label="Status" type="select" value={empForm.status} onChange={ef('status')} options={['Active','On Leave','Resigned','Terminated']}/>
          </div>

          {/* Convenience only — thinks in monthly terms (e.g. owners), still
              stores a plain daily rate like everyone else underneath. */}
          <div style={{background:'#f9fbf9',border:`1px solid ${C.lightGray}`,borderRadius:8,padding:'12px 14px',marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',marginBottom:8}}>Or compute from a monthly figure</div>
            <div style={{display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap'}}>
              <div>
                <label style={{fontSize:9,color:C.gray,fontWeight:700}}>Monthly Salary (₱)</label>
                <input type="number" value={monthlyCalc} onChange={e=>setMonthlyCalc(Number(e.target.value))} onFocus={e=>e.target.select()} style={{width:140,padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,display:'block',marginTop:3}}/>
              </div>
              <div>
                <label style={{fontSize:9,color:C.gray,fontWeight:700}}>÷ Working Days</label>
                <input type="number" value={monthlyDivisor} onChange={e=>setMonthlyDivisor(Number(e.target.value))} onFocus={e=>e.target.select()} style={{width:90,padding:'7px 9px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12,display:'block',marginTop:3}}/>
              </div>
              <button type="button" onClick={()=>{ if(monthlyCalc>0&&monthlyDivisor>0) ef('rate')(round2(monthlyCalc/monthlyDivisor)) }} style={{padding:'8px 16px',fontSize:11,fontWeight:700,background:`${C.blue}18`,border:`1px solid ${C.blue}44`,color:C.blue,borderRadius:6,cursor:'pointer'}}>Use as Daily Rate →</button>
              {monthlyCalc>0 && monthlyDivisor>0 && <span style={{fontSize:11,color:C.gray}}>= {fmt(round2(monthlyCalc/monthlyDivisor))}/day</span>}
            </div>
          </div>

          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
          </div>
          {empForm.employment_type!=='Salaried' && (
            <div style={{background:'#f9fbf9',border:`1px solid ${C.lightGray}`,borderRadius:8,padding:'12px 14px',marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8,marginBottom:6}}>
                <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase'}}>Daily Rate Schedule (raises)</div>
                <div style={{display:'flex',gap:12}}>
                  <button type="button" onClick={()=>{
                    if(!empForm.hire_date){setError('Set the Date Hired first.');return}
                    setError('')
                    setRateRows(rows=>{
                      const have=new Set(rows.map(r=>r.effective_from))
                      const add=[{effective_from:empForm.hire_date,rate:String(empForm.rate||'')},{effective_from:raiseDateFor(empForm.hire_date,3),rate:''},{effective_from:raiseDateFor(empForm.hire_date,6),rate:''}].filter(r=>!have.has(r.effective_from))
                      return [...rows,...add]
                    })
                  }} style={{fontSize:10,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>Fill 3- &amp; 6-month raise dates</button>
                  <button type="button" onClick={()=>setRateRows(r=>[...r,{effective_from:'',rate:''}])} style={{fontSize:10,fontWeight:700,color:C.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>+ Add rate change</button>
                </div>
              </div>
              <div style={{fontSize:10,color:C.gray,marginBottom:8}}>Each day is paid at the rate in force on that date, so a raise in the middle of a cutoff is split automatically. The raise starts the day after the 3-month / 6-month mark. Leave empty to use the single Daily Rate above. Rows without a rate are ignored.</div>
              {rateRows.map((r,i)=>(
                <div key={i} style={{display:'flex',gap:8,alignItems:'center',marginBottom:6,flexWrap:'wrap'}}>
                  <span style={{fontSize:10,color:C.gray,width:70}}>Effective from</span>
                  <input type="date" value={r.effective_from} onChange={e=>setRateRows(rs=>rs.map((x,j)=>j===i?{...x,effective_from:e.target.value}:x))} style={{padding:'6px 8px',border:`1.5px solid ${C.lightGray}`,borderRadius:6,fontSize:12}}/>
                  <span style={{fontSize:10,color:C.gray}}>₱/day</span>
                  <input type="number" value={r.rate} placeholder="rate" onChange={e=>setRateRows(rs=>rs.map((x,j)=>j===i?{...x,rate:e.target.value}:x))} onFocus={e=>e.target.select()} style={{width:100,padding:'6px 8px',border:`1.5px solid ${r.rate?C.lightGray:C.amber}`,borderRadius:6,fontSize:12}}/>
                  <button type="button" onClick={()=>setRateRows(rs=>rs.filter((_,j)=>j!==i))} style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'3px 8px',cursor:'pointer',fontSize:10}}>✕</button>
                </div>
              ))}
            </div>
          )}

          {empForm.employment_type==='Salaried' && Number(empForm.rate)>0 && (
            <div style={{fontSize:11,color:C.gray,marginTop:-8,marginBottom:14}}>= {fmt(Number(empForm.rate)/2)}/cutoff — paid in full every cutoff, not tied to attendance</div>
          )}
          <div style={{display:'flex',gap:16,marginBottom:14,padding:'10px 14px',background:'#f9fbf9',borderRadius:8,flexWrap:'wrap'}}>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,cursor:'pointer'}}>
              <input type="checkbox" checked={empForm.sss_exempt} onChange={e=>setEmpForm((p:any)=>({...p,sss_exempt:e.target.checked}))}/>
              SSS exempt (no deduction)
            </label>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,cursor:'pointer'}}>
              <input type="checkbox" checked={empForm.philhealth_exempt} onChange={e=>setEmpForm((p:any)=>({...p,philhealth_exempt:e.target.checked,philhealth_doubled:e.target.checked?false:p.philhealth_doubled}))}/>
              PhilHealth exempt (no deduction)
            </label>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,cursor:'pointer',opacity:empForm.philhealth_exempt?0.4:1}}>
              <input type="checkbox" checked={empForm.philhealth_doubled} disabled={empForm.philhealth_exempt} onChange={e=>setEmpForm((p:any)=>({...p,philhealth_doubled:e.target.checked}))}/>
              PhilHealth doubled (₱250/cutoff)
            </label>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,cursor:'pointer'}}>
              <input type="checkbox" checked={empForm.pagibig_exempt} onChange={e=>setEmpForm((p:any)=>({...p,pagibig_exempt:e.target.checked,pagibig_doubled:e.target.checked?false:p.pagibig_doubled}))}/>
              Pag-IBIG exempt (no deduction)
            </label>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,cursor:'pointer',opacity:empForm.pagibig_exempt?0.4:1}}>
              <input type="checkbox" checked={empForm.pagibig_doubled} disabled={empForm.pagibig_exempt} onChange={e=>setEmpForm((p:any)=>({...p,pagibig_doubled:e.target.checked}))}/>
              Pag-IBIG doubled (₱200/cutoff)
            </label>
          </div>
          <div style={{marginBottom:14,padding:'10px 14px',background:empForm.ot_exempt?`${C.amber}12`:'#f9fbf9',border:`1px solid ${empForm.ot_exempt?C.amber:C.lightGray}`,borderRadius:8}}>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,fontWeight:700,cursor:'pointer'}}>
              <input type="checkbox" checked={empForm.ot_exempt} onChange={e=>setEmpForm((p:any)=>({...p,ot_exempt:e.target.checked}))}/>
              OT Exempt — fixed rate, no overtime pay (managerial/supervisory)
            </label>
            <div style={{fontSize:10,color:C.gray,marginTop:4,marginLeft:24}}>Pay stays based on days present only. Any Approved Overtime entered on their attendance is ignored — nothing gets paid for it, regardless of what's logged.</div>
          </div>
          <div style={{marginBottom:14,padding:'10px 14px',background:empForm.full_day_pay?`${C.blue}12`:'#f9fbf9',border:`1px solid ${empForm.full_day_pay?C.blue:C.lightGray}`,borderRadius:8}}>
            <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,fontWeight:700,cursor:'pointer'}}>
              <input type="checkbox" checked={empForm.full_day_pay} onChange={e=>setEmpForm((p:any)=>({...p,full_day_pay:e.target.checked}))}/>
              Full-Day Pay — present counts as a complete day, hours don't matter
            </label>
            <div style={{fontSize:10,color:C.gray,marginTop:4,marginLeft:24}}>For owners or a role with a legitimately short schedule (e.g. a cook who leaves after the last meal). Any attendance that day pays the full daily rate — no proration for coming in late or logging fewer hours.</div>
          </div>
          {error&&<div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            {selectedEmp&&<button onClick={deleteEmp} disabled={saving} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.red}`,background:'transparent',color:C.red,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Delete</button>}
            <button onClick={()=>setShowEmpModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={saveEmp} disabled={saving} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',boxShadow:`0 3px 10px ${C.accent}44`}}>{saving?'Saving…':'Save Employee'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── NEW CASH ADVANCE MODAL ── */}
      {showCAModal&&(
        <ModalShell title="New Cash Advance" onClose={()=>setShowCAModal(false)} accentColor={C.amber}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
            <div style={{marginBottom:14,gridColumn:'1/-1'}}>
              <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Employee</label>
              <select value={caForm.employee_id} onChange={e=>{
                  const empId=e.target.value
                  const seq=cashAdvances.filter(ca=>ca.employee_id===empId).length+1
                  setCaForm((p:any)=>({...p, employee_id:empId, id: p.id || `CA-${empId}-${String(seq).padStart(2,'0')}`}))
                }} style={inputStyle}>
                <option value="">Select employee…</option>
                {employees.map(e=><option key={e.id} value={e.id}>{e.name} — {e.role}</option>)}
              </select>
            </div>
            <div style={{marginBottom:14}}>
              <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Reference Number</label>
              <input value={caForm.id} onChange={e=>{const v=e.target.value.toUpperCase(); caf('id')(v); checkCaId(v)}} onFocus={e=>e.target.select()} style={inputStyle}/>
              {caForm.id && <div style={{fontSize:10,marginTop:5,fontWeight:700,color:caIdAvailable?C.accent:C.red}}>{caIdAvailable?'✓ Available':'⚠ Already in use'}</div>}
            </div>
            <Field label="Date Issued" type="date" value={caForm.date_issued} onChange={caf('date_issued')}/>
            <Field label="Amount (₱)" type="number" value={caForm.amount} onChange={caf('amount')} span/>
            <div style={{marginBottom:14,gridColumn:'1/-1'}}>
              <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Notes</label>
              <textarea value={caForm.notes} onChange={e=>caf('notes')(e.target.value)} rows={2} style={{...inputStyle,resize:'vertical'}} placeholder="Reason for advance, agreed repayment schedule, etc."/>
            </div>
          </div>
          {error&&<div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowCAModal(false)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={saveCA} disabled={saving||!caIdAvailable} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:`linear-gradient(135deg,${C.amber},#b45309)`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',opacity:(saving||!caIdAvailable)?0.6:1}}>{saving?'Saving…':'Issue Advance'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── RECORD PAYMENT MODAL ── */}
      {showPayModal&&(
        <ModalShell title={`Record Payment — ${showPayModal.id}`} onClose={()=>setShowPayModal(null)} accentColor={C.accent}>
          <div style={{background:`${C.amber}08`,border:`1px solid ${C.amber}33`,borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:12,color:C.dark}}>
            {showPayModal.employees?.name} — remaining balance: <b>{fmt(showPayModal.balance)}</b>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 14px'}}>
            <Field label="Amount (₱)" type="number" value={payForm.amount} onChange={(v:any)=>setPayForm(p=>({...p,amount:v}))}/>
            <Field label="Date" type="date" value={payForm.date} onChange={(v:any)=>setPayForm(p=>({...p,date:v}))}/>
            <Field label="Method" type="select" value={payForm.method} onChange={(v:any)=>setPayForm(p=>({...p,method:v}))} options={['Cash Payment','Payroll Deduction','Other']} span/>
            <div style={{marginBottom:14,gridColumn:'1/-1'}}>
              <label style={{fontSize:10,fontWeight:800,letterSpacing:1.5,color:C.gray,textTransform:'uppercase',display:'block',marginBottom:5}}>Notes</label>
              <input value={payForm.notes} onChange={e=>setPayForm(p=>({...p,notes:e.target.value}))} onFocus={e=>e.target.select()} onBlur={e=>{if(!e.target.value.trim()) setPayForm(p=>({...p,notes:'N/A'}))}} style={inputStyle}/>
            </div>
          </div>
          {error&&<div style={{background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:6,padding:'10px 14px',fontSize:12,color:C.red,marginBottom:14}}>{error}</div>}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowPayModal(null)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,letterSpacing:1,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase'}}>Cancel</button>
            <button onClick={submitPayment} disabled={saving} style={{padding:'9px 22px',fontSize:11,fontWeight:800,letterSpacing:1,background:`linear-gradient(135deg,${C.accent},${C.midGreen})`,border:'none',color:C.white,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',boxShadow:`0 3px 10px ${C.accent}44`}}>{saving?'Saving…':'Record Payment'}</button>
          </div>
        </ModalShell>
      )}

      {/* ── LEDGER MODAL ── */}
      {showLedger&&(
        <ModalShell title={`Ledger — ${showLedger.id}`} onClose={()=>setShowLedger(null)} accentColor={C.blue}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:16,flexWrap:'wrap',gap:8}}>
            <span style={{fontSize:12,color:C.gray}}>Employee: <b style={{color:C.dark}}>{showLedger.employees?.name}</b></span>
            <span style={{fontSize:12,color:C.gray}}>Original: <b style={{color:C.dark}}>{fmt(showLedger.amount)}</b></span>
            <span style={{fontSize:12,color:C.gray}}>Balance: <b style={{color:showLedger.status==='Open'?C.amber:C.accent}}>{fmt(showLedger.balance)}</b></span>
            <Badge label={showLedger.status}/>
          </div>
          {ledgerRows.length===0
            ? <div style={{textAlign:'center',padding:30,color:C.gray,fontSize:12}}>No payments recorded yet.</div>
            : <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:`linear-gradient(90deg,${C.darkGreen},${C.midGreen})`}}>
                  {['Date','Method','Amount','Notes',''].map(h=><th key={h} style={{padding:'8px 10px',textAlign:'left',color:C.white,fontWeight:800,fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>{h}</th>)}
                </tr></thead>
                <tbody>{ledgerRows.map((p,i)=>(
                  <tr key={p.id} style={{background:i%2===0?C.white:'#f9fbf9',borderBottom:`1px solid ${C.lightGray}`}}>
                    <td style={{padding:'8px 10px',color:C.gray}}>{p.date}</td>
                    <td style={{padding:'8px 10px'}}><span style={{padding:'2px 8px',borderRadius:20,background:p.method==='Payroll Deduction'?`${C.purple}18`:`${C.accent}18`,color:p.method==='Payroll Deduction'?C.purple:C.accent,fontSize:10,fontWeight:800}}>{p.method}</span></td>
                    <td style={{padding:'8px 10px',fontWeight:800,color:C.dark}}>{fmt(p.amount)}</td>
                    <td style={{padding:'8px 10px',color:C.gray,fontSize:11}}>{p.notes||'—'}</td>
                    <td style={{padding:'8px 10px'}}>{canEdit&&<button onClick={()=>deleteLedgerPayment(p.id)} style={{background:`${C.red}18`,border:`1px solid ${C.red}44`,color:C.red,borderRadius:4,padding:'4px 9px',cursor:'pointer',fontSize:10,fontWeight:700}}>✕</button>}</td>
                  </tr>
                ))}</tbody>
              </table>}
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:16}}>
            <button onClick={()=>setShowLedger(null)} style={{padding:'9px 18px',fontSize:11,fontWeight:800,border:`2px solid ${C.accent}`,background:'transparent',color:C.accent,borderRadius:6,cursor:'pointer',fontFamily:'inherit',textTransform:'uppercase',letterSpacing:1}}>Close</button>
          </div>
        </ModalShell>
      )}
    </div>
  )
}