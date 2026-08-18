![License](https://img.shields.io/badge/license-MIT-green)
![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi-C51A4A?logo=raspberrypi&logoColor=white)

# kominka-reserver

インターンの共同生活で使う、風呂の枠予約と白米の挙手集計。LAN 内の Raspberry Pi に置き、各自のスマートフォンから開く。

対象期間は 2026-08-17 の晩から 2026-08-28 の朝まで。

## 何ができるか

**風呂タブ** — 浴槽なしの「風呂」と浴槽ありの「風呂（浴槽付き）」を予約する。枠の長さは浴室ごとに違い、浴槽なしが 15 分、浴槽付きが 20 分。時間帯は朝が 06:00 から 08:00、夜が 19:00 から 25:00。24 時以降の表記は翌日を指し、`25:00` は翌 01:00 になる。刻み幅が違うので時刻の行は揃わず、画面では浴室ごとの列として横に並ぶ。

予約できるのは今日と明日の枠で、1 人が持てるのは同じ日の朝に 1 枠、夜に 1 枠まで。取り消しはいつでもできる。

「今日」は暦の日付ではなく滞在の一晩を指す。夜の枠が翌 01:20 まで伸びるため、05:00 より前は前夜の続きとして扱う。0 時を回っても前夜のタブが残り、まだ始まっていない深夜の枠を取れる。境目は `DAY_CHANGE_HOUR` にある。

同じ枠を 2 人が同時に押した場合、成立するのは 1 件だけになる。判定はデータベースの一意制約が行うため、確認と書き込みの隙に割り込まれることがない。

**ごはんタブ** — 必要な白米の量を挙手で集める。通常が 0.5 合、大盛が 1 合で、集計は合計の合数を出す。もう一方を押せば量を変えられる。締切は朝の分が前日 22:00、晩の分が当日 18:00。受付開始は無く、締切までならいつでも挙手できる。締切後は人数だけが残る。押していない状態を「要らない」として扱う。

最初の食事は 8/18 の晩ごはん。8/18 の朝ごはんは投票窓が過ぎていたため対象外で、朝ごはんは 8/19 から始まる。

名前はパスワードなしで名簿から選び、端末が Cookie で覚える。名簿は画面からは編集できず、一覧を見るだけになっている。画面に出るのはこれだけで、設定や管理の類は置かない。

## 手元で動かす

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py
```

`http://127.0.0.1:8080/` を開く。最初に「名簿」で参加者を登録する。

テストは `.venv/bin/python -m pytest` で走る。

## Raspberry Pi へ置く

Pi を同じ LAN に繋ぎ、SSH を有効にしてから実行する。

```sh
PI_PASS='<Pi のパスワード>' ./deploy.sh
```

既定の宛先は `raspberrypi.local` の `pi` ユーザー。パスワードは既定値を持たないので必ず渡す。回線が不安定なときは IP を直に指定した方が確実。

```sh
PI_HOST=192.168.0.10 PI_USER=pi PI_PASS='<パスワード>' ./deploy.sh
```

転送、仮想環境の作成、依存の導入、時刻帯の設定、systemd への登録、起動確認までを行う。何度流しても結果は変わらず、`data/` と `config.toml` は上書きしない。転送と `apt-get` と pip は 3 回まで再試行するので、無線が不安定でも 1 回の切断では止まらない。配置後は `http://raspberrypi.local:8080/` で開く。

`sshpass` が要る。入っていなければ `brew install hudochenkov/sshpass/sshpass` で入れる。

状態の確認と再起動は Pi 上で行う。

```sh
sudo systemctl status kominka-reserver
journalctl -u kominka-reserver -n 50 --no-pager
sudo systemctl restart kominka-reserver
```

## 名簿を変える

画面からは編集できない。Pi 上で操作する。

```sh
cd ~/kominka-reserver
.venv/bin/python roster.py list
.venv/bin/python roster.py add そら
.venv/bin/python roster.py hide そら
.venv/bin/python roster.py show そら
```

非表示にしても、その人の予約と投票は残る。

## 日程を変える

`app/config.py` の `PERIOD` に開始日と終了日をまとめてある。ここだけ書き換えれば全体が追随する。

```python
PERIOD = {
    ("bath", "night"):     (date(2026, 8, 17), date(2026, 8, 27)),
    ("bath", "morning"):   (date(2026, 8, 18), date(2026, 8, 28)),
    ("meal", "breakfast"): (date(2026, 8, 18), date(2026, 8, 28)),
    ("meal", "dinner"):    (date(2026, 8, 18), date(2026, 8, 27)),
}
```

白米の量と合数は `RICE_GO`、浴室ごとの枠の長さは `ROOM_SLOT_MINUTES`、朝と夜の時間帯は `SECTION_HOURS`、夜の最終開始時刻は `SECTION_LAST_START`、深夜の日付の境目は `DAY_CHANGE_HOUR`、投票の締切は `VOTE_DEADLINE` にある。

## 構成

| ファイル | 役割 |
| --- | --- |
| `app/config.py` | 期間、枠、設定ファイルの読み込み |
| `app/clock.py` | 現在時刻の取得口。テストはここを差し替える |
| `app/slots.py` | 風呂の枠生成と予約可否 |
| `app/meals.py` | 食事の一覧と投票窓 |
| `app/db.py` | SQLite の接続と問い合わせ |
| `app/web.py` | Flask アプリとルーティング |
| `roster.py` | 名簿の追加と非表示 |
| `deploy.sh` | Pi への配置 |

設計は `docs/superpowers/specs/2026-08-17-kominka-reserver-design.md` にある。
