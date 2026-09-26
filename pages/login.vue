<template>
  <main class="page">
    <form class="form card" @submit.prevent="submit">
      <div>
        <h1>Diablo Tavern</h1>
        <p class="muted">Recibí viajeros, prepará expediciones y hacé crecer tu caravana.</p>
      </div>

      <label class="field">
        <span>Email</span>
        <input v-model="email" type="email" autocomplete="email" required>
      </label>

      <label class="field">
        <span>Contraseña</span>
        <input v-model="password" type="password" autocomplete="current-password" required minlength="6">
      </label>

      <label v-if="mode === 'register'" class="field">
        <span>Código de invitación</span>
        <input v-model="inviteCode" type="text" required>
      </label>

      <p v-if="auth.error" class="error">{{ auth.error }}</p>

      <div class="row">
        <button class="btn primary" type="submit">{{ mode === 'login' ? 'Entrar' : 'Crear cuenta' }}</button>
        <button class="link-btn" type="button" @click="toggleMode">
          {{ mode === 'login' ? 'Crear una cuenta' : 'Ya tengo una cuenta' }}
        </button>
      </div>
    </form>
  </main>
</template>

<script setup lang="ts">
const auth = useAuthStore()
const mode = ref<'login' | 'register'>('login')
const email = ref('')
const password = ref('')
const inviteCode = ref('')

async function submit() {
  auth.error = ''
  try {
    if (mode.value === 'login') await auth.login(email.value, password.value)
    else await auth.register(email.value, password.value, inviteCode.value)
    return await navigateTo('/juego', { replace: true })
  } catch (error) {
    auth.error = message(error)
  }
}

function toggleMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  auth.error = ''
}

function message(error: unknown): string {
  if (typeof error === 'object' && error && 'statusMessage' in error) return String((error as { statusMessage: string }).statusMessage)
  if (error instanceof Error) return error.message
  return 'No se pudo iniciar sesión.'
}
</script>
