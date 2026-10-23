# Home + AI (AI optional)

A home screen for your Obsidian vault with live vault stats, widgets you can put in any note, an AI chat that lives in a tab or sidebar, and an AI spell and grammar checker. Works on desktop, iPhone and iPad.

## Features

### Home screen
- Opens when Obsidian starts and replaces the blank "New tab" page (both optional).
- Two styles:
  - **Modern**: greeting and clock, note search, quick action tiles, your recent notes and vault stats.
  - **Dashboard**: logo and title, search, quick actions, clock, calendar, vault summary, recent notes and vault stats.
- **Vault stats**, kept up to date as you write. Word counts cover your writing only: frontmatter, `%%comments%%` and plugin data (Excalidraw drawings, Dataview queries) are skipped, and Sheet Plus spreadsheets count the text in their cells. Stats include total words and words written today, characters, words per note, time to read everything, links, notes added this week and month, unlinked notes, attachments, task progress, and your longest and most-linked notes.
- Backgrounds: accent glow, plain, or illustrated scenes (night sky with cabin, moonlit lake, aurora, sunset dunes, ocean dawn, sunny meadow, rainy city), plus **Auto**, which changes scene with the time of day. Scenes are drawn in code at your window size, with no image files, and respect the system's reduce-motion setting.
- The calendar opens or creates daily notes using your core **Daily notes** folder, date format and template.

### Widgets in notes
Put a live widget in any note: run **Insert widget** from the command palette, or add a code block yourself:

````markdown
```home-widget
stats
```
````

Widgets: `stats` (vault stats), `words` (word count), `clock`, `calendar`, `vault` (vault summary) and `recent` (recent notes). A note with widgets also shows them on a canvas.

### Graph view
Optionally draws the lines between linked notes in purple (on by default; reopen graph view after changing it).

### AI chat
- Opens in the left sidebar, right sidebar or a tab, and can move between them without losing the conversation.
- Works with **Anthropic (Claude)**, **OpenAI**, **OpenRouter**, or any OpenAI-compatible server such as **Ollama** or **LM Studio**.
- **Works with your notes:** the AI can read the note you have open and, with vault access on (the library button in the chat header), search and read any note to answer you. Small labels under each reply show which notes it searched or read.
- **Edits only with your permission:** when the AI wants to change or create a note, the chat shows the exact change (removed lines in red, added lines in green) with **Approve** and **Reject**. Nothing is saved until you approve. It can't write to Obsidian's settings folder.
- Attach the current note as context, copy replies, insert replies into your note, regenerate, and save a chat as a note.
- **Effort**: choose how hard the AI thinks (model default, low, medium, high, extra high or max) in settings or from the model menu in the chat.
- **Chat history**: every conversation is saved; search, reopen or delete past chats.
- **Long-term memory**: when you tell it something lasting (or say "remember that…"), the AI adds a short line to a normal note, `AI Memory.md` by default, and reads that note at the start of every chat. Say "forget that…" to remove something, or edit the note yourself. You can turn memory off, pick another note, or have it ask before saving anything.

### Spell check
- Uses your AI model to find spelling, punctuation and grammar mistakes, and sentences that don't make sense.
- Either lists each problem with a suggested fix (fix one at a time, jump to it, or fix all), or fixes everything at once. Fixing everything is a single undo step.
- Checks the selected text, or the whole note if nothing is selected.
- Run it from the command palette, the right-click menu in a note, or by typing `/` with Obsidian's core **Slash commands** plugin turned on.
- Spelling variants: Australian, British, American, Canadian and New Zealand English.

### Voice notes
- Press the **microphone** in the left ribbon (or run "Record voice note") to start recording. A bar across the top of the window shows a live audio line, the time, and **pause** and **stop** buttons.
- When you stop, a new note opens with the recording in it. With AI on, the recording is turned into text and your AI model writes a title, summary, key points and action items, followed by the full transcript.
- Claude can't listen to audio, so the speech-to-text step uses **OpenAI** (gpt-4o-transcribe), an audio model on **OpenRouter**, or your own Whisper-compatible server. Add one of those keys in settings; the notes are then written by whichever model you normally use.
- The recording is always kept in your attachments folder, so nothing is lost if a step fails. Works on desktop, iPhone and iPad (allow microphone access when asked).

### On/off switches
Turn the **home screen**, **voice notes** or the **AI features** off in settings (or with the "Turn home screen on or off" and "Turn AI on or off" commands). With AI off, nothing is sent to any AI provider.

### Ribbon spacers (desktop)
Adds a few small gaps to the left ribbon so you can group your icons. Hold the command key (control on Windows) to make them easy to see, then drag them like any ribbon icon.

## Setup

1. Install and enable **Home + AI (AI optional)** from **Settings → Community plugins**.
2. Open **Settings → Home + AI (AI optional)**, choose a provider and paste your API key (not needed for a local server).
3. Pick a home style and background under **Home screen**.

## Commands

| Command | What it does |
| --- | --- |
| Open home screen | Shows the home screen |
| Open AI chat | Opens the chat in your default location (or in the left sidebar, right sidebar or a new tab) |
| Ask AI about current note | Opens the chat with the current note attached |
| Spell check | Runs spell check in your chosen mode |
| Spell check: list problems with fixes | Always shows the list |
| Spell check: fix everything | Always fixes everything |
| Insert widget | Adds a widget to the current note |
| Open AI memory note | Opens the note the AI remembers things in |
| Record voice note (start or stop) | Starts a recording, or stops it and makes the note |
| Pause or resume recording | Pauses or resumes the current recording |

## Privacy and network use

This plugin needs an account with an AI provider to use chat, spell check and voice note transcription.

- **What is sent:** your chat messages, the note you attach, notes the AI reads or searches while answering (only with vault access on, except the open note), and the text you spell check are sent to the AI provider you choose: `api.anthropic.com`, `api.openai.com`, `openrouter.ai`, or the custom server address you enter. Nothing is sent until you send a message or run spell check.
- **API keys** are stored in this plugin's `data.json` inside your vault's config folder. If you sync your vault, the keys sync too.
- **Chat history** is stored in `chats.json` in the same folder, and never leaves your device except through your own vault sync.
- **Voice notes**: recordings are saved in your vault. With AI on, the audio is sent to the transcription service you chose (`api.openai.com`, `openrouter.ai` or your custom server), and the transcript to your AI provider. The microphone is only on while the recording bar is showing.
- **Memory**: with memory on, the contents of your memory note are sent to your AI provider at the start of each chat.
- There is **no telemetry, analytics or tracking**, and the plugin doesn't load anything from the internet other than the AI requests above.

Using an AI provider may cost money; check your provider's pricing.

## Building from source

```bash
npm install
npm run build   # type-checks and writes main.js
npm run lint    # Obsidian's recommended lint rules
```

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/home-llm/` to test.

## Credits

The Obsidian name and logo are trademarks of Dynalist Inc. and are shown on the dashboard to refer to Obsidian. You can change the dashboard title in settings.

## License

[MIT](LICENSE)
