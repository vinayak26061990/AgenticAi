const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";

export async function resolveProblemContext(rawContext) {
  const context = String(rawContext || "").trim();
  if (!context) {
    throw new Error("Paste a LeetCode problem statement or link first.");
  }

  const link = extractLeetCodeLink(context);
  const slug = link ? extractSlug(link) : null;
  const pastedStatement = removeUrl(context, link).trim();

  if (slug && pastedStatement.length < 80) {
    const fetched = await fetchLeetCodeProblem(slug);
    if (fetched) return fetched;

    return {
      title: titleFromSlug(slug),
      slug,
      difficulty: "Unknown",
      topics: [],
      source: "link",
      statement: `Only the LeetCode link was provided: ${link}\n\nThe app could not fetch the private/public LeetCode content from this network. Paste the problem statement here for exact coaching.`,
      examples: [],
      constraints: []
    };
  }

  const parsed = parsePastedProblem(context);
  return {
    ...parsed,
    slug,
    source: slug ? "pasted-with-link" : "pasted"
  };
}

function extractLeetCodeLink(text) {
  const match = text.match(/https?:\/\/(?:www\.)?leetcode\.com\/problems\/[a-z0-9-]+\/?/i);
  return match ? match[0] : null;
}

function extractSlug(link) {
  const match = link.match(/\/problems\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function removeUrl(text, link) {
  return link ? text.replace(link, "") : text;
}

async function fetchLeetCodeProblem(slug) {
  try {
    const response = await fetch(LEETCODE_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Referer": `https://leetcode.com/problems/${slug}/`,
        "User-Agent": "Mozilla/5.0 LeetCode Java Coach"
      },
      body: JSON.stringify({
        query: `
          query questionData($titleSlug: String!) {
            question(titleSlug: $titleSlug) {
              questionId
              title
              titleSlug
              content
              difficulty
              topicTags { name slug }
              exampleTestcases
            }
          }
        `,
        variables: { titleSlug: slug }
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    const question = data?.data?.question;
    if (!question) return null;

    const statement = htmlToText(question.content || "");
    return {
      title: question.title || titleFromSlug(slug),
      slug: question.titleSlug || slug,
      questionId: question.questionId || null,
      difficulty: question.difficulty || "Unknown",
      topics: (question.topicTags || []).map(tag => tag.name).filter(Boolean),
      source: "leetcode",
      statement,
      examples: extractExamples(statement),
      constraints: extractConstraints(statement),
      exampleTestcases: question.exampleTestcases || ""
    };
  } catch {
    return null;
  }
}

function parsePastedProblem(text) {
  const clean = text.replace(/\r\n/g, "\n").trim();
  const lines = clean.split("\n").map(line => line.trim()).filter(Boolean);
  const firstSubstantialLine = lines.find(line => line.length > 2) || "LeetCode Problem";
  const title = normalizeTitle(firstSubstantialLine);

  return {
    title,
    difficulty: extractDifficulty(clean),
    topics: extractTopicHints(clean),
    statement: clean,
    examples: extractExamples(clean),
    constraints: extractConstraints(clean)
  };
}

function normalizeTitle(line) {
  return line
    .replace(/^\d+\.\s*/, "")
    .replace(/\s+-\s+LeetCode$/i, "")
    .replace(/\s+\|\s+LeetCode$/i, "")
    .trim()
    .slice(0, 120) || "LeetCode Problem";
}

function extractDifficulty(text) {
  const match = text.match(/\b(Easy|Medium|Hard)\b/i);
  return match ? titleCase(match[1]) : "Unknown";
}

function extractTopicHints(text) {
  const checks = [
    ["Array", /\barray|int\[\]|nums\b/i],
    ["String", /\bstring|substring|character|palindrome\b/i],
    ["HashMap", /\bfrequency|count|duplicate|pair|hash\b/i],
    ["Two Pointers", /\btwo pointers|sorted|left|right|window\b/i],
    ["Sliding Window", /\bsubarray|substring|window|contiguous\b/i],
    ["Binary Search", /\bsorted|binary search|logarithmic|minimum possible|maximum possible\b/i],
    ["Stack", /\bstack|parentheses|bracket|monotonic\b/i],
    ["Queue", /\bqueue|level order|breadth|bfs\b/i],
    ["Tree", /\btree|root|node|binary tree|bst\b/i],
    ["Graph", /\bgraph|edge|node|connected|island|dfs|bfs\b/i],
    ["Dynamic Programming", /\bways|minimum cost|maximum profit|subsequence|dp\b/i],
    ["Heap", /\bkth|top k|priority|median\b/i]
  ];

  return checks
    .filter(([, regex]) => regex.test(text))
    .map(([topic]) => topic)
    .slice(0, 6);
}

function extractExamples(text) {
  const examples = [];
  const regex = /Example\s+\d*:?\s*([\s\S]*?)(?=Example\s+\d*:|Constraints?:|$)/gi;
  let match;
  while ((match = regex.exec(text)) && examples.length < 4) {
    const body = match[1].trim();
    if (body) examples.push(body);
  }
  return examples;
}

function extractConstraints(text) {
  const match = text.match(/Constraints?:\s*([\s\S]*)/i);
  if (!match) return [];

  return match[1]
    .split("\n")
    .map(line => line.replace(/^[-*]\s*/, "").trim())
    .filter(line => line.length > 0)
    .slice(0, 12);
}

function htmlToText(html) {
  return decodeEntities(html)
    .replace(/<pre>/gi, "\n")
    .replace(/<\/pre>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function decodeEntities(text) {
  const entities = {
    "&nbsp;": " ",
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": "\"",
    "&#39;": "'"
  };

  return text.replace(/&(nbsp|lt|gt|amp|quot);|&#39;/g, entity => entities[entity] || entity);
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map(titleCase)
    .join(" ");
}

function titleCase(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}
