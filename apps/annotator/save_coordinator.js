(function attachAnnotatorSaveCoordinator(root) {
    'use strict';

    function cloneValue(value) {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }

        return JSON.parse(JSON.stringify(value));
    }

    function createSaveCoordinator(options) {
        if (!options || typeof options.snapshotState !== 'function' || typeof options.persistSnapshot !== 'function') {
            throw new Error('createSaveCoordinator requires snapshotState and persistSnapshot functions');
        }

        var saveChain = Promise.resolve();
        var nextSaveSeq = 0;
        var latestRequestedSeq = 0;
        var latestAppliedSeq = 0;

        function enqueueSave(reason, explicitSnapshot) {
            var seq = ++nextSaveSeq;
            latestRequestedSeq = seq;
            var snapshot = cloneValue(
                explicitSnapshot === undefined ? options.snapshotState() : explicitSnapshot
            );

            var run = async function runSave() {
                var result = await options.persistSnapshot(snapshot, seq, reason);
                var shouldApply = !result || !result.error ? seq === latestRequestedSeq : false;

                if (shouldApply && typeof options.applyLatestResult === 'function') {
                    options.applyLatestResult(result, {
                        seq: seq,
                        reason: reason,
                        snapshot: snapshot,
                        latestRequestedSeq: latestRequestedSeq,
                    });
                    latestAppliedSeq = seq;
                }

                return {
                    seq: seq,
                    reason: reason,
                    snapshot: snapshot,
                    result: result,
                    applied: shouldApply,
                };
            };

            var task = saveChain.then(run, run);
            saveChain = task.then(
                function clearOnSuccess() {
                    return undefined;
                },
                function clearOnFailure() {
                    return undefined;
                }
            );

            return task;
        }

        function getState() {
            return {
                latestRequestedSeq: latestRequestedSeq,
                latestAppliedSeq: latestAppliedSeq,
            };
        }

        return {
            cloneValue: cloneValue,
            enqueueSave: enqueueSave,
            getState: getState,
        };
    }

    var api = {
        cloneValue: cloneValue,
        createSaveCoordinator: createSaveCoordinator,
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        module.exports.default = api;
        return;
    }

    root.AnnotatorSaveCoordinator = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)));
