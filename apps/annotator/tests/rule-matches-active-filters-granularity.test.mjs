import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Tests for the granularity clause inside `ruleMatchesActiveFilters`.
 *
 * The helper has three filter clauses:
 *   - rule type filter (existing)
 *   - granularity filter (new — only applies to layout rules)
 *   - tag filter (existing)
 *
 * Non-layout rules must pass the granularity gate unconditionally so
 * that switching the layout granularity filter never accidentally
 * hides parse rules (present, absent, order, ...).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadFilterHelper() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const ruleMatch = source.match(/function ruleMatchesActiveFilters\([\s\S]*?\n\}/);
    const granularityMatch = source.match(/function getRuleGranularity\([\s\S]*?\n\}/);
    const parseTokens = source.match(/function parseRuleTagFilterTokens\([\s\S]*?\n\}/);
    if (!ruleMatch || !granularityMatch || !parseTokens) {
        throw new Error('Could not locate filter helpers in annotator.js');
    }
    const sandbox = {
        ruleListTypeFilter: '',
        ruleListGranularityFilter: '',
        ruleListTagFilter: '',
    };
    vm.createContext(sandbox);
    const code = `
        ${granularityMatch[0]};
        ${parseTokens[0]};
        ${ruleMatch[0]};
        globalThis._setFilters = (type, granularity, tag) => {
            globalThis.ruleListTypeFilter = type || '';
            globalThis.ruleListGranularityFilter = granularity || '';
            globalThis.ruleListTagFilter = tag || '';
        };
        globalThis._matches = ruleMatchesActiveFilters;
    `;
    vm.runInContext(code, sandbox);
    return {
        setFilters: sandbox._setFilters,
        matches: sandbox._matches,
    };
}

describe('ruleMatchesActiveFilters — granularity clause', () => {
    const { setFilters, matches } = loadFilterHelper();

    it('default region filter accepts legacy layout rules with no granularity field', () => {
        setFilters('', 'region', '');
        const legacyRule = { type: 'layout', bbox: [0, 0, 1, 1], canonical_class: 'Text' };
        assert.equal(matches(legacyRule), true);
    });

    it('default region filter accepts explicit granularity=region', () => {
        setFilters('', 'region', '');
        assert.equal(matches({ type: 'layout', granularity: 'region' }), true);
    });

    it('default region filter rejects line and word rules', () => {
        setFilters('', 'region', '');
        assert.equal(matches({ type: 'layout', granularity: 'line' }), false);
        assert.equal(matches({ type: 'layout', granularity: 'word' }), false);
    });

    it('default region filter rejects mark-scope checkboxes (they need the explicit checkbox filter)', () => {
        setFilters('', 'region', '');
        assert.equal(
            matches({ type: 'layout', attributes: { scope: 'mark' } }),
            false,
        );
    });

    it('checkbox filter accepts scope=mark rules and rejects everything else', () => {
        setFilters('', 'checkbox', '');
        assert.equal(
            matches({ type: 'layout', attributes: { scope: 'mark' } }),
            true,
        );
        assert.equal(matches({ type: 'layout', granularity: 'line' }), false);
        assert.equal(matches({ type: 'layout' }), false);
    });

    it('empty granularity filter (== "all") accepts every layout granularity', () => {
        setFilters('', '', '');
        assert.equal(matches({ type: 'layout' }), true);
        assert.equal(matches({ type: 'layout', granularity: 'line' }), true);
        assert.equal(matches({ type: 'layout', granularity: 'word' }), true);
        assert.equal(
            matches({ type: 'layout', attributes: { scope: 'mark' } }),
            true,
        );
    });

    it('granularity filter does not gate non-layout rules', () => {
        setFilters('', 'word', '');
        // present/absent/order/etc. rules pass the granularity gate
        // unconditionally so a labeller flipping to "Words" doesn't
        // hide their text-presence assertions.
        assert.equal(matches({ type: 'present', text: 'foo' }), true);
        assert.equal(matches({ type: 'absent', text: 'bar' }), true);
        assert.equal(matches({ type: 'order', before: 'a', after: 'b' }), true);
    });

    it('granularity clause composes with rule-type filter', () => {
        setFilters('layout', 'word', '');
        assert.equal(matches({ type: 'layout', granularity: 'word' }), true);
        assert.equal(matches({ type: 'layout', granularity: 'line' }), false);
        assert.equal(matches({ type: 'present', text: 'x' }), false);
    });

    it('granularity clause composes with tag filter', () => {
        setFilters('', 'line', 'auto');
        assert.equal(
            matches({ type: 'layout', granularity: 'line', tags: ['auto-generated'] }),
            true,
        );
        assert.equal(
            matches({ type: 'layout', granularity: 'line', tags: ['manual'] }),
            false,
        );
        assert.equal(
            matches({ type: 'layout', granularity: 'word', tags: ['auto-generated'] }),
            false,
        );
    });
});
