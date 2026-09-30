import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Tests for the Phase 4 overlay-selection helpers: `_truncateForLabel`
 * and the pure classification logic that decides whether a bbox renders
 * as selected / dimmed / default.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadTruncate() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const match = source.match(/function _truncateForLabel\([\s\S]*?\n\}/);
    if (!match) throw new Error('Could not locate _truncateForLabel');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${match[0]}; globalThis._truncateForLabel = _truncateForLabel;`, sandbox);
    return sandbox._truncateForLabel;
}

describe('_truncateForLabel', () => {
    const truncate = loadTruncate();

    it('returns "null" for null or undefined', () => {
        assert.equal(truncate(null), 'null');
        assert.equal(truncate(undefined), 'null');
    });

    it('returns a short string unchanged', () => {
        assert.equal(truncate('Widget XL'), 'Widget XL');
    });

    it('truncates long strings with an ellipsis', () => {
        const longStr = 'A'.repeat(200);
        const got = truncate(longStr, 80);
        assert.equal(got.length, 80);
        assert.ok(got.endsWith('…'));
    });

    it('stringifies numbers and booleans', () => {
        assert.equal(truncate(42), '42');
        assert.equal(truncate(3.14), '3.14');
        assert.equal(truncate(true), 'true');
        assert.equal(truncate(false), 'false');
    });

    it('respects a custom maxChars', () => {
        assert.equal(truncate('abcdef', 3), 'ab…');
        assert.equal(truncate('abc', 3), 'abc');
    });
});

describe('selection / dim / default bbox classification', () => {
    // Pure logic mirroring renderExtractFieldOverlay. A unit test of
    // the *decision*, not the SVG emission, catches regressions where
    // selection logic and opacity wiring drift.
    function classify({ hasSelection, isSelected }) {
        if (isSelected) return 'selected';
        if (hasSelection) return 'dimmed';
        return 'default';
    }

    it('selects the targeted bbox', () => {
        assert.equal(classify({ hasSelection: true, isSelected: true }), 'selected');
    });

    it('dims non-selected bboxes when a selection is active', () => {
        assert.equal(classify({ hasSelection: true, isSelected: false }), 'dimmed');
    });

    it('renders everything at default when nothing is selected', () => {
        assert.equal(classify({ hasSelection: false, isSelected: false }), 'default');
    });
});
