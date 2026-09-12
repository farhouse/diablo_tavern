## Dirección validada

- Estética: **Supervivencia áspera**, fantasía oscura y cruda, pixel art original con referencias atmosféricas en Diablo II, Path of Exile, ZERO Sievert y Darkest Dungeon.
- Héroes: `46×70 px` nativos, vista 3/4 frontal, fondo transparente, píxel duro sin antialiasing.
- Paleta común: carbón, oliva sucio, óxido, marrones desaturados, hueso y acentos ámbar muy contenidos.
- Iluminación: cálida desde arriba a la izquierda, sombras profundas pero legibles.

## Kit de implementación v1

### Héroes

Archivos PNG RGBA individuales para Bárbaro, Hechicera, Paladín y Nigromante. Se usan en selección de clase, candidato seleccionado, roster y detalle de héroe.

### Equipamiento

`equipment-supervivencia-source-sheet.png` contiene ocho tipos en una grilla conceptual 4×2, en este orden:

1. Short Sword
2. Quilted Armor
3. Bone Helm
4. Leather Gloves
5. Heavy Boots
6. Ring
7. Amulet
8. Small Charm

La integración debe recortar cada celda y normalizarla como icono cuadrado transparente. Para el primer pase, mapear por `ItemType`; las variantes concretas pueden reutilizar el icono de su tipo. No agregar rareza dentro del PNG: representarla con el borde o estado de la UI.

### Tavern

`tavern-supervivencia-background.png` es un fondo 16:9 sin personajes ni texto. Debe funcionar como ambientación y no reemplazar el contenido ni reducir contraste. Aplicar overlay oscuro cuando sea necesario; en pantallas angostas priorizar un recorte centrado en el hogar y la mesa.

### Edificios mejorables

`caravan-buildings-supervivencia-source-sheet.png` contiene cinco estructuras en una fila, en este orden:

1. Wagons
2. Scout Table
3. Stash Wagon
4. Infirmary
5. Appraiser

La integración debe recortar cada estructura, mantener transparencia y asociarla por `CaravanUpgradeId`. El nivel sigue expresándose con texto/estado de UI; este set no incluye todavía variantes visuales por nivel.

## Criterios técnicos

- Renderizar pixel art con `image-rendering: pixelated` y escalado entero cuando el layout lo permita.
- Conservar relación de aspecto; nunca deformar los sprites.
- Incluir `alt` útil cuando la imagen transmite identidad y `alt=""` cuando es puramente decorativa.
- Mantener legibilidad, foco de teclado, estados disabled/loading/error y comportamiento responsive existentes.
- Evitar duplicar metadatos: centralizar las rutas por `HeroClass`, `ItemType` y `CaravanUpgradeId`.
- Verificar visualmente Tavern, Stash, Caravan y detalle de héroe en desktop y mobile.

## Fuera de alcance de v1

- Animaciones, sprites direccionales o estados de combate.
- Variantes gráficas por nivel de edificio.
- Un icono distinto para cada base, afijo o rareza de objeto.
- Rediseño completo de navegación o contratos de backend.
