# 通知 bot をサーバへ置く

Raspberry Pi を管理している人向けの手順。風呂の枠が始まる 5 分前に、予約した本人を
Slack でメンションする bot を常駐させる。

アプリ本体には手を入れない。bot は `/api/v1/` を外から呼ぶだけの別プロセスで、
止めても予約と集計はそのまま動く。

## 前提

| | |
| --- | --- |
| Node | **18 以上**。`fetch` を使うため。アプリ本体が Node なので同じ機体なら入っている |
| 依存 | 無し。`npm install` は不要 |
| 通信 | アプリの API（既定 `http://127.0.0.1:8080`）と `hooks.slack.com` への外向き HTTPS |

## 用意するもの

**1. Slack の Incoming Webhook URL を浴室の数だけ**

浴槽付き用と浴槽なし用で 2 本発行する。Incoming Webhook は 1 本が 1 チャンネルに固定される
ため、投げ分けるには本数を分けるしかない。Slack アプリの Incoming Webhooks で発行する。権限は `incoming-webhook` の 1 つだけでよく、
これは「指定した 1 チャンネルに投稿する」以外に何もできない。**URL 自体が鍵**なので、
チャットに貼らない。漏れたら発行し直して古い方を消す。

**2. 名簿と Slack の対応表**

`bot/slack-users.json` に、アプリの名簿の名前をキーとして Slack の member ID を書く。

```json
{ "あかり": "U01ABCD2EF", "たかし": "U01GHIJ3KL" }
```

member ID は Slack のプロフィール → その他 → 「メンバー ID をコピー」で取る。**表示名では
メンションが飛ばない。** 対応表に無い人は平文の名前で投稿される（通知は飛ばないが、投稿は
落とさない）。全員分そろっていなくても動くので、埋まった人から書けばよい。

## 置く

`deploy.sh` がアプリと一緒に置く。送るのは `notify.js` と `kominka-bot.service` と
`slack-users.example.json` の 3 つだけで、**Pi 側の `webhook.env` と `slack-users.json` は
触らない。** 秘密と対応表は Pi にしか無い。

```sh
PI_PASS='<パスワード>' ./deploy.sh
```

初回は `webhook.env` がまだ無いため、unit を置くところで止まる。Pi の上で設定を書く。

```sh
cd ~/kominka-reserver
cat > bot/webhook.env <<'EOT'
SLACK_WEBHOOK_URL_TUB=https://hooks.slack.com/services/...
SLACK_WEBHOOK_URL_SHOWER=https://hooks.slack.com/services/...
EOT
chmod 600 bot/webhook.env
vi bot/slack-users.json          # 対応表を書く
```

書き終えたら `deploy.sh` を流し直す。次からは bot も一緒に起動する。

## 常駐させる前に 1 回手で動かす

```sh
cd ~/kominka-reserver && node bot/notify.js
```

正常なら次が出る。名簿を読めている証拠になる。確認したら `Ctrl+C`。

```
kominka-bot 起動  API=http://127.0.0.1:8080  送信済み=0件
対応表に無い: そら, みなと          ← 対応表が埋まっていない人。全員埋まっていれば出ない
```

## systemd に登録する

`deploy.sh` が行う。`bot/kominka-bot.service` の `__USER__` と `__APP_DIR__` を置き換えて
`/etc/systemd/system/` へ入れ、`webhook.env` があれば `enable --now` する。URL が無いまま
起こすと `notify.js` が終了コード 1 で落ち、`Restart=always` が 3 秒ごとに起こし直すため、
無いうちは意図して起こさない。

手で登録するなら次のとおり。

```sh
APP_DIR=/home/pi/kominka-reserver
sed -e "s|__USER__|pi|g" -e "s|__APP_DIR__|${APP_DIR}|g" \
    ${APP_DIR}/bot/kominka-bot.service > /tmp/kominka-bot.service
sudo cp /tmp/kominka-bot.service /etc/systemd/system/kominka-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now kominka-bot
journalctl -u kominka-bot -f
```

`ExecStart` は `/usr/bin/node` を指している。`which node` が違う場所を返すなら unit を直す。

## 動作の確認

実際の枠で確かめる。直近の枠を 1 つ予約し、その 5 分前に Slack へ届くかを見る。

再起動しても連投しないことも確認しておく。`sudo systemctl restart kominka-bot` を通知の
窓（開始 5 分前〜開始）の最中に行い、同じ人へ 2 通目が飛ばなければ正しい。

## 何をする bot か

- 1 分ごとに「今日」と「明日」の `GET /api/v1/bath/<date>` を引く
- 予約済みで、開始まで 5 分を切っていて、まだ送っていない枠を Slack へ 1 通投げる
- 送った枠の鍵を `bot/sent.json` に記録する

やらないこと。ごはんの投票締切の通知、予約が成立した瞬間の投稿、Slack からの操作。
Slack から bot への通信は無いため、外部に穴を開ける必要はない。

**同じ枠へ 2 回送らない仕組み**。1 分ごとに巡回する一方で通知の窓が 5 分あるため、同じ枠が
5 回続けて条件を満たす。送信済みの鍵を `bot/sent.json` に持って弾いている。`Restart=always`
で再起動しても記憶が残るのはこのファイルのおかげなので、消さない。消しても実害は
「窓の中にいる枠へもう 1 通飛ぶ」程度。

鍵は `日付|浴室|時刻|member_id` で、`reservation_id` は使っていない。SQLite が削除された
id を再利用するため、取り消しのあとに同じ id を得た予約へ通知が飛ばなくなるのを避けている。

## 設定

| | |
| --- | --- |
| `SLACK_WEBHOOK_URL_TUB` | 浴槽付きの通知先。`bot/webhook.env` に書く。unit ファイルに直書きしない |
| `SLACK_WEBHOOK_URL_SHOWER` | 浴槽なしの通知先 |
| `SLACK_WEBHOOK_URL` | 上の 2 つが無いときの共通の通知先。1 チャンネルで運用するとき用 |
| `API_BASE` | 既定 `http://127.0.0.1:8080`。別の機体から動かすときだけ指定する |
| `bot/slack-users.json` | 1 分ごとに読み直す。**書き換えに再起動は要らない** |
| `bot/sent.json` | 自動で作られる。消さない |

浴室の日本語名（`shower`→風呂、`tub`→風呂（浴槽付き））は API が返さないため bot が持って
いる。**`shower` が浴槽なしで、アプリの画面ではそれを「風呂」と呼ぶ。** 投稿先を割り当てる
ときはここで取り違えやすい。`src/config.js` の `ROOM_LABELS` と一致することを `npm test` が確認する。

## 困ったとき

| 症状 | 原因 |
| --- | --- |
| 起動直後に `投稿先が URL になっていない浴室` で落ちる | その浴室の行が `webhook.env` に無いか書式違い。`SLACK_WEBHOOK_URL_TUB=https://...` の形。引用符も `< >` も要らない |
| 浴槽付きと浴槽なしが逆のチャンネルに出る | `_TUB` と `_SHOWER` の URL が入れ替わっている。アプリは浴槽なしを「風呂」と呼ぶため取り違えやすい |
| `巡回に失敗 fetch failed` が続く | アプリが落ちている。`systemctl status kominka-reserver` を見る。bot は落ちずに次の分で復帰する |
| 特定の人だけ通知が来ない | 対応表に無い（起動ログに名前が出る）、member ID の写し間違い、または本人が投稿先チャンネルに入っていない |
| 名前が青くならず `@U01ABCD…` と出る | member ID が違う。Slack はこの誤りをエラーにせず、文字列のまま表示する |
| 同じ人に何通も飛ぶ | `bot/sent.json` を書けていない。ディレクトリの所有者と unit の `User=` を見る |
| 名簿の名前を変えたら通知が止まった | 対応表のキーは名簿の名前。起動ログの「対応表に無い」に出る |

## 止める

```sh
sudo systemctl disable --now kominka-bot
```

アプリ本体には影響しない。bot を止めても予約と集計はそのまま動く。
