(function attachAnnotatorLayoutAttributes(root) {
    'use strict';

    function normalizeAttributeRows(rows) {
        if (!Array.isArray(rows)) {
            return { value: {} };
        }

        var attributes = {};
        var seenKeys = new Set();

        for (var index = 0; index < rows.length; index += 1) {
            var row = rows[index] || {};
            var rawKey = row.key === undefined || row.key === null ? '' : String(row.key);
            var rawValue = row.value === undefined || row.value === null ? '' : String(row.value);
            var key = rawKey.trim();
            var value = rawValue.trim();

            if (!key && !value) {
                continue;
            }

            if (!key || !value) {
                return {
                    error: 'Each layout attribute needs both a key and a value.',
                    index: index,
                };
            }

            if (seenKeys.has(key)) {
                return {
                    error: 'Duplicate attribute key: ' + key,
                    index: index,
                    key: key,
                };
            }

            seenKeys.add(key);
            attributes[key] = value;
        }

        return { value: attributes };
    }

    function attributeRowsFromMap(attributes) {
        if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
            return [];
        }

        return Object.entries(attributes).map(function mapEntry(entry) {
            return {
                key: entry[0],
                value: entry[1],
            };
        });
    }

    var api = {
        normalizeAttributeRows: normalizeAttributeRows,
        attributeRowsFromMap: attributeRowsFromMap,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorLayoutAttributes = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
