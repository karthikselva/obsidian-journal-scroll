# Journal Scroll

An Obsidian plugin that shows all your daily journal entries on one continuous, read-only page. It opens at today's entry.

- Asks once which folder holds your journal (searched recursively), then always opens straight into it. Change the folder later in settings or with the folder button in the view.
- Expects files named `DD-MM-YYYY - Journal.md`, e.g. `Daily Journal/2026/11 (Nov) 2026/23-11-2026 - Journal.md`.
- Two reading modes, switched from the toolbar, the command palette (*Toggle infinite scroll / book view*) or settings:
  - **Infinite scroll** opens at the end of today's entry, or at the most recent entry before today if today has none. Older and newer entries load in batches as you scroll. Each date heading stays pinned at the top of the view.
  - **Book** shows the journal as pages. Each day starts on a new page, and wide panes show two pages side by side. Turn pages with the arrow keys, Page Up/Down, Space, the mouse wheel, a swipe, or the buttons at the bottom.
- Switching modes keeps your place. Click a date to open that note for editing.
- Photos show as small thumbnails, side by side. Click one to see it full size, step through that day's photos with the arrow keys or a swipe, or open it in a new tab.
- Wikilinks open in a new tab and support hover preview. Nothing on the page can be edited.
- Works on desktop and mobile.

## Install

**BRAT (desktop or mobile):** install *Obsidian42 - BRAT*, choose *Add a beta plugin*, enter `karthikselva/obsidian-journal-scroll`, then enable *Journal Scroll*.

**Manual:** copy `manifest.json`, `main.js` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/journal-scroll/`.

## Use

Click the 📖 ribbon icon, or run the command *Journal Scroll: Open journal (scrolled to today)*.
