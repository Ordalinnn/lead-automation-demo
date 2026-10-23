"""Уведомление менеджеру в Telegram. В демо-режиме сообщение пишется в лог."""

import html
import json
import logging
import urllib.request

from .config import Settings
from .models import Lead

log = logging.getLogger(__name__)

PRIORITY_ICON = {"высокий": "🔴", "средний": "🟡", "низкий": "⚪"}


def format_message(lead: Lead) -> str:
    d, a = lead.data, lead.analysis
    e = html.escape
    lines = [
        f"{PRIORITY_ICON[a.priority]} <b>Новая заявка</b> · {e(a.category)} · приоритет {e(a.priority)}",
        "",
        f"<b>Имя:</b> {e(d.name)}",
    ]
    if d.phone:
        lines.append(f"<b>Телефон:</b> {e(d.phone)}")
    if d.email:
        lines.append(f"<b>Email:</b> {e(d.email)}")
    lines += [
        f"<b>Источник:</b> {e(d.source)}",
        "",
        f"<b>Суть:</b> {e(a.summary)}",
        "",
        f"<b>Черновик ответа:</b>\n<i>{e(a.suggested_reply)}</i>",
    ]
    return "\n".join(lines)


def notify(lead: Lead, settings: Settings) -> str:
    text = format_message(lead)
    if not settings.use_telegram:
        log.info("[демо] Сообщение в Telegram:\n%s", text)
        return "log"
    try:
        _send_telegram(text, settings)
        return "telegram"
    except Exception:
        log.exception("Не удалось отправить уведомление в Telegram")
        return "failed"


def _send_telegram(text: str, settings: Settings) -> None:
    url = f"https://api.telegram.org/bot{settings.telegram_token}/sendMessage"
    body = json.dumps({"chat_id": settings.telegram_chat_id, "text": text, "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        if not json.load(resp).get("ok"):
            raise RuntimeError("Telegram вернул ok=false")
