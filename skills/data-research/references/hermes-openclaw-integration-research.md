# Hermes + OpenClaw Integration Research Notes

Use when researching cross-agent integration patterns between Hermes Agent, OpenClaw, and adjacent agent runtimes.

## Source confidence ladder

- **High confidence:** official Hermes/OpenClaw docs; upstream GitHub repos/issues/PRs; cloned READMEs with recent commits; locally verified runtime docs.
- **Medium confidence:** third-party bridge repos with code but unclear adoption; practitioner blogs with concrete commands or architecture.
- **Low confidence:** SEO comparison articles; Google-indexed X/Twitter snippets without full thread access; claims from screenshots/search snippets only.

## Concrete public patterns observed

### Migration, not integration

Both ecosystems expose migration paths:

- Hermes: `hermes claw migrate` for OpenClaw users.
- OpenClaw: Hermes importer/migration docs and PRs around memory/config/plugin/MCP/skill mappings.

Treat migration paths as evidence of overlapping users, not proof of mature bidirectional integration.

### Channel/account multiplexing

`AaronWong1999/hermesclaw` describes a concrete WeChat/iLink use case:

- Hermes Agent and OpenClaw both support WeChat, but both gateways can try to exclusively own the same iLink connection.
- Starting both on the same account can produce 403/drop-message failures.
- HermesClaw acts as the sole iLink poller and proxies to Hermes/OpenClaw/OpenCode.
- User-facing commands include `/hermes`, `/openclaw`, `/opencode`, `/both`, `/three`.

Pattern: one human-facing chat account, explicit routing to multiple agent brains.

### OpenClaw as control plane, Hermes as runtime

`ZY-LI-F/Hermesclaw` frames:

```text
OpenClaw = control plane for entrypoints, sessions, channels, device-facing surfaces, plugin contracts
Hermes Agent = controlled runtime/backend capability
OpenClaw CLI backend -> Hermesclaw bridge -> Hermes AIAgent
```

Caveat from README: memory, skills, cron, and other Hermes-native capabilities had not yet been lifted into OpenClaw-native layers.

### Hermes as client delegating to OpenClaw

`ORee1000/openclaw-bridge` frames:

```text
Hermes MCP client -> OpenClaw Bridge MCP Server -> queue file -> OpenClaw Cron Worker -> OpenClaw Agent -> result file -> Hermes
```

Pattern: Hermes delegates specialized tasks to OpenClaw via MCP/queue/cron bridge.

### Shared context / agent mesh

`DevvGwardo/agentic-mesh` frames multi-agent collaboration with:

- shared context
- peer discovery
- task delegation
- example roles: OpenClaw coding agent, Hermes research agent, Hermes monitoring agent

Pattern: publish findings and handoffs as structured artifacts instead of sharing raw sessions/state.

### Provenance and handoff primitives

OpenClaw GitHub surfaced work/proposals around:

- Hermes import path.
- Hermes arbiter metadata routed through outbound delivery.
- `chat.inject` with `originAgent` to preserve who actually produced an injected message.
- ASFS skill format + Handoff Protocol for cross-agent interoperability.
- MCP compatibility issues affecting Hermes Agent.

Key lesson: cross-agent systems need provenance (`originAgent`, scope, confidence, handoff id), not just message passing.

## X/Twitter research caveat

Direct X search can hit a login wall. In this session, Browser Use Cloud reached X login, then used Google-indexed X snippets. Google screenshots were separately read via vision analysis.

Use labels:

- `X verified full post` only when the full public post/thread is visible.
- `Google-indexed X snippet` when only search-result text is visible.
- Do not overstate indexed snippets as full practitioner validation.

Visible indexed examples included gkisokay discussing advantages of using both OpenClaw and Hermes, hosseeb comparing Hermes adaptation across sessions vs OpenClaw, and gregisenberg posting tutorial/comparison content. Treat these as early chatter, not a standard workflow.

## Recommended synthesis for users asking “what could it be?”

Emphasize possible product shape over current maturity:

```text
Mission Control / channel router
  -> OpenClaw: gateway, orchestration, production ownership, routing
  -> Hermes: adaptive memory, skill distillation, research, independent audit/monitoring
  -> coding agents: OpenCode/Codex/Claude/etc.
  -> shared artifact bus: handoffs, findings, reports, decisions, runbooks
```

Rollout order:

1. Shared artifact bus, no raw sessions/secrets/state DBs.
2. Manual handoff files with owner/scope/forbidden actions/expected output.
3. CLI bridge wrappers.
4. Provenance-aware transcript injection (`originAgent`, confidence, scope, handoff id).
5. Router/automation only after the manual path is proven.

Pitfalls:

- Do not conflate migration tools with integration.
- Do not merge raw memories or runtime state.
- Do not let two gateways own the same locked chat account without a multiplexer.
- Do not allow silent auto-repair loops between agents.
- Preserve identity boundaries: Hermes/Alex should not appear as OpenClaw/Vivian and vice versa.
