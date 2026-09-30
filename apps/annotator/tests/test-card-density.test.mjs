import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');
const cssPath = path.resolve(__dirname, '../annotator.css');

describe('test card density', () => {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const css = fs.readFileSync(cssPath, 'utf-8');

    it('keeps rule tags in the header instead of a separate vertical row', () => {
        const renderStart = source.indexOf('function renderTestList()');
        assert.ok(renderStart > 0, 'could not locate renderTestList()');
        const renderEnd = source.indexOf('\nasync function markFileStatus', renderStart);
        assert.ok(renderEnd > renderStart, 'could not locate end of renderTestList()');
        const renderBody = source.slice(renderStart, renderEnd);

        assert.match(renderBody, /containerClass:\s*'test-item-header-tags'/);
        assert.match(renderBody, /chipClass:\s*'tag-chip test-item-header-tag'/);
        assert.match(renderBody, /\$\{idBadge\}\s*\$\{tagsHtml\}/);
        assert.doesNotMatch(renderBody, /<div class="test-item-content">\$\{content\}<\/div>\s*\$\{tagsHtml\}/);
        assert.match(css, /\.test-item-header-tags\s*{[^}]*display:\s*inline-flex;/s);
        assert.match(css, /\.test-item-header-tag\s*{[^}]*font-size:\s*10px;/s);
    });

    it('does not duplicate verification state in rule summary fields', () => {
        const summaryStart = source.indexOf('function renderRuleSummaryFromDefinition');
        assert.ok(summaryStart > 0, 'could not locate renderRuleSummaryFromDefinition()');
        const summaryEnd = source.indexOf('\n// === Test Types Functions ===', summaryStart);
        assert.ok(summaryEnd > summaryStart, 'could not locate end of renderRuleSummaryFromDefinition()');
        const summaryBody = source.slice(summaryStart, summaryEnd);

        assert.match(summaryBody, /new Set\(\['verified'\]\)/);
        assert.match(summaryBody, /if \(hiddenSummaryFields\.has\(fieldName\)\) continue;/);
    });
});
