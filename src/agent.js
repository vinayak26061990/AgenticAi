const DEFAULT_PROVIDER = "local";
const DEFAULT_MODEL = "qwen3.6-64K:latest";
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_HINT_OUTPUT_TOKENS = 1400;
const DEFAULT_REVIEW_OUTPUT_TOKENS = 2200;
const DEFAULT_COMPLETE_OUTPUT_TOKENS = 2600;

export async function buildAgentReply({ problem, messages }) {
  if (!problem || !problem.statement) {
    throw new Error("Problem context is missing.");
  }

  const latestMessage = messages.at(-1)?.content || "";
  const mode = determineInteractionMode(latestMessage);
  const allowCompleteSolution = mode === "complete-solution";
  const reviewProposedSolution = mode === "solution-review";

  const provider = (process.env.AI_PROVIDER || DEFAULT_PROVIDER).toLowerCase();

  if (provider === "local") {
    return {
      content: localFallback(problem, latestMessage, mode),
      model: "local-fallback",
      allowCompleteSolution,
      solutionLocked: !allowCompleteSolution,
      reviewProposedSolution,
      mode
    };
  }

  const response = await callConfiguredModel(problem, messages, mode, provider);
  const guarded = guardSolutionLeak(response, mode);

  return {
    content: guarded,
    model: `${provider}:${process.env.AI_MODEL || DEFAULT_MODEL}`,
    allowCompleteSolution,
    solutionLocked: !allowCompleteSolution,
    reviewProposedSolution,
    mode
  };
}

async function callConfiguredModel(problem, messages, mode, provider) {
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const userMessages = formatConversation(messages, mode);

  const systemPrompt = buildSystemPrompt(mode);
  const userPrompt = buildUserPrompt(problem, userMessages, mode);

  if (provider === "ollama") {
    return callOllama({ model, systemPrompt, userPrompt, mode });
  }

  if (provider === "openai-compatible") {
    return callOpenAICompatible({ model, systemPrompt, userPrompt, mode });
  }

  throw new Error(`Unknown AI_PROVIDER "${provider}". Use local, ollama, or openai-compatible.`);
}

async function callOllama({ model, systemPrompt, userPrompt, mode }) {
  const baseUrl = (process.env.AI_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
  const timeoutMs = optionalInteger(process.env.AI_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: false,
        options: {
          temperature: 0.2,
          num_ctx: optionalInteger(process.env.AI_CONTEXT_TOKENS),
          num_predict: outputTokenLimit(mode)
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Ollama timed out after ${Math.round(timeoutMs / 1000)} seconds. Try again, lower AI_CONTEXT_TOKENS, or use a smaller AI_MAX_OUTPUT_TOKENS value.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();

  // Ollama may return 200 with empty content when the model is loading or errored
  if (data?.error) {
    throw new Error(`Ollama error: ${data.error}`);
  }

  const content = data?.message?.content;
  if (!content) {
    const reason = data?.done_reason;
    const msg = reason
      ? `Ollama stopped generation (${reason}) without producing content. Try a smaller AI_MAX_OUTPUT_TOKENS or restart Ollama.`
      : `Ollama returned an empty response. Make sure the model "${model}" is loaded and Ollama is running.`;
    throw new Error(msg);
  }
  return content.trim();
}

function optionalInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function callOpenAICompatible({ model, systemPrompt, userPrompt, mode }) {
  const baseUrl = (process.env.AI_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("AI_BASE_URL is required for openai-compatible provider.");
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (process.env.AI_API_KEY) {
    headers.Authorization = `Bearer ${process.env.AI_API_KEY}`;
  }

  const timeoutMs = optionalInteger(process.env.AI_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: outputTokenLimit(mode),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Model request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model request failed: ${response.status} ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const finish = data?.choices?.[0]?.finish_reason;
    const msg = finish
      ? `Model stopped (${finish}) without producing content. Try a smaller max_tokens.`
      : "Model returned an empty response. Check the provider's logs.";
    throw new Error(msg);
  }
  return content.trim();
}

function determineInteractionMode(latestMessage) {
  if (/\bcomplete solution\b/i.test(latestMessage)) return "complete-solution";
  if (hasProposedSolution(latestMessage)) return "solution-review";
  return "coaching";
}

function hasProposedSolution(text) {
  const value = String(text || "").trim();
  if (!value) return false;

  const asksForReview = /\b(?:review|evaluate|check|debug|validate|test|critique|syntax|edge cases?|failing?|fails?|wrong answer|my solution|this solution|probable solution)\b/i.test(value);
  const hasCodeFence = /```(?:java)?[\s\S]{40,}```/i.test(value);
  const hasSolutionClass = /\bclass\s+Solution\b[\s\S]{40,}/i.test(value);
  const hasMethodBody = /\b(?:public|private|protected)?\s*(?:static\s+)?(?:int|boolean|long|double|char|void|String|List<[^>]+>|Map<[^>]+>|Set<[^>]+>|int\[\]|char\[\]|boolean\[\]|String\[\])\s+\w+\s*\([^)]*\)\s*\{/i.test(value);

  if (hasCodeFence || hasSolutionClass || (asksForReview && hasMethodBody)) return true;

  const codeSignals = [
    /\bfor\s*\(/,
    /\bwhile\s*\(/,
    /\bif\s*\(/,
    /\breturn\b/,
    /;\s*(?:\n|$)/,
    /\{[\s\S]*\}/,
    /\b(?:HashMap|HashSet|ArrayList|ArrayDeque|PriorityQueue|Arrays|Collections)\b/
  ].filter(regex => regex.test(value)).length;

  return asksForReview && value.length > 120 && codeSignals >= 3;
}

function buildSystemPrompt(mode) {
  const allowCompleteSolution = mode === "complete-solution";
  return `
You are a LeetCode coaching agent for Java implementations.

Core behavior:
- Coach the actual problem provided by the user. Ground every approach in the given statement, examples, and constraints.
- Use Java language terminology and Java collections: int[], char[], String, StringBuilder, ArrayList, HashMap, HashSet, ArrayDeque, PriorityQueue, Arrays.sort, Collections, and recursion where relevant.
- Give guidelines, mental models, hints, edge cases, and dry-run examples.
- Include compact ASCII diagrams when they help explain pointers, stacks, queues, trees, graphs, matrices, or DP tables.
- Prefer progressive disclosure: start with pattern recognition, brute force, optimized approach, invariants, and pitfalls.
- If the user provides a probable Java solution or asks you to review, evaluate, check, debug, or validate their solution, switch to solution-review behavior.
- In solution-review behavior, inspect the user's submitted code for Java syntax or compile risks, LeetCode signature mismatch, algorithmic correctness, edge cases, complexity, and likely failing tests. Give actionable feedback tied to their code.
- In solution-review behavior, you may quote small snippets or corrected lines, but do not provide a complete replacement implementation unless the latest user message contains the exact keyword phrase "complete solution".
- Do not provide a complete Java implementation unless the latest user message contains the exact keyword phrase "complete solution".
- Before that keyword appears, do not output a full class Solution, full method body, or final accepted code. Small Java-flavored snippets are allowed only when they are not enough to submit.
- If the keyword is present, provide the full final answer with complete Java code. Do not use placeholders. Use the method signature implied by the problem.

Current mode: ${mode}.
Current lock state: ${allowCompleteSolution ? "complete solution allowed" : "complete solution locked"}.
`.trim();
}

function buildUserPrompt(problem, userMessages, mode) {
  return `
Problem metadata:
Title: ${problem.title || "Unknown"}
Difficulty: ${problem.difficulty || "Unknown"}
Topics detected: ${(problem.topics || []).join(", ") || "Unknown"}
Source: ${problem.source || "pasted"}
Interaction mode: ${mode}

Problem statement:
${problem.statement}

Extracted examples:
${(problem.examples || []).map((example, index) => `Example ${index + 1}:\n${example}`).join("\n\n") || "None extracted"}

Extracted constraints:
${(problem.constraints || []).map(item => `- ${item}`).join("\n") || "None extracted"}

Conversation:
${userMessages}

${instructionsForMode(mode)}
`.trim();
}

function instructionsForMode(mode) {
  if (mode === "complete-solution") return completeSolutionInstructions();
  if (mode === "solution-review") return solutionReviewInstructions();
  return lockedCoachingInstructions();
}

function lockedCoachingInstructions() {
  return `
Respond now. Complete solution is locked, so give coaching only:
1. Problem-specific recap.
2. Constraints-to-approach signals.
3. Brute force idea and why it may fail.
4. Best likely approach with Java data structures.
5. Hint ladder with 3-5 hints.
6. Examples, including edge cases to watch.
7. ASCII diagram or table.
8. What the learner should implement next.

If the learner wants feedback on their own attempt, tell them they can paste their Java solution and ask for a review.
`.trim();
}

function solutionReviewInstructions() {
  return `
Respond now in solution-review mode. The user has provided or referred to their own probable Java solution.
Keep the complete-solution lock active and do not provide a full replacement implementation.
Include these sections:
1. Verdict: whether the attempt is likely accepted, likely compile error, likely wrong answer, or needs more information.
2. Syntax and LeetCode signature check: Java compile risks, missing return paths, bad method/class shape, imports only if relevant, and type issues.
3. Correctness review: explain the core invariant in the user's approach and where it breaks, if it breaks.
4. Edge cases that may fail: include concrete inputs when possible and the expected behavior.
5. Complexity: time and space implied by the submitted code.
6. Targeted fixes: small changes or pseudocode-level guidance, not a full corrected solution unless the user explicitly asks for "complete solution".
`.trim();
}

function completeSolutionInstructions() {
  return `
Respond now in complete-solution mode. Include these sections:
1. Problem recap.
2. Brute force solution: idea, Java-specific implementation notes, time complexity, and space complexity.
3. Improved solution(s), if any: explain the transition from brute force toward optimal.
4. Optimal solution: invariant, Java data structures, why it works, time complexity, and space complexity.
5. Complete Java implementation: one compilable LeetCode-style \`class Solution\` code block with imports if needed and no placeholders.
6. Walkthrough: dry-run one provided example step by step.
7. Edge cases: list what to test and why.
8. Complexity summary: concise final time and space comparison from brute force to optimal.

Keep the answer complete but focused. Prefer the optimal Java implementation for the final code block.
`.trim();
}

function formatConversation(messages, mode) {
  if (!messages.length) return "USER: Start coaching me on this problem.";

  if (mode === "complete-solution") {
    const recentUserMessages = messages
      .filter(message => message.role === "user")
      .slice(-3)
      .map(message => `USER: ${truncate(message.content, 900)}`);

    return [
      ...recentUserMessages,
      "SYSTEM NOTE: Prior assistant hint responses are omitted so the model focuses on producing the final complete Java solution."
    ].join("\n\n");
  }

  if (mode === "solution-review") {
    const recentMessages = messages.slice(-4);
    return recentMessages
      .map((message, index) => {
        const isLatest = index === recentMessages.length - 1;
        const maxLength = isLatest ? 8000 : (message.role === "assistant" ? 900 : 1600);
        return `${message.role.toUpperCase()}: ${truncate(message.content, maxLength)}`;
      })
      .join("\n\n");
  }

  return messages
    .slice(-6)
    .map(message => `${message.role.toUpperCase()}: ${truncate(message.content, message.role === "assistant" ? 900 : 1400)}`)
    .join("\n\n");
}

function outputTokenLimit(mode) {
  return optionalInteger(process.env.AI_MAX_OUTPUT_TOKENS) ||
    (mode === "complete-solution"
      ? DEFAULT_COMPLETE_OUTPUT_TOKENS
      : mode === "solution-review"
        ? DEFAULT_REVIEW_OUTPUT_TOKENS
        : DEFAULT_HINT_OUTPUT_TOKENS);
}

function truncate(text, maxLength) {
  const value = String(text || "");
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function guardSolutionLeak(text, mode) {
  if (mode === "complete-solution" || mode === "solution-review") return text;

  const hasFullSolution =
    /class\s+Solution\b/.test(text) ||
    /public\s+(?:static\s+)?(?:int|boolean|long|double|String|List|int\[\]|char\[\])\s+\w+\s*\([^)]*\)\s*\{[\s\S]{120,}/.test(text);

  if (!hasFullSolution) return text;

  return [
    "The complete Java implementation is locked until you ask with the keyword `complete solution`.",
    "",
    "Here is the next useful hint instead:",
    "",
    "- Identify the state you need to maintain while scanning the input.",
    "- Write the loop invariant in Java terms before coding: what does each pointer, map, stack, queue, or DP cell mean?",
    "- Dry-run the smallest non-trivial example and one boundary case before filling in the method body."
  ].join("\n");
}

function localFallback(problem, latestMessage, mode) {
  if (mode === "complete-solution") {
    return [
      `## ${problem.title}`,
      "",
      "Complete solution mode is unlocked, but no generative model provider is configured, so I cannot reliably generate an accepted Java implementation for an arbitrary LeetCode problem.",
      "",
      "Use this Java submission shell while you work from the hints:",
      "",
      "```java",
      "class Solution {",
      "    // Paste the LeetCode method signature here.",
      "    // Implement after choosing the data structure and invariant.",
      "}",
      "```",
      "",
      localFallback(problem, latestMessage, "coaching")
    ].join("\n");
  }

  if (mode === "solution-review") {
    return localSolutionReview(problem, latestMessage);
  }

  const profile = detectApproachProfile(problem);
  const examples = problem.examples?.length ? problem.examples : makeGenericExamples(problem);
  const constraints = problem.constraints?.length
    ? problem.constraints.map(item => `- ${item}`).join("\n")
    : "- Check input size before choosing O(n^2).\n- Check value ranges before using arrays as frequency buckets.\n- Check whether duplicates, empty inputs, or negative values are allowed.";

  return [
    `## ${problem.title}`,
    "",
    `Difficulty: ${problem.difficulty || "Unknown"}  `,
    `Detected Java topics: ${profile.topics.join(", ") || "needs statement-specific analysis"}`,
    "",
    "### Problem Recap",
    summarizeProblem(problem.statement),
    "",
    "### Constraints To Approach",
    constraints,
    "",
    "### Approach Ladder",
    `1. Brute force: ${profile.bruteForce}`,
    `2. Better direction: ${profile.optimized}`,
    `3. Java data structures to consider: ${profile.javaTools.join(", ")}`,
    "",
    "### Hint Ladder",
    ...profile.hints.map((hint, index) => `${index + 1}. ${hint}`),
    "",
    "### Examples And Edge Cases",
    ...examples.map((example, index) => `Example ${index + 1}:\n${example}`),
    "",
    "Edge cases to keep in view:",
    ...profile.edgeCases.map(item => `- ${item}`),
    "",
    "### Diagram",
    "```text",
    profile.diagram,
    "```",
    "",
    "### Next Step",
    "Write the Java method signature from LeetCode, name the invariant in a comment, then implement only the first pass or first recurrence. Ask for another hint when you get stuck."
  ].join("\n");
}

function localSolutionReview(problem, latestMessage) {
  const code = extractCandidateSolution(latestMessage);
  const profile = detectApproachProfile(problem);
  const syntaxFindings = analyzeJavaSyntaxShape(code);
  const fitFindings = analyzeProblemFit(problem, code);
  const complexityFindings = inferComplexitySignals(code);

  return [
    `## ${problem.title} Solution Review`,
    "",
    "Local static review mode is active. This catches common Java and LeetCode failure patterns, but a configured model provider can give a deeper line-by-line proof of correctness.",
    "",
    "### Verdict",
    syntaxFindings.some(item => item.severity === "error")
      ? "Likely compile or submission-shape issue until the syntax findings below are fixed."
      : "No obvious syntax-shape blocker was found by the local checker. The main risk is correctness on edge cases, so dry-run the tests below.",
    "",
    "### Syntax And Signature Check",
    ...syntaxFindings.map(item => `- ${item.message}`),
    "",
    "### Problem Fit",
    ...(fitFindings.length ? fitFindings.map(item => `- ${item}`) : ["- No problem-specific mismatch was obvious from static checks. Verify the invariant with the official examples."]),
    "",
    "### Complexity Signals",
    ...complexityFindings.map(item => `- ${item}`),
    "",
    "### Edge Cases To Try",
    ...profile.edgeCases.map(item => `- ${item}`),
    "",
    "### Next Step",
    "Run the official examples, then add one test for each edge case above. If any fail, paste the failing input/output and the current code for a tighter review."
  ].join("\n");
}

function extractCandidateSolution(message) {
  const text = String(message || "").trim();
  const fenced = text.match(/```(?:java)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const classStart = text.match(/\bclass\s+Solution\b[\s\S]*/i);
  if (classStart?.[0]?.trim()) return classStart[0].trim();

  const methodStart = text.match(/\b(?:public|private|protected)?\s*(?:static\s+)?(?:int|boolean|long|double|char|void|String|List<[^>]+>|Map<[^>]+>|Set<[^>]+>|int\[\]|char\[\]|boolean\[\]|String\[\])\s+\w+\s*\([^)]*\)\s*\{[\s\S]*/i);
  if (methodStart?.[0]?.trim()) return methodStart[0].trim();

  return text;
}

function analyzeJavaSyntaxShape(code) {
  const findings = [];
  const source = String(code || "").trim();

  if (source.length < 40) {
    findings.push({
      severity: "error",
      message: "I do not see enough Java code to evaluate. Paste the method or `class Solution` in the chat."
    });
    return findings;
  }

  const clean = stripJavaCommentsAndLiterals(source);
  const bracketIssue = findBracketIssue(clean);
  if (bracketIssue) {
    findings.push({ severity: "error", message: bracketIssue });
  }

  if (!/\bclass\s+Solution\b/.test(clean)) {
    findings.push({
      severity: "warn",
      message: "No `class Solution` wrapper was detected. A pasted method is fine for review, but the final LeetCode submission must live inside `class Solution`."
    });
  }

  if (!/\b(?:public|private|protected)?\s*(?:static\s+)?(?:int|boolean|long|double|char|void|String|List<[^>]+>|Map<[^>]+>|Set<[^>]+>|int\[\]|char\[\]|boolean\[\]|String\[\])\s+\w+\s*\([^)]*\)\s*\{/.test(clean)) {
    findings.push({
      severity: "error",
      message: "No complete Java method signature with a body was detected."
    });
  }

  const primitiveReturn = clean.match(/\b(?:public|private|protected)?\s*(?:static\s+)?(int|boolean|long|double|char)\s+\w+\s*\([^)]*\)\s*\{/);
  if (primitiveReturn && /\breturn\s+null\s*;/.test(clean)) {
    findings.push({
      severity: "error",
      message: `A method returning primitive \`${primitiveReturn[1]}\` cannot return \`null\`.`
    });
  }

  if (/\b(?:nums|arr|array|grid|matrix|heights|prices|values|intervals)\.length\(\)/.test(clean)) {
    findings.push({
      severity: "error",
      message: "Arrays use `.length`, not `.length()`. Strings use `.length()`."
    });
  }

  if (/\bif\s*\([^)]*[^!<>=]=[^=][^)]*\)/.test(clean)) {
    findings.push({
      severity: "error",
      message: "An `if` condition appears to use assignment `=`. Java conditions usually need `==`, `<`, `>`, or a boolean expression."
    });
  }

  const mapNames = extractMapVariableNames(clean);
  for (const name of mapNames) {
    const containsRegex = new RegExp(`\\b${escapeRegex(name)}\\.contains\\s*\\(`);
    if (containsRegex.test(clean)) {
      findings.push({
        severity: "error",
        message: `\`${name}.contains(...)\` is not a ` +
          "Map method. Use `containsKey(...)` or `containsValue(...)`."
      });
    }
  }

  if (/\bString\b[\s\S]*==/.test(clean)) {
    findings.push({
      severity: "warn",
      message: "If you compare String values, use `.equals(...)`; `==` compares references."
    });
  }

  if (/return\s+[a-zA-Z_]\w*\s*-\s*[a-zA-Z_]\w*\s*;/.test(clean) || /->\s*[a-zA-Z_]\w*(?:\[[^\]]+\])?\s*-\s*[a-zA-Z_]\w*/.test(clean)) {
    findings.push({
      severity: "warn",
      message: "Comparator subtraction can overflow. Prefer `Integer.compare(a, b)` or `Long.compare(a, b)`."
    });
  }

  if (/\b(?:left|lo|low)\s*\+\s*(?:right|hi|high)\s*\/\s*2\b/.test(clean) || /\(\s*(?:left|lo|low)\s*\+\s*(?:right|hi|high)\s*\)\s*\/\s*2\b/.test(clean)) {
    findings.push({
      severity: "warn",
      message: "For binary search, compute mid as `left + (right - left) / 2` to avoid overflow."
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "info",
      message: "No obvious syntax-shape issue was found by the local static checker."
    });
  }

  return findings;
}

function stripJavaCommentsAndLiterals(code) {
  return String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
    .replace(/'(?:\\.|[^'\\])+'/g, "''");
}

function findBracketIssue(code) {
  const pairs = {
    "(": ")",
    "{": "}",
    "[": "]"
  };
  const opening = new Set(Object.keys(pairs));
  const closing = new Map(Object.entries(pairs).map(([open, close]) => [close, open]));
  const stack = [];

  for (const char of code) {
    if (opening.has(char)) {
      stack.push(char);
      continue;
    }

    if (!closing.has(char)) continue;

    const expectedOpen = closing.get(char);
    const actualOpen = stack.pop();
    if (actualOpen !== expectedOpen) {
      return `Bracket mismatch near \`${char}\`: expected it to close \`${pairs[actualOpen] || "nothing"}\`.`;
    }
  }

  if (stack.length) {
    const lastOpen = stack.at(-1);
    return `Unclosed bracket \`${lastOpen}\`; expected a matching \`${pairs[lastOpen]}\`.`;
  }

  return null;
}

function extractMapVariableNames(code) {
  const names = new Set();
  const patterns = [
    /\b(?:HashMap|Map)<[^>]+>\s+([a-zA-Z_]\w*)\b/g,
    /\b(?:HashMap|Map)\s+([a-zA-Z_]\w*)\s*=/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code))) {
      names.add(match[1]);
    }
  }

  return [...names];
}

function analyzeProblemFit(problem, code) {
  const findings = [];
  const statement = `${problem.title || ""}\n${problem.statement || ""}`.toLowerCase();
  const clean = stripJavaCommentsAndLiterals(code);

  if (/return\s+indices|return indices|index|indices/.test(statement) && /\bArrays\.sort\s*\(/.test(clean)) {
    findings.push("The problem appears to require original indices, and `Arrays.sort(...)` can destroy index positions unless you store index-value pairs first.");
  }

  if (/same element twice|may not use the same element twice/.test(statement) && /\bmap\.put\s*\([^;]+;\s*if\s*\([^)]*containsKey/i.test(clean)) {
    findings.push("For complement-map problems, checking after inserting the current element can accidentally reuse the same index. Check first, then insert the current value.");
  }

  if (/(?:-\d|\bnegative\b|nums\[i\]\s*<=\s*10\^9|\b10\^9\b)/i.test(statement) && /\b[a-zA-Z_]\w*\s*\[\s*nums\s*\[[^\]]+\]\s*\]/.test(clean)) {
    findings.push("Directly using `nums[i]` as an array index can fail for negative or very large values. Prefer a `HashMap` unless the value range is small and non-negative.");
  }

  if (/\bempty\b|0\s*<=|length\s*==\s*0/.test(statement) && !/\b(?:length|size)\s*==\s*0|\b(?:length|size)\s*<\s*1|\bisEmpty\s*\(/.test(clean)) {
    findings.push("The statement may allow empty input. Add an explicit empty-case check if the LeetCode signature allows it.");
  }

  return findings;
}

function inferComplexitySignals(code) {
  const clean = stripJavaCommentsAndLiterals(code);
  const findings = [];

  if (/\bfor\s*\([^)]*\)\s*\{[\s\S]*\bfor\s*\(/.test(clean) || /\bwhile\s*\([^)]*\)\s*\{[\s\S]*\bwhile\s*\(/.test(clean)) {
    findings.push("Nested loops suggest O(n^2) or worse. Compare that against the largest constraint.");
  } else if (/\b(?:for|while)\s*\(/.test(clean) && /\b(?:HashMap|HashSet|Map|Set)\b/.test(clean)) {
    findings.push("A single pass with hash-based state is usually O(n) average time and O(n) space.");
  } else if (/\b(?:for|while)\s*\(/.test(clean)) {
    findings.push("The visible loop structure looks roughly linear unless helpers perform extra scans.");
  } else {
    findings.push("No loop was obvious; verify recursion/helper calls to estimate time complexity.");
  }

  if (/\bArrays\.sort\s*\(|\bCollections\.sort\s*\(/.test(clean)) {
    findings.push("Sorting adds O(n log n) time and may mutate the input array/list.");
  }

  if (/\b(?:dfs|recur|helper)\s*\(|\breturn\s+\w+\s*\([^)]*\)/i.test(clean)) {
    findings.push("Recursive solutions also use call-stack space proportional to recursion depth.");
  }

  return findings;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectApproachProfile(problem) {
  const text = `${problem.title || ""}\n${problem.statement || ""}`.toLowerCase();
  const topics = new Set(problem.topics || []);

  if (/tree|root|binary tree|bst/.test(text)) {
    topics.add("Tree");
    return {
      topics: [...topics],
      bruteForce: "traverse every node and recompute needed information from scratch.",
      optimized: "use DFS recursion or an ArrayDeque-based BFS so each TreeNode is processed once.",
      javaTools: ["TreeNode", "ArrayDeque<TreeNode>", "recursive helper", "HashMap<TreeNode, ...> when memoization is needed"],
      hints: [
        "Decide whether the answer is local to one node or depends on information returned from children.",
        "For DFS, define exactly what the helper returns to its parent.",
        "For BFS, store nodes in an ArrayDeque and process level by level.",
        "Null children are usually the base case, not a special failure."
      ],
      edgeCases: ["root is null if allowed", "single node tree", "skewed tree behaving like a linked list", "duplicate values in TreeNode.val"],
      diagram: "        root\n       /    \\\n   left    right\n    |        |\nreturn L  return R\n        combine at root"
    };
  }

  if (/graph|edge|connected|island|shortest|bfs|dfs/.test(text)) {
    topics.add("Graph");
    return {
      topics: [...topics],
      bruteForce: "start a fresh search for each query or cell, which often revisits the same nodes repeatedly.",
      optimized: "build adjacency or scan neighbors once, then use BFS/DFS with a visited structure.",
      javaTools: ["ArrayList<List<Integer>>", "ArrayDeque<Integer>", "boolean[] visited", "int[][] directions"],
      hints: [
        "Model what a node is: index, cell coordinate, word state, or pair of values.",
        "Mark visited when enqueuing to avoid duplicates in the queue.",
        "For shortest path with equal edge weights, BFS is usually the first candidate.",
        "For components or reachability, DFS/BFS both work; choose the simpler Java implementation."
      ],
      edgeCases: ["empty grid/list", "disconnected components", "cycles", "start equals target", "boundary cells"],
      diagram: "queue: [start]\nvisited: {start}\n\npop -> inspect neighbors -> enqueue unseen\nrepeat until queue empty or target found"
    };
  }

  if (/substring|subarray|window|contiguous/.test(text)) {
    topics.add("Sliding Window");
    return {
      topics: [...topics],
      bruteForce: "enumerate every start and end index and validate each window.",
      optimized: "move right to expand, move left to restore the invariant, and update the answer while the window is valid.",
      javaTools: ["int left/right", "HashMap<Character, Integer>", "int[] freq", "String.charAt"],
      hints: [
        "Write the invariant: what makes the current window valid?",
        "Only move `left` when the invariant is broken or while it can be improved.",
        "Update the answer at the exact moment the window satisfies the problem condition.",
        "Use `int[]` for character counts when the alphabet is bounded; otherwise use `HashMap`."
      ],
      edgeCases: ["empty string/array", "all identical values", "no valid window", "window length 1", "answer at the end"],
      diagram: "nums/string:  [ ... L ===== R ... ]\nexpand R -> update counts\nshrink L -> restore invariant\nanswer <- best valid window"
    };
  }

  if (/sorted|binary search|minimum possible|maximum possible|koko|ship|capacity/.test(text)) {
    topics.add("Binary Search");
    return {
      topics: [...topics],
      bruteForce: "try every possible answer or scan linearly through the search space.",
      optimized: "binary search either an index in a sorted structure or the answer value using a monotonic feasibility check.",
      javaTools: ["int left/right/mid", "long for overflow-safe sums", "helper can(...)", "Arrays.sort"],
      hints: [
        "Decide whether you are searching an index or searching the answer.",
        "Prove monotonicity: after a value works, do larger or smaller values also work?",
        "Use `left + (right - left) / 2` to avoid overflow.",
        "Keep the feasibility helper side-effect free."
      ],
      edgeCases: ["smallest input", "all values equal", "target below/above range", "overflow in sums", "off-by-one loop exit"],
      diagram: "search space: [L .... mid .... R]\ncan(mid)?\n  yes -> keep the half containing better valid answers\n  no  -> discard impossible half"
    };
  }

  if (/parentheses|bracket|stack|next greater|monotonic/.test(text)) {
    topics.add("Stack");
    return {
      topics: [...topics],
      bruteForce: "for each position, scan outward or repeatedly re-check previous elements.",
      optimized: "use an ArrayDeque as a stack to keep unresolved items or opening symbols.",
      javaTools: ["ArrayDeque<Integer>", "ArrayDeque<Character>", "peek", "push", "pop"],
      hints: [
        "Store indices when distance or span matters; store values/chars when only matching matters.",
        "For monotonic stacks, decide whether the stack is increasing or decreasing.",
        "Resolve answers when the current element breaks the stack invariant.",
        "Check empty stack before calling `peek` or `pop`."
      ],
      edgeCases: ["empty input", "single item", "unmatched opening/closing symbol", "strictly increasing/decreasing sequence"],
      diagram: "current item -> compare with stack.peek()\nwhile stack violates invariant:\n    pop and resolve\npush current item/index"
    };
  }

  if (/kth|top k|frequency|median|priority/.test(text)) {
    topics.add("Heap");
    return {
      topics: [...topics],
      bruteForce: "sort everything or repeatedly scan for the next best item.",
      optimized: "use PriorityQueue to keep only the candidates needed for the answer.",
      javaTools: ["PriorityQueue<Integer>", "PriorityQueue<int[]>", "HashMap<T, Integer>", "custom comparator"],
      hints: [
        "Choose min-heap or max-heap based on which element should be evicted first.",
        "For top K, keep heap size at K when possible.",
        "For frequency problems, count with HashMap before heap operations.",
        "Comparator overflow matters; prefer `Integer.compare(a, b)`."
      ],
      edgeCases: ["k is 1", "k equals input length", "ties", "negative values", "duplicate values"],
      diagram: "HashMap counts -> PriorityQueue candidates\npush item\nif heap.size() > k: poll least useful\nremaining heap -> answer"
    };
  }

  if (/ways|minimum cost|maximum profit|subsequence|partition|decode|dp/.test(text)) {
    topics.add("Dynamic Programming");
    return {
      topics: [...topics],
      bruteForce: "try all choices recursively, which repeats overlapping subproblems.",
      optimized: "define a DP state, transition, base case, and fill order; use memoization or tabulation.",
      javaTools: ["int[] dp", "int[][] dp", "Arrays.fill", "HashMap<String, Integer> for sparse states"],
      hints: [
        "Define `dp[i]` or `dp[i][j]` in one sentence before writing code.",
        "List the choices from each state and how they move to smaller states.",
        "Initialize base cases directly from the problem's smallest valid inputs.",
        "If only the previous row/state is needed, compress space after correctness is clear."
      ],
      edgeCases: ["length 0/1", "impossible states", "large answer requiring modulo if stated", "negative values if allowed"],
      diagram: "state -> choices -> smaller states\n\ndp[i] = best/count using prefix ending at i\nfill from known base cases toward final answer"
    };
  }

  topics.add("Array");
  topics.add("HashMap");
  return {
    topics: [...topics],
    bruteForce: "compare all pairs/subsets or scan repeatedly for each element.",
    optimized: "scan once while maintaining the exact state needed to answer future positions.",
    javaTools: ["int[]", "HashMap<Integer, Integer>", "HashSet<Integer>", "Arrays.sort", "two pointers if sorted"],
    hints: [
      "Ask what information from previous elements would make the current decision O(1).",
      "If the problem asks for pairs, think complement lookup with HashMap or two pointers after sorting.",
      "If order matters, avoid sorting unless you preserve original indices.",
      "Keep answer updates close to the line that changes the state."
    ],
    edgeCases: ["empty or length 1 input", "duplicates", "negative numbers", "large values", "multiple valid answers"],
    diagram: "for each nums[i]:\n    use current state to ask: can I answer now?\n    update HashMap/HashSet/window/answer\nstate only stores what future indices need"
  };
}

function summarizeProblem(statement) {
  const firstParagraph = String(statement || "")
    .replace(/\s+/g, " ")
    .split(/Example\s+\d|Constraints?:/i)[0]
    .trim();

  if (!firstParagraph) {
    return "The statement could not be summarized locally. Paste the full problem text for sharper guidance.";
  }

  return firstParagraph.length > 420
    ? `${firstParagraph.slice(0, 420).trim()}...`
    : firstParagraph;
}

function makeGenericExamples(problem) {
  const hasLinkOnly = problem.source === "link";
  if (hasLinkOnly) {
    return [
      "Paste the official examples from LeetCode so the agent can dry-run the actual inputs.",
      "Add one boundary case from the constraints, such as smallest length, duplicates, empty grid, or single node."
    ];
  }

  return [
    "Use the smallest non-trivial input from the statement and dry-run each state update.",
    "Create one edge case that challenges the chosen data structure, such as duplicates for HashMap, all equal values for two pointers, or an empty queue for BFS."
  ];
}
