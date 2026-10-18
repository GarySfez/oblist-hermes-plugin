import {
  atom,
  Badge,
  Button,
  Codicon,
  COMPOSER_AREAS,
  Input,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Textarea,
  TRANSCRIPT_DIRECTIVE_AREA,
  host,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const inFlightNotificationIds = new Set()
const notificationPollRunning = new Set()
const notificationInboxAtom = atom({
  activeOperator: '',
  byOperator: {
    '': [],
    lyse: [],
    philippine: []
  }
})

const INTRO_MESSAGE =
  'Comment puis-je vous aider à résoudre un cas du service client aujourd’hui ?'
const QUICK_PROMPT_USAGE_KEY = 'cs-quick-prompt-usage-v1'
const CS_QUICK_PROMPTS = [
  {
    id: 'priorities',
    label: 'Priorités du jour',
    icon: 'list-ordered',
    text:
      'Quelles situations méritent réellement mon attention aujourd’hui ? Classe-les par priorité et propose la prochaine action utile.'
  },
  {
    id: 'inbox',
    label: 'Ma boîte de réception',
    icon: 'inbox',
    text:
      'Regarde ma boîte de réception, classe les dossiers qui demandent une action et affiche la liste interactive. N’envoie aucun message.'
  },
  {
    id: 'resolve',
    label: 'Résoudre un cas',
    icon: 'sparkle',
    text:
      'Aide-moi à résoudre ce cas avec tout le contexte disponible. Ne me demande pas une information que tu peux retrouver : '
  }
]

function installCsIntroMessage() {
  const originals = new Map()
  let scheduled = false
  const apply = () => {
    const root = document.querySelector('[data-slot="aui_intro"]')
    const tagline = root?.querySelector('p:not(.fit-text)')
    if (!tagline) return
    if (!originals.has(tagline)) originals.set(tagline, tagline.textContent)
    if (tagline.textContent !== INTRO_MESSAGE) {
      tagline.textContent = INTRO_MESSAGE
    }
  }
  const observer = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      apply()
    })
  })
  apply()
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  })
  return () => {
    observer.disconnect()
    for (const [element, original] of originals) {
      if (element.isConnected) element.textContent = original
    }
  }
}

function quickPromptActions(ctx, busy) {
  if (busy) return []
  const usage = ctx.storage.get(QUICK_PROMPT_USAGE_KEY, {})
  return [...CS_QUICK_PROMPTS]
    .sort(
      (left, right) =>
        Number(usage?.[right.id] || 0) - Number(usage?.[left.id] || 0)
    )
    .map(prompt => ({
      id: `oblist-${prompt.id}`,
      label: prompt.label,
      icon: prompt.icon,
      run: async sessionId => {
        const latest = ctx.storage.get(QUICK_PROMPT_USAGE_KEY, {})
        await ctx.storage.set(QUICK_PROMPT_USAGE_KEY, {
          ...latest,
          [prompt.id]: Number(latest?.[prompt.id] || 0) + 1
        })
        await host.composer.setDraft(sessionId, prompt.text)
        host.composer.focus(sessionId)
      }
    }))
}

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
    DRAFT: 'À vérifier',
    APPROVED: 'Approuvé',
    REJECTED: 'Refusé',
    COPIED: 'Prêt dans Intercom',
    MONITORING: 'Suivi actif',
    SENT: 'Envoyé',
    SUPERSEDED: 'Remplacé'
  }[status] || 'État inconnu'
}

function kindLabel(card) {
  if (card?.metadata?.channel === 'KEPLER_INFO_REQUEST') {
    return "Demande d’information au vendeur"
  }
  if (card?.metadata?.channel === 'INTERCOM_VENDOR_EMAIL') {
    return 'E-mail au vendeur via Intercom'
  }
  return card?.kind === 'CUSTOMER_REPLY'
    ? 'Réponse au client'
    : 'Demande au vendeur'
}

function approvalLabel(card) {
  return {
    INTERCOM_CUSTOMER_REPLY: 'Approuver et envoyer dans Intercom',
    INTERCOM_VENDOR_EMAIL: "Approuver et envoyer l’e-mail",
    KEPLER_INFO_REQUEST: "Approuver et créer l’Info Request",
    INTERCOM_SIDE_CONVERSATION: 'Approuver le brouillon vendeur'
  }[card?.metadata?.channel] || 'Approuver'
}

function executionLabel(card) {
  return {
    INTERCOM_CUSTOMER_REPLY: 'Envoyer la réponse dans Intercom',
    INTERCOM_VENDOR_EMAIL: "Envoyer l’e-mail au vendeur",
    KEPLER_INFO_REQUEST: "Créer et envoyer l’Info Request"
  }[card?.metadata?.channel] || "Exécuter l’action approuvée"
}

const INFO_REQUEST_OPTIONS = {
  PRODUCT: [
    ['MISSING_DIMENSIONS', 'Dimensions manquantes'],
    ['MISSING_MATERIALS', 'Matériaux non précisés'],
    ['MISSING_WEIGHT', 'Poids manquant'],
    ['WRONG_CATEGORY', 'Catégorie produit incorrecte'],
    ['LOW_QUALITY_PHOTOS', 'Photos de qualité insuffisante'],
    ['MISSING_LIFESTYLE', "Photos d’ambiance nécessaires"],
    ['MISSING_DESCRIPTION', 'Description manquante'],
    ['PRICE_INCONSISTENT', 'Prix à vérifier']
  ],
  VENDOR: [
    ['MISSING_VAT', 'Numéro de TVA manquant ou invalide'],
    ['MISSING_LOGO', 'Logo de marque manquant ou inexploitable'],
    ['MISSING_BRAND_DESC', 'Description de marque manquante'],
    ['OUTDATED_ADDRESS', 'Adresse à mettre à jour'],
    ['BRAND_HANDLE_ISSUE', 'Adresse web de la marque à corriger'],
    ['TERMS_REACCEPT', 'Nouvelles conditions à accepter']
  ],
  ORDER: [
    ['REQUEST_SHIPPING_QUOTE', 'Demander un devis de livraison'],
    ['MISSING_TRACKING', 'Numéro de suivi manquant'],
    ['WRONG_TRACKING', 'Numéro de suivi invalide'],
    ['CONTACT_CARRIER_STATUS', 'Demander le statut au transporteur'],
    ['MISSING_INVOICE', 'Facture vendeur manquante'],
    ['SHIPPING_DELAYED', 'Livraison en retard'],
    ['PACKAGING_PROOF', 'Demander une photo du colis préparé'],
    ['FULFILLMENT_CONFIRM', 'Confirmer la prise en charge de la commande'],
    [
      'QUALITY_OR_DESCRIPTION_ISSUE',
      'Problème de dommage, qualité ou description'
    ]
  ],
  PENALTY: [
    ['REJECTION_EXPLANATION', 'Expliquer le refus et le plan de prévention'],
    ['REJECTION_STOCK_ACCURACY', 'Corriger le stock ou le catalogue'],
    ['REJECTION_DAMAGE_QA', "Revoir l’emballage et le contrôle qualité"],
    ['REJECTION_REPEATED_NOTICE', 'Refus répétés — rappel formel']
  ],
  PAYMENT: [
    ['MISSING_IBAN', 'IBAN manquant ou invalide'],
    ['STRIPE_CONNECT_ISSUE', 'Configuration des paiements incomplète'],
    ['PAYOUT_METHOD', 'Mode de versement à mettre à jour'],
    ['BANKING_DOCS', 'Documents bancaires nécessaires']
  ],
  OTHER: []
}

const INFO_REQUEST_CATEGORY_LABELS = {
  PRODUCT: 'Produit',
  VENDOR: 'Vendeur',
  ORDER: 'Commande',
  PENALTY: 'Pénalité',
  PAYMENT: 'Paiement',
  OTHER: 'Autre'
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
        children: "Détails de l’Info Request"
      }),
      ...value.sections.map((section, sectionIndex) => {
        const options = INFO_REQUEST_OPTIONS[section.category] || []
        const context = section.contextRef
        const contextLabels =
          context?.scope === 'all'
            ? context.type === 'product'
              ? 'Tous les produits concernés'
              : 'Toute la commande'
            : (context?.items || []).map(item => item.label).join(', ')
        return jsxs('div', {
          style: { display: 'grid', gap: '7px' },
          children: [
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx(Badge, {
                  children:
                    INFO_REQUEST_CATEGORY_LABELS[section.category] ||
                    'Catégorie à vérifier'
                }),
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
                  children: 'Demande libre'
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
          ? `Cette carte n’a pas pu être chargée : ${detail}`
          : 'Cette carte n’a pas pu être chargée.'
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
      host.notify({ kind: 'success', message: 'Brouillon enregistré' })
      return result.card
    } catch {
      setError(
        'Ce brouillon a été modifié ailleurs. Rechargez-le avant de continuer.'
      )
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
      setError(
        "L’action n’a pas pu être enregistrée. Rechargez puis réessayez."
      )
      return null
    } finally {
      setWorking('')
    }
  }

  const reject = async () => {
    const rejected = await decide('REJECT', {
      reason: rejectReason.trim() || 'Refusé depuis Hermes Desktop'
    })
    if (rejected) {
      host.notify({ kind: 'success', message: 'Action refusée' })
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
          ? 'Demande vendeur copiée — créez la conversation associée dans Intercom'
          : 'Réponse client copiée'
    })
  }

  const startMonitoring = async () => {
    const monitored = await decide('START_MONITORING')
    if (monitored) {
      host.notify({
        kind: 'success',
        message: 'Hermes suit maintenant cette conversation'
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
            ? `Info Request n° ${result.execution.threadId} envoyée au vendeur`
            : channel === 'INTERCOM_VENDOR_EMAIL'
              ? 'E-mail vendeur envoyé via Intercom'
              : 'Réponse client envoyée via Intercom'
      })
      return result.card
    } catch (executeError) {
      const detail =
        executeError instanceof Error
          ? executeError.message.slice(0, 180)
          : ''
      setError(
        detail
          ? `L’action approuvée n’a pas été confirmée : ${detail}`
          : "L’action approuvée n’a pas été confirmée. Vous pouvez réessayer sans risque de doublon."
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
    host.notify({ kind: 'success', message: 'Action approuvée' })
  }

  if (!UUID_RE.test(actionId)) return null
  if (streaming || loading) {
    return jsx('div', {
      style: cardStyle,
      children: jsx('div', {
        style: { padding: '14px', color: 'var(--ui-text-tertiary)' },
        children: 'Chargement de la carte…'
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
            children: error || 'Carte indisponible.'
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: load,
            children: 'Réessayer'
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
    'aria-label': `${kindLabel(card)} pour ${card.recipientLabel}`,
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
                children: `Destinataire : ${card.recipientLabel} · ${card.language.toUpperCase()}`
              })
            ]
          }),
          jsxs('div', {
            style: rowStyle,
            children: [
              dirty ? jsx(Badge, { children: 'Modifications non enregistrées' }) : null,
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
                placeholder: 'Objet',
                'aria-label': 'Objet du message',
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
            'aria-label': 'Message modifiable',
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
                    children: 'Pourquoi Hermes propose cette action'
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
                    placeholder: 'Pourquoi refusez-vous ce brouillon ? (facultatif)',
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
                        children: 'Confirmer le refus'
                      }),
                      jsx(Button, {
                        size: 'sm',
                        variant: 'secondary',
                        onClick: () => setRejecting(false),
                        disabled: Boolean(working),
                        children: 'Annuler'
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
                    children:
                      working === 'save'
                        ? 'Enregistrement…'
                        : 'Enregistrer les modifications'
                  })
                : null,
              card.status === 'DRAFT'
                ? jsx(Button, {
                    size: 'sm',
                    onClick: approve,
                    disabled: Boolean(working) || !body.trim(),
                    children:
                      working === 'APPROVE' || working === 'execute'
                        ? 'Envoi…'
                        : approvalLabel(card)
                  })
                : null,
              !finalState && card.status !== 'REJECTED'
                ? jsx(Button, {
                    size: 'sm',
                    variant: 'secondary',
                    onClick: () => setRejecting(true),
                    disabled: Boolean(working),
                    children: 'Refuser'
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
                        ? 'Copier et ouvrir Intercom'
                        : 'Copier la réponse approuvée'
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
                        ? 'Envoi…'
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
                        ? 'Activation…'
                        : 'Conversation vendeur créée'
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
  ['TEAM_SUPPORT', 'Équipe Support'],
  ['MY_INBOX', 'Ma boîte de réception'],
  ['ESCALATION_RISK', "Risque d’escalade"],
  ['FRUSTRATED_PRIORITY', 'Clients mécontents'],
  ['ETA_REQUEST', 'Demandes de délai'],
  ['SHIPPING_QUOTE', 'Devis de livraison']
]

function priorityLabel(priority) {
  return {
    CRITICAL: 'Critique',
    URGENT: 'Urgent',
    HIGH: 'Priorité élevée',
    MEDIUM: 'Priorité normale',
    LOW: 'Priorité faible'
  }[priority] || 'À évaluer'
}

function resolutionPrompt(situation) {
  if ((situation.signals || []).includes('TEST_ONLY')) {
    return [
      'Ceci est un test de notification Hermes, pas un dossier client réel.',
      'Confirme que le bouton Résoudre maintenant a correctement ouvert ce chat dédié.',
      'Ne contacte personne et ne prépare aucune action externe.'
    ].join('\n')
  }
  return [
    'Résous maintenant cette situation du service client.',
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
  const title = `CS · ${
    situation.orderNumber
      ? `Commande #${situation.orderNumber}`
      : situation.title || 'Dossier à résoudre'
  }`.slice(0, 180)
  const testOnly = (situation.signals || []).includes('TEST_ONLY')
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
        model: testOnly
          ? 'anthropic/claude-haiku-5.5'
          : 'anthropic/claude-sonnet-5.5',
        provider: 'nous',
        reasoning_effort: testOnly ? 'low' : 'medium',
        ...(profile ? { profile } : {})
      })
    }
    const runtimeId = session?.session_id
    const storedId =
      session?.stored_session_id || existing?.resolved_id || existing?.id
    if (!runtimeId || !storedId) {
      throw new Error('Le chat dédié n’a pas pu être créé')
    }
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
      message: 'Le chat dédié à la résolution n’a pas pu être ouvert'
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
          : 'La vue du service client est indisponible'
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
        children: 'Préparation de la vue priorisée du service client…'
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
            children:
              error || 'La vue globale du service client est indisponible.'
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: load,
            children: 'Réessayer'
          })
        ]
      })
    })
  }

  return jsxs('section', {
    style: { ...cardStyle, width: 'min(820px, 100%)' },
    'aria-label': 'Priorités globales du service client',
    children: [
      jsxs('div', {
        style: headerStyle,
        children: [
          jsxs('div', {
            style: { display: 'grid', gap: '3px' },
            children: [
              jsx('strong', {
                style: { fontSize: '14px' },
                children: 'Priorités du service client'
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
            children: 'Actualiser'
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
                children: 'Aucune situation nécessitant une action.'
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
                        jsx(Badge, {
                          children: priorityLabel(situation.priority)
                        })
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
                          children: 'Résoudre maintenant'
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

function currentNotificationScope() {
  const focusedProfile = host.state.focusedSessionProfile.get()
  const homeProfile = host.state.profile.get()
  const profile = homeProfile || focusedProfile || ''
  const operator =
    profile === 'lyse' || profile === 'philippine' ? profile : ''
  return { profile, operator }
}

function operatorQuery(operator) {
  return operator ? `?operator=${encodeURIComponent(operator)}` : ''
}

function notificationsForOperator(inbox, operator) {
  return inbox.byOperator?.[operator] || []
}

function setActiveNotificationOperator(operator) {
  const current = notificationInboxAtom.get()
  if (current.activeOperator === operator) return
  notificationInboxAtom.set({
    ...current,
    activeOperator: operator
  })
}

async function refreshNotificationInbox(
  ctx,
  operator = currentNotificationScope().operator
) {
  const data = await ctx.rest(
    `/notification-inbox${operatorQuery(operator)}`,
    { timeoutMs: 20_000 }
  )
  const current = notificationInboxAtom.get()
  notificationInboxAtom.set({
    ...current,
    byOperator: {
      ...current.byOperator,
      [operator]: Array.isArray(data?.notifications)
        ? data.notifications
        : []
    }
  })
}

async function readNotification(ctx, notificationId) {
  const { operator } = currentNotificationScope()
  await ctx.rest(
    `/notifications/${notificationId}/read${operatorQuery(operator)}`,
    { method: 'POST', body: {}, timeoutMs: 20_000 }
  )
  await refreshNotificationInbox(ctx, operator)
}

async function pollDesktopNotifications(ctx) {
  const { profile, operator } = currentNotificationScope()
  setActiveNotificationOperator(operator)
  if (notificationPollRunning.has(operator)) return
  notificationPollRunning.add(operator)
  try {
    const query = operatorQuery(operator)
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
              label: 'Résoudre maintenant',
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
    await refreshNotificationInbox(ctx, operator)
  } catch {
    // Keep notifications pending while Desktop or the remote gateway is offline.
  } finally {
    notificationPollRunning.delete(operator)
  }
}

function NotificationStatus({ ctx }) {
  const inbox = useValue(notificationInboxAtom)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const homeProfile = useValue(host.state.profile)
  const currentOperator =
    homeProfile === 'lyse' || homeProfile === 'philippine'
      ? homeProfile
      : focusedProfile === 'lyse' || focusedProfile === 'philippine'
        ? focusedProfile
        : ''
  const count = notificationsForOperator(
    inbox,
    currentOperator
  ).length

  useEffect(() => {
    setActiveNotificationOperator(currentOperator)
    void pollDesktopNotifications(ctx)
  }, [ctx, currentOperator])

  if (count === 0) return null
  return jsxs('button', {
    type: 'button',
    onClick: () => host.navigate('/oblist-notifications'),
    'aria-label': `${count} notification${count > 1 ? 's' : ''} non lue${count > 1 ? 's' : ''}`,
    style: {
      display: 'inline-flex',
      height: '100%',
      alignItems: 'center',
      gap: '5px',
      border: 0,
      borderRadius: 0,
      padding: '0 7px',
      background: 'transparent',
      color: 'var(--ui-accent)',
      cursor: 'pointer',
      fontSize: '11px',
      fontWeight: 700
    },
    children: [
      jsx(Codicon, { name: 'bell', size: '0.75rem' }),
      jsx('span', { children: `CS ${count}` })
    ]
  })
}

function NotificationBanner() {
  const inbox = useValue(notificationInboxAtom)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const homeProfile = useValue(host.state.profile)
  const currentOperator =
    homeProfile === 'lyse' || homeProfile === 'philippine'
      ? homeProfile
      : focusedProfile === 'lyse' || focusedProfile === 'philippine'
        ? focusedProfile
        : ''
  const count = notificationsForOperator(
    inbox,
    currentOperator
  ).length

  if (count === 0) return null
  return jsxs('button', {
    type: 'button',
    onClick: () => host.navigate('/oblist-notifications'),
    style: {
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '10px',
      padding: '8px 10px',
      border: '1px solid var(--ui-danger)',
      borderRadius: '9px',
      background: 'var(--ui-bg-secondary)',
      color: 'var(--ui-text-primary)',
      cursor: 'pointer',
      fontSize: '12px'
    },
    children: [
      jsxs('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          minWidth: 0
        },
        children: [
          jsx('span', {
            'aria-hidden': true,
            style: {
              width: '8px',
              height: '8px',
              flex: '0 0 auto',
              borderRadius: '999px',
              background: 'var(--ui-danger)'
            }
          }),
          jsx('strong', {
            children: `${count} nouvelle${count > 1 ? 's' : ''} alerte${count > 1 ? 's' : ''} CS`
          })
        ]
      }),
      jsx('span', {
        style: {
          color: 'var(--ui-accent)',
          fontWeight: 700,
          whiteSpace: 'nowrap'
        },
        children: 'Ouvrir les alertes →'
      })
    ]
  })
}

function NotificationInboxPage({ ctx }) {
  const inbox = useValue(notificationInboxAtom)
  const [working, setWorking] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const { profile, operator } = currentNotificationScope()
  const notifications = notificationsForOperator(inbox, operator)

  const refresh = async () => {
    setRefreshing(true)
    try {
      await refreshNotificationInbox(ctx, operator)
      setError('')
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message.slice(0, 180)
          : 'La boîte de notifications est indisponible'
      )
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [ctx, operator])

  useEffect(() => {
    if (inbox.byOperator?.[operator]) setError('')
  }, [inbox, operator])

  const dismiss = async notification => {
    setWorking(notification.id)
    setError('')
    try {
      await readNotification(ctx, notification.id)
    } catch (readError) {
      setError(
        readError instanceof Error
          ? readError.message.slice(0, 180)
          : 'Cette notification n’a pas pu être marquée comme lue'
      )
    } finally {
      setWorking('')
    }
  }

  const resolve = async notification => {
    const situation = notification?.payload?.situation
    if (!situation?.id) return
    setWorking(notification.id)
    setError('')
    try {
      await readNotification(ctx, notification.id)
      await openSituationChat(
        situation,
        operator || profile || undefined
      )
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message.slice(0, 180)
          : 'Cette notification n’a pas pu être ouverte'
      )
    } finally {
      setWorking('')
    }
  }

  return jsxs('main', {
    style: {
      width: 'min(920px, 100%)',
      margin: '0 auto',
      padding: '24px',
      color: 'var(--ui-text-primary)'
    },
    children: [
      jsxs('header', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '14px',
          marginBottom: '18px'
        },
        children: [
          jsxs('div', {
            style: { display: 'grid', gap: '4px' },
            children: [
              jsx('h1', {
                style: { margin: 0, fontSize: '20px' },
                children: 'Notifications du service client'
              }),
              jsx('span', {
                style: {
                  color: 'var(--ui-text-tertiary)',
                  fontSize: '12px'
                },
                children: `${notifications.length} non lue${
                  notifications.length > 1 ? 's' : ''
                } · ${operator || 'Vue globale de Gary'}`
              })
            ]
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            disabled: refreshing,
            onClick: () => void refresh(),
            children: refreshing ? 'Actualisation…' : 'Actualiser'
          })
        ]
      }),
      error
        ? jsx('div', {
            role: 'alert',
            style: {
              marginBottom: '12px',
              color: 'var(--ui-danger)',
              fontSize: '12px'
            },
            children: error
          })
        : null,
      notifications.length === 0
        ? jsx('section', {
            style: {
              padding: '28px',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: '12px',
              color: 'var(--ui-text-tertiary)',
              textAlign: 'center'
            },
            children: 'Aucune notification non lue.'
          })
        : jsx('div', {
            style: { display: 'grid', gap: '10px' },
            children: notifications.map(notification => {
              const situation = notification?.payload?.situation
              const priority =
                notification?.payload?.priority || 'INFORMATION'
              return jsxs('article', {
                style: cardStyle,
                children: [
                  jsxs('div', {
                    style: headerStyle,
                    children: [
                      jsxs('div', {
                        style: { display: 'grid', gap: '4px' },
                        children: [
                          jsx('strong', {
                            style: { fontSize: '13px' },
                            children: notification.title
                          }),
                          jsx('span', {
                            style: {
                              color: 'var(--ui-text-tertiary)',
                              fontSize: '11px'
                            },
                            children: new Date(
                              notification.createdAt
                            ).toLocaleString()
                          })
                        ]
                      }),
                      jsx(Badge, { children: priorityLabel(priority) })
                    ]
                  }),
                  jsxs('div', {
                    style: bodyStyle,
                    children: [
                      jsx('span', {
                        style: {
                          color: 'var(--ui-text-secondary)',
                          fontSize: '13px',
                          lineHeight: 1.5
                        },
                        children: notification.body
                      }),
                      situation?.summary
                        ? jsx('span', {
                            style: {
                              color: 'var(--ui-text-tertiary)',
                              fontSize: '12px',
                              lineHeight: 1.45
                            },
                            children: situation.summary
                          })
                        : null
                    ]
                  }),
                  jsxs('div', {
                    style: footerStyle,
                    children: [
                      jsx('div', {
                        style: rowStyle,
                        children: (situation?.links || []).map(link =>
                          jsx(Button, {
                            size: 'sm',
                            variant: 'secondary',
                            onClick: () => ctx.os.openExternal(link.url),
                            children: link.label
                          })
                        )
                      }),
                      jsxs('div', {
                        style: rowStyle,
                        children: [
                          jsx(Button, {
                            size: 'sm',
                            variant: 'secondary',
                            disabled: working === notification.id,
                            onClick: () => dismiss(notification),
                            children: 'Ignorer'
                          }),
                          situation?.id
                            ? jsx(Button, {
                                size: 'sm',
                                disabled: working === notification.id,
                                onClick: () => resolve(notification),
                                children:
                                  working === notification.id
                                    ? 'Ouverture…'
                                    : 'Résoudre maintenant'
                              })
                            : null
                        ]
                      })
                    ]
                  })
                ]
              })
            })
          })
    ]
  })
}

export default {
  id: 'oblist-action-cards',
  name: 'The Oblist Action Cards',
  register(ctx) {
    const uninstallIntroMessage = installCsIntroMessage()
    ctx.onDispose(uninstallIntroMessage)
    ctx.register({
      id: 'oblist-cs-quick-prompts',
      area: COMPOSER_AREAS.microActions,
      order: 20,
      data: {
        resolve: ({ busy }) => quickPromptActions(ctx, busy)
      }
    })
    const syncActiveProfile = () => {
      const { operator } = currentNotificationScope()
      setActiveNotificationOperator(operator)
      void pollDesktopNotifications(ctx)
    }
    const unsubscribeFocusedProfile =
      host.state.focusedSessionProfile.subscribe(syncActiveProfile)
    const unsubscribeHomeProfile =
      host.state.profile.subscribe(syncActiveProfile)
    ctx.onDispose(() => {
      unsubscribeFocusedProfile()
      unsubscribeHomeProfile()
    })
    syncActiveProfile()
    const notificationTimer = window.setInterval(
      () => void pollDesktopNotifications(ctx),
      30_000
    )
    ctx.onDispose(() => window.clearInterval(notificationTimer))
    ctx.register({
      id: 'oblist-notification-inbox-page',
      area: ROUTES_AREA,
      data: { path: '/oblist-notifications' },
      render: () => jsx(NotificationInboxPage, { ctx })
    })
    let disposeNotificationNav = () => undefined
    const unsubscribeNotificationNav = notificationInboxAtom.subscribe(
      inbox => {
        disposeNotificationNav()
        const count = notificationsForOperator(
          inbox,
          inbox.activeOperator
        ).length
        disposeNotificationNav = ctx.register({
          id: 'oblist-notification-inbox-nav',
          area: SIDEBAR_NAV_AREA,
          order: 45,
          data: {
            path: '/oblist-notifications',
            label:
              count > 0 ? `🔴 Alertes CS (${count})` : 'Alertes CS',
            codicon: 'bell'
          }
        })
      }
    )
    ctx.onDispose(() => {
      unsubscribeNotificationNav()
      disposeNotificationNav()
    })
    ctx.register({
      id: 'oblist-notification-count',
      area: STATUSBAR_AREAS.right,
      order: 70,
      render: () => jsx(NotificationStatus, { ctx })
    })
    ctx.register({
      id: 'oblist-notification-banner',
      area: COMPOSER_AREAS.top,
      order: 10,
      render: () => jsx(NotificationBanner, {})
    })
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
