"""Verification of Firebase ID tokens, against real RSA signatures.

The rest of the suite stubs this module out, so if it is wrong nothing else will
notice -- and being wrong here means accepting a token somebody else minted.
Every test below signs a token with a throwaway key and asks what the verifier
makes of it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app import auth

PROJECT = "genai-study-test"
KID = "test-key-1"


@pytest.fixture(scope="module")
def keypair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key, key.public_key()


@pytest.fixture(autouse=True)
def configured(monkeypatch, keypair):
    """Point the verifier at our project id and our key instead of Google's."""
    monkeypatch.setenv("GENAI_FIREBASE_API_KEY", "not-a-secret")
    monkeypatch.setenv("GENAI_FIREBASE_AUTH_DOMAIN", f"{PROJECT}.firebaseapp.com")
    monkeypatch.setenv("GENAI_FIREBASE_PROJECT_ID", PROJECT)
    monkeypatch.setenv("GENAI_FIREBASE_APP_ID", "1:2:web:3")

    _, public = keypair

    class _Key:
        key = public

    class _Client:
        def get_signing_key_from_jwt(self, token):
            return _Key()

    monkeypatch.setattr(auth, "_jwk_client", lambda: _Client())


def make_token(keypair, **overrides) -> str:
    private, _ = keypair
    now = int(time.time())
    claims = {
        "iss": auth.ISSUER_PREFIX + PROJECT,
        "aud": PROJECT,
        "sub": "uid-abc",
        "iat": now - 60,
        "exp": now + 3600,
        "auth_time": now - 60,
        "email": "hokie@vt.edu",
        "email_verified": True,
    }
    claims.update(overrides)
    for key in [k for k, v in claims.items() if v is None]:
        del claims[key]
    return jwt.encode(claims, private, algorithm="RS256", headers={"kid": KID})


def test_a_well_formed_token_yields_the_address(keypair):
    assert auth.verify_id_token(make_token(keypair)) == "hokie@vt.edu"


def test_the_address_is_lower_cased(keypair):
    assert auth.verify_id_token(make_token(keypair, email="Hokie@VT.edu")) == "hokie@vt.edu"


def test_a_vt_subdomain_is_still_vt(keypair):
    token = make_token(keypair, email="grad@cs.vt.edu")
    assert auth.verify_id_token(token) == "grad@cs.vt.edu"


@pytest.mark.parametrize(
    "overrides,why",
    [
        ({"exp": int(time.time()) - 10}, "expired"),
        ({"aud": "some-other-project"}, "minted for a different Firebase project"),
        ({"iss": "https://securetoken.google.com/other"}, "issued by someone else"),
        ({"iss": "https://evil.example/" + PROJECT}, "issuer host is not Google"),
        ({"email_verified": False}, "address not verified by the provider"),
        ({"email_verified": None}, "no email_verified claim at all"),
        ({"email": "attacker@gmail.com"}, "not a VT address"),
        ({"email": "attacker@notvt.edu"}, "a lookalike domain"),
        ({"email": None}, "no address"),
        ({"sub": ""}, "no subject"),
        ({"exp": None}, "no expiry"),
    ],
)
def test_tokens_that_must_be_refused(keypair, overrides, why):
    with pytest.raises(auth.InvalidToken):
        auth.verify_id_token(make_token(keypair, **overrides))


def test_an_hmac_token_signed_with_the_public_key_is_refused(keypair):
    """The classic algorithm-confusion forgery.

    Google's verifying key is public. If the verifier took the algorithm from
    the token's own header, anyone could sign their own claims with HS256 using
    that public key as the shared secret and be believed. Pinning RS256 in the
    decode call is what stops it, and this is the test that fails if the pin is
    ever removed.

    Assembled by hand because PyJWT refuses to *sign* with a PEM key as an HMAC
    secret -- a real attacker is under no such restriction.
    """
    _, public = keypair
    pem = public.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    def segment(payload: dict) -> bytes:
        raw = json.dumps(payload, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    now = int(time.time())
    signing_input = b".".join(
        (
            segment({"alg": "HS256", "typ": "JWT", "kid": KID}),
            segment(
                {
                    "iss": auth.ISSUER_PREFIX + PROJECT,
                    "aud": PROJECT,
                    "sub": "uid-attacker",
                    "iat": now - 60,
                    "exp": now + 3600,
                    "email": "victim@vt.edu",
                    "email_verified": True,
                }
            ),
        )
    )
    signature = hmac.new(pem, signing_input, hashlib.sha256).digest()
    forged = (
        signing_input + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")
    ).decode()

    with pytest.raises(auth.InvalidToken):
        auth.verify_id_token(forged)


def test_a_token_signed_by_the_wrong_key_is_refused(keypair):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = int(time.time())
    forged = jwt.encode(
        {
            "iss": auth.ISSUER_PREFIX + PROJECT,
            "aud": PROJECT,
            "sub": "uid-attacker",
            "iat": now - 60,
            "exp": now + 3600,
            "email": "victim@vt.edu",
            "email_verified": True,
        },
        other,
        algorithm="RS256",
        headers={"kid": KID},
    )
    with pytest.raises(auth.InvalidToken):
        auth.verify_id_token(forged)


@pytest.mark.parametrize("token", ["", "   ", "not.a.token", "a.b"])
def test_junk_is_refused_without_reaching_google(token):
    with pytest.raises(auth.InvalidToken):
        auth.verify_id_token(token)


def test_an_unconfigured_server_says_so_rather_than_letting_anyone_in(monkeypatch, keypair):
    """Fail closed. A missing setting must never mean "skip the check"."""
    monkeypatch.delenv("GENAI_FIREBASE_PROJECT_ID", raising=False)
    assert auth.firebase_config() == {}
    with pytest.raises(auth.AuthUnavailable):
        auth.verify_id_token(make_token(keypair))


def test_a_partial_config_counts_as_no_config(monkeypatch):
    """Half a config would render the sign-in button and then fail inside Google."""
    monkeypatch.delenv("GENAI_FIREBASE_APP_ID", raising=False)
    assert auth.firebase_config() == {}
    assert not auth.is_configured()
