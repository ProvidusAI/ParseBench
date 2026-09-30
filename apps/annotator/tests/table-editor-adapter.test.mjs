import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../table_editor_adapter.js');
const require = createRequire(import.meta.url);

const tableEditorAdapter = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

function createFakeDocument() {
    return {
        createElement(tagName) {
            return {
                tagName,
                className: '',
                ownerDocument: this,
                appendChild() {},
            };
        },
        createRange() {
            return {
                selectNodeContents() {},
                collapse() {},
            };
        },
        getSelection() {
            return {
                removeAllRanges() {},
                addRange() {},
            };
        },
    };
}

describe('module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof tableEditorAdapter.createTableEditor, 'function');
        assert.equal(typeof importedModule.default.runTableEditorCommand, 'function');

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorTableEditorAdapter.destroyTableEditor,
            'function',
        );
    });
});

describe('createTableEditor', () => {
    it('creates a SunEditor instance through the injected factory and seeds the HTML', async () => {
        const fakeDocument = createFakeDocument();
        const rootEl = {
            innerHTML: 'stale',
            ownerDocument: fakeDocument,
            appendChild(child) {
                this.child = child;
            },
        };

        let receivedOptions = null;
        let seededHtml = null;
        const fakeEditor = {
            setContents(html) {
                seededHtml = html;
            },
            core: {
                context: {
                    element: {
                        wysiwyg: {
                            addEventListener() {},
                            querySelector() {
                                return null;
                            },
                        },
                    },
                    table: {
                        resizeDiv: {
                            querySelector() {
                                return null;
                            },
                        },
                    },
                },
            },
        };
        const factory = {
            create(host, options) {
                receivedOptions = options;
                return fakeEditor;
            },
        };

        const instance = tableEditorAdapter.createTableEditor(rootEl, '<table><tbody><tr><td>A</td></tr></tbody></table>', {
            editorFactory: factory,
        });

        await Promise.resolve();

        assert.equal(instance, fakeEditor);
        assert.equal(rootEl.innerHTML, '');
        assert.equal(rootEl.child.tagName, 'textarea');
        assert.equal(seededHtml, '<table><tbody><tr><td>A</td></tr></tbody></table>');
        assert.equal(receivedOptions.tableCellControllerPosition, 'top');
        assert.equal(receivedOptions.resizingBar, false);
    });
});

describe('runTableEditorCommand', () => {
    it('maps external toolbar commands to the SunEditor table controls', () => {
        const clicks = [];
        const fakeDocument = createFakeDocument();
        const selectedCell = {
            nodeType: 1,
            tagName: 'TD',
            ownerDocument: fakeDocument,
            parentNode: null,
        };
        const commandMap = new Map([
            ['button[data-command="insert"][data-value="row"][data-option="up"]', { click: () => clicks.push('rowBefore') }],
            ['button[data-command="onsplit"]', { click: () => clicks.push('split') }],
            ['li[data-command="split"][data-value="vertical"]', { click: () => clicks.push('splitVertical') }],
        ]);
        const instance = {
            __annotatorSelectedCell: selectedCell,
            core: {
                _wd: fakeDocument,
                focus() {},
                getSelection() {
                    return fakeDocument.getSelection();
                },
                getSelectionNode() {
                    return selectedCell;
                },
                context: {
                    element: {
                        wysiwyg: {
                            innerHTML: '<table><tbody><tr><td>A</td></tr></tbody></table>',
                        },
                    },
                    table: {
                        resizeDiv: {
                            querySelector(selector) {
                                return commandMap.get(selector) || null;
                            },
                        },
                    },
                },
            },
        };

        assert.equal(tableEditorAdapter.runTableEditorCommand(instance, 'rowBefore'), true);
        assert.equal(tableEditorAdapter.runTableEditorCommand(instance, 'splitVertical'), true);
        assert.deepEqual(clicks, ['rowBefore', 'split', 'splitVertical']);
    });
});

describe('getTableEditorHtml', () => {
    it('reads the current innerHTML from the editable root', () => {
        const instance = {
            core: {
                context: {
                    element: {
                        wysiwyg: {
                            innerHTML: '<table><tbody><tr><td>A</td></tr></tbody></table>',
                        },
                    },
                },
            },
        };

        assert.equal(
            tableEditorAdapter.getTableEditorHtml(instance),
            '<table><tbody><tr><td>A</td></tr></tbody></table>',
        );
    });
});
