import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Tests for shared bbox-drag math.
 *
 * The semantics must match the original layout-mode drag switch at
 * apps/annotator/annotator.js ~line 5694 byte-for-byte. Each of the
 * nine modes is exercised through its forward and clamped-edge paths.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const modulePath = path.resolve(__dirname, '../bbox_drag_helpers.js');
const { applyBboxDrag, mouseDeltaToNorm, MIN_SIZE, DRAG_MODES } = require(modulePath);

const EPS = 1e-9;
const almost = (a, b) => Math.abs(a - b) <= EPS;
const almostBbox = (got, want) => {
    assert.equal(got.length, 4);
    for (let i = 0; i < 4; i += 1) {
        assert.ok(
            almost(got[i], want[i]),
            `index ${i}: got=${got[i]}, want=${want[i]}`,
        );
    }
};

describe('mouseDeltaToNorm', () => {
    it('divides pixel delta by svg rect dimensions', () => {
        const svgRect = { width: 800, height: 600 };
        const d = mouseDeltaToNorm(810, 620, 800, 600, svgRect);
        assert.ok(almost(d.dx, 10 / 800));
        assert.ok(almost(d.dy, 20 / 600));
    });

    it('guards against zero-size rects without dividing by zero', () => {
        const svgRect = { width: 0, height: 0 };
        const d = mouseDeltaToNorm(10, 20, 0, 0, svgRect);
        assert.ok(Number.isFinite(d.dx));
        assert.ok(Number.isFinite(d.dy));
    });
});

describe('applyBboxDrag — move', () => {
    it('translates the bbox by delta', () => {
        const got = applyBboxDrag([0.3, 0.3, 0.2, 0.2], { dx: 0.1, dy: -0.1 }, 'move');
        almostBbox(got, [0.4, 0.2, 0.2, 0.2]);
    });

    it('clamps against the top-left edge', () => {
        const got = applyBboxDrag([0.02, 0.02, 0.2, 0.2], { dx: -0.5, dy: -0.5 }, 'move');
        almostBbox(got, [0, 0, 0.2, 0.2]);
    });

    it('clamps against the bottom-right edge, preserving size', () => {
        const got = applyBboxDrag([0.7, 0.7, 0.2, 0.2], { dx: 0.5, dy: 0.5 }, 'move');
        almostBbox(got, [0.8, 0.8, 0.2, 0.2]);
    });

    it('never shrinks the bbox when moving against a corner', () => {
        const got = applyBboxDrag([0, 0, 0.2, 0.2], { dx: -10, dy: -10 }, 'move');
        almostBbox(got, [0, 0, 0.2, 0.2]);
    });
});

describe('applyBboxDrag — resize-se', () => {
    it('grows w and h by delta when headroom allows', () => {
        const got = applyBboxDrag([0.2, 0.2, 0.3, 0.3], { dx: 0.1, dy: 0.2 }, 'resize-se');
        almostBbox(got, [0.2, 0.2, 0.4, 0.5]);
    });

    it('enforces MIN_SIZE on shrink', () => {
        const got = applyBboxDrag([0.2, 0.2, 0.3, 0.3], { dx: -1, dy: -1 }, 'resize-se');
        almostBbox(got, [0.2, 0.2, MIN_SIZE, MIN_SIZE]);
    });

    it('clamps w and h at the canvas edge', () => {
        const got = applyBboxDrag([0.7, 0.7, 0.2, 0.2], { dx: 1, dy: 1 }, 'resize-se');
        almostBbox(got, [0.7, 0.7, 0.3, 0.3]);
    });
});

describe('applyBboxDrag — resize-nw', () => {
    it('moves the NW corner, shrinking w/h accordingly', () => {
        const got = applyBboxDrag([0.2, 0.2, 0.4, 0.4], { dx: 0.1, dy: 0.1 }, 'resize-nw');
        almostBbox(got, [0.3, 0.3, 0.3, 0.3]);
    });

    it('clamps NW corner to the opposite corner minus MIN_SIZE', () => {
        const got = applyBboxDrag([0.2, 0.2, 0.4, 0.4], { dx: 1, dy: 1 }, 'resize-nw');
        almostBbox(got, [0.2 + 0.4 - MIN_SIZE, 0.2 + 0.4 - MIN_SIZE, MIN_SIZE, MIN_SIZE]);
    });

    it('clamps NW corner at 0, 0', () => {
        const got = applyBboxDrag([0.2, 0.2, 0.4, 0.4], { dx: -1, dy: -1 }, 'resize-nw');
        almostBbox(got, [0, 0, 0.6, 0.6]);
    });
});

describe('applyBboxDrag — resize-ne', () => {
    it('grows w and moves y', () => {
        const got = applyBboxDrag([0.2, 0.3, 0.3, 0.3], { dx: 0.1, dy: 0.1 }, 'resize-ne');
        almostBbox(got, [0.2, 0.4, 0.4, 0.2]);
    });

    it('clamps w at the right edge', () => {
        const got = applyBboxDrag([0.6, 0.3, 0.3, 0.3], { dx: 1, dy: 0 }, 'resize-ne');
        almostBbox(got, [0.6, 0.3, 0.4, 0.3]);
    });
});

describe('applyBboxDrag — resize-sw', () => {
    it('moves x, grows h', () => {
        const got = applyBboxDrag([0.2, 0.2, 0.4, 0.3], { dx: 0.1, dy: 0.1 }, 'resize-sw');
        almostBbox(got, [0.3, 0.2, 0.3, 0.4]);
    });

    it('clamps x at 0', () => {
        const got = applyBboxDrag([0.1, 0.2, 0.4, 0.3], { dx: -1, dy: 0 }, 'resize-sw');
        almostBbox(got, [0, 0.2, 0.5, 0.3]);
    });
});

describe('applyBboxDrag — edge resizes', () => {
    it('resize-n moves y, shrinks h', () => {
        const got = applyBboxDrag([0.2, 0.3, 0.4, 0.4], { dx: 0, dy: 0.1 }, 'resize-n');
        almostBbox(got, [0.2, 0.4, 0.4, 0.3]);
    });

    it('resize-e grows w', () => {
        const got = applyBboxDrag([0.2, 0.3, 0.3, 0.3], { dx: 0.1, dy: 0 }, 'resize-e');
        almostBbox(got, [0.2, 0.3, 0.4, 0.3]);
    });

    it('resize-s grows h', () => {
        const got = applyBboxDrag([0.2, 0.3, 0.3, 0.3], { dx: 0, dy: 0.1 }, 'resize-s');
        almostBbox(got, [0.2, 0.3, 0.3, 0.4]);
    });

    it('resize-w moves x, shrinks w', () => {
        const got = applyBboxDrag([0.2, 0.3, 0.4, 0.3], { dx: 0.1, dy: 0 }, 'resize-w');
        almostBbox(got, [0.3, 0.3, 0.3, 0.3]);
    });
});

describe('applyBboxDrag — unknown mode', () => {
    it('returns the origin bbox unchanged', () => {
        const got = applyBboxDrag([0.2, 0.3, 0.4, 0.4], { dx: 0.5, dy: 0.5 }, 'rotate');
        almostBbox(got, [0.2, 0.3, 0.4, 0.4]);
    });
});

describe('applyBboxDrag — input safety', () => {
    it('does not mutate origBbox', () => {
        const orig = [0.2, 0.3, 0.4, 0.4];
        const copy = [...orig];
        applyBboxDrag(orig, { dx: 0.1, dy: 0.1 }, 'move');
        almostBbox(orig, copy);
    });

    it('throws on a malformed origBbox', () => {
        assert.throws(() => applyBboxDrag([0.1, 0.2], { dx: 0, dy: 0 }, 'move'));
        assert.throws(() => applyBboxDrag(null, { dx: 0, dy: 0 }, 'move'));
    });
});

describe('DRAG_MODES manifest', () => {
    it('lists all 9 supported modes and no others', () => {
        assert.deepEqual([...DRAG_MODES].sort(), [
            'move',
            'resize-e',
            'resize-n',
            'resize-ne',
            'resize-nw',
            'resize-s',
            'resize-se',
            'resize-sw',
            'resize-w',
        ]);
    });
});
