# The Oblist Action Cards

Unified Hermes package containing:

- the remote dashboard API used to review and execute approved cards;
- the local Desktop renderer for inline cards, CS alerts and `Resolve now`;
- no direct Kepler, Shopify or Intercom credential.

The backend reuses the profile-bound `MCP_OBLIST_ACTIONS_API_KEY` already
configured on each Nous Cloud agent. Operator identity still comes from the
authenticated Nous session and is checked again by AI Ops.

## Managed updates

After the one-time bootstrap installation, the plugin checks the authenticated
The Oblist release channel. Only the exact commit approved by AI Ops can be
installed. A release appears in **Accueil CS** with one
**Ouvrir la mise à jour** button. The Agent copies for Global, Lyse and
Philippine are aligned as one operation and rolled back together on failure.
Hermes then opens its official local installer: the CS confirms **Installer**
once and Desktop hot-reloads the interface without restarting the app or
ending the remote browser session.

The release channel can target Global, Lyse and Philippine independently.
Setting the channel to `OFF` or removing its approved commit fails closed.
Rollback uses the same mechanism by approving the previous immutable commit.

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

## V2 compatibility

The Desktop plugin keeps the current interface active by default. Workflow and
quality controls appear only when the authenticated runtime handshake reports
`LIVE` with the exact release epoch expected by the plugin. A missing,
unavailable or incompatible handshake leaves the V2 controls dormant; a live
version mismatch blocks sensitive actions with a human-readable message.
For a locked release, the gateway receives the exact manifest hash through
`OBLIST_HERMES_MANIFEST_DIGEST`; a missing or malformed value keeps V2
fail-closed.

All workflow decisions use the existing authenticated plugin REST proxy. API
paths and payload adaptation are centralized in `desktop/plugin.js` and
`dashboard/plugin_api.py` so the server contract can be merged without changing
the UI components.

Pull requests touching this package run Nous Research's pinned official
`hermes plugins validate` action. The local contract checks run with:

```bash
npm run test:hermes-plugin
```
