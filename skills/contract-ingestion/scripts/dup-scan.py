#!/usr/bin/env python3
"""dup-scan.py — name-anchored content-similarity duplicate sweep over the
contracts/ shelf. Catches slug-variant / cross-source dups that exact doc-id
matching misses (e.g. a SignNow copy + a local-PDF copy of the same deal).

WHY name-anchored: KOL contracts are templated, so raw body-text similarity is
~0.97 for EVERY pair — useless on its own. The real duplicate signal is
**same creator + same signing date + same value**. Same creator with a
different date OR value is a legitimate DISTINCT round, not a dup.

Usage:  python3 dup-scan.py [CONTRACTS_DIR]      # default /Users/jarvis/brain/contracts
Prints ranked candidate pairs (score 3 = near-certain, 2 = review). 0 pairs = clean.
"""
import os, re, sys, difflib
from collections import defaultdict
from datetime import date

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/Users/jarvis/brain/contracts"

def normcp(s):
    s = re.sub(r'[^a-z0-9]', '', (s or '').lower())
    for pre in ("the", "0x", "crypto"):
        if s.startswith(pre) and len(s) > len(pre) + 2:
            s = s[len(pre):]
    return s

def daydiff(x, y):
    try:    return abs((date.fromisoformat(x) - date.fromisoformat(y)).days)
    except Exception: return 999

pages = []
for dp, _, fs in os.walk(ROOT):
    client = os.path.basename(dp)
    for fn in fs:
        if not fn.endswith(".md") or fn == "README.md":
            continue
        txt = open(os.path.join(dp, fn), errors="ignore").read()
        m = re.search(r'^title:\s*"?(.+?)"?\s*$', txt, re.M)
        title = m.group(1) if m else fn[:-3]
        dear = re.search(r'Dear\s+([A-Za-z0-9 ._]+?)[,\n]', txt)
        cpkey = normcp(dear.group(1) if dear else
                       re.sub(r'-[0-9a-f]{8}$', '', re.sub(r'-\d{8}$', '', fn[:-3])))
        signed = re.search(r'signed\s+(\d{4}-\d{2}-\d{2})', txt)
        val = re.search(r'\*\*(?:Value|Fee|Compensation)\:\*\*\s*\$?([\d,]+)', txt)
        body = re.split(r'## Agreement(?: text)?', txt, maxsplit=1)
        body = re.sub(r'<sub>.*', '', body[1] if len(body) > 1 else txt, flags=re.S)
        pages.append(dict(client=client, fn=fn, cpkey=cpkey,
                          signed=signed.group(1) if signed else "",
                          val=val.group(1).replace(",", "") if val else "",
                          body=re.sub(r'[^a-z0-9]', '', body.lower())))

flags = []
byc = defaultdict(list)
for p in pages:
    byc[p['client']].append(p)
for client, ps in byc.items():
    for i in range(len(ps)):
        for j in range(i + 1, len(ps)):
            a, b = ps[i], ps[j]
            namesim = difflib.SequenceMatcher(None, a['cpkey'], b['cpkey']).ratio()
            if namesim < 0.8:            # name anchor REQUIRED — body alone is noise
                continue
            bodysim = difflib.SequenceMatcher(None, a['body'], b['body']).ratio() if (a['body'] and b['body']) else 0
            same_date = a['signed'] and a['signed'] == b['signed']
            same_val = a['val'] and a['val'] == b['val']
            near = a['signed'] and b['signed'] and daydiff(a['signed'], b['signed']) <= 4
            if same_date and same_val:                 score, why = 3, "SAME name+date+val"
            elif same_date:                            score, why = 2, "same name+date, diff val"
            elif same_val and bodysim > 0.97:          score, why = 2, "same name+val, diff date"
            elif near and same_val:                    score, why = 2, f"same name+val, date±{daydiff(a['signed'],b['signed'])}d"
            elif near and bodysim > 0.985:             score, why = 2, f"same name, date±{daydiff(a['signed'],b['signed'])}d"
            else:                                      continue
            flags.append((score, client, a['fn'], b['fn'], a['signed'], b['signed'],
                          a['val'], b['val'], round(namesim, 2), round(bodysim, 2), why))

flags.sort(reverse=True)
print(f"scanned {len(pages)} contract pages; {len(flags)} candidate dup pairs (score>=2)\n")
for sc, cl, a, b, da, db, va, vb, nm, bd, why in flags:
    print(f"[{sc}] {cl}: {a}  ==  {b}  | {da}|{db} val {va}/{vb} name={nm} body={bd}  ({why})")
sys.exit(1 if any(f[0] >= 3 for f in flags) else 0)
