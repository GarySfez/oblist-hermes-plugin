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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GIT_COMMIT_RE = /^[a-f0-9]{40}$/
const PLUGIN_REVISION_RE = /^[A-Za-z0-9._-]{1,64}$/
const VISION_UI_CONTRACT_VERSION = '1.0.0'
const VISION_DIRECTIVE_NAME = 'oblist-vision'
const VISION_PAYLOAD_ORIGIN = 'AUTHENTICATED_API'
const VISION_PARSED_PAYLOAD = Symbol('oblist-vision-parsed-payload')
const VISION_PRODUCT_LIMIT = 6
const VISION_ATTACHMENT_VISIBLE_LIMIT = 12
const VISION_HIDE_STORAGE_PREFIX = 'oblist-vision-products-hidden:v1'
const VISION_PAYLOAD_CACHE_MS = 30_000
const VISION_PAYLOAD_CACHE_LIMIT = 64
const VISION_LINK_CACHE_MS = 30_000
const VISION_LINK_CACHE_LIMIT = 128
const VISION_PENDING_STATUSES = new Set([
  'DISCOVERED',
  'QUEUED',
  'DOWNLOADING',
  'SCANNING',
  'ANALYZING'
])
const VISION_FAILED_STATUSES = new Set([
  'FAILED',
  'TIMED_OUT',
  'DLQ'
])
const VISION_TERMINAL_STATUSES = new Set([
  'READY',
  'LINK_ONLY',
  'UNSUPPORTED',
  ...VISION_FAILED_STATUSES
])
const VISION_SIGNED_QUERY_PARAMETERS = new Set([
  'expires',
  'key-pair-id',
  'policy',
  'signature',
  'token',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-security-token',
  'x-amz-signature'
])
const visionRenderedAutoContexts = new Set()
const visionPayloadCache = new Map()
const visionPayloadRequests = new Map()
const visionAttachmentLinkCache = new Map()
const visionAttachmentLinkRequests = new Map()

const PLUGIN_VERSION = '0.5.0'
const PLUGIN_RELEASE_REVISION = '2026.10.21.14'
const RELEASE_EPOCH = 'hermes-intelligence-v2'
const MANAGED_PLUGIN_INSTALLER_URL =
  'https://garysfez.github.io/oblist-hermes-plugin/?update=1&desktop=1'
const API_PATHS = Object.freeze({
  runtime: '/runtime',
  pluginRelease: '/plugin-release',
  pluginReleaseApply: '/plugin-release/apply',
  action: actionId => `/actions/${actionId}`,
  actionEdit: actionId => `/actions/${actionId}/edit`,
  actionDecision: actionId => `/actions/${actionId}/decision`,
  actionExecute: actionId => `/actions/${actionId}/execute`,
  actionOutcome: actionId => `/actions/${actionId}/outcome`,
  overview: '/overview',
  notifications: '/notifications',
  notificationInbox: '/notification-inbox',
  notificationOutcome: notificationId =>
    `/notifications/${notificationId}/outcome`,
  notificationRead: notificationId =>
    `/notifications/${notificationId}/read`,
  workflowClaim: workflowId => `/workflows/${workflowId}/claim`,
  workflowConfirmAssignment: workflowId =>
    `/workflows/${workflowId}/confirm-assignment`,
  workflowRelease: workflowId =>
    `/workflows/${workflowId}/release`,
  workflowClosure: workflowId => `/workflows/${workflowId}/closure`,
  visionPayload: (payloadRef, caseRef) =>
    `/v1/vision-payloads/${encodeURIComponent(
      payloadRef
    )}?caseRef=${encodeURIComponent(caseRef)}`,
  attachmentLinks: '/v1/attachments/links'
})

const V1_RUNTIME = Object.freeze({
  mode: 'OFF',
  releaseEpoch: null,
  compatible: false,
  fallback: 'V1'
})

const inFlightNotificationIds = new Set()
const notificationPollRunning = new Set()
const actionCardCache = new Map()
const operationsOverviewCache = new Map()
const operationsOverviewRequests = new Map()
const runtimeHandshakeCache = new Map()
const runtimeHandshakeRequests = new Map()
const managedPluginReleaseRequests = new Map()
const ACTION_CARD_CACHE_MS = 60_000
const OPERATIONS_OVERVIEW_CACHE_MS = 90_000
const RUNTIME_HANDSHAKE_CACHE_MS = 15_000
const MANAGED_PLUGIN_RELEASE_POLL_MS = 60_000
const notificationInboxAtom = atom({
  activeOperator: '',
  byOperator: {
    '': [],
    lyse: [],
    philippine: []
  }
})
const runtimeCompatibilityAtom = atom({
  state: 'idle',
  connectionKey: '',
  runtime: V1_RUNTIME
})
const managedPluginReleaseAtom = atom({
  state: 'idle',
  connectionKey: '',
  release: null,
  checkedAt: 0,
  error: ''
})
let lastManagedReleaseNotice = ''

function currentConnectionKey() {
  return String(
    host.state.connectionId?.get?.() ||
      host.activeConnectionId?.() ||
      'local'
  )
}

function currentProfileKey() {
  const focusedSessionId = host.state.focusedSessionId.get()
  const focusedProfile = host.state.focusedSessionProfile.get()
  const homeProfile = host.state.profile.get()
  return String(
    (
      focusedSessionId
        ? focusedProfile
        : homeProfile || focusedProfile
    ) || 'global'
  )
}

function normalizeRuntimeHandshake(value) {
  const nested =
    value?.runtime && typeof value.runtime === 'object'
      ? value.runtime
      : null
  const source = nested ? { ...value, ...nested } : value || {}
  const mode = ['OFF', 'SHADOW', 'LIVE'].includes(source.mode)
    ? source.mode
    : 'OFF'
  const releaseEpoch =
    typeof source.releaseEpoch === 'string' ? source.releaseEpoch : null
  return {
    mode,
    releaseEpoch,
    compatible:
      source.compatible === true && releaseEpoch === RELEASE_EPOCH,
    fallback: 'V1',
    checkedAt:
      Number.isFinite(Number(source.checkedAt))
        ? Number(source.checkedAt)
        : Date.now()
  }
}

function isV2Live(runtime) {
  return (
    runtime?.mode === 'LIVE' &&
    runtime?.compatible === true &&
    runtime?.releaseEpoch === RELEASE_EPOCH
  )
}

function runtimeBlocksV2(runtime) {
  return runtime?.mode === 'LIVE' && !isV2Live(runtime)
}

async function refreshRuntimeHandshake(ctx, force = false) {
  const connectionKey = currentConnectionKey()
  const cached = runtimeHandshakeCache.get(connectionKey)
  if (
    !force &&
    cached &&
    Date.now() - cached.cachedAt < RUNTIME_HANDSHAKE_CACHE_MS
  ) {
    runtimeCompatibilityAtom.set({
      state: 'ready',
      connectionKey,
      runtime: cached.runtime
    })
    return cached.runtime
  }

  let request = runtimeHandshakeRequests.get(connectionKey)
  if (!request) {
    request = ctx
      .rest(API_PATHS.runtime, { timeoutMs: 10_000 })
      .then(normalizeRuntimeHandshake)
      .catch(() => ({ ...V1_RUNTIME, checkedAt: Date.now() }))
      .finally(() => runtimeHandshakeRequests.delete(connectionKey))
    runtimeHandshakeRequests.set(connectionKey, request)
  }
  runtimeCompatibilityAtom.set({
    state: 'loading',
    connectionKey,
    runtime: cached?.runtime || V1_RUNTIME
  })
  const runtime = await request
  runtimeHandshakeCache.set(connectionKey, {
    runtime,
    cachedAt: Date.now()
  })
  runtimeCompatibilityAtom.set({
    state: 'ready',
    connectionKey,
    runtime
  })
  return runtime
}

function useRuntimeCompatibility(ctx) {
  const compatibility = useValue(runtimeCompatibilityAtom)
  useEffect(() => {
    void refreshRuntimeHandshake(ctx)
  }, [ctx])
  return compatibility.runtime
}

function normalizeManagedPluginRelease(value) {
  if (
    !value ||
    value.channelVersion !== 1 ||
    value.repository !== 'GarySfez/oblist-hermes-plugin'
  ) {
    return null
  }
  const targetCommit =
    typeof value.targetCommit === 'string' &&
    GIT_COMMIT_RE.test(value.targetCommit)
      ? value.targetCommit
      : null
  const targetRevision =
    typeof value.targetRevision === 'string' &&
    PLUGIN_REVISION_RE.test(value.targetRevision)
      ? value.targetRevision
      : null
  return {
    policy: ['OFF', 'NOTIFY', 'AUTO'].includes(value.policy)
      ? value.policy
      : 'OFF',
    releaseLabel:
      typeof value.releaseLabel === 'string'
        ? value.releaseLabel.slice(0, 100)
        : 'Mise à jour The Oblist',
    targetCommit,
    targetRevision,
    currentRevision:
      typeof value.currentRevision === 'string' &&
      PLUGIN_REVISION_RE.test(value.currentRevision)
        ? value.currentRevision
        : null,
    currentCommit:
      typeof value.currentCommit === 'string' &&
      GIT_COMMIT_RE.test(value.currentCommit)
        ? value.currentCommit
        : null,
    available: value.available === true,
    updateAvailable:
      value.updateAvailable === true && targetCommit !== null,
    applyAllowed:
      value.applyAllowed === true && targetCommit !== null,
    automatic: value.automatic === true
  }
}

async function refreshManagedPluginRelease(ctx, force = false) {
  const connectionKey = currentConnectionKey()
  const current = managedPluginReleaseAtom.get()
  if (
    !force &&
    current.connectionKey === connectionKey &&
    current.checkedAt > 0 &&
    Date.now() - current.checkedAt < MANAGED_PLUGIN_RELEASE_POLL_MS
  ) {
    return current.release
  }

  let request = managedPluginReleaseRequests.get(connectionKey)
  if (!request) {
    request = ctx
      .rest(
        `${API_PATHS.pluginRelease}?currentRevision=${encodeURIComponent(
          PLUGIN_RELEASE_REVISION
        )}`,
        { timeoutMs: 20_000 }
      )
      .then(normalizeManagedPluginRelease)
      .finally(() => managedPluginReleaseRequests.delete(connectionKey))
    managedPluginReleaseRequests.set(connectionKey, request)
  }
  managedPluginReleaseAtom.set({
    ...current,
    state: 'loading',
    connectionKey,
    error: ''
  })
  try {
    const release = await request
    managedPluginReleaseAtom.set({
      state: 'ready',
      connectionKey,
      release,
      checkedAt: Date.now(),
      error: ''
    })
    if (
      release?.updateAvailable &&
      release.targetCommit !== lastManagedReleaseNotice
    ) {
      lastManagedReleaseNotice = release.targetCommit
      host.notify({
        kind: 'info',
        message:
          `${release.releaseLabel} est disponible dans Accueil CS.`
      })
    }
    return release
  } catch (error) {
    managedPluginReleaseAtom.set({
      state: 'error',
      connectionKey,
      release: current.release,
      checkedAt: Date.now(),
      error: readableUiError(
        error,
        'La vérification des mises à jour est indisponible.',
      )
    })
    return current.release
  }
}

function useManagedPluginRelease(ctx) {
  const state = useValue(managedPluginReleaseAtom)
  useEffect(() => {
    void refreshManagedPluginRelease(ctx)
  }, [ctx])
  return state
}

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
  },
  {
    id: 'priority-customers',
    label: 'Clients VIP et VIC',
    icon: 'star',
    text:
      'Fais un point sur les situations actives de mes clients VIP et VIC. Reste dans mon périmètre, classe les dossiers par urgence et propose le suivi utile sans envoyer de message.'
  },
  {
    id: 'returns',
    label: 'Retours à suivre',
    icon: 'package',
    text:
      'Fais un point sur les retours qui demandent mon attention, en commençant par les urgences et les dossiers bloqués. Ne demande pas de numéro de commande.'
  },
  {
    id: 'vendor-replies',
    label: 'Réponses vendeurs',
    icon: 'comment-discussion',
    text:
      'Montre-moi les dossiers de mon périmètre où un vendeur a répondu ou doit être relancé. Vérifie les Info Requests existantes pour éviter tout doublon.'
  },
  {
    id: 'shipping-quotes',
    label: 'Devis de livraison',
    icon: 'package',
    text:
      'Montre-moi les demandes de devis de livraison de mon périmètre qui nécessitent une action, avec la prochaine étape recommandée.'
  },
  {
    id: 'customs',
    label: 'Dédouanements à suivre',
    icon: 'globe',
    text:
      'Fais un point sur les commandes de mon périmètre en cours de dédouanement ou bloquées en douane. Indique les preuves disponibles, les inconnues et la prochaine action utile sans contacter personne.'
  }
]

function orderedQuickPrompts(ctx) {
  const usage = ctx.storage.get(QUICK_PROMPT_USAGE_KEY, {})
  return [...CS_QUICK_PROMPTS]
    .sort(
      (left, right) =>
        Number(usage?.[right.id] || 0) - Number(usage?.[left.id] || 0)
    )
}

async function rememberQuickPrompt(ctx, prompt) {
  const latest = ctx.storage.get(QUICK_PROMPT_USAGE_KEY, {})
  await ctx.storage.set(QUICK_PROMPT_USAGE_KEY, {
    ...latest,
    [prompt.id]: Number(latest?.[prompt.id] || 0) + 1
  })
}

function quickPromptActions(ctx, busy) {
  if (busy) return []
  return orderedQuickPrompts(ctx)
    .slice(0, 3)
    .map(prompt => ({
      id: `oblist-${prompt.id}`,
      label: prompt.label,
      icon: prompt.icon,
      run: async sessionId => {
        await rememberQuickPrompt(ctx, prompt)
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

function ManagedPluginUpdateStatus({ ctx }) {
  const managed = useManagedPluginRelease(ctx)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const release = managed.release

  if (managed.state === 'handoff') {
    return jsxs('div', {
      role: 'status',
      style: {
        display: 'grid',
        gap: '6px',
        padding: '12px 14px',
        border: '1px solid rgba(96, 165, 250, 0.38)',
        borderRadius: '10px',
        background: 'rgba(59, 130, 246, 0.1)',
        color: 'var(--ui-text-primary)',
        textAlign: 'left'
      },
      children: [
        jsx('strong', {
          children: 'Mise à jour prête à installer'
        }),
        jsx('span', {
          style: {
            color: 'var(--ui-text-secondary)',
            fontSize: '12px',
            lineHeight: 1.45
          },
          children:
            'Confirmez « Installer » dans la fenêtre Hermes ouverte. L’interface se rechargera à chaud sans fermer votre session.'
        })
      ]
    })
  }

  if (!release?.updateAvailable) return null

  const install = async () => {
    if (!release.applyAllowed || !release.targetCommit) return
    setInstalling(true)
    setError('')
    try {
      const opened = await ctx.os.openExternal(
        MANAGED_PLUGIN_INSTALLER_URL
      )
      if (!opened) {
        throw new Error('PLUGIN_INSTALLER_UNAVAILABLE')
      }
      managedPluginReleaseAtom.set({
        ...managedPluginReleaseAtom.get(),
        state: 'handoff',
        error: ''
      })
      host.notify({
        kind: 'info',
        message:
          'Confirmez maintenant l’installation dans Hermes.'
      })
      void ctx
        .rest(API_PATHS.pluginReleaseApply, {
          method: 'POST',
          body: {
            expectedCommit: release.targetCommit,
            currentRevision: PLUGIN_RELEASE_REVISION
          },
          timeoutMs: 600_000
        })
        .catch(() => undefined)
    } catch (installError) {
      setError(
        readableUiError(
          installError,
          'La mise à jour n’a pas pu être installée. La version actuelle reste active.',
        )
      )
    } finally {
      setInstalling(false)
    }
  }

  return jsxs('div', {
    role: 'alert',
    style: {
      display: 'grid',
      gap: '10px',
      padding: '13px 14px',
      border: '1px solid rgba(251, 191, 36, 0.38)',
      borderRadius: '10px',
      background: 'rgba(245, 158, 11, 0.1)',
      color: 'var(--ui-text-primary)',
      textAlign: 'left'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '9px'
        },
        children: [
          jsx(Codicon, {
            name: 'cloud-download',
            size: '1rem'
          }),
          jsxs('div', {
            style: { display: 'grid', gap: '3px' },
            children: [
              jsx('strong', {
                children: release.releaseLabel
              }),
              jsx('span', {
                style: {
                  color: 'var(--ui-text-secondary)',
                  fontSize: '12px',
                  lineHeight: 1.45
                },
                children:
                  'Une version approuvée de l’interface The Oblist est disponible. Vos conversations et brouillons sont conservés.'
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          flexWrap: 'wrap'
        },
        children: [
          error
            ? jsx('span', {
                role: 'alert',
                style: {
                  color: 'var(--ui-danger)',
                  fontSize: '12px'
                },
                children: error
              })
            : jsx('span', {
                style: {
                  color: 'var(--ui-text-tertiary)',
                  fontSize: '11px'
                },
                children:
                  'Un clic ouvre l’installateur sécurisé ; confirmez ensuite « Installer ». Aucun redémarrage n’est nécessaire.'
              }),
          jsx(Button, {
            size: 'sm',
            disabled:
              installing || release.applyAllowed !== true,
            onClick: () => void install(),
            children: installing
              ? 'Préparation…'
              : 'Ouvrir la mise à jour'
          })
        ]
      })
    ]
  })
}

function RuntimeCompatibilityStatus({ ctx }) {
  const runtime = useRuntimeCompatibility(ctx)
  if (runtimeBlocksV2(runtime)) {
    return jsxs('div', {
      role: 'alert',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '7px',
        color: 'var(--ui-danger)',
        fontSize: '12px',
        lineHeight: 1.4
      },
      children: [
        jsx(Codicon, { name: 'warning', size: '0.8rem' }),
        jsx('span', {
          children:
            'Le suivi avancé attend une mise à jour. L’interface habituelle reste disponible.'
        })
      ]
    })
  }
  return jsx('div', {
    role: 'status',
    style: {
      display: 'flex',
      justifyContent: 'center'
    },
    children: jsx(Badge, {
      children: isV2Live(runtime)
        ? 'Suivi avancé actif'
        : 'Interface habituelle active'
    })
  })
}

function RuntimeActionBlock() {
  return jsx('div', {
    role: 'alert',
    style: {
      padding: '10px',
      border: '1px solid var(--ui-danger)',
      borderRadius: '8px',
      color: 'var(--ui-danger)',
      fontSize: '12px',
      lineHeight: 1.45
    },
    children:
      'Cette action est temporairement bloquée pour éviter une confirmation avec une version incompatible. Aucune action n’a été effectuée.'
  })
}

async function openQuickPrompt(ctx, prompt) {
  await rememberQuickPrompt(ctx, prompt)
  host.navigate('/')
  queueMicrotask(async () => {
    const sessionId =
      host.state.focusedSessionId.get() || host.state.activeSessionId.get()
    await host.composer.setDraft(sessionId, prompt.text)
    host.composer.focus(sessionId)
  })
}

async function requestActionCardRecheck(ctx) {
  const sessionId =
    host.state.focusedSessionId.get() ||
    host.state.activeSessionId.get()
  await host.composer.setDraft(
    sessionId,
    'Revérifie le brouillon que je viens de modifier. Récupère à nouveau tout le contexte actuel, contrôle chaque information sensible avec ses sources, puis lance la nouvelle vérification de la carte sans rien envoyer.'
  )
  host.composer.focus(sessionId)
}

function CsHomePage({ ctx }) {
  const prompts = orderedQuickPrompts(ctx)
  return jsx('main', {
    style: {
      minHeight: 'calc(100vh - 120px)',
      display: 'grid',
      placeItems: 'center',
      padding: '28px'
    },
    children: jsxs('section', {
      style: {
        width: 'min(720px, 100%)',
        display: 'grid',
        gap: '18px',
        textAlign: 'center'
      },
      children: [
        jsx('h1', {
          style: {
            margin: 0,
            color: 'var(--ui-text-primary)',
            fontSize: '24px',
            fontWeight: 650,
            lineHeight: 1.25
          },
          children:
            'Comment puis-je vous aider à résoudre un cas du service client aujourd’hui ?'
        }),
        jsx('p', {
          style: {
            margin: 0,
            color: 'var(--ui-text-secondary)',
            fontSize: '13px',
            lineHeight: 1.5
          },
          children:
            'Vous pouvez me demander de retrouver une commande, analyser une conversation, vérifier une livraison ou un dédouanement, faire le point sur un retour, un remboursement ou un client VIP/VIC, puis préparer les prochaines actions sans rien envoyer sans votre accord.'
        }),
        jsx(ManagedPluginUpdateStatus, { ctx }),
        jsx(RuntimeCompatibilityStatus, { ctx }),
        jsx('div', {
          style: {
            display: 'flex',
            justifyContent: 'center',
            gap: '8px',
            flexWrap: 'wrap'
          },
          children: prompts.map(prompt =>
            jsx(Button, {
              variant: 'secondary',
              onClick: () => void openQuickPrompt(ctx, prompt),
              children: prompt.label
            })
          )
        })
      ]
    })
  })
}

function statusLabel(status) {
  return {
    DRAFT: 'À vérifier',
    APPROVED: 'Approuvé',
    REJECTED: 'Refusé',
    COPIED: 'Prêt dans Intercom',
    MONITORING: 'Suivi actif',
    EXECUTING: 'En cours d’envoi',
    SENT: 'Envoyé',
    SUPERSEDED: 'Remplacé'
  }[status] || 'État inconnu'
}

function readableUiError(error, fallback) {
  const detail =
    error instanceof Error ? error.message.trim().slice(0, 180) : ''
  if (!detail || /[A-Z]{2,}_[A-Z_]+/.test(detail)) return fallback
  return `${fallback} ${detail}`
}

function normalizeCriticReview(card) {
  const metadata = card?.metadata || {}
  const raw =
    card?.critic ||
    card?.qualityReview ||
    metadata.critic ||
    metadata.qualityReview ||
    (card?.criticVerdict || metadata.criticVerdict
      ? {
          verdict: card?.criticVerdict || metadata.criticVerdict,
          cardVersion:
            card?.criticCardVersion || metadata.criticCardVersion,
          casePacketHash:
            card?.casePacketHash || metadata.casePacketHash,
          policyRevisionIds:
            card?.policyRevisionIds || metadata.policyRevisionIds,
          criticPromptVersion:
            card?.criticPromptVersion || metadata.criticPromptVersion,
          releaseEpoch:
            card?.releaseEpoch || metadata.releaseEpoch
        }
      : null)
  if (!raw || typeof raw !== 'object') return null
  const verdict = ['PASS', 'REVISE', 'BLOCK'].includes(raw.verdict)
    ? raw.verdict
    : null
  const cardVersion = Number(raw.cardVersion ?? raw.version)
  const releaseEpoch =
    typeof raw.releaseEpoch === 'string' ? raw.releaseEpoch : null
  const casePacketHash =
    typeof raw.casePacketHash === 'string' && raw.casePacketHash
      ? raw.casePacketHash
      : null
  const policyRevisionIds = Array.isArray(raw.policyRevisionIds)
    ? raw.policyRevisionIds
    : null
  const criticPromptVersion =
    typeof raw.criticPromptVersion === 'string' &&
    raw.criticPromptVersion
      ? raw.criticPromptVersion
      : null
  return {
    verdict,
    cardVersion,
    releaseEpoch,
    current:
      Boolean(verdict) &&
      cardVersion === Number(card?.version) &&
      releaseEpoch === RELEASE_EPOCH &&
      Boolean(casePacketHash) &&
      Boolean(policyRevisionIds) &&
      Boolean(criticPromptVersion)
  }
}

function criticAllowsAction(card, runtime, dirty = false) {
  if (runtimeBlocksV2(runtime)) return false
  if (isV2Live(runtime)) {
    const review = normalizeCriticReview(card)
    return (
      !dirty &&
      review?.current === true &&
      review.verdict === 'PASS'
    )
  }
  return !dirty
}

function CriticStatus({ card, runtime, dirty }) {
  if (!isV2Live(runtime)) return null
  if (dirty) {
    return jsx('div', {
      role: 'status',
      style: {
        color: 'var(--ui-text-secondary)',
        fontSize: '12px',
        lineHeight: 1.45
      },
      children:
        'Les modifications devront être vérifiées avant toute confirmation.'
    })
  }
  const review = normalizeCriticReview(card)
  const passed = review?.current && review.verdict === 'PASS'
  if (passed) {
    return jsx('div', {
      role: 'status',
      children: jsx(Badge, { children: 'Vérification réussie' })
    })
  }
  const message =
    review?.current && review.verdict === 'REVISE'
      ? 'La vérification recommande de corriger ce brouillon avant confirmation.'
      : review?.current && review.verdict === 'BLOCK'
        ? 'La vérification a identifié un risque. Relisez le brouillon avant de confirmer.'
        : 'La vérification automatique n’est pas disponible. Relisez le brouillon avant de confirmer.'
  return jsx('div', {
    role: 'alert',
    style: {
      padding: '9px 10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '8px',
      color: 'var(--ui-text-secondary)',
      fontSize: '12px',
      lineHeight: 1.45
    },
    children: message
  })
}

function bodyForEditor(value) {
  return String(value || '')
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote|section|article)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function materialEdit(card, subject, body, infoRequest) {
  if ((card?.subject || '').trim() !== String(subject || '').trim()) return true
  if (
    JSON.stringify(card?.metadata?.infoRequest || null) !==
    JSON.stringify(infoRequest || null)
  ) {
    return true
  }
  const words = value =>
    String(value || '')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  const previous = words(bodyForEditor(card?.body))
  const next = words(body)
  const counts = new Map()
  previous.forEach(word => counts.set(word, (counts.get(word) || 0) + 1))
  let shared = 0
  next.forEach(word => {
    const remaining = counts.get(word) || 0
    if (remaining < 1) return
    shared += 1
    counts.set(word, remaining - 1)
  })
  return (
    (previous.length + next.length - 2 * shared) /
      Math.max(1, previous.length + next.length) >=
    0.25
  )
}

function kindLabel(card) {
  if (card?.metadata?.channel === 'KEPLER_INFO_REQUEST') {
    return "Demande d’information au vendeur"
  }
  if (card?.metadata?.channel === 'INTERCOM_VENDOR_EMAIL') {
    return 'E-mail au vendeur via Intercom'
  }
  if (card?.metadata?.channel === 'INTERCOM_CUSTOMER_EMAIL') {
    return 'Nouvel e-mail au client via Intercom'
  }
  return card?.kind === 'CUSTOMER_REPLY'
    ? 'Réponse au client'
    : 'Demande au vendeur'
}

function approvalLabel(card) {
  return {
    INTERCOM_CUSTOMER_REPLY: 'Approuver et envoyer dans Intercom',
    INTERCOM_CUSTOMER_EMAIL: "Approuver et créer l’e-mail client",
    INTERCOM_VENDOR_EMAIL: "Approuver et envoyer l’e-mail",
    KEPLER_INFO_REQUEST: "Approuver et créer l’Info Request",
    INTERCOM_SIDE_CONVERSATION: 'Approuver le brouillon vendeur'
  }[card?.metadata?.channel] || 'Approuver'
}

function executionLabel(card) {
  return {
    INTERCOM_CUSTOMER_REPLY: 'Envoyer la réponse dans Intercom',
    INTERCOM_CUSTOMER_EMAIL: "Créer et envoyer l’e-mail au client",
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

function actionCardMatchesDirective(card, actionId) {
  return (
    UUID_RE.test(actionId || '') &&
    card?.id === actionId
  )
}

function ActionCard({ ctx, actionId, streaming }) {
  const runtime = useRuntimeCompatibility(ctx)
  const actionCacheKey = `${currentConnectionKey()}:${currentProfileKey()}:${actionId}`
  const cachedAction = actionCardCache.get(actionCacheKey)?.card || null
  const [card, setCard] = useState(cachedAction)
  const [subject, setSubject] = useState(cachedAction?.subject || '')
  const [body, setBody] = useState(
    bodyForEditor(cachedAction?.body)
  )
  const [infoRequest, setInfoRequest] = useState(
    normalizeInfoRequest(cachedAction?.metadata?.infoRequest || null)
  )
  const [loading, setLoading] = useState(!cachedAction)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [editReason, setEditReason] = useState('')
  const [outcomeReason, setOutcomeReason] = useState('')
  const [outcomeRecorded, setOutcomeRecorded] = useState('')

  const applyCard = useCallback((nextCard, cachedAt = Date.now()) => {
    if (!actionCardMatchesDirective(nextCard, actionId)) return
    actionCardCache.set(actionCacheKey, {
      card: nextCard,
      cachedAt
    })
    setCard(nextCard)
    setSubject(nextCard.subject || '')
    setBody(bodyForEditor(nextCard.body))
    setInfoRequest(
      normalizeInfoRequest(nextCard.metadata?.infoRequest || null)
    )
    setEditReason('')
  }, [actionCacheKey, actionId])

  const load = useCallback(async (force = false) => {
    if (!UUID_RE.test(actionId)) return
    const cached = actionCardCache.get(actionCacheKey)
    if (cached) {
      applyCard(cached.card, cached.cachedAt)
      setLoading(false)
      const needsLiveRefresh =
        isV2Live(runtime) &&
        (
          normalizeCriticReview(cached.card)?.current !== true ||
          (
            cached.card?.status === 'SENT' &&
            !UUID_RE.test(cached.card?.caseEpisodeId || '')
          )
        )
      if (
        !force &&
        !needsLiveRefresh &&
        Date.now() - cached.cachedAt < ACTION_CARD_CACHE_MS
      ) {
        return
      }
    } else {
      setLoading(true)
    }
    try {
      const result = await ctx.rest(API_PATHS.action(actionId))
      applyCard(result.card)
      setError('')
    } catch (loadError) {
      setError(
        readableUiError(
          loadError,
          'Cette carte n’a pas pu être chargée.',
        )
      )
    } finally {
      setLoading(false)
    }
  }, [actionCacheKey, actionId, applyCard, ctx, runtime])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!['MONITORING', 'EXECUTING'].includes(card?.status)) {
      return undefined
    }
    const timer = window.setInterval(
      () => void load(true),
      card.status === 'EXECUTING' ? 5_000 : 30_000
    )
    return () => window.clearInterval(timer)
  }, [card?.status, load])

  const dirty = useMemo(
    () =>
      Boolean(
        card &&
          ((card.subject || '') !== subject ||
            bodyForEditor(card.body) !== body ||
            JSON.stringify(card.metadata?.infoRequest || null) !==
              JSON.stringify(infoRequest))
      ),
    [body, card, infoRequest, subject]
  )

  const canEdit = card && ['DRAFT', 'APPROVED'].includes(card.status)
  const materialChange = useMemo(
    () => Boolean(card && dirty && materialEdit(card, subject, body, infoRequest)),
    [body, card, dirty, infoRequest, subject]
  )

  const save = async () => {
    if (
      !actionCardMatchesDirective(card, actionId) ||
      !dirty ||
      !body.trim()
    ) {
      return card
    }
    if (materialChange && !editReason.trim()) {
      setError('Indiquez brièvement pourquoi cette modification est importante.')
      return null
    }
    setWorking('save')
    setError('')
    try {
      const result = await ctx.rest(API_PATHS.actionEdit(card.id), {
        method: 'POST',
        body: {
          expectedVersion: card.version,
          subject: subject.trim() || null,
          body: body.trim(),
          ...(editReason.trim() ? { reason: editReason.trim() } : {}),
          ...(infoRequest ? { infoRequest } : {})
        }
      })
      applyCard(result.card)
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
    if (!actionCardMatchesDirective(card, actionId)) return null
    let current = card
    if (dirty) {
      current = await save()
      if (!current) return null
    }
    if (
      decision !== 'REJECT' &&
      !criticAllowsAction(current, runtime)
    ) {
      setError(
        'Cette action reste bloquée tant que la vérification du brouillon n’est pas terminée.'
      )
      return null
    }
    setWorking(decision)
    setError('')
    try {
      const result = await ctx.rest(API_PATHS.actionDecision(current.id), {
        method: 'POST',
        body: {
          expectedVersion: current.version,
          decision,
          ...options
        }
      })
      applyCard(result.card)
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
    if (!rejectReason.trim()) {
      setError('Indiquez brièvement pourquoi ce brouillon est refusé.')
      return
    }
    const rejected = await decide('REJECT', {
      reason: rejectReason.trim()
    })
    if (rejected) {
      host.notify({ kind: 'success', message: 'Action refusée' })
    }
  }

  const copyAndOpen = async () => {
    const copied = await decide('COPY')
    if (!copied) return
    await ctx.os.writeClipboard(bodyForEditor(copied.body))
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
    if (
      !actionCardMatchesDirective(approvedCard, actionId) ||
      approvedCard.status !== 'APPROVED'
    ) {
      return
    }
    if (!criticAllowsAction(approvedCard, runtime)) {
      setError(
        'Cette action reste bloquée tant que la vérification du brouillon n’est pas terminée.'
      )
      return null
    }
    setWorking('execute')
    setError('')
    try {
      const result = await ctx.rest(
        API_PATHS.actionExecute(approvedCard.id),
        {
        method: 'POST',
        body: { expectedVersion: approvedCard.version }
        }
      )
      applyCard(result.card)
      const channel = result.execution.channel
      host.notify({
        kind: 'success',
        message:
          channel === 'KEPLER_INFO_REQUEST'
            ? `Info Request n° ${result.execution.threadId} envoyée au vendeur`
            : channel === 'INTERCOM_VENDOR_EMAIL'
              ? 'E-mail vendeur envoyé via Intercom'
              : channel === 'INTERCOM_CUSTOMER_EMAIL'
                ? 'Nouvelle conversation client créée dans Intercom'
                : 'Réponse client envoyée via Intercom'
      })
      return result.card
    } catch (executeError) {
      setError(
        readableUiError(
          executeError,
          "L’action n’a pas été confirmée. Actualisez la carte et vérifiez Intercom ou Kepler avant toute nouvelle tentative.",
        )
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
        'INTERCOM_CUSTOMER_EMAIL',
        'INTERCOM_VENDOR_EMAIL',
        'KEPLER_INFO_REQUEST'
      ].includes(approved.metadata?.channel)
    ) {
      await executeApproved(approved)
      return
    }
    host.notify({ kind: 'success', message: 'Action approuvée' })
  }

  const recordOutcome = async outcome => {
    if (
      !card ||
      card.status !== 'SENT' ||
      !UUID_RE.test(card.caseEpisodeId || '')
    ) {
      return
    }
    if (outcome === 'NEGATIVE' && !outcomeReason.trim()) {
      setError(
        'Indiquez brièvement ce qui reste à résoudre avant d’enregistrer ce retour.'
      )
      return
    }
    const precedentRevisionIds = Array.isArray(
      card.metadata?.precedentRevisionIds
    )
      ? card.metadata.precedentRevisionIds.filter(value =>
          UUID_RE.test(String(value || ''))
        )
      : []
    setWorking(`outcome-${outcome}`)
    setError('')
    try {
      await ctx.rest(API_PATHS.actionOutcome(card.id), {
        method: 'POST',
        body: {
          expectedVersion: card.version,
          episodeId: card.caseEpisodeId,
          outcome,
          attributable: true,
          ...(precedentRevisionIds.length === 1
            ? {
                precedentRevisionId: precedentRevisionIds[0],
                attributionAmbiguous: false
              }
            : {
                attributionAmbiguous:
                  precedentRevisionIds.length > 1
              }),
          ...(outcome === 'NEGATIVE'
            ? { reason: outcomeReason.trim() }
            : {})
        }
      })
      setOutcomeRecorded(outcome)
      host.notify({
        kind: 'success',
        message:
          outcome === 'POSITIVE'
            ? 'Résolution confirmée'
            : 'Suivi à poursuivre enregistré'
      })
    } catch {
      setError(
        'Ce retour n’a pas pu être enregistré. Rechargez la carte puis réessayez.'
      )
    } finally {
      setWorking('')
    }
  }

  if (!UUID_RE.test(actionId)) return null
  if (
    streaming ||
    loading ||
    (card && !actionCardMatchesDirective(card, actionId))
  ) {
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
            onClick: () => void load(true),
            children: 'Réessayer'
          })
        ]
      })
    })
  }

  const finalState = [
    'EXECUTING',
    'REJECTED',
    'MONITORING',
    'SENT',
    'SUPERSEDED'
  ].includes(card.status)
  const actionAllowed = criticAllowsAction(card, runtime, dirty)
  const deliveryConversationUrl =
    typeof card.metadata?.delivery?.conversationUrl === 'string'
      ? card.metadata.delivery.conversationUrl
      : ''
  const recipientEmail =
    typeof card.metadata?.customerEmail === 'string'
      ? card.metadata.customerEmail
      : typeof card.metadata?.delivery?.recipientEmail === 'string'
        ? card.metadata.delivery.recipientEmail
        : ''

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
                children: `Destinataire : ${card.recipientLabel}${
                  recipientEmail ? ` · ${recipientEmail}` : ''
                } · ${card.language.toUpperCase()}`
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
          [
            'INTERCOM_VENDOR_EMAIL',
            'INTERCOM_CUSTOMER_EMAIL'
          ].includes(card.metadata?.channel)
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
          materialChange
            ? jsx(Input, {
                value: editReason,
                maxLength: 500,
                disabled: !canEdit || Boolean(working),
                placeholder: 'Pourquoi cette modification importante ?',
                'aria-label': 'Raison de la modification importante',
                onChange: event => setEditReason(event.target.value)
              })
            : null,
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
          isV2Live(runtime) &&
          card.status === 'SENT' &&
          UUID_RE.test(card.caseEpisodeId || '')
            ? outcomeRecorded
              ? jsx('div', {
                  role: 'status',
                  style: {
                    color: 'var(--ui-text-secondary)',
                    fontSize: '12px'
                  },
                  children:
                    outcomeRecorded === 'POSITIVE'
                      ? 'Vous avez confirmé que cette action a résolu le dossier.'
                      : 'Vous avez indiqué que le suivi doit continuer.'
                })
              : jsxs('section', {
                  'aria-label': 'Résultat de l’action',
                  style: {
                    display: 'grid',
                    gap: '8px',
                    padding: '10px',
                    border: '1px solid var(--ui-stroke-secondary)',
                    borderRadius: '8px'
                  },
                  children: [
                    jsx('strong', {
                      style: { fontSize: '12px' },
                      children:
                        'Cette action a-t-elle résolu le dossier ?'
                    }),
                    jsx(Input, {
                      value: outcomeReason,
                      maxLength: 2000,
                      disabled: Boolean(working),
                      placeholder:
                        'Si le problème continue, indiquez brièvement pourquoi',
                      'aria-label':
                        'Raison pour laquelle le suivi doit continuer',
                      onChange: event =>
                        setOutcomeReason(event.target.value)
                    }),
                    jsxs('div', {
                      style: rowStyle,
                      children: [
                        jsx(Button, {
                          size: 'sm',
                          disabled: Boolean(working),
                          onClick: () =>
                            void recordOutcome('POSITIVE'),
                          children: 'Oui, solution confirmée'
                        }),
                        jsx(Button, {
                          size: 'sm',
                          variant: 'secondary',
                          disabled:
                            Boolean(working) ||
                            !outcomeReason.trim(),
                          onClick: () =>
                            void recordOutcome('NEGATIVE'),
                          children: 'Non, poursuivre le suivi'
                        })
                      ]
                    })
                  ]
                })
            : null,
          jsx(CriticStatus, { card, runtime, dirty }),
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
                    placeholder: 'Pourquoi refusez-vous ce brouillon ?',
                    onChange: event => setRejectReason(event.target.value),
                    autoFocus: true
                  }),
                  jsxs('div', {
                    style: rowStyle,
                    children: [
                      jsx(Button, {
                        size: 'sm',
                        onClick: reject,
                        disabled: Boolean(working) || !rejectReason.trim(),
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
              isV2Live(runtime) &&
              canEdit &&
              !dirty &&
              !actionAllowed
                ? jsx(Button, {
                    size: 'sm',
                    variant: 'secondary',
                    onClick: () =>
                      void requestActionCardRecheck(ctx),
                    disabled: Boolean(working),
                    children: 'Demander une nouvelle vérification'
                  })
                : null,
              card.status === 'DRAFT'
                ? jsx(Button, {
                    size: 'sm',
                    onClick: approve,
                    disabled:
                      Boolean(working) ||
                      !body.trim() ||
                      !actionAllowed,
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
              deliveryConversationUrl
                ? jsx(Button, {
                    size: 'sm',
                    variant: 'secondary',
                    onClick: () =>
                      void ctx.os.openExternal(
                        deliveryConversationUrl
                      ),
                    children:
                      'Ouvrir la nouvelle conversation Intercom'
                  })
                : null,
              ['APPROVED', 'COPIED'].includes(card.status) &&
              (card.metadata?.channel === 'INTERCOM_SIDE_CONVERSATION' ||
                card.metadata?.channel === 'INTERCOM_CUSTOMER_REPLY')
                ? jsx(Button, {
                    size: 'sm',
                    onClick: copyAndOpen,
                    disabled: Boolean(working) || !actionAllowed,
                    children:
                      card.kind === 'VENDOR_SIDE_CONVERSATION'
                        ? 'Copier et ouvrir Intercom'
                        : 'Copier la réponse approuvée'
                  })
                : null,
              [
                'INTERCOM_CUSTOMER_REPLY',
                'INTERCOM_CUSTOMER_EMAIL',
                'INTERCOM_VENDOR_EMAIL',
                'KEPLER_INFO_REQUEST'
              ].includes(card.metadata?.channel) &&
              card.status === 'APPROVED'
                ? jsx(Button, {
                    size: 'sm',
                    onClick: () => executeApproved(card),
                    disabled: Boolean(working) || !actionAllowed,
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
                    disabled: Boolean(working) || !actionAllowed,
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
const CS_OVERVIEW_FOCUSES = new Set([
  'ALL',
  'PRIORITY_CUSTOMERS',
  'VENDOR_FOLLOW_UP',
  'CUSTOMS',
  'DELIVERY_RISK',
  'RETURNS'
])

function normalizeCsOverviewFocus(value) {
  const normalized = String(value || 'ALL').trim().toUpperCase()
  return CS_OVERVIEW_FOCUSES.has(normalized)
    ? normalized
    : 'ALL'
}

function priorityLabel(priority) {
  return {
    CRITICAL: 'Critique',
    URGENT: 'Urgent',
    HIGH: 'Priorité élevée',
    MEDIUM: 'Priorité normale',
    LOW: 'Priorité faible'
  }[priority] || 'À évaluer'
}

function priorityPill(priority) {
  const tone =
    {
      CRITICAL: {
        color: '#f87171',
        background: 'rgba(239, 68, 68, 0.15)',
        border: 'rgba(248, 113, 113, 0.35)'
      },
      URGENT: {
        color: '#fb923c',
        background: 'rgba(249, 115, 22, 0.15)',
        border: 'rgba(251, 146, 60, 0.35)'
      },
      HIGH: {
        color: '#fbbf24',
        background: 'rgba(245, 158, 11, 0.14)',
        border: 'rgba(251, 191, 36, 0.34)'
      },
      MEDIUM: {
        color: '#60a5fa',
        background: 'rgba(59, 130, 246, 0.14)',
        border: 'rgba(96, 165, 250, 0.34)'
      },
      LOW: {
        color: '#86efac',
        background: 'rgba(34, 197, 94, 0.12)',
        border: 'rgba(134, 239, 172, 0.3)'
      }
    }[priority] || {
      color: 'var(--ui-text-secondary)',
      background: 'var(--ui-bg-primary)',
      border: 'var(--ui-stroke-secondary)'
    }
  return jsxs('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '3px 8px',
      border: `1px solid ${tone.border}`,
      borderRadius: '999px',
      background: tone.background,
      color: tone.color,
      fontSize: '11px',
      fontWeight: 700,
      whiteSpace: 'nowrap'
    },
    children: [
      jsx('span', {
        'aria-hidden': true,
        style: {
          width: '6px',
          height: '6px',
          borderRadius: '999px',
          background: 'currentColor'
        }
      }),
      priorityLabel(priority)
    ]
  })
}

const WORKFLOW_PHASE_LABELS = {
  NEW: 'Nouveau dossier',
  INVESTIGATING: 'Analyse en cours',
  WAITING_CUSTOMER: 'En attente du client',
  WAITING_VENDOR: 'En attente du vendeur',
  WAITING_INTERNAL: 'En attente de l’équipe',
  READY_TO_REPLY: 'Réponse à préparer',
  MONITORING: 'Suivi en cours',
  CLOSURE_CONFIRMATION: 'Clôture à confirmer'
}

function humanOwnerLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Non attribué'
  const normalized = value.trim()
  if (normalized === 'lyse') return 'Lyse'
  if (normalized === 'philippine') return 'Philippine'
  return normalized.slice(0, 120)
}

function normalizeWorkflow(value) {
  const nested =
    value?.workflow ||
    value?.caseWorkflow ||
    value?.caseWatch ||
    value?.watch ||
    value?.payload?.workflow ||
    value?.payload?.caseWorkflow ||
    value?.payload?.situation?.workflow ||
    value?.payload?.situation?.caseWorkflow
  const raw =
    nested && typeof nested === 'object'
      ? nested
      : value && typeof value === 'object'
        ? value
        : null
  if (!raw) return null
  const workflowId =
    raw.id || raw.watchId || raw.caseWatchId || raw.workflowId
  if (!UUID_RE.test(String(workflowId || ''))) return null

  const claim =
    raw.claim && typeof raw.claim === 'object' ? raw.claim : {}
  const assignment =
    raw.assignment && typeof raw.assignment === 'object'
      ? raw.assignment
      : {}
  const closure =
    raw.closure && typeof raw.closure === 'object' ? raw.closure : {}
  const sla = raw.sla && typeof raw.sla === 'object' ? raw.sla : {}
  const owner =
    raw.owner && typeof raw.owner === 'object' ? raw.owner : {}
  const capabilities =
    raw.capabilities && typeof raw.capabilities === 'object'
      ? raw.capabilities
      : {}
  const phase = String(
    raw.phase || raw.workflowPhase || 'INVESTIGATING'
  )
  const ownerLabel = humanOwnerLabel(
    owner.displayName ||
      owner.label ||
      raw.ownerLabel ||
      raw.operatorName ||
      raw.operatorRef
  )
  const claimExpiresAt =
    claim.expiresAt || raw.claimExpiresAt || raw.reservationExpiresAt || null
  const expectedVersion = Number(
    raw.version ?? raw.workflowVersion ?? raw.expectedVersion
  )
  return {
    id: String(workflowId),
    version:
      Number.isInteger(expectedVersion) && expectedVersion > 0
        ? expectedVersion
        : null,
    phase,
    phaseLabel:
      WORKFLOW_PHASE_LABELS[phase] || 'Suivi du dossier',
    ownerLabel,
    nextAction:
      typeof raw.nextAction === 'string'
        ? raw.nextAction.slice(0, 500)
        : typeof raw.nextAction?.label === 'string'
          ? raw.nextAction.label.slice(0, 500)
          : 'À préciser',
    resolutionCriteria:
      typeof raw.resolutionCriteria === 'string'
        ? raw.resolutionCriteria.slice(0, 4000)
        : null,
    slaDueAt: sla.dueAt || raw.slaDueAt || raw.dueAt || null,
    slaStatus: String(sla.status || raw.slaStatus || ''),
    claimExpiresAt:
      typeof claimExpiresAt === 'string' ? claimExpiresAt : null,
    reservationRef:
      typeof claim.reservationRef === 'string'
        ? claim.reservationRef
        : typeof raw.reservationRef === 'string'
          ? raw.reservationRef
          : null,
    claimState: String(
      claim.state || raw.claimState || raw.reservationState || ''
    ),
    claimOwnerLabel: humanOwnerLabel(
      claim.owner?.displayName ||
        claim.ownerLabel ||
        claim.operatorName ||
        claim.operatorRef
    ),
    assignmentConfirmationRequired:
      assignment.confirmationRequired === true ||
      raw.assignmentConfirmationRequired === true,
    closureConfirmationRequired:
      closure.confirmationRequired === true ||
      closure.required === true ||
      raw.closureConfirmationRequired === true ||
      phase === 'CLOSURE_CONFIRMATION',
    canClaim:
      capabilities.claim === true || raw.canClaim === true,
    canConfirmAssignment:
      capabilities.confirmAssignment === true ||
      raw.canConfirmAssignment === true,
    canClose:
      capabilities.close === true ||
      closure.canClose === true ||
      raw.canClose === true,
    canContinue:
      capabilities.continue === true ||
      closure.canContinue === true ||
      raw.canContinue === true
  }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    Boolean(
      typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    )
  )
  useEffect(() => {
    const media = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)'
    )
    if (!media) return undefined
    const update = event => setReduced(event.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return reduced
}

/*
 * Vision UI fan-in contract (Desktop only)
 *
 * Transcript directive:
 *   ::oblist-vision{payloadRef="vision-ui:…" caseRef="case:…"}
 *
 * The directive deliberately contains no JSON and no URL. The authenticated
 * fan-in must resolve payloadRef and provide the following object out-of-band
 * as the renderer's `payload` value (notifications/briefs may expose the same
 * object as `visionUi` in their already-authenticated API response):
 *
 * {
 *   uiContractVersion: "1.0.0",
 *   origin: "AUTHENTICATED_API",
 *   payloadRef, caseRef, generatedAt,
 *   permissions: { canViewInternalAttachments: boolean },
 *   attachmentBundle: AttachmentAnalysisBundleV1 | null,
 *   productCards: ProductContextCard[],              // max 6 rendered
 *   conformityComparisons: ProductConformityComparison[],
 *   attachmentLinks: [{
 *     attachmentRef,
 *     previewUrl?, openAttachmentUrl?, openSourceUrl?,
 *     width?, height?, expiresAt?
 *   }]
 * }
 *
 * Attachment links are short-lived API output and never accepted from
 * transcript attrs. Missing structuredContent is hydrated only through
 * ctx.rest and the authenticated ref-only routes declared in API_PATHS.
 */
function isVisionRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
}

function visionString(value, max = 1_000, nullable = false) {
  if (typeof value !== 'string') return nullable ? null : ''
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    return nullable ? null : ''
  }
  return normalized
}

function visionRef(value) {
  return visionString(value, 500)
}

function visionIsoDate(value) {
  const normalized = visionString(value, 100)
  if (!normalized) return null
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function visionConfidence(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : null
}

function visionEnum(value, allowed, fallback = null) {
  return allowed.includes(value) ? value : fallback
}

function visionHttpsUrl(
  value,
  { allowSigned = false, shopifyImage = false } = {}
) {
  if (typeof value !== 'string' || value.length > 2_048) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null
    }
    if (!allowSigned) {
      for (const parameter of url.searchParams.keys()) {
        if (
          VISION_SIGNED_QUERY_PARAMETERS.has(parameter.toLowerCase())
        ) {
          return null
        }
      }
    }
    if (shopifyImage) {
      const hostName = url.hostname.toLowerCase()
      if (
        hostName !== 'cdn.shopify.com' &&
        !hostName.endsWith('.shopifycdn.com') &&
        !hostName.endsWith('.myshopify.com')
      ) {
        return null
      }
    }
    return url.toString()
  } catch {
    return null
  }
}

function visionUrlHasSignedParameter(value) {
  try {
    const url = new URL(value)
    return [...url.searchParams.keys()].some(parameter =>
      VISION_SIGNED_QUERY_PARAMETERS.has(parameter.toLowerCase())
    )
  } catch {
    return false
  }
}

function normalizeVisionAuthor(value) {
  if (!isVisionRecord(value)) return null
  const role = visionEnum(value.role, [
    'CUSTOMER',
    'VENDOR',
    'ADMIN',
    'BOT',
    'SYSTEM',
    'UNVERIFIED_EXTERNAL'
  ])
  const identityStatus = visionEnum(value.identityStatus, [
    'VERIFIED_CUSTOMER',
    'VERIFIED_VENDOR',
    'VERIFIED_ADMIN',
    'UNVERIFIED_EXTERNAL',
    'SYSTEM_IDENTITY',
    'NOT_APPLICABLE'
  ])
  if (!role || !identityStatus) return null
  const expectedRole = {
    VERIFIED_CUSTOMER: 'CUSTOMER',
    VERIFIED_VENDOR: 'VENDOR',
    VERIFIED_ADMIN: 'ADMIN',
    UNVERIFIED_EXTERNAL: 'UNVERIFIED_EXTERNAL'
  }[identityStatus]
  const authorRef = visionString(value.authorRef, 500, true)
  if (
    (expectedRole && role !== expectedRole) ||
    (identityStatus.startsWith('VERIFIED_') && !authorRef)
  ) {
    return null
  }
  return {
    role,
    identityStatus,
    authorRef,
    displayName: visionString(value.displayName, 300, true)
  }
}

function normalizeVisionDescriptor(value, expectedCaseRef) {
  if (
    !isVisionRecord(value) ||
    value.contractVersion !== '1.0.0'
  ) {
    return null
  }
  const attachmentRef = visionRef(value.attachmentRef)
  const caseRef = visionRef(value.caseRef)
  const source = visionEnum(value.source, [
    'INTERCOM_CONVERSATION',
    'INTERCOM_SIDE_CONVERSATION',
    'RETURN_PORTAL',
    'INFO_REQUEST'
  ])
  const visibility = visionEnum(value.visibility, [
    'CUSTOMER_THREAD',
    'VENDOR_THREAD',
    'INTERNAL'
  ])
  const mediaKind = visionEnum(value.mediaKind, [
    'IMAGE',
    'PDF',
    'DOCUMENT',
    'SPREADSHEET',
    'VIDEO',
    'AUDIO',
    'ARCHIVE',
    'EXECUTABLE',
    'OTHER'
  ])
  const analysisDisposition = visionEnum(value.analysisDisposition, [
    'ANALYZE',
    'LINK_ONLY',
    'UNSUPPORTED'
  ])
  const author = normalizeVisionAuthor(value.author)
  const occurredAt = visionIsoDate(value.occurredAt)
  const fileName = visionString(value.fileName, 1_000)
  const sourceContainerRef = visionRef(value.sourceContainerRef)
  const sourceMessageRef = visionRef(value.sourceMessageRef)
  const sourceFileRef = visionRef(value.sourceFileRef)
  const sideConversationRef = visionString(
    value.sideConversationRef,
    500,
    true
  )
  if (
    !attachmentRef ||
    !caseRef ||
    caseRef !== expectedCaseRef ||
    !source ||
    !visibility ||
    !mediaKind ||
    !analysisDisposition ||
    !author ||
    !occurredAt ||
    !fileName ||
    !sourceContainerRef ||
    !sourceMessageRef ||
    !sourceFileRef ||
    (source === 'INTERCOM_SIDE_CONVERSATION' &&
      !sideConversationRef) ||
    (source !== 'INTERCOM_SIDE_CONVERSATION' &&
      sideConversationRef)
  ) {
    return null
  }
  if (
    (mediaKind === 'VIDEO' && analysisDisposition !== 'LINK_ONLY') ||
    (mediaKind === 'EXECUTABLE' &&
      analysisDisposition !== 'UNSUPPORTED')
  ) {
    return null
  }
  return {
    attachmentRef,
    caseRef,
    source,
    visibility,
    mediaKind,
    analysisDisposition,
    author,
    occurredAt,
    fileName,
    sourceContainerRef,
    sourceMessageRef,
    sourceFileRef,
    sideConversationRef
  }
}

function normalizeDerivedVisionCitations(value, attachmentRef) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value.slice(0, 200).flatMap(citation => {
    if (
      !isVisionRecord(citation) ||
      citation.authority !== 'DERIVED' ||
      citation.sourceKind !== 'ATTACHMENT' ||
      visionRef(citation.sourceRef) !== attachmentRef
    ) {
      return []
    }
    const citationId = visionString(citation.citationId, 100)
    if (!citationId || seen.has(citationId)) return []
    seen.add(citationId)
    return [{
      citationId,
      sourceRef: attachmentRef,
      excerpt: visionString(citation.excerpt, 1_500, true)
    }]
  })
}

function normalizeCitedVisionItems(value, citationIds, limit) {
  if (!Array.isArray(value)) return []
  return value.slice(0, limit).flatMap(item => {
    if (!isVisionRecord(item)) return []
    const text = visionString(
      item.text || item.description || item.question,
      4_000
    )
    const refs = Array.isArray(item.citationIds)
      ? item.citationIds
          .map(reference => visionString(reference, 100))
          .filter(reference => citationIds.has(reference))
          .slice(0, 20)
      : []
    if (!text || refs.length === 0) return []
    return [{
      text,
      confidence: visionConfidence(item.confidence),
      citationIds: refs,
      kind: visionString(item.kind || item.category, 100, true),
      severity: visionString(item.severity, 100, true)
    }]
  })
}

function normalizeVisionInsight(value, attachmentRef) {
  if (
    !isVisionRecord(value) ||
    value.contractVersion !== '1.0.0' ||
    value.authority !== 'DERIVED' ||
    value.status !== 'READY' ||
    value.redacted !== true ||
    value.untrustedContent !== true ||
    visionRef(value.attachmentRef) !== attachmentRef
  ) {
    return null
  }
  const summary = visionString(value.summary, 4_000)
  const citations = normalizeDerivedVisionCitations(
    value.citations,
    attachmentRef
  )
  if (!summary || citations.length === 0) return null
  const citationIds = new Set(
    citations.map(citation => citation.citationId)
  )
  return {
    authority: 'DERIVED',
    summary,
    purpose: visionEnum(value.purpose, [
      'DAMAGE_EVIDENCE',
      'PRODUCT_CONFORMITY',
      'PAYMENT_EVIDENCE',
      'CUSTOMS_EVIDENCE',
      'SHIPPING_EVIDENCE',
      'IDENTITY_EVIDENCE',
      'RETURN_EVIDENCE',
      'GENERAL_CASE_EVIDENCE',
      'UNKNOWN'
    ], 'UNKNOWN'),
    documentKind: visionString(value.documentKind, 100, true),
    confidence: visionConfidence(value.confidence),
    visualObservations: normalizeCitedVisionItems(
      value.visualObservations,
      citationIds,
      100
    ),
    damages: normalizeCitedVisionItems(
      value.damages,
      citationIds,
      50
    ),
    verificationChecks: normalizeCitedVisionItems(
      value.verificationChecks,
      citationIds,
      50
    ),
    citations
  }
}

function normalizeVisionAttachmentItem(value, expectedCaseRef) {
  if (!isVisionRecord(value)) return null
  const descriptor = normalizeVisionDescriptor(
    value.descriptor,
    expectedCaseRef
  )
  const declaredStatus = visionEnum(value.status, [
    ...VISION_PENDING_STATUSES,
    ...VISION_TERMINAL_STATUSES
  ])
  if (!descriptor || !declaredStatus) return null

  let status =
    descriptor.mediaKind === 'VIDEO' ? 'LINK_ONLY' : declaredStatus
  let insight =
    status === 'READY'
      ? normalizeVisionInsight(
          value.insight,
          descriptor.attachmentRef
        )
      : null
  let invalidReadyResult = false
  if (status === 'READY' && !insight) {
    status = 'FAILED'
    invalidReadyResult = true
  }
  if (descriptor.mediaKind === 'VIDEO') insight = null
  const actions = Array.isArray(value.freshLinkActions)
    ? [...new Set(
        value.freshLinkActions.filter(action =>
          ['OPEN_ATTACHMENT', 'OPEN_SOURCE'].includes(action)
        )
      )].slice(0, 2)
    : []
  return {
    descriptor,
    status,
    insight,
    freshLinkActions: actions,
    invalidReadyResult
  }
}

function normalizeVisionSynthesis(value, expectedCaseRef) {
  if (
    !isVisionRecord(value) ||
    value.contractVersion !== '1.0.0' ||
    value.authority !== 'DERIVED' ||
    value.redacted !== true ||
    visionRef(value.caseRef) !== expectedCaseRef
  ) {
    return null
  }
  const summary = visionString(value.summary, 4_000)
  return summary
    ? {
        authority: 'DERIVED',
        summary,
        criticalEvidenceStatus: visionEnum(
          value.criticalEvidenceStatus,
          ['NOT_PRESENT', 'PENDING', 'READY', 'FAILED'],
          'NOT_PRESENT'
        ),
        confidence: visionConfidence(value.confidence)
      }
    : null
}

function normalizeVisionAttachmentBundle(value, expectedCaseRef) {
  if (value === null || value === undefined) return null
  if (
    !isVisionRecord(value) ||
    value.contractVersion !== '1.0.0' ||
    visionRef(value.caseRef) !== expectedCaseRef
  ) {
    return null
  }
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .slice(0, 100)
        .map(item =>
          normalizeVisionAttachmentItem(item, expectedCaseRef)
        )
        .filter(Boolean)
    : []
  const pending = attachments.filter(item =>
    VISION_PENDING_STATUSES.has(item.status)
  ).length
  const ready = attachments.filter(
    item => item.status === 'READY'
  ).length
  const linkOnly = attachments.filter(
    item => item.status === 'LINK_ONLY'
  ).length
  const unsupported = attachments.filter(
    item => item.status === 'UNSUPPORTED'
  ).length
  const failed = attachments.filter(item =>
    VISION_FAILED_STATUSES.has(item.status)
  ).length
  return {
    bundleRef: visionRef(value.bundleRef),
    caseRef: expectedCaseRef,
    status: visionEnum(
      value.status,
      ['PENDING', 'PARTIAL', 'READY', 'FAILED'],
      pending > 0 ? 'PENDING' : failed > 0 ? 'PARTIAL' : 'READY'
    ),
    attachments,
    omittedAttachmentCount:
      Number.isInteger(value.omittedAttachmentCount) &&
      value.omittedAttachmentCount >= 0
        ? value.omittedAttachmentCount
        : 0,
    counts: {
      total:
        attachments.length +
        (Number.isInteger(value.omittedAttachmentCount) &&
        value.omittedAttachmentCount >= 0
          ? value.omittedAttachmentCount
          : 0),
      pending,
      ready,
      linkOnly,
      unsupported,
      failed
    },
    synthesis: normalizeVisionSynthesis(
      value.synthesis,
      expectedCaseRef
    )
  }
}

function hasVisionSystemCitation(value, allowedRefs) {
  return (
    Array.isArray(value) &&
    value.some(
      citation =>
        isVisionRecord(citation) &&
        citation.authority === 'SYSTEM_OF_RECORD' &&
        [
          'ORDER_LINE_ITEM',
          'ORDER_TIME_PRODUCT_SNAPSHOT',
          'CURRENT_PRODUCT_PAGE'
        ].includes(citation.sourceKind) &&
        allowedRefs.has(visionRef(citation.sourceRef))
    )
  )
}

function hasVisionAttachmentCitation(value, attachmentRefs) {
  return (
    Array.isArray(value) &&
    value.some(
      citation =>
        isVisionRecord(citation) &&
        citation.authority === 'DERIVED' &&
        citation.sourceKind === 'ATTACHMENT' &&
        attachmentRefs.has(visionRef(citation.sourceRef))
    )
  )
}

function normalizeVisionProductCard(value) {
  if (
    !isVisionRecord(value) ||
    value.contractVersion !== '1.0.0' ||
    value.authority !== 'SYSTEM_OF_RECORD'
  ) {
    return null
  }
  const productRef = visionRef(value.productRef)
  const orderItemRef = visionRef(value.orderItemRef)
  const title = visionString(value.title, 1_000)
  const vendorName = visionString(value.vendorName, 500)
  const displayMode = visionEnum(value.displayMode, [
    'AUTO_CONTEXT',
    'EXPLICIT',
    'HIDDEN'
  ])
  const displayReason = visionString(
    value.displayReason,
    1_000,
    true
  )
  const catalogStatus = visionEnum(value.catalogStatus, [
    'PUBLISHED',
    'UNPUBLISHED',
    'UNKNOWN'
  ])
  const citationRefs = new Set([productRef, orderItemRef])
  if (
    !productRef ||
    !orderItemRef ||
    !title ||
    !vendorName ||
    !displayMode ||
    !catalogStatus ||
    !hasVisionSystemCitation(value.citations, citationRefs) ||
    (displayMode !== 'HIDDEN' && !displayReason) ||
    !Number.isInteger(value.quantity) ||
    value.quantity < 1 ||
    value.quantity > 10_000
  ) {
    return null
  }
  const published = catalogStatus === 'PUBLISHED'
  return {
    productRef,
    orderItemRef,
    title,
    vendorName,
    variantTitle: visionString(value.variantTitle, 1_000, true),
    quantity: value.quantity,
    imageUrl: published
      ? visionHttpsUrl(value.imageUrl, { shopifyImage: true })
      : null,
    productUrl: published
      ? visionHttpsUrl(value.productUrl)
      : null,
    imageAlt:
      visionString(value.imageAlt, 1_000) ||
      `Photo de référence — ${title}`,
    catalogStatus,
    displayMode,
    displayReason,
    authority: 'SYSTEM_OF_RECORD'
  }
}

function normalizeVisionMeasurement(value, attachmentRefs) {
  if (
    !isVisionRecord(value) ||
    !hasVisionAttachmentCitation(value.citations, attachmentRefs)
  ) {
    return null
  }
  const name = visionString(value.name, 200)
  const method = visionEnum(value.method, [
    'FORM_VALUE',
    'DOCUMENT_DIMENSION',
    'READABLE_SCALE',
    'UNSCALED_IMAGE'
  ])
  const reliability = visionEnum(value.reliability, [
    'STRONG',
    'LIMITED',
    'NOT_VERIFIABLE'
  ])
  if (!name || !method || !reliability) return null
  const rawValue =
    typeof value.value === 'string' &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?$/.test(value.value)
      ? value.value
      : null
  const rawUnit = visionEnum(value.unit, ['MM', 'CM', 'M', 'IN'])
  const mayExposeValue =
    method !== 'UNSCALED_IMAGE' &&
    reliability !== 'NOT_VERIFIABLE' &&
    rawValue &&
    rawUnit
  return {
    measurementId:
      visionString(value.measurementId, 100) ||
      `${name}:${method}:${reliability}`,
    name,
    method,
    reliability,
    value: mayExposeValue ? rawValue : null,
    unit: mayExposeValue ? rawUnit : null
  }
}

function normalizeVisionDifference(value) {
  if (!isVisionRecord(value)) return null
  const field = visionEnum(value.field, [
    'VARIANT',
    'SKU',
    'DIMENSION',
    'MATERIAL',
    'COLOR',
    'SHAPE',
    'FINISH',
    'COMPONENT',
    'DESCRIPTION',
    'OTHER'
  ])
  const assessment = visionEnum(value.assessment, [
    'CONFIRMED',
    'POSSIBLE',
    'UNRESOLVED'
  ])
  const confidence = visionConfidence(value.confidence)
  if (!field || !assessment || confidence === null) return null
  return {
    differenceId:
      visionString(value.differenceId, 100) ||
      `${field}:${assessment}`,
    field,
    assessment,
    confidence,
    expectedValue: visionString(
      value.expectedValue,
      2_000,
      true
    ),
    observedValue: visionString(
      value.observedValue,
      2_000,
      true
    )
  }
}

function normalizeVisionConformity(
  value,
  productRefs,
  attachmentRefs
) {
  if (
    !isVisionRecord(value) ||
    value.contractVersion !== '1.0.0' ||
    value.authority !== 'DERIVED'
  ) {
    return null
  }
  const productRef = visionRef(value.productRef)
  const orderItemRef = visionRef(value.orderItemRef)
  const verdict = visionEnum(value.verdict, [
    'MATCH',
    'DIFFERENCE_CONFIRMED',
    'POSSIBLE_DIFFERENCE',
    'NOT_VERIFIABLE'
  ])
  const confidence = visionConfidence(value.confidence)
  if (
    !productRef ||
    !orderItemRef ||
    !productRefs.has(productRef) ||
    !verdict ||
    confidence === null ||
    !isVisionRecord(value.expected) ||
    value.expected.authority !== 'SYSTEM_OF_RECORD' ||
    !isVisionRecord(value.observed) ||
    value.observed.authority !== 'DERIVED'
  ) {
    return null
  }
  const differences = Array.isArray(value.differences)
    ? value.differences
        .slice(0, 50)
        .map(item => {
          if (
            !hasVisionSystemCitation(
              item?.expectedCitations,
              new Set([productRef, orderItemRef])
            ) ||
            !hasVisionAttachmentCitation(
              item?.observedCitations,
              attachmentRefs
            )
          ) {
            return null
          }
          return normalizeVisionDifference(item)
        })
        .filter(Boolean)
    : []
  const blockingUnknowns = Array.isArray(value.blockingUnknowns)
    ? value.blockingUnknowns
        .slice(0, 20)
        .map(item => visionString(item, 4_000))
        .filter(Boolean)
    : []
  if (
    (verdict === 'MATCH' && differences.length > 0) ||
    (verdict === 'DIFFERENCE_CONFIRMED' &&
      !differences.some(item => item.assessment === 'CONFIRMED')) ||
    (verdict === 'NOT_VERIFIABLE' &&
      blockingUnknowns.length === 0)
  ) {
    return null
  }
  if (
    !hasVisionSystemCitation(
      value.expected.citations,
      new Set([productRef, orderItemRef])
    )
  ) {
    return null
  }
  const referenceImageUrls = Array.isArray(
    value.expected.referenceImageUrls
  )
    ? value.expected.referenceImageUrls
        .slice(0, 3)
        .map(url =>
          visionHttpsUrl(url, { shopifyImage: true })
        )
        .filter(Boolean)
    : []
  const measurements = Array.isArray(value.observed.measurements)
    ? value.observed.measurements
        .slice(0, 20)
        .map(item =>
          normalizeVisionMeasurement(item, attachmentRefs)
        )
        .filter(Boolean)
    : []
  return {
    productRef,
    orderItemRef,
    authority: 'DERIVED',
    expected: {
      authority: 'SYSTEM_OF_RECORD',
      referenceBasis: visionEnum(
        value.expected.referenceBasis,
        [
          'ORDER_LINE_ITEM',
          'ORDER_TIME_PRODUCT_SNAPSHOT',
          'CURRENT_PRODUCT_PAGE'
        ],
        'CURRENT_PRODUCT_PAGE'
      ),
      variantTitle: visionString(
        value.expected.variantTitle,
        1_000,
        true
      ),
      sku: visionString(value.expected.sku, 300, true),
      referenceImageUrls
    },
    observed: {
      authority: 'DERIVED',
      measurements
    },
    differences,
    verdict,
    confidence,
    blockingUnknowns
  }
}

function normalizeVisionAttachmentLinks(value, attachments) {
  if (!Array.isArray(value)) return new Map()
  const byRef = new Map(
    attachments.map(item => [
      item.descriptor.attachmentRef,
      item
    ])
  )
  const links = new Map()
  value.slice(0, 100).forEach(item => {
    if (!isVisionRecord(item)) return
    const attachmentRef = visionRef(item.attachmentRef)
    const attachment = byRef.get(attachmentRef)
    if (!attachment || links.has(attachmentRef)) return
    const canOpenAttachment =
      attachment.freshLinkActions.includes('OPEN_ATTACHMENT')
    const canOpenSource =
      attachment.freshLinkActions.includes('OPEN_SOURCE')
    const width =
      Number.isInteger(item.width) &&
      item.width >= 16 &&
      item.width <= 10_000
        ? item.width
        : 640
    const height =
      Number.isInteger(item.height) &&
      item.height >= 16 &&
      item.height <= 10_000
        ? item.height
        : 480
    links.set(attachmentRef, {
      attachmentRef,
      previewUrl:
        canOpenAttachment &&
        attachment.descriptor.mediaKind === 'IMAGE'
          ? visionHttpsUrl(item.previewUrl, { allowSigned: true })
          : null,
      openAttachmentUrl: canOpenAttachment
        ? visionHttpsUrl(item.openAttachmentUrl, {
            allowSigned: true
          })
        : null,
      openSourceUrl: canOpenSource
        ? visionHttpsUrl(item.openSourceUrl, { allowSigned: true })
        : null,
      width,
      height,
      expiresAt: visionIsoDate(item.expiresAt)
    })
  })
  return links
}

function filterVisionBundleForPermissions(
  bundle,
  canViewInternalAttachments
) {
  if (!bundle || canViewInternalAttachments) return bundle
  const attachments = bundle.attachments.filter(
    item => item.descriptor.visibility !== 'INTERNAL'
  )
  const pending = attachments.filter(item =>
    VISION_PENDING_STATUSES.has(item.status)
  ).length
  const ready = attachments.filter(
    item => item.status === 'READY'
  ).length
  const linkOnly = attachments.filter(
    item => item.status === 'LINK_ONLY'
  ).length
  const unsupported = attachments.filter(
    item => item.status === 'UNSUPPORTED'
  ).length
  const failed = attachments.filter(item =>
    VISION_FAILED_STATUSES.has(item.status)
  ).length
  return {
    ...bundle,
    attachments,
    omittedAttachmentCount: 0,
    counts: {
      total: attachments.length,
      pending,
      ready,
      linkOnly,
      unsupported,
      failed
    },
    synthesis: null
  }
}

function parseVisionUiPayload(value, expectations = {}) {
  if (
    isVisionRecord(value) &&
    value[VISION_PARSED_PAYLOAD] === true
  ) {
    return (
      (!expectations.payloadRef ||
        value.payloadRef === expectations.payloadRef) &&
      (!expectations.caseRef ||
        value.caseRef === expectations.caseRef)
    )
      ? value
      : null
  }
  if (
    !isVisionRecord(value) ||
    value.uiContractVersion !== VISION_UI_CONTRACT_VERSION ||
    value.origin !== VISION_PAYLOAD_ORIGIN
  ) {
    return null
  }
  const payloadRef = visionRef(value.payloadRef)
  const caseRef = visionRef(value.caseRef)
  const generatedAt = visionIsoDate(value.generatedAt)
  const canViewInternalAttachments =
    isVisionRecord(value.permissions) &&
    typeof value.permissions.canViewInternalAttachments === 'boolean'
      ? value.permissions.canViewInternalAttachments
      : null
  if (
    !payloadRef ||
    !caseRef ||
    !generatedAt ||
    canViewInternalAttachments === null ||
    (expectations.payloadRef &&
      payloadRef !== expectations.payloadRef) ||
    (expectations.caseRef && caseRef !== expectations.caseRef)
  ) {
    return null
  }
  const attachmentBundle = filterVisionBundleForPermissions(
    normalizeVisionAttachmentBundle(
      value.attachmentBundle,
      caseRef
    ),
    canViewInternalAttachments
  )
  const productCards = Array.isArray(value.productCards)
    ? value.productCards
        .map(normalizeVisionProductCard)
        .filter(Boolean)
        .filter(
          (card, index, cards) =>
            cards.findIndex(
              candidate =>
                candidate.productRef === card.productRef &&
                candidate.orderItemRef === card.orderItemRef
            ) === index
        )
        .slice(0, VISION_PRODUCT_LIMIT)
    : []
  const productRefs = new Set(
    productCards.map(card => card.productRef)
  )
  const attachmentRefs = new Set(
    (attachmentBundle?.attachments || []).map(
      item => item.descriptor.attachmentRef
    )
  )
  const conformityComparisons = Array.isArray(
    value.conformityComparisons
  )
    ? value.conformityComparisons
        .map(item =>
          normalizeVisionConformity(
            item,
            productRefs,
            attachmentRefs
          )
        )
        .filter(Boolean)
        .slice(0, VISION_PRODUCT_LIMIT)
    : []
  const attachments = attachmentBundle?.attachments || []
  const attachmentLinks = normalizeVisionAttachmentLinks(
    value.attachmentLinks,
    attachments
  )
  if (
    !attachmentBundle &&
    productCards.length === 0 &&
    conformityComparisons.length === 0
  ) {
    return null
  }
  return {
    [VISION_PARSED_PAYLOAD]: true,
    uiContractVersion: VISION_UI_CONTRACT_VERSION,
    origin: VISION_PAYLOAD_ORIGIN,
    payloadRef,
    caseRef,
    generatedAt,
    permissions: {
      canViewInternalAttachments
    },
    attachmentBundle,
    productCards,
    conformityComparisons,
    attachmentLinks
  }
}

function parseVisionDirectiveAttrs(value) {
  if (!isVisionRecord(value)) return null
  const allowedKeys = new Set([
    'payloadRef',
    'caseRef',
    'payloadref',
    'caseref'
  ])
  const conflictingAliases =
    (
      Object.prototype.hasOwnProperty.call(value, 'payloadRef') &&
      Object.prototype.hasOwnProperty.call(value, 'payloadref') &&
      value.payloadRef !== value.payloadref
    ) ||
    (
      Object.prototype.hasOwnProperty.call(value, 'caseRef') &&
      Object.prototype.hasOwnProperty.call(value, 'caseref') &&
      value.caseRef !== value.caseref
    )
  if (
    Object.prototype.hasOwnProperty.call(value, 'payload') ||
    Object.prototype.hasOwnProperty.call(value, 'data') ||
    conflictingAliases ||
    Object.keys(value).some(key => !allowedKeys.has(key))
  ) {
    return null
  }
  // Hermes normalizes directive attribute names to lowercase before invoking
  // plugin renderers. Keep camelCase aliases for older hosts and direct tests.
  const payloadRef = visionRef(value.payloadref ?? value.payloadRef)
  const caseRef = visionRef(value.caseref ?? value.caseRef)
  return payloadRef && caseRef ? { payloadRef, caseRef } : null
}

function visionPayloadCacheKey(directive) {
  if (!directive) return ''
  return [
    currentConnectionKey(),
    currentProfileKey(),
    directive.payloadRef,
    directive.caseRef
  ]
    .map(value => encodeURIComponent(value))
    .join(':')
}

function setBoundedVisionCache(cache, key, value, limit) {
  if (!key) return
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

function cacheVisionPayload(directive, payload) {
  const key = visionPayloadCacheKey(directive)
  setBoundedVisionCache(
    visionPayloadCache,
    key,
    { payload, cachedAt: Date.now() },
    VISION_PAYLOAD_CACHE_LIMIT
  )
}

function cachedVisionPayload(directive) {
  const key = visionPayloadCacheKey(directive)
  const cached = visionPayloadCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.cachedAt >= VISION_PAYLOAD_CACHE_MS) {
    visionPayloadCache.delete(key)
    return null
  }
  visionPayloadCache.delete(key)
  visionPayloadCache.set(key, cached)
  return cached.payload
}

function visionAbortError() {
  const error = new Error('VISION_REQUEST_ABORTED')
  error.name = 'AbortError'
  return error
}

function consumeVisionRequest(entry, signal, onNoConsumers) {
  entry.consumers += 1
  return new Promise((resolve, reject) => {
    let settled = false
    const release = () => {
      entry.consumers = Math.max(0, entry.consumers - 1)
      if (entry.consumers === 0 && !entry.settled) {
        onNoConsumers()
      }
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', abort)
      release()
      callback(value)
    }
    const abort = () => finish(reject, visionAbortError())
    signal?.addEventListener?.('abort', abort, { once: true })
    entry.promise.then(
      value => finish(resolve, value),
      error => finish(reject, error)
    )
    if (signal?.aborted) abort()
  })
}

function createSharedVisionRequest(requests, key, loader) {
  let entry = requests.get(key)
  if (entry && !entry.controller.signal.aborted) return entry
  if (entry) requests.delete(key)
  const controller = new AbortController()
  entry = {
    controller,
    consumers: 0,
    settled: false,
    promise: null
  }
  entry.promise = Promise.resolve()
    .then(() => loader(controller.signal))
    .finally(() => {
      entry.settled = true
      if (requests.get(key) === entry) requests.delete(key)
    })
  requests.set(key, entry)
  return entry
}

function classifyVisionRequestError(error) {
  if (error?.name === 'AbortError') return 'ABORTED'
  const status = Number(
    error?.status ||
      error?.statusCode ||
      error?.response?.status ||
      error?.response?.statusCode
  )
  const code = [
    error?.code,
    error?.error,
    error?.data?.error,
    error?.body?.error,
    error?.response?.data?.error,
    error?.message
  ]
    .filter(Boolean)
    .join(' ')
  if (
    status === 404 ||
    status === 410 ||
    /VISION_PAYLOAD_NOT_FOUND|NOT_FOUND|EXPIRED|404|410/i.test(code)
  ) {
    return 'EXPIRED'
  }
  return 'FAILED'
}

async function requestVisionPayload(
  ctx,
  directive,
  { signal } = {}
) {
  const key = visionPayloadCacheKey(directive)
  const entry = createSharedVisionRequest(
    visionPayloadRequests,
    key,
    async requestSignal => {
      const raw = await ctx.rest(
        API_PATHS.visionPayload(
          directive.payloadRef,
          directive.caseRef
        ),
        {
          timeoutMs: 15_000,
          signal: requestSignal
        }
      )
      if (isVisionRecord(raw) && typeof raw.error === 'string') {
        const apiError = new Error('VISION_PAYLOAD_REQUEST_FAILED')
        apiError.code = raw.error.slice(0, 100)
        throw apiError
      }
      const payload = parseVisionUiPayload(raw, directive)
      if (!payload) throw new Error('INVALID_VISION_PAYLOAD')
      cacheVisionPayload(directive, payload)
      return payload
    }
  )
  return consumeVisionRequest(entry, signal, () => {
    if (visionPayloadRequests.get(key) === entry) {
      entry.controller.abort()
    }
  })
}

async function resolveVisionDirectivePayload(
  ctx,
  attrs,
  structuredContent,
  { force = false, signal } = {}
) {
  const directive = parseVisionDirectiveAttrs(attrs)
  if (!directive) throw new Error('INVALID_VISION_DIRECTIVE')
  const directPayload = parseVisionUiPayload(
    structuredContent,
    directive
  )
  if (directPayload) {
    cacheVisionPayload(directive, directPayload)
    return { payload: directPayload, source: 'STRUCTURED_CONTENT' }
  }
  const key = visionPayloadCacheKey(directive)
  if (force) visionPayloadCache.delete(key)
  const cached = force ? null : cachedVisionPayload(directive)
  if (cached) return { payload: cached, source: 'MEMORY_CACHE' }
  const payload = await requestVisionPayload(ctx, directive, {
    signal
  })
  return { payload, source: 'AUTHENTICATED_HYDRATION' }
}

function visionAttachmentByRef(payload, attachmentRef) {
  return (payload?.attachmentBundle?.attachments || []).find(
    item => item.descriptor.attachmentRef === attachmentRef
  )
}

function visionLinkCacheKey(payload, attachmentRef) {
  return `${visionPayloadCacheKey(payload)}:${encodeURIComponent(
    attachmentRef
  )}`
}

function visionFreshLinkUrl(link, action, now = Date.now()) {
  if (!link) return null
  const expiresAt = link.expiresAt
    ? Date.parse(link.expiresAt)
    : null
  if (
    Number.isFinite(expiresAt) &&
    expiresAt <= now + 5_000
  ) {
    return null
  }
  const candidate =
    action === 'OPEN_SOURCE'
      ? link.openSourceUrl
      : link.openAttachmentUrl
  if (
    visionUrlHasSignedParameter(candidate) &&
    !Number.isFinite(expiresAt)
  ) {
    return null
  }
  return visionHttpsUrl(candidate, { allowSigned: true })
}

function cachedVisionAttachmentLink(payload, attachmentRef, action) {
  const key = visionLinkCacheKey(payload, attachmentRef)
  const cached = visionAttachmentLinkCache.get(key)
  if (!cached) return null
  if (
    Date.now() - cached.cachedAt >= VISION_LINK_CACHE_MS ||
    !visionFreshLinkUrl(cached.link, action)
  ) {
    visionAttachmentLinkCache.delete(key)
    return null
  }
  visionAttachmentLinkCache.delete(key)
  visionAttachmentLinkCache.set(key, cached)
  return cached.link
}

function cacheVisionAttachmentLinks(payload, links) {
  links.forEach((link, attachmentRef) => {
    setBoundedVisionCache(
      visionAttachmentLinkCache,
      visionLinkCacheKey(payload, attachmentRef),
      { link, cachedAt: Date.now() },
      VISION_LINK_CACHE_LIMIT
    )
    payload.attachmentLinks.set(attachmentRef, link)
  })
}

async function requestVisionAttachmentLinks(
  ctx,
  payload,
  attachmentRefs,
  { action = 'OPEN_ATTACHMENT', signal } = {}
) {
  if (
    !payload ||
    !['OPEN_ATTACHMENT', 'OPEN_SOURCE'].includes(action)
  ) {
    throw new Error('INVALID_ATTACHMENT_LINK_REQUEST')
  }
  const refs = [...new Set(
    (Array.isArray(attachmentRefs) ? attachmentRefs : [])
      .map(visionRef)
      .filter(reference => {
        const attachment = visionAttachmentByRef(payload, reference)
        return (
          attachment &&
          attachment.freshLinkActions.includes(action)
        )
      })
  )].slice(0, 12)
  if (refs.length === 0) {
    throw new Error('INVALID_ATTACHMENT_LINK_REQUEST')
  }
  const cachedLinks = new Map()
  const missingRefs = []
  refs.forEach(reference => {
    const inline = payload.attachmentLinks.get(reference)
    if (visionFreshLinkUrl(inline, action)) {
      cachedLinks.set(reference, inline)
      return
    }
    const cached = cachedVisionAttachmentLink(
      payload,
      reference,
      action
    )
    if (cached) cachedLinks.set(reference, cached)
    else missingRefs.push(reference)
  })
  if (missingRefs.length === 0) return cachedLinks

  const requestKey = `${visionPayloadCacheKey(payload)}:${action}:${
    missingRefs.slice().sort().map(encodeURIComponent).join(',')
  }`
  const entry = createSharedVisionRequest(
    visionAttachmentLinkRequests,
    requestKey,
    async requestSignal => {
      const response = await ctx.rest(API_PATHS.attachmentLinks, {
        method: 'POST',
        body: {
          payloadRef: payload.payloadRef,
          caseRef: payload.caseRef,
          attachmentRefs: missingRefs
        },
        timeoutMs: 15_000,
        signal: requestSignal
      })
      if (
        isVisionRecord(response) &&
        typeof response.error === 'string'
      ) {
        const apiError = new Error('ATTACHMENT_LINK_REQUEST_FAILED')
        apiError.code = response.error.slice(0, 100)
        throw apiError
      }
      if (
        !isVisionRecord(response) ||
        visionRef(response.payloadRef) !== payload.payloadRef ||
        visionRef(response.caseRef) !== payload.caseRef
      ) {
        throw new Error('INVALID_ATTACHMENT_LINK_RESPONSE')
      }
      const links = normalizeVisionAttachmentLinks(
        response.attachmentLinks,
        payload.attachmentBundle?.attachments || []
      )
      const hasEveryRequestedLink = missingRefs.every(reference =>
        visionFreshLinkUrl(links.get(reference), action)
      )
      if (!hasEveryRequestedLink) {
        throw new Error('ATTACHMENT_LINK_UNAVAILABLE')
      }
      cacheVisionAttachmentLinks(payload, links)
      return links
    }
  )
  const freshLinks = await consumeVisionRequest(
    entry,
    signal,
    () => {
      if (visionAttachmentLinkRequests.get(requestKey) === entry) {
        entry.controller.abort()
      }
    }
  )
  return new Map([...cachedLinks, ...freshLinks])
}

async function openVisionAttachment(
  ctx,
  payload,
  attachmentRef,
  action,
  { signal } = {}
) {
  const attachment = visionAttachmentByRef(payload, attachmentRef)
  if (
    !attachment ||
    !attachment.freshLinkActions.includes(action)
  ) {
    throw new Error('ATTACHMENT_ACTION_NOT_ALLOWED')
  }
  let link = payload.attachmentLinks.get(attachmentRef)
  let url = visionFreshLinkUrl(link, action)
  if (!url) {
    const links = await requestVisionAttachmentLinks(
      ctx,
      payload,
      [attachmentRef],
      { action, signal }
    )
    link = links.get(attachmentRef)
    url = visionFreshLinkUrl(link, action)
  }
  if (!url) throw new Error('ATTACHMENT_LINK_UNAVAILABLE')
  const opened = await ctx.os.openExternal(url)
  if (opened === false) {
    throw new Error('ATTACHMENT_LINK_OPEN_FAILED')
  }
  return true
}

function visibleVisionProducts(payload) {
  return (payload?.productCards || []).filter(
    card => card.displayMode !== 'HIDDEN'
  )
}

function visionDisplayMode(payload) {
  const products = visibleVisionProducts(payload)
  if (products.some(card => card.displayMode === 'EXPLICIT')) {
    return 'EXPLICIT'
  }
  return products.length > 0 ? 'AUTO_CONTEXT' : 'HIDDEN'
}

function visionDedupKey(sessionKey, payload) {
  const refs = visibleVisionProducts(payload)
    .map(card => card.productRef)
    .sort()
  if (!sessionKey || !payload?.caseRef || refs.length === 0) return ''
  return [
    visionString(sessionKey, 500),
    payload.caseRef,
    ...refs
  ]
    .map(value => encodeURIComponent(value))
    .join(':')
}

function visionSurfaceAllowsProducts(surface) {
  return [
    'NOTIFICATION',
    'BRIEF',
    'SESSION',
    'OVERVIEW',
    'SEARCH'
  ].includes(surface)
}

function currentVisionSessionKey(surface) {
  const sessionId =
    host.state.focusedSessionId.get() ||
    host.state.activeSessionId.get()
  return sessionId
    ? `session:${sessionId}`
    : `${surface.toLowerCase()}:${currentConnectionKey()}:${currentProfileKey()}`
}

function visionVisibilityStorageKey(sessionKey, caseRef) {
  return `${VISION_HIDE_STORAGE_PREFIX}:${encodeURIComponent(
    sessionKey
  )}:${encodeURIComponent(caseRef || '')}`.slice(0, 900)
}

function useVisionProductVisibility(ctx, payload, surface) {
  const sessionKey = currentVisionSessionKey(surface)
  const storageKey = visionVisibilityStorageKey(
    sessionKey,
    payload?.caseRef
  )
  const [hidden, setHidden] = useState(() => {
    try {
      return ctx.storage.get(storageKey, false) === true
    } catch {
      return false
    }
  })
  const [duplicate, setDuplicate] = useState(false)
  const displayMode = visionDisplayMode(payload)
  const dedupKey = visionDedupKey(sessionKey, payload)

  useEffect(() => {
    try {
      setHidden(ctx.storage.get(storageKey, false) === true)
    } catch {
      setHidden(false)
    }
  }, [ctx, storageKey])

  useEffect(() => {
    setDuplicate(false)
    if (displayMode !== 'AUTO_CONTEXT' || !dedupKey) {
      return undefined
    }
    if (visionRenderedAutoContexts.has(dedupKey)) {
      setDuplicate(true)
      return undefined
    }
    visionRenderedAutoContexts.add(dedupKey)
    if (visionRenderedAutoContexts.size > 500) {
      const oldest = visionRenderedAutoContexts.values().next().value
      if (oldest) visionRenderedAutoContexts.delete(oldest)
    }
    return undefined
  }, [dedupKey, displayMode])

  const toggleHidden = async () => {
    const next = !hidden
    setHidden(next)
    try {
      await ctx.storage.set(storageKey, next)
    } catch {
      // The in-memory choice still applies for the current render.
    }
  }

  return {
    duplicate,
    hidden,
    toggleHidden,
    displayMode
  }
}

const VISION_STYLE_RULES = `
  .oblist-vision-focus:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
  .oblist-vision-pressable {
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1),
      border-color 160ms ease;
  }
  .oblist-vision-pressable:active {
    transform: scale(0.98);
  }
  .oblist-vision-carousel {
    scrollbar-width: thin;
    scrollbar-color: var(--ui-stroke-secondary) transparent;
  }
  .oblist-vision-carousel::-webkit-scrollbar {
    height: 5px;
  }
  .oblist-vision-carousel::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: var(--ui-stroke-secondary);
  }
  @media (hover: hover) and (pointer: fine) {
    .oblist-vision-pressable:hover {
      border-color: var(--ui-accent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .oblist-vision-pressable {
      transition: border-color 120ms ease;
    }
    .oblist-vision-pressable:active {
      transform: none;
    }
    .oblist-vision-carousel {
      scroll-behavior: auto !important;
    }
  }
`

function VisionStyleRules() {
  return jsx('style', { children: VISION_STYLE_RULES })
}

function VisionImage({
  src,
  alt,
  width = 640,
  height = 480,
  square = false,
  fit = 'cover'
}) {
  const [failed, setFailed] = useState(false)
  const ratio = square ? '1 / 1' : `${width} / ${height}`
  return jsx('div', {
    style: {
      width: '100%',
      aspectRatio: ratio,
      display: 'grid',
      placeItems: 'center',
      overflow: 'hidden',
      borderRadius: '8px',
      background: 'var(--ui-bg-primary)',
      color: 'var(--ui-text-tertiary)'
    },
    children:
      src && !failed
        ? jsx('img', {
            src,
            alt,
            width,
            height,
            loading: 'lazy',
            decoding: 'async',
            draggable: false,
            onError: () => setFailed(true),
            style: {
              width: '100%',
              height: '100%',
              display: 'block',
              objectFit: fit
            }
          })
        : jsxs('span', {
            role: 'img',
            'aria-label': alt || 'Image indisponible',
            style: {
              display: 'grid',
              placeItems: 'center',
              gap: '5px',
              padding: '12px',
              textAlign: 'center',
              fontSize: '11px',
              lineHeight: 1.35
            },
            children: [
              jsx(Codicon, { name: 'file-media', size: '1.2rem' }),
              jsx('span', { children: 'Aperçu indisponible' })
            ]
          })
  })
}

function HorizontalVisionCarousel({
  label,
  slides,
  renderSlide,
  cardWidth = 'clamp(148px, 29%, 206px)'
}) {
  const reducedMotion = usePrefersReducedMotion()
  const scrollerRef = useRef(null)
  const [bounds, setBounds] = useState({
    atStart: true,
    atEnd: slides.length <= 1
  })

  const updateBounds = useCallback(() => {
    const element = scrollerRef.current
    if (!element) return
    setBounds({
      atStart: element.scrollLeft <= 2,
      atEnd:
        element.scrollLeft + element.clientWidth >=
        element.scrollWidth - 2
    })
  }, [])

  useEffect(() => {
    const element = scrollerRef.current
    if (!element) return undefined
    const timer = window.setTimeout(updateBounds, 0)
    element.addEventListener('scroll', updateBounds, {
      passive: true
    })
    window.addEventListener('resize', updateBounds)
    return () => {
      window.clearTimeout(timer)
      element.removeEventListener('scroll', updateBounds)
      window.removeEventListener('resize', updateBounds)
    }
  }, [slides.length, updateBounds])

  const move = (direction, keyboard = false) => {
    const element = scrollerRef.current
    if (!element) return
    element.scrollBy({
      left:
        direction *
        Math.max(156, Math.round(element.clientWidth * 0.76)),
      behavior: keyboard || reducedMotion ? 'auto' : 'auto'
    })
  }

  const jump = edge => {
    const element = scrollerRef.current
    if (!element) return
    element.scrollTo({
      left: edge === 'start' ? 0 : element.scrollWidth,
      behavior: 'auto'
    })
  }

  const onKeyDown = event => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      move(-1, true)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      move(1, true)
    } else if (event.key === 'Home') {
      event.preventDefault()
      jump('start')
    } else if (event.key === 'End') {
      event.preventDefault()
      jump('end')
    }
  }

  if (slides.length === 0) return null
  return jsxs('section', {
    'aria-label': label,
    style: {
      display: 'grid',
      gap: '7px',
      minWidth: 0
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px'
        },
        children: [
          jsxs('span', {
            style: {
              color: 'var(--ui-text-secondary)',
              fontSize: '11px',
              fontWeight: 700
            },
            children: [
              label,
              jsx('span', {
                style: {
                  marginLeft: '6px',
                  color: 'var(--ui-text-tertiary)',
                  fontWeight: 500
                },
                children: `${slides.length} élément${
                  slides.length > 1 ? 's' : ''
                }`
              })
            ]
          }),
          slides.length > 1
            ? jsxs('div', {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px'
                },
                children: [
                  jsx('button', {
                    type: 'button',
                    className:
                      'oblist-vision-focus oblist-vision-pressable',
                    disabled: bounds.atStart,
                    'aria-label': `Élément précédent — ${label}`,
                    onClick: () => move(-1),
                    style: {
                      width: '28px',
                      height: '28px',
                      display: 'grid',
                      placeItems: 'center',
                      border: '1px solid var(--ui-stroke-secondary)',
                      borderRadius: '7px',
                      background: 'var(--ui-bg-primary)',
                      color: 'var(--ui-text-primary)',
                      cursor: bounds.atStart ? 'default' : 'pointer',
                      opacity: bounds.atStart ? 0.45 : 1
                    },
                    children: jsx(Codicon, {
                      name: 'chevron-left',
                      size: '0.85rem'
                    })
                  }),
                  jsx('button', {
                    type: 'button',
                    className:
                      'oblist-vision-focus oblist-vision-pressable',
                    disabled: bounds.atEnd,
                    'aria-label': `Élément suivant — ${label}`,
                    onClick: () => move(1),
                    style: {
                      width: '28px',
                      height: '28px',
                      display: 'grid',
                      placeItems: 'center',
                      border: '1px solid var(--ui-stroke-secondary)',
                      borderRadius: '7px',
                      background: 'var(--ui-bg-primary)',
                      color: 'var(--ui-text-primary)',
                      cursor: bounds.atEnd ? 'default' : 'pointer',
                      opacity: bounds.atEnd ? 0.45 : 1
                    },
                    children: jsx(Codicon, {
                      name: 'chevron-right',
                      size: '0.85rem'
                    })
                  })
                ]
              })
            : null
        ]
      }),
      jsx('div', {
        ref: scrollerRef,
        className: 'oblist-vision-carousel oblist-vision-focus',
        role: 'region',
        'aria-roledescription': 'carrousel',
        'aria-label': `${label}. Utilisez les flèches gauche et droite, ou faites défiler horizontalement.`,
        tabIndex: 0,
        onKeyDown,
        style: {
          display: 'grid',
          gridAutoFlow: 'column',
          gridAutoColumns: cardWidth,
          gap: '9px',
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          overscrollBehaviorX: 'contain',
          scrollSnapType: 'x mandatory',
          scrollPaddingInline: '1px',
          padding: '1px 1px 5px',
          touchAction: 'pan-x pan-y'
        },
        children: slides.map((slide, index) =>
          renderSlide(slide, index)
        )
      })
    ]
  })
}

function openVisionUrl(ctx, value) {
  const url = visionHttpsUrl(value, { allowSigned: true })
  if (url) void ctx.os.openExternal(url)
}

function visionSourceLabel(source) {
  return {
    INTERCOM_CONVERSATION: 'Intercom',
    INTERCOM_SIDE_CONVERSATION: 'Conversation vendeur Intercom',
    RETURN_PORTAL: 'Portail de retour',
    INFO_REQUEST: 'Info Request'
  }[source] || 'Source vérifiée'
}

function visionAuthorLabel(author) {
  if (author?.displayName) return author.displayName
  return {
    CUSTOMER: 'Client',
    VENDOR: 'Vendeur',
    ADMIN: 'Service client',
    BOT: 'Automatisation',
    SYSTEM: 'Système',
    UNVERIFIED_EXTERNAL: 'Partie externe non vérifiée'
  }[author?.role] || 'Auteur inconnu'
}

function visionStatusLabel(status) {
  if (VISION_PENDING_STATUSES.has(status)) return 'Analyse en cours'
  if (status === 'READY') return 'Analyse disponible'
  if (status === 'LINK_ONLY') return 'Fichier disponible'
  if (status === 'UNSUPPORTED') return 'Format non analysé'
  if (status === 'TIMED_OUT') return 'Analyse expirée'
  if (status === 'DLQ') return 'Analyse indisponible'
  if (status === 'FAILED') return 'Analyse impossible'
  return 'Statut indisponible'
}

function visionAttachmentSummary(item) {
  if (item.descriptor.mediaKind === 'VIDEO') {
    return 'Vidéo reçue — non analysée.'
  }
  if (item.status === 'READY' && item.insight) {
    return item.insight.summary
  }
  if (VISION_PENDING_STATUSES.has(item.status)) {
    return 'Le fichier est disponible ; son analyse est en cours.'
  }
  if (item.status === 'UNSUPPORTED') {
    return 'Ce format reste accessible, mais aucune analyse n’est affirmée.'
  }
  if (VISION_FAILED_STATUSES.has(item.status)) {
    return 'L’analyse n’a pas abouti. Le fichier source reste à vérifier.'
  }
  return 'Fichier disponible pour vérification humaine.'
}

function visionAttachmentActionLabel(mediaKind) {
  if (mediaKind === 'IMAGE') return 'Voir l’image'
  if (mediaKind === 'VIDEO') return 'Voir la vidéo'
  if (mediaKind === 'AUDIO') return 'Écouter le fichier'
  return 'Voir le document'
}

function buildVisionEvidenceSlides(payload) {
  if (!payload) return []
  const products = new Map(
    visibleVisionProducts(payload).map(product => [
      product.productRef,
      product
    ])
  )
  const attachments =
    payload.attachmentBundle?.attachments || []
  const evidenceMode =
    payload.conformityComparisons.length > 0 ||
    attachments.some(item =>
      ['IMAGE', 'VIDEO'].includes(
        item.descriptor.mediaKind
      )
    )
  if (!evidenceMode) return []

  const expectedSlides = []
  const expectedUrls = new Set()
  const comparisons =
    payload.conformityComparisons.length > 0
      ? payload.conformityComparisons
      : [...products.values()].map(product => ({
          productRef: product.productRef,
          expected: {
            referenceBasis: 'CURRENT_PRODUCT_PAGE',
            referenceImageUrls: product.imageUrl
              ? [product.imageUrl]
              : []
          }
        }))
  comparisons.forEach(comparison => {
    const product = products.get(comparison.productRef)
    if (!product) return
    const urls =
      comparison.expected.referenceImageUrls.length > 0
        ? comparison.expected.referenceImageUrls
        : product.imageUrl
          ? [product.imageUrl]
          : []
    urls.slice(0, 3).forEach((url, index) => {
      if (expectedUrls.has(url)) return
      expectedUrls.add(url)
      expectedSlides.push({
        id: `expected:${product.productRef}:${index}`,
        kind: 'EXPECTED',
        label: 'Produit attendu',
        title: product.title,
        meta:
          comparison.expected.referenceBasis ===
          'ORDER_TIME_PRODUCT_SNAPSHOT'
            ? 'Référence au moment de la commande'
            : comparison.expected.referenceBasis === 'ORDER_LINE_ITEM'
              ? 'Variante commandée'
              : 'Fiche produit actuelle',
        imageUrl: url,
        openUrl: product.productUrl,
        imageAlt: product.imageAlt,
        width: 640,
        height: 640,
        attachmentRef: null,
        observations: []
      })
    })
  })

  const receivedSlides = attachments.flatMap((item, index) => {
    if (
      !['IMAGE', 'VIDEO'].includes(item.descriptor.mediaKind)
    ) {
      return []
    }
    const links = payload.attachmentLinks.get(
      item.descriptor.attachmentRef
    )
    const freshAttachmentUrl = visionFreshLinkUrl(
      links,
      'OPEN_ATTACHMENT'
    )
    const observations = [
      ...(item.insight?.damages || []),
      ...(item.insight?.visualObservations || [])
    ]
      .map(observation => observation.text)
      .filter(Boolean)
      .slice(0, 2)
    return [{
      id: `received:${item.descriptor.attachmentRef}`,
      kind:
        item.descriptor.mediaKind === 'VIDEO'
          ? 'VIDEO'
          : 'RECEIVED',
      label:
        item.descriptor.mediaKind === 'VIDEO'
          ? 'Vidéo reçue'
          : 'Photo reçue',
      title:
        item.descriptor.mediaKind === 'VIDEO'
          ? `Vidéo du retour ${index + 1}`
          : `Photo du retour ${index + 1}`,
      meta: `${visionSourceLabel(
        item.descriptor.source
      )} · ${visionAuthorLabel(
        item.descriptor.author
      )} · ${parisDateTime(item.descriptor.occurredAt) || 'Date inconnue'}`,
      imageUrl:
        item.descriptor.mediaKind === 'IMAGE' &&
        freshAttachmentUrl
          ? links?.previewUrl || null
          : null,
      openUrl: freshAttachmentUrl,
      attachmentRef: item.descriptor.attachmentRef,
      imageAlt:
        item.descriptor.mediaKind === 'VIDEO'
          ? 'Vidéo reçue — non analysée'
          : `Preuve reçue — ${item.descriptor.fileName}`,
      width: links?.width || 640,
      height: links?.height || 480,
      observations
    }]
  })

  const expectedLimit = Math.min(
    receivedSlides.length > 0 ? 1 : 3,
    expectedSlides.length
  )
  return [
    ...expectedSlides.slice(0, expectedLimit),
    ...receivedSlides.slice(0, VISION_ATTACHMENT_VISIBLE_LIMIT)
  ]
}

function VisionProductSlide({ ctx, card }) {
  const interactive = Boolean(card.productUrl)
  const element = interactive ? 'button' : 'article'
  return jsx(element, {
    ...(interactive
      ? {
          type: 'button',
          onClick: () => openVisionUrl(ctx, card.productUrl),
          'aria-label': `Voir le produit ${card.title}`
        }
      : {}),
    className: interactive
      ? 'oblist-vision-focus oblist-vision-pressable'
      : undefined,
    style: {
      width: '100%',
      minWidth: 0,
      display: 'grid',
      alignContent: 'start',
      gap: '7px',
      scrollSnapAlign: 'start',
      padding: '8px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '10px',
      background: 'var(--ui-bg-secondary)',
      color: 'var(--ui-text-primary)',
      cursor: interactive ? 'pointer' : 'default',
      font: 'inherit',
      textAlign: 'left'
    },
    children: jsxs('div', {
      style: { display: 'grid', gap: '7px', minWidth: 0 },
      children: [
        jsx(VisionImage, {
          src: card.imageUrl,
          alt: card.imageAlt,
          width: 640,
          height: 640,
          square: true
        }),
        jsx('strong', {
          style: {
            minHeight: '2.7em',
            display: '-webkit-box',
            overflow: 'hidden',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            fontSize: '12px',
            lineHeight: 1.35
          },
          children: card.title
        }),
        jsx('span', {
          style: {
            overflow: 'hidden',
            color: 'var(--ui-text-tertiary)',
            fontSize: '10px',
            lineHeight: 1.35,
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          },
          children: [
            card.vendorName,
            card.variantTitle ? ` · ${card.variantTitle}` : '',
            card.quantity > 1 ? ` · ×${card.quantity}` : ''
          ].join('')
        }),
        interactive
          ? jsx('span', {
              style: {
                color: 'var(--ui-accent)',
                fontSize: '11px',
                fontWeight: 700
              },
              children: 'Voir le produit →'
            })
          : jsx('span', {
              style: {
                color: 'var(--ui-text-tertiary)',
                fontSize: '10px'
              },
              children: 'Lien produit indisponible'
            })
      ]
    })
  })
}

function useVisionAttachmentOpener(ctx, payload, attachmentRef) {
  const controllerRef = useRef(null)
  const mountedRef = useRef(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])

  const open = async action => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setWorking(action)
    setError(false)
    try {
      await openVisionAttachment(
        ctx,
        payload,
        attachmentRef,
        action,
        { signal: controller.signal }
      )
      return true
    } catch (openError) {
      if (
        mountedRef.current &&
        classifyVisionRequestError(openError) !== 'ABORTED'
      ) {
        setError(true)
      }
      return false
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null
        if (mountedRef.current) setWorking('')
      }
    }
  }

  return { error, open, working }
}

function VisionEvidenceSlide({ ctx, payload, slide }) {
  const opener = useVisionAttachmentOpener(
    ctx,
    payload,
    slide.attachmentRef
  )
  const interactive = Boolean(
    slide.openUrl || slide.attachmentRef
  )
  const element = interactive ? 'button' : 'article'
  return jsx(element, {
    ...(interactive
      ? {
          type: 'button',
          onClick: () =>
            slide.attachmentRef
              ? void opener.open('OPEN_ATTACHMENT')
              : openVisionUrl(ctx, slide.openUrl),
          disabled: Boolean(opener.working),
          'aria-busy': Boolean(opener.working),
          'aria-label': `${slide.label} — ${slide.title}`
        }
      : {}),
    className: interactive
      ? 'oblist-vision-focus oblist-vision-pressable'
      : undefined,
    style: {
      width: '100%',
      minWidth: 0,
      display: 'grid',
      alignContent: 'start',
      gap: '7px',
      scrollSnapAlign: 'start',
      padding: '8px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '10px',
      background: 'var(--ui-bg-secondary)',
      color: 'var(--ui-text-primary)',
      cursor: interactive ? 'pointer' : 'default',
      font: 'inherit',
      textAlign: 'left'
    },
    children: [
      jsx('span', {
        style: {
          color:
            slide.kind === 'EXPECTED'
              ? 'var(--ui-accent)'
              : 'var(--ui-text-secondary)',
          fontSize: '10px',
          fontWeight: 750,
          letterSpacing: '0.06em',
          textTransform: 'uppercase'
        },
        children:
          slide.kind === 'VIDEO'
            ? 'Vidéo reçue · non analysée'
            : slide.label
      }),
      jsx(VisionImage, {
        src: slide.imageUrl,
        alt: slide.imageAlt,
        width: slide.width,
        height: slide.height,
        square: slide.kind === 'EXPECTED',
        fit: slide.kind === 'EXPECTED' ? 'cover' : 'contain'
      }),
      jsx('strong', {
        style: {
          display: '-webkit-box',
          overflow: 'hidden',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          fontSize: '11px',
          lineHeight: 1.35
        },
        children: slide.title
      }),
      jsx('span', {
        style: {
          display: '-webkit-box',
          overflow: 'hidden',
          color: 'var(--ui-text-tertiary)',
          fontSize: '10px',
          lineHeight: 1.35,
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2
        },
        children: slide.meta
      }),
      ...slide.observations.slice(0, 1).map(observation =>
        jsx('span', {
          key: observation,
          style: {
            display: '-webkit-box',
            overflow: 'hidden',
            color: 'var(--ui-text-secondary)',
            fontSize: '10px',
            lineHeight: 1.35,
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2
          },
          children: `Observation liée : ${observation}`
        })
      ),
      interactive
        ? jsx('span', {
            style: {
              color: 'var(--ui-accent)',
              fontSize: '11px',
              fontWeight: 700
            },
            children:
              opener.working
                ? 'Ouverture…'
                : opener.error
                  ? 'Réessayer l’ouverture'
                  : slide.kind === 'EXPECTED'
                ? 'Voir le produit →'
                : slide.kind === 'VIDEO'
                  ? 'Voir la vidéo →'
                  : 'Voir l’original →'
          })
        : null
    ]
  })
}

function VisionAttachmentAction({
  ctx,
  payload,
  item,
  action,
  label
}) {
  const opener = useVisionAttachmentOpener(
    ctx,
    payload,
    item.descriptor.attachmentRef
  )
  if (!item.freshLinkActions.includes(action)) return null
  return jsx(Button, {
    size: 'sm',
    variant: 'secondary',
    disabled: Boolean(opener.working),
    'aria-busy': Boolean(opener.working),
    onClick: () => void opener.open(action),
    children: opener.working
      ? 'Ouverture…'
      : opener.error
        ? `Réessayer — ${label}`
        : label
  })
}

function VisionAttachmentsBlock({ ctx, payload }) {
  const bundle = payload.attachmentBundle
  if (!bundle || bundle.counts.total === 0) return null
  const visible = bundle.attachments.slice(
    0,
    VISION_ATTACHMENT_VISIBLE_LIMIT
  )
  const hiddenCount =
    Math.max(0, bundle.attachments.length - visible.length) +
    bundle.omittedAttachmentCount
  return jsxs('section', {
    'aria-label': 'Pièces jointes',
    style: {
      display: 'grid',
      gap: '8px',
      padding: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '10px',
      background: 'var(--ui-bg-primary)'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap'
        },
        children: [
          jsx('strong', {
            style: { fontSize: '12px' },
            children: 'Pièces jointes'
          }),
          jsx('span', {
            style: {
              color: 'var(--ui-text-tertiary)',
              fontSize: '10px'
            },
            children: `${bundle.counts.total} fichier${
              bundle.counts.total > 1 ? 's' : ''
            } · ${bundle.counts.ready} analysé${
              bundle.counts.ready > 1 ? 's' : ''
            } · ${bundle.counts.pending} en cours`
          })
        ]
      }),
      bundle.synthesis
        ? jsxs('div', {
            style: {
              display: 'grid',
              gap: '3px',
              padding: '8px',
              borderRadius: '8px',
              background: 'var(--ui-bg-secondary)'
            },
            children: [
              jsx('span', {
                style: {
                  color: 'var(--ui-text-tertiary)',
                  fontSize: '10px',
                  fontWeight: 750
                },
                children: 'Synthèse automatique'
              }),
              jsx('span', {
                style: {
                  color: 'var(--ui-text-secondary)',
                  fontSize: '11px',
                  lineHeight: 1.4
                },
                children: bundle.synthesis.summary
              })
            ]
          })
        : null,
      ...visible.map((item, index) => {
        const descriptor = item.descriptor
        const internal = descriptor.visibility === 'INTERNAL'
        return jsxs('article', {
          key: descriptor.attachmentRef,
          style: {
            display: 'grid',
            gap: '5px',
            padding: '8px 0',
            borderTop: '1px solid var(--ui-stroke-secondary)'
          },
          children: [
            jsxs('div', {
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '8px',
                flexWrap: 'wrap'
              },
              children: [
                jsxs('div', {
                  style: { display: 'grid', gap: '2px', minWidth: 0 },
                  children: [
                    jsx('strong', {
                      style: {
                        overflow: 'hidden',
                        fontSize: '11px',
                        lineHeight: 1.35,
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      },
                      children:
                        descriptor.mediaKind === 'VIDEO'
                          ? `Vidéo ${index + 1}`
                          : descriptor.mediaKind === 'IMAGE'
                            ? `Photo ${index + 1}`
                            : `Document ${index + 1}`
                    }),
                    jsx('span', {
                      style: {
                        color: 'var(--ui-text-tertiary)',
                        fontSize: '10px',
                        lineHeight: 1.35
                      },
                      children: `${visionSourceLabel(
                        descriptor.source
                      )} · ${visionAuthorLabel(
                        descriptor.author
                      )} · ${
                        parisDateTime(descriptor.occurredAt) ||
                        'Date inconnue'
                      }`
                    })
                  ]
                }),
                jsx(Badge, {
                  children: visionStatusLabel(item.status)
                })
              ]
            }),
            jsx('span', {
              style: {
                color: 'var(--ui-text-secondary)',
                fontSize: '11px',
                lineHeight: 1.4
              },
              children: visionAttachmentSummary(item)
            }),
            internal
              ? jsx('span', {
                  style: {
                    color: 'var(--ui-text-tertiary)',
                    fontSize: '10px',
                    fontWeight: 650
                  },
                  children:
                    'Note interne · non copiée dans les messages externes'
                })
              : null,
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx(VisionAttachmentAction, {
                  ctx,
                  payload,
                  item,
                  action: 'OPEN_ATTACHMENT',
                  label: visionAttachmentActionLabel(
                    descriptor.mediaKind
                  )
                }),
                jsx(VisionAttachmentAction, {
                  ctx,
                  payload,
                  item,
                  action: 'OPEN_SOURCE',
                  label: 'Voir la source'
                })
              ]
            })
          ]
        })
      }),
      hiddenCount > 0
        ? jsx('span', {
            style: {
              color: 'var(--ui-text-tertiary)',
              fontSize: '10px'
            },
            children: `+ ${hiddenCount} autre${
              hiddenCount > 1 ? 's' : ''
            } pièce${hiddenCount > 1 ? 's' : ''} dans le dossier`
          })
        : null
    ]
  })
}

function visionVerdictLabel(verdict) {
  return {
    MATCH: 'Conforme aux preuves disponibles',
    DIFFERENCE_CONFIRMED: 'Différence confirmée',
    POSSIBLE_DIFFERENCE: 'Différence possible',
    NOT_VERIFIABLE: 'Non vérifiable'
  }[verdict] || 'À vérifier'
}

function visionDifferenceFieldLabel(field) {
  return {
    VARIANT: 'Variante',
    SKU: 'Référence',
    DIMENSION: 'Dimensions',
    MATERIAL: 'Matériau',
    COLOR: 'Couleur',
    SHAPE: 'Forme',
    FINISH: 'Finition',
    COMPONENT: 'Composant',
    DESCRIPTION: 'Description',
    OTHER: 'Autre'
  }[field] || 'Écart'
}

function VisionConformityBlock({ payload }) {
  if (payload.conformityComparisons.length === 0) return null
  return jsxs('section', {
    'aria-label': 'Conformité produit',
    style: {
      display: 'grid',
      gap: '8px',
      padding: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '10px',
      background: 'var(--ui-bg-primary)'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap'
        },
        children: [
          jsx('strong', {
            style: { fontSize: '12px' },
            children: 'Conformité produit'
          }),
          jsx('span', {
            style: {
              color: 'var(--ui-text-tertiary)',
              fontSize: '10px',
              fontWeight: 700
            },
            children: 'DERIVED · à confirmer par le CS'
          })
        ]
      }),
      ...payload.conformityComparisons.slice(0, 2).map(comparison => {
        const product = payload.productCards.find(
          card => card.productRef === comparison.productRef
        )
        return jsxs('article', {
          key: `${comparison.productRef}:${comparison.orderItemRef}`,
          style: {
            display: 'grid',
            gap: '6px',
            padding: '8px',
            borderRadius: '8px',
            background: 'var(--ui-bg-secondary)'
          },
          children: [
            jsxs('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                flexWrap: 'wrap'
              },
              children: [
                jsx('strong', {
                  style: { fontSize: '11px' },
                  children:
                    product?.title || 'Produit du dossier'
                }),
                jsx(Badge, {
                  children: visionVerdictLabel(comparison.verdict)
                })
              ]
            }),
            ...comparison.differences.slice(0, 3).map(difference =>
              jsxs('div', {
                key: difference.differenceId,
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'minmax(70px, 0.4fr) 1fr',
                  gap: '5px 8px',
                  fontSize: '10px',
                  lineHeight: 1.4
                },
                children: [
                  jsx('strong', {
                    children: visionDifferenceFieldLabel(
                      difference.field
                    )
                  }),
                  jsx('span', {
                    style: { color: 'var(--ui-text-secondary)' },
                    children: `${
                      difference.expectedValue ||
                      'Valeur attendue non précisée'
                    } → ${
                      difference.observedValue ||
                      'Observation non concluante'
                    } · ${
                      difference.assessment === 'CONFIRMED'
                        ? 'confirmé'
                        : difference.assessment === 'POSSIBLE'
                          ? 'possible'
                          : 'non résolu'
                    }`
                  })
                ]
              })
            ),
            ...comparison.observed.measurements
              .slice(0, 3)
              .map(measurement =>
                jsx('span', {
                  key: measurement.measurementId,
                  style: {
                    color: 'var(--ui-text-secondary)',
                    fontSize: '10px',
                    lineHeight: 1.4
                  },
                  children: measurement.value
                    ? `${measurement.name} : ${measurement.value} ${measurement.unit} · preuve explicite`
                    : `${measurement.name} : non vérifiable sans échelle fiable`
                })
              ),
            comparison.blockingUnknowns.length > 0
              ? jsx('span', {
                  role: 'status',
                  style: {
                    color: 'var(--ui-text-secondary)',
                    fontSize: '10px',
                    lineHeight: 1.4
                  },
                  children: `À vérifier : ${comparison.blockingUnknowns
                    .slice(0, 2)
                    .join(' · ')}`
                })
              : null
          ]
        })
      }),
      payload.conformityComparisons.length > 2
        ? jsx('span', {
            style: {
              color: 'var(--ui-text-tertiary)',
              fontSize: '10px'
            },
            children: `+ ${
              payload.conformityComparisons.length - 2
            } autre${
              payload.conformityComparisons.length - 2 > 1
                ? 's'
                : ''
            } comparaison${
              payload.conformityComparisons.length - 2 > 1
                ? 's'
                : ''
            }`
          })
        : null
    ]
  })
}

function VisionProductsControl({
  hidden,
  onToggle,
  hasProducts
}) {
  if (!hasProducts) return null
  return jsx('button', {
    type: 'button',
    className: 'oblist-vision-focus oblist-vision-pressable',
    onClick: () => void onToggle(),
    style: {
      border: 0,
      padding: '3px 0',
      background: 'transparent',
      color: 'var(--ui-accent)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '10px',
      fontWeight: 700
    },
    children: hidden ? 'Afficher les produits' : 'Masquer les produits'
  })
}

function VisionContextBlock({
  ctx,
  value,
  surface = 'SESSION',
  expectations = {}
}) {
  const payload = useMemo(
    () => parseVisionUiPayload(value, expectations),
    [expectations.caseRef, expectations.payloadRef, value]
  )
  const visibility = useVisionProductVisibility(
    ctx,
    payload,
    surface
  )
  if (surface === 'ACTION_CARD') return null
  if (!payload) {
    return value
      ? jsx('div', {
          role: 'alert',
          style: {
            padding: '9px 10px',
            border: '1px solid var(--ui-stroke-secondary)',
            borderRadius: '9px',
            color: 'var(--ui-text-secondary)',
            fontSize: '11px'
          },
          children:
            'Le contexte visuel reçu est invalide ou ne correspond pas à ce dossier.'
        })
      : null
  }
  const products = visibleVisionProducts(payload)
  const canRenderProducts =
    visionSurfaceAllowsProducts(surface) &&
    products.length > 0 &&
    !visibility.duplicate
  const showProducts = canRenderProducts && !visibility.hidden
  const allEvidenceSlides = buildVisionEvidenceSlides(payload)
  const receivedEvidenceSlides = allEvidenceSlides.filter(
    slide => slide.kind !== 'EXPECTED'
  )
  const expectedEvidenceSlides = showProducts
    ? allEvidenceSlides.filter(slide => slide.kind === 'EXPECTED')
    : []
  const hasVisualEvidence = receivedEvidenceSlides.length > 0
  const attachmentCount =
    payload.attachmentBundle?.counts.total || 0

  return jsxs('section', {
    'aria-label': 'Contexte visuel vérifié du dossier',
    style: {
      width: 'min(760px, 100%)',
      minWidth: 0,
      display: 'grid',
      gap: '12px',
      padding: '12px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '12px',
      background: 'var(--ui-bg-primary)',
      color: 'var(--ui-text-primary)',
      overflow: 'hidden'
    },
    children: [
      jsx(VisionStyleRules, {}),
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap'
        },
        children: [
          jsxs('div', {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px'
            },
            children: [
              jsx(Codicon, { name: 'eye', size: '0.85rem' }),
              jsx('strong', {
                style: { fontSize: '13px' },
                children:
                  attachmentCount > 0
                    ? 'Preuves visuelles du retour'
                    : 'Contexte visuel'
              })
            ]
          }),
          canRenderProducts
            ? jsx(VisionProductsControl, {
                hidden: visibility.hidden,
                onToggle: visibility.toggleHidden,
                hasProducts: true
              })
            : null
        ]
      }),
      showProducts && products[0]?.displayReason
        ? jsx('span', {
            style: {
              color: 'var(--ui-text-tertiary)',
              fontSize: '10px',
              lineHeight: 1.35
            },
            children: products[0].displayReason
          })
        : null,
      hasVisualEvidence
        ? jsx(HorizontalVisionCarousel, {
            label: 'Photos et vidéos du retour',
            slides: receivedEvidenceSlides,
            cardWidth: 'clamp(220px, 48%, 340px)',
            renderSlide: slide =>
              jsx(VisionEvidenceSlide, {
                ctx,
                payload,
                slide,
                key: slide.id
              })
          })
        : null,
      expectedEvidenceSlides.length > 0
        ? jsx(HorizontalVisionCarousel, {
            label: 'Produit de référence',
            slides: expectedEvidenceSlides,
            cardWidth: 'clamp(148px, 24%, 190px)',
            renderSlide: slide =>
              jsx(VisionEvidenceSlide, {
                ctx,
                payload,
                slide,
                key: slide.id
              })
          })
        : showProducts
          ? jsx(HorizontalVisionCarousel, {
              label: 'Produits du dossier',
              slides: products.slice(0, VISION_PRODUCT_LIMIT),
              cardWidth: 'clamp(148px, 24%, 190px)',
              renderSlide: card =>
                jsx(VisionProductSlide, {
                  ctx,
                  card,
                  key: `${card.productRef}:${card.orderItemRef}`
                })
            })
          : null,
      visibility.hidden && canRenderProducts
        ? jsx('span', {
            role: 'status',
            style: {
              color: 'var(--ui-text-tertiary)',
              fontSize: '10px'
            },
            children:
              'Les produits sont masqués pour ce dossier dans cette session.'
          })
        : null,
      jsx(VisionAttachmentsBlock, { ctx, payload }),
      jsx(VisionConformityBlock, { payload })
    ]
  })
}

function VisionNotificationThumbnail({ ctx, value, notificationId }) {
  const payload = useMemo(
    () => parseVisionUiPayload(value),
    [value]
  )
  const visibility = useVisionProductVisibility(
    ctx,
    payload,
    'NOTIFICATION'
  )
  const product = visibleVisionProducts(payload)[0]
  if (
    !payload ||
    !product ||
    visibility.hidden ||
    visibility.duplicate
  ) {
    return null
  }
  return jsxs('aside', {
    'aria-label': 'Produit principal du dossier',
    style: {
      display: 'grid',
      gridTemplateColumns: '48px minmax(0, 1fr) auto',
      alignItems: 'center',
      gap: '8px',
      padding: '7px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '9px',
      background: 'var(--ui-bg-primary)'
    },
    children: [
      jsx(VisionStyleRules, {}),
      jsx(VisionImage, {
        src: product.imageUrl,
        alt: product.imageAlt,
        width: 96,
        height: 96,
        square: true
      }),
      jsxs('div', {
        style: { display: 'grid', gap: '2px', minWidth: 0 },
        children: [
          jsx('span', {
            style: {
              color: 'var(--ui-text-tertiary)',
              fontSize: '9px',
              fontWeight: 750,
              letterSpacing: '0.05em',
              textTransform: 'uppercase'
            },
            children: 'Produit lié au dossier'
          }),
          product.productUrl
            ? jsx('button', {
                type: 'button',
                className:
                  'oblist-vision-focus oblist-vision-pressable',
                onClick: () =>
                  openVisionUrl(ctx, product.productUrl),
                style: {
                  overflow: 'hidden',
                  border: 0,
                  padding: 0,
                  background: 'transparent',
                  color: 'var(--ui-text-primary)',
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: '11px',
                  fontWeight: 700,
                  textAlign: 'left',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                },
                children: product.title
              })
            : jsx('strong', {
                style: {
                  overflow: 'hidden',
                  fontSize: '11px',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                },
                children: product.title
              }),
          jsx('span', {
            style: {
              overflow: 'hidden',
              color: 'var(--ui-text-tertiary)',
              fontSize: '9px',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            },
            children: `${product.vendorName}${
              product.variantTitle
                ? ` · ${product.variantTitle}`
                : ''
            }`
          })
        ]
      }),
      jsx(VisionProductsControl, {
        hidden: false,
        onToggle: visibility.toggleHidden,
        hasProducts: Boolean(notificationId)
      })
    ]
  })
}

function VisionDirective({
  ctx,
  attrs,
  structuredContent,
  streaming
}) {
  const directive = useMemo(
    () => parseVisionDirectiveAttrs(attrs),
    [attrs?.caseRef, attrs?.payloadRef]
  )
  const directiveKey = directive
    ? `${directive.payloadRef}:${directive.caseRef}`
    : ''
  const directPayload = useMemo(
    () =>
      directive
        ? parseVisionUiPayload(structuredContent, directive)
        : null,
    [directiveKey, structuredContent]
  )
  const [requestState, setRequestState] = useState({
    key: '',
    state: 'idle',
    payload: null
  })
  const [retryVersion, setRetryVersion] = useState(0)
  const [, setLinkRevision] = useState(0)
  const currentState =
    requestState.key === directiveKey
      ? requestState
      : { state: 'loading', payload: null }
  const effectivePayload = directive
    ? directPayload || currentState.payload
    : null

  useEffect(() => {
    if (!directive) return undefined
    if (directPayload) {
      cacheVisionPayload(directive, directPayload)
      setRequestState({
        key: directiveKey,
        state: 'ready',
        payload: directPayload
      })
      return undefined
    }
    if (streaming) {
      setRequestState({
        key: directiveKey,
        state: 'loading',
        payload: null
      })
      return undefined
    }

    const controller = new AbortController()
    let mounted = true
    setRequestState({
      key: directiveKey,
      state: 'loading',
      payload: null
    })
    void resolveVisionDirectivePayload(
      ctx,
      directive,
      null,
      {
        force: retryVersion > 0,
        signal: controller.signal
      }
    )
      .then(result => {
        if (!mounted) return
        setRequestState({
          key: directiveKey,
          state: 'ready',
          payload: result.payload
        })
      })
      .catch(error => {
        if (!mounted) return
        const errorKind = classifyVisionRequestError(error)
        if (errorKind === 'ABORTED') return
        setRequestState({
          key: directiveKey,
          state:
            errorKind === 'EXPIRED' ? 'expired' : 'failed',
          payload: null
        })
      })
    return () => {
      mounted = false
      controller.abort()
    }
  }, [
    ctx,
    directPayload,
    directive,
    directiveKey,
    retryVersion,
    streaming
  ])

  useEffect(() => {
    if (!effectivePayload || streaming) return undefined
    const missingImageRefs = (
      effectivePayload.attachmentBundle?.attachments || []
    )
      .filter(
        item =>
          item.descriptor.mediaKind === 'IMAGE' &&
          item.freshLinkActions.includes('OPEN_ATTACHMENT') &&
          !visionFreshLinkUrl(
            effectivePayload.attachmentLinks.get(
              item.descriptor.attachmentRef
            ),
            'OPEN_ATTACHMENT'
          )
      )
      .map(item => item.descriptor.attachmentRef)
      .slice(0, VISION_ATTACHMENT_VISIBLE_LIMIT)
    if (missingImageRefs.length === 0) return undefined

    const controller = new AbortController()
    let mounted = true
    void requestVisionAttachmentLinks(
      ctx,
      effectivePayload,
      missingImageRefs,
      {
        action: 'OPEN_ATTACHMENT',
        signal: controller.signal
      }
    )
      .then(() => {
        if (mounted) setLinkRevision(value => value + 1)
      })
      .catch(() => {
        // The attachment row and authenticated open action remain available.
      })
    return () => {
      mounted = false
      controller.abort()
    }
  }, [ctx, directiveKey, effectivePayload, streaming])

  if (!directive) return null
  if (effectivePayload) {
    return jsx(VisionContextBlock, {
      ctx,
      value: effectivePayload,
      surface: 'SESSION',
      expectations: directive
    })
  }
  if (
    streaming ||
    ['idle', 'loading'].includes(currentState.state)
  ) {
    return jsx('div', {
      role: 'status',
      'aria-live': 'polite',
      style: {
        width: 'min(760px, 100%)',
        padding: '9px 10px',
        border: '1px solid var(--ui-stroke-secondary)',
        borderRadius: '9px',
        color: 'var(--ui-text-tertiary)',
        fontSize: '11px'
      },
      children: 'Chargement sécurisé du contexte visuel…'
    })
  }
  return jsxs('div', {
    role: 'alert',
    style: {
      width: 'min(760px, 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '9px',
      padding: '9px 10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '9px',
      color: 'var(--ui-text-secondary)',
      fontSize: '11px'
    },
    children: [
      jsx('span', {
        children:
          currentState.state === 'expired'
            ? 'Ce contexte visuel a expiré ou n’est plus disponible.'
            : 'Le contexte visuel n’a pas pu être chargé.'
      }),
      jsx(Button, {
        size: 'sm',
        variant: 'secondary',
        onClick: () => {
          if (currentState.state === 'expired') {
            const sessionId =
              host.state.focusedSessionId.get() ||
              host.state.activeSessionId?.get?.()
            if (!sessionId) {
              host.notify({
                kind: 'error',
                message:
                  'La demande visuelle doit être relancée depuis une conversation active.'
              })
              return
            }
            void host.composer
              .setDraft(
                sessionId,
                `Recharge le contexte visuel de ${directive.caseRef}. Utilise l’outil approprié et affiche de nouveau le visuel vérifié.`
              )
              .then(() => host.composer.focus(sessionId))
            return
          }
          visionPayloadCache.delete(
            visionPayloadCacheKey(directive)
          )
          setRetryVersion(value => value + 1)
        },
        children:
          currentState.state === 'expired'
            ? 'Relancer la demande'
            : 'Réessayer'
      })
    ]
  })
}

function useReservationCountdown(expiresAt) {
  const reducedMotion = usePrefersReducedMotion()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!expiresAt) return undefined
    const timer = window.setInterval(
      () => setNow(Date.now()),
      reducedMotion ? 60_000 : 1_000
    )
    return () => window.clearInterval(timer)
  }, [expiresAt, reducedMotion])
  const deadline = Date.parse(expiresAt || '')
  return {
    reducedMotion,
    remainingMs: Number.isFinite(deadline)
      ? Math.max(0, deadline - now)
      : 0
  }
}

function reservationCountdownLabel(remainingMs, reducedMotion) {
  if (remainingMs <= 0) return 'Réservation expirée'
  const totalSeconds = Math.ceil(remainingMs / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (reducedMotion) {
    return `Réservé pour encore ${Math.max(1, Math.ceil(totalSeconds / 60))} min`
  }
  return `Réservé pour encore ${minutes} min ${String(seconds).padStart(2, '0')} s`
}

function parisDateTime(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date)
}

function slaLabel(workflow) {
  const dueAt = parisDateTime(workflow.slaDueAt)
  if (workflow.slaStatus === 'BREACHED') {
    return dueAt
      ? `Échéance dépassée depuis le ${dueAt}`
      : 'Échéance dépassée'
  }
  if (workflow.slaStatus === 'DUE_SOON') {
    return dueAt ? `À traiter avant le ${dueAt}` : 'À traiter bientôt'
  }
  return dueAt ? `À traiter avant le ${dueAt}` : 'Échéance à préciser'
}

async function requestWorkflowAction(
  ctx,
  workflow,
  action,
  operatorRef,
  decision
) {
  const path = {
    claim: API_PATHS.workflowClaim,
    confirm: API_PATHS.workflowConfirmAssignment,
    closure: API_PATHS.workflowClosure
  }[action]
  if (!path) throw new Error('Unsupported workflow action')
  return ctx.rest(
    `${path(workflow.id)}${operatorQuery(operatorRef)}`,
    {
      method: 'POST',
      body: {
        ...(workflow.version
          ? { expectedVersion: workflow.version }
          : {}),
        ...(workflow.reservationRef
          ? { reservationRef: workflow.reservationRef }
          : {}),
        ...(decision ? { decision } : {}),
        ...(decision === 'CLOSE' && workflow.resolutionCriteria
          ? { outcome: workflow.resolutionCriteria }
          : {})
      },
      timeoutMs: 30_000
    }
  )
}

function WorkflowPanel({
  ctx,
  runtime,
  source,
  operatorRef,
  onUpdated
}) {
  const normalized = useMemo(() => normalizeWorkflow(source), [source])
  const [workflow, setWorkflow] = useState(normalized)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const countdown = useReservationCountdown(workflow?.claimExpiresAt)

  useEffect(() => {
    setWorkflow(normalized)
  }, [normalized])

  if (!workflow) return null
  if (!isV2Live(runtime)) {
    return runtimeBlocksV2(runtime) ? jsx(RuntimeActionBlock, {}) : null
  }

  const run = async (action, decision) => {
    setWorking(action)
    setError('')
    try {
      const result = await requestWorkflowAction(
        ctx,
        workflow,
        action,
        operatorRef,
        decision
      )
      const next =
        normalizeWorkflow(result?.workflow) ||
        normalizeWorkflow(result?.caseWatch) ||
        normalizeWorkflow(result)
      if (next) setWorkflow(next)
      onUpdated?.(next, result)
      host.notify({
        kind: 'success',
        message:
          action === 'claim'
            ? 'Dossier réservé pour vous'
            : action === 'confirm'
              ? 'Attribution confirmée'
              : decision === 'CLOSE'
                ? 'Clôture confirmée'
                : 'Le suivi continue'
      })
    } catch {
      setError(
        'Cette décision n’a pas pu être enregistrée. Aucune action n’a été effectuée.'
      )
    } finally {
      setWorking('')
    }
  }

  const reservationActive =
    Boolean(workflow.claimExpiresAt) && countdown.remainingMs > 0
  return jsxs('section', {
    'aria-label': 'Suivi du dossier',
    style: {
      display: 'grid',
      gap: '9px',
      padding: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '9px',
      background: 'var(--ui-bg-primary)'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap'
        },
        children: [
          jsx('strong', {
            style: { fontSize: '12px' },
            children: workflow.phaseLabel
          }),
          reservationActive
            ? jsx('span', {
                role: 'timer',
                'aria-label': 'Temps restant pour confirmer l’attribution',
                style: {
                  color: 'var(--ui-text-secondary)',
                  fontSize: '11px',
                  fontVariantNumeric: 'tabular-nums'
                },
                children: reservationCountdownLabel(
                  countdown.remainingMs,
                  countdown.reducedMotion
                )
              })
            : null
        ]
      }),
      jsxs('details', {
        children: [
          jsx('summary', {
            style: {
              cursor: 'pointer',
              color: 'var(--ui-text-secondary)',
              fontSize: '12px'
            },
            children: 'Voir le suivi du dossier'
          }),
          jsxs('dl', {
            style: {
              display: 'grid',
              gridTemplateColumns: 'max-content minmax(0, 1fr)',
              gap: '6px 10px',
              margin: '9px 0 0',
              color: 'var(--ui-text-secondary)',
              fontSize: '12px',
              lineHeight: 1.45
            },
            children: [
              jsx('dt', { children: 'Responsable' }),
              jsx('dd', {
                style: { margin: 0 },
                children: workflow.ownerLabel
              }),
              jsx('dt', { children: 'Prochaine action' }),
              jsx('dd', {
                style: { margin: 0 },
                children: workflow.nextAction
              }),
              jsx('dt', { children: 'Échéance' }),
              jsx('dd', {
                style: { margin: 0 },
                children: slaLabel(workflow)
              }),
              reservationActive
                ? jsx('dt', { children: 'Réservation' })
                : null,
              reservationActive
                ? jsx('dd', {
                    style: { margin: 0 },
                    children: workflow.claimOwnerLabel
                  })
                : null
            ]
          })
        ]
      }),
      error
        ? jsx('div', {
            role: 'alert',
            style: {
              color: 'var(--ui-danger)',
              fontSize: '12px',
              lineHeight: 1.45
            },
            children: error
          })
        : null,
      jsxs('div', {
        style: rowStyle,
        children: [
          workflow.canClaim
            ? jsx(Button, {
                size: 'sm',
                variant: 'secondary',
                disabled: Boolean(working),
                onClick: () => void run('claim'),
                children:
                  working === 'claim'
                    ? 'Réservation…'
                    : 'Prendre ce dossier'
              })
            : null,
          workflow.assignmentConfirmationRequired &&
          workflow.canConfirmAssignment
            ? jsx(Button, {
                size: 'sm',
                disabled:
                  Boolean(working) ||
                  !reservationActive,
                onClick: () => void run('confirm'),
                children:
                  working === 'confirm'
                    ? 'Confirmation…'
                    : 'Confirmer l’attribution'
              })
            : null,
          workflow.closureConfirmationRequired && workflow.canClose
            ? jsx(Button, {
                size: 'sm',
                disabled: Boolean(working),
                onClick: () => void run('closure', 'CLOSE'),
                children:
                  working === 'closure'
                    ? 'Confirmation…'
                    : 'Clôturer'
              })
            : null,
          workflow.closureConfirmationRequired && workflow.canContinue
            ? jsx(Button, {
                size: 'sm',
                variant: 'secondary',
                disabled: Boolean(working),
                onClick: () => void run('closure', 'CONTINUE'),
                children: 'Continuer le suivi'
              })
            : null
        ]
      })
    ]
  })
}

function compactNotificationSummary(value, max = 320) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /^(?:hi|hello|good\s+(?:morning|afternoon|evening)|bonjour|bonsoir)[,!.\s-]+/i,
      ''
    )
  if (!normalized) {
    return 'Le dossier nécessite une analyse du contexte actuel.'
  }
  const sentences =
    normalized.match(/[^.!?]+(?:[.!?]+|$)/g) || [normalized]
  const summary = sentences
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
  if (summary.length <= max) return summary
  const shortened = summary.slice(0, max - 1)
  const lastSpace = shortened.lastIndexOf(' ')
  return `${shortened.slice(
    0,
    lastSpace > 80 ? lastSpace : shortened.length
  )}…`
}

function fallbackSituationPresentation(situation, launchContext = {}) {
  const requestedBy =
    launchContext?.requestedBy ||
    launchContext?.presentation?.requestedBy ||
    ''
  const manualRequest =
    launchContext?.manualRequest === true ||
    launchContext?.presentation?.sourceKind === 'INTERCOM'
  return {
    dossier:
      launchContext?.presentation?.dossier ||
      (situation.orderNumber
        ? `Commande #${situation.orderNumber} · ${situation.title}`
        : situation.title || 'Dossier service client'),
    source:
      launchContext?.presentation?.source ||
      (manualRequest
        ? `Intercom${requestedBy ? ` · demandé par ${requestedBy}` : ''}`
        : 'Détection proactive Hermes'),
    mission:
      launchContext?.presentation?.mission ||
      'Résoudre cette situation du service client.',
    summary:
      launchContext?.presentation?.summary ||
      compactNotificationSummary(situation.summary),
    currentState:
      launchContext?.presentation?.currentState ||
      'Le dossier doit être vérifié.',
    checks:
      Array.isArray(launchContext?.presentation?.checks) &&
      launchContext.presentation.checks.length > 0
        ? launchContext.presentation.checks
        : Array.isArray(situation.importantInformation) &&
            situation.importantInformation.length > 0
          ? situation.importantInformation.slice(0, 3)
          : ['Contexte live et actions déjà effectuées.'],
    nextAction:
      launchContext?.presentation?.nextAction ||
      situation.nextAction ||
      'Analyser le dossier et proposer la prochaine action utile.'
  }
}

function resolutionPrompt(situation, launchContext = {}) {
  if ((situation.signals || []).includes('TEST_ONLY')) {
    return [
      'Ceci est un test de notification Hermes, pas un dossier client réel.',
      'Confirme que le bouton Résoudre maintenant a correctement ouvert ce chat dédié.',
      'Ne contacte personne et ne prépare aucune action externe.'
    ].join('\n')
  }
  const presentation = fallbackSituationPresentation(
    situation,
    launchContext
  )
  return [
    'DOSSIER',
    presentation.dossier,
    situation.orderNumber ? `Commande : #${situation.orderNumber}` : null,
    situation.conversationRef
      ? `Conversation Intercom : ${situation.conversationRef}`
      : null,
    '',
    'SOURCE',
    presentation.source,
    '',
    'MISSION',
    presentation.mission,
    '',
    'RÉSUMÉ',
    presentation.summary,
    '',
    'ÉTAT ACTUEL',
    presentation.currentState,
    '',
    'À VÉRIFIER',
    ...presentation.checks.map(item => `- ${item}`),
    '',
    'PROCHAINE ACTION',
    presentation.nextAction,
    '',
    'Le résumé ci-dessus sert uniquement à orienter le travail : ce n’est pas une preuve. Récupère immédiatement le contexte live complet, vérifie les changements depuis la notification et les actions déjà effectuées, puis prépare les cartes utiles sans rien envoyer avant mon approbation.'
  ]
    .filter(item => item !== null && item !== undefined)
    .join('\n')
}

function resolutionSessionKey(situation, profile) {
  const scope = String(profile || 'global').trim().toLowerCase()
  const dossier = situation?.conversationRef
    ? `intercom:${situation.conversationRef}`
    : String(situation?.id || '').trim()
  if (!dossier) {
    throw new Error('Le dossier ne possède pas d’identifiant stable')
  }
  return `cs-resolution:v2:${scope}:${dossier}`.slice(0, 240)
}

async function openSituationChat(
  situation,
  profile,
  launchContext = {}
) {
  const prompt = resolutionPrompt(situation, launchContext)
  const conversationLabel = situation.conversationRef
    ? `Intercom ${situation.conversationRef} · `
    : ''
  const title = `CS · ${
    conversationLabel
  }${
    situation.orderNumber
      ? `#${situation.orderNumber} · ${
          situation.title || 'Dossier à résoudre'
        }`
      : situation.title || 'Dossier à résoudre'
  }`.slice(0, 180)
  const testOnly = (situation.signals || []).includes('TEST_ONLY')
  try {
    const session = await host.request('session.create', {
      title,
      idempotency_key: resolutionSessionKey(situation, profile),
      follow_profile_config: true,
      model: testOnly
        ? 'anthropic/claude-haiku-5.5'
        : 'anthropic/claude-sonnet-5.5',
      provider: 'nous',
      reasoning_effort: testOnly ? 'low' : 'medium',
      ...(profile ? { profile } : {})
    })
    const runtimeId = session?.session_id
    const storedId = session?.stored_session_id
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
    host.notify({
      kind: 'error',
      message:
        'Le chat dédié n’a pas pu être ouvert. Aucune autre session n’a été modifiée.'
    })
    return false
  }
}

function inboxViewLabel(view) {
  return (
    {
      TO_PROCESS: 'À traiter',
      WAITING: 'En attente',
      RESOLVED: 'Terminés',
      ALL: 'Tout'
    }[view] || 'À traiter'
  )
}

function notificationPresentationFor(notification) {
  const situation = notification?.payload?.situation || {}
  return fallbackSituationPresentation(situation, {
    presentation: notification?.payload?.presentation,
    requestedBy: notification?.payload?.requestedBy,
    manualRequest: notification?.payload?.manualRequest === true
  })
}

function notificationSection(label, content, options = {}) {
  if (
    content === null ||
    content === undefined ||
    content === '' ||
    (Array.isArray(content) && content.length === 0)
  ) {
    return null
  }
  const values = Array.isArray(content) ? content : [content]
  return jsxs('div', {
    style: {
      display: 'grid',
      gap: '4px',
      padding:
        options.prominent === true
          ? '8px 10px'
          : options.panel
            ? '7px 9px'
            : '6px 0',
      borderBottom: options.last || options.panel
        ? 'none'
        : '1px solid var(--ui-stroke-secondary)',
      borderRadius: options.panel ? '8px' : 0,
      background: options.accent
        ? 'rgba(59, 130, 246, 0.1)'
        : options.panel
          ? 'var(--ui-bg-primary)'
          : 'transparent'
    },
    children: [
      jsx('span', {
        style: {
          color: 'var(--ui-text-tertiary)',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase'
        },
        children: label
      }),
      ...values.map((value, index) =>
        jsx('span', {
          style: {
            color: options.prominent
              ? 'var(--ui-text-primary)'
              : 'var(--ui-text-secondary)',
            fontSize: options.prominent ? '14px' : '12px',
            fontWeight: options.prominent ? 700 : 500,
            lineHeight: 1.4
          },
          children: value,
          key: `${label}-${index}`
        })
      )
    ]
  })
}

function OperationsOverview({
  ctx,
  streaming,
  operatorRef,
  initialView,
  focus
}) {
  const runtime = useRuntimeCompatibility(ctx)
  const defaultView =
    initialView ||
    (operatorRef ? 'MY_INBOX' : 'TEAM_SUPPORT')
  const [activeView, setActiveView] = useState(defaultView)
  const cacheKey = `${currentConnectionKey()}:${currentProfileKey()}:${
    operatorRef || 'global'
  }:${activeView}:${focus || 'ALL'}`
  const initialCache = operationsOverviewCache.get(cacheKey)
  const [overview, setOverview] = useState(
    initialCache?.overview || null
  )
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (force = false) => {
    const cached = operationsOverviewCache.get(cacheKey)
    if (cached) {
      setOverview(cached.overview)
      setLoading(false)
      if (
        !force &&
        Date.now() - cached.cachedAt < OPERATIONS_OVERVIEW_CACHE_MS
      ) {
        return
      }
      setRefreshing(true)
    } else {
      setOverview(null)
      setLoading(true)
    }
    try {
      const query = new URLSearchParams({
        view: activeView,
        focus: focus || 'ALL',
        ...(force ? { refresh: '1' } : {}),
        ...(operatorRef ? { operator: operatorRef } : {})
      }).toString()
      let request = operationsOverviewRequests.get(cacheKey)
      if (!request) {
        request = ctx
          .rest(`${API_PATHS.overview}?${query}`, {
            timeoutMs: 60_000
          })
          .finally(() => operationsOverviewRequests.delete(cacheKey))
        operationsOverviewRequests.set(cacheKey, request)
      }
      const result = await request
      operationsOverviewCache.set(cacheKey, {
        overview: result,
        cachedAt: Date.now()
      })
      setOverview(result)
      setError('')
    } catch (loadError) {
      setError(
        readableUiError(
          loadError,
          'La vue du service client est indisponible.',
        )
      )
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [activeView, cacheKey, ctx, focus, operatorRef])

  useEffect(() => {
    void load()
  }, [load])

  const resolveNow = async situation => {
    const profile =
      overview.scope?.operatorRef ||
      host.state.focusedSessionProfile.get() ||
      undefined
    await openSituationChat(situation, profile)
  }

  if ((streaming || loading) && !overview) {
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
            onClick: () => void load(true),
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
                children:
                  focus && focus !== 'ALL'
                    ? `${
                        {
                          PRIORITY_CUSTOMERS: 'Clients VIP et VIC',
                          VENDOR_FOLLOW_UP: 'Suivis vendeurs',
                          CUSTOMS: 'Dédouanements',
                          DELIVERY_RISK: 'Risques de retard',
                          RETURNS: 'Retours'
                        }[focus] || 'Vue filtrée'
                      } · ${overview.situations.length} dossier${
                        overview.situations.length === 1 ? '' : 's'
                      }`
                    : `${overview.scope?.operatorName ? `${overview.scope.operatorName} · ` : ''}${overview.summary.supportOpen} ouvertes · ${overview.summary.supportUnanswered} en attente de réponse`
              })
            ]
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: () => void load(true),
            disabled: refreshing,
            children: refreshing ? 'Actualisation…' : 'Actualiser'
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
                    ...(situation.importantInformation || []).map(
                      information =>
                        jsx('strong', {
                          style: {
                            color: 'var(--ui-text-primary)',
                            fontSize: '11px',
                            lineHeight: 1.4
                          },
                          children: information
                        })
                    ),
                    !isV2Live(runtime) || !normalizeWorkflow(situation)
                      ? jsx('span', {
                          style: {
                            color: 'var(--ui-text-tertiary)',
                            fontSize: '11px'
                          },
                          children: situation.nextAction
                        })
                      : null,
                    jsx(VisionContextBlock, {
                      ctx,
                      value: situation.visionUi,
                      surface: 'OVERVIEW'
                    }),
                    jsx(WorkflowPanel, {
                      ctx,
                      runtime,
                      source: situation,
                      operatorRef,
                      onUpdated: () => {
                        operationsOverviewCache.delete(cacheKey)
                        void load(true)
                      }
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
  const focusedSessionId = host.state.focusedSessionId.get()
  const focusedProfile = host.state.focusedSessionProfile.get()
  const homeProfile = host.state.profile.get()
  const profile =
    (
      focusedSessionId
        ? focusedProfile
        : homeProfile || focusedProfile
    ) || ''
  const operator =
    profile === 'lyse' || profile === 'philippine' ? profile : ''
  return { profile, operator }
}

function operatorQuery(operator) {
  return operator ? `?operator=${encodeURIComponent(operator)}` : ''
}

function notificationInboxQuery(operator, filters = {}) {
  const params = new URLSearchParams()
  if (operator) params.set('operator', operator)
  if (filters.query?.trim()) params.set('query', filters.query.trim())
  params.set('view', filters.view || 'TO_PROCESS')
  params.set('priority', filters.priority || 'ALL')
  params.set('source', filters.source || 'ALL')
  params.set('sort', filters.sort || 'ACTION')
  return `?${params.toString()}`
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
    `${API_PATHS.notificationInbox}${operatorQuery(operator)}`,
    { timeoutMs: 20_000 }
  )
  const hasResolvedScope =
    data && Object.prototype.hasOwnProperty.call(data, 'operatorRef')
  const resolvedOperator =
    data?.operatorRef === 'lyse' ||
    data?.operatorRef === 'philippine'
      ? data.operatorRef
      : hasResolvedScope
        ? ''
        : operator
  setActiveNotificationOperator(resolvedOperator)
  const current = notificationInboxAtom.get()
  notificationInboxAtom.set({
    ...current,
    byOperator: {
      ...current.byOperator,
      [resolvedOperator]: Array.isArray(data?.notifications)
        ? data.notifications
        : []
    }
  })
}

async function loadNotificationInbox(
  ctx,
  operator,
  filters
) {
  const data = await ctx.rest(
    `${API_PATHS.notificationInbox}${notificationInboxQuery(
      operator,
      filters
    )}`,
    { timeoutMs: 20_000 }
  )
  if (
    data &&
    Object.prototype.hasOwnProperty.call(data, 'operatorRef')
  ) {
    setActiveNotificationOperator(
      data.operatorRef === 'lyse' ||
        data.operatorRef === 'philippine'
        ? data.operatorRef
        : ''
    )
  }
  return Array.isArray(data?.notifications)
    ? data.notifications
    : []
}

async function readNotification(ctx, notificationId) {
  const { operator } = currentNotificationScope()
  await ctx.rest(
    `${API_PATHS.notificationRead(notificationId)}${operatorQuery(operator)}`,
    { method: 'POST', body: {}, timeoutMs: 20_000 }
  )
  await refreshNotificationInbox(ctx, operator)
}

function closureNotificationPayload(notification) {
  const payload = notification?.payload
  if (
    !['CLOSURE_CONFIRMATION', 'CLOSURE_CONFIRMATION_REMINDER'].includes(
      payload?.eventKind
    ) ||
    !UUID_RE.test(payload?.watchId || '') ||
    !Number.isInteger(payload?.workflowCycle)
  ) {
    return null
  }
  return payload
}

async function decideClosureNotification(ctx, notification, decision) {
  const closure = closureNotificationPayload(notification)
  if (!closure) throw new Error('INVALID_CLOSURE_NOTIFICATION')
  const { operator } = currentNotificationScope()
  await ctx.rest(
    `${API_PATHS.workflowClosure(closure.watchId)}${operatorQuery(operator)}`,
    {
    method: 'POST',
    body: {
      expectedVersion: closure.workflowCycle,
      decision,
      ...(decision === 'CLOSE'
        ? {
            outcome:
              closure.resolutionCriteria ||
              'Clôture confirmée par l’opératrice'
          }
        : {})
    },
    timeoutMs: 20_000
    }
  )
  await readNotification(ctx, notification.id)
}

async function claimNotificationWatch(ctx, notification) {
  const payload = notification?.payload
  if (!UUID_RE.test(payload?.watchId || '')) return null
  const { operator } = currentNotificationScope()
  const result = await ctx.rest(
    `${API_PATHS.workflowClaim(payload.watchId)}${operatorQuery(operator)}`,
    {
    method: 'POST',
    body: {
      ...(Number.isInteger(payload.workflowCycle)
        ? { expectedVersion: payload.workflowCycle }
        : {})
    },
    timeoutMs: 20_000
    }
  )
  await refreshNotificationInbox(ctx, operator)
  return result
}

async function resolveNotificationNow(
  ctx,
  notification,
  profile = currentNotificationScope().profile
) {
  const situation = notification?.payload?.situation
  const watchId = notification?.payload?.watchId
  if (!situation?.id) {
    throw new Error('INVALID_NOTIFICATION_CASE')
  }
  const { operator } = currentNotificationScope()
  if (!UUID_RE.test(watchId || '')) {
    const opened = await openSituationChat(
      situation,
      operator || profile || undefined,
      {
        presentation: notification?.payload?.presentation,
        requestedBy: notification?.payload?.requestedBy,
        manualRequest:
          notification?.payload?.manualRequest === true,
        notificationCreatedAt: notification.createdAt,
        changeSummary: notification?.payload?.changeSummary
      }
    )
    if (!opened) {
      throw new Error('RESOLUTION_SESSION_OPEN_FAILED')
    }
    await readNotification(ctx, notification.id)
    host.notify({
      kind: 'success',
      message:
        'Session de résolution ouverte ; cette ancienne alerte ne modifie pas l’assignation'
    })
    return true
  }
  const claimed = await claimNotificationWatch(ctx, notification)
  const claim = claimed?.claim
  if (
    !claim ||
    !UUID_RE.test(claim.claimToken || '') ||
    !Number.isInteger(claim.workflowCycle)
  ) {
    throw new Error('CASE_WATCH_CLAIM_MISSING')
  }
  try {
    await ctx.rest(
      `${API_PATHS.workflowConfirmAssignment(watchId)}${operatorQuery(
        operator
      )}`,
      {
        method: 'POST',
        body: {
          expectedVersion: claim.workflowCycle,
          reservationRef: claim.claimToken
        },
        timeoutMs: 30_000
      }
    )
  } catch (error) {
    await ctx
      .rest(
        `${API_PATHS.workflowRelease(watchId)}${operatorQuery(
          operator
        )}`,
        {
          method: 'POST',
          body: { reservationRef: claim.claimToken },
          timeoutMs: 20_000
        }
      )
      .catch(() => undefined)
    throw error
  }
  const opened = await openSituationChat(
    situation,
    operator || profile || undefined,
    {
      presentation: notification?.payload?.presentation,
      requestedBy: notification?.payload?.requestedBy,
      manualRequest:
        notification?.payload?.manualRequest === true,
      workflow: normalizeWorkflow(notification),
      notificationCreatedAt: notification.createdAt,
      changeSummary: notification?.payload?.changeSummary
    }
  )
  if (!opened) {
    throw new Error('RESOLUTION_SESSION_OPEN_FAILED')
  }
  await readNotification(ctx, notification.id)
  host.notify({
    kind: 'success',
    message: 'Dossier pris en charge et session de résolution ouverte'
  })
  return true
}

async function pollDesktopNotifications(ctx) {
  const { profile, operator } = currentNotificationScope()
  if (operator) setActiveNotificationOperator(operator)
  if (notificationPollRunning.has(operator)) return
  notificationPollRunning.add(operator)
  try {
    const query = operatorQuery(operator)
    const data = await ctx.rest(`${API_PATHS.notifications}${query}`, {
      timeoutMs: 20_000
    })
    if (
      data &&
      Object.prototype.hasOwnProperty.call(data, 'operatorRef')
    ) {
      setActiveNotificationOperator(
        data.operatorRef === 'lyse' ||
          data.operatorRef === 'philippine'
          ? data.operatorRef
          : ''
      )
    }
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
      const closure = closureNotificationPayload(notification)
      try {
        const resolve = async () => {
          return resolveNotificationNow(
            ctx,
            notification,
            profile
          )
        }
        host.notify({
          kind: 'info',
          message: `${notification.title} · ${notification.body}`
        })
        await ctx.os.notify({
          title: notification.title,
          body: notification.body,
          ...(closure
            ? {
                onActivate: () => undefined,
                actions: [
                  {
                    id: 'close-case',
                    label: 'Clôturer',
                    onAction: () =>
                      decideClosureNotification(ctx, notification, 'CLOSE')
                  },
                  {
                    id: 'continue-case',
                    label: 'Continuer le suivi',
                    onAction: () =>
                      decideClosureNotification(
                        ctx,
                        notification,
                        'CONTINUE'
                      )
                  }
                ]
              }
            : situation?.id
              ? {
                onActivate: resolve,
                actions: [
                  {
                    id: 'resolve-now',
                    label: 'Résoudre maintenant',
                    onAction: resolve
                  }
                ]
                }
              : {})
        })
        await ctx.rest(
          `${API_PATHS.notificationOutcome(notification.id)}${query}`,
          {
            method: 'POST',
            body: {
              outcome: 'DELIVERED',
              deliveryToken: notification.deliveryToken
            },
            timeoutMs: 20_000
          }
        )
      } catch (deliveryError) {
        await ctx
          .rest(`${API_PATHS.notificationOutcome(notification.id)}${query}`, {
            method: 'POST',
            body: {
              outcome: 'RETRY',
              deliveryToken: notification.deliveryToken,
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
  const runtime = useRuntimeCompatibility(ctx)
  const inbox = useValue(notificationInboxAtom)
  const [working, setWorking] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const { profile, operator: profileOperator } =
    currentNotificationScope()
  const operator = profileOperator || inbox.activeOperator || ''
  const [notifications, setNotifications] = useState(
    notificationsForOperator(inbox, operator)
  )
  const [query, setQuery] = useState('')
  const [view, setView] = useState('TO_PROCESS')
  const [priority, setPriority] = useState('ALL')
  const [source, setSource] = useState('ALL')
  const [sort, setSort] = useState('ACTION')
  const requestSequence = useRef(0)
  const operatorInbox = notificationsForOperator(inbox, operator)
  const inboxSignal = `${operatorInbox.length}:${
    operatorInbox[0]?.id || ''
  }:${operatorInbox[0]?.createdAt || ''}`
  const filters = useMemo(
    () => ({ query, view, priority, source, sort }),
    [query, view, priority, source, sort]
  )

  const refresh = useCallback(async () => {
    const sequence = requestSequence.current + 1
    requestSequence.current = sequence
    setRefreshing(true)
    try {
      const next = await loadNotificationInbox(
        ctx,
        operator,
        filters
      )
      if (requestSequence.current === sequence) {
        setNotifications(next)
        setError('')
      }
    } catch (refreshError) {
      if (requestSequence.current === sequence) {
        setError(
          readableUiError(
            refreshError,
            'La boîte de notifications est indisponible.',
          )
        )
      }
    } finally {
      if (requestSequence.current === sequence) {
        setRefreshing(false)
      }
    }
  }, [ctx, filters, operator])

  useEffect(() => {
    const timer = window.setTimeout(
      () => void refresh(),
      query.trim() ? 220 : 0
    )
    return () => window.clearTimeout(timer)
  }, [query, refresh])

  useEffect(() => {
    if (operatorInbox.length > 0) void refresh()
  }, [inboxSignal])

  const dismiss = async notification => {
    setWorking(notification.id)
    setError('')
    try {
      await readNotification(ctx, notification.id)
      await refreshNotificationInbox(ctx, operator)
      await refresh()
    } catch (readError) {
      setError(
        readableUiError(
          readError,
          'Cette notification n’a pas pu être marquée comme lue.',
        )
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
      await resolveNotificationNow(
        ctx,
        notification,
        profile
      )
      await refresh()
    } catch (resolveError) {
      setError(
        readableUiError(
          resolveError,
          'Cette notification n’a pas pu être ouverte.',
        )
      )
    } finally {
      setWorking('')
    }
  }

  const decideClosure = async (notification, decision) => {
    setWorking(notification.id)
    setError('')
    try {
      await decideClosureNotification(ctx, notification, decision)
      await refreshNotificationInbox(ctx, operator)
      await refresh()
    } catch (closureError) {
      setError(
        readableUiError(
          closureError,
          'La décision de clôture n’a pas pu être enregistrée.'
        )
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
                children: `${notifications.length} dossier${
                  notifications.length > 1 ? 's' : ''
                } · ${inboxViewLabel(view)} · ${
                  operator || 'Vue globale de Gary'
                } · Interface ${PLUGIN_RELEASE_REVISION}`
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
      jsxs('section', {
        style: {
          display: 'grid',
          gap: '10px',
          marginBottom: '16px',
          padding: '12px',
          border: '1px solid var(--ui-stroke-secondary)',
          borderRadius: '12px',
          background: 'var(--ui-bg-secondary)'
        },
        children: [
          jsx(Input, {
            value: query,
            placeholder:
              'Rechercher une commande, un client, un vendeur ou un mot-clé…',
            'aria-label': 'Rechercher dans les dossiers du service client',
            onChange: event => setQuery(event.target.value)
          }),
          jsxs('div', {
            style: {
              display: 'flex',
              gap: '6px',
              flexWrap: 'wrap',
              alignItems: 'center'
            },
            children: [
              ...['TO_PROCESS', 'WAITING', 'RESOLVED', 'ALL'].map(
                item =>
                  jsx(Button, {
                    size: 'sm',
                    variant:
                      view === item ? undefined : 'secondary',
                    onClick: () => setView(item),
                    children: inboxViewLabel(item)
                  })
              ),
              jsx('span', {
                style: { flex: '1 1 12px' },
                'aria-hidden': true
              }),
              jsx('select', {
                value: source,
                'aria-label': 'Filtrer par source',
                onChange: event => setSource(event.target.value),
                style: {
                  minHeight: '30px',
                  border: '1px solid var(--ui-stroke-secondary)',
                  borderRadius: '8px',
                  background: 'var(--ui-bg-primary)',
                  color: 'var(--ui-text-primary)',
                  padding: '0 7px',
                  width: '160px',
                  fontSize: '12px'
                },
                children: [
                  jsx('option', {
                    value: 'ALL',
                    children: 'Toutes les sources'
                  }),
                  jsx('option', {
                    value: 'INTERCOM',
                    children: 'Demandes Intercom'
                  }),
                  jsx('option', {
                    value: 'AUTOMATIC',
                    children: 'Détections Hermes'
                  })
                ]
              }),
              jsx('select', {
                value: priority,
                'aria-label': 'Filtrer par priorité',
                onChange: event => setPriority(event.target.value),
                style: {
                  minHeight: '30px',
                  border: '1px solid var(--ui-stroke-secondary)',
                  borderRadius: '8px',
                  background: 'var(--ui-bg-primary)',
                  color: 'var(--ui-text-primary)',
                  padding: '0 7px',
                  width: '165px',
                  fontSize: '12px'
                },
                children: [
                  jsx('option', {
                    value: 'ALL',
                    children: 'Toutes les priorités'
                  }),
                  jsx('option', {
                    value: 'CRITICAL',
                    children: 'Critique'
                  }),
                  jsx('option', {
                    value: 'HIGH',
                    children: 'Élevée'
                  }),
                  jsx('option', {
                    value: 'MEDIUM',
                    children: 'Normale'
                  }),
                  jsx('option', {
                    value: 'LOW',
                    children: 'Faible'
                  })
                ]
              }),
              jsx('select', {
                value: sort,
                'aria-label': 'Trier les dossiers',
                onChange: event => setSort(event.target.value),
                style: {
                  minHeight: '30px',
                  border: '1px solid var(--ui-stroke-secondary)',
                  borderRadius: '8px',
                  background: 'var(--ui-bg-primary)',
                  color: 'var(--ui-text-primary)',
                  padding: '0 7px',
                  width: '135px',
                  fontSize: '12px'
                },
                children: [
                  jsx('option', {
                    value: 'ACTION',
                    children: 'Action requise'
                  }),
                  jsx('option', {
                    value: 'NEWEST',
                    children: 'Plus récents'
                  }),
                  jsx('option', {
                    value: 'OLDEST',
                    children: 'Plus anciens'
                  })
                ]
              })
            ]
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
            children:
              query.trim() || source !== 'ALL' || priority !== 'ALL'
                ? 'Aucun dossier ne correspond à ces filtres.'
                : `Aucun dossier dans « ${inboxViewLabel(view)} ».`
          })
        : jsx('div', {
            style: { display: 'grid', gap: '10px' },
            children: notifications.map(notification => {
              const situation = notification?.payload?.situation
              const closure = closureNotificationPayload(notification)
              const notificationWorkflow =
                normalizeWorkflow(notification)
              const closureHandledByWorkflow =
                isV2Live(runtime) &&
                Boolean(
                  notificationWorkflow?.canClose ||
                    notificationWorkflow?.canContinue
                )
              const priority =
                notification?.payload?.priority || 'INFORMATION'
              const presentation =
                notificationPresentationFor(notification)
              const manualRequest =
                notification?.payload?.manualRequest === true
              const isNew =
                Date.now() -
                  new Date(notification.createdAt).getTime() <
                15 * 60_000
              return jsxs('article', {
                style: {
                  ...cardStyle,
                  borderColor: manualRequest
                    ? 'var(--ui-accent)'
                    : 'var(--ui-stroke-secondary)',
                  boxShadow: manualRequest
                    ? 'inset 3px 0 0 var(--ui-accent)'
                    : 'none'
                },
                children: [
                  jsxs('div', {
                    style: headerStyle,
                    children: [
                      jsxs('div', {
                        style: { display: 'grid', gap: '4px' },
                        children: [
                          jsxs('div', {
                            style: {
                              display: 'flex',
                              gap: '6px',
                              flexWrap: 'wrap',
                              alignItems: 'center'
                            },
                            children: [
                              manualRequest
                                ? jsx(Badge, {
                                    children:
                                      'Demandé depuis Intercom'
                                  })
                                : null,
                              isNew
                                ? jsx(Badge, {
                                    children: 'Nouveau'
                                  })
                                : null,
                              jsx('strong', {
                                style: { fontSize: '13px' },
                                children: notification.title
                              })
                            ]
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
                      priorityPill(priority)
                    ]
                  }),
                  jsxs('div', {
                    style: {
                      ...bodyStyle,
                      gap: '7px',
                      padding: '10px 12px'
                    },
                    children: [
                      notificationSection(
                        'Dossier',
                        presentation.dossier,
                        { prominent: true, panel: true }
                      ),
                      jsxs('div', {
                        style: {
                          display: 'grid',
                          gridTemplateColumns:
                            'repeat(auto-fit, minmax(220px, 1fr))',
                          gap: '7px'
                        },
                        children: [
                          notificationSection(
                            'Source',
                            presentation.source,
                            { panel: true }
                          ),
                          notificationSection(
                            'Mission',
                            presentation.mission,
                            { panel: true }
                          )
                        ]
                      }),
                      notificationSection(
                        'Résumé',
                        presentation.summary,
                        { panel: true }
                      ),
                      jsxs('div', {
                        style: {
                          display: 'grid',
                          gridTemplateColumns:
                            'repeat(auto-fit, minmax(220px, 1fr))',
                          gap: '7px'
                        },
                        children: [
                          notificationSection(
                            'État actuel',
                            presentation.currentState,
                            { panel: true }
                          ),
                          notificationSection(
                            'À vérifier',
                            presentation.checks.map(
                              item => `• ${item}`
                            ),
                            { panel: true }
                          )
                        ]
                      }),
                      notificationSection(
                        'Prochaine action',
                        presentation.nextAction,
                        {
                          last: true,
                          panel: true,
                          accent: true
                        }
                      ),
                      jsx(VisionNotificationThumbnail, {
                        ctx,
                        value: notification?.payload?.visionUi,
                        notificationId: notification.id
                      }),
                      jsx(WorkflowPanel, {
                        ctx,
                        runtime,
                        source: notification,
                        operatorRef: operator,
                        onUpdated: (_next, result) => {
                          void refresh()
                          if (result?.assignment) {
                            void (async () => {
                              const opened = await openSituationChat(
                                situation,
                                operator || profile || undefined,
                                {
                                  presentation:
                                    notification?.payload?.presentation,
                                  requestedBy:
                                    notification?.payload?.requestedBy,
                                  manualRequest:
                                    notification?.payload?.manualRequest === true,
                                  workflow: notificationWorkflow
                                }
                              )
                              if (!opened) return
                              await readNotification(
                                ctx,
                                notification.id
                              )
                              await refresh()
                            })()
                          }
                          if (closure && result?.ok === true) {
                            void (async () => {
                              await readNotification(
                                ctx,
                                notification.id
                              )
                              await refresh()
                            })()
                          }
                        }
                      })
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
                            : null,
                          closure && !closureHandledByWorkflow
                            ? jsx(Button, {
                                size: 'sm',
                                variant: 'secondary',
                                disabled: working === notification.id,
                                onClick: () =>
                                  decideClosure(notification, 'CONTINUE'),
                                children: 'Continuer le suivi'
                              })
                            : null,
                          closure && !closureHandledByWorkflow
                            ? jsx(Button, {
                                size: 'sm',
                                disabled: working === notification.id,
                                onClick: () =>
                                  decideClosure(notification, 'CLOSE'),
                                children:
                                  working === notification.id
                                    ? 'Enregistrement…'
                                    : 'Clôturer'
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
  version: PLUGIN_VERSION,
  register(ctx) {
    ctx.register({
      id: 'oblist-cs-home-page',
      area: ROUTES_AREA,
      data: { path: '/oblist-cs-home' },
      render: () => jsx(CsHomePage, { ctx })
    })
    ctx.register({
      id: 'oblist-cs-home-nav',
      area: SIDEBAR_NAV_AREA,
      order: 30,
      data: {
        path: '/oblist-cs-home',
        label: 'Accueil CS',
        codicon: 'home'
      }
    })
    if (
      !host.state.activeSessionId.get() &&
      !host.state.focusedSessionId.get()
    ) {
      queueMicrotask(() => host.navigate('/oblist-cs-home'))
    }
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
      if (operator) setActiveNotificationOperator(operator)
      void pollDesktopNotifications(ctx)
    }
    const unsubscribeFocusedProfile =
      host.state.focusedSessionProfile.subscribe(syncActiveProfile)
    const unsubscribeFocusedSession =
      host.state.focusedSessionId.subscribe(syncActiveProfile)
    const unsubscribeHomeProfile =
      host.state.profile.subscribe(syncActiveProfile)
    ctx.onDispose(() => {
      unsubscribeFocusedProfile()
      unsubscribeFocusedSession()
      unsubscribeHomeProfile()
    })
    void refreshRuntimeHandshake(ctx, true)
    const runtimeTimer = window.setInterval(
      () => void refreshRuntimeHandshake(ctx, true),
      RUNTIME_HANDSHAKE_CACHE_MS
    )
    ctx.onDispose(() => window.clearInterval(runtimeTimer))
    void refreshManagedPluginRelease(ctx, true)
    const managedReleaseTimer = window.setInterval(
      () => void refreshManagedPluginRelease(ctx, true),
      MANAGED_PLUGIN_RELEASE_POLL_MS
    )
    ctx.onDispose(() =>
      window.clearInterval(managedReleaseTimer)
    )
    syncActiveProfile()
    const notificationTimer = window.setInterval(
      () => void pollDesktopNotifications(ctx),
      10_000
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
      id: 'oblist-vision-directive',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: VISION_DIRECTIVE_NAME,
        render: ({
          attrs,
          structuredContent,
          streaming
        }) =>
          jsx(VisionDirective, {
            ctx,
            attrs,
            structuredContent,
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
            initialView: attrs.view || attrs.scope || '',
            focus: normalizeCsOverviewFocus(attrs.focus)
          })
      }
    })
  }
}
