const state = {
  problem: null,
  messages: []
};

const elements = {
  problemInput: document.querySelector("#problemInput"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  loadSampleBtn: document.querySelector("#loadSampleBtn"),
  problemMeta: document.querySelector("#problemMeta"),
  responseOutput: document.querySelector("#responseOutput"),
  chatLog: document.querySelector("#chatLog"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  modelBadge: document.querySelector("#modelBadge"),
  lockBadge: document.querySelector("#lockBadge"),
  tabs: document.querySelectorAll(".tab"),
  coachView: document.querySelector("#coachView"),
  conversationView: document.querySelector("#conversationView"),
  quickActions: document.querySelectorAll(".quick-actions button")
};

const sampleProblem = `1. Two Sum
Easy

Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.

You may assume that each input would have exactly one solution, and you may not use the same element twice.

You can return the answer in any order.

Example 1:
Input: nums = [2,7,11,15], target = 9
Output: [0,1]
Explanation: Because nums[0] + nums[1] == 9, we return [0, 1].

Example 2:
Input: nums = [3,2,4], target = 6
Output: [1,2]

Example 3:
Input: nums = [3,3], target = 6
Output: [0,1]

Constraints:
2 <= nums.length <= 10^4
-10^9 <= nums[i] <= 10^9
-10^9 <= target <= 10^9
Only one valid answer exists.`;

elements.analyzeBtn.addEventListener("click", analyzeProblem);
elements.clearBtn.addEventListener("click", clearAll);
elements.loadSampleBtn.addEventListener("click", () => {
  elements.problemInput.value = sampleProblem;
  elements.problemInput.focus();
});

elements.chatForm.addEventListener("submit", event => {
  event.preventDefault();
  const message = elements.chatInput.value.trim();
  if (!message) return;
  elements.chatInput.value = "";
  sendCoachMessage(message);
});

for (const button of elements.quickActions) {
  button.addEventListener("click", () => {
    sendCoachMessage(button.dataset.prompt);
  });
}

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
}

async function analyzeProblem() {
  const context = elements.problemInput.value.trim();
  if (!context) {
    showError("Paste a LeetCode problem statement or link first.");
    return;
  }

  setBusy(true);
  showCoachText("Reading the problem context...");

  try {
    const { problem } = await postJson("/api/problem", { context });
    state.problem = problem;
    state.messages = [
      {
        role: "user",
        content: "Start coaching me on this LeetCode problem. Give guidelines, hints, examples, diagrams, edge cases, and Java-specific approach notes. Do not provide the complete solution."
      }
    ];
    renderProblemMeta(problem);

    const reply = await postJson("/api/coach", {
      problem: state.problem,
      messages: state.messages
    });

    state.messages.push({ role: "assistant", content: reply.content });
    renderAssistantReply(reply);
    renderChat();
    setTab("coach");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function sendCoachMessage(content) {
  if (!state.problem) {
    showError("Analyze a problem before chatting with the coach.");
    return;
  }

  const isCompleteSolutionRequest = /\bcomplete solution\b/i.test(content);
  state.messages.push({ role: "user", content });
  renderChat();
  setTab("conversation");
  setBusy(true);
  showCoachText(isCompleteSolutionRequest
    ? "Generating the complete Java implementation, walkthrough, and complexity analysis..."
    : "Generating the next coaching response...");

  try {
    const reply = await postJson("/api/coach", {
      problem: state.problem,
      messages: state.messages
    });

    state.messages.push({ role: "assistant", content: reply.content });
    renderAssistantReply(reply);
    renderChat();
  } catch (error) {
    state.messages.push({ role: "assistant", content: `Error: ${error.message}`, error: true });
    renderChat();
  } finally {
    setBusy(false);
  }
}

function renderAssistantReply(reply) {
  elements.responseOutput.classList.remove("empty-state");
  elements.responseOutput.innerHTML = markdownToHtml(reply.content);
  elements.modelBadge.textContent = `Model: ${reply.model || "unknown"}`;
  elements.lockBadge.textContent = reply.solutionLocked ? "Solution locked" : "Solution unlocked";
  elements.lockBadge.classList.toggle("locked", Boolean(reply.solutionLocked));
  elements.lockBadge.classList.toggle("open", !reply.solutionLocked);
}

function renderProblemMeta(problem) {
  elements.problemMeta.innerHTML = `
    <div>
      <dt>Title</dt>
      <dd title="${escapeHtml(problem.title || "Unknown")}">${escapeHtml(problem.title || "Unknown")}</dd>
    </div>
    <div>
      <dt>Difficulty</dt>
      <dd>${escapeHtml(problem.difficulty || "Unknown")}</dd>
    </div>
    <div>
      <dt>Source</dt>
      <dd>${escapeHtml(problem.source || "pasted")}</dd>
    </div>
  `;
}

function renderChat() {
  elements.chatLog.innerHTML = state.messages
    .filter(message => message.role !== "system")
    .map(message => {
      const role = message.role === "assistant" ? "assistant" : "user";
      const errorClass = message.error ? " error" : "";
      return `<div class="message ${role}${errorClass}">${markdownToHtml(message.content)}</div>`;
    })
    .join("");
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function setTab(name) {
  for (const tab of elements.tabs) {
    tab.classList.toggle("is-active", tab.dataset.tab === name);
  }

  elements.coachView.classList.toggle("is-active", name === "coach");
  elements.conversationView.classList.toggle("is-active", name === "conversation");
}

function clearAll() {
  state.problem = null;
  state.messages = [];
  elements.problemInput.value = "";
  elements.responseOutput.className = "markdown-output empty-state";
  elements.responseOutput.textContent = "Paste a problem and analyze it to start.";
  elements.chatLog.innerHTML = "";
  elements.modelBadge.textContent = "Model: local";
  elements.lockBadge.textContent = "Solution locked";
  elements.lockBadge.classList.add("locked");
  elements.lockBadge.classList.remove("open");
  renderProblemMeta({ title: "Not loaded", difficulty: "Unknown", source: "None" });
}

function showCoachText(text) {
  elements.responseOutput.classList.add("empty-state");
  elements.responseOutput.textContent = text;
}

function showError(text) {
  elements.responseOutput.className = "markdown-output";
  elements.responseOutput.innerHTML = `<div class="message error">${escapeHtml(text)}</div>`;
}

function setBusy(isBusy) {
  document.body.classList.toggle("is-loading", isBusy);
  elements.analyzeBtn.disabled = isBusy;
  elements.chatForm.querySelector("button").disabled = isBusy;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function markdownToHtml(markdown) {
  const source = String(markdown || "");
  const blocks = [];
  const withoutCode = source.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `@@CODE_BLOCK_${blocks.length}@@`;
    blocks.push(`<pre><code class="language-${escapeHtml(lang || "text")}">${escapeHtml(code.trim())}</code></pre>`);
    return token;
  });

  const lines = withoutCode.split(/\n/);
  const html = [];
  let listType = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const codeToken = trimmed.match(/^@@CODE_BLOCK_(\d+)@@$/);
    if (codeToken) {
      closeList();
      html.push(blocks[Number(codeToken[1])]);
      continue;
    }

    if (/^###\s+/.test(trimmed)) {
      closeList();
      html.push(`<h3>${inlineMarkdown(trimmed.replace(/^###\s+/, ""))}</h3>`);
      continue;
    }

    if (/^##\s+/.test(trimmed)) {
      closeList();
      html.push(`<h2>${inlineMarkdown(trimmed.replace(/^##\s+/, ""))}</h2>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      openList("ol");
      html.push(`<li>${inlineMarkdown(trimmed.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      openList("ul");
      html.push(`<li>${inlineMarkdown(trimmed.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }

  closeList();
  return html.join("");

  function openList(type) {
    if (listType === type) return;
    closeList();
    listType = type;
    html.push(`<${type}>`);
  }

  function closeList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  }
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
