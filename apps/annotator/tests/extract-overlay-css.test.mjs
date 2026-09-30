import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cssPath = path.resolve(__dirname, '../annotator.css');

describe('extract overlay pointer events', () => {
    const source = fs.readFileSync(cssPath, 'utf-8');

    it('lets extract bbox groups receive clicks on the shared layout overlay', () => {
        assert.match(
            source,
            /\.layout-overlay\s+\.layout-bbox-group,\s*\.layout-overlay\s+\.extract-overlay-group\s*{\s*pointer-events:\s*all;/s,
        );
    });
});
