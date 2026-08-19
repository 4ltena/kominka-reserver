#!/usr/bin/env bash
#
# 8080 を 2 つの実装で分け合う。前段に nginx を置き、Flask は 8081 へ退く。
#
#   PI_PASS='<パスワード>' ./switch-front.sh
#
#   http://<pi>:8080/       → Flask   (これまでどおり)
#   http://<pi>:8080/ex/... → Express
#
# 8080 は Flask が握っているため、nginx が受け取るまでに短い断絶がある。
# Flask を 8081 で立て直してから nginx を差し込むので、窓は 1 秒から 2 秒。
# 受け取りに失敗したら config.toml を戻して 8080 を Flask に返す。
#
# 逆戻しは ./switch-front.sh --revert。

set -euo pipefail

PI_HOST="${PI_HOST:-192.168.0.117}"
PI_USER="${PI_USER:-pi}"
EX_PORT="${EX_PORT:-8082}"
FLASK_PORT="${FLASK_PORT:-8081}"
FRONT_PORT="${FRONT_PORT:-8080}"
BASE_PATH="${BASE_PATH:-/ex}"
FLASK_DIR="${FLASK_DIR:-/home/pi/furo-gohan}"
MODE="${1:-switch}"

if [ -z "${PI_PASS:-}" ]; then
  echo "PI_PASS が要る。使い方: PI_PASS='<パスワード>' $0" >&2
  exit 1
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o LogLevel=ERROR -o ConnectTimeout=30 -o ServerAliveInterval=5)

run_remote() {
  printf '%s' "$PI_PASS" |
    sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" \
      "PI_PASS=\"\$(cat)\" EX_PORT='$EX_PORT' FLASK_PORT='$FLASK_PORT' FRONT_PORT='$FRONT_PORT' \
       BASE_PATH='$BASE_PATH' FLASK_DIR='$FLASK_DIR' MODE='$MODE' bash /tmp/switch-front-remote.sh"
}

sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" \
  "cat > /tmp/switch-front-remote.sh" <<'REMOTE'
set -euo pipefail

sudo_run() { printf '%s\n' "$PI_PASS" | sudo -S -p '' "$@"; }
alive() { curl -fsS -o /dev/null --max-time 5 "$1"; }

set_flask_port() {
  sed -i "s/^port = .*/port = $1/" "$FLASK_DIR/config.toml"
  sudo_run systemctl restart furo-gohan
  for _ in $(seq 1 40); do
    alive "http://127.0.0.1:$1/select" && return 0
    sleep 0.25
  done
  return 1
}

if [ "$MODE" = "--revert" ]; then
  echo "-- 8080 を Flask に返す --"
  sudo_run systemctl stop nginx || true
  sudo_run systemctl disable --quiet nginx || true
  set_flask_port "$FRONT_PORT"
  alive "http://127.0.0.1:$FRONT_PORT/select" && echo "   Flask が 8080 に戻った"
  exit 0
fi

echo "-- 出発点を確かめる --"
alive "http://127.0.0.1:$EX_PORT$BASE_PATH/api/v1/members" || {
  echo "Express が $EX_PORT で応えない。先に deploy-express.sh を通すこと" >&2; exit 1; }
alive "http://127.0.0.1:$FRONT_PORT/select" || {
  echo "Flask が $FRONT_PORT で応えない" >&2; exit 1; }
echo "   Express $EX_PORT ok / Flask $FRONT_PORT ok"

echo "-- nginx --"
if ! command -v nginx > /dev/null; then
  sudo_run apt-get update -qq
  sudo_run env DEBIAN_FRONTEND=noninteractive apt-get install -y nginx-light
fi

cat > /tmp/kominka.conf <<CONF
# 8080 を 2 つの実装で分け合う。$BASE_PATH の下だけ Express、他は Flask。
upstream kominka_flask   { server 127.0.0.1:$FLASK_PORT; }
upstream kominka_express { server 127.0.0.1:$EX_PORT; }

server {
    listen $FRONT_PORT;
    listen [::]:$FRONT_PORT;
    server_name _;
    client_max_body_size 1m;

    location = $BASE_PATH { return 302 $BASE_PATH/bath; }

    # proxy_pass に経路を付けないので、$BASE_PATH を含んだまま渡る。
    # Express 側も同じ位置にぶら下がっているため、書き換えは要らない。
    location $BASE_PATH/ {
        proxy_pass http://kominka_express;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://kominka_flask;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
CONF
sudo_run install -m 644 /tmp/kominka.conf /etc/nginx/conf.d/kominka.conf
rm -f /tmp/kominka.conf
# 既定の site は 80 を握るだけだが、紛れないよう外す。
sudo_run rm -f /etc/nginx/sites-enabled/default
sudo_run nginx -t
echo "   設定は妥当"

echo "-- 差し替える --"
sudo_run systemctl stop nginx 2>/dev/null || true
if ! set_flask_port "$FLASK_PORT"; then
  echo "Flask が $FLASK_PORT で立たない。戻す" >&2
  set_flask_port "$FRONT_PORT" || true
  exit 1
fi
sudo_run systemctl enable --quiet nginx
sudo_run systemctl restart nginx

echo "-- 受け取れているか --"
ok=0
for _ in $(seq 1 40); do
  if alive "http://127.0.0.1:$FRONT_PORT/select" && alive "http://127.0.0.1:$FRONT_PORT$BASE_PATH/api/v1/members"; then
    ok=1; break
  fi
  sleep 0.25
done
if [ "$ok" -ne 1 ]; then
  echo "8080 が両方を返さない。Flask に返す" >&2
  sudo_run systemctl stop nginx || true
  set_flask_port "$FRONT_PORT" || true
  exit 1
fi

echo "   Flask   $(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:$FRONT_PORT/bath)  ←  /"
echo "   Express $(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:$FRONT_PORT$BASE_PATH/bath)  ←  $BASE_PATH/"
REMOTE

run_remote

if [ "$MODE" != "--revert" ]; then
  echo
  echo "Flask  : http://$PI_HOST:$FRONT_PORT/bath"
  echo "Express: http://$PI_HOST:$FRONT_PORT$BASE_PATH/bath"
  echo "API    : http://$PI_HOST:$FRONT_PORT$BASE_PATH/api/v1/meals"
fi
