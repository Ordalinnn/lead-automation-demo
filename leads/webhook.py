"""Приведение заявок из конструкторов сайтов (Tilda, WordPress, Webflow и др.) к одному виду."""

from .models import LeadIn

# Возможные названия полей в разных конструкторах, в нижнем регистре
NAME_KEYS = ("name", "имя", "fio", "фио", "your-name", "first_name", "firstname", "full_name", "client_name")
PHONE_KEYS = ("phone", "телефон", "tel", "your-phone", "your-tel", "phone_number", "mobile", "whatsapp")
EMAIL_KEYS = ("email", "e-mail", "почта", "your-email", "mail")
MESSAGE_KEYS = ("message", "сообщение", "comments", "comment", "комментарий", "textarea", "text",
                "your-message", "question", "вопрос")
SOURCE_KEYS = ("formname", "form_name", "form", "source", "utm_source")
# Служебные поля, которые не нужно добавлять в текст заявки
SKIP_KEYS = {"tranid", "formid", "cookies", "referer", "website", "key", "test", "_wpcf7", "_wpcf7_version",
             "_wpcf7_locale", "_wpcf7_unit_tag", "_wpcf7_container_post", "g-recaptcha-response"}


def is_test_ping(fields: dict[str, str]) -> bool:
    """Tilda при подключении вебхука присылает запрос test=test."""
    return {k.lower() for k in fields} == {"test"}


def _pick(fields: dict[str, str], keys: tuple[str, ...]) -> tuple[str, str]:
    lowered = {k.lower().strip(): k for k in fields}
    for key in keys:
        if key in lowered and str(fields[lowered[key]]).strip():
            return lowered[key], str(fields[lowered[key]]).strip()
    return "", ""


def normalize(fields: dict[str, str], default_source: str = "сайт") -> LeadIn:
    """Собирает LeadIn из полей любой формы. Нераспознанные поля дописываются в текст заявки."""
    used = set()
    name_key, name = _pick(fields, NAME_KEYS)
    phone_key, phone = _pick(fields, PHONE_KEYS)
    email_key, email = _pick(fields, EMAIL_KEYS)
    msg_key, message = _pick(fields, MESSAGE_KEYS)
    source_key, source = _pick(fields, SOURCE_KEYS)
    used.update(k for k in (name_key, phone_key, email_key, msg_key, source_key) if k)

    extra = [f"{k}: {v}" for k, v in fields.items()
             if k not in used and k.lower() not in SKIP_KEYS and str(v).strip()]
    if extra:
        message = "\n".join([message, *extra]) if message else "\n".join(extra)

    return LeadIn(
        name=(name or "Без имени")[:100],
        phone=phone[:30],
        email=email[:100],
        message=message[:2000],
        source=(source or default_source)[:50],
        website=str(fields.get("website", ""))[:200],
    )
