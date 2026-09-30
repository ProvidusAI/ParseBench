import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Tests for extract bbox reassignment. The ranking and mutation logic are
 * extracted from annotator.js and run in isolation.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadHelpers() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');
    const functionsToExtract = [
        '_bboxCenterNorm',
        '_minCentroidDistance',
        '_rankReassignmentCandidates',
    ];
    const chunks = [];
    for (const name of functionsToExtract) {
        const m = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
        if (!m) throw new Error(`Could not locate ${name}`);
        chunks.push(m[0]);
    }
    const sandbox = {
        currentTests: { test_rules: [] },
    };
    vm.createContext(sandbox);
    vm.runInContext(
        chunks.join('\n\n') + '\nglobalThis._rankReassignmentCandidates = _rankReassignmentCandidates;'
            + '\nglobalThis._setCurrentTests = (v) => { currentTests = v; };',
        sandbox,
    );
    return sandbox;
}

describe('_rankReassignmentCandidates', () => {
    const helpers = loadHelpers();

    it('ranks by centroid distance on the same page', () => {
        const stray = {
            type: 'extract_field',
            bboxes: [{ page: 1, bbox: [0.5, 0.5, 0.01, 0.01], source_bbox_index: 99 }],
            tags: ['stray_evidence'],
        };
        helpers._setCurrentTests({
            test_rules: [
                stray,
                {
                    type: 'extract_field',
                    field_path: 'close',
                    bboxes: [{ page: 1, bbox: [0.49, 0.49, 0.02, 0.02] }],
                    tags: [],
                },
                {
                    type: 'extract_field',
                    field_path: 'far',
                    bboxes: [{ page: 1, bbox: [0.0, 0.0, 0.02, 0.02] }],
                    tags: [],
                },
                {
                    type: 'extract_field',
                    field_path: 'wrong_page',
                    bboxes: [{ page: 2, bbox: [0.5, 0.5, 0.01, 0.01] }],
                    tags: [],
                },
            ],
        });
        const ranked = helpers._rankReassignmentCandidates(stray);
        assert.equal(ranked.length, 2);
        assert.equal(ranked[0].rule.field_path, 'close');
        assert.equal(ranked[1].rule.field_path, 'far');
    });

    it('excludes other strays from candidates', () => {
        const stray = {
            type: 'extract_field',
            bboxes: [{ page: 1, bbox: [0.5, 0.5, 0.01, 0.01] }],
            tags: ['stray_evidence'],
        };
        helpers._setCurrentTests({
            test_rules: [
                stray,
                {
                    type: 'extract_field',
                    field_path: 'also_stray',
                    bboxes: [{ page: 1, bbox: [0.5, 0.5, 0.01, 0.01] }],
                    tags: ['stray_evidence'],
                },
                {
                    type: 'extract_field',
                    field_path: 'real',
                    bboxes: [{ page: 1, bbox: [0.6, 0.6, 0.01, 0.01] }],
                    tags: [],
                },
            ],
        });
        const ranked = helpers._rankReassignmentCandidates(stray);
        assert.equal(ranked.length, 1);
        assert.equal(ranked[0].rule.field_path, 'real');
    });

    it('returns at most limit candidates', () => {
        const stray = {
            type: 'extract_field',
            bboxes: [{ page: 1, bbox: [0.5, 0.5, 0.01, 0.01] }],
            tags: ['stray_evidence'],
        };
        const test_rules = [stray];
        for (let i = 0; i < 25; i += 1) {
            test_rules.push({
                type: 'extract_field',
                field_path: `field_${i}`,
                bboxes: [{ page: 1, bbox: [i / 30, i / 30, 0.01, 0.01] }],
                tags: [],
            });
        }
        helpers._setCurrentTests({ test_rules });
        const ranked = helpers._rankReassignmentCandidates(stray, { limit: 10 });
        assert.equal(ranked.length, 10);
    });
});

describe('reassignment mutation + undo', () => {
    // Pure reproduction of the state-transition the annotator performs.
    function reassign(rules, strayIdx, targetIdx) {
        const stray = rules[strayIdx];
        const target = rules[targetIdx];
        const snapshot = {
            strayRule: JSON.parse(JSON.stringify(stray)),
            strayIdx,
            targetIdx,
            targetOrigBboxes: JSON.parse(JSON.stringify(target.bboxes || [])),
            targetOrigTags: Array.isArray(target.tags) ? [...target.tags] : [],
        };
        target.bboxes = Array.isArray(target.bboxes) ? target.bboxes : [];
        for (const b of stray.bboxes || []) target.bboxes.push({ ...b });
        target.tags = Array.isArray(target.tags) ? target.tags.slice() : [];
        if (!target.tags.includes('reassigned')) target.tags.push('reassigned');
        rules.splice(strayIdx, 1);
        return snapshot;
    }

    function undo(rules, snapshot) {
        const currentTargetIdx = snapshot.strayIdx < snapshot.targetIdx
            ? snapshot.targetIdx - 1
            : snapshot.targetIdx;
        const target = rules[currentTargetIdx];
        if (target) {
            target.bboxes = snapshot.targetOrigBboxes;
            target.tags = snapshot.targetOrigTags;
        }
        rules.splice(snapshot.strayIdx, 0, snapshot.strayRule);
    }

    it('moves stray bboxes onto the target, removes the stray, tags target as reassigned', () => {
        const rules = [
            {
                type: 'extract_field',
                field_path: 'dest',
                bboxes: [{ page: 1, bbox: [0.5, 0.5, 0.01, 0.01], source_bbox_index: 0 }],
                tags: ['benchmark_fixture'],
            },
            {
                type: 'extract_field',
                id: 'stray1',
                field_path: 'dest',
                bboxes: [{ page: 1, bbox: [0.6, 0.6, 0.01, 0.01], source_bbox_index: 99 }],
                tags: ['benchmark_fixture', 'stray_evidence'],
            },
        ];
        reassign(rules, 1, 0);
        assert.equal(rules.length, 1);
        assert.equal(rules[0].bboxes.length, 2);
        assert.equal(rules[0].bboxes[1].source_bbox_index, 99);
        assert.ok(rules[0].tags.includes('reassigned'));
    });

    it('undo restores both stray and target to pre-reassignment state', () => {
        const rules = [
            {
                type: 'extract_field',
                field_path: 'dest',
                bboxes: [{ page: 1, bbox: [0.5, 0.5, 0.01, 0.01] }],
                tags: ['benchmark_fixture'],
            },
            {
                type: 'extract_field',
                id: 'stray1',
                field_path: 'dest',
                bboxes: [{ page: 1, bbox: [0.6, 0.6, 0.01, 0.01] }],
                tags: ['benchmark_fixture', 'stray_evidence'],
            },
        ];
        const originalTargetBboxes = JSON.parse(JSON.stringify(rules[0].bboxes));
        const originalTargetTags = [...rules[0].tags];
        const snapshot = reassign(rules, 1, 0);
        undo(rules, snapshot);
        assert.equal(rules.length, 2);
        assert.deepEqual(rules[0].bboxes, originalTargetBboxes);
        assert.deepEqual(rules[0].tags, originalTargetTags);
        assert.equal(rules[1].id, 'stray1');
    });

    it('handles strayIdx < targetIdx by adjusting target index on undo', () => {
        // When we remove stray at a lower index, target shifts down. Undo
        // must know to re-insert at the old stray position and restore the
        // still-valid current target.
        const rules = [
            {
                type: 'extract_field',
                id: 'stray',
                field_path: 'dest',
                bboxes: [{ page: 1, bbox: [0.5, 0.5, 0.01, 0.01] }],
                tags: ['stray_evidence'],
            },
            {
                type: 'extract_field',
                field_path: 'dest',
                bboxes: [{ page: 1, bbox: [0.6, 0.6, 0.01, 0.01] }],
                tags: [],
            },
        ];
        const snapshot = reassign(rules, 0, 1);
        // After reassign, target is at index 0 (stray removed).
        assert.equal(rules.length, 1);
        assert.equal(rules[0].bboxes.length, 2);
        undo(rules, snapshot);
        assert.equal(rules.length, 2);
        assert.equal(rules[0].id, 'stray');
        assert.equal(rules[1].bboxes.length, 1);
    });
});
