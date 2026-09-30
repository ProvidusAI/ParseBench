import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');
const source = fs.readFileSync(annotatorPath, 'utf-8');

function loadResizeExtractValueTextarea() {
    const constMatch = source.match(/const EXTRACT_VALUE_TEXTAREA_MIN_HEIGHT = \d+;/);
    const fnMatch = source.match(/function resizeExtractValueTextarea\([\s\S]*?\n\}/);
    if (!constMatch || !fnMatch) {
        throw new Error('Could not locate resizeExtractValueTextarea');
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${constMatch[0]}\n${fnMatch[0]}; globalThis.resizeExtractValueTextarea = resizeExtractValueTextarea;`,
        sandbox,
    );
    return sandbox.resizeExtractValueTextarea;
}

function fakeTextarea(scrollHeight = 96) {
    const classes = new Set();
    return {
        scrollHeight,
        style: { height: '' },
        classList: {
            add: (className) => classes.add(className),
            remove: (className) => classes.delete(className),
            contains: (className) => classes.has(className),
        },
    };
}

describe('extract value textarea autosize', () => {
    const resizeExtractValueTextarea = loadResizeExtractValueTextarea();

    it('expands focused value textareas to their scroll height', () => {
        const textarea = fakeTextarea(128);

        resizeExtractValueTextarea(textarea, true);

        assert.equal(textarea.style.height, '128px');
        assert.equal(textarea.classList.contains('extract-value--expanded'), true);
    });

    it('uses the compact minimum when scroll height is unavailable', () => {
        const textarea = fakeTextarea(0);

        resizeExtractValueTextarea(textarea, true);

        assert.equal(textarea.style.height, '28px');
    });

    it('can collapse the textarea when explicitly requested', () => {
        const textarea = fakeTextarea(128);
        resizeExtractValueTextarea(textarea, true);

        resizeExtractValueTextarea(textarea, false);

        assert.equal(textarea.style.height, '');
        assert.equal(textarea.classList.contains('extract-value--expanded'), false);
    });

    it('wires render, focus, input, and blur events for extract value textareas', () => {
        assert.ok(
            source.includes('function syncExtractEditorTextareaHeights(root = elements.extractKvRows, options = {})'),
            'extract editor should size value textareas immediately after render',
        );
        assert.ok(
            source.includes('scheduleVisibleExtractEditorTextareaSync(elements.extractKvRows)'),
            'large extract editor renders should keep visible rows sized while scrolling',
        );
        assert.ok(
            source.includes('syncExtractEditorTextareaHeights();'),
            'extract editor render path should expand textareas by default',
        );
        assert.ok(
            source.includes("elements.extractKvRows.addEventListener('focusin'"),
            'extract editor should expand value textareas on focus',
        );
        assert.ok(
            source.includes("elements.extractKvRows.addEventListener('input'"),
            'extract editor should keep expanded textareas sized while editing',
        );
        assert.ok(
            source.includes('if (valueInput) resizeExtractValueTextarea(valueInput, true);'),
            'extract editor should keep value textareas expanded after focus leaves',
        );
    });
});
