"""Focused coverage for the HunyuanOCR-1.5 provider."""

from __future__ import annotations

import asyncio
import io
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import aiohttp
import pytest
from bs4 import BeautifulSoup
from PIL import Image

from parse_bench.evaluation.evaluators.layoutdet import LayoutDetectionEvaluator
from parse_bench.evaluation.layout_adapters.adapters import HunyuanOcrLayoutAdapter
from parse_bench.evaluation.layout_adapters.registry import create_layout_adapter_for_result
from parse_bench.evaluation.layout_label_mappers import project_layout_predictions
from parse_bench.inference.providers.base import (
    ProviderConfigError,
    ProviderPermanentError,
    ProviderRateLimitError,
    ProviderTransientError,
)
from parse_bench.inference.providers.parse.hunyuanocr import (
    CHART_PARSE_PROMPT,
    LAYOUT_PARSE_PROMPT,
    HunyuanOcrProvider,
)
from parse_bench.layout_projection import project_to_canonical_predictions
from parse_bench.schemas.layout_detection_output import LayoutDetectionModel
from parse_bench.schemas.layout_ontology import CanonicalLabel
from parse_bench.schemas.pipeline import PipelineSpec
from parse_bench.schemas.pipeline_io import InferenceRequest, RawInferenceResult
from parse_bench.schemas.product import ProductType


def _pipeline() -> PipelineSpec:
    return PipelineSpec(
        pipeline_name="hunyuanocr_1_5",
        provider_name="hunyuanocr",
        product_type=ProductType.PARSE,
        config={},
    )


def _raw_result(raw_output: dict) -> RawInferenceResult:
    now = datetime.now()
    request = InferenceRequest(
        example_id="hunyuan-doc",
        source_file_path="/tmp/hunyuan-doc.pdf",
        product_type=ProductType.PARSE,
    )
    return RawInferenceResult(
        request=request,
        pipeline=_pipeline(),
        pipeline_name="hunyuanocr_1_5",
        product_type=ProductType.PARSE,
        raw_output=raw_output,
        started_at=now,
        completed_at=now,
        latency_in_ms=1,
    )


class _Response:
    def __init__(
        self,
        status: int,
        payload: Any = None,
        *,
        json_error: Exception | None = None,
    ) -> None:
        self.status = status
        self._payload = payload
        self._json_error = json_error

    async def __aenter__(self) -> _Response:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def text(self) -> str:
        return "request failed"

    async def json(self) -> Any:
        if self._json_error:
            raise self._json_error
        return self._payload


class _Session:
    def __init__(self, response: _Response | None = None, error: Exception | None = None) -> None:
        self._response = response
        self._error = error

    def post(self, *_args: object, **_kwargs: object) -> _Response:
        if self._error:
            raise self._error
        assert self._response is not None
        return self._response


def test_hunyuanocr_endpoint_comes_from_public_env_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HUNYUANOCR_SERVER_URL", raising=False)
    with pytest.raises(ProviderConfigError, match="HUNYUANOCR_SERVER_URL"):
        HunyuanOcrProvider("hunyuanocr", {})

    monkeypatch.setenv("HUNYUANOCR_SERVER_URL", "https://example.invalid")
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": ""})
    assert provider._server_url == "https://example.invalid"


def test_hunyuanocr_recovers_items_with_unescaped_html_quotes() -> None:
    response = (
        '[{"layout_type":"table","bbox":"(10,20),(110,20),(110,80),(10,80)",'
        '"text":"<table><tr><td colspan="2">A</td></tr></table>"},'
        '{"layout_type":"paragraph","bbox":"(20,100),(400,100),(400,160),(20,160)",'
        '"text":"Body\\ntext"}]'
    )

    items = HunyuanOcrProvider._parse_layout_items(response)

    assert items == [
        {
            "label": "table",
            "bbox": [10.0, 20.0, 110.0, 80.0],
            "text": '<table><tr><td colspan="2">A</td></tr></table>',
        },
        {
            "label": "paragraph",
            "bbox": [20.0, 100.0, 400.0, 160.0],
            "text": "Body\ntext",
        },
    ]


def test_hunyuanocr_salvages_unterminated_final_table_and_repairs_markup() -> None:
    response = (
        '[{"layout_type":"paragraph","bbox":"(20,20),(900,20),(900,80),(20,80)",'
        '"text":"Quarterly results"},'
        '{"layout_type":"table","bbox":"(20,100),(980,100),(980,920),(20,920)",'
        '"text":"<table><tr><th>Quarter</th><th>Revenue</th></tr>'
        "<tr><td>Q4</td><td>120"
    )

    items = HunyuanOcrProvider._parse_layout_items(response)

    assert len(items) == 2
    assert items[-1] == {
        "label": "table",
        "bbox": [20.0, 100.0, 980.0, 920.0],
        "text": "<table><tr><th>Quarter</th><th>Revenue</th></tr><tr><td>Q4</td><td>120",
    }

    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": items,
                "image_width": 1000,
                "image_height": 1000,
                "_config": {"served_model_name": "tencent/HunyuanOCR"},
            }
        )
    )

    assert "Quarterly results" in normalized.output.markdown
    assert "<table>" in normalized.output.markdown
    assert "Q4" in normalized.output.markdown
    assert "120</td></tr></table>" in normalized.output.markdown
    assert len(normalized.output.layout_pages[0].items) == 2


def test_hunyuanocr_repairs_truncated_table_before_later_items() -> None:
    response = json.dumps(
        [
            {
                "layout_type": "table",
                "bbox": "(20,20),(980,20),(980,300),(20,300)",
                "text": "<table><tbody><tr><td>First table",
            },
            {
                "layout_type": "footer",
                "bbox": "(450,920),(550,920),(550,970),(450,970)",
                "text": "7",
            },
            {
                "layout_type": "paragraph",
                "bbox": "(20,330),(980,330),(980,450),(20,450)",
                "text": "Following paragraph",
            },
            {
                "layout_type": "table",
                "bbox": "(20,500),(980,500),(980,800),(20,800)",
                "text": "<table><tr><td>Second table</td></tr></table>",
            },
        ]
    )
    items = HunyuanOcrProvider._parse_layout_items(response)
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": items,
                "image_width": 1000,
                "image_height": 1000,
            }
        )
    )

    markdown = normalized.output.markdown
    assert markdown.index("</table>") < markdown.index("7")
    assert markdown.index("7") < markdown.index("Following paragraph")
    assert markdown.index("Following paragraph") < markdown.rindex("<table>")
    assert markdown.count("<table>") == markdown.count("</table>") == 2

    parsed = BeautifulSoup(markdown, "html.parser")
    tables = parsed.find_all("table")
    assert len(tables) == 2
    assert tables[0].find("table") is None
    assert tables[0].get_text(" ", strip=True) == "First table"
    assert tables[1].get_text(" ", strip=True) == "Second table"
    assert "7" not in tables[0].get_text(" ", strip=True)
    assert "Following paragraph" not in tables[0].get_text(" ", strip=True)
    assert parsed.get_text(" ", strip=True).split() == [
        "First",
        "table",
        "7",
        "Following",
        "paragraph",
        "Second",
        "table",
    ]

    layout_items = normalized.output.layout_pages[0].items
    assert layout_items[0].value.endswith("</td></tr></tbody></table>")
    assert [item.layout_segments[0].label for item in layout_items] == [
        "Table",
        "Page-footer",
        "Text",
        "Table",
    ]


def test_hunyuanocr_maps_algorithm_chart_and_chart_title() -> None:
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": [
                    {
                        "label": "algorithm_chart",
                        "bbox": [100, 100, 900, 700],
                        "text": "for item in items:\n    process(item)",
                    },
                    {
                        "label": "chart_title",
                        "bbox": [100, 20, 900, 80],
                        "text": "Processing algorithm",
                    },
                ],
                "image_width": 1000,
                "image_height": 1000,
            }
        )
    )

    assert normalized.output.markdown == ("```\nfor item in items:\n    process(item)\n```\n\nProcessing algorithm")
    assert [item.layout_segments[0].label for item in normalized.output.layout_pages[0].items] == ["Code", "Caption"]


@pytest.mark.parametrize(
    "bbox",
    [
        "(10,20),(110,20),(110,80),(10,80)",
        '(10,20),(110,20),(110,80),(10,80"',
        "[[10,20],[110,20],[110,80],[10,80]]",
        [[10, 20], [110, 20], [110, 80], [10, 80]],
        [10, 20, 110, 80],
    ],
    ids=["parenthesized-string", "truncated-final-paren", "bracket-string", "point-list", "flat-list"],
)
def test_hunyuanocr_normalizes_supported_bbox_encodings(bbox: Any) -> None:
    response = json.dumps(
        [
            {
                "layout_type": "paragraph",
                "bbox": bbox,
                "text": "Bounded text",
            }
        ]
    )
    items = HunyuanOcrProvider._parse_layout_items(response)
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": items,
                "image_width": 1000,
                "image_height": 1000,
            }
        )
    )

    segment = normalized.output.layout_pages[0].items[0].layout_segments[0]
    assert [segment.x, segment.y, segment.w, segment.h] == pytest.approx([0.01, 0.02, 0.1, 0.06])
    layout = HunyuanOcrLayoutAdapter().to_layout_output(normalized)
    assert layout.predictions[0].bbox == pytest.approx([10.0, 20.0, 110.0, 80.0])


@pytest.mark.parametrize(
    "bbox",
    [
        "[[10,20],[110,20],[110,80]]",
        '[[10,20],[110,20],[110,80],["bad",80]]',
        [[10, 20], [110, 20], [110, 80]],
        [10, 20, 110],
        [True, 20, 110, 80],
        "(10,20),(110,20),(110,80),(10,80) trailing",
        '(10,20),(110,20),(110,80),(10,80" trailing',
        '(10,20),(110,20),(110,80),(10,80",(1,1)',
    ],
    ids=[
        "bracket-string-three-points",
        "bracket-string-nonnumeric",
        "point-list-three-points",
        "flat-list-three-values",
        "flat-list-boolean",
        "parenthesized-string-junk",
        "truncated-final-paren-junk",
        "truncated-final-paren-fifth-point",
    ],
)
def test_hunyuanocr_rejects_malformed_bbox_encodings_during_layout_conversion(
    bbox: Any,
) -> None:
    response = json.dumps(
        [
            {
                "layout_type": "paragraph",
                "bbox": bbox,
                "text": "Must not gain a malformed box",
            }
        ]
    )
    items = HunyuanOcrProvider._parse_layout_items(response)
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": items,
                "image_width": 1000,
                "image_height": 1000,
            }
        )
    )

    assert items == []
    assert normalized.output.layout_pages == []
    with pytest.raises(ValueError, match="non-empty layout_pages"):
        HunyuanOcrLayoutAdapter().to_layout_output(normalized)


def test_hunyuanocr_maps_catalogue_to_canonical_document_index() -> None:
    response = json.dumps(
        [
            {
                "layout_type": "catalogue",
                "bbox": "[[10,20],[110,20],[110,80],[10,80]]",
                "text": "Contents",
            }
        ]
    )
    items = HunyuanOcrProvider._parse_layout_items(response)
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": items,
                "image_width": 1000,
                "image_height": 1000,
            }
        )
    )

    segment = normalized.output.layout_pages[0].items[0].layout_segments[0]
    assert segment.label == "Document Index"
    layout = HunyuanOcrLayoutAdapter().to_layout_output(normalized)
    assert layout.predictions[0].label == "Document Index"


def test_hunyuanocr_hy_meta_quad_poly_reaches_canonical_evaluator_path() -> None:
    page_one_raw = (
        "Annual Report"
        "<hy-meta><layout>title</layout>"
        "<quad>(50,20),(950,20),(950,90),(50,90)</quad></hy-meta>"
        "\nBody <em>with markup</em>"
        "<hy-meta><layout>paragraph_span</layout>"
        "<poly>[[50,120],[950,120],[950,280],[50,280]]</poly></hy-meta>"
        "\n<table><tr><td>A</td></tr></table>"
        "<hy-meta><layout>table</layout>"
        "<quad>(50,320),(950,320),(950,700),(50,700)</quad></hy-meta>"
    )
    page_two_raw = (
        "Contents"
        "<hy-meta><layout>table_of_contents</layout>"
        "<poly>(80,40),(920,40),(920,160),(80,160)</poly></hy-meta>"
        "\n# Closing notes"
        "<hy-meta><layout>heading</layout>"
        "<quad>[[80,220],[920,220],[920,300],[80,300]]"
    )

    page_one_items = HunyuanOcrProvider._parse_layout_items(page_one_raw)
    page_two_items = HunyuanOcrProvider._parse_layout_items(page_two_raw)

    assert page_one_items == [
        {"label": "title", "bbox": [50.0, 20.0, 950.0, 90.0], "text": "Annual Report"},
        {
            "label": "paragraph_span",
            "bbox": [50.0, 120.0, 950.0, 280.0],
            "text": "Body <em>with markup</em>",
        },
        {
            "label": "table",
            "bbox": [50.0, 320.0, 950.0, 700.0],
            "text": "<table><tr><td>A</td></tr></table>",
        },
    ]
    assert page_two_items == [
        {
            "label": "table_of_contents",
            "bbox": [80.0, 40.0, 920.0, 160.0],
            "text": "Contents",
        },
        {
            "label": "heading",
            "bbox": [80.0, 220.0, 920.0, 300.0],
            "text": "# Closing notes",
        },
    ]

    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    page_results = [
        {
            "layout_parse_raw": page_one_raw,
            "layout_items": page_one_items,
            "image_width": 1200,
            "image_height": 1800,
        },
        {
            "layout_parse_raw": page_two_raw,
            "layout_items": page_two_items,
            "image_width": 1800,
            "image_height": 900,
        },
    ]
    normalized = provider.normalize(
        _raw_result(
            {
                **page_results[0],
                "page_results": page_results,
                "_config": {"served_model_name": "tencent/HunyuanOCR"},
            }
        )
    )

    assert normalized.output.markdown == (
        "# Annual Report\n\nBody <em>with markup</em>\n\n"
        "<table><tr><td>A</td></tr></table>\n\nContents\n\n## Closing notes"
    )
    adapter = create_layout_adapter_for_result(normalized)
    layout = adapter.to_layout_output(normalized)
    assert [prediction.label for prediction in layout.predictions] == [
        "Title",
        "Text",
        "Table",
        "Document Index",
        "Section-header",
    ]
    assert [prediction.page for prediction in layout.predictions] == [1, 1, 1, 2, 2]
    assert [prediction.bbox for prediction in layout.predictions] == [
        pytest.approx([50.0, 20.0, 950.0, 90.0]),
        pytest.approx([50.0, 120.0, 950.0, 280.0]),
        pytest.approx([50.0, 320.0, 950.0, 700.0]),
        pytest.approx([80.0, 40.0, 920.0, 160.0]),
        pytest.approx([80.0, 220.0, 920.0, 300.0]),
    ]

    canonical = project_to_canonical_predictions(layout)
    assert [prediction.canonical_class for prediction in canonical] == [
        CanonicalLabel.TITLE,
        CanonicalLabel.TEXT,
        CanonicalLabel.TABLE,
        CanonicalLabel.DOCUMENT_INDEX,
        CanonicalLabel.SECTION_HEADER,
    ]
    evaluator = LayoutDetectionEvaluator(evaluation_view="canonical", default_ontology="canonical")
    projected = evaluator._extract_predictions(
        normalized,
        layout,
        target_ontology="canonical",
    )
    assert [prediction["class_name"] for prediction in projected] == [
        "Title",
        "Text",
        "Table",
        "Document Index",
        "Section-header",
    ]
    assert [prediction["page"] for prediction in projected] == [1, 1, 1, 2, 2]


@pytest.mark.parametrize(
    ("alias", "canonical_label"),
    [
        ("paragraph", "Text"),
        ("paragraph_span", "Text"),
        ("paragraphspan", "Text"),
        ("para", "Text"),
        ("para_title", "Section-header"),
        ("paratitle", "Section-header"),
        ("section_title", "Section-header"),
        ("sectiontitle", "Section-header"),
        ("heading", "Section-header"),
        ("title", "Title"),
        ("table_of_contents", "Document Index"),
        ("tableofcontents", "Document Index"),
        ("table-of-figures", "Document Index"),
        ("catalogue", "Document Index"),
        ("catalog", "Document Index"),
        ("catalogue_title", "Document Index"),
        ("table_title", "Caption"),
        ("tabletitle", "Caption"),
        ("figure_title", "Caption"),
        ("figuretitle", "Caption"),
        ("chart_title", "Caption"),
        ("charttitle", "Caption"),
        ("caption", "Caption"),
        ("table", "Table"),
        ("figure", "Picture"),
        ("chart", "Picture"),
        ("header", "Page-header"),
        ("page_header", "Page-header"),
        ("footer", "Page-footer"),
        ("page_footer", "Page-footer"),
    ],
)
def test_hunyuanocr_official_layout_aliases_reach_markdown_and_layout(
    alias: str,
    canonical_label: str,
) -> None:
    text = "# Heading" if canonical_label in {"Title", "Section-header"} else "Content"
    response = json.dumps(
        [
            {
                "layout_type": alias,
                "bbox": "(10,20),(110,20),(110,80),(10,80)",
                "text": text,
            }
        ]
    )
    items = HunyuanOcrProvider._parse_layout_items(response)
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": items,
                "image_width": 1000,
                "image_height": 1000,
            }
        )
    )

    expected_markdown = {
        "Title": "# Heading",
        "Section-header": "## Heading",
    }.get(canonical_label, "Content")
    assert normalized.output.markdown == expected_markdown
    assert normalized.output.layout_pages[0].items[0].layout_segments[0].label == canonical_label
    layout = HunyuanOcrLayoutAdapter().to_layout_output(normalized)
    assert layout.predictions[0].label == canonical_label


def test_hunyuanocr_mixed_page_sizes_project_canonical_labels_in_common_frame() -> None:
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    page_results = [
        {
            "layout_items": [
                {
                    "label": "paragraph",
                    "bbox": [100, 100, 400, 300],
                    "text": "Page one text",
                },
                {
                    "label": "table",
                    "bbox": [200, 500, 900, 900],
                    "text": "<table><tr><td>A</td></tr></table>",
                },
            ],
            "image_width": 1000,
            "image_height": 2000,
        },
        {
            "layout_items": [
                {
                    "label": "algorithm_chart",
                    "bbox": [250, 100, 750, 700],
                    "text": "process(items)",
                },
                {
                    "label": "catalogue",
                    "bbox": [100, 750, 900, 900],
                    "text": "Contents",
                },
            ],
            "image_width": 2000,
            "image_height": 1000,
        },
    ]
    normalized = provider.normalize(
        _raw_result(
            {
                **page_results[0],
                "page_results": page_results,
                "_config": {"served_model_name": "tencent/HunyuanOCR"},
            }
        )
    )

    assert [(page.width, page.height) for page in normalized.output.layout_pages] == [
        (1000.0, 2000.0),
        (2000.0, 1000.0),
    ]
    adapter = create_layout_adapter_for_result(normalized)
    assert isinstance(adapter, HunyuanOcrLayoutAdapter)
    layout = adapter.to_layout_output(normalized)
    assert layout.model is LayoutDetectionModel.HUNYUANOCR_LAYOUT
    assert (layout.image_width, layout.image_height) == (1000, 1000)
    assert [prediction.label for prediction in layout.predictions] == [
        "Text",
        "Table",
        "Code",
        "Document Index",
    ]
    assert [prediction.bbox for prediction in layout.predictions] == [
        pytest.approx([100.0, 100.0, 400.0, 300.0]),
        pytest.approx([200.0, 500.0, 900.0, 900.0]),
        pytest.approx([250.0, 100.0, 750.0, 700.0]),
        pytest.approx([100.0, 750.0, 900.0, 900.0]),
    ]

    canonical = project_to_canonical_predictions(layout)
    assert [prediction.canonical_class for prediction in canonical] == [
        CanonicalLabel.TEXT,
        CanonicalLabel.TABLE,
        CanonicalLabel.CODE,
        CanonicalLabel.DOCUMENT_INDEX,
    ]

    projected = project_layout_predictions(
        normalized,
        layout,
        evaluation_view="canonical",
        target_ontology="canonical",
    )
    assert [prediction["class_name"] for prediction in projected] == [
        "Text",
        "Table",
        "Code",
        "Document Index",
    ]
    assert [prediction["bbox"] for prediction in projected] == [
        pytest.approx([0.1, 0.1, 0.4, 0.3]),
        pytest.approx([0.2, 0.5, 0.9, 0.9]),
        pytest.approx([0.25, 0.1, 0.75, 0.7]),
        pytest.approx([0.1, 0.75, 0.9, 0.9]),
    ]
    assert [prediction["page"] for prediction in projected] == [1, 1, 2, 2]

    evaluator = LayoutDetectionEvaluator(evaluation_view="canonical", default_ontology="canonical")
    evaluator_predictions = evaluator._extract_predictions(
        normalized,
        layout,
        target_ontology="canonical",
    )
    assert evaluator_predictions == projected

    page_two_layout = adapter.to_layout_output(normalized, page_filter=2)
    assert (page_two_layout.image_width, page_two_layout.image_height) == (1000, 1000)
    assert [prediction.page for prediction in page_two_layout.predictions] == [2, 2]
    assert [prediction.bbox for prediction in page_two_layout.predictions] == [
        pytest.approx([250.0, 100.0, 750.0, 700.0]),
        pytest.approx([100.0, 750.0, 900.0, 900.0]),
    ]
    page_two_predictions = evaluator._extract_predictions(
        normalized,
        page_two_layout,
        target_ontology="canonical",
        page_filter=2,
    )
    assert [prediction["class_name"] for prediction in page_two_predictions] == [
        "Code",
        "Document Index",
    ]
    assert [prediction["bbox"] for prediction in page_two_predictions] == [
        pytest.approx([0.25, 0.1, 0.75, 0.7]),
        pytest.approx([0.1, 0.75, 0.9, 0.9]),
    ]


def test_hunyuanocr_rereads_empty_figures_with_chart_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    prompts: list[str] = []

    async def fake_call_api(_session: object, _image_b64: str, prompt: str) -> str:
        prompts.append(prompt)
        if prompt == LAYOUT_PARSE_PROMPT:
            return '[{"layout_type":"figure","bbox":"(100,100),(900,100),(900,900),(100,900)","text":""}]'
        return "| Label | Value |\n| --- | --- |\n| A | 10 |"

    monkeypatch.setattr(provider, "_call_api", fake_call_api)
    page = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(page, format="PNG")

    result = asyncio.run(provider._run_page_async(object(), page.getvalue()))  # type: ignore[arg-type]

    assert prompts == [LAYOUT_PARSE_PROMPT, CHART_PARSE_PROMPT]
    assert result["figures_read"] == 1
    assert result["layout_items"][0]["text"].startswith("| Label |")


def test_hunyuanocr_keeps_content_when_finish_reason_is_length() -> None:
    content = (
        '[{"layout_type":"table","bbox":"(0,0),(1000,0),(1000,1000),(0,1000)","text":"<table><tr><td>useful partial row'
    )
    response = _Response(
        200,
        {
            "choices": [
                {
                    "message": {"content": content},
                    "finish_reason": "length",
                }
            ]
        },
    )
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})

    result = asyncio.run(
        provider._call_api(_Session(response), "image", LAYOUT_PARSE_PROMPT)  # type: ignore[arg-type]
    )

    assert result == content
    assert HunyuanOcrProvider._parse_layout_items(result)[0]["text"].endswith("useful partial row")


@pytest.mark.parametrize(
    ("status", "error_type"),
    [
        (400, ProviderPermanentError),
        (408, ProviderTransientError),
        (429, ProviderRateLimitError),
        (500, ProviderTransientError),
        (599, ProviderTransientError),
    ],
)
def test_hunyuanocr_classifies_http_statuses(status: int, error_type: type[Exception]) -> None:
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})

    with pytest.raises(error_type):
        asyncio.run(
            provider._call_api(  # type: ignore[arg-type]
                _Session(_Response(status)),
                "image",
                LAYOUT_PARSE_PROMPT,
            )
        )


@pytest.mark.parametrize(
    "error",
    [
        TimeoutError("timed out"),
        aiohttp.ClientConnectionError("connection reset"),
    ],
)
def test_hunyuanocr_classifies_transport_failures_as_transient(error: Exception) -> None:
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})

    with pytest.raises(ProviderTransientError) as caught:
        asyncio.run(
            provider._call_api(  # type: ignore[arg-type]
                _Session(error=error),
                "image",
                LAYOUT_PARSE_PROMPT,
            )
        )

    assert caught.value.__cause__ is error


def test_hunyuanocr_classifies_invalid_json_as_transient() -> None:
    error = json.JSONDecodeError("bad json", "not json", 0)
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})

    with pytest.raises(ProviderTransientError) as caught:
        asyncio.run(
            provider._call_api(  # type: ignore[arg-type]
                _Session(_Response(200, json_error=error)),
                "image",
                LAYOUT_PARSE_PROMPT,
            )
        )

    assert caught.value.__cause__ is error


@pytest.mark.parametrize(
    ("kind", "expected_type"),
    [
        ("permanent", ProviderPermanentError),
        ("rate_limit", ProviderRateLimitError),
        ("transient", ProviderTransientError),
        ("timeout", ProviderTransientError),
        ("transport", ProviderTransientError),
        ("invalid_json", ProviderTransientError),
    ],
)
def test_hunyuanocr_run_inference_propagates_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    kind: str,
    expected_type: type[Exception],
) -> None:
    errors: dict[str, Exception] = {
        "permanent": ProviderPermanentError("bad request"),
        "rate_limit": ProviderRateLimitError("slow down"),
        "transient": ProviderTransientError("retry"),
        "timeout": TimeoutError("timed out"),
        "transport": aiohttp.ClientConnectionError("connection reset"),
        "invalid_json": json.JSONDecodeError("bad json", "not json", 0),
    }
    error = errors[kind]
    provider = HunyuanOcrProvider("hunyuanocr", {"server_url": "https://example.invalid"})
    source = tmp_path / "page.png"
    source.write_bytes(b"image")

    async def fail(_pages: list[bytes]) -> dict[str, Any]:
        raise error

    monkeypatch.setattr(provider, "_run_inference_pages_async", fail)
    request = InferenceRequest(
        example_id="failure",
        source_file_path=str(source),
        product_type=ProductType.PARSE,
    )

    with pytest.raises(expected_type) as caught:
        provider.run_inference(_pipeline(), request)

    if isinstance(error, (ProviderPermanentError, ProviderRateLimitError, ProviderTransientError)):
        assert caught.value is error
    else:
        assert caught.value.__cause__ is error


def test_hunyuanocr_normalizes_layout_and_selects_its_adapter() -> None:
    provider = HunyuanOcrProvider(
        "hunyuanocr",
        {"server_url": "https://example.invalid", "figure_pass": False},
    )
    normalized = provider.normalize(
        _raw_result(
            {
                "layout_items": [
                    {
                        "label": "paragraph",
                        "bbox": [100, 200, 500, 300],
                        "text": "Body text",
                    },
                    {
                        "label": "table",
                        "bbox": [100, 400, 900, 800],
                        "text": "<table><tr><td colspan=2>A</td></tr></table>",
                    },
                ],
                "image_width": 1200,
                "image_height": 1600,
                "_config": {
                    "server_url": "https://example.invalid",
                    "served_model_name": "tencent/HunyuanOCR",
                },
            }
        )
    )

    assert normalized.output.markdown == ('Body text\n\n<table><tr><td colspan="2">A</td></tr></table>')
    assert len(normalized.output.layout_pages) == 1
    adapter = create_layout_adapter_for_result(normalized)
    assert isinstance(adapter, HunyuanOcrLayoutAdapter)
    layout = adapter.to_layout_output(normalized)
    assert layout.model is LayoutDetectionModel.HUNYUANOCR_LAYOUT
    assert [prediction.bbox for prediction in layout.predictions] == [
        pytest.approx([100.0, 200.0, 500.0, 300.0]),
        pytest.approx([100.0, 400.0, 900.0, 800.0]),
    ]
