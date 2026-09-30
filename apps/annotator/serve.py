#!/usr/bin/env python3
"""Flask server for the parse annotation app.

Usage:
    python apps/annotator/serve.py --port 5001
    python apps/annotator/serve.py --queue-dir /path/to/queue --output-dir /path/to/output --port 5001
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import tempfile
from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file

# Load environment variables from .env files
# First load from project root (lower priority)
load_dotenv()
# Then load from annotator directory (higher priority)
annotator_env = Path(__file__).parent / ".env"
if annotator_env.exists():
    load_dotenv(annotator_env, override=True)


def get_vlm_api_key() -> str | None:
    """Return the configured VLM API key, preferring ParseBench's env var."""
    return (
        vlm_config.get("api_key")
        or os.environ.get("GOOGLE_GEMINI_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
    )


def get_vlm_api_key_source() -> str | None:
    """Return where the active VLM API key came from."""
    if vlm_config.get("api_key"):
        return "config"
    if os.environ.get("GOOGLE_GEMINI_API_KEY"):
        return "GOOGLE_GEMINI_API_KEY"
    if os.environ.get("GOOGLE_API_KEY"):
        return "GOOGLE_API_KEY"
    return None

# === VLM Provider Abstraction ===


class VLMProvider(ABC):
    """Abstract base class for VLM providers."""

    @abstractmethod
    def generate(self, image_base64: str, prompt: str) -> str:
        """Generate text from an image using the VLM.

        Args:
            image_base64: Base64-encoded image data (without data URI prefix)
            prompt: The prompt to send to the VLM

        Returns:
            Generated text response
        """
        pass

    @abstractmethod
    def test_connection(self) -> bool:
        """Test if the provider is properly configured."""
        pass


class GeminiProvider(VLMProvider):
    """Google Gemini VLM provider."""

    def __init__(self, api_key: str, model: str = "gemini-3-flash-preview"):
        self.api_key = api_key
        self.model = model
        self._client = None

    def _get_client(self):
        """Lazy-load the Gemini client."""
        if self._client is None:
            try:
                from google import genai
                self._client = genai.Client(api_key=self.api_key)
            except ImportError:
                raise RuntimeError("google-genai package not installed")
        return self._client

    def generate(self, image_base64: str, prompt: str) -> str:
        """Generate text from an image using Gemini."""
        from google.genai import types

        client = self._get_client()

        # Decode base64 to bytes
        image_bytes = base64.b64decode(image_base64)

        # Create image part for Gemini
        image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/png")

        # Generate response
        response = client.models.generate_content(
            model=self.model,
            contents=[image_part, prompt]
        )
        return response.text

    def test_connection(self) -> bool:
        """Test if Gemini is properly configured."""
        try:
            self._get_client()
            return True
        except Exception:
            return False


# VLM Prompts - Base prompts
VLM_PROMPTS = {
    "parse": """Extract all text content from this document image. Output clean markdown with proper formatting:
- Use appropriate heading levels (# ## ###)
- Format lists properly (- or 1. 2. 3.)
- Format tables using markdown table syntax
- Preserve text hierarchy and structure
- Do not include any explanations, just the extracted content.""",

    "review_tests": """Review the following test rules against this document image.
For each test, determine if it's valid (correctly specified) or has issues.

Tests to review:
{tests_json}

For each test, check:
- "present" tests: Does the text actually appear in the document?
- "absent" tests: Is this text truly absent from the document?
- "order" tests: Do both texts exist, and does the ordering make sense?
- "table" tests: Do the cell value and headings actually match what's in the document?
- "chart_data_point" tests: Does the value exist with all associated labels in the same row or column?

Return a JSON object with this structure:
{{
    "review_results": [
        {{
            "index": 0,
            "type": "present|absent|order|table|chart_data_point",
            "status": "valid|warning|error",
            "message": "Brief explanation of any issues or confirmation"
        }}
    ],
    "summary": "Overall assessment of the test suite"
}}

Be strict: flag tests where:
- The text doesn't match exactly what's in the document
- Typos or incorrect capitalization
- Table headings that don't exist
- Ordering that doesn't make logical sense

Return ONLY the JSON, no markdown formatting.""",
}

RULE_ID_HASH_LEN = 16
# Modular test type prompts for generate_tests mode
TEST_TYPE_PROMPTS = {
    "present": '''- "present" - verify text exists:
    {{"type": "present", "text": "exact text to find", "max_diffs": 0, "case_sensitive": true}}
    Optional: add "count": N to require exactly N occurrences of the text.''',

    "absent": '''- "absent" - verify text does NOT exist:
   {{"type": "absent", "text": "text that should not appear", "max_diffs": 0, "case_sensitive": true}}''',

    "order": '''- "order" - verify text A appears before text B:
   {{"type": "order", "before": "first text", "after": "second text", "max_diffs": 0}}''',

    "unexpected_sentence": '''- "unexpected_sentence" - fail if output contains sentence fragments not in the bag:
   {{"type": "unexpected_sentence", "bag_of_sentence": {{"sentence 1": 2, "another sentence": 4, "str4": 1}}}}''',

    "too_many_sentence_occurence": '''- "too_many_sentence_occurence" - fail if any bag sentence appears more than allowed:
   {{"type": "too_many_sentence_occurence", "bag_of_sentence": {{"sentence 1": 2, "another sentence": 4, "str4": 1}}}}''',

    "missing_sentence": '''- "missing_sentence" - fail if any bag sentence appears fewer times than required:
   {{"type": "missing_sentence", "bag_of_sentence": {{"sentence 1": 2, "another sentence": 4, "str4": 1}}}}''',

    "unexpected_word": '''- "unexpected_word" - fail if output contains words not in the bag:
   {{"type": "unexpected_word", "bag_of_word": {{"word1": 2, "word2": 4, "word3": 1}}}}''',

    "too_many_word_occurence": '''- "too_many_word_occurence" - fail if any bag word appears more than allowed:
   {{"type": "too_many_word_occurence", "bag_of_word": {{"word1": 2, "word2": 4, "word3": 1}}}}''',

    "missing_word": '''- "missing_word" - fail if any bag word appears fewer times than required:
   {{"type": "missing_word", "bag_of_word": {{"word1": 2, "word2": 4, "word3": 1}}}}''',

    "table": '''- "table" - verify table cell relationships:
   {{"type": "table", "cell": "cell value", "top_heading": "column header", "left_heading": "row header", "max_diffs": 0}}''',

    "chart_data_point": '''- "chart_data_point" - verify data point with associated labels (orientation-invariant):
   {{"type": "chart_data_point", "value": "102", "labels": ["label1", "label2"], "normalize_numbers": true, "relative_tolerance": 0.01}}
   If the value is clearly shown on the chart, omit relative_tolerance (defaults to 1%).
   If the value must be estimated from the chart (not directly labeled), add "relative_tolerance": 0.05 (5%). For harder estimations, use larger values like 0.1 or 0.2... Values should be a straight number, not a range or using any ~.
   Labels rules: Each label must exactly match a legend entry, axis label, or category name from the chart. Do NOT include chart titles as labels. Do NOT add chart titles, type suffixes ("Line", "bars"), unit suffixes ("USD bn"), color descriptions ("Dark Blue"), annotations, or any other descriptive text by yourself.''',
}

# Focus suggestions based on selected test types
TEST_TYPE_FOCUS = {
    "present": "Key headings, section titles, important text content",
    "absent": "Text that should NOT appear (e.g., placeholder text, wrong values)",
    "order": "Sequential content that must appear in correct order",
    "unexpected_sentence": "Sentence whitelist for unexpected-content detection",
    "too_many_sentence_occurence": "Max allowed counts for configured sentences",
    "missing_sentence": "Required minimum counts for configured sentences",
    "unexpected_word": "Word whitelist for unexpected-word detection",
    "too_many_word_occurence": "Max allowed counts for configured words",
    "missing_word": "Required minimum counts for configured words",
    "table": "Table cell values with their column/row headers",
    "chart_data_point": "Chart/graph data points with their axis labels",
}


def build_generate_tests_prompt(test_types: list[str], test_count: int, parse_content: str | None = None) -> str:
    """Build a dynamic prompt for test generation based on selected test types."""

    # Filter to valid test types
    valid_types = [t for t in test_types if t in TEST_TYPE_PROMPTS]
    if not valid_types:
        valid_types = [
            "present",
            "absent",
            "order",
            "unexpected_sentence",
            "too_many_sentence_occurence",
            "missing_sentence",
            "unexpected_word",
            "too_many_word_occurence",
            "missing_word",
            "table",
        ]  # Default

    # Build test type descriptions
    type_descriptions = "\n\n".join([TEST_TYPE_PROMPTS[t] for t in valid_types])

    # Build focus section
    focus_items = [TEST_TYPE_FOCUS[t] for t in valid_types if t in TEST_TYPE_FOCUS]
    focus_section = "\n".join([f"- {item}" for item in focus_items])

    # Build the prompt
    prompt = f"""Analyze this document image and generate test rules to verify parsing output.

Return ONLY a valid JSON array of test rule objects. Each test rule should be one of these types:

{type_descriptions}

Generate up to {test_count} meaningful test rules that would verify important content is correctly parsed. If the document doesn't contain enough distinct testable elements, generate fewer high-quality rules rather than creating redundant or low-value tests.
Focus on:
{focus_section}

Return ONLY the JSON array, no markdown formatting or explanations."""

    # Add parse content context if provided
    if parse_content:
        prompt += f"""

IMPORTANT: Here is the existing parse result for this document. Use this to generate accurate tests that match the actual parsed content:

```markdown
{parse_content}
```

Generate tests based on the actual content shown above. Ensure text values match exactly what appears in the parse result."""

    return prompt

app = Flask(__name__, static_folder=".", static_url_path="/static")

# Global state
queue_dir: Path | None = None
output_dir: Path | None = None
state_file: Path | None = None
annotation_state: dict[str, Any] = {}
base_browse_dir: Path = Path.home()  # Starting directory for browsing

# VLM configuration state
vlm_config: dict[str, Any] = {
    "provider": "gemini",
    "api_key": None,  # Will use env var if not set
    "model": "gemini-3-flash-preview",
}
vlm_provider: VLMProvider | None = None

# Supported file extensions
SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".jfif"}


def _state_file_for_queue(current_queue_dir: Path | None) -> Path | None:
    if not current_queue_dir:
        return None
    return current_queue_dir / ".annotation_state.json"


def load_state_from_path(target_state_file: Path | None) -> dict[str, Any]:
    """Load annotation state from an explicit state file path."""
    if target_state_file and target_state_file.exists():
        try:
            with open(target_state_file, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"files": {}, "current_index": 0}


def save_state_to_path(target_state_file: Path | None, state: dict[str, Any]) -> None:
    """Persist annotation state to an explicit state file path."""
    if not target_state_file:
        return
    with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
        json.dump(state, f, indent=2)
        temp_path = f.name
    shutil.move(temp_path, target_state_file)
    target_state_file.chmod(0o644)


def load_state() -> dict[str, Any]:
    """Load annotation state from file."""
    global state_file, annotation_state
    annotation_state = load_state_from_path(state_file)
    return annotation_state


def save_state() -> None:
    """Save annotation state to file."""
    global state_file, annotation_state
    save_state_to_path(state_file, annotation_state)


def get_requested_queue_id() -> str | None:
    """Return the queue scope identifier from the request.

    Supports two query parameters (checked in order):
      ?dir=/absolute/path  — absolute path, no browse-root restriction
      ?queue=relative/path — relative to base_browse_dir (legacy)
    """
    abs_dir = request.args.get("dir", "").strip()
    if abs_dir:
        return abs_dir
    queue_id = request.args.get("queue", "").strip()
    return queue_id or None


def get_requested_generated_queue_id() -> str | None:
    """Return the generated queue identifier, excluding direct directory links."""
    queue_id = request.args.get("queue", "").strip()
    return queue_id or None


def resolve_queue_dir(queue_id: str | None = None) -> Path | None:
    """Resolve a request-scoped queue directory.

    When queue_id starts with '/', it is treated as an absolute path.
    When queue_id is a relative path, it must be under base_browse_dir.
    When queue_id is omitted, legacy global queue_dir behavior is preserved.
    """
    global queue_dir, base_browse_dir

    if not queue_id:
        return queue_dir

    if queue_id.startswith("/"):
        candidate = Path(queue_id).resolve()
    else:
        root = base_browse_dir.resolve()
        candidate = (root / queue_id).resolve()
        candidate.relative_to(root)

    if not candidate.exists():
        raise FileNotFoundError(f"Queue not found: {queue_id}")
    if not candidate.is_dir():
        raise NotADirectoryError(f"Queue is not a directory: {queue_id}")
    return candidate


def resolve_request_queue_dir() -> Path | None:
    return resolve_queue_dir(get_requested_queue_id())


def scan_queue(current_queue_dir: Path | None = None) -> list[dict[str, Any]]:
    """Scan queue directory for files to annotate."""
    resolved_queue = current_queue_dir or queue_dir
    if not resolved_queue or not resolved_queue.exists():
        return []

    current_state = load_state_from_path(_state_file_for_queue(resolved_queue))
    state_changed = False
    files = []
    for file_path in sorted(resolved_queue.rglob("*")):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        # Skip test.json files
        if file_path.name.endswith(".test.json"):
            continue

        rel_path = str(file_path.relative_to(resolved_queue))
        file_info = current_state.get("files", {}).get(rel_path, {})

        # Check if test.json exists
        test_json_path = file_path.parent / f"{file_path.stem}.test.json"
        has_tests = test_json_path.exists()

        # Check if parse.md exists (supports multiple patterns: .parse.md, _llama_agentic.md)
        parse_md_patterns = [
            file_path.parent / f"{file_path.stem}.parse.md",
            file_path.parent / f"{file_path.stem}_llama_agentic.md",
        ]
        has_parse_md = any(p.exists() for p in parse_md_patterns)

        # Load existing tests if any
        annotation_count = 0
        test_data = None
        if has_tests:
            try:
                with open(test_json_path, encoding="utf-8") as f:
                    test_data = json.load(f)
                annotation_count = annotation_count_from_payload(test_data)
            except (json.JSONDecodeError, OSError):
                pass

        stored_status = file_info.get("status", "pending")
        status = derive_file_status(stored_status, test_data)
        if status != stored_status:
            current_state.setdefault("files", {})[rel_path] = {
                **file_info,
                "status": status,
                "updated_at": datetime.now().isoformat(),
                "auto_verified": True,
            }
            state_changed = True

        files.append({
            "path": rel_path,
            "name": file_path.name,
            "status": status,
            "has_tests": has_tests,
            "test_count": annotation_count,
            "has_parse_md": has_parse_md,
            "group": file_path.parent.name if file_path.parent != resolved_queue else "root",
        })

    if state_changed:
        try:
            save_state_to_path(_state_file_for_queue(resolved_queue), current_state)
        except OSError:
            pass

    return files


def get_file_tests(rel_path: str, current_queue_dir: Path | None = None) -> dict[str, Any]:
    """Get tests for a specific file."""
    resolved_queue = current_queue_dir or queue_dir
    if not resolved_queue:
        return {"test_rules": [], "expected_markdown": None}

    file_path = resolved_queue / rel_path
    test_json_path = file_path.parent / f"{file_path.stem}.test.json"

    if test_json_path.exists():
        try:
            with open(test_json_path, encoding="utf-8") as f:
                return assign_missing_rule_ids(json.load(f))
        except (json.JSONDecodeError, OSError):
            pass

    return {"test_rules": [], "expected_markdown": None}


def canonical_rule_signature(rule: dict[str, Any]) -> str:
    """Match the shared rule-id canonicalization used by assign_rule_ids.py."""
    payload = dict(rule)
    payload.pop("id", None)
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def compute_rule_id(rule: dict[str, Any]) -> str:
    signature = canonical_rule_signature(rule)
    page = rule.get("page")
    page_prefix = str(page) if page is not None else ""
    payload = f"{page_prefix}\u0000{signature}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:RULE_ID_HASH_LEN]


def assign_missing_rule_ids(test_data: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(test_data, dict):
        return {"test_rules": [], "expected_markdown": None}

    normalized = dict(test_data)
    test_rules = normalized.get("test_rules")
    if not isinstance(test_rules, list):
        normalized["test_rules"] = []
        return normalized

    normalized_rules: list[Any] = []
    for rule in test_rules:
        if isinstance(rule, dict):
            normalized_rule = dict(rule)
            if not normalized_rule.get("id"):
                normalized_rule["id"] = compute_rule_id(normalized_rule)
            normalized_rules.append(normalized_rule)
        else:
            normalized_rules.append(rule)

    normalized["test_rules"] = normalized_rules
    return normalized


def annotation_count_from_payload(test_data: dict[str, Any] | None) -> int:
    """Return display count for parse rules or extract fields."""
    if not isinstance(test_data, dict):
        return 0

    test_rules = test_data.get("test_rules")
    test_rules_count = len(test_rules) if isinstance(test_rules, list) else 0

    annotation_mode = test_data.get("annotation_mode")
    expected_output = test_data.get("expected_output")
    is_extract = (
        annotation_mode == "extract"
        or isinstance(expected_output, (dict, list))
        or isinstance(test_data.get("data_schema"), dict)
    )
    if is_extract:
        if isinstance(test_rules, list):
            extract_rule_count = sum(
                1
                for rule in test_rules
                if isinstance(rule, dict) and rule.get("type") == "extract_field"
            )
            if extract_rule_count > 0:
                return extract_rule_count
        if "expected_output" not in test_data:
            return 0
        return count_expected_output_leaves(expected_output, is_root=True)

    return test_rules_count


def count_expected_output_leaves(value: Any, is_root: bool = False) -> int:
    """Count scalar extract fields inside nested expected_output structures."""
    if is_root and value is None:
        return 0
    if isinstance(value, list):
        return sum(count_expected_output_leaves(item) for item in value)
    if isinstance(value, dict):
        return sum(count_expected_output_leaves(item) for item in value.values())
    return 1


def tests_payload_is_fully_verified(test_data: dict[str, Any] | None) -> bool:
    """Return true when a test payload has rules and none need review."""
    if not isinstance(test_data, dict):
        return False

    test_rules = test_data.get("test_rules")
    if not isinstance(test_rules, list) or len(test_rules) == 0:
        return False

    return all(not isinstance(rule, dict) or rule.get("verified") is not False for rule in test_rules)


def derive_file_status(
    stored_status: str | None,
    test_data: dict[str, Any] | None,
) -> str:
    """Derive queue status from test verification, preserving explicit skipped files."""
    if stored_status == "skipped":
        return "skipped"
    return "completed" if tests_payload_is_fully_verified(test_data) else "pending"


def save_file_tests(
    rel_path: str,
    test_data: dict[str, Any],
    current_queue_dir: Path | None = None,
) -> dict[str, Any] | None:
    """Save tests for a specific file."""
    resolved_queue = current_queue_dir or queue_dir
    if not resolved_queue:
        return None

    file_path = resolved_queue / rel_path
    test_json_path = file_path.parent / f"{file_path.stem}.test.json"
    normalized_test_data = assign_missing_rule_ids(test_data)

    try:
        # Atomic write. Match the converter's on-disk format byte-for-byte:
        # indent=2, ensure_ascii=False, trailing newline. The trailing newline
        # is required for the extract_field round-trip audit.
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            f.write(json.dumps(normalized_test_data, indent=2, ensure_ascii=False))
            f.write("\n")
            temp_path = f.name
        shutil.move(temp_path, test_json_path)
        # Set readable permissions (644)
        test_json_path.chmod(0o644)
        return normalized_test_data
    except OSError:
        return None


@app.route("/")
def index():
    """Serve the main page."""
    return send_file("index.html")


@app.route("/api/queue")
def get_queue():
    """Get list of files in the queue."""
    try:
        files = scan_queue(resolve_request_queue_dir())
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404
    return jsonify({
        "files": files,
        "total": len(files),
        "pending": sum(1 for f in files if f["status"] == "pending"),
        "completed": sum(1 for f in files if f["status"] == "completed"),
        "skipped": sum(1 for f in files if f["status"] == "skipped"),
    })


@app.route("/api/file/<path:rel_path>")
def serve_file(rel_path: str):
    """Serve a file from the queue directory."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "Queue directory not configured"}), 500

    file_path = current_queue_dir / rel_path
    if not file_path.exists():
        return jsonify({"error": "File not found"}), 404

    # Determine mimetype
    suffix = file_path.suffix.lower()
    mimetypes = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".jfif": "image/jpeg",
    }
    mimetype = mimetypes.get(suffix, "application/octet-stream")

    return send_file(file_path, mimetype=mimetype)


@app.route("/api/tests/<path:rel_path>", methods=["GET"])
def get_tests(rel_path: str):
    """Get tests for a file."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    test_data = get_file_tests(rel_path, current_queue_dir)
    return jsonify(test_data)


@app.route("/api/tests/<path:rel_path>", methods=["POST"])
def update_tests(rel_path: str):
    """Update tests for a file."""
    test_data = request.json
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    saved_test_data = save_file_tests(rel_path, test_data, current_queue_dir)
    if saved_test_data is not None:
        state_path = _state_file_for_queue(current_queue_dir)
        current_state = load_state_from_path(state_path)
        file_info = current_state.get("files", {}).get(rel_path, {})
        file_status = derive_file_status(file_info.get("status", "pending"), saved_test_data)
        if file_status != file_info.get("status"):
            current_state.setdefault("files", {})[rel_path] = {
                **file_info,
                "status": file_status,
                "updated_at": datetime.now().isoformat(),
                "auto_verified": True,
            }
            save_state_to_path(state_path, current_state)
        return jsonify({"status": "success", "test_data": saved_test_data, "file_status": file_status})
    return jsonify({"error": "Failed to save tests"}), 500


@app.route("/api/status/<path:rel_path>", methods=["POST"])
def update_status(rel_path: str):
    """Update status for a file."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "Queue directory not configured"}), 500

    data = request.json
    requested_status = data.get("status", "pending")
    test_data = get_file_tests(rel_path, current_queue_dir)
    status = derive_file_status(requested_status, test_data)
    current_state = load_state_from_path(_state_file_for_queue(current_queue_dir))

    if "files" not in current_state:
        current_state["files"] = {}

    current_state["files"][rel_path] = {
        "status": status,
        "updated_at": datetime.now().isoformat(),
    }
    save_state_to_path(_state_file_for_queue(current_queue_dir), current_state)

    return jsonify({"status": "success", "file_status": status})


@app.route("/api/export", methods=["POST"])
def export_dataset():
    """Export annotated files to output directory."""
    global output_dir

    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "Directories not configured"}), 500

    current_output_dir = output_dir or current_queue_dir.parent / "datasets"
    current_output_dir.mkdir(parents=True, exist_ok=True)

    if not current_output_dir:
        return jsonify({"error": "Directories not configured"}), 500

    data = request.json
    dataset_name = data.get("name", "annotated_dataset")
    include_skipped = data.get("include_skipped", False)

    # Create output directory
    dataset_dir = current_output_dir / dataset_name
    dataset_dir.mkdir(parents=True, exist_ok=True)

    exported_count = 0
    errors = []

    files = scan_queue(current_queue_dir)
    for file_info in files:
        rel_path = file_info["path"]
        status = file_info["status"]

        # Skip files based on status
        if status == "pending":
            continue
        if status == "skipped" and not include_skipped:
            continue

        # Skip files without tests
        if not file_info["has_tests"]:
            continue

        try:
            src_file = current_queue_dir / rel_path
            src_test = src_file.parent / f"{src_file.stem}.test.json"

            # Determine group (use parent directory name or 'default')
            group = file_info["group"] if file_info["group"] != "root" else "default"
            group_dir = dataset_dir / group
            group_dir.mkdir(parents=True, exist_ok=True)

            # Copy file and test.json
            dst_file = group_dir / src_file.name
            dst_test = group_dir / f"{src_file.stem}.test.json"

            shutil.copy2(src_file, dst_file)
            if src_test.exists():
                shutil.copy2(src_test, dst_test)

            exported_count += 1
        except Exception as e:
            errors.append(f"{rel_path}: {str(e)}")

    return jsonify({
        "status": "success",
        "exported": exported_count,
        "errors": errors,
        "output_dir": str(dataset_dir),
    })


@app.route("/api/extract-page", methods=["POST"])
def extract_page():
    """Extract a single page from a PDF as a new file."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "No queue directory selected"}), 400

    data = request.json
    source_path = data.get("source")  # relative path in queue
    page_num = data.get("page", 1)    # 1-indexed
    output_format = data.get("format", "pdf")  # "pdf" or "png"

    if not source_path:
        return jsonify({"error": "No source file specified"}), 400

    source_file = current_queue_dir / source_path
    if not source_file.exists():
        return jsonify({"error": "Source file not found"}), 404

    if source_file.suffix.lower() != ".pdf":
        return jsonify({"error": "Source must be a PDF file"}), 400

    # Generate output filename
    base_name = source_file.stem
    output_name = f"{base_name}_p{page_num}.{output_format}"
    output_path = source_file.parent / output_name

    # Avoid overwrites
    counter = 1
    while output_path.exists():
        output_name = f"{base_name}_p{page_num}_{counter}.{output_format}"
        output_path = source_file.parent / output_name
        counter += 1

    try:
        from pypdf import PdfReader, PdfWriter

        # pypdf only supports PDF output, not PNG
        if output_format == "png":
            return jsonify({"error": "PNG extraction not supported. Use PDF format."}), 400

        reader = PdfReader(source_file)

        if page_num < 1 or page_num > len(reader.pages):
            return jsonify({"error": f"Page {page_num} out of range (1-{len(reader.pages)})"}), 400

        # Extract single page as PDF
        writer = PdfWriter()
        writer.add_page(reader.pages[page_num - 1])

        with open(output_path, "wb") as f:
            writer.write(f)

        return jsonify({
            "status": "success",
            "path": str(output_path.relative_to(current_queue_dir)),
            "filename": output_name,
        })
    except ImportError:
        return jsonify({"error": "pypdf not installed. Page extraction is disabled."}), 501
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/capabilities")
def get_capabilities():
    """Check what features are available."""
    try:
        from pypdf import PdfReader  # noqa: F401
        has_pypdf = True
    except ImportError:
        has_pypdf = False

    try:
        from google import genai  # noqa: F401
        has_genai = True
    except ImportError:
        has_genai = False

    # Check if VLM is configured
    has_vlm_key = bool(get_vlm_api_key())

    return jsonify({
        "extract_page": has_pypdf,
        "pypdf_installed": has_pypdf,
        "vlm_available": has_genai and has_vlm_key,
        "vlm_sdk_installed": has_genai,
        "vlm_configured": has_vlm_key,
    })


@app.route("/api/upload", methods=["POST"])
def upload_files():
    """Upload files to the queue directory."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "No queue directory selected"}), 400

    if "files" not in request.files:
        return jsonify({"error": "No files provided"}), 400

    files = request.files.getlist("files")
    subfolder = request.form.get("subfolder", "").strip()

    # Determine target directory
    if subfolder:
        target_dir = current_queue_dir / subfolder
    else:
        target_dir = current_queue_dir

    target_dir.mkdir(parents=True, exist_ok=True)

    uploaded = []
    errors = []

    for file in files:
        if not file.filename:
            continue

        # Check extension
        ext = Path(file.filename).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            errors.append(f"{file.filename}: unsupported file type")
            continue

        # Save file
        try:
            # Sanitize filename
            safe_name = Path(file.filename).name
            dest_path = target_dir / safe_name

            # Don't overwrite existing files
            if dest_path.exists():
                base = dest_path.stem
                counter = 1
                while dest_path.exists():
                    dest_path = target_dir / f"{base}_{counter}{ext}"
                    counter += 1

            file.save(dest_path)
            uploaded.append(str(dest_path.relative_to(current_queue_dir)))
        except Exception as e:
            errors.append(f"{file.filename}: {str(e)}")

    return jsonify({
        "status": "success",
        "uploaded": uploaded,
        "errors": errors,
        "count": len(uploaded),
    })


@app.route("/api/delete/<path:rel_path>", methods=["DELETE"])
def delete_file(rel_path: str):
    """Delete a file from the queue."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "No queue directory selected"}), 400

    file_path = current_queue_dir / rel_path
    if not file_path.exists():
        return jsonify({"error": "File not found"}), 404

    # Security check: ensure path is within queue_dir
    try:
        file_path.resolve().relative_to(current_queue_dir.resolve())
    except ValueError:
        return jsonify({"error": "Invalid path"}), 403

    current_state = load_state_from_path(_state_file_for_queue(current_queue_dir))
    try:
        # Delete the file
        file_path.unlink()

        # Also delete the associated test.json if it exists
        test_json_path = file_path.parent / f"{file_path.stem}.test.json"
        if test_json_path.exists():
            test_json_path.unlink()

        # Remove from annotation state
        if rel_path in current_state.get("files", {}):
            del current_state["files"][rel_path]
            save_state_to_path(_state_file_for_queue(current_queue_dir), current_state)

        return jsonify({"status": "success", "deleted": rel_path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/rename/<path:rel_path>", methods=["POST"])
def rename_file(rel_path: str):
    """Rename a file in the queue."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "No queue directory selected"}), 400

    data = request.json
    new_name = data.get("new_name", "").strip()

    if not new_name:
        return jsonify({"error": "New name is required"}), 400

    file_path = current_queue_dir / rel_path
    if not file_path.exists():
        return jsonify({"error": "File not found"}), 404

    # Security check: ensure path is within queue_dir
    try:
        file_path.resolve().relative_to(current_queue_dir.resolve())
    except ValueError:
        return jsonify({"error": "Invalid path"}), 403

    # Ensure new name has same extension
    old_ext = file_path.suffix.lower()
    new_ext = Path(new_name).suffix.lower()
    if new_ext != old_ext:
        new_name = new_name + old_ext

    new_path = file_path.parent / new_name

    # Check if target already exists
    if new_path.exists():
        return jsonify({"error": "A file with that name already exists"}), 409

    current_state = load_state_from_path(_state_file_for_queue(current_queue_dir))
    try:
        # Rename the file
        file_path.rename(new_path)

        # Also rename the associated test.json if it exists
        test_json_path = file_path.parent / f"{file_path.stem}.test.json"
        if test_json_path.exists():
            new_test_path = file_path.parent / f"{new_path.stem}.test.json"
            test_json_path.rename(new_test_path)

        # Update annotation state
        new_rel_path = str(new_path.relative_to(current_queue_dir))
        if rel_path in current_state.get("files", {}):
            current_state["files"][new_rel_path] = current_state["files"].pop(rel_path)
            save_state_to_path(_state_file_for_queue(current_queue_dir), current_state)

        return jsonify({
            "status": "success",
            "old_path": rel_path,
            "new_path": new_rel_path,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/config")
def get_config():
    """Get current configuration."""
    global output_dir
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    return jsonify({
        "queue_id": get_requested_generated_queue_id(),
        "queue_dir": str(current_queue_dir) if current_queue_dir else None,
        "output_dir": str(output_dir) if output_dir else None,
    })


@app.route("/api/config", methods=["POST"])
def set_config():
    """Set queue directory configuration."""
    global queue_dir, output_dir, state_file, annotation_state

    if get_requested_generated_queue_id():
        return jsonify({"error": "Queue-scoped mode does not allow changing the global directory"}), 400

    data = request.json
    new_queue_dir = data.get("queue_dir")
    new_output_dir = data.get("output_dir")

    if new_queue_dir:
        new_path = Path(new_queue_dir).resolve()
        if not new_path.exists():
            return jsonify({"error": f"Directory does not exist: {new_queue_dir}"}), 400
        if not new_path.is_dir():
            return jsonify({"error": f"Path is not a directory: {new_queue_dir}"}), 400

        queue_dir = new_path
        state_file = queue_dir / ".annotation_state.json"
        load_state()

        # Set default output dir if not specified
        if not new_output_dir and not output_dir:
            output_dir = queue_dir.parent / "datasets"
            output_dir.mkdir(parents=True, exist_ok=True)

    if new_output_dir:
        new_path = Path(new_output_dir).resolve()
        new_path.mkdir(parents=True, exist_ok=True)
        output_dir = new_path

    return jsonify({
        "status": "success",
        "queue_dir": str(queue_dir) if queue_dir else None,
        "output_dir": str(output_dir) if output_dir else None,
    })


def get_vlm_provider() -> VLMProvider:
    """Get or create the VLM provider based on current config."""
    global vlm_provider, vlm_config

    # Get API key from config or environment
    api_key = get_vlm_api_key()
    if not api_key:
        raise ValueError(
            "No API key configured. Set GOOGLE_GEMINI_API_KEY, "
            "set GOOGLE_API_KEY, or configure a key in settings."
        )

    # Create provider if needed or if config changed
    if vlm_provider is None or (
        isinstance(vlm_provider, GeminiProvider) and
        (vlm_provider.api_key != api_key or vlm_provider.model != vlm_config.get("model"))
    ):
        if vlm_config.get("provider") == "gemini":
            vlm_provider = GeminiProvider(api_key, vlm_config.get("model", "gemini-3-flash-preview"))
        else:
            raise ValueError(f"Unknown provider: {vlm_config.get('provider')}")

    return vlm_provider


@app.route("/api/vlm/config", methods=["GET"])
def get_vlm_config():
    """Get current VLM configuration."""
    global vlm_config

    # Check if API key is available (from config or env)
    api_key_source = get_vlm_api_key_source()
    has_api_key = bool(api_key_source)

    return jsonify({
        "provider": vlm_config.get("provider", "gemini"),
        "model": vlm_config.get("model", "gemini-3-flash-preview"),
        "has_api_key": has_api_key,
        "api_key_source": api_key_source,
        "generatable_test_types": sorted(TEST_TYPE_PROMPTS.keys()),
        "available_models": [
            "gemini-3-flash-preview",
            "gemini-3-pro-preview",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-1.5-pro",
            "gemini-1.5-flash",
        ],
    })


@app.route("/api/vlm/config", methods=["POST"])
def set_vlm_config():
    """Update VLM configuration."""
    global vlm_config, vlm_provider

    data = request.json

    if "api_key" in data:
        vlm_config["api_key"] = data["api_key"] if data["api_key"] else None
        vlm_provider = None  # Reset provider to pick up new key

    if "model" in data:
        vlm_config["model"] = data["model"]
        vlm_provider = None  # Reset provider to pick up new model

    if "provider" in data:
        vlm_config["provider"] = data["provider"]
        vlm_provider = None

    return jsonify({"status": "success"})


@app.route("/api/vlm/test", methods=["POST"])
def test_vlm_connection():
    """Test VLM connection."""
    try:
        provider = get_vlm_provider()
        if provider.test_connection():
            return jsonify({"status": "success", "message": "Connection successful"})
        else:
            return jsonify({"status": "error", "message": "Connection failed"}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route("/api/vlm/generate", methods=["POST"])
def vlm_generate():
    """Generate text or tests from an image using VLM."""
    try:
        data = request.json
        image_base64 = data.get("image")
        mode = data.get("mode", "parse")  # "parse", "generate_tests", or "review_tests"
        custom_prompt = data.get("prompt")  # Optional full custom prompt (overrides mode)
        additional_instructions = data.get("additional_instructions")  # Optional extra instructions
        test_count = data.get("test_count", 4)  # Number of tests to generate
        test_types = data.get("test_types")  # Optional list of test types to generate
        parse_content = data.get("parse_content")  # Optional parse.md content for context
        tests_to_review = data.get("tests_to_review")  # Tests for review mode

        if not image_base64:
            return jsonify({"error": "No image provided"}), 400

        # Remove data URI prefix if present
        if image_base64.startswith("data:"):
            image_base64 = image_base64.split(",", 1)[1]

        # Get prompt
        if custom_prompt:
            prompt = custom_prompt
        elif mode == "generate_tests":
            # Use modular prompt builder for generate_tests
            if not test_types:
                test_types = ["present", "absent", "order", "table"]  # Default types
            prompt = build_generate_tests_prompt(test_types, test_count, parse_content)
            # Append additional instructions if provided
            if additional_instructions:
                prompt = f"{prompt}\n\nAdditional instructions from user:\n{additional_instructions}"
        elif mode in VLM_PROMPTS:
            prompt = VLM_PROMPTS[mode]
            # Format tests_to_review into prompt if applicable
            if mode == "review_tests":
                if not tests_to_review:
                    return jsonify({"error": "No tests provided for review"}), 400
                prompt = prompt.format(tests_json=json.dumps(tests_to_review, indent=2))
            # Append additional instructions if provided
            if additional_instructions:
                prompt = f"{prompt}\n\nAdditional instructions from user:\n{additional_instructions}"
        else:
            return jsonify({"error": f"Unknown mode: {mode}"}), 400

        # Get provider and generate
        provider = get_vlm_provider()
        result = provider.generate(image_base64, prompt)

        # For generate_tests mode, try to parse as JSON
        if mode == "generate_tests":
            try:
                # Clean up the result - remove markdown code fences if present
                cleaned = result.strip()
                if cleaned.startswith("```"):
                    # Remove opening fence
                    cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()

                # Parse JSON
                tests = json.loads(cleaned)
                return jsonify({
                    "status": "success",
                    "mode": mode,
                    "result": result,
                    "tests": tests,
                })
            except json.JSONDecodeError:
                # Return raw result if JSON parsing fails
                return jsonify({
                    "status": "success",
                    "mode": mode,
                    "result": result,
                    "tests": None,
                    "parse_error": "Could not parse response as JSON",
                })

        # For review_tests mode, try to parse as JSON
        if mode == "review_tests":
            try:
                # Clean up the result - remove markdown code fences if present
                cleaned = result.strip()
                if cleaned.startswith("```"):
                    # Remove opening fence
                    cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()

                # Parse JSON
                review_data = json.loads(cleaned)
                return jsonify({
                    "status": "success",
                    "mode": mode,
                    "result": result,
                    "review_results": review_data.get("review_results", []),
                    "summary": review_data.get("summary", ""),
                })
            except json.JSONDecodeError:
                # Return raw result if JSON parsing fails
                return jsonify({
                    "status": "success",
                    "mode": mode,
                    "result": result,
                    "review_results": None,
                    "parse_error": "Could not parse review response as JSON",
                })

        return jsonify({
            "status": "success",
            "mode": mode,
            "result": result,
        })

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"VLM generation failed: {str(e)}"}), 500


@app.route("/api/browse")
def browse_directory():
    """Browse filesystem directories."""
    global base_browse_dir

    path = request.args.get("path", "")

    if not path:
        current_dir = base_browse_dir
    else:
        current_dir = Path(path).resolve()

    # Security check - don't allow browsing outside reasonable paths
    try:
        current_dir.relative_to(Path("/"))
    except ValueError:
        current_dir = base_browse_dir

    if not current_dir.exists() or not current_dir.is_dir():
        current_dir = base_browse_dir

    # Get parent directory
    parent = str(current_dir.parent) if current_dir != current_dir.parent else None

    # List directories only (for selecting queue directory)
    items = []
    try:
        for item in sorted(current_dir.iterdir()):
            if item.is_dir() and not item.name.startswith("."):
                # Count files in directory
                try:
                    file_count = sum(
                        1 for f in item.iterdir()
                        if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS
                    )
                except PermissionError:
                    file_count = 0

                items.append({
                    "name": item.name,
                    "path": str(item),
                    "is_dir": True,
                    "file_count": file_count,
                })
    except PermissionError:
        pass

    return jsonify({
        "current": str(current_dir),
        "parent": parent,
        "items": items,
    })


def get_parse_md_path(rel_path: str, current_queue_dir: Path | None = None) -> Path | None:
    """Get the path to the parse.md file for a given file, if it exists.

    Checks for these patterns in order:
    - {filename}.parse.md
    - {filename}_llama_agentic.md
    """
    resolved_queue = current_queue_dir or queue_dir
    if not resolved_queue:
        return None

    file_path = resolved_queue / rel_path

    # Check for supported parse result patterns
    patterns = [
        f"{file_path.stem}.parse.md",
        f"{file_path.stem}_llama_agentic.md",
    ]

    for pattern in patterns:
        candidate = file_path.parent / pattern
        if candidate.exists():
            return candidate

    return None


def get_parse_md_content(rel_path: str, current_queue_dir: Path | None = None) -> str | None:
    """Load parse.md content for a given file, if it exists."""
    parse_md_path = get_parse_md_path(rel_path, current_queue_dir)

    if parse_md_path:
        try:
            with open(parse_md_path, encoding="utf-8") as f:
                return f.read()
        except OSError:
            return None
    return None


# Layout Detection Ontology Labels
LAYOUT_ONTOLOGY_LABELS = {
    "basic": [
        "Formula", "Page-footer", "Page-header",
        "Picture", "Section", "Table", "Text"
    ],
    "core": [
        "Caption", "Footnote", "Formula", "List-item", "Page-footer",
        "Page-header", "Picture", "Section-header", "Table", "Text", "Title"
    ],
    "canonical": [
        "Caption", "Checkbox-Selected", "Checkbox-Unselected", "Code",
        "Document Index", "Footnote", "Form", "Formula", "Key-Value Region",
        "List-item", "Page-footer", "Page-header", "Picture", "Section-header",
        "Table", "Text", "Title"
    ],
}


@app.route("/api/ontology/<ontology_type>")
def get_ontology_labels(ontology_type: str):
    """Get layout detection labels for a given ontology type."""
    if ontology_type not in LAYOUT_ONTOLOGY_LABELS:
        return jsonify({"error": f"Unknown ontology type: {ontology_type}"}), 400

    return jsonify({
        "ontology_type": ontology_type,
        "labels": LAYOUT_ONTOLOGY_LABELS[ontology_type],
    })


@app.route("/api/parse-md/<path:rel_path>")
def get_parse_md(rel_path: str):
    """Check if parse.md exists for a file and optionally return its content."""
    try:
        current_queue_dir = resolve_request_queue_dir()
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 404

    if not current_queue_dir:
        return jsonify({"error": "Queue directory not configured"}), 500

    include_content = request.args.get("content", "false").lower() == "true"

    parse_md_path = get_parse_md_path(rel_path, current_queue_dir)

    if parse_md_path:
        result = {"exists": True, "path": str(parse_md_path.relative_to(current_queue_dir))}

        if include_content:
            try:
                with open(parse_md_path, encoding="utf-8") as f:
                    result["content"] = f.read()
            except OSError:
                result["content"] = None

        return jsonify(result)

    return jsonify({"exists": False})


def main() -> None:
    """Main entry point."""
    global queue_dir, output_dir, state_file, base_browse_dir

    parser = argparse.ArgumentParser(description="Parse Annotation App Server")
    parser.add_argument(
        "--queue-dir",
        type=str,
        default=None,
        help="Directory containing files to annotate (can be set in UI)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Directory for exported datasets (default: <queue-dir>/../datasets)",
    )
    parser.add_argument(
        "--browse-root",
        type=str,
        default=None,
        help="Starting directory for file browser (default: home directory)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=5001,
        help="Port to run server on (default: 5001)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )

    args = parser.parse_args()

    # Set browse root
    if args.browse_root:
        base_browse_dir = Path(args.browse_root).resolve()

    # Set queue directory if provided
    if args.queue_dir:
        queue_dir = Path(args.queue_dir).resolve()
        if not queue_dir.exists():
            print(f"Creating queue directory: {queue_dir}")
            queue_dir.mkdir(parents=True, exist_ok=True)

        # State file in queue directory
        state_file = queue_dir / ".annotation_state.json"
        load_state()

        # Set output directory
        output_dir = Path(args.output_dir).resolve() if args.output_dir else queue_dir.parent / "datasets"
        if not output_dir.exists():
            output_dir.mkdir(parents=True, exist_ok=True)

        print(f"Queue directory: {queue_dir}")
        print(f"Output directory: {output_dir}")
    else:
        print("No queue directory specified. Select one in the UI.")

    print(f"Starting server at http://{args.host}:{args.port}")

    app.run(host=args.host, port=args.port, debug=True, threaded=True)


if __name__ == "__main__":
    main()
