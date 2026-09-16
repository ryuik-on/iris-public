#!/bin/bash
#
# Packages the helper as a signed .app bundle.
#
# The reason this exists is a failure that already happened: a bare CLI has no
# bundle identifier, so TCC attributes the microphone to whichever process
# launched it. Started from a terminal that had been granted access it worked;
# started from a server in another shell it came back notDetermined with no
# prompt — permission that depends on who launched you is not permission.
#
# Inside a bundle the executable gets an identity of its own. macOS finds the
# enclosing Info.plist, TCC records the decision against the bundle id, and it
# survives being launched by launchd, by npm, or by anything else.
#
# NSMicrophoneUsageDescription is not decoration: without it the system kills
# the process at the moment it asks for audio.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/IrisSpeech.app"
BUNDLE_ID="${IRIS_SPEECH_BUNDLE_ID:-local.iris.speech}"

echo "▸ building release binary"
swift build -c release --package-path "$HERE"

echo "▸ assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cp "$HERE/.build/release/IrisSpeech" "$APP/Contents/MacOS/IrisSpeech"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>IrisSpeech</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>IRIS Speech</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <!-- An accessory rather than a background-only app: it must still be able
       to put the system's permission prompt in front of a person. -->
  <key>LSUIElement</key><true/>
  <!-- Required. Without it macOS terminates the process the moment it asks
       for the microphone, rather than showing a prompt. -->
  <key>NSMicrophoneUsageDescription</key>
  <string>IRIS があなたの発話を端末内で文字に変換するためにマイクを使用します。音声は外部に送信されません。</string>
  <!-- Reading events needs full access on macOS 14+, but nothing here writes.
       A usage string that overstates what it is for teaches people to stop
       reading them. -->
  <!-- Only the full-access key. The legacy NSCalendarsUsageDescription is
       what macOS 14+ reads as a request for write-only, and shipping both
       appears to have landed us in exactly that: writeOnly, with reading
       refused and no prompt to widen it. -->
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>IRIS が今日の予定を読み取って状況を把握するために使用します。予定の作成・変更・削除は行いません。</string>
</dict>
</plist>
PLIST

echo "▸ signing (ad-hoc)"
# Ad-hoc is what is available without a Developer ID. It is enough to give TCC
# a stable bundle identity, with one consequence worth knowing: the signature
# covers the binary's hash, so rebuilding produces a new identity and macOS may
# ask for the microphone again. That is a re-prompt, not a silent denial.

# 署名 identity。
#
# ad-hoc (`-`) だと署名は cdhash だけで同一性を持つため、リビルドのたびに
# 別物になり、TCC に記録された許可と一致しなくなる。実際にマイク許可が
# 静かに無効化され、launchd から notDetermined として現れた。
#
# キーチェーンに自己署名のコード署名証明書があればそれを使う。identity は
# リビルドをまたいで変わらないので、許可も無効化されない。無ければ ad-hoc に
# 落とす — 開発者が証明書を作っていないことは、機能が無いことを意味しない。
IRIS_SIGN_IDENTITY="${IRIS_SIGN_IDENTITY:-IRIS Local}"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$IRIS_SIGN_IDENTITY\""; then
  SIGN_WITH="$IRIS_SIGN_IDENTITY"
else
  SIGN_WITH="-"
fi
codesign --force --sign "$SIGN_WITH" --identifier "$BUNDLE_ID" --timestamp=none "$APP" >/dev/null 2>&1
echo "   署名: $SIGN_WITH"

codesign --display --verbose=2 "$APP" 2>&1 | sed -n 's/^/   /p' | head -6
echo "▸ done: $APP"
