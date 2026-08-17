# A-Frame reference (v1.8.0)

Detailed catalog of primitives, components, systems, and the ECS API. Use this when you need exact property names, defaults, or lifecycle details.

## Table of contents
- [Primitives](#primitives)
- [Core components](#core-components)
- [Material and shading](#material-and-shading)
- [Lighting](#lighting)
- [Camera and controls](#camera-and-controls)
- [Cursor, raycaster, interaction](#cursor-raycaster-interaction)
- [Text](#text)
- [Sound](#sound)
- [Models](#models)
- [Animation component](#animation-component)
- [Component API (registerComponent)](#component-api)
- [System API (registerSystem)](#system-api)
- [Schema property types](#schema-property-types)
- [Events](#events)
- [three.js escape hatch](#threejs-escape-hatch)

---

## Primitives

Every primitive is `<a-entity>` with preset components. Common ones and their headline props:

| Primitive | Notable attributes |
|-----------|--------------------|
| `<a-box>` | `width` `height` `depth` `color` |
| `<a-sphere>` | `radius` `color` `segments-width` `segments-height` |
| `<a-cylinder>` | `radius` `height` `open-ended` `color` |
| `<a-cone>` | `radius-bottom` `radius-top` `height` |
| `<a-plane>` | `width` `height` `color` `src` |
| `<a-circle>` | `radius` `theta-start` `theta-length` |
| `<a-ring>` | `radius-inner` `radius-outer` |
| `<a-torus>` | `radius` `radius-tubular` `arc` |
| `<a-torus-knot>` | `radius` `radius-tubular` `p` `q` |
| `<a-dodecahedron>` / `<a-octahedron>` / `<a-tetrahedron>` / `<a-icosahedron>` | `radius` `detail` |
| `<a-triangle>` | `vertex-a` `vertex-b` `vertex-c` |
| `<a-sky>` | `color` or `src` (equirectangular 360 image); `radius` |
| `<a-videosphere>` | `src` (360 video) |
| `<a-image>` | `src` `width` `height` |
| `<a-video>` | `src` `width` `height` |
| `<a-curvedimage>` | `src` `radius` `theta-length` |
| `<a-text>` | `value` `color` `align` `width` |
| `<a-gltf-model>` | `src` (glTF/GLB) |
| `<a-obj-model>` | `src` (.obj) `mtl` |
| `<a-light>` | `type` `color` `intensity` |
| `<a-camera>` | `look-controls` `wasd-controls` presets |
| `<a-cursor>` | gaze cursor preset (fuse) |
| `<a-sound>` | `src` `autoplay` `loop` |
| `<a-link>` | `href` `title` — VR scene-to-scene portal |
| `<a-sky>`, `<a-assets>`, `<a-asset-item>` | scene infrastructure |

## Core components

**position** — `x y z` in meters. Default `0 0 0`.
**rotation** — `x y z` in degrees. Default `0 0 0`.
**scale** — `x y z` multiplier. Default `1 1 1`. Zero on any axis hides/flattens.
**visible** — `true|false`. Hidden entities skip render but stay in the DOM.

**geometry** — `primitive` selects shape; remaining props depend on primitive. Shared: `buffer` (true), `skipCache`. Example: `geometry="primitive: box; width: 2; height: 1; depth: 1"`.

## Material and shading

**material** properties (standard/PBR shader is default):
- `color` (base color), `opacity` (0–1), `transparent` (bool), `side` (`front|back|double`).
- `shader` — `standard` (PBR, default), `flat` (unlit, cheap, good for UI/text), `sdf`, or custom.
- PBR: `metalness` (0–1), `roughness` (0–1), `envMap`, `sphericalEnvMap`.
- Textures: `src` (map), `normalMap`, `displacementMap`, `roughnessMap`, `metalnessMap`, `aoMap`. `repeat="4 4"` tiles a texture.
- `wireframe`, `wireframe-linewidth`.
- Video/canvas textures: point `src` at a `<video>`/`<canvas>` selector.

Use `shader: flat` when you don't want lighting to affect a surface (labels, HUD, emissive-looking UI). Use PBR `metalness`/`roughness` for realistic materials, and provide an environment map for reflections.

## Lighting

**light** — `type`: `ambient` | `directional` | `point` | `spot` | `hemisphere`. Props: `color`, `intensity`, `castShadow` (directional/point/spot), plus `angle`/`penumbra`/`decay`/`distance` for spot/point, and `groundColor` for hemisphere.

Defaults: A-Frame injects a directional + ambient light **only when the scene has no user lights**. The moment you add one `<a-light>`/`light` component, defaults vanish — so add at least a fill (ambient or hemisphere) and a key (directional/point). For shadows: set `castShadow` on the light, `shadow="cast: true"` / `shadow="receive: true"` on entities, and `shadow` on `<a-scene>` for the renderer to enable them.

## Camera and controls

**camera** — `active`, `fov` (default 80), `near`, `far`, `zoom`. Usually paired with controls on the same entity.
**look-controls** — mouse-drag / touch / headset orientation. `pointerLockEnabled`, `reverseMouseDrag`, `magicWindowTrackingEnabled`.
**wasd-controls** — keyboard movement. `acceleration`, `fly` (bool, allow vertical), `wasdKeys`.
Put the rig at `position="0 1.6 0"` for standing eye height. For room-scale VR, wrap the camera in a rig entity and move the rig, not the camera.

## Cursor, raycaster, interaction

**cursor** — emits `click`/`mouseenter`/`mouseleave`/`mousedown`/`mouseup` on intersected entities. `rays`/`fuse` (gaze dwell), `fuseTimeout`, `downEvents`, `upEvents`. Put `cursor` + a small ring geometry as a child of the camera for gaze; use `cursor="rays: mouse"` for desktop mouse picking.
**raycaster** — `objects` (selector to limit targets, e.g. `.clickable`), `far`, `interval` (ms between casts; raise it to save CPU), `showLine`. Fires `raycaster-intersected` / `raycaster-intersected-cleared`.
**laser-controls** — controller-mounted laser pointer for VR (wraps `tracked-controls` + `raycaster`).
**hand-controls / tracked-controls / oculus-touch-controls / meta-touch-controls** — 6DoF controller models and input; listen for `triggerdown`, `gripdown`, `abuttondown`, etc.

## Text

**text** — SDF text without external fonts. Key props: `value`, `color`, `align` (`left|center|right`), `width` (wrapping width in meters), `wrapCount`, `baseline`, `anchor`, `font`, `shader` (default `sdf`). For crisp large text set an explicit `width` and `wrapCount`. `<a-text value="Hello" color="#FFF"></a-text>`.

## Sound

**sound** — `src`, `autoplay`, `loop`, `volume`, `positional` (3D spatialized, default true), `distanceModel`, `refDistance`, `maxDistance`, `on` (play on an event, e.g. `on: click`). Browsers block autoplay audio until a user gesture — start sound on a `click` or an enter-VR event.

## Models

**gltf-model** — `src` selector to an `<a-asset-item>` (glTF/GLB). Preferred format. Fires `model-loaded` on the entity; wait for it before scaling/traversing. `<a-gltf-model src="#tree"></a-gltf-model>`.
**obj-model** — `obj` + `mtl` selectors.
**animation-mixer** (from `aframe-extras`) — plays a glTF's built-in animation clips: `animation-mixer="clip: *; loop: repeat"`.

Model tips: glTF is authored in meters — if a model is huge or invisible, check `scale`. Draco/Meshopt-compressed glTF needs the corresponding loader; keep textures ≤2K for mobile.

## Animation component

`animation` (and suffixed `animation__name` for multiples). Fields:

| Field | Meaning |
|-------|---------|
| `property` | component/property to animate (e.g. `rotation`, `position`, `material.color`, `scale`) |
| `from` / `to` | start/end values (from defaults to current) |
| `dur` | duration ms (default 1000) |
| `delay` | ms before start |
| `loop` | `true` / number of repeats |
| `dir` | `normal` / `reverse` / `alternate` |
| `easing` | e.g. `linear`, `easeInOutQuad`, `easeOutElastic` |
| `startEvents` | comma-separated events that (re)start it, e.g. `mouseenter` |
| `pauseEvents` / `resumeEvents` | control playback |
| `autoplay` | default true |

Emits `animationbegin` / `animationcomplete` (and `animationcomplete__name`).

## Component API

`AFRAME.registerComponent(name, definition)`:

```js
AFRAME.registerComponent('foo', {
  schema: { /* properties -> this.data */ },
  multiple: false,        // true allows foo__a, foo__b on one entity
  dependencies: [],       // components initialized before this one

  init: function () {},               // once, on attach
  update: function (oldData) {},      // on init and whenever data changes
  tick: function (time, timeDelta) {},// every frame (omit if not needed)
  tock: function (time, timeDelta, camera) {}, // after render
  remove: function () {},             // on detach
  pause: function () {},              // scene/entity paused
  play: function () {}                // scene/entity resumed
});
```

- `this.el` — the entity element. `this.el.object3D` — its three.js `Group`. `this.el.sceneEl` — the scene. `this.data` — parsed schema values.
- Single-property component: give `schema` a bare type, e.g. `schema: { type: 'number', default: 1 }`, then `this.data` is that value directly.
- Prefer implementing `update` over doing setup work in `init` when the work should re-run on property changes.
- Remove `tick` entirely if the component isn't per-frame — every `tick` adds fixed per-frame cost.

## System API

`AFRAME.registerSystem(name, definition)` — scene-scoped singleton for shared state/services, accessible from components via `this.el.sceneEl.systems.<name>`. Same lifecycle handlers (`init`, `tick`, etc.) minus per-entity ones. Use a system when many components need to share data or coordinate (object pools, global config, spatial indexes) instead of duplicating state per component.

## Schema property types

`number`, `int`, `string`, `boolean`, `vec2`, `vec3`, `vec4`, `color`, `array` (comma-separated), `selector` (`document.querySelector` result), `selectorAll`, `asset` (URL or selector, resolves `#id`), `map`/`src` (asset URL), `audio`, `model`, `time` (ms). Each schema entry: `{ type, default, oneOf: [...] (enum), parse, stringify }`.

## Events

Scene: `loaded`, `renderstart`, `enter-vr`, `exit-vr`, `enter-ar`, `exit-ar`.
Entity/model: `componentinitialized`, `componentchanged`, `child-attached`, `model-loaded`, `model-error`.
Interaction: `click`, `mousedown`, `mouseup`, `mouseenter`, `mouseleave`, `raycaster-intersected`, `raycaster-intersected-cleared`, controller button events (`triggerdown`/`gripdown`/…).
Animation: `animationbegin`, `animationcomplete`.

Emit your own with `this.el.emit('eventName', detail, bubbles=true)`.

## three.js escape hatch

A-Frame is three.js underneath — drop down when you need something A-Frame doesn't expose:
- `el.object3D` — entity's `THREE.Object3D`/`Group`.
- `el.getObject3D('mesh')` — the mesh; `el.setObject3D(name, obj)` to attach custom three.js objects.
- `el.sceneEl.object3D` — the `THREE.Scene`; `el.sceneEl.renderer`, `el.sceneEl.camera`.
- `AFRAME.THREE` / global `THREE` — the bundled three.js. Match its version to the A-Frame release (1.8.0 bundles a specific three build) if you add three.js plugins.

Use this for custom geometry/shaders, post-processing, or integrating three.js libraries, while keeping scene structure declarative in HTML.
