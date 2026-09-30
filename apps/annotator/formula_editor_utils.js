(function attachAnnotatorFormulaEditorUtils(root) {
    'use strict';

    var OUTER_MATH_DELIMITERS = [
        { open: '$$', close: '$$', displayMode: true, label: 'double-dollar' },
        { open: '\\[', close: '\\]', displayMode: true, label: 'bracket' },
        { open: '\\(', close: '\\)', displayMode: false, label: 'paren' },
        { open: '$', close: '$', displayMode: false, label: 'single-dollar' },
    ];

    function normalizeString(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function isFormulaLayout(test) {
        if (!test || typeof test !== 'object') return false;
        return test.type === 'layout' && test.canonical_class === 'Formula';
    }

    function getFormulaSource(test) {
        if (!test || typeof test !== 'object') return '';
        return normalizeString(test.content && test.content.type === 'text' ? test.content.text : '');
    }

    function getOuterWhitespace(source) {
        var normalized = normalizeString(source);
        var leadingMatch = normalized.match(/^\s*/);
        var trailingMatch = normalized.match(/\s*$/);
        return {
            leadingWhitespace: leadingMatch ? leadingMatch[0] : '',
            trailingWhitespace: trailingMatch ? trailingMatch[0] : '',
        };
    }

    function cloneDelimiter(delimiter) {
        if (!delimiter) return null;
        return {
            open: delimiter.open,
            close: delimiter.close,
            displayMode: Boolean(delimiter.displayMode),
            label: delimiter.label || '',
        };
    }

    function stripOuterMathDelimiters(text) {
        var source = normalizeString(text);
        var whitespace = getOuterWhitespace(source);
        var trimmed = source.slice(
            whitespace.leadingWhitespace.length,
            source.length - whitespace.trailingWhitespace.length,
        );

        for (var i = 0; i < OUTER_MATH_DELIMITERS.length; i += 1) {
            var delimiter = OUTER_MATH_DELIMITERS[i];
            var minimumLength = delimiter.open.length + delimiter.close.length;
            if (trimmed.length < minimumLength) continue;
            if (!trimmed.startsWith(delimiter.open) || !trimmed.endsWith(delimiter.close)) continue;

            return {
                latex: trimmed.slice(delimiter.open.length, trimmed.length - delimiter.close.length),
                delimiter: cloneDelimiter(delimiter),
                hadDelimiters: true,
                displayMode: Boolean(delimiter.displayMode),
                leadingWhitespace: whitespace.leadingWhitespace,
                trailingWhitespace: whitespace.trailingWhitespace,
                trimmedSource: trimmed,
            };
        }

        return {
            latex: trimmed,
            delimiter: null,
            hadDelimiters: false,
            displayMode: true,
            leadingWhitespace: whitespace.leadingWhitespace,
            trailingWhitespace: whitespace.trailingWhitespace,
            trimmedSource: trimmed,
        };
    }

    function extractRenderableLatex(text) {
        return normalizeString(stripOuterMathDelimiters(text).latex).trim();
    }

    function rebuildFormulaSource(latex, options) {
        var normalizedLatex = normalizeString(latex);
        var resolvedOptions = options || {};
        var delimiter = resolvedOptions.delimiter || null;
        var leadingWhitespace = normalizeString(resolvedOptions.leadingWhitespace);
        var trailingWhitespace = normalizeString(resolvedOptions.trailingWhitespace);

        if (delimiter && delimiter.open && delimiter.close) {
            return ''.concat(leadingWhitespace).concat(delimiter.open).concat(normalizedLatex).concat(delimiter.close).concat(trailingWhitespace);
        }

        return ''.concat(leadingWhitespace).concat(normalizedLatex).concat(trailingWhitespace);
    }

    function getFormulaRenderState(text) {
        var rawSource = normalizeString(text);
        var stripped = stripOuterMathDelimiters(rawSource);
        var renderableLatex = normalizeString(stripped.latex).trim();

        return {
            rawSource: rawSource,
            trimmedSource: normalizeString(stripped.trimmedSource),
            renderableLatex: renderableLatex,
            isEmpty: renderableLatex.length === 0,
            displayMode: Boolean(stripped.displayMode),
            delimiter: cloneDelimiter(stripped.delimiter),
            hadDelimiters: Boolean(stripped.hadDelimiters),
            leadingWhitespace: normalizeString(stripped.leadingWhitespace),
            trailingWhitespace: normalizeString(stripped.trailingWhitespace),
        };
    }

    var api = {
        OUTER_MATH_DELIMITERS: OUTER_MATH_DELIMITERS,
        extractRenderableLatex: extractRenderableLatex,
        getFormulaRenderState: getFormulaRenderState,
        getFormulaSource: getFormulaSource,
        isFormulaLayout: isFormulaLayout,
        rebuildFormulaSource: rebuildFormulaSource,
        stripOuterMathDelimiters: stripOuterMathDelimiters,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorFormulaEditorUtils = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
