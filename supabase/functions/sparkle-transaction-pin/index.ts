import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
type RequestBody = {
  action?: string;
  pin?: string;
  currentPin?: string;
  newPin?: string;
};
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
async function hashPin(pin: string): Promise<string> {
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
async function checkPin(pin: string, stored: string): Promise<boolean> {
  const [saltHex, expected] = stored.split(":");
  if (!saltHex || !expected || !/^[0-9a-f]{32}$/i.test(saltHex)) {
    return false;
  }
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
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  return actual === expected;
}
function validPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,6}$/.test(pin);
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return reply({
      success: false,
      error: "This request must use POST.",
      message: "This request must use POST.",
    }, 405);
  }
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) {
      return reply({
        success: false,
        error: "PIN service configuration is incomplete.",
        message: "PIN service configuration is incomplete.",
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
      global: { headers: { Authorization: authHeader } },
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
    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return reply({
        success: false,
        error: "Invalid request body.",
        message: "Invalid request body.",
      }, 400);
    }
    const action = body.action;
    if (!["set", "verify", "change"].includes(action ?? "")) {
      return reply({
        success: false,
        error: "Invalid PIN action. Please try again.",
        message: "Invalid PIN action. Please try again.",
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
        error: "We couldn't access your PIN security record. Please try again.",
        message: "We couldn't access your PIN security record. Please try again.",
      }, 500);
    }
    // STATUS CHECK: return only whether the authenticated user has a PIN.
    // This action must be available to existing users during login; never expose the stored hash.
    if (action === "status") {
      return reply({ success: true, hasPin: Boolean(record) });
    }
    // CREATE PIN
    if (action === "set") {
      if (!validPin(body.pin)) {
        return reply({
          success: false,
          error: "Enter a valid 4–6 digit transaction PIN.",
          message: "Enter a valid 4–6 digit transaction PIN.",
        }, 400);
      }
      if (record) {
        return reply({
          success: false,
          error: "You already have a transaction PIN. Use Change PIN instead.",
          message: "You already have a transaction PIN. Use Change PIN instead.",
        }, 409);
      }
      const { error: insertError } = await admin
        .from("sparkle_transaction_pins")
        .insert({
          user_id: user.id,
          pin_hash: await hashPin(body.pin),
          failed_attempts: 0,
          locked_until: null,
        });
      if (insertError) {
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
    // VERIFY PIN
    if (action === "verify") {
      if (!validPin(body.pin)) {
        return reply({
          success: false,
          error: "Enter a valid 4–6 digit transaction PIN.",
          message: "Enter a valid 4–6 digit transaction PIN.",
        }, 400);
      }
      if (!record) {
        return reply({
          success: false,
          error: "You haven't created a transaction PIN yet. Create one in your Profile.",
          message: "You haven't created a transaction PIN yet. Create one in your Profile.",
        }, 404);
      }
      if (
        record.locked_until &&
        new Date(record.locked_until).getTime() > Date.now()
      ) {
        const remainingMinutes = Math.max(
          1,
          Math.ceil(
            (new Date(record.locked_until).getTime() - Date.now()) /
              60000,
          ),
        );
        const message =
          `Your transaction PIN is locked. Try again in about ${remainingMinutes} minute(s).`;
        return reply({
          success: false,
          error: message,
          message,
        }, 429);
      }
      let valid = false;
      try {
        valid = await checkPin(body.pin, record.pin_hash);
      } catch {
        return reply({
          success: false,
          error: "A system error occurred while checking your PIN.",
          message: "A system error occurred while checking your PIN.",
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
            error: "Incorrect PIN, but we couldn't update the security record. Please try again.",
            message: "Incorrect PIN, but we couldn't update the security record. Please try again.",
          }, 500);
        }
        const message = locked
          ? "Incorrect transaction PIN. You have reached the maximum attempts. Your PIN is locked for 15 minutes."
          : `Incorrect transaction PIN. Please try again. ${5 - attempts} attempt(s) remaining.`;
        // HTTP 200 lets the frontend read the incorrect-PIN message.
        return reply({
          success: false,
          verified: false,
          error: message,
          message,
        });
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
          error: "We couldn't complete PIN verification. Please try again.",
          message: "We couldn't complete PIN verification. Please try again.",
        }, 500);
      }
      return reply({
        success: true,
        verified: true,
        message: "Transaction PIN verified successfully.",
      });
    }
    // CHANGE PIN
    if (action === "change") {
      if (!validPin(body.currentPin) || !validPin(body.newPin)) {
        return reply({
          success: false,
          error: "Enter your current PIN and a valid new 4–6 digit PIN.",
          message: "Enter your current PIN and a valid new 4–6 digit PIN.",
        }, 400);
      }
      if (!record) {
        return reply({
          success: false,
          error: "You haven't created a transaction PIN yet.",
          message: "You haven't created a transaction PIN yet.",
        }, 404);
      }
      if (
        record.locked_until &&
        new Date(record.locked_until).getTime() > Date.now()
      ) {
        return reply({
          success: false,
          error: "Your transaction PIN is temporarily locked. Please try again later.",
          message: "Your transaction PIN is temporarily locked. Please try again later.",
        }, 429);
      }
      const currentValid = await checkPin(
        body.currentPin,
        record.pin_hash,
      );
      if (!currentValid) {
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
            error: "Current PIN is incorrect, and the security record could not be updated.",
            message: "Current PIN is incorrect, and the security record could not be updated.",
          }, 500);
        }
        const message = locked
          ? "Incorrect current PIN. Your PIN is locked for 15 minutes."
          : `Incorrect current PIN. ${5 - attempts} attempt(s) remaining.`;
        return reply({
          success: false,
          error: message,
          message,
        });
      }
      if (body.currentPin === body.newPin) {
        return reply({
          success: false,
          error: "Your new PIN must be different from your current PIN.",
          message: "Your new PIN must be different from your current PIN.",
        }, 400);
      }
      const { error: changeError } = await admin
        .from("sparkle_transaction_pins")
        .update({
          pin_hash: await hashPin(body.newPin),
          failed_attempts: 0,
          locked_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
      if (changeError) {
        return reply({
          success: false,
          error: "We couldn't change your transaction PIN. Please try again.",
          message: "We couldn't change your transaction PIN. Please try again.",
        }, 500);
      }
      return reply({
        success: true,
        message: "Your transaction PIN has been changed successfully.",
      });
    }
    return reply({
      success: false,
      error: "Unsupported PIN action.",
      message: "Unsupported PIN action.",
    }, 400);
  } catch (error) {
    console.error("sparkle-transaction-pin error:", error);
    return reply({
      success: false,
      error: "An unexpected PIN service error occurred. Please try again.",
      message: "An unexpected PIN service error occurred. Please try again.",
    }, 500);
  }
});
