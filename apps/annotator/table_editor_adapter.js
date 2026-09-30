(function attachAnnotatorTableEditorAdapter(root) {
    'use strict';

    var COMMAND_SELECTORS = {
        rowBefore: 'button[data-command="insert"][data-value="row"][data-option="up"]',
        rowAfter: 'button[data-command="insert"][data-value="row"][data-option="down"]',
        deleteRow: 'button[data-command="delete"][data-value="row"]',
        columnBefore: 'button[data-command="insert"][data-value="cell"][data-option="left"]',
        columnAfter: 'button[data-command="insert"][data-value="cell"][data-option="right"]',
        deleteColumn: 'button[data-command="delete"][data-value="cell"]',
        merge: 'button[data-command="merge"]',
        split: 'button[data-command="onsplit"]',
        splitVertical: 'li[data-command="split"][data-value="vertical"]',
        splitHorizontal: 'li[data-command="split"][data-value="horizontal"]',
    };

    function resolveSunEditorFactory(options) {
        if (options && options.editorFactory) return options.editorFactory;
        return root.SUNEDITOR || root.suneditor || null;
    }

    function createMountElement(rootEl) {
        if (!rootEl) {
            throw new Error('Table editor root element is required');
        }

        var ownerDocument = rootEl.ownerDocument || root.document;
        if (!ownerDocument || typeof ownerDocument.createElement !== 'function') {
            throw new Error('Table editor requires a document with createElement()');
        }

        rootEl.innerHTML = '';
        var host = ownerDocument.createElement('textarea');
        host.className = 'annotator-table-editor-host';
        rootEl.appendChild(host);
        return host;
    }

    function getEditorWysiwyg(instance) {
        return instance && instance.core && instance.core.context && instance.core.context.element
            ? instance.core.context.element.wysiwyg
            : null;
    }

    function getCommandRoot(instance) {
        return instance && instance.core && instance.core.context && instance.core.context.table
            ? instance.core.context.table.resizeDiv
            : null;
    }

    function findClosestTableCell(node) {
        var current = node;
        while (current) {
            if (current.nodeType === 1) {
                var tagName = String(current.tagName || '').toLowerCase();
                if (tagName === 'td' || tagName === 'th') {
                    return current;
                }
            }
            current = current.parentNode || null;
        }
        return null;
    }

    function getSelectedTableCell(instance) {
        var selectionNode = instance && instance.core && typeof instance.core.getSelectionNode === 'function'
            ? instance.core.getSelectionNode()
            : null;

        return findClosestTableCell(selectionNode) || instance.__annotatorSelectedCell || null;
    }

    function setSelectionToCell(instance, cell) {
        if (!instance || !cell) return false;

        var core = instance.core;
        var doc = (core && core._wd) || cell.ownerDocument || root.document;
        if (!doc || typeof doc.createRange !== 'function') return false;

        var selection = core && typeof core.getSelection === 'function'
            ? core.getSelection()
            : (doc.getSelection ? doc.getSelection() : null);

        if (!selection) return false;

        var range = doc.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        if (core && typeof core.focus === 'function') {
            core.focus();
        }

        instance.__annotatorSelectedCell = cell;
        return true;
    }

    function selectFirstTableCell(instance) {
        var wysiwyg = getEditorWysiwyg(instance);
        if (!wysiwyg || typeof wysiwyg.querySelector !== 'function') {
            return null;
        }

        var firstCell = wysiwyg.querySelector('td, th');
        if (firstCell) {
            setSelectionToCell(instance, firstCell);
        }
        return firstCell;
    }

    function updateSelectedCell(instance) {
        var cell = getSelectedTableCell(instance);
        if (cell) {
            instance.__annotatorSelectedCell = cell;
        }
    }

    function installSelectionTracking(instance) {
        var wysiwyg = getEditorWysiwyg(instance);
        if (!wysiwyg || typeof wysiwyg.addEventListener !== 'function') {
            return;
        }

        var handler = function handleSelectionChange() {
            updateSelectedCell(instance);
        };

        ['click', 'mouseup', 'keyup', 'focusin', 'input'].forEach(function bindEvent(eventName) {
            wysiwyg.addEventListener(eventName, handler);
        });

        instance.__annotatorSelectionTracking = {
            target: wysiwyg,
            handler: handler,
        };
    }

    function removeSelectionTracking(instance) {
        var tracking = instance && instance.__annotatorSelectionTracking;
        if (!tracking || !tracking.target || !tracking.handler) {
            return;
        }

        ['click', 'mouseup', 'keyup', 'focusin', 'input'].forEach(function unbindEvent(eventName) {
            tracking.target.removeEventListener(eventName, tracking.handler);
        });
        instance.__annotatorSelectionTracking = null;
    }

    function getTableEditorHtml(instance) {
        var wysiwyg = getEditorWysiwyg(instance);
        if (wysiwyg && typeof wysiwyg.innerHTML === 'string') {
            return wysiwyg.innerHTML;
        }

        if (instance && typeof instance.getContents === 'function') {
            return instance.getContents();
        }

        return '';
    }

    function setTableEditorHtml(instance, html) {
        if (instance && typeof instance.setContents === 'function') {
            instance.setContents(html || '');
        }
    }

    function destroyTableEditor(instance) {
        if (!instance) return;
        removeSelectionTracking(instance);
        if (typeof instance.destroy === 'function') {
            instance.destroy();
        }
    }

    function getCommandElement(instance, command) {
        var commandRoot = getCommandRoot(instance);
        if (!commandRoot || typeof commandRoot.querySelector !== 'function') {
            return null;
        }

        return commandRoot.querySelector(COMMAND_SELECTORS[command] || '');
    }

    function restoreSelection(instance) {
        var selectedCell = getSelectedTableCell(instance) || selectFirstTableCell(instance);
        if (!selectedCell) {
            return false;
        }

        return setSelectionToCell(instance, selectedCell);
    }

    function clickElement(element) {
        if (!element) return false;
        if (typeof element.click === 'function') {
            element.click();
            return true;
        }
        return false;
    }

    function runTableEditorCommand(instance, command) {
        if (!instance || !command) return false;

        restoreSelection(instance);

        if (command === 'splitVertical' || command === 'splitHorizontal') {
            var splitButton = getCommandElement(instance, 'split');
            var splitOption = getCommandElement(instance, command);
            if (!splitButton || !splitOption) {
                return false;
            }
            clickElement(splitButton);
            return clickElement(splitOption);
        }

        var button = getCommandElement(instance, command);
        return clickElement(button);
    }

    function createTableEditor(rootEl, initialHtml, options) {
        var resolvedOptions = options || {};
        var factory = resolveSunEditorFactory(resolvedOptions);
        if (!factory || typeof factory.create !== 'function') {
            throw new Error('SunEditor is not available');
        }

        var host = createMountElement(rootEl);
        var buttonList = resolvedOptions.buttonList || [
            ['undo', 'redo'],
            ['table'],
        ];

        var instance = factory.create(host, {
            width: '100%',
            height: resolvedOptions.height || '100%',
            minHeight: resolvedOptions.minHeight || '420px',
            buttonList: buttonList,
            defaultTag: 'div',
            resizingBar: false,
            showPathLabel: false,
            charCounter: false,
            strictHTMLValidation: false,
            tableCellControllerPosition: 'top',
        });

        setTableEditorHtml(instance, initialHtml || '');
        installSelectionTracking(instance);

        if (typeof queueMicrotask === 'function') {
            queueMicrotask(function selectInitialCell() {
                selectFirstTableCell(instance);
            });
        } else {
            setTimeout(function selectInitialCell() {
                selectFirstTableCell(instance);
            }, 0);
        }

        return instance;
    }

    var api = {
        createTableEditor: createTableEditor,
        destroyTableEditor: destroyTableEditor,
        getSelectedTableCell: getSelectedTableCell,
        getTableEditorHtml: getTableEditorHtml,
        runTableEditorCommand: runTableEditorCommand,
        setSelectionToCell: setSelectionToCell,
        setTableEditorHtml: setTableEditorHtml,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorTableEditorAdapter = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
