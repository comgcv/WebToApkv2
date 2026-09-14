# Web to APK Studio — Vercel

This project builds a real debug APK from a website URL using an Android WebView project generated at request time.

## Deploy

1. Upload this folder to GitHub.
2. Import the repository into Vercel.
3. Vercel should detect `Dockerfile.vercel`.
4. Deploy.

The container includes:
- JDK 17
- Android command-line tools
- Android platform 36
- Build Tools 35.0.0
- Gradle 8.13
- Android Gradle Plugin 8.11.1

## Important

This is a debug APK and is not signed for Play Store release. A production release needs a signing key and a release build configuration.

Vercel Container Functions have execution/resource limits. If an APK build exceeds the available request duration or compute resources, the build can fail. The UI reports the error.

Some websites block iframe embedding, so Live Preview may be blank even though the APK can still open the URL.

The build endpoint streams the APK directly to the browser and does not rely on persistent local storage.
