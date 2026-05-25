import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentReply } from "./src/agent.js";
import { resolveProblemContext } from "./src/leetcode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/problem") {
      const body = await readJson(req);
      const problem = await resolveProblemContext(body.context || "");
      sendJson(res, { problem });
      return;
    }

    if (req.method === "POST" && req.url === "/api/coach") {
      const body = await readJson(req);
      const reply = await buildAgentReply({
        problem: body.problem,
        messages: Array.isArray(body.messages) ? body.messages : []
      });
      sendJson(res, reply);
      return;
    }

    sendJson(res, { error: "Route not found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    sendJson(res, { error: message }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`LeetCode Java Coach running at http://${host}:${port}`);
});

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, { error: "Forbidden" }, 403);
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, { error: "File not found" }, 404);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1_500_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const splitAt = trimmed.indexOf("=");
    if (splitAt === -1) continue;

    const key = trimmed.slice(0, splitAt).trim();
    const value = trimmed.slice(splitAt + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
