(function attachAnnotatorReadingOrder(root) {
    'use strict';

    function isLayoutRule(rule) {
        return !!rule && typeof rule === 'object' && rule.type === 'layout';
    }

    function isValidRoIndex(value) {
        return Number.isInteger(value) && value >= 0;
    }

    function matchesPage(rule, pageNumber) {
        if (!isLayoutRule(rule)) {
            return false;
        }

        // Legacy single-page rules often omit `page`. Treat them as page 1 so they
        // remain visible for single-page files without duplicating onto every page
        // when a multi-page document is edited directly.
        if (pageNumber === undefined || pageNumber === null) {
            return rule.page === undefined || rule.page === null;
        }

        if (rule.page === undefined || rule.page === null) {
            return pageNumber === 1;
        }

        return rule.page === pageNumber;
    }

    function compareEntries(left, right) {
        if (left.hadValidRoIndex && right.hadValidRoIndex) {
            if (left.rawRoIndex !== right.rawRoIndex) {
                return left.rawRoIndex - right.rawRoIndex;
            }
            return left.originalIndex - right.originalIndex;
        }

        if (left.hadValidRoIndex !== right.hadValidRoIndex) {
            return left.hadValidRoIndex ? -1 : 1;
        }

        return left.originalIndex - right.originalIndex;
    }

    function buildSnapshotEntry(entry, roIndex) {
        return {
            originalIndex: entry.originalIndex,
            page: entry.page,
            rawRoIndex: entry.rawRoIndex,
            roIndex: roIndex,
            hadValidRoIndex: entry.hadValidRoIndex,
            needsCommit: !entry.hadValidRoIndex || entry.rawRoIndex !== roIndex,
            rule: entry.rule,
        };
    }

    function getPageReadingOrder(testRules, pageNumber) {
        if (!Array.isArray(testRules)) {
            return [];
        }

        var entries = [];

        for (var index = 0; index < testRules.length; index += 1) {
            var rule = testRules[index];
            if (!matchesPage(rule, pageNumber)) {
                continue;
            }

            entries.push({
                originalIndex: index,
                page: rule.page,
                rawRoIndex: rule.ro_index,
                hadValidRoIndex: isValidRoIndex(rule.ro_index),
                rule: rule,
            });
        }

        entries.sort(compareEntries);

        // Invariant: snapshots are page-local, retain the caller's `originalIndex`, and
        // always expose a contiguous zero-based `roIndex` even when persisted data is bad.
        return entries.map(function mapEntry(entry, roIndex) {
            return buildSnapshotEntry(entry, roIndex);
        });
    }

    function writeCommittedOrder(orderedEntries) {
        for (var index = 0; index < orderedEntries.length; index += 1) {
            orderedEntries[index].rule.ro_index = index;
        }
    }

    function commitNormalizedPageReadingOrder(testRules, pageNumber) {
        var orderedEntries = getPageReadingOrder(testRules, pageNumber);
        writeCommittedOrder(orderedEntries);
        return getPageReadingOrder(testRules, pageNumber);
    }

    function findEntryPosition(orderedEntries, originalIndex) {
        for (var index = 0; index < orderedEntries.length; index += 1) {
            if (orderedEntries[index].originalIndex === originalIndex) {
                return index;
            }
        }

        return -1;
    }

    function resolveRelativeInsertBeforeOriginalIndex(orderedEntries, anchorOriginalIndex, placement) {
        if (!Array.isArray(orderedEntries) || !placement || placement === 'append') {
            return null;
        }

        var anchorPosition = findEntryPosition(orderedEntries, anchorOriginalIndex);
        if (anchorPosition === -1) {
            return null;
        }

        if (placement === 'before') {
            return anchorOriginalIndex;
        }

        if (placement === 'after') {
            var nextEntry = orderedEntries[anchorPosition + 1];
            return nextEntry ? nextEntry.originalIndex : null;
        }

        return null;
    }

    function movePageReadingOrderItem(testRules, pageNumber, fromOriginalIndex, toOriginalIndex) {
        var orderedEntries = commitNormalizedPageReadingOrder(testRules, pageNumber);
        var fromPosition = findEntryPosition(orderedEntries, fromOriginalIndex);
        var toPosition = findEntryPosition(orderedEntries, toOriginalIndex);

        if (fromPosition === -1 || toPosition === -1 || fromPosition === toPosition) {
            return orderedEntries;
        }

        var reorderedEntries = orderedEntries.slice();
        var movedEntry = reorderedEntries.splice(fromPosition, 1)[0];

        // Invariant: move only changes page-local `ro_index` values. The caller's
        // `test_rules` array order stays untouched, so `originalIndex` remains stable.
        reorderedEntries.splice(toPosition, 0, movedEntry);
        writeCommittedOrder(reorderedEntries);
        return getPageReadingOrder(testRules, pageNumber);
    }

    function insertPageReadingOrderItem(testRules, pageNumber, originalIndex, beforeOriginalIndex) {
        var orderedEntries = commitNormalizedPageReadingOrder(testRules, pageNumber);
        var itemPosition = findEntryPosition(orderedEntries, originalIndex);

        if (itemPosition === -1) {
            return orderedEntries;
        }

        if (beforeOriginalIndex === originalIndex) {
            return orderedEntries;
        }

        var reorderedEntries = orderedEntries.slice();
        var insertedEntry = reorderedEntries.splice(itemPosition, 1)[0];
        var targetPosition = reorderedEntries.length;

        if (beforeOriginalIndex !== undefined && beforeOriginalIndex !== null) {
            targetPosition = findEntryPosition(reorderedEntries, beforeOriginalIndex);
            if (targetPosition === -1) {
                return orderedEntries;
            }
        }

        reorderedEntries.splice(targetPosition, 0, insertedEntry);
        writeCommittedOrder(reorderedEntries);
        return getPageReadingOrder(testRules, pageNumber);
    }

    function removePageReadingOrderItem(testRules, pageNumber, originalIndex) {
        var orderedEntries = commitNormalizedPageReadingOrder(testRules, pageNumber);
        var itemPosition = findEntryPosition(orderedEntries, originalIndex);

        if (!Array.isArray(testRules) || itemPosition === -1) {
            return orderedEntries;
        }

        // Invariant: removing from page order deletes the referenced rule from
        // `test_rules`; remaining page-local layout rules are then re-compacted.
        testRules.splice(originalIndex, 1);
        return commitNormalizedPageReadingOrder(testRules, pageNumber);
    }

    var api = {
        isLayoutRule: isLayoutRule,
        isValidRoIndex: isValidRoIndex,
        matchesPage: matchesPage,
        getPageReadingOrder: getPageReadingOrder,
        commitNormalizedPageReadingOrder: commitNormalizedPageReadingOrder,
        resolveRelativeInsertBeforeOriginalIndex: resolveRelativeInsertBeforeOriginalIndex,
        movePageReadingOrderItem: movePageReadingOrderItem,
        insertPageReadingOrderItem: insertPageReadingOrderItem,
        removePageReadingOrderItem: removePageReadingOrderItem,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorReadingOrder = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
