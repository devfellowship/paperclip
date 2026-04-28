#!/usr/bin/env python3
"""
infisical-map/map.py

Generates a Mermaid diagram of agent machine identities and their secret-path
access in Infisical, then sends it to Telegram or prints to stdout.

Usage:
    python3 skills/infisical-map/map.py

Required env:
    INFISICAL_CLIENT_ID      — Universal Auth client ID (Bro's R/W identity)
    INFISICAL_CLIENT_SECRET  — Universal Auth client secret

Optional env:
    INFISICAL_API_URL        — default: https://infisical.devfellowship.com
    INFISICAL_PROJECT_ID     — default: f9572f70-c99d-4a44-8686-e9e83ff5a8fe
    INFISICAL_ENV            — default: prod
    TELEGRAM_BOT_TOKEN       — if unset, output goes to stdout only
    TELEGRAM_CHAT_ID         — Telegram chat or user ID
"""

import os
import sys
import json
import re
import urllib.request
import urllib.error

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

INFISICAL_API_URL = os.environ.get("INFISICAL_API_URL", "https://infisical.devfellowship.com")
INFISICAL_PROJECT_ID = os.environ.get("INFISICAL_PROJECT_ID", "f9572f70-c99d-4a44-8686-e9e83ff5a8fe")
INFISICAL_ENV = os.environ.get("INFISICAL_ENV", "prod")
INFISICAL_CLIENT_ID = os.environ.get("INFISICAL_CLIENT_ID", "")
INFISICAL_CLIENT_SECRET = os.environ.get("INFISICAL_CLIENT_SECRET", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def http_get(url, token=None):
    """Perform a GET request, return parsed JSON or None."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"[infisical-map] HTTP {e.code} on GET {url}: {e.read().decode()[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[infisical-map] Error on GET {url}: {e}", file=sys.stderr)
        return None


def http_post(url, data, token=None):
    """Perform a POST request with JSON body, return parsed JSON or None."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"[infisical-map] HTTP {e.code} on POST {url}: {e.read().decode()[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[infisical-map] Error on POST {url}: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Infisical helpers
# ---------------------------------------------------------------------------

def authenticate():
    """Authenticate via Universal Auth. Returns access token or exits."""
    if not INFISICAL_CLIENT_ID or not INFISICAL_CLIENT_SECRET:
        print("[infisical-map] INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET must be set", file=sys.stderr)
        sys.exit(1)

    url = f"{INFISICAL_API_URL}/api/v1/auth/universal-auth/login"
    resp = http_post(url, {"clientId": INFISICAL_CLIENT_ID, "clientSecret": INFISICAL_CLIENT_SECRET})
    if not resp or "accessToken" not in resp:
        print("[infisical-map] Authentication failed — check credentials", file=sys.stderr)
        sys.exit(1)

    return resp["accessToken"]


def list_identities(token):
    """
    List all machine identity memberships for the project.
    Returns list of dicts with keys: identity.name, role.
    """
    url = f"{INFISICAL_API_URL}/api/v2/workspace/{INFISICAL_PROJECT_ID}/identities"
    resp = http_get(url, token)
    if resp is None:
        return []

    # Response shape: { identityMemberships: [ { identity: {name, id}, role, ... } ] }
    memberships = resp.get("identityMemberships", [])
    if not memberships:
        # Older API may return top-level list
        if isinstance(resp, list):
            memberships = resp

    result = []
    for m in memberships:
        identity = m.get("identity", {}) if isinstance(m, dict) else {}
        name = identity.get("name", "") or m.get("name", "")
        role = m.get("role", "viewer")
        if name:
            result.append({"name": name, "role": role})
    return result


def list_folders(token, path="/"):
    """
    Recursively list all folders from the given path.
    Returns a flat list of folder paths (strings).
    """
    url = (
        f"{INFISICAL_API_URL}/api/v1/folders"
        f"?workspaceId={INFISICAL_PROJECT_ID}&environment={INFISICAL_ENV}&path={path}"
    )
    resp = http_get(url, token)
    if not resp:
        return []

    folders = resp.get("folders", [])
    all_paths = []
    for folder in folders:
        folder_name = folder.get("name", "")
        if not folder_name:
            continue
        child_path = (path.rstrip("/") + "/" + folder_name + "/")
        all_paths.append(child_path)
        # Recurse
        all_paths.extend(list_folders(token, child_path))

    return all_paths


# ---------------------------------------------------------------------------
# Mapping logic
# ---------------------------------------------------------------------------

def extract_agent_name(identity_name):
    """
    Extract the agent-name segment from an identity name.
    Pattern: {owner}__{agent-name}__{platform}
    Returns the middle segment, or None if pattern doesn't match.
    """
    parts = identity_name.split("__")
    if len(parts) >= 2:
        return parts[1]
    return None


def map_identity_to_paths(identity, all_folder_paths):
    """
    Determine which paths an identity can access based on naming convention.
    - /agents/{agent-name}/  → agent-specific (extracted from identity name)
    - /shared/               → all identities
    - /infra/**              → admin/member only (Bro)
    - /apps/**               → admin/member only (Bro)
    """
    name = identity["name"]
    role = identity["role"]
    accessible = []

    agent_name = extract_agent_name(name)
    if agent_name:
        agent_path = f"/agents/{agent_name}/"
        if agent_path in all_folder_paths:
            accessible.append(agent_path)

    # Shared — accessible by all
    if "/shared/" in all_folder_paths:
        accessible.append("/shared/")

    # Admin/member get broader access
    if role in ("admin", "member"):
        for p in all_folder_paths:
            if p.startswith("/infra/") or p.startswith("/apps/"):
                if p not in accessible:
                    accessible.append(p)

    # Fallback: if nothing matched, include /shared/ even if not in discovered folders
    if not accessible:
        accessible.append("/shared/")

    return accessible


# ---------------------------------------------------------------------------
# Mermaid generation
# ---------------------------------------------------------------------------

def sanitize_id(s):
    """Convert a string to a valid Mermaid node ID (uppercase, underscores)."""
    return re.sub(r"[^A-Z0-9_]", "_", s.upper())


def role_label(role):
    if role in ("admin", "member"):
        return "R/W"
    return "R"


def generate_mermaid(identities, all_folder_paths):
    """Generate a Mermaid LR diagram."""
    lines = ["graph LR"]

    # Collect used paths
    identity_paths = {}
    for ident in identities:
        paths = map_identity_to_paths(ident, all_folder_paths)
        identity_paths[ident["name"]] = paths

    all_used_paths = set()
    for paths in identity_paths.values():
        all_used_paths.update(paths)

    # Node declarations — identities
    for ident in identities:
        node_id = sanitize_id(ident["name"])
        label = f'{extract_agent_name(ident["name"]) or ident["name"]} {role_label(ident["role"])}'
        lines.append(f'    {node_id}["{label}"]')

    # Node declarations — paths
    for path in sorted(all_used_paths):
        node_id = sanitize_id(path)
        lines.append(f'    {node_id}["{path}"]')

    # Edges
    for ident in identities:
        src_id = sanitize_id(ident["name"])
        for path in identity_paths[ident["name"]]:
            dst_id = sanitize_id(path)
            lines.append(f"    {src_id} --> {dst_id}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------

def send_telegram(text):
    """Send text message to Telegram. Returns True on success."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("[infisical-map] Telegram vars not set — skipping send", file=sys.stderr)
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    # Wrap in code block so Mermaid is readable as plain text
    message = f"```\n{text}\n```"
    data = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown",
    }
    resp = http_post(url, data)
    if resp and resp.get("ok"):
        print("[infisical-map] Diagram sent to Telegram", file=sys.stderr)
        return True
    print(f"[infisical-map] Telegram send failed: {resp}", file=sys.stderr)
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("[infisical-map] Authenticating with Infisical...", file=sys.stderr)
    token = authenticate()

    print("[infisical-map] Listing machine identities...", file=sys.stderr)
    identities = list_identities(token)
    if not identities:
        print("[infisical-map] No identities found. Check that the calling identity has project access.", file=sys.stderr)
        # Still generate a minimal diagram
        identities = []

    print(f"[infisical-map] Found {len(identities)} identities", file=sys.stderr)

    print("[infisical-map] Discovering folder tree...", file=sys.stderr)
    all_folders = list_folders(token, "/")
    print(f"[infisical-map] Discovered {len(all_folders)} folders: {all_folders}", file=sys.stderr)

    mermaid = generate_mermaid(identities, all_folders)

    # Always print to stdout
    print(mermaid)

    # Also send to Telegram if configured
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
        send_telegram(mermaid)


if __name__ == "__main__":
    main()
