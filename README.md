![License](https://img.shields.io/badge/license-MIT-green)
![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi-C51A4A?logo=raspberrypi&logoColor=white)

# kominka-reserver

古民家での共同生活で使う、風呂の枠予約と白米の集計。LAN 内の Raspberry Pi 上で動く Flask アプリ。

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

## データを読む

SQLite ファイル 1 つに全部入っている。パスは `data/kominka-reserver.db`（Pi では `~/kominka-reserver/data/`）。読むだけなら別プロセスから開いてよい。

```sql
members         (id, name, active, created_at)
bath_reservations (id, date, section, room, slot, member_id, created_at)
rice_votes      (id, date, meal, member_id, size, created_at)
```

- `date` は `YYYY-MM-DD`、`slot` は `HH:MM`。**`24:00` と `25:00` は翌日の 00:00 と 01:00** を指し、枠は入浴を始めた夜の日付に属する。
- `section` は `morning` / `night`、`room` は `shower`（風呂）/ `tub`（風呂・浴槽付き）。
- `meal` は `breakfast` / `dinner`、`size` は `normal`（0.5 合）/ `large`（1 合）。

ある食事の合計を出す例。

```sql
SELECT SUM(CASE size WHEN 'large' THEN 1.0 ELSE 0.5 END) AS go,
       COUNT(*) AS people
FROM rice_votes WHERE date = '2026-08-20' AND meal = 'dinner';
```

Python から使うなら `app/db.py` の `rice_summary()` と `reservations_for_date()` がそのまま呼べる。締切や枠の判定は `app/meals.py` と `app/slots.py` にあり、どちらも現在時刻を引数で受け取る純粋関数なので DB に触れずに試せる。

## 画面

| 経路 | 内容 |
| --- | --- |
| `/bath` | 風呂の表。`?date=YYYY-MM-DD` |
| `/meals` | ごはんのカード |
| `/members` | 名簿の一覧（読み取り専用） |
| `/fragment/bath`, `/fragment/meals` | 表とカードの断片。10 秒ごとの自動更新に使う |

書き込みは `/bath/reserve`、`/bath/cancel`、`/meals/vote`、`/meals/unvote` への通常のフォーム送信。JSON API は無い。

## 動かす

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py        # http://127.0.0.1:8080/
.venv/bin/python -m pytest
```

名簿は画面から編集できない。`roster.py list|add|hide|show <名前>` を使う。

Raspberry Pi へ置くときは `PI_PASS='<パスワード>' ./deploy.sh`。転送から systemd への登録まで一度に行い、`data/` と `config.toml` は上書きしない。

## 設定

`app/config.py` に日程と時間の設定がまとまっている。

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
