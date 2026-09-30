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

function loadClampCenteredScrollPosition() {
    const fnMatch = source.match(/function _clampCenteredScrollPosition\([\s\S]*?\n\}/);
    if (!fnMatch) throw new Error('Could not locate _clampCenteredScrollPosition');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${fnMatch[0]}; globalThis._clampCenteredScrollPosition = _clampCenteredScrollPosition;`,
        sandbox,
    );
    return sandbox._clampCenteredScrollPosition;
}

describe('extract bbox focus scroll', () => {
    const clampCenteredScrollPosition = loadClampCenteredScrollPosition();

    it('centers a target bbox when there is scroll room', () => {
        assert.equal(clampCenteredScrollPosition(900, 400, 1200), 700);
    });

    it('clamps before the beginning of the scroll range', () => {
        assert.equal(clampCenteredScrollPosition(120, 400, 1200), 0);
    });

    it('clamps after the end of the scroll range', () => {
        assert.equal(clampCenteredScrollPosition(1600, 400, 1200), 1200);
    });

    it('focuses the bbox after extract selection re-renders the overlay', () => {
        const fnStart = source.indexOf('async function selectExtractFieldPath(');
        assert.ok(fnStart > 0, 'could not locate selectExtractFieldPath');
        const fnEnd = source.indexOf('\n/**\n * Toggle the `verified` flag', fnStart);
        assert.ok(fnEnd > fnStart, 'could not locate end of selectExtractFieldPath');
        const fnBody = source.slice(fnStart, fnEnd);

        const renderIdx = fnBody.indexOf('renderLayoutOverlay();');
        const focusIdx = fnBody.indexOf('_focusExtractBboxInPdf(fieldPath');
        assert.ok(renderIdx > 0, 'selection should render selected overlay state');
        assert.ok(focusIdx > renderIdx, 'selection should focus the bbox after overlay render');
    });

    it('keeps overlay clicks from re-centering an already visible bbox', () => {
        assert.ok(
            source.includes('focusBbox: false'),
            'overlay-initiated selection should be able to opt out of bbox centering',
        );
    });
});
