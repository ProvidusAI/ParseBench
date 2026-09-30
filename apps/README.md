# ParseBench Apps

This directory contains standalone local tools for working with ParseBench datasets and outputs.

The apps are intentionally kept outside the `parse_bench` Python package. Each app owns its own runtime instructions and dependencies so the core benchmark package stays focused on running pipelines, evaluation, and report generation.

Current apps:

- `annotator` - local browser UI for authoring and editing sidecar `.test.json` datasets.
- `visual_grounding_viewer` - local viewer for inspecting visual grounding artifacts and evaluation diagnostics.

Generated folders such as `node_modules/`, frontend build outputs, virtual environments, cache directories, and local `.env` files should stay untracked.
