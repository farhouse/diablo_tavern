# Implementacion V2 - Expediciones Vivas

## Estado

**Completado.** Este plan ya fue implementado como MVP de expediciones vivas:

- Expediciones activas con eventos por tiempo.
- Recall manual con recompensas cargadas.
- Loot/oro/XP acumulados durante la exploracion.
- Estados de heroes durante expedicion.
- Boss readiness y boss encounter.
- Soporte para multiples expediciones activas.
- Historial de expediciones.

La siguiente etapa esta documentada en `implementation-v2-caravan.md`.

## Objetivo

Reemplazar el flujo actual de quest con timer fijo por una expedicion activa estilo Fallout Shelter:

Enviar heroe -> explorar en tiempo real -> generar eventos automaticos -> acumular loot/oro/xp -> decidir recall o seguir arriesgando -> eventualmente enfrentar boss.

El objetivo es que la decision principal sea cuanto tiempo arriesgar al heroe fuera de la guild.

## Estado actual

Hoy el juego tiene:

- `SaveGame.activeQuestRun` con `startedAt` y `finishesAt`.
- Un solo run activo por usuario.
- Héroes con estado `available`, `onQuest` o `injured`.
- `POST /api/quests/:questId/start` para iniciar.
- `POST /api/quests/complete` para reclamar al terminar.
- Resolucion final que entrega XP, gold y loot al stash.

La V2 debe conservar la idea de un solo run activo, pero cambiar la resolucion de "esperar y reclamar" a "explorar y avanzar por eventos".

## Modelo de datos propuesto

### ActiveExpedition

Reemplaza o extiende `ActiveQuestRun`.

```ts
interface ActiveExpedition {
  id: string;
  questId: string;
  heroIds: string[];

  status: "exploring" | "bossReady" | "returning";

  startedAt: string;
  lastEventAt: string;
  nextEventAt: string;

  depth: number;
  danger: number;

  partyState: ExpeditionHeroState[];

  events: ExpeditionEvent[];

  carriedLoot: Item[];
  carriedGold: number;
  carriedXp: number;

  bossReady: boolean;
  bossDefeated: boolean;
}
```

### ExpeditionHeroState

```ts
interface ExpeditionHeroState {
  heroId: string;
  temporaryHp: number;
  maxTemporaryHp: number;
  dead: boolean;
}
```

`temporaryHp` se calcula al salir usando `hero.derivedStats.life`. No reemplaza la vida real persistente del heroe; es estado de la expedicion.

### ExpeditionEvent

```ts
interface ExpeditionEvent {
  id: string;
  type:
    | "enemy"
    | "champion"
    | "evilHero"
    | "treasure"
    | "trap"
    | "rest"
    | "bossClue"
    | "boss"
    | "death"
    | "return";

  createdAt: string;
  title: string;
  description: string;

  damageTaken?: number;
  xpGained?: number;
  goldFound?: number;
  lootFound?: Item[];
  depthGained?: number;
}
```

### SaveGame

```ts
interface SaveGame {
  activeExpedition?: ActiveExpedition;
  lastExpeditionRun?: ExpeditionSummary;
}
```

Durante la migracion se puede mantener `activeQuestRun`/`lastQuestRun` temporalmente, pero la UI nueva debe leer `activeExpedition`.

## Reglas de expedicion

### Inicio

Al iniciar una expedicion:

1. Validar que no haya otra expedicion activa.
2. Validar quest desbloqueada.
3. Validar heroes disponibles.
4. Validar `minLevel`.
5. Marcar heroes como `onQuest`.
6. Crear `ActiveExpedition`.
7. Setear `nextEventAt` a `now + eventInterval`.

Para dev:

```ts
eventInterval = 5_000 // 5 segundos
```

Luego puede escalarse a 30-90 segundos.

### Avance

Cada vez que el cliente hace polling o el jugador abre Quest Board:

1. Cargar save.
2. Si hay `activeExpedition`, calcular cuantos eventos vencieron entre `lastEventAt` y `now`.
3. Generar hasta un maximo de eventos por request para evitar bursts enormes.
4. Actualizar `lastEventAt`, `nextEventAt`, `depth`, `danger`, recompensas y HP temporal.
5. Persistir save.

Limite recomendado:

```ts
maxEventsPerAdvance = 5
```

### Tipos de eventos

#### Enemy

Evento comun. Da XP baja/media, puede dar oro bajo, causa dano moderado.

#### Champion

Evento raro. Mas dano, mas XP, mejor chance de loot.

#### Evil Hero

Evento raro. Pelea peligrosa contra un enemigo elite. Debe tener mas chance de item magic/rare.

#### Treasure

No causa dano. Da oro o loot.

#### Trap

Causa dano y no da recompensa.

#### Rest

Recupera parte de `temporaryHp`.

#### Boss Clue

Aumenta progreso hacia boss.

#### Boss

Solo puede ocurrir si:

- `depth` suficiente.
- quest/acto lo permite.
- al menos un heroe cumple nivel recomendado.

Para Act I V2:

```ts
bossRequiredLevel = 10
bossRequiredDepth = 100
```

### Recall manual

El jugador puede hacer recall en cualquier momento.

Al hacer recall:

1. Avanzar eventos pendientes hasta `now`.
2. Resolver retorno.
3. Mover `carriedGold` al save.
4. Mover `carriedLoot` al stash o `pendingLoot`.
5. Aplicar `carriedXp` a heroes vivos.
6. Marcar heroes como `available`, `injured` o `dead`.
7. Limpiar `activeExpedition`.
8. Guardar `lastExpeditionRun`.

### Derrota y muerte

Si `temporaryHp <= 0`:

1. El heroe cae durante la expedicion.
2. Tirar chance de muerte.
3. Si no muere, vuelve `injured`.
4. Si muere, marcarlo como muerto o removerlo del roster segun decision de implementacion.

Para V2:

```ts
deathChance = 0.08 // 8% cuando cae a 0 HP
```

Si hay muerte, registrar evento `death`.

Para evitar castigo excesivo, si todos caen:

- terminar expedicion automaticamente.
- perder 50% de oro cargado.
- perder 50% del loot cargado.
- aplicar XP parcial.

## APIs

### Iniciar expedicion

```http
POST /api/expeditions/start
```

Body:

```ts
{
  questId: string;
  heroIds: string[];
}
```

Response:

```ts
SaveGame
```

### Avanzar expedicion

```http
POST /api/expeditions/advance
```

No requiere body.

Response:

```ts
SaveGame
```

Debe ser idempotente para un mismo intervalo: no debe generar eventos duplicados si se llama muchas veces antes de `nextEventAt`.

### Recall

```http
POST /api/expeditions/recall
```

No requiere body.

Response:

```ts
SaveGame
```

### Compatibilidad

Se pueden mantener temporalmente:

```http
POST /api/quests/:questId/start
POST /api/quests/complete
```

Pero la UI nueva debe usar `/api/expeditions/*`.

## UI

### Quest Board

Cuando no hay expedicion activa:

- mostrar zonas/quests disponibles.
- seleccionar heroes.
- mostrar nivel recomendado y peligro.
- boton `Send Expedition`.

Cuando hay expedicion activa:

- mostrar zona actual.
- tiempo explorando.
- depth/progreso.
- danger.
- HP temporal por heroe.
- carried gold/xp.
- carried loot.
- event log en vivo.
- boton `Recall`.
- indicador de boss:
  - locked.
  - clues found.
  - boss ready.
  - boss defeated.

### Event Log

Cada evento debe verse como una entrada compacta:

```text
00:35 - The party found a cracked chest. +42 gold.
00:50 - Champion Fallen attacked. -18 HP, +30 XP.
01:10 - A rare ring was found.
```

### Recall Summary

Al volver:

- resultado: success/retreated/defeated/death.
- XP ganada.
- oro ganado.
- loot traido.
- loot perdido si aplica.
- estado final de heroes.

## Implementacion sugerida

### 1. Tipos

Actualizar `types/game.ts` con:

- `ActiveExpedition`.
- `ExpeditionHeroState`.
- `ExpeditionEvent`.
- `ExpeditionSummary`.

Marcar `activeQuestRun` como legacy o reemplazarlo.

### 2. Logica pura

En `utils/game-logic.ts`, agregar:

- `startExpedition(save, questId, heroIds, now)`.
- `advanceExpedition(save, now)`.
- `recallExpedition(save, now)`.
- `generateExpeditionEvent(expedition, save, quest, now)`.
- `resolveCombatEvent(...)`.
- `applyExpeditionRewards(...)`.

Mantener funciones existentes de loot y stats.

### 3. API

Agregar:

- `server/api/expeditions/start.post.ts`
- `server/api/expeditions/advance.post.ts`
- `server/api/expeditions/recall.post.ts`

Cada endpoint debe:

1. autenticar usuario.
2. cargar save.
3. ejecutar logica pura.
4. persistir save.
5. devolver save.

### 4. Store

En `stores/game.ts`, agregar:

- `startExpedition(questId, heroIds)`.
- `advanceExpedition()`.
- `recallExpedition()`.

La UI debe hacer polling suave mientras haya expedicion activa:

```ts
setInterval(() => game.advanceExpedition(), 3000)
```

### 5. UI

Refactor de `pages/quests.vue`:

- estado sin expedicion.
- estado con expedicion.
- event log.
- carried rewards.
- recall.
- boss state.

## Balance inicial

Valores para dev/test:

```ts
eventIntervalMs = 5_000
maxEventsPerAdvance = 5
bossRequiredDepth = 100
bossRequiredLevel = 10
deathChanceOnDowned = 0.08
defeatGoldLossPercent = 0.5
defeatLootLossPercent = 0.5
```

Eventos:

```ts
enemy: 45%
treasure: 20%
trap: 12%
rest: 8%
champion: 7%
evilHero: 4%
bossClue: 4%
```

Al subir `depth`, aumentar champion/evilHero/trap y mejorar loot.

## Tests

### Unit tests

- iniciar expedicion marca heroes `onQuest`.
- no permite dos expediciones activas.
- `advanceExpedition` no genera evento antes de `nextEventAt`.
- `advanceExpedition` genera eventos vencidos.
- eventos de combate reducen HP temporal.
- treasure agrega gold/loot cargado.
- recall transfiere recompensas al save.
- derrota reduce recompensas.
- muerte solo puede ocurrir si HP temporal llega a 0.
- boss no aparece antes de level/depth requerido.

### API tests/manual smoke

1. Crear usuario.
2. Contratar heroe.
3. Iniciar expedicion.
4. Esperar 5-10 segundos.
5. Llamar advance.
6. Ver evento nuevo.
7. Recall.
8. Confirmar oro/xp/loot transferidos.

## Criterio de aceptacion

La V2 esta lista cuando:

- El jugador puede mandar un heroe a explorar y ver eventos aparecer con el tiempo.
- Puede hacer recall cuando quiera.
- Seguir explorando aumenta recompensa y riesgo.
- El loot no entra al stash hasta volver.
- Los heroes pueden volver disponibles, heridos o muertos.
- Hay progreso hacia un boss de Act I que requiere mas tiempo y nivel alto.
