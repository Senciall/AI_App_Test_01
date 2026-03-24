'use strict';
/* ═══════════════════════════════════════════════════════════════
   pdf-annotations.js — Annotation data model, storage & rendering
   ═══════════════════════════════════════════════════════════════ */

(function () {

// ── Coordinate utilities ────────────────────────────────────────

function screenToPdf(screenX, screenY, pageHeight, scale) {
  return { x: screenX / scale, y: pageHeight - (screenY / scale) };
}

function pdfToScreen(pdfX, pdfY, pageHeight, scale) {
  return { x: pdfX * scale, y: (pageHeight - pdfY) * scale };
}

// ── Annotation factory ──────────────────────────────────────────

function createAnnotation(type, page, props) {
  return {
    id: crypto.randomUUID(),
    type,
    page,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    content: '',
    color: '#FF0000',
    opacity: 1.0,
    strokeWidth: 2,
    strokeColor: '#000000',
    fillColor: 'transparent',
    fontSize: 14,
    fontFamily: 'Helvetica',
    fontWeight: 'normal',
    fontStyle: 'normal',
    lineStyle: 'solid',  // solid | dashed | dotted
    points: [],           // for freehand
    stampText: '',        // for stamp
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    ...props,
  };
}

// ── Annotation store (per document) ─────────────────────────────

class AnnotationStore {
  constructor() {
    this.annotations = [];   // flat list
    this.selected = null;    // selected annotation id
    this.onChange = null;     // callback: () => void — triggers redraw
  }

  add(annotation) {
    this.annotations.push(annotation);
    this._changed();
  }

  remove(id) {
    this.annotations = this.annotations.filter(a => a.id !== id);
    if (this.selected === id) this.selected = null;
    this._changed();
  }

  get(id) {
    return this.annotations.find(a => a.id === id) || null;
  }

  getForPage(pageNum) {
    return this.annotations.filter(a => a.page === pageNum);
  }

  updateRect(id, rect) {
    const a = this.get(id);
    if (a) { Object.assign(a.rect, rect); a.modifiedAt = Date.now(); this._changed(); }
  }

  updateProps(id, props) {
    const a = this.get(id);
    if (a) { Object.assign(a, props); a.modifiedAt = Date.now(); this._changed(); }
  }

  select(id) {
    this.selected = id;
    this._changed();
  }

  deselect() {
    this.selected = null;
    this._changed();
  }

  getSelected() {
    return this.selected ? this.get(this.selected) : null;
  }

  selectAll(pageNum) {
    // Returns array of ids on that page
    return this.getForPage(pageNum).map(a => a.id);
  }

  clear() {
    this.annotations = [];
    this.selected = null;
    this._changed();
  }

  toJSON() {
    return JSON.stringify(this.annotations);
  }

  fromJSON(json) {
    try {
      this.annotations = JSON.parse(json);
    } catch { this.annotations = []; }
    this.selected = null;
    this._changed();
  }

  _changed() {
    if (this.onChange) this.onChange();
  }
}

// ── Annotation canvas renderer ──────────────────────────────────

function renderAnnotations(ctx, annotations, pageHeight, scale, selectedId, dpr) {
  ctx.save();
  ctx.scale(dpr, dpr);

  for (const ann of annotations) {
    ctx.save();
    ctx.globalAlpha = ann.opacity;

    switch (ann.type) {
      case 'highlight':
        renderHighlight(ctx, ann, pageHeight, scale);
        break;
      case 'freehand':
        renderFreehand(ctx, ann, pageHeight, scale);
        break;
      case 'rectangle':
        renderRectangle(ctx, ann, pageHeight, scale);
        break;
      case 'ellipse':
        renderEllipse(ctx, ann, pageHeight, scale);
        break;
      case 'line':
        renderLine(ctx, ann, pageHeight, scale);
        break;
      case 'arrow':
        renderArrow(ctx, ann, pageHeight, scale);
        break;
      case 'text':
        renderText(ctx, ann, pageHeight, scale);
        break;
      case 'stickynote':
        renderStickyNote(ctx, ann, pageHeight, scale);
        break;
      case 'stamp':
        renderStamp(ctx, ann, pageHeight, scale);
        break;
    }

    // Selection handles
    if (ann.id === selectedId) {
      renderSelectionHandles(ctx, ann, pageHeight, scale);
    }

    ctx.restore();
  }
  ctx.restore();
}

function renderHighlight(ctx, ann, ph, s) {
  const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const w = ann.rect.width * s;
  const h = ann.rect.height * s;
  ctx.fillStyle = ann.color;
  ctx.globalAlpha = ann.opacity * 0.35;
  ctx.fillRect(p.x, p.y - h, w, h);
}

function renderFreehand(ctx, ann, ph, s) {
  if (!ann.points || ann.points.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = ann.color;
  ctx.lineWidth = ann.strokeWidth * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const p0 = pdfToScreen(ann.points[0].x, ann.points[0].y, ph, s);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < ann.points.length; i++) {
    const p = pdfToScreen(ann.points[i].x, ann.points[i].y, ph, s);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function renderRectangle(ctx, ann, ph, s) {
  const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const w = ann.rect.width * s;
  const h = ann.rect.height * s;
  setLineStyle(ctx, ann);
  if (ann.fillColor && ann.fillColor !== 'transparent') {
    ctx.fillStyle = ann.fillColor;
    ctx.fillRect(p.x, p.y - h, w, h);
  }
  ctx.strokeStyle = ann.strokeColor || ann.color;
  ctx.lineWidth = ann.strokeWidth * s;
  ctx.strokeRect(p.x, p.y - h, w, h);
}

function renderEllipse(ctx, ann, ph, s) {
  const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const w = ann.rect.width * s;
  const h = ann.rect.height * s;
  const cx = p.x + w / 2;
  const cy = p.y - h / 2;
  setLineStyle(ctx, ann);
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  if (ann.fillColor && ann.fillColor !== 'transparent') {
    ctx.fillStyle = ann.fillColor;
    ctx.fill();
  }
  ctx.strokeStyle = ann.strokeColor || ann.color;
  ctx.lineWidth = ann.strokeWidth * s;
  ctx.stroke();
}

function renderLine(ctx, ann, ph, s) {
  const p1 = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const p2 = pdfToScreen(ann.rect.x + ann.rect.width, ann.rect.y + ann.rect.height, ph, s);
  setLineStyle(ctx, ann);
  ctx.beginPath();
  ctx.strokeStyle = ann.strokeColor || ann.color;
  ctx.lineWidth = ann.strokeWidth * s;
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
}

function renderArrow(ctx, ann, ph, s) {
  const p1 = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const p2 = pdfToScreen(ann.rect.x + ann.rect.width, ann.rect.y + ann.rect.height, ph, s);
  setLineStyle(ctx, ann);
  ctx.beginPath();
  ctx.strokeStyle = ann.strokeColor || ann.color;
  ctx.lineWidth = ann.strokeWidth * s;
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  // Arrowhead
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const headLen = 12 * s;
  ctx.beginPath();
  ctx.fillStyle = ann.strokeColor || ann.color;
  ctx.moveTo(p2.x, p2.y);
  ctx.lineTo(p2.x - headLen * Math.cos(angle - Math.PI / 6), p2.y - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(p2.x - headLen * Math.cos(angle + Math.PI / 6), p2.y - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function renderText(ctx, ann, ph, s) {
  const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const fontSize = ann.fontSize * s;
  const style = ann.fontStyle === 'italic' ? 'italic ' : '';
  const weight = ann.fontWeight === 'bold' ? 'bold ' : '';
  ctx.font = `${style}${weight}${fontSize}px ${ann.fontFamily}`;
  ctx.fillStyle = ann.color;
  ctx.textBaseline = 'top';
  // Text wrapping
  const maxW = ann.rect.width > 0 ? ann.rect.width * s : 9999;
  const lines = wrapText(ctx, ann.content, maxW);
  const lineH = fontSize * 1.3;
  const topY = p.y - (ann.rect.height * s);
  lines.forEach((line, i) => {
    ctx.fillText(line, p.x, topY + i * lineH);
  });
}

function renderStickyNote(ctx, ann, ph, s) {
  const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const size = 24 * s;
  // Note icon
  ctx.fillStyle = ann.color || '#FFEB3B';
  ctx.fillRect(p.x, p.y - size, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x, p.y - size, size, size);
  // Corner fold
  ctx.beginPath();
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  ctx.moveTo(p.x + size - 6 * s, p.y - size);
  ctx.lineTo(p.x + size, p.y - size + 6 * s);
  ctx.lineTo(p.x + size - 6 * s, p.y - size + 6 * s);
  ctx.closePath();
  ctx.fill();
}

function renderStamp(ctx, ann, ph, s) {
  const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const text = ann.stampText || ann.content || 'STAMP';
  const fontSize = (ann.fontSize || 18) * s;
  ctx.font = `bold ${fontSize}px ${ann.fontFamily || 'Helvetica'}`;
  const metrics = ctx.measureText(text);
  const pad = 8 * s;
  const w = metrics.width + pad * 2;
  const h = fontSize + pad * 2;
  ctx.strokeStyle = ann.color || '#FF0000';
  ctx.lineWidth = 3 * s;
  ctx.setLineDash([6 * s, 3 * s]);
  ctx.strokeRect(p.x, p.y - h, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = ann.color || '#FF0000';
  ctx.globalAlpha = (ann.opacity || 1) * 0.7;
  ctx.fillText(text, p.x + pad, p.y - pad);
  ctx.globalAlpha = ann.opacity || 1;
}

function renderSelectionHandles(ctx, ann, ph, s) {
  ctx.globalAlpha = 1;
  let bounds;
  if (ann.type === 'freehand' && ann.points.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ann.points.forEach(pt => {
      const p = pdfToScreen(pt.x, pt.y, ph, s);
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    });
    bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  } else {
    const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
    bounds = { x: p.x, y: p.y - ann.rect.height * s, w: ann.rect.width * s, h: ann.rect.height * s };
  }

  // Dashed outline
  ctx.strokeStyle = '#4A90D9';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(bounds.x - 2, bounds.y - 2, bounds.w + 4, bounds.h + 4);
  ctx.setLineDash([]);

  // Corner handles
  const hs = 6;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#4A90D9';
  ctx.lineWidth = 1.5;
  const corners = [
    [bounds.x - hs / 2, bounds.y - hs / 2],
    [bounds.x + bounds.w - hs / 2, bounds.y - hs / 2],
    [bounds.x - hs / 2, bounds.y + bounds.h - hs / 2],
    [bounds.x + bounds.w - hs / 2, bounds.y + bounds.h - hs / 2],
  ];
  corners.forEach(([cx, cy]) => {
    ctx.fillRect(cx, cy, hs, hs);
    ctx.strokeRect(cx, cy, hs, hs);
  });
}

// ── Helpers ─────────────────────────────────────────────────────

function setLineStyle(ctx, ann) {
  if (ann.lineStyle === 'dashed') ctx.setLineDash([8, 4]);
  else if (ann.lineStyle === 'dotted') ctx.setLineDash([2, 3]);
  else ctx.setLineDash([]);
}

function wrapText(ctx, text, maxWidth) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Hit testing ─────────────────────────────────────────────────

function hitTest(annotations, screenX, screenY, pageHeight, scale) {
  // Reverse order so topmost annotation is hit first
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    if (isHit(ann, screenX, screenY, pageHeight, scale)) return ann;
  }
  return null;
}

function isHit(ann, sx, sy, ph, s) {
  if (ann.type === 'freehand') {
    // Check proximity to any point
    const threshold = Math.max(ann.strokeWidth * s, 8);
    for (const pt of ann.points) {
      const p = pdfToScreen(pt.x, pt.y, ph, s);
      if (Math.hypot(p.x - sx, p.y - sy) < threshold) return true;
    }
    return false;
  }

  if (ann.type === 'line' || ann.type === 'arrow') {
    // Distance from point to line segment
    const p1 = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
    const p2 = pdfToScreen(ann.rect.x + ann.rect.width, ann.rect.y + ann.rect.height, ph, s);
    const dist = distToSegment(sx, sy, p1.x, p1.y, p2.x, p2.y);
    return dist < Math.max(ann.strokeWidth * s, 8);
  }

  if (ann.type === 'stickynote') {
    const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
    const size = 24 * s;
    return sx >= p.x && sx <= p.x + size && sy >= p.y - size && sy <= p.y;
  }

  // Rectangle bounds
  const p = pdfToScreen(ann.rect.x, ann.rect.y, ph, s);
  const w = ann.rect.width * s;
  const h = ann.rect.height * s;
  return sx >= p.x && sx <= p.x + w && sy >= p.y - h && sy <= p.y;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ── Exports ─────────────────────────────────────────────────────

window.PdfAnnotations = {
  screenToPdf,
  pdfToScreen,
  createAnnotation,
  AnnotationStore,
  renderAnnotations,
  hitTest,
};

})();
