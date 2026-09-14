"""Request models for the submission API.

Pydantic evaluates these annotations at runtime, so they use typing constructs
rather than PEP 604 unions -- the course machines still run Python 3.9.
"""

from __future__ import annotations

from typing import List, Optional, Union

from pydantic import BaseModel, Field


class TurnIn(BaseModel):
    role: str = "unknown"
    content: Union[str, List, None] = None
    timestamp: Union[str, int, float, None] = None
    model: Optional[str] = None


class WorkspaceIn(BaseModel):
    """Where an IDE/agentic session ran. Absent for chat-tool exports."""

    cwd: Optional[str] = Field(default=None, max_length=500)
    repo_url: Optional[str] = Field(default=None, max_length=500)
    branch: Optional[str] = Field(default=None, max_length=200)
    commit_hash: Optional[str] = Field(default=None, max_length=64)
    tool_origin: Optional[str] = Field(default=None, max_length=100)


class AIEditIn(BaseModel):
    path: str = Field(max_length=1000)
    change_type: Optional[str] = Field(default=None, max_length=20)
    patch: Optional[str] = None
    ts: Union[str, int, float, None] = None


class ConversationIn(BaseModel):
    platform: str
    platform_other: Optional[str] = Field(default=None, max_length=100)
    title: Optional[str] = Field(default=None, max_length=300)
    source_format: str = "paste"
    parse_quality: Optional[str] = None
    # Both were once required. Purpose is now optional, and the "did this change
    # your project?" question was dropped, so neither can be relied on.
    primary_purpose: Optional[str] = None
    reported_change: Optional[str] = None
    conversation_start: Union[str, int, float, None] = None
    conversation_end: Union[str, int, float, None] = None
    turns: List[TurnIn] = Field(default_factory=list)
    raw_text: Optional[str] = None
    # Provenance extracted by the parsers; never typed by the student.
    workspace: Optional[WorkspaceIn] = None
    ai_edits: List[AIEditIn] = Field(default_factory=list)
    models: List[str] = Field(default_factory=list)
    tool_version: Optional[str] = Field(default=None, max_length=100)
    source_session_id: Optional[str] = Field(default=None, max_length=200)
    source_url: Optional[str] = Field(default=None, max_length=500)
    metadata: Optional[dict] = None


class SubmissionIn(BaseModel):
    # No email field: the caller's identity comes from their verified Firebase
    # ID token (app/auth.py), never from the body. A client that sends one is
    # ignored rather than refused, so an old cached page keeps working.
    project_id: str
    team_id: Optional[str] = Field(default=None, max_length=40)
    completeness: str
    conversations: List[ConversationIn] = Field(min_length=1)


class ConsentIn(BaseModel):
    decision: str
    # Eligibility, confirmed in the portal before consent as the protocol
    # requires. False is a valid answer and is recorded; it just cannot carry a
    # consent with it.
    is_adult: bool = False
    # Which wording the student was looking at. Checked against the current file
    # so an answer is never filed against text nobody saw.
    form_version: str = Field(max_length=64)


class RepositoryIn(BaseModel):
    project_id: str
    # Optional since the roster already knows which team the signed-in student
    # is on. Still honoured when sent, so the check has something to disagree
    # with if a client ever gets it wrong.
    team_id: Optional[str] = Field(default=None, max_length=40)
    repo_url: str = Field(max_length=500)


class SessionStartIn(BaseModel):
    project_id: str
    team_id: Optional[str] = Field(default=None, max_length=40)


class ShareLinkIn(BaseModel):
    url: str


class PreviewIn(BaseModel):
    text: str
    platform: Optional[str] = None
    title: Optional[str] = None
