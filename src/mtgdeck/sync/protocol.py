"""What the sync server promises its clients, in one place: the desktop client (``remote``), the server itself and
hosts that answer some of its routes (Conclave Cloud) read it from here instead of writing it again.

Stdlib only and no imports from the package: the desktop build leaves the server out but needs these.
"""

from __future__ import annotations

SERVICE = "mtgdeck-sync"  # GET /api/health answers it; a client refuses an address that answers anything else
PROTOCOL = 1

NOT_SIGNED_IN = "Dieses Gerät ist nicht (mehr) angemeldet – bitte neu koppeln."
CODE_WRONG = "Der Kopplungscode stimmt nicht oder ist abgelaufen."
TOO_MANY_CODES = "Zu viele falsche Codes – bitte in ein paar Minuten noch einmal versuchen."

# The routes that store synced documents (what a host's storage quota counts). The server's other writes only touch
# its device table (pairing, presence, sign-off, the AI search settings and cache), which stays small.
DOC_WRITES = frozenset({("PUT", "/api/sync/doc"), ("POST", "/api/app/ops")})


def bearer(authorization: str) -> str:
    """The token of an ``Authorization: Bearer …`` header, else ""."""
    return authorization[7:].strip() if authorization[:7].lower() == "bearer " else ""


def pairing_link(base: str, code: str) -> str:
    """The link a new device opens (or scans) to pair: the app takes the code after ``#``."""
    return f"{base}/koppeln#{code}"
