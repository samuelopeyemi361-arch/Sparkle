-- Restrict direct client writes to customer-editable profile fields.
-- Admin authorization, referral attribution, referral activation and timestamps
-- remain server-managed. Keep the own-profile RLS policies in place.

REVOKE INSERT, UPDATE ON TABLE public.profiles FROM authenticated;

GRANT INSERT (
  id,
  email,
  first_name,
  last_name,
  full_name,
  phone,
  username,
  referral_code
) ON TABLE public.profiles TO authenticated;

GRANT UPDATE (
  id,
  email,
  first_name,
  last_name,
  full_name,
  phone,
  username,
  referral_code
) ON TABLE public.profiles TO authenticated;
