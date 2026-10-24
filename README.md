# Home + AI (AI optional)

A home screen for your Obsidian vault with live vault stats, widgets you can put in any note, an AI chat that lives in a tab or sidebar, and an AI spell and grammar checker. Works on desktop, iPhone and iPad.

## Features

### Home screen
- Opens when Obsidian starts and replaces the blank "New tab" page (both optional).
- Two styles (Dashboard is the default):
  - **Modern**: greeting and clock, note search, quick action tiles, your recent notes and vault stats.
  - **Dashboard**: logo and title, search, quick actions, vault stats, focus timer, recent notes and vault summary.
- **Vault stats**, kept up to date as you write. Word counts cover your writing only: frontmatter, `%%comments%%` and plugin data (Excalidraw drawings, Dataview queries) are skipped, and Sheet Plus spreadsheets count the text in their cells. Stats include total words and words written today, your writing streak (days in a row you've written, and your best), characters, words per note, time to read everything, links, notes added this week and month, unlinked notes, attachments, task progress, and your longest and most-linked notes.
- Backgrounds: accent glow, plain, or illustrated scenes (night sky with cabin, moonlit lake, aurora, sunset dunes, ocean dawn, sunny meadow, rainy city), plus **Auto**, which changes scene with the time of day. Scenes are drawn in code at your window size, with no image files, and respect the system's reduce-motion setting.
- The calendar opens or creates daily notes using your core **Daily notes** folder, date format and template.

### Widgets in notes
Put a live widget in any note: run **Insert widget** from the command palette, or add a code block yourself:

````markdown
```home-widget
stats
```
````

Widgets: `stats` (vault stats), `words` (word count), `clock`, `calendar`, `vault` (vault summary), `recent` (recent notes) and `focus` (focus timer). A note with widgets also shows them on a canvas.

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

### On-device AI (optional add-on)
- Install the separate **Home + AI Local** add-on to run a small AI model on your own iPad or Mac, with no internet or API key. Then choose **On this device** as the provider.
- It's a separate plugin so this one stays small: the model runtime is about 6 MB and only loads on devices that use it.

### Full-page AI chat
- The sparkle button next to the **+** in the tab bar opens a new tab with just the AI chat, laid out as a full page.

### Spell check
- Uses your AI model to find spelling, punctuation and grammar mistakes, and sentences that don't make sense.
- Either lists each problem with a suggested fix (fix one at a time, jump to it, or fix all), or fixes everything at once. Fixing everything is a single undo step.
- Checks the selected text, or the whole note if nothing is selected.
- Run it from the command palette, the right-click menu in a note, or by typing `/` with Obsidian's core **Slash commands** plugin turned on.
- Spelling variants: Australian, British, American, Canadian and New Zealand English.

### Voice notes
- Press the **microphone** in the left ribbon (or run "Record voice note") to start recording. A bar across the top of the window shows a live audio line, the time, and **pause** and **stop** buttons.
- When you stop, a new note opens with the recording, a **Summary** and the full **Transcript**, and **Claude names the note**.
- **Google Gemini** listens to the recording and writes the transcript and summary (add a Gemini API key under Voice notes in settings). Claude can't listen to audio, so without a Gemini key the transcript comes from **OpenAI**, an **OpenRouter** audio model or your own Whisper server, and **Claude** writes the summary.
- **Live transcript:** while you record, what you're saying appears under the bar, a few seconds behind (turn it off under Voice notes to save the extra requests).
- **Timestamps:** each paragraph of the transcript starts with a time. Click it to hear that part of the recording.
- The recording is always kept in your attachments folder, so nothing is lost if a step fails. Works on desktop, iPhone and iPad (allow microphone access when asked).

### Flashcards and quizzes
- Run "Make flashcards from this note" or "Make a quiz from this note" (or right-click a note in the file list).
- Flashcards: flip each card, then mark it "Got it" or "Again"; cards you miss come back until you know them.
- Quiz: multiple choice with an explanation after each answer, and a score at the end.
- Keep either as a note. Flashcard notes use the `question::answer` format the Spaced Repetition plugin reads.

### Focus timer
- A Pomodoro timer: 25 minutes of focus, 5-minute breaks, and a 15-minute break after every 4 sessions (all adjustable).
- On the home screen as a card, in the left ribbon (click to start or pause, right-click for more; a badge shows the minutes left), at the far right of the tab bar while it runs, and in the Mac menu bar (desktop) so you can see and control it from any app.
- Purple by default; pick any colour in settings. Stop ends the session and goes back to the start of a focus session.
- Plays a soft chime and shows a system notification when time's up, even when Obsidian isn't in front. Keeps going if you restart Obsidian, and counts the sessions you finish each day. Add it to any note with the `focus` widget.

### Canvas drawing (like Freeform)
- In any canvas, press the **pen** button in the bottom toolbar, or just touch the canvas with **Apple Pencil**. Fingers keep scrolling and zooming.
- Tools: pen (responds to Apple Pencil pressure), highlighter, eraser, line, arrow, rectangle and oval. Hold Shift for straight lines, squares and circles. Seven colours, three sizes, undo and redo.
- Press **Done** and your drawing becomes a card you can move, resize and connect. Right-click it and choose **Edit drawing** to change it later.
- **Sticky notes:** the sticky-note button adds a yellow square card.
- Drawings are saved as SVG images in your attachments folder.

### Read aloud
- Run "Read this note aloud", right-click in a note, or right-click a note in the file list. Reads the selection if there is one.
- Uses your device's own voices (free and offline), picking one that matches your spelling choice. A bar at the bottom shows the sentence being read, with pause, skip back or forward, speed and stop.

### Writing profile
- Spell check keeps a list of the words you most often misspell, and checks extra carefully for them next time.
- Run "Update my writing profile" and the AI reads your recent notes and spell-check history, then writes a note describing how you write: your style, strengths, habits to watch and tips, plus a table of your common spelling mistakes that updates after every spell check.

### Performance
- **Low power mode** (in settings, or the "Turn low power mode on or off" command) uses less CPU and battery. It stops background animations, counts words every 30 seconds instead of on every save, updates the focus timer once a minute, lets Obsidian rest in the background, and turns off the live transcript.
- Home screen animations always pause while Obsidian isn't the app in front, and can be turned off completely.
- Settings show Obsidian's current CPU and memory use (desktop) and your biggest plugins, so you can see what's using the most.
- Choose how many past chats to keep.

### On/off switches
Every main feature has its own switch under **Features** in settings, and a "Turn … on or off" command: home screen, AI, AI chat, AI memory, spell check, writing profile, flashcards and quizzes, voice notes, read aloud, focus timer, canvas drawing, note widgets and purple graph links. The **AI** switch turns off everything that uses AI at once; with it off, nothing is sent to any AI provider.

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
| Make flashcards from this note | Flashcards to study, which you can keep as a note |
| Make a quiz from this note | A multiple-choice quiz with a score |
| Start or pause focus timer | Starts or pauses the Pomodoro timer (also reset and skip) |
| Read this note aloud | Reads the note (or selection) to you |
| Turn low power mode on or off | Uses less CPU and battery |
| Draw on this canvas | Starts drawing on the open canvas |
| Add sticky note to this canvas | Adds a yellow sticky note |
| Update my writing profile | Has the AI describe how you write, in a note |

## Privacy and network use

This plugin needs an account with an AI provider to use chat, spell check and voice note transcription.

- **What is sent:** your chat messages, the note you attach, notes the AI reads or searches while answering (only with vault access on, except the open note), and the text you spell check are sent to the AI provider you choose: `api.anthropic.com`, `api.openai.com`, `openrouter.ai`, or the custom server address you enter. Nothing is sent until you send a message or run spell check.
- **API keys** are stored in this plugin's `data.json` inside your vault's config folder. If you sync your vault, the keys sync too.
- **Chat history** is stored in `chats.json` in the same folder, and never leaves your device except through your own vault sync.
- **Voice notes**: recordings are saved in your vault. With live transcript on, short clips are sent while you speak. With AI on, the audio is sent to the transcription service you chose (`generativelanguage.googleapis.com` for Gemini, `api.openai.com`, `openrouter.ai` or your custom server), and the transcript to your AI provider (Claude, if you have an Anthropic key) to name the note. The microphone is only on while the recording bar is showing.
- **Writing profile**: when you update it, samples of your recent notes and your spell-check history are sent to your AI provider. The mistake list itself stays in the plugin's data file.
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

Canvas drawing uses [perfect-freehand](https://github.com/steveruizok/perfect-freehand) by Steve Ruiz (MIT licence) for pressure-sensitive pen strokes.

## License

[MIT](LICENSE)
