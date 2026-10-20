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

const PLUGIN_VERSION = '0.4.0'
const PLUGIN_RELEASE_REVISION = '2026.10.20.3'
const RELEASE_EPOCH = 'hermes-intelligence-v2'
const MANAGED_PLUGIN_INSTALLER_URL =
  'https://garysfez.github.io/oblist-hermes-plugin/?update=1'
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
  workflowClosure: workflowId => `/workflows/${workflowId}/closure`
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
      await ctx.rest(API_PATHS.pluginReleaseApply, {
        method: 'POST',
        body: {
          expectedCommit: release.targetCommit,
          currentRevision: PLUGIN_RELEASE_REVISION
        },
        timeoutMs: 600_000
      })
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
  initialView
}) {
  const runtime = useRuntimeCompatibility(ctx)
  const defaultView =
    initialView ||
    (operatorRef ? 'MY_INBOX' : 'TEAM_SUPPORT')
  const [activeView, setActiveView] = useState(defaultView)
  const cacheKey = `${currentConnectionKey()}:${currentProfileKey()}:${
    operatorRef || 'global'
  }:${activeView}`
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
  }, [activeView, cacheKey, ctx, operatorRef])

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
                children: `${overview.scope?.operatorName ? `${overview.scope.operatorName} · ` : ''}${overview.summary.supportOpen} ouvertes · ${overview.summary.supportUnanswered} en attente de réponse`
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
  if (!situation?.id || !UUID_RE.test(watchId || '')) {
    throw new Error('INVALID_NOTIFICATION_CASE')
  }
  const { operator } = currentNotificationScope()
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
                }`
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
