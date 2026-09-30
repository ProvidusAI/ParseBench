import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Tests for the Phase 5 multi-bbox ordinal helpers and per-row page
 * indicator. We extract `_formatBboxPagesBadge` by regex and exercise
 * it in isolation.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function extractFunctionSource(source, functionName) {
    const start = source.indexOf(`function ${functionName}(`);
    if (start === -1) throw new Error(`Could not locate ${functionName}`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`Could not parse ${functionName}`);
}

function loadBadgeFormatter() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const functionSource = extractFunctionSource(source, '_formatBboxPagesBadge');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${functionSource}; globalThis._formatBboxPagesBadge = _formatBboxPagesBadge;`,
        sandbox,
    );
    return sandbox._formatBboxPagesBadge;
}

function loadUnionComputer() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const functionSource = extractFunctionSource(source, '_computeExtractBboxUnion');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${functionSource}; globalThis._computeExtractBboxUnion = _computeExtractBboxUnion;`,
        sandbox,
    );
    return sandbox._computeExtractBboxUnion;
}

function loadPaddedScreenRectComputer() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const functionSource = extractFunctionSource(source, '_computePaddedScreenRect');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${functionSource}; globalThis._computePaddedScreenRect = _computePaddedScreenRect;`,
        sandbox,
    );
    return sandbox._computePaddedScreenRect;
}

function loadPageBboxCollector() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const functionSource = extractFunctionSource(source, '_getExtractRuleBboxesForPage');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${functionSource}; globalThis._getExtractRuleBboxesForPage = _getExtractRuleBboxesForPage;`,
        sandbox,
    );
    return sandbox._getExtractRuleBboxesForPage;
}

describe('_formatBboxPagesBadge', () => {
    const format = loadBadgeFormatter();

    it('formats a single bbox on page 1', () => {
        assert.equal(format([{ page: 1, bbox: [0, 0, 0.1, 0.1] }]), 'p1');
    });

    it('formats multiple bboxes on a single page', () => {
        assert.equal(
            format([
                { page: 1, bbox: [0, 0, 0.1, 0.1] },
                { page: 1, bbox: [0, 0.2, 0.1, 0.1] },
                { page: 1, bbox: [0, 0.4, 0.1, 0.1] },
            ]),
            '3 bboxes · p1',
        );
    });

    it('formats multiple bboxes across pages', () => {
        assert.equal(
            format([
                { page: 1, bbox: [0, 0, 0.1, 0.1] },
                { page: 2, bbox: [0, 0, 0.1, 0.1] },
            ]),
            '2 bboxes · p1, p2',
        );
    });

    it('truncates to +N when 4+ unique pages', () => {
        const bboxes = [1, 2, 3, 4, 5].map((p) => ({ page: p, bbox: [0, 0, 0.1, 0.1] }));
        const got = format(bboxes);
        assert.equal(got, '5 bboxes · p1, p2, +3');
    });

    it('deduplicates pages', () => {
        assert.equal(
            format([
                { page: 3, bbox: [0, 0, 0.1, 0.1] },
                { page: 1, bbox: [0, 0, 0.1, 0.1] },
                { page: 1, bbox: [0, 0, 0.1, 0.1] },
            ]),
            '3 bboxes · p1, p3',
        );
    });

    it('handles an empty bbox list', () => {
        assert.equal(format([]), '1 bbox');
    });

    it('ignores invalid page entries', () => {
        assert.equal(
            format([
                { page: null, bbox: [0, 0, 0.1, 0.1] },
                { page: 2, bbox: [0, 0, 0.1, 0.1] },
            ]),
            '2 bboxes · p2',
        );
    });
});

describe('_computeExtractBboxUnion', () => {
    const computeUnion = loadUnionComputer();
    const roundUnion = (union) => ({
        ...union,
        x: Number(union.x.toFixed(6)),
        y: Number(union.y.toFixed(6)),
        width: Number(union.width.toFixed(6)),
        height: Number(union.height.toFixed(6)),
    });

    it('returns null for a single bbox on the page', () => {
        assert.equal(
            computeUnion([{ page: 1, bbox: [0.1, 0.2, 0.3, 0.4] }], 1),
            null,
        );
    });

    it('computes the enclosing box for multiple bboxes on the current page', () => {
        assert.deepEqual(
            roundUnion(computeUnion([
                { page: 1, bbox: [0.3, 0.2, 0.4, 0.1] },
                { page: 1, bbox: [0.1, 0.5, 0.2, 0.2] },
                { page: 2, bbox: [0.0, 0.0, 1.0, 1.0] },
            ], 1)),
            {
                x: 0.1,
                y: 0.2,
                width: 0.6,
                height: 0.5,
                count: 2,
            },
        );
    });

    it('ignores invalid bboxes', () => {
        assert.deepEqual(
            roundUnion(computeUnion([
                { page: 1, bbox: [0.1, 0.2, 0.3, 0.4] },
                { page: 1, bbox: ['bad', 0, 1, 1] },
                { page: 1, bbox: [0.2, 0.3, 0.5, 0.1] },
            ], 1)),
            {
                x: 0.1,
                y: 0.2,
                width: 0.6,
                height: 0.4,
                count: 2,
            },
        );
    });
});

describe('_getExtractRuleBboxesForPage', () => {
    const getPageBboxes = loadPageBboxCollector();
    const plainPageBboxes = (entries) => Array.from(entries, ({ bboxEntry, bboxIndexInRule }) => ({
        bboxEntry: { page: bboxEntry.page, bbox: Array.from(bboxEntry.bbox) },
        bboxIndexInRule,
    }));

    it('returns valid bboxes for the requested page while preserving original indexes', () => {
        assert.deepEqual(
            plainPageBboxes(getPageBboxes({
                bboxes: [
                    { page: 1, bbox: [0.1, 0.2, 0.3, 0.4] },
                    { page: 2, bbox: [0.2, 0.3, 0.4, 0.5] },
                    { page: 1, bbox: [0.3, 0.4, 0.5, 0.6] },
                ],
            }, 1)),
            [
                { bboxEntry: { page: 1, bbox: [0.1, 0.2, 0.3, 0.4] }, bboxIndexInRule: 0 },
                { bboxEntry: { page: 1, bbox: [0.3, 0.4, 0.5, 0.6] }, bboxIndexInRule: 2 },
            ],
        );
    });

    it('filters invalid bbox payloads before overlay rendering', () => {
        assert.deepEqual(
            plainPageBboxes(getPageBboxes({
                bboxes: [
                    { page: 1, bbox: [0.1, 0.2, 0.3] },
                    { page: 1, bbox: null },
                    { page: 1, bbox: [0.2, 0.3, 0.4, 0.5] },
                    { page: 3, bbox: [0.4, 0.5, 0.6, 0.7] },
                ],
            }, 1)),
            [
                { bboxEntry: { page: 1, bbox: [0.2, 0.3, 0.4, 0.5] }, bboxIndexInRule: 2 },
            ],
        );
    });
});

describe('_computePaddedScreenRect', () => {
    const computeScreenRect = loadPaddedScreenRectComputer();
    const roundRect = (rect) => rect && {
        x: Number(rect.x.toFixed(6)),
        y: Number(rect.y.toFixed(6)),
        width: Number(rect.width.toFixed(6)),
        height: Number(rect.height.toFixed(6)),
    };

    it('clamps padded unions at the top-left edge without over-extending width or height', () => {
        assert.deepEqual(
            roundRect(computeScreenRect(
                { x: 0.003, y: 0.002, width: 0.1, height: 0.2 },
                1000,
                1000,
                7,
            )),
            {
                x: 0,
                y: 0,
                width: 110,
                height: 209,
            },
        );
    });

    it('clamps padded unions at the bottom-right edge without overflowing the canvas', () => {
        assert.deepEqual(
            roundRect(computeScreenRect(
                { x: 0.9, y: 0.85, width: 0.12, height: 0.2 },
                1000,
                1000,
                7,
            )),
            {
                x: 893,
                y: 843,
                width: 107,
                height: 157,
            },
        );
    });

    it('returns null for collapsed or invalid screen rects', () => {
        assert.equal(
            computeScreenRect({ x: 1.2, y: 0.2, width: 0.1, height: 0.1 }, 1000, 1000, 7),
            null,
        );
    });
});
