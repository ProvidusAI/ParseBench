"""docai provider: pipe tables are swapped for the API's own HTML tables, grounding boxes become
layout pages with canonical labels and page-furniture slots, HTTP statuses map onto the error
taxonomy, and the knowledge base is found by name before it is created."""

from __future__ import annotations

import pytest

from parse_bench.inference.providers.base import (
    ProviderConfigError,
    ProviderPermanentError,
    ProviderTransientError,
)
from parse_bench.inference.providers.parse.docai import (
    DocAIProvider,
    layout_pages_from_grounding,
    tables_to_html,
)

_GROUNDING = {
    "pages": [
        {
            "page_number": 1,
            "elements": [
                {"label": "header", "bbox": {"x1": 0.1, "y1": 0.02, "x2": 0.5, "y2": 0.05}, "content": "Annual report"},
                {
                    "label": "paragraph_title",
                    "bbox": {"x1": 0.1, "y1": 0.1, "x2": 0.9, "y2": 0.15},
                    "content": "Revenue",
                },
                {
                    "label": "table",
                    "bbox": {"x1": 0.1, "y1": 0.2, "x2": 0.9, "y2": 0.5},
                    "content": '<table border="1"><tr><td>Item</td><td colspan="2">Qty</td></tr></table>',
                },
                {"label": "number", "bbox": {"x1": 0.45, "y1": 0.95, "x2": 0.55, "y2": 0.98}, "content": "12"},
            ],
        }
    ]
}
_MARKDOWN = "## Revenue\n\n| Item | Qty |\n| --- | --- |\n| Bolt | 12 |\n"


def test_tables_to_html_swaps_pipe_table_for_grounding_html_with_th_header():
    out = tables_to_html(_MARKDOWN, _GROUNDING)
    assert '<tr><th>Item</th><th colspan="2">Qty</th></tr>' in out
    assert "| Bolt |" not in out


def test_tables_to_html_falls_back_to_pipe_rewrite_when_counts_differ():
    out = tables_to_html(_MARKDOWN, {"pages": []})
    assert "<table>" in out and "<th>Item</th>" in out and "<td>Bolt</td>" in out


def test_layout_pages_have_canonical_labels_and_furniture_slots():
    pages = layout_pages_from_grounding(_GROUNDING)
    assert len(pages) == 1
    assert [item.bbox.label for item in pages[0].items] == ["Page-header", "Section-header", "Table", "Page-footer"]
    assert pages[0].page_header_markdown == "Annual report"
    assert pages[0].printed_page_number == "12"
    seg = pages[0].items[2].bbox
    assert (seg.x, seg.y, seg.w, seg.h) == (0.1, 0.2, pytest.approx(0.8), pytest.approx(0.3))


def test_missing_key_is_a_config_error(monkeypatch):
    monkeypatch.delenv("DOCAI_API_KEY", raising=False)
    with pytest.raises(ProviderConfigError):
        DocAIProvider("docai", {})


class _Resp:
    def __init__(self, status, body=None, text=""):
        self.status_code, self._body, self.text = status, body, text

    def json(self):
        return self._body


def test_status_classification(monkeypatch):
    monkeypatch.setenv("DOCAI_API_KEY", "k")
    p = DocAIProvider("docai", {})
    assert p._check(_Resp(200, {}), "x").status_code == 200
    with pytest.raises(ProviderTransientError):
        p._check(_Resp(503, text="down"), "x")
    with pytest.raises(ProviderPermanentError):
        p._check(_Resp(409, text="busy"), "x")


def test_knowledge_base_is_found_by_name_before_creating(monkeypatch):
    monkeypatch.setenv("DOCAI_API_KEY", "k")
    p = DocAIProvider("docai", {})
    calls = []

    def fake_req(method, path, **kw):
        calls.append((method, path))
        if method == "GET":
            return _Resp(200, {"knowledge_bases": [{"id": "kb-1", "name": "parsebench"}]})  # any case
        raise AssertionError("must not create")

    monkeypatch.setattr(p, "_req", fake_req)
    assert p._knowledge_base() == "kb-1"
    assert p._knowledge_base() == "kb-1"  # cached: one GET in total
    assert calls == [("GET", "/v1/knowledge-bases")]
