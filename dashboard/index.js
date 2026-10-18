(function registerOblistActionCardsBackend() {
  const registry = window.__HERMES_PLUGINS__
  const React = window.__HERMES_PLUGIN_SDK__?.React
  if (!registry || !React) return
  registry.register('oblist-action-cards', function HiddenActionCardsPlugin() {
    return null
  })
})()
