"""Сохранение заявок: Google Sheets или локальный CSV (демо-режим и резервная копия)."""

import csv
import logging
from pathlib import Path

from .config import Settings
from .models import ROW_HEADER, Lead

log = logging.getLogger(__name__)


def save(lead: Lead, settings: Settings) -> str:
    """Возвращает, куда сохранили заявку. Если Sheets недоступен, пишет в CSV."""
    if settings.use_sheets:
        try:
            _append_to_sheet(lead, settings)
            return "google_sheets"
        except Exception:
            log.exception("Не удалось записать в Google Sheets, сохраняем в CSV")
    _append_to_csv(lead, settings.csv_path)
    return "csv"


def _append_to_sheet(lead: Lead, settings: Settings) -> None:
    import gspread

    client = gspread.service_account(filename=settings.google_credentials)
    sheet = client.open_by_key(settings.sheet_id).sheet1
    if not sheet.row_values(1):
        sheet.append_row(ROW_HEADER)
    sheet.append_row(lead.as_row(), value_input_option="RAW")


def _append_to_csv(lead: Lead, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    is_new = not path.exists()
    with path.open("a", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(ROW_HEADER)
        writer.writerow(lead.as_row())
