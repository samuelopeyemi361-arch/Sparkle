
CREATE OR REPLACE FUNCTION public.sparkle_claim_pending_data_orders(
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 90
)
RETURNS SETOF public.wallet_transactions
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH clock AS (
    SELECT clock_timestamp() AS now_at
  ),
  candidates AS (
    SELECT t.id, c.now_at
    FROM public.wallet_transactions AS t
    CROSS JOIN clock AS c
    WHERE t.type = 'debit'
      AND t.status = 'pending'
      AND lower(coalesce(t.service, '')) = 'data'
      AND lower(coalesce(t.metadata->>'provider', 'gsubz')) = 'gsubz'
      AND t.created_at <= c.now_at - interval '30 seconds'
      AND (
        nullif(t.metadata->>'dataNextCheckAt', '') IS NULL
        OR t.metadata->>'dataNextCheckAt' <=
          to_char(c.now_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      AND (
        nullif(t.metadata->>'dataTrackingLeaseUntil', '') IS NULL
        OR t.metadata->>'dataTrackingLeaseUntil' <=
          to_char(c.now_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    ORDER BY t.created_at ASC
    FOR UPDATE OF t SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 5), 20))
  ),
  claimed AS (
    UPDATE public.wallet_transactions AS t
    SET metadata = coalesce(t.metadata, '{}'::jsonb) || jsonb_build_object(
      'dataTrackingLeaseUntil',
      to_char(
        (c.now_at + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))))
          AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'dataNextCheckAt',
      to_char(
        (c.now_at + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))))
          AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    )
    FROM candidates AS c
    WHERE t.id = c.id
    RETURNING t.*
  )
  SELECT * FROM claimed;
$function$;

REVOKE ALL ON FUNCTION public.sparkle_claim_pending_data_orders(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sparkle_claim_pending_data_orders(integer, integer)
  TO service_role;
