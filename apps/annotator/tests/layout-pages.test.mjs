import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../layout_pages.js');
const require = createRequire(import.meta.url);

const layoutPages = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

describe('layout page helper module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof layoutPages.resolveNewLayoutFormPage, 'function');
        assert.equal(typeof importedModule.default.resolveSavedLayoutPage, 'function');
        assert.equal(importedModule.default.resolveNewLayoutFormPage, layoutPages.resolveNewLayoutFormPage);

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorLayoutPages.resolveSavedLayoutPage,
            'function',
        );
    });
});

describe('resolveNewLayoutFormPage', () => {
    it('uses insertion context page when provided', () => {
        assert.equal(layoutPages.resolveNewLayoutFormPage(4, 2), 2);
    });

    it('falls back to the current viewer page for normal new-layout flows', () => {
        assert.equal(layoutPages.resolveNewLayoutFormPage(4, null), 4);
        assert.equal(layoutPages.resolveNewLayoutFormPage('3', undefined), 3);
    });
});

describe('resolveSavedLayoutPage', () => {
    it('prefers an explicit page input value', () => {
        assert.equal(layoutPages.resolveSavedLayoutPage('5', 2, 3), 5);
    });

    it('falls back to previous page then current page', () => {
        assert.equal(layoutPages.resolveSavedLayoutPage('', 2, 3), 2);
        assert.equal(layoutPages.resolveSavedLayoutPage('', null, 3), 3);
    });
});
