"""Product-specific evaluators."""

from parse_bench.evaluation.evaluators.base import BaseEvaluator

__all__ = ["BaseEvaluator", "ExtractEvaluator", "ParseEvaluator"]


def __getattr__(name: str):  # type: ignore[no-untyped-def]
    if name == "ExtractEvaluator":
        from parse_bench.evaluation.evaluators.extract import ExtractEvaluator

        return ExtractEvaluator
    if name == "ParseEvaluator":
        from parse_bench.evaluation.evaluators.parse import ParseEvaluator

        return ParseEvaluator
    raise AttributeError(name)
