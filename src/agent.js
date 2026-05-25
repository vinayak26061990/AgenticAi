const DEFAULT_PROVIDER = "local";
const DEFAULT_MODEL = "qwen2.5-coder:7b";
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_HINT_OUTPUT_TOKENS = 1400;
const DEFAULT_COMPLETE_OUTPUT_TOKENS = 2600;

export async function buildAgentReply({ problem, messages }) {
  if (!problem || !problem.statement) {
    throw new Error("Problem context is missing.");
  }

  const latestMessage = messages.at(-1)?.content || "";
  const allowCompleteSolution = /\bcomplete solution\b/i.test(latestMessage);

  const provider = (process.env.AI_PROVIDER || DEFAULT_PROVIDER).toLowerCase();

  if (provider === "local") {
    return {
      content: localFallback(problem, latestMessage, allowCompleteSolution),
      model: "local-fallback",
      allowCompleteSolution,
      solutionLocked: !allowCompleteSolution
    };
  }

  const response = await callConfiguredModel(problem, messages, allowCompleteSolution, provider);
  const guarded = guardSolutionLeak(response, allowCompleteSolution);

  return {
    content: guarded,
    model: `${provider}:${process.env.AI_MODEL || DEFAULT_MODEL}`,
    allowCompleteSolution,
    solutionLocked: !allowCompleteSolution
  };
}

async function callConfiguredModel(problem, messages, allowCompleteSolution, provider) {
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const userMessages = formatConversation(messages, allowCompleteSolution);

  const systemPrompt = buildSystemPrompt(allowCompleteSolution);
  const userPrompt = buildUserPrompt(problem, userMessages, allowCompleteSolution);

  if (provider === "ollama") {
    return callOllama({ model, systemPrompt, userPrompt, allowCompleteSolution });
  }

  if (provider === "openai-compatible") {
    return callOpenAICompatible({ model, systemPrompt, userPrompt, allowCompleteSolution });
  }

  throw new Error(`Unknown AI_PROVIDER "${provider}". Use local, ollama, or openai-compatible.`);
}

async function callOllama({ model, systemPrompt, userPrompt, allowCompleteSolution }) {
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
          num_predict: outputTokenLimit(allowCompleteSolution)
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
  const content = data?.message?.content;
  if (!content) throw new Error("Ollama response did not include message content.");
  return content.trim();
}

function optionalInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function callOpenAICompatible({ model, systemPrompt, userPrompt, allowCompleteSolution }) {
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
        max_tokens: outputTokenLimit(allowCompleteSolution),
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
  if (!content) throw new Error("Model response did not include message content.");
  return content.trim();
}

function buildSystemPrompt(allowCompleteSolution) {
  return `
You are a LeetCode coaching agent for Java implementations.

Core behavior:
- Coach the actual problem provided by the user. Ground every approach in the given statement, examples, and constraints.
- Use Java language terminology and Java collections: int[], char[], String, StringBuilder, ArrayList, HashMap, HashSet, ArrayDeque, PriorityQueue, Arrays.sort, Collections, and recursion where relevant.
- Give guidelines, mental models, hints, edge cases, and dry-run examples.
- Include compact ASCII diagrams when they help explain pointers, stacks, queues, trees, graphs, matrices, or DP tables.
- Prefer progressive disclosure: start with pattern recognition, brute force, optimized approach, invariants, and pitfalls.
- Do not provide a complete Java implementation unless the latest user message contains the exact keyword phrase "complete solution".
- Before that keyword appears, do not output a full class Solution, full method body, or final accepted code. Small Java-flavored snippets are allowed only when they are not enough to submit.
- If the keyword is present, provide the full final answer with complete Java code. Do not use placeholders. Use the method signature implied by the problem.

Current lock state: ${allowCompleteSolution ? "complete solution allowed" : "complete solution locked"}.
`.trim();
}

function buildUserPrompt(problem, userMessages, allowCompleteSolution) {
  return `
Problem metadata:
Title: ${problem.title || "Unknown"}
Difficulty: ${problem.difficulty || "Unknown"}
Topics detected: ${(problem.topics || []).join(", ") || "Unknown"}
Source: ${problem.source || "pasted"}

Problem statement:
${problem.statement}

Extracted examples:
${(problem.examples || []).map((example, index) => `Example ${index + 1}:\n${example}`).join("\n\n") || "None extracted"}

Extracted constraints:
${(problem.constraints || []).map(item => `- ${item}`).join("\n") || "None extracted"}

Conversation:
${userMessages}

${allowCompleteSolution ? completeSolutionInstructions() : lockedCoachingInstructions()}
`.trim();
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

function formatConversation(messages, allowCompleteSolution) {
  if (!messages.length) return "USER: Start coaching me on this problem.";

  if (allowCompleteSolution) {
    const recentUserMessages = messages
      .filter(message => message.role === "user")
      .slice(-3)
      .map(message => `USER: ${truncate(message.content, 900)}`);

    return [
      ...recentUserMessages,
      "SYSTEM NOTE: Prior assistant hint responses are omitted so the model focuses on producing the final complete Java solution."
    ].join("\n\n");
  }

  return messages
    .slice(-6)
    .map(message => `${message.role.toUpperCase()}: ${truncate(message.content, message.role === "assistant" ? 900 : 1400)}`)
    .join("\n\n");
}

function outputTokenLimit(allowCompleteSolution) {
  return optionalInteger(process.env.AI_MAX_OUTPUT_TOKENS) ||
    (allowCompleteSolution ? DEFAULT_COMPLETE_OUTPUT_TOKENS : DEFAULT_HINT_OUTPUT_TOKENS);
}

function truncate(text, maxLength) {
  const value = String(text || "");
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function guardSolutionLeak(text, allowCompleteSolution) {
  if (allowCompleteSolution) return text;

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

function localFallback(problem, latestMessage, allowCompleteSolution) {
  if (allowCompleteSolution) {
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
      localFallback(problem, latestMessage, false)
    ].join("\n");
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
