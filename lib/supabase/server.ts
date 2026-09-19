import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Server client — built from the caller's own session cookies, anon key only.
 * This is the only Supabase client any API route or server component may use.
 *
 * doc 05's single most important line: the service-role key must never appear in a
 * user-facing request path, or every RLS policy becomes decorative. If a route ever
 * needs elevated access, that is a signal to stop and re-read doc 05, not to reach
 * for SUPABASE_SERVICE_ROLE_KEY here.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component with no request/response to write to —
            // safe to ignore as long as middleware refreshes the session (see lib/supabase/middleware.ts).
          }
        },
      },
    }
  );
}
