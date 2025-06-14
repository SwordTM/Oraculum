import { Plugin, Notice, PluginSettingTab, Setting } from 'obsidian';
import { GoogleGenAI } from '@google/genai';

interface SummarizeResponse {
  candidates: { content: string }[];
}

interface Settings {
  apiKey: string;
  model: string; // e.g. 'gemini-2.0-flash'
}

const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'gemini-2.0-flash',
};

export default class OraculumPlugin extends Plugin {
  settings: Settings;
  ai?: GoogleGenAI;

  async onload() {
    // Load persisted settings or defaults
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Add settings tab for API key & model
    this.addSettingTab(new (class extends PluginSettingTab {
      plugin: OraculumPlugin;
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
                await this.plugin.saveData(this.plugin.settings);
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
                await this.plugin.saveData(this.plugin.settings);
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
      const stream = await ai.models.generateContentStream({
        model: this.settings.model,
        contents: [
          // System prompt goes first:
          {
            text: `You are an AI assistant embedded in Obsidian, the note taking application.  
            You know about Obsidian’s markdown conventions, backlinks, and editor UX—always respond in valid markdown suitable for Obsidian.
            Highlight the most important techniques, algorithms and topics in double sqaure brackets so that they can be a sepearte note`,
          },
          // Then the actual user prompt:
          { text: `${stylePrompt}\n\n${prompt}` },
        ],
        config: {
          temperature: 0.5,
        },
      });

      editor.replaceSelection('');

      // As each chunk arrives, append it
      for await (const chunk of stream) {
        // Gemini stream chunks expose `.text`
        const piece = chunk.text;
        if (piece) {
          editor.replaceSelection(piece);
        }
      }

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
      const stream = await ai.models.generateContentStream({
        model: this.settings.model,
        contents: [
          // Minimal system prompt: no Obsidian-specific tone enforcement
          {
            text: `You are an AI assistant embedded in Obsidian, the note taking application.  
            You know about Obsidian’s markdown conventions, backlinks, and editor UX—always respond in valid markdown suitable for Obsidian.
            Highlight the most important techniques, algorithms and topics in double sqaure brackets so that they can be a sepearte note`,
          },
          { text: question },
        ],
        config: {
          temperature: 0.4,
        },
      });

      editor.replaceSelection('');

      for await (const chunk of stream) {
        const piece = chunk.text;
        if (piece) {
          editor.replaceSelection(piece);
        }
      }

    } catch (e) {
      console.error(e);
      new Notice('Error calling Gemini.');
    }
  }



  onunload() {}
}