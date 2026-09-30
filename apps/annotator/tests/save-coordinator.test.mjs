import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, '../save_coordinator.js');
const require = createRequire(import.meta.url);

const saveCoordinator = require(modulePath);
const importedModule = await import(pathToFileURL(modulePath).href);

describe('save coordinator module loading', () => {
    it('supports require(), import(), and browser-global usage', () => {
        assert.equal(typeof saveCoordinator.createSaveCoordinator, 'function');
        assert.equal(typeof importedModule.default.createSaveCoordinator, 'function');
        assert.equal(importedModule.default.createSaveCoordinator, saveCoordinator.createSaveCoordinator);

        const source = fs.readFileSync(modulePath, 'utf8');
        const browserContext = { globalThis: {}, console, structuredClone };
        vm.runInNewContext(source, browserContext, { filename: modulePath });

        assert.equal(
            typeof browserContext.globalThis.AnnotatorSaveCoordinator.createSaveCoordinator,
            'function',
        );
    });
});

describe('createSaveCoordinator', () => {
    it('snapshots state at enqueue time, serializes saves, and only applies the latest result', async () => {
        let currentState = { version: 'initial', nested: { count: 0 } };
        const persisted = [];
        const applied = [];

        let releaseFirstSave;
        const firstSaveGate = new Promise((resolve) => {
            releaseFirstSave = resolve;
        });

        const coordinator = saveCoordinator.createSaveCoordinator({
            snapshotState: () => currentState,
            persistSnapshot: async (snapshot, seq, reason) => {
                persisted.push({
                    seq,
                    reason,
                    version: snapshot.version,
                    nestedCount: snapshot.nested.count,
                });

                if (seq === 1) {
                    await firstSaveGate;
                }

                return {
                    ok: true,
                    testData: {
                        version: snapshot.version,
                        nestedCount: snapshot.nested.count,
                    },
                };
            },
            applyLatestResult: (result, meta) => {
                applied.push({
                    seq: meta.seq,
                    version: result.testData.version,
                    nestedCount: result.testData.nestedCount,
                });
            },
        });

        currentState = { version: 'first', nested: { count: 1 } };
        const firstSave = coordinator.enqueueSave('first-save');

        currentState = { version: 'second', nested: { count: 2 } };
        const secondSave = coordinator.enqueueSave('second-save');

        await Promise.resolve();

        assert.deepEqual(persisted, [
            {
                seq: 1,
                reason: 'first-save',
                version: 'first',
                nestedCount: 1,
            },
        ]);

        releaseFirstSave();

        const firstResult = await firstSave;
        const secondResult = await secondSave;

        assert.deepEqual(
            persisted.map((entry) => [entry.seq, entry.reason, entry.version, entry.nestedCount]),
            [
                [1, 'first-save', 'first', 1],
                [2, 'second-save', 'second', 2],
            ],
        );
        assert.equal(firstResult.applied, false);
        assert.equal(secondResult.applied, true);
        assert.deepEqual(applied, [
            {
                seq: 2,
                version: 'second',
                nestedCount: 2,
            },
        ]);
        assert.deepEqual(coordinator.getState(), {
            latestRequestedSeq: 2,
            latestAppliedSeq: 2,
        });
    });
});
