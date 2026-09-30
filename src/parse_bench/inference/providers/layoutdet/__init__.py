"""Layout detection providers imported lazily for registry side effects."""

import importlib
import logging

logger = logging.getLogger(__name__)

_PROVIDER_MODULES = [
    "chandra",
    "docling",
    "dots_ocr",
    "layout_v3",
    "paddle",
    "qwen3vl",
    "surya",
    "yolo",
]

for _mod in _PROVIDER_MODULES:
    try:
        importlib.import_module(f"parse_bench.inference.providers.layoutdet.{_mod}")
    except ImportError:
        logger.debug("Skipping layout provider %s (missing dependency)", _mod)

__all__ = _PROVIDER_MODULES
