# furo-gohan

インターンの共同生活で使う、風呂の枠予約と白米の挙手集計。LAN 内の Raspberry Pi に置き、各自のスマートフォンから開く。

対象期間は 2026-08-17 の晩から 2026-08-28 の朝まで。

## 何ができるか

**風呂タブ** — 浴槽なしの「風呂」と浴槽ありの「風呂（浴槽付き）」を予約する。枠の長さは浴室ごとに違い、浴槽なしが 15 分、浴槽付きが 20 分。時間帯は朝が 06:00 から 08:00、夜が 19:00 から 24:00。ただし夜に入浴を始められるのは 23:00 までで、それより後の枠は出ない。刻み幅が違うので時刻の行は揃わず、画面では浴室ごとの列として横に並ぶ。

予約できるのは今日と明日の枠で、1 人が持てるのは同じ日の朝に 1 枠、夜に 1 枠まで。取り消しはいつでもできる。

同じ枠を 2 人が同時に押した場合、成立するのは 1 件だけになる。判定はデータベースの一意制約が行うため、確認と書き込みの隙に割り込まれることがない。

**ごはんタブ** — 白米が要る人が挙手する。朝の分は前日 18:00 から 22:00 まで、晩の分は当日 09:00 から 18:00 までが受付で、締切後は人数だけが残る。押していない状態を「要らない」として扱う。

最初の食事は 8/18 の晩ごはん。8/18 の朝ごはんは投票窓が過ぎていたため対象外で、朝ごはんは 8/19 から始まる。

名前はパスワードなしで名簿から選び、端末が Cookie で覚える。名簿の編集は画面下の「名簿」から行う。

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
./deploy.sh
```

既定では `raspi` というホスト名の `pi` ユーザーへ、パスワード `xxxx` で入る。変えるときは環境変数で渡す。

```sh
PI_HOST=192.168.1.20 PI_USER=pi PI_PASS=... ./deploy.sh
```

転送、仮想環境の作成、依存の導入、時刻帯の設定、systemd への登録、起動確認までを行う。何度流しても結果は変わらず、`data/` と `config.toml` は上書きしない。配置後は `http://raspi.local:8080/` で開く。

`sshpass` が要る。入っていなければ `brew install hudochenkov/sshpass/sshpass` で入れる。

状態の確認と再起動は Pi 上で行う。

```sh
sudo systemctl status furo-gohan
journalctl -u furo-gohan -n 50 --no-pager
sudo systemctl restart furo-gohan
```

## Discord への通知（未完成）

締切を過ぎた食事の集計を Discord へ投稿する仕組みが入っている。60 秒ごとに未送信の食事を拾い、投稿できたものを記録して二度送らない。締切から 24 時間を超えたものは送らない。

`config.toml` の設定が空のあいだは投稿しない。動かすには bot を作り、次を書く。

```toml
[discord]
bot_token = "..."
channel_id = "..."
manager_id = ""   # 米の担当者の Discord ユーザー ID。空ならメンションなし
```

書いたあと「名簿」の画面の試験投稿で届くかを確かめる。bot の作成と権限付与、担当者の指定はまだ行っていない。

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

浴室ごとの枠の長さは `ROOM_SLOT_MINUTES`、朝と夜の時間帯は `SECTION_HOURS`、夜の受付を打ち切る時刻は `SECTION_LAST_START`、投票の受付窓は `VOTE_WINDOW` にある。

## 構成

| ファイル | 役割 |
| --- | --- |
| `app/config.py` | 期間、枠、設定ファイルの読み込み |
| `app/clock.py` | 現在時刻の取得口。テストはここを差し替える |
| `app/slots.py` | 風呂の枠生成と予約可否 |
| `app/meals.py` | 食事の一覧と投票窓 |
| `app/db.py` | SQLite の接続と問い合わせ |
| `app/notify.py` | Discord への投稿 |
| `app/web.py` | Flask アプリとルーティング |
| `deploy.sh` | Pi への配置 |

設計は `docs/superpowers/specs/2026-08-17-furo-gohan-design.md` にある。
