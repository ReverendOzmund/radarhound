# Build the Radarhound Android app (APK) with nothing but Docker:
#   docker build -t radarhound-apk mobile
#   docker run --rm -v "${PWD}/mobile/out:/out" radarhound-apk
# The signed APK lands in mobile/out/radarhound.apk.
FROM eclipse-temurin:21-jdk
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android ANDROID_SDK_ROOT=/opt/android
RUN mkdir -p /opt/android/cmdline-tools && cd /opt/android \
 && curl -fsSL -o clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
 && unzip -q clt.zip -d tmp && mv tmp/cmdline-tools cmdline-tools/latest && rm -rf clt.zip tmp \
 && yes | cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && cmdline-tools/latest/bin/sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools" > /dev/null
WORKDIR /src
COPY package.json capacitor.config.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npx cap sync android && cd android && echo "sdk.dir=/opt/android" > local.properties \
 && ./gradlew assembleRelease --no-daemon --console=plain
CMD ["sh", "-c", "mkdir -p /out && cp android/app/build/outputs/apk/release/app-release.apk /out/radarhound.apk && echo 'APK copied to /out/radarhound.apk'"]
