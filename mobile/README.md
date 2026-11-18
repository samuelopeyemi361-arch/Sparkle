# TheSparkle Mobile (Capacitor)

This directory is an isolated native-app wrapper for the existing TheSparkle web application. It is intentionally kept separate from the production website and Supabase functions.

## Safety boundary

- The live website remains the source of truth for the existing product and service flows.
- This mobile project does not change wallet balances, Paystack, Supabase schemas, authentication rules, suppliers, purchases, PIN checks, or refunds.
- Do not add production secrets, signing keys, service-role keys, or Apple certificates to this repository.
- The native project must be tested against a staging/test account before any store submission.

## Current architecture

The app packages the existing root `index.html` and `favicon.svg` into a Capacitor WebView. `scripts/sync-web.mjs` copies those files into the generated `www/` directory immediately before Capacitor sync/build. The website's existing remote Supabase and supplier integrations remain the backend.

This first foundation deliberately avoids changing the main web app to add native-only behavior. OAuth/deep-link behavior, file downloads, external payment redirects, push notifications, and app-store compliance need a separate device test pass before release.

## Requirements

- Node.js 22+
- Android builds: Android Studio and Android SDK
- iOS builds: macOS, Xcode 26+, and Xcode Command Line Tools
- Store distribution: Google Play Console for Play Store release; Apple Developer Program and App Store Connect for iOS distribution

## Setup

From this directory:

```sh
npm install
npm run sync:web
npx cap add android
npx cap add ios
npx cap sync
```

The `cap add` commands are one-time operations. Commit the generated `android/` and `ios/` projects after reviewing them; do not commit credentials or signing assets.

## Android

Debug APK:

```sh
npm run android:debug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

Google Play bundle (requires signing configuration before store upload):

```sh
npm run android:release
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

For direct website downloads, produce a signed release APK after configuring a private signing key outside Git. Never publish a debug APK as the production app.

## iOS

On a Mac with Xcode:

```sh
npm run ios:open
```

Select the correct Apple Developer Team and bundle signing settings in Xcode. Archive and validate in Xcode before uploading to App Store Connect/TestFlight.

## App identity

- Display name: TheSparkle
- Bundle identifier: com.thesparkle.mobile
- Web source: repository-root `index.html`
- Web assets output: `mobile/www/` (generated; not committed)

Before production release, confirm the bundle identifier is available and reserved for this app in the relevant developer accounts.
