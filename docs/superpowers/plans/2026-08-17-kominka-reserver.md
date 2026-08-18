# 風呂予約・白米投票システム 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LAN 内の Raspberry Pi で動く、風呂の枠予約と白米の挙手集計を 2 タブで行う Web アプリを作る。

**Architecture:** Flask がサーバ側で HTML を生成し、操作は通常のフォーム送信で行う。時刻に依存する判定は現在時刻を引数で受け取る純粋関数に閉じ込め、データベースに触れずにテストできるようにする。先着順と 1 人 1 枠は SQLite の一意制約が守る。白米の集計は締切後に背景処理が Discord へ投稿する。

**Tech Stack:** Python 3.11 / Flask / SQLite / 標準ライブラリの urllib.request / pytest

**Spec:** `docs/superpowers/specs/2026-08-17-kominka-reserver-design.md`

## Global Constraints

- Python 3.11 以上。設定の読み込みに `tomllib` を使うため 3.11 未満は不可。
- 追加依存は Flask と pytest のみ。Discord への投稿は標準ライブラリの `urllib.request` で行う。
- 時刻帯は `zoneinfo.ZoneInfo("Asia/Tokyo")` に固定する。`datetime.now()` の直接呼び出しは `app/clock.py` の 1 箇所だけに置く。
- 判定関数は現在時刻を引数で受け取る。既定引数で現在時刻を取得しない。
- 日付は `YYYY-MM-DD`、枠の開始時刻は `HH:MM` の文字列で保存する。
- 対象期間は次のとおり。夜風呂 2026-08-17 から 2026-08-27。朝風呂 2026-08-18 から 2026-08-28。朝ごはん 2026-08-18 から 2026-08-28。晩ごはん 2026-08-18 から 2026-08-27。
- 浴室の識別子は `shower`（表示名「風呂」）と `tub`（表示名「風呂（浴槽付き）」）。区分は `morning` と `night`。食事は `breakfast` と `dinner`。
- 画面の背景は白 `#ffffff`、文字は `#111111`、罫線は `#dddddd`。
- `config.toml` と `data/` は版数管理に含めない。

---

## File Structure

| ファイル | 責務 |
| --- | --- |
| `app/config.py` | 期間、枠、浴室、表示名、設定ファイルの読み込み |
| `app/clock.py` | 現在時刻の取得。テストから差し替える唯一の窓口 |
| `app/slots.py` | 風呂の枠生成と期間判定。純粋関数のみ |
| `app/meals.py` | 食事の一覧と投票窓の判定。純粋関数のみ |
| `app/db.py` | SQLite の接続、スキーマ、問い合わせ |
| `app/notify.py` | Discord への投稿と、通知すべき食事の選定 |
| `app/web.py` | Flask アプリとルーティング |
| `app/templates/` | 画面 |
| `app/static/style.css` | 見た目 |
| `tests/` | pytest |
| `run.py` | 起動口 |
| `deploy.sh` | Pi への配置 |
| `kominka-reserver.service` | systemd の設定 |

---

### Task 1: 骨格と設定

**Files:**
- Create: `app/__init__.py`, `app/config.py`, `app/clock.py`, `config.example.toml`, `requirements.txt`, `.gitignore`, `tests/__init__.py`, `tests/conftest.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Produces: `config.TZ`, `config.ROOMS`, `config.ROOM_LABELS`, `config.SECTIONS`, `config.SECTION_LABELS`, `config.MEALS`, `config.MEAL_LABELS`, `config.PERIOD` (辞書。キーは `("bath","morning")` などの組、値は `(first_date, last_date)`)、`config.load_settings(path) -> Settings`、`clock.now() -> datetime`
- `Settings` は `bot_token: str`, `channel_id: str`, `manager_id: str`, `host: str`, `port: int` を持つ凍結データクラス。ファイルが無い場合はすべて既定値で返す。

- [ ] **Step 1: 設定の読み込みテストを書く**

```python
def test_load_settings_missing_file(tmp_path):
    s = load_settings(tmp_path / "none.toml")
    assert s.bot_token == "" and s.channel_id == "" and s.manager_id == ""
    assert s.host == "0.0.0.0" and s.port == 8080

def test_load_settings_reads_discord(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text('[discord]\nbot_token = "t"\nchannel_id = "123"\n', encoding="utf-8")
    s = load_settings(p)
    assert (s.bot_token, s.channel_id, s.manager_id) == ("t", "123", "")
```

- [ ] **Step 2: 失敗を確認する** — `pytest tests/test_config.py -v`、`ModuleNotFoundError` で失敗する。
- [ ] **Step 3: `app/config.py` と `app/clock.py` を実装する**

期間は `PERIOD` に集約する。

```python
PERIOD = {
    ("bath", "night"):      (date(2026, 8, 17), date(2026, 8, 27)),
    ("bath", "morning"):    (date(2026, 8, 18), date(2026, 8, 28)),
    ("meal", "breakfast"):  (date(2026, 8, 18), date(2026, 8, 28)),
    ("meal", "dinner"):     (date(2026, 8, 18), date(2026, 8, 27)),
}
```

`clock.now()` は `datetime.now(config.TZ)` を返すだけにする。

- [ ] **Step 4: 通ることを確認する** — `pytest tests/test_config.py -v`
- [ ] **Step 5: commit** — `chore: プロジェクトの骨格と設定の読み込みを追加`

---

### Task 2: 風呂の枠と期間

**Files:**
- Create: `app/slots.py`
- Test: `tests/test_slots.py`

**Interfaces:**
- Consumes: `config.PERIOD`, `config.TZ`
- Produces:
  - `slot_starts(section: str) -> tuple[str, ...]`
  - `section_in_period(section: str, d: date) -> bool`
  - `sections_for_date(d: date) -> tuple[str, ...]` — 期間内の区分だけを `("morning", "night")` の順で返す
  - `slot_datetime(d: date, slot: str) -> datetime` — Asia/Tokyo の aware
  - `selectable_dates(now: datetime) -> list[date]` — 今日と明日のうち、期間内の区分を 1 つ以上持つ日
  - `check_reservable(d: date, section: str, slot: str, now: datetime) -> str` — `"ok"` か拒否理由 `"out_of_period"` / `"not_selectable_date"` / `"past"` / `"bad_slot"`

- [ ] **Step 1: テストを書く**

```python
def test_slot_starts_morning():
    assert slot_starts("morning") == ("06:00", "06:20", "06:40", "07:00", "07:20", "07:40")

def test_slot_starts_night_has_15():
    s = slot_starts("night")
    assert len(s) == 15 and s[0] == "19:00" and s[-1] == "23:40"

def test_sections_first_day_is_night_only():
    assert sections_for_date(date(2026, 8, 17)) == ("night",)

def test_sections_last_day_is_morning_only():
    assert sections_for_date(date(2026, 8, 28)) == ("morning",)

def test_sections_middle_day_has_both():
    assert sections_for_date(date(2026, 8, 20)) == ("morning", "night")

def test_sections_outside_period_is_empty():
    assert sections_for_date(date(2026, 8, 29)) == ()

def test_check_reservable_rejects_started_slot():
    now = datetime(2026, 8, 20, 19, 5, tzinfo=config.TZ)
    assert check_reservable(date(2026, 8, 20), "night", "19:00", now) == "past"
    assert check_reservable(date(2026, 8, 20), "night", "19:20", now) == "ok"

def test_check_reservable_rejects_day_after_tomorrow():
    now = datetime(2026, 8, 20, 12, 0, tzinfo=config.TZ)
    assert check_reservable(date(2026, 8, 22), "night", "19:00", now) == "not_selectable_date"
```

- [ ] **Step 2: 失敗を確認する** — `pytest tests/test_slots.py -v`
- [ ] **Step 3: 実装する** — 枠は開始時刻と刻み幅から生成する。朝は 06:00 から 08:00 の手前まで、夜は 19:00 から翌 00:00 の手前まで、20 分刻み。
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: 風呂の枠生成と予約可否の判定を追加`

---

### Task 3: 食事と投票窓

**Files:**
- Create: `app/meals.py`
- Test: `tests/test_meals.py`

**Interfaces:**
- Consumes: `config.PERIOD`, `config.TZ`
- Produces:
  - `Meal` — 凍結データクラス。`day: date`, `kind: str`
  - `all_meals() -> list[Meal]` — 期間内の全食事を時系列で
  - `vote_window(m: Meal) -> tuple[datetime, datetime]` — 受付開始と締切
  - `vote_state(m: Meal, now: datetime) -> str` — `"before"` / `"open"` / `"closed"`
  - `visible_meals(now: datetime) -> list[Meal]` — 締切が未来の先頭 3 件と直近で締め切った 1 件、時系列で最大 4 件
  - `pending_notifications(now: datetime, sent: set[tuple[str, str]]) -> list[Meal]` — 締切済、未送信、締切から 24 時間以内

- [ ] **Step 1: テストを書く**

```python
def test_breakfast_window_is_previous_evening():
    m = Meal(date(2026, 8, 19), "breakfast")
    assert vote_window(m) == (
        datetime(2026, 8, 18, 18, 0, tzinfo=config.TZ),
        datetime(2026, 8, 18, 22, 0, tzinfo=config.TZ),
    )

def test_dinner_window_is_same_day_daytime():
    m = Meal(date(2026, 8, 19), "dinner")
    assert vote_window(m) == (
        datetime(2026, 8, 19, 9, 0, tzinfo=config.TZ),
        datetime(2026, 8, 19, 18, 0, tzinfo=config.TZ),
    )

def test_vote_state_boundaries():
    m = Meal(date(2026, 8, 19), "dinner")
    assert vote_state(m, datetime(2026, 8, 19, 8, 59, tzinfo=config.TZ)) == "before"
    assert vote_state(m, datetime(2026, 8, 19, 9, 0, tzinfo=config.TZ)) == "open"
    assert vote_state(m, datetime(2026, 8, 19, 17, 59, tzinfo=config.TZ)) == "open"
    assert vote_state(m, datetime(2026, 8, 19, 18, 0, tzinfo=config.TZ)) == "closed"

def test_all_meals_bounds():
    ms = all_meals()
    assert ms[0] == Meal(date(2026, 8, 18), "breakfast")
    assert ms[-1] == Meal(date(2026, 8, 28), "breakfast")
    assert Meal(date(2026, 8, 28), "dinner") not in ms
    assert Meal(date(2026, 8, 17), "dinner") not in ms

def test_visible_meals_keeps_one_closed():
    now = datetime(2026, 8, 20, 20, 0, tzinfo=config.TZ)
    vs = visible_meals(now)
    assert len(vs) == 4
    assert vote_state(vs[0], now) == "closed"
    assert sum(1 for m in vs if vote_state(m, now) == "closed") == 1

def test_pending_skips_sent_and_stale():
    now = datetime(2026, 8, 20, 20, 0, tzinfo=config.TZ)
    sent = {("2026-08-20", "dinner")}
    assert all(m.kind != "dinner" or m.day != date(2026, 8, 20)
               for m in pending_notifications(now, sent))
    assert all((now - vote_window(m)[1]).total_seconds() <= 86400
               for m in pending_notifications(now, set()))
```

- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する** — 並び順は締切時刻を鍵にする。朝の締切は前日 22:00、晩の締切は当日 18:00 なので、締切順と食事の時系列順は一致する。
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: 食事の一覧と投票窓の判定を追加`

---

### Task 4: データベースの土台と名簿

**Files:**
- Create: `app/db.py`
- Test: `tests/test_db_members.py`

**Interfaces:**
- Produces:
  - `connect(path: str | Path) -> sqlite3.Connection` — WAL、外部キー有効、`busy_timeout` 5000、`row_factory = sqlite3.Row`
  - `init_schema(conn)` — 仕様書のスキーマをそのまま作る。何度呼んでも同じ結果になる
  - `list_members(conn, include_hidden: bool = False) -> list[sqlite3.Row]`
  - `get_member(conn, member_id: int) -> sqlite3.Row | None`
  - `add_member(conn, name: str) -> int` — 同名は `ValueError`
  - `set_member_active(conn, member_id: int, active: bool)`
  - `count_active_members(conn) -> int`

- [ ] **Step 1: テストを書く** — 追加、一覧、同名の拒否、非表示にすると既定の一覧から消えること、`include_hidden=True` で戻ること、`init_schema` を二度呼んでも壊れないこと。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: データベースの接続と名簿の操作を追加`

---

### Task 5: 風呂の予約と先着順

**Files:**
- Modify: `app/db.py`
- Test: `tests/test_db_bath.py`, `tests/test_concurrency.py`

**Interfaces:**
- Produces:
  - `reservations_for_date(conn, day: str) -> dict[tuple[str, str], sqlite3.Row]` — 鍵は `(room, slot)`、値は `id`, `member_id`, `name` を含む行
  - `member_reservation(conn, day: str, section: str, member_id: int) -> sqlite3.Row | None`
  - `reserve(conn, day: str, section: str, room: str, slot: str, member_id: int) -> str` — `"ok"` / `"already_has"` / `"slot_taken"`
  - `cancel_reservation(conn, reservation_id: int, member_id: int) -> bool` — 他人の予約なら `False`

- [ ] **Step 1: テストを書く**

```python
def test_reserve_then_slot_is_taken(conn, alice, bob):
    assert reserve(conn, "2026-08-20", "night", "shower", "19:00", alice) == "ok"
    assert reserve(conn, "2026-08-20", "night", "shower", "19:00", bob) == "slot_taken"

def test_second_slot_same_section_rejected(conn, alice):
    reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    assert reserve(conn, "2026-08-20", "night", "tub", "20:00", alice) == "already_has"

def test_morning_and_night_both_allowed(conn, alice):
    reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    assert reserve(conn, "2026-08-20", "morning", "shower", "06:00", alice) == "ok"

def test_cancel_only_own(conn, alice, bob):
    reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    rid = reservations_for_date(conn, "2026-08-20")[("shower", "19:00")]["id"]
    assert cancel_reservation(conn, rid, bob) is False
    assert cancel_reservation(conn, rid, alice) is True
```

同時実行のテストは 10 スレッドから同じ枠へ同時に `reserve` を呼び、`"ok"` がちょうど 1 件であることを確かめる。スレッドごとに別の接続を開き、`threading.Barrier` で足並みを揃える。

- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する** — `INSERT` を試み、`sqlite3.IntegrityError` を捕まえたら `rollback` してから理由を調べる。先に `member_reservation` を見て、あれば `"already_has"`、なければ `"slot_taken"` を返す。
- [ ] **Step 4: 通ることを確認する** — 同時実行のテストは 3 回繰り返して安定を見る。
- [ ] **Step 5: commit** — `feat: 風呂の予約と先着順の保証を追加`

---

### Task 6: 白米の投票

**Files:**
- Modify: `app/db.py`
- Test: `tests/test_db_rice.py`

**Interfaces:**
- Produces:
  - `rice_count(conn, day: str, kind: str) -> int`
  - `has_voted(conn, day: str, kind: str, member_id: int) -> bool`
  - `vote(conn, day: str, kind: str, member_id: int) -> bool` — 二重投票は `False`
  - `unvote(conn, day: str, kind: str, member_id: int) -> bool`
  - `sent_notifications(conn) -> set[tuple[str, str]]`
  - `mark_notified(conn, day: str, kind: str, at: str)`

- [ ] **Step 1: テストを書く** — 投票で数が増えること、二重投票で増えないこと、取り消しで減ること、投票していない状態での取り消しが `False` を返すこと、朝と晩が別に数えられること、`mark_notified` が二度目に例外を出さないこと。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: 白米の投票と通知記録の操作を追加`

---

### Task 7: Discord への通知

**Files:**
- Create: `app/notify.py`
- Test: `tests/test_notify.py`

**Interfaces:**
- Consumes: `meals.pending_notifications`, `db.rice_count`, `db.count_active_members`, `db.sent_notifications`, `db.mark_notified`, `config.Settings`
- Produces:
  - `build_content(m: Meal, wanted: int, registered: int, manager_id: str) -> str`
  - `post_message(settings, content: str) -> None` — `urllib.request` で `https://discord.com/api/v10/channels/{channel_id}/messages` へ POST。ヘッダは `Authorization: Bot <token>`。本文は `{"content": ..., "allowed_mentions": {"parse": ["users"]}}`
  - `send_pending(conn, now, settings, poster=post_message) -> list[Meal]` — 設定が空なら何もせず空を返す
  - `start_worker(app, interval: int = 60)` — daemon スレッドで `send_pending` を回す

- [ ] **Step 1: テストを書く**

```python
def test_content_without_manager():
    c = build_content(Meal(date(2026, 8, 19), "breakfast"), 5, 8, "")
    assert c.startswith("白米 8/19(水) 朝")
    assert "いる 5人 / 登録 8人" in c

def test_content_with_manager():
    c = build_content(Meal(date(2026, 8, 19), "dinner"), 5, 8, "42")
    assert c.startswith("<@42> 白米 8/19(水) 晩")

def test_send_pending_skips_when_unconfigured(conn):
    settings = Settings(bot_token="", channel_id="", manager_id="", host="", port=0)
    calls = []
    sent = send_pending(conn, NOW, settings, poster=lambda s, c: calls.append(c))
    assert sent == [] and calls == [] and sent_notifications(conn) == set()

def test_send_pending_records_and_does_not_repeat(conn):
    settings = Settings(bot_token="t", channel_id="1", manager_id="", host="", port=0)
    calls = []
    first = send_pending(conn, NOW, settings, poster=lambda s, c: calls.append(c))
    second = send_pending(conn, NOW, settings, poster=lambda s, c: calls.append(c))
    assert first and second == []
    assert len(calls) == len(first)

def test_send_pending_keeps_record_on_failure(conn):
    settings = Settings(bot_token="t", channel_id="1", manager_id="", host="", port=0)
    def boom(s, c):
        raise RuntimeError("network down")
    assert send_pending(conn, NOW, settings, poster=boom) == []
    assert sent_notifications(conn) == set()
```

- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する** — 投稿が失敗した食事は記録せず、次の周回で再び試す。1 件の失敗で残りを止めない。曜日は `("月","火","水","木","金","土","日")` から引く。
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: 締切後の集計を Discord へ投稿する処理を追加`

---

### Task 8: 画面の土台と名前の選択

**Files:**
- Create: `app/web.py`, `app/templates/base.html`, `app/templates/select.html`, `app/static/style.css`
- Test: `tests/test_web_select.py`

**Interfaces:**
- Produces: `create_app(config_path=None, db_path=None) -> Flask`、`current_member()`、Cookie 名 `member_id`（有効期限 30 日）
- 経路: `GET /` は `/bath` へ転送。`GET /select` と `POST /select`。

- [ ] **Step 1: テストを書く** — 名前未選択で `/bath` を開くと `/select` へ転送されること、`POST /select` で Cookie が付くこと、名簿が空のとき `/select` が名簿の画面へ導く文言を含むこと。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する** — `base.html` に「風呂」「ごはん」のタブ、右上に現在の名前と変更のリンク、フラッシュメッセージの表示欄を置く。`style.css` は白背景で、枠のボタンは高さ 44px 以上にする。
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: 画面の土台と名前の選択を追加`

---

### Task 9: 風呂タブ

**Files:**
- Modify: `app/web.py`
- Create: `app/templates/bath.html`, `app/templates/_bath_table.html`
- Test: `tests/test_web_bath.py`

**Interfaces:**
- 経路: `GET /bath`（`?date=` で切り替え）、`POST /bath/reserve`、`POST /bath/cancel`、`GET /fragment/bath`
- 拒否理由に対応する文言は仕様書のエラー処理の表に従う。

- [ ] **Step 1: テストを書く** — 予約が表に出ること、埋まった枠を押すと「ちょうど埋まりました」が出ること、2 枠目で予約済みの枠の時刻と浴室が文言に含まれること、開始済みの枠を押すと拒否されること、期間外の日付で表が出ないこと、他人の予約に取消ボタンが出ないこと。現在時刻は `clock.now` を差し替えて固定する。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する** — 書き込み後は元の日付へ転送する。`_bath_table.html` は `/fragment/bath` からも同じ引数で描画する。
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: 風呂タブの表と予約操作を追加`

---

### Task 10: ごはんタブ

**Files:**
- Modify: `app/web.py`
- Create: `app/templates/meals.html`, `app/templates/_meal_cards.html`
- Test: `tests/test_web_meals.py`

**Interfaces:**
- 経路: `GET /meals`、`POST /meals/vote`、`POST /meals/unvote`、`GET /fragment/meals`

- [ ] **Step 1: テストを書く** — 受付中のカードにボタンが出ること、押すと「いる ✓」と取消ボタンに変わること、人数が「いる 1人 / 登録 2人」の形で出ること、締切後の投票が拒否され数が変わらないこと、受付前のカードに開始時刻が出てボタンが無いこと。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する** — カードは `meals.visible_meals(now)` の順に描画する。
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: ごはんタブの投票を追加`

---

### Task 11: 名簿の画面と通知の起動

**Files:**
- Modify: `app/web.py`
- Create: `app/templates/members.html`
- Test: `tests/test_web_members.py`

**Interfaces:**
- 経路: `GET /members`、`POST /members`（追加）、`POST /members/hide`、`POST /members/notify-test`
- `create_app` の中で `notify.start_worker` を呼ぶ。テスト時は起動しない引数を設ける。

- [ ] **Step 1: テストを書く** — 追加、同名の拒否、非表示、試験投稿が設定なしのとき「設定がありません」と出ること。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: commit** — `feat: 名簿の画面と試験投稿を追加`

---

### Task 12: 起動口と Pi への配置

**Files:**
- Create: `run.py`, `kominka-reserver.service`, `deploy.sh`, `README.md`
- Modify: `docs/` に配置手順

**Interfaces:**
- `run.py` は `create_app()` を作り `settings.host` と `settings.port` で待ち受ける。
- `deploy.sh` は環境変数 `PI_HOST`（既定 `raspi`）、`PI_USER`（既定 `pi`）、`PI_PASS`（既定 `xxxx`）を読み、`sshpass` 経由で配置する。

- [ ] **Step 1: `run.py` と systemd の設定を書く**
- [ ] **Step 2: `deploy.sh` を書く** — 接続確認、`rsync` か `tar` での転送、`python3-venv` の導入、仮想環境の作成、依存の導入、`config.toml` が無い場合だけ雛形を置く、サービスの設置と起動、最後に `curl` で応答を確かめる。`data/` と `config.toml` は上書きしない。
- [ ] **Step 3: `bash -n deploy.sh` で構文を確かめる**
- [ ] **Step 4: `README.md` を書く** — 手元での起動、Pi への配置、Discord の設定、名簿の登録、期間の変え方。
- [ ] **Step 5: 全テストを通す** — `pytest -q`
- [ ] **Step 6: commit** — `feat: 起動口と Raspberry Pi への配置手順を追加`

---

## Self-Review

**仕様書の網羅**

| 仕様書の項 | 対応する Task |
| --- | --- |
| 対象期間 | 1, 2, 3 |
| 利用者と識別 | 4, 8 |
| 風呂の枠と規則 | 2, 5, 9 |
| 先着順の保証 | 5 |
| 白米の投票と受付の窓 | 3, 6, 10 |
| 担当者への通知 | 7, 11 |
| データモデル | 4, 5, 6 |
| 画面と経路 | 8, 9, 10, 11 |
| 見た目 | 8 |
| エラー処理 | 9, 10, 11 |
| 実行環境 | 12 |
| テスト | 各 Task |

**型の一貫性** — `day` と `date` の混在を避けるため、データベースに渡す日付は文字列で `day`、純粋関数が扱う日付は `date` 型で `d` または `Meal.day` とする。`Meal` の食事種別は `kind` で統一し、データベースの列名 `meal` との対応は `db.py` の呼び出し側で行う。
