// ============================================================
// FILE: types/index.ts
// ============================================================
export type UserRole = 'accountant' | 'manager'

export interface Profile {
  id: string
  full_name: string
  role: UserRole
}

export interface Project {
  id: string
  name: string
  client: string
  type: string
  status: string
  start_date: string
  end_date: string
  value: number
  progress: number
  progress_manual?: boolean
  manager: string
  notes: string
  po_number?: string | null
  quotation_id?: string | null
  invoice_id?: string | null
  dr_number?: string | null
  delivery_date_needed?: string | null
  actual_delivery_date?: string | null
  payment_terms_days?: number
  cr_number?: string | null
  collection_date?: string | null
  collection_amount?: number
  date_collected?: string | null
  payment_status?: string
  po_total_value?: number;
}

export interface QuotationItem {
  id?: string
  quotation_id?: string
  description: string
  qty: number
  unit: string
  price: number
}

export interface Quotation {
  id: string
  client: string
  date: string
  valid_until: string
  status: string
  notes: string
  tax: number
  quotation_items?: QuotationItem[]
}

export interface InvoiceItem {
  id?: string
  invoice_id?: string
  description: string
  qty: number
  unit: string
  price: number
}

export interface Invoice {
  id: string
  quotation_id?: string
  client: string
  date: string
  due_date: string
  status: string
  notes: string
  tax: number
  invoice_items?: InvoiceItem[]
}

export interface Employee {
  id: string
  name: string
  role: string
  department: string
  employment_type: string
  rate: number
  contact: string
  status: string
}

export interface PayrollRecord {
  id?: string
  employee_id: string
  period: string
  days_worked: number
  overtime_hours: number
  allowance: number
  sss: number
  philhealth: number
  pagibig: number
  tax: number
  status: string
  employees?: Employee
}

export interface Expense {
  id: string
  date: string
  category: string
  description: string
  amount: number
  payment_method: string
  receipt: string
  status: string
}

export interface InventoryItem {
  id: string
  name: string
  unit: string
  quantity: number
  min_stock: number
  unit_cost: number
  supplier: string
  category?: string
}

export interface Equipment {
  id: string
  name: string
  brand: string
  status: string
  assigned_to: string
  last_maintenance: string
  price?: number
  date_acquired?: string
  quantity?: number
}