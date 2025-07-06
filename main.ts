import fetch, { Headers, Request, Response } from 'node-fetch';
(globalThis as any).fetch   = fetch;
(globalThis as any).Headers = Headers;
(globalThis as any).Request = Request;
(globalThis as any).Response= Response;
import { Plugin, Notice, PluginSettingTab, Setting, Modal, App, MarkdownView, requestUrl, TFile} from 'obsidian';
import { GoogleGenAI } from '@google/genai';
import cosineSimilarity from 'cosine-similarity';
import PQueue from 'p-queue';

interface SummarizeResponse {
  candidates: { content: string }[];
}
interface NoteEmbedding { path: string; embedding: number[] }
interface Settings {
  apiKey: string;
  model: string; // e.g. 'gemini-2.0-flash'
  hfToken: string;
  embedModel: string; 
}
interface EmbeddingIndexEntry {
  mtime: number;
  embedding: number[];
}

const VAULT_ROOT = process.cwd();

const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'gemini-2.0-flash',
  hfToken: '',
  embedModel: 'models/gemini-embedding-exp-03-07'
};

export default class OraculumPlugin extends Plugin {
  settings!: Settings;
  ai?: GoogleGenAI;

  private embedQueue!: PQueue;
  private index: Record<string, EmbeddingIndexEntry> = {};

  async onload() {
    const loaded = (await this.loadData()) ?? {};
    // Load persisted settings or defaults
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.ai = new GoogleGenAI({ apiKey: this.settings.apiKey });
    this.index = (await this.loadData())?.embeddings || {};

    const modelName = this.settings.embedModel;
    console.log("▶️ embedding with model:", modelName);

    this.embedQueue = new PQueue({
      concurrency: 1,           // one batch at a time
      intervalCap: 140,          // <=10 tasks per interval
      interval: 60_000,         // 60 000 ms = 1 minute
      carryoverConcurrencyCount: true
    });

    this.buildEmbeddingIndex(13);

    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          try {
            await this.indexFileEmbedding(file);
            console.log(`[Oraculum] Embedded on open: ${file.path}`);
          } catch (e) {
            console.error(`[Oraculum] Embed-on-open failed:`, e);
          }
        }
      })
    );

    // handles renames so your keys stay in sync
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          // move embedding entry
          this.index[file.path] = this.index[oldPath];
          delete this.index[oldPath];
          await this.saveData({ ...this.settings, embeddings: this.index });
        }
      })
    );

    // Add settings tab for API key & model
    this.addSettingTab(new (class extends PluginSettingTab {
      plugin!: OraculumPlugin;
      display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Gemini API Settings' });
        
        new Setting(containerEl)
        .setName('API Key')
        .setDesc('Your Google Generative Language API key')
        .addText(text =>
          text
          .setPlaceholder('Enter API key')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            this.plugin.initializeAi();
          })
        );
        
        new Setting(containerEl)
        .setName('Model')
        .setDesc('Gemini model, e.g. gemini-2.0-flash')
        .addText(text =>
          text
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
          })
        );
        
        }        
          constructor(plugin: OraculumPlugin) {
            super(plugin.app, plugin);
            (this as any).plugin = plugin;
          }
        })(this));
        
        this.initializeAi();
        
        // Summarize Selection
        this.addCommand({
          id: 'summarize-selection',
          name: 'Summarize Selection',
          editorCallback: (editor) => this.handleEditor(editor, 'short'),
        });
        // Expand Selection
        this.addCommand({
          id: 'expand-selection',
          name: 'Expand Selection',
          editorCallback: (editor) => this.handleEditor(editor, 'detailed'),
        });
        this.addCommand({
          id: 'ask-gemini',
          name: 'Ask the Oraculum',
          editorCallback: (editor) => this.askGemini(editor),
        });

        this.addCommand({
          id: 'tag-current-note',
          name: 'Suggest tags for current note',
          callback: async () => {
            const file = this.app.workspace.getActiveFile();
            if (file) {
              await this.suggestTagsFor(file);
            } else {
              new Notice('No active note to tag.');
            }
          },
        });       
    
        this.addCommand({
          id: 'show-related-notes',
          name: 'Show Semantic Related Notes (Ctrl+Shift+L)',
          callback: () => this.handleShowRelatedNotes(13)
        });

        this.addCommand({
          id: 'expand-from-title',
          name: 'Create Note from Title',
          callback: () => this.createNoteFromTitle()
        });

        await this.embedQueue.onIdle();
  }

  initializeAi(): void {
    if (!this.settings.apiKey) {
      this.ai = undefined;
      new Notice('⚠️ Please enter your API key in plugin settings.');
      return;
    }
    try {
      this.ai = new GoogleGenAI({ apiKey: this.settings.apiKey });
    } catch (e) {
      console.error('GenAI init failed:', e);
      this.ai = undefined;
      new Notice('❌ Invalid API key—please re-enter it.');
    }
  }

  getRelated(currentPath: string, topK = 5) {
    console.log('[Oraculum:getRelated] 🔍 called for:', currentPath);
    console.log('[Oraculum:getRelated] index size:', Object.keys(this.index).length);

    const currEmbedding = this.index[currentPath]?.embedding;
    if (!currEmbedding) {
      console.warn('[Oraculum:getRelated] no embedding for', currentPath);
      return [];
    }

    const scores = Object.entries(this.index)
      .filter(([path]) => path !== currentPath)
      .map(([path, { embedding }]) => ({
        path,
        score: cosineSimilarity(currEmbedding, embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    console.log('[Oraculum:getRelated] scores:', scores);
    return scores;
  }

  private async handleShowRelatedNotes(Batch: number) {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView?.file) {
      new Notice("No note is open right now");
      return;
    }
    const file = mdView.file;

    // ensure the vault index exists
    if (Object.keys(this.index).length === 0) {
      new Notice("🔄 Building embeddings for all notes…");
      await this.buildEmbeddingIndex(13);
      new Notice("✅ Embedding complete.");
    }

    // embed this note if needed
    if (!this.index[file.path]) {
      await this.indexFileEmbedding(file);
      new Notice("✅ Embedded current note.");
      this.queueAllOtherEmbeddings(file.path);
      new Notice("🕒 Queued other notes for embedding (≤10/min).");
    }
    
    const related = this.getRelated(file.path);
    if (related.length) {
      await this.upsertRelatedSection(file, related);
      new Notice(`🔗 Appended top ${Math.min(related.length, 3)} related notes.`);
    } else {
      new Notice('⚠️ No related notes to append.');
    }
  }

  async suggestTagsFor(file: TFile) {
    if (!this.ai) return;

    const content = await this.app.vault.read(file);
    const prompt = `
You are an assistant that reads a markdown note and suggests up to five concise tags reflecting its main topics and domain.
Here is the note content:

"""${content}"""

Return your answer as a comma-separated list (no '#' prefix), e.g. Ai, Ethics, Philosophy.
Give only unique tags, no duplicates
`;
    try {
      const resp = await this.ai.models.generateContent({
        model: this.settings.model,
        contents: [{ text: prompt }],
        config: { temperature: 0.1 },
      });
      // Accumulate every chunk.text into one raw string
      const raw = resp.text ?? resp.candidates?.[0]?.content;
      if (typeof raw !== 'string' || raw.trim() === '') {
        new Notice('⚠️ No tags returned from the AI');
        return;
      }

      // Now parse out up to five “#tag” tokens
      const tags = raw
        .trim()
        .split(/[,;\n]/)
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .slice(0, 5);
      
      console.log(tags)
      
      if (!tags.length) {
        new Notice('⚠️ No tags to apply.');
        return;
      }

      // 3. Build new frontmatter
      const tagLine = `tags: ${tags.join(' ')}`;
      let newContent: string;
      if (/^---\r?\n/.test(content)) {
        if (/^tags:.*$/m.test(content)) {
          newContent = content.replace(/^tags:.*$/m, tagLine);
        } else {
          newContent = content.replace(/^---\r?\n/, `---\n${tagLine}\n`);
        }
      } else {
        newContent = `---\n${tagLine}\n---\n\n${content}`;
      }

      // 4. Save back to the vault
      await this.app.vault.modify(file, newContent);
      new Notice(`Updated tags: ${tags.join(' ')}`);
    } catch (e: any) {
      console.error('Tag suggestion error', e);
      new Notice('❌ Failed to generate tags.');
    }
  }

  private async upsertRelatedSection(file: TFile, related: { path: string; score: number }[]) {
    // 1. Read the existing file
    let content = await this.app.vault.read(file);

    // 2. Strip out any old “## Related Notes” section
    content = content.replace(
      /## Related Notes[\s\S]*$/m,
      ''
    );

    // 3. Build the new section
    const topThree = related.slice(0, 3);
    const lines = topThree.map(
      r => `- [[${r.path.replace(/\.md$/, '')}]] (${r.score.toFixed(3)})`
    );
    const section = `\n## Related Notes\n${lines.join('\n')}\n`;

    // 4. Write it back
    await this.app.vault.modify(file, content + section);
  }

  private queueAllOtherEmbeddings(skipPath?: string) {
    const allFiles = this.app.vault.getMarkdownFiles();
    const toEmbed = allFiles.filter(f =>
      f.path !== skipPath &&        // don’t re-embed current
      !this.index[f.path]           // only files not yet in the index
    );
    console.log(`[Oraculum] ▶️ Queuing ${toEmbed.length} other files for embedding…`);
    toEmbed.forEach(f =>
      this.embedQueue.add(() => this.indexFileEmbedding(f))
    );
  }

  private async buildEmbeddingIndex(BATCH: number) {
    const files = this.app.vault.getMarkdownFiles();
    const stale: TFile[] = [];
    for (const f of files) {
      const stat = await this.app.vault.adapter.stat(f.path);
      if (!this.index[f.path] || this.index[f.path].mtime !== stat!.mtime) {
        stale.push(f);
      }
    }
    console.log(`[Oraculum] 🔍 buildEmbeddingIndex found ${stale.length} files to embed`);
    
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      console.log(`[Oraculum] ➕ queueing batch ${i/BATCH + 1} (${batch.length} files)`);
      this.embedQueue.add(() => this.indexBatch(batch));
    }
    await this.embedQueue.onIdle();
    console.log("[Oraculum] 🛑 buildEmbeddingIndex: all batches finished");
    await this.saveData({ ...this.settings, embeddings: this.index });
    new Notice('✅ Initial embedding index complete');
  }

  private async indexBatch(files: TFile[], attempt = 0) {
    console.log(`[Oraculum] ▶️ indexBatch start (${files.length} files), attempt #${attempt}`);
    try {
      for (const file of files) {
        await this.indexFileEmbedding(file);
      }
      console.log(`[Oraculum] ✔️ indexBatch succeeded for ${files.length} files`);
    } catch (err : any) {
      if ((err.status === 429 || err.message.includes("exhausted")) && attempt < 5) {
        const backoff = Math.min(60000, 1000 * 2 ** attempt);
        setTimeout(() =>
          this.embedQueue.add(() => this.indexBatch(files, attempt + 1))
        , backoff);
        return;
      }
      console.error("Batch embed failed:", err);
    }
  }

  private async indexFileEmbedding(file: TFile) {
    console.log(`[Oraculum] ✏️ indexFileEmbedding: ${file.path}`);
    try {
      const stat = await this.app.vault.adapter.stat(file.path);
      if (this.index[file.path]?.mtime === stat!.mtime) {
        return;
      }
      const text = await this.app.vault.read(file);
      const resp = await this.ai!.models.embedContent({
        model: this.settings.embedModel,
        contents: text,
      });

  
      const raw = resp.embeddings;
      if (!raw || raw.length === 0) {
        throw new Error("No embeddings returned for single file");
      }
      const first = raw[0];
      let vector: number[];
      if (Array.isArray(first)) {
        vector = first;
      } else if (Array.isArray((first as any).values)) {
        vector = (first as any).values as number[];
      } else if ((first as any).embedding && Array.isArray((first as any).embedding.values)) {
        vector = (first as any).embedding.values as number[];
      } else {
        throw new Error("Unable to extract vector from embedding object");
      }

      this.index[file.path] = { mtime: stat!.mtime, embedding: vector };
      await this.saveData({ ...this.settings, embeddings: this.index });
    } catch (e) {
      console.error(`Embed failed for ${file.path}:`, e);
    }
  }

  /**
   * “Type out” `fullText` into the given editor, one chunk at a time.
   * @param editor   The CodeMirror editor instance
   * @param fullText The complete response string
   * @param delayMs  How many milliseconds between each chunk
   * @param chunkSize How many characters per chunk
   */
  private simulateTyping(
    editor: import('obsidian').Editor,
    fullText: string,
    delayMs = 20,
    chunkSize = 1
  ) {
    let offset = 0;
    const insertNext = () => {
      if (offset >= fullText.length) return;
      const slice = fullText.substr(offset, chunkSize);
      editor.replaceSelection(slice);
      offset += chunkSize;
      setTimeout(insertNext, delayMs);
    };
    insertNext();
  }

  async handleEditor(editor: import('obsidian').Editor, mode: 'short' | 'detailed') {
    if (!this.ai) {
      new Notice('No API key set – open Settings and paste your key.');
      return;
    }

    const text = editor.getSelection();
    if (!text) { new Notice('Select text first'); return; }

    // Outline the style prompt so that it can give me a standardized format in the same style that i have
    const stylePrompt = `Mimic the tone, formatting, and language style of the following text when summarizing or expanding it.`;

    const prompt =
      mode === 'short'
        ? `Provide a concise summary of the following text, keeping the existing obsidian links:\n\n${text}`
        : `Provide a detailed expansion of the following section that has been written:\n\n${text}`;

     try {
      const ai = this.ai;
      const resp = await ai.models.generateContent({
        model: this.settings.model,
        contents: [
          // System prompt goes first:
          {
            text: `You are an AI assistant embedded in Obsidian, the note taking application.  
            You know about Obsidian’s markdown conventions, backlinks, and editor UX—always respond in valid markdown suitable for Obsidian.
            Highlight the most important techniques, algorithms and topics in double sqaure brackets so that they can be a sepearte note
            Only output the answer in Markdown, do NOT include any introductory or concluding remarks`,
          },
          // Then the actual user prompt:
          { text: `${stylePrompt}\n\n${prompt}` },
        ],
        config: {
          temperature: 0.5,
        },
      });

      const fullText = resp.text 
        ?? resp.candidates?.[0]?.content;
      if (typeof fullText !== 'string') {
        new Notice('⚠️ No content returned to type out');
        return;
      }

      editor.replaceSelection('');

      this.simulateTyping(editor, fullText, 25, 30);

      const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!mdView?.file) return;
      await this.ensureIndexed(mdView.file);

    } catch (e) {
      console.error(e);
      new Notice('Error querying the oracle.');
    }
  }

  async askGemini(editor: import('obsidian').Editor) {
    if (!this.ai) {
      new Notice('No API key set – open Settings and paste your key.');
      return;
    }
    const question = editor.getSelection();
    if (!question) {
      new Notice('Select a question or prompt first.');
      return;
    }

    try {
      const ai = this.ai;
      const resp = await ai.models.generateContent({
        model: this.settings.model,
        contents: [
          // Minimal system prompt: no Obsidian-specific tone enforcement
          {
            text: `You are an AI assistant embedded in Obsidian, the note taking application.  
            You know about Obsidian’s markdown conventions, backlinks, and editor UX—always respond in valid markdown suitable for Obsidian.
            Highlight the most important techniques, algorithms and topics in double sqaure brackets so that they can be a sepearte note
            Only output the answer in Markdown, do NOT include any introductory or concluding remarks.`,
          },
          { text: question },
        ],
        config: {
          temperature: 0.5,
        },
      });

      const fullText = resp.text 
        ?? resp.candidates?.[0]?.content;
      if (typeof fullText !== 'string') {
        new Notice('⚠️ No content returned to type out');
        return;
      }

      editor.replaceSelection('');

      this.simulateTyping(editor, fullText, 25, 30);

      const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!mdView?.file) return;
      await this.ensureIndexed(mdView.file);

    } catch (e) {
      console.error(e);
      new Notice('Error calling Gemini.');
    }
  }

  private async createNoteFromTitle() {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView?.file) {
      new Notice("No note is open right now");
      return;
    }
    const file   = mdView.file;
    const editor = mdView.editor;
    const title  = file.basename;

    if (!this.ai) {
      new Notice("AI not initialized – set your API key first.");
      return;
    }

    const prompt = `Write a comprehensive Obsidian-style note titled "${title}". 
  The note should be informative, use markdown formatting, include bullet points or headings where useful, and use [[wikilinks]] for key terms or ideas that could be their own notes. 
  If there is existing content (tags or text), just add to it. Do not remove it completely`;

    try {
      const resp = await this.ai.models.generateContent({
        model: this.settings.model,
        contents: [
          { text: "You are an AI assistant embedded in Obsidian. Write markdown notes suitable for the Obsidian vault environment. Avoid the initial markdown tag. Avoid putting the note title in the content" },
          { text: prompt }
        ],
        config: { temperature: 0.5 },
      });

      const fullText = resp.text ?? resp.candidates?.[0]?.content;
      if (typeof fullText !== 'string') {
        new Notice('⚠️ No content returned to type out');
        return;
      }

      editor.replaceSelection('');
      this.simulateTyping(editor, fullText, 25, 30);
      new Notice(`✅ "${title}" expanded from title`);

      await this.ensureIndexed(file);
    } catch (e) {
      console.error('Failed to expand note:', e);
      new Notice('❌ Failed to generate content from title');
    }
  }


  private async ensureIndexed(file: TFile) {
    const stat = await this.app.vault.adapter.stat(file.path);
    const existing = this.index[file.path];
    if (!existing || existing.mtime < stat!.mtime) {
      await this.indexFileEmbedding(file);
    }
  }

  onunload() {}
}