# GEMMN IRFE — Integrated Resource & Financial Ecosystem (portfolio demo)

A full-stack operations platform I designed and built for **GEMMN Engineering Works**, a metal-fabrication company in Bulacan, Philippines. It replaces spreadsheets and paper forms with one system for quotations, billing, project tracking, payroll, purchasing, inventory and accounting.

> **This repository is a demo copy.** The production system runs on the company's real data. Everything in this repo's database is **fictional sample data** (invented clients, employees, prices and projects). No real company records, customer data or credentials are included.

**Stack:** Next.js 14 (App Router) · TypeScript · Supabase (PostgreSQL, Auth, Storage, Row Level Security) · deployed on Vercel

---

## What it does

| Module | Highlights |
|---|---|
| **Quotations** | Line items with material sub-rows, a standardized **Cost Builder** (materials → labor from a lead-time table → contingency → markup), versioning, client-ready print/PDF layout matching the company's physical quotation sheet, scope-of-work headings, info rows, resizable reference images |
| **Invoices** | Generated from approved quotations, VAT modes (included / excluded / exempt), collection and overdue tracking |
| **Projects** | PO-driven project monitor, automatic progress/stage from real events, bill of materials, timeline, delivery and collection status |
| **Payroll** | Biometric attendance import → per-day hours → payroll with overtime, Sunday and holiday premiums, night differential, SSS / PhilHealth / Pag-IBIG, loans and cash advances, payslips. Supports **mid-period daily-rate changes** (e.g. probationary raises) through a dated rate history |
| **Purchasing** | Material requests → supplier quotes → purchase orders → receiving, with approval thresholds |
| **Inventory & Resources** | Stock levels with minimums, material releases and returns, equipment register, loans and assignments |
| **Expenses & Accounting** | Expense ledger, bank ledger with outstanding checks, petty-cash fund and vouchers |
| **Reports & Audit** | Management reports and a full audit log of data changes |
| **Access control** | Role-based module access (view vs. edit per module), user approval workflow, admin-managed roles |

## Engineering notes

- **Data migration pipeline:** CSV/Excel import to bring several years of real transaction history into the system, with normalization and de-duplication.
- **Role-based reporting:** different views for accountant, manager and viewer roles, enforced both in the UI and by Row Level Security.
- **Date-effective pay rates:** an `employee_rates` history table lets one payroll period price each attendance day at the rate in force on that day, then stores a per-rate breakdown for audit.
- **Server-side admin boundary:** privileged actions (user creation, role management) run in API routes with the service-role key; the browser never sees it.
- **Design validation:** the build-vs-buy decision (ERP vs. low-code vs. lean framework) was evaluated with AHP and Pareto analysis as part of an undergraduate thesis.

## Try the demo

Use the role buttons on the login page (all share the password `Demo#2026`):

| Username | Role | Access |
|---|---|---|
| `admin` | Administrator | everything, including user access and audit log |
| `accountant` | Accountant | finance, payroll, billing |
| `viewer` | Viewer | read-only, no payroll/admin |

Public sign-up is disabled in demo mode. The demo database may be reset periodically.

## Run it yourself

1. Create a free [Supabase](https://supabase.com) project.
2. In the SQL editor run, in order: `supabase/01_schema.sql`, then `supabase/02_seed.sql`.
3. Copy `.env.example` to `.env.local` and fill in your project URL, anon key and service-role key.
4. `npm install && npm run dev` → http://localhost:3000

### Reset the demo
`supabase/03_reset_demo.sql` empties all data tables; re-run the seed afterwards.

## About

Built and maintained by **Sean Jericho V. Leoncio** (Industrial Engineering, UST — Cum Laude) as Systems Engineer at GEMMN Engineering Works.
The company name and logo appear to show the real project this came from; all sample data is invented.

*Seed data and Row Level Security policies in this repo are simplified for demonstration; the production system uses stricter per-role policies.*
