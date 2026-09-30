import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(appDir, 'annotator.js'), 'utf-8');
const css = fs.readFileSync(path.join(appDir, 'annotator.css'), 'utf-8');

describe('PDF viewer gestures', () => {
    it('binds a non-passive wheel listener to the PDF viewport', () => {
        assert.match(
            js,
            /elements\.pdfContainer\.addEventListener\('wheel',\s*handlePdfContainerWheel,\s*{\s*passive:\s*false\s*}\)/,
        );
    });

    it('supports cursor-anchored wheel zoom and manual panning', () => {
        assert.match(js, /function handlePdfContainerWheel\(event\)/);
        assert.match(js, /event\.ctrlKey\s*\|\|\s*event\.metaKey/);
        assert.match(js, /scheduleViewerZoom\(nextScale,\s*event\.clientX,\s*event\.clientY\)/);
        assert.match(js, /function restoreViewerPointerAnchor\(anchor\)/);
        assert.match(js, /container\.scrollLeft\s*\+=\s*horizontalDelta/);
        assert.match(js, /container\.scrollTop\s*\+=\s*deltaY/);
    });

    it('contains viewport overscroll inside the PDF panel', () => {
        assert.match(css, /\.pdf-container\s*{[^}]*overscroll-behavior:\s*contain;/s);
    });
});
