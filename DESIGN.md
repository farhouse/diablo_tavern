---
name: Diablo Tavern
description: Campamento pixel-art oscuro, legible y orientado a decisiones.
colors:
  background: "#11100e"
  panel: "#1b1916"
  panel-raised: "#24211d"
  text: "#f1ece2"
  text-muted: "#a99f91"
  border: "#3a342d"
  action: "#a94327"
  gold: "#d8a849"
  success: "#51b36b"
  danger: "#d45b5b"
typography:
  display:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "clamp(1.4rem, 2.6vw, 2.6rem)"
    fontWeight: 700
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: ".72rem"
    fontWeight: 800
    letterSpacing: ".12em"
rounded:
  control: "6px"
  container: "8px"
spacing:
  xs: ".35rem"
  sm: ".5rem"
  md: ".75rem"
  lg: "1rem"
  xl: "1.25rem"
---

# Design System: Diablo Tavern

## Overview

**Creative North Star: "El campamento como tablero vivo"**

La portada de juego es una única ciudad-campamento operable, inspirada en la lectura espacial de *Heroes of Might and Magic*. El pixel-art existente es la autoridad visual: la interfaz debe revelar sus lugares y personajes, no cubrirlos con una grilla de paneles genéricos.

La atmósfera es sombría, cálida y deliberada. La fantasía acompaña decisiones claras; nunca oculta estado, consecuencias ni recuperación.

## Colors

Fondos carbón y tierra sostienen texto marfil; el dorado indica foco, jerarquía y valor. Rojo, verde y colores de rareza siempre necesitan texto, icono o etiqueta equivalente: el color no comunica estado por sí solo.

**The Sparse Gold Rule.** Reservá el dorado para títulos, valores importantes, bordes interactivos y foco; su escasez conserva la jerarquía.

## Typography

Georgia aporta voz fantástica sólo a títulos y nombres de lugares. Inter y sus fallbacks mantienen legibles recursos, estados, acciones y texto operativo. Las etiquetas compactas pueden usar mayúsculas y espaciado amplio, pero nunca el contenido descriptivo.

## Layout

En escritorio, el campamento conserva la proporción de su arte base (`1672 / 941`). Los edificios son zonas interactivas posicionadas en porcentajes sobre el mapa; cualquier cambio de arte debe recalibrar zonas y expansiones juntas para que la correspondencia espacial siga siendo exacta. El HUD ocupa la parte superior, la próxima acción permanece destacada y los héroes activos forman una franja inferior.

A `900px` o menos, el mapa completo mantiene la misma proporción y ubicación relativa de todos los edificios. HUD, recomendación y dock salen del overlay y pasan a bloques compactos en el flujo; el dock puede desplazarse horizontalmente. La simplificación móvil puede ocultar descripciones redundantes, nunca nombres de lugar, recursos críticos ni el CTA recomendado. A `560px` o menos se reduce densidad, no se reordena el mapa.

## Elevation & Depth

La profundidad combina capas oscuras translúcidas, bordes tierra y sombras amplias. El mapa permanece visualmente dominante; overlays y diálogos oscurecen lo necesario para legibilidad sin reemplazar la escena. Respetá `prefers-reduced-motion` y no hagas depender ninguna orientación de animaciones.

## Shapes

Controles y tarjetas usan curvas discretas; las superficies ligadas al mapa y los diálogos conservan marcos rectos, como placas sobre el campamento. Los objetivos de interacción tienen al menos `44px` de alto y un foco visible de `3px` con separación de `3px`.

## Components

### Lugares del campamento

Cada edificio es navegación contextual: zona completa clicable, nombre persistente y descripción secundaria. Hover y foco comparten borde dorado y realce interior. Caravana, Taberna, Herrería, Tasador y Mesa de campaña abren su contenido en el mismo marco modal sin abandonar el campamento. La próxima acción abre también su lugar correspondiente. En la portada, el mapa reemplaza la navegación superior entre secciones; las rutas completas siguen disponibles para accesos directos.

### Diálogos de servicio

Herrería y Tasador usan un `dialog` modal con fondo atenuado, encabezado fijo y cierre explícito. Al abrir, el foco entra al diálogo; Escape, botón y backdrop permiten cerrar; al cerrar, el foco vuelve al edificio que lo abrió. Confirmaciones internas atrapan el foco, anuncian consecuencias y dejan inerte el contenido subyacente.

El campamento sigue reconocible detrás del diálogo. Los servicios comparten marco y usan un recorte de su propio lugar en el encabezado. El inventario se presenta en filas separadas por líneas, con sprite, nombre, nivel, rareza textual y acciones de altura normal; no anidar tarjetas.

Caravana, Taberna, Equipo y Crónica reutilizan sus controles y estados publicados dentro de este marco. En el modal, sus filas y secciones se separan con líneas; no repetir el encabezado de página ni la decoración de tarjetas completas. La crónica carga sus eventos al abrirse. El contenido largo se desplaza dentro del diálogo y el cierre devuelve el foco al edificio o recomendación que lo abrió.

### Mesa de trato

El visitante conserva su sprite destacado, nombre y estado en el encabezado. La negociación separa las condiciones del contrato del equipo opcional en dos columnas; en móvil se apilan. Las condiciones vienen de la partida, no se calculan probabilidades ni recompensas inventadas. Sólo se agrupan copias identificadas con las mismas propiedades visibles; al expandirlas se elige cada objeto por separado. El cuerpo puede desplazarse, pero el conteo de préstamos, «Volver al campamento» y «Aceptar contrato» permanecen accesibles en el pie. La acción principal usa terracota, reservando dorado para foco y valores.

### Héroes

Los héroes visibles representan visitantes activos, no unidades contratables. Cada retrato combina sprite, nombre y estado textual, abre su flujo contextual en un diálogo sin abandonar el campamento y admite truncado seguro sin perder el nombre accesible.

### Estado y acciones

Carga usa `aria-busy`; errores usan `role="alert"`; cambios no críticos usan `role="status"` y `aria-live`. Una acción bloqueada expone su motivo y las consecuencias destructivas requieren confirmación explícita.

## Do's and Don'ts

### Do:

- **Do** reutilizá el pixel-art y sus proporciones como fuente de verdad visual.
- **Do** preservá teclado, foco visible, retorno de foco y anuncios semánticos en overlays.
- **Do** mantené visible una próxima acción concreta y su consecuencia.

### Don't:

- **Don't** conviertas la portada en dashboard, menú de tarjetas o lista de edificios.
- **Don't** reacomodes los edificios en móvil de forma que rompa su posición en el mapa.
- **Don't** abras Herrería o Tasador como navegación de página desde el campamento.
- **Don't** presentes héroes como propiedad o roster controlable del jugador.
