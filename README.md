# LeetCode Java Coach

A local web app that coaches you through LeetCode problems with Java-focused hints, approach guidance, examples, edge cases, and ASCII diagrams.

The app intentionally keeps complete Java submissions locked until the latest chat message contains the exact phrase:

```text
complete solution
```

## Important model note

Codex inside ChatGPT Pro can help build and edit this project, but a local web app cannot directly call your ChatGPT Pro Codex session as its model backend. ChatGPT Pro does not expose a local API endpoint for apps.

This project therefore supports:

- `local`: deterministic built-in coaching, no external model calls.
- `ollama`: a local model running through Ollama.
- `openai-compatible`: any provider that exposes a `/chat/completions` API.

## Run

```bash
npm start
```

Then open:

```text
http://localhost:4173
```

No package install is required because the app uses Node built-ins only.

## Configure

Copy `.env.example` to `.env` and choose a provider.

Local fallback:

```env
AI_PROVIDER=local
```

Ollama:

```env
AI_PROVIDER=ollama
AI_BASE_URL=http://localhost:11434
AI_MODEL=qwen2.5-coder:7b
AI_CONTEXT_TOKENS=4096
AI_MAX_OUTPUT_TOKENS=2600
AI_REQUEST_TIMEOUT_MS=120000
```

Before running the app with this provider, pull the model once:

```bash
ollama pull qwen2.5-coder:7b
```

Make sure Ollama is running locally, then start the app with `npm start`.

OpenAI-compatible endpoint:

```env
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://your-provider.example/v1
AI_MODEL=your-model
AI_API_KEY=your-key-if-needed
```

## Use

Paste either:

- the full LeetCode problem statement, or
- a LeetCode problem link.

Problem links are fetched best-effort through LeetCode's public GraphQL endpoint. If that fails because of network access or LeetCode restrictions, paste the statement directly.

All generated implementation guidance assumes Java.

## API Documentation

See [docs/CALLING_AGENT.md](docs/CALLING_AGENT.md) for:

- web UI usage
- REST API request and response shapes
- curl examples
- JavaScript fetch examples
- the `complete solution` unlock flow
- Ollama troubleshooting

## Git History

This project is initialized as a git repository. View the local commit history with:

```bash
git log --oneline
```
