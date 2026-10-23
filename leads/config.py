"""Настройки из переменных окружения. Без ключей проект работает в демо-режиме."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    claude_model: str
    use_claude: bool
    sheet_id: str | None
    google_credentials: str | None
    telegram_token: str | None
    telegram_chat_id: str | None
    csv_path: Path

    @property
    def use_sheets(self) -> bool:
        return bool(self.sheet_id and self.google_credentials)

    @property
    def use_telegram(self) -> bool:
        return bool(self.telegram_token and self.telegram_chat_id)


def load_settings() -> Settings:
    return Settings(
        claude_model=os.getenv("CLAUDE_MODEL", "claude-haiku-5-5"),
        use_claude=bool(os.getenv("ANTHROPIC_API_KEY")),
        sheet_id=os.getenv("GOOGLE_SHEET_ID"),
        google_credentials=os.getenv("GOOGLE_CREDENTIALS_FILE"),
        telegram_token=os.getenv("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID"),
        csv_path=Path(os.getenv("LEADS_CSV", "data/leads.csv")),
    )
