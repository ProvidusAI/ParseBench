import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf-8');
const js = fs.readFileSync(path.join(appDir, 'annotator.js'), 'utf-8');
const css = fs.readFileSync(path.join(appDir, 'annotator.css'), 'utf-8');

describe('space optimized annotator layout', () => {
    it('exposes collapsible document tags and PDF toolbar controls', () => {
        assert.match(html, /id="document-tags-toggle"[^>]+aria-controls="document-tags-body"/);
        assert.match(html, /id="document-tags-body"/);
        assert.match(html, /id="pdf-controls-toggle"[^>]+aria-controls="pdf-tool-row"/);
        assert.match(html, /id="pdf-control-content"/);
        assert.match(html, /id="pdf-tool-row"/);
        assert.match(html, /<div class="file-workflow-bar top-bar" id="file-workflow-bar">/);
        assert.doesNotMatch(html, /<header class="top-bar">/);
    });

    it('persists collapsed layout state through dedicated toggles', () => {
        assert.match(js, /documentTagsCollapsed:\s*'annotator:documentTagsCollapsed'/);
        assert.match(js, /pdfControlsCollapsed:\s*'annotator:pdfControlsCollapsed'/);
        assert.match(js, /function setDocumentTagsCollapsed\(collapsed/);
        assert.match(js, /function setPdfControlsCollapsed\(collapsed/);
        assert.match(js, /elements\.documentTagsToggle\.addEventListener\('click'/);
        assert.match(js, /elements\.pdfControlsToggle\.addEventListener\('click'/);
        assert.match(js, /elements\.pdfToolRow\.hidden = pdfControlsCollapsed/);
        assert.doesNotMatch(js, /elements\.pdfControlContent\.hidden = pdfControlsCollapsed/);
    });

    it('keeps collapsed chrome compact', () => {
        assert.match(css, /\.top-bar\s*{[^}]*min-height:\s*48px;/s);
        assert.match(css, /\.pdf-controls\.collapsed\s*{[^}]*min-height:\s*34px;/s);
        assert.match(css, /\.document-tags-section\.collapsed\s*{[^}]*padding-top:\s*7px;[^}]*padding-bottom:\s*7px;/s);
        assert.match(css, /\.file-workflow-bar\.top-bar\s*{[^}]*min-height:\s*32px;[^}]*padding:\s*0 0 6px;/s);
        assert.match(css, /\.ai-sidebar-toggle\s*{[^}]*width:\s*28px;[^}]*margin-left:\s*-14px;[^}]*margin-right:\s*-14px;/s);
        assert.doesNotMatch(css, /\.ai-sidebar-toggle\s*{[^}]*height:\s*100%;/s);
    });

    it('keeps extract serialization help inside collapsed advanced details', () => {
        assert.match(html, /<details class="extract-config-details">[\s\S]*Values are serialized into[\s\S]*<\/details>/);
        assert.doesNotMatch(html, /<\/details>\s*<div class="extract-editor-help">\s*Values are serialized into/);
    });
});
