# The Oblist Action Cards

Unified Hermes package containing:

- the remote dashboard API used to review and execute approved cards;
- the local Desktop renderer for inline cards, CS alerts and `Resolve now`;
- no direct Kepler, Shopify or Intercom credential.

The backend reuses the profile-bound `MCP_OBLIST_ACTIONS_API_KEY` already
configured on each Nous Cloud agent. Operator identity still comes from the
authenticated Nous session and is checked again by AI Ops.

## Install source

```text
GarySfez/oblist-ai-ops/hermes-plugin/oblist-action-cards
```

The repository is private. Use only an authenticated internal installation
channel; never place a GitHub token in the URL or in Hermes configuration.
