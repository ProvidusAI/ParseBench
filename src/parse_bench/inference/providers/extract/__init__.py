"""Extract providers imported for registry side effects.

Only the minimal ParseBench EXTRACT integration providers are registered here.
Imports are best-effort so base ParseBench imports do not require optional
provider SDKs such as ``extend-ai``.
"""

import importlib
import logging

logger = logging.getLogger(__name__)

_PROVIDER_MODULES = [
    "extend",
    "llamaextract_v2_api",
]

for _mod in _PROVIDER_MODULES:
    try:
        importlib.import_module(f"parse_bench.inference.providers.extract.{_mod}")
    except ImportError:
        logger.debug("Skipping extract provider %s (missing dependency)", _mod)
