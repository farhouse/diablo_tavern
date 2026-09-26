## Contrato público V2 — Etapa 0, revisión 4

`contractVersion = "v2-etapa0-4"` reemplaza `v2-etapa0-3`.

El JSON Schema 2020-12 adjunto es normativo para forma y discriminantes cerrados. Las invariantes de referencias, pertenencia, elegibilidad y vigencia de este documento también son normativas y se ejecutan después de AJV mediante el validador contractual adjunto.

### Regla de autoridad de acciones

`ActionAvailability` sigue siendo la única autorización pública. Toda variante lleva un `authorizationId` opaco, estable sólo dentro de la revisión, que identifica la misma autorización cuando se proyecta en más de un DTO. Una acción deshabilitada conserva `reason` y `reasonText` y no expone `execution`. Toda acción habilitada es ahora una variante cerrada por `action` y exige `execution`, que contiene todos los IDs opacos, acknowledgements, opciones y conjuntos de elegibilidad necesarios para construir el payload del comando sin inferirlos de cifras, estado o IDs vecinos. `authorizationId` no forma parte del payload del comando.

El cliente sólo puede:

1. elegir una alternativa publicada en `execution`;
2. elegir `loanItemIds` como subconjunto de `eligibleLoanItemIds` del mismo binding;
3. copiar los tokens exactos del binding al payload congelado de `v2-etapa0-1`;
4. envolverlo con un `requestId` nuevo o reutilizado según idempotencia y el `expectedRevision` del mismo snapshot.

No puede fabricar, mezclar entre acciones, reutilizar tras vencer ni completar tokens ausentes. Que una entidad parezca elegible no autoriza el comando. `enabled: true` con un token vencido o ajeno es un snapshot inválido del servidor, no una invitación a que el cliente lo corrija.

### Unión cerrada de acciones ejecutables

| `action` | Contenedor / `targetId` | `execution` obligatorio | Payload derivado |
|---|---|---|---|
| `accept_contract` | visitante / `visitorId` | `{ visitorId, bindings[{ optionId, eligibleLoanItemIds, expiresAt }] }` | `{ visitorId, optionId, loanItemIds }` usando un binding y un subconjunto elegible |
| `start_expedition` | visitante / `visitorId` | `{ contractId }` | `{ contractId }` |
| `reconcile_game` | `GameView`, sin `targetId` | `{}` | `{}` |
| `confirm_settlement` | visitante o settlement / ID del contenedor | `{ settlementId, previewVersion, expiresAt, groups[{ groupId, eligibleOptionIds }] }` | `{ settlementId, previewVersion, selectedOptionIds }`, exactamente uno por grupo |
| `assign_recovery` | recovery / `recoveryId` | `{ recoveryId, bindings[{ optionId, visitorId, eligibleLoanItemIds, expiresAt }] }` | `{ recoveryId, visitorId, optionId, loanItemIds }` desde un único binding |
| `abandon_recovery` | recovery / `recoveryId` | `{ recoveryId, acknowledgement{ acknowledgementId, expiresAt, text } }` | `{ recoveryId, acknowledgementId }` |
| `sell_item_to_visitor` | visitante o item / ID del contenedor | `{ itemId, offers[{ offerId, visitorId, itemId, expiresAt, label, description, consequences }] }` | `{ visitorId, offerId, itemId }` desde una oferta |
| `identify_item` | item / `itemId` | `{ itemId, options: SealedOption[] }` | `{ itemId, optionId }` |
| `queue_blacksmith_job` | item / `itemId` | `{ itemId, options: SealedOption[] }` | `{ itemId, optionId }` |
| `queue_enchanter_job` | item / `itemId` | `{ itemId, options: SealedOption[] }` | `{ itemId, optionId }` |
| `dismantle_item` | item / `itemId` | `{ itemId, options: DestructiveOption[] }` | `{ itemId, optionId, acknowledgementId }` de la misma opción |
| `replace_boss_imprint` | item / `itemId` | `{ itemId, options: DestructiveOption[] }` | `{ itemId, optionId, acknowledgementId }` de la misma opción |
| `upgrade_caravan` | `GameView`, sin `targetId` | `{ options: SealedOption[] }` | `{ optionId }` |

```ts
type SealedOption = {
  optionId: string
  expiresAt: UtcDateTime
  label: LocalizedText
  description: LocalizedText
  consequences: ConsequenceView[]
}

type Acknowledgement = {
  acknowledgementId: string
  expiresAt: UtcDateTime
  text: LocalizedText
}

type DestructiveOption = SealedOption & {
  acknowledgement: Acknowledgement
}
```

Ofertas y opciones son renderizables por sí mismas. Nunca se muestra un token como copy; `label`, `description`, `text` y las consecuencias mantienen el fallback accesible obligatorio de revisión 2. `expiresAt` siempre usa reloj del servidor y el token es vigente sólo cuando `serverNow < expiresAt`.

### Correlaciones normativas

Además de la estructura cerrada del Schema:

1. `targetId` coincide con el ID del contenedor. Las acciones globales lo prohíben. La copia de `visitorId`, `itemId`, `settlementId` o `recoveryId` en `execution` resuelve al recurso del comando; cuando la acción se proyecta sobre otro contenedor admitido (`confirm_settlement` en visitante o `sell_item_to_visitor` en visitante), la correlación se verifica por las referencias de ese contenedor.
2. Cada `accept_contract.bindings[].optionId` pertenece a `contractOptions/options` del mismo visitante. Cada préstamo elegible resuelve a un `ItemView` `owner=caravan`, `custody=stash`.
3. `start_expedition.contractId` es el contrato del visitante `contracted` contenedor.
4. `confirm_settlement` referencia el mismo preview `preview_ready`, igual `previewVersion` e igual `expiresAt`. Publica todos y sólo sus grupos, y cada `eligibleOptionId` pertenece al grupo correspondiente.
5. Cada binding de `assign_recovery` referencia una opción del mismo recovery, un visitante visible en estado `available|negotiating` y préstamos elegibles actualmente en stash. No pueden mezclarse `optionId`, `visitorId` o préstamos de bindings diferentes.
6. `abandon_recovery` sólo referencia su recovery. Venta sólo referencia el item contenedor y un visitante visible; `offerId` queda ligado a esa pareja exacta.
7. Identificación, herrero, encantador, desmantelado y reemplazo de impronta repiten exactamente el `itemId` contenedor. En acciones destructivas `optionId` y `acknowledgementId` se toman de la misma `DestructiveOption`.
8. Todo `expiresAt` de un binding, oferta, opción o acknowledgement de una acción habilitada satisface estrictamente `serverNow < expiresAt`.
9. Cada acción, habilitada o deshabilitada, sólo aparece en los contenedores y estados de la matriz de revisión 2. Si el mismo `authorizationId` se proyecta en dos lugares por accesibilidad —por ejemplo confirmación en visitante y settlement— conserva el mismo `action`, `enabled`, `execution` y `reason`; no se admite que una proyección esté habilitada y otra deshabilitada. No crea dos autorizaciones ni dos operaciones; idempotencia sigue gobernada por `requestId` y claves de negocio.
10. Los IDs de visitantes, expediciones, settlements, recoveries, jobs e items son únicos por colección. También lo son los `optionId` en cada colección fuente de contrato, recovery o choice group; ninguna resolución normativa usa “el primero encontrado”.
11. `bindings`, `offers`, `options` y `groups` son mapas serializados, no multiconjuntos ambiguos: sus claves de selección (`optionId`, `offerId`, `groupId`, o la pareja `optionId+visitorId` en recovery) son únicas dentro de la acción.
12. Al cambiar `revision`, ninguna autorización local sobrevive automáticamente. El cliente conserva una selección sólo si el nuevo snapshot vuelve a publicar la misma acción, binding y tokens vigentes.

Una violación de estas invariantes invalida la respuesta del servidor. No se representa como `ACTION_UNAVAILABLE` ni se repara en frontend.

### Fixtures integrados y negativos

El archivo adjunto conserva 60 fixtures positivos de revisión 2 y agrega ocho `GameView` completos por familia:

- contrato/préstamos elegibles;
- inicio de expedición;
- reconciliación y mejora de caravana;
- confirmación de settlement con grupos sellados;
- asignación y abandono de recovery;
- oferta de venta correlacionada;
- identificación, herrero y encantador;
- desmantelado y reemplazo de impronta con acknowledgements.

En conjunto aparecen las 13 variantes habilitadas con todos sus tokens. Los veintitrés negativos incluyen tokens `optionId`, `offerId` y `acknowledgementId` ausentes, elegibilidad ausente, opción de contrato ajena, binding expirado, préstamo ajeno, discriminante de acción incompatible con `execution`, oferta ligada a otro item, acknowledgement expirado, visitante de recovery ajeno, versión u opción de preview ajena, acción habilitada o deshabilitada en estado/contenedor imposible, entidades/opciones fuente duplicadas, oferta/grupo/acción duplicados y proyecciones divergentes o contradictorias. Los casos estructurales fallan en AJV; referencias, pertenencia, unicidad, ubicación y vigencia fallan en el validador semántico con código estable esperado.

Validación de publicación:

```text
AJV 8.17.1, draft 2020-12, strict=true
60/60 fixtures heredados válidos
8/8 snapshots integrados válidos
23/23 negativos rechazados con el motivo esperado
```

El validador se ejecuta con:

```bash
npm install --no-save --package-lock=false ajv@8.17.1 ajv-formats@3.0.1
node validate-v2-etapa0-3.mjs
```

### Criterios de implementación posteriores

- Generar tipos desde la unión cerrada; `switch(action)` debe ser exhaustivo y caer en `assertNever`.
- El mapper backend no puede emitir `enabled: true` hasta producir un `execution` íntegro y semánticamente válido para la misma revisión.
- Los contract tests deben ejecutar AJV y las invariantes sobre cada respuesta, no sólo validar DTOs aislados.
- Frontend debe construir comandos únicamente mediante adapters puros por variante y probar que campos económicos, IDs alternativos o tokens de otra acción no pueden entrar al payload.
- Mutaciones por eliminación de cada campo requerido y adición de campos desconocidos deben seguir fallando por `additionalProperties: false`.

Esta entrega no modifica endpoints, MongoDB, stores, componentes ni reglas de producto.
