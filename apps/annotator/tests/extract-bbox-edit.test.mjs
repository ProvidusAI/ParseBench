import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Tests for the extract bbox edit flow. The mousedown flow itself mixes DOM
 * events and annotator state; the bookkeeping pieces (bbox mutation +
 * source_bbox_index preservation) are pure and exercised here.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const dragModulePath = path.resolve(__dirname, '../bbox_drag_helpers.js');
const { applyBboxDrag } = require(dragModulePath);

const EPS = 1e-9;
const almostBbox = (got, want) => {
    assert.equal(got.length, 4);
    for (let i = 0; i < 4; i += 1) {
        assert.ok(Math.abs(got[i] - want[i]) <= EPS, `idx ${i}: ${got[i]} vs ${want[i]}`);
    }
};

describe('extract bbox drag preserves source_bbox_index', () => {
    it('does not touch source_bbox_index during move', () => {
        const rule = {
            type: 'extract_field',
            field_path: 'total_due',
            bboxes: [
                { page: 1, bbox: [0.2, 0.3, 0.2, 0.1], source_bbox_index: 17 },
            ],
            verified: true,
            tags: [],
        };
        const bboxEntry = rule.bboxes[0];
        const orig = [...bboxEntry.bbox];
        bboxEntry.bbox = applyBboxDrag(orig, { dx: 0.1, dy: -0.05 }, 'move');
        almostBbox(bboxEntry.bbox, [0.3, 0.25, 0.2, 0.1]);
        assert.equal(bboxEntry.source_bbox_index, 17);
    });

    it('does not touch source_bbox_index during resize', () => {
        const bboxEntry = { page: 2, bbox: [0.2, 0.2, 0.3, 0.3], source_bbox_index: 4 };
        bboxEntry.bbox = applyBboxDrag([...bboxEntry.bbox], { dx: 0.05, dy: 0.05 }, 'resize-se');
        almostBbox(bboxEntry.bbox, [0.2, 0.2, 0.35, 0.35]);
        assert.equal(bboxEntry.source_bbox_index, 4);
    });
});

describe('extract bbox drag state transitions', () => {
    // Pure reproduction of the overlay's select-vs-clear click branch.
    function overlayClickAction({
        clickedPath,
        clickedIdx,
        selectedPath,
        selectedIdx,
        suppressNextClick = false,
    }) {
        if (suppressNextClick) return 'ignore';
        const alreadySelected = selectedPath === clickedPath
            && (selectedIdx === clickedIdx || (selectedIdx == null && clickedIdx === 0));
        return alreadySelected ? 'clear' : 'select';
    }

    // Pure reproduction of _onExtractBboxMouseDown's drag preparation branch.
    function mousedownAction({ clickedPath, clickedIdx, selectedPath, selectedIdx }) {
        const alreadyActive = selectedPath === clickedPath
            && (selectedIdx === clickedIdx || (selectedIdx == null && clickedIdx === 0));
        return alreadyActive ? 'prepare-drag' : 'ignore';
    }

    it('first click on unselected bbox selects it', () => {
        assert.equal(
            overlayClickAction({
                clickedPath: 'total_due',
                clickedIdx: 0,
                selectedPath: null,
                selectedIdx: null,
            }),
            'select',
        );
    });

    it('clicking the active bbox again clears focus selection', () => {
        assert.equal(
            overlayClickAction({
                clickedPath: 'total_due',
                clickedIdx: 0,
                selectedPath: 'total_due',
                selectedIdx: 0,
            }),
            'clear',
        );
    });

    it('click after drag release is ignored instead of toggling selection', () => {
        assert.equal(
            overlayClickAction({
                clickedPath: 'total_due',
                clickedIdx: 0,
                selectedPath: 'total_due',
                selectedIdx: 0,
                suppressNextClick: true,
            }),
            'ignore',
        );
    });

    it('mousedown on already-active bbox prepares drag without clearing selection', () => {
        assert.equal(
            mousedownAction({
                clickedPath: 'total_due',
                clickedIdx: 0,
                selectedPath: 'total_due',
                selectedIdx: 0,
            }),
            'prepare-drag',
        );
    });
});

describe('rule index lookup for synthetic __unassigned__ paths', () => {
    // Pure reproduction of _findExtractRuleIndexByPath's branches.
    function findExtractRuleIndex(rules, fieldPath) {
        if (!fieldPath) return -1;
        if (typeof fieldPath === 'string' && fieldPath.startsWith('__unassigned__/')) {
            const suffix = fieldPath.slice('__unassigned__/'.length);
            for (let i = 0; i < rules.length; i += 1) {
                const r = rules[i];
                if (!r || r.type !== 'extract_field') continue;
                const tags = Array.isArray(r.tags) ? r.tags : [];
                if (!tags.includes('stray_evidence')) continue;
                if (r.id === suffix) return i;
            }
            return -1;
        }
        let firstMatch = -1;
        for (let i = 0; i < rules.length; i += 1) {
            const r = rules[i];
            if (!r || r.type !== 'extract_field' || r.field_path !== fieldPath) continue;
            const isStray = Array.isArray(r.tags) && r.tags.includes('stray_evidence');
            if (!isStray) return i;
            if (firstMatch < 0) firstMatch = i;
        }
        return firstMatch;
    }

    const rules = [
        { type: 'extract_field', id: 'a', field_path: 'foo', tags: [] },
        { type: 'extract_field', id: 'b', field_path: 'bar', tags: ['stray_evidence'] },
        { type: 'extract_field', id: 'c', field_path: 'foo', tags: ['stray_evidence'] },
    ];

    it('real path prefers non-stray', () => {
        assert.equal(findExtractRuleIndex(rules, 'foo'), 0);
    });

    it('synthetic path resolves by stray rule id', () => {
        assert.equal(findExtractRuleIndex(rules, '__unassigned__/b'), 1);
        assert.equal(findExtractRuleIndex(rules, '__unassigned__/c'), 2);
    });

    it('returns -1 when synthetic id not found', () => {
        assert.equal(findExtractRuleIndex(rules, '__unassigned__/missing'), -1);
    });
});
