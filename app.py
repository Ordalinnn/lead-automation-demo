"""Приём заявок с сайта: разбор через Claude, запись в Google Sheets, уведомление в Telegram."""

import hmac
import logging
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import ValidationError

from leads import classifier, notifier, storage, webhook
from leads.config import load_settings
from leads.models import Lead, LeadIn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

app = FastAPI(title="Lead automation demo")
settings = load_settings()
FORM = Path(__file__).parent / "static" / "index.html"


def process(data: LeadIn) -> dict:
    """Разбирает заявку, сохраняет её и уведомляет менеджера."""
    analysis, analyzed_by = classifier.classify(
        data, use_claude=settings.use_claude, model=settings.claude_model
    )
    lead = Lead(data=data, analysis=analysis, analyzed_by=analyzed_by)
    saved_to = storage.save(lead, settings)
    notified_via = notifier.notify(lead, settings) if analysis.category != "спам" else "skipped"

    log.info("Заявка от %s: %s/%s, сохранена в %s, уведомление: %s",
             data.name, analysis.category, analysis.priority, saved_to, notified_via)
    return {
        "ok": True,
        "category": analysis.category,
        "priority": analysis.priority,
        "saved_to": saved_to,
        "notified_via": notified_via,
    }


@app.get("/")
def form():
    return FileResponse(FORM)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "claude": settings.use_claude,
        "google_sheets": settings.use_sheets,
        "telegram": settings.use_telegram,
        "webhook_protected": bool(settings.webhook_secret),
    }


@app.post("/api/lead")
def receive_lead(data: LeadIn):
    if data.website:
        # Бот заполнил поле-ловушку: отвечаем как обычно, но ничего не сохраняем
        log.info("Отброшена заявка от бота")
        return {"ok": True}
    return process(data)


@app.post("/webhook")
async def receive_webhook(request: Request, background: BackgroundTasks, key: str = ""):
    """Вебхук для Tilda, WordPress (Contact Form 7, Elementor), Webflow и любых форм.

    Принимает JSON или обычную отправку формы с любыми названиями полей.
    Отвечает сразу, а разбор идёт в фоне: конструкторы ждут ответ всего несколько секунд.
    """
    if settings.webhook_secret and not hmac.compare_digest(key, settings.webhook_secret):
        raise HTTPException(status_code=403, detail="Неверный ключ вебхука")

    if "application/json" in request.headers.get("content-type", ""):
        body = await request.json()
        fields = {str(k): str(v) for k, v in body.items()} if isinstance(body, dict) else {}
    else:
        fields = {str(k): str(v) for k, v in (await request.form()).items()}

    if webhook.is_test_ping(fields):
        return PlainTextResponse("ok")

    try:
        data = webhook.normalize(fields, default_source=request.query_params.get("source", "сайт"))
    except ValidationError:
        log.warning("Заявка без телефона и email, поля: %s", ", ".join(fields))
        raise HTTPException(status_code=422, detail="В заявке нет телефона или email")

    if data.website:
        log.info("Отброшена заявка от бота")
        return PlainTextResponse("ok")

    background.add_task(process, data)
    return PlainTextResponse("ok")
