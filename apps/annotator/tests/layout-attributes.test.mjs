import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../layout_attributes.js');
const require = createRequire(import.meta.url);

const layoutAttributes = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

describe('layout attribute module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof layoutAttributes.normalizeAttributeRows, 'function');
        assert.equal(typeof importedModule.default.normalizeAttributeRows, 'function');
        assert.equal(importedModule.default.normalizeAttributeRows, layoutAttributes.normalizeAttributeRows);

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorLayoutAttributes.normalizeAttributeRows,
            'function',
        );
    });
});

describe('normalizeAttributeRows', () => {
    it('preserves multiple distinct attributes and trims user input', () => {
        const result = layoutAttributes.normalizeAttributeRows([
            { key: ' text_role ', value: ' body ' },
            { key: 'furniture', value: 'page-header' },
        ]);

        assert.deepEqual(result, {
            value: {
                text_role: 'body',
                furniture: 'page-header',
            },
        });
    });

    it('rejects duplicate keys explicitly', () => {
        const result = layoutAttributes.normalizeAttributeRows([
            { key: 'text_role', value: 'body' },
            { key: 'text_role', value: 'caption' },
        ]);

        assert.deepEqual(result, {
            error: 'Duplicate attribute key: text_role',
            index: 1,
            key: 'text_role',
        });
    });

    it('rejects partially filled rows and ignores fully empty ones', () => {
        const result = layoutAttributes.normalizeAttributeRows([
            { key: '', value: '' },
            { key: 'chart_type', value: '' },
        ]);

        assert.deepEqual(result, {
            error: 'Each layout attribute needs both a key and a value.',
            index: 1,
        });
    });
});

describe('attributeRowsFromMap', () => {
    it('round-trips attribute objects for edit/reopen flows', () => {
        const rows = layoutAttributes.attributeRowsFromMap({
            text_role: 'body',
            notes: 'value with "quotes" and punctuation: yes.',
        });

        assert.deepEqual(rows, [
            { key: 'text_role', value: 'body' },
            { key: 'notes', value: 'value with "quotes" and punctuation: yes.' },
        ]);
    });
});
