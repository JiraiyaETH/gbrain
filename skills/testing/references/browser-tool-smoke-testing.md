# Browser/tool smoke testing notes

Use this reference when validating Hermes browser/browser-use compatibility after a Hermes update or dependency drift.

## Focused smoke scope

- Inventory versions:
  ```bash
  cd ~/.hermes/hermes-agent && source venv/bin/activate
  python - <<'PY'
  import importlib.metadata as m
  for pkg in ['browser-use','anyio','openai','pydantic','rich']:
      try: print(f'{pkg}={m.version(pkg)}')
      except m.PackageNotFoundError: print(f'{pkg}=MISSING')
  PY
  ```
- Import smoke:
  ```bash
  python - <<'PY'
  import importlib
  for mod in ['browser_use','browser_use.agent.views','tools.browser_tool','tools.browser_providers.browser_use','tools.browser_cdp_tool','tools.browser_camofox','openai']:
      importlib.import_module(mod)
      print('OK', mod)
  PY
  ```
- Live browser path: navigate to `https://example.com` with the browser tool, then clean any test-spawned `agent-browser`/headless Chrome residue if the tool did not close it.

## Pytest command shape

For focused Hermes tests, prefer clearing repository-level addopts:
```bash
python -m pytest -o 'addopts=' tests/tools/test_browser_*.py -q --tb=short
```
If a file glob is too broad, enumerate the browser files explicitly.

## Classification pattern for order-dependent failures

When a focused suite fails but individual files pass:

1. Run the failed test alone.
2. Run the suspected predecessor file alone.
3. Run predecessor + failed test in the same process.
4. If the pair fails but each file alone passes, classify as **test isolation/order pollution**, not a runtime regression.
5. Inspect shared globals, temporary browser sessions, monkeypatch cleanup, and process residue before changing product code.

Example symptom:
- a browser test leaves `_active_sessions` or a socket/pid file behind
- a later cleanup-cache test calls `cleanup_all_browsers()`
- the live-system guard blocks `os.kill(pid, SIGTERM)` for a process outside the pytest subtree

Fix direction:
- the predecessor test should mock or clean browser state after any normal URL/live-ish path
- cleanup tests should seed/clear the exact globals they rely on and avoid inheriting `_active_sessions`
- only bypass live-system guards when real signal delivery is the purpose of the test

## Reporting

Separate:
- dependency pin drift (`pip check`) as advisory unless imports/smoke fail
- skipped live-browser integration tests as coverage gap, not failure
- order-dependent test failures as test hygiene unless product behavior reproduces outside pytest
- process residue cleanup evidence from actual runtime failures
