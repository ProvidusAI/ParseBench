(function attachAnnotatorBboxDrag(root) {
    'use strict';

    // Minimum normalized width/height for resize operations. Matches the
    // original layout-mode value (0.01) so layout and extract boxes resize consistently.
    const MIN_SIZE = 0.01;

    /**
     * Convert a raw (mouseX, mouseY) delta against a drag-start point into
     * normalized-coordinate deltas using the overlay's bounding rect.
     *
     * Pure. Takes only primitive inputs + the cached svgRect.
     */
    function mouseDeltaToNorm(mouseX, mouseY, startX, startY, svgRect) {
        const width = svgRect && svgRect.width > 0 ? svgRect.width : 1;
        const height = svgRect && svgRect.height > 0 ? svgRect.height : 1;
        return {
            dx: (mouseX - startX) / width,
            dy: (mouseY - startY) / height,
        };
    }

    /**
     * Apply a drag delta to an origin bbox under one of 9 edit modes
     * ('move', 'resize-{nw,ne,sw,se,n,e,s,w}'). Returns a fresh
     * `[x, y, w, h]` array; does not mutate `origBbox`.
     *
     * Semantics match the original switch at annotator.js:5694 byte-for-byte:
     *   - move is clamped to [0, 1] with the bbox's dimensions preserved
     *   - every resize enforces MIN_SIZE on the resized axis
     *   - corner/edge resizes that move the NW corner reposition x / y
     *     so the opposite corner stays anchored.
     */
    function applyBboxDrag(origBbox, deltaNorm, mode) {
        if (!Array.isArray(origBbox) || origBbox.length !== 4) {
            throw new Error('applyBboxDrag: origBbox must be [x, y, w, h]');
        }
        const { dx, dy } = deltaNorm || { dx: 0, dy: 0 };
        let [x, y, w, h] = origBbox;

        switch (mode) {
            case 'move':
                x = Math.max(0, Math.min(1 - w, x + dx));
                y = Math.max(0, Math.min(1 - h, y + dy));
                break;

            case 'resize-nw': {
                const nx = Math.max(0, Math.min(x + w - MIN_SIZE, x + dx));
                const ny = Math.max(0, Math.min(y + h - MIN_SIZE, y + dy));
                w = w - (nx - x);
                h = h - (ny - y);
                x = nx;
                y = ny;
                break;
            }

            case 'resize-ne': {
                const nw = Math.max(MIN_SIZE, Math.min(1 - x, w + dx));
                const ny = Math.max(0, Math.min(y + h - MIN_SIZE, y + dy));
                w = nw;
                h = h - (ny - y);
                y = ny;
                break;
            }

            case 'resize-sw': {
                const nx = Math.max(0, Math.min(x + w - MIN_SIZE, x + dx));
                const nh = Math.max(MIN_SIZE, Math.min(1 - y, h + dy));
                w = w - (nx - x);
                x = nx;
                h = nh;
                break;
            }

            case 'resize-se':
                w = Math.max(MIN_SIZE, Math.min(1 - x, w + dx));
                h = Math.max(MIN_SIZE, Math.min(1 - y, h + dy));
                break;

            case 'resize-n': {
                const ny = Math.max(0, Math.min(y + h - MIN_SIZE, y + dy));
                h = h - (ny - y);
                y = ny;
                break;
            }

            case 'resize-e':
                w = Math.max(MIN_SIZE, Math.min(1 - x, w + dx));
                break;

            case 'resize-s':
                h = Math.max(MIN_SIZE, Math.min(1 - y, h + dy));
                break;

            case 'resize-w': {
                const nx = Math.max(0, Math.min(x + w - MIN_SIZE, x + dx));
                w = w - (nx - x);
                x = nx;
                break;
            }

            default:
                // Unknown mode: leave the bbox untouched.
                break;
        }

        return [x, y, w, h];
    }

    const DRAG_MODES = Object.freeze([
        'move',
        'resize-nw',
        'resize-ne',
        'resize-sw',
        'resize-se',
        'resize-n',
        'resize-e',
        'resize-s',
        'resize-w',
    ]);

    const api = {
        MIN_SIZE,
        DRAG_MODES,
        applyBboxDrag,
        mouseDeltaToNorm,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorBboxDrag = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
