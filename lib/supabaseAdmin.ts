import { createClient } from '@supabase/supabase-js'

// IMPORTANT: this file must only ever be imported from server-side code
// (API routes, Server Components, Server Actions) — never from a 'use client'
// component. The service role key it uses bypasses Row Level Security and
// can do anything to your database, so it must never reach the browser.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!, // NOT prefixed with NEXT_PUBLIC_
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}
