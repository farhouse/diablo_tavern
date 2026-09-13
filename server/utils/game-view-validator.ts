import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import contract from '../../contracts/v2-etapa0-3/schema.json'

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
