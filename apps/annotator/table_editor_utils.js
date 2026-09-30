(function attachAnnotatorTableEditorUtils(root) {
    'use strict';

    var DEFAULT_EMPTY_TABLE_HTML = '<table><tbody><tr><td></td></tr></tbody></table>';
    var ALLOWED_TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col']);
    var ALLOWED_TABLE_ATTRS = new Set([
        'abbr',
        'align',
        'class',
        'colspan',
        'headers',
        'height',
        'rowspan',
        'scope',
        'span',
        'style',
        'valign',
        'width',
    ]);
    var NUMERIC_TABLE_ATTRS = new Set(['colspan', 'rowspan', 'span']);

    function normalizeString(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function getDefaultEmptyTableHtml() {
        return DEFAULT_EMPTY_TABLE_HTML;
    }

    function isTableContent(test) {
        if (!test || typeof test !== 'object') return false;
        if (test.content && test.content.type === 'table') return true;
        return test.canonical_class === 'Table';
    }

    function countTableElements(html) {
        var source = normalizeString(html);
        var matches = source.match(/<table\b/gi);
        return matches ? matches.length : 0;
    }

    function findFirstTableBounds(html) {
        var source = normalizeString(html);
        var tagMatcher = /<\/?table\b[^>]*>/gi;
        var depth = 0;
        var start = -1;
        var match;

        while ((match = tagMatcher.exec(source))) {
            var tag = match[0];
            var isClosing = /^<\//.test(tag);

            if (!isClosing) {
                if (depth === 0) {
                    start = match.index;
                }
                depth += 1;
                continue;
            }

            if (depth === 0) {
                continue;
            }

            depth -= 1;
            if (depth === 0 && start !== -1) {
                return {
                    start: start,
                    end: match.index + tag.length,
                };
            }
        }

        return null;
    }

    function extractEditableTableSegment(html) {
        var source = normalizeString(html);
        var trimmed = source.trim();

        if (!trimmed) {
            return {
                mode: 'visual',
                reason: 'empty',
                tableCount: 0,
                prefixHtml: '',
                tableHtml: DEFAULT_EMPTY_TABLE_HTML,
                suffixHtml: '',
            };
        }

        var tableCount = countTableElements(source);
        if (tableCount !== 1) {
            return {
                mode: 'raw',
                reason: tableCount === 0 ? 'no-table' : 'multiple-tables',
                tableCount: tableCount,
                prefixHtml: '',
                tableHtml: '',
                suffixHtml: '',
                rawHtml: source,
            };
        }

        var bounds = findFirstTableBounds(source);
        if (!bounds) {
            return {
                mode: 'raw',
                reason: 'malformed-table',
                tableCount: tableCount,
                prefixHtml: '',
                tableHtml: '',
                suffixHtml: '',
                rawHtml: source,
            };
        }

        return {
            mode: 'visual',
            reason: null,
            tableCount: tableCount,
            prefixHtml: source.slice(0, bounds.start),
            tableHtml: source.slice(bounds.start, bounds.end),
            suffixHtml: source.slice(bounds.end),
        };
    }

    function clampNumericAttribute(value, fallback) {
        var parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
            return fallback;
        }
        return String(parsed);
    }

    function stripDangerousMarkup(html) {
        return normalizeString(html)
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<script\b[\s\S]*?<\/script>/gi, '')
            .replace(/<style\b[\s\S]*?<\/style>/gi, '')
            .replace(/\son[a-z0-9_-]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
            .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '');
    }

    function createHtmlDocument() {
        if (typeof document !== 'undefined' && document.implementation && typeof document.implementation.createHTMLDocument === 'function') {
            return document.implementation.createHTMLDocument('annotator-table-editor');
        }

        return null;
    }

    function sanitizeTableNode(node, doc) {
        if (!node) return null;

        if (node.nodeType === 3) {
            return doc.createTextNode(node.nodeValue || '');
        }

        if (node.nodeType !== 1) {
            return null;
        }

        var tagName = String(node.tagName || '').toLowerCase();
        if (!ALLOWED_TABLE_TAGS.has(tagName)) {
            var fragment = doc.createDocumentFragment();
            Array.from(node.childNodes || []).forEach(function appendChild(child) {
                var sanitizedChild = sanitizeTableNode(child, doc);
                if (sanitizedChild) {
                    fragment.appendChild(sanitizedChild);
                }
            });
            return fragment;
        }

        var cleanNode = doc.createElement(tagName);

        Array.from(node.attributes || []).forEach(function copyAttribute(attr) {
            var attrName = String(attr.name || '').toLowerCase();
            if (!ALLOWED_TABLE_ATTRS.has(attrName)) {
                return;
            }

            var value = attr.value;
            if (NUMERIC_TABLE_ATTRS.has(attrName)) {
                value = clampNumericAttribute(value, '1');
            }

            cleanNode.setAttribute(attrName, value);
        });

        Array.from(node.childNodes || []).forEach(function appendChild(child) {
            var sanitizedChild = sanitizeTableNode(child, doc);
            if (sanitizedChild) {
                cleanNode.appendChild(sanitizedChild);
            }
        });

        return cleanNode;
    }

    function normalizeSavedTableHtml(html) {
        var source = stripDangerousMarkup(html).trim();
        if (!source) {
            return DEFAULT_EMPTY_TABLE_HTML;
        }

        if (typeof DOMParser !== 'undefined') {
            try {
                var parser = new DOMParser();
                var parsed = parser.parseFromString(source, 'text/html');
                var firstTable = parsed.querySelector('table');
                if (firstTable) {
                    var cleanDoc = createHtmlDocument() || parsed;
                    var sanitizedTable = sanitizeTableNode(firstTable, cleanDoc);
                    if (sanitizedTable && sanitizedTable.outerHTML) {
                        return sanitizedTable.outerHTML;
                    }
                }
            } catch (error) {
                // Fall back to string-based normalization below.
            }
        }

        var extracted = extractEditableTableSegment(source);
        if (extracted.mode !== 'visual') {
            return DEFAULT_EMPTY_TABLE_HTML;
        }

        return stripDangerousMarkup(extracted.tableHtml).trim() || DEFAULT_EMPTY_TABLE_HTML;
    }

    function rebuildContentHtml(parts) {
        var prefixHtml = normalizeString(parts && parts.prefixHtml);
        var tableHtml = normalizeString(parts && parts.tableHtml).trim() || DEFAULT_EMPTY_TABLE_HTML;
        var suffixHtml = normalizeString(parts && parts.suffixHtml);
        return ''.concat(prefixHtml).concat(tableHtml).concat(suffixHtml);
    }

    var api = {
        ALLOWED_TABLE_TAGS: ALLOWED_TABLE_TAGS,
        countTableElements: countTableElements,
        extractEditableTableSegment: extractEditableTableSegment,
        findFirstTableBounds: findFirstTableBounds,
        getDefaultEmptyTableHtml: getDefaultEmptyTableHtml,
        isTableContent: isTableContent,
        normalizeSavedTableHtml: normalizeSavedTableHtml,
        rebuildContentHtml: rebuildContentHtml,
        stripDangerousMarkup: stripDangerousMarkup,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorTableEditorUtils = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
