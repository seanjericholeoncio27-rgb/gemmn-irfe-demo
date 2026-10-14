// ============================================================
// FILE: lib/supabase-server.ts  (server-side client)
// ============================================================
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const SESSION_MAX_AGE = 60 * 60 * 1 // must match lib/supabase.ts and middleware.ts

export const createServerSupabaseClient = () => {
  const cookieStore = cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: any) {
          const capped = { ...options, maxAge: Math.min(options.maxAge ?? SESSION_MAX_AGE, SESSION_MAX_AGE) }
          try { cookieStore.set({ name, value, ...capped }) } catch {}
        },
        remove(name: string, options: any) {
          const { maxAge, expires, ...rest } = options
          try { cookieStore.set({ name, value: '', ...rest }) } catch {}
        },
      },
    }
  )
}

export const createAdminClient = () => {
  const { createClient } = require('@supabase/supabase-js')
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}