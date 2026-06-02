# Implementacion V2 - Caravana de Act I

## Estado

**Pendiente.** Esta es la proxima version despues del MVP de expediciones.

## Objetivo

Construir una V2 beta jugable para probar con amigos: unas 12 horas de progreso dentro de Act I, con mas profundidad en items/builds, eventos narrativos y progresion de base.

La base sera una **caravana oscura**. El jugador empieza con una caravana chica y va mejorandola con oro + materiales para manejar mas heroes, lanzar mas expediciones, ampliar stash y desbloquear servicios.

## Loop principal

```text
contratar heroes
-> enviar expediciones
-> volver con oro/materiales/items
-> identificar/equipar/vender
-> mejorar caravana
-> manejar mas heroes y expediciones
-> preparar boss final de Act I
```

## Alcance V2

### Incluido

- Progresion de caravana.
- Capacidad inicial de 3 heroes.
- Mejoras para subir capacidad de heroes.
- Mejoras para subir expediciones simultaneas.
- Mejoras para subir stash.
- Infirmary como servicio de recuperacion.
- Appraiser/Sage para identificar items gratis con tiempo.
- Materiales como nuevo recurso de upgrade.
- Mas items, affixes y uniques orientados a builds.
- Eventos narrativos con consecuencias mecanicas.
- Invite code para beta privada.
- Docker productivo y README actualizado.

### No incluido

- Nuevos actos.
- Multiplayer en tiempo real.
- Trading entre jugadores.
- Admin panel completo.
- Crafting avanzado.
- Grilla tipo Diablo para stash.

## Modelo de datos

### SaveGame

Agregar:

```ts
interface SaveGame {
  materials: number;
  caravan: CaravanState;
}
```

Mantener compatibilidad con saves viejos desde `normalizeSaveGame`.

### CaravanState

```ts
interface CaravanState {
  level: number;
  upgrades: Record<CaravanUpgradeId, number>;
  services: {
    appraiserQueue: AppraisalJob[];
  };
}
```

### CaravanUpgradeId

```ts
type CaravanUpgradeId =
  | "wagons"
  | "scoutTable"
  | "stashWagon"
  | "infirmary"
  | "appraiser";
```

### AppraisalJob

```ts
interface AppraisalJob {
  id: string;
  itemId: string;
  startedAt: string;
  finishesAt: string;
}
```

## Reglas de caravana

### Valores iniciales

```ts
materials = 0
heroCapacity = 3
expeditionCapacity = 1
stashLimit = 20
appraiserQueueCapacity = 0
```

El `stashLimit` actual de 30 debe migrarse al valor calculado por caravana o conservarse si el save viejo ya tiene mas espacio. Para saves nuevos, usar 20.

### Capacidades por upgrade

#### Wagons

Controla cantidad maxima de heroes.

```ts
level 0: 3 heroes
level 1: 5 heroes
level 2: 8 heroes
level 3: 12 heroes
```

#### Scout Table

Controla expediciones simultaneas.

```ts
level 0: 1 expedition
level 1: 2 expeditions
level 2: 3 expeditions
level 3: 4 expeditions
```

#### Stash Wagon

Controla stash.

```ts
level 0: 20 slots
level 1: 30 slots
level 2: 45 slots
level 3: 60 slots
```

#### Infirmary

Controla recuperacion.

```ts
level 0: recover instantaneo como hoy
level 1: reduce costo futuro o baja injury risk
level 2: baja mas injury risk
level 3: baja death chance en expediciones
```

Para V2, si recovery sigue gratis, usar infirmary para reducir chance de injury/death al resolver expediciones.

#### Appraiser

Identifica items gratis con tiempo.

```ts
level 0: sin appraiser
level 1: 1 item en cola
level 2: 2 items en cola
level 3: 3 items en cola
```

Duraciones iniciales:

```ts
magic: 5 min
rare: 15 min
unique: 30 min
normal: instantaneo/no requiere
```

## Costos de upgrades

Usar oro + materiales.

```ts
wagons lvl 1: 600 gold, 20 materials
wagons lvl 2: 1800 gold, 70 materials
wagons lvl 3: 4200 gold, 180 materials

scoutTable lvl 1: 800 gold, 30 materials
scoutTable lvl 2: 2400 gold, 90 materials
scoutTable lvl 3: 5200 gold, 220 materials

stashWagon lvl 1: 500 gold, 15 materials
stashWagon lvl 2: 1600 gold, 60 materials
stashWagon lvl 3: 3600 gold, 150 materials

infirmary lvl 1: 700 gold, 25 materials
infirmary lvl 2: 2200 gold, 80 materials
infirmary lvl 3: 4800 gold, 200 materials

appraiser lvl 1: 900 gold, 35 materials
appraiser lvl 2: 2600 gold, 100 materials
appraiser lvl 3: 5600 gold, 240 materials
```

Estos valores son balance inicial y deben ajustarse despues de playtest.

## Materiales

Agregar `materialsFound?: number` a `ExpeditionEvent`.

Eventos que pueden dar materiales:

- treasure.
- champion.
- evilHero.
- bossClue.
- boss.
- eventos narrativos especiales.

Al hacer recall, `carriedMaterials` se suma a `save.materials`.

Agregar `carriedMaterials` a `ActiveExpedition` y `materials` a `ExpeditionSummary`.

## Expediciones y capacidades

`startExpedition` debe validar:

```ts
save.activeExpeditions.length < getExpeditionCapacity(save)
```

`hire` debe validar:

```ts
save.heroes.length < getHeroCapacity(save)
```

La UI debe mostrar:

```text
Heroes: 2 / 3
Expeditions: 1 / 1
Stash: 12 / 20
```

## APIs nuevas

### Mejorar caravana

```http
POST /api/caravan/upgrade
```

Body:

```ts
{
  upgradeId: CaravanUpgradeId;
}
```

Response:

```ts
SaveGame
```

Reglas:

- Solo puede subir un nivel por request.
- Validar recursos.
- Validar max level.
- Descontar oro/materiales.
- Recalcular capacidades derivadas.

### Encolar identificacion

```http
POST /api/appraiser/start
```

Body:

```ts
{
  itemId: string;
}
```

Response:

```ts
SaveGame
```

Reglas:

- Requiere appraiser level >= 1.
- Item debe estar en stash.
- Item no debe estar identificado.
- Item no debe estar ya en cola.
- Cola no debe estar llena.
- Setear `finishesAt` segun rareza y nivel de appraiser.

### Completar identificaciones listas

```http
POST /api/appraiser/complete
```

Response:

```ts
SaveGame
```

Reglas:

- Identifica todos los jobs con `finishesAt <= now`.
- Remueve jobs completados.
- No cobra oro.

La UI puede llamar este endpoint al cargar Stash/Caravan y con polling suave si hay jobs activos.

## UI nueva

### Topbar

Agregar indicadores:

- gold.
- materials.
- heroes usados/capacidad.
- expediciones usadas/capacidad.

### Pagina Caravan

Nueva ruta:

```text
/caravan
```

Contenido:

- resumen de caravana.
- cards de upgrades.
- costo del proximo nivel.
- beneficio actual y siguiente.
- boton upgrade.
- servicios desbloqueados.
- cola de appraiser.

Agregar link `Caravan` al topbar.

### Tavern

Cambios:

- mostrar `Roster X / capacity`.
- usar capacidad desde caravana en vez de limite hardcodeado 8.
- si esta lleno, mostrar CTA a mejorar Wagons.

### Quests

Cambios:

- mostrar `Active expeditions X / capacity`.
- si esta lleno, bloquear start y mostrar CTA a mejorar Scout Table.
- mostrar `carriedMaterials` en cada expedicion.

### Stash

Cambios:

- mostrar stash capacity desde caravana.
- para item no identificado:
  - boton `Identify now` con oro.
  - si appraiser desbloqueado, boton `Send to appraiser`.
  - si esta en cola, mostrar tiempo restante.

## Eventos narrativos V2

Agregar tipos o subtipos de evento:

```ts
type ExpeditionEventType =
  | actuales
  | "altar"
  | "merchant"
  | "traveler"
  | "cursedShrine"
  | "miniBoss";
```

Para V2 inicial, no hace falta que todos tengan choices. Primero agregar eventos automaticos con texto y consecuencias.

Choices quedan como fase siguiente dentro de V2:

```ts
interface ExpeditionChoice {
  id: string;
  label: string;
  description: string;
  effect: ExpeditionChoiceEffect;
}
```

## Items/builds V2

Agregar contenido data-driven en `utils/game-data.ts`:

- mas bases por slot.
- mas uniques.
- affixes enfocados en:
  - tank.
  - damage.
  - magic find.
  - sustain.
  - resistencias.

No cambiar schema de items salvo que sea necesario. Para V2 inicial, los builds pueden emerger de affixes existentes y nuevos affixes.

## Auth beta

Agregar invite code al registro:

```ts
runtimeConfig.inviteCode = process.env.INVITE_CODE
```

`POST /api/auth/register` debe requerir:

```ts
{
  email: string;
  password: string;
  inviteCode: string;
}
```

Si falta o no coincide:

```http
403 Invalid invite code
```

Actualizar login/register UI.

## Deploy beta

Actualizar Dockerfile para produccion:

1. instalar deps.
2. build.
3. correr `.output/server/index.mjs`.

Mantener docker-compose dev o crear:

```text
docker-compose.yml
docker-compose.prod.yml
```

Variables requeridas:

```env
MONGO_URI=
MONGO_DB_NAME=
JWT_SECRET=
INVITE_CODE=
```

README debe documentar:

- setup local.
- deploy beta con Docker.
- backup basico de Mongo.
- reset/wipe permitido en beta.

## Fases de implementacion

### Fase 1 - Caravana base

- Tipos de caravan/materials.
- `normalizeSaveGame`.
- capacidades derivadas.
- upgrade logic.
- endpoint `/api/caravan/upgrade`.
- pagina `/caravan`.
- topbar con materials/capacidades.
- Tavern y Quests usando capacidades.

### Fase 2 - Materiales y balance de expediciones

- `carriedMaterials`.
- `materialsFound`.
- eventos que dan materiales.
- recall transfiere materiales.
- tests de materiales.
- balance inicial de costs/rewards.

### Fase 3 - Appraiser e Infirmary

- cola de appraiser.
- endpoints start/complete.
- UI en Stash/Caravan.
- infirmary reduce injury/death risk.
- tests de servicios.

### Fase 4 - Items/builds y eventos narrativos

- nuevas bases.
- nuevos affixes.
- nuevos uniques.
- eventos narrativos automaticos.
- mejoras de UI para comparar equipo.

### Fase 5 - Beta privada/deploy

- invite code.
- Docker prod.
- README.
- esconder/proteger reset save.
- smoke test final.

## Tests requeridos

- Save nuevo arranca con 3 heroes max, 1 expedicion max, 20 stash slots.
- Save viejo se normaliza con caravan/materials.
- Hire respeta `heroCapacity`.
- Start expedition respeta `expeditionCapacity`.
- Upgrade falla si faltan recursos.
- Upgrade descuenta recursos y sube capacidad.
- Materials se cargan durante expedicion y se transfieren en recall.
- Appraiser no acepta item identificado.
- Appraiser no acepta item duplicado en cola.
- Appraiser completa jobs vencidos.
- Invite code requerido para registro.

## Criterio de aceptacion

La V2 esta lista para beta de amigos cuando:

- Un jugador nuevo entiende el objetivo de mejorar la caravana.
- La caravana limita y desbloquea roster/expediciones/stash.
- Expediciones dan materiales ademas de oro/xp/items.
- Hay al menos 5 upgrades utiles.
- Appraiser permite identificar gratis con tiempo.
- Infirmary tiene impacto real en supervivencia o recuperacion.
- Hay mas variedad de items/builds que en el MVP.
- Registro requiere invite code.
- Docker prod levanta app + Mongo con datos persistentes.
- `pnpm typecheck`, `pnpm test` y `pnpm build` pasan.
