# TheSparkle Android build status

## Completed
- [x] Isolated Capacitor mobile foundation created on `mobile/capacitor-foundation`; production branch is untouched.
- [x] Current root `index.html` and `favicon.svg` are copied into the Android app during each build.
- [x] Android native project generation completed in CI.
- [x] Capacitor Android sync completed in CI.
- [x] Android debug APK build completed successfully.
- [x] Android debug AAB validation build completed successfully.
- [x] Android build artifacts uploaded to GitHub Actions.
- [x] Automated workflow is Android-only. iOS work is postponed.

## Still required before public release
- [ ] Install and test the APK on real Android phones, including login/Google sign-in, dashboard refresh/session persistence, wallet display, purchase review/PIN screens, transaction history, receipts/PDF downloads, external links, keyboard behavior, and Android back navigation.
- [ ] Confirm the official TheSparkle app icon and splash artwork.
- [ ] Configure a private Android release-signing key outside Git and add it securely as GitHub Actions secrets.
- [ ] Produce and verify a signed release APK for direct distribution and a signed release AAB for Google Play.
- [ ] Prepare the Google Play listing, privacy policy/data-safety declarations, screenshots, and support contact.
- [ ] Complete Google Play internal testing and required review steps.

## iOS — postponed
iOS dependencies, signing, simulator/device testing, and App Store work are intentionally parked. They are not part of the Android workflow and will not block Android progress.

## Safety boundary
No production website files, Supabase functions/schemas, Paystack flows, wallet logic, supplier integrations, purchase rules, PIN checks, or refund logic were changed. No production deployment or store submission has been made.
