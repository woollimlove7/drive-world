import * as THREE from "three";

// ---------------------------------------------------------------------------
// NameLabel
// ---------------------------------------------------------------------------
// A lightweight, camera-facing name tag rendered as a single textured plane.
//
// The canvas width is dynamically calculated from the actual text width so
// long names are never clipped.
//
// Textures are cached module-wide so identical names only require one canvas
// render.
// ---------------------------------------------------------------------------

const textureCache = new Map();

function getTextureForName(text) {
  if (textureCache.has(text)) return textureCache.get(text);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // -------------------------------------------------------------------------
  // Text settings
  // -------------------------------------------------------------------------
  const fontSize = 52;
  const font = `bold ${fontSize}px sans-serif`;

  ctx.font = font;

  // Measure the actual width of the name.
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);

  // Padding prevents the outline from touching/cutting into the canvas.
  const horizontalPadding = 32;
  const verticalPadding = 20;

  // Minimum width keeps short names looking consistent.
  const minWidth = 160;

  canvas.width = Math.max(
    minWidth,
    textWidth + horizontalPadding
  );

  canvas.height = fontSize + verticalPadding;

  // Canvas resizing resets the drawing state, so set the font again.
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // -------------------------------------------------------------------------
  // Draw text
  // -------------------------------------------------------------------------
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Dark outline for readability.
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.strokeText(
    text,
    canvas.width / 2,
    canvas.height / 2
  );

  // Main text.
  ctx.fillStyle = "#ff5a3c";
  ctx.fillText(
    text,
    canvas.width / 2,
    canvas.height / 2
  );

  // -------------------------------------------------------------------------
  // THREE.js texture
  // -------------------------------------------------------------------------
  const texture = new THREE.CanvasTexture(canvas);

  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  textureCache.set(text, texture);

  return texture;
}

let sharedGeometry = null;

function getSharedGeometry() {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.PlaneGeometry(1, 1);
  }

  return sharedGeometry;
}

export class NameLabel {
  constructor(scene, text, { width = 2.2, yOffset = 1.6 } = {}) {
    this.scene = scene;
    this.disposed = false;
    this.yOffset = yOffset;

    const texture = getTextureForName(text);

    // Because the canvas is dynamically sized, the aspect ratio now
    // automatically matches short and long names.
    const aspect =
      texture.image.width / texture.image.height;

    const height = width / aspect;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });

    this.mesh = new THREE.Mesh(
      getSharedGeometry(),
      material
    );

    this.mesh.scale.set(
      width,
      height,
      1
    );

    this.mesh.renderOrder = 15;
    this.mesh.visible = true;

    scene.add(this.mesh);
  }

  updateTransform(anchorWorldPos, camera) {
    if (this.disposed) return;

    this.mesh.position.set(
      anchorWorldPos.x,
      anchorWorldPos.y + this.yOffset,
      anchorWorldPos.z
    );

    if (camera) {
      this.mesh.quaternion.copy(camera.quaternion);
    }
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  dispose() {
    if (this.disposed) return;

    this.disposed = true;

    this.scene.remove(this.mesh);

    this.mesh.material.dispose();
  }
}