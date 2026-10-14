// ============================================================
// FILE: lib/fetchAll.ts
// ============================================================
// Supabase's PostgREST layer enforces a server-side row cap (db-max-rows,
// 1000 by default on a standard project) on every request, independent of
// whatever .range() the client asks for — requesting .range(0, 9999) does
// NOT override it; the server still returns at most 1000 rows per call.
//
// Any table that can realistically grow past 1000 rows (quotations,
// projects, and friends, after the historical-data migration) must be
// fetched in batches and concatenated client-side. This helper does that:
// it re-issues the same query with an advancing .range() until a batch
// comes back short of a full page, which is the signal there's no more data.
//
// Usage: pass a function that, given (from, to), returns the Supabase query
// for that page — e.g.:
//   const data = await fetchAll((from, to) =>
//     supabase.from('quotations').select('*, quotation_items(*)').order('created_at', { ascending: false }).range(from, to)
//   )
import type { PostgrestError } from '@supabase/supabase-js'

const PAGE_SIZE = 1000

// Returns { data } (mirroring the shape of a plain Supabase call) so it drops
// into existing `const { data } = await ...` and `Promise.all([...])` /
// `{data: x}` destructuring call sites with a minimal diff.
export async function fetchAll<T>(
  queryFn: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>
): Promise<{ data: T[] }> {
  const out: T[] = []
  let from = 0
  // Hard stop at 500 pages (500,000 rows) so a bug elsewhere can't spin this
  // into an infinite loop against the database.
  for (let page = 0; page < 500; page++) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await queryFn(from, to)
    if (error) throw error
    const batch = data || []
    out.push(...batch)
    if (batch.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { data: out }
}
