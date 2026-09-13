import fs from 'node:fs'
import { createRequire } from 'node:module'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const schemaPath = new URL('../contracts/v2-etapa0-3/schema.json', import.meta.url)
const fixturesPath = new URL('../contracts/v2-etapa0-3/fixtures.json', import.meta.url)
const require = createRequire(import.meta.url)
const ajvVersion = require('ajv/package.json').version
const schema = JSON.parse(fs.readFileSync(schemaPath))
const fixtures = JSON.parse(fs.readFileSync(fixturesPath))
const ajv = new Ajv2020({ strict: true, allErrors: true })
addFormats(ajv)
ajv.addSchema(schema)

const compileDef = (name) => ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })
const validators = new Map()
const validator = (name) => {
  if (!validators.has(name)) validators.set(name, compileDef(name))
  return validators.get(name)
}
const fail = (code, detail) => {
  const error = new Error(`${code}: ${detail}`)
  error.code = code
  throw error
}
const find = (values, key, id) => values.find((value) => value[key] === id)
const future = (expiresAt, serverNow) => {
  if (Date.parse(expiresAt) <= Date.parse(serverNow)) fail('TOKEN_EXPIRED', `${expiresAt} <= ${serverNow}`)
}
const uniqueBy = (values, keyOf, detail) => {
  const keys = values.map(keyOf)
  if (new Set(keys).size !== keys.length) fail('TOKEN_AMBIGUOUS', detail)
}
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}
const verifySealedOptions = (options, serverNow) => options.forEach((option) => {
  future(option.expiresAt, serverNow)
  if (option.acknowledgement) future(option.acknowledgement.expiresAt, serverNow)
})

function verifyAction(game, action, owner) {
  const target = owner.type === 'game' ? null : owner.id
  if (action.targetId !== undefined && action.targetId !== target) fail('TOKEN_FOREIGN', `${action.action} target does not match ${owner.type}`)
  if (owner.type === 'game' && action.targetId !== undefined) fail('TOKEN_FOREIGN', `${action.action} global target is forbidden`)
  const locations = {
    accept_contract: { visitor: ['available', 'negotiating'] },
    start_expedition: { visitor: ['contracted'] },
    reconcile_game: { game: ['root'] },
    confirm_settlement: { visitor: ['awaiting_settlement'], settlement: ['preview_ready'] },
    assign_recovery: { recovery: ['open'] }, abandon_recovery: { recovery: ['open'] },
    sell_item_to_visitor: { visitor: ['available', 'negotiating'], item: ['unidentified', 'identified'] },
    identify_item: { item: ['unidentified'] },
    queue_blacksmith_job: { item: ['unidentified', 'identified'] },
    queue_enchanter_job: { item: ['unidentified', 'identified'] },
    dismantle_item: { item: ['unidentified', 'identified'] },
    replace_boss_imprint: { item: ['identified'] },
    upgrade_caravan: { game: ['root'] }
  }
  if (!locations[action.action]?.[owner.type]?.includes(owner.state)) fail('ACTION_LOCATION_INVALID', `${action.action} in ${owner.type}:${owner.state}`)
  if (!action.enabled) return
  const execution = action.execution

  switch (action.action) {
    case 'accept_contract': {
      if (execution.visitorId !== owner.id) fail('TOKEN_FOREIGN', 'accept visitorId differs from container')
      const visitor = find(game.visitors, 'visitorId', owner.id)
      const options = visitor?.contractOptions ?? visitor?.options ?? []
      uniqueBy(execution.bindings, (binding) => binding.optionId, 'duplicate contract option binding')
      for (const binding of execution.bindings) {
        future(binding.expiresAt, game.serverNow)
        if (!options.some((option) => option.optionId === binding.optionId)) fail('TOKEN_FOREIGN', `contract option ${binding.optionId}`)
        for (const itemId of binding.eligibleLoanItemIds) {
          const item = find(game.items, 'itemId', itemId)
          if (!item || item.owner.kind !== 'caravan' || item.custody.kind !== 'stash') fail('ELIGIBILITY_FOREIGN', `loan item ${itemId}`)
        }
      }
      break
    }
    case 'start_expedition': {
      const visitor = find(game.visitors, 'visitorId', owner.id)
      if (!visitor || visitor.contractId !== execution.contractId) fail('TOKEN_FOREIGN', `contract ${execution.contractId}`)
      break
    }
    case 'reconcile_game':
      break
    case 'confirm_settlement': {
      const settlement = find(game.settlements, 'settlementId', execution.settlementId)
      const ownerMatches = owner.type === 'settlement'
        ? settlement?.settlementId === owner.id
        : owner.type === 'visitor' && find(game.visitors, 'visitorId', owner.id)?.settlementId === execution.settlementId
      if (!settlement || !ownerMatches || settlement.state !== 'preview_ready' || settlement.previewVersion !== execution.previewVersion) {
        fail('TOKEN_FOREIGN', `settlement ${execution.settlementId}@${execution.previewVersion}`)
      }
      future(execution.expiresAt, game.serverNow)
      if (execution.expiresAt !== settlement.expiresAt) fail('TOKEN_FOREIGN', 'settlement expiry differs from preview')
      for (const group of execution.groups) {
        const source = settlement.choiceGroups.find((candidate) => candidate.groupId === group.groupId)
        if (!source || group.eligibleOptionIds.some((optionId) => !source.options.some((option) => option.optionId === optionId))) {
          fail('ELIGIBILITY_FOREIGN', `settlement group ${group.groupId}`)
        }
        const expectedOptions = source.options.map((option) => option.optionId).sort()
        const actualOptions = [...group.eligibleOptionIds].sort()
        if (JSON.stringify(actualOptions) !== JSON.stringify(expectedOptions)) fail('ELIGIBILITY_FOREIGN', `incomplete settlement options for ${group.groupId}`)
      }
      uniqueBy(execution.groups, (group) => group.groupId, 'duplicate settlement group')
      if (execution.groups.length !== settlement.choiceGroups.length) fail('ELIGIBILITY_FOREIGN', 'settlement group set is incomplete')
      break
    }
    case 'assign_recovery': {
      const recovery = find(game.recoveries, 'recoveryId', execution.recoveryId)
      if (!recovery || recovery.recoveryId !== owner.id || recovery.state !== 'open') fail('TOKEN_FOREIGN', `recovery ${execution.recoveryId}`)
      uniqueBy(execution.bindings, (binding) => `${binding.optionId}\u0000${binding.visitorId}`, 'duplicate recovery binding')
      for (const binding of execution.bindings) {
        future(binding.expiresAt, game.serverNow)
        if (!recovery.options.some((option) => option.optionId === binding.optionId)) fail('TOKEN_FOREIGN', `recovery option ${binding.optionId}`)
        const visitor = find(game.visitors, 'visitorId', binding.visitorId)
        if (!visitor || !['available', 'negotiating'].includes(visitor.state)) fail('ELIGIBILITY_FOREIGN', `recovery visitor ${binding.visitorId}`)
        for (const itemId of binding.eligibleLoanItemIds) {
          const item = find(game.items, 'itemId', itemId)
          if (!item || item.owner.kind !== 'caravan' || item.custody.kind !== 'stash') fail('ELIGIBILITY_FOREIGN', `recovery loan ${itemId}`)
        }
      }
      break
    }
    case 'abandon_recovery':
      if (execution.recoveryId !== owner.id || !find(game.recoveries, 'recoveryId', owner.id)) fail('TOKEN_FOREIGN', `recovery ${execution.recoveryId}`)
      future(execution.acknowledgement.expiresAt, game.serverNow)
      break
    case 'sell_item_to_visitor':
      if (owner.type === 'item' && execution.itemId !== owner.id) fail('TOKEN_FOREIGN', `sale item ${execution.itemId}`)
      if (!find(game.items, 'itemId', execution.itemId)) fail('TOKEN_FOREIGN', `sale item ${execution.itemId}`)
      uniqueBy(execution.offers, (offer) => offer.offerId, 'duplicate sale offer')
      for (const offer of execution.offers) {
        future(offer.expiresAt, game.serverNow)
        if (offer.itemId !== execution.itemId || !find(game.visitors, 'visitorId', offer.visitorId)) fail('TOKEN_FOREIGN', `offer ${offer.offerId}`)
        if (owner.type === 'visitor' && offer.visitorId !== owner.id) fail('TOKEN_FOREIGN', `offer visitor ${offer.visitorId}`)
      }
      break
    case 'identify_item':
    case 'queue_blacksmith_job':
    case 'queue_enchanter_job':
    case 'dismantle_item':
    case 'replace_boss_imprint':
      if (execution.itemId !== owner.id) fail('TOKEN_FOREIGN', `${action.action} item ${execution.itemId}`)
      uniqueBy(execution.options, (optionValue) => optionValue.optionId, `duplicate option for ${action.action}`)
      verifySealedOptions(execution.options, game.serverNow)
      break
    case 'upgrade_caravan':
      uniqueBy(execution.options, (optionValue) => optionValue.optionId, 'duplicate caravan upgrade option')
      verifySealedOptions(execution.options, game.serverNow)
      break
    default:
      fail('SCHEMA_INVALID', `unknown enabled action ${action.action}`)
  }
}

function verifyGame(game) {
  uniqueBy(game.visitors, (value) => value.visitorId, 'duplicate visitorId')
  uniqueBy(game.expeditions, (value) => value.expeditionId, 'duplicate expeditionId')
  uniqueBy(game.settlements, (value) => value.settlementId, 'duplicate settlementId')
  uniqueBy(game.recoveries, (value) => value.recoveryId, 'duplicate recoveryId')
  uniqueBy(game.serviceJobs, (value) => value.jobId, 'duplicate jobId')
  uniqueBy(game.items, (value) => value.itemId, 'duplicate itemId')
  for (const visitor of game.visitors) {
    const options = visitor.contractOptions ?? visitor.options
    if (options) uniqueBy(options, (value) => value.optionId, `duplicate contract option in ${visitor.visitorId}`)
  }
  for (const recovery of game.recoveries) {
    if (recovery.options) uniqueBy(recovery.options, (value) => value.optionId, `duplicate recovery option in ${recovery.recoveryId}`)
  }
  for (const settlement of game.settlements) {
    if (!settlement.choiceGroups) continue
    uniqueBy(settlement.choiceGroups, (value) => value.groupId, `duplicate choice group in ${settlement.settlementId}`)
    for (const group of settlement.choiceGroups) uniqueBy(group.options, (value) => value.optionId, `duplicate source option in ${group.groupId}`)
  }
  const projections = new Map()
  const rememberProjection = (action) => {
    const key = action.authorizationId
    const canonical = JSON.stringify(canonicalize({ action: action.action, enabled: action.enabled, execution: action.execution, reason: action.reason }))
    if (projections.has(key) && projections.get(key) !== canonical) fail('PROJECTION_MISMATCH', key)
    projections.set(key, canonical)
  }
  const verifyContainer = (actions, owner) => {
    uniqueBy(actions, (actionValue) => `${actionValue.action}\u0000${actionValue.targetId ?? ''}`, `duplicate action in ${owner.type}:${owner.id ?? 'root'}`)
    for (const actionValue of actions) { verifyAction(game, actionValue, owner); rememberProjection(actionValue) }
  }
  verifyContainer(game.actions, { type: 'game', state: 'root', id: null })
  for (const visitor of game.visitors) verifyContainer(visitor.actions, { type: 'visitor', state: visitor.state, id: visitor.visitorId })
  for (const expedition of game.expeditions) verifyContainer(expedition.actions, { type: 'expedition', state: expedition.state, id: expedition.expeditionId })
  for (const settlement of game.settlements) verifyContainer(settlement.actions, { type: 'settlement', state: settlement.state, id: settlement.settlementId })
  for (const recovery of game.recoveries) verifyContainer(recovery.actions, { type: 'recovery', state: recovery.state, id: recovery.recoveryId })
  for (const job of game.serviceJobs) verifyContainer(job.actions, { type: 'service', state: job.state, id: job.jobId })
  for (const item of game.items) verifyContainer(item.actions, { type: 'item', state: item.identification, id: item.itemId })
}

let retained = 0
for (const fixture of fixtures.retainedPositiveCases) {
  const validate = validator(fixture.schema)
  if (!validate(fixture.value)) fail('SCHEMA_INVALID', `${fixture.id}: ${ajv.errorsText(validate.errors)}`)
  retained++
}

let integrated = 0
for (const fixture of fixtures.integratedPositiveCases) {
  const validate = validator(fixture.schema)
  if (!validate(fixture.value)) fail('SCHEMA_INVALID', `${fixture.id}: ${ajv.errorsText(validate.errors)}`)
  verifyGame(fixture.value)
  integrated++
}

let negatives = 0
for (const fixture of fixtures.negativeCases) {
  const validate = validator(fixture.schema)
  try {
    if (!validate(fixture.value)) fail('SCHEMA_INVALID', ajv.errorsText(validate.errors))
    verifyGame(fixture.value)
    fail('NEGATIVE_ACCEPTED', fixture.id)
  } catch (error) {
    if (error.code !== fixture.expectedError) throw new Error(`${fixture.id}: expected ${fixture.expectedError}, got ${error.code}: ${error.message}`)
  }
  negatives++
}

console.log(JSON.stringify({ ajv: ajvVersion, strict: true, schemaDraft: '2020-12', retainedPositive: retained, integratedPositive: integrated, negativeRejected: negatives }))
