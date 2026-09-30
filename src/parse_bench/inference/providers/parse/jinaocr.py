"""Provider for the Jina-OCR-v1 server.

Jina-OCR-v1 (jinaai/jina-ocr-v1) is a DeepSeek-OCR fine-tune served through vLLM
with a FastMTP speculative-decoding head. It is a markdown-only parser: unlike the
DeepSeek-OCR base model it emits no ``<|det|>`` boxes for any prompt phrasing, so
this provider produces no ``layout_pages`` and layout datasets score it on text
only.

API format: POST /predict with {"image_base64": "...", "prompt": "..."}
            -> {"markdown": "...", "status": "success"}
"""

import asyncio
import base64
import io
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
    ProviderTransientError,
)
from parse_bench.inference.providers.parse.mistral_ocr import _convert_pipe_tables_to_html
from parse_bench.inference.providers.registry import register_provider
from parse_bench.schemas.parse_output import ParseOutput
from parse_bench.schemas.pipeline import PipelineSpec
from parse_bench.schemas.pipeline_io import (
    InferenceRequest,
    InferenceResult,
    RawInferenceResult,
)
from parse_bench.schemas.product import ProductType


@register_provider("jinaocr")
class JinaOCRProvider(Provider):
    """
    Provider for the Jina-OCR-v1 server.

    Configuration options:
        - server_url (str, required): predict endpoint URL; falls back to
          the ``JINAOCR_SERVER_URL`` environment variable
        - prompt (str, optional): override the server's default OCR prompt
        - max_tokens (int, optional): generation budget per page
        - timeout (int, default=600): Request timeout in seconds
        - dpi (int, default=150): DPI for PDF to image conversion
    """

    def __init__(self, provider_name: str, base_config: dict[str, Any] | None = None):
        super().__init__(provider_name, base_config)

        server_url = self.base_config.get("server_url") or os.getenv("JINAOCR_SERVER_URL")
        if not server_url:
            raise ProviderConfigError("JinaOCR provider requires 'server_url' in config.")
        self._server_url: str = server_url

        self._prompt: str | None = self.base_config.get("prompt")
        self._max_tokens: int | None = self.base_config.get("max_tokens")
        self._timeout = self.base_config.get("timeout", 600)
        self._dpi = self.base_config.get("dpi", 150)

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
            raise ProviderPermanentError("pdf2image is required.") from e
        except Exception as e:
            if "pdf2image" in str(e).lower():
                raise
            raise ProviderPermanentError(f"Error converting PDF to image: {e}") from e

    def _read_image(self, file_path: Path) -> bytes:
        try:
            return file_path.read_bytes()
        except Exception as e:
            raise ProviderPermanentError(f"Error reading image file: {e}") from e

    async def _call_api(self, session: aiohttp.ClientSession, image_b64: str) -> dict[str, Any]:
        api_url = self._server_url.rstrip("/")

        payload: dict[str, Any] = {"image_base64": image_b64}
        if self._prompt:
            payload["prompt"] = self._prompt
        if self._max_tokens:
            payload["max_tokens"] = self._max_tokens

        async with session.post(
            api_url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=self._timeout),
        ) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                if resp.status in (408, 502, 503, 504):
                    raise ProviderTransientError(f"HTTP {resp.status}: {error_text[:200]}")
                raise ProviderPermanentError(f"HTTP {resp.status}: {error_text[:200]}")

            result: dict[str, Any] = await resp.json()
            if result.get("status") == "error":
                raise ProviderPermanentError(result.get("error", "Unknown error from API"))

            content: str = result.get("markdown", "")
            if not content:
                raise ProviderPermanentError("Empty markdown response from API")
            return result

    async def _run_inference_async(self, image_bytes: bytes) -> dict[str, Any]:
        image_b64 = base64.b64encode(image_bytes).decode()

        async with aiohttp.ClientSession() as session:
            result = await self._call_api(session, image_b64)

        return {
            "markdown": result.get("markdown", ""),
            "image_width": result.get("image_width"),
            "image_height": result.get("image_height"),
            "_config": {
                "server_url": self._server_url,
                "prompt": self._prompt,
                "dpi": self._dpi,
            },
        }

    async def _run_inference_pages_async(self, pages: list[bytes]) -> dict[str, Any]:
        """Run pages concurrently; the server batches them through vLLM."""
        results = await asyncio.gather(*(self._run_inference_async(page) for page in pages))
        first = results[0]
        if len(results) == 1:
            return first
        merged = dict(first)
        merged["page_results"] = list(results)
        return merged

    def run_inference(self, pipeline: PipelineSpec, request: InferenceRequest) -> RawInferenceResult:
        if request.product_type != ProductType.PARSE:
            raise ProviderPermanentError(
                f"JinaOCRProvider only supports PARSE product type, got {request.product_type}"
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

        except (ProviderPermanentError, ProviderTransientError):
            raise

        except Exception as e:
            completed_at = datetime.now()
            latency_ms = int((completed_at - started_at).total_seconds() * 1000)

            error_msg = str(e)
            if isinstance(e, asyncio.TimeoutError):
                error_msg = f"Request timed out after {self._timeout} seconds"

            return RawInferenceResult(
                request=request,
                pipeline=pipeline,
                pipeline_name=pipeline.pipeline_name,
                product_type=request.product_type,
                raw_output={
                    "markdown": "",
                    "_error": error_msg,
                    "_error_type": type(e).__name__,
                    "_config": {
                        "server_url": self._server_url,
                        "prompt": self._prompt,
                        "dpi": self._dpi,
                    },
                },
                started_at=started_at,
                completed_at=completed_at,
                latency_in_ms=latency_ms,
            )

    @staticmethod
    def _close_unclosed_table_tags(content: str) -> str:
        """Auto-close unclosed HTML table tags from truncated model output."""
        opens = content.count("<table>")
        closes = content.count("</table>")
        if opens > closes:
            if not content.rstrip().endswith(">"):
                # Truncated mid-cell — close the cell and row first.
                content += "</td></tr>"
            content += "</table>" * (opens - closes)
        return content

    @staticmethod
    def _demote_body_header_cells(content: str) -> str:
        """Rewrite ``<th>`` to ``<td>`` inside ``<tbody>``.

        The model marks up its column headers correctly (``<thead>`` + ``<th>``)
        but then tags *every* data cell ``<th>`` as well, never emitting a single
        ``<td>``. The table scorers read ``<th>`` as "header", so every body row
        is classified as a header row, the table has no data records left, and
        table_record_match (half of GriTS TRM Composite) and the chart data-point
        rules both collapse to 0.

        Restricting the rewrite to ``<tbody>`` keeps the authored ``<thead>``
        block intact and only changes markup the model has no information in:
        with zero ``<td>`` anywhere, the th/td distinction inside the body
        carries no signal to lose.
        """
        if "<tbody" not in content or "<th" not in content:
            return content

        def _demote(match: re.Match[str]) -> str:
            body: str = match.group(0)
            body = re.sub(r"<th(\s|>)", r"<td\1", body)
            return body.replace("</th>", "</td>")

        return re.sub(r"<tbody[^>]*>.*?</tbody>", _demote, content, flags=re.DOTALL)

    @staticmethod
    def _sanitize_html_attributes(markdown: str) -> str:
        """Quote unquoted HTML attributes for XML-based metric parsers."""

        def _quote_attrs(match: re.Match) -> str:
            tag_text: str = match.group(0)
            return re.sub(r'(\w+)=([^\s"\'<>=]+)', r'\1="\2"', tag_text)

        return re.sub(r"<[^>]+>", _quote_attrs, markdown)

    def normalize(self, raw_result: RawInferenceResult) -> InferenceResult:
        if raw_result.product_type != ProductType.PARSE:
            raise ProviderPermanentError(
                f"JinaOCRProvider only supports PARSE product type, got {raw_result.product_type}"
            )

        page_results = raw_result.raw_output.get("page_results")
        if not isinstance(page_results, list) or not page_results:
            page_results = [raw_result.raw_output]

        page_markdowns: list[str] = []
        for page_raw in page_results:
            markdown = page_raw.get("markdown", "")
            if not markdown:
                continue
            # The model truncates at max_tokens mid-table on dense pages.
            markdown = self._close_unclosed_table_tags(markdown)
            # Any markdown pipe tables -> HTML (shared helper).
            markdown = _convert_pipe_tables_to_html(markdown)
            markdown = self._demote_body_header_cells(markdown)
            markdown = self._sanitize_html_attributes(markdown)
            page_markdowns.append(markdown)

        output = ParseOutput(
            task_type="parse",
            example_id=raw_result.request.example_id,
            pipeline_name=raw_result.pipeline_name,
            pages=[],
            markdown="\n\n".join(page_markdowns),
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
