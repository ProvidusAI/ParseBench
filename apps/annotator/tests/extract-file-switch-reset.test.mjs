import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Regression test for per-file extract bbox state. These variables must be
 * cleared in selectFile() so pending undo / draw state cannot leak across files.
 *
 * We grep annotator.js for the block that runs on file switch and
 * assert that every per-file extract bbox state variable is reset there.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

describe('file-switch state reset', () => {
    const source = fs.readFileSync(annotatorPath, 'utf-8');

    // Locate the selectFile() body. Looking for the assignment to
    // `currentTests = await fetchTests(currentFile.path);` as an anchor.
    const anchorIdx = source.indexOf('currentTests = await fetchTests(currentFile.path);');
    assert.ok(anchorIdx > 0, 'could not locate selectFile() load site');

    // Grab the ~400 chars before the anchor — this is where we reset
    // per-file state.
    const preamble = source.slice(Math.max(0, anchorIdx - 400), anchorIdx);

    const mustReset = [
        'selectedExtractFieldPath = null',
        'selectedExtractBboxIndex = null',
        // per-file extract bbox state:
        'extractBboxEditMode = null',
        'extractBboxEditStart = null',
        'extractBboxSuppressNextClick = false',
        'extractDrawContext = null',
        'lastExtractReassignment = null',
        // Also the expand-state sets from the UX follow-up:
        'expandedExtractPaths.clear()',
        'collapsedExtractPaths.clear()',
    ];

    for (const stmt of mustReset) {
        it(`selectFile() resets: ${stmt}`, () => {
            assert.ok(
                preamble.includes(stmt),
                `expected selectFile() preamble to include \`${stmt}\`; got:\n${preamble}`,
            );
        });
    }
});

describe('toggleAiSelectMode off-branch clears extractDrawContext', () => {
    const source = fs.readFileSync(annotatorPath, 'utf-8');

    it('clears extractDrawContext on exit', () => {
        // Find the off branch: `} else {` after `if (aiSelectMode) {`
        // inside toggleAiSelectMode.
        const fnStart = source.indexOf('function toggleAiSelectMode(');
        assert.ok(fnStart > 0);
        const fnEnd = source.indexOf('\nfunction ', fnStart + 1);
        const fnBody = source.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
        // off branch must null out extractDrawContext
        const elseIdx = fnBody.indexOf('} else {');
        assert.ok(elseIdx > 0, 'toggleAiSelectMode must have an else branch');
        const elseBlock = fnBody.slice(elseIdx);
        assert.ok(
            elseBlock.includes('extractDrawContext = null'),
            'toggleAiSelectMode off branch must clear extractDrawContext — '
            + 'otherwise pressing \'a\' to cancel draw leaves stale context '
            + 'that corrupts the next AI query capture',
        );
    });
});

describe('file-switch extract validation handling', () => {
    const source = fs.readFileSync(annotatorPath, 'utf-8');

    it('warns but keeps navigation unblocked for extract editor validation errors', () => {
        const fnStart = source.indexOf('async function selectFile(index)');
        assert.ok(fnStart > 0, 'could not locate selectFile()');
        const fnEnd = source.indexOf('\nasync function loadFile', fnStart);
        assert.ok(fnEnd > fnStart, 'could not locate end of selectFile()');
        const fnBody = source.slice(fnStart, fnEnd);

        assert.ok(
            fnBody.includes('allowValidationFailure: true'),
            'file switching should allow extract validation warnings without blocking navigation',
        );
        assert.ok(
            fnBody.includes("validationToastType: 'warning'"),
            'file switching should surface extract validation failures as warnings',
        );
        assert.ok(
            fnBody.includes("reason: 'file-switch'"),
            'valid extract file-switch saves should still use the file-switch save reason',
        );
    });
});

describe('mode-switch extract validation handling', () => {
    const source = fs.readFileSync(annotatorPath, 'utf-8');

    it('warns but keeps Parse/Extract mode switching unblocked for extract validation errors', () => {
        const fnStart = source.indexOf('function setAnnotationMode(mode)');
        assert.ok(fnStart > 0, 'could not locate setAnnotationMode()');
        const fnEnd = source.indexOf('\nfunction buildApiUrl', fnStart);
        assert.ok(fnEnd > fnStart, 'could not locate end of setAnnotationMode()');
        const fnBody = source.slice(fnStart, fnEnd);
        const validationBranch = fnBody.slice(
            fnBody.indexOf('if (annotationMode === ANNOTATION_MODE_EXTRACT)'),
            fnBody.indexOf('} else if (elements.expectedMarkdown)'),
        );

        assert.ok(
            validationBranch.includes("showToast(`Current extract edits were not saved: ${collected.error}`, 'warning')"),
            'mode switching should surface extract validation failures as warnings',
        );
        assert.ok(
            validationBranch.includes('} else {\n            currentTests = collected.payload;'),
            'valid extract mode switches should still keep collected payload changes',
        );
        assert.ok(
            !validationBranch.includes('return;'),
            'extract validation failures should not block switching annotation modes',
        );
    });
});
