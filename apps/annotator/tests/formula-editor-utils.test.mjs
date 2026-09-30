import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../formula_editor_utils.js');
const require = createRequire(import.meta.url);

const formulaEditorUtils = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

describe('module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof formulaEditorUtils.getFormulaRenderState, 'function');
        assert.equal(typeof importedModule.default.rebuildFormulaSource, 'function');

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorFormulaEditorUtils.extractRenderableLatex,
            'function',
        );
    });
});

describe('getFormulaRenderState', () => {
    it('extracts display-mode latex from wrapped formulas', () => {
        const state = formulaEditorUtils.getFormulaRenderState('  $$\\frac{a}{b}$$  ');

        assert.equal(state.renderableLatex, '\\frac{a}{b}');
        assert.equal(state.displayMode, true);
        assert.equal(state.hadDelimiters, true);
        assert.equal(state.delimiter.open, '$$');
        assert.equal(state.leadingWhitespace, '  ');
        assert.equal(state.trailingWhitespace, '  ');
    });

    it('treats plain latex as renderable display math by default', () => {
        const state = formulaEditorUtils.getFormulaRenderState('\\int_0^1 x^2 dx');

        assert.equal(state.renderableLatex, '\\int_0^1 x^2 dx');
        assert.equal(state.displayMode, true);
        assert.equal(state.hadDelimiters, false);
        assert.equal(state.delimiter, null);
    });

    it('returns an empty-safe state for blank input', () => {
        const state = formulaEditorUtils.getFormulaRenderState('   ');

        assert.equal(state.isEmpty, true);
        assert.equal(state.renderableLatex, '');
    });
});

describe('rebuildFormulaSource', () => {
    it('reapplies outer delimiters and whitespace around edited latex', () => {
        const rebuilt = formulaEditorUtils.rebuildFormulaSource('\\sqrt{x}', {
            delimiter: { open: '\\(', close: '\\)' },
            leadingWhitespace: '\n',
            trailingWhitespace: '  ',
        });

        assert.equal(rebuilt, '\n\\(\\sqrt{x}\\)  ');
    });
});

describe('isFormulaLayout', () => {
    it('matches only Formula layout rules', () => {
        assert.equal(formulaEditorUtils.isFormulaLayout({ type: 'layout', canonical_class: 'Formula' }), true);
        assert.equal(formulaEditorUtils.isFormulaLayout({ type: 'layout', canonical_class: 'Text' }), false);
        assert.equal(formulaEditorUtils.isFormulaLayout({ type: 'present' }), false);
    });
});
