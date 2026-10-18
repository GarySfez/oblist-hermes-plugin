import {
  Badge,
  Button,
  Input,
  Textarea,
  TRANSCRIPT_DIRECTIVE_AREA,
  host
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const inFlightNotificationIds = new Set()
let notificationPollRunning = false

const cardStyle = {
  width: 'min(720px, 100%)',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: '12px',
  background: 'var(--ui-bg-secondary)',
  overflow: 'hidden',
  margin: '10px 0',
  color: 'var(--ui-text-primary)'
}

const headerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '13px 14px 11px',
  borderBottom: '1px solid var(--ui-stroke-secondary)'
}

const bodyStyle = {
  display: 'grid',
  gap: '11px',
  padding: '13px 14px'
}

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap'
}

const footerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '10px',
  flexWrap: 'wrap',
  padding: '10px 14px',
  borderTop: '1px solid var(--ui-stroke-secondary)'
}

function statusLabel(status) {
  return {
    DRAFT: 'Needs review',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    COPIED: 'Ready in Intercom',
    MONITORING: 'Monitoring replies',
    SENT: 'Sent',
    SUPERSEDED: 'Superseded'
  }[status] || status
}

function kindLabel(card) {
  if (card?.metadata?.channel === 'KEPLER_INFO_REQUEST') {
    return 'Vendor Info Request'
  }
  if (card?.metadata?.channel === 'INTERCOM_VENDOR_EMAIL') {
    return 'Vendor email via Intercom'
  }
  return card?.kind === 'CUSTOMER_REPLY'
    ? 'Customer reply'
    : 'Vendor side conversation'
}

function approvalLabel(card) {
  return {
    INTERCOM_CUSTOMER_REPLY: 'Approve & send in Intercom',
    INTERCOM_VENDOR_EMAIL: 'Approve & send vendor email',
    KEPLER_INFO_REQUEST: 'Approve & create Info Request',
    INTERCOM_SIDE_CONVERSATION: 'Approve vendor draft'
  }[card?.metadata?.channel] || 'Approve'
}

function executionLabel(card) {
  return {
    INTERCOM_CUSTOMER_REPLY: 'Send reply in Intercom',
    INTERCOM_VENDOR_EMAIL: 'Send vendor email',
    KEPLER_INFO_REQUEST: 'Create & send Info Request'
  }[card?.metadata?.channel] || 'Execute approved action'
}

const INFO_REQUEST_OPTIONS = {
  PRODUCT: [
    ['MISSING_DIMENSIONS', 'Missing dimensions'],
    ['MISSING_MATERIALS', 'Materials not specified'],
    ['MISSING_WEIGHT', 'Weight missing'],
    ['WRONG_CATEGORY', 'Wrong product category'],
    ['LOW_QUALITY_PHOTOS', 'Photos too low resolution'],
    ['MISSING_LIFESTYLE', 'Need lifestyle photos'],
    ['MISSING_DESCRIPTION', 'Description missing'],
    ['PRICE_INCONSISTENT', 'Price seems inconsistent']
  ],
  VENDOR: [
    ['MISSING_VAT', 'VAT number missing or invalid'],
    ['MISSING_LOGO', 'Brand logo missing or low quality'],
    ['MISSING_BRAND_DESC', 'Brand description missing'],
    ['OUTDATED_ADDRESS', 'Address seems outdated'],
    ['BRAND_HANDLE_ISSUE', 'Brand handle / URL issue'],
    ['TERMS_REACCEPT', 'Re-accept updated terms']
  ],
  ORDER: [
    ['REQUEST_SHIPPING_QUOTE', 'Request a shipping quote'],
    ['MISSING_TRACKING', 'Tracking number missing'],
    ['WRONG_TRACKING', 'Tracking number invalid'],
    ['CONTACT_CARRIER_STATUS', 'Contact carrier for status'],
    ['MISSING_INVOICE', 'Vendor invoice missing'],
    ['SHIPPING_DELAYED', 'Shipping delayed'],
    ['PACKAGING_PROOF', 'Send packaged-item photo'],
    ['FULFILLMENT_CONFIRM', 'Confirm fulfillment status'],
    [
      'QUALITY_OR_DESCRIPTION_ISSUE',
      'Damage, quality or description issue'
    ]
  ],
  PENALTY: [
    ['REJECTION_EXPLANATION', 'Explain rejection and prevention plan'],
    ['REJECTION_STOCK_ACCURACY', 'Fix stock / catalogue accuracy'],
    ['REJECTION_DAMAGE_QA', 'Damage — packaging / QA process'],
    ['REJECTION_REPEATED_NOTICE', 'Repeated rejections — formal notice']
  ],
  PAYMENT: [
    ['MISSING_IBAN', 'IBAN missing or invalid'],
    ['STRIPE_CONNECT_ISSUE', 'Payment setup incomplete'],
    ['PAYOUT_METHOD', 'Payout method needs update'],
    ['BANKING_DOCS', 'Banking documents required']
  ],
  OTHER: []
}

function normalizeInfoRequest(value) {
  if (!value?.sections?.length) return null
  const sections = value.sections.map(section => {
    const allowed = new Set(
      (INFO_REQUEST_OPTIONS[section.category] || []).map(([id]) => id)
    )
    let items = (section.items || []).filter(item => allowed.has(item))
    if (
      items.length === 0 &&
      section.category === 'ORDER' &&
      /(dimension|damage|crack|quality|veneer|description|repair|replacement|refund)/i.test(
        (section.items || []).join(' ')
      )
    ) {
      items = ['QUALITY_OR_DESCRIPTION_ISSUE']
    }
    return { ...section, items }
  })
  const selected = sections.flatMap(section =>
    (section.items || []).map(itemId => ({
      category: section.category,
      itemId
    }))
  )
  const primaryStillSelected = selected.some(
    item =>
      item.category === value.primaryReason?.category &&
      item.itemId === value.primaryReason?.itemId
  )
  return {
    ...value,
    sections,
    primaryReason: primaryStillSelected
      ? value.primaryReason
      : selected[0] || null
  }
}

function InfoRequestFields({ value, onChange, disabled }) {
  if (!value?.sections?.length) return null

  const toggle = (sectionIndex, itemId) => {
    const sections = value.sections.map((section, index) => {
      if (index !== sectionIndex) return section
      const selected = new Set(section.items || [])
      if (selected.has(itemId)) selected.delete(itemId)
      else selected.add(itemId)
      return { ...section, items: [...selected] }
    })
    const allSelected = sections.flatMap(section =>
      (section.items || []).map(itemId => ({
        category: section.category,
        itemId
      }))
    )
    const primaryStillSelected = allSelected.some(
      item =>
        item.category === value.primaryReason?.category &&
        item.itemId === value.primaryReason?.itemId
    )
    onChange({
      ...value,
      sections,
      primaryReason: primaryStillSelected
        ? value.primaryReason
        : allSelected[0] || null
    })
  }

  return jsxs('div', {
    style: {
      display: 'grid',
      gap: '10px',
      padding: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '9px'
    },
    children: [
      jsx('div', {
        style: {
          color: 'var(--ui-text-secondary)',
          fontSize: '12px',
          fontWeight: 650
        },
        children: 'Kepler Info Request details'
      }),
      ...value.sections.map((section, sectionIndex) => {
        const options = INFO_REQUEST_OPTIONS[section.category] || []
        const context = section.contextRef
        const contextLabels =
          context?.scope === 'all'
            ? `All ${context.type}s`
            : (context?.items || []).map(item => item.label).join(', ')
        return jsxs('div', {
          style: { display: 'grid', gap: '7px' },
          children: [
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx(Badge, { children: section.category }),
                contextLabels
                  ? jsx('span', {
                      style: {
                        color: 'var(--ui-text-tertiary)',
                        fontSize: '12px'
                      },
                      children: contextLabels
                    })
                  : null
              ]
            }),
            options.length
              ? jsx('div', {
                  style: {
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fit, minmax(210px, 1fr))',
                    gap: '6px'
                  },
                  children: options.map(([itemId, label]) =>
                    jsxs('label', {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '7px',
                        minHeight: '32px',
                        padding: '6px 8px',
                        border: '1px solid var(--ui-stroke-secondary)',
                        borderRadius: '7px',
                        color: 'var(--ui-text-secondary)',
                        fontSize: '12px',
                        cursor: disabled ? 'default' : 'pointer'
                      },
                      children: [
                        jsx('input', {
                          type: 'checkbox',
                          checked: (section.items || []).includes(itemId),
                          disabled,
                          onChange: () => toggle(sectionIndex, itemId)
                        }),
                        jsx('span', { children: label })
                      ]
                    })
                  )
                })
              : jsx('span', {
                  style: {
                    color: 'var(--ui-text-tertiary)',
                    fontSize: '12px'
                  },
                  children: 'Free-text request'
                })
          ]
        })
      })
    ]
  })
}

function ActionCard({ ctx, actionId, streaming }) {
  const [card, setCard] = useState(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [infoRequest, setInfoRequest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const load = useCallback(async () => {
    if (!UUID_RE.test(actionId)) return
    try {
      const result = await ctx.rest(`/actions/${actionId}`)
      setCard(result.card)
      setSubject(result.card.subject || '')
      setBody(result.card.body || '')
      setInfoRequest(
        normalizeInfoRequest(result.card.metadata?.infoRequest || null)
      )
      setError('')
    } catch (loadError) {
      const detail =
        loadError instanceof Error ? loadError.message.slice(0, 180) : ''
      setError(
        detail
          ? `This action card could not be loaded: ${detail}`
          : 'This action card could not be loaded.'
      )
    } finally {
      setLoading(false)
    }
  }, [actionId, ctx])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (card?.status !== 'MONITORING') return undefined
    const timer = window.setInterval(load, 30_000)
    return () => window.clearInterval(timer)
  }, [card?.status, load])

  const dirty = useMemo(
    () =>
      Boolean(
        card &&
          ((card.subject || '') !== subject ||
            (card.body || '') !== body ||
            JSON.stringify(card.metadata?.infoRequest || null) !==
              JSON.stringify(infoRequest))
      ),
    [body, card, infoRequest, subject]
  )

  const canEdit = card && ['DRAFT', 'APPROVED'].includes(card.status)

  const save = async () => {
    if (!card || !dirty || !body.trim()) return card
    setWorking('save')
    setError('')
    try {
      const result = await ctx.rest(`/actions/${card.id}/edit`, {
        method: 'POST',
        body: {
          expectedVersion: card.version,
          subject: subject.trim() || null,
          body: body.trim(),
          ...(infoRequest ? { infoRequest } : {})
        }
      })
      setCard(result.card)
      setSubject(result.card.subject || '')
      setBody(result.card.body || '')
      setInfoRequest(
        normalizeInfoRequest(result.card.metadata?.infoRequest || null)
      )
      host.notify({ kind: 'success', message: 'Draft saved' })
      return result.card
    } catch {
      setError('The draft changed elsewhere. Reload it before continuing.')
      return null
    } finally {
      setWorking('')
    }
  }

  const decide = async (decision, options = {}) => {
    if (!card) return null
    let current = card
    if (dirty) {
      current = await save()
      if (!current) return null
    }
    setWorking(decision)
    setError('')
    try {
      const result = await ctx.rest(`/actions/${current.id}/decision`, {
        method: 'POST',
        body: {
          expectedVersion: current.version,
          decision,
          ...options
        }
      })
      setCard(result.card)
      setRejecting(false)
      setRejectReason('')
      return result.card
    } catch {
      setError('The action could not be recorded. Reload and try again.')
      return null
    } finally {
      setWorking('')
    }
  }

  const reject = async () => {
    const rejected = await decide('REJECT', {
      reason: rejectReason.trim() || 'Rejected from Hermes Desktop'
    })
    if (rejected) {
      host.notify({ kind: 'success', message: 'Action rejected' })
    }
  }

  const copyAndOpen = async () => {
    const copied = await decide('COPY')
    if (!copied) return
    await ctx.os.writeClipboard(copied.body)
    const conversationUrl = copied.metadata?.conversationUrl
    if (typeof conversationUrl === 'string' && conversationUrl) {
      await ctx.os.openExternal(conversationUrl)
    }
    host.notify({
      kind: 'success',
      message:
        copied.kind === 'VENDOR_SIDE_CONVERSATION'
          ? 'Vendor request copied — create the side conversation in Intercom'
          : 'Customer reply copied'
    })
  }

  const startMonitoring = async () => {
    const monitored = await decide('START_MONITORING')
    if (monitored) {
      host.notify({
        kind: 'success',
        message: 'Hermes is now monitoring this conversation'
      })
    }
  }

  const executeApproved = async approvedCard => {
    if (!approvedCard || approvedCard.status !== 'APPROVED') return
    setWorking('execute')
    setError('')
    try {
      const result = await ctx.rest(`/actions/${approvedCard.id}/execute`, {
        method: 'POST',
        body: { expectedVersion: approvedCard.version }
      })
      setCard(result.card)
      const channel = result.execution.channel
      host.notify({
        kind: 'success',
        message:
          channel === 'KEPLER_INFO_REQUEST'
            ? `Info Request #${result.execution.threadId} sent to the vendor`
            : channel === 'INTERCOM_VENDOR_EMAIL'
              ? 'Vendor email sent through Intercom'
              : 'Customer reply sent through Intercom'
      })
      return result.card
    } catch (executeError) {
      const detail =
        executeError instanceof Error
          ? executeError.message.slice(0, 180)
          : ''
      setError(
        detail
          ? `The approved action was not confirmed: ${detail}`
          : 'The approved action was not confirmed. Retry safely.'
      )
      return null
    } finally {
      setWorking('')
    }
  }

  const approve = async () => {
    const approved = await decide('APPROVE')
    if (!approved) return
    if (
      [
        'INTERCOM_CUSTOMER_REPLY',
        'INTERCOM_VENDOR_EMAIL',
        'KEPLER_INFO_REQUEST'
      ].includes(approved.metadata?.channel)
    ) {
      await executeApproved(approved)
      return
    }
    host.notify({ kind: 'success', message: 'Action approved' })
  }

  if (!UUID_RE.test(actionId)) return null
  if (streaming || loading) {
    return jsx('div', {
      style: cardStyle,
      children: jsx('div', {
        style: { padding: '14px', color: 'var(--ui-text-tertiary)' },
        children: 'Loading action card…'
      })
    })
  }
  if (!card) {
    return jsx('div', {
      style: cardStyle,
      children: jsxs('div', {
        style: { ...rowStyle, padding: '12px 14px' },
        children: [
          jsx('span', {
            style: { color: 'var(--ui-danger)' },
            children: error || 'Action card unavailable.'
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: load,
            children: 'Retry'
          })
        ]
      })
    })
  }

  const finalState = ['REJECTED', 'MONITORING', 'SENT', 'SUPERSEDED'].includes(
    card.status
  )

  return jsxs('section', {
    style: cardStyle,
    'aria-label': `${kindLabel(card)} for ${card.recipientLabel}`,
    children: [
      jsxs('div', {
        style: headerStyle,
        children: [
          jsxs('div', {
            style: { display: 'grid', gap: '3px', minWidth: 0 },
            children: [
              jsx('strong', {
                style: { fontSize: '13px', lineHeight: 1.35 },
                children: kindLabel(card)
              }),
              jsx('span', {
                style: {
                  color: 'var(--ui-text-tertiary)',
                  fontSize: '12px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                },
                children: `To ${card.recipientLabel} · ${card.language.toUpperCase()}`
              })
            ]
          }),
          jsxs('div', {
            style: rowStyle,
            children: [
              dirty ? jsx(Badge, { children: 'Unsaved edits' }) : null,
              jsx(Badge, { children: statusLabel(card.status) })
            ]
          })
        ]
      }),
      jsxs('div', {
        style: bodyStyle,
        children: [
          card.kind === 'VENDOR_SIDE_CONVERSATION'
            ? jsx(Input, {
                value: subject,
                disabled: !canEdit || Boolean(working),
                placeholder: 'Subject',
                'aria-label': 'Message subject',
                onChange: event => setSubject(event.target.value)
              })
            : null,
          infoRequest
            ? jsx(InfoRequestFields, {
                value: infoRequest,
                onChange: setInfoRequest,
                disabled: !canEdit || Boolean(working)
              })
            : null,
          jsx(Textarea, {
            value: body,
            maxLength: infoRequest ? 4000 : 10000,
            rows: Math.min(14, Math.max(6, body.split('\n').length + 2)),
            disabled: !canEdit || Boolean(working),
            'aria-label': 'Editable message',
            onChange: event => setBody(event.target.value),
            style: {
              resize: canEdit ? 'vertical' : 'none',
              lineHeight: 1.5,
              minHeight: '132px'
            }
          }),
          card.rationale
            ? jsx('details', {
                children: [
                  jsx('summary', {
                    style: {
                      cursor: 'pointer',
                      color: 'var(--ui-text-tertiary)',
                      fontSize: '12px'
                    },
                    children: 'Why Hermes proposed this'
                  }),
                  jsx('p', {
                    style: {
                      margin: '7px 0 0',
                      color: 'var(--ui-text-secondary)',
                      fontSize: '12px',
                      lineHeight: 1.45
                    },
                    children: card.rationale
                  })
                ]
              })
            : null,
          error
            ? jsx('div', {
                role: 'alert',
                style: { color: 'var(--ui-danger)', fontSize: '12px' },
                children: error
              })
            : null,
          rejecting
            ? jsxs('div', {
                style: {
                  display: 'grid',
                  gap: '8px',
                  padding: '10px',
                  border: '1px solid var(--ui-stroke-secondary)',
                  borderRadius: '8px'
                },
                children: [
                  jsx(Input, {
                    value: rejectReason,
                    placeholder: 'Why are you rejecting this draft? (optional)',
                    onChange: event => setRejectReason(event.target.value),
                    autoFocus: true
                  }),
                  jsxs('div', {
                    style: rowStyle,
                    children: [
                      jsx(Button, {
                        size: 'sm',
                        onClick: reject,
                        disabled: Boolean(working),
                        children: 'Confirm rejection'
                      }),
                      jsx(Button, {
                        size: 'sm',
                        variant: 'secondary',
                        onClick: () => setRejecting(false),
                        disabled: Boolean(working),
                        children: 'Cancel'
                      })
                    ]
                  })
                ]
              })
            : null
        ]
      }),
      jsxs('div', {
        style: footerStyle,
        children: [
          jsxs('div', {
            style: rowStyle,
            children: [
              canEdit
                ? jsx(Button, {
                    size: 'sm',
                    variant: 'secondary',
                    onClick: save,
                    disabled: !dirty || Boolean(working) || !body.trim(),
                    children: working === 'save' ? 'Saving…' : 'Save edits'
                  })
                : null,
              card.status === 'DRAFT'
                ? jsx(Button, {
                    size: 'sm',
                    onClick: approve,
                    disabled: Boolean(working) || !body.trim(),
                    children:
                      working === 'APPROVE' || working === 'execute'
                        ? 'Sending…'
                        : approvalLabel(card)
                  })
                : null,
              !finalState && card.status !== 'REJECTED'
                ? jsx(Button, {
                    size: 'sm',
                    variant: 'secondary',
                    onClick: () => setRejecting(true),
                    disabled: Boolean(working),
                    children: 'Reject'
                  })
                : null
            ]
          }),
          jsxs('div', {
            style: rowStyle,
            children: [
              ['APPROVED', 'COPIED'].includes(card.status) &&
              (card.metadata?.channel === 'INTERCOM_SIDE_CONVERSATION' ||
                card.metadata?.channel === 'INTERCOM_CUSTOMER_REPLY')
                ? jsx(Button, {
                    size: 'sm',
                    onClick: copyAndOpen,
                    disabled: Boolean(working),
                    children:
                      card.kind === 'VENDOR_SIDE_CONVERSATION'
                        ? 'Copy & open Intercom'
                        : 'Copy approved reply'
                  })
                : null,
              [
                'INTERCOM_CUSTOMER_REPLY',
                'INTERCOM_VENDOR_EMAIL',
                'KEPLER_INFO_REQUEST'
              ].includes(card.metadata?.channel) &&
              card.status === 'APPROVED'
                ? jsx(Button, {
                    size: 'sm',
                    onClick: () => executeApproved(card),
                    disabled: Boolean(working),
                    children:
                      working === 'execute'
                        ? 'Sending…'
                        : executionLabel(card)
                  })
                : null,
              card.kind === 'VENDOR_SIDE_CONVERSATION' &&
              card.metadata?.channel === 'INTERCOM_SIDE_CONVERSATION' &&
              card.status === 'COPIED'
                ? jsx(Button, {
                    size: 'sm',
                    onClick: startMonitoring,
                    disabled: Boolean(working),
                    children:
                      working === 'START_MONITORING'
                        ? 'Starting…'
                        : 'Side conversation created'
                  })
                : null
            ]
          })
        ]
      })
    ]
  })
}

const CS_VIEW_OPTIONS = [
  ['TEAM_SUPPORT', 'Support team'],
  ['MY_INBOX', 'My inbox'],
  ['ESCALATION_RISK', 'Escalation'],
  ['FRUSTRATED_PRIORITY', 'Frustrated'],
  ['ETA_REQUEST', 'ETA'],
  ['SHIPPING_QUOTE', 'Shipping quotes']
]

function resolutionPrompt(situation) {
  if ((situation.signals || []).includes('TEST_ONLY')) {
    return [
      'Ceci est un test de notification Hermes, pas un dossier client réel.',
      'Confirme que le bouton Resolve now a correctement ouvert ce chat dédié.',
      'Ne contacte personne et ne prépare aucune action externe.'
    ].join('\n')
  }
  return [
    `Résous maintenant cette situation CS : ${situation.id}.`,
    situation.title,
    situation.summary,
    `Action recommandée : ${situation.nextAction}.`,
    situation.orderNumber ? `Commande : #${situation.orderNumber}.` : '',
    situation.conversationRef
      ? `Conversation Intercom : ${situation.conversationRef}.`
      : '',
    'Récupère à nouveau le contexte live complet, vérifie les actions déjà effectuées, puis prépare toutes les cartes nécessaires sans envoyer avant mon approbation.'
  ]
    .filter(Boolean)
    .join('\n')
}

async function openSituationChat(situation, profile) {
  const prompt = resolutionPrompt(situation)
  const title = `CS · ${situation.id}`.slice(0, 180)
  try {
    const listed = await host.request('session.list', {
      title,
      ...(profile ? { profile } : {})
    })
    const existing = listed?.sessions?.[0]
    let session
    if (existing) {
      session = await host.request('session.resume', {
        session_id: existing.resolved_id || existing.id,
        defer_history: true,
        ...(profile ? { profile } : {})
      })
    } else {
      session = await host.request('session.create', {
        title,
        idempotency_key: `cs-situation:${situation.id}`,
        follow_profile_config: true,
        ...(profile ? { profile } : {})
      })
    }
    const runtimeId = session?.session_id
    const storedId =
      session?.stored_session_id || existing?.resolved_id || existing?.id
    if (!runtimeId || !storedId) throw new Error('Session creation failed')
    await host.request('prompt.submit', {
      session_id: runtimeId,
      text: prompt
    })
    host.navigate(`/${encodeURIComponent(storedId)}`)
    return true
  } catch {
    const sessionId = host.state.focusedSessionId.get()
    const ok = await host.composer.setDraft(sessionId, prompt)
    host.composer.focus(sessionId)
    if (ok) return true
    host.notify({
      kind: 'error',
      message: 'Could not open the dedicated resolution chat'
    })
    return false
  }
}

function OperationsOverview({
  ctx,
  streaming,
  operatorRef,
  initialView
}) {
  const defaultView =
    initialView ||
    (operatorRef ? 'MY_INBOX' : 'TEAM_SUPPORT')
  const [activeView, setActiveView] = useState(defaultView)
  const [overview, setOverview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({
        view: activeView,
        ...(operatorRef ? { operator: operatorRef } : {})
      }).toString()
      const result = await ctx.rest(`/overview?${query}`, {
        timeoutMs: 60_000
      })
      setOverview(result)
      setError('')
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message.slice(0, 220)
          : 'CS overview unavailable'
      )
    } finally {
      setLoading(false)
    }
  }, [activeView, ctx, operatorRef])

  useEffect(() => {
    load()
  }, [load])

  const resolveNow = async situation => {
    const profile =
      overview.scope?.operatorRef ||
      host.state.focusedSessionProfile.get() ||
      undefined
    await openSituationChat(situation, profile)
  }

  if (streaming || loading) {
    return jsx('section', {
      style: cardStyle,
      children: jsx('div', {
        style: { padding: '14px', color: 'var(--ui-text-tertiary)' },
        children: 'Building the global CS overview…'
      })
    })
  }
  if (!overview) {
    return jsx('section', {
      style: cardStyle,
      children: jsxs('div', {
        style: { ...rowStyle, padding: '12px 14px' },
        children: [
          jsx('span', {
            style: { color: 'var(--ui-danger)', fontSize: '12px' },
            children: error || 'Global CS overview unavailable.'
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: load,
            children: 'Retry'
          })
        ]
      })
    })
  }

  return jsxs('section', {
    style: { ...cardStyle, width: 'min(820px, 100%)' },
    'aria-label': 'Global Customer Service priorities',
    children: [
      jsxs('div', {
        style: headerStyle,
        children: [
          jsxs('div', {
            style: { display: 'grid', gap: '3px' },
            children: [
              jsx('strong', {
                style: { fontSize: '14px' },
                children: 'Customer Service priorities'
              }),
              jsx('span', {
                style: {
                  color: 'var(--ui-text-tertiary)',
                  fontSize: '12px'
                },
                children: `${overview.scope?.operatorName ? `${overview.scope.operatorName} · ` : ''}${overview.summary.supportOpen} open · ${overview.summary.supportUnanswered} awaiting a reply`
              })
            ]
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: load,
            children: 'Refresh'
          })
        ]
      }),
      jsx('div', {
        style: {
          display: 'flex',
          gap: '6px',
          flexWrap: 'wrap',
          padding: '10px 14px 0'
        },
        children: CS_VIEW_OPTIONS.filter(
          ([key]) => key !== 'MY_INBOX' || Boolean(operatorRef)
        ).map(([key, label]) =>
          jsx(Button, {
            size: 'sm',
            variant: activeView === key ? 'primary' : 'secondary',
            onClick: () => setActiveView(key),
            children: label
          })
        )
      }),
      jsx('div', {
        style: {
          ...bodyStyle,
          gap: '8px',
          maxHeight: '620px',
          overflow: 'auto'
        },
        children:
          overview.situations.length === 0
            ? jsx('span', {
                style: {
                  color: 'var(--ui-text-tertiary)',
                  fontSize: '13px'
                },
                children: 'No actionable situation found.'
              })
            : overview.situations.map(situation =>
                jsxs('article', {
                  style: {
                    display: 'grid',
                    gap: '8px',
                    padding: '11px',
                    border: '1px solid var(--ui-stroke-secondary)',
                    borderRadius: '9px'
                  },
                  children: [
                    jsxs('div', {
                      style: {
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: '10px'
                      },
                      children: [
                        jsxs('div', {
                          style: { display: 'grid', gap: '4px' },
                          children: [
                            jsx('strong', {
                              style: { fontSize: '12px', lineHeight: 1.4 },
                              children: situation.title
                            }),
                            jsx('span', {
                              style: {
                                color: 'var(--ui-text-secondary)',
                                fontSize: '12px',
                                lineHeight: 1.45
                              },
                              children: situation.summary
                            })
                          ]
                        }),
                        jsx(Badge, { children: situation.priority })
                      ]
                    }),
                    jsx('span', {
                      style: {
                        color: 'var(--ui-text-tertiary)',
                        fontSize: '11px'
                      },
                      children: situation.nextAction
                    }),
                    jsxs('div', {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        flexWrap: 'wrap'
                      },
                      children: [
                        jsx('div', {
                          style: rowStyle,
                          children: (situation.links || []).map(link =>
                            jsx(Button, {
                              size: 'sm',
                              variant: 'secondary',
                              onClick: () => ctx.os.openExternal(link.url),
                              children: link.label
                            })
                          )
                        }),
                        jsx(Button, {
                          size: 'sm',
                          onClick: () => resolveNow(situation),
                          children: 'Resolve now'
                        })
                      ]
                    })
                  ]
                })
              )
      })
    ]
  })
}

async function pollDesktopNotifications(ctx) {
  if (notificationPollRunning) return
  notificationPollRunning = true
  const focusedProfile = host.state.focusedSessionProfile.get()
  const homeProfile = host.state.profile.get()
  const profile = focusedProfile || homeProfile || ''
  const operator =
    profile === 'lyse' || profile === 'philippine' ? profile : ''
  try {
    const query = operator
      ? `?operator=${encodeURIComponent(operator)}`
      : ''
    const data = await ctx.rest(`/notifications${query}`, {
      timeoutMs: 20_000
    })
    const notifications = Array.isArray(data?.notifications)
      ? data.notifications
      : []
    for (const notification of notifications) {
      if (
        !UUID_RE.test(notification?.id || '') ||
        inFlightNotificationIds.has(notification.id)
      ) {
        continue
      }
      inFlightNotificationIds.add(notification.id)
      const situation = notification?.payload?.situation
      try {
        if (!situation?.id) throw new Error('INVALID_SITUATION_PAYLOAD')
        const resolve = () =>
          openSituationChat(situation, operator || profile || undefined)
        host.notify({
          kind: 'info',
          message: `${notification.title} · ${notification.body}`
        })
        await ctx.os.notify({
          title: notification.title,
          body: notification.body,
          onActivate: resolve,
          actions: [
            {
              id: 'resolve-now',
              label: 'Resolve now',
              onAction: resolve
            }
          ]
        })
        await ctx.rest(
          `/notifications/${notification.id}/outcome${query}`,
          {
            method: 'POST',
            body: { outcome: 'DELIVERED' },
            timeoutMs: 20_000
          }
        )
      } catch (deliveryError) {
        await ctx
          .rest(`/notifications/${notification.id}/outcome${query}`, {
            method: 'POST',
            body: {
              outcome: 'RETRY',
              errorCode:
                deliveryError instanceof Error
                  ? deliveryError.message.slice(0, 100)
                  : 'DESKTOP_DELIVERY_FAILED'
            },
            timeoutMs: 20_000
          })
          .catch(() => undefined)
      } finally {
        inFlightNotificationIds.delete(notification.id)
      }
    }
  } catch {
    // Keep notifications pending while Desktop or the remote gateway is offline.
  } finally {
    notificationPollRunning = false
  }
}

export default {
  id: 'oblist-action-cards',
  name: 'The Oblist Action Cards',
  register(ctx) {
    void pollDesktopNotifications(ctx)
    const notificationTimer = window.setInterval(
      () => void pollDesktopNotifications(ctx),
      30_000
    )
    ctx.onDispose(() => window.clearInterval(notificationTimer))
    ctx.register({
      id: 'oblist-action-card-directive',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'oblist-action-card',
        render: ({ attrs, streaming }) =>
          jsx(ActionCard, {
            ctx,
            actionId: attrs.id || '',
            streaming
          })
      }
    })
    ctx.register({
      id: 'oblist-ops-overview-directive',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'oblist-ops-overview',
        render: ({ attrs, streaming }) =>
          jsx(OperationsOverview, {
            ctx,
            streaming,
            operatorRef:
              attrs.operator === 'lyse' || attrs.operator === 'philippine'
                ? attrs.operator
                : '',
            initialView: attrs.view || attrs.scope || ''
          })
      }
    })
  }
}
