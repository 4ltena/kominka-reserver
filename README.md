![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/Node-20%2B-5FA04E?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi-C51A4A?logo=raspberrypi&logoColor=white)

# kominka-reserver

古民家での共同生活で使う、風呂の枠予約と白米の集計。LAN 内の Raspberry Pi 上で動く Express アプリ。

- **風呂** — 浴槽なし 15 分、浴槽付き 20 分の枠を先着順で取る。朝 06:00〜08:00、夜 19:00〜25:00 開始。今日と明日の分だけ、朝 1 枠と夜 1 枠まで。
- **ごはん** — 白米の必要量を「通常」0.5 合と「大盛」1 合で挙手し、合計の合数を出す。
- **名簿** — パスワードなし。名前を選ぶと端末が Cookie で覚える。

## 締切

投票の受付開始は無く、締切だけがある。

| 対象 | 締切 |
| --- | --- |
| D 日の朝ごはん | D-1 日 22:00 |
| D 日の晩ごはん | D 日 18:00 |

時刻はすべて Asia/Tokyo。締切時刻ちょうどは締切済として扱う。

## API

`/api/v1/` に JSON で置いてある。認証は無い。締切や先着順の判定は画面と同じ規則で動く。日時はすべて `+09:00` 付きで返る。

| | |
| --- | --- |
| `GET /api/v1/members` | 名簿 |
| `GET /api/v1/meals` | 直近 4 件。`?all=true` で期間内の全食事 |
| `GET /api/v1/meals/<date>/<meal>` | 1 食分 |
| `POST /api/v1/meals/<date>/<meal>/vote` | `{"member_id":1,"size":"large"}` |
| `DELETE /api/v1/meals/<date>/<meal>/vote` | `{"member_id":1}` |
| `GET /api/v1/bath/<date>` | その日の枠と予約者 |
| `POST /api/v1/bath/<date>/reserve` | `{"member_id":1,"section":"night","room":"shower","slot":"19:00"}` |
| `DELETE /api/v1/bath/reservations/<id>` | `{"member_id":1}` |

`<meal>` は `breakfast` / `dinner`、`<date>` は `YYYY-MM-DD`。引数は JSON 本体でもフォームでもクエリ文字列でも受ける。`DELETE` に本体を付けられない client は `?member_id=1` でよい。

### 名簿

```json
{"members": [{"id": 1, "name": "あかり"}], "registered": 23}
```

`id` がそのまま `member_id` になる。Slack の利用者との対応は bot 側で持つ。

### ごはん

1 食分はこの形で、`/api/v1/meals` はこれを `{"now": "...", "meals": [...]}` に包んで返す。

```json
{"date":"2026-08-20","meal":"dinner","state":"open",
 "deadline":"2026-08-20T18:00:00+09:00",
 "go":1.5,"people":2,"registered":3,
 "by_size":{"normal":1,"large":1}}
```

`state` は `open` か `closed`。`go` が炊く合数、`people` は挙手した人数、`registered` は名簿の人数。投票と取り消しが成功すると更新後の同じ形が返るため、読み直さなくてよい。取り消しは挙手していなくても成功として返るので、何度呼んでも結果は変わらない。

### 風呂

`GET /api/v1/bath/<date>` は区分と浴室で入れ子になった枠を返す。

```json
{"date":"2026-08-20","now":"2026-08-20T12:00:00+09:00","selectable":true,
 "sections":[{"section":"night","rooms":[{"room":"shower","minutes":15,
   "slots":[{"slot":"19:00","starts_at":"2026-08-20T19:00:00+09:00",
             "state":"free","reservable":true,
             "member_id":null,"name":null,"reservation_id":null}]}]}]}
```

`state` は `free` / `taken` / `past` で、埋まっていれば `name` と `reservation_id` が入る。**予約に進んでよいかは `state` ではなく `reservable` を見る。** 期間内でも受け付けるのは今日と明日だけなので、それより先の日の空き枠は `state` が `free` のまま `reservable` が `false` になる。日ごとの可否は `selectable`。

予約が成立すると 201 とともに次が返る。取り消しに使う `reservation_id` はここか枠の一覧から取る。

```json
{"reservation_id":12,"date":"2026-08-20","section":"night",
 "room":"shower","slot":"19:00","starts_at":"2026-08-20T19:00:00+09:00",
 "member_id":1,"name":"あかり"}
```

### 失敗

状態コードと機械可読な `error` を返す。画面の日本語文言とは分離してあるので、文面を変えても壊れない。経路や method を間違えたときも HTML ではなく `not_found` / `method_not_allowed` の JSON が返る。

| `error` | 状態 | 意味 |
| --- | --- | --- |
| `bad_request` | 400 | `member_id` が無いなど。`detail` に理由が入る |
| `bad_slot` | 400 | 知らない浴室、区分に無い時刻 |
| `bad_size` | 400 | `normal` / `large` 以外 |
| `unknown_member` | 404 | 名簿に無い |
| `unknown_meal` | 404 | 期間外の食事 |
| `unknown_reservation` | 404 | 無いか、他人の予約 |
| `not_in_period` | 404 | 期間外の日 |
| `not_found` | 404 | 知らない経路 |
| `method_not_allowed` | 405 | method が違う |
| `not_selectable_date` | 409 | 今日と明日以外 |
| `slot_started` | 409 | 開始時刻を過ぎた |
| `slot_taken` | 409 | 先に取られた |
| `already_has` | 409 | その区分で予約済み。`held` に中身が入る |
| `deadline_passed` | 409 | 締切後。`deadline` が入る |

## データを直接読む

API を通さず SQLite を開いてもよい。パスは `data/kominka-reserver.db`（Pi では `~/kominka-reserver/data/`）。

```sql
members           (id, name, active, created_at)
bath_reservations (id, date, section, room, slot, member_id, created_at)
rice_votes        (id, date, meal, member_id, size, created_at)
```

- `date` は `YYYY-MM-DD`、`slot` は `HH:MM`。**`24:00` と `25:00` は翌日の 00:00 と 01:00** を指し、枠は入浴を始めた夜の日付に属する。
- `section` は `morning` / `night`、`room` は `shower`（風呂）/ `tub`（風呂・浴槽付き）。
- `meal` は `breakfast` / `dinner`、`size` は `normal`（0.5 合）/ `large`（1 合）。

書き込みは API 経由を勧める。先着順と 1 人 1 枠は一意制約が守っているため、直接 INSERT すると制約違反を自前で捌く必要がある。

## 画面（人が使う側）

| 経路 | 内容 |
| --- | --- |
| `/bath` | 風呂の表。`?date=YYYY-MM-DD` |
| `/meals` | ごはんのカード |
| `/members` | 名簿の一覧（読み取り専用） |
| `/fragment/bath`, `/fragment/meals` | 表とカードの断片。10 秒ごとの自動更新に使う |

書き込みは `/bath/reserve`、`/bath/cancel`、`/meals/vote`、`/meals/unvote` への通常のフォーム送信。API とは同じデータを見ている。

## 動かす

```sh
npm install
npm start                      # http://127.0.0.1:8080/
npm test
```

名簿は画面から編集できない。`node roster.js list|add|hide|show <名前>` を使う。

Raspberry Pi へ置くときは `PI_PASS='<パスワード>' ./deploy.sh`。転送から systemd への登録まで一度に行い、`data/` と `config.toml` は上書きしない。

## 通知 bot

`bot/notify.js` が、予約した風呂の枠が始まる 5 分前に Slack の共有チャンネルで本人をメンションする。1 分ごとに `/api/v1/bath/<date>` を見に行くだけの独立したプロセスで、アプリには手を入れていない。API の契約が Flask 版と Express 版で同じなため、どちらが動いていても変更なしで働く。依存は増やさず Node 20 の `fetch` だけで動く。

```sh
export SLACK_WEBHOOK_URL_TUB='https://hooks.slack.com/services/...'
export SLACK_WEBHOOK_URL_SHOWER='https://hooks.slack.com/services/...'
node bot/notify.js
```

| | |
| --- | --- |
| `SLACK_WEBHOOK_URL_TUB` | 浴槽付きの通知先。Slack アプリの Incoming Webhook で発行する |
| `SLACK_WEBHOOK_URL_SHOWER` | 浴槽なしの通知先 |
| `SLACK_WEBHOOK_URL` | 上の 2 つが無いときに使う共通の通知先。1 チャンネルで済ませるとき用 |
| `API_BASE` | 既定 `http://127.0.0.1:8080` |
| `bot/slack-users.json` | 名簿の名前 → Slack member ID。`slack-users.example.json` が見本。1 分ごとに読み直すので、動かしながら埋めてよい |
| `bot/sent.json` | 送信済みの鍵。自動で作られる |

浴室ごとに Slack のチャンネルが分かれているため、投稿先も浴室ごとに持つ。`_TUB` が浴槽の**ある**方。アプリの画面では浴槽なしを「風呂」と呼ぶため、Slack の #風呂 チャンネルがどちらを指すかは目で確かめてから割り当てる。

メンションには member ID（`U01ABCD2EF`）が要る。表示名では通知が飛ばない。ID は Slack のプロフィール → その他 → 「メンバー ID をコピー」で取る。対応表に無い人は平文の名前で投稿する。名簿にいて対応表に無い人は起動時のログに出る。

Pi では `bot/kominka-bot.service` を `kominka-reserver.service` と同じ手順で置く。`__USER__` と `__APP_DIR__` を置き換え、Webhook URL は `bot/webhook.env` に `SLACK_WEBHOOK_URL_TUB=...` と `SLACK_WEBHOOK_URL_SHOWER=...` の 2 行で置く。`deploy.sh` はまだ bot を転送しないため、手で送る。 配置から systemd への登録、確認と切り分けまでの手順は [docs/slack-bot-deploy.md](docs/slack-bot-deploy.md) にまとめてある。

送信済みをファイルに残すのは、`Restart=always` で再起動したときに同じ枠へ投稿し続けるのを防ぐため。鍵は `date|room|slot|member_id` で、`reservation_id` は使わない。SQLite は削除された id を再利用するため、取り消しのあとに同じ id を得た予約へ通知が飛ばなくなる。
## 実装

もとは Flask で書き、Raspberry Pi の実行環境を Node に寄せるため Express へ移した。
移行の最中なので Python 版が `app/` と `tests/` に残っている。**Pi で動いているのは
まだ Python 版**であり、切り替えは同じデータベースを見せて並走させたうえで行う。
データベースのファイルもスキーマも URL も API の契約も変わらない。

```
src/jst.js       日本標準時。夏時間が無いので +09:00 の固定オフセットとして扱う
src/slots.js     風呂の枠と可否。現在時刻は引数で受け取り、DB には触れない
src/meals.js     食事と締切
src/db.js        SQLite。先着順と 1 人 1 枠は一意制約が守る
src/api.js       /api/v1
src/web.js       画面
```

移植が正しいことは、両方の版へ同じ入力を流して確かめている。`tools/dump.py` と
`tools/dump.mjs` が純関数の出力を突き合わせ、`tools/api-differential.mjs` は
2 つのサーバを同時に立てて応答そのものを比べる。

## 設定

`src/config.js` に日程と時間の設定がまとまっている。

| 名前 | 意味 |
| --- | --- |
| `PERIOD` | 風呂と食事それぞれの開始日と終了日 |
| `SECTION_HOURS` | 朝と夜の時間帯 |
| `SECTION_LAST_START` | 夜の最終開始時刻 |
| `ROOM_SLOT_MINUTES` | 浴室ごとの枠の長さ |
| `DAY_CHANGE_HOUR` | 深夜を前夜として扱う境目（05:00） |
| `VOTE_DEADLINE` | 食事ごとの締切 |
| `RICE_GO` | 量から合数への換算 |

設計は `docs/superpowers/specs/` にある。
