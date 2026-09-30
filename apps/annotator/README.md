# ParseBench Annotator

Local browser-based annotator for creating and editing ParseBench evaluation test cases.

## Security Model

This is a local, unauthenticated file-editing tool. Run it on trusted machines and keep the default localhost binding unless you add your own authentication, authorization, and network hardening.

## Setup

From this directory:

```bash
uv sync
```

Optional AI-assisted annotation features use a Google Gemini API key. Copy `.env.example` to `.env` and set:

```bash
GOOGLE_GEMINI_API_KEY=your_api_key_here
```

`GOOGLE_API_KEY` is also accepted as a backward-compatible fallback.

## Run

```bash
uv run annotator --queue-dir /path/to/queue --output-dir /path/to/output --port 5001
```

Then open:

```text
http://127.0.0.1:5001
```

You can also start without a queue and choose directories in the UI:

```bash
uv run annotator --port 5001
```

## Expected Queue Shape

The annotator works with a local directory containing source files such as PDFs and images (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.jfif`). Markdown outputs are supported as adjacent parse sidecars, for example `<filename>.parse.md` or `<filename>_llama_agentic.md`; they are not queue source files by themselves. The app writes per-file `.test.json` sidecars and queue state next to the files you annotate.

Use generic local paths such as:

```text
/path/to/queue
/path/to/output
```

Use `--browse-root /path/to/root` to choose the starting directory for the in-app directory picker.

## Tests

From the ParseBench repository root:

```bash
node --test apps/annotator/tests/*.mjs
```
