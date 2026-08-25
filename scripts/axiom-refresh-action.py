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
  3. Otherwise POST /refresh-access-token through every shard until one
     answers 200 (curl_cffi, impersonate="chrome").
  4. Write the rotated pair back to worker_state.

Secrets expected (GitHub repo → Settings → Secrets → Actions):
  TURSO_DATABASE_URL   e.g. libsql://your-db.turso.io
  TURSO_AUTH_TOKEN     Turso auth token

Tokens themselves are NEVER stored in GitHub Secrets — Turso worker_state is
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
# Refresh only when the access token has less than this much life left (the
# JWT lives ~16 min; refreshing at <3 min wastes few rotations but keeps a
# comfortable buffer over cron jitter).
REFRESH_MARGIN_SECONDS = 180

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


def turso_query(sql: str, args: list | None = None):
    """One statement via Turso's v2/pipeline HTTP API."""
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
    res.raise_for_status()
    payload = res.json()
    result = payload["results"][0]
    if result.get("type") != "ok":
        raise RuntimeError(f"Turso error: {json.dumps(result)[:300]}")
    rows = result["response"]["result"]["rows"]
    # Rows come back as [[{"type":"text","value":"..."}, ...], ...]
    out = []
    for row in rows:
        out.append([cell.get("value") for cell in row])
    return out


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
    new_access, new_refresh, host = refresh(refresh_token)
    new_exp = jwt_exp(new_access)

    set_worker_state("axiom_access_token", new_access)
    if new_refresh != refresh_token:
        set_worker_state("axiom_refresh_token", new_refresh)
        print("♻️ refresh token rotated — updated worker_state")
    mins = f"{(new_exp - now) // 60} min" if new_exp else "?"
    print(f"✅ refreshed via {host} — new access {MASK(new_access)} expires in {mins}")


if __name__ == "__main__":
    main()
