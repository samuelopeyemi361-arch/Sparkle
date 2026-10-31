CREATE OR REPLACE FUNCTION public.sparkle_finish_sms_otp(
  p_request_id text,
  p_status text,
  p_provider_response jsonb DEFAULT NULL::jsonb,
  p_error text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.sparkle_sms_otp_orders%rowtype;
  v_tx_status text;
  v_refund_status text;
BEGIN
  IF p_request_id IS NULL OR p_status NOT IN ('success','failed','cancelled','unknown') THEN
    RAISE EXCEPTION 'Invalid order reference or status';
  END IF;

  SELECT * INTO v_order
  FROM public.sparkle_sms_otp_orders
  WHERE request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMS OTP order not found';
  END IF;

  IF v_order.status IN ('success','failed','cancelled') THEN
    RETURN jsonb_build_object('success', true, 'status', v_order.status, 'message', 'Order already finalized');
  END IF;

  SELECT status INTO v_tx_status
  FROM public.wallet_transactions
  WHERE id = v_order.wallet_transaction_id
  FOR UPDATE;

  IF p_status IN ('failed','cancelled') THEN
    IF v_tx_status = 'refunded' THEN
      NULL;
    ELSIF v_tx_status IN ('pending','successful') THEN
      SELECT status INTO v_refund_status
      FROM public.wallet_transactions
      WHERE reference = p_request_id || '_refund'
      FOR UPDATE;

      IF FOUND THEN
        IF v_refund_status <> 'successful' THEN
          RETURN jsonb_build_object('success', false, 'status', v_order.status, 'message', 'A refund record exists but is not confirmed successful; manual review is required.');
        END IF;
      ELSE
        UPDATE public.wallets
        SET balance = balance + v_order.amount, updated_at = now()
        WHERE user_id = v_order.user_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Wallet not found while refunding SMS OTP order';
        END IF;

        INSERT INTO public.wallet_transactions(user_id, type, amount, service, reference, status, metadata)
        VALUES(
          v_order.user_id, 'credit', v_order.amount, 'sms_otp_refund',
          p_request_id || '_refund', 'successful',
          jsonb_build_object(
            'reason', coalesce(p_error, 'Provider confirmed failure'),
            'original_request_id', p_request_id,
            'provider_status', coalesce(p_provider_response->>'status', 'unknown')
          )
        );
      END IF;

      UPDATE public.wallet_transactions
      SET status = 'refunded'
      WHERE id = v_order.wallet_transaction_id AND status IN ('pending','successful');
    ELSE
      RETURN jsonb_build_object('success', false, 'status', v_order.status, 'message', 'The original wallet debit is not in a refundable state.');
    END IF;

  ELSIF p_status = 'success' THEN
    IF v_tx_status = 'pending' THEN
      UPDATE public.wallet_transactions
      SET status = 'successful'
      WHERE id = v_order.wallet_transaction_id AND status = 'pending';
    ELSIF v_tx_status <> 'successful' OR v_tx_status IS NULL THEN
      RETURN jsonb_build_object('success', false, 'status', v_order.status, 'message', 'The original wallet debit is not in a state that can be finalized as successful.');
    END IF;
  END IF;

  UPDATE public.sparkle_sms_otp_orders
  SET status = p_status,
      provider_response = coalesce(p_provider_response, provider_response),
      error_message = p_error,
      updated_at = now()
  WHERE request_id = p_request_id;

  RETURN jsonb_build_object('success', true, 'status', p_status);
END;
$function$;
