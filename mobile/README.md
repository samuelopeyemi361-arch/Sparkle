# TheSparkle Android app (Capacitor)

This is an isolated Android app wrapper for the existing TheSparkle web application. It is maintained on the `mobile/capacitor-foundation` branch and does not replace the live website.

## Safety boundary

- The live website remains the source of truth for existing customer and service flows.
- This mobile foundation does not change wallet balances, Paystack, Supabase schemas, authentication rules, suppliers, purchases, transaction PIN checks, or refunds.
- Do not commit production secrets, service-role keys, signing keys, or keystore files.
- Test with a dedicated test account first. Do not place real transactions while checking the app shell.

## Current architecture

The Android app packages the current root `index.html` and `favicon.svg` into a Capacitor WebView. The sync script copies those files into `mobile/www/` before native sync/build. Existing Supabase and supplier integrations remain remote; the mobile wrapper does not introduce another wallet or backend.

The Android launcher icon is generated from the existing repository `favicon.svg`. A successful CI build proves that the native project compiles, not that every website flow has been validated inside Android WebView. Authentication redirects, Google sign-in, dashboard/session persistence, file/PDF downloads, external links, keyboard resizing, and Android back navigation need real-device testing.

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
npm run brand:android
npx cap sync android
npx cap open android
```

The `cap add android` command is a one-time setup for a fresh checkout. Do not commit signing credentials or private keys.

## Test build

The debug APK is for internal installation/testing only; it is not a public release.

```sh
npm run android:debug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

The CI also creates a debug AAB as a validation artifact. A debug AAB is not the signed production AAB required by Google Play.

## Signed Android release

The repository has a **manual-only** signed-release workflow. It runs only when you select `release` under GitHub Actions → TheSparkle Android Build → Run workflow. Normal pushes and pull requests continue to build debug-only files.

Before using that option, create an Android upload keystore on your own trusted computer. Keep the original `.jks` file and passwords backed up offline. Never send them in chat, commit them to Git, or place them in a public repository file.

Example command (run in a terminal with Java/keytool installed):

```sh
keytool -genkeypair -v -keystore thesparkle-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias thesparkle-upload
```

Choose and securely record the keystore password, key password, and alias. For this example, the alias is `thesparkle-upload`.

Convert the keystore file to one-line Base64 for the GitHub secret:
- Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("thesparkle-upload.jks"))`
- macOS/Linux: `base64 < thesparkle-upload.jks | tr -d '\n'`

In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add these four secrets:

| Secret name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The one-line Base64 output |
| `ANDROID_KEYSTORE_PASSWORD` | Your keystore password |
| `ANDROID_KEY_ALIAS` | The alias you chose |
| `ANDROID_KEY_PASSWORD` | The key password |

Do not paste these values into chat, source files, issues, or pull-request comments. Keep a separate offline backup of the original keystore: losing it can prevent you from updating an app already published with that upload key.

After those secrets are safely configured, open **Actions → TheSparkle Android Build → Run workflow**, choose branch `mobile/capacitor-foundation`, select `release`, and run it. The workflow verifies and signs both a release APK (for direct Android distribution) and a release AAB (for Google Play), then uploads them as a short-lived workflow artifact.

The release workflow has not been run because it requires your private signing secrets. Do not select `release` until all four secrets have been configured correctly and the Android test pass has been completed.

## App identity

- Display name: TheSparkle
- Android application ID: `com.thesparkle.mobile`
- Web source: repository-root `index.html`
- Generated web assets: `mobile/www/` (not committed)

Confirm the application ID in the Play Console before the first public upload. Once published, changing the application ID creates a different Android app.

## iOS — postponed

iOS work is intentionally out of the current scope. No iOS build or signing is required for this Android phase. It can be resumed separately later.
