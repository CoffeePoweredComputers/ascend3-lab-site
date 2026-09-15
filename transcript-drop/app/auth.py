"""Firebase ID token verification -- the only place a caller's identity is decided.

Before this module the student typed their own email address, and the roster
check on (email, team) was what made a typo or an impersonation attempt visible.
That was a check, not authentication: a teammate knows both values. Now the
address arrives as a Google-signed assertion that the browser cannot forge, and
the server decides who the caller is rather than believing them.

The verification is done here rather than with firebase-admin on purpose. The
admin SDK authenticates as the *project* and so needs a service-account key on
the VM -- a real secret, with a rotation story, to protect something that needs
no privilege at all. Checking the signature on an ID token needs only Google's
public keys, so there is nothing on this host worth stealing.
"""

from __future__ import annotations

import os
from functools import lru_cache

import jwt
from jwt import PyJWKClient

# Imported for what it does at import time: app.config reads the repo's .env
# into the environment, and firebase_config() below reads the environment. That
# already happened by accident, through identity -> db -> config, and an import
# chain is not something this module should depend on quietly.
from app import config  # noqa: F401
from app.identity import REQUIRED_DOMAIN

# Google signs Firebase ID tokens with a key that rotates roughly daily and
# publishes the public half here.
JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
ISSUER_PREFIX = "https://securetoken.google.com/"


class AuthUnavailable(RuntimeError):
    """Sign-in is not configured, or Google's keys could not be fetched.

    Distinct from a rejected token: this is our fault, not the caller's, and the
    student can do nothing about it.
    """


class InvalidToken(ValueError):
    """The token is missing, malformed, expired, or not for this project."""


def firebase_config() -> dict:
    """The public web config, from the environment. Empty when not set up.

    Every value here is public by design -- a Firebase web apiKey identifies a
    project, it does not authorise anything -- so these are ordinary settings
    and not secrets. They live in the environment anyway so that one deployment
    can point at a different project from another without a code change.
    """
    keys = {
        "apiKey": "GENAI_FIREBASE_API_KEY",
        "authDomain": "GENAI_FIREBASE_AUTH_DOMAIN",
        "projectId": "GENAI_FIREBASE_PROJECT_ID",
        "appId": "GENAI_FIREBASE_APP_ID",
    }
    found = {name: os.environ.get(var, "").strip() for name, var in keys.items()}
    # A partial config is worse than none: the sign-in button would render and
    # then fail inside Google's SDK with a message no student can act on.
    if not all(found.values()):
        return {}
    return found


def is_configured() -> bool:
    return bool(firebase_config())


@lru_cache(maxsize=1)
def _jwk_client() -> PyJWKClient:
    # Caches keys in-process and refetches when it sees an unknown kid, so a
    # rotation costs one extra request rather than a spell of failed sign-ins.
    return PyJWKClient(JWKS_URL, cache_keys=True)


def verify_id_token(token: str) -> str:
    """Return the verified email address, or raise.

    Checks the signature and every registered claim, then two of our own:
    the address must be verified by the provider, and it must be a VT one.
    """
    config = firebase_config()
    if not config:
        raise AuthUnavailable("Sign-in is not configured on this server.")
    project_id = config["projectId"]

    if not token:
        raise InvalidToken("Sign in with your VT Google account to continue.")

    try:
        signing_key = _jwk_client().get_signing_key_from_jwt(token)
    except jwt.exceptions.PyJWKClientError as exc:
        # Could be an unknown kid (a forged or very stale token) or a failure to
        # reach Google. Telling them apart matters: one is the caller's problem
        # and one is ours.
        if "Unable to find" in str(exc):
            raise InvalidToken("That sign-in could not be verified.") from exc
        raise AuthUnavailable("Could not reach Google to verify your sign-in.") from exc
    except jwt.exceptions.DecodeError as exc:
        raise InvalidToken("That sign-in could not be verified.") from exc

    try:
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],  # never from the token's own header
            audience=project_id,
            issuer=ISSUER_PREFIX + project_id,
            options={"require": ["exp", "iat", "aud", "iss", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise InvalidToken("Your sign-in has expired. Sign in again.") from exc
    except jwt.InvalidTokenError as exc:
        raise InvalidToken("That sign-in could not be verified.") from exc

    if not claims.get("sub"):
        raise InvalidToken("That sign-in could not be verified.")

    email = (claims.get("email") or "").strip().lower()
    if not email:
        raise InvalidToken("That account has no email address attached.")

    # A Google Workspace sign-in always carries email_verified. Refusing when it
    # is absent costs a real student nothing and closes the one route by which an
    # unverified address could be asserted.
    if not claims.get("email_verified"):
        raise InvalidToken("That email address is not verified by Google.")

    domain = email.rsplit("@", 1)[-1]
    if domain != REQUIRED_DOMAIN and not domain.endswith("." + REQUIRED_DOMAIN):
        raise InvalidToken(
            f"Sign in with your VT Google account, ending in @{REQUIRED_DOMAIN}."
        )
    return email
