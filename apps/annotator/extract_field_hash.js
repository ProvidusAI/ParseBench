(function attachAnnotatorExtractFieldHash(root) {
    'use strict';

    const EXTRACT_FIELD_RULE_TYPE = 'extract_field';
    const DEFAULT_HASH_LEN = 16;

    // Byte-for-byte JS port of:
    //   Python rule-id reference
    // (canonical_rule_signature + compute_rule_id)
    // and the extract-specific payload builder in
    //   Python extract-field fixture generator
    //   (_rule_id_payload + _assign_deterministic_ids)
    //
    // The Python reference uses:
    //   json.dumps(payload, sort_keys=True, separators=(",", ":"),
    //              ensure_ascii=False)
    // which means ASCII-only strings, compact commas/colons, no padding,
    // and non-ASCII characters emitted as UTF-8 (not \u escapes).
    //
    // JS's JSON.stringify already matches: sorts nothing (we handle sort
    // manually), uses compact separators by default, emits raw UTF-8.
    //
    // Known divergence: Python distinguishes 1 (int) from 1.0 (float) in
    // `json.dumps`; JS `JSON.stringify` emits both as "1". The v0.5 dataset
    // has no whole-number floats in `expected_value`, so this does not
    // affect the shipped data. If a future dataset introduces them, the
    // ids will diverge — detect via the round-trip audit script.

    function stableStringify(value) {
        if (value === null || typeof value !== 'object') {
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return '[' + value.map(stableStringify).join(',') + ']';
        }
        const keys = Object.keys(value).sort();
        const parts = keys.map(
            (k) => JSON.stringify(k) + ':' + stableStringify(value[k]),
        );
        return '{' + parts.join(',') + '}';
    }

    function canonicalRuleSignature(rule) {
        const payload = Object.assign({}, rule);
        delete payload.id;
        return stableStringify(payload);
    }

    async function sha256Hex(input) {
        // Prefer SubtleCrypto in the browser; fall back to Node's crypto in tests.
        const subtle = (root.crypto && root.crypto.subtle)
            || (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle);
        if (subtle) {
            const data = new TextEncoder().encode(input);
            const digest = await subtle.digest('SHA-256', data);
            const bytes = new Uint8Array(digest);
            let hex = '';
            for (let i = 0; i < bytes.length; i += 1) {
                hex += bytes[i].toString(16).padStart(2, '0');
            }
            return hex;
        }
        // Node.js fallback for unit tests.
        // eslint-disable-next-line global-require
        const nodeCrypto = require('node:crypto');
        return nodeCrypto.createHash('sha256').update(input, 'utf-8').digest('hex');
    }

    async function computeRuleId(rule, hashLen) {
        const len = typeof hashLen === 'number' ? hashLen : DEFAULT_HASH_LEN;
        const signature = canonicalRuleSignature(rule);
        const page = rule && rule.page != null ? String(rule.page) : '';
        // NUL byte (\u0000) separator — matches Python `f"{page_prefix}\u0000{signature}"`.
        const payload = page + '\u0000' + signature;
        const hex = await sha256Hex(payload);
        return hex.slice(0, len);
    }

    function extractFieldIdPayload(rule) {
        const bboxes = Array.isArray(rule && rule.bboxes) ? rule.bboxes : [];
        const firstIdx = bboxes.length > 0 && bboxes[0]
            && bboxes[0].source_bbox_index != null
            ? bboxes[0].source_bbox_index
            : null;
        const expected = rule && rule.expected_value !== undefined
            ? rule.expected_value
            : null;
        // `verified` defaults to true when absent — matches the Python
        // Pydantic model (schema.py: `verified: bool = True`) and the
        // audit script (`bool(rule.get("verified", True))`). A naive
        // Boolean(rule.verified) would flip to false for rules missing
        // the field and silently diverge the rule id hash from Python.
        const verified = rule && rule.verified !== undefined
            ? Boolean(rule.verified)
            : true;
        return {
            type: EXTRACT_FIELD_RULE_TYPE,
            field_path: rule ? rule.field_path : null,
            source_bbox_index: firstIdx,
            expected_value: expected,
            verified,
            tags: Array.isArray(rule && rule.tags) ? rule.tags.slice() : [],
        };
    }

    async function assignExtractFieldIds(rules, hashLen) {
        const len = typeof hashLen === 'number' ? hashLen : DEFAULT_HASH_LEN;
        if (!Array.isArray(rules) || rules.length === 0) return;

        const payloads = rules.map(extractFieldIdPayload);
        const baseIds = await Promise.all(
            payloads.map((p) => computeRuleId(p, len)),
        );

        const positionsByBase = new Map();
        for (let i = 0; i < baseIds.length; i += 1) {
            const baseId = baseIds[i];
            if (!positionsByBase.has(baseId)) {
                positionsByBase.set(baseId, []);
            }
            positionsByBase.get(baseId).push(i);
        }

        for (const [baseId, positions] of positionsByBase.entries()) {
            if (positions.length === 1) {
                rules[positions[0]].id = baseId;
                continue;
            }
            // Collision: stable sort by (canonical_signature, original_index)
            // to match Python's collision resolution.
            const ordered = positions.slice().sort((a, b) => {
                const sa = canonicalRuleSignature(payloads[a]);
                const sb = canonicalRuleSignature(payloads[b]);
                if (sa < sb) return -1;
                if (sa > sb) return 1;
                return a - b;
            });
            for (let counter = 0; counter < ordered.length; counter += 1) {
                const idx = ordered[counter];
                const prefix = String(counter).padStart(3, '0');
                rules[idx].id = prefix + '-' + baseId;
            }
        }
    }

    const api = {
        EXTRACT_FIELD_RULE_TYPE,
        DEFAULT_HASH_LEN,
        stableStringify,
        canonicalRuleSignature,
        computeRuleId,
        extractFieldIdPayload,
        assignExtractFieldIds,
        sha256Hex,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorExtractFieldHash = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
