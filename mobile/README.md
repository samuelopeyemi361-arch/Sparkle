# TheSparkle Android app (Capacitor)

This is an isolated Android app wrapper for the existing TheSparkle web application. It is maintained on the `mobile/capacitor-foundation` branch and does not replace the live website.

## Safety boundary

- The live website remains the source of truth for existing customer and service flows.
- This mobile foundation does not change wallet balances, Paystack, Supabase schemas, authentication rules, suppliers, purchases, transaction PIN checks, or refunds.
- Do not commit production secrets, service-role keys, signing keys, or keystore files.
- Test with a dedicated test account and low-risk/read-only checks before attempting any live transaction.

## Current architecture

The Android app packages the current root `index.html` and `favicon.svg` into a Capacitor WebView. The `scripts/sync-web.mjs` script copies those files into the generated `www/` directory before each native sync/build. Existing Supabase and supplier integrations remain remote; the mobile wrapper does not introduce a second wallet or backend.

Authentication redirects, Google sign-in, file/PDF downloads, external links, keyboard resizing, Android back navigation, and app-store compliance still require real-device validation. A successful CI build proves that the Android project compiles; it does not prove every app flow works correctly on every phone.

## Requirements

- Node.js 22+
- Android Studio with a compatible Android SDK
- Java 21 for the current CI build

## Local setup

From this directory:

```sh
npm install
npm run sync:web
npx cap add android
npx cap sync android
npx cap open android
```

The `cap add android` command is a one-time setup for a fresh checkout. Do not commit signing credentials or private keys.

## Build output

Debug APK (for internal installation/testing only; not a public release):

```sh
npm run android:debug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

The CI also creates a debug AAB as a build-validation artifact. It is not the signed production AAB required for Google Play.

For public distribution, create a private release-signing key, store it securely outside Git, configure the build secrets, and produce a signed release APK and AAB. Never publish a debug APK as the production app.

## App identity

- Display name: TheSparkle
- Android application ID: `com.thesparkle.mobile`
- Web source: repository-root `index.html`
- Generated web assets: `mobile/www/` (not committed)

Confirm the application ID is the intended one in the Play Console before the first public release. Once published, changing the application ID creates a different Android app.

## iOS — postponed

iOS work is intentionally out of the current scope. No iOS build is run by the Android workflow. iOS dependencies and signing will be brought back when that phase is resumed.
