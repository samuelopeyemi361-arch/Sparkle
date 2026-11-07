
CREATE OR REPLACE FUNCTION public.sparkle_provider_response_shows_charge(p_response jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_status text;
  v_paid_text text;
  v_initial_text text;
  v_final_text text;
  v_initial numeric;
  v_final numeric;
BEGIN
  IF p_response IS NULL OR jsonb_typeof(p_response) <> 'object' THEN
    RETURN false;
  END IF;

  v_status := lower(regexp_replace(coalesce(
    p_response->>'status',
    p_response->>'transaction_status',
    p_response->'data'->>'status',
    p_response->'data'->>'transaction_status',
    p_response->'content'->>'status',
    p_response->'data'->'content'->>'status',
    ''
  ), '[[:space:]-]+', '_', 'g'));

  IF v_status IN (
    'success', 'successful', 'complete', 'completed',
    'pending', 'processing', 'accepted', 'queued',
    'in_progress', 'inprogress', 'received'
  ) THEN
    RETURN true;
  END IF;

  v_paid_text := coalesce(
    p_response->>'amountPaid',
    p_response->>'amount_paid',
    p_response->>'paid_amount',
    p_response->'data'->>'amountPaid',
    p_response->'data'->>'amount_paid',
    p_response->'content'->>'amountPaid',
    p_response->'data'->'content'->>'amountPaid'
  );

  IF v_paid_text ~ '^[0-9]+([.][0-9]+)?$' AND v_paid_text::numeric > 0 THEN
    RETURN true;
  END IF;

  v_initial_text := coalesce(
    p_response->>'initialBalance',
    p_response->>'initial_balance',
    p_response->'data'->>'initialBalance',
    p_response->'content'->>'initialBalance',
    p_response->'data'->'content'->>'initialBalance'
  );
  v_final_text := coalesce(
    p_response->>'finalBalance',
    p_response->>'final_balance',
    p_response->'data'->>'finalBalance',
    p_response->'content'->>'finalBalance',
    p_response->'data'->'content'->>'finalBalance'
  );

  IF v_initial_text ~ '^[0-9]+([.][0-9]+)?$'
     AND v_final_text ~ '^[0-9]+([.][0-9]+)?$' THEN
    v_initial := v_initial_text::numeric;
    v_final := v_final_text::numeric;
    IF v_initial > v_final THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sparkle_guard_provider_charge_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR OLD.status = 'refunded'
     OR NEW.status <> 'refunded'
     OR NEW.type <> 'debit' THEN
    RETURN NEW;
  END IF;

  IF lower(coalesce(NEW.service, '')) NOT IN (
    'airtime', 'data', 'electricity', 'cable tv',
    'education pin', 'bulk sms', 'social media market',
    'recharge_pin', 'recharge pin'
  ) THEN
    RETURN NEW;
  END IF;

  IF public.sparkle_provider_response_shows_charge(NEW.metadata->'provider_response')
     OR public.sparkle_provider_response_shows_charge(OLD.metadata->'provider_response')
     OR public.sparkle_provider_response_shows_charge(NEW.metadata->'provider_check')
     OR public.sparkle_provider_response_shows_charge(OLD.metadata->'provider_check') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Automatic refund blocked: supplier response shows an accepted or charged order. Manual reconciliation is required.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sparkle_wallet_refund_charge_guard ON public.wallet_transactions;
CREATE TRIGGER sparkle_wallet_refund_charge_guard
BEFORE UPDATE OF status ON public.wallet_transactions
FOR EACH ROW
EXECUTE FUNCTION public.sparkle_guard_provider_charge_refund();

REVOKE ALL ON FUNCTION public.sparkle_provider_response_shows_charge(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sparkle_guard_provider_charge_refund() FROM PUBLIC, anon, authenticated, service_role;
