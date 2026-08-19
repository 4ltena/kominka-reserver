#!/usr/bin/env bash
#
# Raspberry Pi へ置く。
#
#   PI_PASS='<パスワード>' ./deploy.sh
#
# 転送から Node の導入、systemd への登録、起動確認までを一度に行う。
# 何度流しても結果は変わらず、データベースは上書きしない。流す前に控えを取る。

set -euo pipefail

PI_HOST="${PI_HOST:-192.168.0.117}"
PI_USER="${PI_USER:-pi}"
EX_PORT="${EX_PORT:-8080}"
BASE_PATH="${BASE_PATH:-}"
APP_DIR="${APP_DIR:-/home/pi/kominka-reserver}"
LIVE_DB="${LIVE_DB:-/home/pi/kominka-reserver/data/kominka-reserver.db}"
UNIT="kominka-reserver"
BOT_UNIT="kominka-bot"

if [ -z "${PI_PASS:-}" ]; then
  echo "PI_PASS が要る。使い方: PI_PASS='<パスワード>' $0" >&2
  exit 1
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o LogLevel=ERROR -o ConnectTimeout=30 -o ServerAliveInterval=5)

ssh_pi() { sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" "$@"; }

# パスワードは stdin で渡す。引数に置くと ps に見えるため。
ssh_pi_sudo_script() {
  printf '%s' "$PI_PASS" |
    sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" \
      "PI_PASS=\"\$(cat)\" EX_PORT='$EX_PORT' BASE_PATH='$BASE_PATH' APP_DIR='$APP_DIR' \
       LIVE_DB='$LIVE_DB' UNIT='$UNIT' BOT_UNIT='$BOT_UNIT' PI_USER='$PI_USER' \
       bash /tmp/$UNIT-remote.sh"
}

echo "== 送る =="
tar czf - package.json package-lock.json server.js roster.js src public \
    bot/notify.js bot/kominka-bot.service bot/slack-users.example.json |
  sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" \
    "mkdir -p '$APP_DIR' && tar xzf - -C '$APP_DIR'"

echo "== 手順を送る =="
sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" "cat > /tmp/$UNIT-remote.sh" <<'REMOTE'
set -euo pipefail

sudo_run() { printf '%s\n' "$PI_PASS" | sudo -S -p '' "$@"; }

echo "-- データベースの控えを取る --"
mkdir -p /home/pi/backup "$(dirname "$LIVE_DB")"
if [ ! -f "$LIVE_DB" ]; then
  echo "   初回。控えは取らない"
else
STAMP=$(date +%Y%m%d-%H%M%S)
python3 - "$LIVE_DB" "/home/pi/backup/live-$STAMP.db" <<'PY'
import sqlite3, sys
# 書き込みの最中でも整合する控えを取る。cp では WAL の途中を掴むことがある。
source = sqlite3.connect(sys.argv[1])
target = sqlite3.connect(sys.argv[2])
source.backup(target)
target.close()
source.close()
PY
echo "   /home/pi/backup/live-$STAMP.db  $(stat -c %s "/home/pi/backup/live-$STAMP.db") バイト"
fi

echo "-- Node --"
if ! command -v node > /dev/null; then
  sudo_run apt-get update -qq
  sudo_run apt-get install -y -qq nodejs npm
fi
echo "   node $(node --version) / npm $(npm --version)"

echo "-- 依存 --"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
node -e "require('better-sqlite3'); console.log('   better-sqlite3 読み込み ok')"

echo "-- unit --"
cat > /tmp/$UNIT.service <<UNITFILE
[Unit]
Description=kominka-reserver (風呂・ごはん予約)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$PI_USER
WorkingDirectory=$APP_DIR
Environment=TZ=Asia/Tokyo
Environment=PORT=$EX_PORT
Environment=HOST=0.0.0.0
Environment=BASE_PATH=$BASE_PATH
Environment=DB_PATH=$LIVE_DB
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITFILE
sudo_run install -m 644 /tmp/$UNIT.service /etc/systemd/system/$UNIT.service
rm -f /tmp/$UNIT.service
sudo_run systemctl daemon-reload
sudo_run systemctl enable --quiet $UNIT
sudo_run systemctl restart $UNIT

echo "-- bot --"
# Webhook URL と対応表は Pi 側にあるものを使う。転送していないので消えない。
sed -e "s|__USER__|$PI_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
    "$APP_DIR/bot/$BOT_UNIT.service" > /tmp/$BOT_UNIT.service
sudo_run install -m 644 /tmp/$BOT_UNIT.service /etc/systemd/system/$BOT_UNIT.service
rm -f /tmp/$BOT_UNIT.service
sudo_run systemctl daemon-reload
if [ -f "$APP_DIR/bot/webhook.env" ]; then
  sudo_run systemctl enable --quiet $BOT_UNIT
  sudo_run systemctl restart $BOT_UNIT
  echo "   $(systemctl is-active $BOT_UNIT)"
else
  # URL が無いまま起こすと notify.js が exit 1 し、Restart=always で回り続ける。
  echo "   bot/webhook.env が無い。unit だけ置いて起こさない"
fi

echo "-- 確認 --"
for attempt in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$EX_PORT$BASE_PATH/api/v1/members"; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$EX_PORT$BASE_PATH/api/v1/members" | head -c 200; echo
echo "   $(systemctl is-active $UNIT)"
REMOTE

echo "== 進める =="
ssh_pi_sudo_script

echo
echo "http://$PI_HOST:$EX_PORT$BASE_PATH/bath"
