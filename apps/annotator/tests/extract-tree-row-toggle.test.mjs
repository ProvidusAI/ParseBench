import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

describe('extract tree row expansion', () => {
    const source = fs.readFileSync(annotatorPath, 'utf-8');

    it('uses one expansion helper for chevron and object/array row clicks', () => {
        assert.match(source, /function toggleExtractNodeExpansion\(node\)/);

        const listenerStart = source.indexOf("elements.extractKvRows.addEventListener('click'");
        assert.ok(listenerStart > 0, 'could not locate extract tree click listener');
        const listenerEnd = source.indexOf("elements.extractKvRows.addEventListener('mouseover'", listenerStart);
        assert.ok(listenerEnd > listenerStart, 'could not locate end of extract tree click listener');
        const listenerBody = source.slice(listenerStart, listenerEnd);

        assert.match(
            listenerBody,
            /const toggle = event\.target\.closest\('\.extract-node-toggle'\);[\s\S]*toggleExtractNodeExpansion\(node\);/,
            'chevron clicks should use the shared expansion helper',
        );
        assert.match(
            listenerBody,
            /if \(nodeType === 'object' \|\| nodeType === 'array'\) \{[\s\S]*toggleExtractNodeExpansion\(node\);[\s\S]*return;/,
            'clicking object/array row bodies should expand or collapse the tree node',
        );
        assert.match(
            listenerBody,
            /const isControlClick = event\.target\.closest\('input, textarea, select, button'\);/,
            'object/array row controls, including key textareas, should keep their native click behavior',
        );
    });
});
