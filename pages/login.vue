<template>
  <main class="page">
    <form class="form card" @submit.prevent="submit">
      <div>
        <h1>Guild Manager ARPG</h1>
        <p class="muted">Build a guild, run quests, identify loot, and push through Act I.</p>
      </div>

      <label class="field">
        <span>Email</span>
        <input v-model="email" type="email" autocomplete="email" required>
      </label>

      <label class="field">
        <span>Password</span>
        <input v-model="password" type="password" autocomplete="current-password" required minlength="6">
      </label>

      <p v-if="auth.error" class="error">{{ auth.error }}</p>

      <div class="row">
        <button class="btn primary" type="submit">{{ mode === 'login' ? 'Login' : 'Create account' }}</button>
        <button class="link-btn" type="button" @click="toggleMode">
          {{ mode === 'login' ? 'Register instead' : 'Login instead' }}
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

async function submit() {
  auth.error = ''
  try {
    if (mode.value === 'login') await auth.login(email.value, password.value)
    else await auth.register(email.value, password.value)
    await navigateTo('/tavern')
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
  return 'Could not authenticate'
}
</script>
