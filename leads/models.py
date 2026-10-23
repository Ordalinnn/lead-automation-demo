from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, model_validator

Category = Literal["покупка", "консультация", "поддержка", "спам", "другое"]
Priority = Literal["высокий", "средний", "низкий"]


class LeadIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    phone: str = Field(default="", max_length=30)
    email: str = Field(default="", max_length=100)
    message: str = Field(default="", max_length=2000)
    source: str = Field(default="сайт", max_length=50)
    # Скрытое поле-ловушка: люди его не видят, боты заполняют
    website: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def need_contact(self):
        if not self.phone.strip() and not self.email.strip():
            raise ValueError("Укажите телефон или email")
        return self


class Analysis(BaseModel):
    category: Category
    priority: Priority
    summary: str = Field(description="Суть заявки одним предложением")
    suggested_reply: str = Field(description="Короткий черновик ответа клиенту")


class Lead(BaseModel):
    received_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    data: LeadIn
    analysis: Analysis
    analyzed_by: str

    def as_row(self) -> list[str]:
        return [
            self.received_at.strftime("%Y-%m-%d %H:%M:%S UTC"),
            self.data.name,
            self.data.phone,
            self.data.email,
            self.data.source,
            self.data.message,
            self.analysis.category,
            self.analysis.priority,
            self.analysis.summary,
            self.analysis.suggested_reply,
            self.analyzed_by,
        ]


ROW_HEADER = [
    "Дата", "Имя", "Телефон", "Email", "Источник", "Сообщение",
    "Категория", "Приоритет", "Суть", "Черновик ответа", "Разобрано",
]
