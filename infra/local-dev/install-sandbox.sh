#!/usr/bin/env bash
# Installs the nearcore sandbox binary used by local dev and the e2e suite.
# macOS builds link liblzma from Homebrew; if it is missing we build xz into a private prefix.
set -euo pipefail
VERSION="${NEAR_SANDBOX_VERSION:-2.14.0}"
DEST="${BASIS_TOOLS:-$HOME/.local/share/basis-amm}"
mkdir -p "$DEST"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="Darwin-arm64" ;;
  Linux-x86_64) PLATFORM="Linux-x86_64" ;;
  Linux-aarch64) PLATFORM="Linux-aarch64" ;;
  *) echo "unsupported platform" >&2; exit 1 ;;
esac
if [ ! -x "$DEST/near-sandbox" ]; then
  TMP=$(mktemp -d)
  curl -sSL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$PLATFORM/$VERSION/near-sandbox.tar.gz" -o "$TMP/s.tgz"
  tar xzf "$TMP/s.tgz" -C "$TMP"
  find "$TMP" -name near-sandbox -type f -exec cp {} "$DEST/near-sandbox" \;
  chmod +x "$DEST/near-sandbox"
fi
if [ "$(uname -s)" = "Darwin" ] && [ ! -f /opt/homebrew/opt/xz/lib/liblzma.5.dylib ] && [ ! -f "$DEST/xz/lib/liblzma.5.dylib" ]; then
  TMP=$(mktemp -d)
  curl -sSL https://github.com/tukaani-project/xz/releases/download/v5.6.4/xz-5.6.4.tar.gz -o "$TMP/xz.tgz"
  tar xzf "$TMP/xz.tgz" -C "$TMP"
  (cd "$TMP/xz-5.6.4" && ./configure --prefix="$DEST/xz" --disable-static --disable-doc --disable-xz --disable-xzdec \
     --disable-lzmadec --disable-lzmainfo --disable-scripts >/dev/null && make -j4 >/dev/null && make install >/dev/null)
fi
echo "sandbox: $DEST/near-sandbox"
