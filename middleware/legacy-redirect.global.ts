export default defineNuxtRouteMiddleware((to) => {
  const destinations: Record<string, string> = {
    '/tavern': '/juego',
    '/stash': '/equipment-v2',
    '/caravan': '/caravan-v2'
  }
  const destination = destinations[to.path]
  if (destination) return navigateTo(destination, { replace: true })
})
