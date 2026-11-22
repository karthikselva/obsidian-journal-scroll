/*
 * Journal Scroll — every daily journal entry as one continuous, read-only page.
 *
 * Convention (from "01 - Projects/Daily Journal"):
 *   <dir>/<YYYY>/<MM> (<Mon>) <YYYY>/<DD>-<MM>-<YYYY> - Journal.md
 * The filename date drives ordering, so the nesting can vary. An invalid name
 * (e.g. the old "13-13-2024" typo) falls back to its month folder's date.
 *
 * Plain CommonJS, no build step.
 */
const {
  Plugin, ItemView, SuggestModal, PluginSettingTab, Setting, Component,
  MarkdownRenderer, TFile, TFolder, Vault, Keymap, Notice, normalizePath,
} = require("obsidian");

const VIEW_TYPE = "journal-scroll-view";
const NAME_RE = /^(\d{2})-(\d{2})-(\d{4})\b/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DEFAULT_SETTINGS = {
  journalDir: "01 - Projects/Daily Journal",
  askOnOpen: true,
  batchSize: 10,
};

function parseDate(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  const date = new Date(y, mo - 1, d);
  // Reject rollovers like 13-13-2024 or 31-02-2025.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

function dayKey(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/* ------------------------------------------------------------------ */
/* Directory prompt                                                    */
/* ------------------------------------------------------------------ */

class FolderPromptModal extends SuggestModal {
  constructor(app, initial, onChoose) {
    super(app);
    this.initial = initial;
    this.onChoose = onChoose;
    this.setPlaceholder("Journal directory");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "open journal" },
      { command: "esc", purpose: "cancel" },
    ]);
    this.folders = app.vault.getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && !f.isRoot())
      .map((f) => f.path)
      .sort();
  }

  onOpen() {
    super.onOpen();
    if (this.initial) {
      this.inputEl.value = this.initial;
      this.inputEl.select();
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.folders;
    const exact = this.folders.filter((p) => p.toLowerCase() === q);
    const rest = this.folders.filter((p) => p.toLowerCase() !== q && p.toLowerCase().includes(q));
    return exact.concat(rest);
  }

  renderSuggestion(path, el) {
    el.setText(path);
  }

  onChooseSuggestion(path) {
    this.onChoose(path);
  }
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

class JournalScrollView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.dir = null;
    this.entries = [];      // [{ file, date }], oldest first
    this.firstLoaded = 0;   // index of the oldest rendered entry
    this.loading = false;
    this.pinned = false;    // keep today in view while images load
    this.targetEl = null;
    this.renderScope = null;
    this.buildId = 0;
  }

  getViewType() { return VIEW_TYPE; }
  getIcon() { return "book-open"; }
  getDisplayText() {
    return this.dir ? `Journal · ${this.dir.split("/").pop()}` : "Journal";
  }

  getState() {
    return { dir: this.dir };
  }

  async setState(state, result) {
    if (state && state.dir) await this.build(state.dir);
    await super.setState(state, result);
  }

  async onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("journal-scroll-view");
    this.statusEl = el.createDiv({ cls: "journal-scroll-status" });
    this.listEl = el.createDiv({ cls: "journal-scroll-list" });

    this.addAction("folder-open", "Change journal directory", () => this.plugin.promptAndOpen(this.leaf));
    this.addAction("calendar-check", "Jump to today", () => this.dir && this.build(this.dir));

    this.registerDomEvent(el, "scroll", () => this.onScroll());
    for (const evt of ["wheel", "touchstart", "mousedown", "keydown"]) {
      this.registerDomEvent(el, evt, () => { this.pinned = false; }, { passive: true });
    }

    // Read-only links: open in the workspace, never edit here.
    this.registerDomEvent(this.listEl, "click", (evt) => this.onClick(evt));
    this.registerDomEvent(this.listEl, "mouseover", (evt) => this.onHover(evt));

    // Images load after render and change heights — re-pin to today while pinned.
    this.resizeObserver = new ResizeObserver(() => { if (this.pinned) this.scrollToTarget(); });
    this.resizeObserver.observe(this.listEl);

    // Keep rendered entries fresh; new/deleted files need a rebuild (toolbar button).
    this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));

    if (!this.dir) this.statusEl.setText("Choose a journal directory to begin.");
  }

  async onClose() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.renderScope) this.removeChild(this.renderScope);
  }

  /* ---------------- build ---------------- */

  async build(dir) {
    dir = normalizePath(dir);
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!(folder instanceof TFolder)) {
      new Notice(`Journal Scroll: "${dir}" is not a folder`);
      return;
    }
    const id = ++this.buildId;
    this.dir = dir;
    this.leaf.updateHeader && this.leaf.updateHeader();

    const entries = [];
    Vault.recurseChildren(folder, (f) => {
      if (!(f instanceof TFile) || f.extension !== "md") return;
      if (!NAME_RE.test(f.basename)) return;
      // Typos like "13-13-2024" fall back to the day + its "<MM> (<Mon>) <YYYY>" folder.
      let date = parseDate(f.basename);
      const fm = f.parent && /^(\d{2}) \(\w+\) (\d{4})$/.exec(f.parent.name);
      if (!date && fm) date = parseDate(`${f.basename.slice(0, 2)}-${fm[1]}-${fm[2]}`);
      if (date) entries.push({ file: f, date });
    });
    entries.sort((a, b) => a.date - b.date || a.file.path.localeCompare(b.file.path));
    this.entries = entries;

    if (this.renderScope) this.removeChild(this.renderScope);
    this.renderScope = this.addChild(new Component());
    this.listEl.empty();
    this.targetEl = null;

    if (!entries.length) {
      this.statusEl.setText(`No DD-MM-YYYY journal files found in "${dir}".`);
      return;
    }

    // Target = today, or the latest entry on or before today.
    const today = dayKey(new Date());
    let target = -1;
    for (let i = 0; i < entries.length; i++) if (dayKey(entries[i].date) <= today) target = i;
    if (target < 0) target = 0;

    const size = this.plugin.settings.batchSize;
    this.firstLoaded = Math.max(0, target - size + 1);
    // Render from the window start through the end (includes any future-dated entries).
    const els = await this.renderRange(this.firstLoaded, entries.length, id);
    if (id !== this.buildId) return;
    for (const e of els) this.listEl.appendChild(e);
    this.targetEl = els[target - this.firstLoaded];
    this.updateStatus();

    this.pinned = true;
    this.scrollToTarget();
    // Give async embeds a moment, then stop chasing layout shifts.
    window.setTimeout(() => { if (id === this.buildId) this.pinned = false; }, 4000);
  }

  scrollToTarget() {
    if (!this.targetEl) return;
    const el = this.contentEl;
    const bottom = this.targetEl.offsetTop + this.targetEl.offsetHeight;
    el.scrollTop = Math.max(0, bottom - el.clientHeight);
  }

  updateStatus() {
    const n = this.entries.length;
    if (this.firstLoaded > 0) {
      this.statusEl.setText(`Scroll up for older entries · ${n - this.firstLoaded} of ${n} loaded`);
    } else {
      const first = this.entries[0].date;
      this.statusEl.setText(`Beginning of journal · ${first.getDate()} ${MONTHS[first.getMonth()]} ${first.getFullYear()} · ${n} entries`);
    }
  }

  /* ---------------- rendering ---------------- */

  async renderRange(from, to, id) {
    const out = [];
    for (let i = from; i < to; i++) {
      if (id !== this.buildId) return out;
      out.push(await this.renderEntry(this.entries[i]));
    }
    return out;
  }

  async renderEntry(entry) {
    const { file, date } = entry;
    const wrap = createDiv({ cls: "journal-scroll-entry" });
    wrap.dataset.path = file.path;
    if (dayKey(date) === dayKey(new Date())) wrap.addClass("is-today");

    const h = wrap.createEl("h2", { cls: "journal-scroll-date" });
    h.createSpan({ text: `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}` });
    h.createSpan({ cls: "journal-scroll-weekday", text: WEEKDAYS[date.getDay()] });
    h.setAttr("aria-label", `Open ${file.basename}`);
    h.addEventListener("click", (evt) => {
      this.app.workspace.getLeaf(Keymap.isModEvent(evt) || "tab").openFile(file);
    });

    const body = wrap.createDiv({ cls: "journal-scroll-body markdown-rendered" });
    await this.renderBody(file, body);
    return wrap;
  }

  async renderBody(file, body) {
    let text = await this.app.vault.cachedRead(file);
    text = text.replace(/^﻿/, "");
    // Most entries open with a "---" section rule, which Obsidian would read as
    // frontmatter. Strip only real (parsed) frontmatter; otherwise keep the rule.
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache && cache.frontmatter;
    if (fm && Object.keys(fm).length && cache.frontmatterPosition) {
      text = text.slice(cache.frontmatterPosition.end.offset);
    } else if (text.startsWith("---")) {
      text = "\n" + text;
    }
    body.empty();
    if (MarkdownRenderer.render) {
      await MarkdownRenderer.render(this.app, text, body, file.path, this.renderScope);
    } else {
      await MarkdownRenderer.renderMarkdown(text, body, file.path, this.renderScope);
    }
    body.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.disabled = true; });
  }

  async onModify(file) {
    if (!(file instanceof TFile) || !this.listEl) return;
    const wrap = Array.from(this.listEl.children).find((c) => c.dataset.path === file.path);
    if (!wrap) return;
    const body = wrap.querySelector(".journal-scroll-body");
    if (body) await this.renderBody(file, body);
  }

  /* ---------------- infinite scroll upwards ---------------- */

  onScroll() {
    if (this.loading || this.firstLoaded <= 0 || !this.entries.length) return;
    if (this.contentEl.scrollTop > 600) return;
    this.loadOlder();
  }

  async loadOlder() {
    this.loading = true;
    const id = this.buildId;
    const to = this.firstLoaded;
    const from = Math.max(0, to - this.plugin.settings.batchSize);
    const els = await this.renderRange(from, to, id);
    if (id !== this.buildId) { this.loading = false; return; }

    // Keep the reader's place: pin the current first entry's on-screen position.
    const anchor = this.listEl.firstElementChild;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    this.listEl.prepend(...els);
    if (anchor) this.contentEl.scrollTop += anchor.getBoundingClientRect().top - before;

    this.firstLoaded = from;
    this.updateStatus();
    this.loading = false;
    // Short entries may not fill the gap — keep going if still near the top.
    this.onScroll();
  }

  /* ---------------- links ---------------- */

  linkFromEvent(evt) {
    const a = evt.target.closest && evt.target.closest("a.internal-link");
    if (!a) return null;
    const entry = a.closest(".journal-scroll-entry");
    return {
      a,
      linktext: a.getAttribute("data-href") || a.getAttribute("href"),
      sourcePath: entry ? entry.dataset.path : "",
    };
  }

  onClick(evt) {
    const link = this.linkFromEvent(evt);
    if (!link) return;
    evt.preventDefault();
    this.app.workspace.openLinkText(link.linktext, link.sourcePath, Keymap.isModEvent(evt) || "tab");
  }

  onHover(evt) {
    const link = this.linkFromEvent(evt);
    if (!link) return;
    this.app.workspace.trigger("hover-link", {
      event: evt, source: VIEW_TYPE, hoverParent: this,
      targetEl: link.a, linktext: link.linktext, sourcePath: link.sourcePath,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class JournalScrollPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new JournalScrollView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: "Journal Scroll", defaultMod: true });

    this.addRibbonIcon("book-open", "Open Journal Scroll", () => this.open());
    this.addCommand({ id: "open", name: "Open journal (scrolled to today)", callback: () => this.open() });
    this.addCommand({ id: "open-choose-dir", name: "Open journal from a chosen directory", callback: () => this.promptAndOpen() });

    this.addSettingTab(new JournalScrollSettingTab(this.app, this));
  }

  open() {
    if (this.settings.askOnOpen) this.promptAndOpen();
    else this.openDir(this.settings.journalDir);
  }

  promptAndOpen(leaf) {
    new FolderPromptModal(this.app, this.settings.journalDir, (dir) => this.openDir(dir, leaf)).open();
  }

  async openDir(dir, leaf) {
    if (dir !== this.settings.journalDir) {
      this.settings.journalDir = dir;
      await this.saveData(this.settings);
    }
    leaf = leaf || this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] || this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { dir } });
    this.app.workspace.revealLeaf(leaf);
  }
}

class JournalScrollSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Journal directory")
      .setDesc("Folder holding DD-MM-YYYY - Journal.md files (searched recursively). Prefilled in the prompt.")
      .addText((t) => t
        .setPlaceholder(DEFAULT_SETTINGS.journalDir)
        .setValue(this.plugin.settings.journalDir)
        .onChange(async (v) => {
          this.plugin.settings.journalDir = v.trim() || DEFAULT_SETTINGS.journalDir;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Ask for directory on open")
      .setDesc("Show the directory prompt every time the journal is opened.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.askOnOpen)
        .onChange(async (v) => {
          this.plugin.settings.askOnOpen = v;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Entries per batch")
      .setDesc("How many entries to render at a time as you scroll back.")
      .addSlider((s) => s
        .setLimits(3, 50, 1)
        .setValue(this.plugin.settings.batchSize)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.batchSize = v;
          await this.plugin.saveData(this.plugin.settings);
        }));
  }
}

module.exports = JournalScrollPlugin;
