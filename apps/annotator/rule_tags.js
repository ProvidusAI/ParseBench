(function attachAnnotatorRuleTags(root) {
    'use strict';

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function dedupeTags(tags) {
        var seen = new Set();
        var unique = [];

        for (var index = 0; index < (tags || []).length; index += 1) {
            var rawTag = tags[index];
            var cleaned = rawTag === undefined || rawTag === null ? '' : String(rawTag).trim();
            if (!cleaned) continue;
            var key = cleaned.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(cleaned);
        }

        return unique;
    }

    function applyRuleTags(rule, tags) {
        var normalized = dedupeTags(Array.isArray(tags) ? tags : []);
        if (!rule || typeof rule !== 'object') {
            return normalized;
        }
        if (normalized.length > 0) {
            rule.tags = normalized;
        } else {
            delete rule.tags;
        }
        return normalized;
    }

    function renderRuleTagsHtml(tags, options) {
        var normalized = dedupeTags(Array.isArray(tags) ? tags : []);
        if (!normalized.length) return '';

        var resolvedOptions = options && typeof options === 'object' ? options : {};
        var containerClass = resolvedOptions.containerClass || 'test-item-tags';
        var chipClass = resolvedOptions.chipClass || 'tag-chip';

        return '<div class="' + escapeHtml(containerClass) + '">' + normalized.map(function buildChip(tag) {
            return (
                '<span class="' + escapeHtml(chipClass) + '">' +
                    '<span class="tag-chip-label">' + escapeHtml(tag) + '</span>' +
                '</span>'
            );
        }).join('') + '</div>';
    }

    var api = {
        dedupeTags: dedupeTags,
        applyRuleTags: applyRuleTags,
        renderRuleTagsHtml: renderRuleTagsHtml,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorRuleTags = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
