"""Timestamp handling shared by the extractor and the matcher.

Conversation timestamps arrive in a mix of shapes: ChatGPT exports carry UTC
epochs, Claude exports carry ISO strings with an offset, and pasted transcripts
carry nothing at all. Git gives offsets. Everything is compared in UTC, and a
naive timestamp is read as course-local time rather than silently as UTC --
mis-reading a 3pm lab session as 3pm UTC would shift it out of the matching
window entirely.
"""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.config import course_config


def course_timezone() -> ZoneInfo:
    return ZoneInfo(course_config().get("timezone", "UTC"))


def to_utc(value: str | datetime | None) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=course_timezone())
    return parsed.astimezone(timezone.utc)


def deadline_to_utc(value: str) -> datetime | None:
    """Stage deadlines in projects.yaml are written in course-local time."""
    return to_utc(value)


def iso(value: datetime | None) -> str | None:
    return value.isoformat(timespec="seconds") if value else None
