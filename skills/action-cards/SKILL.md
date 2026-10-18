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
- Prefer a Kepler Info Request when the request concerns an order, product,
  production, shipment, tracking, invoice, payment or quality/non-conformity issue.
  Populate `infoRequest` on the vendor card so the approved card can create the real
  vendor dashboard thread and email. For damage, wrong dimensions, poor quality or
  misdescription, use category `ORDER` and item
  `QUALITY_OR_DESCRIPTION_ISSUE` with verified order context.
- Use a manual Intercom side-conversation card only when an Info Request is not an
  appropriate vendor workflow.
- If the CS explicitly chooses an outbound Intercom email instead, set
  `vendorChannel` to `INTERCOM_VENDOR_EMAIL`; the server resolves the matched vendor
  contact without exposing the email address to the model.
- Prepare every immediately useful parallel action in the first response. When
  vendor input is needed, normally create both the customer holding/reply card and
  the appropriate vendor card instead of waiting for a second user prompt.
- Before drafting, check the conversation's current assignee, age and latest
  human-authored messages. Preserve an existing human owner's responsibility;
  never route their case to another operator merely because that owner has no
  Hermes profile.
- Treat Fin answers, bot summaries and automated conversation summaries only as
  unverified leads. Never conclude phishing, fraud, policy, sender identity or a
  business fact from bot-authored content without corroborating human or system
  evidence.
- For an open conversation with no activity for more than 14 days, first decide
  whether responding still creates concrete value. Do not prepare an external
  reply merely to clear an old inbox item.
- Read the available Intercom history before asking the CS operator for
  information that could already be in messages, notes, assignments or side
  conversations.
- A customer holding reply should simply confirm that The Oblist is checking with
  the relevant partner and will follow up. Do not expose internal uncertainty.
- Vendor requests must contain only the questions relevant to that seller and the
  verified order/product context needed to answer them.
- Draft in the recipient's language. Do not add a signature.
- In messages to the CS operator, use only human labels such as "réponse
  client", "demande vendeur" or "Info Request". Never repeat tool parameter
  names, enum values, underscores or internal error codes.
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
