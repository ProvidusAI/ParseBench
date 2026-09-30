import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Tests for the "⚠ Unassigned bboxes" tree branch added in Phase 3 of the
 * extract_field viz+editing follow-up.
 *
 * `annotator.js` is loaded as-text and executed inside a VM sandbox to
 * exercise the pure tree-builder helpers without spinning up the browser.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

const norm = (v) => JSON.parse(JSON.stringify(v));

function loadHelpers() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');

    // Extract the contiguous block from the `Extract field path helpers`
    // comment down to just before `function extractTypeOptions`. This
    // contains all the pure tree-builder helpers we want to exercise.
    const startMarker = '// --- Extract field path helpers (JS port of extract_field_paths.py) ---';
    const endMarker = '/** Type selector HTML helper */';
    const startIdx = source.indexOf(startMarker);
    const endIdx = source.indexOf(endMarker);
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
        throw new Error('Could not locate extract_field helper block in annotator.js');
    }
    const helpers = source.slice(startIdx, endIdx);

    const sandbox = {
        currentTests: { test_rules: [] },
        console,
        extractFieldFilter: 'all',
        // Stubs for schema helpers defined elsewhere in annotator.js. The
        // tree-builder only calls `normalizeSchemaType(rawType, fallbackValue)`
        // to pick a type for each leaf; our test inputs already supply an
        // explicit schema, so a thin passthrough is sufficient.
        normalizeSchemaType: (rawType, fallback) => {
            if (Array.isArray(rawType) && rawType.length > 0) return rawType[0];
            if (typeof rawType === 'string') return rawType;
            if (typeof fallback === 'number') return Number.isInteger(fallback) ? 'integer' : 'number';
            if (typeof fallback === 'boolean') return 'boolean';
            if (fallback === null) return 'null';
            if (typeof fallback === 'string') return 'string';
            return 'string';
        },
    };
    vm.createContext(sandbox);

    const script = `
${helpers}
globalThis.buildExtractEntriesFromCurrentTests = buildExtractEntriesFromCurrentTests;
globalThis._collectUnassignedStrayEntries = _collectUnassignedStrayEntries;
globalThis.applyExtractFieldFilter = applyExtractFieldFilter;
globalThis._setCurrentTests = (v) => { currentTests = v; };
globalThis._setFilter = (v) => { extractFieldFilter = v; };
`;
    vm.runInContext(script, sandbox, { filename: annotatorPath });
    return sandbox;
}

describe('_collectUnassignedStrayEntries', () => {
    const helpers = loadHelpers();

    it('returns empty when no strays present', () => {
        helpers._setCurrentTests({
            test_rules: [
                { type: 'extract_field', id: 'a', field_path: 'foo', expected_value: 1, bboxes: [] },
                { type: 'present', text: 'x' },
            ],
        });
        const strays = helpers._collectUnassignedStrayEntries();
        assert.equal(strays.length, 0);
    });

    it('collects every stray as its own entry (preserves duplicates)', () => {
        helpers._setCurrentTests({
            test_rules: [
                {
                    type: 'extract_field',
                    id: 'stray1',
                    field_path: 'line_items[0].description',
                    expected_value: null,
                    bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1], source_bbox_index: 7 }],
                    verified: false,
                    tags: ['benchmark_fixture', 'stray_evidence'],
                },
                {
                    type: 'extract_field',
                    id: 'stray2',
                    field_path: 'line_items[0].description',
                    expected_value: null,
                    bboxes: [{ page: 2, bbox: [0.1, 0.1, 0.1, 0.1], source_bbox_index: 8 }],
                    verified: false,
                    tags: ['benchmark_fixture', 'stray_evidence'],
                },
                {
                    type: 'extract_field',
                    id: 'real1',
                    field_path: 'line_items[0].description',
                    expected_value: 'Widget',
                    bboxes: [{ page: 1, bbox: [0.2, 0.2, 0.1, 0.1], source_bbox_index: 0 }],
                    verified: true,
                    tags: ['benchmark_fixture'],
                },
            ],
        });
        const strays = helpers._collectUnassignedStrayEntries();
        assert.equal(strays.length, 2);
        assert.equal(strays[0].type, 'unassigned-stray');
        assert.equal(strays[0].path, '__unassigned__/stray1');
        assert.equal(strays[0].sourcePath, 'line_items[0].description');
        assert.equal(strays[0].bboxes.length, 1);
        assert.equal(strays[1].path, '__unassigned__/stray2');
    });

    it('ignores extract_field rules that lack the stray tag', () => {
        helpers._setCurrentTests({
            test_rules: [
                {
                    type: 'extract_field',
                    id: 'real',
                    field_path: 'unassigned_looking_but_not_tagged',
                    expected_value: null,
                    bboxes: [],
                    verified: false,
                    tags: [],
                },
            ],
        });
        const strays = helpers._collectUnassignedStrayEntries();
        assert.equal(strays.length, 0);
    });
});

describe('buildExtractEntriesFromCurrentTests', () => {
    const helpers = loadHelpers();

    it('prepends an unassigned-group when strays exist', () => {
        helpers._setFilter('all');
        helpers._setCurrentTests({
            data_schema: {
                type: 'object',
                properties: { record_id: { type: 'string' } },
            },
            expected_output: { record_id: 'REC-0000' },
            test_rules: [
                {
                    type: 'extract_field',
                    id: 'real',
                    field_path: 'record_id',
                    expected_value: 'REC-0000',
                    bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1], source_bbox_index: 0 }],
                    verified: true,
                    tags: ['benchmark_fixture'],
                },
                {
                    type: 'extract_field',
                    id: 'stray1',
                    field_path: 'record_id',
                    expected_value: null,
                    bboxes: [{ page: 1, bbox: [0.3, 0.3, 0.1, 0.1], source_bbox_index: 99 }],
                    verified: false,
                    tags: ['benchmark_fixture', 'stray_evidence'],
                },
            ],
        });
        const entries = helpers.buildExtractEntriesFromCurrentTests();
        // [0] is the unassigned group, [1..] are the real keys
        assert.equal(entries[0].type, 'unassigned-group');
        assert.equal(entries[0].children.length, 1);
        assert.equal(entries[0].children[0].type, 'unassigned-stray');
        assert.equal(entries[0].children[0].path, '__unassigned__/stray1');
        // The schema-based entry for record_id follows
        const realEntry = entries.find((e) => e.key === 'record_id');
        assert.ok(realEntry, 'expected record_id entry');
        // Real entry keeps the non-stray rule
        assert.equal(realEntry.rule?.id, 'real');
    });

    it('emits no unassigned-group when there are zero strays', () => {
        helpers._setFilter('all');
        helpers._setCurrentTests({
            data_schema: {
                type: 'object',
                properties: { po_number: { type: 'string' } },
            },
            expected_output: { po_number: 'PO-1' },
            test_rules: [
                {
                    type: 'extract_field',
                    id: 'a',
                    field_path: 'po_number',
                    expected_value: 'PO-1',
                    bboxes: [],
                    verified: true,
                    tags: ['benchmark_fixture'],
                },
            ],
        });
        const entries = helpers.buildExtractEntriesFromCurrentTests();
        for (const e of entries) {
            assert.notEqual(e.type, 'unassigned-group');
        }
    });

    it('hides the unassigned-group when filter=verified', () => {
        helpers._setFilter('verified');
        helpers._setCurrentTests({
            data_schema: {
                type: 'object',
                properties: { foo: { type: 'string' } },
            },
            expected_output: { foo: 'v' },
            test_rules: [
                {
                    type: 'extract_field',
                    id: 'real',
                    field_path: 'foo',
                    expected_value: 'v',
                    bboxes: [],
                    verified: true,
                    tags: [],
                },
                {
                    type: 'extract_field',
                    id: 'stray',
                    field_path: 'foo',
                    expected_value: null,
                    bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1], source_bbox_index: 7 }],
                    verified: false,
                    tags: ['stray_evidence'],
                },
            ],
        });
        const entries = helpers.buildExtractEntriesFromCurrentTests();
        for (const e of entries) {
            assert.notEqual(e.type, 'unassigned-group');
        }
    });
});
