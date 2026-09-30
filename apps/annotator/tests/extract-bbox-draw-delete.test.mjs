import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Tests for extract bbox draw + delete flows. We exercise the pure mutation
 * pieces (append / splice) in isolation; the DOM glue is covered by manual QA.
 */

function appendDrawnBbox(rule, pageNum, pxRect, canvasW, canvasH) {
    rule.bboxes = Array.isArray(rule.bboxes) ? rule.bboxes : [];
    rule.bboxes.push({
        page: pageNum,
        bbox: [
            pxRect.x / canvasW,
            pxRect.y / canvasH,
            pxRect.width / canvasW,
            pxRect.height / canvasH,
        ],
        source_bbox_index: null,
    });
    return rule.bboxes.length - 1;
}

function deleteBboxAt(rule, bboxIdx, { selectedBboxIndex }) {
    rule.bboxes.splice(bboxIdx, 1);
    let nextSelected = selectedBboxIndex;
    if (selectedBboxIndex === bboxIdx) {
        nextSelected = rule.bboxes.length > 0 ? 0 : null;
    } else if (selectedBboxIndex != null && selectedBboxIndex > bboxIdx) {
        nextSelected = selectedBboxIndex - 1;
    }
    return nextSelected;
}

describe('draw — append bbox', () => {
    it('appends a new bbox with source_bbox_index=null', () => {
        const rule = {
            type: 'extract_field',
            field_path: 'total_due',
            bboxes: [],
            verified: false,
            tags: [],
        };
        const idx = appendDrawnBbox(rule, 3, { x: 100, y: 200, width: 80, height: 40 }, 800, 600);
        assert.equal(idx, 0);
        assert.equal(rule.bboxes.length, 1);
        const b = rule.bboxes[0];
        assert.equal(b.page, 3);
        assert.equal(b.source_bbox_index, null);
        assert.ok(Math.abs(b.bbox[0] - 100 / 800) < 1e-9);
        assert.ok(Math.abs(b.bbox[1] - 200 / 600) < 1e-9);
        assert.ok(Math.abs(b.bbox[2] - 80 / 800) < 1e-9);
        assert.ok(Math.abs(b.bbox[3] - 40 / 600) < 1e-9);
    });

    it('appends to a multi-bbox rule, preserving existing entries', () => {
        const existing = { page: 1, bbox: [0.1, 0.1, 0.1, 0.1], source_bbox_index: 5 };
        const rule = {
            type: 'extract_field',
            field_path: 'line_items[0].description',
            bboxes: [existing],
            verified: true,
            tags: [],
        };
        appendDrawnBbox(rule, 2, { x: 50, y: 50, width: 100, height: 30 }, 500, 500);
        assert.equal(rule.bboxes.length, 2);
        assert.equal(rule.bboxes[0], existing);
        assert.equal(rule.bboxes[0].source_bbox_index, 5);
    });
});

describe('delete — splice bbox', () => {
    const rule = () => ({
        type: 'extract_field',
        field_path: 'wrap_cell',
        bboxes: [
            { page: 1, bbox: [0.1, 0.1, 0.1, 0.1], source_bbox_index: 0 },
            { page: 1, bbox: [0.2, 0.2, 0.1, 0.1], source_bbox_index: 1 },
            { page: 1, bbox: [0.3, 0.3, 0.1, 0.1], source_bbox_index: 2 },
        ],
        verified: true,
        tags: [],
    });

    it('removes the bbox at the given index', () => {
        const r = rule();
        deleteBboxAt(r, 1, { selectedBboxIndex: 0 });
        assert.equal(r.bboxes.length, 2);
        assert.equal(r.bboxes[0].source_bbox_index, 0);
        assert.equal(r.bboxes[1].source_bbox_index, 2);
    });

    it('resets selection to 0 when the removed index was selected', () => {
        const r = rule();
        const next = deleteBboxAt(r, 1, { selectedBboxIndex: 1 });
        assert.equal(next, 0);
    });

    it('decrements selection when a lower index is removed', () => {
        const r = rule();
        const next = deleteBboxAt(r, 0, { selectedBboxIndex: 2 });
        assert.equal(next, 1);
    });

    it('returns null when the final bbox is removed', () => {
        const r = { bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1] }] };
        const next = deleteBboxAt(r, 0, { selectedBboxIndex: 0 });
        assert.equal(next, null);
        assert.equal(r.bboxes.length, 0);
    });
});
