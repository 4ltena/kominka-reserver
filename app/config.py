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

WEEKDAYS = ("月", "火", "水", "木", "金", "土", "日")

# 滞在は 2026-08-17 の晩に始まり 2026-08-28 の朝に終わる。
PERIOD = {
    ("bath", "night"): (date(2026, 8, 17), date(2026, 8, 27)),
    ("bath", "morning"): (date(2026, 8, 18), date(2026, 8, 28)),
    ("meal", "breakfast"): (date(2026, 8, 18), date(2026, 8, 28)),
    ("meal", "dinner"): (date(2026, 8, 18), date(2026, 8, 27)),
}

# 枠の長さは浴室ごとに違う。浴槽付きは 20 分、浴槽なしは 15 分。
ROOM_SLOT_MINUTES = {"shower": 15, "tub": 20}
SECTION_HOURS = {"morning": (6, 8), "night": (19, 24)}

# 食事の投票窓。(対象日からの日数のずれ, 受付開始の時, 締切の時)
VOTE_WINDOW = {
    "breakfast": (-1, 18, 22),
    "dinner": (0, 9, 18),
}

NOTIFY_MAX_DELAY_SECONDS = 24 * 60 * 60

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = ROOT / "config.toml"
DEFAULT_DB_PATH = ROOT / "data" / "furo-gohan.db"


@dataclass(frozen=True)
class Settings:
    bot_token: str = ""
    channel_id: str = ""
    manager_id: str = ""
    host: str = "0.0.0.0"
    port: int = 8080

    @property
    def discord_ready(self) -> bool:
        return bool(self.bot_token and self.channel_id)


def load_settings(path: str | Path | None = None) -> Settings:
    path = Path(path) if path else DEFAULT_CONFIG_PATH
    if not path.exists():
        return Settings()
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    discord = data.get("discord", {})
    server = data.get("server", {})
    return Settings(
        bot_token=str(discord.get("bot_token", "")),
        channel_id=str(discord.get("channel_id", "")),
        manager_id=str(discord.get("manager_id", "")),
        host=str(server.get("host", "0.0.0.0")),
        port=int(server.get("port", 8080)),
    )
