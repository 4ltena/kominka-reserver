# Flask から Express への移行 設計

## 目的

Raspberry Pi 上の実行環境を Node に一本化する。アプリが Python を使わない状態にする。

Raspberry Pi OS から `python3` そのものは外せない（apt 周辺が依存している）。到達点は
「アプリが Python を必要としない」ことであり、`.venv` と `requirements.txt` の撤去までを指す。

## 変えないもの

データベースのファイル、スキーマ、URL、API の契約、Cloudflare Tunnel。特に API は
外部の Slack bot が使うため、応答の形を変えない。移植した契約テストで守る。

## 構成

実行時の依存は 3 つに絞る。

| | |
| --- | --- |
| `express` 5 | ルーティング |
| `ejs` | 画面 7 枚 |
| `better-sqlite3` | SQLite |

テストは Node 組み込みの `node:test` と `fetch` で書き、追加の依存を持たない。

`better-sqlite3` を選ぶ理由は、このシステムの正しさが「どちらの一意制約に違反したか」の
判別に乗っているため。`slot_taken` と `already_has` の区別が `SQLITE_CONSTRAINT_UNIQUE`
から安定して取れる。組み込みの `node:sqlite` は experimental で、ここを賭けない。

## 時刻

移植で最も危ないのがここ。日本は 1951 年を最後に夏時間を持たないため、**`+09:00` の固定
オフセット**として計算してよく、タイムゾーンのデータベースを引く必要がない。

- 暦日は `YYYY-MM-DD` の文字列で持つ。データベースの格納形と同じにして変換の往復を減らし、
  `Date` の壁時計計算を避ける。ISO の日付は辞書順が日付順なので比較もそのまま行える。
- 瞬間は epoch ミリ秒。JST の壁時計から瞬間へは `Date.UTC(y, m - 1, d, h - 9, min)` で厳密に出る。
- `25:00` は `h = 25` を渡せばそのまま翌 01:00 になる。Python の `slot_datetime` と同じ構造。

`src/jst.js` にこの変換を閉じ込め、他のモジュールは `Date` を直接触らない。

## 正しさの確かめ方

テストの移植だけでは足りない。Python 版と Node 版へ同じ入力を流し、出力を突き合わせる
差分テストを `tools/differential.mjs` に置く。期間全体を細かい刻みで走査し、
`slot_starts` / `stay_date` / `check_reservable` / `vote_state` / `visible_meals` の
出力が完全に一致することを確認する。境界を人間が選んで書くより網羅的になる。

## 移行の手順

WAL なので同じデータベースファイルを 2 つのプロセスが同時に開ける。

1. ローカルで実装し、テストと差分テストを通す
2. Pi で Express を 8081 に立て、現行のデータベースを直接見せて並走させる
3. 実データで確認したのち 8080 を Express に渡す
4. 同じ瞬間に `furo-gohan` から `kominka-reserver` への改名もまとめて 1 回で行う

Flask は切替まで一度も止めない。切り戻しは unit を戻すだけ。Tunnel は localhost:8080 を
見ているため触らない。改名と Express 化を別々に行わないのは、並走中に現行のパスを
動かさないためである。

## 既知の差異

- `now` の秒未満。Python は `datetime.now()` のマイクロ秒まで出す。Node は秒までとする。
  `deadline` と `starts_at` は常に分単位なので一致する。
- 経路の `detail` 文。Werkzeug の英文ではなく日本語にする。`error` は変えない。
- 想定外の例外。Python は HTML の 500 を返す。Node は `/api/v1` 配下では JSON を返す。
