import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/auth/login — email+password sign-in.
 *
 * Uses the session-scoped server client (lib/supabase/server.ts), so a successful
 * sign-in sets the real Supabase session cookie via @supabase/ssr's cookie adapter —
 * the same mechanism every other server route relies on to identify the caller.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = body?.email;
  const password = body?.password;

  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    return NextResponse.json({ error: error?.message ?? "sign-in failed" }, { status: 401 });
  }

  return NextResponse.json({ user: { id: data.user.id, email: data.user.email } });
}
