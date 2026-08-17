"""締切後の集計を Discord へ投稿する。

常時接続は張らず、bot トークンで REST API を呼ぶときだけ通信する。
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

from . import config, db, meals
from .meals import Meal

log = logging.getLogger(__name__)

API_URL = "https://discord.com/api/v10/channels/{channel_id}/messages"


def build_content(meal: Meal, wanted: int, registered: int, manager_id: str) -> str:
    head = f"白米 {meals.format_meal(meal)}"
    if manager_id:
        head = f"<@{manager_id}> {head}"
    return f"{head}\nいる {wanted}人 / 登録 {registered}人"


def post_message(settings: config.Settings, content: str) -> None:
    payload = json.dumps(
        {"content": content, "allowed_mentions": {"parse": ["users"]}}
    ).encode("utf-8")
    request = urllib.request.Request(
        API_URL.format(channel_id=settings.channel_id),
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bot {settings.bot_token}",
            "Content-Type": "application/json",
            "User-Agent": "furo-gohan (https://localhost, 1.0)",
        },
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status >= 300:
            raise RuntimeError(f"Discord から {response.status} が返りました")


def send_pending(conn, now: datetime, settings: config.Settings, poster=post_message) -> list[Meal]:
    """締切済で未送信の食事を投稿する。投稿できたものだけ記録する。"""
    if not settings.discord_ready:
        return []
    registered = db.count_active_members(conn)
    sent: list[Meal] = []
    for meal in meals.pending_notifications(now, db.sent_notifications(conn)):
        day = meal.day.isoformat()
        wanted = db.rice_count(conn, day, meal.kind)
        try:
            poster(settings, build_content(meal, wanted, registered, settings.manager_id))
        except Exception:
            log.exception("Discord への投稿に失敗した: %s", meals.format_meal(meal))
            continue
        db.mark_notified(conn, day, meal.kind, now.isoformat(timespec="seconds"))
        sent.append(meal)
    return sent


def start_worker(db_path, settings: config.Settings, interval: int = 60) -> threading.Thread:
    def loop():
        while True:
            try:
                conn = db.connect(db_path)
                try:
                    send_pending(conn, datetime.now(config.TZ), settings)
                finally:
                    conn.close()
            except Exception:
                log.exception("通知の周回で例外が出た")
            time.sleep(interval)

    thread = threading.Thread(target=loop, name="notify-worker", daemon=True)
    thread.start()
    return thread
