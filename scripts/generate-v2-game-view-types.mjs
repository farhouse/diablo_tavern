import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = resolve(root, 'contracts/v2-etapa0-4/schema.json')
const outputPath = resolve(root, 'shared/types/v2-game-view.generated.ts')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))

function refName(ref) {
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref)
  if (!match) throw new Error(`Unsupported schema reference: ${ref}`)
  return match[1]
}

function render(node, indent = 0) {
  if (node === true) return 'unknown'
  if (node === false) return 'never'
  if (node.$ref) return refName(node.$ref)
  if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const)
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (node.oneOf) return node.oneOf.map((entry) => render(entry, indent)).join(' | ')
  if (Array.isArray(node.type)) return node.type.map((type) => render({ ...node, type }, indent)).join(' | ')

  if (!node.type && !node.properties && node.allOf) {
    return node.allOf.map((entry) => render(entry, indent)).join(' & ')
  }

  switch (node.type) {
    case 'null': return 'null'
    case 'boolean': return 'boolean'
    case 'integer':
    case 'number': return 'number'
    case 'string': return 'string'
    case 'array': return node.maxItems === 0 ? 'Array<never>' : `Array<${render(node.items ?? {}, indent)}>`
    case 'object': return renderObject(node, indent)
    default:
      if (node.properties || node.additionalProperties) return renderObject(node, indent)
      return 'unknown'
  }
}

function renderObject(node, indent) {
  const required = new Set(node.required ?? [])
  const prefix = ' '.repeat(indent)
  const childPrefix = ' '.repeat(indent + 2)
  const fields = Object.entries(node.properties ?? {}).filter(([, value]) => value !== true).map(([key, value]) => {
    const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
    return `${childPrefix}${property}${required.has(key) ? '' : '?'}: ${render(value, indent + 2)}`
  })
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    fields.push(`${childPrefix}[key: string]: ${render(node.additionalProperties, indent + 2)}`)
  }
  if (fields.length === 0) return 'Record<string, never>'
  return `{\n${fields.join('\n')}\n${prefix}}`
}

function renderDefinition(name, definition) {
  const rendered = render(definition)
  if (name === 'DisabledAction') {
    return `{ [Action in ActionId]: Omit<${rendered}, 'action'> & { action: Action } }[ActionId]`
  }
  if (name === 'ItemBase') {
    return `Omit<${rendered}, 'owner' | 'custody'> & (\n` +
      `  | { owner: VisitorOwner; custody: VisitorCustody }\n` +
      `  | { owner: CaravanOwner; custody: StashCustody | ExpeditionCustody | RecoveryCustody | SettlementCustody | ServiceCustody }\n` +
      `)`
  }
  return rendered
}

const definitions = Object.entries(schema.$defs).map(([name, definition]) =>
  `export type ${name} = ${renderDefinition(name, definition)}\n`
)

const banner = `// Generated from contracts/v2-etapa0-4/schema.json. Do not edit by hand.\n` +
  `// Run \`pnpm generate:v2-types\` after changing the normative schema.\n\n`
const output = `${banner}${definitions.join('\n')}`

mkdirSync(dirname(outputPath), { recursive: true })
if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8')
  if (current !== output) throw new Error('Generated V2 DTOs are stale; run pnpm generate:v2-types')
} else {
  writeFileSync(outputPath, output)
}
