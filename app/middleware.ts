// ============================================================
// FILE: middleware.ts  (root of project)
// ============================================================
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const SESSION_MAX_AGE = 60 * 60 * 8 // must match lib/supabase.ts

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: any) {
          // Cap maxAge at 8 hours — a cookie that actually expires can't be
          // resurrected by Chrome's "Continue where you left off" the way a
          // pure session cookie can, since there's nothing left to restore.
          const capped = { ...options, maxAge: Math.min(options.maxAge ?? SESSION_MAX_AGE, SESSION_MAX_AGE) }
          request.cookies.set({ name, value, ...capped })
          response = NextResponse.next({
            request: { headers: request.headers },
          })
          response.cookies.set({ name, value, ...capped })
        },
        remove(name: string, options: any) {
          const { maxAge, expires, ...rest } = options
          request.cookies.set({ name, value: '', ...rest })
          response = NextResponse.next({
            request: { headers: request.headers },
          })
          response.cookies.set({ name, value: '', ...rest })
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const path = request.nextUrl.pathname

  if (!user && path.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (user && path === '/login') {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return response
}

export const config = {
  matcher: ['/dashboard/:path*', '/login'],
}