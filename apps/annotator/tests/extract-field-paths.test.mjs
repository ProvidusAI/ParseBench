import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/** Normalize a VM-sandbox value into a main-realm structure for deep equality. */
const norm = (v) => JSON.parse(JSON.stringify(v));

/**
 * Unit tests for the EXTRACT-mode helpers added to annotator.js.
 *
 * annotator.js is a browser-globals JS file (not an ES/CJS module), so we
 * extract the relevant pure helper block by regex and execute it inside a
 * VM sandbox. This lets us exercise `parseExtractFieldPath`,
 * `inflateExpectedOutput`, `indexExtractFieldRules`, and
 * `applyExtractFieldFilter` without pulling in the full browser DOM.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadHelpers() {
    const source = fs.readFileSync(annotatorPath, 'utf8');

    // Pull out the helper block between the JS-port section header and the
    // end of `indexExtractFieldRules` / `shortenFieldPathLabel`. The section
    // is self-contained (depends only on a module-level `currentTests` we stub).
    const startMarker = '// --- Extract field path helpers (JS port of extract_field_paths.py) ---';
    const endMarker = '// --- Recursive tree-based extract editor ---';
    const startIdx = source.indexOf(startMarker);
    const endIdx = source.indexOf(endMarker);
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
        throw new Error('Could not locate extract_field helper block in annotator.js');
    }
    const helpers = source.slice(startIdx, endIdx);

    // Also pull the buildExtractEntriesFromSchema / _attachRuleToLeaf /
    // applyExtractFieldFilter helpers that follow. We match up to and including
    // `function buildExtractEntriesFromCurrentTests` opener (stop before body
    // that relies on the DOM `currentTests`).
    const filterStart = source.indexOf('function applyExtractFieldFilter');
    const filterEnd = source.indexOf('function buildExtractEntriesFromCurrentTests');
    if (filterStart < 0 || filterEnd < 0) {
        throw new Error('Could not locate filter helper block in annotator.js');
    }
    const filterBlock = source.slice(filterStart, filterEnd);

    const sandbox = {
        currentTests: { test_rules: [] },
        console,
    };
    vm.createContext(sandbox);
    // Wrap in a function so we can expose the needed symbols on globalThis.
    const script = `
${helpers}
${filterBlock}
globalThis.parseExtractFieldPath = parseExtractFieldPath;
globalThis.setExtractPath = setExtractPath;
globalThis.getExtractPath = getExtractPath;
globalThis.inflateExpectedOutput = inflateExpectedOutput;
globalThis.indexExtractFieldRules = indexExtractFieldRules;
globalThis.shortenFieldPathLabel = shortenFieldPathLabel;
globalThis.applyExtractFieldFilter = applyExtractFieldFilter;
globalThis.applyExtractCurrentPageFilter = applyExtractCurrentPageFilter;
globalThis._setCurrentTests = (v) => { currentTests = v; };
`;
    vm.runInContext(script, sandbox, { filename: annotatorPath });
    return sandbox;
}

describe('parseExtractFieldPath', () => {
    const { parseExtractFieldPath } = loadHelpers();

    it('parses simple scalar key', () => {
        assert.deepEqual(norm(parseExtractFieldPath('po_number')), ['po_number']);
    });

    it('parses dotted path', () => {
        assert.deepEqual(norm(parseExtractFieldPath('buyer.company')), ['buyer', 'company']);
    });

    it('parses array index', () => {
        assert.deepEqual(norm(parseExtractFieldPath('line_items[0]')), ['line_items', 0]);
    });

    it('parses nested array + dot', () => {
        assert.deepEqual(
            norm(parseExtractFieldPath('line_items[0].description')),
            ['line_items', 0, 'description'],
        );
    });

    it('parses double-index', () => {
        assert.deepEqual(norm(parseExtractFieldPath('grid[2][3]')), ['grid', 2, 3]);
    });

    it('throws on empty path', () => {
        assert.throws(() => parseExtractFieldPath(''));
    });
});

describe('inflateExpectedOutput', () => {
    const { inflateExpectedOutput } = loadHelpers();

    it('produces empty object from no rules', () => {
        assert.deepEqual(norm(inflateExpectedOutput([])), {});
    });

    it('rebuilds scalar + array + nested from flat rules', () => {
        const rules = [
            { type: 'extract_field', field_path: 'po_number', expected_value: 'PO-1' },
            { type: 'extract_field', field_path: 'line_items[0].description', expected_value: 'Widget' },
            { type: 'extract_field', field_path: 'line_items[0].quantity', expected_value: 3 },
            { type: 'extract_field', field_path: 'line_items[1].description', expected_value: 'Sprocket' },
        ];
        assert.deepEqual(norm(inflateExpectedOutput(rules)), {
            po_number: 'PO-1',
            line_items: [
                { description: 'Widget', quantity: 3 },
                { description: 'Sprocket' },
            ],
        });
    });

    it('first non-null value wins for duplicate paths', () => {
        const rules = [
            { type: 'extract_field', field_path: 'x', expected_value: 'a' },
            { type: 'extract_field', field_path: 'x', expected_value: 'b' },
        ];
        assert.deepEqual(norm(inflateExpectedOutput(rules)), { x: 'a' });
    });

    it('null scalar rule still produces null value at path', () => {
        const rules = [
            { type: 'extract_field', field_path: 'missing', expected_value: null },
        ];
        assert.deepEqual(norm(inflateExpectedOutput(rules)), { missing: null });
    });

    it('skips rules without field_path', () => {
        const rules = [
            { type: 'extract_field', expected_value: 'lost' },
            { type: 'extract_field', field_path: 'keep', expected_value: 'ok' },
        ];
        assert.deepEqual(norm(inflateExpectedOutput(rules)), { keep: 'ok' });
    });
});

describe('indexExtractFieldRules', () => {
    const helpers = loadHelpers();

    it('indexes rules by field_path and prefers non-stray entries', () => {
        helpers._setCurrentTests({
            test_rules: [
                { type: 'extract_field', field_path: 'foo', expected_value: null, tags: ['stray_evidence'] },
                { type: 'extract_field', field_path: 'foo', expected_value: 'real', tags: [] },
                { type: 'extract_field', field_path: 'bar', expected_value: 42 },
                { type: 'present', text: 'unrelated' },
            ],
        });
        const map = helpers.indexExtractFieldRules();
        assert.equal(map.size, 2);
        assert.equal(map.get('foo').expected_value, 'real');
        assert.equal(map.get('bar').expected_value, 42);
    });
});

describe('applyExtractFieldFilter', () => {
    const { applyExtractFieldFilter } = loadHelpers();

    const tree = [
        {
            key: 'group',
            type: 'object',
            path: 'group',
            children: [
                { key: 'verified_leaf', type: 'string', path: 'group.verified_leaf', verified: true },
                { key: 'unverified_leaf', type: 'string', path: 'group.unverified_leaf', verified: false },
                { key: 'no_rule_leaf', type: 'string', path: 'group.no_rule_leaf', verified: null },
            ],
        },
        { key: 'loose_verified', type: 'string', path: 'loose_verified', verified: true },
    ];

    it('returns the input untouched for filter=all', () => {
        const result = applyExtractFieldFilter(tree, 'all');
        assert.deepEqual(norm(result), norm(tree));
    });

    it('drops purely-verified leaves for filter=unverified', () => {
        const result = applyExtractFieldFilter(tree, 'unverified');
        // loose_verified (top-level verified leaf) dropped.
        // group keeps unverified_leaf and no_rule_leaf (verified != true).
        assert.equal(result.length, 1);
        assert.equal(result[0].key, 'group');
        const keptChildKeys = result[0].children.map((c) => c.key);
        assert.deepEqual(norm(keptChildKeys), ['unverified_leaf', 'no_rule_leaf']);
    });

    it('drops unverified leaves for filter=verified', () => {
        const result = applyExtractFieldFilter(tree, 'verified');
        assert.equal(result.length, 2);
        const groupResult = result[0];
        assert.equal(groupResult.key, 'group');
        assert.deepEqual(norm(groupResult.children.map((c) => c.key)), ['verified_leaf']);
        assert.equal(result[1].key, 'loose_verified');
    });

    it('keeps full array item records when any field needs review', () => {
        const result = applyExtractFieldFilter([
            {
                key: 'employees',
                type: 'array',
                path: 'employees',
                children: [
                    {
                        index: 17,
                        type: 'object',
                        path: 'employees[17]',
                        children: [
                            { key: 'birth_date', type: 'string', path: 'employees[17].birth_date', verified: true },
                            { key: 'sample_10_percent_vested', type: 'number', path: 'employees[17].sample_10_percent_vested', verified: false },
                            { key: 'name', type: 'string', path: 'employees[17].name', verified: true },
                            { key: 'total_vested_balance', type: 'number', path: 'employees[17].total_vested_balance', verified: true },
                        ],
                    },
                    {
                        index: 18,
                        type: 'object',
                        path: 'employees[18]',
                        children: [
                            { key: 'birth_date', type: 'string', path: 'employees[18].birth_date', verified: true },
                            { key: 'name', type: 'string', path: 'employees[18].name', verified: true },
                        ],
                    },
                ],
            },
        ], 'unverified');

        assert.equal(result.length, 1);
        assert.equal(result[0].key, 'employees');
        assert.equal(result[0].children.length, 1);
        assert.equal(result[0].children[0].index, 17);
        assert.deepEqual(
            norm(result[0].children[0].children.map((child) => child.key)),
            ['birth_date', 'sample_10_percent_vested', 'name', 'total_vested_balance'],
        );
    });
});

describe('applyExtractCurrentPageFilter', () => {
    const { applyExtractCurrentPageFilter } = loadHelpers();

    const tree = [
        {
            key: 'employees',
            type: 'array',
            path: 'employees',
            children: [
                {
                    index: 0,
                    type: 'object',
                    path: 'employees[0]',
                    children: [
                        {
                            key: 'name',
                            type: 'string',
                            path: 'employees[0].name',
                            rule: { bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1] }] },
                            bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1] }],
                        },
                        {
                            key: 'balance',
                            type: 'number',
                            path: 'employees[0].balance',
                            rule: null,
                            bboxes: [],
                        },
                    ],
                },
                {
                    index: 1,
                    type: 'object',
                    path: 'employees[1]',
                    children: [
                        {
                            key: 'name',
                            type: 'string',
                            path: 'employees[1].name',
                            rule: { bboxes: [{ page: 2, bbox: [0, 0, 0.1, 0.1] }] },
                            bboxes: [{ page: 2, bbox: [0, 0, 0.1, 0.1] }],
                        },
                    ],
                },
            ],
        },
        {
            key: '__unassigned__',
            type: 'unassigned-group',
            path: '__unassigned__',
            children: [
                {
                    type: 'unassigned-stray',
                    path: '__unassigned__/stray-p1',
                    rule: { bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1] }] },
                    bboxes: [{ page: 1, bbox: [0, 0, 0.1, 0.1] }],
                },
                {
                    type: 'unassigned-stray',
                    path: '__unassigned__/stray-p3',
                    rule: { bboxes: [{ page: 3, bbox: [0, 0, 0.1, 0.1] }] },
                    bboxes: [{ page: 3, bbox: [0, 0, 0.1, 0.1] }],
                },
            ],
        },
    ];

    it('keeps only leaves and strays with bboxes on the requested page', () => {
        const result = applyExtractCurrentPageFilter(tree, 1);
        assert.equal(result.length, 2);
        assert.equal(result[0].key, 'employees');
        assert.equal(result[0].children.length, 1);
        assert.equal(result[0].children[0].index, 0);
        assert.deepEqual(
            norm(result[0].children[0].children.map((entry) => entry.path)),
            ['employees[0].name'],
        );
        assert.equal(result[1].type, 'unassigned-group');
        assert.deepEqual(norm(result[1].children.map((entry) => entry.path)), ['__unassigned__/stray-p1']);
    });

    it('returns an empty tree when no fields can be visualized on that page', () => {
        assert.deepEqual(norm(applyExtractCurrentPageFilter(tree, 99)), []);
    });
});

describe('shortenFieldPathLabel', () => {
    const { shortenFieldPathLabel } = loadHelpers();

    it('returns leaf key for dotted path', () => {
        assert.equal(shortenFieldPathLabel('line_items[0].description'), 'description');
    });

    it('returns scalar path as-is', () => {
        assert.equal(shortenFieldPathLabel('po_number'), 'po_number');
    });

    it('handles plain array index', () => {
        assert.equal(shortenFieldPathLabel('items[3]'), 'items[3]');
    });
});
