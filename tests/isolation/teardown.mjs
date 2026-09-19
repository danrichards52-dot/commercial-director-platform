import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Admin-only cleanup script — pairs with setup.mjs as the only two files that touch
// SUPABASE_SERVICE_ROLE_KEY. Deliberately separate from run.mjs's isolation assertions.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set in this process's env."
  );
  process.exit(1);
}

const fixturesPath = fileURLToPath(new URL("./.fixtures.json", import.meta.url));
if (!existsSync(fixturesPath)) {
  console.log("No fixtures file found — nothing to tear down.");
  process.exit(0);
}
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let failures = 0;
const testUserIds = new Set(fixtures.users.map((u) => u.id));

const { data: businesses, error: bizError } = await admin.from("businesses").select("id, owner_user_id");
if (bizError) {
  console.error("Failed to list businesses for cleanup:", bizError.message);
  failures++;
} else {
  const testBusinesses = (businesses ?? []).filter((b) => testUserIds.has(b.owner_user_id));

  for (const biz of testBusinesses) {
    const { data: objects, error: listError } = await admin.storage.from("uploads").list(biz.id);
    if (listError) {
      console.error(`Failed to list storage objects for business ${biz.id}:`, listError.message);
      failures++;
      continue;
    }
    if (objects && objects.length > 0) {
      const paths = objects.map((o) => `${biz.id}/${o.name}`);
      const { error: removeError } = await admin.storage.from("uploads").remove(paths);
      if (removeError) {
        console.error(`Failed to remove storage objects for business ${biz.id}:`, removeError.message);
        failures++;
      } else {
        console.log(`Removed ${paths.length} storage object(s) for business ${biz.id}`);
      }
    }
  }

  for (const biz of testBusinesses) {
    const { error: delError } = await admin.from("businesses").delete().eq("id", biz.id);
    if (delError) {
      console.error(`Failed to delete business ${biz.id}:`, delError.message);
      failures++;
    } else {
      console.log(`Deleted business ${biz.id}`);
    }
  }
}

for (const u of fixtures.users) {
  const { error } = await admin.auth.admin.deleteUser(u.id);
  if (error) {
    console.error(`Failed to delete auth user ${u.label} (${u.id}):`, error.message);
    failures++;
  } else {
    console.log(`Deleted auth user ${u.label} (${u.id})`);
  }
}

unlinkSync(fixturesPath);

if (failures > 0) {
  console.error(`\nTeardown finished with ${failures} failure(s) — see above.`);
  process.exit(1);
}
console.log("\nTeardown complete, no failures.");
