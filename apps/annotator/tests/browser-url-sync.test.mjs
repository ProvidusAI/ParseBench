import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Tests for the deep-link URL sync (Task 2: queue-dir + file query
 * params). We extract `updateBrowserUrl` and `normalizeQueueRelativeFilePath`
 * from annotator.js and run them in a VM against a fake `window` /
 * `history` so we can assert the final URL without spinning up a browser.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const annotatorPath = path.resolve(__dirname, '../annotator.js');

function loadUpdateBrowserUrl() {
    const source = fs.readFileSync(annotatorPath, 'utf-8');

    const normalizeMatch = source.match(/function normalizeQueueRelativeFilePath\([\s\S]*?\n\}/);
    const updateMatch = source.match(/function updateBrowserUrl\([\s\S]*?\n\}/);
    if (!normalizeMatch || !updateMatch) {
        throw new Error('could not locate url helper functions');
    }

    const fakeLocationInitial = 'http://localhost:5001/';
    const pushed = [];
    const sandbox = {
        window: {
            location: { href: fakeLocationInitial, origin: 'http://localhost:5001' },
            history: {
                replaceState(state, title, href) {
                    pushed.push(href);
                    sandbox.window.location.href = new URL(href, sandbox.window.location.origin).href;
                },
            },
        },
        URL, URLSearchParams,
        queueId: null,
        queueDir: null,
        queueIdParam: null,
        initialQueueDirParam: null,
    };
    vm.createContext(sandbox);

    const script = `
${normalizeMatch[0]}
${updateMatch[0]}
globalThis.updateBrowserUrl = updateBrowserUrl;
globalThis.__setState = (s) => {
    queueId = s.queueId !== undefined ? s.queueId : queueId;
    queueDir = s.queueDir !== undefined ? s.queueDir : queueDir;
    queueIdParam = s.queueIdParam !== undefined ? s.queueIdParam : queueIdParam;
    initialQueueDirParam = s.initialQueueDirParam !== undefined ? s.initialQueueDirParam : initialQueueDirParam;
};
globalThis.__setHref = (href) => { window.location.href = href; };
`;
    vm.runInContext(script, sandbox);
    return { sandbox, pushed };
}

describe('updateBrowserUrl', () => {
    it('adds ?dir=<abs path> when queueDir is set and no existing param', () => {
        const { sandbox, pushed } = loadUpdateBrowserUrl();
        sandbox.__setState({ queueDir: '/tmp/my-queue' });
        sandbox.updateBrowserUrl();
        assert.ok(pushed[0]?.includes('dir=%2Ftmp%2Fmy-queue'), `got: ${pushed[0]}`);
    });

    it('adds ?file=<path> alongside queue', () => {
        const { sandbox, pushed } = loadUpdateBrowserUrl();
        sandbox.__setState({ queueDir: '/tmp/q' });
        sandbox.updateBrowserUrl('sample_statement_1.pdf');
        const last = pushed[pushed.length - 1];
        assert.ok(last.includes('dir=%2Ftmp%2Fq'), `got: ${last}`);
        assert.ok(last.includes('file=sample_statement_1.pdf'), `got: ${last}`);
    });

    it('preserves ?queue= when user loaded with that key', () => {
        const { sandbox, pushed } = loadUpdateBrowserUrl();
        sandbox.__setState({
            queueId: 'relative/queue',
            queueDir: '/base/relative/queue',
            queueIdParam: 'queue',
        });
        sandbox.updateBrowserUrl('doc.pdf');
        const last = pushed[pushed.length - 1];
        assert.ok(last.includes('queue=relative%2Fqueue'), `got: ${last}`);
        // should NOT emit the absolute-path dir key as well
        assert.ok(!last.includes('dir=%2Fbase'), `unexpected dir key: ${last}`);
    });

    it('uses direct dir links without treating them as scoped queue ids', () => {
        const { sandbox, pushed } = loadUpdateBrowserUrl();
        sandbox.__setHref('http://localhost:5001/?dir=%2Ftmp%2Flinked-q&file=old.pdf');
        sandbox.__setState({
            queueId: null,
            queueDir: '/tmp/linked-q',
            queueIdParam: 'dir',
            initialQueueDirParam: null,
        });
        sandbox.updateBrowserUrl('doc.pdf');
        const last = pushed[pushed.length - 1];
        assert.ok(last.includes('dir=%2Ftmp%2Flinked-q'), `got: ${last}`);
        assert.ok(!last.includes('queue='), `direct dir link must not become scoped queue: ${last}`);
        assert.ok(last.includes('file=doc.pdf'), `got: ${last}`);
    });

    it('drops the other key when switching from queue to dir', () => {
        const { sandbox, pushed } = loadUpdateBrowserUrl();
        sandbox.__setHref('http://localhost:5001/?queue=old');
        sandbox.__setState({ queueDir: '/tmp/new', queueIdParam: 'dir' });
        sandbox.updateBrowserUrl('doc.pdf');
        const last = pushed[pushed.length - 1];
        assert.ok(!last.includes('queue=old'), `stale queue param: ${last}`);
        assert.ok(last.includes('dir=%2Ftmp%2Fnew'), `got: ${last}`);
    });

    it('removes ?file= when null is passed', () => {
        const { sandbox, pushed } = loadUpdateBrowserUrl();
        sandbox.__setHref('http://localhost:5001/?dir=%2Ftmp%2Fq&file=old.pdf');
        sandbox.__setState({ queueDir: '/tmp/q' });
        sandbox.updateBrowserUrl(null);
        const last = pushed[pushed.length - 1];
        assert.ok(!last.includes('file='), `file should be removed: ${last}`);
        assert.ok(last.includes('dir=%2Ftmp%2Fq'), `got: ${last}`);
    });

    it('removes both dir and queue when no queue state set', () => {
        const { sandbox, pushed } = loadUpdateBrowserUrl();
        sandbox.__setHref('http://localhost:5001/?dir=%2Fold&file=x.pdf');
        sandbox.__setState({ queueDir: null, queueId: null });
        sandbox.updateBrowserUrl(null);
        const last = pushed[pushed.length - 1];
        assert.ok(!last.includes('dir='), `dir should be removed: ${last}`);
        assert.ok(!last.includes('queue='));
        assert.ok(!last.includes('file='));
    });
});
