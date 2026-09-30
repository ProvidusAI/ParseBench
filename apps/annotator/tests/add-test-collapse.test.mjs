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

describe('add test composer collapse', () => {
    it('renders the Add Test composer behind an accessible toggle', () => {
        assert.match(html, /id="add-test-toggle"[^>]+aria-controls="add-test-body"/);
        assert.match(html, /id="add-test-body"/);
        assert.match(html, /id="add-test-summary"/);
        assert.match(html, /<label for="test-type-select">Rule type:<\/label>/);
    });

    it('persists collapsed state and expands when a rule type is selected', () => {
        assert.match(js, /addTestCollapsed:\s*'annotator:addTestCollapsed'/);
        assert.match(js, /let addTestCollapsed = readStoredBoolean\(STORAGE_KEYS\.addTestCollapsed,\s*true\)/);
        assert.match(js, /function setAddTestCollapsed\(collapsed/);
        assert.match(js, /elements\.addTestToggle\.addEventListener\('click'/);
        assert.match(js, /setAddTestCollapsed\(false\);\s*elements\.testFormContainer\.innerHTML = formHtml;/s);
    });

    it('keeps the collapsed composer compact', () => {
        assert.match(css, /\.add-test-section\.collapsed\s*{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
        assert.match(css, /\.add-test-body\[hidden\]\s*{[^}]*display:\s*none;/s);
        assert.match(css, /\.add-test-summary\s*{[^}]*text-overflow:\s*ellipsis;/s);
    });
});
