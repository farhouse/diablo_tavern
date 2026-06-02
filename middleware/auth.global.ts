export default defineNuxtRouteMiddleware((to) => {
  const auth = useAuthStore()
  auth.hydrate()

  if (to.path === '/login') {
    if (auth.loggedIn) return navigateTo('/tavern')
    return
  }

  if (!auth.loggedIn) return navigateTo('/login')
})
