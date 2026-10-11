
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
    {
      name: "PBKDF2",
      salt,
      iterations: 310000,
      hash: "SHA-256",
    },
    key,
    256,
  );

  const hex = (bytes: Uint8Array) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}

async function checkPin(pin: string, stored: string) {
  const [saltHex, expected] = stored.split(":");

  if (!saltHex || !expected) return false;

  const saltBytes = saltHex.match(/.{2}/g);
  if (!saltBytes || saltBytes.length !== 16) return false;

  const salt = new Uint8Array(
    saltBytes.map((b) => parseInt(b, 16)),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 310000,
      hash: "SHA-256",
    },
    key,
    256,
  );

  const actual = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return actual === expected;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });

  if (req.method !== "POST") {
    return reply({
      success: false,
      error: "This request must use POST.",
      message: "This request must use POST.",
    }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !anonKey || !serviceKey) {
    return reply({
      success: false,
      error: "PIN service configuration is incomplete. Please try again later.",
      message: "PIN service configuration is incomplete. Please try again later.",
    }, 500);
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return reply({
      success: false,
      error: "Please sign in again to continue.",
      message: "Please sign in again to continue.",
    }, 401);
  }

  const userClient = createClient(url, anonKey, {
    global: {
      headers: { Authorization: authHeader },
    },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();

  if (authError || !user) {
    return reply({
      success: false,
      error: "Your session has expired. Please sign in again.",
      message: "Your session has expired. Please sign in again.",
    }, 401);
  }

  let body: { action?: string; pin?: string };

  try {
    body = await req.json();
  } catch {
    return reply({
      success: false,
      error: "Invalid request. Please try again.",
      message: "Invalid request. Please try again.",
    }, 400);
  }

  const { action, pin } = body;

  if (!["set", "verify"].includes(action ?? "")) {
    return reply({
      success: false,
      error: "Invalid PIN request. Please try again.",
      message: "Invalid PIN request. Please try again.",
    }, 400);
  }

  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
    return reply({
      success: false,
      error: "Enter a valid 4–6 digit transaction PIN.",
      message: "Enter a valid 4–6 digit transaction PIN.",
    }, 400);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const {
    data: record,
    error: readError,
  } = await admin
    .from("sparkle_transaction_pins")
    .select("pin_hash, failed_attempts, locked_until")
    .eq("user_id", user.id)
    .maybeSingle();

  if (readError) {
    return reply({
      success: false,
      error: "We couldn't check your transaction PIN because of a system error. Please try again.",
      message: "We couldn't check your transaction PIN because of a system error. Please try again.",
    }, 500);
  }

  if (action === "set") {
    if (record) {
      return reply({
        success: false,
        error: "You already have a transaction PIN. Use the PIN change option to update it.",
        message: "You already have a transaction PIN. Use the PIN change option to update it.",
      }, 409);
    }

    const { error } = await admin
      .from("sparkle_transaction_pins")
      .insert({
        user_id: user.id,
        pin_hash: await hashPin(pin),
      });

    if (error) {
      return reply({
        success: false,
        error: "We couldn't create your transaction PIN. Please try again.",
        message: "We couldn't create your transaction PIN. Please try again.",
      }, 500);
    }

    return reply({
      success: true,
      message: "Your transaction PIN has been created successfully.",
    });
  }

  if (!record) {
    return reply({
      success: false,
      error: "You haven't created a transaction PIN yet. Please create one in your Profile.",
      message: "You haven't created a transaction PIN yet. Please create one in your Profile.",
    }, 404);
  }

  if (
    record.locked_until &&
    new Date(record.locked_until).getTime() > Date.now()
  ) {
    const remainingMs =
      new Date(record.locked_until).getTime() - Date.now();

    const remainingMinutes = Math.max(
      1,
      Math.ceil(remainingMs / 60000),
    );

    const lockMessage =
      `Your transaction PIN is temporarily locked after too many incorrect attempts. Please try again in about ${remainingMinutes} minute(s).`;

    return reply({
      success: false,
      error: lockMessage,
      message: lockMessage,
    }, 429);
  }

  let valid: boolean;

  try {
    valid = await checkPin(pin, record.pin_hash);
  } catch {
    return reply({
      success: false,
      error: "We couldn't verify your PIN because of a system error. No purchase has been authorized. Please try again.",
      message: "We couldn't verify your PIN because of a system error. No purchase has been authorized. Please try again.",
    }, 500);
  }

  if (!valid) {
    const attempts = Number(record.failed_attempts ?? 0) + 1;
    const locked = attempts >= 5;

    const { error: updateError } = await admin
      .from("sparkle_transaction_pins")
      .update({
        failed_attempts: locked ? 0 : attempts,
        locked_until: locked
          ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
          : null,
      })
      .eq("user_id", user.id);

    if (updateError) {
      return reply({
        success: false,
        error: "Your PIN was not accepted, but we couldn't update the security record. Please try again.",
        message: "Your PIN was not accepted, but we couldn't update the security record. Please try again.",
      }, 500);
    }

    if (locked) {
      const lockMessage =
        "Incorrect transaction PIN. You have reached the maximum number of attempts. Your PIN is locked for 15 minutes.";

      return reply({
        success: false,
        error: lockMessage,
        message: lockMessage,
      }, 401);
    }

    const attemptsLeft = 5 - attempts;
    const incorrectMessage =
      `Incorrect transaction PIN. Please try again. ${attemptsLeft} attempt(s) remaining before temporary lock.`;

    return reply({
      success: false,
      error: incorrectMessage,
      message: incorrectMessage,
    }, 401);
  }

  const { error: resetError } = await admin
    .from("sparkle_transaction_pins")
    .update({
      failed_attempts: 0,
      locked_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);

  if (resetError) {
    return reply({
      success: false,
      error: "We couldn't complete PIN verification due to a security-record error. Please try again.",
      message: "We couldn't complete PIN verification due to a security-record error. Please try again.",
    }, 500);
  }

  return reply({
    success: true,
    verified: true,
    message: "Transaction PIN verified successfully.",
  });
});
