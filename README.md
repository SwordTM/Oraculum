# Oraculum

Oraculum is your AI-powered assistant inside Obsidian, designed to help you write, expand, summarize, and tag your notes, all without ever leaving the editor.

## Core AI Assistant Features

**Ask the Oraculum**
- Pose any question or prompt (on the note), select it, and get a concise, Markdown-formatted answer directly in your note.

**Summarize Selection**
- Generate a clear, link-aware summary of the text you’ve highlighted, preserving your Obsidian backlinks.

**Expand Selection**
- Flesh out an idea or section with richer detail, examples, and [[wikilinks]]—perfect for brainstorming or deepening explanations.

**Create Note from Title**
- Turn a file’s title into a full-fledged note skeleton, complete with headings, bullet points, and suggested links.

**Suggest Tags for Current Note**
- Automatically generate up to five concise front-matter tags based on your note’s content.

**Semantic Related Notes** (**Still under development**)
Appends a ## Related Notes section to your note, ranking the top 3 closest notes by cosine similarity.

## Installation

- Clone this repo.
- Make sure your NodeJS is at least v16 (`node --version`).
- `npm i` or `yarn` to install dependencies.
- `npm run dev` to start compilation in watch mode.

1. Clone into your vault

```bash
  git clone https://github.com/SwordTM/Oraculum.git \
  "<Your-Vault>/.obsidian/plugins/Oraculum"
```
2. Install & build

```bash
  cd "<Your-Vault>/.obsidian/plugins/Oraculum"
  npm install
  npm run build
```

3. Enable

- Open Obsidian → Settings → Community plugins
- Disable Safe mode (if on)
- Find “Oraculum” and toggle it on

## Configuration

- Open Settings → Oraculum.
- Paste your Google Generative Language API key.
- Choose your preferred Gemini model for text generation.
- Reload the plugin to apply changes.