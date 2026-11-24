# Journal Scroll

[![Add to Obsidian](https://img.shields.io/badge/Add_to-Obsidian-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white)](https://community.obsidian.md/plugins/journal-scroll)

An Obsidian plugin that shows all your daily journal entries on one continuous, read-only page. It opens at today's entry.

- Asks once which folder holds your journal (searched recursively), then always opens straight into it. Change the folder later in settings or with the folder button in the view.
- An activity heatmap at the top shows the last year like a GitHub contribution graph. Days without an entry are grey, and longer entries are a deeper green. Hover a day to see its date and length, or click it to jump to that entry. You can turn it off in settings.
- If an entry's frontmatter has a `title:` or `highlights:`, they appear above its date. Write them by hand, or let [Journal Scroll Assistant](https://github.com/karthikselva/obsidian-journal-scroll-assistant) generate them. You can turn this off in settings.
- Expects files named `DD-MM-YYYY - Journal.md`, e.g. `Daily Journal/2026/11 (Nov) 2026/23-11-2026 - Journal.md`.
- Two reading modes, switched from the toolbar, the command palette (*Toggle infinite scroll / book view*) or settings:
  - **Infinite scroll** opens at the end of today's entry, or at the most recent entry before today if today has none. Older and newer entries load in batches as you scroll. Each date heading stays pinned at the top of the view.
  - **Book** shows the journal as pages. Each day starts on a new page, and wide panes show two pages side by side. Turn pages with the arrow keys, Page Up/Down, Space, the mouse wheel, a swipe, or the buttons at the bottom.
- Switching modes keeps your place. Click a date to open that note for editing.
- Photos show as small thumbnails, side by side. Click one to see it full size, step through that day's photos with the arrow keys or a swipe, or open it in a new tab.
- Wikilinks open in a new tab and support hover preview. Nothing on the page can be edited.
- Works on desktop and mobile.

## Install

**From Obsidian (recommended):** open *Settings → Community plugins → Browse*, search for **Journal Scroll**, then choose *Install* and *Enable*. Or open the [Journal Scroll page](https://community.obsidian.md/plugins/journal-scroll) in the Obsidian Community directory and click **Add to Obsidian**.

**Beta builds with BRAT:** install *Obsidian42 - BRAT*, choose *Add a beta plugin*, enter `karthikselva/obsidian-journal-scroll`, then enable *Journal Scroll*. BRAT tracks the latest GitHub release, which can be ahead of the directory.

**Manual:** copy `manifest.json`, `main.js` and `styles.css` from the [latest release](https://github.com/karthikselva/obsidian-journal-scroll/releases/latest) into `<vault>/.obsidian/plugins/journal-scroll/`, then enable *Journal Scroll* under *Settings → Community plugins*.

## Use

Click the 📖 ribbon icon, or run the command *Journal Scroll: Open journal (scrolled to today)*.
