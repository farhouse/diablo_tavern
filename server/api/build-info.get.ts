export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  return { sha: config.public.buildSha }
})
