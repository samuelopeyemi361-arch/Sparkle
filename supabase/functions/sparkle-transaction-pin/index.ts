
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function hashPin(pin: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    key,
    256,
  );
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}

async function checkPin(pin: string, stored: string) {
  const [saltHex, expected] = stored.split(":");
  if (!saltHex || !expected) return false;
  const salt = new Uint8Array(
    saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    key,
    256,
  );
  const actual = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return actual === expected;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method !== "POST") return reply({ error: "POST required" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return reply({ error: "Sign in required" }, 401);
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return reply({ error: "Invalid session" }, 401);

  let body: { action?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
  }

  const { action, pin } = body;
  if (!["set", "verify"].includes(action ?? "")) {
    return reply({ error: "Action must be set or verify" }, 400);
  }
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
    return reply({ error: "PIN must contain 4 to 6 digits" }, 400);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: record, error: readError } = await admin
    .from("sparkle_transaction_pins")
    .select("pin_hash, failed_attempts, locked_until")
    .eq("user_id", user.id)
    .maybeSingle();

  if (readError) return reply({ error: "Storage error" }, 500);

  if (action === "set") {
    if (record) {
      return reply({ error: "PIN already exists. PIN reset needs a separate secure flow." }, 409);
    }

    const { error } = await admin.from("sparkle_transaction_pins").insert({
      user_id: user.id,
      pin_hash: await hashPin(pin),
    });

    if (error) return reply({ error: "Could not set PIN" }, 500);
    return reply({ success: true, message: "Transaction PIN created" });
  }

  if (!record) return reply({ error: "Set your transaction PIN first" }, 404);

  if (record.locked_until && new Date(record.locked_until).getTime() > Date.now()) {
    return reply({ error: "Too many attempts. Try again later." }, 429);
  }

  const valid = await checkPin(pin, record.pin_hash);

  if (!valid) {
    const attempts = (record.failed_attempts ?? 0) + 1;
    await admin.from("sparkle_transaction_pins").update({
      failed_attempts: attempts >= 5 ? 0 : attempts,
      locked_until: attempts >= 5
        ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
        : null,
    }).eq("user_id", user.id);

    return reply({ error: "Incorrect PIN" }, 401);
  }

  await admin.from("sparkle_transaction_pins").update({
    failed_attempts: 0,
    locked_until: null,
    updated_at: new Date().toISOString(),
  }).eq("user_id", user.id);

  return reply({ success: true, verified: true });
});
