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

function kindLabel(kind) {
  return kind === 'CUSTOMER_REPLY'
    ? 'Customer reply'
    : 'Vendor side conversation'
}

function ActionCard({ ctx, actionId, streaming }) {
  const [card, setCard] = useState(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
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
      setError('')
    } catch {
      setError('This action card could not be loaded.')
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
          ((card.subject || '') !== subject || (card.body || '') !== body)
      ),
    [body, card, subject]
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
          body: body.trim()
        }
      })
      setCard(result.card)
      setSubject(result.card.subject || '')
      setBody(result.card.body || '')
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

  const approve = async () => {
    const approved = await decide('APPROVE')
    if (approved) {
      host.notify({ kind: 'success', message: 'Action approved' })
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
    'aria-label': `${kindLabel(card.kind)} for ${card.recipientLabel}`,
    children: [
      jsxs('div', {
        style: headerStyle,
        children: [
          jsxs('div', {
            style: { display: 'grid', gap: '3px', minWidth: 0 },
            children: [
              jsx('strong', {
                style: { fontSize: '13px', lineHeight: 1.35 },
                children: kindLabel(card.kind)
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
          jsx(Textarea, {
            value: body,
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
                    children: working === 'APPROVE' ? 'Approving…' : 'Approve'
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
              ['APPROVED', 'COPIED'].includes(card.status)
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
              card.kind === 'VENDOR_SIDE_CONVERSATION' &&
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

export default {
  id: 'oblist-action-cards',
  name: 'The Oblist Action Cards',
  register(ctx) {
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
  }
}
