// ============================================================
// FILE: lib/supabase.ts  (browser client)
// ============================================================
import { createBrowserClient } from '@supabase/ssr'

const SESSION_MAX_AGE = 60 * 60 * 1 // 1 hour, in seconds — adjust if you want it shorter

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: {
        maxAge: SESSION_MAX_AGE,
      },
    }
  )
}