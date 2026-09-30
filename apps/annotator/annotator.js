// === State ===
let files = [];
let currentFileIndex = -1;
let currentFile = null;
let currentFileQueueDir = null;
let currentTests = { test_rules: [], expected_markdown: null, tags: [] };
const initialUrlParams = new URLSearchParams(window.location.search);
const STORAGE_KEYS = {
    aiSidebarOpen: 'annotator:aiSidebarOpen',
    documentTagsCollapsed: 'annotator:documentTagsCollapsed',
    pdfControlsCollapsed: 'annotator:pdfControlsCollapsed',
    addTestCollapsed: 'annotator:addTestCollapsed',
};
const ANNOTATION_MODE_PARSE = 'parse';
const ANNOTATION_MODE_EXTRACT = 'extract';
let annotationMode = ANNOTATION_MODE_PARSE;
let editingIndex = null; // Index of test being edited, null if adding new
let pdfDoc = null;
let pageNum = 1;
let scale = 1.5;
let queueDir = null;
let outputDir = null;
const initialDirParam = initialUrlParams.get('dir');
const initialQueueParam = initialUrlParams.get('queue');
let queueIdParam = initialQueueParam ? 'queue' : 'dir';
let initialQueueDirParam = initialDirParam || null;
let queueId = initialQueueParam || null;
let queueScopedMode = Boolean(queueId);
let requestedInitialFilePath = normalizeQueueRelativeFilePath(initialUrlParams.get('file'));
let requestedInitialFileHandled = false;
let browseCurrentPath = '';
let isMultiPagePdf = false;
let collapsedGroups = new Set();
let queueToolsCollapsed = true;
let fileSearchQuery = '';
let capabilities = { extract_page: true, vlm_available: false }; // Assume available until checked

// AI Selection state
let aiSelectMode = false;
let isDrawingSelection = false;
let selectionStart = { x: 0, y: 0 };
let selectionEnd = { x: 0, y: 0 };
let currentSelection = null; // { x, y, width, height } in canvas coordinates
let vlmConfig = { has_api_key: false, model: 'gemini-3-flash-preview' };
let aiSidebarOpen = readStoredBoolean(STORAGE_KEYS.aiSidebarOpen, false); // AI sidebar visibility state
let sidebarOpen = true; // Left sidebar (queue) visibility state
let testPanelOpen = true; // Right sidebar (test panel) visibility state
let documentTagsCollapsed = readStoredBoolean(STORAGE_KEYS.documentTagsCollapsed, true);
let pdfControlsCollapsed = readStoredBoolean(STORAGE_KEYS.pdfControlsCollapsed, true);
let addTestCollapsed = readStoredBoolean(STORAGE_KEYS.addTestCollapsed, true);
let testReviewResultsCache = new Map(); // Map of file path -> { test index -> review result }
let testReviewResults = {}; // Current file's review results (synced with cache)

// Test Types state
const DEFAULT_TEST_TYPES = ['present', 'absent', 'order', 'table'];
let selectedTestTypes = [...DEFAULT_TEST_TYPES];
let aiGeneratableTypes = new Set(DEFAULT_TEST_TYPES);
let aiManualOnlyTypes = new Set();
let testTypeFilterQuery = '';
let ruleListTypeFilter = '';
let ruleListTagFilter = '';
// Granularity filter for layout rules. Default 'region' (legacy
// docs only have region rules; this preserves their UX). Empty
// string == "all granularities". Persisted to localStorage so the
// labeller's filter survives reloads.
let ruleListGranularityFilter = (() => {
    try {
        const stored = window.localStorage?.getItem('annotator.ruleListGranularityFilter');
        return stored === null || stored === undefined ? 'region' : stored;
    } catch (e) {
        return 'region';
    }
})();
let testTypesFolded = true; // Test types section starts folded
const MAX_RENDERED_CHIPS = 200;
const GROUNDING_ROLE_ORDER = ['before', 'after'];
const STATIC_TEST_FORM_TYPES = new Set(['present', 'absent', 'order', 'table', 'chart_data_point', 'layout']);
const RAW_JSON_TEST_TYPE = '__raw_json__';
const MIN_PDF_SCALE = 0.25;
const MIN_IMAGE_SCALE = 0.1;
const MAX_VIEWER_SCALE = 4;
const VIEWER_WHEEL_ZOOM_SENSITIVITY = 0.002;
const WHEEL_LINE_DELTA_PX = 16;

// Schema-driven rule definition state
let ruleDefinitionsManifest = null;
let ruleDefinitionsByType = new Map();
let ruleBaseFields = [];

// Parse.md state
let parseMdContent = null; // Content of parse.md file if it exists
let parseMdAvailable = false; // Whether parse.md exists for current file
let useParseMd = true; // Whether to use parse.md content (default: yes if available)

// Multi-file selection state
let selectedFiles = new Set(); // Set of file paths selected for batch operations
let batchProcessingFiles = new Set(); // Set of file paths currently being processed

// Layout Detection Overlay state
const LAYOUT_CATEGORY_COLORS = {
    'Caption': '#e6194b',
    'Footnote': '#3cb44b',
    'Formula': '#ffe119',
    'List-item': '#4363d8',
    'Page-footer': '#f58231',
    'Page-header': '#911eb4',
    'Picture': '#46f0f0',
    'Section-header': '#f032e6',
    'Table': '#bcf60c',
    'Text': '#fabebe',
    'Title': '#008080',
    'Section': '#f032e6',
    'Code': '#e6beff',
    'Checkbox-Selected': '#9a6324',
    'Checkbox-Unselected': '#fffac8',
    'Document Index': '#800000',
    'Form': '#aaffc3',
    'Key-Value Region': '#808000',
};

// Resolved granularity for a layout rule. Existing datasets pre-date
// the schema's `granularity` field and never set it, so missing/null
// must read as 'region' (otherwise legacy region-only docs would
// disappear from a "regions" filter). `attributes.scope === 'mark'`
// promotes any rule to 'checkbox' regardless of declared granularity
// — that's how Azure DI / Textract checkbox marks come in. Returns
// null for non-layout rules so the granularity filter can short-
// circuit without checking type at every call site.
function getRuleGranularity(rule) {
    if (!rule || rule.type !== 'layout') return null;
    const scope = rule.attributes && rule.attributes.scope;
    if (typeof scope === 'string' && scope.toLowerCase() === 'mark') {
        return 'checkbox';
    }
    const granularity = rule.granularity;
    if (granularity === 'line' || granularity === 'word') {
        return granularity;
    }
    return 'region';
}

// Memoised by `currentTests` reference. Cleared whenever
// currentTests is reassigned (every load + every save round-trip).
let _rulesByParentIdCache = null;
let _rulesByParentIdCacheKey = null;
function getRulesByParentIdIndex() {
    if (_rulesByParentIdCacheKey !== currentTests) {
        _rulesByParentIdCacheKey = currentTests;
        _rulesByParentIdCache = new Map();
        if (currentTests && Array.isArray(currentTests.test_rules)) {
            for (let i = 0; i < currentTests.test_rules.length; i += 1) {
                const rule = currentTests.test_rules[i];
                const parentId = rule && typeof rule.parent_test_id === 'string'
                    ? rule.parent_test_id.trim() : '';
                if (!parentId) continue;
                const list = _rulesByParentIdCache.get(parentId) || [];
                list.push({ rule, index: i });
                _rulesByParentIdCache.set(parentId, list);
            }
        }
    }
    return _rulesByParentIdCache;
}

let layoutOverlayVisible = true;
let labelNamesVisible = (() => {
    try {
        const stored = localStorage.getItem('annotator:showLabelNames');
        return stored === null ? true : stored === 'true';
    } catch (e) {
        return true;
    }
})();
let selectedLayoutTestIndex = null;
let layoutDrawMode = false; // For drawing new layout bboxes
let cachedOntologyLabels = null; // Cache for ontology labels
let ontologyLabelsPromise = null;
let layoutInsertionContext = null; // { page, anchorOriginalIndex, placement: 'append' | 'before' | 'after' }

// Bbox editing state (for visual drag-to-edit)
let bboxEditMode = null; // null, 'move', 'resize-nw', 'resize-ne', 'resize-sw', 'resize-se', 'resize-n', 'resize-e', 'resize-s', 'resize-w'
let bboxEditStartCoords = null; // { mouseX, mouseY, bbox: [x, y, w, h], svgRect } - initial state at drag start
let bboxEditCurrentTest = null; // Reference to the test being edited

// Extract-mode bbox editing state. Parallel to the layout-mode state above
// but indexes into `rule.bboxes[bboxIdx]` rather than the rule itself, so
// multi-bbox rules can be edited one evidence at a time without touching
// source_bbox_index.
let extractBboxEditMode = null;
let extractBboxEditStart = null; // { mouseX, mouseY, origBbox, svgRect, ruleIdx, bboxIdx, mode }
let extractBboxSuppressNextClick = false;
const EXTRACT_BBOX_DRAG_START_PX = 3;
const EXTRACT_VALUE_TEXTAREA_MIN_HEIGHT = 28;

// Active "draw new extract bbox" context. Set when the user clicks a
// tree-row Draw button; cleared once processSelectionEnd captures a region
// or the user cancels. Only one at a time — overlaps with layout-draw are
// prevented by toggling layoutDrawMode off at set time.
let extractDrawContext = null; // { fieldPath, ruleIdx }

// Single-level undo buffer for stray reassignment. Holds enough state to
// restore the original stray + target. Out-of-scope for anything else —
// not a general edit history.
let lastExtractReassignment = null; // { strayRule, strayIdx, targetIdx, targetOrigBboxes, targetOrigTags }
let groundingPickerContext = null; // { form, ruleType, role? } while waiting for layout click to link grounding

// Markdown Preview Panel state
let markdownPanelOpen = false;
let markdownEditingIndex = null; // Which block is being edited
let markdownTagEditingIndex = null; // Which block is editing tags
let markdownDragIndex = null; // Which block is being dragged
let markdownMoveState = null; // { sourceOriginalIndex, targetOriginalIndex, placement: 'before' | 'after' }
let selectedMarkdownCardIndices = new Set();
let markdownRenderSequence = 0;
let tableEditorSession = null;
let formulaEditorSession = null;
let pendingViewerZoomRequest = null;
let viewerZoomFrame = null;
let viewerZoomRendering = false;
const readingOrderHelpers = window.AnnotatorReadingOrder;
const saveCoordinatorHelpers = window.AnnotatorSaveCoordinator;
const layoutAttributeHelpers = window.AnnotatorLayoutAttributes;
const ruleTagHelpers = window.AnnotatorRuleTags;
const layoutPageHelpers = window.AnnotatorLayoutPages;
const tableEditorUtils = window.AnnotatorTableEditorUtils;
const tableEditorAdapter = window.AnnotatorTableEditorAdapter;
const formulaEditorUtils = window.AnnotatorFormulaEditorUtils;
const formulaEditorAdapter = window.AnnotatorFormulaEditorAdapter;

function readStoredBoolean(key, fallback) {
    try {
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : stored === 'true';
    } catch (e) {
        return fallback;
    }
}

function writeStoredBoolean(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch (e) {
        // Ignore storage failures; the control should still update for this session.
    }
}

// === PDF.js Setup ===
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

if (window.MathfieldElement) {
    window.MathfieldElement.fontsDirectory = 'https://cdn.jsdelivr.net/npm/mathlive/fonts';
}

// === DOM Elements ===
const elements = {
    fileList: document.getElementById('file-list'),
    statPending: document.getElementById('stat-pending'),
    statCompleted: document.getElementById('stat-completed'),
    currentFileName: document.getElementById('current-file-name'),
    currentFileGroup: document.getElementById('current-file-group'),
    currentFileTags: document.getElementById('current-file-tags'),
    prevFile: document.getElementById('prev-file'),
    nextFile: document.getElementById('next-file'),
    skipFile: document.getElementById('skip-file'),
    completeFile: document.getElementById('complete-file'),
    renameFile: document.getElementById('rename-file'),
    deleteFile: document.getElementById('delete-file'),
    refreshQueue: document.getElementById('refresh-queue'),
    exportBtn: document.getElementById('export-btn'),
    pdfContainer: document.getElementById('pdf-container'),
    pdfPlaceholder: document.getElementById('pdf-placeholder'),
    pdfWrapper: document.getElementById('pdf-wrapper'),
    pdfCanvas: document.getElementById('pdf-canvas'),
    textLayer: document.getElementById('text-layer'),
    pdfControls: document.getElementById('pdf-controls'),
    pdfControlsToggle: document.getElementById('pdf-controls-toggle'),
    pdfControlContent: document.getElementById('pdf-control-content'),
    pdfToolRow: document.getElementById('pdf-tool-row'),
    prevPage: document.getElementById('prev-page'),
    nextPage: document.getElementById('next-page'),
    pageNum: document.getElementById('page-num'),
    pageCount: document.getElementById('page-count'),
    zoomIn: document.getElementById('zoom-in'),
    zoomOut: document.getElementById('zoom-out'),
    zoomFit: document.getElementById('zoom-fit'),
    zoomLevel: document.getElementById('zoom-level'),
    extractPage: document.getElementById('extract-page'),
    testTypeSelect: document.getElementById('test-type-select'),
    testTypeFilterInput: document.getElementById('test-type-filter'),
    testTypeFilterClear: document.getElementById('test-type-filter-clear'),
    testTypeSelectMeta: document.getElementById('test-type-select-meta'),
    testFormContainer: document.getElementById('test-form-container'),
    testList: document.getElementById('test-list'),
    testCount: document.getElementById('test-count'),
    ruleListFilters: document.getElementById('rule-list-filters'),
    ruleTypeFilterSelect: document.getElementById('rule-type-filter-select'),
    ruleGranularityFilterSelect: document.getElementById('rule-granularity-filter-select'),
    ruleTagFilterInput: document.getElementById('rule-tag-filter-input'),
    ruleListFilterClear: document.getElementById('rule-list-filter-clear'),
    clearAllTestsBtn: document.getElementById('clear-all-tests-btn'),
    verifyAllTestsBtn: document.getElementById('verify-all-tests-btn'),
    expectedMarkdown: document.getElementById('expected-markdown'),
    // Test panel toggle
    testPanel: document.getElementById('test-panel'),
    testPanelToggle: document.getElementById('test-panel-toggle'),
    testPanelClose: document.getElementById('test-panel-close'),
    documentTagsSection: document.getElementById('document-tags-section'),
    documentTagsToggle: document.getElementById('document-tags-toggle'),
    documentTagsBody: document.getElementById('document-tags-body'),
    documentTagsMeta: document.getElementById('document-tags-meta'),
    documentTagsEditor: document.getElementById('document-tags-editor'),
    addTestSection: document.getElementById('add-test-section'),
    addTestToggle: document.getElementById('add-test-toggle'),
    addTestBody: document.getElementById('add-test-body'),
    addTestSummary: document.getElementById('add-test-summary'),
    expectedMarkdownSection: document.getElementById('expected-markdown-section'),
    annotationModeParseBtn: document.getElementById('annotation-mode-parse'),
    annotationModeExtractBtn: document.getElementById('annotation-mode-extract'),
    extractEditorSection: document.getElementById('extract-editor-section'),
    extractKvRows: document.getElementById('extract-kv-rows'),
    extractConfigJson: document.getElementById('extract-config-json'),
    extractAddRowBtn: document.getElementById('extract-add-row'),
    extractSaveBtn: document.getElementById('extract-save'),
    extractFieldFilterBar: document.getElementById('extract-field-filter-bar'),
    extractFieldFilterSelect: document.getElementById('extract-field-filter-select'),
    extractPageFilterToggle: document.getElementById('extract-page-filter-toggle'),
    extractPageFilterMeta: document.getElementById('extract-page-filter-meta'),
    exportModal: document.getElementById('export-modal'),
    exportBasePath: document.getElementById('export-base-path'),
    exportFullPath: document.getElementById('export-full-path'),
    datasetName: document.getElementById('dataset-name'),
    includeSkipped: document.getElementById('include-skipped'),
    cancelExport: document.getElementById('cancel-export'),
    confirmExport: document.getElementById('confirm-export'),
    resizerPdf: document.getElementById('resizer-pdf'),
    resizerTest: document.getElementById('resizer-test'),
    toastContainer: document.getElementById('toast-container'),
    // Markdown Preview Panel
    markdownPanel: document.getElementById('markdown-panel'),
    markdownContent: document.getElementById('markdown-content'),
    markdownPreviewBtn: document.getElementById('markdown-preview-btn'),
    markdownPanelClose: document.getElementById('markdown-panel-close'),
    generateExpectedMdBtn: document.getElementById('generate-expected-md-btn'),
    layoutOverlayBtn: document.getElementById('layout-overlay-btn'),
    layoutOverlayLabel: document.getElementById('layout-overlay-label'),
    labelNamesToggleBtn: document.getElementById('label-names-toggle-btn'),
    labelNamesToggleLabel: document.getElementById('label-names-toggle-label'),
    tableEditorShell: document.getElementById('table-editor-shell'),
    tableEditorTitle: document.getElementById('table-editor-title'),
    tableEditorContext: document.getElementById('table-editor-context'),
    tableEditorStatus: document.getElementById('table-editor-status'),
    tableEditorSurroundings: document.getElementById('table-editor-surroundings'),
    tableEditorPrefixBlock: document.getElementById('table-editor-prefix-block'),
    tableEditorPrefixPreview: document.getElementById('table-editor-prefix-preview'),
    tableEditorSuffixBlock: document.getElementById('table-editor-suffix-block'),
    tableEditorSuffixPreview: document.getElementById('table-editor-suffix-preview'),
    tableEditorRoot: document.getElementById('table-editor-root'),
    tableEditorRaw: document.getElementById('table-editor-raw'),
    tableEditorModeHint: document.getElementById('table-editor-mode-hint'),
    tableEditorRawToggle: document.getElementById('table-editor-raw-toggle'),
    tableEditorCancel: document.getElementById('table-editor-cancel'),
    tableEditorSave: document.getElementById('table-editor-save'),
    tableEditorClose: document.getElementById('table-editor-close'),
    formulaEditorShell: document.getElementById('formula-editor-shell'),
    formulaEditorTitle: document.getElementById('formula-editor-title'),
    formulaEditorContext: document.getElementById('formula-editor-context'),
    formulaEditorStatus: document.getElementById('formula-editor-status'),
    formulaEditorRoot: document.getElementById('formula-editor-root'),
    formulaEditorRaw: document.getElementById('formula-editor-raw'),
    formulaEditorModeHint: document.getElementById('formula-editor-mode-hint'),
    formulaEditorRawToggle: document.getElementById('formula-editor-raw-toggle'),
    formulaEditorCancel: document.getElementById('formula-editor-cancel'),
    formulaEditorSave: document.getElementById('formula-editor-save'),
    formulaEditorClose: document.getElementById('formula-editor-close'),
    // Drag and drop / file upload
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle'),
    sidebarClose: document.getElementById('sidebar-close'),
    dropZone: document.getElementById('drop-zone'),
    queueToolsSection: document.getElementById('queue-tools-section'),
    queueToolsToggle: document.getElementById('queue-tools-toggle'),
    queueToolsFold: document.getElementById('queue-tools-fold'),
    queueToolsSummary: document.getElementById('queue-tools-summary'),
    fileSearchInput: document.getElementById('file-search-input'),
    fileSearchClear: document.getElementById('file-search-clear'),
    fileSearchStatus: document.getElementById('file-search-status'),
    addFilesBtn: document.getElementById('add-files-btn'),
    fileInput: document.getElementById('file-input'),
    // Directory browser
    selectDirBtn: document.getElementById('select-dir-btn'),
    currentDirLabel: document.getElementById('current-dir-label'),
    currentDirPath: document.getElementById('current-dir-path'),
    browseModal: document.getElementById('browse-modal'),
    closeBrowse: document.getElementById('close-browse'),
    browseUp: document.getElementById('browse-up'),
    browsePathInput: document.getElementById('browse-path-input'),
    browseGo: document.getElementById('browse-go'),
    browseList: document.getElementById('browse-list'),
    cancelBrowse: document.getElementById('cancel-browse'),
    confirmBrowse: document.getElementById('confirm-browse'),
    // AI Selection
    aiSelectBtn: document.getElementById('ai-select-btn'),
    selectionCanvas: document.getElementById('selection-canvas'),
    selectionBox: document.getElementById('selection-box'),
    // AI Sidebar
    aiSidebar: document.getElementById('ai-sidebar'),
    aiSidebarToggle: document.getElementById('ai-sidebar-toggle'),
    aiSidebarClose: document.getElementById('ai-sidebar-close'),
    aiFullPageBtn: document.getElementById('ai-full-page-btn'),
    aiDrawRegionBtn: document.getElementById('ai-draw-region-btn'),
    aiCustomPrompt: document.getElementById('ai-custom-prompt'),
    aiTestCountSlider: document.getElementById('ai-test-count-slider'),
    aiTestCountValue: document.getElementById('ai-test-count-value'),
    aiExtractTextBtn: document.getElementById('ai-extract-text-btn'),
    aiGenerateTestsBtn: document.getElementById('ai-generate-tests-btn'),
    aiReviewTestsBtn: document.getElementById('ai-review-tests-btn'),
    aiResultsContainer: document.getElementById('ai-results-container'),
    aiResultText: document.getElementById('ai-result-text'),
    aiCopyBtn: document.getElementById('ai-copy-btn'),
    aiClearSelectionBtn: document.getElementById('ai-clear-selection-btn'),
    aiSelectionStatus: document.getElementById('ai-selection-status'),
    // AI Settings
    aiSettingsBtn: document.getElementById('ai-settings-btn'),
    aiSettingsModal: document.getElementById('ai-settings-modal'),
    aiApiKeyInput: document.getElementById('ai-api-key-input'),
    aiModelSelect: document.getElementById('ai-model-select'),
    aiTestConnectionBtn: document.getElementById('ai-test-connection-btn'),
    aiSaveSettingsBtn: document.getElementById('ai-save-settings-btn'),
    aiCancelSettingsBtn: document.getElementById('ai-cancel-settings-btn'),
    // Test Types (inline)
    testTypesToggle: document.getElementById('test-types-toggle'),
    testTypesCheckboxes: document.getElementById('test-types-checkboxes'),
    testTypesLegend: document.getElementById('test-types-legend'),
    testTypesSummary: document.getElementById('test-types-summary'),
    foldArrow: document.getElementById('fold-arrow'),
    // Parse.md
    parseMdSection: document.getElementById('parse-md-section'),
    useParseMdCheckbox: document.getElementById('use-parse-md'),
    // Batch selection controls
    batchSelectControls: document.getElementById('batch-select-controls'),
    selectUntestedBtn: document.getElementById('select-untested-btn'),
    clearSelectionBtn: document.getElementById('clear-selection-btn'),
    batchSelectCount: document.getElementById('batch-select-count'),
};

// === Test Form Templates ===
const testForms = {
    present: `
        <form class="test-form" id="present-form">
            <div class="form-group">
                <label for="present-text">Text to find:</label>
                <textarea id="present-text" required placeholder="Enter text that must be present"></textarea>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="present-max-diffs">Max diffs (fuzzy):</label>
                    <input type="number" id="present-max-diffs" value="0" min="0">
                </div>
                <div class="form-group checkbox-group">
                    <label>
                        <input type="checkbox" id="present-case-sensitive" checked>
                        Case sensitive
                    </label>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="present-first-n">First N chars:</label>
                    <input type="number" id="present-first-n" min="0" placeholder="Optional">
                </div>
                <div class="form-group">
                    <label for="present-last-n">Last N chars:</label>
                    <input type="number" id="present-last-n" min="0" placeholder="Optional">
                </div>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">Add Test</button>
            </div>
        </form>
    `,
    absent: `
        <form class="test-form" id="absent-form">
            <div class="form-group">
                <label for="absent-text">Text that must NOT exist:</label>
                <textarea id="absent-text" required placeholder="Enter text that must be absent"></textarea>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="absent-max-diffs">Max diffs (fuzzy):</label>
                    <input type="number" id="absent-max-diffs" value="0" min="0">
                </div>
                <div class="form-group checkbox-group">
                    <label>
                        <input type="checkbox" id="absent-case-sensitive" checked>
                        Case sensitive
                    </label>
                </div>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">Add Test</button>
            </div>
        </form>
    `,
    order: `
        <form class="test-form" id="order-form">
            <div class="form-group">
                <label for="order-before">Text that appears FIRST:</label>
                <textarea id="order-before" required placeholder="This text must appear before..."></textarea>
            </div>
            <div class="form-group">
                <label for="order-after">Text that appears AFTER:</label>
                <textarea id="order-after" required placeholder="...this text"></textarea>
            </div>
            <div class="form-group">
                <label for="order-max-diffs">Max diffs (fuzzy):</label>
                <input type="number" id="order-max-diffs" value="0" min="0">
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">Add Test</button>
            </div>
        </form>
    `,
    table: `
        <form class="test-form" id="table-form">
            <div class="form-group">
                <label for="table-cell">Target cell value:</label>
                <input type="text" id="table-cell" required placeholder="Cell content to find">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="table-up">Cell above:</label>
                    <input type="text" id="table-up" placeholder="Optional">
                </div>
                <div class="form-group">
                    <label for="table-down">Cell below:</label>
                    <input type="text" id="table-down" placeholder="Optional">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="table-left">Cell left:</label>
                    <input type="text" id="table-left" placeholder="Optional">
                </div>
                <div class="form-group">
                    <label for="table-right">Cell right:</label>
                    <input type="text" id="table-right" placeholder="Optional">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="table-top-heading">Top heading:</label>
                    <input type="text" id="table-top-heading" placeholder="Optional">
                </div>
                <div class="form-group">
                    <label for="table-left-heading">Left heading:</label>
                    <input type="text" id="table-left-heading" placeholder="Optional">
                </div>
            </div>
            <div class="form-group">
                <label for="table-max-diffs">Max diffs (fuzzy):</label>
                <input type="number" id="table-max-diffs" value="0" min="0">
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">Add Test</button>
            </div>
        </form>
    `,
    chart_data_point: `
        <form class="test-form" id="chart-data-point-form">
            <div class="form-info">
                <small>Tests that a value is associated with labels in a table, regardless of row/column orientation. Useful for chart-to-table conversions.</small>
            </div>
            <div class="form-group">
                <label for="chart-value">Data point value:</label>
                <input type="text" id="chart-value" required placeholder="e.g., 102 or 39.2m">
            </div>
            <div class="form-group">
                <label for="chart-labels">Associated labels (one per line):</label>
                <textarea id="chart-labels" required placeholder="e.g.:\n50-249 employees\n2015"></textarea>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="chart-max-diffs">Max diffs (fuzzy):</label>
                    <input type="number" id="chart-max-diffs" value="2" min="0">
                </div>
                <div class="form-group checkbox-group">
                    <label>
                        <input type="checkbox" id="chart-normalize-numbers" checked>
                        Normalize numbers (39.2m ≈ 39.2)
                    </label>
                </div>
            </div>
            <div class="form-group">
                <label for="chart-tolerance">Tolerance % (1=default, 5=estimated):</label>
                <input type="number" id="chart-tolerance" value="1" min="1" max="50" step="1">
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">Add Test</button>
            </div>
        </form>
    `,
    layout: `
        <form class="test-form" id="layout-form">
            <div class="form-info">
                <small>Define a layout element with bounding box, class, and optional attributes/content. Reading order is managed from the Reading Order panel for the selected page.</small>
            </div>
            <div class="form-group">
                <label for="layout-class">Layout Class:</label>
                <select id="layout-class" required>
                    <option value="">-- Select class --</option>
                </select>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="layout-page">Page:</label>
                    <input type="number" id="layout-page" value="1" min="1" placeholder="1">
                </div>
                <div class="form-group">
                    <label>Reading Order:</label>
                    <div class="layout-ro-summary" id="layout-ro-summary">
                        <span id="layout-ro-display">Assigned from the Reading Order panel</span>
                        <strong id="layout-ro-badge">RO: --</strong>
                    </div>
                    <div class="form-hint">New layout elements default to the end of the target page, or can be inserted before/after an existing item from the Reading Order panel.</div>
                </div>
            </div>
            <div class="form-group">
                <label>Bounding Box (normalized 0-1):</label>
                <div class="bbox-inputs">
                    <div class="form-group">
                        <label for="layout-bbox-x">X</label>
                        <input type="number" id="layout-bbox-x" step="any" min="0" max="1" required placeholder="0.0">
                    </div>
                    <div class="form-group">
                        <label for="layout-bbox-y">Y</label>
                        <input type="number" id="layout-bbox-y" step="any" min="0" max="1" required placeholder="0.0">
                    </div>
                    <div class="form-group">
                        <label for="layout-bbox-w">W</label>
                        <input type="number" id="layout-bbox-w" step="any" min="0" max="1" required placeholder="0.0">
                    </div>
                    <div class="form-group">
                        <label for="layout-bbox-h">H</label>
                        <input type="number" id="layout-bbox-h" step="any" min="0" max="1" required placeholder="0.0">
                    </div>
                </div>
                <button type="button" class="btn btn-sm btn-draw-bbox" onclick="drawLayoutBbox()" style="margin-top: 8px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/>
                    </svg>
                    Draw on Canvas
                </button>
            </div>
            <div class="form-group">
                <label>Attributes (optional):</label>
                <div id="layout-attributes-container" class="attributes-container"></div>
                <button type="button" class="btn btn-xs btn-secondary btn-add-attribute" onclick="addLayoutAttribute()">+ Add Attribute</button>
            </div>
            <div class="form-group">
                <label>Content (optional):</label>
                <div class="content-type-selector">
                    <label><input type="radio" name="layout-content-type" value="none" checked onchange="toggleLayoutContentInput()"> None</label>
                    <label><input type="radio" name="layout-content-type" value="text" onchange="toggleLayoutContentInput()"> Text</label>
                    <label><input type="radio" name="layout-content-type" value="html" onchange="toggleLayoutContentInput()"> HTML</label>
                </div>
                <textarea id="layout-content" class="layout-content-textarea" style="display: none;" placeholder="Enter content..."></textarea>
                <div class="layout-content-actions" id="layout-content-actions" hidden>
                    <button type="button" class="btn btn-sm btn-secondary" id="layout-open-table-editor-btn">Open Table Editor</button>
                    <button type="button" class="btn btn-sm btn-ghost" id="layout-edit-raw-html-btn">Edit Raw HTML</button>
                    <button type="button" class="btn btn-sm btn-secondary" id="layout-open-formula-editor-btn" hidden>Open Formula Editor</button>
                    <button type="button" class="btn btn-sm btn-ghost" id="layout-edit-raw-latex-btn" hidden>Edit Raw LaTeX</button>
                </div>
                <div class="form-hint" id="layout-content-editor-hint">Table editor changes only the detected table fragment. Any text before or after the table stays read-only and is preserved on save.</div>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">Add Test</button>
            </div>
        </form>
    `,
};

// === Utility Functions ===
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function truncate(str, maxLen = 50) {
    if (!str) return '';
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function inlineJsStringLiteral(value) {
    return escapeHtml(JSON.stringify(String(value ?? '')));
}

function sanitizeIdComponent(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getRuleDefinition(type) {
    return ruleDefinitionsByType.get(type) || null;
}

function getMergedDefinitionFields(definition) {
    const fields = [];
    const seen = new Set();
    const hiddenBaseFieldNames = new Set(['id', 'layout_id', 'layout_ids', 'layout_bindings', 'layout_elements']);

    // Do not expose id in the generic form; ids are assigned/preserved automatically.
    for (const baseField of ruleBaseFields || []) {
        if (hiddenBaseFieldNames.has(baseField?.name)) continue;
        if (!baseField?.name || seen.has(baseField.name)) continue;
        fields.push(baseField);
        seen.add(baseField.name);
    }
    for (const field of definition?.fields || []) {
        if (!field?.name || seen.has(field.name)) continue;
        fields.push(field);
        seen.add(field.name);
    }
    return fields;
}

function validateRuleDefinitionsManifest(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Rule definitions manifest must be an object');
    }
    if (!Array.isArray(payload.rules)) {
        throw new Error("Rule definitions manifest missing 'rules' array");
    }
    if (payload.base_fields && !Array.isArray(payload.base_fields)) {
        throw new Error("Rule definitions manifest 'base_fields' must be an array");
    }

    const seen = new Set();
    for (const rule of payload.rules) {
        if (!rule || typeof rule !== 'object') {
            throw new Error('Each rule definition must be an object');
        }
        if (!rule.type || typeof rule.type !== 'string') {
            throw new Error('Each rule definition requires a string type');
        }
        if (seen.has(rule.type)) {
            throw new Error(`Duplicate rule type in manifest: ${rule.type}`);
        }
        seen.add(rule.type);
        if (!Array.isArray(rule.fields)) {
            throw new Error(`Rule '${rule.type}' is missing fields array`);
        }
        if (!Array.isArray(rule.summary_fields)) {
            throw new Error(`Rule '${rule.type}' is missing summary_fields array`);
        }
    }
}

async function loadRuleDefinitions() {
    try {
        const response = await fetch('/static/rule_definitions.json');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        validateRuleDefinitionsManifest(payload);

        ruleDefinitionsManifest = payload;
        ruleBaseFields = Array.isArray(payload.base_fields) ? payload.base_fields : [];
        ruleDefinitionsByType = new Map(payload.rules.map(rule => [rule.type, rule]));

        populateTestTypeSelectOptions();
        return true;
    } catch (error) {
        console.error('Failed to load rule definitions manifest:', error);
        showToast('Rule definitions manifest failed to load; using legacy forms', 'error');
        ruleDefinitionsManifest = null;
        ruleBaseFields = [];
        ruleDefinitionsByType = new Map();
        return false;
    }
}

function toTitleCaseType(type) {
    return String(type || '')
        .split('_')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function getRuleDefinitionsList() {
    if (!ruleDefinitionsManifest || !Array.isArray(ruleDefinitionsManifest.rules)) return [];
    return ruleDefinitionsManifest.rules.slice();
}

function getServerGeneratableTypeSet() {
    if (!Array.isArray(vlmConfig?.generatable_test_types)) return null;
    return new Set(vlmConfig.generatable_test_types.filter(type => typeof type === 'string' && type));
}

function refreshAiTypeMetadata() {
    const definitions = getRuleDefinitionsList();
    if (!definitions.length) {
        aiGeneratableTypes = new Set(DEFAULT_TEST_TYPES);
        aiManualOnlyTypes = new Set();
        return;
    }

    const serverTypeSet = getServerGeneratableTypeSet();
    const nextGeneratable = new Set();
    const nextManual = new Set();

    for (const definition of definitions) {
        const manifestAi = Boolean(definition.ai_supported);
        const serverAi = serverTypeSet ? serverTypeSet.has(definition.type) : manifestAi;
        if (manifestAi && serverAi) {
            nextGeneratable.add(definition.type);
        } else {
            nextManual.add(definition.type);
        }
    }

    if (!nextGeneratable.size) {
        DEFAULT_TEST_TYPES.forEach(type => nextGeneratable.add(type));
    }

    aiGeneratableTypes = nextGeneratable;
    aiManualOnlyTypes = nextManual;
}

function sanitizeSelectedTestTypes() {
    const allowed = new Set(aiGeneratableTypes);
    selectedTestTypes = selectedTestTypes.filter(type => allowed.has(type));

    if (!selectedTestTypes.length) {
        const fallback = DEFAULT_TEST_TYPES.filter(type => allowed.has(type));
        selectedTestTypes = fallback.length ? fallback : Array.from(allowed).slice(0, 4);
    }
}

function getDefinitionDescription(definition) {
    if (!definition) return '';
    if (definition.description) return String(definition.description);
    const availability = aiGeneratableTypes.has(definition.type) ? 'AI-generatable' : 'Manual-only';
    return `${toTitleCaseType(definition.category || 'other')} rule (${availability})`;
}

function matchesTypeFilter(definition, filterText) {
    if (!filterText) return true;
    const haystack = [
        definition.type,
        toTitleCaseType(definition.type),
        definition.category || '',
        definition.description || '',
    ].join(' ').toLowerCase();
    return haystack.includes(filterText);
}

function populateTestTypeSelectOptions() {
    if (!elements.testTypeSelect) return;
    if (!ruleDefinitionsManifest || !Array.isArray(ruleDefinitionsManifest.rules)) return;

    refreshAiTypeMetadata();
    sanitizeSelectedTestTypes();

    const previousValue = elements.testTypeSelect.value;
    const filterText = (testTypeFilterQuery || '').trim().toLowerCase();
    const grouped = new Map();
    let visibleCount = 0;
    let visibleAiCount = 0;

    for (const definition of ruleDefinitionsManifest.rules) {
        if (!matchesTypeFilter(definition, filterText)) continue;
        const category = definition.category || 'other';
        if (!grouped.has(category)) grouped.set(category, []);
        grouped.get(category).push(definition);
        visibleCount += 1;
        if (aiGeneratableTypes.has(definition.type)) {
            visibleAiCount += 1;
        }
    }

    const categories = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
    let html = '<option value="">-- Select type --</option>';

    for (const category of categories) {
        const options = grouped.get(category)
            .slice()
            .sort((a, b) => a.type.localeCompare(b.type))
            .map(definition => {
                const availability = aiGeneratableTypes.has(definition.type) ? 'AI' : 'Manual';
                const description = getDefinitionDescription(definition);
                const label = `${toTitleCaseType(definition.type)} (${definition.type}) | ${availability}`;
                return `<option value="${escapeHtml(definition.type)}" title="${escapeHtml(description)}">${escapeHtml(label)}</option>`;
            })
            .join('');
        if (!options) continue;
        html += `<optgroup label="${escapeHtml(toTitleCaseType(category))}">${options}</optgroup>`;
    }

    if (visibleCount === 0) {
        html += '<option value="" disabled>No matching types for current filter</option>';
    }

    html += '<option value="__raw_json__">Raw JSON (Custom / Unknown)</option>';
    elements.testTypeSelect.innerHTML = html;

    if (previousValue && elements.testTypeSelect.querySelector(`option[value="${CSS.escape(previousValue)}"]`)) {
        elements.testTypeSelect.value = previousValue;
    } else if (elements.testTypeSelect.value === previousValue && previousValue) {
        elements.testTypeSelect.value = '';
    }

    if (elements.testTypeSelectMeta) {
        const manualCount = Math.max(0, visibleCount - visibleAiCount);
        const filterSuffix = filterText ? ' (filtered)' : '';
        elements.testTypeSelectMeta.textContent = `${visibleCount} rule types${filterSuffix} | ${visibleAiCount} AI | ${manualCount} manual`;
    }

    updateAddTestSummary();
    renderAiTestTypeOptions();
}

function serializeValueForFieldInput(kind, value) {
    if (value === undefined || value === null) return '';
    switch (kind) {
        case 'string_array':
            return Array.isArray(value) ? value.map(v => String(v)).join('\n') : String(value);
        case 'string_int_map':
            if (typeof value === 'object' && !Array.isArray(value)) {
                return Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n');
            }
            return String(value);
        case 'table_like_2d':
        case 'json':
        case 'object':
            return JSON.stringify(value, null, 2);
        case 'boolean':
            return Boolean(value);
        default:
            return String(value);
    }
}

function dedupeTags(tags) {
    if (ruleTagHelpers?.dedupeTags) {
        return ruleTagHelpers.dedupeTags(tags);
    }
    const seen = new Set();
    const unique = [];
    for (const tag of tags || []) {
        const cleaned = String(tag || '').trim();
        if (!cleaned) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(cleaned);
    }
    return unique;
}

function parseRuleTagFilterTokens(rawValue) {
    return String(rawValue || '')
        .split(',')
        .map(token => token.trim().toLowerCase())
        .filter(Boolean);
}

function applyRuleTagsToPayload(rule, nextTags) {
    const normalizedTags = dedupeTags(Array.isArray(nextTags) ? nextTags : []);
    if (ruleTagHelpers?.applyRuleTags) {
        ruleTagHelpers.applyRuleTags(rule, normalizedTags);
        return normalizedTags;
    }
    if (normalizedTags.length > 0) {
        rule.tags = normalizedTags;
    } else if (rule && typeof rule === 'object') {
        delete rule.tags;
    }
    return normalizedTags;
}

function renderRuleTagsHtml(tags, options = {}) {
    const normalizedTags = dedupeTags(Array.isArray(tags) ? tags : []);
    if (!normalizedTags.length) return '';
    if (ruleTagHelpers?.renderRuleTagsHtml) {
        return ruleTagHelpers.renderRuleTagsHtml(normalizedTags, options);
    }
    const containerClass = escapeHtml(options.containerClass || 'test-item-tags');
    const chipClass = escapeHtml(options.chipClass || 'tag-chip');
    return `
        <div class="${containerClass}">
            ${normalizedTags.map(tag => `
                <span class="${chipClass}">
                    <span class="tag-chip-label">${escapeHtml(tag)}</span>
                </span>
            `).join('')}
        </div>
    `;
}

function getCurrentDocumentTags() {
    return dedupeTags(Array.isArray(currentTests?.tags) ? currentTests.tags : []);
}

function updateDocumentTagsMeta(nextTags = getCurrentDocumentTags()) {
    if (!elements.documentTagsMeta) return;
    const tagCount = Array.isArray(nextTags) ? nextTags.length : 0;
    elements.documentTagsMeta.textContent = tagCount === 0
        ? 'No tags'
        : `${tagCount} tag${tagCount === 1 ? '' : 's'}`;
}

function renderCurrentFileMetadata() {
    if (elements.currentFileName) {
        elements.currentFileName.textContent = currentFile?.name || 'Select a file to start';
    }
    if (elements.currentFileGroup) {
        elements.currentFileGroup.textContent = currentFile && currentFile.group !== 'root'
            ? `Group: ${currentFile.group}`
            : '';
    }
    if (elements.currentFileTags) {
        elements.currentFileTags.innerHTML = renderRuleTagsHtml(getCurrentDocumentTags(), {
            containerClass: 'file-tag-list',
            chipClass: 'tag-chip file-tag-chip',
        });
    }
}

function setCurrentDocumentTags(nextTags) {
    const normalizedTags = dedupeTags(Array.isArray(nextTags) ? nextTags : []);
    if (!currentTests || typeof currentTests !== 'object' || Array.isArray(currentTests)) {
        currentTests = { test_rules: [], expected_markdown: null, tags: normalizedTags };
    } else {
        currentTests.tags = normalizedTags;
    }
    updateDocumentTagsMeta(normalizedTags);
    renderCurrentFileMetadata();
    return normalizedTags;
}

function handleDocumentTagWidgetChange(event) {
    const input = event?.target;
    if (!input?.matches?.('[data-document-tags-hidden="true"]')) {
        return;
    }
    const nextTags = Array.isArray(event.detail?.tags)
        ? event.detail.tags
        : parseStringArray(input.value || '');
    setCurrentDocumentTags(nextTags);
}

function renderDocumentTagEditor() {
    if (!elements.documentTagsEditor) return;

    elements.documentTagsEditor.innerHTML = buildTagInputFieldHtml(
        'document-tags-input',
        'document_tags',
        { placeholder: 'Type a document tag and press Enter' },
        getCurrentDocumentTags(),
        '',
    );

    const hiddenInput = elements.documentTagsEditor.querySelector('#document-tags-input-hidden');
    if (hiddenInput) {
        hiddenInput.dataset.documentTagsHidden = 'true';
    }
    initTagInputWidgets(elements.documentTagsEditor);
    updateDocumentTagsMeta();
}

function setDocumentTagsCollapsed(collapsed, persist = true) {
    documentTagsCollapsed = Boolean(collapsed);
    elements.documentTagsSection?.classList.toggle('collapsed', documentTagsCollapsed);

    if (elements.documentTagsToggle) {
        elements.documentTagsToggle.setAttribute('aria-expanded', String(!documentTagsCollapsed));
        elements.documentTagsToggle.title = documentTagsCollapsed
            ? 'Expand document tags'
            : 'Collapse document tags';
    }
    if (elements.documentTagsBody) {
        elements.documentTagsBody.hidden = documentTagsCollapsed;
    }
    if (persist) {
        writeStoredBoolean(STORAGE_KEYS.documentTagsCollapsed, documentTagsCollapsed);
    }
}

function setPdfControlsCollapsed(collapsed, persist = true) {
    pdfControlsCollapsed = Boolean(collapsed);
    elements.pdfControls?.classList.toggle('collapsed', pdfControlsCollapsed);

    if (elements.pdfControlsToggle) {
        elements.pdfControlsToggle.setAttribute('aria-expanded', String(!pdfControlsCollapsed));
        elements.pdfControlsToggle.title = pdfControlsCollapsed
            ? 'Expand PDF controls'
            : 'Collapse PDF controls';
    }
    if (elements.pdfToolRow) {
        elements.pdfToolRow.hidden = pdfControlsCollapsed;
    }
    if (persist) {
        writeStoredBoolean(STORAGE_KEYS.pdfControlsCollapsed, pdfControlsCollapsed);
    }
}

function updateAddTestSummary() {
    if (!elements.addTestSummary) return;

    const selectedValue = elements.testTypeSelect?.value || '';
    const selectedOption = elements.testTypeSelect?.selectedOptions?.[0];
    if (selectedValue && selectedOption) {
        elements.addTestSummary.textContent = selectedOption.textContent.trim();
        return;
    }

    const filterText = (testTypeFilterQuery || '').trim();
    if (filterText) {
        elements.addTestSummary.textContent = `Filtered by "${filterText}"`;
        return;
    }

    const metaText = elements.testTypeSelectMeta?.textContent?.trim();
    elements.addTestSummary.textContent = metaText || 'Select rule type';
}

function setAddTestCollapsed(collapsed, persist = true) {
    addTestCollapsed = Boolean(collapsed);
    elements.addTestSection?.classList.toggle('collapsed', addTestCollapsed);

    if (elements.addTestToggle) {
        elements.addTestToggle.setAttribute('aria-expanded', String(!addTestCollapsed));
        elements.addTestToggle.title = addTestCollapsed
            ? 'Expand add test'
            : 'Collapse add test';
    }
    if (elements.addTestBody) {
        elements.addTestBody.hidden = addTestCollapsed;
    }
    updateAddTestSummary();
    if (persist) {
        writeStoredBoolean(STORAGE_KEYS.addTestCollapsed, addTestCollapsed);
    }
}

if (elements.documentTagsSection && elements.documentTagsSection.dataset.bound !== 'true') {
    elements.documentTagsSection.dataset.bound = 'true';
    elements.documentTagsSection.addEventListener('tag-widget-change', handleDocumentTagWidgetChange);
}

function buildStaticRuleTagFieldHtml(existingTags = []) {
    return `
        <div class="form-group static-rule-tags-group">
            <label for="static-rule-tags">Tags</label>
            ${buildTagInputFieldHtml(
        'static-rule-tags',
        'tags',
        { placeholder: 'Type a tag and press Enter' },
        existingTags,
        '',
    )}
        </div>
    `;
}

function injectStaticRuleTagField(form, existingRule = null) {
    if (!form || form.querySelector('.static-rule-tags-group')) return;
    const formActions = form.querySelector('.form-actions');
    if (!formActions) return;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildStaticRuleTagFieldHtml(existingRule?.tags || []);
    const tagField = wrapper.firstElementChild;
    if (!tagField) return;
    formActions.before(tagField);
}

function collectRuleTagsFromRoot(root) {
    const hiddenInput = root?.querySelector('[data-rule-field="tags"]');
    if (!hiddenInput) return [];
    try {
        return dedupeTags(parseStringArray(hiddenInput.value || ''));
    } catch {
        return [];
    }
}

function ruleMatchesActiveFilters(rule) {
    if (!rule) return false;
    if (ruleListTypeFilter && rule.type !== ruleListTypeFilter) {
        return false;
    }
    // Granularity filter applies only to layout rules. Non-layout
    // rules (present, absent, order, table, ...) pass this gate
    // unconditionally so changing the granularity filter doesn't
    // hide unrelated parse rules.
    if (ruleListGranularityFilter && rule.type === 'layout') {
        if (getRuleGranularity(rule) !== ruleListGranularityFilter) {
            return false;
        }
    }

    const tagFilters = parseRuleTagFilterTokens(ruleListTagFilter);
    if (!tagFilters.length) return true;

    const tags = Array.isArray(rule.tags) ? rule.tags : [];
    if (!tags.length) return false;

    const loweredTags = tags.map(tag => String(tag || '').toLowerCase());
    return tagFilters.some(filterTag => loweredTags.some(tag => tag.includes(filterTag)));
}

function populateRuleListFilterOptions(rules) {
    const select = elements.ruleTypeFilterSelect;
    if (!select) return;

    const currentValue = ruleListTypeFilter || '';
    const types = Array.from(new Set((rules || []).map(rule => rule?.type).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const options = ['<option value="">All rule types</option>', ...types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)];
    select.innerHTML = options.join('');

    if (currentValue && types.includes(currentValue)) {
        select.value = currentValue;
    } else {
        ruleListTypeFilter = '';
        select.value = '';
    }
}

function dedupeStringsPreserveOrder(values) {
    const seen = new Set();
    const unique = [];
    for (const value of values || []) {
        const cleaned = String(value || '').trim();
        if (!cleaned || seen.has(cleaned)) continue;
        seen.add(cleaned);
        unique.push(cleaned);
    }
    return unique;
}

function sanitizeLayoutIdValue(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    return cleaned || null;
}

function normalizeGroundingBindings(rawBindings) {
    if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) {
        return {};
    }

    const normalized = {};
    for (const [role, rawValue] of Object.entries(rawBindings)) {
        const roleName = String(role || '').trim();
        if (!roleName) continue;
        if (typeof rawValue === 'string') {
            const cleaned = sanitizeLayoutIdValue(rawValue);
            if (cleaned) normalized[roleName] = cleaned;
            continue;
        }
        if (Array.isArray(rawValue)) {
            const ids = dedupeStringsPreserveOrder(rawValue.map(v => sanitizeLayoutIdValue(v)).filter(Boolean));
            if (ids.length === 1) {
                normalized[roleName] = ids[0];
            } else if (ids.length > 1) {
                normalized[roleName] = ids;
            }
        }
    }
    return normalized;
}

function flattenGroundingBindingIds(bindings) {
    const ids = [];
    for (const value of Object.values(bindings || {})) {
        if (typeof value === 'string') {
            ids.push(value);
        } else if (Array.isArray(value)) {
            ids.push(...value.filter(item => typeof item === 'string'));
        }
    }
    return dedupeStringsPreserveOrder(ids);
}

function getNormalizedRuleGrounding(rule, ruleType) {
    const layoutId = sanitizeLayoutIdValue(rule?.layout_id);
    const layoutIds = Array.isArray(rule?.layout_ids)
        ? dedupeStringsPreserveOrder(rule.layout_ids.map(v => sanitizeLayoutIdValue(v)).filter(Boolean))
        : [];
    const rawBindings = normalizeGroundingBindings(rule?.layout_bindings);
    const layoutBindings = {};

    if (ruleType === 'order') {
        for (const role of GROUNDING_ROLE_ORDER) {
            const value = rawBindings[role];
            if (typeof value === 'string') {
                layoutBindings[role] = value;
            } else if (Array.isArray(value) && value.length > 0) {
                layoutBindings[role] = value[0];
            }
        }
    }

    const allIds = dedupeStringsPreserveOrder([
        ...(layoutId ? [layoutId] : []),
        ...layoutIds,
        ...flattenGroundingBindingIds(layoutBindings),
    ]);
    const normalizedLayoutId = layoutId || allIds[0] || null;

    if (ruleType !== 'order') {
        const primary = normalizedLayoutId || allIds[0] || null;
        return {
            layout_id: primary,
            layout_ids: primary ? [primary] : [],
            layout_bindings: {},
        };
    }

    return {
        layout_id: normalizedLayoutId,
        layout_ids: allIds,
        layout_bindings: layoutBindings,
    };
}

function applyGroundingToRulePayload(rule, groundingState, ruleType) {
    const normalized = getNormalizedRuleGrounding(groundingState || {}, ruleType);
    delete rule.layout_elements;
    delete rule.layout_id;
    delete rule.layout_ids;
    delete rule.layout_bindings;

    if (normalized.layout_id) {
        rule.layout_id = normalized.layout_id;
    }
    if (Array.isArray(normalized.layout_ids) && normalized.layout_ids.length > 0) {
        rule.layout_ids = normalized.layout_ids;
    }
    if (normalized.layout_bindings && Object.keys(normalized.layout_bindings).length > 0) {
        rule.layout_bindings = normalized.layout_bindings;
    }
}

function shouldShowGroundingSection(ruleType) {
    return Boolean(ruleType) && ruleType !== 'layout' && ruleType !== RAW_JSON_TEST_TYPE;
}

function getGroundableLayoutTests() {
    if (!currentTests || !Array.isArray(currentTests.test_rules)) return [];
    return currentTests.test_rules
        .map((test, index) => ({
            index,
            id: sanitizeLayoutIdValue(test?.id),
            page: test?.page,
            canonical_class: test?.canonical_class || 'layout',
            type: test?.type,
        }))
        .filter(item => item.type === 'layout' && item.id);
}

function getGroundingLayoutIndexById(layoutId) {
    const targetId = sanitizeLayoutIdValue(layoutId);
    if (!targetId || !currentTests || !Array.isArray(currentTests.test_rules)) return null;
    for (let index = 0; index < currentTests.test_rules.length; index += 1) {
        const test = currentTests.test_rules[index];
        if (test?.type !== 'layout') continue;
        if (sanitizeLayoutIdValue(test?.id) === targetId) return index;
    }
    return null;
}

function setGroundingPickerContext(context) {
    const previous = groundingPickerContext;
    groundingPickerContext = context;

    if (previous?.form && document.body.contains(previous.form)) {
        renderVisualGroundingSection(previous.form, previous.ruleType);
    }
    if (context?.form && document.body.contains(context.form)) {
        renderVisualGroundingSection(context.form, context.ruleType);
    }
}

function getGroundingSection(form) {
    return form?.querySelector('[data-visual-grounding-section]') || null;
}

function startGroundingPickMode(form, ruleType, role = null) {
    const available = getGroundableLayoutTests();
    if (!available.length) {
        showToast('Create layout annotations with ids before linking visual grounding', 'error');
        return;
    }
    setGroundingPickerContext({ form, ruleType, role });
    if (!layoutOverlayVisible) {
        layoutOverlayVisible = true;
        renderLayoutOverlay();
    }
    const roleText = role ? `${role} ` : '';
    showToast(`Click a layout box to link ${roleText}grounding`, 'info');
}

function clearGroundingForRole(state, role) {
    if (!state?.layout_bindings) return;
    delete state.layout_bindings[role];
    if (state.layout_bindings) {
        const roleIds = GROUNDING_ROLE_ORDER
            .map(name => {
                const value = state.layout_bindings[name];
                return Array.isArray(value) ? value[0] : value;
            })
            .map(id => sanitizeLayoutIdValue(id))
            .filter(Boolean);
        const deduped = dedupeStringsPreserveOrder(roleIds);
        state.layout_ids = deduped;
        state.layout_id = deduped[0] || null;
    }
}

function setGroundingFromLayoutSelection(form, ruleType, layoutId, role = null) {
    if (!form) return;
    const normalizedId = sanitizeLayoutIdValue(layoutId);
    if (!normalizedId) return;

    const state = getNormalizedRuleGrounding(form.__groundingState || {}, ruleType);
    if (ruleType === 'order' && role) {
        state.layout_bindings = { ...(state.layout_bindings || {}), [role]: normalizedId };
        const roleIds = GROUNDING_ROLE_ORDER
            .map(name => sanitizeLayoutIdValue(state.layout_bindings?.[name]))
            .filter(Boolean);
        const deduped = dedupeStringsPreserveOrder(roleIds);
        state.layout_ids = deduped;
        state.layout_id = deduped[0] || null;
    } else {
        state.layout_id = normalizedId;
        state.layout_ids = [normalizedId];
        if (ruleType !== 'order') {
            state.layout_bindings = {};
        }
    }

    form.__groundingState = getNormalizedRuleGrounding(state, ruleType);
    renderVisualGroundingSection(form, ruleType);
}

function maybeApplyGroundingPick(index) {
    if (!groundingPickerContext) return;
    const { form, ruleType, role } = groundingPickerContext;
    if (!form || !document.body.contains(form)) {
        setGroundingPickerContext(null);
        return;
    }

    const layoutTest = currentTests?.test_rules?.[index];
    const layoutId = sanitizeLayoutIdValue(layoutTest?.id);
    if (!layoutId) {
        showToast('Selected layout element has no id; assign an id first', 'error');
        return;
    }

    setGroundingFromLayoutSelection(form, ruleType, layoutId, role);
    setGroundingPickerContext(null);
    const roleText = role ? `${role} ` : '';
    showToast(`Linked ${roleText}grounding to ${layoutId}`, 'success');
}

function selectLayoutByElementId(layoutId) {
    const targetIndex = getGroundingLayoutIndexById(layoutId);
    if (targetIndex === null) {
        showToast(`Linked layout id '${layoutId}' no longer exists`, 'error');
        return;
    }
    selectLayoutTest(targetIndex);
}

function buildGroundingChipsHtml(ids, availableIndexById, options = {}) {
    const removeAction = options.removeAction || null;
    if (!Array.isArray(ids) || ids.length === 0) {
        return '<span class="grounding-empty-value">No linked layout element</span>';
    }
    return ids.map(id => {
        const layoutId = sanitizeLayoutIdValue(id);
        if (!layoutId) return '';
        const hasTarget = availableIndexById.has(layoutId);
        const missingClass = hasTarget ? '' : 'missing';
        const removeButton = removeAction
            ? `<button type="button" class="tag-chip-remove" data-grounding-remove-id="${escapeHtml(layoutId)}" data-grounding-remove-action="${escapeHtml(removeAction)}" aria-label="Remove ${escapeHtml(layoutId)}">&times;</button>`
            : '';
        const targetButton = hasTarget
            ? `<button type="button" class="grounding-chip-jump" data-layout-link-id="${escapeHtml(layoutId)}" title="Jump to linked layout">${escapeHtml(layoutId)}</button>`
            : `<span class="grounding-chip-jump">${escapeHtml(layoutId)}</span>`;
        return `
            <span class="tag-chip grounding-chip ${missingClass}">
                ${targetButton}
                ${removeButton}
            </span>
        `;
    }).filter(Boolean).join('');
}

function renderVisualGroundingSection(form, ruleType) {
    const section = getGroundingSection(form);
    if (!section) return;

    const available = getGroundableLayoutTests();
    const availableIndexById = new Map(available.map(item => [item.id, item.index]));
    const selectedLayout = selectedLayoutTestIndex !== null
        ? currentTests?.test_rules?.[selectedLayoutTestIndex]
        : null;
    const selectedLayoutId = sanitizeLayoutIdValue(selectedLayout?.id);
    const state = getNormalizedRuleGrounding(form.__groundingState || {}, ruleType);
    form.__groundingState = state;

    const statusEl = section.querySelector('[data-grounding-status]');
    if (statusEl) {
        if (!available.length) {
            statusEl.textContent = 'No layout annotations with ids are available in this file.';
            statusEl.classList.add('is-warning');
        } else if (selectedLayoutId) {
            statusEl.textContent = `Selected layout: ${selectedLayoutId}`;
            statusEl.classList.remove('is-warning');
        } else {
            statusEl.textContent = `${available.length} layout annotation${available.length === 1 ? '' : 's'} available for linking.`;
            statusEl.classList.remove('is-warning');
        }
    }

    if (ruleType === 'order') {
        for (const role of GROUNDING_ROLE_ORDER) {
            const roleList = section.querySelector(`[data-grounding-role-chip-list="${CSS.escape(role)}"]`);
            if (!roleList) continue;
            const rawValue = state.layout_bindings?.[role];
            const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
            const ids = value ? [value] : [];
            roleList.innerHTML = buildGroundingChipsHtml(ids, availableIndexById, { removeAction: role });
        }
        const combinedList = section.querySelector('[data-grounding-chip-list]');
        if (combinedList) {
            combinedList.innerHTML = buildGroundingChipsHtml(state.layout_ids, availableIndexById);
        }
    } else {
        const chipList = section.querySelector('[data-grounding-chip-list]');
        if (chipList) {
            chipList.innerHTML = buildGroundingChipsHtml(state.layout_ids, availableIndexById, { removeAction: 'all' });
        }
    }

    section.querySelectorAll('[data-grounding-action="use-selected"], [data-grounding-action="pick-overlay"]').forEach(button => {
        button.disabled = !available.length;
    });

    const isPickerForThisForm = groundingPickerContext?.form === form;
    section.classList.toggle('pick-mode-active', isPickerForThisForm);
    section.querySelectorAll('[data-grounding-action="pick-overlay"]').forEach(button => {
        const role = button.dataset.groundingRole || null;
        const isActive = isPickerForThisForm && (groundingPickerContext?.role || null) === role;
        button.classList.toggle('active', isActive);
    });
}

function initVisualGroundingForm(form, ruleType, existingRule = null) {
    if (!form || !shouldShowGroundingSection(ruleType)) return;
    if (getGroundingSection(form)) return;

    const section = document.createElement('div');
    section.className = 'visual-grounding-section';
    section.setAttribute('data-visual-grounding-section', 'true');
    section.innerHTML = ruleType === 'order'
        ? `
            <div class="visual-grounding-header">
                <span>Visual Grounding</span>
                <small>Link each order anchor to a layout element.</small>
            </div>
            <div class="visual-grounding-status" data-grounding-status></div>
            <div class="visual-grounding-roles">
                ${GROUNDING_ROLE_ORDER.map(role => `
                    <div class="visual-grounding-role-row">
                        <div class="visual-grounding-role-label">${escapeHtml(toTitleCaseType(role))}</div>
                        <div class="visual-grounding-role-chips" data-grounding-role-chip-list="${escapeHtml(role)}"></div>
                        <div class="visual-grounding-actions">
                            <button type="button" class="btn btn-xs btn-secondary" data-grounding-action="use-selected" data-grounding-role="${escapeHtml(role)}">Link Selected</button>
                            <button type="button" class="btn btn-xs btn-secondary" data-grounding-action="pick-overlay" data-grounding-role="${escapeHtml(role)}">Pick on Page</button>
                            <button type="button" class="btn btn-xs btn-ghost" data-grounding-action="clear-role" data-grounding-role="${escapeHtml(role)}">Clear</button>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="visual-grounding-all-links">
                <label>All linked layout ids</label>
                <div class="visual-grounding-chip-list" data-grounding-chip-list></div>
            </div>
        `
        : `
            <div class="visual-grounding-header">
                <span>Visual Grounding</span>
                <small>Link this rule to a layout element in the same file.</small>
            </div>
            <div class="visual-grounding-status" data-grounding-status></div>
            <div class="visual-grounding-chip-list" data-grounding-chip-list></div>
            <div class="visual-grounding-actions">
                <button type="button" class="btn btn-xs btn-secondary" data-grounding-action="use-selected">Link Selected</button>
                <button type="button" class="btn btn-xs btn-secondary" data-grounding-action="pick-overlay">Pick on Page</button>
                <button type="button" class="btn btn-xs btn-ghost" data-grounding-action="clear-all">Clear</button>
            </div>
        `;

    const actions = form.querySelector('.form-actions');
    if (actions) {
        form.insertBefore(section, actions);
    } else {
        form.appendChild(section);
    }

    form.__groundingState = getNormalizedRuleGrounding(existingRule || {}, ruleType);

    section.addEventListener('click', (event) => {
        const jumpChip = event.target.closest('[data-layout-link-id]');
        if (jumpChip) {
            event.preventDefault();
            event.stopPropagation();
            selectLayoutByElementId(jumpChip.dataset.layoutLinkId);
            return;
        }

        const removeChip = event.target.closest('[data-grounding-remove-id]');
        if (removeChip) {
            const removeId = sanitizeLayoutIdValue(removeChip.dataset.groundingRemoveId);
            const removeAction = removeChip.dataset.groundingRemoveAction || 'all';
            const state = getNormalizedRuleGrounding(form.__groundingState || {}, ruleType);
            if (removeId) {
                if (ruleType === 'order' && removeAction !== 'all') {
                    clearGroundingForRole(state, removeAction);
                } else {
                    state.layout_id = null;
                    state.layout_ids = [];
                    state.layout_bindings = {};
                }
            }
            form.__groundingState = getNormalizedRuleGrounding(state, ruleType);
            renderVisualGroundingSection(form, ruleType);
            return;
        }

        const actionButton = event.target.closest('[data-grounding-action]');
        if (!actionButton) return;

        event.preventDefault();
        const action = actionButton.dataset.groundingAction;
        const role = actionButton.dataset.groundingRole || null;

        if (action === 'pick-overlay') {
            startGroundingPickMode(form, ruleType, role);
            return;
        }

        if (action === 'use-selected') {
            if (selectedLayoutTestIndex === null) {
                showToast('Select a layout annotation first, then click Link Selected', 'info');
                return;
            }
            const selectedLayout = currentTests?.test_rules?.[selectedLayoutTestIndex];
            const selectedLayoutId = sanitizeLayoutIdValue(selectedLayout?.id);
            if (!selectedLayoutId) {
                showToast('Selected layout annotation has no id; assign one first', 'error');
                return;
            }
            setGroundingFromLayoutSelection(form, ruleType, selectedLayoutId, role);
            return;
        }

        if (action === 'clear-role') {
            const state = getNormalizedRuleGrounding(form.__groundingState || {}, ruleType);
            if (role) {
                clearGroundingForRole(state, role);
            }
            form.__groundingState = getNormalizedRuleGrounding(state, ruleType);
            renderVisualGroundingSection(form, ruleType);
            return;
        }

        if (action === 'clear-all') {
            form.__groundingState = getNormalizedRuleGrounding({}, ruleType);
            renderVisualGroundingSection(form, ruleType);
        }
    });

    renderVisualGroundingSection(form, ruleType);
}

function buildStringArrayChipFieldHtml(fieldId, fieldName, field, value, requiredAttr, options = {}) {
    const initial = Array.isArray(value) ? value : (typeof value === 'string' ? parseStringArray(value) : []);
    const initialTags = dedupeTags(initial.map(item => String(item)));
    const hiddenValue = escapeHtml(JSON.stringify(initialTags));
    const placeholderText = options.placeholder || field.placeholder || 'Type a value and press Enter';
    const hiddenInputId = `${fieldId}-hidden`;
    const helperButtons = [];

    if (Array.isArray(options.anchorSourceFields) && options.anchorSourceFields.length > 0) {
        helperButtons.push(`
            <button type="button"
                    class="btn btn-xs btn-secondary"
                    data-anchor-populate="${escapeHtml(fieldId)}"
                    data-anchor-source-fields="${escapeHtml(options.anchorSourceFields.join(','))}">
                Add Referenced Cells
            </button>
        `);
    }
    if (options.allowClear) {
        helperButtons.push(`
            <button type="button"
                    class="btn btn-xs btn-ghost"
                    data-array-clear="${escapeHtml(fieldId)}">
                Clear
            </button>
        `);
    }

    const helperActionsHtml = helperButtons.length
        ? `<div class="string-array-helper-actions">${helperButtons.join('')}</div>`
        : '';

    return `
        <div class="string-array-helper ${escapeHtml(options.helperClass || '')}">
            <div class="tag-input-widget ${escapeHtml(options.widgetClass || '')}" data-widget-id="${escapeHtml(fieldId)}" data-tag-widget data-for-input="${escapeHtml(hiddenInputId)}">
                <div class="tag-chip-list"></div>
                <input type="text"
                    id="${escapeHtml(fieldId)}"
                    class="tag-input-entry"
                    autocomplete="off"
                    placeholder="${escapeHtml(placeholderText)}">
            </div>
            ${helperActionsHtml}
        </div>
        <input type="hidden"
            id="${escapeHtml(hiddenInputId)}"
            data-rule-field="${escapeHtml(fieldName)}"
            data-field-kind="string_array"
            ${requiredAttr}
            value="${hiddenValue}">
    `;
}

function buildTagInputFieldHtml(fieldId, fieldName, field, value, requiredAttr) {
    return buildStringArrayChipFieldHtml(fieldId, fieldName, field, value, requiredAttr, {
        placeholder: field.placeholder || 'Type a tag and press Enter',
        allowClear: false,
    });
}

function getTableAnchorSourceFieldsForRule(ruleType) {
    const mapping = {
        table_colspan: ['cell'],
        table_rowspan: ['cell'],
        table_same_row: ['cell_a', 'cell_b'],
        table_same_column: ['cell_a', 'cell_b'],
        table_top_header: ['data_cell', 'expected_header'],
        table_left_header: ['data_cell', 'expected_header'],
        table_adjacent_up: ['anchor_cell', 'expected_neighbor'],
        table_adjacent_down: ['anchor_cell', 'expected_neighbor'],
        table_adjacent_left: ['anchor_cell', 'expected_neighbor'],
        table_adjacent_right: ['anchor_cell', 'expected_neighbor'],
        table_no_left: ['cell'],
        table_no_right: ['cell'],
        table_no_above: ['cell'],
        table_no_below: ['cell'],
    };
    return mapping[ruleType] || ['cell', 'cell_a', 'cell_b', 'anchor_cell', 'data_cell'];
}

function buildTableAnchorFieldHtml(ruleType, fieldId, fieldName, field, value, requiredAttr) {
    return buildStringArrayChipFieldHtml(fieldId, fieldName, field, value, requiredAttr, {
        placeholder: field.placeholder || 'Add anchor cells and press Enter',
        anchorSourceFields: getTableAnchorSourceFieldsForRule(ruleType),
        allowClear: true,
        widgetClass: 'table-anchor-widget',
        helperClass: 'table-anchor-helper',
    });
}

function buildChartLabelsFieldHtml(fieldId, fieldName, field, value, requiredAttr) {
    return buildStringArrayChipFieldHtml(fieldId, fieldName, field, value, requiredAttr, {
        placeholder: field.placeholder || 'Add chart labels and press Enter',
        allowClear: true,
    });
}

function buildChartArrayDataFieldHtml(fieldId, fieldName, field, value, requiredAttr, placeholder) {
    const escapedValue = escapeHtml(serializeValueForFieldInput(field.kind, value));
    return `
        <div class="chart-array-helper">
            <textarea id="${escapeHtml(fieldId)}"
                      data-rule-field="${escapeHtml(fieldName)}"
                      data-field-kind="${escapeHtml(field.kind)}"
                      ${requiredAttr}
                      ${placeholder}>${escapedValue}</textarea>
            <div class="chart-array-helper-extra">
                <small>Paste CSV/TSV rows below, then convert to a JSON 2D array.</small>
                <textarea class="chart-array-helper-input"
                          data-chart-array-input="${escapeHtml(fieldId)}"
                          placeholder="Category,2019,2020&#10;Revenue,120,140"></textarea>
                <div class="chart-array-helper-actions">
                    <button type="button" class="btn btn-xs btn-secondary" data-chart-array-convert="${escapeHtml(fieldId)}">Convert</button>
                    <button type="button" class="btn btn-xs btn-ghost" data-chart-array-format="${escapeHtml(fieldId)}">Format JSON</button>
                </div>
            </div>
        </div>
    `;
}

function collectRuleFieldValues(form, fieldNames) {
    const values = [];
    for (const fieldName of fieldNames || []) {
        const selector = `[data-rule-field="${CSS.escape(fieldName)}"]`;
        const element = form.querySelector(selector);
        if (!element) continue;
        const raw = (element.value || '').trim();
        if (!raw) continue;
        const kind = element.dataset.fieldKind || '';
        if (kind === 'string_array') {
            try {
                values.push(...parseStringArray(raw));
            } catch {
                values.push(raw);
            }
        } else {
            values.push(raw);
        }
    }
    return dedupeTags(values);
}

function initTagInputWidgets(root) {
    if (!root) return;
    root.querySelectorAll('[data-tag-widget]').forEach(widget => {
        if (widget.dataset.initialized === 'true') return;
        widget.dataset.initialized = 'true';

        const inputId = widget.dataset.forInput;
        const hiddenInput = inputId ? document.getElementById(inputId) : null;
        const entry = widget.querySelector('.tag-input-entry');
        const chipList = widget.querySelector('.tag-chip-list');
        if (!hiddenInput || !entry || !chipList) return;

        let tags = [];
        try {
            tags = dedupeTags(parseStringArray(hiddenInput.value || ''));
        } catch {
            tags = [];
        }

        const render = () => {
            const visibleTags = tags.slice(0, MAX_RENDERED_CHIPS);
            const hiddenCount = Math.max(0, tags.length - visibleTags.length);
            const chipsHtml = visibleTags.map((tag, index) => `
                <span class="tag-chip">
                    <span class="tag-chip-label">${escapeHtml(tag)}</span>
                    <button type="button" class="tag-chip-remove" data-tag-remove="${index}" aria-label="Remove ${escapeHtml(tag)}">&times;</button>
                </span>
            `).join('');
            const overflowChipHtml = hiddenCount > 0
                ? `<span class="tag-chip tag-chip-overflow">+${hiddenCount} more</span>`
                : '';
            chipList.innerHTML = `${chipsHtml}${overflowChipHtml}`;
            widget.classList.toggle('has-tags', tags.length > 0);
        };

        const persist = () => {
            hiddenInput.value = JSON.stringify(tags);
            if (typeof CustomEvent === 'function') {
                hiddenInput.dispatchEvent(new CustomEvent('tag-widget-change', {
                    bubbles: true,
                    detail: { tags: tags.slice() },
                }));
            }
            render();
        };

        const widgetApi = {
            getTags: () => tags.slice(),
            setTags: (nextTags) => {
                tags = dedupeTags(nextTags || []);
                persist();
            },
            addTags: (nextTags) => {
                tags = dedupeTags([...(tags || []), ...(nextTags || [])]);
                persist();
            },
            clear: () => {
                tags = [];
                persist();
            },
        };
        widget.__tagWidgetApi = widgetApi;

        const commitEntryValue = () => {
            const raw = entry.value || '';
            if (!raw.trim()) return;
            const tokens = raw
                .split(/[\n,]/g)
                .map(token => token.trim())
                .filter(Boolean);
            tags = dedupeTags([...tags, ...tokens]);
            entry.value = '';
            persist();
        };

        entry.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                commitEntryValue();
                return;
            }
            if (event.key === 'Backspace' && !entry.value.trim() && tags.length > 0) {
                tags = tags.slice(0, -1);
                persist();
            }
        });

        entry.addEventListener('blur', commitEntryValue);

        widget.addEventListener('click', (event) => {
            const removeButton = event.target.closest('[data-tag-remove]');
            if (removeButton) {
                const index = parseInt(removeButton.dataset.tagRemove, 10);
                if (!Number.isNaN(index) && index >= 0 && index < tags.length) {
                    tags.splice(index, 1);
                    persist();
                }
                return;
            }
            entry.focus();
        });

        persist();
    });

    if (root.dataset.tagHelpersInitialized === 'true') return;
    root.dataset.tagHelpersInitialized = 'true';

    root.addEventListener('click', (event) => {
        const populateButton = event.target.closest('[data-anchor-populate]');
        if (populateButton) {
            const widgetId = populateButton.dataset.anchorPopulate;
            const sourceFields = (populateButton.dataset.anchorSourceFields || '')
                .split(',')
                .map(v => v.trim())
                .filter(Boolean);
            const targetWidget = widgetId
                ? root.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`)
                : null;
            const targetApi = targetWidget?.__tagWidgetApi;
            if (!targetApi) return;

            const sourceValues = collectRuleFieldValues(root, sourceFields);
            if (!sourceValues.length) {
                showToast('No source cells found yet for anchor helper', 'info');
                return;
            }
            targetApi.addTags(sourceValues);
            return;
        }

        const clearButton = event.target.closest('[data-array-clear]');
        if (!clearButton) return;
        const widgetId = clearButton.dataset.arrayClear;
        const targetWidget = widgetId
            ? root.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`)
            : null;
        const targetApi = targetWidget?.__tagWidgetApi;
        if (!targetApi) return;
        targetApi.clear();
    });
}

function parseDelimitedLine(line, delimiter) {
    if (delimiter === '\t') {
        return line.split('\t').map(cell => cell.trim());
    }

    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            const next = line[i + 1];
            if (inQuotes && next === '"') {
                current += '"';
                i += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (ch === delimiter && !inQuotes) {
            values.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    values.push(current.trim());
    return values;
}

function coerceTableCellValue(rawCell) {
    const trimmed = String(rawCell || '').trim();
    if (!trimmed) return '';
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) return parsed;
    }
    return trimmed;
}

function parseChartArrayRows(rawText) {
    const lines = String(rawText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    if (!lines.length) return [];

    const delimiter = lines.some(line => line.includes('\t')) ? '\t' : ',';
    return lines.map(line => parseDelimitedLine(line, delimiter).map(coerceTableCellValue));
}

function initChartArrayHelpers(root) {
    if (!root || root.dataset.chartArrayHelpersInitialized === 'true') return;
    root.dataset.chartArrayHelpersInitialized = 'true';

    root.addEventListener('click', (event) => {
        const convertButton = event.target.closest('[data-chart-array-convert]');
        if (convertButton) {
            const fieldId = convertButton.dataset.chartArrayConvert;
            const target = fieldId ? document.getElementById(fieldId) : null;
            const source = fieldId
                ? root.querySelector(`[data-chart-array-input="${CSS.escape(fieldId)}"]`)
                : null;
            if (!target || !source) return;

            try {
                const rows = parseChartArrayRows(source.value || '');
                if (!rows.length) {
                    showToast('Paste at least one CSV/TSV row to convert', 'info');
                    return;
                }
                target.value = JSON.stringify(rows, null, 2);
            } catch (error) {
                showToast(`Failed to parse rows: ${error.message}`, 'error');
            }
            return;
        }

        const formatButton = event.target.closest('[data-chart-array-format]');
        if (!formatButton) return;
        const fieldId = formatButton.dataset.chartArrayFormat;
        const target = fieldId ? document.getElementById(fieldId) : null;
        if (!target) return;
        try {
            const parsed = JSON.parse(target.value || '[]');
            target.value = JSON.stringify(parsed, null, 2);
        } catch (error) {
            showToast(`Invalid JSON: ${error.message}`, 'error');
        }
    });
}

function isFormattingRuleType(type) {
    return /^is_(?:not_)?/.test(type || '');
}

function getFormattingStyleName(type) {
    if (!type) return null;
    if (type.startsWith('is_not_')) return type.slice('is_not_'.length);
    if (type.startsWith('is_')) return type.slice('is_'.length);
    return null;
}

function getFormattingPairType(type) {
    const style = getFormattingStyleName(type);
    if (!style) return null;
    const positive = `is_${style}`;
    const negative = `is_not_${style}`;

    if (type === positive && ruleDefinitionsByType.has(negative)) return negative;
    if (type === negative && ruleDefinitionsByType.has(positive)) return positive;
    return null;
}

function getFormattingStyles() {
    const styles = new Set();
    for (const definition of getRuleDefinitionsList()) {
        const style = getFormattingStyleName(definition.type);
        if (!style) continue;
        styles.add(style);
    }
    return Array.from(styles).sort();
}

function getFormattingTargetType(style, preferNegative) {
    const positive = `is_${style}`;
    const negative = `is_not_${style}`;
    if (preferNegative && ruleDefinitionsByType.has(negative)) return negative;
    if (ruleDefinitionsByType.has(positive)) return positive;
    if (ruleDefinitionsByType.has(negative)) return negative;
    return null;
}

function switchFormattingRuleType(targetType, sourceForm) {
    if (!targetType || !elements.testTypeSelect) return;
    const currentText = sourceForm?.querySelector('[data-rule-field="text"]')?.value || '';
    if (testTypeFilterQuery && elements.testTypeFilterInput) {
        testTypeFilterQuery = '';
        elements.testTypeFilterInput.value = '';
        populateTestTypeSelectOptions();
    }
    elements.testTypeSelect.value = targetType;
    showTestForm(targetType);
    if (currentText) {
        setTimeout(() => {
            const textInput = elements.testFormContainer.querySelector('[data-rule-field="text"]');
            if (textInput) textInput.value = currentText;
        }, 0);
    }
}

function renderDynamicRuleFamilyHelper(type) {
    if (type === 'baseline') {
        return `
            <div class="family-helper">
                <div class="family-helper-title">Baseline Presets</div>
                <div class="family-helper-actions">
                    <button type="button" class="btn btn-xs btn-secondary" data-baseline-preset="strict">Strict</button>
                    <button type="button" class="btn btn-xs btn-secondary" data-baseline-preset="default">Default</button>
                    <button type="button" class="btn btn-xs btn-secondary" data-baseline-preset="lenient">Lenient</button>
                </div>
                <div class="family-helper-note">Quickly apply sensible repeat/disallowed-character defaults.</div>
            </div>
        `;
    }

    if (type === 'rotate_check') {
        return `
            <div class="family-helper">
                <div class="family-helper-title">Rotate Quick Values</div>
                <div class="family-helper-actions">
                    <button type="button" class="btn btn-xs btn-secondary" data-rotate-value-set="0">0</button>
                    <button type="button" class="btn btn-xs btn-secondary" data-rotate-value-set="90">90</button>
                    <button type="button" class="btn btn-xs btn-secondary" data-rotate-value-set="180">180</button>
                    <button type="button" class="btn btn-xs btn-secondary" data-rotate-value-set="270">270</button>
                </div>
            </div>
        `;
    }

    if (isFormattingRuleType(type)) {
        const isNegative = type.startsWith('is_not_');
        const pairType = getFormattingPairType(type);
        const styleButtons = getFormattingStyles()
            .map(style => {
                const targetType = getFormattingTargetType(style, isNegative);
                if (!targetType) return '';
                const activeClass = targetType === type ? 'btn-success' : 'btn-secondary';
                return `<button type="button" class="btn btn-xs ${activeClass}" data-format-switch="${escapeHtml(targetType)}">${escapeHtml(style)}</button>`;
            })
            .filter(Boolean)
            .join('');
        const pairButton = pairType
            ? `<button type="button" class="btn btn-xs btn-secondary" data-format-switch="${escapeHtml(pairType)}">${escapeHtml(pairType)}</button>`
            : '';

        return `
            <div class="family-helper">
                <div class="family-helper-title">Formatting Helpers</div>
                <div class="family-helper-actions">
                    ${pairButton}
                    ${styleButtons}
                </div>
                <div class="family-helper-note">Switch style quickly while preserving text.</div>
            </div>
        `;
    }

    return '';
}

function initDynamicRuleFormHelpers(root, ruleType) {
    if (!root || root.dataset.dynamicRuleHelpersInitialized === 'true') return;
    root.dataset.dynamicRuleHelpersInitialized = 'true';

    root.addEventListener('click', (event) => {
        const formatSwitchButton = event.target.closest('[data-format-switch]');
        if (formatSwitchButton) {
            const targetType = formatSwitchButton.dataset.formatSwitch;
            switchFormattingRuleType(targetType, root);
            return;
        }

        const baselinePresetButton = event.target.closest('[data-baseline-preset]');
        if (baselinePresetButton) {
            const preset = baselinePresetButton.dataset.baselinePreset;
            const maxRepeatsInput = root.querySelector('[data-rule-field="max_repeats"]');
            const disallowedInput = root.querySelector('[data-rule-field="check_disallowed_characters"]');
            const altTagInput = root.querySelector('[data-rule-field="max_length_skips_image_alt_tags"]');
            if (preset === 'strict') {
                if (maxRepeatsInput) maxRepeatsInput.value = 20;
                if (disallowedInput) disallowedInput.checked = true;
                if (altTagInput) altTagInput.checked = false;
            } else if (preset === 'lenient') {
                if (maxRepeatsInput) maxRepeatsInput.value = 50;
                if (disallowedInput) disallowedInput.checked = false;
                if (altTagInput) altTagInput.checked = true;
            } else {
                if (maxRepeatsInput) maxRepeatsInput.value = 30;
                if (disallowedInput) disallowedInput.checked = true;
                if (altTagInput) altTagInput.checked = false;
            }
            return;
        }

        const rotatePresetButton = event.target.closest('[data-rotate-value-set]');
        if (!rotatePresetButton) return;
        const input = root.querySelector('[data-rule-field="value"]');
        if (!input) return;
        input.value = rotatePresetButton.dataset.rotateValueSet;
        input.focus();
    });

    if (ruleType === 'baseline') {
        const maxLengthInput = root.querySelector('[data-rule-field="max_length"]');
        const maxRepeatsInput = root.querySelector('[data-rule-field="max_repeats"]');
        if (maxLengthInput) maxLengthInput.placeholder = 'Optional hard limit';
        if (maxRepeatsInput) maxRepeatsInput.placeholder = 'Default: 30';
    }
}

function createDynamicFieldHtml(ruleType, field, value) {
    const fieldId = `dyn-${sanitizeIdComponent(ruleType)}-${sanitizeIdComponent(field.name)}`;
    const label = field.label || toTitleCaseType(field.name);
    const requiredMark = field.required ? ' *' : '';
    const helpHtml = field.help ? `<small class="form-hint">${escapeHtml(field.help)}</small>` : '';
    const formGroupClasses = ['form-group'];

    if (ruleType === 'baseline' && ['max_length', 'max_repeats'].includes(field.name)) {
        formGroupClasses.push('baseline-compact-field');
    }

    if (field.kind === 'boolean') {
        const checked = serializeValueForFieldInput(field.kind, value) ? 'checked' : '';
        return `
            <div class="${formGroupClasses.join(' ')} checkbox-group">
                <label for="${escapeHtml(fieldId)}">
                    <input type="checkbox"
                           id="${escapeHtml(fieldId)}"
                           data-rule-field="${escapeHtml(field.name)}"
                           data-field-kind="${escapeHtml(field.kind)}"
                           ${checked}>
                    ${escapeHtml(label)}
                </label>
                ${helpHtml}
            </div>
        `;
    }

    let inputHtml = '';
    const escapedValue = escapeHtml(serializeValueForFieldInput(field.kind, value));
    const requiredAttr = field.required ? 'required' : '';
    const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';

    if (field.kind === 'string_array' && field.name === 'tags') {
        inputHtml = buildTagInputFieldHtml(fieldId, field.name, field, value, requiredAttr);
        return `
            <div class="${formGroupClasses.join(' ')}">
                <label for="${escapeHtml(fieldId)}">${escapeHtml(label)}${requiredMark}</label>
                ${inputHtml}
                ${helpHtml}
            </div>
        `;
    }

    if (field.kind === 'string_array' && field.name === 'table_anchor_cells') {
        inputHtml = buildTableAnchorFieldHtml(ruleType, fieldId, field.name, field, value, requiredAttr);
        return `
            <div class="${formGroupClasses.join(' ')}">
                <label for="${escapeHtml(fieldId)}">${escapeHtml(label)}${requiredMark}</label>
                ${inputHtml}
                ${helpHtml}
            </div>
        `;
    }

    if (field.kind === 'string_array' && field.name === 'labels' && ruleType === 'chart_data_point') {
        inputHtml = buildChartLabelsFieldHtml(fieldId, field.name, field, value, requiredAttr);
        return `
            <div class="${formGroupClasses.join(' ')}">
                <label for="${escapeHtml(fieldId)}">${escapeHtml(label)}${requiredMark}</label>
                ${inputHtml}
                ${helpHtml}
            </div>
        `;
    }

    if (field.kind === 'table_like_2d' && field.name === 'data' && ruleType.startsWith('chart_data_array')) {
        inputHtml = buildChartArrayDataFieldHtml(fieldId, field.name, field, value, requiredAttr, placeholder);
        return `
            <div class="${formGroupClasses.join(' ')}">
                <label for="${escapeHtml(fieldId)}">${escapeHtml(label)}${requiredMark}</label>
                ${inputHtml}
                ${helpHtml}
            </div>
        `;
    }

    switch (field.kind) {
        case 'textarea':
        case 'string_array':
        case 'string_int_map':
        case 'json':
        case 'object':
        case 'table_like_2d':
            inputHtml = `
                <textarea id="${escapeHtml(fieldId)}"
                          data-rule-field="${escapeHtml(field.name)}"
                          data-field-kind="${escapeHtml(field.kind)}"
                          ${requiredAttr}
                          ${placeholder}>${escapedValue}</textarea>
            `;
            break;
        case 'integer':
            inputHtml = `
                <input type="number"
                       id="${escapeHtml(fieldId)}"
                       data-rule-field="${escapeHtml(field.name)}"
                       data-field-kind="${escapeHtml(field.kind)}"
                       step="1"
                       ${requiredAttr}
                       ${placeholder}
                       value="${escapedValue}">
            `;
            break;
        case 'number':
            inputHtml = `
                <input type="number"
                       id="${escapeHtml(fieldId)}"
                       data-rule-field="${escapeHtml(field.name)}"
                       data-field-kind="${escapeHtml(field.kind)}"
                       step="any"
                       ${requiredAttr}
                       ${placeholder}
                       value="${escapedValue}">
            `;
            break;
        case 'enum': {
            const options = Array.isArray(field.options) ? field.options : [];
            const optionHtml = ['<option value="">-- Select --</option>', ...options.map(option => {
                const optionValue = typeof option === 'string' ? option : option?.value;
                const optionLabel = typeof option === 'string' ? toTitleCaseType(option) : (option?.label || optionValue);
                const selected = String(value ?? '') === String(optionValue) ? 'selected' : '';
                return `<option value="${escapeHtml(optionValue)}" ${selected}>${escapeHtml(optionLabel)}</option>`;
            })].join('');
            inputHtml = `
                <select id="${escapeHtml(fieldId)}"
                        data-rule-field="${escapeHtml(field.name)}"
                        data-field-kind="${escapeHtml(field.kind)}"
                        ${requiredAttr}>
                    ${optionHtml}
                </select>
            `;
            break;
        }
        default:
            inputHtml = `
                <input type="text"
                       id="${escapeHtml(fieldId)}"
                       data-rule-field="${escapeHtml(field.name)}"
                       data-field-kind="${escapeHtml(field.kind || 'text')}"
                       ${requiredAttr}
                       ${placeholder}
                       value="${escapedValue}">
            `;
            break;
    }

    return `
        <div class="${formGroupClasses.join(' ')}">
            <label for="${escapeHtml(fieldId)}">${escapeHtml(label)}${requiredMark}</label>
            ${inputHtml}
            ${helpHtml}
        </div>
    `;
}

function renderDynamicRuleForm(type, definition, existingRule = null) {
    const mergedFields = getMergedDefinitionFields(definition);
    const familyHelperHtml = renderDynamicRuleFamilyHelper(type);
    const fieldsHtml = mergedFields
        .map(field => {
            const defaultValue = field.default !== undefined ? field.default : '';
            const currentValue = existingRule && existingRule[field.name] !== undefined
                ? existingRule[field.name]
                : defaultValue;
            return createDynamicFieldHtml(type, field, currentValue);
        })
        .join('');

    const modeText = editingIndex !== null ? 'Update Test' : 'Add Test';
    return `
        <form class="test-form dynamic-test-form" data-dynamic-rule-type="${escapeHtml(type)}">
            <div class="form-info">
                <small>${escapeHtml(definition.description || `Schema-driven form for ${type}`)}</small>
            </div>
            ${familyHelperHtml}
            ${fieldsHtml}
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">${modeText}</button>
            </div>
        </form>
    `;
}

function renderRawJsonForm(existingRule = null) {
    const modeText = editingIndex !== null ? 'Update Test' : 'Add Test';
    const typeValue = existingRule?.type || '';
    const payload = existingRule ? JSON.stringify(existingRule, null, 2) : '';
    return `
        <form class="test-form raw-json-form" id="raw-json-form">
            <div class="form-info">
                <small>Fallback editor for unknown or custom rule types. Provide full rule JSON payload.</small>
            </div>
            <div class="form-group">
                <label for="raw-rule-type">Rule Type *</label>
                <input type="text" id="raw-rule-type" value="${escapeHtml(typeValue)}" placeholder="e.g. custom_rule" required>
            </div>
            <div class="form-group">
                <label for="raw-rule-json">Rule JSON</label>
                <textarea id="raw-rule-json" placeholder="{\n  &quot;type&quot;: &quot;custom_rule&quot;\n}">${escapeHtml(payload)}</textarea>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="clearTestForm()">Clear</button>
                <button type="submit" class="btn btn-success">${modeText}</button>
            </div>
        </form>
    `;
}

function parseStringArray(rawValue) {
    const trimmed = rawValue.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            throw new Error('Expected JSON array');
        }
        return parsed.map(item => String(item));
    }
    return trimmed
        .split('\n')
        .flatMap(line => line.split(','))
        .map(item => item.trim())
        .filter(Boolean);
}

function parseStringIntMap(rawValue) {
    const trimmed = rawValue.trim();
    if (!trimmed) return {};

    if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Expected JSON object');
        }
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                throw new Error(`Invalid number for key '${key}'`);
            }
            out[key] = num;
        }
        return out;
    }

    const out = {};
    for (const line of trimmed.split('\n')) {
        const normalizedLine = line.trim();
        if (!normalizedLine) continue;
        const splitIndex = normalizedLine.indexOf(':');
        if (splitIndex === -1) {
            throw new Error(`Invalid map line '${normalizedLine}', expected 'key: value'`);
        }
        const key = normalizedLine.slice(0, splitIndex).trim();
        const rawNum = normalizedLine.slice(splitIndex + 1).trim();
        const num = Number(rawNum);
        if (!key) {
            throw new Error('Map key cannot be empty');
        }
        if (!Number.isFinite(num)) {
            throw new Error(`Invalid number for key '${key}'`);
        }
        out[key] = num;
    }
    return out;
}

function parseScalar(rawValue) {
    const trimmed = rawValue.trim();
    if (!trimmed) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
}

function parseFieldValue(field, element) {
    const kind = field.kind || 'text';
    const raw = element?.value ?? '';

    if (kind === 'boolean') {
        return { hasValue: true, value: element.checked };
    }

    if (!raw.trim()) {
        return { hasValue: false, value: undefined };
    }

    try {
        switch (kind) {
            case 'integer': {
                const parsed = parseInt(raw, 10);
                if (Number.isNaN(parsed)) throw new Error('Expected integer');
                return { hasValue: true, value: parsed };
            }
            case 'number': {
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) throw new Error('Expected number');
                return { hasValue: true, value: parsed };
            }
            case 'string_array': {
                const parsed = parseStringArray(raw);
                return { hasValue: parsed.length > 0, value: parsed };
            }
            case 'string_int_map':
                return { hasValue: true, value: parseStringIntMap(raw) };
            case 'table_like_2d':
            case 'json':
            case 'object': {
                const parsed = JSON.parse(raw);
                return { hasValue: true, value: parsed };
            }
            case 'scalar':
                return { hasValue: true, value: parseScalar(raw) };
            default:
                return { hasValue: true, value: raw };
        }
    } catch (error) {
        return { error: `${field.name}: ${error.message}` };
    }
}

function serializeRuleFromDefinition(type, definition, previousRule = null) {
    const form = elements.testFormContainer.querySelector('form');
    if (!form) {
        return { error: 'Test form not found' };
    }

    const rule = { type, verified: true };
    const mergedFields = getMergedDefinitionFields(definition);
    const knownKeys = new Set(['type', 'verified']);
    mergedFields.forEach(field => knownKeys.add(field.name));

    for (const field of mergedFields) {
        const selector = `[data-rule-field="${CSS.escape(field.name)}"]`;
        const element = form.querySelector(selector);
        if (!element) continue;

        const parsed = parseFieldValue(field, element);
        if (parsed.error) {
            return { error: parsed.error };
        }
        if (field.required && !parsed.hasValue) {
            return { error: `${field.name} is required` };
        }
        if (parsed.hasValue) {
            rule[field.name] = parsed.value;
        } else if (field.default !== undefined && field.required) {
            rule[field.name] = field.default;
        }
    }

    if (previousRule) {
        for (const [key, value] of Object.entries(previousRule)) {
            if (!knownKeys.has(key) && rule[key] === undefined) {
                rule[key] = value;
            }
        }
        if (!rule.id && previousRule.id) {
            rule.id = previousRule.id;
        }
    }

    return { rule };
}

function formatSummaryValue(value) {
    if (value === undefined || value === null || value === '') return '';
    if (Array.isArray(value)) {
        return value.slice(0, 3).map(item => String(item)).join(', ') + (value.length > 3 ? '…' : '');
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (!keys.length) return '{}';
        return `${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}`;
    }
    return String(value);
}

function renderRuleSummaryFromDefinition(test, definition) {
    const fields = Array.isArray(definition?.summary_fields) ? definition.summary_fields : [];
    const lines = [];
    const hiddenSummaryFields = new Set(['verified']);
    for (const fieldName of fields) {
        if (hiddenSummaryFields.has(fieldName)) continue;
        const value = formatSummaryValue(test[fieldName]);
        if (!value) continue;
        lines.push(`
            <div class="field">
                <span class="field-label">${escapeHtml(fieldName)}:</span>
                <span class="field-value">${escapeHtml(truncate(value, 60))}</span>
            </div>
        `);
    }
    if (!lines.length) {
        lines.push(`
            <div class="field">
                <span class="field-label">Rule:</span>
                <span class="field-value">${escapeHtml(truncate(JSON.stringify(test), 90))}</span>
            </div>
        `);
    }
    return lines.join('');
}

// === Test Types Functions ===
function loadTestTypesFromStorage() {
    try {
        const stored = localStorage.getItem('annotator_selected_test_types');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) {
                selectedTestTypes = parsed.filter(type => typeof type === 'string' && type);
            }
        }
    } catch (e) {
        console.error('Failed to load test types from storage:', e);
    }
    refreshAiTypeMetadata();
    sanitizeSelectedTestTypes();
    updateTestTypesUI();
}

function saveTestTypesToStorage() {
    try {
        localStorage.setItem('annotator_selected_test_types', JSON.stringify(selectedTestTypes));
    } catch (e) {
        console.error('Failed to save test types to storage:', e);
    }
}

function toggleTestTypesSection() {
    testTypesFolded = !testTypesFolded;
    // Use direct DOM lookup for reliability
    const checkboxes = document.getElementById('test-types-checkboxes');
    const legend = document.getElementById('test-types-legend');
    const arrow = document.getElementById('fold-arrow');
    const toggle = document.getElementById('test-types-toggle');

    if (checkboxes) {
        checkboxes.style.display = testTypesFolded ? 'none' : 'flex';
    }
    if (legend) {
        legend.style.display = testTypesFolded ? 'none' : 'block';
    }
    if (arrow) {
        arrow.textContent = testTypesFolded ? '▶' : '▼';
    }
    if (toggle) {
        toggle.classList.toggle('expanded', !testTypesFolded);
    }
}

function updateTestTypesFoldState() {
    toggleTestTypesSection();
    toggleTestTypesSection(); // Toggle twice to refresh state without changing it
}

function renderAiTestTypeOptions() {
    const container = elements.testTypesCheckboxes;
    if (!container) return;

    refreshAiTypeMetadata();
    sanitizeSelectedTestTypes();

    const definitions = getRuleDefinitionsList()
        .sort((a, b) => {
            const catA = a.category || 'other';
            const catB = b.category || 'other';
            if (catA !== catB) return catA.localeCompare(catB);
            return a.type.localeCompare(b.type);
        });

    if (!definitions.length) {
        container.innerHTML = DEFAULT_TEST_TYPES.map(type => `
            <label class="test-type-choice">
                <span class="test-type-choice-label">
                    <input type="checkbox" data-ai-test-type="${escapeHtml(type)}" ${selectedTestTypes.includes(type) ? 'checked' : ''}>
                    <span class="test-type-choice-name">${escapeHtml(type)}</span>
                </span>
                <span class="test-type-choice-badge ai">AI</span>
            </label>
        `).join('');
        updateTestTypesCount();
        return;
    }

    container.innerHTML = definitions.map(definition => {
        const type = definition.type;
        const aiSupported = aiGeneratableTypes.has(type);
        const checked = aiSupported && selectedTestTypes.includes(type) ? 'checked' : '';
        const disabled = aiSupported ? '' : 'disabled';
        const category = toTitleCaseType(definition.category || 'other');
        const title = getDefinitionDescription(definition);
        return `
            <label class="test-type-choice ${aiSupported ? '' : 'manual-only'}" title="${escapeHtml(title)}">
                <span class="test-type-choice-label">
                    <input type="checkbox" data-ai-test-type="${escapeHtml(type)}" ${checked} ${disabled}>
                    <span class="test-type-choice-name">${escapeHtml(type)}</span>
                    <span class="test-type-choice-category">(${escapeHtml(category)})</span>
                </span>
                <span class="test-type-choice-badge ${aiSupported ? 'ai' : 'manual'}">${aiSupported ? 'AI' : 'Manual'}</span>
            </label>
        `;
    }).join('');

    if (elements.testTypesLegend) {
        const aiCount = aiGeneratableTypes.size;
        const manualCount = aiManualOnlyTypes.size;
        elements.testTypesLegend.textContent = `${aiCount} AI-generatable types, ${manualCount} manual-only types`;
    }

    updateTestTypesCount();
}

function updateTestTypesUI() {
    renderAiTestTypeOptions();
    updateTestTypesCount();
}

function updateTestTypesCount() {
    const summary = document.getElementById('test-types-summary');
    if (summary) {
        const denominator = aiGeneratableTypes.size || selectedTestTypes.length || DEFAULT_TEST_TYPES.length;
        summary.textContent = `(${selectedTestTypes.length}/${denominator})`;
    }
}

function getSelectedTestTypes() {
    sanitizeSelectedTestTypes();
    return [...selectedTestTypes];
}

function getAcceptedAiGeneratedTypeSet() {
    const accepted = new Set(aiGeneratableTypes);
    const serverTypes = getServerGeneratableTypeSet();
    if (serverTypes) {
        serverTypes.forEach(type => accepted.add(type));
    }
    // Backward compatibility for historical prompts/responses.
    accepted.add('extra_content');
    if (!accepted.size) {
        DEFAULT_TEST_TYPES.forEach(type => accepted.add(type));
    }
    return accepted;
}

function onTestTypeChange(type, checked) {
    if (!aiGeneratableTypes.has(type)) return;

    if (checked) {
        if (!selectedTestTypes.includes(type)) {
            selectedTestTypes.push(type);
        }
    } else {
        selectedTestTypes = selectedTestTypes.filter(t => t !== type);
    }
    sanitizeSelectedTestTypes();
    renderAiTestTypeOptions();
    saveTestTypesToStorage();
}

// === Parse.md Functions ===
async function checkParseMd(relPath) {
    parseMdContent = null;
    parseMdAvailable = false;

    if (!relPath) {
        updateParseMdUI();
        return;
    }

    try {
        const response = await fetch(
            buildApiUrl(`/api/parse-md/${encodeURIComponent(relPath)}`, { content: true })
        );
        const data = await response.json();

        if (data.exists && data.content) {
            parseMdAvailable = true;
            parseMdContent = data.content;
        }
    } catch (error) {
        console.error('Failed to check parse.md:', error);
    }

    updateParseMdUI();
}

function updateParseMdUI() {
    if (elements.parseMdSection) {
        const showParseMd = annotationMode !== ANNOTATION_MODE_EXTRACT && parseMdAvailable;
        elements.parseMdSection.style.display = showParseMd ? 'block' : 'none';
    }
    if (elements.useParseMdCheckbox) {
        elements.useParseMdCheckbox.checked = useParseMd && parseMdAvailable;
    }
}

function getParseMdContentIfEnabled() {
    if (parseMdAvailable && useParseMd && elements.useParseMdCheckbox?.checked) {
        return parseMdContent;
    }
    return null;
}

function normalizeCurrentTestsPayload(payload) {
    const normalized = (payload && typeof payload === 'object' && !Array.isArray(payload))
        ? { ...payload }
        : {};
    if (!Array.isArray(normalized.test_rules)) {
        normalized.test_rules = [];
    }
    normalized.tags = dedupeTags(Array.isArray(normalized.tags) ? normalized.tags : []);
    if (normalized.expected_markdown === undefined) {
        normalized.expected_markdown = null;
    }
    return normalized;
}

function inferAnnotationModeFromPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return ANNOTATION_MODE_PARSE;
    }
    if (payload.annotation_mode === ANNOTATION_MODE_PARSE) {
        return ANNOTATION_MODE_PARSE;
    }
    if (payload.annotation_mode === ANNOTATION_MODE_EXTRACT) {
        return ANNOTATION_MODE_EXTRACT;
    }
    const hasSchema = payload.data_schema && typeof payload.data_schema === 'object' && !Array.isArray(payload.data_schema);
    const hasExpectedOutput = payload.expected_output && typeof payload.expected_output === 'object';
    return (hasSchema || hasExpectedOutput) ? ANNOTATION_MODE_EXTRACT : ANNOTATION_MODE_PARSE;
}

function inferExtractValueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    const valueType = typeof value;
    if (valueType === 'string') return 'string';
    if (valueType === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (valueType === 'boolean') return 'boolean';
    if (valueType === 'object') return 'object';
    return 'string';
}

function normalizeSchemaType(rawType, fallbackValue = undefined) {
    if (Array.isArray(rawType) && rawType.length > 0) {
        return normalizeSchemaType(rawType[0], fallbackValue);
    }
    const allowed = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
    if (typeof rawType === 'string' && allowed.has(rawType)) {
        // Defensive coercion: if the declared type is scalar but the actual
        // value is an array/object, prefer the value's shape so we don't
        // render "[object Object]" when an on-disk schema gets out of sync.
        const isScalarDeclared = rawType === 'string' || rawType === 'number' || rawType === 'integer' || rawType === 'boolean' || rawType === 'null';
        if (isScalarDeclared && Array.isArray(fallbackValue)) return 'array';
        if (isScalarDeclared && fallbackValue !== null && typeof fallbackValue === 'object') return 'object';
        return rawType;
    }
    return inferExtractValueType(fallbackValue);
}

function formatExtractValueForInput(value, type) {
    if (type === 'null') return '';
    if (type === 'object' || type === 'array') {
        try {
            return JSON.stringify(value ?? (type === 'array' ? [] : {}));
        } catch {
            return '';
        }
    }
    if (type === 'boolean') {
        return value === true ? 'true' : value === false ? 'false' : '';
    }
    if (value === undefined || value === null) return '';
    return String(value);
}

function parseExtractValueFromInput(rawValue, type) {
    const text = String(rawValue ?? '').trim();
    if (type === 'null') {
        return { value: null };
    }
    if (type === 'string') {
        return { value: rawValue ?? '' };
    }
    if (type === 'number') {
        if (!text) return { error: 'Number value is required' };
        const num = Number(text);
        if (Number.isNaN(num)) return { error: `Invalid number: ${rawValue}` };
        return { value: num };
    }
    if (type === 'integer') {
        if (!text) return { error: 'Integer value is required' };
        if (!/^-?\d+$/.test(text)) return { error: `Invalid integer: ${rawValue}` };
        return { value: Number.parseInt(text, 10) };
    }
    if (type === 'boolean') {
        const lowered = text.toLowerCase();
        if (lowered === 'true' || lowered === '1' || lowered === 'yes') return { value: true };
        if (lowered === 'false' || lowered === '0' || lowered === 'no') return { value: false };
        return { error: `Invalid boolean: ${rawValue}` };
    }
    if (type === 'object' || type === 'array') {
        if (!text) return { error: `${type} JSON value is required` };
        try {
            const parsed = JSON.parse(text);
            if (type === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
                return { error: `Expected JSON object for ${type}` };
            }
            if (type === 'array' && !Array.isArray(parsed)) {
                return { error: `Expected JSON array for ${type}` };
            }
            return { value: parsed };
        } catch (error) {
            return { error: `Invalid JSON: ${error.message}` };
        }
    }
    return { value: rawValue };
}

// --- Extract field path helpers (JS port of extract_field_paths.py) ---

const _EXTRACT_PATH_TOKEN_RE = /([^.\[\]]+)|\[(\d+)\]/g;

function parseExtractFieldPath(path) {
    if (!path) throw new Error('field_path must be non-empty');
    const tokens = [];
    _EXTRACT_PATH_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = _EXTRACT_PATH_TOKEN_RE.exec(path)) !== null) {
        if (m[1] !== undefined) tokens.push(m[1]);
        else tokens.push(parseInt(m[2], 10));
    }
    return tokens;
}

function setExtractPath(target, tokens, value) {
    let cursor = target;
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const isLast = i === tokens.length - 1;
        if (typeof tok === 'string') {
            if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
                throw new TypeError(`expected object for key ${tok} at position ${i}`);
            }
            if (isLast) { cursor[tok] = value; return; }
            const nextTok = tokens[i + 1];
            const defaultCtr = typeof nextTok === 'number' ? [] : {};
            if (!(tok in cursor) || cursor[tok] === undefined) cursor[tok] = defaultCtr;
            cursor = cursor[tok];
        } else {
            if (!Array.isArray(cursor)) {
                throw new TypeError(`expected array for index ${tok} at position ${i}`);
            }
            while (cursor.length <= tok) cursor.push(null);
            if (isLast) { cursor[tok] = value; return; }
            const nextTok = tokens[i + 1];
            const defaultCtr = typeof nextTok === 'number' ? [] : {};
            if (cursor[tok] === null || cursor[tok] === undefined) cursor[tok] = defaultCtr;
            cursor = cursor[tok];
        }
    }
}

const _EXTRACT_MISSING = Symbol('missing');

function getExtractPath(source, tokens, defaultValue) {
    let cursor = source;
    for (const tok of tokens) {
        if (typeof tok === 'string') {
            if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !(tok in cursor)) {
                return defaultValue;
            }
            cursor = cursor[tok];
        } else {
            if (!Array.isArray(cursor) || tok < 0 || tok >= cursor.length) {
                return defaultValue;
            }
            cursor = cursor[tok];
        }
    }
    return cursor;
}

function inflateExpectedOutput(rules) {
    const out = {};
    for (const rule of rules || []) {
        if (!rule || typeof rule !== 'object') continue;
        const fieldPath = rule.field_path;
        if (!fieldPath || typeof fieldPath !== 'string') continue;
        let tokens;
        try { tokens = parseExtractFieldPath(fieldPath); } catch { continue; }
        let existing;
        try { existing = getExtractPath(out, tokens, _EXTRACT_MISSING); } catch { existing = _EXTRACT_MISSING; }
        if (existing === _EXTRACT_MISSING || existing === null) {
            try { setExtractPath(out, tokens, rule.expected_value ?? null); } catch { /* skip */ }
        }
    }
    return out;
}

// --- Extract field rule indexing + selection state ---

// Current selection state for extract field mode
let selectedExtractFieldPath = null;
// Which bbox of the selected multi-bbox rule is the "active" ordinal. null
// when no rule is selected or the rule has a single bbox. This also anchors
// resize handles for extract-field evidence boxes.
let selectedExtractBboxIndex = null;
// Paths the user has explicitly expanded or collapsed (overrides default).
// Clicking a leaf re-renders the tree; we persist expansion here so users
// don't lose context around a deeply-nested field they just selected.
const expandedExtractPaths = new Set();
const collapsedExtractPaths = new Set();
// Filter: 'all' | 'verified' | 'unverified'
let extractFieldFilter = 'all';
let extractPageFilterEnabled = false;
const EXTRACT_TEXTAREA_SYNC_FULL_LIMIT = 160;
const EXTRACT_TEXTAREA_SYNC_VIEWPORT_MARGIN = 360;
let extractTextareaSyncFrame = null;
let extractTextareaResizeObserver = null;

/**
 * Return a Map keyed by field_path → rule (the first extract_field rule found for that path,
 * preferring non-stray entries if multiple).
 */
function indexExtractFieldRules() {
    const map = new Map();
    const rules = Array.isArray(currentTests?.test_rules) ? currentTests.test_rules : [];
    for (const rule of rules) {
        if (!rule || rule.type !== 'extract_field' || typeof rule.field_path !== 'string') continue;
        const existing = map.get(rule.field_path);
        const isStray = Array.isArray(rule.tags) && rule.tags.includes('stray_evidence');
        if (!existing) {
            map.set(rule.field_path, rule);
        } else {
            const existingStray = Array.isArray(existing.tags) && existing.tags.includes('stray_evidence');
            if (existingStray && !isStray) map.set(rule.field_path, rule);
        }
    }
    return map;
}

/** Short label: "line_items[0].description" → "description" */
function shortenFieldPathLabel(fieldPath) {
    if (!fieldPath) return '';
    const dotIdx = fieldPath.lastIndexOf('.');
    if (dotIdx >= 0) return fieldPath.slice(dotIdx + 1);
    const bracketIdx = fieldPath.lastIndexOf(']');
    if (bracketIdx >= 0 && bracketIdx < fieldPath.length - 1) return fieldPath.slice(bracketIdx + 1);
    return fieldPath;
}

// --- Recursive tree-based extract editor ---

/**
 * Build a tree of entries from schema + expected_output, recursing into objects/arrays.
 */
function buildExtractEntriesFromSchema(schemaDef, expectedOutput, parentRequired, ctx) {
    const properties = schemaDef?.properties && typeof schemaDef.properties === 'object' && !Array.isArray(schemaDef.properties)
        ? schemaDef.properties
        : {};
    const requiredSet = new Set(Array.isArray(parentRequired ?? schemaDef?.required) ? (parentRequired ?? schemaDef?.required) : []);
    const outputObj = expectedOutput && typeof expectedOutput === 'object' && !Array.isArray(expectedOutput)
        ? expectedOutput
        : {};
    const keys = Array.from(new Set([...Object.keys(properties), ...Object.keys(outputObj)]));
    keys.sort();
    return keys.map((key) => buildExtractEntryForKey(key, properties[key] || {}, outputObj[key], requiredSet.has(key), ctx));
}

function _joinExtractPath(parentPath, key) {
    if (!parentPath) return key;
    return `${parentPath}.${key}`;
}

function _joinExtractPathIndex(parentPath, index) {
    return `${parentPath || ''}[${index}]`;
}

function buildExtractEntryForKey(key, schemaDef, value, required, ctx) {
    const type = normalizeSchemaType(schemaDef.type, value);
    const ctxSafe = ctx || { rulesByPath: new Map(), parentPath: '' };
    const path = _joinExtractPath(ctxSafe.parentPath, key);
    if (type === 'object') {
        const childCtx = { ...ctxSafe, parentPath: path };
        return {
            key,
            type: 'object',
            required,
            path,
            children: buildExtractEntriesFromSchema(schemaDef, value, schemaDef?.required, childCtx),
        };
    }
    if (type === 'array') {
        const itemsSchemaDef = schemaDef.items && typeof schemaDef.items === 'object' ? schemaDef.items : {};
        const arrValue = Array.isArray(value) ? value : [];
        let itemsType = normalizeSchemaType(itemsSchemaDef.type, arrValue.length > 0 ? arrValue[0] : undefined);
        if (itemsType === 'string' && itemsSchemaDef.properties) {
            itemsType = 'object';
        }
        const children = arrValue.map((item, index) => {
            const itemPath = _joinExtractPathIndex(path, index);
            if (itemsType === 'object') {
                const itemCtx = { ...ctxSafe, parentPath: itemPath };
                return {
                    index,
                    type: 'object',
                    path: itemPath,
                    children: buildExtractEntriesFromSchema(itemsSchemaDef, item, itemsSchemaDef?.required, itemCtx),
                };
            }
            return _attachRuleToLeaf({
                index,
                type: itemsType,
                value: item,
                path: itemPath,
            }, ctxSafe.rulesByPath);
        });
        return {
            key,
            type: 'array',
            required,
            path,
            itemsType,
            itemsSchemaDef,
            children,
        };
    }
    return _attachRuleToLeaf({ key, type, value, required, path }, ctxSafe.rulesByPath);
}

function _attachRuleToLeaf(entry, rulesByPath) {
    const rule = rulesByPath.get(entry.path) || null;
    const bboxes = Array.isArray(rule?.bboxes) ? rule.bboxes : [];
    const verified = rule ? Boolean(rule.verified) : null;
    return { ...entry, rule, bboxes, verified };
}

/**
 * Prune entries based on extractFieldFilter. Returns filtered list.
 * - 'all': no pruning
 * - 'verified': keep branches that contain at least one verified leaf, hide purely-unverified-or-no-rule leaves
 * - 'unverified': keep branches that contain at least one unverified-or-no-rule leaf
 */
function applyExtractFieldFilter(entries, filter) {
    if (!filter || filter === 'all') return entries;
    const result = [];
    for (const entry of entries) {
        const kept = _filterEntry(entry, filter);
        if (kept) result.push(kept);
    }
    return result;
}

function _filterEntry(entry, filter) {
    if (entry.type === 'object' || entry.type === 'array' || entry.type === 'unassigned-group') {
        const isArrayRecord = entry.type === 'object' && /\[\d+\]$/.test(entry.path || '');
        if (filter === 'unverified' && isArrayRecord && _entryContainsFilterMatch(entry, filter)) {
            return entry;
        }
        const filteredChildren = [];
        for (const child of entry.children || []) {
            const kept = _filterEntry(child, filter);
            if (kept) filteredChildren.push(kept);
        }
        if (filteredChildren.length === 0) return null;
        return { ...entry, children: filteredChildren };
    }
    // Unassigned strays never satisfy verified=true, so they're only visible
    // under 'all' or 'unverified'.
    if (entry.type === 'unassigned-stray') {
        if (filter === 'verified') return null;
        return entry;
    }
    // leaf: only keep if it matches the filter
    if (filter === 'verified') {
        return entry.verified === true ? entry : null;
    }
    if (filter === 'unverified') {
        // no rule (null) OR verified=false → show
        return entry.verified !== true ? entry : null;
    }
    return entry;
}

function _entryContainsFilterMatch(entry, filter) {
    if (entry.type === 'object' || entry.type === 'array' || entry.type === 'unassigned-group') {
        return (entry.children || []).some((child) => _entryContainsFilterMatch(child, filter));
    }
    if (entry.type === 'unassigned-stray') {
        return filter !== 'verified';
    }
    if (filter === 'verified') {
        return entry.verified === true;
    }
    if (filter === 'unverified') {
        return entry.verified !== true;
    }
    return true;
}

function extractRuleHasBboxOnPage(rule, targetPage) {
    if (!rule || !Number.isFinite(targetPage)) return false;
    return Array.isArray(rule.bboxes) && rule.bboxes.some((bboxEntry) => bboxEntry?.page === targetPage);
}

function hasGroundedExtractFieldRules() {
    const rules = Array.isArray(currentTests?.test_rules) ? currentTests.test_rules : [];
    return rules.some((rule) => rule?.type === 'extract_field'
        && Array.isArray(rule.bboxes)
        && rule.bboxes.some((bboxEntry) => Number.isFinite(bboxEntry?.page)));
}

function isExtractPageFilterActive() {
    return extractPageFilterEnabled && hasGroundedExtractFieldRules();
}

function applyExtractCurrentPageFilter(entries, targetPage) {
    if (!Number.isFinite(targetPage)) return entries;
    const result = [];
    for (const entry of entries || []) {
        const kept = _filterEntryForCurrentPage(entry, targetPage);
        if (kept) result.push(kept);
    }
    return result;
}

function _filterEntryForCurrentPage(entry, targetPage) {
    if (entry.type === 'object' || entry.type === 'array' || entry.type === 'unassigned-group') {
        const filteredChildren = [];
        for (const child of entry.children || []) {
            const kept = _filterEntryForCurrentPage(child, targetPage);
            if (kept) filteredChildren.push(kept);
        }
        if (filteredChildren.length === 0) return null;
        return { ...entry, children: filteredChildren };
    }
    return extractRuleHasBboxOnPage(entry.rule, targetPage) ? entry : null;
}

function filterExtractEntries(entries) {
    let filtered = applyExtractFieldFilter(entries, extractFieldFilter);
    if (isExtractPageFilterActive()) {
        filtered = applyExtractCurrentPageFilter(filtered, pageNum);
    }
    return filtered;
}

function hasActiveExtractFieldFilters() {
    return extractFieldFilter !== 'all' || isExtractPageFilterActive();
}

function buildExtractEntriesFromCurrentTests(options = {}) {
    const { applyFilters = true } = options;
    const schema = currentTests?.data_schema && typeof currentTests.data_schema === 'object' && !Array.isArray(currentTests.data_schema)
        ? currentTests.data_schema
        : {};
    const expectedOutput = currentTests?.expected_output && typeof currentTests.expected_output === 'object' && !Array.isArray(currentTests.expected_output)
        ? currentTests.expected_output
        : {};
    const rulesByPath = indexExtractFieldRules();
    const ctx = { rulesByPath, parentPath: '' };
    const entries = buildExtractEntriesFromSchema(schema, expectedOutput, schema?.required, ctx);
    const strayEntries = _collectUnassignedStrayEntries();
    const withStrays = strayEntries.length > 0
        ? [_buildUnassignedStrayGroup(strayEntries), ...entries]
        : entries;
    return applyFilters ? filterExtractEntries(withStrays) : withStrays;
}

/**
 * Unassigned evidence (tags include 'stray_evidence') are bboxes we could
 * not confidently assign to any real row during conversion. They carry a
 * `field_path` that collides with a real row's path, so `indexExtractFieldRules`
 * (which prefers non-stray entries) hides them. Surface every stray under a
 * dedicated synthetic tree group so reviewers can see and later reassign them.
 */
function _collectUnassignedStrayEntries() {
    const rules = Array.isArray(currentTests?.test_rules) ? currentTests.test_rules : [];
    const entries = [];
    for (let i = 0; i < rules.length; i += 1) {
        const rule = rules[i];
        if (!rule || rule.type !== 'extract_field') continue;
        const tags = Array.isArray(rule.tags) ? rule.tags : [];
        if (!tags.includes('stray_evidence')) continue;
        const sourcePath = typeof rule.field_path === 'string' ? rule.field_path : '<unknown>';
        // Fallback uses the absolute test_rules index so it matches the
        // key built in renderExtractFieldOverlay. Both sites degrade the
        // same way when a rule lacks an id (hand-edited test.json).
        const syntheticPath = `__unassigned__/${rule.id || `idx-${i}`}`;
        entries.push({
            key: sourcePath,
            type: 'unassigned-stray',
            path: syntheticPath,
            sourcePath,
            ruleIndex: i,
            rule,
            bboxes: Array.isArray(rule.bboxes) ? rule.bboxes : [],
            verified: false,
            value: rule.expected_value,
            required: false,
        });
    }
    return entries;
}

function _buildUnassignedStrayGroup(strayEntries) {
    return {
        key: '__unassigned__',
        type: 'unassigned-group',
        path: '__unassigned__',
        required: false,
        children: strayEntries,
    };
}

/** Type selector HTML helper */
function extractTypeOptions(selected, types) {
    const allTypes = types || ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
    return allTypes.map((t) => `<option value="${t}" ${selected === t ? 'selected' : ''}>${t}</option>`).join('');
}

/**
 * Format a compact page-list + count suffix for an extract_field leaf row.
 * Scalars render as "(p1)"; multi-bbox rules render as
 * "(N bboxes · p1, p2)" with +N truncation at >= 4 unique pages.
 */
function _formatBboxPagesBadge(bboxes) {
    const pages = Array.from(new Set((bboxes || []).map((b) => b?.page).filter((p) => Number.isFinite(p))))
        .sort((a, b) => a - b);
    let pageLabel = '';
    if (pages.length === 0) {
        pageLabel = '';
    } else if (pages.length <= 3) {
        pageLabel = 'p' + pages.join(', p');
    } else {
        pageLabel = 'p' + pages.slice(0, 2).join(', p') + ', +' + (pages.length - 2);
    }
    const count = bboxes.length;
    if (count > 1) {
        return `${count} bboxes${pageLabel ? ` · ${pageLabel}` : ''}`;
    }
    return pageLabel || '1 bbox';
}

function buildUnassignedGroupHtml(entry) {
    const strays = Array.isArray(entry.children) ? entry.children : [];
    const count = strays.length;
    let html = '<div class="extract-node extract-unassigned-group" data-node-type="unassigned-group">';
    html += '<div class="extract-node-row extract-unassigned-header" data-field-path="__unassigned__">';
    html += '<span class="extract-node-toggle" title="Expand/Collapse">▼</span>';
    html += `<span class="extract-unassigned-title">⚠ Unassigned bboxes <span class="extract-unassigned-count">(${count})</span></span>`;
    html += '<span class="extract-unassigned-hint">Unassigned evidence — bboxes not confidently attached to a row.</span>';
    html += '</div>';
    html += '<div class="extract-node-children">';
    for (const stray of strays) {
        html += buildUnassignedStrayHtml(stray, 1);
    }
    html += '</div>';
    html += '</div>';
    return html;
}

function buildUnassignedStrayHtml(entry, depth = 1) {
    const indent = depth * 20;
    const path = entry.path || '';
    const sourcePath = entry.sourcePath || '';
    const bboxes = Array.isArray(entry.bboxes) ? entry.bboxes : [];
    const pages = Array.from(new Set(bboxes.map((b) => b?.page).filter((p) => Number.isFinite(p)))).sort((a, b) => a - b);
    const pageStr = pages.map((p) => `p${p}`).join(', ');
    const valuePreview = entry.value == null
        ? 'null'
        : String(entry.value).slice(0, 60);
    const isSelected = selectedExtractFieldPath === path;

    const rowClasses = ['extract-node-row', 'extract-unassigned-entry'];
    if (isSelected) rowClasses.push('extract-node-row--selected');

    let html = `<div class="extract-node extract-unassigned-stray" data-node-type="unassigned-stray" data-field-path="${escapeHtml(path)}" data-source-path="${escapeHtml(sourcePath)}" data-rule-index="${entry.ruleIndex}">`;
    html += `<div class="${rowClasses.join(' ')}" style="padding-left: ${8 + indent}px;" data-field-path="${escapeHtml(path)}">`;
    html += '<span class="extract-node-toggle-spacer"></span>';
    html += `<span class="extract-node-key extract-unassigned-key" title="${escapeHtml(sourcePath)}">${escapeHtml(sourcePath)}</span>`;
    html += `<span class="extract-unassigned-value" title="${escapeHtml(String(valuePreview))}">"${escapeHtml(valuePreview)}"</span>`;
    if (bboxes.length > 0) {
        html += `<span class="extract-bbox-count-badge" data-path="${escapeHtml(path)}">${bboxes.length} bbox${bboxes.length === 1 ? '' : 'es'}${pageStr ? ` · ${pageStr}` : ''}</span>`;
    }
    html += '</div></div>';
    return html;
}

function normalizeExtractKeyText(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function syncExtractKeyTextareaHeight(textarea) {
    if (!textarea?.classList?.contains('extract-key')) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 28), 112)}px`;
}

function getExtractTextareaScrollContainer(root = elements.extractKvRows) {
    return root?.closest?.('.extract-editor-tree-wrap') || root || null;
}

function isElementNearScrollViewport(element, container, margin = EXTRACT_TEXTAREA_SYNC_VIEWPORT_MARGIN) {
    if (!element || !container || typeof element.getBoundingClientRect !== 'function') return true;
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return elementRect.bottom >= containerRect.top - margin
        && elementRect.top <= containerRect.bottom + margin
        && elementRect.right >= containerRect.left - margin
        && elementRect.left <= containerRect.right + margin;
}

function syncExtractEditorTextareaHeights(root = elements.extractKvRows, options = {}) {
    if (!root) return;
    const textareas = Array.from(root.querySelectorAll?.('.extract-key, .extract-value') || []);
    const visibleOnly = Boolean(options.visibleOnly) || textareas.length > EXTRACT_TEXTAREA_SYNC_FULL_LIMIT;
    const scrollContainer = visibleOnly ? getExtractTextareaScrollContainer(root) : null;
    for (const textarea of textareas) {
        if (visibleOnly && !isElementNearScrollViewport(textarea, scrollContainer)) continue;
        if (textarea.classList?.contains('extract-key')) {
            syncExtractKeyTextareaHeight(textarea);
        } else if (textarea.classList?.contains('extract-value')) {
            resizeExtractValueTextarea(textarea, true);
        }
    }
}

function scheduleVisibleExtractEditorTextareaSync(root = elements.extractKvRows) {
    if (!root || extractTextareaSyncFrame !== null) return;
    extractTextareaSyncFrame = window.requestAnimationFrame(() => {
        extractTextareaSyncFrame = null;
        syncExtractEditorTextareaHeights(root, { visibleOnly: true });
    });
}

/**
 * Render a single extract node (field row + children) recursively.
 * @param {object} entry - tree entry
 * @param {number} depth - nesting depth for indentation
 * @param {boolean} isArrayItem - true if this is an array element (shows index, no key input)
 */
function buildExtractNodeHtml(entry, depth = 0, isArrayItem = false) {
    if (entry.type === 'unassigned-group') {
        return buildUnassignedGroupHtml(entry);
    }
    if (entry.type === 'unassigned-stray') {
        return buildUnassignedStrayHtml(entry, depth);
    }
    const indent = depth * 20;
    const type = entry.type || 'string';
    const isExpandable = type === 'object' || type === 'array';
    const children = entry.children || [];
    const isLeaf = !isExpandable;
    const path = entry.path || '';

    const isSelected = isLeaf && path && selectedExtractFieldPath === path;
    const isArrayNode = type === 'array';
    // Default: collapse large arrays for perf (inventory_listing_1 has 4,700 rules).
    // Override: user's explicit expand/collapse choices survive re-render so
    // they don't lose context after clicking a nested leaf.
    const defaultCollapsed = isArrayNode && !(entry.children && entry.children.length <= 10);
    let startCollapsed = defaultCollapsed;
    if (path) {
        if (expandedExtractPaths.has(path)) startCollapsed = false;
        else if (collapsedExtractPaths.has(path)) startCollapsed = true;
    }
    // Force the ancestor chain of the selected path to stay expanded so the
    // user can always see where the selection lives.
    if (!isLeaf && path && selectedExtractFieldPath
        && (selectedExtractFieldPath === path
            || selectedExtractFieldPath.startsWith(path + '.')
            || selectedExtractFieldPath.startsWith(path + '['))
        && !collapsedExtractPaths.has(path)) {
        startCollapsed = false;
    }

    const rowClasses = ['extract-node-row'];
    if (isSelected) rowClasses.push('extract-node-row--selected');

    let html = `<div class="extract-node" data-node-type="${type}"${isArrayNode ? ` data-items-type="${entry.itemsType || 'string'}"` : ''}${path ? ` data-field-path="${escapeHtml(path)}"` : ''}>`;
    html += `<div class="${rowClasses.join(' ')}" style="padding-left: ${8 + indent}px;"${path ? ` data-field-path="${escapeHtml(path)}"` : ''}>`;

    // Toggle or spacer
    if (isExpandable) {
        const toggleChar = startCollapsed ? '▶' : '▼';
        html += `<span class="extract-node-toggle" title="Expand/Collapse">${toggleChar}</span>`;
    } else {
        html += `<span class="extract-node-toggle-spacer"></span>`;
    }

    // Key or index label
    if (isArrayItem) {
        html += `<span class="extract-node-key"><span class="extract-index-label">[${entry.index}]</span></span>`;
    } else {
        html += `<span class="extract-node-key"><textarea class="extract-key" rows="1" spellcheck="false" placeholder="field_name">${escapeHtml(entry.key || '')}</textarea></span>`;
    }

    // Type selector (not for array items that are objects — type is fixed by parent)
    if (isArrayItem && type === 'object') {
        html += `<span class="extract-node-type"><span class="extract-object-label">{object}</span></span>`;
    } else if (!isArrayItem) {
        html += `<span class="extract-node-type"><select class="extract-type">${extractTypeOptions(type)}</select></span>`;
    } else {
        html += `<span class="extract-node-type"><span style="color: var(--text-muted); font-size: 11px;">${type}</span></span>`;
    }

    // Items type selector (for array nodes only)
    if (type === 'array') {
        html += `<span class="extract-node-items-type"><span class="extract-node-items-type-label">items:</span><select class="extract-items-type">${extractTypeOptions(entry.itemsType || 'string')}</select></span>`;
    }

    // Value textarea (only for primitive non-expandable types)
    if (!isExpandable) {
        html += `<span class="extract-node-value"><textarea class="extract-value" placeholder="value">${escapeHtml(formatExtractValueForInput(entry.value, type))}</textarea></span>`;
    }

    // Required checkbox (only for top-level-ish named fields, not array items)
    if (!isArrayItem) {
        html += `<span class="extract-node-req" title="Required"><input type="checkbox" class="extract-required" ${entry.required ? 'checked' : ''}></span>`;
    }

    // Extract field grounding indicators (leaves only)
    if (isLeaf && path) {
        if (entry.verified !== null && entry.verified !== undefined) {
            const badgeClass = entry.verified ? 'is-verified' : 'is-unverified';
            const badgeText = entry.verified ? '✓ verified' : '⚠ needs review';
            html += `<span class="extract-verified-badge ${badgeClass}" data-path="${escapeHtml(path)}">${badgeText}</span>`;
            html += `<button type="button" class="btn btn-xs btn-ghost extract-toggle-verified" data-path="${escapeHtml(path)}" title="Toggle verified">Toggle</button>`;
        }
        if (Array.isArray(entry.bboxes) && entry.bboxes.length > 0) {
            html += `<span class="extract-bbox-count-badge" data-path="${escapeHtml(path)}">${_formatBboxPagesBadge(entry.bboxes)}</span>`;
        }
        html += `<button type="button" class="btn btn-xs btn-ghost extract-draw-bbox" data-path="${escapeHtml(path)}" title="Draw a new bounding box for this field">+ Draw</button>`;
    }

    // Actions
    html += `<span class="extract-node-actions">`;
    if (type === 'object') {
        html += `<button type="button" class="btn btn-xs btn-secondary extract-add-child" title="Add field">+ Field</button>`;
    }
    if (type === 'array') {
        html += `<button type="button" class="btn btn-xs btn-secondary extract-add-item" title="Add item">+ Item</button>`;
    }
    html += `<button type="button" class="btn btn-xs btn-danger extract-delete-row" title="Delete">×</button>`;
    html += `</span>`;

    html += `</div>`; // close .extract-node-row

    // Children container
    if (isExpandable) {
        const childClasses = ['extract-node-children'];
        if (startCollapsed) childClasses.push('collapsed');
        // For lazy mode, stash the child depth + parent path + itemsType for materialization later.
        const lazyAttrs = startCollapsed
            ? ` data-lazy-pending="true" data-lazy-depth="${depth + 1}" data-lazy-parent-path="${escapeHtml(path)}" data-lazy-items-type="${escapeHtml(entry.itemsType || 'string')}"`
            : '';
        html += `<div class="${childClasses.join(' ')}"${lazyAttrs}>`;
        if (!startCollapsed) {
            if (type === 'object') {
                for (const child of children) {
                    html += buildExtractNodeHtml(child, depth + 1, false);
                }
            } else if (type === 'array') {
                for (const child of children) {
                    const childIsObj = (entry.itemsType || 'string') === 'object';
                    html += buildExtractNodeHtml(
                        childIsObj ? { ...child, type: 'object' } : { ...child, type: entry.itemsType || 'string' },
                        depth + 1,
                        true,
                    );
                }
            }
        } else {
            html += `<div class="extract-lazy-placeholder" aria-label="lazy-pending">${children.length} collapsed items — click to expand</div>`;
        }
        html += `</div>`;
    }

    html += `</div>`; // close .extract-node
    return html;
}

function resizeExtractValueTextarea(textarea, expand = true) {
    if (!textarea) return;
    if (!expand) {
        textarea.classList?.remove('extract-value--expanded');
        textarea.style.height = '';
        return;
    }

    textarea.classList?.add('extract-value--expanded');
    textarea.style.height = 'auto';
    const nextHeight = Math.max(
        Number(textarea.scrollHeight) || EXTRACT_VALUE_TEXTAREA_MIN_HEIGHT,
        EXTRACT_VALUE_TEXTAREA_MIN_HEIGHT,
    );
    textarea.style.height = `${nextHeight}px`;
}

function updateExtractFieldFilterControls() {
    if (elements.extractFieldFilterSelect && elements.extractFieldFilterSelect.value !== extractFieldFilter) {
        elements.extractFieldFilterSelect.value = extractFieldFilter;
    }

    const pageFilterAvailable = hasGroundedExtractFieldRules();
    if (elements.extractPageFilterToggle) {
        elements.extractPageFilterToggle.disabled = !pageFilterAvailable;
        elements.extractPageFilterToggle.checked = pageFilterAvailable && extractPageFilterEnabled;
        elements.extractPageFilterToggle.title = pageFilterAvailable
            ? 'Show only fields with bounding boxes on the current page'
            : 'No page-level bounding boxes are available for this file';
    }
    if (elements.extractPageFilterMeta) {
        if (!pageFilterAvailable) {
            elements.extractPageFilterMeta.textContent = 'No page bboxes';
        } else if (extractPageFilterEnabled) {
            elements.extractPageFilterMeta.textContent = `Page ${pageNum}`;
        } else {
            elements.extractPageFilterMeta.textContent = '';
        }
    }

    const filtersActive = hasActiveExtractFieldFilters();
    if (elements.extractSaveBtn) {
        elements.extractSaveBtn.disabled = filtersActive;
        elements.extractSaveBtn.title = filtersActive
            ? 'Clear extract filters before saving so hidden fields are preserved'
            : '';
    }
    if (elements.extractAddRowBtn) {
        elements.extractAddRowBtn.disabled = filtersActive;
        elements.extractAddRowBtn.title = filtersActive
            ? 'Clear extract filters before adding top-level fields'
            : '';
    }
}

function selectedExtractPathHasBboxOnCurrentPage() {
    if (!selectedExtractFieldPath || !isExtractPageFilterActive()) return true;
    const ruleIdx = _findExtractRuleIndexByPath(selectedExtractFieldPath);
    const rule = ruleIdx >= 0 ? currentTests?.test_rules?.[ruleIdx] : null;
    return extractRuleHasBboxOnPage(rule, pageNum);
}

function renderExtractEditor() {
    if (!elements.extractKvRows) return;
    if (!selectedExtractPathHasBboxOnCurrentPage()) {
        selectedExtractFieldPath = null;
        selectedExtractBboxIndex = null;
    }
    updateExtractFieldFilterControls();
    const unfilteredEntries = buildExtractEntriesFromCurrentTests({ applyFilters: false });
    const entries = filterExtractEntries(unfilteredEntries);
    if (entries.length > 0) {
        elements.extractKvRows.innerHTML = entries.map((e) => buildExtractNodeHtml(e, 0, false)).join('');
    } else if (unfilteredEntries.length > 0 && hasActiveExtractFieldFilters()) {
        const message = isExtractPageFilterActive()
            ? `No grounded extract fields on page ${pageNum}.`
            : 'No extract fields match the current filter.';
        elements.extractKvRows.innerHTML = `<div class="extract-editor-empty">${escapeHtml(message)}</div>`;
    } else {
        elements.extractKvRows.innerHTML = buildExtractNodeHtml({ key: '', type: 'string', value: '', required: false }, 0, false);
    }
    if (elements.testCount) {
        elements.testCount.textContent = String(getAnnotationCountForPayload(currentTests));
    }

    if (elements.extractConfigJson) {
        const config = currentTests?.config;
        elements.extractConfigJson.value = config ? JSON.stringify(config, null, 2) : '';
    }
    syncExtractEditorTextareaHeights();
}

/**
 * Recursively collect schema + expected_output from the DOM tree.
 * @param {Element} container - element containing .extract-node children
 * @param {boolean} isObjectContext - true if collecting named properties (vs array items)
 * @returns {{ error?: string, properties?: object, required?: string[], expectedOutput?: object, items?: object[], itemValues?: any[] }}
 */
function collectExtractNodesFromContainer(container, isObjectContext) {
    const nodes = Array.from(container.children).filter((el) => el.classList.contains('extract-node'));

    if (isObjectContext) {
        const properties = {};
        const required = [];
        const expectedOutput = {};
        const seenKeys = new Set();

        for (const node of nodes) {
            const row = node.querySelector(':scope > .extract-node-row');
            const key = normalizeExtractKeyText(row?.querySelector('.extract-key')?.value);
            const typeSelect = row?.querySelector('.extract-type');
            const type = typeSelect?.value || node.dataset.nodeType || 'string';
            const isRequired = Boolean(row?.querySelector('.extract-required')?.checked);

            if (!key) continue;
            if (seenKeys.has(key)) {
                return { error: `Duplicate key: ${key}` };
            }
            seenKeys.add(key);

            if (type === 'object') {
                const childContainer = node.querySelector(':scope > .extract-node-children');
                if (childContainer) {
                    const childResult = collectExtractNodesFromContainer(childContainer, true);
                    if (childResult.error) return { error: `Field "${key}": ${childResult.error}` };
                    const propDef = { type: 'object' };
                    if (Object.keys(childResult.properties).length > 0) {
                        propDef.properties = childResult.properties;
                    }
                    if (childResult.required.length > 0) {
                        propDef.required = childResult.required;
                    }
                    properties[key] = propDef;
                    expectedOutput[key] = childResult.expectedOutput;
                } else {
                    properties[key] = { type: 'object' };
                    expectedOutput[key] = {};
                }
            } else if (type === 'array') {
                const itemsType = row?.querySelector('.extract-items-type')?.value || node.dataset.itemsType || 'string';
                const childContainer = node.querySelector(':scope > .extract-node-children');
                if (childContainer) {
                    const childResult = collectExtractNodesFromContainer(childContainer, false);
                    if (childResult.error) return { error: `Field "${key}": ${childResult.error}` };
                    const propDef = { type: 'array', items: {} };
                    if (itemsType === 'object') {
                        propDef.items = { type: 'object' };
                        // Infer properties schema from first item if available
                        if (childResult.items && childResult.items.length > 0) {
                            const firstItemSchema = childResult.items[0].schema;
                            if (firstItemSchema && Object.keys(firstItemSchema.properties || {}).length > 0) {
                                propDef.items.properties = firstItemSchema.properties;
                                if (firstItemSchema.required?.length > 0) {
                                    propDef.items.required = firstItemSchema.required;
                                }
                            }
                        }
                    } else {
                        propDef.items = { type: itemsType };
                    }
                    properties[key] = propDef;
                    expectedOutput[key] = childResult.itemValues || [];
                } else {
                    properties[key] = { type: 'array', items: { type: itemsType } };
                    expectedOutput[key] = [];
                }
            } else {
                // primitive
                const rawValue = row?.querySelector('.extract-value')?.value ?? '';
                const parsed = parseExtractValueFromInput(rawValue, type);
                if (parsed.error) return { error: `Field "${key}": ${parsed.error}` };
                properties[key] = { type };
                expectedOutput[key] = parsed.value;
            }

            if (isRequired) required.push(key);
        }

        return { properties, required, expectedOutput };
    } else {
        // Array items context
        const items = [];
        const itemValues = [];

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const nodeType = node.dataset.nodeType || 'string';

            if (nodeType === 'object') {
                const childContainer = node.querySelector(':scope > .extract-node-children');
                if (childContainer) {
                    const childResult = collectExtractNodesFromContainer(childContainer, true);
                    if (childResult.error) return { error: `Item [${i}]: ${childResult.error}` };
                    items.push({
                        schema: { properties: childResult.properties, required: childResult.required },
                    });
                    itemValues.push(childResult.expectedOutput);
                } else {
                    items.push({ schema: {} });
                    itemValues.push({});
                }
            } else {
                // primitive array item
                const row = node.querySelector(':scope > .extract-node-row');
                const rawValue = row?.querySelector('.extract-value')?.value ?? '';
                const parsed = parseExtractValueFromInput(rawValue, nodeType);
                if (parsed.error) return { error: `Item [${i}]: ${parsed.error}` };
                items.push({ schema: { type: nodeType } });
                itemValues.push(parsed.value);
            }
        }

        return { items, itemValues };
    }
}

function collectExtractPayloadFromEditor() {
    if (!elements.extractKvRows) {
        return { payload: normalizeCurrentTestsPayload(currentTests) };
    }
    if (hasActiveExtractFieldFilters()) {
        return { error: 'Clear extract filters before saving so hidden fields are preserved.' };
    }

    const result = collectExtractNodesFromContainer(elements.extractKvRows, true);
    if (result.error) return { error: result.error };

    const payload = normalizeCurrentTestsPayload(currentTests);
    payload.annotation_mode = ANNOTATION_MODE_EXTRACT;
    payload.data_schema = { type: 'object', properties: result.properties };
    if (result.required.length > 0) {
        payload.data_schema.required = result.required;
    } else {
        delete payload.data_schema.required;
    }
    payload.expected_output = result.expectedOutput;

    if (elements.extractConfigJson) {
        const configText = elements.extractConfigJson.value.trim();
        if (!configText) {
            delete payload.config;
        } else {
            try {
                const parsedConfig = JSON.parse(configText);
                if (parsedConfig && typeof parsedConfig === 'object' && !Array.isArray(parsedConfig)) {
                    payload.config = parsedConfig;
                } else {
                    return { error: 'config must be a JSON object' };
                }
            } catch (error) {
                return { error: `Invalid config JSON: ${error.message}` };
            }
        }
    }

    return { payload };
}

function countExpectedOutputLeaves(value, isRoot = false) {
    if (value === undefined || (isRoot && value === null)) return 0;
    if (Array.isArray(value)) {
        return value.reduce((total, item) => total + countExpectedOutputLeaves(item), 0);
    }
    if (value && typeof value === 'object') {
        return Object.values(value).reduce((total, item) => total + countExpectedOutputLeaves(item), 0);
    }
    return 1;
}

function countExtractFieldRules(testData) {
    const testRules = Array.isArray(testData?.test_rules) ? testData.test_rules : [];
    return testRules.filter(rule => rule && rule.type === 'extract_field').length;
}

function getAnnotationCountForPayload(testData) {
    const testRules = Array.isArray(testData?.test_rules) ? testData.test_rules : [];
    const mode = inferAnnotationModeFromPayload(testData);
    if (mode === ANNOTATION_MODE_EXTRACT) {
        const extractRuleCount = countExtractFieldRules(testData);
        if (extractRuleCount > 0) return extractRuleCount;
        return countExpectedOutputLeaves(testData?.expected_output, true);
    }
    return testRules.length;
}

function isTestsPayloadFullyVerified(testData) {
    const rules = Array.isArray(testData?.test_rules) ? testData.test_rules : [];
    return rules.length > 0 && rules.every(rule => !rule || rule.verified !== false);
}

function deriveFileStatusFromTests(currentStatus, testData) {
    if (currentStatus === 'skipped') return 'skipped';
    return isTestsPayloadFullyVerified(testData) ? 'completed' : 'pending';
}

function updateQueueStatsFromFiles() {
    if (elements.statPending) {
        elements.statPending.textContent = String(files.filter(file => file.status === 'pending').length);
    }
    if (elements.statCompleted) {
        elements.statCompleted.textContent = String(files.filter(file => file.status === 'completed').length);
    }
}

async function saveExtractEditor(showSuccessToast = false, options = {}) {
    const {
        allowValidationFailure = false,
        validationToastType = 'error',
        validationMessagePrefix = '',
        reason = 'manual-save',
    } = options;
    const collected = collectExtractPayloadFromEditor();
    if (collected.error) {
        showToast(`${validationMessagePrefix}${collected.error}`, validationToastType);
        return allowValidationFailure;
    }
    currentTests = collected.payload;
    const saved = await saveTests(reason);
    if (!saved) return false;
    if (showSuccessToast) {
        showToast('Extract fields saved', 'success');
    }
    return true;
}

function applyAnnotationModeUi() {
    const isExtract = annotationMode === ANNOTATION_MODE_EXTRACT;
    if (elements.annotationModeParseBtn) {
        elements.annotationModeParseBtn.classList.toggle('active', !isExtract);
    }
    if (elements.annotationModeExtractBtn) {
        elements.annotationModeExtractBtn.classList.toggle('active', isExtract);
    }

    if (elements.addTestSection) {
        elements.addTestSection.style.display = isExtract ? 'none' : '';
    }
    if (elements.ruleListFilters) {
        elements.ruleListFilters.style.display = isExtract ? 'none' : '';
    }
    if (elements.testList) {
        elements.testList.style.display = isExtract ? 'none' : '';
    }
    if (elements.expectedMarkdownSection) {
        elements.expectedMarkdownSection.style.display = isExtract ? 'none' : '';
    }
    if (elements.extractEditorSection) {
        elements.extractEditorSection.style.display = isExtract ? '' : 'none';
    }
    if (elements.extractFieldFilterBar) {
        // Only reveal the filter bar when EXTRACT mode is active AND the current test
        // case carries at least one extract_field rule (so extractbench_v3 stays clean).
        const hasExtractFieldRules = isExtract && Array.isArray(currentTests?.test_rules)
            && currentTests.test_rules.some((r) => r && r.type === 'extract_field');
        elements.extractFieldFilterBar.style.display = hasExtractFieldRules ? '' : 'none';
    }
    updateExtractFieldFilterControls();

    if (elements.clearAllTestsBtn) {
        elements.clearAllTestsBtn.style.display = isExtract ? 'none' : '';
    }
    if (elements.verifyAllTestsBtn) {
        elements.verifyAllTestsBtn.style.display = isExtract ? 'none' : '';
    }

    if (elements.testTypeSelect) {
        elements.testTypeSelect.disabled = isExtract;
    }

    if (elements.parseMdSection) {
        elements.parseMdSection.style.display = (!isExtract && parseMdAvailable) ? 'block' : 'none';
    }
    if (elements.aiGenerateTestsBtn) {
        elements.aiGenerateTestsBtn.disabled = isExtract;
        elements.aiGenerateTestsBtn.title = isExtract
            ? 'Generate Tests is available in Parse mode'
            : 'Generate test rules from region';
    }
    if (elements.aiReviewTestsBtn) {
        elements.aiReviewTestsBtn.disabled = isExtract;
        elements.aiReviewTestsBtn.title = isExtract
            ? 'Review Tests is available in Parse mode'
            : 'Review existing tests against document';
    }

    if (isExtract) {
        renderExtractEditor();
        clearTestForm();
        // Re-render overlay so extract_field bboxes appear after mode switch
        try { renderLayoutOverlay(); } catch { /* pdf may not yet be loaded */ }
    } else {
        renderTestList();
        try { renderLayoutOverlay(); } catch { /* ignore */ }
    }
    updateCompleteButtonState();
}

function setAnnotationMode(mode) {
    const nextMode = mode === ANNOTATION_MODE_EXTRACT ? ANNOTATION_MODE_EXTRACT : ANNOTATION_MODE_PARSE;
    if (nextMode === annotationMode) {
        return;
    }
    if (annotationMode === ANNOTATION_MODE_EXTRACT) {
        const collected = collectExtractPayloadFromEditor();
        if (collected.error) {
            showToast(`Current extract edits were not saved: ${collected.error}`, 'warning');
        } else {
            currentTests = collected.payload;
        }
    } else if (elements.expectedMarkdown) {
        currentTests.expected_markdown = elements.expectedMarkdown.value || null;
    }

    annotationMode = nextMode;
    if (annotationMode === ANNOTATION_MODE_EXTRACT) {
        currentTests.annotation_mode = ANNOTATION_MODE_EXTRACT;
    } else if (currentTests?.annotation_mode) {
        currentTests.annotation_mode = ANNOTATION_MODE_PARSE;
    }
    if (isMultiPagePdf) {
        // Re-evaluate multi-page annotation state based on new mode
        updateAnnotationState();
    } else {
        applyAnnotationModeUi();
    }
}

function buildApiUrl(path, extraParams = {}) {
    const url = new URL(path, window.location.origin);
    const queueParamValue = queueId || queueDir || initialQueueDirParam;
    if (queueParamValue) {
        url.searchParams.set(queueId ? 'queue' : 'dir', queueParamValue);
    }
    Object.entries(extraParams).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            url.searchParams.set(key, String(value));
        }
    });
    return `${url.pathname}${url.search}`;
}

function updateQueueScopedUi() {
    if (!elements.selectDirBtn) return;
    elements.selectDirBtn.disabled = queueScopedMode;
    elements.selectDirBtn.title = queueScopedMode ? `Queue locked to ${queueId}` : '';
}

function normalizeFileSearchQuery(query) {
    return String(query || '').trim().toLowerCase();
}

function isFileSearchActive() {
    return normalizeFileSearchQuery(fileSearchQuery).length > 0;
}

function fileMatchesSearchQuery(file, query) {
    const terms = normalizeFileSearchQuery(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return true;

    const haystack = [
        file?.name,
        file?.path,
        file?.group || 'root',
    ].filter(Boolean).join(' ').toLowerCase();
    return terms.every(term => haystack.includes(term));
}

function getSearchMatchedFiles() {
    return files
        .map((file, index) => ({ ...file, arrayIndex: index }))
        .filter(file => fileMatchesSearchQuery(file, fileSearchQuery));
}

function updateQueueToolsUi() {
    if (elements.queueToolsSection) {
        elements.queueToolsSection.classList.toggle('collapsed', queueToolsCollapsed);
    }
    if (elements.queueToolsToggle) {
        elements.queueToolsToggle.setAttribute('aria-expanded', String(!queueToolsCollapsed));
    }
    if (elements.queueToolsFold) {
        elements.queueToolsFold.textContent = queueToolsCollapsed ? '▶' : '▼';
    }
    if (elements.fileSearchInput && elements.fileSearchInput.value !== fileSearchQuery) {
        elements.fileSearchInput.value = fileSearchQuery;
    }

    const searchActive = isFileSearchActive();
    const matchCount = searchActive ? getSearchMatchedFiles().length : files.length;
    if (elements.queueToolsSummary) {
        if (searchActive) {
            elements.queueToolsSummary.textContent = `${matchCount}/${files.length} matching`;
        } else if (queueDir) {
            elements.queueToolsSummary.textContent = elements.currentDirLabel?.textContent || 'Directory selected';
        } else {
            elements.queueToolsSummary.textContent = 'Select directory';
        }
    }
    if (elements.fileSearchClear) {
        elements.fileSearchClear.classList.toggle('visible', searchActive);
    }
    if (elements.fileSearchStatus) {
        elements.fileSearchStatus.textContent = searchActive
            ? `${matchCount} matching file${matchCount === 1 ? '' : 's'} across all folders`
            : '';
    }
}

function toggleQueueTools() {
    queueToolsCollapsed = !queueToolsCollapsed;
    updateQueueToolsUi();
}

function clearFileSearch() {
    fileSearchQuery = '';
    renderFileList();
}

// === API Functions ===
async function fetchConfig() {
    try {
        const response = await fetch(buildApiUrl('/api/config'));
        const data = await response.json();
        queueId = data.queue_id || queueId;
        if (!queueId) {
            queueIdParam = 'dir';
        }
        queueScopedMode = Boolean(queueId);
        queueDir = data.queue_dir;
        if (queueDir && !queueId) {
            initialQueueDirParam = null;
        }
        outputDir = data.output_dir;
        updateDirectoryDisplay();
        updateQueueScopedUi();
        // First-load URL sync: if the server launched with --queue-dir and
        // the user opened / with no params, echo the resolved queue into
        // the URL so they can share it. updateBrowserUrl is a no-op when
        // there's nothing to add.
        updateBrowserUrl(requestedInitialFilePath);
        return data;
    } catch (error) {
        console.error('Failed to fetch config:', error);
        return null;
    }
}

async function fetchCapabilities() {
    try {
        const response = await fetch('/api/capabilities');
        capabilities = await response.json();

        // Update UI based on capabilities
        if (!capabilities.extract_page) {
            elements.extractPage.disabled = true;
            elements.extractPage.title = 'Page extraction not available (pypdf not installed)';
        }

        // Update AI button based on VLM availability
        if (elements.aiSelectBtn) {
            if (!capabilities.vlm_sdk_installed) {
                elements.aiSelectBtn.disabled = true;
                elements.aiSelectBtn.title = 'AI features not available (google-genai not installed)';
            } else if (!capabilities.vlm_configured) {
                elements.aiSelectBtn.title = 'Configure API key in AI Settings to enable';
            }
        }

        return capabilities;
    } catch (error) {
        console.error('Failed to fetch capabilities:', error);
        return { extract_page: false, vlm_available: false };
    }
}

async function setQueueDirectory(path) {
    if (queueScopedMode) {
        showToast('This annotator session is locked to a generated queue', 'error');
        return false;
    }

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ queue_dir: path }),
        });
        const data = await response.json();

        if (data.error) {
            showToast(data.error, 'error');
            return false;
        }

        queueDir = data.queue_dir;
        queueId = null;
        queueIdParam = 'dir';
        initialQueueDirParam = null;
        queueScopedMode = false;
        updateDirectoryDisplay();
        updateQueueScopedUi();
        // Echo the selected directory into the URL so copy-paste deep-links
        // include both the queue and the file.
        updateBrowserUrl(currentFile?.path || null);
        await fetchQueue();
        showToast('Directory loaded', 'success');
        return true;
    } catch (error) {
        showToast('Failed to set directory', 'error');
        console.error(error);
        return false;
    }
}

function updateDirectoryDisplay() {
    if (queueDir) {
        if (queueScopedMode && queueId) {
            elements.currentDirLabel.textContent = queueId;
        } else {
            const parts = queueDir.split('/');
            const dirName = parts[parts.length - 1] || parts[parts.length - 2];
            elements.currentDirLabel.textContent = dirName;
        }
        elements.currentDirPath.textContent = queueDir;
        elements.currentDirPath.title = queueDir;
    } else {
        elements.currentDirLabel.textContent = 'Select Directory...';
        elements.currentDirPath.textContent = '';
    }
    updateQueueToolsUi();
}

function normalizeQueueRelativeFilePath(filePath) {
    if (typeof filePath !== 'string') return null;

    const trimmedPath = filePath.trim();
    if (!trimmedPath) return null;

    const normalizedPath = trimmedPath
        .replace(/\\/g, '/')
        .replace(/^(?:\.\/)+/, '')
        .replace(/^\/+/, '');

    return normalizedPath || null;
}

/**
 * Sync the browser URL with the current queue + file so it can be
 * copy-pasted to deep-link back. Uses whichever queue param key was
 * originally present (`dir` or `queue`) and defaults to `dir` with an
 * absolute path otherwise — so users who select a queue via the
 * "Select Directory" modal still get a shareable URL.
 */
function updateBrowserUrl(filePath = null) {
    const url = new URL(window.location.href);

    // Queue scope. Preserve the user's original param key when present
    // so `?queue=relative/path` stays `?queue=...`; otherwise emit the
    // resolved absolute path as `?dir=...`.
    const dirKey = queueId ? 'queue' : 'dir';
    const otherKey = dirKey === 'dir' ? 'queue' : 'dir';
    const dirValue = queueId || queueDir || initialQueueDirParam;
    if (dirValue) {
        url.searchParams.set(dirKey, dirValue);
        url.searchParams.delete(otherKey);
    } else {
        url.searchParams.delete('dir');
        url.searchParams.delete('queue');
    }

    const normalizedPath = normalizeQueueRelativeFilePath(filePath);
    if (normalizedPath) {
        url.searchParams.set('file', normalizedPath);
    } else {
        url.searchParams.delete('file');
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

// Back-compat alias: older callers passed only the file path. New logic
// lives in updateBrowserUrl so we can also carry the queue/dir.
function updateSelectedFileUrl(filePath = null) {
    updateBrowserUrl(filePath);
}

function findFileIndexByPath(filePath) {
    const normalizedPath = normalizeQueueRelativeFilePath(filePath);
    if (!normalizedPath) return -1;

    return files.findIndex(file => normalizeQueueRelativeFilePath(file.path) === normalizedPath);
}

function expandGroupForFileIndex(fileIndex) {
    const file = files[fileIndex];
    if (!file || !file.group || file.group === 'root') return;

    if (collapsedGroups.has(file.group)) {
        collapsedGroups.delete(file.group);
    }
}

function getDefaultQueueSelectionIndex() {
    const firstPending = files.findIndex(file => file.status === 'pending');
    if (firstPending !== -1) {
        return firstPending;
    }
    return files.length > 0 ? 0 : -1;
}

async function selectFileByPath(filePath) {
    const fileIndex = findFileIndexByPath(filePath);
    if (fileIndex === -1) return false;

    expandGroupForFileIndex(fileIndex);
    const targetFile = files[fileIndex];
    if (currentFile?.path === targetFile.path && currentFileQueueDir === queueDir) {
        currentFileIndex = fileIndex;
        updateSelectedFileUrl(targetFile.path);
        renderFileList();
        return true;
    }

    await selectFile(fileIndex);
    return true;
}

async function selectInitialQueueFile() {
    if (!requestedInitialFileHandled && requestedInitialFilePath) {
        requestedInitialFileHandled = true;
        const selectedRequestedFile = await selectFileByPath(requestedInitialFilePath);
        if (selectedRequestedFile) {
            requestedInitialFilePath = null;
            return true;
        }

        showToast(`Requested file not found: ${requestedInitialFilePath}`, 'warning');
        requestedInitialFilePath = null;
    }

    const defaultIndex = getDefaultQueueSelectionIndex();
    if (defaultIndex === -1) {
        return false;
    }

    expandGroupForFileIndex(defaultIndex);
    await selectFile(defaultIndex);
    return true;
}

async function fetchQueue() {
    if (!queueDir) {
        files = [];
        elements.statPending.textContent = '0';
        elements.statCompleted.textContent = '0';
        currentFileIndex = -1;
        elements.fileList.innerHTML = '<p class="empty-state">Select a directory to start annotating.</p>';
        return;
    }

    try {
        const response = await fetch(buildApiUrl('/api/queue'));
        const data = await response.json();

        // Sort files to match display order: by group, then by status, then alphabetically
        const statusOrder = { pending: 0, skipped: 1, completed: 2 };
        files = data.files.sort((a, b) => {
            // First sort by group: root first, then alphabetically
            const groupA = a.group || 'root';
            const groupB = b.group || 'root';
            if (groupA === 'root' && groupB !== 'root') return -1;
            if (groupA !== 'root' && groupB === 'root') return 1;
            if (groupA !== groupB) return groupA.localeCompare(groupB);

            // Within group: sort by status
            const statusDiff = statusOrder[a.status] - statusOrder[b.status];
            if (statusDiff !== 0) return statusDiff;

            // Within status: sort alphabetically
            return a.name.localeCompare(b.name);
        });

        updateQueueStatsFromFiles();
        if (currentFile?.path && currentFileQueueDir === queueDir) {
            currentFileIndex = findFileIndexByPath(currentFile.path);
        }
        renderFileList();

        // Clean up selected files that no longer exist
        const filePaths = new Set(files.map(f => f.path));
        selectedFiles.forEach(path => {
            if (!filePaths.has(path)) {
                selectedFiles.delete(path);
            }
        });
        updateBatchButtonsState();
    } catch (error) {
        showToast('Failed to load queue', 'error');
        console.error(error);
    }
}

async function fetchTests(path) {
    try {
        const response = await fetch(buildApiUrl(`/api/tests/${encodeURIComponent(path)}`));
        const payload = await response.json();
        return normalizeCurrentTestsPayload(payload);
    } catch (error) {
        console.error(error);
        return normalizeCurrentTestsPayload({ test_rules: [], expected_markdown: null });
    }
}

async function warnOnExtractFieldIdDrift(tests) {
    // If any extract_field rule's stored `id` differs from what the shared
    // hash would produce, surface a toast so the user knows the on-disk file
    // has drifted from the converter-canonical format. We do not auto-fix;
    // the next save will rehash in persistTestsSnapshot.
    if (!window.AnnotatorExtractFieldHash) return;
    if (!tests || !Array.isArray(tests.test_rules)) return;
    const extractRules = tests.test_rules.filter((r) => r && r.type === 'extract_field');
    if (extractRules.length === 0) return;

    try {
        const snapshot = extractRules.map((r) => ({ ...r }));
        await window.AnnotatorExtractFieldHash.assignExtractFieldIds(snapshot);
        let drift = 0;
        for (let i = 0; i < extractRules.length; i += 1) {
            if (extractRules[i].id !== snapshot[i].id) drift += 1;
        }
        if (drift > 0) {
            const plural = drift === 1 ? 'rule has' : 'rules have';
            showToast(`${drift} extract_field ${plural} stale ids — save to refresh.`, 'warning');
        }
    } catch (err) {
        console.warn('extract_field id drift check failed', err);
    }
}

function cloneAnnotatorValue(value) {
    if (saveCoordinatorHelpers?.cloneValue) {
        return saveCoordinatorHelpers.cloneValue(value);
    }
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function snapshotCurrentTestsForSave() {
    return {
        filePath: currentFile?.path || null,
        tests: cloneAnnotatorValue(currentTests),
    };
}

function updateFileEntryState(filePath, testsPayload, savedStatus = null) {
    if (!filePath || !testsPayload) return;

    const file = files.find(entry => entry.path === filePath);
    if (!file) return;

    const testRules = Array.isArray(testsPayload.test_rules) ? testsPayload.test_rules : [];
    file.has_tests = testRules.length > 0;
    file.test_count = getAnnotationCountForPayload(testsPayload);
    file.status = savedStatus || deriveFileStatusFromTests(file.status, testsPayload);
    updateQueueStatsFromFiles();
    renderFileList();
}

async function persistTestsSnapshot(saveRequest, seq, reason) {
    if (!saveRequest?.filePath) {
        return {
            ok: true,
            filePath: null,
            testData: saveRequest?.tests || currentTests,
            seq,
            reason,
        };
    }

    // v0.5 extract_field: if the test carries extract_field rules, regenerate
    // `expected_output` from them so the nested view stays in sync with edits,
    // and rehash each rule so the on-disk `id` stays byte-equivalent with the
    // Python converter's output.
    try {
        const tests = saveRequest.tests;
        if (tests && Array.isArray(tests.test_rules)) {
            const extractFieldRules = tests.test_rules.filter((r) => r && r.type === 'extract_field');
            if (extractFieldRules.length > 0) {
                if (window.AnnotatorExtractFieldHash) {
                    await window.AnnotatorExtractFieldHash.assignExtractFieldIds(extractFieldRules);
                }
                tests.expected_output = inflateExpectedOutput(extractFieldRules);
            }
        }
    } catch (err) {
        console.warn('Failed to rehash/inflate extract_field rules', err);
    }

    try {
        const response = await fetch(buildApiUrl(`/api/tests/${encodeURIComponent(saveRequest.filePath)}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saveRequest.tests),
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || 'Failed to save tests');
        }

        const savedTests = data.test_data && typeof data.test_data === 'object'
            ? normalizeCurrentTestsPayload(data.test_data)
            : normalizeCurrentTestsPayload(saveRequest.tests);
        const savedFile = files.find(entry => entry.path === saveRequest.filePath) || null;
        const savedStatus = typeof data.file_status === 'string'
            ? data.file_status
            : deriveFileStatusFromTests(savedFile?.status, savedTests);

        currentTests = savedTests;
        updateDocumentTagsMeta();
        renderCurrentFileMetadata();

        // Update local state
        const annotationCount = getAnnotationCountForPayload(currentTests);
        currentFile.has_tests = annotationCount > 0;
        currentFile.test_count = annotationCount;
        currentFile.status = savedStatus;
        updateQueueStatsFromFiles();
        renderFileList();

        return {
            ok: true,
            filePath: saveRequest.filePath,
            testData: savedTests,
            fileStatus: savedStatus,
            seq,
            reason,
        };
    } catch (error) {
        showToast('Failed to save tests', 'error');
        console.error(error);
        return {
            ok: false,
            filePath: saveRequest?.filePath || null,
            error,
            seq,
            reason,
        };
    }
}

function applyLatestSavedTests(result) {
    if (!result?.ok) return;

    updateFileEntryState(result.filePath, result.testData, result.fileStatus);

    if (currentFile?.path === result.filePath && result.testData && typeof result.testData === 'object') {
        currentTests = normalizeCurrentTestsPayload(result.testData);
        updateDocumentTagsMeta();
        renderCurrentFileMetadata();
    }
}

const testsSaveCoordinator = saveCoordinatorHelpers?.createSaveCoordinator
    ? saveCoordinatorHelpers.createSaveCoordinator({
        snapshotState: snapshotCurrentTestsForSave,
        persistSnapshot: persistTestsSnapshot,
        applyLatestResult: applyLatestSavedTests,
    })
    : null;

async function saveTests(reason = 'manual-save') {
    if (!currentFile) return currentTests;

    if (!testsSaveCoordinator) {
        const result = await persistTestsSnapshot(snapshotCurrentTestsForSave(), 0, reason);
        if (result?.ok) {
            applyLatestSavedTests(result);
            return result.testData;
        }
        return null;
    }

    const saveOutcome = await testsSaveCoordinator.enqueueSave(reason);
    return saveOutcome?.result?.ok ? saveOutcome.result.testData : null;
}

async function updateFileStatus(path, status) {
    try {
        const response = await fetch(buildApiUrl(`/api/status/${encodeURIComponent(path)}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
        });
        const data = await response.json();
        // Update local state
        const file = files.find(f => f.path === path);
        const effectiveStatus = data.file_status || (currentFile?.path === path
            ? deriveFileStatusFromTests(status, currentTests)
            : status);
        if (file) file.status = effectiveStatus;
        updateQueueStatsFromFiles();
        renderFileList();
        fetchQueue(); // Refresh stats
    } catch (error) {
        showToast('Failed to update status', 'error');
        console.error(error);
    }
}

async function deleteCurrentFile() {
    if (!currentFile) return;

    const fileName = currentFile.name;
    const confirmed = confirm(`Are you sure you want to permanently delete "${fileName}"?\n\nThis will also delete any associated test file.`);

    if (!confirmed) return;

    try {
        const response = await fetch(buildApiUrl(`/api/delete/${encodeURIComponent(currentFile.path)}`), {
            method: 'DELETE',
        });

        const data = await response.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        showToast(`Deleted: ${fileName}`, 'success');

        // Navigate to next file or previous if at end
        const nextIndex = currentFileIndex < files.length - 1 ? currentFileIndex : currentFileIndex - 1;

        // Refresh queue
        await fetchQueue();

        // Select appropriate file
        if (files.length > 0 && nextIndex >= 0) {
            selectFile(Math.min(nextIndex, files.length - 1));
        } else {
            // No files left
            currentFile = null;
            currentFileIndex = -1;
            currentFileQueueDir = null;
            updateSelectedFileUrl(null);
            elements.pdfPlaceholder.style.display = 'flex';
            elements.pdfWrapper.style.display = 'none';
            updateMarkdownPreviewButton();
            updateLayoutOverlayButton();
        }
    } catch (error) {
        showToast('Failed to delete file', 'error');
        console.error(error);
    }
}

async function renameCurrentFile() {
    if (!currentFile) return;

    const oldName = currentFile.name;
    const baseName = oldName.replace(/\.[^/.]+$/, ''); // Remove extension

    const newName = prompt('Enter new filename:', baseName);

    if (!newName || newName === baseName) return;

    try {
        const response = await fetch(buildApiUrl(`/api/rename/${encodeURIComponent(currentFile.path)}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_name: newName }),
        });

        const data = await response.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        showToast(`Renamed to: ${data.new_path.split('/').pop()}`, 'success');

        // Refresh queue and select the renamed file
        await fetchQueue();

        await selectFileByPath(data.new_path);
    } catch (error) {
        showToast('Failed to rename file', 'error');
        console.error(error);
    }
}

function updateExportPaths() {
    const basePath = outputDir || '<output directory not set>';
    const datasetName = elements.datasetName.value.trim() || 'annotated_dataset';

    elements.exportBasePath.textContent = basePath;
    elements.exportFullPath.textContent = outputDir
        ? `${outputDir}/${datasetName}/`
        : `<output directory>/${datasetName}/`;
}

async function exportDataset() {
    const name = elements.datasetName.value.trim() || 'annotated_dataset';
    const includeSkipped = elements.includeSkipped.checked;

    try {
        const response = await fetch(buildApiUrl('/api/export'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, include_skipped: includeSkipped }),
        });
        const data = await response.json();

        if (data.status === 'success') {
            showToast(`Exported ${data.exported} files to ${data.output_dir}`, 'success');
            elements.exportModal.classList.remove('active');
        } else {
            showToast(data.error || 'Export failed', 'error');
        }
    } catch (error) {
        showToast('Export failed', 'error');
        console.error(error);
    }
}

// === File List Rendering ===
function renderFileList() {
    updateQueueToolsUi();
    if (files.length === 0) {
        elements.fileList.innerHTML = '<p class="empty-state">No files found.</p>';
        return;
    }

    const searchActive = isFileSearchActive();
    const filesToRender = searchActive
        ? getSearchMatchedFiles()
        : files.map((file, index) => ({ ...file, arrayIndex: index }));

    if (filesToRender.length === 0) {
        elements.fileList.innerHTML = `<p class="empty-state">No files match "${escapeHtml(fileSearchQuery.trim())}".</p>`;
        return;
    }

    // Group files by their group (files array is already sorted)
    const grouped = {};
    filesToRender.forEach((file) => {
        const group = file.group || 'root';
        if (!grouped[group]) grouped[group] = [];
        grouped[group].push(file);
    });

    // Sort groups: 'root' first, then alphabetically
    const sortedGroups = Object.keys(grouped).sort((a, b) => {
        if (a === 'root') return -1;
        if (b === 'root') return 1;
        return a.localeCompare(b);
    });

    // Render with collapsible section headers
    let html = '';
    for (const group of sortedGroups) {
        // Files are already sorted in the array, just use them as-is
        const groupFiles = grouped[group];

        const displayName = group === 'root' ? 'Root Directory' : group;
        const completedCount = groupFiles.filter(f => f.status === 'completed').length;
        const isCollapsed = !searchActive && collapsedGroups.has(group);
        const groupArg = inlineJsStringLiteral(group);

        html += `
            <div class="file-group-header ${isCollapsed ? 'collapsed' : ''}" data-group="${escapeHtml(group)}" onclick="toggleGroup(${groupArg})">
                <span class="group-toggle">${isCollapsed ? '▶' : '▼'}</span>
                <span class="group-name">${escapeHtml(displayName)}</span>
                <span class="group-stats">${completedCount}/${groupFiles.length}</span>
            </div>
        `;

        if (!isCollapsed) {
            html += groupFiles.map(file => {
                const isSelected = file.arrayIndex === currentFileIndex;
                const isChecked = selectedFiles.has(file.path);
                const isProcessing = batchProcessingFiles.has(file.path);
                const showCheckbox = file.has_parse_md;
                const fileIndex = file.arrayIndex;

                return `
                <div class="file-item ${isSelected ? 'selected' : ''} ${isChecked ? 'batch-selected' : ''}"
                     data-index="${fileIndex}">
                    <div class="file-item-row">
                        ${showCheckbox ? `
                            <label class="file-checkbox-wrapper ${isProcessing ? 'processing' : ''}" onclick="event.stopPropagation()">
                                ${isProcessing ? `
                                    <span class="file-processing-spinner"></span>
                                ` : `
                                    <input type="checkbox" class="file-checkbox"
                                           data-file-index="${fileIndex}"
                                           ${isChecked ? 'checked' : ''}
                                           onchange="toggleFileSelectionByIndex(${fileIndex}, this.checked)">
                                `}
                            </label>
                        ` : ''}
                        <div class="file-item-content" onclick="selectFile(${fileIndex})">
                            <div class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</div>
                            <div class="file-meta">
                                <span class="status-badge ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>
                                ${file.test_count > 0 ? `<span class="test-badge">${file.test_count} tests</span>` : ''}
                            </div>
                        </div>
                    </div>
                </div>
            `}).join('');
        }
    }

    elements.fileList.innerHTML = html;
}

function toggleGroup(group) {
    if (collapsedGroups.has(group)) {
        collapsedGroups.delete(group);
    } else {
        collapsedGroups.add(group);
    }
    renderFileList();
}

// === Multi-File Selection ===
function toggleFileSelectionByIndex(fileIndex, checked) {
    const file = files[fileIndex];
    if (!file) return;
    toggleFileSelection(file.path, checked);
}

function toggleFileSelection(filePath, checked) {
    if (checked) {
        selectedFiles.add(filePath);
    } else {
        selectedFiles.delete(filePath);
    }
    updateBatchButtonsState();
    renderFileList();
}

function selectAllFilesWithParseMd() {
    files.forEach(file => {
        if (file.has_parse_md) {
            selectedFiles.add(file.path);
        }
    });
    updateBatchButtonsState();
    renderFileList();
}

function deselectAllFiles() {
    selectedFiles.clear();
    updateBatchButtonsState();
    renderFileList();
}

function getSelectedFilesCount() {
    return selectedFiles.size;
}

function updateBatchButtonsState() {
    const count = getSelectedFilesCount();
    const batchLabel = count > 0 ? ` (${count})` : '';

    // Update generate tests button to show count if multiple selected
    const generateBtn = elements.aiGenerateTestsBtn;
    if (generateBtn) {
        const baseText = 'Generate Tests';
        // Only show count if we have multiple files (not just current)
        if (count > 1 || (count === 1 && !currentFile?.has_parse_md)) {
            generateBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11l3 3L22 4"/>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </svg>
                ${baseText}${batchLabel}`;
        } else {
            generateBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11l3 3L22 4"/>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </svg>
                ${baseText}`;
        }
    }

    // Update review tests button to show count if multiple selected
    const reviewBtn = elements.aiReviewTestsBtn;
    if (reviewBtn) {
        const baseText = 'Review Tests';
        if (count > 1 || (count === 1 && !currentFile?.has_parse_md)) {
            reviewBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="M21 21l-4.35-4.35"/>
                </svg>
                ${baseText}${batchLabel}`;
        } else {
            reviewBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="M21 21l-4.35-4.35"/>
                </svg>
                ${baseText}`;
        }
    }

    // Update batch selection controls visibility and count
    const hasSelectableFiles = files.some(f => f.has_parse_md);
    if (elements.batchSelectControls) {
        if (hasSelectableFiles) {
            elements.batchSelectControls.classList.add('visible');
        } else {
            elements.batchSelectControls.classList.remove('visible');
        }
    }
    if (elements.batchSelectCount) {
        elements.batchSelectCount.textContent = count > 0 ? `${count} selected` : '';
    }
}

function selectUntestedFiles() {
    // Select all files that have parse.md but no tests
    files.forEach(file => {
        if (file.has_parse_md && file.test_count === 0) {
            selectedFiles.add(file.path);
        }
    });
    updateBatchButtonsState();
    renderFileList();
}

// === Batch Processing ===
async function runBatchOperation(operation) {
    // Determine which files to process
    let filesToProcess = [];

    if (selectedFiles.size > 0) {
        // Use selected files
        filesToProcess = files.filter(f => selectedFiles.has(f.path) && f.has_parse_md);
    } else if (currentFile?.has_parse_md) {
        // Fall back to current file only
        filesToProcess = [currentFile];
    }

    if (filesToProcess.length === 0) {
        showToast('No files with parse.md to process', 'error');
        return;
    }

    // If only one file, use the regular operation
    if (filesToProcess.length === 1 && filesToProcess[0].path === currentFile?.path) {
        if (operation === 'generate') {
            await generateWithAi('generate_tests');
        } else {
            await reviewTestsWithAi();
        }
        return;
    }

    // Multi-file batch processing
    const PARALLEL_LIMIT = 20;
    const results = { success: 0, failed: 0 };

    // Get settings from UI
    const customPrompt = elements.aiCustomPrompt?.value?.trim() || null;
    const testCount = parseInt(elements.aiTestCountSlider?.value || '4', 10);
    const testTypes = getSelectedTestTypes();

    // Disable buttons during batch operation
    const generateBtn = elements.aiGenerateTestsBtn;
    const reviewBtn = elements.aiReviewTestsBtn;
    const extractBtn = elements.aiExtractTextBtn;

    if (generateBtn) generateBtn.disabled = true;
    if (reviewBtn) reviewBtn.disabled = true;
    if (extractBtn) extractBtn.disabled = true;

    // Mark all files as processing
    filesToProcess.forEach(f => batchProcessingFiles.add(f.path));
    renderFileList();

    showToast(`${operation === 'generate' ? 'Generating' : 'Reviewing'} tests for ${filesToProcess.length} files...`, 'info');

    // Process in batches with parallel limit
    const processFile = async (file) => {
        const fileStartTime = Date.now();
        console.log(`[${file.path}] Starting at ${new Date().toISOString()}`);
        try {
            // Load the file's image
            const imageBase64 = await getFileImageAsBase64(file.path);
            if (!imageBase64) {
                throw new Error('Failed to load image');
            }

            // Load parse.md content for the file
            const parseMdResponse = await fetch(
                buildApiUrl(`/api/parse-md/${encodeURIComponent(file.path)}`, { content: true })
            );
            const parseMdData = await parseMdResponse.json();
            const parseContent = parseMdData.exists ? parseMdData.content : null;

            if (operation === 'generate') {
                // Generate tests
                const requestBody = {
                    image: imageBase64,
                    mode: 'generate_tests',
                    additional_instructions: customPrompt,
                    test_count: testCount,
                    test_types: testTypes,
                };
                if (parseContent) {
                    requestBody.parse_content = parseContent;
                }

                const response = await fetch('/api/vlm/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                });

                const data = await response.json();

                if (data.error) {
                    throw new Error(data.error);
                }

                // Save tests to the file
                if (data.tests && Array.isArray(data.tests) && data.tests.length > 0) {
                    // Load existing tests
                    const existingTests = await fetchTests(file.path);
                    const acceptedTypes = getAcceptedAiGeneratedTypeSet();
                    const testsToAdd = data.tests.filter(test =>
                        test.type
                        && acceptedTypes.has(test.type)
                    );

                    for (const test of testsToAdd) {
                        test.verified = false;
                        existingTests.test_rules.push(test);
                    }

                    // Save back
                    const saveResponse = await fetch(buildApiUrl(`/api/tests/${encodeURIComponent(file.path)}`), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(existingTests),
                    });
                    const saveData = await saveResponse.json();
                    if (!saveResponse.ok || saveData.error) {
                        throw new Error(saveData.error || 'Failed to save generated tests');
                    }
                    const savedTests = saveData.test_data && typeof saveData.test_data === 'object'
                        ? saveData.test_data
                        : existingTests;

                    // Update local state if this is the current file
                    if (file.path === currentFile?.path) {
                        currentTests = savedTests;
                        renderTestList();
                    }

                    // Update file info
                    const fileObj = files.find(f => f.path === file.path);
                    if (fileObj) {
                        const annotationCount = getAnnotationCountForPayload(savedTests);
                        fileObj.has_tests = annotationCount > 0;
                        fileObj.test_count = annotationCount;
                    }

                    results.success++;
                } else {
                    throw new Error('No tests generated');
                }
            } else {
                // Review tests
                const existingTests = await fetchTests(file.path);
                if (existingTests.test_rules.length === 0) {
                    throw new Error('No tests to review');
                }

                const testsToReview = existingTests.test_rules.map((test, index) => ({
                    index,
                    ...test
                }));

                const response = await fetch('/api/vlm/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: imageBase64,
                        mode: 'review_tests',
                        tests_to_review: testsToReview,
                        additional_instructions: customPrompt,
                    }),
                });

                const data = await response.json();

                if (data.error) {
                    throw new Error(data.error);
                }

                // Store review results in cache for this file
                if (data.review_results) {
                    const fileResults = {};
                    for (const result of data.review_results) {
                        fileResults[result.index] = result;
                    }
                    testReviewResultsCache.set(file.path, fileResults);

                    // If this is the current file, update display immediately
                    if (file.path === currentFile?.path) {
                        testReviewResults = fileResults;
                        renderTestList();
                    }
                }

                results.success++;
            }
        } catch (error) {
            console.error(`Failed to process ${file.path}:`, error);
            results.failed++;
        } finally {
            const elapsed = ((Date.now() - fileStartTime) / 1000).toFixed(1);
            console.log(`[${file.path}] Completed in ${elapsed}s`);
            // Remove from processing set
            batchProcessingFiles.delete(file.path);
            renderFileList();
        }
    };

    // Process with parallel limit
    const chunks = [];
    for (let i = 0; i < filesToProcess.length; i += PARALLEL_LIMIT) {
        chunks.push(filesToProcess.slice(i, i + PARALLEL_LIMIT));
    }

    console.log(`Processing ${filesToProcess.length} files in ${chunks.length} chunks of up to ${PARALLEL_LIMIT}`);

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        console.log(`Starting chunk ${chunkIdx + 1}/${chunks.length} with ${chunk.length} files at ${new Date().toISOString()}`);
        const startTime = Date.now();
        await Promise.all(chunk.map(processFile));
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Completed chunk ${chunkIdx + 1}/${chunks.length} in ${elapsed}s`);
    }

    // Re-enable buttons
    if (generateBtn) generateBtn.disabled = false;
    if (reviewBtn) reviewBtn.disabled = false;
    if (extractBtn) extractBtn.disabled = false;

    // Refresh file list to update test counts
    await fetchQueue();

    // Show results
    const operationName = operation === 'generate' ? 'Generated' : 'Reviewed';
    if (results.failed > 0) {
        showToast(`${operationName} tests: ${results.success} succeeded, ${results.failed} failed`, results.success > 0 ? 'info' : 'error');
    } else {
        showToast(`${operationName} tests for ${results.success} files`, 'success');
    }
}

async function getFileImageAsBase64(filePath) {
    // Load the file as an image and convert to base64
    try {
        const ext = filePath.split('.').pop().toLowerCase();
        const fileUrl = buildApiUrl(`/api/file/${encodeURIComponent(filePath)}`);

        if (ext === 'pdf') {
            // Load PDF and render first page
            const loadingTask = pdfjsLib.getDocument(fileUrl);
            const pdf = await loadingTask.promise;
            const page = await pdf.getPage(1);

            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({ canvasContext: context, viewport }).promise;

            // Convert to base64
            const dataUrl = canvas.toDataURL('image/png');
            return dataUrl.split(',')[1]; // Remove data:image/png;base64, prefix
        } else {
            // Load image directly
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const dataUrl = canvas.toDataURL('image/png');
                    resolve(dataUrl.split(',')[1]);
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = fileUrl;
            });
        }
    } catch (error) {
        console.error('Failed to get image as base64:', error);
        return null;
    }
}

// === File Selection ===
async function selectFile(index) {
    if (index < 0 || index >= files.length) return;
    if (!closeContentEditorWorkspaces()) return;
    clearMarkdownBulkSelection({ rerender: false });

    // Save current tests and review results before switching
    if (currentFile) {
        if (annotationMode === ANNOTATION_MODE_EXTRACT) {
            const saved = await saveExtractEditor(false, {
                allowValidationFailure: true,
                validationToastType: 'warning',
                validationMessagePrefix: 'Current extract edits were not saved: ',
                reason: 'file-switch',
            });
            if (!saved) return;
        } else {
            currentTests.expected_markdown = elements.expectedMarkdown.value || null;
            const saved = await saveTests('file-switch');
            if (!saved) return;
        }
        // Save current review results to cache
        if (Object.keys(testReviewResults).length > 0) {
            testReviewResultsCache.set(currentFile.path, { ...testReviewResults });
        }
    }

    currentFileIndex = index;
    currentFile = files[index];
    currentFileQueueDir = queueDir;
    updateSelectedFileUrl(currentFile.path);

    // Reset layout selection
    selectedLayoutTestIndex = null;

    // Reset markdown editing state
    markdownEditingIndex = null;
    markdownTagEditingIndex = null;
    markdownMoveState = null;

    // Update UI
    renderCurrentFileMetadata();

    // Update navigation buttons
    elements.prevFile.disabled = index === 0;
    elements.nextFile.disabled = index === files.length - 1;
    elements.skipFile.disabled = false;
    elements.completeFile.disabled = false;
    elements.renameFile.disabled = false;
    elements.deleteFile.disabled = false;

    // Load tests. Clear every piece of per-file extract state so in-flight
    // operations from the previous file (a paused drag, a pending draw, an
    // undoable reassignment) can't reach into the new file and corrupt it.
    expandedExtractPaths.clear();
    collapsedExtractPaths.clear();
    selectedExtractFieldPath = null;
    selectedExtractBboxIndex = null;
    extractBboxEditMode = null;
    extractBboxEditStart = null;
    extractBboxSuppressNextClick = false;
    extractDrawContext = null;
    lastExtractReassignment = null;
    currentTests = await fetchTests(currentFile.path);
    currentTests = normalizeCurrentTestsPayload(currentTests);
    await warnOnExtractFieldIdDrift(currentTests);
    renderDocumentTagEditor();
    renderCurrentFileMetadata();
    annotationMode = inferAnnotationModeFromPayload(currentTests);
    // Load review results from cache (or empty if none cached)
    testReviewResults = testReviewResultsCache.get(currentFile.path) || {};
    elements.expectedMarkdown.value = annotationMode === ANNOTATION_MODE_PARSE
        ? (currentTests.expected_markdown || '')
        : '';
    applyAnnotationModeUi();

    // Check for parse.md
    await checkParseMd(currentFile.path);

    // Load PDF/image
    loadFile(currentFile.path);

    // Update file list selection
    renderFileList();

    // Update batch buttons to reflect current file's parse.md availability
    updateBatchButtonsState();
    updateLayoutOverlayButton();
}

// === PDF/Image Loading ===
async function loadFile(path) {
    const ext = path.split('.').pop().toLowerCase();

    elements.pdfPlaceholder.style.display = 'none';
    elements.pdfWrapper.style.display = 'inline-block';
    elements.textLayer.innerHTML = '';

    if (ext === 'pdf') {
        await loadPDF(buildApiUrl(`/api/file/${encodeURIComponent(path)}`));
    } else {
        // Image file
        loadImage(buildApiUrl(`/api/file/${encodeURIComponent(path)}`));
    }
}

async function loadPDF(url) {
    try {
        currentImage = null; // Clear any loaded image
        pdfDoc = await pdfjsLib.getDocument(url).promise;
        elements.pageCount.textContent = pdfDoc.numPages;
        pageNum = 1;

        // Check for multi-page PDF
        isMultiPagePdf = pdfDoc.numPages > 1;

        // Only enable extract for multi-page PDFs (single page = nothing to extract)
        elements.extractPage.disabled = !isMultiPagePdf || !capabilities.extract_page;

        updateAnnotationState();

        // Fit to container on initial load
        await fitPdfToContainer();
    } catch (error) {
        showToast('Failed to load PDF', 'error');
        console.error(error);
    }
}

async function fitPdfToContainer() {
    if (!pdfDoc) return;

    const container = elements.pdfContainer;
    const containerWidth = Math.max(container.clientWidth, 1);
    const containerHeight = Math.max(container.clientHeight, 1);

    // Get the current page to calculate its dimensions
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });

    const scaleX = containerWidth / viewport.width;
    const scaleY = containerHeight / viewport.height;
    scale = Math.min(scaleX, scaleY);

    renderPage(pageNum);
}

function updateAnnotationState() {
    const testPanel = document.querySelector('.test-panel');
    const multiPageWarning = document.getElementById('multi-page-warning');
    if (multiPageWarning) {
        multiPageWarning.remove();
    }
    if (testPanel) {
        testPanel.classList.remove('disabled');
    }
    applyAnnotationModeUi();
}

async function renderPage(num) {
    if (!pdfDoc) return;

    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale });

    const canvas = elements.pdfCanvas;
    const ctx = canvas.getContext('2d');

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = viewport.width * pixelRatio;
    canvas.height = viewport.height * pixelRatio;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    await page.render({
        canvasContext: ctx,
        viewport: viewport,
    }).promise;

    // Render text layer for text selection
    const textContent = await page.getTextContent();
    renderTextLayer(textContent, viewport);

    elements.pageNum.textContent = num;
    elements.zoomLevel.textContent = `${Math.round(scale * 100)}%`;

    renderLayoutOverlay();
    // Side panel scopes layout rules to the current page, so a page
    // change has to refresh the panel along with the overlay.
    // renderTestList() is a no-op in extract mode.
    renderTestList();
    if (annotationMode === ANNOTATION_MODE_EXTRACT && extractPageFilterEnabled) {
        renderExtractEditor();
    } else {
        updateExtractFieldFilterControls();
    }
    updateLayoutOverlayButton();
    updateMarkdownPreviewButton();
    if (markdownPanelOpen) {
        renderMarkdownPanel();
    }
}

function renderTextLayer(textContent, viewport) {
    // Clear previous text layer
    elements.textLayer.innerHTML = '';
    elements.textLayer.style.width = `${viewport.width}px`;
    elements.textLayer.style.height = `${viewport.height}px`;
    const fragment = document.createDocumentFragment();

    // Render each text item with proper transforms
    for (const item of textContent.items) {
        if (!item.str || item.str.trim() === '') continue;

        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);

        // Calculate font size from transform matrix
        const fontHeight = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
        // Calculate text width scaling
        const fontWidth = Math.sqrt((tx[0] * tx[0]) + (tx[1] * tx[1]));
        // Calculate rotation angle
        const angle = Math.atan2(tx[1], tx[0]);

        const span = document.createElement('span');
        span.textContent = item.str;
        span.style.fontSize = `${fontHeight}px`;
        span.style.fontFamily = 'sans-serif';
        span.style.left = `${tx[4]}px`;
        span.style.top = `${tx[5] - fontHeight}px`;

        // Apply horizontal scaling if text is stretched
        if (item.width && fontHeight > 0) {
            const measuredWidth = item.str.length * fontHeight * 0.5; // rough estimate
            const targetWidth = item.width * viewport.scale;
            if (measuredWidth > 0) {
                const scaleX = targetWidth / measuredWidth;
                if (scaleX > 0.5 && scaleX < 2) {
                    span.style.transform = `scaleX(${scaleX})`;
                    span.style.transformOrigin = 'left top';
                }
            }
        }

        // Apply rotation if needed
        if (Math.abs(angle) > 0.01) {
            span.style.transform = `rotate(${angle}rad)`;
            span.style.transformOrigin = 'left bottom';
        }

        fragment.appendChild(span);
    }
    elements.textLayer.appendChild(fragment);
}

let currentImage = null;
let imageScale = 1;

function loadImage(url) {
    pdfDoc = null;
    isMultiPagePdf = false; // Images are always single-page
    elements.extractPage.disabled = true; // Disable extract for images
    updateAnnotationState();
    const canvas = elements.pdfCanvas;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.onload = () => {
        currentImage = img;

        // Calculate scale to fit container
        const container = elements.pdfContainer;
        const containerWidth = Math.max(container.clientWidth, 1);
        const containerHeight = Math.max(container.clientHeight, 1);

        // Calculate scale to fit while maintaining aspect ratio
        const scaleX = containerWidth / img.width;
        const scaleY = containerHeight / img.height;
        imageScale = Math.min(scaleX, scaleY, 1); // Don't scale up, only down

        renderImage();
    };
    img.onerror = () => {
        showToast('Failed to load image', 'error');
    };
    img.src = url;

    elements.pageNum.textContent = '1';
    elements.pageCount.textContent = '1';
}

function renderImage() {
    if (!currentImage) return;

    const canvas = elements.pdfCanvas;
    const ctx = canvas.getContext('2d');

    const displayWidth = Math.round(currentImage.width * imageScale);
    const displayHeight = Math.round(currentImage.height * imageScale);

    // Set canvas size for high DPI
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = displayWidth * pixelRatio;
    canvas.height = displayHeight * pixelRatio;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.drawImage(currentImage, 0, 0, displayWidth, displayHeight);

    elements.zoomLevel.textContent = `${Math.round(imageScale * 100)}%`;

    renderLayoutOverlay();
    updateLayoutOverlayButton();
    updateMarkdownPreviewButton();
    if (markdownPanelOpen) {
        renderMarkdownPanel();
    }
}

async function fitToContainer() {
    if (pdfDoc) {
        await fitPdfToContainer();
    } else if (currentImage) {
        const container = elements.pdfContainer;
        const containerWidth = Math.max(container.clientWidth, 1);
        const containerHeight = Math.max(container.clientHeight, 1);

        const scaleX = containerWidth / currentImage.width;
        const scaleY = containerHeight / currentImage.height;
        imageScale = Math.min(scaleX, scaleY);

        renderImage();
    }
}

function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function normalizeWheelDelta(delta, deltaMode, pageDeltaPx) {
    if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
        return delta * WHEEL_LINE_DELTA_PX;
    }
    if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        return delta * pageDeltaPx;
    }
    return delta;
}

function getViewerPointerAnchor(clientX, clientY) {
    const container = elements.pdfContainer;
    const wrapper = elements.pdfWrapper;
    const canvas = elements.pdfCanvas;
    if (!container || !wrapper || !canvas) return null;

    const containerRect = container.getBoundingClientRect();
    const renderedWidth = parseFloat(canvas.style.width) || canvas.clientWidth || 1;
    const renderedHeight = parseFloat(canvas.style.height) || canvas.clientHeight || 1;
    const pointerX = clientX - containerRect.left;
    const pointerY = clientY - containerRect.top;
    const contentX = container.scrollLeft + pointerX - wrapper.offsetLeft;
    const contentY = container.scrollTop + pointerY - wrapper.offsetTop;

    return {
        pointerX,
        pointerY,
        ratioX: clampNumber(contentX / renderedWidth, 0, 1),
        ratioY: clampNumber(contentY / renderedHeight, 0, 1),
    };
}

function restoreViewerPointerAnchor(anchor) {
    if (!anchor) return;
    const container = elements.pdfContainer;
    const wrapper = elements.pdfWrapper;
    const canvas = elements.pdfCanvas;
    if (!container || !wrapper || !canvas) return;

    const renderedWidth = parseFloat(canvas.style.width) || canvas.clientWidth || 1;
    const renderedHeight = parseFloat(canvas.style.height) || canvas.clientHeight || 1;
    const maxScrollLeft = Math.max(container.scrollWidth - container.clientWidth, 0);
    const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
    const nextLeft = wrapper.offsetLeft + (anchor.ratioX * renderedWidth) - anchor.pointerX;
    const nextTop = wrapper.offsetTop + (anchor.ratioY * renderedHeight) - anchor.pointerY;

    container.scrollLeft = clampNumber(nextLeft, 0, maxScrollLeft);
    container.scrollTop = clampNumber(nextTop, 0, maxScrollTop);
}

async function applyViewerZoomRequest(request) {
    const anchor = getViewerPointerAnchor(request.clientX, request.clientY);
    if (pdfDoc) {
        scale = request.scale;
        await renderPage(pageNum);
    } else if (currentImage) {
        imageScale = request.scale;
        renderImage();
    }
    restoreViewerPointerAnchor(anchor);
}

function processPendingViewerZoom() {
    viewerZoomFrame = null;
    if (viewerZoomRendering || !pendingViewerZoomRequest) return;

    const request = pendingViewerZoomRequest;
    pendingViewerZoomRequest = null;
    viewerZoomRendering = true;

    applyViewerZoomRequest(request)
        .catch((error) => {
            console.error('Failed to zoom viewer', error);
        })
        .finally(() => {
            viewerZoomRendering = false;
            if (pendingViewerZoomRequest && viewerZoomFrame === null) {
                viewerZoomFrame = window.requestAnimationFrame(processPendingViewerZoom);
            }
        });
}

function scheduleViewerZoom(scaleValue, clientX, clientY) {
    pendingViewerZoomRequest = { scale: scaleValue, clientX, clientY };
    if (viewerZoomFrame === null) {
        viewerZoomFrame = window.requestAnimationFrame(processPendingViewerZoom);
    }
}

function handlePdfContainerWheel(event) {
    const container = elements.pdfContainer;
    if (!container || (!pdfDoc && !currentImage)) return;

    const deltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, container.clientWidth);
    const deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, container.clientHeight);

    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const activeScale = pendingViewerZoomRequest?.scale ?? (pdfDoc ? scale : imageScale);
        const minScale = pdfDoc ? MIN_PDF_SCALE : MIN_IMAGE_SCALE;
        const nextScale = clampNumber(
            activeScale * Math.exp(-deltaY * VIEWER_WHEEL_ZOOM_SENSITIVITY),
            minScale,
            MAX_VIEWER_SCALE,
        );
        if (Math.abs(nextScale - activeScale) > 0.001) {
            scheduleViewerZoom(nextScale, event.clientX, event.clientY);
        }
        return;
    }

    event.preventDefault();
    const horizontalDelta = event.shiftKey && Math.abs(deltaY) > Math.abs(deltaX)
        ? deltaY
        : deltaX;
    container.scrollLeft += horizontalDelta;
    if (!event.shiftKey) {
        container.scrollTop += deltaY;
    }
}

// === Extract Field Overlay (EXTRACT mode) ===
function _truncateForLabel(value, maxChars = 80) {
    if (value == null) return 'null';
    const s = String(value);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars - 1) + '…';
}

const _EXTRACT_HANDLE_SIZE = 10;
const _EXTRACT_HANDLE_COLOR = '#ffffff';

/**
 * Render the 8 resize handles (4 corners + 4 edges) on the actively-
 * selected extract bbox. Mirror of the layout-mode handle pattern at
 * annotator.js:5463 so layout and extract share cursor affordances.
 * `strokeColor` is the bbox's own stroke so handles colour-match the rule.
 */
/**
 * Render a "×" delete affordance just outside the NE corner of the selected
 * bbox. Clicking it removes the bbox entry (but keeps the rule so the user
 * can re-draw). Placed outside the rect so it doesn't overlap the ordinal
 * badge or the move cursor area.
 */
function _appendExtractBboxDeleteIcon(group, x, y, width, strokeColor, onClick) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const size = 18;
    const cx = x + width + size / 2 + 2;
    const cy = y + size / 2 - 2;
    const btn = document.createElementNS(svgNS, 'g');
    btn.classList.add('extract-bbox-delete');
    btn.style.cursor = 'pointer';
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', size / 2);
    circle.setAttribute('fill', '#ef4444');
    circle.setAttribute('stroke', strokeColor);
    circle.setAttribute('stroke-width', '1.5');
    const txt = document.createElementNS(svgNS, 'text');
    txt.setAttribute('x', cx);
    txt.setAttribute('y', cy + 4);
    txt.setAttribute('fill', '#fff');
    txt.setAttribute('font-size', '13');
    txt.setAttribute('font-weight', '700');
    txt.setAttribute('font-family', 'Inter, sans-serif');
    txt.setAttribute('text-anchor', 'middle');
    txt.textContent = '×';
    btn.appendChild(circle);
    btn.appendChild(txt);
    btn.addEventListener('mousedown', (e) => {
        // Prevent the parent bbox's mousedown drag from firing.
        e.preventDefault();
        e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof onClick === 'function') onClick();
    });
    group.appendChild(btn);
}

function _appendExtractBboxHandles(group, x, y, width, height, strokeColor) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const corners = [
        { id: 'nw', cx: x, cy: y, cursor: 'nwse-resize' },
        { id: 'ne', cx: x + width, cy: y, cursor: 'nesw-resize' },
        { id: 'sw', cx: x, cy: y + height, cursor: 'nesw-resize' },
        { id: 'se', cx: x + width, cy: y + height, cursor: 'nwse-resize' },
    ];
    const edges = [
        { id: 'n', cx: x + width / 2, cy: y, cursor: 'ns-resize' },
        { id: 'e', cx: x + width, cy: y + height / 2, cursor: 'ew-resize' },
        { id: 's', cx: x + width / 2, cy: y + height, cursor: 'ns-resize' },
        { id: 'w', cx: x, cy: y + height / 2, cursor: 'ew-resize' },
    ];
    for (const spec of [...corners, ...edges]) {
        const handle = document.createElementNS(svgNS, 'rect');
        handle.setAttribute('x', spec.cx - _EXTRACT_HANDLE_SIZE / 2);
        handle.setAttribute('y', spec.cy - _EXTRACT_HANDLE_SIZE / 2);
        handle.setAttribute('width', _EXTRACT_HANDLE_SIZE);
        handle.setAttribute('height', _EXTRACT_HANDLE_SIZE);
        handle.setAttribute('fill', _EXTRACT_HANDLE_COLOR);
        handle.setAttribute('stroke', strokeColor);
        handle.setAttribute('stroke-width', '2');
        handle.setAttribute('rx', '2');
        handle.classList.add('bbox-handle', 'extract-bbox-handle', `bbox-handle-${spec.id}`);
        handle.style.cursor = spec.cursor;
        handle.dataset.handleType = `resize-${spec.id}`;
        group.appendChild(handle);
    }
}

function _computeExtractBboxUnion(bboxEntries, targetPage) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const entry of bboxEntries || []) {
        if (entry?.page !== targetPage) continue;
        const bbox = entry.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4) continue;
        const [x, y, width, height] = bbox;
        if (![x, y, width, height].every(Number.isFinite)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
        count += 1;
    }
    if (count < 2) return null;
    return {
        x: minX,
        y: minY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY),
        count,
    };
}

function _getExtractRuleBboxesForPage(rule, targetPage) {
    if (!rule || !Array.isArray(rule.bboxes)) return [];
    const pageBboxes = [];
    for (let bboxIndexInRule = 0; bboxIndexInRule < rule.bboxes.length; bboxIndexInRule += 1) {
        const bboxEntry = rule.bboxes[bboxIndexInRule];
        if (!bboxEntry || typeof bboxEntry !== 'object') continue;
        if (bboxEntry.page !== targetPage) continue;
        const bbox = bboxEntry.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4) continue;
        pageBboxes.push({ bboxEntry, bboxIndexInRule });
    }
    return pageBboxes;
}

function _computePaddedScreenRect(normRect, canvasWidth, canvasHeight, padding) {
    if (!normRect || typeof normRect !== 'object') return null;
    if (![canvasWidth, canvasHeight, padding].every(Number.isFinite)) return null;
    const { x, y, width, height } = normRect;
    if (![x, y, width, height].every(Number.isFinite)) return null;

    const left = Math.max(0, x * canvasWidth - padding);
    const top = Math.max(0, y * canvasHeight - padding);
    const right = Math.min(canvasWidth, (x + width) * canvasWidth + padding);
    const bottom = Math.min(canvasHeight, (y + height) * canvasHeight + padding);
    const screenWidth = Math.max(0, right - left);
    const screenHeight = Math.max(0, bottom - top);
    if (screenWidth <= 0 || screenHeight <= 0) return null;

    return {
        x: left,
        y: top,
        width: screenWidth,
        height: screenHeight,
    };
}

function renderExtractFieldOverlay() {
    const pdfCanvas = elements.pdfCanvas;
    if (!pdfCanvas) return;

    // Iterate test_rules directly (not a filtered view) so `ruleIdx` is the
    // absolute index. The stray fallback path uses this index to stay in
    // sync with _collectUnassignedStrayEntries, which also indexes into
    // test_rules. Mismatched fallbacks break the tree↔overlay linkage
    // when a hand-edited rule lacks an `id`.
    const allRules = Array.isArray(currentTests?.test_rules) ? currentTests.test_rules : [];
    if (allRules.length === 0) return;
    const hasAnyExtractField = allRules.some((r) => r && r.type === 'extract_field');
    if (!hasAnyExtractField) return;

    const canvasWidth = parseFloat(pdfCanvas.style.width) || pdfCanvas.width;
    const canvasHeight = parseFloat(pdfCanvas.style.height) || pdfCanvas.height;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'layout-overlay';
    svg.classList.add('layout-overlay', 'extract-overlay');
    svg.setAttribute('width', canvasWidth);
    svg.setAttribute('height', canvasHeight);
    svg.style.width = `${canvasWidth}px`;
    svg.style.height = `${canvasHeight}px`;

    const hasSelection = Boolean(selectedExtractFieldPath);
    const overlayFragment = document.createDocumentFragment();

    for (let ruleIdx = 0; ruleIdx < allRules.length; ruleIdx += 1) {
        const rule = allRules[ruleIdx];
        if (!rule || rule.type !== 'extract_field') continue;
        if (!Array.isArray(rule.bboxes) || rule.bboxes.length === 0) continue;
        const pageBboxes = _getExtractRuleBboxesForPage(rule, pageNum);
        if (pageBboxes.length === 0) continue;
        const isStray = Array.isArray(rule.tags) && rule.tags.includes('stray_evidence');
        const isVerified = Boolean(rule.verified);
        const fieldPath = rule.field_path || '';
        // Strays share their field_path with a real rule; use the rule's
        // deterministic id to key the tree↔overlay linkage. Fallback uses
        // the absolute test_rules index — matches _collectUnassignedStrayEntries
        // so hand-edited rules missing an `id` still route clicks correctly.
        const overlayKey = isStray
            ? `__unassigned__/${rule.id || `idx-${ruleIdx}`}`
            : fieldPath;
        const isSelected = overlayKey && selectedExtractFieldPath === overlayKey;
        const isDimmed = hasSelection && !isSelected;
        // Colors: verified=green, unverified=amber; stray gets a dotted stroke
        const fillColor = isVerified ? '#10b981' : '#f59e0b';
        const strokeColor = isVerified ? '#065f46' : '#92400e';
        const strokeDasharray = isStray ? '2,2' : (isVerified ? '' : '6,3');

        const union = _computeExtractBboxUnion(pageBboxes.map(({ bboxEntry }) => bboxEntry), pageNum);
        if (union) {
            const activeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
            const lowZoomBoost = Math.max(0, 1 - Math.min(activeScale, 1));
            const padding = Math.round((isSelected ? 5 : 4) + lowZoomBoost * 2);
            const unionScreenRect = _computePaddedScreenRect(union, canvasWidth, canvasHeight, padding);
            const unionStrokeWidth = (isSelected ? 3.5 : 2.75) + lowZoomBoost * 0.75;

            if (unionScreenRect) {
                const unionRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                unionRect.setAttribute('x', unionScreenRect.x);
                unionRect.setAttribute('y', unionScreenRect.y);
                unionRect.setAttribute('width', unionScreenRect.width);
                unionRect.setAttribute('height', unionScreenRect.height);
                unionRect.setAttribute('fill', 'none');
                unionRect.setAttribute('stroke', strokeColor);
                unionRect.setAttribute('stroke-width', unionStrokeWidth.toFixed(2));
                unionRect.setAttribute('rx', '3');
                unionRect.setAttribute('opacity', isSelected ? '0.98' : (isDimmed ? '0.25' : '0.85'));
                unionRect.classList.add('extract-bbox-union');
                unionRect.dataset.fieldPath = overlayKey;
                unionRect.dataset.bboxCount = String(union.count);
                overlayFragment.appendChild(unionRect);
            }
        }

        const totalBboxes = rule.bboxes.length;
        for (const { bboxEntry, bboxIndexInRule } of pageBboxes) {
            const bbox = bboxEntry.bbox;
            const [normX, normY, normW, normH] = bbox;
            const x = normX * canvasWidth;
            const y = normY * canvasHeight;
            const width = normW * canvasWidth;
            const height = normH * canvasHeight;

            const isActiveOrdinal = isSelected && selectedExtractBboxIndex === bboxIndexInRule;

            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.classList.add('extract-overlay-group');
            if (isSelected) group.classList.add('extract-bbox--selected');
            if (isStray) group.classList.add('extract-bbox--stray');
            if (isDimmed) group.classList.add('extract-bbox--dimmed');
            if (isActiveOrdinal) group.classList.add('extract-bbox--active-ordinal');
            group.dataset.fieldPath = overlayKey;
            group.dataset.bboxIndex = String(bboxIndexInRule);
            if (isStray) group.dataset.sourcePath = fieldPath;
            group.style.cursor = 'pointer';

            let fillOpacity;
            let strokeWidth;
            if (isSelected) {
                fillOpacity = '0.28';
                strokeWidth = '3';
            } else if (isDimmed) {
                fillOpacity = '0.06';
                strokeWidth = '1';
            } else {
                fillOpacity = '0.16';
                strokeWidth = '2';
            }

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', width);
            rect.setAttribute('height', height);
            rect.setAttribute('fill', fillColor);
            rect.setAttribute('fill-opacity', fillOpacity);
            rect.setAttribute('stroke', strokeColor);
            rect.setAttribute('stroke-width', strokeWidth);
            if (strokeDasharray) rect.setAttribute('stroke-dasharray', strokeDasharray);
            rect.classList.add('extract-bbox-main-rect');
            if (isActiveOrdinal) rect.style.cursor = 'move';
            group.appendChild(rect);

            // Label: selected bbox shows expected value, others show short path.
            // When a selection is active, dimmed bboxes drop their label so the
            // selected bbox reads cleanly against the dim background.
            const shortLabel = shortenFieldPathLabel(fieldPath);
            let labelText = '';
            if (isSelected) {
                const valuePreview = _truncateForLabel(rule.expected_value, 80);
                labelText = shortLabel
                    ? `${shortLabel} → "${valuePreview}"`
                    : `"${valuePreview}"`;
            } else if (!isDimmed) {
                labelText = shortLabel;
            }
            if (labelText && labelNamesVisible !== false) {
                const labelBgHeight = 16;
                const labelBgWidth = Math.min(Math.max(width, 40), labelText.length * 7 + 10);
                const labelBgY = Math.max(0, y - labelBgHeight - 2);
                const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                labelBg.setAttribute('x', x);
                labelBg.setAttribute('y', labelBgY);
                labelBg.setAttribute('width', labelBgWidth);
                labelBg.setAttribute('height', labelBgHeight);
                labelBg.setAttribute('fill', fillColor);
                labelBg.setAttribute('rx', '3');
                labelBg.classList.add('layout-bbox-label');

                const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                label.setAttribute('x', x + 5);
                label.setAttribute('y', labelBgY + 12);
                label.setAttribute('fill', '#fff');
                label.setAttribute('font-size', '10');
                label.setAttribute('font-weight', '600');
                label.setAttribute('font-family', 'Inter, sans-serif');
                label.textContent = labelText;
                label.classList.add('layout-bbox-label');

                group.appendChild(labelBg);
                group.appendChild(label);
            }

            // Ordinal badge for multi-bbox rules: small circle + "i/N" text
            // near the top-right corner of each bbox. Helps users see which
            // of a wrap cell's lines they are looking at.
            if (totalBboxes > 1) {
                const badgeSize = 16;
                const badgeCx = x + width - 4;
                const badgeCy = y + 4;
                if (badgeCx - badgeSize / 2 >= 0 && badgeCy - badgeSize / 2 >= 0) {
                    const badgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                    badgeGroup.classList.add('extract-bbox-ordinal');
                    if (isActiveOrdinal) badgeGroup.classList.add('extract-bbox-ordinal--active');
                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('cx', badgeCx);
                    circle.setAttribute('cy', badgeCy);
                    circle.setAttribute('r', badgeSize / 2);
                    circle.setAttribute('fill', fillColor);
                    circle.setAttribute('stroke', strokeColor);
                    circle.setAttribute('stroke-width', isActiveOrdinal ? '2' : '1');
                    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    text.setAttribute('x', badgeCx);
                    text.setAttribute('y', badgeCy + 3);
                    text.setAttribute('fill', '#fff');
                    text.setAttribute('font-size', '9');
                    text.setAttribute('font-weight', '700');
                    text.setAttribute('font-family', 'Inter, sans-serif');
                    text.setAttribute('text-anchor', 'middle');
                    text.textContent = `${bboxIndexInRule + 1}/${totalBboxes}`;
                    badgeGroup.appendChild(circle);
                    badgeGroup.appendChild(text);
                    group.appendChild(badgeGroup);
                }
            }

            // Resize handles: only on the actively-selected bbox, like
            // layout mode. Mousedown on a handle starts a resize drag;
            // mousedown on the main rect starts a move drag.
            if (isActiveOrdinal) {
                _appendExtractBboxHandles(group, x, y, width, height, strokeColor);
                _appendExtractBboxDeleteIcon(group, x, y, width, strokeColor, () => {
                    const ruleIdx = _findExtractRuleIndexByPath(overlayKey);
                    if (ruleIdx >= 0) _deleteExtractBboxAt(ruleIdx, bboxIndexInRule);
                });
            }

            overlayFragment.appendChild(group);
        }
    }

    svg.appendChild(overlayFragment);
    elements.pdfWrapper.appendChild(svg);
    _initExtractBboxEditHandlers(svg);
}

function _initExtractBboxEditHandlers(svg) {
    if (!svg) return;
    svg.addEventListener('mousedown', _onExtractBboxMouseDown);
    svg.addEventListener('click', _onExtractOverlayClick);
    svg.addEventListener('mouseover', _onExtractOverlayMouseOver);
    svg.addEventListener('mouseout', _onExtractOverlayMouseOut);
    svg.addEventListener('contextmenu', _onExtractOverlayContextMenu);
}

function _getExtractOverlayGroupFromEvent(event) {
    const group = event?.target?.closest?.('.extract-overlay-group');
    if (!group) return null;
    const overlay = document.getElementById('layout-overlay');
    return overlay?.contains(group) ? group : null;
}

function _onExtractOverlayClick(e) {
    const group = _getExtractOverlayGroupFromEvent(e);
    if (!group) return;
    // Ignore synthetic clicks emitted by a drag release.
    if (document.body.classList.contains('bbox-dragging') || extractBboxSuppressNextClick) {
        extractBboxSuppressNextClick = false;
        return;
    }
    e.stopPropagation();
    const overlayKey = group.dataset.fieldPath || '';
    const bboxIndexInRule = parseInt(group.dataset.bboxIndex || '0', 10);
    const alreadySelected = selectedExtractFieldPath === overlayKey
        && (selectedExtractBboxIndex === bboxIndexInRule
            || (selectedExtractBboxIndex == null && bboxIndexInRule === 0));
    if (alreadySelected) {
        selectExtractFieldPath(null, {
            navigateIfNeeded: false,
            scrollIntoView: false,
        });
        return;
    }
    selectExtractFieldPath(overlayKey, {
        navigateIfNeeded: false,
        scrollIntoView: true,
        bboxIndex: bboxIndexInRule,
        focusBbox: false,
    });
}

function _onExtractOverlayMouseOver(e) {
    const group = _getExtractOverlayGroupFromEvent(e);
    if (!group || group.contains(e.relatedTarget)) return;
    const overlayKey = group.dataset.fieldPath || '';
    group.classList.add('is-hovered');
    _toggleExtractTreeHover(overlayKey, true);
}

function _onExtractOverlayMouseOut(e) {
    const group = _getExtractOverlayGroupFromEvent(e);
    if (!group || group.contains(e.relatedTarget)) return;
    const overlayKey = group.dataset.fieldPath || '';
    group.classList.remove('is-hovered');
    _toggleExtractTreeHover(overlayKey, false);
}

function _onExtractOverlayContextMenu(e) {
    const group = _getExtractOverlayGroupFromEvent(e);
    if (!group || !group.classList.contains('extract-bbox--stray')) return;
    e.preventDefault();
    e.stopPropagation();
    const overlayKey = group.dataset.fieldPath || '';
    // `overlayKey` is `__unassigned__/<rule.id>`; resolve to the absolute
    // index in currentTests.test_rules.
    const absIdx = _findExtractRuleIndexByPath(overlayKey);
    if (absIdx >= 0) _showStrayReassignMenu(e.clientX, e.clientY, absIdx);
}

function _findExtractRuleIndexByPath(fieldPath) {
    if (!fieldPath) return -1;
    const rules = Array.isArray(currentTests?.test_rules) ? currentTests.test_rules : [];
    if (typeof fieldPath === 'string' && fieldPath.startsWith('__unassigned__/')) {
        const suffix = fieldPath.slice('__unassigned__/'.length);
        for (let i = 0; i < rules.length; i += 1) {
            const r = rules[i];
            if (!r || r.type !== 'extract_field') continue;
            const tags = Array.isArray(r.tags) ? r.tags : [];
            if (!tags.includes('stray_evidence')) continue;
            if (r.id === suffix) return i;
        }
        return -1;
    }
    // Real path: prefer the first non-stray rule with matching field_path.
    let firstMatch = -1;
    for (let i = 0; i < rules.length; i += 1) {
        const r = rules[i];
        if (!r || r.type !== 'extract_field' || r.field_path !== fieldPath) continue;
        const isStray = Array.isArray(r.tags) && r.tags.includes('stray_evidence');
        if (!isStray) return i;
        if (firstMatch < 0) firstMatch = i;
    }
    return firstMatch;
}

function _onExtractBboxMouseDown(e) {
    if (e.button !== 0) return;
    const target = e.target;
    const group = target.closest('.extract-overlay-group');
    if (!group) return;

    const overlayKey = group.dataset.fieldPath;
    const bboxIdxAttr = group.dataset.bboxIndex;
    const bboxIdx = bboxIdxAttr !== undefined ? parseInt(bboxIdxAttr, 10) : -1;
    if (!overlayKey || !Number.isInteger(bboxIdx) || bboxIdx < 0) return;

    // First click on an unselected bbox just selects — don't start a drag.
    const alreadyActive = selectedExtractFieldPath === overlayKey
        && (selectedExtractBboxIndex === bboxIdx
            || (selectedExtractBboxIndex == null && bboxIdx === 0));
    if (!alreadyActive) {
        return;
    }

    // Determine edit mode from target element.
    let mode = null;
    if (target.dataset.handleType) {
        mode = target.dataset.handleType;
    } else if (target.classList.contains('extract-bbox-main-rect')) {
        mode = 'move';
    } else {
        return;
    }

    const ruleIdx = _findExtractRuleIndexByPath(overlayKey);
    if (ruleIdx < 0) return;
    const rule = currentTests.test_rules[ruleIdx];
    const bbox = rule?.bboxes?.[bboxIdx]?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) return;

    e.preventDefault();
    e.stopPropagation();

    const svg = document.getElementById('layout-overlay');
    const svgRect = svg ? svg.getBoundingClientRect() : { width: 1, height: 1 };

    extractBboxEditMode = null;
    extractBboxEditStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        origBbox: [...bbox],
        svgRect,
        ruleIdx,
        bboxIdx,
        mode,
    };

    document.addEventListener('mousemove', _onExtractBboxMouseMove);
    document.addEventListener('mouseup', _onExtractBboxMouseUp);
}

function _onExtractBboxMouseMove(e) {
    if (!extractBboxEditStart) return;
    const { svgRect, origBbox, mouseX: startX, mouseY: startY, ruleIdx, bboxIdx, mode } = extractBboxEditStart;
    if (!extractBboxEditMode) {
        const dragDistance = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dragDistance < EXTRACT_BBOX_DRAG_START_PX) return;
        extractBboxEditMode = mode;
        document.body.classList.add('bbox-dragging');
    }
    const delta = window.AnnotatorBboxDrag.mouseDeltaToNorm(
        e.clientX, e.clientY, startX, startY, svgRect,
    );
    const next = window.AnnotatorBboxDrag.applyBboxDrag(origBbox, delta, extractBboxEditMode);
    const bboxEntry = currentTests?.test_rules?.[ruleIdx]?.bboxes?.[bboxIdx];
    if (!bboxEntry) return;
    bboxEntry.bbox = next;
    // Re-render the overlay each step — handles ride along with the bbox.
    renderLayoutOverlay();
}

async function _onExtractBboxMouseUp() {
    document.removeEventListener('mousemove', _onExtractBboxMouseMove);
    document.removeEventListener('mouseup', _onExtractBboxMouseUp);
    document.body.classList.remove('bbox-dragging');
    const wasEditing = extractBboxEditMode !== null;
    extractBboxEditMode = null;
    extractBboxEditStart = null;
    if (wasEditing) {
        extractBboxSuppressNextClick = true;
        setTimeout(() => {
            extractBboxSuppressNextClick = false;
        }, 0);
    }
    if (wasEditing) {
        await saveTests('extract-bbox-drag');
        renderExtractEditor();
    }
}

function _bboxCenterNorm(bboxEntry) {
    const b = bboxEntry?.bbox;
    if (!Array.isArray(b) || b.length !== 4) return [0, 0];
    return [b[0] + b[2] / 2, b[1] + b[3] / 2];
}

function _minCentroidDistance(cx, cy, bboxes) {
    let best = Infinity;
    for (const b of bboxes || []) {
        const [bx, by] = _bboxCenterNorm(b);
        const d = Math.hypot(cx - bx, cy - by);
        if (d < best) best = d;
    }
    return best;
}

/**
 * Rank non-stray extract_field rules by centroid distance on the same page
 * as the stray. Returns up to `limit` candidates; stable tie-break order
 * is alphabetical by field_path, then by rule index.
 */
function _rankReassignmentCandidates(strayRule, { limit = 10 } = {}) {
    const rules = Array.isArray(currentTests?.test_rules) ? currentTests.test_rules : [];
    const strayBboxes = Array.isArray(strayRule?.bboxes) ? strayRule.bboxes : [];
    if (strayBboxes.length === 0) return [];
    const page = strayBboxes[0]?.page;
    const [cx, cy] = _bboxCenterNorm(strayBboxes[0]);

    const candidates = [];
    for (let i = 0; i < rules.length; i += 1) {
        const r = rules[i];
        if (!r || r.type !== 'extract_field') continue;
        const tags = Array.isArray(r.tags) ? r.tags : [];
        if (tags.includes('stray_evidence')) continue;
        const sameSite = (r.bboxes || []).some((b) => b?.page === page);
        if (!sameSite) continue;
        candidates.push({
            idx: i,
            rule: r,
            distance: _minCentroidDistance(cx, cy, (r.bboxes || []).filter((b) => b?.page === page)),
        });
    }
    candidates.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        const pa = a.rule.field_path || '';
        const pb = b.rule.field_path || '';
        if (pa !== pb) return pa < pb ? -1 : 1;
        return a.idx - b.idx;
    });
    return candidates.slice(0, limit);
}

async function _reassignStrayToTarget(strayIdx, targetIdx) {
    const rules = currentTests?.test_rules;
    if (!Array.isArray(rules)) return;
    const stray = rules[strayIdx];
    const target = rules[targetIdx];
    if (!stray || !target) return;

    // Snapshot for undo BEFORE mutation.
    lastExtractReassignment = {
        strayRule: JSON.parse(JSON.stringify(stray)),
        strayIdx,
        targetIdx,
        targetOrigBboxes: Array.isArray(target.bboxes)
            ? JSON.parse(JSON.stringify(target.bboxes))
            : [],
        targetOrigTags: Array.isArray(target.tags) ? [...target.tags] : [],
    };

    target.bboxes = Array.isArray(target.bboxes) ? target.bboxes : [];
    for (const b of (stray.bboxes || [])) target.bboxes.push({ ...b });

    // Mark the target rule so the round-trip audit can relax its byte-
    // equivalence check for reassigned rules (fresh converter run wouldn't
    // include these extra source bboxes).
    target.tags = Array.isArray(target.tags) ? target.tags.slice() : [];
    if (!target.tags.includes('reassigned')) target.tags.push('reassigned');

    // Remove the stray. If strayIdx < targetIdx, targetIdx shifts down by 1.
    rules.splice(strayIdx, 1);
    const newTargetIdx = strayIdx < targetIdx ? targetIdx - 1 : targetIdx;

    selectedExtractFieldPath = target.field_path || null;
    selectedExtractBboxIndex = target.bboxes.length > stray.bboxes.length
        ? target.bboxes.length - stray.bboxes.length
        : 0;

    renderExtractEditor();
    renderLayoutOverlay();
    await saveTests('extract-stray-reassign');
    showToast(`Reassigned to "${target.field_path}" (Ctrl+Z to undo)`, 'success');
    return newTargetIdx;
}

async function _undoLastReassignment() {
    const last = lastExtractReassignment;
    if (!last) return;
    lastExtractReassignment = null;
    const rules = currentTests?.test_rules;
    if (!Array.isArray(rules)) return;
    const currentTargetIdx = last.strayIdx < last.targetIdx ? last.targetIdx - 1 : last.targetIdx;
    const target = rules[currentTargetIdx];
    if (target) {
        target.bboxes = last.targetOrigBboxes;
        target.tags = last.targetOrigTags;
    }
    // Reinsert the stray at its original position.
    rules.splice(last.strayIdx, 0, last.strayRule);
    selectedExtractFieldPath = null;
    selectedExtractBboxIndex = null;
    renderExtractEditor();
    renderLayoutOverlay();
    await saveTests('extract-stray-reassign-undo');
    showToast('Reassignment undone', 'info');
}

function _closeExtractContextMenu() {
    const existing = document.getElementById('extract-context-menu');
    if (existing) existing.remove();
    document.removeEventListener('click', _closeExtractContextMenu, true);
    document.removeEventListener('keydown', _contextMenuKeyClose, true);
}

function _contextMenuKeyClose(e) {
    if (e.key === 'Escape') _closeExtractContextMenu();
}

function _showStrayReassignMenu(clientX, clientY, strayIdx) {
    _closeExtractContextMenu();
    const stray = currentTests?.test_rules?.[strayIdx];
    if (!stray) return;
    const candidates = _rankReassignmentCandidates(stray, { limit: 10 });
    if (candidates.length === 0) {
        showToast('No candidate rules on this page to reassign into.', 'warning');
        return;
    }
    const menu = document.createElement('div');
    menu.id = 'extract-context-menu';
    menu.className = 'extract-context-menu';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    const header = document.createElement('div');
    header.className = 'extract-context-menu-header';
    header.textContent = `Reassign stray → (${candidates.length} nearest)`;
    menu.appendChild(header);
    for (const c of candidates) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'extract-context-menu-item';
        const valuePreview = _truncateForLabel(c.rule.expected_value, 40);
        item.innerHTML = `<span class="extract-context-menu-path">${escapeHtml(c.rule.field_path || '')}</span>`
            + ` <span class="extract-context-menu-value">"${escapeHtml(valuePreview)}"</span>`;
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            _closeExtractContextMenu();
            await _reassignStrayToTarget(strayIdx, c.idx);
        });
        menu.appendChild(item);
    }
    document.body.appendChild(menu);
    // Defer document-wide click listener so the triggering click doesn't
    // immediately close the menu.
    setTimeout(() => {
        document.addEventListener('click', _closeExtractContextMenu, true);
        document.addEventListener('keydown', _contextMenuKeyClose, true);
    }, 0);
}

function _beginExtractBboxDraw(fieldPath) {
    if (!fieldPath) return;
    const ruleIdx = _findExtractRuleIndexByPath(fieldPath);
    if (ruleIdx < 0) {
        showToast('No extract_field rule for this path — cannot draw.', 'error');
        return;
    }
    extractDrawContext = { fieldPath, ruleIdx };
    layoutDrawMode = false;
    clearSelectionBox();
    toggleAiSelectMode(true);
    showToast('Draw a region on the document for this field', 'info');
}

async function _deleteExtractBboxAt(ruleIdx, bboxIdx) {
    const rule = currentTests?.test_rules?.[ruleIdx];
    if (!rule || !Array.isArray(rule.bboxes) || bboxIdx < 0 || bboxIdx >= rule.bboxes.length) return;
    rule.bboxes.splice(bboxIdx, 1);
    // Drop the active-ordinal selection so handles don't stick on a
    // since-removed index.
    if (selectedExtractBboxIndex === bboxIdx) {
        selectedExtractBboxIndex = rule.bboxes.length > 0 ? 0 : null;
    } else if (selectedExtractBboxIndex != null && selectedExtractBboxIndex > bboxIdx) {
        selectedExtractBboxIndex -= 1;
    }
    renderExtractEditor();
    renderLayoutOverlay();
    await saveTests('extract-bbox-delete');
    showToast('Bounding box deleted', 'success');
}

function _toggleExtractTreeHover(fieldPath, on) {
    if (!fieldPath || !elements.extractKvRows) return;
    const rows = elements.extractKvRows.querySelectorAll(`.extract-node-row[data-field-path="${CSS.escape(fieldPath)}"]`);
    rows.forEach((row) => row.classList.toggle('is-hovered', on));
}

function _toggleExtractOverlayHover(fieldPath, on) {
    const svg = document.getElementById('layout-overlay');
    if (!svg) return;
    const groups = svg.querySelectorAll(`.extract-overlay-group[data-field-path="${CSS.escape(fieldPath)}"]`);
    groups.forEach((g) => g.classList.toggle('is-hovered', on));
}

function _clampCenteredScrollPosition(targetCenter, viewportSize, maxScroll) {
    const centered = targetCenter - viewportSize / 2;
    return Math.max(0, Math.min(centered, Math.max(0, maxScroll)));
}

function _getExtractBboxOnCurrentPage(fieldPath, bboxIndex = null) {
    const rule = _findExtractRuleByPath(fieldPath);
    const bboxes = Array.isArray(rule?.bboxes) ? rule.bboxes : [];
    if (bboxIndex != null) {
        const selected = bboxes[bboxIndex];
        if (selected?.page === pageNum && Array.isArray(selected.bbox) && selected.bbox.length === 4) {
            return selected;
        }
    }
    return bboxes.find((entry) => (
        entry?.page === pageNum
        && Array.isArray(entry.bbox)
        && entry.bbox.length === 4
    )) || null;
}

function _focusExtractBboxInPdf(fieldPath, { bboxIndex = null, behavior = 'smooth' } = {}) {
    const bboxEntry = _getExtractBboxOnCurrentPage(fieldPath, bboxIndex);
    const bbox = bboxEntry?.bbox;
    const container = elements.pdfContainer;
    const wrapper = elements.pdfWrapper;
    const canvas = elements.pdfCanvas;
    if (!bbox || !container || !wrapper || !canvas) return false;

    const canvasWidth = parseFloat(canvas.style.width) || canvas.width;
    const canvasHeight = parseFloat(canvas.style.height) || canvas.height;
    if (!canvasWidth || !canvasHeight) return false;

    const [x, y, w, h] = bbox;
    const bboxCenterX = (x + w / 2) * canvasWidth;
    const bboxCenterY = (y + h / 2) * canvasHeight;

    const containerRect = container.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const targetCenterX = container.scrollLeft + (wrapperRect.left - containerRect.left) + bboxCenterX;
    const targetCenterY = container.scrollTop + (wrapperRect.top - containerRect.top) + bboxCenterY;

    const left = _clampCenteredScrollPosition(
        targetCenterX,
        container.clientWidth,
        container.scrollWidth - container.clientWidth,
    );
    const top = _clampCenteredScrollPosition(
        targetCenterY,
        container.clientHeight,
        container.scrollHeight - container.clientHeight,
    );

    if (typeof container.scrollTo === 'function') {
        container.scrollTo({ left, top, behavior });
    } else {
        container.scrollLeft = left;
        container.scrollTop = top;
    }
    return true;
}

/**
 * Select an extract field path. Updates tree + overlay rendering, optionally navigating pages.
 */
/**
 * Resolve a tree/overlay path (real field_path or synthetic
 * `__unassigned__/<rule.id>`) back to its underlying extract_field rule.
 */
function _findExtractRuleByPath(fieldPath) {
    if (!fieldPath) return null;
    const rules = Array.isArray(currentTests?.test_rules) ? currentTests.test_rules : [];
    if (typeof fieldPath === 'string' && fieldPath.startsWith('__unassigned__/')) {
        const suffix = fieldPath.slice('__unassigned__/'.length);
        for (const rule of rules) {
            if (!rule || rule.type !== 'extract_field') continue;
            const tags = Array.isArray(rule.tags) ? rule.tags : [];
            if (!tags.includes('stray_evidence')) continue;
            if (rule.id && rule.id === suffix) return rule;
        }
        // Fallback: match on synthetic "field#index" suffix (no stored id yet).
        return null;
    }
    return indexExtractFieldRules().get(fieldPath) || null;
}

async function selectExtractFieldPath(fieldPath, options = {}) {
    const {
        navigateIfNeeded = true,
        scrollIntoView = false,
        bboxIndex = null,
        focusBbox = true,
    } = options;
    const pathChanged = fieldPath !== selectedExtractFieldPath;
    selectedExtractFieldPath = fieldPath || null;
    if (!fieldPath) {
        selectedExtractBboxIndex = null;
    } else if (bboxIndex != null) {
        selectedExtractBboxIndex = bboxIndex;
    } else if (pathChanged) {
        // New selection with no explicit bbox: default to first, or null for scalars.
        const rule = _findExtractRuleByPath(fieldPath);
        selectedExtractBboxIndex = rule && Array.isArray(rule.bboxes) && rule.bboxes.length > 1
            ? 0
            : null;
    }

    if (navigateIfNeeded && fieldPath) {
        const rule = _findExtractRuleByPath(fieldPath);
        if (rule && Array.isArray(rule.bboxes) && rule.bboxes.length > 0) {
            const pages = rule.bboxes.map((b) => b?.page).filter((p) => Number.isFinite(p));
            if (pages.length > 0 && !pages.includes(pageNum)) {
                const target = Math.min(...pages);
                if (pdfDoc && target > 0 && target <= pdfDoc.numPages) {
                    pageNum = target;
                    await renderPage(pageNum);
                }
            }
        }
    }

    renderExtractEditor();
    if (annotationMode === ANNOTATION_MODE_EXTRACT) {
        renderLayoutOverlay();
    }
    if (focusBbox && fieldPath) {
        _focusExtractBboxInPdf(fieldPath, { bboxIndex: selectedExtractBboxIndex });
    }

    if (scrollIntoView && fieldPath && elements.extractKvRows) {
        const row = elements.extractKvRows.querySelector(`.extract-node-row[data-field-path="${CSS.escape(fieldPath)}"]`);
        if (row && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }
}

/**
 * Toggle the `verified` flag on an extract_field rule by field_path.
 * Marks the document dirty (via saveTests later) and re-renders.
 */
function toggleExtractFieldVerified(fieldPath) {
    if (!fieldPath || !Array.isArray(currentTests?.test_rules)) return;
    let changed = false;
    for (const rule of currentTests.test_rules) {
        if (rule && rule.type === 'extract_field' && rule.field_path === fieldPath) {
            rule.verified = !Boolean(rule.verified);
            changed = true;
        }
    }
    if (!changed) return;
    renderExtractEditor();
    if (annotationMode === ANNOTATION_MODE_EXTRACT) {
        renderLayoutOverlay();
    }
    // Persist via existing save path — coordinator will debounce/enqueue.
    saveTests('extract-field-verified-toggle');
}

/**
 * Materialize lazy-rendered children for a collapsed array/object node.
 * We re-derive the children from current data (rules + expected_output),
 * matching by path, so state edits persist across lazy/expand cycles.
 */
function _materializeLazyChildren(node, childContainer) {
    if (!childContainer || childContainer.dataset.lazyPending !== 'true') return;
    const nodeDepth = parseInt(childContainer.dataset.lazyDepth || '1', 10);
    const parentPath = childContainer.dataset.lazyParentPath || '';
    const itemsType = childContainer.dataset.lazyItemsType || 'string';
    const rulesByPath = indexExtractFieldRules();
    const nodeType = node.dataset.nodeType;

    let childrenHtml = '';
    if (nodeType === 'array') {
        // Need the array value at parentPath — traverse expected_output
        const expectedOutput = currentTests?.expected_output && typeof currentTests.expected_output === 'object'
            ? currentTests.expected_output
            : {};
        let tokens;
        try { tokens = parseExtractFieldPath(parentPath); } catch { tokens = []; }
        const arrValue = getExtractPath(expectedOutput, tokens, []);
        const arr = Array.isArray(arrValue) ? arrValue : [];
        arr.forEach((item, index) => {
            const itemPath = _joinExtractPathIndex(parentPath, index);
            let childEntry;
            if (itemsType === 'object') {
                const itemCtx = { rulesByPath, parentPath: itemPath };
                childEntry = {
                    index, type: 'object', path: itemPath,
                    children: buildExtractEntriesFromSchema({}, item, undefined, itemCtx),
                };
            } else {
                childEntry = _attachRuleToLeaf({ index, type: itemsType, value: item, path: itemPath }, rulesByPath);
            }
            const finalEntry = itemsType === 'object'
                ? childEntry
                : { ...childEntry, type: itemsType };
            childrenHtml += buildExtractNodeHtml(finalEntry, nodeDepth, true);
        });
    }
    // Replace placeholder + mark as materialized.
    childContainer.innerHTML = childrenHtml;
    delete childContainer.dataset.lazyPending;
    syncExtractEditorTextareaHeights(childContainer);
}

function toggleExtractNodeExpansion(node) {
    const childContainer = node?.querySelector(':scope > .extract-node-children');
    if (!childContainer) return false;

    const wasCollapsed = childContainer.classList.contains('collapsed');
    const isCollapsed = childContainer.classList.toggle('collapsed');
    const toggle = node.querySelector(':scope > .extract-node-row .extract-node-toggle');
    if (toggle) {
        toggle.textContent = isCollapsed ? '▶' : '▼';
    }
    const path = node?.dataset?.fieldPath || '';
    if (path) {
        if (isCollapsed) {
            collapsedExtractPaths.add(path);
            expandedExtractPaths.delete(path);
        } else {
            expandedExtractPaths.add(path);
            collapsedExtractPaths.delete(path);
        }
    }
    if (wasCollapsed && !isCollapsed && childContainer.dataset.lazyPending === 'true') {
        _materializeLazyChildren(node, childContainer);
    }
    return true;
}

// === Layout Detection Overlay ===
function renderLayoutOverlay() {
    // Remove existing overlay
    const existingOverlay = document.getElementById('layout-overlay');
    if (existingOverlay) {
        existingOverlay.remove();
    }

    // Reset bbox edit state when overlay is rebuilt (unless actively dragging)
    if (!bboxEditMode) {
        bboxEditStartCoords = null;
        bboxEditCurrentTest = null;
    }

    // Check if layout overlay should be visible
    if (!layoutOverlayVisible || !currentTests || !currentTests.test_rules) {
        return;
    }

    // EXTRACT-mode branch: render extract_field bboxes instead of layout
    if (annotationMode === ANNOTATION_MODE_EXTRACT) {
        renderExtractFieldOverlay();
        return;
    }

    // Display path — honor the side-panel's UI granularity / type /
    // tag filters. Data-mutation callers (reading-order assignment,
    // expected-markdown generation, ...) keep using the unfiltered
    // getOrderedLayoutTestsForPage so they don't silently drop rules
    // the user has hidden from view.
    const layoutTests = getFilteredLayoutTestsForPage(pageNum);

    if (layoutTests.length === 0) {
        return;
    }

    const pdfCanvas = elements.pdfCanvas;
    if (!pdfCanvas) return;

    const canvasWidth = parseFloat(pdfCanvas.style.width) || pdfCanvas.width;
    const canvasHeight = parseFloat(pdfCanvas.style.height) || pdfCanvas.height;

    // Create SVG overlay
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'layout-overlay';
    svg.classList.add('layout-overlay');
    svg.setAttribute('width', canvasWidth);
    svg.setAttribute('height', canvasHeight);
    svg.style.width = `${canvasWidth}px`;
    svg.style.height = `${canvasHeight}px`;

    // Batch all per-rule SVG appends through a DocumentFragment so the
    // browser sees a single insert into the live tree, matching the
    // extract-field overlay rendering path.
    const overlayFragment = document.createDocumentFragment();

    layoutTests.forEach((test) => {
        const bbox = test.bbox;
        if (!bbox || bbox.length !== 4) return;

        // bbox is [x, y, width, height] in normalized [0-1] coordinates
        const [normX, normY, normW, normH] = bbox;
        const x = normX * canvasWidth;
        const y = normY * canvasHeight;
        const width = normW * canvasWidth;
        const height = normH * canvasHeight;

        const className = test.canonical_class || 'Unknown';
        const color = LAYOUT_CATEGORY_COLORS[className] || '#888888';
        const isSelected = selectedLayoutTestIndex === test.originalIndex;
        const baseOpacity = isSelected ? '0.4' : '0.2';

        // Create group for this bbox
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.classList.add('layout-bbox-group');
        group.dataset.testIndex = test.originalIndex;
        group.style.cursor = 'pointer';

        // Rectangle with fill
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.classList.add('layout-bbox-rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', width);
        rect.setAttribute('height', height);
        rect.setAttribute('fill', color);
        rect.setAttribute('fill-opacity', baseOpacity);
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', isSelected ? '3' : '2');
        rect.setAttribute('stroke-dasharray', isSelected ? '' : '4,2');
        // Stash the resting opacity so the delegated mouseout handler
        // can restore it without re-deriving selection state.
        rect.dataset.baseOpacity = baseOpacity;

        // Class label badge background
        const labelBgHeight = 18;
        const labelBgWidth = Math.min(width, className.length * 8 + 12);
        const labelBgX = x;
        const labelBgY = Math.max(0, y - labelBgHeight - 2);

        const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelBg.setAttribute('x', labelBgX);
        labelBg.setAttribute('y', labelBgY);
        labelBg.setAttribute('width', labelBgWidth);
        labelBg.setAttribute('height', labelBgHeight);
        labelBg.setAttribute('fill', color);
        labelBg.setAttribute('rx', '3');
        labelBg.classList.add('layout-bbox-label', 'layout-bbox-label-bg');

        // Class label text
        const labelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        labelText.setAttribute('x', labelBgX + 6);
        labelText.setAttribute('y', labelBgY + 13);
        labelText.setAttribute('fill', '#000');
        labelText.setAttribute('font-size', '11');
        labelText.setAttribute('font-weight', '600');
        labelText.setAttribute('font-family', 'Inter, sans-serif');
        labelText.textContent = className;
        labelText.classList.add('layout-bbox-label', 'layout-bbox-label-text');

        if (test.normalizedRoIndex !== undefined && test.normalizedRoIndex !== null) {
            const roSize = 20;
            const roX = x + width - roSize / 2;
            const roY = y - roSize / 2;

            const roCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            roCircle.classList.add('layout-bbox-ro-circle');
            roCircle.setAttribute('cx', roX);
            roCircle.setAttribute('cy', roY);
            roCircle.setAttribute('r', roSize / 2);
            roCircle.setAttribute('fill', '#21262d');
            roCircle.setAttribute('stroke', '#e6edf3');
            roCircle.setAttribute('stroke-width', '1.5');

            const roText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            roText.classList.add('layout-bbox-ro-text');
            roText.setAttribute('x', roX);
            roText.setAttribute('y', roY + 4);
            roText.setAttribute('fill', '#e6edf3');
            roText.setAttribute('font-size', '10');
            roText.setAttribute('font-weight', '600');
            roText.setAttribute('font-family', 'Inter, sans-serif');
            roText.setAttribute('text-anchor', 'middle');
            roText.textContent = String(test.normalizedRoIndex);

            group.appendChild(roCircle);
            group.appendChild(roText);
        }

        group.appendChild(rect);
        group.appendChild(labelBg);
        group.appendChild(labelText);

        // Per-overlay click / mouseover / mouseout handlers used to be
        // attached here (one set per group). They're now wired once
        // via _initLayoutOverlayDelegatedHandlers() below — same
        // pattern as renderExtractFieldOverlay (#848).

        // Add resize handles for selected bbox
        if (isSelected) {
            const handleSize = 10;
            const handleColor = '#fff';
            const handleStroke = color;

            // Make the main rect indicate move cursor when selected
            rect.style.cursor = 'move';
            rect.classList.add('bbox-main-rect');

            // Corner handles: nw, ne, sw, se
            const corners = [
                { id: 'nw', cx: x, cy: y, cursor: 'nwse-resize' },
                { id: 'ne', cx: x + width, cy: y, cursor: 'nesw-resize' },
                { id: 'sw', cx: x, cy: y + height, cursor: 'nesw-resize' },
                { id: 'se', cx: x + width, cy: y + height, cursor: 'nwse-resize' },
            ];

            corners.forEach(corner => {
                const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                handle.setAttribute('x', corner.cx - handleSize / 2);
                handle.setAttribute('y', corner.cy - handleSize / 2);
                handle.setAttribute('width', handleSize);
                handle.setAttribute('height', handleSize);
                handle.setAttribute('fill', handleColor);
                handle.setAttribute('stroke', handleStroke);
                handle.setAttribute('stroke-width', '2');
                handle.setAttribute('rx', '2');
                handle.classList.add('bbox-handle', `bbox-handle-${corner.id}`);
                handle.style.cursor = corner.cursor;
                handle.dataset.handleType = `resize-${corner.id}`;
                group.appendChild(handle);
            });

            // Edge handles: n, e, s, w (midpoints)
            const edges = [
                { id: 'n', cx: x + width / 2, cy: y, cursor: 'ns-resize' },
                { id: 'e', cx: x + width, cy: y + height / 2, cursor: 'ew-resize' },
                { id: 's', cx: x + width / 2, cy: y + height, cursor: 'ns-resize' },
                { id: 'w', cx: x, cy: y + height / 2, cursor: 'ew-resize' },
            ];

            edges.forEach(edge => {
                const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                handle.setAttribute('x', edge.cx - handleSize / 2);
                handle.setAttribute('y', edge.cy - handleSize / 2);
                handle.setAttribute('width', handleSize);
                handle.setAttribute('height', handleSize);
                handle.setAttribute('fill', handleColor);
                handle.setAttribute('stroke', handleStroke);
                handle.setAttribute('stroke-width', '2');
                handle.setAttribute('rx', '2');
                handle.classList.add('bbox-handle', `bbox-handle-${edge.id}`);
                handle.style.cursor = edge.cursor;
                handle.dataset.handleType = `resize-${edge.id}`;
                group.appendChild(handle);
            });
        }

        overlayFragment.appendChild(group);
    });

    svg.appendChild(overlayFragment);

    // Add SVG to pdf-wrapper
    elements.pdfWrapper.appendChild(svg);

    // Wire delegated click / hover handlers (one set total, not one
    // per layout-bbox-group). Mirrors the extract overlay refactor.
    _initLayoutOverlayDelegatedHandlers(svg);

    // Initialize drag handlers for bbox editing
    initBboxEditHandlers(svg);
}

function _getLayoutGroupFromEvent(event) {
    const group = event?.target?.closest?.('.layout-bbox-group');
    if (!group) return null;
    const overlay = document.getElementById('layout-overlay');
    return overlay?.contains(group) ? group : null;
}

function _readLayoutGroupTestIndex(group) {
    if (!group) return null;
    const raw = group.dataset?.testIndex;
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function _onLayoutOverlayClick(event) {
    // The bbox drag handlers add `bbox-dragging` to <body> while a
    // drag is in flight; ignore the synthetic click that fires on
    // mouseup so the dragged rule doesn't toggle selection state.
    if (document.body.classList.contains('bbox-dragging')) return;
    const group = _getLayoutGroupFromEvent(event);
    if (!group) return;
    const idx = _readLayoutGroupTestIndex(group);
    if (idx === null) return;
    event.stopPropagation();
    selectLayoutTest(idx);
}

function _onLayoutOverlayMouseOver(event) {
    const group = _getLayoutGroupFromEvent(event);
    if (!group) return;
    // Skip when the cursor moves between children of the same group.
    if (group.contains(event.relatedTarget)) return;
    const rect = group.querySelector('.layout-bbox-rect');
    if (rect) rect.setAttribute('fill-opacity', '0.35');
}

function _onLayoutOverlayMouseOut(event) {
    const group = _getLayoutGroupFromEvent(event);
    if (!group) return;
    if (group.contains(event.relatedTarget)) return;
    const rect = group.querySelector('.layout-bbox-rect');
    if (rect) {
        rect.setAttribute('fill-opacity', rect.dataset.baseOpacity || '0.2');
    }
}

function _initLayoutOverlayDelegatedHandlers(svg) {
    if (!svg) return;
    svg.addEventListener('click', _onLayoutOverlayClick);
    svg.addEventListener('mouseover', _onLayoutOverlayMouseOver);
    svg.addEventListener('mouseout', _onLayoutOverlayMouseOut);
}

async function selectLayoutTest(index, options = {}) {
    const {
        preserveMarkdownScroll = false,
        scrollMarkdownCard = true,
        scrollTestListItem = true,
    } = options;
    selectedLayoutTestIndex = index;
    const selectedRule = currentTests?.test_rules?.[index];
    if (selectedRule?.type === 'layout' && pdfDoc) {
        const targetPage = getLayoutRulePageNumber(selectedRule);
        if (Number.isInteger(targetPage) && targetPage > 0 && targetPage !== pageNum && targetPage <= pdfDoc.numPages) {
            pageNum = targetPage;
            await renderPage(pageNum);
        }
    }
    maybeApplyGroundingPick(index);

    const activeForm = elements.testFormContainer.querySelector('form');
    if (activeForm) {
        const activeType = activeForm.dataset.dynamicRuleType || elements.testTypeSelect?.value || '';
        if (shouldShowGroundingSection(activeType)) {
            renderVisualGroundingSection(activeForm, activeType);
        }
    }

    renderLayoutOverlay();

    // Update markdown panel selection if open
    if (markdownPanelOpen) {
        const markdownContainer = elements.markdownContent;
        const previousScrollTop = preserveMarkdownScroll && markdownContainer
            ? markdownContainer.scrollTop
            : null;

        Promise.resolve(renderMarkdownPanel()).then(() => {
            if (previousScrollTop !== null && elements.markdownContent) {
                elements.markdownContent.scrollTop = previousScrollTop;
            }
            if (!scrollMarkdownCard) return;

            const mdCard = document.querySelector(`.markdown-card[data-test-index="${index}"]`);
            if (mdCard) {
                mdCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            }
        }).catch((error) => {
            console.error('Failed to refresh markdown panel selection:', error);
        });
    }

    // Scroll test list item into view
    if (scrollTestListItem) {
        const testItem = document.querySelector(`.test-item[data-test-index="${index}"]`);
        if (testItem) {
            testItem.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            testItem.classList.add('highlight');
            setTimeout(() => testItem.classList.remove('highlight'), 1000);
        }
    }
}

function toggleLayoutOverlay() {
    layoutOverlayVisible = !layoutOverlayVisible;
    renderLayoutOverlay();
    updateLayoutOverlayButton();
    showToast(layoutOverlayVisible ? 'Layout overlay shown' : 'Layout overlay hidden', 'info');
}

function applyLabelNamesVisibility() {
    if (elements.pdfWrapper) {
        elements.pdfWrapper.classList.toggle('labels-hidden', !labelNamesVisible);
    }
    const btn = elements.labelNamesToggleBtn;
    if (btn) {
        btn.classList.toggle('active', labelNamesVisible);
        btn.setAttribute('aria-pressed', labelNamesVisible ? 'true' : 'false');
        btn.title = `${labelNamesVisible ? 'Hide' : 'Show'} bbox label names`;
    }
    if (elements.labelNamesToggleLabel) {
        elements.labelNamesToggleLabel.textContent = labelNamesVisible ? 'Labels On' : 'Labels Off';
    }
}

function toggleLabelNames() {
    labelNamesVisible = !labelNamesVisible;
    try {
        localStorage.setItem('annotator:showLabelNames', String(labelNamesVisible));
    } catch (e) {
        console.error('Failed to persist label names visibility:', e);
    }
    applyLabelNamesVisibility();
}

// === Bbox Visual Editing Functions ===
function initBboxEditHandlers(svg) {
    if (!svg) return;

    // Use event delegation on the SVG for mousedown
    svg.addEventListener('mousedown', onBboxMouseDown);
}

function onBboxMouseDown(e) {
    // Only handle left mouse button
    if (e.button !== 0) return;

    const target = e.target;
    const group = target.closest('.layout-bbox-group');

    if (!group) return;

    const testIndex = parseInt(group.dataset.testIndex);
    const test = currentTests.test_rules[testIndex];

    if (!test) return;

    // If clicking on an unselected bbox, just select it
    if (selectedLayoutTestIndex !== testIndex) {
        selectLayoutTest(testIndex);
        return;
    }

    // Determine edit mode based on target
    if (target.dataset.handleType) {
        bboxEditMode = target.dataset.handleType;
    } else if (target.classList.contains('bbox-main-rect')) {
        bboxEditMode = 'move';
    } else {
        return; // Clicked on label or other element
    }

    e.preventDefault();
    e.stopPropagation();

    const svg = document.getElementById('layout-overlay');
    const svgRect = svg.getBoundingClientRect();

    bboxEditCurrentTest = test;
    bboxEditStartCoords = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        bbox: [...test.bbox], // Copy original bbox
        svgRect: svgRect,
        // Stash the dragged <g> so onBboxMouseMove can mutate its
        // children in place instead of rebuilding the entire SVG
        // every mouseframe. The full re-render at mouseup
        // (via saveTests → renderTestList → renderLayoutOverlay)
        // reconciles any state we couldn't update incrementally.
        group: group,
        canvasWidth: svgRect.width,
        canvasHeight: svgRect.height,
    };

    // Add body class for cursor feedback
    document.body.classList.add('bbox-dragging');

    // Add document-level event listeners for drag
    document.addEventListener('mousemove', onBboxMouseMove);
    document.addEventListener('mouseup', onBboxMouseUp);
}

function onBboxMouseMove(e) {
    if (!bboxEditMode || !bboxEditStartCoords || !bboxEditCurrentTest) return;

    const {
        svgRect, bbox: origBbox, mouseX: startX, mouseY: startY,
        group, canvasWidth, canvasHeight,
    } = bboxEditStartCoords;

    const delta = window.AnnotatorBboxDrag.mouseDeltaToNorm(
        e.clientX, e.clientY, startX, startY, svgRect,
    );
    const [x, y, w, h] = window.AnnotatorBboxDrag.applyBboxDrag(origBbox, delta, bboxEditMode);

    // Update the test bbox in place
    bboxEditCurrentTest.bbox = [x, y, w, h];

    // Update form fields if visible
    updateBboxFormFields(x, y, w, h);

    // In-place SVG mutation. Falling back to a full rebuild if the
    // group disappeared (e.g., page navigation mid-drag — shouldn't
    // happen but stays correct under it) keeps behaviour identical
    // to the previous full-rebuild approach.
    if (group && group.isConnected) {
        _updateLayoutGroupInPlace(group, x, y, w, h, canvasWidth, canvasHeight);
    } else {
        renderLayoutOverlay();
    }
}

function _updateLayoutGroupInPlace(group, normX, normY, normW, normH, canvasWidth, canvasHeight) {
    const x = normX * canvasWidth;
    const y = normY * canvasHeight;
    const width = normW * canvasWidth;
    const height = normH * canvasHeight;

    const rect = group.querySelector('.layout-bbox-rect');
    if (rect) {
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', width);
        rect.setAttribute('height', height);
    }

    const labelBg = group.querySelector('.layout-bbox-label-bg');
    const labelText = group.querySelector('.layout-bbox-label-text');
    if (labelBg && labelText) {
        const className = labelText.textContent || '';
        const labelBgHeight = 18;
        const labelBgWidth = Math.min(width, className.length * 8 + 12);
        const labelBgX = x;
        const labelBgY = Math.max(0, y - labelBgHeight - 2);
        labelBg.setAttribute('x', labelBgX);
        labelBg.setAttribute('y', labelBgY);
        labelBg.setAttribute('width', labelBgWidth);
        labelText.setAttribute('x', labelBgX + 6);
        labelText.setAttribute('y', labelBgY + 13);
    }

    const roCircle = group.querySelector('.layout-bbox-ro-circle');
    const roText = group.querySelector('.layout-bbox-ro-text');
    if (roCircle && roText) {
        const roSize = 20;
        const roX = x + width - roSize / 2;
        const roY = y - roSize / 2;
        roCircle.setAttribute('cx', roX);
        roCircle.setAttribute('cy', roY);
        roText.setAttribute('x', roX);
        roText.setAttribute('y', roY + 4);
    }

    // Resize handles (8 corners + edges) only exist when the group is
    // selected. Their positions follow the rect, so update them in
    // place too. Position formulas mirror the renderer above.
    const handleSize = 10;
    const halfHandle = handleSize / 2;
    const handlePositions = {
        nw: [x, y],
        ne: [x + width, y],
        sw: [x, y + height],
        se: [x + width, y + height],
        n: [x + width / 2, y],
        e: [x + width, y + height / 2],
        s: [x + width / 2, y + height],
        w: [x, y + height / 2],
    };
    for (const [id, [cx, cy]] of Object.entries(handlePositions)) {
        const handle = group.querySelector(`.bbox-handle-${id}`);
        if (handle) {
            handle.setAttribute('x', cx - halfHandle);
            handle.setAttribute('y', cy - halfHandle);
        }
    }
}

async function onBboxMouseUp(e) {
    // Remove document-level event listeners
    document.removeEventListener('mousemove', onBboxMouseMove);
    document.removeEventListener('mouseup', onBboxMouseUp);

    // Remove body class
    document.body.classList.remove('bbox-dragging');

    if (!bboxEditMode) return;

    // Save the changes
    if (bboxEditCurrentTest) {
        await saveTests('layout-bbox-drag');
        renderTestList(); // Update bbox display in test list
    }

    // Reset edit state
    bboxEditMode = null;
    bboxEditStartCoords = null;
    bboxEditCurrentTest = null;
}

function updateBboxFormFields(x, y, w, h) {
    const bboxXEl = document.getElementById('layout-bbox-x');
    const bboxYEl = document.getElementById('layout-bbox-y');
    const bboxWEl = document.getElementById('layout-bbox-w');
    const bboxHEl = document.getElementById('layout-bbox-h');

    if (bboxXEl) bboxXEl.value = x.toFixed(4);
    if (bboxYEl) bboxYEl.value = y.toFixed(4);
    if (bboxWEl) bboxWEl.value = w.toFixed(4);
    if (bboxHEl) bboxHEl.value = h.toFixed(4);
}

// === Markdown Preview Panel Functions ===

function hasMarkdownContent() {
    return Boolean(currentFile);
}

function updateMarkdownPreviewButton() {
    const btn = elements.markdownPreviewBtn;
    if (!btn) return;
    const hasContent = hasMarkdownContent();
    btn.disabled = !hasContent;
    if (markdownPanelOpen && !hasContent) {
        toggleMarkdownPanel(false);
    }
}

function updateLayoutOverlayButton() {
    const btn = elements.layoutOverlayBtn;
    if (!btn) return;

    const hasContent = Boolean(currentFile);
    btn.disabled = !hasContent;
    btn.classList.toggle('active', hasContent && layoutOverlayVisible);
    btn.setAttribute('aria-pressed', hasContent && layoutOverlayVisible ? 'true' : 'false');
    btn.title = `${layoutOverlayVisible ? 'Hide' : 'Show'} layout bounding boxes (L)`;

    if (elements.layoutOverlayLabel) {
        elements.layoutOverlayLabel.textContent = layoutOverlayVisible ? 'BBoxes On' : 'BBoxes Off';
    }
}

function toggleMarkdownPanel(open = null) {
    if (!currentFile && open !== false) return;
    markdownPanelOpen = open !== null ? open : !markdownPanelOpen;

    if (elements.markdownPanel) {
        elements.markdownPanel.style.display = markdownPanelOpen ? 'flex' : 'none';
    }
    if (elements.resizerPdf) {
        elements.resizerPdf.style.display = markdownPanelOpen ? 'block' : 'none';
    }

    if (elements.markdownPreviewBtn) {
        elements.markdownPreviewBtn.classList.toggle('active', markdownPanelOpen);
    }

    if (markdownPanelOpen) {
        renderMarkdownPanel();
    }
}

function getLayoutRulePageNumber(test) {
    const explicitPage = layoutPageHelpers?.parsePositivePageNumber
        ? layoutPageHelpers.parsePositivePageNumber(test?.page)
        : Number.parseInt(test?.page, 10);
    return Number.isInteger(explicitPage) && explicitPage > 0 ? explicitPage : 1;
}

function getOrderedLayoutTestsForPage(targetPage = pageNum) {
    if (!currentTests?.test_rules) return [];
    if (readingOrderHelpers?.getPageReadingOrder) {
        return readingOrderHelpers.getPageReadingOrder(currentTests.test_rules, targetPage).map(entry => ({
            ...entry.rule,
            originalIndex: entry.originalIndex,
            normalizedRoIndex: entry.roIndex,
            rawRoIndex: entry.rawRoIndex,
            needsRoCommit: entry.needsCommit,
        }));
    }

    return currentTests.test_rules
        .map((test, index) => ({
            ...test,
            originalIndex: index,
            normalizedRoIndex: test.ro_index ?? index,
        }))
        .filter(test => test.type === 'layout' && getLayoutRulePageNumber(test) === targetPage);
}

// Display-only wrapper around getOrderedLayoutTestsForPage that
// honors the side-panel's UI filters (rule type, granularity, tags).
//
// IMPORTANT: do NOT call this from data-mutation paths — reading-
// order assignment, expected-markdown generation, layout-rule
// insertion/deletion all need the *full* per-page set so they don't
// silently drop rules the user has filtered out of view. Keep the filter
// out of generateExpectedMarkdown / reorderLayoutTests / commitPageReadingOrder
// so display state cannot change saved test data.
function getFilteredLayoutTestsForPage(targetPage = pageNum) {
    return getOrderedLayoutTestsForPage(targetPage).filter(ruleMatchesActiveFilters);
}

function getLayoutTestsForCurrentPage() {
    return getOrderedLayoutTestsForPage(pageNum);
}

function getDocumentLayoutPageNumbers() {
    if (!currentTests?.test_rules) return [];

    const pages = new Set();
    currentTests.test_rules.forEach((test) => {
        if (test?.type !== 'layout') return;
        const page = getLayoutRulePageNumber(test);
        if (Number.isInteger(page) && page > 0) {
            pages.add(page);
        }
    });

    return [...pages].sort((left, right) => left - right);
}

function getExpectedMarkdownPartsFromLayoutTests(orderedTests) {
    return orderedTests.map(test => {
        if (!hasLayoutContent(test)) return null;
        if (test.content.type === 'table') return test.content.html;
        return test.content.text;
    }).filter(Boolean);
}

function commitPageReadingOrder(targetPage, orderedItems = null) {
    if (!currentTests?.test_rules) return [];
    if (!orderedItems && readingOrderHelpers?.commitNormalizedPageReadingOrder) {
        return readingOrderHelpers.commitNormalizedPageReadingOrder(currentTests.test_rules, targetPage).map(entry => ({
            ...entry.rule,
            originalIndex: entry.originalIndex,
            normalizedRoIndex: entry.roIndex,
            rawRoIndex: entry.rawRoIndex,
            needsRoCommit: entry.needsCommit,
        }));
    }

    if (orderedItems) {
        orderedItems.forEach((item, index) => {
            const rule = currentTests.test_rules[item.originalIndex];
            if (rule?.type === 'layout') {
                rule.ro_index = index;
            }
        });
        return getOrderedLayoutTestsForPage(targetPage);
    }

    return [];
}

function normalizeLayoutPages(pages) {
    const uniquePages = [...new Set((pages || [])
        .map(page => Number.parseInt(page, 10))
        .filter(page => Number.isInteger(page) && page > 0))];
    uniquePages.forEach(targetPage => commitPageReadingOrder(targetPage));
}

function resolveLayoutInsertionBeforeOriginalIndex(orderedItems, insertionContext) {
    if (!Array.isArray(orderedItems) || !insertionContext || insertionContext.placement === 'append') {
        return null;
    }

    if (readingOrderHelpers?.resolveRelativeInsertBeforeOriginalIndex) {
        return readingOrderHelpers.resolveRelativeInsertBeforeOriginalIndex(
            orderedItems,
            insertionContext.anchorOriginalIndex,
            insertionContext.placement,
        );
    }

    const anchorPosition = orderedItems.findIndex(test => test.originalIndex === insertionContext.anchorOriginalIndex);
    if (anchorPosition === -1) {
        return null;
    }

    if (insertionContext.placement === 'before') {
        return insertionContext.anchorOriginalIndex;
    }

    const nextItem = orderedItems[anchorPosition + 1];
    return nextItem ? nextItem.originalIndex : null;
}

function appendLayoutTestToPage(testIndex, targetPage) {
    const orderedItems = getOrderedLayoutTestsForPage(targetPage);
    const currentPosition = orderedItems.findIndex(test => test.originalIndex === testIndex);
    if (currentPosition === -1) {
        commitPageReadingOrder(targetPage);
        return;
    }

    const reordered = [...orderedItems];
    const [moved] = reordered.splice(currentPosition, 1);
    reordered.push(moved);
    commitPageReadingOrder(targetPage, reordered);
}

function placeLayoutTestInReadingOrder(testIndex, targetPage, insertionContext = null) {
    const orderedItems = getOrderedLayoutTestsForPage(targetPage);
    const currentPosition = orderedItems.findIndex(test => test.originalIndex === testIndex);

    if (currentPosition === -1) {
        commitPageReadingOrder(targetPage);
        return;
    }

    const activeContext = insertionContext && insertionContext.page === targetPage
        ? insertionContext
        : null;

    if (!activeContext || activeContext.placement === 'append') {
        appendLayoutTestToPage(testIndex, targetPage);
        return;
    }

    const beforeOriginalIndex = resolveLayoutInsertionBeforeOriginalIndex(orderedItems, activeContext);
    if (beforeOriginalIndex === null || beforeOriginalIndex === undefined) {
        appendLayoutTestToPage(testIndex, targetPage);
        return;
    }

    if (readingOrderHelpers?.insertPageReadingOrderItem) {
        readingOrderHelpers.insertPageReadingOrderItem(
            currentTests.test_rules,
            targetPage,
            testIndex,
            beforeOriginalIndex,
        );
        return;
    }

    const reordered = [...orderedItems];
    const [moved] = reordered.splice(currentPosition, 1);
    const targetPosition = reordered.findIndex(test => test.originalIndex === beforeOriginalIndex);
    if (targetPosition === -1) {
        reordered.push(moved);
    } else {
        reordered.splice(targetPosition, 0, moved);
    }
    commitPageReadingOrder(targetPage, reordered);
}

function hasLayoutContent(test) {
    if (!test?.content) return false;
    if (test.content.type === 'table') {
        return Boolean((test.content.html || '').trim());
    }
    return Boolean((test.content.text || '').trim());
}

function getLayoutContentType(test) {
    if (test?.content?.type === 'table') {
        return 'table';
    }
    if (test?.canonical_class === 'Table') {
        return 'table';
    }
    if (formulaEditorUtils?.isFormulaLayout ? formulaEditorUtils.isFormulaLayout(test) : test?.canonical_class === 'Formula') {
        return 'formula';
    }
    return 'text';
}

function getLayoutContentValue(test) {
    if (getLayoutContentType(test) === 'table') {
        return test?.content?.html || '';
    }
    return test?.content?.text || '';
}

function getTableEditorSourceTitle(session) {
    if (!session) return 'Edit Table';

    if (session.source === 'card') {
        const rule = currentTests?.test_rules?.[session.testIndex];
        if (rule && rule.type === 'layout') {
            const page = getLayoutRulePageNumber(rule);
            const ordered = getOrderedLayoutTestsForPage(page);
            const entry = ordered.find(item => item.originalIndex === session.testIndex);
            const roLabel = Number.isInteger(entry?.normalizedRoIndex)
                ? `RO ${entry.normalizedRoIndex}`
                : `Page ${page}`;
            return `Edit Table: ${roLabel}`;
        }
        return 'Edit Table';
    }

    return editingIndex !== null ? 'Edit Table in Layout Form' : 'Add Table in Layout Form';
}

function getTableEditorSourceContext(session) {
    if (!session) return '';

    if (session.source === 'card') {
        return 'Saving updates this Reading Order item immediately and keeps the rest of the HTML block intact.';
    }

    return 'Saving updates the layout form HTML field. Use the form submit button afterwards to persist the rule.';
}

function getTableEditorFallbackMessage(reason) {
    switch (reason) {
        case 'no-table':
            return 'No <table> tag was found, so the workspace opened in raw HTML mode.';
        case 'multiple-tables':
            return 'Multiple tables were detected, so the workspace opened in raw HTML mode.';
        case 'malformed-table':
            return 'The table markup could not be isolated safely, so the workspace opened in raw HTML mode.';
        default:
            return '';
    }
}

function ensureTestPanelVisible(options = {}) {
    openTestPanel();

    const { minWidth = 520, maxWidth = 620 } = options;
    const panel = elements.testPanel;
    if (!panel) return;

    const currentWidth = panel.getBoundingClientRect().width
        || panel.offsetWidth
        || Number.parseFloat(window.getComputedStyle(panel).width)
        || 0;
    if (currentWidth >= minWidth) {
        return;
    }

    const splitPane = document.querySelector('.split-pane');
    const maxAvailableWidth = splitPane
        ? getMaxTestPanelWidth(splitPane.getBoundingClientRect())
        : maxWidth;
    const nextWidth = Math.min(minWidth, maxWidth, maxAvailableWidth);
    panel.style.width = `${nextWidth}px`;
}

function getSidebarTableEditorHost() {
    return {
        kind: 'sidebar',
        shell: elements.tableEditorShell,
        title: elements.tableEditorTitle,
        context: elements.tableEditorContext,
        status: elements.tableEditorStatus,
        surroundings: elements.tableEditorSurroundings,
        prefixBlock: elements.tableEditorPrefixBlock,
        prefixPreview: elements.tableEditorPrefixPreview,
        suffixBlock: elements.tableEditorSuffixBlock,
        suffixPreview: elements.tableEditorSuffixPreview,
        root: elements.tableEditorRoot,
        raw: elements.tableEditorRaw,
        modeHint: elements.tableEditorModeHint,
        rawToggle: elements.tableEditorRawToggle,
        cancel: elements.tableEditorCancel,
        save: elements.tableEditorSave,
        close: elements.tableEditorClose,
    };
}

function getActiveTableEditorHost() {
    return tableEditorSession?.host || getSidebarTableEditorHost();
}

function showSidebarTableEditorShell() {
    if (!elements.tableEditorShell || !elements.testPanel) return;
    elements.tableEditorShell.hidden = false;
    elements.tableEditorShell.classList.add('active');
    elements.testPanel.classList.add('table-editor-active');
}

function hideSidebarTableEditorShell() {
    if (!elements.tableEditorShell || !elements.testPanel) return;
    elements.tableEditorShell.hidden = true;
    elements.tableEditorShell.classList.remove('active');
    elements.testPanel.classList.remove('table-editor-active');
}

function createInlineTableEditorHost(contentEl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-table-editor';
    wrapper.addEventListener('click', (event) => event.stopPropagation());
    ['mousedown', 'pointerdown'].forEach(eventName => {
        wrapper.addEventListener(eventName, (event) => event.stopPropagation());
    });

    const context = document.createElement('div');
    context.className = 'markdown-table-editor-context';

    const status = document.createElement('div');
    status.className = 'table-editor-status markdown-table-editor-status';

    const surroundings = document.createElement('div');
    surroundings.className = 'table-editor-surroundings markdown-table-editor-surroundings';
    surroundings.hidden = true;

    const prefixBlock = document.createElement('div');
    prefixBlock.className = 'table-editor-context-block';
    prefixBlock.hidden = true;
    prefixBlock.innerHTML = `
        <div class="table-editor-context-label">Text before table</div>
        <div class="table-editor-context-preview"></div>
    `;
    const prefixPreview = prefixBlock.querySelector('.table-editor-context-preview');

    const suffixBlock = document.createElement('div');
    suffixBlock.className = 'table-editor-context-block';
    suffixBlock.hidden = true;
    suffixBlock.innerHTML = `
        <div class="table-editor-context-label">Text after table</div>
        <div class="table-editor-context-preview"></div>
    `;
    const suffixPreview = suffixBlock.querySelector('.table-editor-context-preview');

    surroundings.appendChild(prefixBlock);
    surroundings.appendChild(suffixBlock);

    const body = document.createElement('div');
    body.className = 'table-editor-body markdown-table-editor-body';

    const root = document.createElement('div');
    root.className = 'table-editor-root markdown-table-editor-root';

    const raw = document.createElement('textarea');
    raw.className = 'table-editor-raw markdown-table-editor-raw';
    raw.hidden = true;
    raw.spellcheck = false;
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        raw.addEventListener(eventName, (event) => event.stopPropagation());
    });
    raw.addEventListener('input', () => updateTableEditorDirtyState());

    body.appendChild(root);
    body.appendChild(raw);

    const actions = document.createElement('div');
    actions.className = 'table-editor-actions markdown-table-editor-actions';
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        actions.addEventListener(eventName, (event) => event.stopPropagation());
    });

    const modeHint = document.createElement('div');
    modeHint.className = 'table-editor-actions-copy';

    const actionButtons = document.createElement('div');
    actionButtons.className = 'table-editor-actions-buttons';

    const rawToggle = document.createElement('button');
    rawToggle.type = 'button';
    rawToggle.className = 'btn btn-secondary';
    rawToggle.textContent = 'Raw HTML';
    rawToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleTableEditorRawMode();
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', (event) => {
        event.stopPropagation();
        cancelMarkdownEdit();
    });

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-success';
    save.textContent = 'Save';
    save.addEventListener('click', async (event) => {
        event.stopPropagation();
        await saveTableEditorWorkspace();
    });

    actionButtons.appendChild(rawToggle);
    actionButtons.appendChild(cancel);
    actionButtons.appendChild(save);
    actions.appendChild(modeHint);
    actions.appendChild(actionButtons);

    wrapper.appendChild(context);
    wrapper.appendChild(status);
    wrapper.appendChild(surroundings);
    wrapper.appendChild(body);
    wrapper.appendChild(actions);

    contentEl.innerHTML = '';
    contentEl.appendChild(wrapper);

    return {
        kind: 'inline-card',
        wrapper,
        title: null,
        context,
        status,
        surroundings,
        prefixBlock,
        prefixPreview,
        suffixBlock,
        suffixPreview,
        root,
        raw,
        modeHint,
        rawToggle,
        cancel,
        save,
        close: null,
    };
}

function setTableEditorStatus(message = '', tone = 'info') {
    const host = getActiveTableEditorHost();
    if (!host?.status) return;
    host.status.textContent = message;
    host.status.className = host.kind === 'inline-card'
        ? 'table-editor-status markdown-table-editor-status'
        : 'table-editor-status';
    if (tone === 'warning') {
        host.status.classList.add('is-warning');
    } else if (tone === 'error') {
        host.status.classList.add('is-error');
    }
}

function renderTableEditorSurroundings(session) {
    const host = getActiveTableEditorHost();
    if (!host?.surroundings) return;

    const showPrefix = Boolean(session && !session.rawMode && session.prefixHtml && session.prefixHtml.trim());
    const showSuffix = Boolean(session && !session.rawMode && session.suffixHtml && session.suffixHtml.trim());

    host.surroundings.hidden = !(showPrefix || showSuffix);

    if (host.prefixBlock) {
        host.prefixBlock.hidden = !showPrefix;
    }
    if (host.suffixBlock) {
        host.suffixBlock.hidden = !showSuffix;
    }
    if (host.prefixPreview) {
        host.prefixPreview.innerHTML = showPrefix ? session.prefixHtml : '';
    }
    if (host.suffixPreview) {
        host.suffixPreview.innerHTML = showSuffix ? session.suffixHtml : '';
    }
}

function getActiveTableEditorFullHtml() {
    if (!tableEditorSession) return '';

    const host = getActiveTableEditorHost();
    if (tableEditorSession.rawMode) {
        return host?.raw?.value || '';
    }

    const tableHtml = tableEditorAdapter?.getTableEditorHtml
        ? tableEditorAdapter.getTableEditorHtml(tableEditorSession.editor)
        : tableEditorSession.tableHtml;

    return tableEditorUtils?.rebuildContentHtml
        ? tableEditorUtils.rebuildContentHtml({
            prefixHtml: tableEditorSession.prefixHtml,
            tableHtml: tableHtml || tableEditorUtils.getDefaultEmptyTableHtml(),
            suffixHtml: tableEditorSession.suffixHtml,
        })
        : `${tableEditorSession.prefixHtml || ''}${tableHtml || ''}${tableEditorSession.suffixHtml || ''}`;
}

function updateTableEditorDirtyState() {
    if (!tableEditorSession) return;
    tableEditorSession.dirty = getActiveTableEditorFullHtml() !== tableEditorSession.initialCommittedHtml;
}

function syncTableEditorSessionBuffer() {
    if (!tableEditorSession) return;

    const host = getActiveTableEditorHost();
    if (tableEditorSession.rawMode) {
        tableEditorSession.rawHtml = host?.raw?.value || tableEditorSession.rawHtml || tableEditorSession.initialCommittedHtml;
    } else if (tableEditorSession.editor && tableEditorAdapter?.getTableEditorHtml) {
        tableEditorSession.tableHtml = tableEditorAdapter.getTableEditorHtml(tableEditorSession.editor)
            || tableEditorSession.tableHtml;
        tableEditorSession.rawHtml = getActiveTableEditorFullHtml();
    }

    updateTableEditorDirtyState();
}

function removeTableEditorInputTracking() {
    if (!tableEditorSession?.editorTracking) return;

    const { target, handler } = tableEditorSession.editorTracking;
    if (target && handler) {
        ['input', 'keyup', 'mouseup'].forEach(eventName => {
            target.removeEventListener(eventName, handler);
        });
    }
    tableEditorSession.editorTracking = null;
}

function attachTableEditorInputTracking(editorInstance) {
    const target = editorInstance?.core?.context?.element?.wysiwyg;
    if (!target) return;

    const handler = () => updateTableEditorDirtyState();
    ['input', 'keyup', 'mouseup'].forEach(eventName => {
        target.addEventListener(eventName, handler);
    });
    tableEditorSession.editorTracking = { target, handler };
}

function destroyTableEditorInstance() {
    if (!tableEditorSession) return;
    removeTableEditorInputTracking();

    if (tableEditorSession.editor && tableEditorAdapter?.destroyTableEditor) {
        tableEditorAdapter.destroyTableEditor(tableEditorSession.editor);
    }
    tableEditorSession.editor = null;

    const host = getActiveTableEditorHost();
    if (host?.root) {
        host.root.innerHTML = '';
        host.root.hidden = false;
    }
}

function updateTableEditorWorkspaceCopy() {
    if (!tableEditorSession) return;

    const host = getActiveTableEditorHost();
    if (host?.title) {
        host.title.textContent = getTableEditorSourceTitle(tableEditorSession);
    }
    if (host?.context) {
        host.context.textContent = tableEditorSession.rawMode
            ? getTableEditorSourceContext(tableEditorSession)
            : (
                tableEditorSession.source === 'card'
                    ? 'Editing inline. Use the table cell popup controls for rows, columns, merge, and split.'
                    : getTableEditorSourceContext(tableEditorSession)
            );
    }
    if (host?.modeHint) {
        host.modeHint.textContent = tableEditorSession.rawMode
            ? 'Raw fallback mode preserves the full HTML block. Switch back once there is exactly one editable table.'
            : 'Click a cell to use SunEditor’s built-in table controls. Cancel exits without saving.';
    }
    if (host?.rawToggle) {
        host.rawToggle.textContent = tableEditorSession.rawMode ? 'Visual Editor' : 'Raw HTML';
    }
    if (host?.save) {
        host.save.disabled = Boolean(tableEditorSession.loading);
    }
    renderTableEditorSurroundings(tableEditorSession);
}

function initializeTableEditor(tableHtml) {
    const host = getActiveTableEditorHost();
    if (!tableEditorSession || !host?.root) return;

    tableEditorSession.loading = true;
    updateTableEditorWorkspaceCopy();

    try {
        tableEditorSession.editor = tableEditorAdapter?.createTableEditor
            ? tableEditorAdapter.createTableEditor(host.root, tableHtml, {})
            : null;
        attachTableEditorInputTracking(tableEditorSession.editor);
        setTableEditorStatus('', 'info');
    } catch (error) {
        console.error('Failed to initialize visual table editor:', error);
        tableEditorSession.rawMode = true;
        tableEditorSession.rawHtml = tableEditorSession.initialCommittedHtml;
        setTableEditorStatus('SunEditor failed to initialize. Using raw HTML fallback.', 'warning');
    } finally {
        tableEditorSession.loading = false;
        updateTableEditorWorkspaceCopy();
        if (tableEditorSession.rawMode && host?.raw) {
            host.raw.hidden = false;
            host.raw.value = tableEditorSession.rawHtml || tableEditorSession.initialCommittedHtml;
            host.root.hidden = true;
            host.raw.focus();
        }
        updateTableEditorDirtyState();
    }
}

function reattachTableEditorWorkspace() {
    const host = getActiveTableEditorHost();
    if (!tableEditorSession || !host) return;

    if (host.root) {
        host.root.hidden = false;
    }
    if (host.raw) {
        host.raw.hidden = !tableEditorSession.rawMode;
        host.raw.value = tableEditorSession.rawHtml || tableEditorSession.initialCommittedHtml;
    }

    updateTableEditorWorkspaceCopy();

    if (tableEditorSession.rawMode) {
        if (host.root) {
            host.root.hidden = true;
        }
        host.raw?.focus();
        return;
    }

    initializeTableEditor(tableEditorSession.tableHtml || tableEditorUtils.getDefaultEmptyTableHtml());
}

function closeTableEditorWorkspace(options = {}) {
    if (!tableEditorSession) return true;

    const {
        discardChanges = false,
        suppressWarning = false,
        rerenderMarkdown = true,
        preserveMarkdownScroll = false,
    } = options;

    syncTableEditorSessionBuffer();

    if (tableEditorSession.dirty && !discardChanges && !suppressWarning) {
        const confirmed = confirm('Discard unsaved table editor changes?');
        if (!confirmed) {
            return false;
        }
    }

    const source = tableEditorSession.source;
    destroyTableEditorInstance();

    const host = getActiveTableEditorHost();
    if (host?.raw) {
        host.raw.value = '';
        host.raw.hidden = true;
    }
    setTableEditorStatus('', 'info');

    if (source === 'form') {
        hideSidebarTableEditorShell();
    }

    tableEditorSession = null;

    if (source === 'card') {
        markdownEditingIndex = null;
        if (rerenderMarkdown && markdownPanelOpen) {
            renderMarkdownPanel({ preserveScroll: preserveMarkdownScroll });
        }
    }

    return true;
}

function prepareInlineTableEditorForMarkdownRender() {
    if (!tableEditorSession || tableEditorSession.source !== 'card') return;
    syncTableEditorSessionBuffer();
    destroyTableEditorInstance();
}

function openTableEditorWorkspace(sessionInput) {
    if (formulaEditorSession && !closeFormulaEditorWorkspace({
        rerenderMarkdown: false,
        preserveMarkdownScroll: sessionInput.source === 'card',
    })) {
        return false;
    }

    if (tableEditorSession && !closeTableEditorWorkspace({
        rerenderMarkdown: false,
        preserveMarkdownScroll: sessionInput.source === 'card',
    })) {
        return false;
    }

    if (sessionInput.source === 'form') {
        ensureTestPanelVisible();
        markdownEditingIndex = null;
    }

    const initialHtml = String(sessionInput?.initialHtml || '');
    const extracted = tableEditorUtils?.extractEditableTableSegment
        ? tableEditorUtils.extractEditableTableSegment(initialHtml)
        : {
            mode: 'visual',
            reason: null,
            prefixHtml: '',
            tableHtml: initialHtml || '<table><tbody><tr><td></td></tr></tbody></table>',
            suffixHtml: '',
        };
    const fallbackHtml = initialHtml.trim() || tableEditorUtils.getDefaultEmptyTableHtml();
    const initialCommittedHtml = extracted.mode === 'visual'
        ? tableEditorUtils.rebuildContentHtml({
            prefixHtml: extracted.prefixHtml,
            tableHtml: extracted.tableHtml || tableEditorUtils.getDefaultEmptyTableHtml(),
            suffixHtml: extracted.suffixHtml,
        })
        : fallbackHtml;

    tableEditorSession = {
        ...sessionInput,
        host: sessionInput.host || getSidebarTableEditorHost(),
        editor: null,
        editorTracking: null,
        rawMode: extracted.mode !== 'visual',
        loading: false,
        dirty: false,
        unsupportedReason: extracted.reason,
        prefixHtml: extracted.mode === 'visual' ? extracted.prefixHtml : '',
        suffixHtml: extracted.mode === 'visual' ? extracted.suffixHtml : '',
        tableHtml: extracted.mode === 'visual' ? extracted.tableHtml : tableEditorUtils.getDefaultEmptyTableHtml(),
        rawHtml: extracted.mode === 'visual' ? initialCommittedHtml : fallbackHtml,
        initialCommittedHtml,
    };

    if (tableEditorSession.source === 'form') {
        showSidebarTableEditorShell();
    }

    reattachTableEditorWorkspace();

    if (tableEditorSession.rawMode) {
        setTableEditorStatus(getTableEditorFallbackMessage(tableEditorSession.unsupportedReason), 'warning');
    }

    return true;
}

function toggleTableEditorRawMode() {
    if (!tableEditorSession) return;

    const host = getActiveTableEditorHost();

    if (tableEditorSession.rawMode) {
        const rawHtml = host?.raw?.value || '';
        const extracted = tableEditorUtils?.extractEditableTableSegment
            ? tableEditorUtils.extractEditableTableSegment(rawHtml)
            : null;

        if (!extracted || extracted.mode !== 'visual') {
            setTableEditorStatus(getTableEditorFallbackMessage(extracted?.reason || 'malformed-table'), 'warning');
            showToast('Raw HTML must contain exactly one table to reopen the visual editor', 'error');
            return;
        }

        tableEditorSession.rawMode = false;
        tableEditorSession.unsupportedReason = null;
        tableEditorSession.prefixHtml = extracted.prefixHtml;
        tableEditorSession.suffixHtml = extracted.suffixHtml;
        tableEditorSession.tableHtml = extracted.tableHtml || tableEditorUtils.getDefaultEmptyTableHtml();
        if (host?.raw) {
            host.raw.hidden = true;
        }
        if (host?.root) {
            host.root.hidden = false;
        }
        updateTableEditorWorkspaceCopy();
        initializeTableEditor(tableEditorSession.tableHtml);
        return;
    }

    tableEditorSession.rawHtml = getActiveTableEditorFullHtml();
    destroyTableEditorInstance();
    tableEditorSession.rawMode = true;
    if (host?.root) {
        host.root.hidden = true;
    }
    if (host?.raw) {
        host.raw.hidden = false;
        host.raw.value = tableEditorSession.rawHtml;
        host.raw.focus();
    }
    updateTableEditorWorkspaceCopy();
    updateTableEditorDirtyState();
}

async function saveTableEditorWorkspace() {
    if (!tableEditorSession) return;

    const session = tableEditorSession;
    const host = getActiveTableEditorHost();
    let nextHtml = '';

    if (session.rawMode) {
        nextHtml = host?.raw?.value || '';
    } else {
        const currentTableHtml = tableEditorAdapter?.getTableEditorHtml
            ? tableEditorAdapter.getTableEditorHtml(session.editor)
            : '';
        const normalizedTableHtml = tableEditorUtils?.normalizeSavedTableHtml
            ? tableEditorUtils.normalizeSavedTableHtml(currentTableHtml)
            : currentTableHtml;
        nextHtml = tableEditorUtils?.rebuildContentHtml
            ? tableEditorUtils.rebuildContentHtml({
                prefixHtml: session.prefixHtml,
                tableHtml: normalizedTableHtml,
                suffixHtml: session.suffixHtml,
            })
            : normalizedTableHtml;
    }

    if (session.source === 'card') {
        const rule = currentTests?.test_rules?.[session.testIndex];
        if (!rule || rule.type !== 'layout') {
            showToast('Layout element no longer exists', 'error');
            return;
        }

        if (nextHtml.trim()) {
            rule.content = { type: 'table', html: nextHtml };
        } else {
            delete rule.content;
        }

        const savedTests = await saveTests('layout-table-editor');
        if (!savedTests) return;

        const targetIndex = session.testIndex;
        closeTableEditorWorkspace({ discardChanges: true, suppressWarning: true, rerenderMarkdown: false });
        renderTestList();
        if (markdownPanelOpen) {
            renderMarkdownPanel({ preserveScroll: true });
        }
        selectLayoutTest(targetIndex, {
            preserveMarkdownScroll: true,
            scrollMarkdownCard: false,
        });
        showToast(nextHtml.trim() ? 'Table updated' : 'Table content cleared', 'success');
        return;
    }

    if (session.source === 'form') {
        const htmlRadio = document.querySelector('input[name="layout-content-type"][value="html"]');
        const field = session.formFieldId ? document.getElementById(session.formFieldId) : null;

        if (htmlRadio) {
            htmlRadio.checked = true;
        }
        if (field) {
            field.value = nextHtml;
        }
        toggleLayoutContentInput();
        closeTableEditorWorkspace({ discardChanges: true, suppressWarning: true });
        if (field) {
            field.focus();
            field.setSelectionRange(field.value.length, field.value.length);
        }
        showToast('Table HTML updated in form', 'success');
    }
}

function renderInlineTableEditor(contentEl, testIndex, test) {
    const host = createInlineTableEditorHost(contentEl);

    if (tableEditorSession?.source === 'card' && tableEditorSession.testIndex === testIndex) {
        tableEditorSession.host = host;
        reattachTableEditorWorkspace();
        if (tableEditorSession.rawMode) {
            setTableEditorStatus(getTableEditorFallbackMessage(tableEditorSession.unsupportedReason), 'warning');
        }
        return;
    }

    openTableEditorWorkspace({
        source: 'card',
        testIndex,
        formFieldId: null,
        host,
        initialHtml: getLayoutContentValue(test) || tableEditorUtils.getDefaultEmptyTableHtml(),
    });
}

function beginTableCardEdit(testIndex) {
    const test = currentTests?.test_rules?.[testIndex];
    if (!test || test.type !== 'layout' || getLayoutContentType(test) !== 'table') {
        return;
    }

    if (tableEditorSession?.source === 'card' && tableEditorSession.testIndex === testIndex) {
        return;
    }

    markdownEditingIndex = testIndex;
    if (selectedLayoutTestIndex === testIndex) {
        if (markdownPanelOpen) {
            renderMarkdownPanel({ preserveScroll: true });
        }
        return;
    }

    selectLayoutTest(testIndex, {
        preserveMarkdownScroll: true,
        scrollMarkdownCard: false,
        scrollTestListItem: false,
    });
}

function beginTableFormEdit() {
    const htmlRadio = document.querySelector('input[name="layout-content-type"][value="html"]');
    const field = document.getElementById('layout-content');

    if (htmlRadio) {
        htmlRadio.checked = true;
    }
    toggleLayoutContentInput();

    openTableEditorWorkspace({
        source: 'form',
        testIndex: editingIndex,
        formFieldId: 'layout-content',
        initialHtml: field?.value || tableEditorUtils.getDefaultEmptyTableHtml(),
    });
}

function focusLayoutRawHtmlField() {
    const htmlRadio = document.querySelector('input[name="layout-content-type"][value="html"]');
    if (htmlRadio) {
        htmlRadio.checked = true;
    }
    toggleLayoutContentInput();
    document.getElementById('layout-content')?.focus();
}

function closeContentEditorWorkspaces(options = {}) {
    if (!closeTableEditorWorkspace(options)) return false;
    if (!closeFormulaEditorWorkspace(options)) return false;
    return true;
}

function getMathLiveApi() {
    return window.MathLive || null;
}

function getFormulaValidationErrors(latex) {
    const normalizedLatex = String(latex || '').trim();
    if (!normalizedLatex) return [];

    const mathLive = getMathLiveApi();
    if (typeof mathLive?.validateLatex !== 'function') {
        return [];
    }

    try {
        const validation = mathLive.validateLatex(normalizedLatex);
        return Array.isArray(validation) ? validation : [];
    } catch (error) {
        return [error?.message || 'Validation failed'];
    }
}

function getFormulaValidationMessage(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    const firstError = errors[0];
    if (typeof firstError === 'string') return firstError;
    if (firstError && typeof firstError.message === 'string') return firstError.message;
    return 'MathLive reported a LaTeX parse warning.';
}

function getFormulaPreviewState(rawSource) {
    const renderState = formulaEditorUtils?.getFormulaRenderState
        ? formulaEditorUtils.getFormulaRenderState(rawSource)
        : {
            rawSource: String(rawSource || ''),
            renderableLatex: String(rawSource || '').trim(),
            isEmpty: !String(rawSource || '').trim(),
            displayMode: true,
        };

    if (renderState.isEmpty) {
        return {
            mode: 'empty',
            renderState,
            warning: '',
            markup: '',
        };
    }

    const validationErrors = getFormulaValidationErrors(renderState.renderableLatex);
    if (validationErrors.length > 0) {
        return {
            mode: 'raw-fallback',
            renderState,
            warning: getFormulaValidationMessage(validationErrors) || 'Invalid LaTeX',
            markup: '',
        };
    }

    const mathLive = getMathLiveApi();
    if (typeof mathLive?.convertLatexToMarkup !== 'function') {
        return {
            mode: 'raw-fallback',
            renderState,
            warning: 'MathLive preview rendering is unavailable in this browser session.',
            markup: '',
        };
    }

    try {
        return {
            mode: 'rendered',
            renderState,
            warning: '',
            markup: mathLive.convertLatexToMarkup(renderState.renderableLatex, {
                displayMode: renderState.displayMode !== false,
            }),
        };
    } catch (error) {
        return {
            mode: 'raw-fallback',
            renderState,
            warning: error?.message || 'MathLive could not render this LaTeX source.',
            markup: '',
        };
    }
}

function createFormulaPreviewNode(rawSource, options = {}) {
    const preview = document.createElement('div');
    preview.className = 'markdown-formula-preview';
    const previewState = getFormulaPreviewState(rawSource);

    if (previewState.mode === 'empty') {
        preview.innerHTML = '<div class="markdown-card-placeholder">No attributed formula yet. Use Add Formula to attach LaTeX for this layout element.</div>';
        return preview;
    }

    if (previewState.mode === 'rendered') {
        preview.classList.add('is-rendered');
        const rendered = document.createElement('div');
        rendered.className = 'markdown-formula-preview-rendered';
        rendered.innerHTML = previewState.markup;
        preview.appendChild(rendered);
        return preview;
    }

    preview.classList.add('is-invalid');

    const warningRow = document.createElement('div');
    warningRow.className = 'markdown-formula-warning';

    const badge = document.createElement('span');
    badge.className = 'markdown-formula-warning-badge';
    badge.textContent = options.warningLabel || 'LaTeX Warning';

    const message = document.createElement('span');
    message.className = 'markdown-formula-warning-copy';
    message.textContent = previewState.warning || 'Rendering fell back to raw source.';

    warningRow.appendChild(badge);
    warningRow.appendChild(message);

    const rawBlock = document.createElement('pre');
    rawBlock.className = 'markdown-formula-raw';
    rawBlock.textContent = previewState.renderState.rawSource || '';

    preview.appendChild(warningRow);
    preview.appendChild(rawBlock);
    return preview;
}

function getFormulaEditorSourceTitle(session) {
    if (!session) return 'Edit Formula';

    if (session.source === 'card') {
        const rule = currentTests?.test_rules?.[session.testIndex];
        if (rule && rule.type === 'layout') {
            const page = getLayoutRulePageNumber(rule);
            const ordered = getOrderedLayoutTestsForPage(page);
            const entry = ordered.find(item => item.originalIndex === session.testIndex);
            const roLabel = Number.isInteger(entry?.normalizedRoIndex)
                ? `RO ${entry.normalizedRoIndex}`
                : `Page ${page}`;
            return `Edit Formula: ${roLabel}`;
        }
        return 'Edit Formula';
    }

    return editingIndex !== null ? 'Edit Formula in Layout Form' : 'Add Formula in Layout Form';
}

function getFormulaEditorSourceContext(session) {
    if (!session) return '';

    if (session.source === 'card') {
        return 'Saving updates this Reading Order formula immediately. Use Raw LaTeX if you want full source control.';
    }

    return 'Saving updates the layout form text field. Submit the layout form afterwards to persist the rule.';
}

function getSidebarFormulaEditorHost() {
    return {
        kind: 'sidebar',
        shell: elements.formulaEditorShell,
        title: elements.formulaEditorTitle,
        context: elements.formulaEditorContext,
        status: elements.formulaEditorStatus,
        root: elements.formulaEditorRoot,
        raw: elements.formulaEditorRaw,
        modeHint: elements.formulaEditorModeHint,
        rawToggle: elements.formulaEditorRawToggle,
        cancel: elements.formulaEditorCancel,
        save: elements.formulaEditorSave,
        close: elements.formulaEditorClose,
    };
}

function getActiveFormulaEditorHost() {
    return formulaEditorSession?.host || getSidebarFormulaEditorHost();
}

function showSidebarFormulaEditorShell() {
    if (!elements.formulaEditorShell || !elements.testPanel) return;
    elements.formulaEditorShell.hidden = false;
    elements.formulaEditorShell.classList.add('active');
    elements.testPanel.classList.add('formula-editor-active');
}

function hideSidebarFormulaEditorShell() {
    if (!elements.formulaEditorShell || !elements.testPanel) return;
    elements.formulaEditorShell.hidden = true;
    elements.formulaEditorShell.classList.remove('active');
    elements.testPanel.classList.remove('formula-editor-active');
}

function createInlineFormulaEditorHost(contentEl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-formula-editor';
    wrapper.addEventListener('click', (event) => event.stopPropagation());
    ['mousedown', 'pointerdown'].forEach(eventName => {
        wrapper.addEventListener(eventName, (event) => event.stopPropagation());
    });

    const context = document.createElement('div');
    context.className = 'formula-editor-context markdown-formula-editor-context';

    const status = document.createElement('div');
    status.className = 'formula-editor-status markdown-formula-editor-status';

    const body = document.createElement('div');
    body.className = 'formula-editor-body markdown-formula-editor-body';

    const root = document.createElement('div');
    root.className = 'formula-editor-root markdown-formula-editor-root';

    const raw = document.createElement('textarea');
    raw.className = 'formula-editor-raw markdown-formula-editor-raw';
    raw.hidden = true;
    raw.spellcheck = false;
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        raw.addEventListener(eventName, (event) => event.stopPropagation());
    });
    raw.addEventListener('input', () => {
        syncFormulaEditorSessionBuffer();
        updateFormulaEditorStatus();
    });

    body.appendChild(root);
    body.appendChild(raw);

    const actions = document.createElement('div');
    actions.className = 'formula-editor-actions markdown-formula-editor-actions';
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        actions.addEventListener(eventName, (event) => event.stopPropagation());
    });

    const modeHint = document.createElement('div');
    modeHint.className = 'formula-editor-actions-copy';

    const actionButtons = document.createElement('div');
    actionButtons.className = 'formula-editor-actions-buttons';

    const rawToggle = document.createElement('button');
    rawToggle.type = 'button';
    rawToggle.className = 'btn btn-secondary';
    rawToggle.textContent = 'Raw LaTeX';
    rawToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFormulaEditorRawMode();
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', (event) => {
        event.stopPropagation();
        cancelMarkdownEdit();
    });

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-success';
    save.textContent = 'Save';
    save.addEventListener('click', async (event) => {
        event.stopPropagation();
        await saveFormulaEditorWorkspace();
    });

    actionButtons.appendChild(rawToggle);
    actionButtons.appendChild(cancel);
    actionButtons.appendChild(save);
    actions.appendChild(modeHint);
    actions.appendChild(actionButtons);

    wrapper.appendChild(context);
    wrapper.appendChild(status);
    wrapper.appendChild(body);
    wrapper.appendChild(actions);

    contentEl.innerHTML = '';
    contentEl.appendChild(wrapper);

    return {
        kind: 'inline-card',
        wrapper,
        shell: wrapper,
        title: null,
        context,
        status,
        root,
        raw,
        modeHint,
        rawToggle,
        cancel,
        save,
        close: null,
    };
}

function setFormulaEditorStatus(message = '', tone = 'info') {
    const host = getActiveFormulaEditorHost();
    if (!host?.status) return;
    host.status.textContent = message;
    host.status.className = host.kind === 'inline-card'
        ? 'formula-editor-status markdown-formula-editor-status'
        : 'formula-editor-status';
    if (tone === 'warning') {
        host.status.classList.add('is-warning');
    } else if (tone === 'error') {
        host.status.classList.add('is-error');
    }
}

function rebuildFormulaEditorSource(latex) {
    if (!formulaEditorSession) return String(latex || '');
    return formulaEditorUtils?.rebuildFormulaSource
        ? formulaEditorUtils.rebuildFormulaSource(latex, {
            delimiter: formulaEditorSession.delimiter,
            leadingWhitespace: formulaEditorSession.leadingWhitespace,
            trailingWhitespace: formulaEditorSession.trailingWhitespace,
        })
        : String(latex || '');
}

function getActiveFormulaEditorSource() {
    if (!formulaEditorSession) return '';

    const host = getActiveFormulaEditorHost();
    if (formulaEditorSession.rawMode) {
        return host?.raw?.value || '';
    }

    const latex = formulaEditorAdapter?.getFormulaEditorValue
        ? formulaEditorAdapter.getFormulaEditorValue(formulaEditorSession.editor)
        : formulaEditorSession.renderableLatex;
    return rebuildFormulaEditorSource(latex || '');
}

function updateFormulaEditorDirtyState() {
    if (!formulaEditorSession) return;
    formulaEditorSession.dirty = getActiveFormulaEditorSource() !== formulaEditorSession.initialCommittedLatex;
}

function syncFormulaEditorSessionBuffer() {
    if (!formulaEditorSession) return;

    const host = getActiveFormulaEditorHost();
    if (formulaEditorSession.rawMode) {
        formulaEditorSession.rawLatex = host?.raw?.value || '';
        const rawState = formulaEditorUtils?.getFormulaRenderState
            ? formulaEditorUtils.getFormulaRenderState(formulaEditorSession.rawLatex)
            : null;
        if (rawState) {
            formulaEditorSession.renderableLatex = rawState.renderableLatex;
            formulaEditorSession.delimiter = rawState.delimiter;
            formulaEditorSession.displayMode = rawState.displayMode;
            formulaEditorSession.leadingWhitespace = rawState.leadingWhitespace;
            formulaEditorSession.trailingWhitespace = rawState.trailingWhitespace;
        }
    } else {
        formulaEditorSession.renderableLatex = formulaEditorAdapter?.getFormulaEditorValue
            ? formulaEditorAdapter.getFormulaEditorValue(formulaEditorSession.editor)
            : formulaEditorSession.renderableLatex;
        formulaEditorSession.rawLatex = rebuildFormulaEditorSource(formulaEditorSession.renderableLatex || '');
    }

    updateFormulaEditorDirtyState();
}

function updateFormulaEditorStatus() {
    if (!formulaEditorSession) return;

    syncFormulaEditorSessionBuffer();

    if (formulaEditorSession.rawMode) {
        const validationErrors = getFormulaValidationErrors(formulaEditorSession.renderableLatex);
        if (validationErrors.length > 0) {
            setFormulaEditorStatus(getFormulaValidationMessage(validationErrors), 'warning');
            return;
        }
        setFormulaEditorStatus(
            'Raw mode preserves the exact stored source, including outer delimiters. Saving an empty value clears the formula.',
            'info',
        );
        return;
    }

    if (!formulaEditorSession.renderableLatex.trim()) {
        setFormulaEditorStatus('Formula is empty. Save to clear this Reading Order item or switch to Raw LaTeX.', 'info');
        return;
    }

    const validationErrors = getFormulaValidationErrors(formulaEditorSession.renderableLatex);
    if (validationErrors.length > 0) {
        setFormulaEditorStatus(getFormulaValidationMessage(validationErrors), 'warning');
        return;
    }

    setFormulaEditorStatus('', 'info');
}

function destroyFormulaEditorInstance() {
    if (!formulaEditorSession) return;

    if (formulaEditorSession.editor && formulaEditorAdapter?.destroyFormulaEditor) {
        formulaEditorAdapter.destroyFormulaEditor(formulaEditorSession.editor);
    }
    formulaEditorSession.editor = null;

    const host = getActiveFormulaEditorHost();
    if (host?.root) {
        host.root.innerHTML = '';
        host.root.hidden = false;
    }
}

function updateFormulaEditorWorkspaceCopy() {
    if (!formulaEditorSession) return;

    const host = getActiveFormulaEditorHost();
    if (host?.title) {
        host.title.textContent = getFormulaEditorSourceTitle(formulaEditorSession);
    }
    if (host?.context) {
        host.context.textContent = getFormulaEditorSourceContext(formulaEditorSession);
    }
    if (host?.modeHint) {
        host.modeHint.textContent = formulaEditorSession.rawMode
            ? 'Raw mode gives you exact LaTeX source control. Switch back to see the interactive math field.'
            : 'Type directly into the math field. Cancel exits without saving.';
    }
    if (host?.rawToggle) {
        host.rawToggle.textContent = formulaEditorSession.rawMode ? 'Visual Editor' : 'Raw LaTeX';
    }
    if (host?.save) {
        host.save.disabled = Boolean(formulaEditorSession.loading);
    }
}

function handleFormulaEditorInput() {
    updateFormulaEditorStatus();
}

function initializeFormulaEditor(initialLatex) {
    const host = getActiveFormulaEditorHost();
    if (!formulaEditorSession || !host?.root) return;

    formulaEditorSession.loading = true;
    updateFormulaEditorWorkspaceCopy();

    try {
        formulaEditorSession.editor = formulaEditorAdapter?.createFormulaEditor
            ? formulaEditorAdapter.createFormulaEditor(host.root, initialLatex, {
                onInput: handleFormulaEditorInput,
            })
            : null;
        setFormulaEditorStatus('', 'info');
    } catch (error) {
        console.error('Failed to initialize formula editor:', error);
        formulaEditorSession.rawMode = true;
        formulaEditorSession.rawLatex = formulaEditorSession.initialCommittedLatex;
        setFormulaEditorStatus('MathLive failed to initialize. Using raw LaTeX fallback.', 'warning');
    } finally {
        formulaEditorSession.loading = false;
        updateFormulaEditorWorkspaceCopy();
        if (formulaEditorSession.rawMode && host?.raw) {
            host.raw.hidden = false;
            host.raw.value = formulaEditorSession.rawLatex || formulaEditorSession.initialCommittedLatex;
            host.root.hidden = true;
            host.raw.focus();
        }
        updateFormulaEditorStatus();
    }
}

function reattachFormulaEditorWorkspace() {
    const host = getActiveFormulaEditorHost();
    if (!formulaEditorSession || !host) return;

    if (host.root) {
        host.root.hidden = false;
    }
    if (host.raw) {
        host.raw.hidden = !formulaEditorSession.rawMode;
        host.raw.value = formulaEditorSession.rawLatex || formulaEditorSession.initialCommittedLatex;
    }

    updateFormulaEditorWorkspaceCopy();

    if (formulaEditorSession.rawMode) {
        if (host.root) {
            host.root.hidden = true;
        }
        host.raw?.focus();
        updateFormulaEditorStatus();
        return;
    }

    initializeFormulaEditor(formulaEditorSession.renderableLatex || '');
}

function closeFormulaEditorWorkspace(options = {}) {
    if (!formulaEditorSession) return true;

    const {
        discardChanges = false,
        suppressWarning = false,
        rerenderMarkdown = true,
        preserveMarkdownScroll = false,
    } = options;

    syncFormulaEditorSessionBuffer();

    if (formulaEditorSession.dirty && !discardChanges && !suppressWarning) {
        const confirmed = confirm('Discard unsaved formula editor changes?');
        if (!confirmed) {
            return false;
        }
    }

    const source = formulaEditorSession.source;
    destroyFormulaEditorInstance();

    const host = getActiveFormulaEditorHost();
    if (host?.raw) {
        host.raw.value = '';
        host.raw.hidden = true;
    }
    setFormulaEditorStatus('', 'info');

    if (source === 'form') {
        hideSidebarFormulaEditorShell();
    }

    formulaEditorSession = null;

    if (source === 'card') {
        markdownEditingIndex = null;
        if (rerenderMarkdown && markdownPanelOpen) {
            renderMarkdownPanel({ preserveScroll: preserveMarkdownScroll });
        }
    }

    return true;
}

function prepareInlineFormulaEditorForMarkdownRender() {
    if (!formulaEditorSession || formulaEditorSession.source !== 'card') return;
    syncFormulaEditorSessionBuffer();
    destroyFormulaEditorInstance();
}

function openFormulaEditorWorkspace(sessionInput) {
    if (tableEditorSession && !closeTableEditorWorkspace({
        rerenderMarkdown: false,
        preserveMarkdownScroll: sessionInput.source === 'card',
    })) {
        return false;
    }
    if (formulaEditorSession && !closeFormulaEditorWorkspace({
        rerenderMarkdown: false,
        preserveMarkdownScroll: sessionInput.source === 'card',
    })) {
        return false;
    }

    if (sessionInput.source === 'form') {
        ensureTestPanelVisible({ minWidth: 540, maxWidth: 660 });
        markdownEditingIndex = null;
    }

    const rawLatex = String(sessionInput?.initialLatex || '');
    const renderState = formulaEditorUtils?.getFormulaRenderState
        ? formulaEditorUtils.getFormulaRenderState(rawLatex)
        : {
            rawSource: rawLatex,
            renderableLatex: rawLatex.trim(),
            displayMode: true,
            delimiter: null,
            leadingWhitespace: '',
            trailingWhitespace: '',
        };

    formulaEditorSession = {
        ...sessionInput,
        host: sessionInput.host || getSidebarFormulaEditorHost(),
        editor: null,
        rawMode: false,
        loading: false,
        dirty: false,
        initialCommittedLatex: rawLatex,
        rawLatex: rawLatex,
        renderableLatex: renderState.renderableLatex,
        delimiter: renderState.delimiter,
        displayMode: renderState.displayMode,
        leadingWhitespace: renderState.leadingWhitespace,
        trailingWhitespace: renderState.trailingWhitespace,
    };

    if (formulaEditorSession.source === 'form') {
        showSidebarFormulaEditorShell();
    }

    reattachFormulaEditorWorkspace();
    return true;
}

function toggleFormulaEditorRawMode() {
    if (!formulaEditorSession) return;

    const host = getActiveFormulaEditorHost();

    if (formulaEditorSession.rawMode) {
        const rawLatex = host?.raw?.value || '';
        const renderState = formulaEditorUtils?.getFormulaRenderState
            ? formulaEditorUtils.getFormulaRenderState(rawLatex)
            : null;

        formulaEditorSession.rawMode = false;
        formulaEditorSession.rawLatex = rawLatex;
        formulaEditorSession.renderableLatex = renderState?.renderableLatex || rawLatex.trim();
        formulaEditorSession.delimiter = renderState?.delimiter || null;
        formulaEditorSession.displayMode = renderState?.displayMode !== false;
        formulaEditorSession.leadingWhitespace = renderState?.leadingWhitespace || '';
        formulaEditorSession.trailingWhitespace = renderState?.trailingWhitespace || '';
        if (host?.raw) {
            host.raw.hidden = true;
        }
        if (host?.root) {
            host.root.hidden = false;
        }
        updateFormulaEditorWorkspaceCopy();
        initializeFormulaEditor(formulaEditorSession.renderableLatex);
        return;
    }

    formulaEditorSession.rawLatex = getActiveFormulaEditorSource();
    destroyFormulaEditorInstance();
    formulaEditorSession.rawMode = true;
    if (host?.root) {
        host.root.hidden = true;
    }
    if (host?.raw) {
        host.raw.hidden = false;
        host.raw.value = formulaEditorSession.rawLatex;
        host.raw.focus();
    }
    updateFormulaEditorWorkspaceCopy();
    updateFormulaEditorStatus();
}

async function saveFormulaEditorWorkspace() {
    if (!formulaEditorSession) return;

    const session = formulaEditorSession;
    const host = getActiveFormulaEditorHost();
    let nextLatex = '';

    if (session.rawMode) {
        nextLatex = host?.raw?.value || '';
    } else {
        const renderableLatex = formulaEditorAdapter?.getFormulaEditorValue
            ? formulaEditorAdapter.getFormulaEditorValue(session.editor)
            : session.renderableLatex;
        nextLatex = rebuildFormulaEditorSource(renderableLatex || '');
    }

    const trimmedValue = nextLatex.trim();

    if (session.source === 'card') {
        const rule = currentTests?.test_rules?.[session.testIndex];
        if (!rule || rule.type !== 'layout') {
            showToast('Layout element no longer exists', 'error');
            return;
        }

        if (trimmedValue) {
            rule.content = { type: 'text', text: nextLatex };
        } else {
            delete rule.content;
        }

        const savedTests = await saveTests('layout-formula-editor');
        if (!savedTests) return;

        const targetIndex = session.testIndex;
        closeFormulaEditorWorkspace({ discardChanges: true, suppressWarning: true, rerenderMarkdown: false });
        renderTestList();
        if (markdownPanelOpen) {
            renderMarkdownPanel({ preserveScroll: true });
        }
        selectLayoutTest(targetIndex, {
            preserveMarkdownScroll: true,
            scrollMarkdownCard: false,
        });
        showToast(trimmedValue ? 'Formula updated' : 'Formula cleared', 'success');
        return;
    }

    if (session.source === 'form') {
        const textRadio = document.querySelector('input[name="layout-content-type"][value="text"]');
        const field = session.formFieldId ? document.getElementById(session.formFieldId) : null;

        if (textRadio) {
            textRadio.checked = true;
        }
        if (field) {
            field.value = nextLatex;
        }
        toggleLayoutContentInput();
        closeFormulaEditorWorkspace({ discardChanges: true, suppressWarning: true });
        if (field) {
            field.focus();
            field.setSelectionRange(field.value.length, field.value.length);
        }
        showToast('Formula source updated in form', 'success');
    }
}

function renderInlineFormulaEditor(contentEl, testIndex, test) {
    const host = createInlineFormulaEditorHost(contentEl);

    if (formulaEditorSession?.source === 'card' && formulaEditorSession.testIndex === testIndex) {
        formulaEditorSession.host = host;
        reattachFormulaEditorWorkspace();
        return;
    }

    openFormulaEditorWorkspace({
        source: 'card',
        testIndex,
        formFieldId: null,
        host,
        initialLatex: getLayoutContentValue(test),
    });
}

function beginFormulaCardEdit(testIndex) {
    const test = currentTests?.test_rules?.[testIndex];
    if (!test || test.type !== 'layout' || getLayoutContentType(test) !== 'formula') {
        return;
    }

    if (formulaEditorSession?.source === 'card' && formulaEditorSession.testIndex === testIndex) {
        return;
    }

    markdownEditingIndex = testIndex;
    if (selectedLayoutTestIndex === testIndex) {
        if (markdownPanelOpen) {
            renderMarkdownPanel({ preserveScroll: true });
        }
        return;
    }

    selectLayoutTest(testIndex, {
        preserveMarkdownScroll: true,
        scrollMarkdownCard: false,
        scrollTestListItem: false,
    });
}

function beginFormulaFormEdit() {
    const textRadio = document.querySelector('input[name="layout-content-type"][value="text"]');
    const field = document.getElementById('layout-content');

    if (textRadio) {
        textRadio.checked = true;
    }
    toggleLayoutContentInput();

    openFormulaEditorWorkspace({
        source: 'form',
        testIndex: editingIndex,
        formFieldId: 'layout-content',
        initialLatex: field?.value || '',
    });
}

function focusLayoutRawLatexField() {
    const textRadio = document.querySelector('input[name="layout-content-type"][value="text"]');
    if (textRadio) {
        textRadio.checked = true;
    }
    toggleLayoutContentInput();
    document.getElementById('layout-content')?.focus();
}

function formatLayoutBbox(test) {
    if (!Array.isArray(test?.bbox) || test.bbox.length !== 4) return 'bbox unavailable';
    return `[${test.bbox.map(value => Number(value).toFixed(3)).join(', ')}]`;
}

function pruneMarkdownBulkSelection(orderedTests = []) {
    const validIndices = new Set((orderedTests || []).map(test => test.originalIndex));
    const nextSelection = new Set();

    selectedMarkdownCardIndices.forEach(index => {
        if (validIndices.has(index)) {
            nextSelection.add(index);
        }
    });

    selectedMarkdownCardIndices = nextSelection;
}

function isMarkdownCardBulkSelected(testIndex) {
    return selectedMarkdownCardIndices.has(testIndex);
}

function setMarkdownCardBulkSelection(testIndex, shouldSelect) {
    const nextSelection = new Set(selectedMarkdownCardIndices);
    if (shouldSelect) {
        nextSelection.add(testIndex);
    } else {
        nextSelection.delete(testIndex);
    }
    selectedMarkdownCardIndices = nextSelection;

    if (markdownPanelOpen) {
        renderMarkdownPanel({ preserveScroll: true });
    }
}

function clearMarkdownBulkSelection(options = {}) {
    const { rerender = true, preserveScroll = true } = options;
    if (selectedMarkdownCardIndices.size === 0) return;

    selectedMarkdownCardIndices = new Set();

    if (rerender && markdownPanelOpen) {
        renderMarkdownPanel({ preserveScroll });
    }
}

function remapMarkdownBulkSelectionAfterDelete(deletedIndex) {
    if (selectedMarkdownCardIndices.size === 0) return;

    const nextSelection = new Set();
    selectedMarkdownCardIndices.forEach(index => {
        if (index === deletedIndex) return;
        nextSelection.add(index > deletedIndex ? index - 1 : index);
    });
    selectedMarkdownCardIndices = nextSelection;
}

function clearMarkdownDragIndicators() {
    document.querySelectorAll('.markdown-card').forEach(card => {
        card.classList.remove('dragging', 'drag-above', 'drag-below');
    });
}

function clearLayoutInsertionContext() {
    layoutInsertionContext = null;
}

function getDefaultMarkdownMoveState(orderedTests, sourceOriginalIndex) {
    if (!Array.isArray(orderedTests) || orderedTests.length < 2) {
        return null;
    }

    const sourcePosition = orderedTests.findIndex(test => test.originalIndex === sourceOriginalIndex);
    if (sourcePosition === -1) {
        return null;
    }

    const nextTest = orderedTests[sourcePosition + 1];
    if (nextTest) {
        return {
            sourceOriginalIndex,
            targetOriginalIndex: nextTest.originalIndex,
            placement: 'before',
        };
    }

    const previousTest = orderedTests[sourcePosition - 1];
    if (previousTest) {
        return {
            sourceOriginalIndex,
            targetOriginalIndex: previousTest.originalIndex,
            placement: 'after',
        };
    }

    return null;
}

function beginMarkdownMove(sourceTest, orderedTests) {
    if (!sourceTest || sourceTest.type !== 'layout') return;

    const initialState = getDefaultMarkdownMoveState(orderedTests, sourceTest.originalIndex);
    if (!initialState) {
        showToast('Need another layout element on this page to move relative to', 'info');
        return;
    }

    selectLayoutTest(sourceTest.originalIndex);
    markdownMoveState = initialState;
    renderMarkdownPanel();
}

function updateMarkdownMoveState(patch) {
    if (!markdownMoveState) return;
    markdownMoveState = { ...markdownMoveState, ...patch };
    renderMarkdownPanel();
}

function cancelMarkdownMove() {
    if (!markdownMoveState) return;
    markdownMoveState = null;
    renderMarkdownPanel();
}

async function applyMarkdownMove() {
    const moveState = markdownMoveState;
    if (!moveState) return;

    if (!Number.isInteger(moveState.targetOriginalIndex) || moveState.targetOriginalIndex === moveState.sourceOriginalIndex) {
        showToast('Choose another reading-order item as the move target', 'error');
        return;
    }

    markdownMoveState = null;
    const moved = await reorderLayoutTests(
        moveState.sourceOriginalIndex,
        moveState.targetOriginalIndex,
        moveState.placement,
    );

    if (!moved) {
        markdownMoveState = moveState;
        renderMarkdownPanel();
    }
}

function createMarkdownMoveTargetLabel(test) {
    if (!test) return 'Unknown target';
    const className = test.canonical_class || 'Unknown';
    const idSuffix = test.id ? ` • ${truncate(test.id, 8)}` : '';
    return `RO ${test.normalizedRoIndex} • ${className}${idSuffix}`;
}

function createMarkdownMovePanel(test, orderedTests) {
    const moveState = markdownMoveState;
    if (!moveState || moveState.sourceOriginalIndex !== test.originalIndex) {
        return null;
    }

    const moveTargets = orderedTests.filter(item => item.originalIndex !== test.originalIndex);
    if (moveTargets.length === 0) {
        return null;
    }

    const panel = document.createElement('div');
    panel.className = 'markdown-card-move-panel';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const row = document.createElement('div');
    row.className = 'markdown-card-move-row';

    const label = document.createElement('span');
    label.className = 'markdown-card-move-label';
    label.textContent = 'Move relative to';

    const targetSelect = document.createElement('select');
    targetSelect.className = 'markdown-card-move-select';
    moveTargets.forEach(targetTest => {
        const option = document.createElement('option');
        option.value = String(targetTest.originalIndex);
        option.textContent = createMarkdownMoveTargetLabel(targetTest);
        targetSelect.appendChild(option);
    });
    targetSelect.value = String(moveState.targetOriginalIndex);
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        targetSelect.addEventListener(eventName, (e) => e.stopPropagation());
    });
    targetSelect.addEventListener('change', (e) => {
        e.stopPropagation();
        const targetOriginalIndex = Number.parseInt(targetSelect.value, 10);
        updateMarkdownMoveState({ targetOriginalIndex });
    });

    row.appendChild(label);
    row.appendChild(targetSelect);

    const actions = document.createElement('div');
    actions.className = 'markdown-card-move-actions';

    const beforeBtn = document.createElement('button');
    beforeBtn.className = `btn btn-xs btn-toggle markdown-card-action-btn${moveState.placement === 'before' ? ' active' : ''}`;
    beforeBtn.textContent = 'Before';
    beforeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        updateMarkdownMoveState({ placement: 'before' });
    });

    const afterBtn = document.createElement('button');
    afterBtn.className = `btn btn-xs btn-toggle markdown-card-action-btn${moveState.placement === 'after' ? ' active' : ''}`;
    afterBtn.textContent = 'After';
    afterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        updateMarkdownMoveState({ placement: 'after' });
    });

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-xs btn-primary markdown-card-action-btn';
    applyBtn.textContent = 'Apply Move';
    applyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await applyMarkdownMove();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-xs btn-secondary markdown-card-action-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelMarkdownMove();
    });

    actions.appendChild(beforeBtn);
    actions.appendChild(afterBtn);
    actions.appendChild(applyBtn);
    actions.appendChild(cancelBtn);

    panel.appendChild(row);
    panel.appendChild(actions);
    return panel;
}

function formatLayoutInsertionAnchor(anchorTest) {
    if (!anchorTest) return 'selected layout element';
    const className = anchorTest.canonical_class || 'Unknown';
    const idSuffix = anchorTest.id ? ` • ${truncate(anchorTest.id, 8)}` : '';
    return `${className} (RO ${anchorTest.normalizedRoIndex}${idSuffix})`;
}

function beginRelativeLayoutInsert(anchorTest, placement) {
    if (!anchorTest || anchorTest.type !== 'layout') return;

    markdownMoveState = null;
    selectLayoutTest(anchorTest.originalIndex);
    layoutInsertionContext = {
        page: getLayoutRulePageNumber(anchorTest),
        anchorOriginalIndex: anchorTest.originalIndex,
        placement,
    };

    if (testTypeFilterQuery && elements.testTypeFilterInput) {
        testTypeFilterQuery = '';
        elements.testTypeFilterInput.value = '';
        populateTestTypeSelectOptions();
    }

    editingIndex = null;
    elements.testTypeSelect.value = 'layout';
    showTestForm('layout', { preserveLayoutInsertionContext: true });

    queueMicrotask(() => {
        const pageInput = document.getElementById('layout-page');
        if (pageInput) {
            pageInput.value = String(layoutInsertionContext.page);
        }
        updateLayoutReadingOrderSummary();
        elements.testFormContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
}

function closeLayoutEditorsForClassChange(originalIndex, nextClass) {
    if (tableEditorSession?.source === 'card' && tableEditorSession.testIndex === originalIndex && nextClass !== 'Table') {
        closeTableEditorWorkspace({ discardChanges: true, suppressWarning: true, rerenderMarkdown: false });
    }
    if (formulaEditorSession?.source === 'card' && formulaEditorSession.testIndex === originalIndex && nextClass !== 'Formula') {
        closeFormulaEditorWorkspace({ discardChanges: true, suppressWarning: true, rerenderMarkdown: false });
    }
}

async function updateLayoutClassesFromCards(originalIndices, nextClass) {
    if (!nextClass) return;

    const uniqueIndices = [...new Set(originalIndices)].filter(index => Number.isInteger(index));
    const changedIndices = [];

    uniqueIndices.forEach(index => {
        const rule = currentTests?.test_rules?.[index];
        if (!rule || rule.type !== 'layout' || rule.canonical_class === nextClass) {
            return;
        }

        closeLayoutEditorsForClassChange(index, nextClass);
        rule.canonical_class = nextClass;
        changedIndices.push(index);
    });

    if (changedIndices.length === 0) {
        return;
    }

    const savedTests = await saveTests('layout-class-bulk-update');
    if (!savedTests) return;

    renderTestList();
    if (selectedLayoutTestIndex !== null) {
        selectLayoutTest(selectedLayoutTestIndex, {
            preserveMarkdownScroll: true,
            scrollMarkdownCard: false,
            scrollTestListItem: false,
        });
    } else if (markdownPanelOpen) {
        renderMarkdownPanel({ preserveScroll: true });
    }
    showToast(
        `Layout class updated for ${changedIndices.length} item${changedIndices.length === 1 ? '' : 's'}`,
        'success',
    );
}

async function updateLayoutClassFromCard(originalIndex, nextClass) {
    await updateLayoutClassesFromCards([originalIndex], nextClass);
}

function createMarkdownCardClassSelect(test, ontologyLabels) {
    const select = document.createElement('select');
    select.className = 'markdown-card-class-select';
    populateSelectWithLabels(select, ontologyLabels, {
        includePlaceholder: false,
        selectedValue: test.canonical_class || '',
    });
    select.style.backgroundColor = LAYOUT_CATEGORY_COLORS[test.canonical_class] || '#888888';
    select.title = 'Change layout class';
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        select.addEventListener(eventName, (e) => e.stopPropagation());
    });
    select.addEventListener('change', async (e) => {
        e.stopPropagation();
        await updateLayoutClassFromCard(test.originalIndex, select.value);
    });
    return select;
}

function createMarkdownCardBulkSelectionToggle(test) {
    const toggle = document.createElement('label');
    toggle.className = 'markdown-card-select-toggle';
    toggle.title = 'Select this card for a bulk layout class change';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'markdown-card-select-checkbox';
    checkbox.checked = isMarkdownCardBulkSelected(test.originalIndex);
    checkbox.setAttribute('aria-label', `Select RO ${test.normalizedRoIndex} for bulk layout class changes`);

    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        toggle.addEventListener(eventName, (event) => event.stopPropagation());
        checkbox.addEventListener(eventName, (event) => event.stopPropagation());
    });

    checkbox.addEventListener('change', (event) => {
        event.stopPropagation();
        setMarkdownCardBulkSelection(test.originalIndex, checkbox.checked);
    });

    toggle.appendChild(checkbox);
    return toggle;
}

function renderMarkdownBulkToolbar(container, ontologyLabels, orderedTests) {
    pruneMarkdownBulkSelection(orderedTests);
    if (selectedMarkdownCardIndices.size === 0) return;

    const selectedTests = orderedTests.filter(test => selectedMarkdownCardIndices.has(test.originalIndex));
    if (selectedTests.length === 0) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'markdown-bulk-toolbar';
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        toolbar.addEventListener(eventName, (event) => event.stopPropagation());
    });

    const summary = document.createElement('div');
    summary.className = 'markdown-bulk-toolbar-summary';
    summary.textContent = `${selectedTests.length} selected`;

    const controls = document.createElement('div');
    controls.className = 'markdown-bulk-toolbar-controls';

    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'btn btn-xs btn-secondary';
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.disabled = selectedTests.length === orderedTests.length;
    selectAllBtn.addEventListener('click', () => {
        selectedMarkdownCardIndices = new Set(orderedTests.map(test => test.originalIndex));
        renderMarkdownPanel({ preserveScroll: true });
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-xs btn-ghost';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => clearMarkdownBulkSelection({ preserveScroll: true }));

    const selectedClasses = [...new Set(selectedTests.map(test => test.canonical_class).filter(Boolean))];
    const selectedValue = selectedClasses.length === 1 ? selectedClasses[0] : '';

    const classSelect = document.createElement('select');
    classSelect.className = 'markdown-bulk-class-select';
    populateSelectWithLabels(classSelect, ontologyLabels, {
        includePlaceholder: true,
        placeholder: 'Apply layout class...',
        selectedValue: selectedValue || null,
    });
    if (!selectedValue) {
        classSelect.value = '';
    }

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-xs btn-primary';
    applyBtn.textContent = 'Apply';
    applyBtn.disabled = !classSelect.value;

    classSelect.addEventListener('change', () => {
        applyBtn.disabled = !classSelect.value;
    });
    applyBtn.addEventListener('click', async () => {
        if (!classSelect.value) return;
        await updateLayoutClassesFromCards([...selectedMarkdownCardIndices], classSelect.value);
    });

    controls.appendChild(selectAllBtn);
    controls.appendChild(clearBtn);
    controls.appendChild(classSelect);
    controls.appendChild(applyBtn);

    toolbar.appendChild(summary);
    toolbar.appendChild(controls);
    container.appendChild(toolbar);
}

async function renderMarkdownPanel(options = {}) {
    const { preserveScroll = false } = options;
    const renderSequence = ++markdownRenderSequence;
    const container = elements.markdownContent;
    if (!container) return;
    const previousScrollTop = preserveScroll ? container.scrollTop : null;
    if (tableEditorSession?.source === 'card') {
        prepareInlineTableEditorForMarkdownRender();
    }
    if (formulaEditorSession?.source === 'card') {
        prepareInlineFormulaEditorForMarkdownRender();
    }
    container.innerHTML = '';

    // Display path: respect the UI granularity / type / tag filters
    // so the markdown panel shows the same per-page subset the SVG
    // overlay does. The "Generate expected markdown" button is gated
    // on the *unfiltered* set since the generator itself runs on all
    // rules (see generateExpectedMarkdown), not the filtered view —
    // otherwise the button would mislead the user into thinking
    // there's nothing to generate when they've just narrowed the
    // filter.
    const orderedTests = getFilteredLayoutTestsForPage();
    if (elements.generateExpectedMdBtn) {
        elements.generateExpectedMdBtn.disabled = !getLayoutTestsForCurrentPage().some(hasLayoutContent);
    }

    if (orderedTests.length > 0) {
        const ontologyLabels = await getOntologyLabels();
        if (renderSequence !== markdownRenderSequence) return;
        renderMarkdownBulkToolbar(container, ontologyLabels, orderedTests);
        orderedTests.forEach((test, displayIndex) => {
            renderMarkdownCard(container, test, displayIndex, orderedTests.length, ontologyLabels, orderedTests);
        });
        if (previousScrollTop !== null) {
            container.scrollTop = previousScrollTop;
        }
        return;
    }

    if (currentTests?.expected_markdown) {
        container.innerHTML = '<p class="markdown-empty-state">No layout elements exist on this page yet. Showing document-level expected markdown.</p>';
        renderExpectedMarkdownBlock(container);
        if (previousScrollTop !== null) {
            container.scrollTop = previousScrollTop;
        }
        return;
    }

    container.innerHTML = '<p class="markdown-empty-state">No layout elements exist on this page yet.</p>';
    if (previousScrollTop !== null) {
        container.scrollTop = previousScrollTop;
    }
}

function renderExpectedMarkdownBlock(container) {
    const block = document.createElement('div');
    block.className = 'markdown-expected-block';

    const content = document.createElement('div');
    content.className = 'markdown-card-content';
    content.innerHTML = marked.parse(currentTests.expected_markdown || '');

    block.appendChild(content);
    container.appendChild(block);
}

function renderMarkdownCard(container, test, displayIndex, totalCount, ontologyLabels, orderedTests) {
    const card = document.createElement('div');
    card.className = 'markdown-card';
    card.dataset.testIndex = test.originalIndex;

    const color = LAYOUT_CATEGORY_COLORS[test.canonical_class] || '#888888';
    card.style.borderLeftColor = color;
    if (!hasLayoutContent(test)) card.classList.add('markdown-card-empty');
    if (markdownEditingIndex === test.originalIndex) card.classList.add('editing');
    if (isMarkdownCardBulkSelected(test.originalIndex)) card.classList.add('bulk-selected');

    const isSelected = selectedLayoutTestIndex === test.originalIndex;
    if (isSelected) card.classList.add('selected');

    const header = document.createElement('div');
    header.className = 'markdown-card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'markdown-card-header-left';

    const dragHandle = document.createElement('div');
    dragHandle.className = 'markdown-card-drag-handle';
    dragHandle.textContent = '::';
    dragHandle.draggable = true;
    dragHandle.title = 'Drag to reorder';
    dragHandle.addEventListener('dragstart', (e) => {
        markdownDragIndex = test.originalIndex;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(test.originalIndex));
    });

    const roBadge = document.createElement('span');
    roBadge.className = 'markdown-card-ro-badge';
    roBadge.textContent = `RO ${test.normalizedRoIndex}`;

    const bulkToggle = createMarkdownCardBulkSelectionToggle(test);
    const classSelect = createMarkdownCardClassSelect(test, ontologyLabels);

    headerLeft.appendChild(bulkToggle);
    headerLeft.appendChild(dragHandle);
    headerLeft.appendChild(roBadge);
    headerLeft.appendChild(classSelect);

    if (test.id) {
        const idBadge = document.createElement('span');
        idBadge.className = 'markdown-card-id-badge';
        idBadge.textContent = `id: ${truncate(test.id, 8)}`;
        headerLeft.appendChild(idBadge);
    }

    const actions = document.createElement('div');
    actions.className = 'markdown-card-actions';

    const addBeforeBtn = document.createElement('button');
    addBeforeBtn.className = 'btn btn-xs btn-secondary markdown-card-action-btn markdown-card-insert-btn';
    addBeforeBtn.textContent = 'Add Before';
    addBeforeBtn.title = 'Create a new layout element before this item';
    addBeforeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        beginRelativeLayoutInsert(test, 'before');
    });

    const addAfterBtn = document.createElement('button');
    addAfterBtn.className = 'btn btn-xs btn-secondary markdown-card-action-btn markdown-card-insert-btn';
    addAfterBtn.textContent = 'Add After';
    addAfterBtn.title = 'Create a new layout element after this item';
    addAfterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        beginRelativeLayoutInsert(test, 'after');
    });

    const moveBtn = document.createElement('button');
    moveBtn.className = `btn btn-xs btn-toggle markdown-card-action-btn${markdownMoveState?.sourceOriginalIndex === test.originalIndex ? ' active' : ''}`;
    moveBtn.textContent = 'Move';
    moveBtn.title = 'Move this card before or after another reading-order item';
    moveBtn.disabled = totalCount < 2;
    moveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (markdownMoveState?.sourceOriginalIndex === test.originalIndex) {
            cancelMarkdownMove();
            return;
        }
        beginMarkdownMove(test, orderedTests);
    });

    const moveUpBtn = document.createElement('button');
    moveUpBtn.className = 'btn btn-xs btn-secondary markdown-card-action-btn';
    moveUpBtn.textContent = 'Up';
    moveUpBtn.disabled = displayIndex === 0;
    moveUpBtn.title = 'Move earlier in reading order';
    moveUpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (displayIndex === 0) return;
        reorderLayoutTests(test.originalIndex, test.originalIndex, 'up');
    });

    const moveDownBtn = document.createElement('button');
    moveDownBtn.className = 'btn btn-xs btn-secondary markdown-card-action-btn';
    moveDownBtn.textContent = 'Down';
    moveDownBtn.disabled = displayIndex === totalCount - 1;
    moveDownBtn.title = 'Move later in reading order';
    moveDownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (displayIndex === totalCount - 1) return;
        reorderLayoutTests(test.originalIndex, test.originalIndex, 'down');
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-xs btn-secondary markdown-card-action-btn markdown-card-edit-btn';
    const cardContentType = getLayoutContentType(test);
    const isTableCard = cardContentType === 'table';
    const isFormulaCard = cardContentType === 'formula';
    editBtn.textContent = isTableCard
        ? (hasLayoutContent(test) ? 'Edit Table' : 'Add Table')
        : isFormulaCard
            ? (hasLayoutContent(test) ? 'Edit Formula' : 'Add Formula')
            : (hasLayoutContent(test) ? 'Edit' : 'Add');
    editBtn.title = isTableCard
        ? 'Edit table content'
        : isFormulaCard
            ? 'Edit formula content'
            : (hasLayoutContent(test) ? 'Edit content' : 'Add content');
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isTableCard) {
            beginTableCardEdit(test.originalIndex);
            return;
        }
        if (isFormulaCard) {
            beginFormulaCardEdit(test.originalIndex);
            return;
        }
        startMarkdownEdit(test.originalIndex);
    });

    const editTagsBtn = document.createElement('button');
    editTagsBtn.className = `btn btn-xs btn-secondary markdown-card-action-btn${markdownTagEditingIndex === test.originalIndex ? ' active' : ''}`;
    editTagsBtn.textContent = markdownTagEditingIndex === test.originalIndex ? 'Close Tags' : 'Edit Tags';
    editTagsBtn.title = 'Add, edit, or remove per-rule tags';
    editTagsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (markdownTagEditingIndex === test.originalIndex) {
            cancelMarkdownTagEdit();
            return;
        }
        startMarkdownTagEdit(test.originalIndex);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-xs btn-danger markdown-card-action-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.title = 'Delete this layout element';
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteTest(test.originalIndex);
    });

    actions.appendChild(addBeforeBtn);
    actions.appendChild(addAfterBtn);
    actions.appendChild(moveBtn);
    actions.appendChild(moveUpBtn);
    actions.appendChild(moveDownBtn);
    actions.appendChild(editBtn);
    actions.appendChild(editTagsBtn);
    actions.appendChild(deleteBtn);

    header.appendChild(headerLeft);
    header.appendChild(actions);

    const meta = document.createElement('div');
    meta.className = 'markdown-card-meta';
    meta.textContent = `Page ${getLayoutRulePageNumber(test)} • ${formatLayoutBbox(test)}${hasLayoutContent(test) ? '' : ' • No attributed content yet'}`;

    const tagsSection = document.createElement('div');
    tagsSection.className = 'markdown-card-tags-section';
    if (markdownTagEditingIndex === test.originalIndex) {
        renderMarkdownTagEditor(tagsSection, test);
    } else if (Array.isArray(test.tags) && test.tags.length > 0) {
        tagsSection.innerHTML = renderRuleTagsHtml(test.tags, { containerClass: 'markdown-card-tags' });
    } else {
        tagsSection.innerHTML = '<div class="markdown-card-tags markdown-card-tags-empty">No tags</div>';
    }

    const movePanel = createMarkdownMovePanel(test, orderedTests);

    const content = document.createElement('div');
    content.className = 'markdown-card-content';

    if (markdownEditingIndex === test.originalIndex) {
        if (cardContentType === 'table') {
            renderInlineTableEditor(content, test.originalIndex, test);
        } else if (cardContentType === 'formula') {
            renderInlineFormulaEditor(content, test.originalIndex, test);
        } else {
            renderMarkdownEditor(content, test.originalIndex, test);
        }
    } else {
        if (hasLayoutContent(test) && cardContentType === 'table') {
            content.innerHTML = test.content.html;
        } else if (hasLayoutContent(test) && cardContentType === 'formula') {
            content.appendChild(createFormulaPreviewNode(getLayoutContentValue(test)));
        } else if (hasLayoutContent(test)) {
            let text = test.content.text || '';
            if (test.canonical_class === 'Section-header' || test.canonical_class === 'Section') {
                text = `## ${text}`;
            }
            content.innerHTML = marked.parse(text);
        } else {
            content.innerHTML = cardContentType === 'formula'
                ? '<div class="markdown-card-placeholder">No attributed formula yet. Use Add Formula to store LaTeX for this layout element.</div>'
                : '<div class="markdown-card-placeholder">No attributed content yet. Use Add to attach text or table HTML for this layout element.</div>';
        }
    }

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(tagsSection);
    if (movePanel) {
        card.appendChild(movePanel);
    }
    card.appendChild(content);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.markdown-card-actions')) return;
        if (e.target.closest('.markdown-card-select-toggle')) return;
        if (e.target.closest('.markdown-card-drag-handle')) return;
        if (e.target.closest('.markdown-card-move-panel')) return;
        if (e.target.closest('.markdown-card-tags-section')) return;
        if (e.target.closest('.markdown-edit-textarea')) return;
        if (e.target.closest('.markdown-edit-actions')) return;
        if (e.target.closest('.markdown-table-editor')) return;
        if (e.target.closest('.markdown-formula-editor')) return;
        if (e.target.closest('math-field')) return;
        selectLayoutTest(test.originalIndex, {
            preserveMarkdownScroll: true,
            scrollMarkdownCard: false,
        });
    });

    container.appendChild(card);
}

function startMarkdownTagEdit(testIndex) {
    markdownMoveState = null;
    markdownTagEditingIndex = testIndex;
    renderMarkdownPanel({ preserveScroll: true });
}

function cancelMarkdownTagEdit() {
    markdownTagEditingIndex = null;
    if (markdownPanelOpen) {
        renderMarkdownPanel({ preserveScroll: true });
    }
}

function renderMarkdownTagEditor(container, test) {
    if (!container || !test) return;

    const editor = document.createElement('div');
    editor.className = 'markdown-tag-editor';

    const fieldId = `markdown-tags-${test.originalIndex}`;
    editor.innerHTML = `
        ${buildTagInputFieldHtml(
        fieldId,
        'tags',
        { placeholder: 'Type a tag and press Enter' },
        test.tags || [],
        '',
    )}
        <div class="markdown-tag-actions">
            <button type="button" class="btn btn-sm btn-secondary" data-markdown-tag-cancel>Cancel</button>
            <button type="button" class="btn btn-sm btn-success" data-markdown-tag-save>Save</button>
        </div>
    `;
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        editor.addEventListener(eventName, (e) => e.stopPropagation());
    });
    container.innerHTML = '';
    container.appendChild(editor);
    initTagInputWidgets(editor);

    const cancelBtn = editor.querySelector('[data-markdown-tag-cancel]');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => cancelMarkdownTagEdit());
    }

    const saveBtn = editor.querySelector('[data-markdown-tag-save]');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveMarkdownTagEdit(test.originalIndex, editor));
    }
}

function startMarkdownEdit(testIndex) {
    markdownMoveState = null;
    const test = currentTests.test_rules[testIndex];
    if (!test || test.type !== 'layout') return;
    if (getLayoutContentType(test) === 'table') {
        beginTableCardEdit(testIndex);
        return;
    }
    if (getLayoutContentType(test) === 'formula') {
        beginFormulaCardEdit(testIndex);
        return;
    }

    markdownEditingIndex = testIndex;

    const card = document.querySelector(`.markdown-card[data-test-index="${testIndex}"]`);
    if (!card) return;

    const contentEl = card.querySelector('.markdown-card-content');
    if (!contentEl) return;

    renderMarkdownEditor(contentEl, testIndex, test);
    card.classList.add('editing');
}

function renderMarkdownEditor(contentEl, testIndex, test) {
    if (!contentEl || !test || test.type !== 'layout') return;

    const textarea = document.createElement('textarea');
    textarea.className = 'markdown-edit-textarea';
    textarea.dataset.contentType = getLayoutContentType(test);
    textarea.value = getLayoutContentValue(test);
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        textarea.addEventListener(eventName, (e) => e.stopPropagation());
    });

    const actions = document.createElement('div');
    actions.className = 'markdown-edit-actions';
    ['click', 'mousedown', 'pointerdown'].forEach(eventName => {
        actions.addEventListener(eventName, (e) => e.stopPropagation());
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => cancelMarkdownEdit();

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-success';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = () => saveMarkdownEdit(testIndex, textarea.value, textarea.dataset.contentType);

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    contentEl.innerHTML = '';
    contentEl.appendChild(textarea);
    contentEl.appendChild(actions);

    textarea.focus();
}

function cancelMarkdownEdit() {
    if (tableEditorSession?.source === 'card') {
        closeTableEditorWorkspace({ preserveMarkdownScroll: true });
        return;
    }
    if (formulaEditorSession?.source === 'card') {
        closeFormulaEditorWorkspace({ preserveMarkdownScroll: true });
        return;
    }
    markdownEditingIndex = null;
    renderMarkdownPanel({ preserveScroll: true });
}

async function saveMarkdownEdit(testIndex, newValue, contentType) {
    const test = currentTests.test_rules[testIndex];
    if (!test || test.type !== 'layout') return;

    const trimmedValue = newValue.trim();
    if (!trimmedValue) {
        delete test.content;
    } else if (contentType === 'table') {
        test.content = { type: 'table', html: newValue };
    } else {
        test.content = { type: 'text', text: newValue };
    }

    const savedTests = await saveTests('layout-markdown-edit');
    if (!savedTests) return;
    markdownEditingIndex = null;
    renderTestList();
    renderMarkdownPanel({ preserveScroll: true });
    showToast(trimmedValue ? 'Content updated' : 'Content cleared', 'success');
}

async function saveMarkdownTagEdit(testIndex, editorRoot) {
    const test = currentTests.test_rules[testIndex];
    if (!test || test.type !== 'layout') return;

    const nextTags = collectRuleTagsFromRoot(editorRoot);
    applyRuleTagsToPayload(test, nextTags);

    const savedTests = await saveTests('layout-tags-edit');
    if (!savedTests) return;
    markdownTagEditingIndex = null;
    renderTestList();
    renderMarkdownPanel({ preserveScroll: true });
    showToast(nextTags.length > 0 ? 'Tags updated' : 'Tags cleared', 'success');
}

function initMarkdownDragHandlers() {
    const container = elements.markdownContent;
    if (!container) return;

    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        const card = e.target.closest('.markdown-card');
        if (!card || markdownDragIndex === null) return;

        clearMarkdownDragIndicators();

        const rect = card.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        card.classList.toggle('drag-above', e.clientY < midY);
        card.classList.toggle('drag-below', e.clientY >= midY);
    });

    container.addEventListener('drop', async (e) => {
        e.preventDefault();
        let card = e.target.closest('.markdown-card');
        if (!card && container.lastElementChild?.classList.contains('markdown-card')) {
            card = container.lastElementChild;
        }
        if (!card || markdownDragIndex === null) return;

        const rect = card.getBoundingClientRect();
        const targetIndex = Number.parseInt(card.dataset.testIndex, 10);
        const placement = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        await reorderLayoutTests(markdownDragIndex, targetIndex, placement);
    });

    container.addEventListener('dragend', () => {
        markdownDragIndex = null;
        clearMarkdownDragIndicators();
    });
}

async function reorderLayoutTests(fromIndex, toIndex, placement = 'before') {
    const orderedTests = getLayoutTestsForCurrentPage();
    const fromPosition = orderedTests.findIndex(test => test.originalIndex === fromIndex);
    if (fromPosition === -1) return false;

    let insertAt = fromPosition;
    if (placement === 'up') {
        insertAt = Math.max(0, fromPosition - 1);
    } else if (placement === 'down') {
        insertAt = Math.min(orderedTests.length - 1, fromPosition + 1);
    } else {
        const targetPosition = orderedTests.findIndex(test => test.originalIndex === toIndex);
        if (targetPosition === -1) return false;
        insertAt = targetPosition + (placement === 'after' ? 1 : 0);
        if (fromPosition < insertAt) {
            insertAt -= 1;
        }
    }

    if (insertAt === fromPosition) {
        clearMarkdownDragIndicators();
        return false;
    }

    const reordered = [...orderedTests];
    const [moved] = reordered.splice(fromPosition, 1);
    reordered.splice(insertAt, 0, moved);
    commitPageReadingOrder(pageNum, reordered);

    const savedTests = await saveTests('layout-reading-order');
    if (!savedTests) return false;
    renderTestList();
    if (markdownPanelOpen) renderMarkdownPanel();
    showToast('Reading order updated', 'success');
    return true;
}

async function generateExpectedMarkdown() {
    const pageBlocks = getDocumentLayoutPageNumbers()
        .map((page) => getExpectedMarkdownPartsFromLayoutTests(getOrderedLayoutTestsForPage(page)).join('\n\n'))
        .filter(Boolean);

    if (pageBlocks.length === 0) {
        showToast('No content to generate expected markdown from', 'error');
        return;
    }

    const newExpectedMd = pageBlocks.join('\n\n---\n\n');

    if (currentTests.expected_markdown) {
        if (!confirm('This will overwrite existing expected_markdown. Continue?')) return;
    }

    currentTests.expected_markdown = newExpectedMd;
    if (elements.expectedMarkdown) {
        elements.expectedMarkdown.value = newExpectedMd;
    }
    await saveTests('layout-generate-expected-markdown');
    showToast('Generated expected_markdown from layout contents', 'success');
}

// === AI Selection Functions ===
function toggleAiSelectMode(enable = null) {
    aiSelectMode = enable !== null ? enable : !aiSelectMode;

    const btn = elements.aiSelectBtn;
    const wrapper = elements.pdfWrapper;
    const selectionCanvas = elements.selectionCanvas;

    if (aiSelectMode) {
        btn.classList.add('active');
        wrapper.classList.add('ai-select-mode');

        // Setup selection canvas
        const pdfCanvas = elements.pdfCanvas;
        selectionCanvas.width = pdfCanvas.width;
        selectionCanvas.height = pdfCanvas.height;
        selectionCanvas.style.width = pdfCanvas.style.width;
        selectionCanvas.style.height = pdfCanvas.style.height;
        selectionCanvas.style.display = 'block';

        showToast('Draw a region on the document or press A again to cancel', 'info');
    } else {
        btn.classList.remove('active');
        wrapper.classList.remove('ai-select-mode');
        selectionCanvas.style.display = 'none';

        // Clear any in-progress drawing. Exiting select mode — whether via
        // Esc, 'a', a successful capture, or any other path — also cancels
        // a pending extract draw. The successful-capture path in
        // onSelectionMouseUp snapshots extractDrawContext BEFORE calling
        // toggleAiSelectMode(false), so clearing here is safe.
        isDrawingSelection = false;
        extractDrawContext = null;
    }
}

function initSelectionCanvas() {
    const selectionCanvas = elements.selectionCanvas;
    if (!selectionCanvas) return;

    selectionCanvas.addEventListener('mousedown', onSelectionMouseDown);
    selectionCanvas.addEventListener('mousemove', onSelectionMouseMove);
    selectionCanvas.addEventListener('mouseup', onSelectionMouseUp);
    selectionCanvas.addEventListener('mouseleave', onSelectionMouseUp);
}

function onSelectionMouseDown(e) {
    if (!aiSelectMode) return;

    const rect = elements.selectionCanvas.getBoundingClientRect();
    const scaleX = elements.selectionCanvas.width / rect.width;
    const scaleY = elements.selectionCanvas.height / rect.height;

    selectionStart = {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
    selectionEnd = { ...selectionStart };
    isDrawingSelection = true;

    // Clear previous selection
    clearSelectionBox();
}

function onSelectionMouseMove(e) {
    if (!isDrawingSelection || !aiSelectMode) return;

    const rect = elements.selectionCanvas.getBoundingClientRect();
    const scaleX = elements.selectionCanvas.width / rect.width;
    const scaleY = elements.selectionCanvas.height / rect.height;

    selectionEnd = {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };

    drawSelectionPreview();
}

function onSelectionMouseUp(e) {
    if (!isDrawingSelection || !aiSelectMode) return;

    isDrawingSelection = false;

    // Calculate final selection bounds
    const x = Math.min(selectionStart.x, selectionEnd.x);
    const y = Math.min(selectionStart.y, selectionEnd.y);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);

    // Minimum selection size
    if (width < 20 || height < 20) {
        clearSelectionBox();
        showToast('Selection too small. Draw a larger region.', 'error');
        layoutDrawMode = false;
        return;
    }

    currentSelection = { x, y, width, height };

    // Show final selection box
    showSelectionBox(x, y, width, height);

    // Capture the active draw contexts before toggling select mode off.
    // `toggleAiSelectMode(false)` clears `extractDrawContext` so exits via
    // 'a'/Esc can't leak a stale context into a later AI query — but the
    // successful-capture path needs to read it first.
    const pendingLayoutDraw = layoutDrawMode;
    const pendingExtractDraw = extractDrawContext;

    // Exit selection mode
    toggleAiSelectMode(false);

    // If in layout draw mode, populate layout form fields
    if (pendingLayoutDraw) {
        const pdfCanvas = elements.pdfCanvas;
        const canvasWidth = pdfCanvas.width;
        const canvasHeight = pdfCanvas.height;

        // Convert to normalized [0-1] coordinates
        const normX = x / canvasWidth;
        const normY = y / canvasHeight;
        const normW = width / canvasWidth;
        const normH = height / canvasHeight;

        // Populate bbox fields
        const bboxXEl = document.getElementById('layout-bbox-x');
        const bboxYEl = document.getElementById('layout-bbox-y');
        const bboxWEl = document.getElementById('layout-bbox-w');
        const bboxHEl = document.getElementById('layout-bbox-h');

        if (bboxXEl) bboxXEl.value = normX.toFixed(4);
        if (bboxYEl) bboxYEl.value = normY.toFixed(4);
        if (bboxWEl) bboxWEl.value = normW.toFixed(4);
        if (bboxHEl) bboxHEl.value = normH.toFixed(4);

        layoutDrawMode = false;
        clearSelectionBox();
        showToast('Bounding box coordinates captured', 'success');
        return;
    }

    // If in extract draw mode, append a new bbox to the targeted rule.
    // source_bbox_index is null — user-drawn bboxes break the round-trip
    // link for that single bbox only (documented in Migration Notes).
    // (`extractDrawContext` was captured before toggleAiSelectMode cleared it.)
    if (pendingExtractDraw) {
        const pdfCanvas = elements.pdfCanvas;
        const canvasWidth = pdfCanvas.width;
        const canvasHeight = pdfCanvas.height;
        const normX = x / canvasWidth;
        const normY = y / canvasHeight;
        const normW = width / canvasWidth;
        const normH = height / canvasHeight;
        const { ruleIdx, fieldPath } = pendingExtractDraw;
        const rule = currentTests?.test_rules?.[ruleIdx];
        if (!rule || rule.type !== 'extract_field') {
            clearSelectionBox();
            showToast('Rule no longer exists — draw cancelled', 'error');
            return;
        }
        rule.bboxes = Array.isArray(rule.bboxes) ? rule.bboxes : [];
        rule.bboxes.push({
            page: pageNum,
            bbox: [normX, normY, normW, normH],
            source_bbox_index: null,
        });
        const newBboxIdx = rule.bboxes.length - 1;
        clearSelectionBox();
        selectExtractFieldPath(fieldPath, {
            navigateIfNeeded: false,
            scrollIntoView: false,
            bboxIndex: newBboxIdx,
            focusBbox: false,
        });
        saveTests('extract-bbox-draw');
        showToast('Bounding box added', 'success');
        return;
    }

    // Update AI panel
    updateAiSelectionStatus();

    showToast('Region selected. Use AI panel to analyze.', 'success');
}

function drawSelectionPreview() {
    const ctx = elements.selectionCanvas.getContext('2d');
    const canvas = elements.selectionCanvas;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw selection rectangle
    const x = Math.min(selectionStart.x, selectionEnd.x);
    const y = Math.min(selectionStart.y, selectionEnd.y);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);

    // Semi-transparent overlay
    ctx.fillStyle = 'rgba(88, 166, 255, 0.1)';
    ctx.fillRect(x, y, width, height);

    // Dashed border
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, width, height);

    // Corner handles
    ctx.setLineDash([]);
    ctx.fillStyle = '#58a6ff';
    const handleSize = 8;
    ctx.fillRect(x - handleSize/2, y - handleSize/2, handleSize, handleSize);
    ctx.fillRect(x + width - handleSize/2, y - handleSize/2, handleSize, handleSize);
    ctx.fillRect(x - handleSize/2, y + height - handleSize/2, handleSize, handleSize);
    ctx.fillRect(x + width - handleSize/2, y + height - handleSize/2, handleSize, handleSize);
}

function showSelectionBox(x, y, width, height) {
    const selectionBox = elements.selectionBox;
    const pdfCanvas = elements.pdfCanvas;
    const rect = pdfCanvas.getBoundingClientRect();

    // Convert canvas coords to display coords
    const scaleX = rect.width / pdfCanvas.width;
    const scaleY = rect.height / pdfCanvas.height;

    selectionBox.style.left = `${x * scaleX}px`;
    selectionBox.style.top = `${y * scaleY}px`;
    selectionBox.style.width = `${width * scaleX}px`;
    selectionBox.style.height = `${height * scaleY}px`;
    selectionBox.style.display = 'block';

    // Clear the preview canvas
    const ctx = elements.selectionCanvas.getContext('2d');
    ctx.clearRect(0, 0, elements.selectionCanvas.width, elements.selectionCanvas.height);
}

function clearSelectionBox() {
    elements.selectionBox.style.display = 'none';
    currentSelection = null;

    // Clear preview canvas
    if (elements.selectionCanvas) {
        const ctx = elements.selectionCanvas.getContext('2d');
        ctx.clearRect(0, 0, elements.selectionCanvas.width, elements.selectionCanvas.height);
    }

    updateAiSelectionStatus();
}

function updateAiSelectionStatus() {
    const status = elements.aiSelectionStatus;
    if (!status) return;

    if (currentSelection) {
        status.textContent = `Region: ${Math.round(currentSelection.width)}×${Math.round(currentSelection.height)}px`;
        status.classList.add('has-selection');
        if (elements.aiClearSelectionBtn) {
            elements.aiClearSelectionBtn.style.display = 'inline-block';
        }
        setRegionButtonState('region');
    } else {
        status.textContent = 'Full page';
        status.classList.remove('has-selection');
        if (elements.aiClearSelectionBtn) {
            elements.aiClearSelectionBtn.style.display = 'none';
        }
        setRegionButtonState('fullpage');
    }
}

function setRegionButtonState(mode) {
    const fullPageBtn = elements.aiFullPageBtn;
    const drawRegionBtn = elements.aiDrawRegionBtn;

    if (mode === 'fullpage') {
        fullPageBtn?.classList.add('active');
        drawRegionBtn?.classList.remove('active');
    } else if (mode === 'region' || mode === 'drawing') {
        fullPageBtn?.classList.remove('active');
        drawRegionBtn?.classList.add('active');
    }
}

function getSelectedRegionAsBase64() {
    const pdfCanvas = elements.pdfCanvas;

    if (!pdfCanvas) return null;

    let sourceCanvas;

    if (currentSelection) {
        // Create a temporary canvas for the cropped region
        sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = currentSelection.width;
        sourceCanvas.height = currentSelection.height;

        const ctx = sourceCanvas.getContext('2d');
        ctx.drawImage(
            pdfCanvas,
            currentSelection.x, currentSelection.y,
            currentSelection.width, currentSelection.height,
            0, 0,
            currentSelection.width, currentSelection.height
        );
    } else {
        // Use full canvas
        sourceCanvas = pdfCanvas;
    }

    // Convert to base64 PNG
    return sourceCanvas.toDataURL('image/png').split(',')[1];
}

// === AI Panel Functions ===
async function fetchVlmConfig() {
    try {
        const response = await fetch('/api/vlm/config');
        vlmConfig = await response.json();
        updateAiPanelState();
        return vlmConfig;
    } catch (error) {
        console.error('Failed to fetch VLM config:', error);
        return null;
    }
}

function updateAiPanelState() {
    const extractBtn = elements.aiExtractTextBtn;
    const generateTestsBtn = elements.aiGenerateTestsBtn;

    if (!vlmConfig.has_api_key) {
        if (extractBtn) {
            extractBtn.disabled = true;
            extractBtn.title = 'Configure API key in settings first';
        }
        if (generateTestsBtn) {
            generateTestsBtn.disabled = true;
            generateTestsBtn.title = 'Configure API key in settings first';
        }
    } else {
        if (extractBtn) {
            extractBtn.disabled = false;
            extractBtn.title = 'Extract text/markdown from region';
        }
        if (generateTestsBtn) {
            generateTestsBtn.disabled = false;
            generateTestsBtn.title = 'Generate test rules from region';
        }
    }

    // Update model display if present
    const modelSelect = elements.aiModelSelect;
    if (modelSelect && vlmConfig.available_models) {
        modelSelect.innerHTML = vlmConfig.available_models
            .map(m => `<option value="${m}" ${m === vlmConfig.model ? 'selected' : ''}>${m}</option>`)
            .join('');
    }

    refreshAiTypeMetadata();
    updateTestTypesUI();
}

async function generateWithAi(mode = 'parse') {
    // Check if batch operation is needed for generate_tests mode
    if (mode === 'generate_tests' && selectedFiles.size > 0) {
        // If current file is not in selection, or there are multiple selected files
        const hasMultipleSelected = selectedFiles.size > 1 ||
            (selectedFiles.size === 1 && !selectedFiles.has(currentFile?.path));
        if (hasMultipleSelected) {
            await runBatchOperation('generate');
            return;
        }
    }

    if (!currentFile) {
        showToast('No file loaded', 'error');
        return;
    }

    if (!vlmConfig.has_api_key) {
        showToast('Configure API key in AI Settings first', 'error');
        openAiSettingsModal();
        return;
    }

    const imageBase64 = getSelectedRegionAsBase64();

    if (!imageBase64) {
        showToast('No image available', 'error');
        return;
    }

    // Get the button that was clicked
    const actionBtn = mode === 'parse' ? elements.aiExtractTextBtn : elements.aiGenerateTestsBtn;
    const originalHTML = actionBtn?.innerHTML;

    // Show loading state on the clicked button
    if (actionBtn) {
        actionBtn.disabled = true;
        actionBtn.classList.add('loading');
        actionBtn.innerHTML = '<span class="spinner"></span> Generating...';
    }

    // Disable other action button too
    const otherBtn = mode === 'parse' ? elements.aiGenerateTestsBtn : elements.aiExtractTextBtn;
    if (otherBtn) otherBtn.disabled = true;

    // Clear previous results
    if (elements.aiResultText) {
        elements.aiResultText.value = '';
    }
    if (elements.aiResultsContainer) {
        elements.aiResultsContainer.style.display = 'none';
    }

    try {
        // Get custom prompt if provided
        const customPrompt = elements.aiCustomPrompt?.value?.trim() || null;
        const testCount = parseInt(elements.aiTestCountSlider?.value || '4', 10);

        // Build request body
        const requestBody = {
            image: imageBase64,
            mode: mode,
            additional_instructions: customPrompt,
            test_count: testCount,
        };

        // Add test_types and parse_content for generate_tests mode
        if (mode === 'generate_tests') {
            requestBody.test_types = getSelectedTestTypes();
            const parseContent = getParseMdContentIfEnabled();
            if (parseContent) {
                requestBody.parse_content = parseContent;
            }
        }

        const response = await fetch('/api/vlm/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        const data = await response.json();

        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        // Handle results based on mode
        if (mode === 'generate_tests') {
            // Directly insert tests without showing preview
            if (data.tests && Array.isArray(data.tests) && data.tests.length > 0) {
                const acceptedTypes = getAcceptedAiGeneratedTypeSet();
                let addedCount = 0;
                for (const test of data.tests) {
                    if (test.type && acceptedTypes.has(test.type)) {
                        // Mark AI-generated tests as unverified
                        test.verified = false;
                        currentTests.test_rules.push(test);
                        addedCount++;
                    }
                }

                if (addedCount > 0) {
                    await saveTests('ai-generate-tests');
                    renderTestList();
                    showToast(`Added ${addedCount} test rules`, 'success');
                } else {
                    showToast('No valid tests generated', 'error');
                }
            } else {
                showToast(data.parse_error || 'Failed to generate tests', 'error');
            }
        } else {
            // Show results for extract text mode
            if (elements.aiResultsContainer) {
                elements.aiResultsContainer.style.display = 'block';
            }

            if (elements.aiResultText) {
                elements.aiResultText.value = data.result;
            }

            showToast('Text extracted', 'success');
        }

    } catch (error) {
        showToast('AI generation failed', 'error');
        console.error(error);
    } finally {
        // Restore button states
        if (actionBtn) {
            actionBtn.disabled = false;
            actionBtn.classList.remove('loading');
            actionBtn.innerHTML = originalHTML;
        }
        if (otherBtn) otherBtn.disabled = false;
    }
}

async function reviewTestsWithAi() {
    // Check if batch operation is needed
    if (selectedFiles.size > 0) {
        const hasMultipleSelected = selectedFiles.size > 1 ||
            (selectedFiles.size === 1 && !selectedFiles.has(currentFile?.path));
        if (hasMultipleSelected) {
            await runBatchOperation('review');
            return;
        }
    }

    if (!currentFile) {
        showToast('No file loaded', 'error');
        return;
    }

    if (!vlmConfig.has_api_key) {
        showToast('Configure API key in AI Settings first', 'error');
        openAiSettingsModal();
        return;
    }

    if (currentTests.test_rules.length === 0) {
        showToast('No tests to review', 'error');
        return;
    }

    const imageBase64 = getSelectedRegionAsBase64();

    if (!imageBase64) {
        showToast('No image available', 'error');
        return;
    }

    // Get the button and show loading state
    const reviewBtn = elements.aiReviewTestsBtn;
    const originalHTML = reviewBtn?.innerHTML;

    if (reviewBtn) {
        reviewBtn.disabled = true;
        reviewBtn.classList.add('loading');
        reviewBtn.innerHTML = '<span class="spinner"></span> Reviewing...';
    }

    // Disable other action buttons
    if (elements.aiExtractTextBtn) elements.aiExtractTextBtn.disabled = true;
    if (elements.aiGenerateTestsBtn) elements.aiGenerateTestsBtn.disabled = true;

    try {
        // Get custom prompt if provided
        const customPrompt = elements.aiCustomPrompt?.value?.trim() || null;

        // Prepare tests for review
        const testsToReview = currentTests.test_rules.map((test, index) => ({
            index,
            ...test
        }));

        const response = await fetch('/api/vlm/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: imageBase64,
                mode: 'review_tests',
                tests_to_review: testsToReview,
                additional_instructions: customPrompt,
            }),
        });

        const data = await response.json();

        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        // Store review results and show inline with tests
        if (data.review_results && Array.isArray(data.review_results)) {
            // Clear previous results and store new ones
            testReviewResults = {};
            for (const result of data.review_results) {
                testReviewResults[result.index] = result;
            }
            // Also store in cache for persistence when switching files
            if (currentFile) {
                testReviewResultsCache.set(currentFile.path, { ...testReviewResults });
            }

            // Re-render tests to show inline review feedback
            renderTestList();

            const validCount = data.review_results.filter(r => r.status === 'valid').length;
            const issueCount = data.review_results.filter(r => r.status !== 'valid').length;

            showToast(`Review complete: ${validCount} valid, ${issueCount} issues`, issueCount > 0 ? 'info' : 'success');
        } else {
            // Fallback to showing raw result if structured data unavailable
            if (elements.aiResultsContainer) {
                elements.aiResultsContainer.style.display = 'block';
            }
            if (elements.aiResultText) {
                elements.aiResultText.value = data.result || 'Review complete';
            }
            showToast('Review complete', 'success');
        }

    } catch (error) {
        showToast('Review failed', 'error');
        console.error(error);
    } finally {
        // Restore button states
        if (reviewBtn) {
            reviewBtn.disabled = false;
            reviewBtn.classList.remove('loading');
            reviewBtn.innerHTML = originalHTML;
        }
        if (elements.aiExtractTextBtn) elements.aiExtractTextBtn.disabled = false;
        if (elements.aiGenerateTestsBtn) elements.aiGenerateTestsBtn.disabled = false;
    }
}

function copyAiResult() {
    const text = elements.aiResultText?.value;
    if (!text) {
        showToast('Nothing to copy', 'error');
        return;
    }

    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard', 'success');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

// === AI Sidebar Toggle ===
function toggleAiSidebar(open = null) {
    aiSidebarOpen = open !== null ? open : !aiSidebarOpen;
    writeStoredBoolean(STORAGE_KEYS.aiSidebarOpen, aiSidebarOpen);

    const sidebar = elements.aiSidebar;
    const toggle = elements.aiSidebarToggle;

    if (aiSidebarOpen) {
        sidebar.classList.remove('collapsed');
        toggle.classList.add('hidden');
    } else {
        sidebar.classList.add('collapsed');
        toggle.classList.remove('hidden');
    }
}

function openAiSidebar() {
    toggleAiSidebar(true);
}

function closeAiSidebar() {
    toggleAiSidebar(false);
}

// === Queue Sidebar Toggle ===
function toggleSidebar(open = null) {
    sidebarOpen = open !== null ? open : !sidebarOpen;

    const sidebar = elements.sidebar;
    const toggle = elements.sidebarToggle;

    if (sidebarOpen) {
        sidebar.classList.remove('collapsed');
        toggle.classList.remove('visible');
    } else {
        sidebar.classList.add('collapsed');
        toggle.classList.add('visible');
    }
}

function openSidebar() {
    toggleSidebar(true);
}

function closeSidebar() {
    toggleSidebar(false);
}

// === Test Panel (Right Sidebar) Toggle ===
function toggleTestPanel(open = null) {
    testPanelOpen = open !== null ? open : !testPanelOpen;

    const panel = elements.testPanel;
    const toggle = elements.testPanelToggle;

    if (testPanelOpen) {
        panel.classList.remove('collapsed');
        toggle.classList.remove('visible');
    } else {
        panel.classList.add('collapsed');
        toggle.classList.add('visible');
    }
}

function openTestPanel() {
    toggleTestPanel(true);
}

function closeTestPanel() {
    toggleTestPanel(false);
}

// === AI Settings Modal ===
function openAiSettingsModal() {
    const modal = elements.aiSettingsModal;
    if (!modal) return;

    // Populate current settings
    if (elements.aiApiKeyInput) {
        elements.aiApiKeyInput.value = ''; // Don't show existing key
        elements.aiApiKeyInput.placeholder = vlmConfig.has_api_key
            ? `API key configured (${vlmConfig.api_key_source})`
            : 'Enter your Google API key';
    }

    if (elements.aiModelSelect && vlmConfig.available_models) {
        elements.aiModelSelect.innerHTML = vlmConfig.available_models
            .map(m => `<option value="${m}" ${m === vlmConfig.model ? 'selected' : ''}>${m}</option>`)
            .join('');
    }

    modal.classList.add('active');
}

function closeAiSettingsModal() {
    const modal = elements.aiSettingsModal;
    if (modal) {
        modal.classList.remove('active');
    }
}

async function testVlmConnection() {
    const btn = elements.aiTestConnectionBtn;
    const originalText = btn?.innerHTML;

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Testing...';
    }

    try {
        const response = await fetch('/api/vlm/test', { method: 'POST' });
        const data = await response.json();

        if (data.status === 'success') {
            showToast('Connection successful!', 'success');
        } else {
            showToast(data.message || 'Connection failed', 'error');
        }
    } catch (error) {
        showToast('Connection test failed', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

async function saveAiSettings() {
    const apiKey = elements.aiApiKeyInput?.value?.trim();
    const model = elements.aiModelSelect?.value;

    const updates = {};
    if (apiKey) {
        updates.api_key = apiKey;
    }
    if (model) {
        updates.model = model;
    }

    try {
        const response = await fetch('/api/vlm/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });

        const data = await response.json();

        if (data.status === 'success') {
            showToast('Settings saved', 'success');
            await fetchVlmConfig();
            closeAiSettingsModal();
        } else {
            showToast('Failed to save settings', 'error');
        }
    } catch (error) {
        showToast('Failed to save settings', 'error');
        console.error(error);
    }
}

async function extractCurrentPage(format = 'png') {
    if (!pdfDoc || !currentFile) {
        showToast('No PDF loaded', 'error');
        return;
    }

    showToast(`Extracting page ${pageNum}...`, 'info');

    try {
        const response = await fetch(buildApiUrl('/api/extract-page'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: currentFile.path,
                page: pageNum,
                format: format,
            }),
        });

        const data = await response.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        showToast(`Extracted: ${data.filename}`, 'success');
        await fetchQueue();

        await selectFileByPath(data.path);
    } catch (error) {
        showToast('Extraction failed', 'error');
        console.error(error);
    }
}

// === Test Form Handling ===
function showTestForm(type, options = {}) {
    const {
        existingRule = null,
        preserveLayoutInsertionContext = false,
    } = options;
    setGroundingPickerContext(null);
    if (!preserveLayoutInsertionContext) {
        clearLayoutInsertionContext();
    }

    if (!type) {
        if (!closeContentEditorWorkspaces()) return;
        elements.testFormContainer.classList.remove('active');
        elements.testFormContainer.innerHTML = '';
        updateAddTestSummary();
        return;
    }

    let formHtml = '';
    if (type === RAW_JSON_TEST_TYPE) {
        formHtml = renderRawJsonForm(existingRule);
    } else if (STATIC_TEST_FORM_TYPES.has(type)) {
        formHtml = testForms[type] || '';
    } else {
        const definition = getRuleDefinition(type);
        if (definition) {
            formHtml = renderDynamicRuleForm(type, definition, existingRule);
        } else {
            formHtml = renderRawJsonForm(existingRule || { type });
        }
    }

    if (!formHtml) {
        elements.testFormContainer.classList.remove('active');
        elements.testFormContainer.innerHTML = '';
        updateAddTestSummary();
        return;
    }

    setAddTestCollapsed(false);
    elements.testFormContainer.innerHTML = formHtml;
    elements.testFormContainer.classList.add('active');
    updateAddTestSummary();

    const submitType = type === RAW_JSON_TEST_TYPE ? RAW_JSON_TEST_TYPE : type;
    const form = elements.testFormContainer.querySelector('form');
    if (form) {
        if (STATIC_TEST_FORM_TYPES.has(type)) {
            injectStaticRuleTagField(form, existingRule);
        }
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                await addTest(submitType);
            } catch (error) {
                showToast(error?.message || 'Failed to add test', 'error');
                console.error(error);
            }
        });
        initTagInputWidgets(form);
        initChartArrayHelpers(form);
        const dynamicRuleType = form.dataset.dynamicRuleType;
        if (dynamicRuleType) {
            initDynamicRuleFormHelpers(form, dynamicRuleType);
        }
        initVisualGroundingForm(form, submitType, existingRule);
    }

    // Populate ontology dropdown for layout tests
    if (type === 'layout') {
        populateOntologyDropdown().then(() => {
            if (existingRule?.canonical_class) {
                const classSelect = document.getElementById('layout-class');
                if (classSelect) {
                    classSelect.value = existingRule.canonical_class;
                }
            }
            if (!existingRule) {
                const pageInput = document.getElementById('layout-page');
                if (pageInput) {
                    const defaultLayoutPage = layoutPageHelpers?.resolveNewLayoutFormPage
                        ? layoutPageHelpers.resolveNewLayoutFormPage(pageNum, layoutInsertionContext?.page)
                        : (Number.parseInt(layoutInsertionContext?.page, 10) > 0
                            ? Number.parseInt(layoutInsertionContext.page, 10)
                            : pageNum);
                    pageInput.value = String(defaultLayoutPage);
                }
            }
            toggleLayoutContentInput();
            updateLayoutReadingOrderSummary(existingRule);
        });
        const pageInput = document.getElementById('layout-page');
        if (pageInput) {
            pageInput.addEventListener('input', () => updateLayoutReadingOrderSummary(existingRule));
        }
        const classSelect = document.getElementById('layout-class');
        if (classSelect) {
            classSelect.addEventListener('change', toggleLayoutContentInput);
        }
        const tableEditorBtn = document.getElementById('layout-open-table-editor-btn');
        if (tableEditorBtn) {
            tableEditorBtn.addEventListener('click', beginTableFormEdit);
        }
        const rawHtmlBtn = document.getElementById('layout-edit-raw-html-btn');
        if (rawHtmlBtn) {
            rawHtmlBtn.addEventListener('click', focusLayoutRawHtmlField);
        }
        const formulaEditorBtn = document.getElementById('layout-open-formula-editor-btn');
        if (formulaEditorBtn) {
            formulaEditorBtn.addEventListener('click', beginFormulaFormEdit);
        }
        const rawLatexBtn = document.getElementById('layout-edit-raw-latex-btn');
        if (rawLatexBtn) {
            rawLatexBtn.addEventListener('click', focusLayoutRawLatexField);
        }
    }
}

function clearTestForm() {
    if (!closeContentEditorWorkspaces()) return;
    editingIndex = null;
    layoutDrawMode = false;
    clearLayoutInsertionContext();
    setGroundingPickerContext(null);
    elements.testTypeSelect.value = '';
    elements.testFormContainer.classList.remove('active');
    elements.testFormContainer.innerHTML = '';
    updateAddTestSummary();
}

// === Layout Test Helper Functions ===
function getCurrentOntologyType() {
    return currentTests?.ontology || 'basic';
}

async function getOntologyLabels() {
    const ontologyType = getCurrentOntologyType();

    if (cachedOntologyLabels && cachedOntologyLabels.type === ontologyType && Array.isArray(cachedOntologyLabels.labels)) {
        return cachedOntologyLabels.labels;
    }

    if (ontologyLabelsPromise && ontologyLabelsPromise.type === ontologyType) {
        return ontologyLabelsPromise.promise;
    }

    const promise = (async () => {
        try {
            const response = await fetch(`/api/ontology/${ontologyType}`);
            const data = await response.json();
            if (Array.isArray(data.labels) && data.labels.length > 0) {
                cachedOntologyLabels = { type: ontologyType, labels: data.labels };
                return data.labels;
            }
            throw new Error('No ontology labels returned');
        } catch (error) {
            console.error('Failed to fetch ontology labels:', error);
            const fallbackLabels = [
                'Formula', 'Page-footer', 'Page-header', 'Picture', 'Section', 'Table', 'Text'
            ];
            cachedOntologyLabels = { type: ontologyType, labels: fallbackLabels };
            return fallbackLabels;
        } finally {
            if (ontologyLabelsPromise?.type === ontologyType) {
                ontologyLabelsPromise = null;
            }
        }
    })();

    ontologyLabelsPromise = { type: ontologyType, promise };
    return promise;
}

async function populateOntologyDropdown() {
    const select = document.getElementById('layout-class');
    if (!select) return [];

    const labels = await getOntologyLabels();
    populateSelectWithLabels(select, labels, {
        includePlaceholder: true,
        placeholder: '-- Select class --',
    });
    return labels;
}

function populateSelectWithLabels(select, labels, options = {}) {
    const {
        includePlaceholder = true,
        placeholder = '-- Select class --',
        selectedValue = null,
    } = options;

    const allLabels = Array.isArray(labels) ? [...labels] : [];
    if (selectedValue && !allLabels.includes(selectedValue)) {
        allLabels.push(selectedValue);
    }

    select.innerHTML = '';
    if (includePlaceholder) {
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = placeholder;
        select.appendChild(placeholderOption);
    }

    allLabels.forEach(label => {
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        const color = LAYOUT_CATEGORY_COLORS[label];
        if (color) {
            option.style.borderLeft = `4px solid ${color}`;
        }
        select.appendChild(option);
    });

    if (selectedValue !== null && selectedValue !== undefined) {
        select.value = selectedValue;
    }
}

function createLayoutAttributeRow(key = '', value = '') {
    const row = document.createElement('div');
    row.className = 'attribute-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'attr-key';
    keyInput.placeholder = 'Key';
    keyInput.value = key;

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'attr-value';
    valueInput.placeholder = 'Value';
    valueInput.value = value;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-xs btn-danger btn-remove-attr';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
        row.remove();
    });

    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(removeBtn);
    return row;
}

function addLayoutAttribute(key = '', value = '') {
    const container = document.getElementById('layout-attributes-container');
    if (!container) return;

    const row = createLayoutAttributeRow(key, value);
    container.appendChild(row);
    return row;
}

function populateLayoutAttributes(attributes = {}) {
    const container = document.getElementById('layout-attributes-container');
    if (!container) return;

    container.innerHTML = '';

    const rows = layoutAttributeHelpers?.attributeRowsFromMap
        ? layoutAttributeHelpers.attributeRowsFromMap(attributes)
        : Object.entries(attributes || {}).map(([key, value]) => ({ key, value }));

    rows.forEach(({ key, value }) => {
        addLayoutAttribute(key, value);
    });
}

function collectLayoutAttributes() {
    const container = document.getElementById('layout-attributes-container');
    if (!container) return { value: {} };

    const rows = [...container.querySelectorAll('.attribute-row')].map(row => ({
        key: row.querySelector('.attr-key')?.value ?? '',
        value: row.querySelector('.attr-value')?.value ?? '',
    }));

    if (layoutAttributeHelpers?.normalizeAttributeRows) {
        return layoutAttributeHelpers.normalizeAttributeRows(rows);
    }

    const attrs = {};
    rows.forEach(({ key, value }) => {
        const normalizedKey = key.trim();
        const normalizedValue = value.trim();
        if (normalizedKey && normalizedValue) {
            attrs[normalizedKey] = normalizedValue;
        }
    });
    return { value: attrs };
}

function toggleLayoutContentInput() {
    const textarea = document.getElementById('layout-content');
    const selectedType = document.querySelector('input[name="layout-content-type"]:checked')?.value;
    const classSelect = document.getElementById('layout-class');
    const selectedClass = classSelect?.value || '';
    const actionRow = document.getElementById('layout-content-actions');
    const tableEditorBtn = document.getElementById('layout-open-table-editor-btn');
    const rawHtmlBtn = document.getElementById('layout-edit-raw-html-btn');
    const formulaEditorBtn = document.getElementById('layout-open-formula-editor-btn');
    const rawLatexBtn = document.getElementById('layout-edit-raw-latex-btn');
    const editorHint = document.getElementById('layout-content-editor-hint');
    const shouldOfferTableEditor = selectedType === 'html' || selectedClass === 'Table';
    const shouldOfferFormulaEditor = selectedType === 'text' && selectedClass === 'Formula';

    if (textarea) {
        if (selectedType === 'none') {
            textarea.style.display = 'none';
            textarea.value = '';
        } else {
            textarea.style.display = 'block';
            textarea.placeholder = selectedType === 'html' ? 'Enter HTML (e.g., <table>...)' : 'Enter text content...';
        }
    }

    if (actionRow) {
        actionRow.hidden = !(shouldOfferTableEditor || shouldOfferFormulaEditor);
    }
    if (tableEditorBtn) {
        tableEditorBtn.hidden = !shouldOfferTableEditor;
        tableEditorBtn.textContent = textarea?.value?.trim() ? 'Open Table Editor' : 'Create Table';
    }
    if (rawHtmlBtn) {
        rawHtmlBtn.hidden = !shouldOfferTableEditor;
    }
    if (formulaEditorBtn) {
        formulaEditorBtn.hidden = !shouldOfferFormulaEditor;
        formulaEditorBtn.textContent = textarea?.value?.trim() ? 'Open Formula Editor' : 'Create Formula';
    }
    if (rawLatexBtn) {
        rawLatexBtn.hidden = !shouldOfferFormulaEditor;
    }
    if (editorHint) {
        editorHint.hidden = !(shouldOfferTableEditor || shouldOfferFormulaEditor);
        editorHint.textContent = shouldOfferTableEditor
            ? 'Table editor changes only the detected table fragment. Any text before or after the table stays read-only and is preserved on save.'
            : 'Formula editor stores raw LaTeX in the text field. Use Raw LaTeX to preserve or edit outer delimiters directly.';
    }
}

function drawLayoutBbox() {
    layoutDrawMode = true;
    toggleAiSelectMode(true);
    showToast('Draw a bounding box on the document', 'info');
}

function updateLayoutReadingOrderSummary(test = null, testIndex = editingIndex) {
    const summaryEl = document.getElementById('layout-ro-display');
    const badgeEl = document.getElementById('layout-ro-badge');
    if (!summaryEl || !badgeEl) return;

    const pageInput = document.getElementById('layout-page');
    const targetPage = Number.parseInt(pageInput?.value, 10) > 0
        ? Number.parseInt(pageInput.value, 10)
        : (test ? getLayoutRulePageNumber(test) : pageNum);

    if (!test || test.type !== 'layout' || testIndex === null || testIndex === undefined) {
        const insertionContext = layoutInsertionContext && layoutInsertionContext.page === targetPage
            ? layoutInsertionContext
            : null;
        if (insertionContext) {
            const ordered = getOrderedLayoutTestsForPage(targetPage);
            const anchor = ordered.find(item => item.originalIndex === insertionContext.anchorOriginalIndex);
            if (anchor) {
                const anchorLabel = formatLayoutInsertionAnchor(anchor);
                if (insertionContext.placement === 'before') {
                    summaryEl.textContent = `New layout element will be inserted before ${anchorLabel} on page ${targetPage}.`;
                    badgeEl.textContent = `RO: ${anchor.normalizedRoIndex}`;
                    return;
                }

                const insertedRoIndex = anchor.normalizedRoIndex + 1;
                summaryEl.textContent = `New layout element will be inserted after ${anchorLabel} on page ${targetPage}.`;
                badgeEl.textContent = `RO: ${insertedRoIndex}`;
                return;
            }
        }

        summaryEl.textContent = `New layout elements on page ${targetPage} are appended to the end of that page's reading order.`;
        badgeEl.textContent = 'RO: auto';
        return;
    }

    const ordered = getOrderedLayoutTestsForPage(targetPage);
    const entry = ordered.find(item => item.originalIndex === testIndex);
    const roValue = entry?.normalizedRoIndex;

    summaryEl.textContent = `Use the Reading Order panel to move this layout element on page ${targetPage}.`;
    badgeEl.textContent = Number.isInteger(roValue) ? `RO: ${roValue}` : 'RO: auto';
}

async function addTest(type) {
    const previousTest = editingIndex !== null ? currentTests?.test_rules?.[editingIndex] : null;
    const previousLayoutPage = previousTest?.type === 'layout' ? getLayoutRulePageNumber(previousTest) : null;
    const insertionContext = editingIndex === null && type === 'layout'
        ? layoutInsertionContext
        : null;
    let test = { type, verified: true }; // Manually created tests are auto-verified

    if (type === RAW_JSON_TEST_TYPE) {
        const rawType = document.getElementById('raw-rule-type')?.value?.trim();
        const rawJsonText = document.getElementById('raw-rule-json')?.value?.trim();

        if (!rawType && !rawJsonText) {
            showToast('Raw JSON form requires a type or payload', 'error');
            return;
        }

        let payload = {};
        if (rawJsonText) {
            try {
                payload = JSON.parse(rawJsonText);
            } catch (error) {
                showToast(`Invalid JSON: ${error.message}`, 'error');
                return;
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                showToast('Rule JSON must be an object', 'error');
                return;
            }
        }

        if (!payload.type) {
            payload.type = rawType || previousTest?.type;
        }
        if (!payload.type || typeof payload.type !== 'string') {
            showToast('Raw rule type is required', 'error');
            return;
        }
        if (payload.verified === undefined) {
            payload.verified = true;
        }
        test = payload;
    } else if (!STATIC_TEST_FORM_TYPES.has(type)) {
        const definition = getRuleDefinition(type);
        if (!definition) {
            showToast(`No schema found for test type '${type}'. Use Raw JSON.`, 'error');
            return;
        }
        const serialized = serializeRuleFromDefinition(type, definition, previousTest);
        if (serialized.error) {
            showToast(serialized.error, 'error');
            return;
        }
        test = serialized.rule;
    } else {
        switch (type) {
            case 'present':
            case 'absent': {
                const textField = type === 'present' ? 'present-text' : 'absent-text';
                const text = document.getElementById(textField).value.trim();
                if (!text) {
                    showToast('Text is required', 'error');
                    return;
                }
                test.text = text;
                test.max_diffs = parseInt(document.getElementById(`${type}-max-diffs`).value) || 0;
                test.case_sensitive = document.getElementById(`${type}-case-sensitive`).checked;

                const firstN = parseInt(document.getElementById(`${type}-first-n`)?.value);
                const lastN = parseInt(document.getElementById(`${type}-last-n`)?.value);
                if (firstN > 0) test.first_n = firstN;
                if (lastN > 0) test.last_n = lastN;
                break;
            }

            case 'order': {
                const before = document.getElementById('order-before').value.trim();
                const after = document.getElementById('order-after').value.trim();
                if (!before || !after) {
                    showToast('Both before and after text are required', 'error');
                    return;
                }
                test.before = before;
                test.after = after;
                test.max_diffs = parseInt(document.getElementById('order-max-diffs').value) || 0;
                break;
            }

            case 'table': {
                const cell = document.getElementById('table-cell').value.trim();
                if (!cell) {
                    showToast('Cell value is required', 'error');
                    return;
                }
                test.cell = cell;
                test.max_diffs = parseInt(document.getElementById('table-max-diffs').value) || 0;

                // Optional fields
                const up = document.getElementById('table-up').value.trim();
                const down = document.getElementById('table-down').value.trim();
                const left = document.getElementById('table-left').value.trim();
                const right = document.getElementById('table-right').value.trim();
                const topHeading = document.getElementById('table-top-heading').value.trim();
                const leftHeading = document.getElementById('table-left-heading').value.trim();

                if (up) test.up = up;
                if (down) test.down = down;
                if (left) test.left = left;
                if (right) test.right = right;
                if (topHeading) test.top_heading = topHeading;
                if (leftHeading) test.left_heading = leftHeading;
                break;
            }

            case 'chart_data_point': {
                const chartValue = document.getElementById('chart-value').value.trim();
                const chartLabelsRaw = document.getElementById('chart-labels').value.trim();
                if (!chartValue) {
                    showToast('Value is required', 'error');
                    return;
                }
                if (!chartLabelsRaw) {
                    showToast('At least one label is required', 'error');
                    return;
                }
                // Parse labels (one per line, filter empty lines)
                const chartLabels = chartLabelsRaw.split('\n').map(l => l.trim()).filter(l => l);
                if (chartLabels.length === 0) {
                    showToast('At least one label is required', 'error');
                    return;
                }
                test.value = chartValue;
                test.labels = chartLabels;
                test.max_diffs = parseInt(document.getElementById('chart-max-diffs').value) || 2;
                test.normalize_numbers = document.getElementById('chart-normalize-numbers').checked;
                const tolerance = parseInt(document.getElementById('chart-tolerance').value) || 1;
                if (tolerance !== 1) {
                    test.relative_tolerance = tolerance / 100;  // Convert % to ratio
                }
                break;
            }

            case 'layout': {
                const layoutClass = document.getElementById('layout-class').value;
                if (!layoutClass) {
                    showToast('Layout class is required', 'error');
                    return;
                }
                const bboxX = parseFloat(document.getElementById('layout-bbox-x').value);
                const bboxY = parseFloat(document.getElementById('layout-bbox-y').value);
                const bboxW = parseFloat(document.getElementById('layout-bbox-w').value);
                const bboxH = parseFloat(document.getElementById('layout-bbox-h').value);

                if (isNaN(bboxX) || isNaN(bboxY) || isNaN(bboxW) || isNaN(bboxH)) {
                    showToast('All bounding box coordinates are required', 'error');
                    return;
                }

                test.canonical_class = layoutClass;
                test.bbox = [bboxX, bboxY, bboxW, bboxH];
                if (editingIndex !== null) {
                    const existingId = currentTests?.test_rules?.[editingIndex]?.id;
                    if (existingId) {
                        test.id = existingId;
                    }
                }

                const rawLayoutPage = document.getElementById('layout-page').value;
                test.page = layoutPageHelpers?.resolveSavedLayoutPage
                    ? layoutPageHelpers.resolveSavedLayoutPage(rawLayoutPage, previousLayoutPage, pageNum)
                    : (parseInt(rawLayoutPage, 10) > 0
                        ? parseInt(rawLayoutPage, 10)
                        : (previousLayoutPage || pageNum));
                if (editingIndex !== null && previousLayoutPage === test.page && Number.isInteger(previousTest?.ro_index)) {
                    test.ro_index = previousTest.ro_index;
                }

                const attrCollection = collectLayoutAttributes();
                if (attrCollection.error) {
                    showToast(attrCollection.error, 'error');
                    return;
                }
                const attrs = attrCollection.value || {};
                if (Object.keys(attrs).length > 0) {
                    test.attributes = attrs;
                }

                const contentType = document.querySelector('input[name="layout-content-type"]:checked')?.value;
                if (contentType && contentType !== 'none') {
                    const contentValue = document.getElementById('layout-content').value.trim();
                    if (contentValue) {
                        if (contentType === 'html') {
                            test.content = { type: 'table', html: contentValue };
                        } else {
                            test.content = { type: 'text', text: contentValue };
                        }
                    }
                }
                break;
            }
        }

        const form = elements.testFormContainer.querySelector('form');
        const staticRuleTags = collectRuleTagsFromRoot(form);
        applyRuleTagsToPayload(test, staticRuleTags);
    }

    if (shouldShowGroundingSection(type)) {
        const form = elements.testFormContainer.querySelector('form');
        const groundingSource = form?.__groundingState || previousTest || {};
        applyGroundingToRulePayload(test, groundingSource, type);
    } else if (type !== RAW_JSON_TEST_TYPE) {
        delete test.layout_elements;
    }

    const successMessage = editingIndex !== null ? 'Test updated' : 'Test added';
    let savedLayoutIndex = null;
    let savedLayoutPage = null;
    if (editingIndex !== null) {
        const prevTest = currentTests?.test_rules?.[editingIndex];
        if (prevTest && !test.id && prevTest.id) {
            test.id = prevTest.id;
        }
        currentTests.test_rules[editingIndex] = test;
        if (type === 'layout') {
            savedLayoutIndex = editingIndex;
            savedLayoutPage = getLayoutRulePageNumber(test);
            if (previousLayoutPage !== null && previousLayoutPage !== savedLayoutPage) {
                normalizeLayoutPages([previousLayoutPage]);
                placeLayoutTestInReadingOrder(editingIndex, savedLayoutPage);
            } else {
                normalizeLayoutPages([savedLayoutPage]);
            }
        }
    } else {
        currentTests.test_rules.push(test);
        if (type === 'layout') {
            savedLayoutIndex = currentTests.test_rules.length - 1;
            savedLayoutPage = getLayoutRulePageNumber(test);
            placeLayoutTestInReadingOrder(savedLayoutIndex, savedLayoutPage, insertionContext);
        }
    }

    const savedTests = await saveTests(editingIndex !== null ? 'update-test' : 'add-test');
    if (!savedTests) {
        return;
    }
    showToast(successMessage, 'success');
    renderTestList();
    closeContentEditorWorkspaces({ discardChanges: true, suppressWarning: true });
    clearTestForm();
    if (savedLayoutIndex !== null && savedLayoutPage === pageNum) {
        selectLayoutTest(savedLayoutIndex);
    }
}

async function deleteTest(index) {
    const deletedTest = currentTests.test_rules[index];
    const deletedPage = deletedTest?.type === 'layout' ? getLayoutRulePageNumber(deletedTest) : null;

    if (tableEditorSession?.source === 'card') {
        if (tableEditorSession.testIndex === index) {
            closeTableEditorWorkspace({ discardChanges: true, suppressWarning: true });
        } else if (tableEditorSession.testIndex > index) {
            tableEditorSession.testIndex -= 1;
        }
    }
    if (formulaEditorSession?.source === 'card') {
        if (formulaEditorSession.testIndex === index) {
            closeFormulaEditorWorkspace({ discardChanges: true, suppressWarning: true });
        } else if (formulaEditorSession.testIndex > index) {
            formulaEditorSession.testIndex -= 1;
        }
    }

    if (selectedLayoutTestIndex === index) {
        selectedLayoutTestIndex = null;
    } else if (selectedLayoutTestIndex !== null && selectedLayoutTestIndex > index) {
        selectedLayoutTestIndex--;
    }
    if (markdownTagEditingIndex === index) {
        markdownTagEditingIndex = null;
    } else if (markdownTagEditingIndex !== null && markdownTagEditingIndex > index) {
        markdownTagEditingIndex -= 1;
    }
    remapMarkdownBulkSelectionAfterDelete(index);

    currentTests.test_rules.splice(index, 1);
    if (deletedPage !== null) {
        normalizeLayoutPages([deletedPage]);
    }

    const savedTests = await saveTests('delete-test');
    if (!savedTests) return;
    renderTestList();
    if (markdownPanelOpen) {
        renderMarkdownPanel({ preserveScroll: true });
    }
    showToast('Test deleted', 'info');
}

async function clearAllTests() {
    const count = currentTests.test_rules.length;
    if (count === 0) {
        showToast('No tests to clear', 'info');
        return;
    }

    const confirmed = confirm(`Are you sure you want to delete all ${count} test rule${count > 1 ? 's' : ''}?\n\nThis cannot be undone.`);

    if (confirmed) {
        closeContentEditorWorkspaces({ discardChanges: true, suppressWarning: true });
        currentTests.test_rules = [];
        markdownTagEditingIndex = null;
        clearMarkdownBulkSelection({ rerender: false });
        const savedTests = await saveTests('clear-all-tests');
        if (!savedTests) return;
        renderTestList();
        if (markdownPanelOpen) {
            renderMarkdownPanel({ preserveScroll: true });
        }
        showToast(`Cleared ${count} test rules`, 'success');
    }
}

async function toggleTestVerification(index) {
    const test = currentTests.test_rules[index];
    if (!test) return;

    test.verified = !test.verified;
    const savedTests = await saveTests('toggle-test-verification');
    if (!savedTests) return;
    renderTestList();
    updateCompleteButtonState();

    showToast(test.verified ? 'Test verified' : 'Test marked as unverified', 'info');
}

function clearTestReview(index) {
    delete testReviewResults[index];
    // Update cache
    if (currentFile) {
        if (Object.keys(testReviewResults).length > 0) {
            testReviewResultsCache.set(currentFile.path, { ...testReviewResults });
        } else {
            testReviewResultsCache.delete(currentFile.path);
        }
    }
    renderTestList();
}

function clearAllReviews() {
    testReviewResults = {};
    // Update cache
    if (currentFile) {
        testReviewResultsCache.delete(currentFile.path);
    }
    renderTestList();
}

async function verifyAllTests() {
    let verifiedCount = 0;
    for (const test of currentTests.test_rules) {
        if (!test.verified) {
            test.verified = true;
            verifiedCount++;
        }
    }

    if (verifiedCount > 0) {
        const savedTests = await saveTests('verify-all-tests');
        if (!savedTests) return;
        renderTestList();
        updateCompleteButtonState();
        showToast(`Verified ${verifiedCount} tests`, 'success');
    } else {
        showToast('All tests already verified', 'info');
    }
}

function getUnverifiedCount() {
    // Only count as unverified if explicitly set to false (not undefined)
    return currentTests.test_rules.filter(t => t.verified === false).length;
}

function updateCompleteButtonState() {
    const unverifiedCount = getUnverifiedCount();
    const completeBtn = elements.completeFile;

    if (completeBtn) {
        if (annotationMode === ANNOTATION_MODE_EXTRACT) {
            completeBtn.disabled = false;
            completeBtn.title = '';
            return;
        }
        if (unverifiedCount > 0) {
            completeBtn.disabled = true;
            completeBtn.title = `Verify ${unverifiedCount} unverified test${unverifiedCount > 1 ? 's' : ''} first`;
        } else {
            completeBtn.disabled = false;
            completeBtn.title = '';
        }
    }
}

function editTest(index) {
    if (!closeContentEditorWorkspaces()) return;
    const test = currentTests.test_rules[index];
    if (!test) return;

    editingIndex = index;

    const hasDefinition = Boolean(getRuleDefinition(test.type));
    const formType = hasDefinition || STATIC_TEST_FORM_TYPES.has(test.type) ? test.type : RAW_JSON_TEST_TYPE;

    elements.testTypeSelect.value = formType;
    showTestForm(formType, { existingRule: test });

    // Pre-fill legacy/static forms using existing behavior
    if (STATIC_TEST_FORM_TYPES.has(test.type)) {
        setTimeout(async () => {
            switch (test.type) {
                case 'present':
                case 'absent':
                    document.getElementById(`${test.type}-text`).value = test.text || '';
                    document.getElementById(`${test.type}-max-diffs`).value = test.max_diffs || 0;
                    document.getElementById(`${test.type}-case-sensitive`).checked = test.case_sensitive !== false;
                    const firstNEl = document.getElementById(`${test.type}-first-n`);
                    const lastNEl = document.getElementById(`${test.type}-last-n`);
                    if (firstNEl && test.first_n) firstNEl.value = test.first_n;
                    if (lastNEl && test.last_n) lastNEl.value = test.last_n;
                    break;

                case 'order':
                    document.getElementById('order-before').value = test.before || '';
                    document.getElementById('order-after').value = test.after || '';
                    document.getElementById('order-max-diffs').value = test.max_diffs || 0;
                    break;

                case 'table':
                    document.getElementById('table-cell').value = test.cell || '';
                    document.getElementById('table-max-diffs').value = test.max_diffs || 0;
                    document.getElementById('table-up').value = test.up || '';
                    document.getElementById('table-down').value = test.down || '';
                    document.getElementById('table-left').value = test.left || '';
                    document.getElementById('table-right').value = test.right || '';
                    document.getElementById('table-top-heading').value = test.top_heading || '';
                    document.getElementById('table-left-heading').value = test.left_heading || '';
                    break;

                case 'chart_data_point':
                    document.getElementById('chart-value').value = test.value || '';
                    document.getElementById('chart-labels').value = (test.labels || []).join('\n');
                    document.getElementById('chart-max-diffs').value = test.max_diffs || 2;
                    document.getElementById('chart-normalize-numbers').checked = test.normalize_numbers !== false;
                    document.getElementById('chart-tolerance').value = test.relative_tolerance ? Math.round(test.relative_tolerance * 100) : 1;
                    break;

                case 'layout':
                    await populateOntologyDropdown();
                    document.getElementById('layout-class').value = test.canonical_class || '';
                    document.getElementById('layout-page').value = test.page || 1;
                    if (test.bbox && test.bbox.length === 4) {
                        document.getElementById('layout-bbox-x').value = test.bbox[0];
                        document.getElementById('layout-bbox-y').value = test.bbox[1];
                        document.getElementById('layout-bbox-w').value = test.bbox[2];
                        document.getElementById('layout-bbox-h').value = test.bbox[3];
                    }
                    populateLayoutAttributes(test.attributes || {});
                    if (test.content) {
                        const contentType = test.content.type === 'table' ? 'html' : 'text';
                        const contentValue = test.content.type === 'table' ? test.content.html : test.content.text;
                        const radio = document.querySelector(`input[name="layout-content-type"][value="${contentType}"]`);
                        if (radio) radio.checked = true;
                        toggleLayoutContentInput();
                        if (contentValue) {
                            document.getElementById('layout-content').value = contentValue;
                        }
                    }
                    updateLayoutReadingOrderSummary(test, index);
                    break;
            }
        }, 0);
    }

    // Ensure raw fallback form displays original payload when unknown type
    if (!hasDefinition && !STATIC_TEST_FORM_TYPES.has(test.type)) {
        const rawTypeEl = document.getElementById('raw-rule-type');
        const rawJsonEl = document.getElementById('raw-rule-json');
        if (rawTypeEl) rawTypeEl.value = test.type || '';
        if (rawJsonEl) rawJsonEl.value = JSON.stringify(test, null, 2);
    }

    const submitBtn = elements.testFormContainer.querySelector('button[type="submit"]');
    if (submitBtn) {
        submitBtn.textContent = 'Update Test';
    }

    // Scroll the test form into view
    elements.testFormContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderGroundingLinkChip(layoutId, layoutIndexById) {
    const normalizedId = sanitizeLayoutIdValue(layoutId);
    if (!normalizedId) return '';
    const exists = layoutIndexById.has(normalizedId);
    const missingClass = exists ? '' : ' missing';
    const clickable = exists
        ? `<button type="button" class="grounding-chip-jump" data-layout-link-id="${escapeHtml(normalizedId)}" title="Jump to linked layout">${escapeHtml(truncate(normalizedId, 24))}</button>`
        : `<span class="grounding-chip-jump">${escapeHtml(truncate(normalizedId, 24))}</span>`;
    return `<span class="tag-chip grounding-chip${missingClass}">${clickable}</span>`;
}

function buildGroundingSummaryHtml(test, layoutIndexById) {
    if (test?.type === 'layout') return '';

    const grounding = getNormalizedRuleGrounding(test || {}, test?.type || '');
    const hasIds = grounding.layout_ids.length > 0;
    const hasBindings = grounding.layout_bindings && Object.keys(grounding.layout_bindings).length > 0;
    if (!hasIds && !hasBindings) return '';

    const invalidIds = grounding.layout_ids.filter(id => !layoutIndexById.has(id));
    let rows = '';

    if (test.type === 'order' && hasBindings) {
        rows = GROUNDING_ROLE_ORDER.map(role => {
            const raw = grounding.layout_bindings[role];
            const value = Array.isArray(raw) ? raw[0] : raw;
            if (!value) return '';
            return `
                <div class="grounding-summary-row">
                    <span class="grounding-summary-role">${escapeHtml(role)}</span>
                    <div class="grounding-summary-chips">${renderGroundingLinkChip(value, layoutIndexById)}</div>
                </div>
            `;
        }).join('');
    } else if (hasIds) {
        const chips = grounding.layout_ids.map(id => renderGroundingLinkChip(id, layoutIndexById)).join('');
        rows = `
            <div class="grounding-summary-row">
                <span class="grounding-summary-role">layout</span>
                <div class="grounding-summary-chips">${chips || '<span class="grounding-empty-value">No linked layout element</span>'}</div>
            </div>
        `;
    }

    const warningHtml = invalidIds.length > 0
        ? `<div class="grounding-summary-warning">Missing layout id${invalidIds.length > 1 ? 's' : ''}: ${escapeHtml(invalidIds.map(id => truncate(id, 18)).join(', '))}</div>`
        : '';

    return `
        <div class="grounding-summary-block">
            <div class="grounding-summary-title">Visual Grounding</div>
            ${rows}
            ${warningHtml}
        </div>
    `;
}

function renderTestList() {
    if (annotationMode === ANNOTATION_MODE_EXTRACT) {
        return;
    }
    const rules = currentTests.test_rules;
    const unverifiedCount = getUnverifiedCount();
    populateRuleListFilterOptions(rules);
    // Layout rules are scoped to the current PDF page so the labeller
    // only sees overlays they can actually edit. Non-layout rules
    // (present, absent, order, ...) are page-agnostic and stay
    // visible regardless of which page is on screen.
    const filteredRules = rules
        .map((rule, index) => ({ rule, index }))
        .filter(({ rule }) => {
            if (!ruleMatchesActiveFilters(rule)) return false;
            if (rule?.type === 'layout') {
                return getLayoutRulePageNumber(rule) === pageNum;
            }
            return true;
        });
    const layoutIndexById = new Map(
        rules
            .map((rule, index) => {
                if (rule?.type !== 'layout') return null;
                const layoutId = sanitizeLayoutIdValue(rule?.id);
                if (!layoutId) return null;
                return [layoutId, index];
            })
            .filter(Boolean)
    );

    // Update test count: include the per-page layout count so the
    // labeller can see at a glance how many layout rules live on
    // this page vs. the whole doc.
    const layoutRuleCount = rules.reduce(
        (acc, r) => acc + (r?.type === 'layout' ? 1 : 0), 0,
    );
    const layoutOnPageCount = rules.reduce(
        (acc, r) => acc + (r?.type === 'layout' && getLayoutRulePageNumber(r) === pageNum ? 1 : 0),
        0,
    );
    const layoutSummary = layoutRuleCount > 0
        ? ` · ${layoutOnPageCount} layout on page ${pageNum} of ${layoutRuleCount}`
        : '';
    const visibleSuffix = filteredRules.length !== rules.length
        ? ` | showing ${filteredRules.length}`
        : '';
    if (unverifiedCount > 0) {
        elements.testCount.innerHTML = `${rules.length} rules, <span class="unverified-count">${unverifiedCount} unverified</span>${layoutSummary}${visibleSuffix}`;
    } else {
        elements.testCount.textContent = `${rules.length} rules${layoutSummary}${visibleSuffix}`;
    }

    if (rules.length === 0) {
        elements.testList.innerHTML = '<p class="empty-state">No tests defined yet. Add a test above.</p>';
        updateCompleteButtonState();
        return;
    }

    if (filteredRules.length === 0) {
        elements.testList.innerHTML = '<p class="empty-state">No rules match the active filters.</p>';
        updateCompleteButtonState();
        return;
    }

    elements.testList.innerHTML = filteredRules.map(({ rule: test, index }) => {
        let content = '';
        const isVerified = test.verified !== false; // Treat undefined as verified (for backwards compat)
        const reviewResult = testReviewResults[index]; // Get AI review result if available

        switch (test.type) {
            case 'present':
            case 'absent':
                content = `
                    <div class="field">
                        <span class="field-label">Text:</span>
                        <span class="field-value">${truncate(test.text)}</span>
                    </div>
                    ${test.max_diffs > 0 ? `<div class="field"><span class="field-label">Max diffs:</span> ${test.max_diffs}</div>` : ''}
                `;
                break;
            case 'order':
                content = `
                    <div class="field">
                        <span class="field-label">Before:</span>
                        <span class="field-value">${truncate(test.before)}</span>
                    </div>
                    <div class="field">
                        <span class="field-label">After:</span>
                        <span class="field-value">${truncate(test.after)}</span>
                    </div>
                `;
                break;
            case 'table':
                content = `
                    <div class="field">
                        <span class="field-label">Cell:</span>
                        <span class="field-value">${truncate(test.cell)}</span>
                    </div>
                    ${test.top_heading ? `<div class="field"><span class="field-label">Top heading:</span> <span class="field-value">${truncate(test.top_heading)}</span></div>` : ''}
                    ${test.left_heading ? `<div class="field"><span class="field-label">Left heading:</span> <span class="field-value">${truncate(test.left_heading)}</span></div>` : ''}
                `;
                break;
            case 'chart_data_point':
                const labelsDisplay = (test.labels || []).map(l => truncate(l, 30)).join(', ');
                content = `
                    <div class="field">
                        <span class="field-label">Value:</span>
                        <span class="field-value">${truncate(test.value)}</span>
                    </div>
                    <div class="field">
                        <span class="field-label">Labels:</span>
                        <span class="field-value">${labelsDisplay}</span>
                    </div>
                    ${test.normalize_numbers ? '<div class="field"><span class="field-label">Numbers:</span> <span class="field-value">Normalized</span></div>' : ''}
                    ${test.relative_tolerance && test.relative_tolerance !== 0.01 ? `<div class="field"><span class="field-label">Tolerance:</span> <span class="field-value">${Math.round(test.relative_tolerance * 100)}%</span></div>` : ''}
                `;
                break;
            case 'layout':
                const className = test.canonical_class || 'Unknown';
                const bboxDisplay = test.bbox ? `[${test.bbox.map(v => v.toFixed(3)).join(', ')}]` : 'N/A';
                const attrsDisplay = test.attributes && Object.keys(test.attributes).length > 0
                    ? Object.entries(test.attributes).map(([k, v]) => `${k}: ${v}`).join(', ')
                    : '';
                // content is a LayoutContent object: {type: "text", text: "..."} or {type: "table", html: "..."}
                let contentPreview = '';
                if (test.content) {
                    if (test.content.type === 'table') {
                        contentPreview = '[HTML Table]';
                    } else if (test.content.type === 'text' && test.content.text) {
                        contentPreview = truncate(test.content.text, 40);
                    }
                }
                const color = LAYOUT_CATEGORY_COLORS[className] || '#888888';
                content = `
                    <div class="field">
                        <span class="layout-class-badge" style="background: ${color}; color: #000; padding: 2px 8px; border-radius: 4px;">${className}</span>
                        ${test.ro_index !== undefined && test.ro_index !== null ? `<span class="layout-ro-badge" title="Reading order">RO: ${test.ro_index}</span>` : ''}
                    </div>
                    <div class="field">
                        <span class="field-label">Bbox:</span>
                        <span class="field-value">${bboxDisplay}</span>
                    </div>
                    ${test.page !== undefined ? `<div class="field"><span class="field-label">Page:</span> ${test.page}</div>` : ''}
                    ${attrsDisplay ? `<div class="field"><span class="field-label">Attrs:</span> <span class="field-value">${attrsDisplay}</span></div>` : ''}
                    ${contentPreview ? `<div class="field"><span class="field-label">Content:</span> <span class="field-value">${contentPreview}</span></div>` : ''}
                `;
                break;
            default:
                const definition = getRuleDefinition(test.type);
                if (definition) {
                    content = renderRuleSummaryFromDefinition(test, definition);
                } else {
                    content = `
                        <div class="field">
                            <span class="field-label">Type:</span>
                            <span class="field-value">${escapeHtml(test.type || 'unknown')}</span>
                        </div>
                        <div class="field">
                            <span class="field-label">Payload:</span>
                            <span class="field-value">${escapeHtml(truncate(JSON.stringify(test), 90))}</span>
                        </div>
                    `;
                }
                break;
        }

        // Build review feedback HTML if available
        let reviewHtml = '';
        if (reviewResult) {
            const statusIcon = reviewResult.status === 'valid' ? '✓' : reviewResult.status === 'warning' ? '⚠' : '✗';
            const statusClass = reviewResult.status === 'valid' ? 'review-valid' : reviewResult.status === 'warning' ? 'review-warning' : 'review-error';
            reviewHtml = `
                <div class="test-review-feedback ${statusClass}">
                    <span class="review-icon">${statusIcon}</span>
                    <span class="review-message">${reviewResult.message}</span>
                    <button class="btn btn-xs btn-clear-review" onclick="clearTestReview(${index})" title="Dismiss">×</button>
                </div>
            `;
        }

        const verifyBtn = isVerified
            ? `<button class="btn btn-sm btn-verified" onclick="toggleTestVerification(${index})" title="Click to unverify">✓</button>`
            : `<button class="btn btn-sm btn-unverified" onclick="toggleTestVerification(${index})" title="Click to verify">?</button>`;

        // Determine additional class based on review status
        const reviewClass = reviewResult ? `has-review review-${reviewResult.status}` : '';
        // Additional class for layout tests when selected
        const selectedClass = test.type === 'layout' && selectedLayoutTestIndex === index ? 'layout-selected' : '';

        const idBadge = test.id ? `<span class="test-id-badge">id: ${truncate(test.id, 8)}</span>` : '';
        const groundingHtml = buildGroundingSummaryHtml(test, layoutIndexById);
        const tagsHtml = renderRuleTagsHtml(test.tags, {
            containerClass: 'test-item-header-tags',
            chipClass: 'tag-chip test-item-header-tag',
        });

        // `content-visibility: auto` lets the browser skip layout
        // and paint for rows scrolled out of the side-panel viewport.
        // `contain-intrinsic-size` reserves a placeholder height so
        // scrollbar geometry stays stable. Cheapest virtualization
        // available — no JS, no IntersectionObserver.
        return `
            <div class="test-item ${isVerified ? '' : 'unverified'} ${reviewClass} ${selectedClass}" data-test-index="${index}"
                 style="content-visibility: auto; contain-intrinsic-size: 0 96px;"
                 ${test.type === 'layout' ? `onclick="selectLayoutTest(${index})"` : ''}>
                <div class="test-item-header">
                    <div class="test-item-left">
                        ${verifyBtn}
                        <span class="test-type-badge ${test.type}">${test.type}</span>
                        ${idBadge}
                        ${tagsHtml}
                    </div>
                    <div class="test-item-actions">
                        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); editTest(${index})">Edit</button>
                        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteTest(${index})">Delete</button>
                    </div>
                </div>
                <div class="test-item-content">${content}</div>
                ${groundingHtml}
                ${reviewHtml}
            </div>
        `;
    }).join('');

    updateCompleteButtonState();

    // Re-render layout overlay when tests change
    renderLayoutOverlay();

    // Update markdown preview button state and re-render if open
    updateMarkdownPreviewButton();
    if (markdownPanelOpen) {
        renderMarkdownPanel();
    }
}

// === Navigation ===
function navigateFile(direction) {
    const newIndex = currentFileIndex + direction;
    if (newIndex >= 0 && newIndex < files.length) {
        selectFile(newIndex);
    }
}

async function markFileStatus(status) {
    if (!currentFile) return;

    // Check for unverified tests when marking as completed
    if (status === 'completed' && annotationMode === ANNOTATION_MODE_PARSE) {
        const unverifiedCount = getUnverifiedCount();
        if (unverifiedCount > 0) {
            showToast(`Please verify ${unverifiedCount} unverified test${unverifiedCount > 1 ? 's' : ''} first`, 'error');
            return;
        }
    }

    // Save active annotation payload before marking
    if (annotationMode === ANNOTATION_MODE_EXTRACT) {
        const saved = await saveExtractEditor(false);
        if (!saved) return;
    } else {
        currentTests.expected_markdown = elements.expectedMarkdown.value || null;
        const saved = await saveTests('mark-file-status');
        if (!saved) return;
    }

    await updateFileStatus(currentFile.path, status);

    // Move to next pending file
    const nextPending = files.findIndex((f, i) => i > currentFileIndex && f.status === 'pending');
    if (nextPending !== -1) {
        selectFile(nextPending);
    } else {
        // Try from beginning
        const firstPending = files.findIndex(f => f.status === 'pending');
        if (firstPending !== -1) {
            selectFile(firstPending);
        }
    }
}

// === Drag and Drop Upload ===
function initDragAndDrop() {
    const sidebar = elements.sidebar;
    let dragCounter = 0;

    // Prevent default drag behaviors on document
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    // Highlight drop zone when dragging over sidebar
    sidebar.addEventListener('dragenter', (e) => {
        dragCounter++;
        if (queueDir) {
            sidebar.classList.add('drag-over');
        }
    });

    sidebar.addEventListener('dragleave', (e) => {
        dragCounter--;
        if (dragCounter === 0) {
            sidebar.classList.remove('drag-over');
        }
    });

    sidebar.addEventListener('dragover', (e) => {
        e.dataTransfer.dropEffect = 'copy';
    });

    sidebar.addEventListener('drop', async (e) => {
        dragCounter = 0;
        sidebar.classList.remove('drag-over');

        if (!queueDir) {
            showToast('Select a directory first', 'error');
            return;
        }

        const files = e.dataTransfer.files;
        if (files.length === 0) return;

        await uploadFiles(files);
    });
}

async function uploadFiles(fileList) {
    const formData = new FormData();
    let validFiles = 0;

    for (const file of fileList) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (['pdf', 'png', 'jpg', 'jpeg', 'jfif'].includes(ext)) {
            formData.append('files', file);
            validFiles++;
        }
    }

    if (validFiles === 0) {
        showToast('No supported files found (PDF, PNG, JPG)', 'error');
        return;
    }

    showToast(`Uploading ${validFiles} file(s)...`, 'info');

    try {
        const response = await fetch(buildApiUrl('/api/upload'), {
            method: 'POST',
            body: formData,
        });

        const data = await response.json();

        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        if (data.count > 0) {
            showToast(`Uploaded ${data.count} file(s)`, 'success');
            await fetchQueue();

            // Select the first uploaded file
            if (data.uploaded.length > 0) {
                await selectFileByPath(data.uploaded[0]);
            }
        }

        if (data.errors.length > 0) {
            showToast(`${data.errors.length} file(s) failed`, 'error');
            console.error('Upload errors:', data.errors);
        }
    } catch (error) {
        showToast('Upload failed', 'error');
        console.error(error);
    }
}

// === Directory Browser ===
async function openBrowseModal() {
    if (queueScopedMode) {
        showToast('This annotator session is locked to a generated queue', 'error');
        return;
    }
    elements.browseModal.classList.add('active');
    await browseDirectory(queueDir || '');
}

function closeBrowseModal() {
    elements.browseModal.classList.remove('active');
}

async function browseDirectory(path) {
    try {
        const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
        const response = await fetch(url);
        const data = await response.json();

        browseCurrentPath = data.current;
        elements.browsePathInput.value = data.current;
        elements.browseUp.disabled = !data.parent;

        renderBrowseList(data.items);
    } catch (error) {
        showToast('Failed to browse directory', 'error');
        console.error(error);
    }
}

function renderBrowseList(items) {
    if (items.length === 0) {
        elements.browseList.innerHTML = '<div class="browse-empty">No subdirectories found</div>';
        return;
    }

    elements.browseList.innerHTML = items.map(item => `
        <div class="browse-item" data-path="${item.path}" ondblclick="browseDirectory('${item.path}')">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"/>
            </svg>
            <span class="browse-item-name">${item.name}</span>
            ${item.file_count > 0 ? `<span class="browse-item-count">${item.file_count} files</span>` : ''}
        </div>
    `).join('');

    // Add click handlers for selection
    elements.browseList.querySelectorAll('.browse-item').forEach(el => {
        el.addEventListener('click', (e) => {
            // Remove previous selection
            elements.browseList.querySelectorAll('.browse-item').forEach(item => {
                item.classList.remove('selected');
            });
            // Add selection to clicked item
            el.classList.add('selected');
            // Update path input
            elements.browsePathInput.value = el.dataset.path;
        });
    });
}

async function confirmBrowseSelection() {
    const path = elements.browsePathInput.value.trim();
    if (!path) {
        showToast('Please enter or select a directory', 'error');
        return;
    }

    const success = await setQueueDirectory(path);
    if (success) {
        closeBrowseModal();

        await selectInitialQueueFile();
    }
}

// === Resizer ===
const MIN_RESIZABLE_PDF_PANEL_WIDTH = 220;
const MIN_RESIZABLE_TEST_PANEL_WIDTH = 300;

function getMaxTestPanelWidth(containerRect) {
    return Math.max(
        MIN_RESIZABLE_TEST_PANEL_WIDTH,
        containerRect.width - MIN_RESIZABLE_PDF_PANEL_WIDTH,
    );
}

function initResizer() {
    const pdfPanel = document.querySelector('.pdf-panel');
    const testPanel = document.querySelector('.test-panel');
    const resizerPdf = elements.resizerPdf;
    const resizerTest = elements.resizerTest;

    let activeResizer = null;

    // Helper to setup a resizer
    function setupResizer(resizer) {
        if (!resizer) return;

        resizer.addEventListener('mousedown', (e) => {
            activeResizer = resizer;
            resizer.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });
    }

    // Setup resizers
    setupResizer(resizerPdf);
    setupResizer(resizerTest);

    document.addEventListener('mousemove', (e) => {
        if (!activeResizer) return;

        const containerRect = document.querySelector('.split-pane').getBoundingClientRect();

        if (activeResizer === resizerPdf) {
            // Resizing PDF panel - markdown panel will flex to fill remaining space
            const newPdfWidth = e.clientX - containerRect.left;
            if (newPdfWidth >= 200 && newPdfWidth <= containerRect.width - 600) {
                pdfPanel.style.flex = 'none';
                pdfPanel.style.width = `${newPdfWidth}px`;
            }
        } else if (activeResizer === resizerTest && testPanel) {
            // Resizing Test panel (from right edge)
            const newWidth = containerRect.right - e.clientX;
            if (
                newWidth >= MIN_RESIZABLE_TEST_PANEL_WIDTH
                && newWidth <= getMaxTestPanelWidth(containerRect)
            ) {
                testPanel.style.width = `${newWidth}px`;
            }
        }
    });

    document.addEventListener('mouseup', () => {
        if (activeResizer) {
            activeResizer.classList.remove('active');
            activeResizer = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// === Keyboard Shortcuts ===
function shouldIgnoreKeyboardShortcutTarget(target) {
    const element = target?.nodeType === 3 ? target.parentElement : target;
    if (!element) return false;

    const tagName = element.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'MATH-FIELD') {
        return true;
    }

    if (element.isContentEditable) {
        return true;
    }

    if (typeof element.closest === 'function') {
        return Boolean(
            element.closest('[contenteditable="true"]')
            || element.closest('.sun-editor')
            || element.closest('.table-editor-shell')
            || element.closest('.formula-editor-shell')
            || element.closest('.markdown-formula-editor')
            || element.closest('math-field')
        );
    }

    return false;
}

function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Skip if typing into any editable surface, including SunEditor cells.
        if (shouldIgnoreKeyboardShortcutTarget(e.target)) return;

        // Ctrl/Cmd+Z while in EXTRACT mode undoes the most recent stray
        // reassignment. Single-level — not a general edit history.
        const isUndo = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z' && !e.shiftKey;
        if (isUndo && annotationMode === ANNOTATION_MODE_EXTRACT && lastExtractReassignment) {
            e.preventDefault();
            _undoLastReassignment();
            return;
        }

        // Skip if Cmd/Ctrl/Alt is pressed (allow browser shortcuts like Cmd+R to work)
        // Shift is allowed for Shift+D (delete)
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        switch (e.key.toLowerCase()) {
            case 'j':
            case 'arrowdown':
                navigateFile(1);
                break;
            case 'k':
            case 'arrowup':
                navigateFile(-1);
                break;
            case 'd':
                if (e.shiftKey) {
                    // Shift+D = delete file permanently
                    deleteCurrentFile();
                } else {
                    markFileStatus('skipped');
                }
                break;
            case 'enter':
                markFileStatus('completed');
                break;
            case 'u':
                markFileStatus('pending');
                break;
            case 'r':
                renameCurrentFile();
                break;
            case 'arrowleft':
                if (pdfDoc && pageNum > 1) {
                    pageNum--;
                    renderPage(pageNum);
                }
                break;
            case 'arrowright':
                if (pdfDoc && pageNum < pdfDoc.numPages) {
                    pageNum++;
                    renderPage(pageNum);
                }
                break;
            case 'x':
                // Extract current page (only for multi-page PDFs)
                if (pdfDoc && isMultiPagePdf && capabilities.extract_page) {
                    extractCurrentPage('pdf');
                }
                break;
            case 'a':
                // Toggle AI select mode and open sidebar
                if (currentFile) {
                    if (!aiSelectMode) {
                        openAiSidebar();
                    }
                    toggleAiSelectMode();
                }
                break;
            case 'escape':
                // Cancel AI select mode, clear selection, or clear extract field selection
                if (aiSelectMode) {
                    // toggleAiSelectMode(false) now clears extractDrawContext
                    // itself; snapshot first so we can still show the toast.
                    const cancellingExtractDraw = Boolean(extractDrawContext);
                    toggleAiSelectMode(false);
                    layoutDrawMode = false;
                    if (cancellingExtractDraw) {
                        showToast('Draw cancelled', 'info');
                    }
                } else if (currentSelection) {
                    clearSelectionBox();
                } else if (annotationMode === ANNOTATION_MODE_EXTRACT && selectedExtractFieldPath) {
                    selectExtractFieldPath(null, { navigateIfNeeded: false });
                    e.preventDefault();
                }
                break;
            case 'delete':
            case 'backspace':
                // Delete the selected extract bbox (not the whole rule).
                if (annotationMode === ANNOTATION_MODE_EXTRACT
                    && selectedExtractFieldPath
                    && selectedExtractBboxIndex != null) {
                    const ruleIdx = _findExtractRuleIndexByPath(selectedExtractFieldPath);
                    if (ruleIdx >= 0) {
                        _deleteExtractBboxAt(ruleIdx, selectedExtractBboxIndex);
                        e.preventDefault();
                    }
                }
                break;
            case 'l':
                // Toggle layout overlay visibility
                if (currentFile) {
                    toggleLayoutOverlay();
                }
                break;
            case '[':
                // Toggle/collapse queue sidebar
                toggleSidebar();
                break;
            case ']':
                // Toggle/collapse test panel
                toggleTestPanel();
                break;
            case 'm':
                // Toggle markdown preview panel
                if (currentFile && hasMarkdownContent()) {
                    toggleMarkdownPanel();
                }
                break;
        }
    });
}

// === Event Listeners ===
function initEventListeners() {
    // Directory browser
    elements.selectDirBtn.addEventListener('click', openBrowseModal);
    elements.closeBrowse.addEventListener('click', closeBrowseModal);
    elements.cancelBrowse.addEventListener('click', closeBrowseModal);
    elements.confirmBrowse.addEventListener('click', confirmBrowseSelection);
    elements.browseUp.addEventListener('click', async () => {
        const parts = browseCurrentPath.split('/');
        parts.pop();
        const parent = parts.join('/') || '/';
        await browseDirectory(parent);
    });
    elements.browseGo.addEventListener('click', () => {
        browseDirectory(elements.browsePathInput.value.trim());
    });
    elements.browsePathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            browseDirectory(elements.browsePathInput.value.trim());
        }
    });
    elements.browseModal.addEventListener('click', (e) => {
        if (e.target === elements.browseModal) {
            closeBrowseModal();
        }
    });

    // File upload
    elements.addFilesBtn.addEventListener('click', () => {
        if (!queueDir) {
            showToast('Select a directory first', 'error');
            return;
        }
        elements.fileInput.click();
    });
    elements.fileInput.addEventListener('change', async (e) => {
        if (e.target.files.length > 0) {
            await uploadFiles(e.target.files);
            e.target.value = ''; // Reset input
        }
    });

    // Navigation
    elements.prevFile.addEventListener('click', () => navigateFile(-1));
    elements.nextFile.addEventListener('click', () => navigateFile(1));
    elements.skipFile.addEventListener('click', () => markFileStatus('skipped'));
    elements.completeFile.addEventListener('click', () => markFileStatus('completed'));
    elements.renameFile.addEventListener('click', () => renameCurrentFile());
    elements.deleteFile.addEventListener('click', () => deleteCurrentFile());
    elements.refreshQueue.addEventListener('click', fetchQueue);

    if (elements.documentTagsToggle) {
        elements.documentTagsToggle.addEventListener('click', () => {
            setDocumentTagsCollapsed(!documentTagsCollapsed);
        });
    }

    if (elements.addTestToggle) {
        elements.addTestToggle.addEventListener('click', () => {
            setAddTestCollapsed(!addTestCollapsed);
        });
    }

    if (elements.testList) {
        elements.testList.addEventListener('click', (event) => {
            const jumpChip = event.target.closest('[data-layout-link-id]');
            if (!jumpChip) return;
            event.preventDefault();
            event.stopPropagation();
            selectLayoutByElementId(jumpChip.dataset.layoutLinkId);
        });
    }

    // Batch selection controls
    if (elements.selectUntestedBtn) {
        elements.selectUntestedBtn.addEventListener('click', selectUntestedFiles);
    }
    if (elements.clearSelectionBtn) {
        elements.clearSelectionBtn.addEventListener('click', deselectAllFiles);
    }

    // PDF controls
    if (elements.pdfControlsToggle) {
        elements.pdfControlsToggle.addEventListener('click', () => {
            setPdfControlsCollapsed(!pdfControlsCollapsed);
        });
    }
    if (elements.pdfContainer) {
        elements.pdfContainer.addEventListener('wheel', handlePdfContainerWheel, { passive: false });
    }
    elements.prevPage.addEventListener('click', () => {
        if (pdfDoc && pageNum > 1) {
            pageNum--;
            renderPage(pageNum);
        }
    });
    elements.nextPage.addEventListener('click', () => {
        if (pdfDoc && pageNum < pdfDoc.numPages) {
            pageNum++;
            renderPage(pageNum);
        }
    });
    elements.zoomIn.addEventListener('click', () => {
        if (pdfDoc) {
            scale = Math.min(scale * 1.25, MAX_VIEWER_SCALE);
            renderPage(pageNum);
        } else if (currentImage) {
            imageScale = Math.min(imageScale * 1.25, MAX_VIEWER_SCALE);
            renderImage();
        }
    });
    elements.zoomOut.addEventListener('click', () => {
        if (pdfDoc) {
            scale = Math.max(scale / 1.25, MIN_PDF_SCALE);
            renderPage(pageNum);
        } else if (currentImage) {
            imageScale = Math.max(imageScale / 1.25, MIN_IMAGE_SCALE);
            renderImage();
        }
    });
    elements.zoomFit.addEventListener('click', fitToContainer);
    elements.extractPage.addEventListener('click', () => extractCurrentPage('pdf'));

    // Test type selection
    elements.testTypeSelect.addEventListener('change', (e) => {
        showTestForm(e.target.value);
    });
    if (elements.annotationModeParseBtn) {
        elements.annotationModeParseBtn.addEventListener('click', () => {
            setAnnotationMode(ANNOTATION_MODE_PARSE);
        });
    }
    if (elements.annotationModeExtractBtn) {
        elements.annotationModeExtractBtn.addEventListener('click', () => {
            setAnnotationMode(ANNOTATION_MODE_EXTRACT);
        });
    }
    if (elements.extractAddRowBtn) {
        elements.extractAddRowBtn.addEventListener('click', () => {
            if (!elements.extractKvRows) return;
            elements.extractKvRows.insertAdjacentHTML('beforeend',
                buildExtractNodeHtml({ key: '', type: 'string', value: '', required: false }, 0, false));
        });
    }
    if (elements.extractSaveBtn) {
        elements.extractSaveBtn.addEventListener('click', async () => {
            await saveExtractEditor(true);
            const annotationCount = getAnnotationCountForPayload(currentTests);
            if (currentFile) {
                currentFile.has_tests = annotationCount > 0;
                currentFile.test_count = annotationCount;
                renderFileList();
            }
        });
    }
    // Extract field filter select
    if (elements.extractFieldFilterSelect) {
        elements.extractFieldFilterSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            extractFieldFilter = (val === 'verified' || val === 'unverified') ? val : 'all';
            renderExtractEditor();
            if (annotationMode === ANNOTATION_MODE_EXTRACT) {
                renderLayoutOverlay();
            }
        });
    }
    if (elements.extractPageFilterToggle) {
        elements.extractPageFilterToggle.addEventListener('change', (e) => {
            extractPageFilterEnabled = Boolean(e.target.checked);
            renderExtractEditor();
            if (annotationMode === ANNOTATION_MODE_EXTRACT) {
                renderLayoutOverlay();
            }
        });
    }

    if (elements.extractKvRows) {
        elements.extractKvRows.addEventListener('focusin', (event) => {
            const keyTextarea = event.target.closest?.('.extract-key');
            if (!keyTextarea) return;
            keyTextarea.closest('.extract-node-row')?.classList.add('extract-node-row--key-editing');
            syncExtractKeyTextareaHeight(keyTextarea);
        });
        elements.extractKvRows.addEventListener('input', (event) => {
            const keyTextarea = event.target.closest?.('.extract-key');
            if (!keyTextarea) return;
            syncExtractKeyTextareaHeight(keyTextarea);
        });
        elements.extractKvRows.addEventListener('keydown', (event) => {
            const keyTextarea = event.target.closest?.('.extract-key');
            if (!keyTextarea || event.key !== 'Enter') return;
            event.preventDefault();
            keyTextarea.blur();
        });
        elements.extractKvRows.addEventListener('focusout', (event) => {
            const keyTextarea = event.target.closest?.('.extract-key');
            if (!keyTextarea) return;
            keyTextarea.value = normalizeExtractKeyText(keyTextarea.value);
            keyTextarea.closest('.extract-node-row')?.classList.remove('extract-node-row--key-editing');
            syncExtractKeyTextareaHeight(keyTextarea);
        });
        elements.extractKvRows.addEventListener('click', (event) => {
            // Verified toggle button (check first so it doesn't fall through)
            const verifiedBtn = event.target.closest('.extract-toggle-verified');
            if (verifiedBtn) {
                event.stopPropagation();
                const path = verifiedBtn.dataset.path;
                if (path) toggleExtractFieldVerified(path);
                return;
            }

            // Draw-bbox button: enter region-selection mode bound to this
            // rule. Cancels any in-progress layout draw and any current
            // extract draw (toggling the same button cancels).
            const drawBtn = event.target.closest('.extract-draw-bbox');
            if (drawBtn) {
                event.stopPropagation();
                const path = drawBtn.dataset.path;
                if (path) _beginExtractBboxDraw(path);
                return;
            }

            // Toggle collapse/expand (with lazy materialization).
            // Persist the user's choice in module-level sets so a subsequent
            // re-render (triggered by e.g. selecting a nested leaf) respects it.
            const toggle = event.target.closest('.extract-node-toggle');
            if (toggle) {
                const node = toggle.closest('.extract-node');
                toggleExtractNodeExpansion(node);
                return;
            }

            // Click on an extract-node-row with data-field-path → select field
            // (click-to-deselect when clicking an already-selected row).
            const row = event.target.closest('.extract-node-row');
            if (row && row.dataset.fieldPath && annotationMode === ANNOTATION_MODE_EXTRACT) {
                const node = row.closest('.extract-node');
                const nodeType = node?.dataset?.nodeType || '';
                if (nodeType === 'object' || nodeType === 'array') {
                    const isControlClick = event.target.closest('input, textarea, select, button');
                    if (!isControlClick) {
                        toggleExtractNodeExpansion(node);
                        return;
                    }
                }
                const isInteractive = event.target.closest('input, textarea, select, button');
                if (!isInteractive) {
                    const nextPath = row.dataset.fieldPath === selectedExtractFieldPath
                        ? null
                        : row.dataset.fieldPath;
                    selectExtractFieldPath(nextPath, { navigateIfNeeded: Boolean(nextPath) });
                    return;
                }
            }

            // Delete node
            const deleteBtn = event.target.closest('.extract-delete-row');
            if (deleteBtn) {
                const node = deleteBtn.closest('.extract-node');
                const parent = node?.parentElement;
                node?.remove();
                // Re-index array items if in an array children container
                if (parent?.classList.contains('extract-node-children')) {
                    renumberArrayItems(parent);
                }
                // Ensure at least one empty row in root
                if (elements.extractKvRows.querySelectorAll(':scope > .extract-node').length === 0) {
                    elements.extractKvRows.insertAdjacentHTML('beforeend',
                        buildExtractNodeHtml({ key: '', type: 'string', value: '', required: false }, 0, false));
                    syncExtractEditorTextareaHeights(elements.extractKvRows);
                }
                return;
            }

            // Add child field to object node
            const addChildBtn = event.target.closest('.extract-add-child');
            if (addChildBtn) {
                const node = addChildBtn.closest('.extract-node');
                const childContainer = node?.querySelector(':scope > .extract-node-children');
                if (childContainer) {
                    const depth = getNodeDepth(childContainer);
                    childContainer.insertAdjacentHTML('beforeend',
                        buildExtractNodeHtml({ key: '', type: 'string', value: '', required: false }, depth, false));
                    syncExtractEditorTextareaHeights(childContainer);
                    // Ensure expanded
                    childContainer.classList.remove('collapsed');
                    const toggleEl = node.querySelector(':scope > .extract-node-row .extract-node-toggle');
                    if (toggleEl) toggleEl.textContent = '▼';
                }
                return;
            }

            // Add item to array node
            const addItemBtn = event.target.closest('.extract-add-item');
            if (addItemBtn) {
                const node = addItemBtn.closest('.extract-node');
                const childContainer = node?.querySelector(':scope > .extract-node-children');
                if (childContainer) {
                    const depth = getNodeDepth(childContainer);
                    const itemsType = node.dataset.itemsType || 'string';
                    const nextIndex = childContainer.querySelectorAll(':scope > .extract-node').length;
                    let newEntry;
                    if (itemsType === 'object') {
                        newEntry = { index: nextIndex, type: 'object', children: [] };
                    } else {
                        newEntry = { index: nextIndex, type: itemsType, value: '' };
                    }
                    childContainer.insertAdjacentHTML('beforeend',
                        buildExtractNodeHtml(newEntry, depth, true));
                    syncExtractEditorTextareaHeights(childContainer);
                    // Ensure expanded
                    childContainer.classList.remove('collapsed');
                    const toggleEl = node.querySelector(':scope > .extract-node-row .extract-node-toggle');
                    if (toggleEl) toggleEl.textContent = '▼';
                }
                return;
            }
        });
        // Hover routing: tree row ↔ overlay bbox
        elements.extractKvRows.addEventListener('mouseover', (event) => {
            if (annotationMode !== ANNOTATION_MODE_EXTRACT) return;
            const row = event.target.closest('.extract-node-row');
            if (row && row.dataset.fieldPath) {
                row.classList.add('is-hovered');
                _toggleExtractOverlayHover(row.dataset.fieldPath, true);
            }
        });
        elements.extractKvRows.addEventListener('mouseout', (event) => {
            if (annotationMode !== ANNOTATION_MODE_EXTRACT) return;
            const row = event.target.closest('.extract-node-row');
            if (row && row.dataset.fieldPath) {
                row.classList.remove('is-hovered');
                _toggleExtractOverlayHover(row.dataset.fieldPath, false);
            }
        });
        elements.extractKvRows.addEventListener('focusin', (event) => {
            const valueInput = event.target.closest('.extract-value');
            if (valueInput) resizeExtractValueTextarea(valueInput, true);
        });
        elements.extractKvRows.addEventListener('input', (event) => {
            const valueInput = event.target.closest('.extract-value');
            if (valueInput?.classList?.contains('extract-value--expanded')) {
                resizeExtractValueTextarea(valueInput, true);
            }
        });
        elements.extractKvRows.addEventListener('focusout', (event) => {
            const valueInput = event.target.closest('.extract-value');
            if (valueInput) resizeExtractValueTextarea(valueInput, true);
        });
        elements.extractKvRows.addEventListener('change', (event) => {
            // Type change handler
            const typeSelect = event.target.closest('.extract-type');
            if (typeSelect) {
                const node = typeSelect.closest('.extract-node');
                if (!node) return;
                const newType = typeSelect.value;
                const oldType = node.dataset.nodeType;
                if (newType === oldType) return;

                const row = node.querySelector(':scope > .extract-node-row');
                const key = normalizeExtractKeyText(row?.querySelector('.extract-key')?.value);
                const isRequired = Boolean(row?.querySelector('.extract-required')?.checked);
                const depth = getNodeDepth(node.parentElement);

                // Collect old value for type conversion
                let oldValue = '';
                if (oldType !== 'object' && oldType !== 'array') {
                    oldValue = row?.querySelector('.extract-value')?.value ?? '';
                }

                let newEntry;
                if (newType === 'object') {
                    newEntry = { key, type: 'object', required: isRequired, children: [] };
                } else if (newType === 'array') {
                    newEntry = { key, type: 'array', required: isRequired, itemsType: 'string', children: [] };
                } else {
                    // Converting to primitive — if old was object/array, try to serialize as JSON
                    let value = '';
                    if (oldType === 'object' || oldType === 'array') {
                        // Try to collect from DOM and serialize
                        try {
                            const childContainer = node.querySelector(':scope > .extract-node-children');
                            if (childContainer) {
                                const collected = collectExtractNodesFromContainer(
                                    childContainer, oldType === 'object');
                                if (!collected.error) {
                                    const val = oldType === 'object'
                                        ? collected.expectedOutput
                                        : collected.itemValues;
                                    value = JSON.stringify(val);
                                }
                            }
                        } catch { /* ignore */ }
                    } else {
                        value = oldValue;
                    }
                    newEntry = { key, type: newType, required: isRequired, value };
                }

                const newHtml = buildExtractNodeHtml(newEntry, depth, false);
                node.insertAdjacentHTML('afterend', newHtml);
                syncExtractEditorTextareaHeights(node.nextElementSibling);
                node.remove();
                return;
            }

            // Items type change handler
            const itemsTypeSelect = event.target.closest('.extract-items-type');
            if (itemsTypeSelect) {
                const node = itemsTypeSelect.closest('.extract-node');
                if (!node) return;
                node.dataset.itemsType = itemsTypeSelect.value;
                // Clear existing items since type changed
                const childContainer = node.querySelector(':scope > .extract-node-children');
                if (childContainer) {
                    childContainer.innerHTML = '';
                }
                return;
            }

            // null type clears value
            if (event.target.closest('.extract-type')?.value === 'null') {
                const row = event.target.closest('.extract-node-row');
                const valueInput = row?.querySelector('.extract-value');
                if (valueInput) valueInput.value = '';
            }
        });
        const extractTreeScroller = elements.extractKvRows.closest?.('.extract-editor-tree-wrap');
        if (extractTreeScroller) {
            extractTreeScroller.addEventListener('scroll', () => {
                scheduleVisibleExtractEditorTextareaSync(elements.extractKvRows);
            }, { passive: true });
        }
        if (typeof ResizeObserver === 'function') {
            const resizeTarget = extractTreeScroller || elements.extractEditorSection || elements.extractKvRows;
            extractTextareaResizeObserver = new ResizeObserver(() => {
                scheduleVisibleExtractEditorTextareaSync(elements.extractKvRows);
            });
            extractTextareaResizeObserver.observe(resizeTarget);
        }
    }

    /** Compute nesting depth from a container element by counting ancestor .extract-node-children */
    function getNodeDepth(container) {
        let depth = 0;
        let el = container;
        while (el && el !== elements.extractKvRows) {
            if (el.classList?.contains('extract-node-children')) depth++;
            el = el.parentElement;
        }
        return depth;
    }

    /** Renumber [index] labels for array items after deletion */
    function renumberArrayItems(childContainer) {
        const items = childContainer.querySelectorAll(':scope > .extract-node');
        items.forEach((item, i) => {
            const label = item.querySelector(':scope > .extract-node-row .extract-index-label');
            if (label) label.textContent = `[${i}]`;
        });
    }
    if (elements.testTypeFilterInput) {
        elements.testTypeFilterInput.addEventListener('input', (e) => {
            const previous = elements.testTypeSelect?.value || '';
            testTypeFilterQuery = e.target.value || '';
            populateTestTypeSelectOptions();
            if ((elements.testTypeSelect?.value || '') !== previous) {
                showTestForm(elements.testTypeSelect?.value || '');
            }
        });
    }
    if (elements.testTypeFilterClear) {
        elements.testTypeFilterClear.addEventListener('click', () => {
            if (!elements.testTypeFilterInput) return;
            elements.testTypeFilterInput.value = '';
            testTypeFilterQuery = '';
            populateTestTypeSelectOptions();
        });
    }
    if (elements.ruleTypeFilterSelect) {
        elements.ruleTypeFilterSelect.addEventListener('change', (e) => {
            ruleListTypeFilter = e.target.value || '';
            renderTestList();
        });
    }
    if (elements.ruleGranularityFilterSelect) {
        // Reflect the persisted default the first time the element
        // is wired up so the dropdown UI matches the filter state.
        elements.ruleGranularityFilterSelect.value = ruleListGranularityFilter;
        elements.ruleGranularityFilterSelect.addEventListener('change', (e) => {
            ruleListGranularityFilter = e.target.value || '';
            try {
                window.localStorage?.setItem(
                    'annotator.ruleListGranularityFilter',
                    ruleListGranularityFilter,
                );
            } catch (err) {
                /* localStorage unavailable — filter stays in-memory only */
            }
            // The granularity filter affects both the side-panel list
            // and the SVG overlay (so the labeller doesn't see overlays
            // for rules they've filtered out of the panel).
            renderTestList();
            renderLayoutOverlay();
        });
    }
    if (elements.ruleTagFilterInput) {
        elements.ruleTagFilterInput.addEventListener('input', (e) => {
            ruleListTagFilter = e.target.value || '';
            renderTestList();
        });
    }
    if (elements.ruleListFilterClear) {
        elements.ruleListFilterClear.addEventListener('click', () => {
            ruleListTypeFilter = '';
            ruleListTagFilter = '';
            ruleListGranularityFilter = 'region';
            try {
                window.localStorage?.setItem(
                    'annotator.ruleListGranularityFilter',
                    ruleListGranularityFilter,
                );
            } catch (err) {
                /* localStorage unavailable */
            }
            if (elements.ruleTypeFilterSelect) {
                elements.ruleTypeFilterSelect.value = '';
            }
            if (elements.ruleGranularityFilterSelect) {
                elements.ruleGranularityFilterSelect.value = ruleListGranularityFilter;
            }
            if (elements.ruleTagFilterInput) {
                elements.ruleTagFilterInput.value = '';
            }
            renderTestList();
            renderLayoutOverlay();
        });
    }

    // Clear all tests
    if (elements.clearAllTestsBtn) {
        elements.clearAllTestsBtn.addEventListener('click', clearAllTests);
    }

    // Verify all tests
    if (elements.verifyAllTestsBtn) {
        elements.verifyAllTestsBtn.addEventListener('click', verifyAllTests);
    }

    // Expected markdown auto-save
    elements.expectedMarkdown.addEventListener('blur', () => {
        if (currentFile && annotationMode === ANNOTATION_MODE_PARSE) {
            currentTests.expected_markdown = elements.expectedMarkdown.value || null;
            saveTests('expected-markdown-blur');
        }
    });

    // Export modal
    elements.exportBtn.addEventListener('click', () => {
        if (!queueDir) {
            showToast('Select a directory first', 'error');
            return;
        }
        // Update export path display
        updateExportPaths();
        elements.exportModal.classList.add('active');
    });
    elements.cancelExport.addEventListener('click', () => {
        elements.exportModal.classList.remove('active');
    });
    elements.confirmExport.addEventListener('click', exportDataset);
    elements.exportModal.addEventListener('click', (e) => {
        if (e.target === elements.exportModal) {
            elements.exportModal.classList.remove('active');
        }
    });
    // Update full path when dataset name changes
    elements.datasetName.addEventListener('input', updateExportPaths);

    // AI Selection
    if (elements.aiSelectBtn) {
        elements.aiSelectBtn.addEventListener('click', () => {
            openAiSidebar();
            toggleAiSelectMode();
        });
    }

    // AI Sidebar
    if (elements.aiSidebarToggle) {
        elements.aiSidebarToggle.addEventListener('click', openAiSidebar);
    }
    if (elements.aiSidebarClose) {
        elements.aiSidebarClose.addEventListener('click', closeAiSidebar);
    }

    // Queue Sidebar (left sidebar)
    if (elements.sidebarToggle) {
        elements.sidebarToggle.addEventListener('click', openSidebar);
    }
    if (elements.sidebarClose) {
        elements.sidebarClose.addEventListener('click', closeSidebar);
    }
    if (elements.queueToolsToggle) {
        elements.queueToolsToggle.addEventListener('click', toggleQueueTools);
    }
    if (elements.fileSearchInput) {
        elements.fileSearchInput.addEventListener('input', (event) => {
            fileSearchQuery = event.target.value || '';
            renderFileList();
        });
    }
    if (elements.fileSearchClear) {
        elements.fileSearchClear.addEventListener('click', clearFileSearch);
    }

    // Test Panel (right sidebar)
    if (elements.testPanelToggle) {
        elements.testPanelToggle.addEventListener('click', openTestPanel);
    }
    if (elements.testPanelClose) {
        elements.testPanelClose.addEventListener('click', closeTestPanel);
    }

    // Markdown Preview Panel
    if (elements.markdownPreviewBtn) {
        elements.markdownPreviewBtn.addEventListener('click', () => toggleMarkdownPanel());
    }
    if (elements.layoutOverlayBtn) {
        elements.layoutOverlayBtn.addEventListener('click', () => {
            if (currentFile) {
                toggleLayoutOverlay();
            }
        });
    }
    if (elements.labelNamesToggleBtn) {
        elements.labelNamesToggleBtn.addEventListener('click', toggleLabelNames);
    }
    applyLabelNamesVisibility();
    if (elements.markdownPanelClose) {
        elements.markdownPanelClose.addEventListener('click', () => toggleMarkdownPanel(false));
    }
    if (elements.generateExpectedMdBtn) {
        elements.generateExpectedMdBtn.addEventListener('click', generateExpectedMarkdown);
    }

    if (elements.tableEditorRaw) {
        elements.tableEditorRaw.addEventListener('input', () => updateTableEditorDirtyState());
    }
    if (elements.tableEditorRawToggle) {
        elements.tableEditorRawToggle.addEventListener('click', toggleTableEditorRawMode);
    }
    if (elements.tableEditorCancel) {
        elements.tableEditorCancel.addEventListener('click', () => closeTableEditorWorkspace());
    }
    if (elements.tableEditorClose) {
        elements.tableEditorClose.addEventListener('click', () => closeTableEditorWorkspace());
    }
    if (elements.tableEditorSave) {
        elements.tableEditorSave.addEventListener('click', saveTableEditorWorkspace);
    }
    if (elements.formulaEditorRaw) {
        elements.formulaEditorRaw.addEventListener('input', () => updateFormulaEditorStatus());
    }
    if (elements.formulaEditorRawToggle) {
        elements.formulaEditorRawToggle.addEventListener('click', toggleFormulaEditorRawMode);
    }
    if (elements.formulaEditorCancel) {
        elements.formulaEditorCancel.addEventListener('click', () => closeFormulaEditorWorkspace());
    }
    if (elements.formulaEditorClose) {
        elements.formulaEditorClose.addEventListener('click', () => closeFormulaEditorWorkspace());
    }
    if (elements.formulaEditorSave) {
        elements.formulaEditorSave.addEventListener('click', saveFormulaEditorWorkspace);
    }

    // Initialize markdown drag handlers
    initMarkdownDragHandlers();

    // AI Panel - Region Selection
    if (elements.aiFullPageBtn) {
        elements.aiFullPageBtn.addEventListener('click', () => {
            clearSelectionBox();
            setRegionButtonState('fullpage');
        });
    }
    if (elements.aiDrawRegionBtn) {
        elements.aiDrawRegionBtn.addEventListener('click', () => {
            setRegionButtonState('drawing');
            toggleAiSelectMode(true);
        });
    }

    // AI Panel - Test count slider
    if (elements.aiTestCountSlider) {
        elements.aiTestCountSlider.addEventListener('input', (e) => {
            if (elements.aiTestCountValue) {
                elements.aiTestCountValue.textContent = e.target.value;
            }
        });
    }

    // AI Panel - Test Types Section (inline toggle)
    const testTypesToggle = document.getElementById('test-types-toggle');
    if (testTypesToggle) {
        testTypesToggle.addEventListener('click', toggleTestTypesSection);
    }
    if (elements.testTypesCheckboxes) {
        elements.testTypesCheckboxes.addEventListener('change', (e) => {
            const checkbox = e.target.closest('input[data-ai-test-type]');
            if (!checkbox) return;
            onTestTypeChange(checkbox.dataset.aiTestType, checkbox.checked);
        });
    }

    // AI Panel - Parse.md checkbox
    if (elements.useParseMdCheckbox) {
        elements.useParseMdCheckbox.addEventListener('change', (e) => {
            useParseMd = e.target.checked;
        });
    }

    // AI Panel - Action Buttons
    if (elements.aiExtractTextBtn) {
        elements.aiExtractTextBtn.addEventListener('click', () => generateWithAi('parse'));
    }
    if (elements.aiGenerateTestsBtn) {
        elements.aiGenerateTestsBtn.addEventListener('click', () => generateWithAi('generate_tests'));
    }
    if (elements.aiReviewTestsBtn) {
        elements.aiReviewTestsBtn.addEventListener('click', reviewTestsWithAi);
    }
    if (elements.aiCopyBtn) {
        elements.aiCopyBtn.addEventListener('click', copyAiResult);
    }
    if (elements.aiClearSelectionBtn) {
        elements.aiClearSelectionBtn.addEventListener('click', clearSelectionBox);
    }

    // AI Settings Modal
    if (elements.aiSettingsBtn) {
        elements.aiSettingsBtn.addEventListener('click', openAiSettingsModal);
    }
    if (elements.aiCancelSettingsBtn) {
        elements.aiCancelSettingsBtn.addEventListener('click', closeAiSettingsModal);
    }
    if (elements.aiSaveSettingsBtn) {
        elements.aiSaveSettingsBtn.addEventListener('click', saveAiSettings);
    }
    if (elements.aiTestConnectionBtn) {
        elements.aiTestConnectionBtn.addEventListener('click', testVlmConnection);
    }
    if (elements.aiSettingsModal) {
        elements.aiSettingsModal.addEventListener('click', (e) => {
            if (e.target === elements.aiSettingsModal) {
                closeAiSettingsModal();
            }
        });
    }
}

// === Initialize ===
async function init() {
    initEventListeners();
    initResizer();
    initKeyboardShortcuts();
    initDragAndDrop();
    initSelectionCanvas();
    updateLayoutOverlayButton();
    setDocumentTagsCollapsed(documentTagsCollapsed, false);
    setPdfControlsCollapsed(pdfControlsCollapsed, false);
    setAddTestCollapsed(addTestCollapsed, false);

    // Load config, capabilities, and schema-driven rule definitions
    await Promise.all([fetchConfig(), fetchCapabilities(), fetchVlmConfig(), loadRuleDefinitions()]);
    if (!queueDir) {
        queueToolsCollapsed = false;
    }
    updateQueueToolsUi();

    // Initialize AI sidebar state after config loads so the persisted focus layout is restored.
    toggleAiSidebar(aiSidebarOpen);

    // Initialize AI panel state
    updateAiSelectionStatus();

    // Load test types from localStorage
    loadTestTypesFromStorage();
    annotationMode = ANNOTATION_MODE_PARSE;
    applyAnnotationModeUi();

    // If queue dir is set, load files
    if (queueDir) {
        await fetchQueue();

        await selectInitialQueueFile();
    } else {
        // Show empty state and prompt to select directory
        elements.fileList.innerHTML = '<p class="empty-state">Select a directory to start annotating.</p>';
    }
}

// Expose functions for onclick handlers in HTML
window.toggleTestTypesSection = toggleTestTypesSection;
window.toggleGroup = toggleGroup;
window.selectFile = selectFile;
window.clearTestForm = clearTestForm;
window.closeAiSettingsModal = closeAiSettingsModal;

// Start the app
init();
