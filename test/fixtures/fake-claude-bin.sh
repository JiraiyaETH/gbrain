#!/bin/sh
cat >/dev/null

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "anthropic_present=yes"
else
  echo "anthropic_present=no"
fi

cat <<'OUT'
```gbrain-page
slug: wiki/personal/reflections/2026-04-25-allowed-abc123
type: note
---
# Allowed Reflection

The user said "build the lever" and linked it to [[people/alice-example]].
```

```gbrain-page
slug: wiki/private/not-allowed
type: note
---
# Disallowed Note

This should be rejected by the server-side slug allow-list.
```
OUT
