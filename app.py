"""Приём заявок с сайта: разбор через Claude, запись в Google Sheets, уведомление в Telegram."""

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from leads import classifier, notifier, storage
from leads.config import load_settings
from leads.models import Lead, LeadIn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

app = FastAPI(title="Lead automation demo")
settings = load_settings()
FORM = Path(__file__).parent / "static" / "index.html"


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
    }


@app.post("/api/lead")
def receive_lead(data: LeadIn):
    if data.website:
        # Бот заполнил поле-ловушку: отвечаем как обычно, но ничего не сохраняем
        log.info("Отброшена заявка от бота")
        return {"ok": True}

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
