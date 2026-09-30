(function attachAnnotatorFormulaEditorAdapter(root) {
    'use strict';

    var COMMAND_LATEX = {
        fraction: '\\frac{}{}',
        sqrt: '\\sqrt{}',
        superscript: '^{}',
        subscript: '_{}',
    };

    function hasMathfieldSupport(options) {
        if (options && typeof options.isAvailable === 'boolean') {
            return options.isAvailable;
        }

        if (root.MathfieldElement) return true;

        return Boolean(
            root.customElements
            && typeof root.customElements.get === 'function'
            && root.customElements.get('math-field'),
        );
    }

    function createMountElement(rootEl) {
        if (!rootEl) {
            throw new Error('Formula editor root element is required');
        }

        var ownerDocument = rootEl.ownerDocument || root.document;
        if (!ownerDocument || typeof ownerDocument.createElement !== 'function') {
            throw new Error('Formula editor requires a document with createElement()');
        }

        rootEl.innerHTML = '';
        var host = ownerDocument.createElement('math-field');
        host.className = 'annotator-formula-editor-host';
        rootEl.appendChild(host);
        return host;
    }

    function createFormulaEditor(rootEl, initialLatex, options) {
        var resolvedOptions = options || {};
        if (!hasMathfieldSupport(resolvedOptions)) {
            throw new Error('MathLive is not available');
        }

        var editor = createMountElement(rootEl);
        editor.setAttribute('math-virtual-keyboard-policy', resolvedOptions.virtualKeyboardPolicy || 'manual');
        editor.setAttribute('smart-mode', resolvedOptions.smartMode === true ? 'true' : 'false');
        editor.setAttribute('smart-fence', resolvedOptions.smartFence === false ? 'false' : 'true');
        editor.setAttribute('default-mode', resolvedOptions.defaultMode || 'math');
        editor.value = initialLatex || '';

        if (typeof resolvedOptions.onInput === 'function' && typeof editor.addEventListener === 'function') {
            editor.addEventListener('input', resolvedOptions.onInput);
            editor.__annotatorInputHandler = resolvedOptions.onInput;
        }

        if (typeof editor.focus === 'function') {
            if (typeof queueMicrotask === 'function') {
                queueMicrotask(function focusEditor() {
                    editor.focus();
                });
            } else {
                setTimeout(function focusEditor() {
                    editor.focus();
                }, 0);
            }
        }

        return editor;
    }

    function getFormulaEditorValue(instance) {
        return instance && typeof instance.value === 'string' ? instance.value : '';
    }

    function setFormulaEditorValue(instance, latex) {
        if (!instance) return;
        instance.value = latex || '';
    }

    function insertLatex(instance, latex) {
        if (!instance || !latex) return false;

        if (typeof instance.executeCommand === 'function') {
            var result = instance.executeCommand(['insert', latex]);
            return result !== false;
        }

        setFormulaEditorValue(instance, ''.concat(getFormulaEditorValue(instance)).concat(latex));
        return true;
    }

    function runFormulaEditorCommand(instance, command) {
        if (!instance || !command) return false;
        var latex = COMMAND_LATEX[command] || command;
        return insertLatex(instance, latex);
    }

    function destroyFormulaEditor(instance) {
        if (!instance) return;
        if (instance.__annotatorInputHandler && typeof instance.removeEventListener === 'function') {
            instance.removeEventListener('input', instance.__annotatorInputHandler);
            instance.__annotatorInputHandler = null;
        }
        if (typeof instance.remove === 'function') {
            instance.remove();
        }
    }

    var api = {
        createFormulaEditor: createFormulaEditor,
        destroyFormulaEditor: destroyFormulaEditor,
        getFormulaEditorValue: getFormulaEditorValue,
        runFormulaEditorCommand: runFormulaEditorCommand,
        setFormulaEditorValue: setFormulaEditorValue,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorFormulaEditorAdapter = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
