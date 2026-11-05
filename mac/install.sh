#!/bin/bash
# Капри для Mac: ставит или обновляет её в «Программах», подписывает одной и той же подписью
# (тогда macOS не сбрасывает разрешения после обновлений) и запускает.
#   Вручную:  curl -fsSL https://raw.githubusercontent.com/kroshkaruu/capri-desktop/capri-mac/mac/install.sh | bash
#   Из Капри: install.sh <ссылка на zip> <pid Капри>
set -u
REPO="kroshkaruu/capri-desktop"
URL="${1:-}"
WAIT_PID="${2:-}"
APP="/Applications/Capri.app"
NAME="Capri Local Signing"
LOG="$HOME/Library/Logs/Capri-update.log"
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "== $(date) Капри: установка"

if [ -z "$URL" ]; then
  # самая свежая сборка: с наибольшим номером
  URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | grep -o 'https://[^"]*/download/capri-mac-[0-9]*-[0-9]*/Capri-Mac-RU.zip' \
    | sed 's|.*/capri-mac-[0-9]*-\([0-9]*\)/.*|\1 &|' | sort -n | tail -1 | cut -d' ' -f2)
fi
if [ -z "$URL" ]; then echo "Не нашла сборку на GitHub."; exit 1; fi
echo "Скачиваю: $URL"

TMP=$(mktemp -d)
if ! curl -fL --retry 3 -o "$TMP/capri.zip" "$URL"; then echo "Не скачалось."; exit 1; fi
ditto -x -k "$TMP/capri.zip" "$TMP/x" || { echo "Архив не распаковался."; exit 1; }
[ -d "$TMP/x/Capri.app" ] || { echo "В архиве нет Capri.app."; exit 1; }

# Капри закрывается (обновление из неё самой ждёт, пока она выйдет)
if [ -n "$WAIT_PID" ]; then
  for _ in $(seq 1 60); do kill -0 "$WAIT_PID" 2>/dev/null || break; sleep 0.5; done
else
  osascript -e 'tell application id "capri.desktop" to quit' >/dev/null 2>&1
  sleep 2
  pkill -x Capri >/dev/null 2>&1
fi
sleep 1

# модель распознавания речи (~550 МБ) переезжает из старой Капри в её папку, чтобы не качать её заново
SUP="$HOME/Library/Application Support/Capri"
M="ggml-large-v3-turbo-q5_0.bin"
if [ -f "$APP/Contents/Resources/ears/$M" ] && [ ! -f "$SUP/$M" ]; then
  mkdir -p "$SUP" && cp "$APP/Contents/Resources/ears/$M" "$SUP/$M" && echo "Сохранила модель речи."
fi

rm -rf "$APP"
ditto "$TMP/x/Capri.app" "$APP"
xattr -cr "$APP"

# Своя постоянная подпись: создаётся один раз в связке ключей. macOS один раз попросит пароль,
# чтобы ей доверять. С ней разрешения (микрофон, управление, автоматизация) переживают обновления.
ensure_identity() {
  local KC="$HOME/Library/Keychains/login.keychain-db"
  security find-identity -v -p codesigning 2>/dev/null | grep -q "${NAME}" && return 0
  local d; d=$(mktemp -d)
  # ключ уже есть (прошлая установка оборвалась), но ему ещё не доверяют
  if security find-identity -p codesigning 2>/dev/null | grep -q "${NAME}"; then
    security find-certificate -c "${NAME}" -p "$KC" > "$d/cert.pem" 2>/dev/null
  else
    printf '%s\n' '[req]' 'distinguished_name = dn' 'x509_extensions = ext' 'prompt = no' '[dn]' "CN = ${NAME}" '[ext]' \
      'basicConstraints = critical,CA:false' 'keyUsage = critical,digitalSignature' 'extendedKeyUsage = critical,codeSigning' > "$d/cfg"
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/key.pem" -out "$d/cert.pem" -days 3650 -config "$d/cfg" >/dev/null 2>&1 || return 1
    /usr/bin/openssl pkcs12 -export -inkey "$d/key.pem" -in "$d/cert.pem" -out "$d/id.p12" -passout pass:capri >/dev/null 2>&1 \
      || /usr/bin/openssl pkcs12 -export -legacy -inkey "$d/key.pem" -in "$d/cert.pem" -out "$d/id.p12" -passout pass:capri >/dev/null 2>&1 || return 1
    security import "$d/id.p12" -k "$KC" -P capri -T /usr/bin/codesign >/dev/null 2>&1 || return 1
  fi
  echo "Подпись: ${NAME}. Если Mac спросит пароль, это чтобы ей доверять (один раз)."
  security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$d/cert.pem" >/dev/null 2>&1
  rm -rf "$d"
  security find-identity -v -p codesigning 2>/dev/null | grep -q "${NAME}"
}

if ensure_identity && codesign --force --deep --sign "${NAME}" "$APP" >/dev/null 2>&1; then
  echo "Подписала постоянной подписью."
else
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
  echo "Подписала временной подписью (разрешения после обновления придётся выдать заново)."
fi

rm -rf "$TMP"
open "$APP"
echo "Готово: Капри запущена."
