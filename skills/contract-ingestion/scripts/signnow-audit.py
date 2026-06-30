#!/usr/bin/env python3
"""signnow-audit.py — READ-ONLY crawl of the whole SignNow account (folder
traversal) so you can reconcile it against the brain's contracts/ shelf and find
what hasn't been ingested. NEVER mutates, sends an invite, or writes a tracker.

MUST be run through the secret-safe wrapper so credentials are injected, never
printed:

    SN=/Users/jarvis/.hermes/skills/productivity/signnow/scripts/signnow_run.py
    python3 "$SN" preflight                                  # confirm creds resolve
    python3 "$SN" run -- python3 signnow-audit.py OUT.json   # crawl -> OUT.json

The wrapper injects SIGNNOW_CLIENT_ID / _CLIENT_SECRET / _EMAIL / _PASSWORD.
Endpoint notes (this account): `GET /document?limit=` 400s and
`GET /folder/{id}/documents` 405s — the durable path is `GET /folder` then
recursive `GET /folder/{id}` reading each folder's embedded `documents[]`.

Output: a JSON array of {id,name,created,updated,page_count,folder,
signature_count,...}. Live docs are folder=='Documents'; ignore 'Trash Bin'
and 'Templates'. Then match against the brain (see SKILL.md "Reconciliation mode").
"""
import base64, json, os, sys, time, urllib.request, urllib.error
from urllib.parse import urlencode

BASE = "https://api.signnow.com"
OUT = sys.argv[1] if len(sys.argv) > 1 else "signnow-docs.json"

def _req(method, path, token=None, basic=None, data=None, form=False):
    headers = {"Accept": "application/json"}
    body = None
    if basic:  headers["Authorization"] = "Basic " + basic
    elif token: headers["Authorization"] = "Bearer " + token
    if data is not None:
        if form:
            body = urlencode(data).encode(); headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode(); headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

def authenticate():
    cid, sec = os.environ["SIGNNOW_CLIENT_ID"], os.environ["SIGNNOW_CLIENT_SECRET"]
    basic = base64.b64encode(f"{cid}:{sec}".encode()).decode()
    st, resp = _req("POST", "/oauth2/token", basic=basic, form=True, data={
        "grant_type": "password",
        "username": os.environ["SIGNNOW_EMAIL"], "password": os.environ["SIGNNOW_PASSWORD"]})
    if st != 200 or "access_token" not in resp:
        print(f"AUTH FAILED status={st} body={resp}", file=sys.stderr); sys.exit(1)
    return resp["access_token"]

def main():
    token = authenticate()
    st, root = _req("GET", "/folder", token=token)
    if st != 200:
        print(f"ROOT /folder failed status={st} body={root}", file=sys.stderr); sys.exit(1)
    queue = []
    def collect(node):
        if isinstance(node, dict):
            if node.get("id"): queue.append(node["id"])
            for s in node.get("folders", []) or []: collect(s)
    collect(root)
    if isinstance(root, list):
        for f in root: collect(f)

    seen, docs, i = set(), {}, 0
    while i < len(queue):
        fid = queue[i]; i += 1
        if fid in seen: continue
        seen.add(fid)
        offset, fname = 0, ""
        while True:
            st, body = _req("GET", f"/folder/{fid}?limit=100&offset={offset}", token=token)
            if st != 200 or not isinstance(body, dict): break
            fname = body.get("name", fname)
            for s in body.get("folders", []) or []:
                if s.get("id") and s["id"] not in seen: queue.append(s["id"])
            batch = body.get("documents", []) or []
            for d in batch:
                did = d.get("id")
                if not did: continue
                docs[did] = {"id": did,
                             "name": d.get("document_name") or d.get("name") or d.get("title") or "",
                             "created": d.get("created"), "updated": d.get("updated"),
                             "page_count": d.get("page_count"), "folder": fname,
                             "signature_count": len(d.get("signatures", []) or [])}
            total = body.get("total_documents") or body.get("total") or len(batch)
            offset += len(batch)
            if not batch or offset >= int(total or 0): break
            time.sleep(0.05)

    out = sorted(docs.values(), key=lambda x: (x.get("created") or 0))
    json.dump(out, open(OUT, "w"), indent=2)
    print(f"FOLDERS={len(seen)} TOTAL_DOCS={len(out)} -> {OUT}")

if __name__ == "__main__":
    main()
