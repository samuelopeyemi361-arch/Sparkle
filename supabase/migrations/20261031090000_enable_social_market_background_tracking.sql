-- Background Social Media Market order tracking for new orders only.
-- Existing Social Market transactions do not carry socialAutoTrack=true and are not selected.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $secrets$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'sparkle_social_tracker_project_url') THEN
    PERFORM vault.create_secret('https://dcuvhtpqwyljsudzirxg.supabase.co', 'sparkle_social_tracker_project_url', 'Project URL for the internal Social Market tracking schedule');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'sparkle_social_tracker_publishable_key') THEN
    PERFORM vault.create_secret('sb_publishable_KB_zAb08gAt8b5jOfmZU1g_vTMF0AxL', 'sparkle_social_tracker_publishable_key', 'Publishable key for the internal Social Market tracking schedule');
  END IF;
END
$secrets$;

CREATE INDEX IF NOT EXISTS wallet_transactions_social_autotrack_due_idx
ON public.wallet_transactions ((metadata->>'socialNextCheckAt'), created_at)
WHERE service = 'Social Media Market'
  AND metadata->>'digitalKind' = 'social'
  AND metadata->>'socialAutoTrack' = 'true'
  AND metadata->>'socialTrackingTerminal' = 'false';

DO $schedule$
DECLARE
  existing_job_id bigint;
BEGIN
  SELECT jobid INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'sparkle-social-market-order-tracker';

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'sparkle-social-market-order-tracker',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := (SELECT decrypted_secret
                FROM vault.decrypted_secrets
                WHERE name = 'sparkle_social_tracker_project_url')
               || '/functions/v1/sparkle-social-order-tracker',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (SELECT decrypted_secret
                     FROM vault.decrypted_secrets
                     WHERE name = 'sparkle_social_tracker_publishable_key'),
          'x-sparkle-social-tracker', (SELECT decrypted_secret
                                       FROM vault.decrypted_secrets
                                       WHERE name = 'sparkle_social_tracker_token')
        ),
        body := jsonb_build_object('action', 'social_tracking_worker'),
        timeout_milliseconds := 90000
      ) AS request_id;
    $job$
  );
END
$schedule$;
