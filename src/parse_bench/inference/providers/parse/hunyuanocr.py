"""Provider for HunyuanOCR-1.5 (tencent/HunyuanOCR).

HunyuanOCR-1.5 is a small end-to-end OCR VLM served behind an
OpenAI-compatible endpoint. Its task prompts are fixed by the model, so this
provider sends the official prompt text without modification.

The ``layout_parse`` task returns layout labels, normalized quadrilateral
boxes, and per-block content. Detected figures have empty content, so the
provider optionally re-reads each figure crop with the official
``chart_parse`` task.
"""

import asyncio
import base64
import io
import json
import math
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import aiohttp

from parse_bench.inference.providers.base import (
    Provider,
    ProviderConfigError,
    ProviderPermanentError,
    ProviderRateLimitError,
    ProviderTransientError,
)
from parse_bench.inference.providers.parse._layout_utils import (
    build_layout_pages,
    items_to_markdown,
)
from parse_bench.inference.providers.parse.mistral_ocr import (
    _convert_pipe_tables_to_html,
)
from parse_bench.inference.providers.registry import register_provider
from parse_bench.schemas.parse_output import ParseOutput
from parse_bench.schemas.pipeline import PipelineSpec
from parse_bench.schemas.pipeline_io import (
    InferenceRequest,
    InferenceResult,
    RawInferenceResult,
)
from parse_bench.schemas.product import ProductType

SERVED_MODEL_NAME = "tencent/HunyuanOCR"

# Official task prompts from the model's inference task definitions.
LAYOUT_PARSE_PROMPT = (
    "提取文档图片中所有内容用markdown格式表示，表格用html格式表达，"
    "文档中公式用latex格式表示，请按照阅读顺序组织进行全文解析，并输出版式分析信息。"
)
CHART_PARSE_PROMPT = "解析图中的图表，对于流程图使用Mermaid格式表示，其他图表使用Markdown格式表示。"

COORD_SCALE = 1000.0

_COORD_NUMBER = r"-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
_COORD_PAIR_RE = re.compile(rf"\(\s*({_COORD_NUMBER})\s*,\s*({_COORD_NUMBER})\s*\)")
_TRUNCATED_COORD_PAIR_RE = re.compile(rf"^[,\s]*\(\s*({_COORD_NUMBER})\s*,\s*({_COORD_NUMBER})\s*[\"']?$")
_JSON_ARRAY_RE = re.compile(r"\[\s*\{.*}\s*]", re.DOTALL)

# Some responses contain unescaped quotes in HTML attributes. The stable
# layout_type and bbox fields let us recover individual items without dropping
# the whole page.
_LENIENT_ITEM_RE = re.compile(
    r'\{\s*"layout_type"\s*:\s*"(?P<label>[^"]*)"\s*,\s*'
    r'"bbox"\s*:\s*"(?P<bbox>[^"]*)"'
    r'(?:\s*,\s*"text"\s*:\s*"(?P<text>.*?)"\s*)?'
    r"}(?=\s*(?:,\s*\{|]|$))",
    re.DOTALL,
)
_TRUNCATED_FINAL_ITEM_RE = re.compile(
    r'\{\s*"layout_type"\s*:\s*"(?P<label>[^"]*)"\s*,\s*'
    r'"bbox"\s*:\s*"(?P<bbox>[^"]*)"\s*,\s*'
    r'"text"\s*:\s*"(?P<text>.*?)(?:"\s*)?$',
    re.DOTALL,
)
_HY_META_START_RE = re.compile(r"<hy-meta\b[^>]*>", re.IGNORECASE)
_HY_META_END_RE = re.compile(r"</hy-meta\s*>", re.IGNORECASE)
_HY_META_LAYOUT_RE = re.compile(
    r"<layout\b[^>]*>\s*(?P<label>[^<]+?)\s*(?:</layout\s*>|(?=<(?:quad|poly)\b))",
    re.IGNORECASE | re.DOTALL,
)
_HY_META_GEOMETRY_RE = re.compile(
    r"<(?P<tag>quad|poly)\b[^>]*>\s*(?P<bbox>.*?)"
    r"(?:</(?P=tag)\s*>|(?=</hy-meta\s*>)|$)",
    re.IGNORECASE | re.DOTALL,
)
_TABLE_TAG_RE = re.compile(
    r"<(?P<closing>/)?(?P<tag>table|thead|tbody|tfoot|tr|th|td)\b[^>]*>",
    re.IGNORECASE,
)
_ESCAPE_RE = re.compile(r"\\(u[0-9a-fA-F]{4}|.)")
_SIMPLE_ESCAPES = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "b": "\b",
    "f": "\f",
    '"': '"',
    "\\": "\\",
    "/": "/",
}


def _unescape_json_string(value: str) -> str:
    """Apply JSON string escapes to a value recovered outside a JSON parse."""

    def _replace(match: re.Match[str]) -> str:
        token = match.group(1)
        if token.startswith("u") and len(token) == 5:
            return chr(int(token[1:], 16))
        return _SIMPLE_ESCAPES.get(token, token)

    return _ESCAPE_RE.sub(_replace, value)


@register_provider("hunyuanocr")
class HunyuanOcrProvider(Provider):
    """Provider for a self-hosted HunyuanOCR-1.5 endpoint.

    Configuration options:
        - server_url (str, required): OpenAI-compatible endpoint root. Falls
          back to the ``HUNYUANOCR_SERVER_URL`` environment variable.
        - served_model_name (str, default="tencent/HunyuanOCR")
        - timeout (int, default=900): Request timeout in seconds
        - dpi (int, default=200): DPI for PDF page rendering
        - api_key_env (str, default="VLLM_API_KEY"): API key environment variable
        - max_tokens (int, default=16384): Maximum output tokens
        - figure_pass (bool, default=True): Re-read figures with chart_parse
        - figure_pad (float, default=0.05): Padding added around figure crops
    """

    def __init__(self, provider_name: str, base_config: dict[str, Any] | None = None):
        super().__init__(provider_name, base_config)

        server_url = self.base_config.get("server_url") or os.getenv("HUNYUANOCR_SERVER_URL")
        if not server_url:
            raise ProviderConfigError(
                "HunyuanOCR provider requires 'server_url' in config or HUNYUANOCR_SERVER_URL in the environment."
            )
        self._server_url = str(server_url)

        self._served_model_name = self.base_config.get("served_model_name", SERVED_MODEL_NAME)
        self._timeout = self.base_config.get("timeout", 900)
        self._dpi = self.base_config.get("dpi", 200)
        self._max_tokens = self.base_config.get("max_tokens", 16384)
        self._figure_pass = bool(self.base_config.get("figure_pass", True))
        self._figure_pad = float(self.base_config.get("figure_pad", 0.05))

        api_key_env = self.base_config.get("api_key_env", "VLLM_API_KEY")
        self._api_key = os.environ.get(api_key_env, "")

    def _pdf_to_images(self, pdf_path: Path) -> list[bytes]:
        """Render every PDF page to PNG bytes in source order."""
        try:
            from pdf2image import convert_from_path

            images = convert_from_path(pdf_path, dpi=self._dpi)
            if not images:
                raise ProviderPermanentError(f"No pages found in PDF: {pdf_path}")
            encoded: list[bytes] = []
            for image in images:
                buf = io.BytesIO()
                image.save(buf, format="PNG")
                encoded.append(buf.getvalue())
            return encoded
        except ImportError as e:
            raise ProviderPermanentError("pdf2image is required. Install with: pip install pdf2image") from e
        except Exception as e:
            if "pdf2image" in str(e).lower():
                raise
            raise ProviderPermanentError(f"Error converting PDF to image: {e}") from e

    def _read_image(self, file_path: Path) -> bytes:
        try:
            return file_path.read_bytes()
        except Exception as e:
            raise ProviderPermanentError(f"Error reading image file: {e}") from e

    async def _call_api(
        self,
        session: aiohttp.ClientSession,
        image_b64: str,
        prompt: str,
    ) -> str:
        api_url = f"{self._server_url.rstrip('/')}/v1/chat/completions"

        payload: dict[str, Any] = {
            "model": self._served_model_name,
            "messages": [
                {"role": "system", "content": ""},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                        },
                        {"type": "text", "text": prompt},
                    ],
                },
            ],
            "max_tokens": self._max_tokens,
            "temperature": 0.0,
            "top_p": 1.0,
            "top_k": -1,
            "repetition_penalty": 1.08,
            "skip_special_tokens": True,
            "stream": False,
        }

        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        try:
            async with session.post(
                api_url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=self._timeout),
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    if resp.status == 429:
                        raise ProviderRateLimitError(f"HTTP {resp.status}: {error_text[:200]}")
                    if resp.status == 408 or resp.status >= 500:
                        raise ProviderTransientError(f"HTTP {resp.status}: {error_text[:200]}")
                    raise ProviderPermanentError(f"HTTP {resp.status}: {error_text[:200]}")

                try:
                    result: dict[str, Any] = await resp.json()
                except (aiohttp.ClientError, ValueError) as e:
                    raise ProviderTransientError(f"Invalid JSON response: {type(e).__name__}: {e}") from e
                try:
                    content = result["choices"][0]["message"]["content"]
                except (KeyError, IndexError, TypeError) as e:
                    raise ProviderPermanentError(f"Invalid response format: {e}") from e

                if not isinstance(content, str) or not content:
                    raise ProviderPermanentError("Empty content response from API")
                # A length finish_reason can still carry most of a page. Parsing
                # below deliberately salvages that content instead of rejecting it.
                return clean_repeated_substrings(content)
        except (ProviderPermanentError, ProviderRateLimitError, ProviderTransientError):
            raise
        except (TimeoutError, aiohttp.ClientError) as e:
            raise ProviderTransientError(f"HunyuanOCR request failed: {type(e).__name__}: {e}") from e

    @staticmethod
    def _parse_quad(bbox: Any) -> list[float]:
        """Convert a quadrilateral to an axis-aligned ``[x1, y1, x2, y2]``."""
        if isinstance(bbox, str):
            matches = list(_COORD_PAIR_RE.finditer(bbox))
            if matches:
                remainder = _COORD_PAIR_RE.sub("", bbox)
                if len(matches) == 4 and not remainder.strip(" ,"):
                    points = [(float(match.group(1)), float(match.group(2))) for match in matches]
                elif len(matches) == 3:
                    truncated = _TRUNCATED_COORD_PAIR_RE.match(remainder)
                    if not truncated:
                        return []
                    points = [(float(match.group(1)), float(match.group(2))) for match in matches]
                    points.append((float(truncated.group(1)), float(truncated.group(2))))
                else:
                    return []
            else:
                try:
                    decoded = json.loads(bbox)
                except (json.JSONDecodeError, TypeError):
                    return []
                return HunyuanOcrProvider._parse_quad(decoded)
        elif isinstance(bbox, list):
            if len(bbox) == 4 and all(
                isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                for value in bbox
            ):
                return [float(v) for v in bbox]
            if len(bbox) != 4:
                return []
            points: list[tuple[float, float]] = []
            for point in bbox:
                if not isinstance(point, (list, tuple)) or len(point) != 2:
                    return []
                if not all(
                    isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                    for value in point
                ):
                    return []
                points.append((float(point[0]), float(point[1])))
        else:
            return []
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        return [min(xs), min(ys), max(xs), max(ys)]

    @classmethod
    def _parse_hy_meta_items(cls, content: str) -> list[dict[str, Any]]:
        """Parse the model's legacy ``text<hy-meta>...`` layout format.

        Each metadata block describes the body text immediately before it.
        Scan by tag boundaries instead of using ``[^<]*`` for the body so
        useful HTML and Markdown inside tables or paragraphs are retained.
        A final block may omit closing tags when generation stops, provided
        its label and complete four-point geometry are still usable.
        """
        starts = list(_HY_META_START_RE.finditer(content))
        if not starts:
            return []

        items: list[dict[str, Any]] = []
        body_start = 0
        for index, start in enumerate(starts):
            next_start = starts[index + 1].start() if index + 1 < len(starts) else len(content)
            end = _HY_META_END_RE.search(content, start.end(), next_start)
            metadata_end = end.start() if end else next_start
            metadata = content[start.end() : metadata_end]

            layout_match = _HY_META_LAYOUT_RE.search(metadata)
            geometry_match = _HY_META_GEOMETRY_RE.search(metadata)
            if layout_match and geometry_match:
                bbox = cls._parse_quad(geometry_match.group("bbox"))
                if len(bbox) == 4:
                    items.append(
                        {
                            "label": layout_match.group("label").strip().lower(),
                            "bbox": bbox,
                            "text": content[body_start : start.start()].strip(),
                        }
                    )

            body_start = end.end() if end else next_start

        return items

    @classmethod
    def _parse_layout_items(cls, content: str) -> list[dict[str, Any]]:
        """Parse a layout_parse response into layout items."""
        text = content.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)

        array_match = _JSON_ARRAY_RE.search(text)
        candidates = [text] + ([array_match.group(0)] if array_match else [])

        data: Any = None
        for candidate in candidates:
            try:
                data = json.loads(candidate)
                break
            except json.JSONDecodeError:
                continue

        if isinstance(data, list):
            entries = [
                (
                    str(entry.get("layout_type", "") or ""),
                    entry.get("bbox", ""),
                    entry.get("text", ""),
                )
                for entry in data
                if isinstance(entry, dict)
            ]
        elif "<hy-meta" in text.lower():
            return cls._parse_hy_meta_items(text)
        else:
            matches = list(_LENIENT_ITEM_RE.finditer(text))
            entries = [
                (
                    match.group("label"),
                    match.group("bbox"),
                    _unescape_json_string(match.group("text") or ""),
                )
                for match in matches
            ]
            tail_start = matches[-1].end() if matches else 0
            truncated = _TRUNCATED_FINAL_ITEM_RE.search(text[tail_start:])
            if truncated:
                entries.append(
                    (
                        truncated.group("label"),
                        truncated.group("bbox"),
                        _unescape_json_string(truncated.group("text") or ""),
                    )
                )

        items: list[dict[str, Any]] = []
        for label, raw_bbox, value in entries:
            bbox = cls._parse_quad(raw_bbox)
            if len(bbox) != 4:
                continue
            items.append(
                {
                    "label": label.strip().lower(),
                    "bbox": bbox,
                    "text": value.strip() if isinstance(value, str) else "",
                }
            )
        return items

    _FIGURE_LABELS = frozenset({"figure", "image", "picture", "chart", "diagram"})

    def _crop_figure(self, page_png: bytes, bbox: list[float]) -> bytes | None:
        """Crop and pad a normalized figure box from the page image."""
        from PIL import Image

        image = Image.open(io.BytesIO(page_png))
        width, height = image.size
        pad_x = (bbox[2] - bbox[0]) * self._figure_pad
        pad_y = (bbox[3] - bbox[1]) * self._figure_pad
        x1 = max(0, int((bbox[0] - pad_x) / COORD_SCALE * width))
        y1 = max(0, int((bbox[1] - pad_y) / COORD_SCALE * height))
        x2 = min(width, int((bbox[2] + pad_x) / COORD_SCALE * width))
        y2 = min(height, int((bbox[3] + pad_y) / COORD_SCALE * height))
        if x2 - x1 < 32 or y2 - y1 < 32:
            return None
        buf = io.BytesIO()
        image.crop((x1, y1, x2, y2)).save(buf, format="PNG")
        return buf.getvalue()

    async def _run_page_async(
        self,
        session: aiohttp.ClientSession,
        page_png: bytes,
    ) -> dict[str, Any]:
        from PIL import Image

        width, height = Image.open(io.BytesIO(page_png)).size
        image_b64 = base64.b64encode(page_png).decode()
        content = await self._call_api(session, image_b64, LAYOUT_PARSE_PROMPT)
        items = self._parse_layout_items(content)

        figures_read = 0
        if self._figure_pass:
            for item in items:
                if item["label"] not in self._FIGURE_LABELS or item["text"]:
                    continue
                crop = self._crop_figure(page_png, item["bbox"])
                if crop is None:
                    continue
                crop_b64 = base64.b64encode(crop).decode()
                item["text"] = await self._call_api(session, crop_b64, CHART_PARSE_PROMPT)
                if item["text"]:
                    figures_read += 1

        return {
            "layout_parse_raw": content,
            "layout_items": items,
            "figures_read": figures_read,
            "image_width": width,
            "image_height": height,
        }

    async def _run_inference_pages_async(self, pages: list[bytes]) -> dict[str, Any]:
        """Run each input page in order, retaining the one-page shape."""
        async with aiohttp.ClientSession() as session:
            results = [await self._run_page_async(session, page) for page in pages]

        config = {
            "server_url": self._server_url,
            "served_model_name": self._served_model_name,
            "dpi": self._dpi,
            "max_tokens": self._max_tokens,
            "figure_pass": self._figure_pass,
            "figure_pad": self._figure_pad,
        }
        merged = dict(results[0])
        merged["_config"] = config
        if len(results) > 1:
            merged["page_results"] = results
        return merged

    def run_inference(
        self,
        pipeline: PipelineSpec,
        request: InferenceRequest,
    ) -> RawInferenceResult:
        if request.product_type != ProductType.PARSE:
            raise ProviderPermanentError(
                f"HunyuanOcrProvider only supports PARSE product type, got {request.product_type}"
            )

        started_at = datetime.now()
        file_path = Path(request.source_file_path)
        if not file_path.exists():
            raise ProviderPermanentError(f"Source file not found: {file_path}")

        suffix = file_path.suffix.lower()
        if suffix == ".pdf":
            page_images = self._pdf_to_images(file_path)
        elif suffix in (".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp"):
            page_images = [self._read_image(file_path)]
        else:
            raise ProviderPermanentError(
                f"Unsupported file type: {suffix}. Supported: .pdf, .png, .jpg, .jpeg, .webp, .tiff, .bmp"
            )

        try:
            raw_output = asyncio.run(self._run_inference_pages_async(page_images))
            completed_at = datetime.now()
            latency_ms = int((completed_at - started_at).total_seconds() * 1000)
            return RawInferenceResult(
                request=request,
                pipeline=pipeline,
                pipeline_name=pipeline.pipeline_name,
                product_type=request.product_type,
                raw_output=raw_output,
                started_at=started_at,
                completed_at=completed_at,
                latency_in_ms=latency_ms,
            )
        except (ProviderPermanentError, ProviderRateLimitError, ProviderTransientError):
            raise
        except (TimeoutError, aiohttp.ClientError, json.JSONDecodeError) as e:
            raise ProviderTransientError(f"HunyuanOCR request failed: {type(e).__name__}: {e}") from e
        except Exception as e:
            raise ProviderPermanentError(f"Unexpected HunyuanOCR inference error: {e}") from e

    @staticmethod
    def _close_unclosed_table_tags(content: str) -> str:
        """Close table tags left open when generation stops mid-table."""
        incomplete_tag = re.search(
            r"<(?:/?(?:table|thead|tbody|tfoot|tr|th|td))\b[^>]*$",
            content,
            flags=re.IGNORECASE,
        )
        if incomplete_tag:
            content = content[: incomplete_tag.start()]

        stack: list[str] = []
        for match in _TABLE_TAG_RE.finditer(content):
            tag = match.group("tag").lower()
            if not match.group("closing"):
                stack.append(tag)
                continue
            if tag not in stack:
                continue
            while stack:
                opened = stack.pop()
                if opened == tag:
                    break

        if "table" not in stack:
            return content
        return content + "".join(f"</{tag}>" for tag in reversed(stack))

    @staticmethod
    def _items_to_markdown(items: list[dict[str, Any]]) -> str:
        """Render canonical code items as fenced blocks and other items normally."""
        parts: list[str] = []
        for item in items:
            text = str(item.get("text", "") or "").strip()
            if not text:
                continue
            if str(item.get("label", "")).lower() == "code":
                if text.startswith("```") and text.endswith("```"):
                    parts.append(text)
                else:
                    parts.append(f"```\n{text}\n```")
            else:
                rendered = items_to_markdown([item])
                if rendered:
                    parts.append(rendered)
        return "\n\n".join(parts)

    @staticmethod
    def _sanitize_html_attributes(markdown: str) -> str:
        """Quote unquoted HTML attributes for XML-based metric parsers."""

        def _quote_attrs(match: re.Match[str]) -> str:
            return re.sub(
                r'(\w+)=([^\s"\'<>=]+)',
                r'\1="\2"',
                match.group(0),
            )

        return re.sub(r"<[^>]+>", _quote_attrs, markdown)

    # Includes every spelling canonicalized by the official layout scorer,
    # plus layout_parse labels observed in the model's structured output.
    _LABEL_ALIASES: dict[str, str] = {
        "paragraph": "text",
        "paragraph_span": "text",
        "paragraphspan": "text",
        "para": "text",
        "para_title": "section-header",
        "paratitle": "section-header",
        "sub_title": "section-header",
        "subtitle": "section-header",
        "section_title": "section-header",
        "sectiontitle": "section-header",
        "section_header": "section-header",
        "sectionheader": "section-header",
        "heading": "section-header",
        "doc_title": "title",
        "doctitle": "title",
        "document_title": "title",
        "documenttitle": "title",
        "title": "title",
        "list_item": "list-item",
        "listitem": "list-item",
        "table_title": "caption",
        "tabletitle": "caption",
        "table_caption": "caption",
        "tablecaption": "caption",
        "figure_title": "caption",
        "figuretitle": "caption",
        "figure_caption": "caption",
        "figurecaption": "caption",
        "image_caption": "caption",
        "imagecaption": "caption",
        "chart_title": "caption",
        "charttitle": "caption",
        "chart_caption": "caption",
        "chartcaption": "caption",
        "caption": "caption",
        "table_footer_note": "footnote",
        "table_note": "footnote",
        "footer_note": "footnote",
        "header": "page-header",
        "page_header": "page-header",
        "footer": "page-footer",
        "page_footer": "page-footer",
        "page": "page-footer",
        "page_number": "page-footer",
        "image": "picture",
        "figure": "picture",
        "chart": "picture",
        "diagram": "picture",
        "equation": "formula",
        "algorithm": "code",
        "algorithm_chart": "code",
        "reference": "text",
        "table_of_contents": "document index",
        "tableofcontents": "document index",
        "catalogue": "document index",
        "catalog": "document index",
        "catalogue_title": "document index",
        "cataloguetitle": "document index",
        "catalog_title": "document index",
        "catalogtitle": "document index",
        "document_index": "document index",
        "documentindex": "document index",
    }

    @classmethod
    def _normalize_layout_label(cls, label: Any) -> str:
        """Map model label spellings to names understood by ParseBench."""
        raw = str(label or "").strip().lower()
        normalized = re.sub(r"_+", "_", re.sub(r"[\s-]+", "_", raw))
        if normalized.startswith("table_of_"):
            return "document index"
        return cls._LABEL_ALIASES.get(normalized, raw)

    def normalize(self, raw_result: RawInferenceResult) -> InferenceResult:
        if raw_result.product_type != ProductType.PARSE:
            raise ProviderPermanentError(
                f"HunyuanOcrProvider only supports PARSE product type, got {raw_result.product_type}"
            )

        page_results = raw_result.raw_output.get("page_results")
        if not isinstance(page_results, list) or not page_results:
            page_results = [raw_result.raw_output]

        page_markdowns: list[str] = []
        layout_pages = []
        for page_number, page_raw in enumerate(page_results, start=1):
            layout_items = []
            for item in page_raw.get("layout_items", []):
                label = self._normalize_layout_label(item.get("label", ""))
                text = item.get("text", "")
                if label == "table" and isinstance(text, str) and text:
                    text = self._close_unclosed_table_tags(text)
                layout_items.append(
                    {
                        "label": label,
                        "bbox": item.get("bbox", []),
                        "text": text,
                    }
                )

            markdown = self._items_to_markdown(layout_items)
            if markdown:
                markdown = _convert_pipe_tables_to_html(markdown)
                markdown = self._sanitize_html_attributes(markdown)
            page_markdowns.append(markdown)
            layout_pages.extend(
                build_layout_pages(
                    items=layout_items,
                    image_width=page_raw.get("image_width", 0),
                    image_height=page_raw.get("image_height", 0),
                    markdown=markdown,
                    page_number=page_number,
                )
            )

        markdown = "\n\n".join(page for page in page_markdowns if page)
        output = ParseOutput(
            task_type="parse",
            example_id=raw_result.request.example_id,
            pipeline_name=raw_result.pipeline_name,
            pages=[],
            markdown=markdown,
            layout_pages=layout_pages,
        )
        return InferenceResult(
            request=raw_result.request,
            pipeline_name=raw_result.pipeline_name,
            product_type=raw_result.product_type,
            raw_output=raw_result.raw_output,
            output=output,
            started_at=raw_result.started_at,
            completed_at=raw_result.completed_at,
            latency_in_ms=raw_result.latency_in_ms,
        )


def clean_repeated_substrings(text: str, min_repeats: int = 10) -> str:
    """Trim a runaway repeated tail from a HunyuanOCR generation."""
    n = len(text)
    if n < 2000:
        return text
    for length in range(2, n // min_repeats + 1):
        candidate = text[-length:]
        count = 0
        index = n - length
        while index >= 0 and text[index : index + length] == candidate:
            count += 1
            index -= length
        if count >= min_repeats:
            return text[: n - length * (count - 1)]
    return text
