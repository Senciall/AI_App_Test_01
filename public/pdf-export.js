'use strict';
/* ═══════════════════════════════════════════════════════════════
   pdf-export.js — Export annotated PDF using pdf-lib
   ═══════════════════════════════════════════════════════════════ */

(function () {

const PDFLIB_SRC = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';

async function ensurePdfLib() {
  if (window.PDFLib) return window.PDFLib;
  await new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${PDFLIB_SRC}"]`)) { ok(); return; }
    const s = document.createElement('script');
    s.src = PDFLIB_SRC; s.onload = ok; s.onerror = fail;
    document.head.appendChild(s);
  });
  return window.PDFLib;
}

async function exportPdf(pdfUrl, annotations, filename) {
  const PDFLib = await ensurePdfLib();

  // Load original PDF bytes
  let pdfBytes;
  if (pdfUrl.startsWith('blob:')) {
    pdfBytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer());
  } else {
    pdfBytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer());
  }

  const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const helvetica = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);

  for (const ann of annotations) {
    const pageIdx = ann.page - 1;
    if (pageIdx < 0 || pageIdx >= pages.length) continue;
    const page = pages[pageIdx];

    switch (ann.type) {
      case 'text':
        drawTextAnnotation(page, ann, helvetica, helveticaBold, PDFLib);
        break;
      case 'highlight':
        drawHighlightAnnotation(page, ann, PDFLib);
        break;
      case 'freehand':
        drawFreehandAnnotation(page, ann, PDFLib);
        break;
      case 'rectangle':
        drawRectAnnotation(page, ann, PDFLib);
        break;
      case 'ellipse':
        drawEllipseAnnotation(page, ann, PDFLib);
        break;
      case 'line':
      case 'arrow':
        drawLineAnnotation(page, ann, PDFLib);
        break;
      case 'stamp':
        drawStampAnnotation(page, ann, helveticaBold, PDFLib);
        break;
    }
  }

  const outBytes = await pdfDoc.save();
  const blob = new Blob([outBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'annotated.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function parseColor(hex, PDFLib) {
  if (!hex || hex === 'transparent') return null;
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return PDFLib.rgb(r, g, b);
}

function drawTextAnnotation(page, ann, font, boldFont, PDFLib) {
  const f = ann.fontWeight === 'bold' ? boldFont : font;
  const color = parseColor(ann.color, PDFLib);
  if (!color) return;
  page.drawText(ann.content || '', {
    x: ann.rect.x,
    y: ann.rect.y - ann.fontSize,
    size: ann.fontSize || 14,
    font: f,
    color,
    opacity: ann.opacity || 1,
  });
}

function drawHighlightAnnotation(page, ann, PDFLib) {
  const color = parseColor(ann.color, PDFLib);
  if (!color) return;
  page.drawRectangle({
    x: ann.rect.x,
    y: ann.rect.y - ann.rect.height,
    width: ann.rect.width,
    height: ann.rect.height,
    color,
    opacity: (ann.opacity || 1) * 0.35,
  });
}

function drawFreehandAnnotation(page, ann, PDFLib) {
  if (!ann.points || ann.points.length < 2) return;
  const color = parseColor(ann.color, PDFLib);
  if (!color) return;
  // Draw as series of thin lines
  for (let i = 0; i < ann.points.length - 1; i++) {
    page.drawLine({
      start: { x: ann.points[i].x, y: ann.points[i].y },
      end:   { x: ann.points[i+1].x, y: ann.points[i+1].y },
      thickness: ann.strokeWidth || 2,
      color,
      opacity: ann.opacity || 1,
    });
  }
}

function drawRectAnnotation(page, ann, PDFLib) {
  const opts = {
    x: ann.rect.x,
    y: ann.rect.y - ann.rect.height,
    width: ann.rect.width,
    height: ann.rect.height,
    opacity: ann.opacity || 1,
  };
  const fill = parseColor(ann.fillColor, PDFLib);
  const stroke = parseColor(ann.strokeColor || ann.color, PDFLib);
  if (fill) opts.color = fill;
  if (stroke) { opts.borderColor = stroke; opts.borderWidth = ann.strokeWidth || 2; }
  page.drawRectangle(opts);
}

function drawEllipseAnnotation(page, ann, PDFLib) {
  const cx = ann.rect.x + ann.rect.width / 2;
  const cy = ann.rect.y - ann.rect.height / 2;
  const opts = {
    x: cx, y: cy,
    xScale: ann.rect.width / 2,
    yScale: ann.rect.height / 2,
    opacity: ann.opacity || 1,
  };
  const fill = parseColor(ann.fillColor, PDFLib);
  const stroke = parseColor(ann.strokeColor || ann.color, PDFLib);
  if (fill) opts.color = fill;
  if (stroke) { opts.borderColor = stroke; opts.borderWidth = ann.strokeWidth || 2; }
  page.drawEllipse(opts);
}

function drawLineAnnotation(page, ann, PDFLib) {
  const color = parseColor(ann.strokeColor || ann.color, PDFLib);
  if (!color) return;
  page.drawLine({
    start: { x: ann.rect.x, y: ann.rect.y },
    end:   { x: ann.rect.x + ann.rect.width, y: ann.rect.y + ann.rect.height },
    thickness: ann.strokeWidth || 2,
    color,
    opacity: ann.opacity || 1,
  });
}

function drawStampAnnotation(page, ann, font, PDFLib) {
  const color = parseColor(ann.color, PDFLib);
  if (!color) return;
  const text = ann.stampText || ann.content || 'STAMP';
  page.drawText(text, {
    x: ann.rect.x + 8,
    y: ann.rect.y - (ann.fontSize || 18) - 4,
    size: ann.fontSize || 18,
    font,
    color,
    opacity: (ann.opacity || 1) * 0.7,
  });
  page.drawRectangle({
    x: ann.rect.x,
    y: ann.rect.y - ann.rect.height,
    width: ann.rect.width,
    height: ann.rect.height,
    borderColor: color,
    borderWidth: 3,
    opacity: ann.opacity || 1,
  });
}

// ── Save / Load annotations via server ──────────────────────────

async function saveAnnotations(docId, annotations) {
  // Group by page
  const byPage = {};
  annotations.forEach(a => {
    if (!byPage[a.page]) byPage[a.page] = [];
    byPage[a.page].push(a);
  });

  const res = await fetch(`/api/pdf/${docId}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages: byPage }),
  });
  return res.json();
}

async function loadAnnotations(docId) {
  try {
    const res = await fetch(`/api/pdf/${docId}/annotations`);
    if (!res.ok) return [];
    const data = await res.json();
    // Flatten pages back into a single array
    const all = [];
    if (data.pages) {
      for (const [pageNum, anns] of Object.entries(data.pages)) {
        anns.forEach(a => { a.page = parseInt(pageNum); all.push(a); });
      }
    }
    return all;
  } catch { return []; }
}

// ── Exports ─────────────────────────────────────────────────────

window.PdfExport = {
  exportPdf,
  saveAnnotations,
  loadAnnotations,
};

})();
