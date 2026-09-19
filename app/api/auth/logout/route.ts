import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** POST /api/auth/logout — clears the caller's session cookie via the same server client. */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
