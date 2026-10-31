CREATE OR REPLACE FUNCTION public.sparkle_social_refund_order(
  p_user_id uuid,
  p_reference text,
  p_provider_order jsonb,
  p_reason text DEFAULT 'Supplier confirmed that the order was not delivered'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tx public.wallet_transactions%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_existing public.wallet_transactions%ROWTYPE;
  v_role text := current_setting('request.jwt.claim.role', true);
  v_order_status text := lower(regexp_replace(coalesce(p_provider_order->>'status', ''), '[[:space:]-]+', '_', 'g'));
  v_quantity bigint;
  v_remains bigint;
  v_refund_reference text;
  v_amount numeric(14,2);
BEGIN
  IF coalesce(v_role, '') <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorised to process a Social Media Market refund.');
  END IF;

  IF p_user_id IS NULL OR p_reference IS NULL
     OR length(trim(p_reference)) < 12 OR length(trim(p_reference)) > 100
     OR p_reference NOT LIKE 'SPKDIG-%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid Social Media Market reference.');
  END IF;

  IF jsonb_typeof(p_provider_order) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('success', false, 'error', 'A verified supplier order status is required.');
  END IF;

  IF v_order_status NOT IN ('failed', 'failure', 'error', 'cancelled', 'canceled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'The supplier has not confirmed a refundable no-delivery status.');
  END IF;

  SELECT * INTO v_tx
  FROM public.wallet_transactions
  WHERE reference = p_reference
    AND user_id = p_user_id
    AND service = 'Social Media Market'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Social Media Market purchase was not found.');
  END IF;

  IF coalesce(v_tx.metadata->>'digitalKind', '') <> 'social' THEN
    RETURN jsonb_build_object('success', false, 'error', 'This reference is not a Social Media Market order.');
  END IF;

  IF v_tx.status = 'refunded' THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'status', 'refunded', 'amount', v_tx.amount);
  END IF;

  IF v_tx.status NOT IN ('pending', 'successful') THEN
    RETURN jsonb_build_object('success', false, 'error', 'This order is not eligible for a Social Media Market refund.');
  END IF;

  v_quantity := NULLIF(v_tx.metadata->>'quantity', '')::bigint;
  v_remains := NULLIF(p_provider_order->>'remains', '')::bigint;

  -- A canceled order can have partial delivery. Only issue a full refund when
  -- the provider explicitly reports that the entire ordered quantity remains.
  IF v_order_status IN ('cancelled', 'canceled') THEN
    IF v_quantity IS NULL OR v_remains IS NULL OR v_remains < v_quantity THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'partial_or_unconfirmed',
        'error', 'The supplier cancellation does not confirm zero delivery. No automatic refund was issued.'
      );
    END IF;
  END IF;

  v_refund_reference := left(p_reference, 90) || '_refund';
  SELECT * INTO v_existing
  FROM public.wallet_transactions
  WHERE reference = v_refund_reference
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.user_id = p_user_id
       AND v_existing.type = 'credit'
       AND v_existing.status = 'successful' THEN
      RETURN jsonb_build_object('success', true, 'duplicate', true, 'status', 'refunded', 'amount', v_existing.amount);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'A refund reference already exists and needs manual reconciliation.');
  END IF;

  v_amount := round(coalesce(v_tx.amount, 0), 2);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'The original order has no refundable amount.');
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sparkle wallet was not found.');
  END IF;

  UPDATE public.wallets
  SET balance = balance + v_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.wallet_transactions
    (user_id, type, amount, service, reference, status, metadata)
  VALUES
    (p_user_id, 'credit', v_amount, 'Social Media Market Refund', v_refund_reference, 'successful',
     jsonb_build_object(
       'digitalKind', 'social_refund',
       'originalReference', p_reference,
       'reason', coalesce(nullif(trim(p_reason), ''), 'Supplier confirmed no delivery'),
       'providerOrderStatus', p_provider_order->>'status',
       'providerOrder', p_provider_order
     ));

  UPDATE public.wallet_transactions
  SET status = 'refunded',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'stage', 'refunded',
        'socialRefundReference', v_refund_reference,
        'socialRefundAmount', v_amount,
        'socialRefundAt', now(),
        'providerOrder', p_provider_order,
        'refundReason', coalesce(nullif(trim(p_reason), ''), 'Supplier confirmed no delivery')
      )
  WHERE id = v_tx.id;

  RETURN jsonb_build_object('success', true, 'status', 'refunded', 'amount', v_amount, 'reference', v_refund_reference);
END;
$function$;

REVOKE ALL ON FUNCTION public.sparkle_social_refund_order(uuid, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sparkle_social_refund_order(uuid, text, jsonb, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sparkle_social_refund_order(uuid, text, jsonb, text) TO service_role;
