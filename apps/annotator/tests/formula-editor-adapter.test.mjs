import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../formula_editor_adapter.js');
const require = createRequire(import.meta.url);

const formulaEditorAdapter = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

function createFakeMathField() {
    return {
        attributes: {},
        className: '',
        value: '',
        listeners: new Map(),
        ownerDocument: null,
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        addEventListener(name, handler) {
            this.listeners.set(name, handler);
        },
        removeEventListener(name) {
            this.listeners.delete(name);
        },
        focus() {},
        remove() {
            this.removed = true;
        },
        executeCommand(command) {
            this.lastCommand = command;
            return true;
        },
    };
}

function createFakeDocument(field) {
    return {
        createElement(tagName) {
            if (tagName !== 'math-field') {
                throw new Error('Unexpected tag');
            }
            field.ownerDocument = this;
            return field;
        },
    };
}

describe('module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof formulaEditorAdapter.createFormulaEditor, 'function');
        assert.equal(typeof importedModule.default.runFormulaEditorCommand, 'function');

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = {
            globalThis: {
                customElements: {
                    get() {
                        return function MathField() {};
                    },
                },
            },
            console,
        };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorFormulaEditorAdapter.destroyFormulaEditor,
            'function',
        );
    });
});

describe('createFormulaEditor', () => {
    it('creates a MathLive host and seeds the latex value', async () => {
        const fakeField = createFakeMathField();
        const fakeDocument = createFakeDocument(fakeField);
        const rootEl = {
            innerHTML: 'stale',
            ownerDocument: fakeDocument,
            appendChild(child) {
                this.child = child;
            },
        };

        const editor = formulaEditorAdapter.createFormulaEditor(rootEl, '\\frac{a}{b}', {
            isAvailable: true,
            onInput() {},
        });

        await Promise.resolve();

        assert.equal(editor, fakeField);
        assert.equal(rootEl.innerHTML, '');
        assert.equal(rootEl.child, fakeField);
        assert.equal(fakeField.value, '\\frac{a}{b}');
        assert.equal(fakeField.attributes['math-virtual-keyboard-policy'], 'manual');
        assert.equal(fakeField.attributes['smart-mode'], 'false');
    });
});

describe('runFormulaEditorCommand', () => {
    it('maps helper commands to latex insertions', () => {
        const fakeField = createFakeMathField();

        assert.equal(formulaEditorAdapter.runFormulaEditorCommand(fakeField, 'fraction'), true);
        assert.deepEqual(fakeField.lastCommand, ['insert', '\\frac{}{}']);
    });
});

describe('destroyFormulaEditor', () => {
    it('removes the injected input handler and host element', () => {
        const fakeField = createFakeMathField();
        fakeField.__annotatorInputHandler = () => {};
        fakeField.addEventListener('input', fakeField.__annotatorInputHandler);

        formulaEditorAdapter.destroyFormulaEditor(fakeField);

        assert.equal(fakeField.listeners.has('input'), false);
        assert.equal(fakeField.removed, true);
    });
});
