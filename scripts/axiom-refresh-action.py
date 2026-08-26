#!/usr/bin/env python3
"""
GitHub Actions sidecar refresher for the solana-meme-bot's Axiom session.

Why this exists: axiom.trade's /refresh-access-token sits behind Cloudflare
Bot Management, which intermittently 418s the Cloudflare Worker's TLS
fingerprint. curl_cffi impersonating a real Chrome build passes it.

Single-writer contract: while AXIOM_EXTERNAL_REFRESH=1 is set on the Worker,
the Worker never calls refresh itself — THIS script is the only refresher.
(Axiom rotates the refresh token on every call, so two writers would
invalidate each other.)

Flow:
  1. Read auth-access-token / auth-refresh-token from Turso worker_state.
  2. Decode the access JWT's exp claim. If >REFRESH_MARGIN seconds remain,
     exit 0 without refreshing (fewer rotations = fewer failure windows).
  3. Claim the cross-platform refresh lock (CAS on worker_state).
  4. POST /refresh-access-token through every shard until one answers 200
     (curl_cffi, impersonate="chrome").
  5. Write the rotated pair back to worker_state and release the lock.

Secrets expected (GitHub repo → Settings → Secrets → Actions):
  TURSO_DATABASE_URL   e.g. libsql://your-db.turso.io
  TURSO_AUTH_TOKEN     Turso auth token

Tokens themselves are NEVER stored in CI Secrets — Turso worker_state is
the single source of truth, same keys the Worker reads.
"""

import base64
import json
import os
import re
import sys
import time

from curl_cffi import requests as creq

# libsql:// secrets are normalised to https:// — Turso's REST pipeline API
# lives on the same host over HTTPS.
TURSO_URL = (os.environ.get("TURSO_DATABASE_URL") or "").strip().replace(
    "libsql://", "https://", 1
)
TURSO_TOKEN = (os.environ.get("TURSO_AUTH_TOKEN") or "").strip()

HOSTS = ["api9.axiom.trade", "api3.axiom.trade", "api6.axiom.trade", "api10.axiom.trade"]
REFRESH_PATH = "/refresh-access-token"
# Refresh only when the access token has less than this much life left.
# The JWT lives ~16 min and cron delivers every ~10 (GitHub delays slots
# by minutes at times). The margin MUST exceed the cadence or every cycle
# ends with an expired-token window — observed live 2026-08-26 00:17-00:35
# UTC: two skipped slots left all Axiom endpoints returning disguised-502
# for ~15 min. 11 min > the 10-min cadence means every delivered run
# refreshes, keeping >=5 min of buffer against delivery jitter. Bursts of
# catch-up runs stay safe: the workflow's concurrency group serializes
# them, so each reads the latest rotated refresh-token from Turso.
REFRESH_MARGIN_SECONDS = 660

# ---------------------------------------------------------------------------
# Cross-platform refresh lock (Turso compare-and-swap).
#
# The session is refreshed by MULTIPLE independent triggers now (a GitHub
# Actions cron + a cron-job.org job calling this workflow's dispatch API)
# because GitHub's schedule
# delivery stalls during incidents (2026-08-26 00:02–01:52Z: zero runs for
# ~110 min). Axiom rotates the refresh token on EVERY successful call, so
# two platforms refreshing simultaneously would invalidate each other and
# kill the session outright. This lock — same CAS pattern as db.claimPushWatch
# in src/db.ts — lets exactly ONE runner past the rotation step at a time:
# the winner claims the key with a conditional UPDATE, losers exit 0. The
# lock is released when a run finishes (success OR failure); if a runner
# dies mid-flight, LOCK_TTL_SECONDS auto-expires it so the next slot can
# retry. Pacing is NOT the lock's job — REFRESH_MARGIN handles that; the
# lock only closes the simultaneous-double-refresh window across platforms.
LOCK_KEY = "axiom_refresh_lock"
LOCK_TTL_SECONDS = 300

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://axiom.trade",
    "Referer": "https://axiom.trade/",
}

MASK = lambda t: f"{t[:12]}…{t[-6:]}" if t and len(t) > 24 else "<missing>"


def die(msg: str) -> None:
    print(f"❌ {msg}")
    sys.exit(1)


def turso_pipeline(sql: str, args: list | None = None):
    """One statement via Turso's v2/pipeline HTTP API; returns the result."""
    body = {
        "requests": [
            {"type": "execute", "stmt": {"sql": sql, "args": args or []}}
        ]
    }
    res = creq.post(
        f"{TURSO_URL}/v2/pipeline",
        headers={
            "Authorization": f"Bearer {TURSO_TOKEN}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=20,
    )
    # Surface the response BODY on non-2xx — a bare status hides whether the
    # request shape (arg types!) or the SQL was rejected.
    if res.status_code >= 300:
        raise RuntimeError(
            f"Turso HTTP {res.status_code}: {res.text[:300]!r} for sql={sql[:80]!r}"
        )
    result = res.json()["results"][0]
    if result.get("type") != "ok":
        raise RuntimeError(f"Turso error: {json.dumps(result)[:300]}")
    return result["response"]["result"]


def turso_query(sql: str, args: list | None = None):
    """One SELECT; rows come back as [[cell_value, ...], ...]."""
    rows = turso_pipeline(sql, args)["rows"]
    return [[cell.get("value") for cell in row] for row in rows]


def turso_execute(sql: str, args: list | None = None) -> int:
    """One mutating statement; returns rowsAffected for CAS checks."""
    inner = turso_pipeline(sql, args)
    # Raw Hrana spells it rows_affected; some proxies/versions return
    # camelCase — accept both.
    return int(inner.get("rowsAffected") or inner.get("rows_affected") or 0)


def try_claim_lock(now_s: int) -> bool:
    """Atomically claim the refresh lock. True = we may refresh.

    One CAS UPDATE covers the common case (row exists). Zero rows means
    either a fresh lock is held elsewhere (SELECT confirms → lose) or the
    row was never inserted (INSERT wins; losing a UNIQUE-constraint race to
    a concurrent claimer on another platform also means lose).

    NOTE: all bind args go through as TEXT with CASTs on both sides of the
    comparison — Turso's v2/pipeline rejects the Hrana "integer" value type
    on this endpoint (live-verified 2026-08-26: HTTP 400), while plain text
    args are exactly what the rest of this script has always used.
    """
    cutoff = str(now_s - LOCK_TTL_SECONDS)
    n = turso_execute(
        "UPDATE worker_state SET value = ? WHERE key = ? "
        "AND CAST(value AS INTEGER) <= CAST(? AS INTEGER)",
        [
            {"type": "text", "value": str(now_s)},
            {"type": "text", "value": LOCK_KEY},
            {"type": "text", "value": cutoff},
        ],
    )
    if n > 0:
        return True
    rows = turso_query(
        "SELECT value FROM worker_state WHERE key = ?",
        [{"type": "text", "value": LOCK_KEY}],
    )
    if rows:
        return False  # row exists with a fresh timestamp — someone else owns it
    try:
        turso_execute(
            "INSERT INTO worker_state (key, value) VALUES (?, ?)",
            [
                {"type": "text", "value": LOCK_KEY},
                {"type": "text", "value": str(now_s)},
            ],
        )
        return True
    except RuntimeError:
        return False  # concurrent INSERT won the race


def release_lock() -> None:
    """Free the lock immediately so the next slot isn't blocked by the TTL."""
    try:
        turso_execute(
            "UPDATE worker_state SET value = '0' WHERE key = ?",
            [{"type": "text", "value": LOCK_KEY}],
        )
    except Exception as exc:
        print(f"⚠️ lock release failed ({str(exc)[:120]}) — TTL will clear it")


def get_worker_state(key: str) -> str | None:
    rows = turso_query("SELECT value FROM worker_state WHERE key = ?", [{"type": "text", "value": key}])
    return rows[0][0] if rows else None


def set_worker_state(key: str, value: str) -> None:
    turso_query(
        "UPDATE worker_state SET value = ? WHERE key = ?",
        [{"type": "text", "value": value}, {"type": "text", "value": key}],
    )


def jwt_exp(token: str) -> int | None:
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = payload.get("exp")
        return int(exp) if isinstance(exp, (int, float)) else None
    except Exception:
        return None


def extract_cookie(set_cookie_header: str | None, name: str) -> str | None:
    """Pull one cookie value out of a (possibly multi-cookie) Set-Cookie blob."""
    if not set_cookie_header:
        return None
    match = re.search(rf"{name}=([^;,\s]+)", set_cookie_header)
    return match.group(1) if match else None


def refresh(refresh_token: str):
    last_status = 0
    for host in HOSTS:
        url = f"https://{host}{REFRESH_PATH}"
        try:
            res = creq.post(
                url,
                headers={**HEADERS, "Cookie": f"auth-refresh-token={refresh_token}"},
                impersonate="chrome",
                timeout=20,
            )
            last_status = res.status_code
            if res.status_code == 200:
                access = extract_cookie(res.headers.get("set-cookie"), "auth-access-token")
                new_refresh = extract_cookie(res.headers.get("set-cookie"), "auth-refresh-token")
                try:
                    body = res.json() if isinstance(res.json(), dict) else {}
                except Exception:
                    body = {}
                access = access or body.get("auth-access-token") or body.get("access_token")
                new_refresh = new_refresh or body.get("auth-refresh-token") or body.get("refresh_token")
                if isinstance(access, str) and access.count(".") == 2:
                    return access, (new_refresh if isinstance(new_refresh, str) and new_refresh else refresh_token), host
                last_status = -1  # 200 but no usable token — treat as failure
            print(f"  {host}: HTTP {last_status} — trying next host…")
        except Exception as exc:
            print(f"  {host}: {exc.__class__.__name__}: {str(exc)[:120]}")
        time.sleep(0.3)
    raise RuntimeError(f"all {len(HOSTS)} hosts failed (last HTTP {last_status})")


def main() -> None:
    if not TURSO_URL or not TURSO_TOKEN:
        die("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN secrets missing")

    access = get_worker_state("axiom_access_token")
    refresh_token = get_worker_state("axiom_refresh_token")
    if not access or not refresh_token:
        die("no tokens in worker_state — run /debug/axiom-tokens once first")

    exp = jwt_exp(access)
    now = int(time.time())
    if exp is None:
        print("⚠️ cannot parse exp from access JWT — forcing refresh")
    elif exp - now > REFRESH_MARGIN_SECONDS:
        mins = (exp - now) // 60
        print(f"✅ access token still valid ({mins} min left) — no refresh needed")
        return

    print(f"🔁 access token stale/expired ({MASK(access)}) — refreshing…")

    # Only ONE platform may rotate the pair — claim the cross-platform lock.
    if not try_claim_lock(now):
        print("🔒 another refresher holds the lock — skipping (it owns this rotation)")
        return
    try:
        # Another scheduler may have refreshed between our first read and the
        # claim — re-read both tokens and re-check before spending a rotation.
        access = get_worker_state("axiom_access_token") or access
        refresh_token = get_worker_state("axiom_refresh_token") or refresh_token
        re_exp = jwt_exp(access)
        if re_exp is not None and re_exp - int(time.time()) > REFRESH_MARGIN_SECONDS:
            print(
                f"✅ re-checked after lock: already fresh ({(re_exp - int(time.time())) // 60} min left) — no rotation needed"
            )
            return

        new_access, new_refresh, host = refresh(refresh_token)
        new_exp = jwt_exp(new_access)

        set_worker_state("axiom_access_token", new_access)
        if new_refresh != refresh_token:
            set_worker_state("axiom_refresh_token", new_refresh)
            print("♻️ refresh token rotated — updated worker_state")
        mins = f"{(new_exp - now) // 60} min" if new_exp else "?"
        print(f"✅ refreshed via {host} — new access {MASK(new_access)} expires in {mins}")
    finally:
        release_lock()


if __name__ == "__main__":
    main()
