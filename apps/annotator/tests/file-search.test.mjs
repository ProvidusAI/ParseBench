import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');
const source = fs.readFileSync(annotatorPath, 'utf-8');

function loadFileSearchHelpers() {
    const escapeHtmlMatch = source.match(/function escapeHtml\([\s\S]*?\n\}/);
    const inlineLiteralMatch = source.match(/function inlineJsStringLiteral\([\s\S]*?\n\}/);
    const normalizeMatch = source.match(/function normalizeFileSearchQuery\([\s\S]*?\n\}/);
    const matcherMatch = source.match(/function fileMatchesSearchQuery\([\s\S]*?\n\}/);
    if (!escapeHtmlMatch || !inlineLiteralMatch || !normalizeMatch || !matcherMatch) throw new Error('Could not locate file search helpers');

    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        [
            escapeHtmlMatch[0],
            inlineLiteralMatch[0],
            normalizeMatch[0],
            matcherMatch[0],
            'globalThis.fileMatchesSearchQuery = fileMatchesSearchQuery;',
            'globalThis.inlineJsStringLiteral = inlineJsStringLiteral;',
        ].join('\n'),
        sandbox,
    );
    return {
        fileMatchesSearchQuery: sandbox.fileMatchesSearchQuery,
        inlineJsStringLiteral: sandbox.inlineJsStringLiteral,
    };
}

describe('file search', () => {
    const { fileMatchesSearchQuery, inlineJsStringLiteral } = loadFileSearchHelpers();
    const file = {
        name: 'sample_statement_2.pdf',
        path: 'sample_docs/monthly/sample_statement_2.pdf',
        group: 'sample_docs/monthly',
    };

    it('matches file names case-insensitively', () => {
        assert.equal(fileMatchesSearchQuery(file, 'SAMPLE_statement'), true);
    });

    it('matches nested folder paths and groups', () => {
        assert.equal(fileMatchesSearchQuery(file, 'monthly'), true);
        assert.equal(fileMatchesSearchQuery(file, 'sample_docs statement_2'), true);
    });

    it('requires every search term to match somewhere in the file metadata', () => {
        assert.equal(fileMatchesSearchQuery(file, 'sample missing'), false);
    });

    it('escapes group names safely for inline collapse handlers', () => {
        assert.equal(inlineJsStringLiteral("it's_a_test"), '&quot;it&#39;s_a_test&quot;');
        assert.equal(inlineJsStringLiteral('folder/"quoted"/<tag>'), '&quot;folder/\\&quot;quoted\\&quot;/&lt;tag&gt;&quot;');
        assert.doesNotMatch(source, /toggleGroup\(decodeURIComponent\('\$\{encodedGroup\}'\)\)/);
    });
});
