from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from parse_bench.inference.providers.base import ProviderConfigError, ProviderTransientError
from parse_bench.inference.providers.parse._layout_utils import (
    close_open_ended_bands,
    extract_layout_blocks_lenient,
    parse_layout_blocks,
)
from parse_bench.inference.providers.parse.amazon_nova import AmazonNovaProvider


class _FakeBedrockClient:
    """Captures the Converse kwargs and replays a canned response."""

    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.response


def _provider(**attrs: Any) -> AmazonNovaProvider:
    provider = object.__new__(AmazonNovaProvider)
    defaults: dict[str, Any] = {
        "_model": "us.amazon.nova-2-lite-v1:0",
        "_region": "us-east-1",
        "_dpi": 150,
        "_max_tokens": 32768,
        "_timeout": 300,
        "_reasoning_effort": None,
        "_temperature": 0,
        "_top_p": None,
    }
    defaults.update(attrs)
    for key, value in defaults.items():
        setattr(provider, key, value)
    return provider


def test_geo_profile_is_priced_at_the_regional_rate() -> None:
    assert _provider(_model="us.amazon.nova-2-lite-v1:0")._get_pricing() == (0.33, 2.75)
    assert _provider(_model="amazon.nova-2-lite-v1:0")._get_pricing() == (0.33, 2.75)


def test_global_profile_is_priced_at_the_cross_region_global_rate() -> None:
    assert _provider(_model="global.amazon.nova-2-lite-v1:0")._get_pricing() == (0.30, 2.50)


def test_unknown_model_falls_back_to_zero_pricing() -> None:
    assert _provider(_model="us.amazon.nova-9-mystery-v1:0")._get_pricing() == (0.0, 0.0)


def test_converse_sends_temperature_and_no_reasoning_by_default() -> None:
    provider = _provider()
    provider._client = _FakeBedrockClient(
        {
            "output": {"message": {"content": [{"text": "hello"}]}},
            "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
            "stopReason": "end_turn",
        }
    )

    text, usage, stop_reason = provider._converse(Image.new("RGB", (64, 64), "white"), "system", "user")

    (call,) = provider._client.calls
    assert call["modelId"] == "us.amazon.nova-2-lite-v1:0"
    assert call["inferenceConfig"] == {"maxTokens": 32768, "temperature": 0}
    assert "additionalModelRequestFields" not in call
    assert call["messages"][0]["content"][0]["image"]["format"] == "jpeg"
    assert isinstance(call["messages"][0]["content"][0]["image"]["source"]["bytes"], bytes)
    assert text == "hello"
    assert usage == {"input_tokens": 10, "output_tokens": 5, "thinking_tokens": 0, "total_tokens": 15}
    assert stop_reason == "end_turn"


def test_converse_enables_reasoning_without_sampling_params() -> None:
    provider = _provider(_reasoning_effort="high", _temperature=None)
    provider._client = _FakeBedrockClient(
        {
            "output": {"message": {"content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
        }
    )

    provider._converse(Image.new("RGB", (64, 64), "white"), "system", "user")

    (call,) = provider._client.calls
    assert call["inferenceConfig"] == {"maxTokens": 32768}
    assert call["additionalModelRequestFields"] == {
        "reasoningConfig": {"type": "enabled", "maxReasoningEffort": "high"}
    }


def test_redacted_reasoning_blocks_are_not_part_of_the_parsed_text() -> None:
    response = {
        "output": {
            "message": {
                "content": [
                    {"reasoningContent": {"reasoningText": {"text": "[REDACTED]"}}},
                    {"text": "# Heading"},
                ]
            }
        },
        "usage": {"inputTokens": 3, "outputTokens": 4, "totalTokens": 7},
    }

    assert AmazonNovaProvider._extract_text(response) == "# Heading"


def test_reasoning_effort_rejects_sampling_params(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")

    with pytest.raises(ProviderConfigError, match="rejects temperature/top_p"):
        AmazonNovaProvider("amazon_nova", {"reasoning_effort": "low", "temperature": 0.5})


def test_invalid_reasoning_effort_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")

    with pytest.raises(ProviderConfigError, match="Invalid reasoning_effort"):
        AmazonNovaProvider("amazon_nova", {"reasoning_effort": "maximum"})


def test_content_filtered_response_never_becomes_page_content() -> None:
    """Bedrock returns HTTP 200 with a canned filter notice; it is not document text."""
    provider = _provider()
    provider._client = _FakeBedrockClient(
        {
            "output": {
                "message": {"content": [{"text": " - The generated text has been blocked by our content filters."}]}
            },
            "usage": {"inputTokens": 673, "outputTokens": 0, "totalTokens": 673},
            "stopReason": "content_filtered",
        }
    )

    with pytest.raises(ProviderTransientError, match="content filter"):
        provider._converse(Image.new("RGB", (64, 64), "white"), "system", "user")


def test_empty_response_is_rejected_rather_than_parsed_as_a_blank_page() -> None:
    provider = _provider()
    provider._client = _FakeBedrockClient(
        {
            "output": {"message": {"content": [{"text": "   "}]}},
            "usage": {"inputTokens": 5, "outputTokens": 0, "totalTokens": 5},
            "stopReason": "end_turn",
        }
    )

    with pytest.raises(ProviderTransientError, match="no text"):
        provider._converse(Image.new("RGB", (64, 64), "white"), "system", "user")


NESTED_LAYOUT = (
    '<div data-bbox="[0,0,1000,146]" data-label="Text">\n'
    '<div data-bbox="[10,20,300,60]" data-label="Title">Chapter 4</div>\n'
    '<div data-bbox="[10,80,900,140]" data-label="Text">SURVEY</div>\n'
    "</div>"
)


def test_nested_divs_lose_the_child_box_and_leak_markup_under_the_strict_parser() -> None:
    """Documents the failure mode the lenient reader exists to fix."""
    blocks = parse_layout_blocks(NESTED_LAYOUT)

    assert blocks[0]["label"] == "Text"
    assert "<div" in blocks[0]["text"]


def test_lenient_reader_recovers_leaf_boxes_from_nova_nested_divs() -> None:
    blocks = extract_layout_blocks_lenient(NESTED_LAYOUT)

    assert [(b["label"], b["bbox"], b["text"]) for b in blocks] == [
        ("Title", [10, 20, 300, 60], "Chapter 4"),
        ("Text", [10, 80, 900, 140], "SURVEY"),
    ]


def test_lenient_reader_matches_the_strict_parser_on_compliant_output() -> None:
    compliant = (
        '<div data-bbox="[1,2,3,4]" data-label="Text">hi</div>\n'
        '<div data-bbox="[5,6,7,8]" data-label="Title">there</div>'
    )

    assert extract_layout_blocks_lenient(compliant) == parse_layout_blocks(compliant)
    assert extract_layout_blocks_lenient("no wrappers here") == []


SEMANTIC_TAG_LAYOUT = (
    '<TABLE data-bbox="[0, 301, 1000, 456]" data-label="Table">\n'
    "<table><tr><td>7</td></tr></table>\n"
    "</TABLE>\n"
    '<p data-bbox="[0, 456, 1000, 480]" data-label="Text">Caption line</p>'
)


def test_semantic_tag_wrappers_are_scored_instead_of_dropped() -> None:
    """Nova wraps elements in <TABLE>/<p> rather than <div>; same bbox, same label."""
    blocks = extract_layout_blocks_lenient(SEMANTIC_TAG_LAYOUT)

    assert [(b["label"], b["bbox"]) for b in blocks] == [
        ("Table", [0, 301, 1000, 456]),
        ("Text", [0, 456, 1000, 480]),
    ]
    # The inner real <table> survives so GriTS sees a table, not a wrapper.
    assert blocks[0]["text"] == "<table><tr><td>7</td></tr></table>"


def test_plain_inner_tags_without_a_bbox_are_never_treated_as_wrappers() -> None:
    content = '<div data-bbox="[1,2,3,4]" data-label="Table"><table><tr><td>a</td></tr></table></div>'

    assert extract_layout_blocks_lenient(content) == [
        {"bbox": [1, 2, 3, 4], "label": "Table", "text": "<table><tr><td>a</td></tr></table>"}
    ]


UNCLOSED_WRAPPERS = (
    '<div data-bbox="[0, 0, 1000, 1000]" data-label="Text">\n'
    "lead paragraph\n"
    '<TABLE data-bbox="[0, 301, 1000, 456]" data-label="Table">\n'
    "<table><tr><td>7</td></tr></table>\n"
    '<p data-bbox="[0, 456, 1000, 480]" data-label="Text">caption</p>\n'
    "</div>"
)


def test_unclosed_wrappers_end_at_the_next_element_and_lose_nothing() -> None:
    """Nova opens <TABLE data-bbox=...> and never closes it."""
    blocks = extract_layout_blocks_lenient(UNCLOSED_WRAPPERS)

    assert [(b["label"], b["bbox"]) for b in blocks] == [
        ("Text", [0, 0, 1000, 1000]),
        ("Table", [0, 301, 1000, 456]),
        ("Text", [0, 456, 1000, 480]),
    ]
    assert blocks[0]["text"] == "lead paragraph"
    assert blocks[1]["text"] == "<table><tr><td>7</td></tr></table>"
    assert blocks[2]["text"] == "caption"


def test_whitespace_only_container_wrappers_are_skipped() -> None:
    content = (
        '<div data-bbox="[0,0,1000,1000]" data-label="Text">\n'
        '<div data-bbox="[1,2,3,4]" data-label="Title">real</div>\n'
        "</div>"
    )

    assert [b["label"] for b in extract_layout_blocks_lenient(content)] == ["Title"]


def test_open_ended_bands_end_where_the_next_element_starts() -> None:
    """Nova pins y2 to the page bottom; its own filled-in boxes are contiguous bands."""
    items = [
        {"bbox": [0, 0, 1000, 1000], "label": "Title", "text": "a"},
        {"bbox": [0, 87, 1000, 1000], "label": "Text", "text": "b"},
        {"bbox": [0, 208, 1000, 1000], "label": "Section-header", "text": "c"},
    ]

    assert [i["bbox"] for i in close_open_ended_bands(items)] == [
        [0, 0, 1000, 87],
        [0, 87, 1000, 208],
        [0, 208, 1000, 1000],
    ]


def test_boxes_with_a_real_bottom_edge_are_left_alone() -> None:
    items = [
        {"bbox": [0, 301, 1000, 456], "label": "Table", "text": "t"},
        {"bbox": [0, 456, 1000, 480], "label": "Text", "text": "u"},
    ]

    assert [i["bbox"] for i in close_open_ended_bands(items)] == [
        [0, 301, 1000, 456],
        [0, 456, 1000, 480],
    ]


def test_elements_sharing_one_top_edge_are_not_given_invented_extents() -> None:
    """Fully degenerate output stays degenerate rather than being fabricated into bands."""
    items = [{"bbox": [0, 0, 1000, 1000], "label": "Text", "text": str(n)} for n in range(4)]

    assert [i["bbox"] for i in close_open_ended_bands(items)] == [[0, 0, 1000, 1000]] * 4
