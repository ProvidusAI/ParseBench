import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../reading_order.js');
const require = createRequire(import.meta.url);

const readingOrder = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

function cloneRules(rules) {
    return JSON.parse(JSON.stringify(rules));
}

describe('module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof readingOrder.getPageReadingOrder, 'function');
        assert.equal(typeof importedModule.default.getPageReadingOrder, 'function');
        assert.equal(
            importedModule.default.commitNormalizedPageReadingOrder,
            readingOrder.commitNormalizedPageReadingOrder,
        );

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorReadingOrder.getPageReadingOrder,
            'function',
        );
    });
});

describe('getPageReadingOrder', () => {
    it('orders one page deterministically and preserves original indexes', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 2 },
            { id: 'b', type: 'layout', page: 1, ro_index: 'bad' },
            { id: 'text-check', type: 'present', text: 'ignore me' },
            { id: 'c', type: 'layout', page: 1, ro_index: 0 },
            { id: 'd', type: 'layout', page: 2, ro_index: 0 },
            { id: 'e', type: 'layout', ro_index: 1 },
            { id: 'f', type: 'layout', page: 1, ro_index: 2 },
            { id: 'g', type: 'layout', page: 1, ro_index: null },
        ]);

        const ordered = readingOrder.getPageReadingOrder(rules, 1);

        assert.deepEqual(
            ordered.map((entry) => ({
                id: entry.rule.id,
                originalIndex: entry.originalIndex,
                rawRoIndex: entry.rawRoIndex,
                roIndex: entry.roIndex,
                needsCommit: entry.needsCommit,
            })),
            [
                { id: 'c', originalIndex: 3, rawRoIndex: 0, roIndex: 0, needsCommit: false },
                { id: 'e', originalIndex: 5, rawRoIndex: 1, roIndex: 1, needsCommit: false },
                { id: 'a', originalIndex: 0, rawRoIndex: 2, roIndex: 2, needsCommit: false },
                { id: 'f', originalIndex: 6, rawRoIndex: 2, roIndex: 3, needsCommit: true },
                { id: 'b', originalIndex: 1, rawRoIndex: 'bad', roIndex: 4, needsCommit: true },
                { id: 'g', originalIndex: 7, rawRoIndex: null, roIndex: 5, needsCommit: true },
            ],
        );
    });

    it('treats legacy page-less rules as page 1 only in multi-page documents', () => {
        const rules = cloneRules([
            { id: 'page-1', type: 'layout', page: 1, ro_index: 0 },
            { id: 'legacy', type: 'layout', ro_index: 1 },
            { id: 'page-2', type: 'layout', page: 2, ro_index: 0 },
        ]);

        assert.deepEqual(
            readingOrder.getPageReadingOrder(rules, 1).map((entry) => entry.rule.id),
            ['page-1', 'legacy'],
        );
        assert.deepEqual(
            readingOrder.getPageReadingOrder(rules, 2).map((entry) => entry.rule.id),
            ['page-2'],
        );
    });
});

describe('commitNormalizedPageReadingOrder', () => {
    it('writes contiguous page-local ro_index values back to test_rules', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 2 },
            { id: 'b', type: 'layout', page: 1, ro_index: 'bad' },
            { id: 'text-check', type: 'present', text: 'ignore me' },
            { id: 'c', type: 'layout', page: 1, ro_index: 0 },
            { id: 'd', type: 'layout', page: 2, ro_index: 0 },
            { id: 'e', type: 'layout', ro_index: 1 },
            { id: 'f', type: 'layout', page: 1, ro_index: 2 },
            { id: 'g', type: 'layout', page: 1, ro_index: null },
        ]);

        const committed = readingOrder.commitNormalizedPageReadingOrder(rules, 1);

        assert.deepEqual(
            committed.map((entry) => [entry.rule.id, entry.roIndex]),
            [
                ['c', 0],
                ['e', 1],
                ['a', 2],
                ['f', 3],
                ['b', 4],
                ['g', 5],
            ],
        );

        assert.equal(rules[3].ro_index, 0);
        assert.equal(rules[5].ro_index, 1);
        assert.equal(rules[0].ro_index, 2);
        assert.equal(rules[6].ro_index, 3);
        assert.equal(rules[1].ro_index, 4);
        assert.equal(rules[7].ro_index, 5);
        assert.equal(rules[4].ro_index, 0);
        assert.equal('ro_index' in rules[2], false);
    });

    it('supports add and in-place edit flows without disturbing page-local order', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 0, content: { type: 'text', text: 'Alpha' } },
            { id: 'b', type: 'layout', page: 1, ro_index: 1, content: { type: 'text', text: 'Beta' } },
            { id: 'c', type: 'layout', page: 2, ro_index: 0, content: { type: 'text', text: 'Gamma' } },
            { id: 'new', type: 'layout', page: 1, content: { type: 'text', text: 'New item' } },
        ]);

        rules[1].content.text = 'Beta updated';

        const committed = readingOrder.commitNormalizedPageReadingOrder(rules, 1);

        assert.deepEqual(
            committed.map((entry) => [entry.rule.id, entry.roIndex]),
            [
                ['a', 0],
                ['b', 1],
                ['new', 2],
            ],
        );
        assert.equal(rules[1].content.text, 'Beta updated');
        assert.equal(rules[3].ro_index, 2);
        assert.equal(rules[2].ro_index, 0);
    });
});

describe('movePageReadingOrderItem', () => {
    it('moves by original index without reordering test_rules', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 0 },
            { id: 'b', type: 'layout', page: 1, ro_index: 1 },
            { id: 'c', type: 'layout', page: 1, ro_index: 2 },
            { id: 'd', type: 'layout', page: 1, ro_index: 3 },
        ]);

        const moved = readingOrder.movePageReadingOrderItem(rules, 1, 1, 3);

        assert.deepEqual(moved.map((entry) => entry.rule.id), ['a', 'c', 'd', 'b']);
        assert.deepEqual(rules.map((rule) => rule.id), ['a', 'b', 'c', 'd']);
        assert.deepEqual(rules.map((rule) => rule.ro_index), [0, 3, 1, 2]);
    });
});

describe('insertPageReadingOrderItem', () => {
    it('inserts an existing page rule before another original index', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 0 },
            { id: 'b', type: 'layout', page: 1, ro_index: 1 },
            { id: 'x', type: 'layout', page: 1 },
            { id: 'c', type: 'layout', page: 1, ro_index: 2 },
            { id: 'other-page', type: 'layout', page: 2, ro_index: 0 },
        ]);

        const inserted = readingOrder.insertPageReadingOrderItem(rules, 1, 2, 1);

        assert.deepEqual(inserted.map((entry) => entry.rule.id), ['a', 'x', 'b', 'c']);
        assert.deepEqual(
            rules.map((rule) => [rule.id, rule.ro_index]),
            [
                ['a', 0],
                ['b', 2],
                ['x', 1],
                ['c', 3],
                ['other-page', 0],
            ],
        );
    });

    it('resolves before and after anchors without reordering test_rules', () => {
        const baseRules = [
            { id: 'a', type: 'layout', page: 1, ro_index: 0 },
            { id: 'b', type: 'layout', page: 1, ro_index: 1 },
            { id: 'x', type: 'layout', page: 1 },
            { id: 'c', type: 'layout', page: 1, ro_index: 2 },
            { id: 'other-page', type: 'layout', page: 2, ro_index: 0 },
        ];

        const beforeRules = cloneRules(baseRules);
        const beforeOrdered = readingOrder.getPageReadingOrder(beforeRules, 1);
        const beforeOriginalIndex = readingOrder.resolveRelativeInsertBeforeOriginalIndex(
            beforeOrdered,
            1,
            'before',
        );
        const insertedBefore = readingOrder.insertPageReadingOrderItem(beforeRules, 1, 2, beforeOriginalIndex);

        assert.equal(beforeOriginalIndex, 1);
        assert.deepEqual(insertedBefore.map((entry) => entry.rule.id), ['a', 'x', 'b', 'c']);
        assert.deepEqual(beforeRules.map((rule) => rule.id), ['a', 'b', 'x', 'c', 'other-page']);
        assert.deepEqual(
            beforeRules.map((rule) => [rule.id, rule.ro_index]),
            [
                ['a', 0],
                ['b', 2],
                ['x', 1],
                ['c', 3],
                ['other-page', 0],
            ],
        );

        const afterRules = cloneRules(baseRules);
        const afterOrdered = readingOrder.getPageReadingOrder(afterRules, 1);
        const afterBeforeOriginalIndex = readingOrder.resolveRelativeInsertBeforeOriginalIndex(
            afterOrdered,
            1,
            'after',
        );
        const insertedAfter = readingOrder.insertPageReadingOrderItem(afterRules, 1, 2, afterBeforeOriginalIndex);

        assert.equal(afterBeforeOriginalIndex, 3);
        assert.deepEqual(insertedAfter.map((entry) => entry.rule.id), ['a', 'b', 'x', 'c']);
        assert.deepEqual(afterRules.map((rule) => rule.id), ['a', 'b', 'x', 'c', 'other-page']);
        assert.deepEqual(
            afterRules.map((rule) => [rule.id, rule.ro_index]),
            [
                ['a', 0],
                ['b', 1],
                ['x', 2],
                ['c', 3],
                ['other-page', 0],
            ],
        );
    });

    it('appends to the end when no beforeOriginalIndex is provided', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 0 },
            { id: 'b', type: 'layout', page: 1, ro_index: 1 },
            { id: 'x', type: 'layout', page: 1 },
            { id: 'other-page', type: 'layout', page: 2, ro_index: 0 },
        ]);

        const inserted = readingOrder.insertPageReadingOrderItem(rules, 1, 2);

        assert.deepEqual(inserted.map((entry) => entry.rule.id), ['a', 'b', 'x']);
        assert.deepEqual(
            rules.map((rule) => [rule.id, rule.ro_index]),
            [
                ['a', 0],
                ['b', 1],
                ['x', 2],
                ['other-page', 0],
            ],
        );
    });
});

describe('removePageReadingOrderItem', () => {
    it('removes the referenced rule from test_rules and compacts only that page scope', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 0 },
            { id: 'other-page', type: 'layout', page: 2, ro_index: 0 },
            { id: 'b', type: 'layout', page: 1, ro_index: 1 },
            { id: 'c', type: 'layout', page: 1, ro_index: 2 },
        ]);

        const remaining = readingOrder.removePageReadingOrderItem(rules, 1, 2);

        assert.deepEqual(rules.map((rule) => rule.id), ['a', 'other-page', 'c']);
        assert.deepEqual(
            remaining.map((entry) => [entry.rule.id, entry.originalIndex, entry.roIndex]),
            [
                ['a', 0, 0],
                ['c', 2, 1],
            ],
        );
        assert.equal(rules[1].ro_index, 0);
        assert.equal(rules[2].ro_index, 1);
    });
});

describe('cross-page workflows', () => {
    it('supports moving a layout rule between pages while normalizing both pages', () => {
        const rules = cloneRules([
            { id: 'a', type: 'layout', page: 1, ro_index: 0 },
            { id: 'b', type: 'layout', page: 1, ro_index: 1 },
            { id: 'c', type: 'layout', page: 2, ro_index: 0 },
        ]);

        rules[1].page = 2;
        delete rules[1].ro_index;

        const page1 = readingOrder.commitNormalizedPageReadingOrder(rules, 1);
        const page2 = readingOrder.insertPageReadingOrderItem(rules, 2, 1);

        assert.deepEqual(page1.map((entry) => [entry.rule.id, entry.roIndex]), [['a', 0]]);
        assert.deepEqual(page2.map((entry) => [entry.rule.id, entry.roIndex]), [
            ['c', 0],
            ['b', 1],
        ]);
        assert.deepEqual(
            rules.map((rule) => [rule.id, rule.page, rule.ro_index]),
            [
                ['a', 1, 0],
                ['b', 2, 1],
                ['c', 2, 0],
            ],
        );
    });
});
