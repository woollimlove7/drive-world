import * as THREE from "three";

// Presentation-only limits (server caps at 200 chars).
const MAX_CHARS = 140;
const MAX_LINES = 4;

const FONT_PX = 34;
const LINE_HEIGHT_PX = 40;
const PAD_X_PX = 26;
const PAD_TOP_PX = 22;
const PAD_BOTTOM_PX = 22;
const TAIL_PX = 116;
const MIN_TEXT_WIDTH_PX = 60;
const MAX_TEXT_WIDTH_PX = 420;

// Matches the pixel-to-world-unit density used elsewhere.
const PX_PER_UNIT = 512 / 2.8;

const HOLD_MS = 5000;
const FADE_MS = 220;

function wrapAll(context, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  const pushHardBreak = word => {
    let broken = "";

    for (const char of word) {
      const attempt = broken + char;

      if (broken && context.measureText(attempt).width > maxWidth) {
        lines.push(broken);
        broken = char;
      } else {
        broken = attempt;
      }
    }

    return broken;
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;

    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }

    if (!line) {
      line = pushHardBreak(word);
      continue;
    }

    lines.push(line);
    line =
      context.measureText(word).width <= maxWidth ? word : pushHardBreak(word);
  }

  if (line) lines.push(line);

  return lines;
}

function truncate(context, lines, maxLines, maxWidth) {
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];

  while (last.length > 0 && context.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1);
  }

  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

export class ChatBubble {
  constructor(parent, anchorY) {
    this.parent = parent;
    this.anchorY = anchorY;

    this.canvas = document.createElement("canvas");
    this.canvas.width = 4;
    this.canvas.height = 4;

    this.context = this.canvas.getContext("2d");

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    // IMPORTANT: avoid stale mip levels / Chrome copy-subtexture errors when resizing.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      opacity: 0
    });

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.visible = false;
    this.sprite.renderOrder = 10;

    parent.add(this.sprite);

    this.state = "hidden";
    this.fadeInStart = 0;
    this.hideAt = 0;
    this.disposed = false;
  }

  show(rawText) {
    if (this.disposed) return;

    const text = String(rawText ?? "").trim().slice(0, MAX_CHARS);
    if (!text) return;

    this.draw(text);

    const now = performance.now();
    this.fadeInStart = now;
    this.hideAt = now + HOLD_MS;
    this.state = "visible";
    this.sprite.visible = true;
  }

  draw(text) {
    const context = this.context;

    const font = `600 ${FONT_PX}px system-ui, -apple-system, sans-serif`;
    context.font = font;

    const rawLines = wrapAll(context, text, MAX_TEXT_WIDTH_PX);
    const lines = truncate(context, rawLines, MAX_LINES, MAX_TEXT_WIDTH_PX);

    let textWidth = MIN_TEXT_WIDTH_PX;
    for (const line of lines) {
      textWidth = Math.max(textWidth, context.measureText(line).width);
    }
    textWidth = Math.min(textWidth, MAX_TEXT_WIDTH_PX);

    const bubbleWidth = Math.ceil(textWidth + PAD_X_PX * 2);
    const textBlockHeight = lines.length * LINE_HEIGHT_PX;
    const bubbleHeight = Math.ceil(PAD_TOP_PX + textBlockHeight + PAD_BOTTOM_PX);

    const nextW = bubbleWidth;
    const nextH = bubbleHeight + TAIL_PX;

    // If the canvas size changes, force Three/WebGL to reallocate the GPU texture
    // to avoid GL_INVALID_VALUE glCopySubTextureCHROMIUM errors on Chrome.
    const sizeChanged =
      this.canvas.width !== nextW || this.canvas.height !== nextH;

    if (sizeChanged) {
      this.canvas.width = nextW;
      this.canvas.height = nextH;

      // Force reallocation of the underlying WebGLTexture next upload.
      this.texture.dispose();
    } else {
      context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // Resizing clears state; re-apply.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.font = font;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);

    context.fillStyle = "rgba(9, 17, 27, 0.82)";
    context.strokeStyle = "rgba(255, 255, 255, 0.22)";
    context.lineWidth = 2;

    roundedRect(context, 1, 1, bubbleWidth - 2, bubbleHeight - 2, 18);
    context.fill();
    context.stroke();

    // Tail.
    context.beginPath();
    context.moveTo(bubbleWidth / 2 - 12, bubbleHeight - 2);
    context.lineTo(bubbleWidth / 2 + 12, bubbleHeight - 2);
    context.lineTo(bubbleWidth / 2, bubbleHeight - 2 + TAIL_PX);
    context.closePath();
    context.fillStyle = "rgba(9, 17, 27, 0.82)";
    context.fill();

    // Text.
    context.fillStyle = "#f2f8ff";
    context.textAlign = "center";
    context.textBaseline = "alphabetic";

    lines.forEach((line, index) => {
      const y = PAD_TOP_PX + (index + 1) * LINE_HEIGHT_PX - 10;
      context.fillText(line, bubbleWidth / 2, y);
    });

    // Ensure Three sees both content + size changes reliably.
    if (this.texture.source) this.texture.source.data = this.canvas;
    this.texture.needsUpdate = true;
    if (this.texture.source) this.texture.source.needsUpdate = true;

    const worldWidth = this.canvas.width / PX_PER_UNIT;
    const worldHeight = this.canvas.height / PX_PER_UNIT;

    this.sprite.scale.set(worldWidth, worldHeight, 1);

    // Anchor at tail tip.
    this.sprite.center.set(0.5, 0);
    this.sprite.position.set(0, this.anchorY, 0);
  }

  update(now) {
    if (this.state === "hidden" || this.disposed) return;

    const fadeInElapsed = now - this.fadeInStart;

    if (fadeInElapsed < FADE_MS) {
      this.material.opacity = Math.max(0, Math.min(1, fadeInElapsed / FADE_MS));
      return;
    }

    if (now < this.hideAt) {
      this.material.opacity = 1;
      return;
    }

    const fadeOutElapsed = now - this.hideAt;

    if (fadeOutElapsed >= FADE_MS) {
      this.material.opacity = 0;
      this.sprite.visible = false;
      this.state = "hidden";
      return;
    }

    this.material.opacity = 1 - fadeOutElapsed / FADE_MS;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    this.parent.remove(this.sprite);
    this.texture.dispose();
    this.material.dispose();
  }
}