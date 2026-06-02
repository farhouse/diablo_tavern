# Draft de Implementación V1 — Guild Manager ARPG

## Objetivo de la V1

Crear un prototipo jugable web donde el usuario pueda:

1. Crear una cuenta e iniciar sesión.
2. Tener una guild/taverna.
3. Contratar héroes.
4. Enviar héroes a quests.
5. Resolver quests mediante simulación automática.
6. Recibir loot.
7. Identificar ítems.
8. Equipar ítems a héroes.
9. Administrar stash e inventario limitado.

La V1 debe validar si el loop principal es divertido:

Contratar héroe → Mandarlo a quest → Recibir loot → Identificar → Equipar → Avanzar a quests más difíciles.

---

## Stack propuesto

### Frontend

* Nuxt 4
* TypeScript
* Pinia
* Nuxt UI
* Tailwind
* Drag & drop para inventario

### Backend

* Node.js
* Express o NestJS
* REST inicialmente
* MongoDB Atlas

### Auth

* Email/password
* JWT
* Refresh token simple
* Un savegame por usuario

---

## Modelo de datos inicial

### User

```ts
{
  _id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### SaveGame

Para la V1 conviene guardar casi todo junto.

```ts
{
  _id: string;
  userId: string;

  gold: number;

  heroes: Hero[];
  stash: Item[];
  questsProgress: QuestProgress[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

## Hero

```ts
{
  id: string;
  name: string;
  class: "barbarian" | "sorceress" | "paladin" | "necromancer";
  level: number;
  xp: number;

  baseStats: {
    strength: number;
    dexterity: number;
    vitality: number;
    energy: number;
  };

  derivedStats: {
    life: number;
    mana: number;
    attackPower: number;
    defense: number;
    fireResist: number;
    coldResist: number;
    lightningResist: number;
    poisonResist: number;
    magicFind: number;
  };

  equipment: {
    weapon?: Item;
    helmet?: Item;
    armor?: Item;
    gloves?: Item;
    boots?: Item;
    amulet?: Item;
    ring1?: Item;
    ring2?: Item;
  };

  status: "available" | "onQuest" | "injured";
}
```

---

## Item

```ts
{
  id: string;
  baseName: string;
  displayName: string;

  type: "weapon" | "armor" | "helmet" | "gloves" | "boots" | "ring" | "amulet" | "charm";
  rarity: "normal" | "magic" | "rare" | "unique";

  identified: boolean;

  width: number;
  height: number;

  requiredLevel: number;

  affixes: Affix[];

  value: number;
}
```

---

## Affix

```ts
{
  stat: "strength" | "dexterity" | "vitality" | "life" | "mana" | "fireResist" | "coldResist" | "lightningResist" | "poisonResist" | "magicFind" | "attackPower" | "defense";
  value: number;
}
```

---

## Quest

```ts
{
  id: string;
  name: string;
  act: number;
  difficulty: number;
  minLevel: number;

  requirements?: {
    completedQuestIds?: string[];
  };

  rewards: {
    xp: number;
    gold: number;
  };

  lootTableId: string;
}
```

---

## QuestRun

En V1 puede resolverse instantáneamente.

```ts
{
  id: string;
  questId: string;
  heroIds: string[];
  result: "success" | "failure";
  log: string[];
  loot: Item[];
  xpGained: number;
  goldGained: number;
  createdAt: Date;
}
```

---

## Mecánicas V1

### 1. Contratar héroe

El jugador puede contratar héroes básicos desde la taberna.

Ejemplo inicial:

* Barbarian
* Sorceress
* Paladin
* Necromancer

Cada clase tiene stats base distintos.

---

### 2. Enviar héroe a quest

El jugador elige:

* Quest
* Héroe o party
* Confirmar envío

La quest se resuelve con una fórmula simple.

```ts
heroPower = attackPower + defense + life * 0.2 + resistances * 0.5

successChance = heroPower / (heroPower + questDifficulty)
```

Se puede limitar entre 5% y 95%.

---

### 3. Resultado de quest

Si gana:

* Recibe XP
* Recibe oro
* Recibe loot
* Puede desbloquear siguiente quest

Si pierde:

* Recibe poca XP o nada
* Puede volver herido
* No trae loot o trae loot menor

---

### 4. Loot generator

Primera versión simple:

1. Elegir base item.
2. Elegir rarity.
3. Si es magic: 1-2 affixes.
4. Si es rare: 3-5 affixes.
5. Si es unique: ítem predefinido.

Los ítems vuelven sin identificar, salvo normales.

---

### 5. Identificación

El jugador paga oro para identificar.

Ejemplo:

* Magic item: 50 gold
* Rare item: 150 gold
* Unique item: 500 gold

Hasta identificarlo, sólo se ve:

```text
Unidentified Rare Ring
```

Después:

```text
Storm Loop
+12 Strength
+18 Fire Resist
+9% Magic Find
```

---

### 6. Inventario y stash

Para V1:

* Stash con grilla.
* Cada ítem tiene width/height.
* Charms ocupan espacio y dan bonus si están en el inventario activo.
* Si no entra el loot, queda pendiente para vender/elegir.

---

## Pantallas V1

### Login/Register

* Email
* Password
* Crear cuenta
* Iniciar sesión

### Tavern

* Ver héroes
* Contratar héroes
* Ver estado de cada héroe

### Hero Detail

* Stats
* Equipo
* Inventario personal
* Botón equipar/desequipar

### Quest Board

* Lista de quests
* Dificultad
* Recompensas estimadas
* Selección de héroes
* Botón “Send”

### Quest Result

* Resultado
* Log de combate
* XP ganada
* Oro ganado
* Loot encontrado

### Stash

* Grilla de ítems
* Identificar
* Vender
* Equipar
* Mover ítems

---

## Quests iniciales

### Act I Demo

1. Blood Moor
2. Den of Evil
3. Cold Plains
4. Burial Grounds
5. Forgotten Tower
6. Catacombs
7. Act Boss

La V1 termina cuando el jugador derrota al primer boss.

---

## Contenido mínimo

### Clases

* Barbarian: mucha vida y ataque físico.
* Sorceress: mucho daño, poca defensa.
* Paladin: defensa y resistencias.
* Necromancer: balanceado, bonus contra grupos.

### Ítems

* 10 armas
* 10 armaduras
* 5 helmets
* 5 gloves
* 5 boots
* 5 rings
* 5 amulets
* 5 charms
* 5 uniques

### Affixes

* Strength
* Dexterity
* Vitality
* Life
* Mana
* Attack Power
* Defense
* Fire Resist
* Cold Resist
* Lightning Resist
* Poison Resist
* Magic Find

---

## APIs iniciales

### Auth

```http
POST /auth/register
POST /auth/login
POST /auth/refresh
```

### Savegame

```http
GET /savegame
POST /savegame/reset
```

### Heroes

```http
POST /heroes/hire
POST /heroes/:heroId/equip
POST /heroes/:heroId/unequip
```

### Quests

```http
GET /quests
POST /quests/:questId/start
```

### Items

```http
POST /items/:itemId/identify
POST /items/:itemId/sell
POST /items/move
```

---

## Orden de desarrollo recomendado

### Semana 1 — Core sin UI compleja

* Auth básica.
* Crear savegame.
* Crear héroe inicial.
* Lista de quests.
* Simular quest.
* Generar loot textual.
* Guardar progreso.

Objetivo: jugar el loop desde una UI simple.

---

### Semana 2 — Ítems y equipamiento

* Sistema de affixes.
* Identificación.
* Equipamiento.
* Recalcular stats.
* Comparación de ítems.

Objetivo: que decidir qué equipar sea interesante.

---

### Semana 3 — Inventario tipo Diablo

* Grilla de stash.
* Tamaño de ítems.
* Drag & drop.
* Charms.
* Vender ítems.
* Loot pendiente si no hay espacio.

Objetivo: que el espacio empiece a ser una decisión real.

---

### Semana 4 — Act I demo

* 7 quests.
* Primer boss.
* Balance básico.
* Logs de combate.
* Mejorar UI.
* Testing con amigos.

Objetivo: saber si alguien juega 30 minutos y quiere seguir.

---

## Criterio de éxito de la V1

La V1 funciona si el jugador piensa:

“Una quest más.”

Y si aparecen decisiones reales como:

* ¿Identifico este rare o vendo?
* ¿Le doy este ring al paladín o a la sorceress?
* ¿Guardo este charm aunque me ocupe espacio?
* ¿Farmeo una quest anterior o arriesgo la siguiente?
* ¿Contrato otro héroe o invierto en identificar loot?

---

## Lo que queda fuera de V1

* Multiplayer.
* Trading entre jugadores.
* Economía online.
* Animaciones de combate.
* 3D.
* Mapa explorable.
* Crafting complejo.
* Árbol de skills profundo.
* Temporadas.
* PvP.
* Marketplace.
* Mobile.
* Steam/Tauri.

---

## Decisión técnica clave

La V1 debe ser web-first.

No se busca todavía hacer “un videojuego terminado”, sino validar un sistema jugable.

Si el loop funciona, después se puede decidir:

1. Seguir como web game.
2. Empaquetar con Tauri para PC.
3. Migrar a Godot si hace falta una experiencia más visual.

