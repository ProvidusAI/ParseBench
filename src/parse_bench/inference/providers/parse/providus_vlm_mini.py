"""Providus-VLM-mini: the ParseBench provider for the providus_parse /predict server.

The provider renders each page, posts it to the server and keeps the markdown and the layout items of each page.
Set the server address with the PROVIDUS_PARSE_URL variable or the `server_url` setting.
"""

import base64
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from parse_bench.inference.providers.base import (
    Provider,
    ProviderConfigError,
    ProviderPermanentError,
    ProviderTransientError,
)
from parse_bench.inference.providers.registry import register_provider
from parse_bench.schemas.parse_output import PageIR, ParseLayoutPageIR, ParseOutput
from parse_bench.schemas.pipeline import PipelineSpec
from parse_bench.schemas.pipeline_io import InferenceRequest, InferenceResult, RawInferenceResult
from parse_bench.schemas.product import ProductType

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _page_images(path: Path, dpi: int) -> list[bytes]:
    """Return one PNG (or the image file itself) for each page of the source file."""
    if path.suffix.lower() in _IMAGE_SUFFIXES:
        return [path.read_bytes()]
    import pymupdf

    with pymupdf.open(str(path)) as doc:
        return [page.get_pixmap(dpi=dpi).tobytes("png") for page in doc]


def _page_record(number: int, answer: Any) -> dict[str, Any]:
    """Turn one /predict answer into a page record. An error answer gives a failed page."""
    if not isinstance(answer, dict):
        return {"page_number": number, "status": "error", "error": f"answer is not an object: {type(answer).__name__}"}
    if answer.get("status") != "success":
        return {"page_number": number, "status": "error", "error": str(answer.get("error") or "no error text")}
    items = answer.get("items")
    return {
        "page_number": number,
        "status": "success",
        "markdown": str(answer.get("markdown") or ""),
        "items": items if isinstance(items, list) else [],
        "image_width": answer.get("image_width"),
        "image_height": answer.get("image_height"),
    }


@register_provider("providus_vlm_mini")
class ProvidusVlmMiniProvider(Provider):
    """Parse provider for the providus_parse server (pipeline `providus_vlm_mini`)."""

    _transport: httpx.BaseTransport | None = None  # tests set a fake server here

    def _setting(self, request: InferenceRequest, key: str) -> Any:
        return {**self._base_config, **(request.config_override or {})}.get(key)

    def run_inference(self, pipeline: PipelineSpec, request: InferenceRequest) -> RawInferenceResult:
        if request.product_type != ProductType.PARSE:
            raise ProviderPermanentError("providus_vlm_mini supports only the parse product")
        url = (self._setting(request, "server_url") or os.environ.get("PROVIDUS_PARSE_URL") or "").rstrip("/")
        if not url:
            raise ProviderConfigError("Set PROVIDUS_PARSE_URL (or server_url) to the providus_parse server address")
        dpi = int(self._setting(request, "dpi") or 144)
        timeout = float(self._setting(request, "timeout") or 900)

        started = datetime.now()
        path = Path(request.source_file_path)
        try:
            images = _page_images(path, dpi)
        except Exception as exc:
            raise ProviderPermanentError(f"cannot render {path.name}: {exc}") from exc

        pages: list[dict[str, Any]] = []
        with httpx.Client(timeout=timeout, transport=self._transport) as client:
            for number, png in enumerate(images, start=1):
                body = {"image_base64": base64.b64encode(png).decode()}
                try:
                    response = client.post(f"{url}/predict", json=body)
                    response.raise_for_status()
                    answer = response.json()
                except (httpx.HTTPError, ValueError) as exc:  # a dead server or a bad body: the runner may retry
                    raise ProviderTransientError(f"/predict failed on page {number} of {path.name}: {exc}") from exc
                pages.append(_page_record(number, answer))

        completed = datetime.now()
        return RawInferenceResult(
            request=request,
            pipeline=pipeline,
            pipeline_name=pipeline.pipeline_name,
            product_type=request.product_type,
            raw_output={
                "server_url": url,
                "dpi": dpi,
                "pages": pages,
                "failed_pages": sum(1 for p in pages if p["status"] != "success"),
            },
            started_at=started,
            completed_at=completed,
            latency_in_ms=int((completed - started).total_seconds() * 1000),
        )

    def normalize(self, raw_result: RawInferenceResult) -> InferenceResult:
        pages = raw_result.raw_output.get("pages", [])
        page_markdown = [p.get("markdown", "").strip() for p in pages]
        output = ParseOutput(
            example_id=raw_result.request.example_id,
            pipeline_name=raw_result.pipeline_name,
            pages=[PageIR(page_index=i, markdown=md) for i, md in enumerate(page_markdown)],
            layout_pages=[
                ParseLayoutPageIR(
                    page_number=p["page_number"], width=p.get("image_width"), height=p.get("image_height"), md=md
                )
                for p, md in zip(pages, page_markdown, strict=True)
            ],
            markdown="\n\n".join(md for md in page_markdown if md),
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
