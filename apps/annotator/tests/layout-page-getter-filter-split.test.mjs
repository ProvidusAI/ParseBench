import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Regression guard for the UI/data boundary between
 * `getOrderedLayoutTestsForPage` (data-mutation callers — reading
 * order assignment, expected-markdown generation, ...) and
 * `getFilteredLayoutTestsForPage` (display-only callers — overlay
 * rendering, markdown panel).
 *
 * Adding `ruleMatchesActiveFilters` to the shared
 * `getOrderedLayoutTestsForPage` silently drops rules from
 * `generateExpectedMarkdown`, `commitPageReadingOrder`, etc. This
 * test asserts the split: the unfiltered getter must ignore the
 * granularity filter, and the wrapper must honor it.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadGetters() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const helpers = [
        'getRuleGranularity',
        'parseRuleTagFilterTokens',
        'ruleMatchesActiveFilters',
        'getLayoutRulePageNumber',
        'getOrderedLayoutTestsForPage',
        'getFilteredLayoutTestsForPage',
    ];
    const blocks = helpers.map(name => {
        const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
        const match = source.match(re);
        if (!match) throw new Error(`Could not locate ${name} in annotator.js`);
        return match[0];
    });
    const sandbox = {
        currentTests: null,
        pageNum: 1,
        ruleListTypeFilter: '',
        ruleListGranularityFilter: '',
        ruleListTagFilter: '',
        layoutPageHelpers: null,
        readingOrderHelpers: null,
    };
    vm.createContext(sandbox);
    vm.runInContext(`
        ${blocks.join('\n')}
        globalThis._setState = (tests, page, granularity) => {
            globalThis.currentTests = tests;
            globalThis.pageNum = page;
            globalThis.ruleListGranularityFilter = granularity || '';
        };
        globalThis._unfiltered = getOrderedLayoutTestsForPage;
        globalThis._filtered = getFilteredLayoutTestsForPage;
    `, sandbox);
    return { setState: sandbox._setState, unfiltered: sandbox._unfiltered, filtered: sandbox._filtered };
}

const SAMPLE_TESTS = {
    test_rules: [
        { type: 'layout', page: 1, granularity: 'region', bbox: [0, 0, 1, 0.1], canonical_class: 'Text' },
        { type: 'layout', page: 1, granularity: 'line', bbox: [0, 0.1, 1, 0.05], canonical_class: 'Text' },
        { type: 'layout', page: 1, granularity: 'word', bbox: [0, 0.15, 0.2, 0.05], canonical_class: 'Text' },
        { type: 'layout', page: 1, attributes: { scope: 'mark' }, bbox: [0, 0.2, 0.05, 0.05], canonical_class: 'Checkbox-Selected' },
        { type: 'layout', page: 2, granularity: 'region', bbox: [0, 0, 1, 0.1], canonical_class: 'Text' },
        { type: 'present', text: 'page-agnostic rule' },
    ],
};

describe('getOrderedLayoutTestsForPage — unfiltered (data-mutation path)', () => {
    const { setState, unfiltered } = loadGetters();

    it('returns ALL layout rules for the page regardless of granularity filter', () => {
        setState(SAMPLE_TESTS, 1, 'region');
        const result = unfiltered(1);
        // Filter is set to 'region' but the unfiltered getter must
        // ignore it — reading-order / expected-markdown / etc. need
        // the full set.
        assert.equal(result.length, 4, 'should return all 4 layout rules on page 1');
    });

    it('respects page filter', () => {
        setState(SAMPLE_TESTS, 1, '');
        assert.equal(unfiltered(1).length, 4);
        assert.equal(unfiltered(2).length, 1);
    });

    it('returns ALL layout rules even when granularity filter is "checkbox"', () => {
        // With the filter routed through the shared getter,
        // generateExpectedMarkdown / commitPageReadingOrder would only
        // see checkbox rules, silently dropping the rest.
        setState(SAMPLE_TESTS, 1, 'checkbox');
        assert.equal(unfiltered(1).length, 4, 'data path must ignore UI granularity filter');
    });
});

describe('getFilteredLayoutTestsForPage — display-only', () => {
    const { setState, filtered } = loadGetters();

    it('honors the granularity filter for display', () => {
        setState(SAMPLE_TESTS, 1, 'region');
        const result = filtered(1);
        assert.equal(result.length, 1, 'only 1 region rule on page 1');
        assert.equal(result[0].canonical_class, 'Text');
    });

    it('returns line rules only when filter is line', () => {
        setState(SAMPLE_TESTS, 1, 'line');
        const result = filtered(1);
        assert.equal(result.length, 1);
        assert.equal(result[0].granularity, 'line');
    });

    it('returns word rules only when filter is word', () => {
        setState(SAMPLE_TESTS, 1, 'word');
        const result = filtered(1);
        assert.equal(result.length, 1);
        assert.equal(result[0].granularity, 'word');
    });

    it('returns mark-scope checkboxes only when filter is checkbox', () => {
        setState(SAMPLE_TESTS, 1, 'checkbox');
        const result = filtered(1);
        assert.equal(result.length, 1);
        assert.equal(result[0].canonical_class, 'Checkbox-Selected');
    });

    it('returns all granularities when filter is empty (== "all")', () => {
        setState(SAMPLE_TESTS, 1, '');
        assert.equal(filtered(1).length, 4);
    });
});
