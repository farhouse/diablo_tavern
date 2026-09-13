import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SaveGame } from '~/types/game'

const contractPath = path.resolve(process.cwd(), 'contracts/v2-etapa0-3/schema.json')
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as { $id?: string }

const ajv = new Ajv2020({ strict: true, allErrors: true })
addFormats(ajv)
ajv.addSchema(contract)

const gameViewRef = `${contract.$id}#/$defs/GameView`
const validate = ajv.compile({ $ref: gameViewRef })

export class PersistedGameValidationError extends Error {
  override name = 'PersistedGameValidationError'
}

export function validateGameView(save: unknown): void {
  if (!validate(save)) {
    const detail = ajv.errorsText(validate.errors)
    throw new PersistedGameValidationError(`Game view failed validation: ${detail}`)
  }
}

export const validatePersistedGameView = validateGameView
