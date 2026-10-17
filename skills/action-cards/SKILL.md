---
name: oblist-action-cards
description: Create real editable Hermes Desktop cards whenever a Customer Service case needs a customer reply, a vendor request, or both.
---

# The Oblist action cards

Use `prepare_action_card` after investigating the complete live case and applicable
policies.

## Required behavior

- Never present a customer or vendor draft only as prose.
- Create one `CUSTOMER_REPLY` card for the customer-facing response.
- Create one `VENDOR_SIDE_CONVERSATION` card per relevant seller when seller input
  is needed.
- A customer holding reply should simply confirm that The Oblist is checking with
  the relevant partner and will follow up. Do not expose internal uncertainty.
- Vendor requests must contain only the questions relevant to that seller and the
  verified order/product context needed to answer them.
- Draft in the recipient's language. Do not add a signature.
- Never claim that a message has been sent from `prepare_action_card`; it only
  creates a reviewable draft.
- After every successful call, output the returned
  `::oblist-action-card{id="…"}` directive exactly on its own paragraph. Do not
  wrap it in a code block and do not repeat the full draft in prose.
- If several cards are required, render every returned directive as a separate
  paragraph.

## Human learning boundary

Edits, approvals and rejections made in the cards are human evidence. Treat them
as tone and precedent signals, never as official policy. Current validated policy
always outranks historical examples.
