# Claude Project Guide: LeetCode Java Coach

This document provides instructions for Claude when working on this codebase.

## Project Overview
LeetCode Java Coach is a local web application designed to assist developers in solving LeetCode problems using Java. It provides hints, guidance, and code reviews using various AI backends.

## Key Technologies
- **Frontend**: Vanilla JavaScript, HTML5, CSS3.
- **Backend**: Node.js (using built-in modules).
- **AI Providers**: Local (deterministic), Ollama, and OpenAI-compatible APIs.

## Core Features
- **Coaching**: Provides approach guidance, examples, and ASCII diagrams for LeetCode problems.
- **Solution Review**: Analyzes Java code for syntax, correctness, complexity, and edge cases.
- **Solution Unlocking**: The full solution is hidden until the phrase `complete solution` is used in the chat.

## Development Workflow
- **Running the app**: Execute `npm start`.
- **Configuration**: Use `.env` to configure the `AI_PROVIDER`, `AI_BASE_URL`, and `AI_MODEL`.
- **Testing**: Verify logic in `src/agent.js` and UI interactions in `public/app.js`.

## Coding Standards
- **Simplicity**: Prefer using Node.js built-ins where possible.
- **Java-Centric**: All AI-generated guidance and reviews must focus on Java syntax and best practices.
- **Error Handling**: Ensure robust error handling for network requests to AI providers.
