import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Admin-only provisioning script. This is the ONLY file in tests/isolation that may
// reference SUPABASE_SERVICE_ROLE_KEY. run.mjs (the isolation assertions themselves)
// must never import it or read that env var — see the header comment there.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set in this process's env."
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();
const password = `Isolation-Test-${randomUUID()}!`;

const userDefs = [
  { label: "userA", email: `isolation-test-a-${suffix}@example.test` },
  { label: "userB", email: `isolation-test-b-${suffix}@example.test` },
];

const fixtures = { password, users: [] };

for (const def of userDefs) {
  // email_confirm: true confirms only this one disposable account at creation time —
  // it does not touch the project's own "Confirm email" setting.
  const { data, error } = await admin.auth.admin.createUser({
    email: def.email,
    password,
    email_confirm: true,
  });
  if (error) {
    console.error(`Failed to create ${def.label} (${def.email}):`, error.message);
    process.exit(1);
  }
  fixtures.users.push({ label: def.label, email: def.email, id: data.user.id });
  console.log(`Created ${def.label}: ${def.email} (${data.user.id})`);
}

const fixturesPath = fileURLToPath(new URL("./.fixtures.json", import.meta.url));
writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 2));
console.log(`Fixtures written to ${fixturesPath}`);
