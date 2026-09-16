#!/bin/bash
#
# Installs the speech helper somewhere it can actually run in the background.
#
# The repository lives in ~/Downloads, which macOS guards with TCC. Started by
# launchd from there, the helper hung inside dyld while resolving its working
# directory — before main, with no error and no crash. Copying the bundle out
# of the guarded folder is the fix; it is a location problem, not a code one.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${IRIS_SPEECH_HOME:-$HOME/Library/Application Support/IRIS}"
BUNDLE_ID="${IRIS_SPEECH_BUNDLE_ID:-local.iris.speech}"

bash "$HERE/swift/iris-speech/bundle.sh"

mkdir -p "$DEST"
rm -rf "$DEST/IrisSpeech.app"
cp -R "$HERE/swift/iris-speech/IrisSpeech.app" "$DEST/"

# Re-signed after the copy: the signature covers the bundle, and a plain copy
# is enough to invalidate it on some systems.

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
codesign --force --sign "$SIGN_WITH" --identifier "$BUNDLE_ID" --timestamp=none "$DEST/IrisSpeech.app" >/dev/null 2>&1
echo "   署名: $SIGN_WITH"

echo "▸ installed: $DEST/IrisSpeech.app"
echo
echo "IRIS_SPEECH_BINARY をこの実行ファイルに向けてください:"
echo "  IRIS_SPEECH_BINARY=\"$DEST/IrisSpeech.app/Contents/MacOS/IrisSpeech\""
echo
echo "マイクの許可は一度だけ、前面から与えてください（以降はバンドル ID に紐づきます）:"
echo "  \"$DEST/IrisSpeech.app/Contents/MacOS/IrisSpeech\" listen --locale ja-JP"
