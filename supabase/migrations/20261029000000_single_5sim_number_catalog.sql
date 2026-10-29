-- Sparkle uses one live virtual-number catalogue backed by 5SIM.
-- Server 2 and Server 3 are retired; reject stale client calls before reserving wallet funds.
CREATE OR REPLACE FUNCTION public.sparkle_reserve_sms_otp_server(
  p_user_id uuid,
  p_request_id text,
  p_service_name text,
  p_country text,
  p_provider_cost numeric,
  p_server_id text,
  p_markup_percent numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric(12,2);
  v_cost numeric(12,2);
  v_amount numeric(12,2);
  v_tx uuid;
  v_existing public.sparkle_sms_otp_orders%rowtype;
BEGIN
  IF p_user_id IS NULL OR p_request_id IS NULL OR length(trim(p_request_id)) = 0
     OR length(p_request_id) > 120 OR p_service_name IS NULL OR length(trim(p_service_name)) = 0
     OR p_country IS NULL OR p_provider_cost IS NULL OR p_provider_cost <= 0 THEN
    RAISE EXCEPTION 'Invalid number purchase details';
  END IF;
  IF lower(trim(p_server_id)) <> 'server1' OR p_markup_percent IS DISTINCT FROM 75::numeric THEN
    RAISE EXCEPTION 'Only the live number catalogue is available';
  END IF;
  IF lower(trim(p_country)) NOT IN ('us','ca') THEN RAISE EXCEPTION 'Choose USA or Canada'; END IF;
  v_cost := round(p_provider_cost,2);
  v_amount := round(v_cost * 1.75,2);
  IF v_cost <= 0 OR v_amount <= 0 OR v_amount > 1000000 THEN RAISE EXCEPTION 'Invalid number price'; END IF;
  SELECT * INTO v_existing FROM public.sparkle_sms_otp_orders WHERE request_id=trim(p_request_id) FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('success',false,'duplicate',true,
      'message','This number request already exists. Check its status before retrying.','status',v_existing.status);
  END IF;
  SELECT balance INTO v_balance FROM public.wallets WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_balance IS NULL THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  IF v_balance < v_amount THEN RAISE EXCEPTION 'Insufficient wallet balance'; END IF;
  INSERT INTO public.sparkle_sms_otp_orders(user_id,request_id,service_name,country,amount,provider_cost,status)
    VALUES(p_user_id,trim(p_request_id),trim(p_service_name),lower(trim(p_country)),v_amount,v_cost,'pending');
  UPDATE public.wallets SET balance=balance-v_amount,updated_at=now() WHERE user_id=p_user_id;
  INSERT INTO public.wallet_transactions(user_id,type,amount,service,reference,status,metadata)
    VALUES(p_user_id,'debit',v_amount,'sms_otp',trim(p_request_id),'pending',
      jsonb_build_object('service_name',trim(p_service_name),'country',lower(trim(p_country)),
        'provider_cost',v_cost,'markup_percent',75,'server_id','server1'))
    RETURNING id INTO v_tx;
  UPDATE public.sparkle_sms_otp_orders SET wallet_transaction_id=v_tx,updated_at=now()
    WHERE request_id=trim(p_request_id);
  RETURN jsonb_build_object('success',true,'status','pending','request_id',trim(p_request_id),
    'amount',v_amount,'server_id','server1');
END;
$function$;
