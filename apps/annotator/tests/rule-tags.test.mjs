import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../rule_tags.js');
const require = createRequire(import.meta.url);

const ruleTags = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

describe('rule tags module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof ruleTags.dedupeTags, 'function');
        assert.equal(typeof importedModule.default.dedupeTags, 'function');
        assert.equal(importedModule.default.renderRuleTagsHtml, ruleTags.renderRuleTagsHtml);

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorRuleTags.applyRuleTags,
            'function',
        );
    });
});

describe('dedupeTags', () => {
    it('trims input, preserves first casing, and removes case-insensitive duplicates', () => {
        assert.deepEqual(
            ruleTags.dedupeTags([' alpha ', 'Alpha', 'BETA', 'beta', '', '  ', null]),
            ['alpha', 'BETA'],
        );
    });
});

describe('applyRuleTags', () => {
    it('writes non-empty normalized tags and removes the field when empty', () => {
        const rule = { type: 'layout', tags: ['legacy'] };

        const updated = ruleTags.applyRuleTags(rule, ['  Needs Review ', 'needs review', 'table']);
        assert.deepEqual(updated, ['Needs Review', 'table']);
        assert.deepEqual(rule.tags, ['Needs Review', 'table']);

        const cleared = ruleTags.applyRuleTags(rule, []);
        assert.deepEqual(cleared, []);
        assert.equal('tags' in rule, false);
    });
});

describe('renderRuleTagsHtml', () => {
    it('renders visible chips only when tags are present', () => {
        const html = ruleTags.renderRuleTagsHtml(['alpha', 'beta'], {
            containerClass: 'markdown-card-tags',
        });

        assert.match(html, /markdown-card-tags/);
        assert.match(html, /alpha/);
        assert.match(html, /beta/);
        assert.equal(ruleTags.renderRuleTagsHtml([], { containerClass: 'x' }), '');
    });
});
