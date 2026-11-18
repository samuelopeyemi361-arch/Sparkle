# TheSparkle Android build status

## Completed
- [x] Isolated Capacitor Android project created on `mobile/capacitor-foundation`; production branch is untouched.
- [x] Existing root `index.html` and `favicon.svg` copied into the Android bundle during CI.
- [x] Android native project generation and Capacitor sync completed in CI.
- [x] TheSparkle launcher/adaptive icon generated from the current repository favicon.
- [x] Branded Android debug APK built successfully.
- [x] Branded Android debug AAB validation build completed successfully.
- [x] Android-only automated validation workflow is active.
- [x] Manual-only signed APK/AAB release workflow added; it is gated on the four Android signing secrets.
- [x] iOS build/signing work is marked postponed.

## Your testing step
- [ ] Install the debug APK on an Android phone and test login/Google sign-in, dashboard refresh/session persistence, wallet display, service catalogue, review/PIN screens, transaction history, receipts/PDF downloads, external links, keyboard behavior, and Android back navigation.
- [ ] Report any blank screen, forced logout, missing download, app crash, or other unexpected behavior. Do not test using real funds or submit live supplier purchases.

## Still required before public release
- [ ] Confirm the current favicon-based launcher icon and provide final splash artwork if you want a different design.
- [ ] Create and safely back up the Android upload keystore.
- [ ] Add the four Android signing secrets to GitHub Actions and run the manual signed-release workflow.
- [ ] Verify signed release APK and AAB outputs.
- [ ] Prepare Play Console listing, privacy policy/data-safety declarations, screenshots, support contact, and internal testing.
- [ ] Check any new personal Play Console account testing requirements that apply to your account.

## iOS — postponed
iOS native build, signing, device tests, and App Store preparation are parked. They do not block Android.

## Safety boundary
No production website files, Supabase functions/schemas, Paystack flows, wallet logic, supplier integrations, purchase rules, PIN checks, refund logic, or live deployment were changed. The PR remains draft and unmerged.
