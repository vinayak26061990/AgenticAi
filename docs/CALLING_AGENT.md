# Calling The LeetCode Java Coach Agent

This app exposes a local web UI and a small HTTP API. The expected flow is:

1. Start the local server.
2. Send a LeetCode problem statement or problem link to `/api/problem`.
3. Send the normalized problem plus chat messages to `/api/coach`.
4. Ask for hints normally.
5. Ask with the exact phrase `complete solution` only when you want the full Java implementation.

## Start The Agent

From the `AgenticAi` directory:

```bash
npm start
```

The server listens on:

```text
http://127.0.0.1:4173
```

The Ollama-backed default config is:

```env
AI_PROVIDER=ollama
AI_BASE_URL=http://localhost:11434
AI_MODEL=qwen2.5-coder:7b
AI_CONTEXT_TOKENS=4096
AI_MAX_OUTPUT_TOKENS=2600
AI_REQUEST_TIMEOUT_MS=120000
```

Before using Ollama, make sure the model exists locally:

```bash
ollama pull qwen2.5-coder:7b
```

## Web UI

Open:

```text
http://127.0.0.1:4173
```

Then:

1. Paste a full LeetCode statement or a LeetCode problem link.
2. Click `Analyze problem`.
3. Use `Next hint`, `Dry run`, `Edge cases`, or `Java tools` for guided help.
4. Click `Complete solution` or type `complete solution` to unlock the final Java answer.

Until the latest user message contains `complete solution`, the server instructs the model not to return a complete Java submission.

## API Flow

### 1. Normalize Problem Context

Endpoint:

```http
POST /api/problem
Content-Type: application/json
```

Request:

```json
{
  "context": "Paste the LeetCode problem statement or https://leetcode.com/problems/two-sum/"
}
```

Response:

```json
{
  "problem": {
    "title": "Two Sum",
    "slug": null,
    "difficulty": "Easy",
    "topics": ["Array", "HashMap"],
    "source": "pasted",
    "statement": "...",
    "examples": ["..."],
    "constraints": ["..."]
  }
}
```

If you provide only a LeetCode link, the server tries to fetch problem metadata from LeetCode. If that fails, paste the statement directly for exact coaching.

### 2. Ask For Coaching

Endpoint:

```http
POST /api/coach
Content-Type: application/json
```

Request:

```json
{
  "problem": {
    "title": "Two Sum",
    "difficulty": "Easy",
    "topics": ["Array", "HashMap"],
    "source": "pasted",
    "statement": "Given an array of integers nums and an integer target...",
    "examples": ["Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]"],
    "constraints": ["2 <= nums.length <= 10^4"]
  },
  "messages": [
    {
      "role": "user",
      "content": "Give me hints only."
    }
  ]
}
```

Response:

```json
{
  "content": "### Problem-Specific Recap\n...",
  "model": "ollama:qwen2.5-coder:7b",
  "allowCompleteSolution": false,
  "solutionLocked": true
}
```

### 3. Unlock Complete Solution

Use the same `/api/coach` endpoint, but make the latest user message contain the exact phrase `complete solution`.

Request:

```json
{
  "problem": {
    "title": "Two Sum",
    "difficulty": "Easy",
    "topics": ["Array", "HashMap"],
    "source": "pasted",
    "statement": "Given an array of integers nums and an integer target...",
    "examples": ["Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]"],
    "constraints": ["2 <= nums.length <= 10^4"]
  },
  "messages": [
    {
      "role": "user",
      "content": "complete solution"
    }
  ]
}
```

Expected response shape:

```json
{
  "content": "## Problem recap\n...\n```java\nclass Solution {\n    ...\n}\n```",
  "model": "ollama:qwen2.5-coder:7b",
  "allowCompleteSolution": true,
  "solutionLocked": false
}
```

In complete-solution mode, the agent is prompted to include:

- brute force approach
- improved approaches when relevant
- optimal approach
- complete Java implementation
- walkthrough
- edge cases
- time and space complexity for each approach

## Curl Example

Create a normalized problem:

```bash
curl -sS http://127.0.0.1:4173/api/problem \
  -H 'Content-Type: application/json' \
  -d '{
    "context": "1. Two Sum\nEasy\n\nGiven an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.\n\nExample 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]\n\nConstraints:\n2 <= nums.length <= 10^4"
  }'
```

Ask for hints:

```bash
curl -sS http://127.0.0.1:4173/api/coach \
  -H 'Content-Type: application/json' \
  -d '{
    "problem": {
      "title": "Two Sum",
      "difficulty": "Easy",
      "topics": ["Array", "HashMap"],
      "source": "pasted",
      "statement": "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
      "examples": ["Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]"],
      "constraints": ["2 <= nums.length <= 10^4"]
    },
    "messages": [
      {
        "role": "user",
        "content": "Give me the next hint without code."
      }
    ]
  }'
```

Ask for the final answer:

```bash
curl -sS http://127.0.0.1:4173/api/coach \
  -H 'Content-Type: application/json' \
  -d '{
    "problem": {
      "title": "Two Sum",
      "difficulty": "Easy",
      "topics": ["Array", "HashMap"],
      "source": "pasted",
      "statement": "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
      "examples": ["Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]"],
      "constraints": ["2 <= nums.length <= 10^4"]
    },
    "messages": [
      {
        "role": "user",
        "content": "complete solution"
      }
    ]
  }'
```

## Calling From JavaScript

```js
const problemResponse = await fetch("http://127.0.0.1:4173/api/problem", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ context: leetcodeProblemTextOrUrl })
});

const { problem } = await problemResponse.json();

const coachResponse = await fetch("http://127.0.0.1:4173/api/coach", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    problem,
    messages: [{ role: "user", content: "Give me hints only." }]
  })
});

const reply = await coachResponse.json();
console.log(reply.content);
```

## Troubleshooting

If complete solution generation is slow:

- Confirm Ollama is running.
- Keep `AI_CONTEXT_TOKENS=4096` for `qwen2.5-coder:7b` unless you need a larger context.
- Lower `AI_MAX_OUTPUT_TOKENS` if responses take too long.
- Increase `AI_REQUEST_TIMEOUT_MS` if your machine needs more time.

If the model returns hints instead of code:

- Make sure the latest user message includes exactly `complete solution`.
- Use the `Complete solution` button in the web UI.

If a LeetCode link does not fetch:

- Paste the problem statement directly.
- Some LeetCode content may be unavailable depending on network restrictions or problem visibility.
