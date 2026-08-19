# 風呂の 5 分前通知 Slack bot 実装手順

**Spec:** [docs/superpowers/specs/2026-08-19-slack-bath-notifier-design.md](../specs/2026-08-19-slack-bath-notifier-design.md)

> **この手順書は人が読んで自分で書くためのもの。** 通常の実装計画と違い、答えのコードを
> 載せない。各段階で「何を作るか」「どうなったら完成か」「どう確かめるか」「どこで詰まるか」
> だけを書く。詰まったら Claude に聞く。書いたものはレビューしてもらう。

**目標:** 予約した風呂の枠が始まる 5 分前に、Slack の共有チャンネルで本人をメンションする。

**構成:** 独立した Node プロセスが 1 分ごとに `/api/v1/bath/<date>` を叩き、開始 5 分前の
予約を見つけて Incoming Webhook へ投稿する。Express アプリには手を入れない。

**技術:** Node 20（`fetch` と `node:test` のみ。依存パッケージの追加なし）

## 全体の制約

- 追加の npm パッケージを入れない。`package.json` の `dependencies` は変えない。
- `src/` の既存ファイルを変更しない。新規は `bot/` と `test/notify.test.js` だけ。
- 秘密情報（Webhook URL）をコードにも git にも置かない。環境変数で渡す。
- 送信済みの鍵は `date|room|slot|member_id`。`reservation_id` は使わない（spec 参照）。
- 時刻の比較は epoch ミリ秒で行う。`"19:00"` の文字列を自分で足し算しない。

---

## 準備: 手元でアプリを動かす

Pi を触る前に、手元の PC で完結させる。Pi には最後に持っていく。

- [ ] `npm install` して `npm start`。`http://127.0.0.1:8080/` が開く
- [ ] `node roster.js add テスト太郎` などで名簿に 2〜3 人足す
- [ ] 画面から風呂の枠を 1 つ予約する
- [ ] `curl http://127.0.0.1:8080/api/v1/bath/2026-08-20` で、その予約が JSON に出るのを見る

**確認できたこと:** bot が読むデータの形。`sections` → `rooms` → `slots` の 3 段の入れ子で、
各 slot に `starts_at` `state` `member_id` `name` が入っている。**この JSON をどこかに
控えておく。次のテストで使う。**

**つまずきどころ:** 手元の `data/` は空から作られる。Pi の本番データとは別物。壊しても平気。

---

## Task 1: Slack 側を用意する

コードは書かない。Slack の設定だけ。

- [ ] Slack でアプリを作る（api.slack.com/apps → Create New App → From scratch）
- [ ] Incoming Webhooks を On にし、投稿先チャンネルを選んで Webhook URL を発行する
- [ ] `curl` で 1 通投げてチャンネルに出るのを確認する（`-d '{"text":"テスト"}'`）
- [ ] 自分の member ID を Slack のプロフィール（⋮ → メンバー ID をコピー）から取る
- [ ] `{"text":"<@U01ABCD2EF> テスト"}` を投げ、**青いリンクとして表示され通知が来る**のを確認する

**完成条件:** メンション付きの投稿がチャンネルに届く。

**つまずきどころ:**
- ID を間違えても Slack はエラーを返さない。`<@U01ABCD2EF>` が黒い文字のまま出たら間違い。
- 対象者がそのチャンネルに入っていないと通知は飛ばない。
- Webhook URL はパスワードと同じ。この時点で `.gitignore` に `bot/*.local*` などを足しておくか、
  環境変数だけで扱うと決めておく。

---

## Task 2: 通知対象を選ぶ純関数 `due` をテストから書く

ここが実装の中心。**テストを先に書く。**

**作るもの:** `bot/notify.js` に `due(days, now, sent)` を export する。

| | |
| --- | --- |
| `days` | `GET /api/v1/bath/<date>` の応答オブジェクトの配列（今日・明日の 2 つ） |
| `now` | epoch ミリ秒 |
| `sent` | 送信済みの鍵の `Set` |
| 戻り値 | 通知すべき枠の配列。1 件に `name` `member_id` `room` `slot` `key` が入っていれば十分 |

- [ ] **Step 1:** `test/notify.test.js` を作り、準備で控えた JSON を貼って固定データにする
- [ ] **Step 2:** 最初のテストを 1 つだけ書く（「開始 4 分前の `taken` な枠が 1 件返る」）
- [ ] **Step 3:** `npm test` で **失敗する**ことを確認する（`due is not a function`）
- [ ] **Step 4:** `due` を書いて通す
- [ ] **Step 5:** 残りの境界をテストに足し、1 つずつ通す

| 入力 | 期待 |
| --- | --- |
| 開始 4 分前、`taken` | 選ばれる |
| 開始 5 分ちょうど前 | 選ばれる |
| 開始 6 分前 | 選ばれない |
| 開始 1 分後（過ぎている） | 選ばれない |
| `free` の枠 | 選ばれない |
| 鍵が `sent` にある | 選ばれない |

- [ ] **Step 6:** `npm test` が全部通ったらコミットする

**ヒント（答えではない）:**
- 3 段の入れ子を平らにするのは `flatMap` を 2 回。
- `now` を固定値で渡すので `Date.now()` を `due` の中で呼ばない。呼ぶとテストが書けなくなる。
  この流儀は `src/slots.js` と同じ（現在時刻は必ず引数で受け取っている）。
- `starts_at` は `+09:00` 付きなので `Date.parse()` がそのまま解釈する。
- テストの `now` は「その枠の `starts_at` から 4 分引いた値」として計算で作る。日時を手で
  書くと、境界のテストを書き直すたびに壊れる。

**つまずきどころ:** 「5 分ちょうど」と「開始済み」の境界。spec の条件は
`0 < starts_at - now <= 5分`。等号がどちら側に付くかを、テストで固定してから実装する。

---

## Task 3: 実データで空打ちする（まだ Slack へ送らない）

- [ ] API の base URL は `process.env.API_BASE ?? "http://127.0.0.1:8080"` から取る
- [ ] `bot/notify.js` に、今日と明日の日付を作って API を 2 回叩く処理を足す
- [ ] 取ってきた応答を `due` に渡し、結果を `console.log` するだけの main を書く
- [ ] `node bot/notify.js` を実行する
- [ ] 手元のアプリで **5 分以内に始まる枠**を予約し、もう一度実行して 1 件出るのを見る

**完成条件:** 実際の API 応答から、通知すべき枠を拾えている。

**ヒント:** `src/jst.js` を import してはいけない。`deploy.sh` が Pi へ送るのは Flask 版の
`app/` だけで、`src/` は Pi に存在しない。日付の計算は bot 側に 3 行持つ。また「今日」は
暦日ではなく滞在の日（05:00 より前は前夜の続き）である点に注意する。夜の枠は 25:00 まで
伸び、開始した夜の日付に属するため、暦日で引くと 00:30 頃に取りこぼす。

**つまずきどころ:** アプリを止めた状態で実行すると `fetch` が例外を投げる。ここで
`try/catch` の位置を決めておく（spec: 捕まえてログを出し、次の分へ進む）。

---

## Task 4: Slack へ送る + 送信済みを覚える

- [ ] `post(text)` を書く。Webhook URL は `process.env.SLACK_WEBHOOK_URL` から読む
- [ ] URL が未設定なら、起動時にエラーを出して終了する（気づけないまま黙るのが最悪）
- [ ] メッセージを組み立てる。対応表に無い人は `あかりさん` と平文で出す
- [ ] 送信に成功した鍵だけ `sent` に足す（失敗したものは足さない＝次の分に再試行される）
- [ ] `sent` を `bot/sent.json` に書き出し、起動時に読む。読めなければ空で始める
- [ ] 一度実行して Slack に届くのを確認 → **もう一度実行して、今度は届かない**ことを確認

**完成条件:** 2 回実行しても 1 通しか飛ばない。これが重複防止の動作確認。

**つまずきどころ:**
- 浴室の日本語名は API が返さない。`src/config.js` の `ROOM_LABELS` と同じ対応を bot 側に書く。
- `Set` はそのままでは JSON にできない。`[...sent]` で配列にする。
- `bot/sent.json` と `bot/slack-users.json` を `.gitignore` に足す。代わりに 1 人分だけ書いた
  `bot/slack-users.example.json` をコミットしておくと、Pi で作り直すときに形を思い出せる。

---

## Task 5: 対応表を埋める

- [ ] Pi 上で `curl -s http://127.0.0.1:8080/api/v1/members` を叩き、名簿の名前を全部出す
- [ ] 名前をキー、空文字を値にした `bot/slack-users.json` の雛形を作る
- [ ] 各人の member ID を Slack から集めて埋める（集まった人から順でよい）
- [ ] 起動時チェックを足す: `/api/v1/members` を引き、**対応表に無い名前をログに出す**

**完成条件:** 起動ログに未登録の名前が並び、埋めるほど減っていく。

**つまずきどころ:** 名簿の名前を後から変えると対応表が黙って壊れる。起動時チェックはその
ための保険。省略しない。

---

## Task 6: 1 分ごとのループにする

- [ ] `setInterval` で 60 秒ごとに Task 3〜4 の処理を回す
- [ ] 起動直後にも 1 回走らせる（`setInterval` は 60 秒後まで何もしない）
- [ ] ループ全体を `try/catch` で囲み、例外で落ちないようにする
- [ ] 10 分ほど動かし、予約した枠の 5 分前に **1 通だけ** 届くのを確認する

**完成条件:** 放っておいて正しい時刻に 1 通だけ来る。

**つまずきどころ:** `Restart=always` があるので、落ちても再起動する＝バグに気づきにくい。
例外は握りつぶさず、必ず `console.error` に出す。

---

## Task 7: Pi へ置いて常駐させる

- [ ] `bot/kominka-bot.service` を書く。`kominka-reserver.service` を写して `ExecStart` を
      `node .../bot/notify.js` に変える
- [ ] Webhook URL は `EnvironmentFile=` で別ファイルから読ませる（unit ファイルに直書きしない）
- [ ] Pi にファイルを置く（`deploy.sh` は今回いじらない。手で `scp` でよい）
- [ ] `systemctl daemon-reload` → `enable` → `start`
- [ ] `journalctl -u kominka-bot -f` でログを見ながら、実際の枠で 1 回確認する
- [ ] `systemctl restart kominka-bot` して、**再起動後に連投しない**ことを確認する

**完成条件:** 再起動しても重複しない。`bot/sent.json` が効いている証拠。

**つまずきどころ:**
- Pi で動いているのは Flask 版。API の形は同じなので bot は変更なしで動く。動かなければ
  API の応答を `curl` で見比べる。
- `WorkingDirectory` を間違えると `bot/sent.json` が想定と違う場所にできる。絶対パスで確認する。

---

## 最後に

- [ ] `.gitignore` に `bot/sent.json` と `bot/slack-users.json` が入っているか確認
- [ ] `git status` に秘密情報が出ていないか目視
- [ ] コミットして README に 1 段落足す（bot の存在と起動方法）

## やらないこと

ごはんの締切通知、予約成立時の投稿、Slack からの操作。spec の「後回しにしたもの」を参照。
