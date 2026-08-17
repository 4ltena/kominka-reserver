"""現在時刻の取得口。テストはここを差し替える。"""

from __future__ import annotations

from datetime import datetime

from . import config


def now() -> datetime:
    return datetime.now(config.TZ)
