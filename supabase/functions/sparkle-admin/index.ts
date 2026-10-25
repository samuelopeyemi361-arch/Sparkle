import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}
function str(v: unknown) { return String(v ?? "").trim(); }
function int(v: unknown, fallback: number, min: number, max: number) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ success: false, error: "POST required" }, 405);

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return reply({ success: false, error: "Sign in to Sparkle first." }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return reply({ success: false, error: "Admin service is not configured." }, 503);

  const authClient = createClient(url, anon, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  const actor = authData?.user;
  if (authError || !actor) return reply({ success: false, error: "Your session has expired. Sign in again." }, 401);

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: actorProfile, error: roleError } = await admin
    .from("profiles").select("id, email, username, role").eq("id", actor.id).maybeSingle();
  if (roleError || actorProfile?.role !== "admin") {
    return reply({ success: false, error: "Administrator access required." }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ success: false, error: "Invalid request body." }, 400); }
  const action = str(body.action);

  try {
    if (action === "dashboard") {
      const [users, walletRows, txRows, recentRows] = await Promise.all([
        admin.from("profiles").select("id", { count: "exact", head: true }),
        admin.from("wallets").select("balance"),
        admin.from("wallet_transactions").select("id", { count: "exact", head: true }),
        admin.from("wallet_transactions").select("id,user_id,type,amount,service,reference,status,created_at").order("created_at", { ascending: false }).limit(8),
      ]);
      if (users.error || walletRows.error || txRows.error || recentRows.error) throw new Error("Could not load all dashboard summaries.");
      const walletBalances = (walletRows.data || []).map((x: any) => Number(x.balance || 0));
      const totalWalletBalance = Math.round(walletBalances.reduce((sum: number, x: number) => sum + (Number.isFinite(x) ? x : 0), 0) * 100) / 100;
      return reply({ success: true, admin: { email: actor.email, username: actorProfile.username }, stats: {
        customers: users.count || 0, wallets: walletBalances.length, totalWalletBalance,
        transactionCount: txRows.count || 0
      }, recentTransactions: recentRows.data || [] });
    }

    if (action === "users") {
      const page = int(body.page, 1, 1, 100000);
      const limit = int(body.limit, 50, 1, 100);
      const search = str(body.search).slice(0, 100);
      let query = admin.from("profiles")
        .select("id,email,username,full_name,first_name,last_name,phone,role,created_at")
        .order("created_at", { ascending: false })
        .range((page - 1) * limit, (page * limit) - 1);
      if (search) query = query.ilike("email", "%" + search.replace(/[%_,]/g, "") + "%");
      const { data, error, count } = await query;
      if (error) throw new Error("Could not load customer list.");
      const ids = (data || []).map((p: any) => p.id);
      const wallets = ids.length
        ? await admin.from("wallets").select("user_id,balance,updated_at").in("user_id", ids)
        : { data: [], error: null };
      if (wallets.error) throw new Error("Could not load customer wallet balances.");
      const byId = new Map((wallets.data || []).map((w: any) => [w.user_id, w]));
      // Read email confirmation from Supabase Auth, not from editable profile data.
      const usersWithVerification = await Promise.all((data || []).map(async (p: any) => {
        let emailVerified: boolean | null = null;
        try {
          const { data: authRecord, error: authLookupError } = await admin.auth.admin.getUserById(p.id);
          if (!authLookupError && authRecord?.user) {
            emailVerified = Boolean(authRecord.user.email_confirmed_at || authRecord.user.confirmed_at);
          }
        } catch (_) {
          // Unknown is kept distinct from a confirmed-unverified account.
        }
        return { ...p, email_verified: emailVerified, wallet: byId.get(p.id) || null };
      }));
      return reply({ success: true, users: usersWithVerification, page, limit, total: count ?? null });
    }

    if (action === "transactions") {
      const page = int(body.page, 1, 1, 100000);
      const limit = int(body.limit, 50, 1, 100);
      const userId = str(body.user_id);
      let query = admin.from("wallet_transactions")
        .select("id,user_id,type,amount,service,reference,status,metadata,created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((page - 1) * limit, (page * limit) - 1);
      if (userId) query = query.eq("user_id", userId);
      const { data, error, count } = await query;
      if (error) throw new Error("Could not load transaction history.");
      const ids = [...new Set((data || []).map((x: any) => x.user_id))];
      const profiles = ids.length
        ? await admin.from("profiles").select("id,email,username,full_name").in("id", ids)
        : { data: [], error: null };
      if (profiles.error) throw new Error("Could not load transaction account details.");
      const byId = new Map((profiles.data || []).map((p: any) => [p.id, p]));
      return reply({ success: true, transactions: (data || []).map((x: any) => ({ ...x, customer: byId.get(x.user_id) || null })), page, limit, total: count ?? null });
    }

    if (action === "user_detail") {
      const targetId = str(body.user_id);
      if (!/^[0-9a-f-]{36}$/i.test(targetId)) return reply({ success: false, error: "Choose a valid customer." }, 400);
      const [profile, wallet, transactions] = await Promise.all([
        admin.from("profiles").select("id,email,username,full_name,first_name,last_name,phone,role,created_at").eq("id", targetId).maybeSingle(),
        admin.from("wallets").select("user_id,balance,updated_at").eq("user_id", targetId).maybeSingle(),
        admin.from("wallet_transactions").select("id,type,amount,service,reference,status,metadata,created_at").eq("user_id", targetId).order("created_at", { ascending: false }).limit(50),
      ]);
      if (profile.error || wallet.error || transactions.error) throw new Error("Could not load this customer.");
      if (!profile.data) return reply({ success: false, error: "Customer not found." }, 404);
      let emailVerified: boolean | null = null;
      try {
        const { data: authRecord, error: authLookupError } = await admin.auth.admin.getUserById(targetId);
        if (!authLookupError && authRecord?.user) {
          emailVerified = Boolean(authRecord.user.email_confirmed_at || authRecord.user.confirmed_at);
        }
      } catch (_) {
        // Keep auth lookup failures visibly unknown rather than falsely unverified.
      }
      return reply({ success: true, profile: { ...profile.data, email_verified: emailVerified }, wallet: wallet.data, transactions: transactions.data || [] });
    }

    if (action === "set_role") {
      const targetId = str(body.user_id);
      const role = str(body.role);
      if (!/^[0-9a-f-]{36}$/i.test(targetId) || !["admin", "customer"].includes(role)) {
        return reply({ success: false, error: "Invalid account or role." }, 400);
      }
      if (targetId === actor.id && role !== "admin") return reply({ success: false, error: "You cannot remove your own administrator access here." }, 409);
      const { data: target, error: targetError } = await admin.from("profiles").select("id,email,role").eq("id", targetId).maybeSingle();
      if (targetError || !target) return reply({ success: false, error: "Customer not found." }, 404);
      const { error } = await admin.from("profiles").update({ role }).eq("id", targetId);
      if (error) throw new Error("Could not update customer role.");
      await admin.from("sparkle_admin_audit_logs").insert({
        actor_user_id: actor.id, action: "set_role", target_user_id: targetId,
        details: { previous_role: target.role, new_role: role, target_email: target.email }
      });
      return reply({ success: true, user_id: targetId, role });
    }

    if (action === "wallet_adjust") {
      const targetId = str(body.user_id);
      const amount = Number(body.amount);
      const reason = str(body.reason);
      if (!/^[0-9a-f-]{36}$/i.test(targetId) || !Number.isFinite(amount) || Math.round(amount * 100) !== amount * 100 || amount === 0 || Math.abs(amount) > 10000000 || reason.length < 4 || reason.length > 240) {
        return reply({ success: false, error: "Enter a valid customer, amount, and reason. Maximum adjustment is ₦10,000,000." }, 400);
      }
      const { data, error } = await admin.rpc("sparkle_admin_adjust_wallet", {
        p_admin_id: actor.id, p_target_user_id: targetId, p_amount: amount, p_reason: reason
      });
      if (error) return reply({ success: false, error: error.message || "Wallet adjustment was not completed." }, 409);
      await admin.from("sparkle_admin_audit_logs").insert({
        actor_user_id: actor.id, action: "wallet_adjust", target_user_id: targetId,
        details: { amount, reason, result: data }
      });
      return reply({ success: true, adjustment: data });
    }

    if (action === "audit_logs") {
      const limit = int(body.limit, 50, 1, 100);
      const { data, error } = await admin.from("sparkle_admin_audit_logs")
        .select("id,actor_user_id,action,target_user_id,details,created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error("Could not load admin audit log.");
      return reply({ success: true, logs: data || [] });
    }

    return reply({ success: false, error: "Unsupported admin action." }, 400);
  } catch (error) {
    return reply({ success: false, error: error instanceof Error ? error.message : "Admin request failed." }, 500);
  }
});