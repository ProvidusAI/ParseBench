import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadQueueHelpers() {
    const source = fs.readFileSync(annotatorPath, 'utf8');
    const inferStart = source.indexOf('function inferAnnotationModeFromPayload');
    const inferEnd = source.indexOf('function inferExtractValueType');
    if (inferStart < 0 || inferEnd < 0 || inferEnd <= inferStart) {
        throw new Error('Could not locate annotation mode helper block');
    }
    const start = source.indexOf('function countExpectedOutputLeaves');
    const end = source.indexOf('async function saveExtractEditor');
    if (start < 0 || end < 0 || end <= start) {
        throw new Error('Could not locate queue helper block');
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`
const ANNOTATION_MODE_PARSE = 'parse';
const ANNOTATION_MODE_EXTRACT = 'extract';
${source.slice(inferStart, inferEnd)}
${source.slice(start, end)}
globalThis.countExpectedOutputLeaves = countExpectedOutputLeaves;
globalThis.countExtractFieldRules = countExtractFieldRules;
globalThis.getAnnotationCountForPayload = getAnnotationCountForPayload;
globalThis.isTestsPayloadFullyVerified = isTestsPayloadFullyVerified;
globalThis.deriveFileStatusFromTests = deriveFileStatusFromTests;
`, sandbox);
    return sandbox;
}

describe('file verification status helpers', () => {
    const { isTestsPayloadFullyVerified, deriveFileStatusFromTests } = loadQueueHelpers();

    it('treats payloads with no test rules as not fully verified', () => {
        assert.equal(isTestsPayloadFullyVerified({ test_rules: [] }), false);
        assert.equal(isTestsPayloadFullyVerified({ expected_output: { x: 1 } }), false);
    });

    it('treats missing verified flags as verified for backwards compatibility', () => {
        assert.equal(isTestsPayloadFullyVerified({
            test_rules: [
                { type: 'present', text: 'A' },
                { type: 'present', text: 'B', verified: true },
            ],
        }), true);
    });

    it('marks a file pending when any rule needs review', () => {
        assert.equal(deriveFileStatusFromTests('completed', {
            test_rules: [
                { type: 'present', text: 'A', verified: true },
                { type: 'present', text: 'B', verified: false },
            ],
        }), 'pending');
    });

    it('marks a file completed when all rules are verified', () => {
        assert.equal(deriveFileStatusFromTests('pending', {
            test_rules: [
                { type: 'present', text: 'A', verified: true },
                { type: 'present', text: 'B' },
            ],
        }), 'completed');
    });

    it('preserves skipped files', () => {
        assert.equal(deriveFileStatusFromTests('skipped', {
            test_rules: [
                { type: 'present', text: 'A', verified: true },
            ],
        }), 'skipped');
    });
});

describe('file annotation count helpers', () => {
    const { getAnnotationCountForPayload } = loadQueueHelpers();

    it('counts extract_field rules instead of only top-level expected_output keys', () => {
        assert.equal(getAnnotationCountForPayload({
            annotation_mode: 'extract',
            expected_output: {
                employees: [
                    { name: 'A', score: 1 },
                    { name: 'B', score: 2 },
                ],
            },
            test_rules: [
                { type: 'extract_field', field_path: 'employees[0].name' },
                { type: 'extract_field', field_path: 'employees[0].score' },
                { type: 'extract_field', field_path: 'employees[1].name' },
                { type: 'extract_field', field_path: 'employees[1].score' },
            ],
        }), 4);
    });

    it('recursively counts expected_output leaves for extract payloads without rules', () => {
        assert.equal(getAnnotationCountForPayload({
            annotation_mode: 'extract',
            expected_output: {
                employees: [
                    { name: 'A', score: 1 },
                    { name: 'B', score: null },
                ],
            },
            test_rules: [],
        }), 4);
    });

    it('does not count a missing root expected_output as a test', () => {
        assert.equal(getAnnotationCountForPayload({
            annotation_mode: 'extract',
            expected_output: null,
            test_rules: [],
        }), 0);
    });

    it('counts parse mode rules directly', () => {
        assert.equal(getAnnotationCountForPayload({
            annotation_mode: 'parse',
            test_rules: [
                { type: 'present', text: 'A' },
                { type: 'absent', text: 'B' },
            ],
        }), 2);
    });
});
