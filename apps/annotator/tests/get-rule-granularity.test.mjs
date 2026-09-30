import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Tests for `getRuleGranularity`. The helper resolves the canonical
 * granularity for any layout rule in `currentTests.test_rules`. It is
 * the single source of truth for backwards-compat with legacy
 * datasets (which never set the field) and for routing
 * `attributes.scope === 'mark'` checkbox marks regardless of declared
 * granularity.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadHelper() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const match = source.match(/function getRuleGranularity\([\s\S]*?\n\}/);
    if (!match) throw new Error('Could not locate getRuleGranularity in annotator.js');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${match[0]}; globalThis._getRuleGranularity = getRuleGranularity;`, sandbox);
    return sandbox._getRuleGranularity;
}

describe('getRuleGranularity', () => {
    const getRuleGranularity = loadHelper();

    it('returns null for non-layout rules', () => {
        assert.equal(getRuleGranularity({ type: 'present', text: 'x' }), null);
        assert.equal(getRuleGranularity({ type: 'absent', text: 'x' }), null);
        assert.equal(getRuleGranularity({ type: 'order' }), null);
    });

    it('returns null for falsy / malformed input', () => {
        assert.equal(getRuleGranularity(null), null);
        assert.equal(getRuleGranularity(undefined), null);
        assert.equal(getRuleGranularity({}), null);
        assert.equal(getRuleGranularity({ type: '' }), null);
    });

    it('defaults missing or null granularity to "region" for layout rules', () => {
        assert.equal(getRuleGranularity({ type: 'layout' }), 'region');
        assert.equal(getRuleGranularity({ type: 'layout', granularity: null }), 'region');
        assert.equal(getRuleGranularity({ type: 'layout', granularity: undefined }), 'region');
    });

    it('honors explicit granularity values', () => {
        assert.equal(getRuleGranularity({ type: 'layout', granularity: 'line' }), 'line');
        assert.equal(getRuleGranularity({ type: 'layout', granularity: 'word' }), 'word');
    });

    it('treats unknown granularity strings as region (forwards-compat for cells later)', () => {
        // Schema only allows region/line/word today; if a future "cell"
        // shows up before the helper is updated we fall back to region
        // so the rule still appears in the default filter.
        assert.equal(getRuleGranularity({ type: 'layout', granularity: 'cell' }), 'region');
        assert.equal(getRuleGranularity({ type: 'layout', granularity: 'paragraph' }), 'region');
    });

    it('promotes scope=mark to "checkbox" regardless of declared granularity', () => {
        assert.equal(
            getRuleGranularity({
                type: 'layout',
                attributes: { scope: 'mark' },
            }),
            'checkbox',
        );
        assert.equal(
            getRuleGranularity({
                type: 'layout',
                granularity: 'line',
                attributes: { scope: 'mark' },
            }),
            'checkbox',
        );
        assert.equal(
            getRuleGranularity({
                type: 'layout',
                granularity: 'word',
                attributes: { scope: 'MARK' },
            }),
            'checkbox',
        );
    });

    it('does not treat scope=region or other scope values as checkbox', () => {
        assert.equal(
            getRuleGranularity({
                type: 'layout',
                attributes: { scope: 'region' },
            }),
            'region',
        );
        assert.equal(
            getRuleGranularity({
                type: 'layout',
                granularity: 'line',
                attributes: { scope: '' },
            }),
            'line',
        );
        // Non-string scope is ignored.
        assert.equal(
            getRuleGranularity({
                type: 'layout',
                granularity: 'word',
                attributes: { scope: true },
            }),
            'word',
        );
    });
});
