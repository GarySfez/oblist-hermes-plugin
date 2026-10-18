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
GarySfez/oblist-hermes-plugin
```

One-click Desktop installer:

```text
https://garysfez.github.io/oblist-hermes-plugin/
```

The public distribution repository contains plugin code only. It contains no
credentials, customer data, Kepler data or direct third-party access.
