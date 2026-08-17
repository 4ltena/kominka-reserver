#!/usr/bin/env bash
# Raspberry Pi へ配置する。何度流しても結果は変わらない。
# data/ と config.toml は上書きしない。
set -euo pipefail

PI_HOST="${PI_HOST:-raspi}"
PI_USER="${PI_USER:-pi}"
PI_PASS="${PI_PASS:-xxxx}"
APP_DIR="${APP_DIR:-/home/${PI_USER}/furo-gohan}"
SERVICE=furo-gohan

HERE="$(cd "$(dirname "$0")" && pwd)"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

if ! command -v sshpass >/dev/null 2>&1; then
  echo "sshpass が要る。brew install hudochenkov/sshpass/sshpass" >&2
  exit 1
fi

run() {
  sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" "$@"
}

run_sudo() {
  run "echo '${PI_PASS}' | sudo -S sh -c '$*' 2>/dev/null"
}

echo "==> 接続確認 ${PI_USER}@${PI_HOST}"
run true

echo "==> ファイルの転送"
run "mkdir -p '${APP_DIR}'"
tar --exclude '__pycache__' -czf - -C "$HERE" \
    app run.py requirements.txt config.example.toml furo-gohan.service \
  | sshpass -p "$PI_PASS" ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" \
      "tar -xzf - -C '${APP_DIR}'"

echo "==> 依存の導入"
run_sudo "apt-get update -qq"
run_sudo "apt-get install -y -qq python3-venv python3-pip curl"
run "test -d '${APP_DIR}/.venv' || python3 -m venv '${APP_DIR}/.venv'"
run "'${APP_DIR}/.venv/bin/pip' -q install --upgrade pip"
run "'${APP_DIR}/.venv/bin/pip' -q install -r '${APP_DIR}/requirements.txt'"

echo "==> 設定とデータ (既存は残す)"
run "mkdir -p '${APP_DIR}/data'"
run "test -f '${APP_DIR}/config.toml' || cp '${APP_DIR}/config.example.toml' '${APP_DIR}/config.toml'"

echo "==> 時刻帯を Asia/Tokyo に"
run_sudo "timedatectl set-timezone Asia/Tokyo"

echo "==> systemd サービスの設置"
run "sed -e 's|__USER__|${PI_USER}|g' -e 's|__APP_DIR__|${APP_DIR}|g' \
      '${APP_DIR}/furo-gohan.service' > /tmp/${SERVICE}.service"
run_sudo "cp /tmp/${SERVICE}.service /etc/systemd/system/${SERVICE}.service"
run_sudo "systemctl daemon-reload"
run_sudo "systemctl enable ${SERVICE}"
run_sudo "systemctl restart ${SERVICE}"

echo "==> 応答の確認"
for i in 1 2 3 4 5; do
  if run "curl -fsS -o /dev/null http://localhost:8080/"; then
    echo "配置完了  http://${PI_HOST}.local:8080/"
    exit 0
  fi
  sleep 2
done

echo "サービスが応答しない。次で調べる:" >&2
echo "  sshpass -p '${PI_PASS}' ssh ${PI_USER}@${PI_HOST} 'journalctl -u ${SERVICE} -n 50 --no-pager'" >&2
exit 1
