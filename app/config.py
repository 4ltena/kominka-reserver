"""期間・枠・設定ファイルの定義。ここを書き換えれば日程を動かせる。"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Tokyo")

ROOMS = ("shower", "tub")
ROOM_LABELS = {"shower": "風呂", "tub": "風呂（浴槽付き）"}

SECTIONS = ("morning", "night")
SECTION_LABELS = {"morning": "朝", "night": "夜"}

MEALS = ("breakfast", "dinner")
MEAL_LABELS = {"breakfast": "朝", "dinner": "晩"}

# 白米の量。合計の合数を炊く人が見る。
RICE_SIZES = ("normal", "large")
RICE_LABELS = {"normal": "通常", "large": "大盛"}
RICE_GO = {"normal": 0.5, "large": 1.0}

WEEKDAYS = ("月", "火", "水", "木", "金", "土", "日")

# 滞在は 2026-08-17 の晩に始まり 2026-08-28 の朝に終わる。
PERIOD = {
    ("bath", "night"): (date(2026, 8, 17), date(2026, 8, 27)),
    ("bath", "morning"): (date(2026, 8, 18), date(2026, 8, 28)),
    # 8/18 の朝ごはんは投票窓 (8/17 18:00-22:00) が閉じたあとに決まったため対象外。
    ("meal", "breakfast"): (date(2026, 8, 19), date(2026, 8, 28)),
    ("meal", "dinner"): (date(2026, 8, 18), date(2026, 8, 27)),
}

# 枠の長さは浴室ごとに違う。浴槽付きは 20 分、浴槽なしは 15 分。
ROOM_SLOT_MINUTES = {"shower": 15, "tub": 20}
SECTION_HOURS = {"morning": (6, 8), "night": (19, 24)}

# 夜の枠が翌 01:20 まで伸びるため、暦の日付では「今日」を判定できない。
# この時刻より前は前夜の続きとして扱う。朝風呂の開始 06:00 より前に置く。
DAY_CHANGE_HOUR = 5
# 区分によっては最後の入浴開始時刻を明示する。指定が無ければ、枠が区分の
# 終了時刻をはみ出さない範囲で並べる。24 時以降は翌日を指し、25:00 は翌 01:00。
SECTION_LAST_START = {"night": "25:00"}

# 食事の投票の締切。(対象日からの日数のずれ, 締切の時)。受付開始は設けない。
VOTE_DEADLINE = {
    "breakfast": (-1, 22),
    "dinner": (0, 18),
}

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = ROOT / "config.toml"
DEFAULT_DB_PATH = ROOT / "data" / "furo-gohan.db"


@dataclass(frozen=True)
class Settings:
    host: str = "0.0.0.0"
    port: int = 8080


def load_settings(path: str | Path | None = None) -> Settings:
    path = Path(path) if path else DEFAULT_CONFIG_PATH
    if not path.exists():
        return Settings()
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    server = data.get("server", {})
    return Settings(
        host=str(server.get("host", "0.0.0.0")),
        port=int(server.get("port", 8080)),
    )
