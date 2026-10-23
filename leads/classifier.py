"""Разбор заявки: Claude, если есть ключ, иначе простые правила по ключевым словам."""

import logging

import anthropic

from .models import Analysis, LeadIn

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """Ты помогаешь отделу продаж малого бизнеса разбирать входящие заявки.
Определи категорию и приоритет заявки, кратко изложи её суть и предложи черновик ответа.

Категории:
- покупка: клиент хочет купить или узнать цену
- консультация: вопрос до покупки, нужна помощь с выбором
- поддержка: проблема с уже купленным товаром или услугой
- спам: реклама, бессмысленный текст, предложения «продвинуть сайт»
- другое: всё остальное

Приоритет высокий, если клиент готов купить сейчас, упоминает сроки или крупный объём,
или если это жалоба. Низкий для спама и общих вопросов.
Черновик ответа пиши вежливо, на языке клиента, 1-3 предложения, без выдуманных цен и сроков."""

BUY_WORDS = ("купить", "заказ", "цена", "стоимость", "сколько стоит", "прайс", "счёт", "счет", "оплат")
SUPPORT_WORDS = ("не работает", "сломал", "проблем", "жалоб", "возврат", "брак", "ошибк")
URGENT_WORDS = ("срочно", "сегодня", "завтра", "оптом", "партия")
SPAM_WORDS = ("seo", "продвижение сайта", "раскрутк", "казино", "http://", "https://")


def classify(lead: LeadIn, *, use_claude: bool, model: str) -> tuple[Analysis, str]:
    """Возвращает разбор и то, кто его сделал (модель или 'правила')."""
    if use_claude:
        try:
            return _classify_with_claude(lead, model), model
        except Exception:
            # Заявка важнее разбора: при любой ошибке API не теряем её
            log.exception("Claude недоступен, используем правила")
    return classify_by_rules(lead), "правила"


def _classify_with_claude(lead: LeadIn, model: str) -> Analysis:
    client = anthropic.Anthropic(timeout=30, max_retries=2)
    response = client.messages.parse(
        model=model,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": (
                f"Имя: {lead.name}\nИсточник: {lead.source}\n"
                f"Сообщение:\n<message>\n{lead.message or '(пусто)'}\n</message>"
            ),
        }],
        output_format=Analysis,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"Нет разбора, stop_reason={response.stop_reason}, request_id={response._request_id}")
    return response.parsed_output


def classify_by_rules(lead: LeadIn) -> Analysis:
    text = lead.message.lower()
    if any(w in text for w in SPAM_WORDS):
        category, priority = "спам", "низкий"
    elif any(w in text for w in SUPPORT_WORDS):
        category, priority = "поддержка", "высокий"
    elif any(w in text for w in BUY_WORDS):
        category = "покупка"
        priority = "высокий" if any(w in text for w in URGENT_WORDS) else "средний"
    elif text.strip():
        category, priority = "консультация", "средний"
    else:
        category, priority = "другое", "низкий"

    summary = lead.message.strip()[:150] or "Заявка без текста, нужно перезвонить"
    reply = f"Здравствуйте, {lead.name}! Спасибо за заявку, менеджер свяжется с вами в ближайшее время."
    return Analysis(category=category, priority=priority, summary=summary, suggested_reply=reply)
