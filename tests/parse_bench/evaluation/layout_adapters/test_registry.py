from __future__ import annotations

from datetime import datetime

from parse_bench.evaluation.layout_adapters import registry as registry_module
from parse_bench.evaluation.layout_adapters.base import LayoutAdapter
from parse_bench.evaluation.layout_adapters.registry import (
    _LayoutAdapterRegistration,
    create_layout_adapter_for_result,
    register_pipeline_resolver,
)
from parse_bench.schemas.parse_output import ParseOutput
from parse_bench.schemas.pipeline import PipelineSpec
from parse_bench.schemas.pipeline_io import InferenceRequest, InferenceResult
from parse_bench.schemas.product import ProductType


class _ShapeMatchedLayoutAdapter(LayoutAdapter):
    """Test-only adapter claimed via `matches()`, never registered under a provider key."""

    @classmethod
    def matches(cls, inference_result: InferenceResult) -> bool:
        del inference_result
        return True

    def to_layout_output(self, inference_result: InferenceResult, *, page_filter: int | None = None):
        del inference_result, page_filter
        raise NotImplementedError


def _make_inference_result(pipeline_name: str) -> InferenceResult:
    now = datetime.now()
    output = ParseOutput(
        task_type="parse",
        example_id="doc-1",
        pipeline_name=pipeline_name,
        pages=[],
        layout_pages=[],
        markdown="",
    )
    return InferenceResult(
        request=InferenceRequest(
            example_id="doc-1",
            source_file_path="/tmp/doc-1.pdf",
            product_type=ProductType.PARSE,
        ),
        pipeline_name=pipeline_name,
        product_type=ProductType.PARSE,
        raw_output={},
        output=output,
        started_at=now,
        completed_at=now,
        latency_in_ms=1,
    )


def test_create_layout_adapter_for_result_tries_shape_matcher_before_default() -> None:
    """A resolvable-but-unregistered provider key must still reach the shape-matcher fallback.

    Regression test for #102: `create_layout_adapter`'s own default-adapter fallback made
    the `except ValueError` guard in `create_layout_adapter_for_result` unreachable (a
    `__default__` adapter is always registered), so a real shape-matching adapter was
    never tried for a provider key that resolved but had no exact registration.
    """
    registration = _LayoutAdapterRegistration(
        keys=("shape_matched_test_provider",),
        priority=0,
        adapter_cls=_ShapeMatchedLayoutAdapter,
    )

    def _resolver(pipeline_name: str) -> PipelineSpec | None:
        if pipeline_name != "unregistered_test_pipeline":
            return None
        return PipelineSpec(
            pipeline_name=pipeline_name,
            provider_name="unregistered_test_provider",
            product_type=ProductType.PARSE,
        )

    registry_module._LAYOUT_ADAPTER_REGISTRY.append(registration)
    register_pipeline_resolver(_resolver)
    try:
        inference_result = _make_inference_result("unregistered_test_pipeline")

        adapter = create_layout_adapter_for_result(inference_result)

        assert isinstance(adapter, _ShapeMatchedLayoutAdapter)
    finally:
        registry_module._LAYOUT_ADAPTER_REGISTRY.remove(registration)
        registry_module._PIPELINE_RESOLVERS.remove(_resolver)


def test_create_layout_adapter_for_result_falls_back_to_default_when_no_matcher_claims_it() -> None:
    """No exact key and no shape match still lands on `__default__`, as before."""

    def _resolver(pipeline_name: str) -> PipelineSpec | None:
        if pipeline_name != "unregistered_unmatched_test_pipeline":
            return None
        return PipelineSpec(
            pipeline_name=pipeline_name,
            provider_name="unregistered_unmatched_test_provider",
            product_type=ProductType.PARSE,
        )

    register_pipeline_resolver(_resolver)
    try:
        inference_result = _make_inference_result("unregistered_unmatched_test_pipeline")

        adapter = create_layout_adapter_for_result(inference_result)

        assert type(adapter).__name__ == "NormalizedLayoutOutputAdapter"
    finally:
        registry_module._PIPELINE_RESOLVERS.remove(_resolver)


def _make_kdl_shaped_inference_result(pipeline_name: str) -> InferenceResult:
    """A ParseOutput.layout_pages payload paired with a *real* kdl_frontier_nano
    raw_output shape (`{"pages": [{"elements": [...]}]}`), the case the shape
    matcher actually has to resolve for an unregistered pipeline-name variant.
    """
    now = datetime.now()
    from parse_bench.schemas.parse_output import LayoutItemIR, LayoutSegmentIR, ParseLayoutPageIR

    layout_pages = [
        ParseLayoutPageIR(
            page_number=1,
            width=1000,
            height=1000,
            items=[
                LayoutItemIR(
                    type="Text",
                    md="hello",
                    layout_segments=[LayoutSegmentIR(x=0.1, y=0.1, w=0.2, h=0.05, label="Text")],
                )
            ],
        )
    ]
    output = ParseOutput(
        task_type="parse",
        example_id="doc-1",
        pipeline_name=pipeline_name,
        pages=[],
        layout_pages=layout_pages,
        markdown="hello",
    )
    raw_output = {"pages": [{"page_number": 1, "elements": [{"category": "Text", "text": "hello"}]}]}
    return InferenceResult(
        request=InferenceRequest(
            example_id="doc-1",
            source_file_path="/tmp/doc-1.pdf",
            product_type=ProductType.PARSE,
        ),
        pipeline_name=pipeline_name,
        product_type=ProductType.PARSE,
        raw_output=raw_output,
        output=output,
        started_at=now,
        completed_at=now,
        latency_in_ms=1,
    )


def test_create_layout_adapter_for_result_picks_kdl_adapter_for_unregistered_kdl_variant() -> None:
    """Regression for the review on #102: a resolvable-but-unregistered pipeline
    name whose raw payload is genuinely kdl_frontier_nano-shaped must not be
    claimed by LlamaParseLayoutAdapter or OIParserLayoutAdapter, both of which
    matched any ParseOutput carrying non-empty layout_pages regardless of
    provider. LlamaParse's higher priority (100 vs 90) meant it always won;
    OIParser and KDL were additionally identical to each other, so even without
    LlamaParse in the mix registration order (OIParser registers first) would
    still have picked the wrong adapter.
    """
    from parse_bench.evaluation.layout_adapters.adapters import KdlFrontierNanoLayoutAdapter

    def _resolver(pipeline_name: str) -> PipelineSpec | None:
        if pipeline_name != "kdl_frontier_nano_patched":
            return None
        return PipelineSpec(
            pipeline_name=pipeline_name,
            provider_name="kdl_frontier_nano_patched",
            product_type=ProductType.PARSE,
        )

    register_pipeline_resolver(_resolver)
    try:
        inference_result = _make_kdl_shaped_inference_result("kdl_frontier_nano_patched")

        adapter = create_layout_adapter_for_result(inference_result)

        assert isinstance(adapter, KdlFrontierNanoLayoutAdapter)
    finally:
        registry_module._PIPELINE_RESOLVERS.remove(_resolver)
