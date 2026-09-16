#!/bin/sh
set -e
# Creates the local code-signing identity, once.
#
# Without it the HUD is ad-hoc signed, which means it has no certificate and
# the only stable thing about it is the hash of its executable. Measured
# 2026-08-22: two builds of identical source share a CDHash, and changing a
# single constant produces a different one — so macOS treats every rebuild as
# a new application and asks for the location permission again. During one
# afternoon of work that is a dialog every few minutes.
#
# With a certificate the designated requirement becomes
#   identifier "com.user.iris.hud" and certificate root = H"..."
# which does not move when the code does.
#
# Deliberately not the login keychain. That would need the login password to
# authorise codesign's access to the key, and there is no reason to involve
# it: this keychain holds one self-signed certificate that signs one local
# application, so its password is written here in the open. It protects
# nothing else.
#
# The certificate is never trusted as a root. codesign does not require it —
# verified — and trusting a self-signed root system-wide would be a real
# change to this machine's security for no benefit here.
KEYCHAIN="$HOME/Library/Keychains/iris-signing.keychain-db"
NAME="IRIS Local Signing"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$NAME"; then
  echo "既にあります: $NAME"
  exit 0
fi

cat > "$WORK/cert.cnf" <<'CNF'
[ req ]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[ dn ]
CN = IRIS Local Signing
O  = IRIS
[ v3 ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$WORK/cert.cnf" -keyout "$WORK/iris.key" -out "$WORK/iris.crt" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$WORK/iris.key" -in "$WORK/iris.crt" \
  -name "$NAME" -out "$WORK/iris.p12" -passout pass:iris >/dev/null 2>&1

security create-keychain -p iris "$KEYCHAIN"
# No auto-lock: a keychain that locks itself mid-build turns a rebuild into a
# password prompt, which is the problem this exists to remove.
security set-keychain-settings -lut 100000 "$KEYCHAIN"
security unlock-keychain -p iris "$KEYCHAIN"
security import "$WORK/iris.p12" -k "$KEYCHAIN" -P iris -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k iris "$KEYCHAIN" >/dev/null
security list-keychains -d user -s $(security list-keychains -d user | tr -d ' "') "$KEYCHAIN"

echo "作りました: $NAME"
echo "次に menubar/install.sh を実行すると、この証明書で署名されます。"
echo "位置情報の許可は、そのとき一度だけ聞かれます。"
