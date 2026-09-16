#!/bin/sh
set -e
# Build, sign and install the HUD.
#
# Written down because doing it by hand went wrong twice in ways that were
# invisible afterwards. Building straight into `IRIS HUD.new` and moving the
# file left the ad-hoc signature carrying the identifier `IRIS HUD.new`, with
# Info.plist unbound — which is fine until the app asks for a location, at
# which point macOS has no stable identity to attach the permission to and no
# usage string to show, and the prompt simply never appears.
#
# So: build to a scratch name, move it in, then sign the whole bundle with the
# real bundle identifier. Signing last is what binds Info.plist.
#
# And it is signed with a certificate rather than ad-hoc, which is what stops
# macOS asking for the location permission again on every install. Ad-hoc
# signing has no certificate, so the only stable thing about the app is the
# hash of its executable — measured: two builds of identical source share a
# CDHash, and changing one constant produces a different one. TCC treats that
# as a different application and asks again. With a certificate the designated
# requirement becomes `identifier "com.user.iris.hud" and certificate root =
# H"..."`, which survives every rebuild.
#
# The keychain holds nothing but this one self-signed certificate and is not
# the login keychain, so its password is in this file on purpose: it protects
# a local code-signing identity and nothing else. Set it up with
# `menubar/signing-setup.sh`; without it, this falls back to ad-hoc and says
# so rather than failing.
cd "$(dirname "$0")"
APP="$HOME/Applications/IRIS HUD.app"

swiftc -O -o /tmp/iris-hud-build IrisMenuBar.swift Hotkeys.swift Ask.swift Travel.swift Rail.swift Shape.swift Schedule.swift Day.swift main.swift

pkill -f "IRIS HUD" 2>/dev/null || true
sleep 1
mkdir -p "$APP/Contents/MacOS"
mv -f /tmp/iris-hud-build "$APP/Contents/MacOS/IRIS HUD"
chmod +x "$APP/Contents/MacOS/IRIS HUD"
cp Info.plist "$APP/Contents/Info.plist"

# レールに出す道具のアイコン。記号で代用していたが、どれもデスクトップアプリの
# ある道具なので、そのアプリの顔をそのまま使う。署名の前に置くこと — 後から
# 足すと署名が壊れる。
mkdir -p "$APP/Contents/Resources"
cp -f icons/*.png "$APP/Contents/Resources/" 2>/dev/null || true
# アプリの顔。**これまで束の中にしか無かった** — 2026-08-21 に手で置かれたもので、
# install.sh が触らないから生き残っていただけ。束を作り直せば消える置き方だったので、
# リポジトリに入れて毎回置く。中身は `icons/Core.png` と同じ絵から起こしてある。
cp -f ApplicationIcon.icns "$APP/Contents/Resources/" 2>/dev/null || true
KEYCHAIN="$HOME/Library/Keychains/iris-signing.keychain-db"
IDENTITY="IRIS Local Signing"
if [ -f "$KEYCHAIN" ] && security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; then
  security unlock-keychain -p iris "$KEYCHAIN"
  codesign --force --deep --sign "$IDENTITY" --keychain "$KEYCHAIN" --identifier com.user.iris.hud "$APP"
else
  echo "署名証明書がありません。ad-hoc で署名します（位置情報の許可を毎回聞かれます）。"
  echo "  menubar/signing-setup.sh を一度実行すると止まります。"
  codesign --force --deep --sign - --identifier com.user.iris.hud "$APP"
fi
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Info.plist"
codesign -d --requirements - "$APP" 2>&1 | grep designated
open -a "$APP"
echo "installed"
