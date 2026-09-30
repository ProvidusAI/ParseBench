(function attachAnnotatorLayoutPages(root) {
    'use strict';

    function parsePositivePageNumber(value) {
        var parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function resolveNewLayoutFormPage(currentPage, insertionPage) {
        return parsePositivePageNumber(insertionPage) || parsePositivePageNumber(currentPage) || 1;
    }

    function resolveSavedLayoutPage(rawPageValue, previousLayoutPage, currentPage) {
        return (
            parsePositivePageNumber(rawPageValue)
            || parsePositivePageNumber(previousLayoutPage)
            || parsePositivePageNumber(currentPage)
            || 1
        );
    }

    var api = {
        parsePositivePageNumber: parsePositivePageNumber,
        resolveNewLayoutFormPage: resolveNewLayoutFormPage,
        resolveSavedLayoutPage: resolveSavedLayoutPage,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorLayoutPages = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
