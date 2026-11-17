-- Signed-in Google onboarding and profile edits use the same availability
-- check as public email signup. This function returns availability only.
GRANT EXECUTE ON FUNCTION public.sparkle_check_signup(text, text) TO authenticated;
