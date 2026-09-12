declare const __DIABLO_BUILD_SHA__: string

export default defineEventHandler(() => {
  return { sha: __DIABLO_BUILD_SHA__ }
})
