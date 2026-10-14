// ============================================================
// FILE: lib/parseQuotationExcel.ts
// ============================================================
// Parses a quotation Excel file built on the company's "Standard" sheet
// template (same cell layout the historical-migration parser used) into a
// structured object the Quotations page can show on a review screen before
// saving — fields, items, materials, the sheet's own stated totals (for the
// computation cross-check), and any images embedded in the file.
//
// Cell layout mirrors the original Python migration parser exactly, so a
// file that migrated cleanly before will parse the same way here:
//   O2  quotation number        O3  delivery date       O4  payment terms
//   O6  prepared by             D12 company name        D13 address
//   D14 attention
//   Item rows 19-39:  B = item marker (numeric), C = description (spans
//     every row since the previous item row), J = qty, L = unit, N = price,
//     O = line total
//   Material rows 21-35: T = description, U = qty, V = unit, W = price
//   Cost-breakdown rows 36-55: T = label, X = value (numeric only)

export type ParsedQuotationItem = {
  row: number | null
  description: string
  qty: number | null
  unit: string | null
  price: number | null
  total: number | null // the sheet's own stated line total, for the cross-check
}

export type ParsedQuotationMaterial = {
  description: string
  qty: number | null
  unit: string | null
  price: number | null
}

export type ParsedQuotationImage = {
  name: string
  blob: Blob
  dataUrl: string
  width: number | null
  height: number | null
  // Best-effort default so the review screen doesn't start every image as a
  // bare, unclassified attachment — the user can always override it. Every
  // file includes the boilerplate GEMMN letterhead/logo and a sales-rep
  // signature alongside the actual item photo, and those two should never
  // land in the generic Attachments list.
  guessedRole: 'logo' | 'signature' | 'item_photo'
}

// Mirrors app/dashboard/quotations/page.tsx's CostBreakdown shape (the "Cost
// Builder" feature) closely enough to seed it on import — kept as a separate,
// minimal type here since this module has no import access to that page.
export type ParsedCostBreakdownSeed = {
  materialMarkupPct: number
  treatmentCost: number
  labor: { process: string; hours: number; rate: number; unit: 'HR' }[]
  contingencyPct: number
  markupPct: number
  installation: number
  mobilization: number
  leewayPct: number
}

export type ParsedQuotation = {
  quotationNumber: string | null
  deliveryDate: string | null
  paymentTerms: string | null
  preparedBy: string | null
  companyName: string | null
  address: string | null
  attention: string | null
  items: ParsedQuotationItem[]
  materials: ParsedQuotationMaterial[]
  costBreakdown: Record<string, number>
  // Best-effort mapping of the raw costBreakdown dict onto the app's Cost
  // Builder fields — null if the sheet had no recognizable cost-breakdown
  // table at all. Percentages are parsed out of the sheet's own labels
  // (e.g. "Contingency (+10%)") since the X-column values next to them are
  // the resulting peso amounts, not the percentages themselves.
  costBuilderSeed: ParsedCostBreakdownSeed | null
  images: ParsedQuotationImage[]
  // sheet's own stated grand total, if findable in the cost breakdown —
  // used for the "does this match what the system computes" check
  sheetStatedTotal: number | null
}

function cellStr(ws: any, addr: string): string | null {
  const v = ws[addr]?.v
  if (v === undefined || v === null || v === '') return null
  return String(v).trim()
}
function cellNum(ws: any, addr: string): number | null {
  const v = ws[addr]?.v
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function cellRaw(ws: any, addr: string): any {
  return ws[addr]?.v ?? null
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
}

// TS's DOM lib types Blob's constructor as wanting a plain ArrayBuffer, not
// the broader ArrayBufferLike a Uint8Array view reports — slice() always
// returns a real, freshly-copied ArrayBuffer, which sidesteps the mismatch
// (and also protects against the underlying buffer being larger than the view).
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const blob = new Blob([toArrayBuffer(bytes)], { type: mime })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Pixel dimensions, read via the browser's own image decoder rather than
// hand-parsing PNG/JPEG headers — best-effort only, never blocks the import.
async function imageDims(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    const bmp = await createImageBitmap(blob)
    const dims = { width: bmp.width, height: bmp.height }
    bmp.close?.()
    return dims
  } catch {
    return { width: null, height: null }
  }
}

// A rough, overridable default — not a reliable classifier. Signatures scan
// wide and short; the GEMMN letterhead/logo is small and roughly square;
// anything else embedded in the sheet is most likely the actual item photo.
function guessImageRole(width: number | null, height: number | null): 'logo' | 'signature' | 'item_photo' {
  if (!width || !height) return 'item_photo'
  const aspect = width / height
  if (aspect >= 2.2 && height <= 160) return 'signature'
  if (aspect >= 0.55 && aspect <= 1.8 && Math.max(width, height) <= 220) return 'logo'
  return 'item_photo'
}

// The X-column value next to a cost-breakdown label is the resulting peso
// amount after applying that percentage, not the percentage itself — the
// percentage only appears written into the label text, e.g. "Contingency
// (+10%)". Pull it out of there, falling back to the Cost Builder's own
// default when a label doesn't carry one (or wasn't found at all).
function pctFromLabel(label: string | undefined, fallback: number): number {
  if (!label) return fallback
  const m = label.match(/([\d.]+)\s*%/)
  return m ? Number(m[1]) : fallback
}

function buildCostBreakdownSeed(costBreakdown: Record<string, number>): ParsedCostBreakdownSeed | null {
  const keys = Object.keys(costBreakdown)
  if (!keys.length) return null
  const find = (pred: (k: string) => boolean) => keys.find(pred)

  const materialMarkupKey = find(k => /material/i.test(k) && /%|\+/.test(k))
  const treatmentKey = find(k => /treatment/i.test(k))
  const laborKey = find(k => /labor/i.test(k))
  const contingencyKey = find(k => /contingency/i.test(k))
  const markupKey = find(k => /mark-?\s?up/i.test(k))
  const installationKey = find(k => /installation/i.test(k))
  const mobilizationKey = find(k => /mobilization/i.test(k))
  const additionalKey = find(k => /additional/i.test(k))

  // Nothing at all recognizable — don't pretend there's a seed to apply.
  if (!materialMarkupKey && !contingencyKey && !markupKey && !treatmentKey && !laborKey) return null

  const laborCost = laborKey ? costBreakdown[laborKey] : 0

  let leewayPct = 10
  if (additionalKey) {
    const v = costBreakdown[additionalKey]
    // Some sheets store a percent cell as the fraction (0.15) under a
    // percentage display format; normalize anything <=1 up to a whole percent.
    leewayPct = v <= 1 ? v * 100 : v
  }

  return {
    materialMarkupPct: pctFromLabel(materialMarkupKey, 30),
    treatmentCost: treatmentKey ? (costBreakdown[treatmentKey] || 0) : 0,
    labor: laborCost ? [{ process: 'Imported Labor', hours: 1, rate: laborCost, unit: 'HR' as const }] : [],
    contingencyPct: pctFromLabel(contingencyKey, 10),
    markupPct: pctFromLabel(markupKey, 10),
    installation: installationKey ? (costBreakdown[installationKey] || 0) : 0,
    mobilization: mobilizationKey ? (costBreakdown[mobilizationKey] || 0) : 0,
    leewayPct,
  }
}

export async function parseQuotationExcel(file: File): Promise<ParsedQuotation> {
  const XLSX: any = await import('xlsx')
  const buf = await file.arrayBuffer()
  // bookFiles: true also stashes every raw zip entry (including xl/media/*
  // embedded images) on wb.files, keyed by path inside the xlsx archive.
  const wb = XLSX.read(buf, { type: 'array', bookFiles: true })

  const ws = wb.Sheets?.['Standard']
  if (!ws) {
    throw new Error('This file has no "Standard" sheet — it doesn\'t match the quotation template, so it can\'t be auto-imported.')
  }

  const quotationNumber = cellStr(ws, 'O2')
  const deliveryDate = cellStr(ws, 'O3')
  const paymentTerms = cellStr(ws, 'O4')
  const preparedBy = cellStr(ws, 'O6')
  const companyName = cellStr(ws, 'D12')
  const address = cellStr(ws, 'D13')
  const attention = cellStr(ws, 'D14')

  // ---- item rows: numeric marker in column B, rows 19-39 ----
  const itemRowNums: number[] = []
  for (let r = 19; r <= 39; r++) {
    const v = cellRaw(ws, `B${r}`)
    if (typeof v === 'number' && Number.isFinite(v)) itemRowNums.push(r)
  }

  const items: ParsedQuotationItem[] = []
  if (itemRowNums.length) {
    let blockStart = 20
    itemRowNums.forEach((r, idx) => {
      const prevEnd = idx > 0 ? itemRowNums[idx - 1] + 1 : blockStart
      const descParts: string[] = []
      for (let rr = prevEnd; rr <= r; rr++) {
        const v = cellStr(ws, `C${rr}`)
        if (v) descParts.push(v)
      }
      items.push({
        row: r,
        description: descParts.join(' ').trim() || cellStr(ws, `C${r}`) || '',
        qty: cellNum(ws, `J${r}`),
        unit: cellStr(ws, `L${r}`),
        price: cellNum(ws, `N${r}`),
        total: cellNum(ws, `O${r}`),
      })
    })
  } else {
    // fallback: no numbered item markers found — treat the whole description
    // block as a single line item, same fallback the migration parser used.
    const descParts: string[] = []
    for (let rr = 20; rr <= 35; rr++) {
      const v = cellStr(ws, `C${rr}`)
      if (v) descParts.push(v)
    }
    items.push({ row: null, description: descParts.join(' ').trim(), qty: 1, unit: null, price: null, total: null })
  }

  // ---- materials: rows 21-35 ----
  const materials: ParsedQuotationMaterial[] = []
  for (let r = 21; r <= 35; r++) {
    const desc = cellStr(ws, `T${r}`)
    if (!desc) continue
    materials.push({
      description: desc,
      qty: cellNum(ws, `U${r}`),
      unit: cellStr(ws, `V${r}`),
      price: cellNum(ws, `W${r}`),
    })
  }

  // ---- cost breakdown: rows 36-55, label T / value X ----
  const costBreakdown: Record<string, number> = {}
  for (let r = 36; r <= 55; r++) {
    const label = cellStr(ws, `T${r}`)
    const val = cellNum(ws, `X${r}`)
    if (!label || val === null) continue
    if (label.toUpperCase() === 'PROCESS') continue
    costBreakdown[label] = val
  }
  // "Total Price" is the label the template uses for its own grand total —
  // fall back to null (no cross-check shown) if it isn't present.
  const totalKey = Object.keys(costBreakdown).find(k => k.toUpperCase() === 'TOTAL PRICE')
  const sheetStatedTotal = totalKey ? costBreakdown[totalKey] : null

  // ---- embedded images (xl/media/*) ----
  const images: ParsedQuotationImage[] = []
  const files = wb.files || {}
  for (const path of Object.keys(files)) {
    // bookFiles paths sometimes carry a leading slash depending on which
    // internal zip-reading branch produced them — strip it before matching.
    if (!/^\/?xl\/media\//i.test(path)) continue
    const entry = files[path]
    const bytes: Uint8Array = entry?.content
    if (!bytes || !bytes.length) continue
    const ext = (path.split('.').pop() || '').toLowerCase()
    const mime = EXT_MIME[ext] || 'application/octet-stream'
    const dataUrl = await bytesToDataUrl(bytes, mime)
    const blob = new Blob([toArrayBuffer(bytes)], { type: mime })
    const { width, height } = await imageDims(blob)
    images.push({
      name: path.split('/').pop() || path, blob, dataUrl, width, height,
      guessedRole: guessImageRole(width, height),
    })
  }

  const costBuilderSeed = buildCostBreakdownSeed(costBreakdown)

  return {
    quotationNumber, deliveryDate, paymentTerms, preparedBy,
    companyName, address, attention,
    items, materials, costBreakdown, costBuilderSeed, images, sheetStatedTotal,
  }
}
