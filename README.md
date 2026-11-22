# Journal Scroll

An Obsidian plugin that shows all your daily journal entries on one continuous, read-only page. It opens at today's entry.

- Asks which folder holds your journal (searched recursively) and remembers your choice.
- Expects files named `DD-MM-YYYY - Journal.md`, e.g. `Daily Journal/2026/11 (Nov) 2026/23-11-2026 - Journal.md`.
- Opens at the end of today's entry, or at the most recent entry before today if today has none. Scroll up to load older entries in batches.
- Each date heading stays pinned at the top of the view while you scroll. Click a date to open that note for editing.
- Wikilinks open in a new tab and support hover preview. Nothing on the page can be edited.
- Works on desktop and mobile.

## Install

**BRAT (desktop or mobile):** install *Obsidian42 - BRAT*, choose *Add a beta plugin*, enter `karthikselva/obsidian-journal-scroll`, then enable *Journal Scroll*.

**Manual:** copy `manifest.json`, `main.js` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/journal-scroll/`.

## Use

Click the 📖 ribbon icon, or run the command *Journal Scroll: Open journal (scrolled to today)*.
