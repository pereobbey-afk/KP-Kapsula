---
name: aframe
description: Build web-based 3D, VR, and AR experiences with A-Frame (aframevr/aframe), the HTML framework built on top of three.js. Use this skill whenever the user wants to create a VR/AR scene, a 3D web experience, a WebXR page, a 360° photo/video viewer, an interactive 3D product viewer, or anything involving `<a-scene>`, `<a-entity>`, A-Frame primitives, or custom A-Frame components — even if they don't say "A-Frame" by name but describe an immersive/3D scene that runs in the browser. Also use it when debugging A-Frame scenes, registering components, wiring up interaction (cursor/raycaster/controllers), loading glTF models, or optimizing performance.
---

# A-Frame

A-Frame is an HTML framework for building 3D/VR/AR experiences on the web. It's built on top of three.js and the DOM, using an **entity-component-system (ECS)** architecture. You declare scenes with custom HTML elements, and everything is inspectable and manipulable with normal DOM APIs.

**Current stable version: 1.8.0.** Always pin an explicit version in the CDN URL rather than using an unpinned/`latest` URL, so scenes don't break on a future release.

```html
<script src="https://aframe.io/releases/1.8.0/aframe.min.js"></script>
```

## Mental model (read this first — it's what people get wrong)

Everything in A-Frame is an **entity** (`<a-entity>`), and **components** are HTML attributes that attach appearance and behavior to it. A "primitive" like `<a-box>` is just an `<a-entity>` with some components preset for convenience. These two are equivalent:

```html
<a-box color="tomato" depth="2"></a-box>
<a-entity geometry="primitive: box; depth: 2" material="color: tomato"></a-entity>
```

Understanding this collapses the whole framework: if you know the component, you can set it on any entity, read it, and animate it. Don't reach for a special primitive when a component on an entity does the job — and don't hunt for a primitive that doesn't exist when the answer is "put the right component on an entity."

Component attribute values use a compact syntax: **`property: value; property: value`** (semicolon-separated, colon between key and value). Single-property components take a bare value (`position="0 1 -3"`).

## Minimal scene skeleton

Start every scene from this shape. The key gotchas are baked in: the camera sits at eye height and the first content is placed a few meters **in front** (negative Z) so it's actually visible, and lights are declared explicitly once you turn off defaults.

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <script src="https://aframe.io/releases/1.8.0/aframe.min.js"></script>
  </head>
  <body>
    <a-scene>
      <!-- Assets: preload here so they're ready before render -->
      <a-assets>
        <img id="sky" src="sky.jpg" />
      </a-assets>

      <a-sky src="#sky"></a-sky>

      <!-- Content lives in front of the default camera (negative Z) -->
      <a-box position="-1 1.5 -3" rotation="0 45 0" color="#4CC3D9"></a-box>
      <a-sphere position="0 1.25 -5" radius="1.25" color="#EF2D5E"></a-sphere>
      <a-cylinder position="1 0.75 -3" radius="0.5" height="1.5" color="#FFC65D"></a-cylinder>
      <a-plane position="0 0 -4" rotation="-90 0 0" width="4" height="4" color="#7BC8A4"></a-plane>

      <!-- Explicit camera + cursor for gaze interaction (optional) -->
      <a-entity camera look-controls wasd-controls position="0 1.6 0">
        <a-cursor></a-cursor>
      </a-entity>
    </a-scene>
  </body>
</html>
```

Units are **meters**, angles are **degrees**, the coordinate system is right-handed: **+X right, +Y up, +Z toward the viewer** (so things in front of the camera have negative Z). Human eye height is ~1.6m — position the camera there for a natural standing view.

## Core building blocks

For the full catalog with property tables, read `references/components.md`. The essentials:

- **Transform:** `position`, `rotation`, `scale` — on every entity.
- **Appearance:** `geometry` (box/sphere/cylinder/plane/cone/torus/…), `material` (color, opacity, shader, textures, `metalness`/`roughness` for PBR).
- **Primitives:** `<a-box>`, `<a-sphere>`, `<a-cylinder>`, `<a-plane>`, `<a-circle>`, `<a-cone>`, `<a-torus>`, `<a-ring>`, `<a-sky>`, `<a-text>`, `<a-image>`, `<a-video>`, `<a-videosphere>`, `<a-gltf-model>`, `<a-light>`, `<a-camera>`, `<a-sound>`, `<a-curvedimage>`.
- **Lighting:** `light` component (`type: ambient | directional | point | spot | hemisphere`). A-Frame adds default lights only until you add your own — once you declare any `<a-light>`, the defaults switch off, so add both a fill (ambient/hemisphere) and a key (directional/point) or your scene goes dark.
- **Camera & controls:** `camera`, `look-controls` (mouse/touch/headset), `wasd-controls` (desktop movement).
- **Interaction:** `cursor` + `raycaster` for gaze/click; `laser-controls`/`hand-controls`/`tracked-controls` for VR controllers.
- **Models:** `<a-gltf-model src="#model">` — glTF/GLB is the preferred format. Preload in `<a-assets>`.
- **Animation:** the `animation` component (see below).

## Assets and the asset management system

Declare images, videos, audio, and models inside `<a-assets>` and reference them by selector (`src="#id"`). This makes A-Frame **preload and cache** them before rendering, which prevents flickering and the "texture pops in late" problem. `<a-scene>` waits for assets before firing `loaded`.

```html
<a-assets timeout="10000">
  <img id="wood" src="wood.jpg" />
  <a-asset-item id="tree" src="tree.glb"></a-asset-item>
  <audio id="ambient" src="ambient.mp3"></audio>
</a-assets>
```

## Animation

Use the `animation` component. Multiple animations go on suffixed attributes (`animation__rotate`, `animation__scale`). Animate any component property via the `property` field.

```html
<a-box color="tomato"
  animation="property: rotation; to: 0 360 0; loop: true; dur: 4000; easing: linear"
  animation__pulse="property: scale; to: 1.2 1.2 1.2; dir: alternate; loop: true; dur: 800">
</a-box>
```

Common fields: `property`, `to`, `from`, `dur` (ms), `loop`, `dir` (normal/reverse/alternate), `easing`, `delay`, `startEvents` (trigger on a DOM event instead of on load).

## Writing custom components (the heart of ECS)

When built-in components don't cover the behavior, register your own. A component has a `schema` (its properties), lifecycle handlers, and access to the underlying three.js object via `this.el.object3D` and the raw three.js scene via `this.el.sceneEl.object3D`.

```html
<script>
AFRAME.registerComponent('spin', {
  schema: {
    speed: { type: 'number', default: 30 },   // degrees per second
    axis:  { type: 'vec3',   default: { x: 0, y: 1, z: 0 } }
  },
  init: function () {
    // Runs once. Set up state, bind event handlers here.
    this.el.addEventListener('click', () => { this.data.speed *= -1; });
  },
  tick: function (time, timeDelta) {
    // Runs every frame. Keep it cheap. timeDelta is ms since last frame.
    const rad = THREE.MathUtils.degToRad(this.data.speed * timeDelta / 1000);
    this.el.object3D.rotateOnAxis(
      new THREE.Vector3(this.data.axis.x, this.data.axis.y, this.data.axis.z).normalize(),
      rad
    );
  }
});
</script>

<a-box spin="speed: 45" position="0 1.5 -3" color="teal"></a-box>
```

Register **before** `<a-scene>` parses (put the script in `<head>`, or above the scene). Lifecycle: `init` → `update` (on any property change) → `tick` (per frame) → `remove`. For the full lifecycle, schema types, and `registerSystem` (for scene-wide/shared state), read `references/components.md`.

## Interaction: making things clickable

Gaze/click needs a `cursor` (on the camera for gaze, or as `cursor="rays: mouse"` for mouse) plus objects that are raycaster targets. Listen for `click`, `mouseenter`, `mouseleave`:

```html
<a-entity camera look-controls>
  <a-cursor></a-cursor>   <!-- fuse-based gaze cursor -->
</a-entity>

<a-box class="clickable" position="0 1.5 -3" color="tomato"
  animation__enter="property: material.color; type: color; to: yellow; startEvents: mouseenter; dur: 200"
  animation__leave="property: material.color; type: color; to: tomato; startEvents: mouseleave; dur: 200"></a-box>
```

To restrict what the cursor can hit, set `raycaster="objects: .clickable"` on the cursor entity. In VR, swap `<a-cursor>` for `laser-controls` on controller entities.

## Manipulating scenes from JavaScript

The scene is real DOM, so `querySelector` works — but **read and write components with `.getAttribute` / `.setAttribute`**, not by parsing the raw HTML string. For direct/fast transforms, go through three.js objects.

```js
const el = document.querySelector('#box');
el.setAttribute('material', 'color', 'blue');      // set one property
el.setAttribute('position', { x: 0, y: 2, z: -3 }); // set a whole component
el.object3D.position.y = 2;                          // fast path via three.js

// Wait for the scene before touching it:
document.querySelector('a-scene').addEventListener('loaded', () => { /* ready */ });
```

Create entities dynamically with `document.createElement('a-entity')`, set components, then `appendChild`.

## Performance and correctness checklist

Run through this before calling a scene done — these are the failure modes that actually bite:

- **Content off-camera.** New entities default to `0 0 0`, which is *inside* the camera. Place content in front (negative Z) and at a sensible height.
- **Black scene.** You added a light and lost the defaults. Add an ambient/hemisphere fill plus a key light.
- **Textures pop in / flicker.** Assets weren't preloaded — move them into `<a-assets>` and reference by `#id`.
- **`tick` doing heavy work.** It runs every frame (~60–90fps). Cache lookups in `init`, avoid allocating new `THREE.Vector3`/objects every tick, and prefer `object3D` writes over `setAttribute` in hot loops.
- **Too many draw calls.** Merge static geometry, reuse materials, keep polycount and texture sizes modest for mobile/standalone headsets (Quest).
- **VR not working / not appearing.** WebXR needs **HTTPS** (or `localhost`). Serve over a local dev server, not `file://` — many features (assets, XR) misbehave from the filesystem.
- **Model doesn't show.** Wrong scale (glTF in meters vs. huge/tiny export), missing textures, or not waiting for the `model-loaded` event before manipulating it.

## Debugging tools

- **Inspector:** press **`Ctrl + Alt + I`** in any scene to open the visual inspector (move/inspect entities live). Add `<a-scene inspector="url: ...">` only to pin a version.
- **Stats:** `<a-scene stats>` shows an FPS/draw-call/entity panel.
- Set `debug` on components you're writing to log lifecycle, and use the browser console — entities log warnings for unknown components and malformed values.

## Ecosystem components worth knowing

Common community add-ons (load their script after A-Frame): `aframe-environment-component` (instant skyboxes/terrain/lighting presets — great for prototyping), `aframe-physics-system` (`static-body`/`dynamic-body`), `aframe-extras` (controls, `nav-mesh`, model helpers), `aframe-particle-system-component`, and `networked-aframe` (multi-user). For AR, the built-in WebXR AR mode plus `<a-scene webxr>` config, or `mind-ar` / `AR.js` for marker/image tracking.

## References

- `references/components.md` — full component/primitive catalog, property tables, component/system lifecycle, schema property types, and registration patterns. Read it when you need exact property names/defaults or are writing non-trivial custom components/systems.
- `assets/starter.html` — a complete, runnable starter scene (interactive, lit, with a custom component and animation) to copy and adapt.
