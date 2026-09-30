import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../table_editor_utils.js');
const require = createRequire(import.meta.url);

const tableEditorUtils = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

describe('module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof tableEditorUtils.extractEditableTableSegment, 'function');
        assert.equal(typeof importedModule.default.normalizeSavedTableHtml, 'function');

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorTableEditorUtils.getDefaultEmptyTableHtml,
            'function',
        );
    });
});

describe('extractEditableTableSegment', () => {
    it('returns a default visual table when the source HTML is empty', () => {
        const extracted = tableEditorUtils.extractEditableTableSegment('');

        assert.equal(extracted.mode, 'visual');
        assert.equal(extracted.reason, 'empty');
        assert.equal(extracted.prefixHtml, '');
        assert.equal(extracted.suffixHtml, '');
        assert.match(extracted.tableHtml, /<table>/i);
    });

    it('isolates one table while preserving prefix and suffix HTML', () => {
        const extracted = tableEditorUtils.extractEditableTableSegment(
            '<p>Lead-in copy</p><table><tbody><tr><td>A</td></tr></tbody></table><p>Tail copy</p>',
        );

        assert.equal(extracted.mode, 'visual');
        assert.equal(extracted.reason, null);
        assert.equal(extracted.prefixHtml, '<p>Lead-in copy</p>');
        assert.equal(extracted.tableHtml, '<table><tbody><tr><td>A</td></tr></tbody></table>');
        assert.equal(extracted.suffixHtml, '<p>Tail copy</p>');
    });

    it('falls back to raw mode for multiple tables', () => {
        const extracted = tableEditorUtils.extractEditableTableSegment(
            '<table><tbody><tr><td>One</td></tr></tbody></table><table><tbody><tr><td>Two</td></tr></tbody></table>',
        );

        assert.equal(extracted.mode, 'raw');
        assert.equal(extracted.reason, 'multiple-tables');
        assert.equal(extracted.tableCount, 2);
    });
});

describe('normalizeSavedTableHtml', () => {
    it('strips dangerous markup while preserving table structure attributes', () => {
        const normalized = tableEditorUtils.normalizeSavedTableHtml(`
            <table>
                <thead>
                    <tr><th colspan="2">Heading<script>alert(1)</script></th></tr>
                </thead>
                <tbody>
                    <tr><td rowspan="2">Left</td><td>Right</td></tr>
                    <tr><td onclick="hack()">Bottom</td></tr>
                </tbody>
            </table>
        `);

        assert.match(normalized, /<thead>/i);
        assert.match(normalized, /colspan="2"/i);
        assert.match(normalized, /rowspan="2"/i);
        assert.doesNotMatch(normalized, /<script/i);
        assert.doesNotMatch(normalized, /onclick=/i);
    });
});

describe('rebuildContentHtml', () => {
    it('reassembles the original non-table context around the table fragment', () => {
        const rebuilt = tableEditorUtils.rebuildContentHtml({
            prefixHtml: '<p>Lead-in copy</p>',
            tableHtml: '<table><tbody><tr><td>A</td></tr></tbody></table>',
            suffixHtml: '<p>Tail copy</p>',
        });

        assert.equal(
            rebuilt,
            '<p>Lead-in copy</p><table><tbody><tr><td>A</td></tr></tbody></table><p>Tail copy</p>',
        );
    });
});
