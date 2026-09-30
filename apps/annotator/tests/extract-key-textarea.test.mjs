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

describe('extract key field editor', () => {
    it('renders field names as expandable textareas instead of single-line inputs', () => {
        assert.match(js, /<textarea class="extract-key" rows="1" spellcheck="false" placeholder="field_name">/);
        assert.doesNotMatch(js, /<input type="text" class="extract-key"/);
    });

    it('normalizes textarea field names without saving accidental newlines', () => {
        assert.match(js, /function normalizeExtractKeyText\(value\)/);
        assert.ok(js.includes("replace(/[\\r\\n]+/g, ' ').trim()"));
        assert.match(js, /normalizeExtractKeyText\(row\?\.querySelector\('\.extract-key'\)\?\.value\)/);
    });

    it('expands key textareas by default', () => {
        assert.match(js, /function syncExtractKeyTextareaHeight\(textarea\)/);
        assert.match(js, /function syncExtractEditorTextareaHeights\(root = elements\.extractKvRows, options = \{\}\)/);
        assert.match(js, /syncExtractEditorTextareaHeights\(\);/);
        assert.match(js, /scheduleVisibleExtractEditorTextareaSync\(elements\.extractKvRows\)/);
        assert.match(js, /addEventListener\('focusin'/);
        assert.match(js, /addEventListener\('focusout'/);
        assert.match(css, /\.extract-node-key\s*{\s*flex:\s*0 1 clamp\(180px, 26%, 520px\);[^}]*max-width:\s*min\(520px, 45%\);/s);
        assert.match(js, /new ResizeObserver\(\(\) => \{\s*scheduleVisibleExtractEditorTextareaSync\(elements\.extractKvRows\);/s);
        assert.match(css, /\.extract-node-key \.extract-key\s*{[^}]*resize:\s*none;[^}]*word-break:\s*break-word;/s);
    });
});
