#!/usr/bin/env bash
# Raspberry Pi へ配置する。何度流しても結果は変わらない。
# data/ と config.toml は上書きしない。
set -euo pipefail

PI_HOST="${PI_HOST:-raspberrypi.local}"
PI_USER="${PI_USER:-pi}"
# パスワードは既定値を持たない。環境変数で渡すか、鍵認証を使う。
PI_PASS="${PI_PASS:-}"
APP_DIR="${APP_DIR:-/home/${PI_USER}/kominka-reserver}"
SERVICE=kominka-reserver

HERE="$(cd "$(dirname "$0")" && pwd)"
# 回線が不安定な環境でも切れにくいようにする。
SSH_OPTS=(
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=30
  -o ServerAliveInterval=5
  -o ServerAliveCountMax=6
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
)

if [ -z "$PI_PASS" ]; then
  cat >&2 <<'USAGE'
PI_PASS が空。次のいずれかで実行する。

  PI_PASS='<Pi のパスワード>' ./deploy.sh
  PI_HOST=192.168.0.10 PI_PASS='<パスワード>' ./deploy.sh

鍵認証を設定済みなら sshpass は不要なので、この確認ごと外してよい。
USAGE
  exit 1
fi

if ! command -v sshpass >/dev/null 2>&1; then
  echo "sshpass が要る。brew install hudochenkov/sshpass/sshpass" >&2
  exit 1
fi

run() {
  sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" "$@"
}

run_sudo() {
  run "echo '${PI_PASS}' | sudo -S -p '' sh -c '$*'"
}

# 不安定な回線で 1 回落ちても続けられるように、3 回まで試す。
retry() {
  local n=1
  until "$@"; do
    if [ "$n" -ge 3 ]; then
      echo "3 回試して失敗した: $*" >&2
      return 1
    fi
    n=$((n + 1))
    echo "  再試行 ${n}/3"
    sleep 3
  done
}

echo "==> 接続確認 ${PI_USER}@${PI_HOST}"
run true

# 旧名 furo-gohan で配置済みなら引き継ぐ。データベースと設定は残す。
# 全機で移行が済んだらこの節ごと消してよい。
OLD_DIR="/home/${PI_USER}/furo-gohan"
if run "test -d '${OLD_DIR}'"; then
  echo "==> 旧名 furo-gohan からの移行"
  run_sudo "systemctl disable --now furo-gohan 2>/dev/null || true"
  run_sudo "rm -f /etc/systemd/system/furo-gohan.service"
  run "mkdir -p '${APP_DIR}'"
  run "test -d '${OLD_DIR}/data' && cp -a '${OLD_DIR}/data' '${APP_DIR}/' || true"
  run "test -f '${OLD_DIR}/config.toml' && cp -a '${OLD_DIR}/config.toml' '${APP_DIR}/' || true"
  run "test -f '${APP_DIR}/data/furo-gohan.db' && mv '${APP_DIR}/data/furo-gohan.db' '${APP_DIR}/data/kominka-reserver.db' || true"
  for suffix in wal shm; do
    run "test -f '${APP_DIR}/data/furo-gohan.db-${suffix}' && mv '${APP_DIR}/data/furo-gohan.db-${suffix}' '${APP_DIR}/data/kominka-reserver.db-${suffix}' || true"
  done
  run "mv '${OLD_DIR}' '${OLD_DIR}.bak'"
  run_sudo "systemctl daemon-reload"
  echo "    旧ディレクトリは ${OLD_DIR}.bak に残した"
fi

echo "==> ファイルの転送"
run "mkdir -p '${APP_DIR}'"
send() {
  tar --exclude '__pycache__' -czf - -C "$HERE" \
      app run.py roster.py requirements.txt config.example.toml kominka-reserver.service \
    | sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" \
        "tar -xzf - -C '${APP_DIR}'"
}
retry send

echo "==> 依存の導入"
retry run_sudo "apt-get update -qq"
retry run_sudo "apt-get install -y -qq python3-venv python3-pip curl"
run "test -d '${APP_DIR}/.venv' || python3 -m venv '${APP_DIR}/.venv'"
run "'${APP_DIR}/.venv/bin/pip' -q install --upgrade pip"
retry run "'${APP_DIR}/.venv/bin/pip' -q install -r '${APP_DIR}/requirements.txt'"

echo "==> 設定とデータ (既存は残す)"
run "mkdir -p '${APP_DIR}/data'"
run "test -f '${APP_DIR}/config.toml' || cp '${APP_DIR}/config.example.toml' '${APP_DIR}/config.toml'"

echo "==> 時刻帯を Asia/Tokyo に"
run_sudo "timedatectl set-timezone Asia/Tokyo"

echo "==> systemd サービスの設置"
run "sed -e 's|__USER__|${PI_USER}|g' -e 's|__APP_DIR__|${APP_DIR}|g' \
      '${APP_DIR}/kominka-reserver.service' > /tmp/${SERVICE}.service"
run_sudo "cp /tmp/${SERVICE}.service /etc/systemd/system/${SERVICE}.service"
run_sudo "systemctl daemon-reload"
run_sudo "systemctl enable ${SERVICE}"
run_sudo "systemctl restart ${SERVICE}"

echo "==> 応答の確認"
for i in 1 2 3 4 5; do
  if run "curl -fsS -o /dev/null http://localhost:8080/"; then
    echo "配置完了  http://${PI_HOST}:8080/"
    exit 0
  fi
  sleep 2
done

echo "サービスが応答しない。次で調べる:" >&2
echo "  sshpass -p '${PI_PASS}' ssh ${PI_USER}@${PI_HOST} 'journalctl -u ${SERVICE} -n 50 --no-pager'" >&2
exit 1
