import csv

import pytest
from fastapi.testclient import TestClient

import app as app_module
from leads.classifier import classify_by_rules
from leads.config import Settings
from leads.models import LeadIn


@pytest.fixture
def client(tmp_path, monkeypatch):
    settings = Settings(
        claude_model="claude-haiku-5-5", use_claude=False, sheet_id=None, google_credentials=None,
        telegram_token=None, telegram_chat_id=None, csv_path=tmp_path / "leads.csv",
    )
    monkeypatch.setattr(app_module, "settings", settings)
    return TestClient(app_module.app), settings.csv_path


def read_rows(path):
    with path.open(encoding="utf-8-sig") as f:
        return list(csv.reader(f))


def test_lead_saved_and_classified(client):
    http, csv_path = client
    res = http.post("/api/lead", json={
        "name": "Анна", "phone": "+7 900 000-00-00", "message": "Сколько стоит доставка? Нужно срочно",
    })
    assert res.status_code == 200
    body = res.json()
    assert body["category"] == "покупка"
    assert body["priority"] == "высокий"
    assert body["saved_to"] == "csv"
    assert body["notified_via"] == "log"
    rows = read_rows(csv_path)
    assert rows[0][0] == "Дата"
    assert rows[1][1] == "Анна"


def test_contact_required(client):
    http, _ = client
    res = http.post("/api/lead", json={"name": "Без контактов", "message": "Привет"})
    assert res.status_code == 422


def test_honeypot_drops_bot(client):
    http, csv_path = client
    res = http.post("/api/lead", json={"name": "bot", "email": "b@b.b", "website": "spam.example"})
    assert res.json() == {"ok": True}
    assert not csv_path.exists()


def test_spam_not_notified(client):
    http, _ = client
    res = http.post("/api/lead", json={"name": "SEO", "email": "s@s.s", "message": "Продвижение сайта в ТОП"})
    assert res.json()["category"] == "спам"
    assert res.json()["notified_via"] == "skipped"


@pytest.mark.parametrize("message,category", [
    ("Товар не работает, хочу возврат", "поддержка"),
    ("Подскажите, какой тариф выбрать?", "консультация"),
    ("", "другое"),
])
def test_rules(message, category):
    lead = LeadIn(name="Иван", email="i@i.i", message=message)
    assert classify_by_rules(lead).category == category


def test_health(client):
    http, _ = client
    assert http.get("/health").json()["claude"] is False
    assert http.get("/").status_code == 200


@pytest.fixture
def hook(tmp_path, monkeypatch):
    settings = Settings(
        claude_model="claude-haiku-5-5", use_claude=False, sheet_id=None, google_credentials=None,
        telegram_token=None, telegram_chat_id=None, csv_path=tmp_path / "leads.csv", webhook_secret="s3cret",
    )
    monkeypatch.setattr(app_module, "settings", settings)
    return TestClient(app_module.app), settings.csv_path


def test_webhook_requires_key(hook):
    http, _ = hook
    assert http.post("/webhook", data={"Phone": "+77010000000"}).status_code == 403
    assert http.post("/webhook?key=wrong", data={"Phone": "+77010000000"}).status_code == 403


def test_webhook_tilda_test_ping(hook):
    http, csv_path = hook
    res = http.post("/webhook?key=s3cret", data={"test": "test"})
    assert res.status_code == 200 and res.text == "ok"
    assert not csv_path.exists()


def test_webhook_tilda_form(hook):
    http, csv_path = hook
    res = http.post("/webhook?key=s3cret", data={
        "Name": "Айгерим", "Phone": "+7 701 000 00 00", "Textarea": "Сколько стоит чистка зубов? Можно сегодня?",
        "Service": "Чистка", "formname": "Запись", "tranid": "123:456",
    })
    assert res.status_code == 200
    row = read_rows(csv_path)[1]
    assert row[1:5] == ["Айгерим", "+7 701 000 00 00", "", "Запись"]
    assert "Service: Чистка" in row[5] and "tranid" not in row[5]


def test_webhook_wordpress_cf7_json(hook):
    http, csv_path = hook
    res = http.post("/webhook?key=s3cret&source=wordpress", json={
        "your-name": "Ерлан", "your-email": "erlan@example.kz", "your-message": "Нужна консультация",
    })
    assert res.status_code == 200
    row = read_rows(csv_path)[1]
    assert row[1] == "Ерлан" and row[3] == "erlan@example.kz" and row[4] == "wordpress"


def test_webhook_without_contact(hook):
    http, _ = hook
    assert http.post("/webhook?key=s3cret", data={"Name": "Без контактов"}).status_code == 422


def test_webhook_phone_only(hook):
    http, csv_path = hook
    assert http.post("/webhook?key=s3cret", data={"phone": "87010000000"}).status_code == 200
    assert read_rows(csv_path)[1][1] == "Без имени"
