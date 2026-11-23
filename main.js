/*
 * Journal Scroll — every daily journal entry as one continuous, read-only page,
 * or as a paginated book.
 *
 * Convention (from "01 - Projects/Daily Journal"):
 *   <dir>/<YYYY>/<MM> (<Mon>) <YYYY>/<DD>-<MM>-<YYYY> - Journal.md
 * The filename date drives ordering, so the nesting can vary. An invalid name
 * (e.g. the old "13-13-2024" typo) falls back to its month folder's date.
 *
 * Plain CommonJS, no build step.
 */
const {
  Plugin, ItemView, Modal, SuggestModal, PluginSettingTab, Setting, Component,
  MarkdownRenderer, TFile, TFolder, Vault, Keymap, Notice, normalizePath, setIcon,
} = require("obsidian");

const VIEW_TYPE = "journal-scroll-view";
const NAME_RE = /^(\d{2})-(\d{2})-(\d{4})\b/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?)$/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MODE_SCROLL = "scroll";
const MODE_BOOK = "book";

const DEFAULT_SETTINGS = {
  journalDir: "01 - Projects/Daily Journal",
  batchSize: 10,
  viewMode: MODE_SCROLL,
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

/** Set CSS custom properties (Obsidian's setCssProps, with a fallback for older builds). */
function setCssVars(el, props) {
  if (el.setCssProps) el.setCssProps(props);
  else for (const k of Object.keys(props)) el.style.setProperty(k, props[k]);
}

function fmtDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
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
/* Image lightbox                                                      */
/* ------------------------------------------------------------------ */

class ImageLightbox extends Modal {
  /** images: [{ src, alt, linktext, sourcePath }] */
  constructor(app, images, index) {
    super(app);
    this.images = images;
    this.index = index;
  }

  onOpen() {
    this.modalEl.addClass("journal-scroll-lightbox");
    if (this.images.length > 1) {
      this.scope.register([], "ArrowLeft", () => { this.show(this.index - 1); return false; });
      this.scope.register([], "ArrowRight", () => { this.show(this.index + 1); return false; });
      this.contentEl.addEventListener("touchstart", (evt) => {
        const t = evt.touches[0];
        this.touchX = t ? t.clientX : null;
      }, { passive: true });
      this.contentEl.addEventListener("touchend", (evt) => {
        const t = evt.changedTouches[0];
        if (this.touchX == null || !t) return;
        const dx = t.clientX - this.touchX;
        this.touchX = null;
        if (Math.abs(dx) > 50) this.show(this.index + (dx < 0 ? 1 : -1));
      }, { passive: true });
    }
    this.show(this.index);
  }

  show(i) {
    const n = this.images.length;
    this.index = ((i % n) + n) % n;
    const item = this.images[this.index];
    const el = this.contentEl;
    el.empty();

    const img = el.createEl("img", { cls: "journal-lightbox-img", attr: { src: item.src, alt: item.alt || "" } });
    img.addEventListener("click", () => this.close());

    const bar = el.createDiv({ cls: "journal-lightbox-bar" });
    if (n > 1) {
      const prev = bar.createEl("button", { attr: { "aria-label": "Previous image" } });
      setIcon(prev, "chevron-left");
      prev.addEventListener("click", () => this.show(this.index - 1));
      bar.createSpan({ cls: "journal-lightbox-count", text: `${this.index + 1} / ${n}` });
      const next = bar.createEl("button", { attr: { "aria-label": "Next image" } });
      setIcon(next, "chevron-right");
      next.addEventListener("click", () => this.show(this.index + 1));
    }
    if (item.linktext) {
      const open = bar.createEl("button", { text: "Open in new tab" });
      open.addEventListener("click", () => {
        this.close();
        this.app.workspace.openLinkText(item.linktext, item.sourcePath, "tab");
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

class JournalScrollView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = plugin.settings.viewMode;
    this.dir = null;
    this.entries = [];      // [{ file, date }], oldest first
    this.byPath = new Map();
    this.firstLoaded = 0;   // index of the oldest rendered entry
    this.lastLoaded = 0;    // index after the newest rendered entry
    this.buildId = 0;
    this.renderScope = null;

    // Scroll mode
    this.loading = false;
    this.pinned = false;    // keep the target in view while images load
    this.targetEl = null;
    this.alignTop = false;  // show the target's top (mode switch) rather than its end (today)

    // Book mode
    this.book = null;       // page geometry, see layoutBook()
    this.spread = 0;        // index of the visible spread (1 or 2 pages)
    this.anchor = null;     // { path, offset } — entry + page within it at the spread's first page
    this.bookLoading = null;
    this.relayoutPending = false;
    this.lastWheel = 0;
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
    el.tabIndex = 0; // receive arrow keys in book mode
    this.statusEl = el.createDiv({ cls: "journal-scroll-status" });
    this.stageEl = el.createDiv({ cls: "journal-scroll-stage" });
    this.viewportEl = this.stageEl.createDiv({ cls: "journal-scroll-viewport" });
    this.listEl = this.viewportEl.createDiv({ cls: "journal-scroll-list" });

    this.navEl = el.createDiv({ cls: "journal-book-nav" });
    this.prevBtn = this.navEl.createEl("button", { cls: "journal-book-btn", attr: { "aria-label": "Previous page" } });
    setIcon(this.prevBtn, "chevron-left");
    this.navLabel = this.navEl.createDiv({ cls: "journal-book-label" });
    this.nextBtn = this.navEl.createEl("button", { cls: "journal-book-btn", attr: { "aria-label": "Next page" } });
    setIcon(this.nextBtn, "chevron-right");
    this.registerDomEvent(this.prevBtn, "click", () => this.turn(-1));
    this.registerDomEvent(this.nextBtn, "click", () => this.turn(1));

    this.addAction("folder-open", "Change journal directory", () => this.plugin.promptAndOpen(this.leaf));
    this.addAction("calendar-check", "Jump to today", () => this.dir && this.build(this.dir));
    this.modeAction = this.addAction("book", "", () => this.plugin.setViewMode(
      this.mode === MODE_BOOK ? MODE_SCROLL : MODE_BOOK));
    this.applyMode();

    // Scroll mode
    this.registerDomEvent(el, "scroll", () => this.onScroll());
    for (const evt of ["wheel", "touchstart", "mousedown", "keydown"]) {
      this.registerDomEvent(el, evt, () => { this.pinned = false; }, { passive: true });
    }

    // Book mode: keys, wheel, swipe
    this.registerDomEvent(el, "keydown", (evt) => this.onBookKey(evt));
    this.registerDomEvent(this.stageEl, "wheel", (evt) => this.onBookWheel(evt), { passive: true });
    this.registerDomEvent(this.stageEl, "touchstart", (evt) => {
      const t = evt.touches[0];
      this.touch = t ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    this.registerDomEvent(this.stageEl, "touchend", (evt) => {
      const t = evt.changedTouches[0];
      if (this.mode !== MODE_BOOK || !this.touch || !t) return;
      const dx = t.clientX - this.touch.x, dy = t.clientY - this.touch.y;
      this.touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.turn(dx < 0 ? 1 : -1);
    }, { passive: true });

    // Read-only links: open in the workspace, never edit here.
    this.registerDomEvent(this.listEl, "click", (evt) => this.onClick(evt));
    this.registerDomEvent(this.listEl, "mouseover", (evt) => this.onHover(evt));

    // Images and embeds load after render and change layout.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.mode === MODE_BOOK) {
        if (this.entries.length && this.layoutBook()) this.relayout();
      } else if (this.pinned) {
        this.scrollToTarget();
      }
    });
    this.resizeObserver.observe(this.listEl);
    this.resizeObserver.observe(this.stageEl);
    this.registerDomEvent(this.listEl, "load", () => this.scheduleRelayout(), { capture: true });
    this.mutationObserver = new MutationObserver(() => this.scheduleRelayout());
    this.mutationObserver.observe(this.listEl, { childList: true, subtree: true });

    // Keep rendered entries fresh; new/deleted files need a rebuild (toolbar button).
    this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));

    if (!this.dir) this.setMessage("Choose a journal directory to begin.");
  }

  async onClose() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.mutationObserver) this.mutationObserver.disconnect();
    if (this.renderScope) this.removeChild(this.renderScope);
  }

  /* ---------------- mode ---------------- */

  applyMode() {
    const book = this.mode === MODE_BOOK;
    this.contentEl.toggleClass("is-book", book);
    if (this.modeAction) {
      setIcon(this.modeAction, book ? "scroll-text" : "book");
      this.modeAction.setAttr("aria-label", book ? "Switch to infinite scroll" : "Switch to book view");
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const focus = this.currentPath();
    this.mode = mode;
    this.applyMode();
    if (this.dir) this.build(this.dir, focus);
  }

  /** Path of the entry the reader is currently looking at. */
  currentPath() {
    if (this.mode === MODE_BOOK) return this.anchor ? this.anchor.path : null;
    const top = this.contentEl.scrollTop + 1;
    for (const child of this.listEl.children) {
      if (child.offsetTop + child.offsetHeight > top) return child.dataset.path;
    }
    return null;
  }

  setMessage(text) {
    this.statusEl.setText(text);
    this.navLabel.setText(text);
  }

  /* ---------------- build ---------------- */

  async build(dir, focusPath) {
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
    this.byPath = new Map(entries.map((e) => [e.file.path, e]));

    if (this.renderScope) this.removeChild(this.renderScope);
    this.renderScope = this.addChild(new Component());
    this.listEl.empty();
    setCssVars(this.contentEl, { "--journal-book-x": "0px" });
    this.contentEl.scrollTop = 0;
    this.targetEl = null;
    this.book = null;
    this.anchor = null;
    this.spread = 0;
    this.bookLoading = null;
    this.loading = false;

    if (!entries.length) {
      this.setMessage(`No DD-MM-YYYY journal files found in "${dir}".`);
      return;
    }

    // Target = the focused entry, else today, else the latest entry before today.
    let target = focusPath ? entries.findIndex((e) => e.file.path === focusPath) : -1;
    this.alignTop = target >= 0;
    if (target < 0) {
      const today = dayKey(new Date());
      for (let i = 0; i < entries.length; i++) if (dayKey(entries[i].date) <= today) target = i;
      if (target < 0) target = 0;
    }

    if (this.mode === MODE_BOOK) await this.buildBook(target, id);
    else await this.buildScroll(target, id);
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
    h.createSpan({ cls: "journal-scroll-day", text: fmtDate(date) });
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
    this.groupThumbnails(body);
  }

  /**
   * Gather images into compact thumbnail groups that float beside the text.
   * Image-only paragraphs become a group; images mixed into a text paragraph are
   * lifted into a group just before it. Neighbouring groups merge, so a run of
   * photos forms one block and the following text wraps around it.
   */
  groupThumbnails(body) {
    const isImageEl = (node) => node.nodeType === Node.ELEMENT_NODE && (
      (node.tagName === "IMG" && !node.closest("a"))
      || (node.classList.contains("internal-embed")
        && (node.classList.contains("image-embed") || IMAGE_RE.test(node.getAttribute("src") || ""))));
    const isFiller = (node) => node.nodeType === Node.COMMENT_NODE
      || (node.nodeType === Node.TEXT_NODE && !node.textContent.trim())
      || (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR");

    for (const p of Array.from(body.querySelectorAll("p"))) {
      const nodes = Array.from(p.childNodes);
      const images = nodes.filter(isImageEl);
      if (!images.length) continue;

      let row;
      if (nodes.every((n) => isImageEl(n) || isFiller(n))) {
        p.querySelectorAll("br").forEach((br) => br.remove());
        p.addClass("journal-thumb-row");
        row = p;
      } else {
        row = createEl("p", { cls: "journal-thumb-row" });
        p.before(row);
        row.append(...images);
        // Drop line breaks the lifted images leave behind at the edges or doubled up.
        const trim = () => {
          while (p.firstChild && isFiller(p.firstChild)) p.firstChild.remove();
          while (p.lastChild && isFiller(p.lastChild)) p.lastChild.remove();
        };
        trim();
        for (const br of Array.from(p.querySelectorAll(":scope > br"))) {
          let next = br.nextSibling;
          while (next && next.nodeType === Node.TEXT_NODE && !next.textContent.trim()) next = next.nextSibling;
          if (next && next.nodeType === Node.ELEMENT_NODE && next.tagName === "BR") br.remove();
        }
        if (!p.childNodes.length) p.remove();
      }

      const prev = row.previousElementSibling;
      if (prev && prev.hasClass("journal-thumb-row")) {
        prev.append(...Array.from(row.childNodes));
        row.remove();
      }
    }
  }

  openLightbox(img) {
    const entry = img.closest(".journal-scroll-entry");
    const imgs = entry ? Array.from(entry.querySelectorAll(".journal-scroll-body img")) : [img];
    const images = imgs.map((el) => {
      const embed = el.closest(".internal-embed");
      return {
        src: el.currentSrc || el.src,
        alt: el.alt,
        linktext: embed ? embed.getAttribute("src") : null,
        sourcePath: entry ? entry.dataset.path : "",
      };
    });
    new ImageLightbox(this.app, images, Math.max(0, imgs.indexOf(img))).open();
  }

  async onModify(file) {
    if (!(file instanceof TFile) || !this.listEl) return;
    const wrap = Array.from(this.listEl.children).find((c) => c.dataset.path === file.path);
    if (!wrap) return;
    const body = wrap.querySelector(".journal-scroll-body");
    if (body) await this.renderBody(file, body);
  }

  /* ---------------- scroll mode ---------------- */

  async buildScroll(target, id) {
    const size = this.plugin.settings.batchSize;
    this.firstLoaded = Math.max(0, target - size + 1);
    this.lastLoaded = Math.min(this.entries.length, target + 1 + size);
    const els = await this.renderRange(this.firstLoaded, this.lastLoaded, id);
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
    if (!this.targetEl || this.mode !== MODE_SCROLL) return;
    const el = this.contentEl;
    if (this.alignTop) {
      el.scrollTop = this.targetEl.offsetTop;
    } else {
      const bottom = this.targetEl.offsetTop + this.targetEl.offsetHeight;
      el.scrollTop = Math.max(0, bottom - el.clientHeight);
    }
  }

  updateStatus() {
    const n = this.entries.length;
    if (this.firstLoaded > 0) {
      this.statusEl.setText(`Scroll up for older entries · ${this.lastLoaded - this.firstLoaded} of ${n} loaded`);
    } else {
      this.statusEl.setText(`Beginning of journal · ${fmtDate(this.entries[0].date)} · ${n} entries`);
    }
  }

  onScroll() {
    if (this.mode !== MODE_SCROLL || this.loading || !this.entries.length) return;
    const el = this.contentEl;
    if (this.firstLoaded > 0 && el.scrollTop <= 600) this.loadOlder();
    else if (this.lastLoaded < this.entries.length
      && el.scrollTop + el.clientHeight >= el.scrollHeight - 600) this.loadNewer();
  }

  async loadOlder() {
    this.loading = true;
    const id = this.buildId;
    const to = this.firstLoaded;
    const from = Math.max(0, to - this.plugin.settings.batchSize);
    const els = await this.renderRange(from, to, id);
    if (id !== this.buildId) return;

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

  async loadNewer() {
    this.loading = true;
    const id = this.buildId;
    const from = this.lastLoaded;
    const to = Math.min(this.entries.length, from + this.plugin.settings.batchSize);
    const els = await this.renderRange(from, to, id);
    if (id !== this.buildId) return;
    this.listEl.append(...els);
    this.lastLoaded = to;
    this.updateStatus();
    this.loading = false;
    this.onScroll();
  }

  /* ---------------- book mode ---------------- */
  /*
   * Entries flow through a CSS multi-column box of fixed page height; overflow
   * columns extend to the right and are paged by translating the box. Each
   * entry starts on a new page. Position is kept as an anchor (entry + page
   * within it) so prepending entries or late-loading images never move the reader.
   */

  async buildBook(target, id) {
    const size = this.plugin.settings.batchSize;
    this.firstLoaded = Math.max(0, target - size);
    this.lastLoaded = Math.min(this.entries.length, target + 1 + size);
    const els = await this.renderRange(this.firstLoaded, this.lastLoaded, id);
    if (id !== this.buildId) return;
    this.listEl.append(...els);
    this.anchor = { path: this.entries[target].file.path, offset: 0 };
    if (this.layoutBook()) this.relayout();
    if (this.app.workspace.getActiveViewOfType(JournalScrollView) === this) {
      this.contentEl.focus({ preventScroll: true });
    }
  }

  layoutBook() {
    const sw = this.stageEl.clientWidth, sh = this.stageEl.clientHeight;
    if (!sw || !sh) { this.book = null; return false; }
    const narrow = sw < 600;
    const G = narrow ? 32 : 64;                     // gap between pages
    const n = sw >= 1100 ? 2 : 1;                   // two-page spread on wide panes
    const maxPage = 680;
    const W = Math.floor(Math.min(sw - (narrow ? 32 : 64), n * maxPage + (n - 1) * G));
    const padY = narrow ? 12 : 28;
    const H = Math.floor(sh - 2 * padY);
    const colW = (W - (n - 1) * G) / n;
    const prev = this.book;
    this.book = { n, G, W, H, colStride: colW + G };
    if (prev && prev.W === W && prev.H === H && prev.n === n) return true;

    this.contentEl.toggleClass("is-spread", n === 2);
    // Geometry lives in CSS variables; the .is-book rules in styles.css consume them.
    setCssVars(this.contentEl, {
      "--journal-page-width": `${W}px`,
      "--journal-page-height": `${H}px`,
      "--journal-page-pad-y": `${padY}px`,
      "--journal-page-cols": String(n),
      "--journal-page-gap": `${G}px`,
    });
    return true;
  }

  /** Column (page) range an entry occupies. */
  entrySpan(el) {
    const L = this.listEl.getBoundingClientRect().left;
    const r = el.getBoundingClientRect();
    const s = this.book.colStride;
    const start = Math.max(0, Math.floor((r.left - L + 1) / s));
    const end = Math.max(start, Math.floor((r.right - L - 1) / s));
    return { start, end };
  }

  totalSpreads() {
    const last = this.listEl.lastElementChild;
    if (!last || !this.book) return 1;
    return Math.max(1, Math.ceil((this.entrySpan(last).end + 1) / this.book.n));
  }

  entryEl(path) {
    for (const c of this.listEl.children) if (c.dataset.path === path) return c;
    return null;
  }

  scheduleRelayout() {
    if (this.mode !== MODE_BOOK || this.relayoutPending) return;
    this.relayoutPending = true;
    window.requestAnimationFrame(() => {
      this.relayoutPending = false;
      if (this.mode === MODE_BOOK && this.book) this.relayout();
    });
  }

  /** Re-derive the visible spread from the anchor after any layout change. */
  relayout() {
    if (!this.book) return;
    const el = this.anchor && this.entryEl(this.anchor.path);
    let col = 0;
    if (el) {
      const span = this.entrySpan(el);
      col = span.start + Math.min(this.anchor.offset, span.end - span.start);
    }
    this.showSpread(Math.floor(col / this.book.n), false, false);
  }

  showSpread(s, animate, fromUser) {
    if (!this.book) return;
    const total = this.totalSpreads();
    s = Math.max(0, Math.min(s, total - 1));
    this.spread = s;
    this.listEl.toggleClass("is-instant", !animate);
    setCssVars(this.contentEl, { "--journal-book-x": `${-s * (this.book.W + this.book.G)}px` });
    if (fromUser) this.updateAnchor();
    this.updateNav(total);
    this.maybeLoadMore(total);
  }

  updateAnchor() {
    const first = this.spread * this.book.n;
    let best = null, bestStart = 0;
    for (const el of this.listEl.children) {
      const { start } = this.entrySpan(el);
      if (start > first) break;
      best = el; bestStart = start;
    }
    if (best) this.anchor = { path: best.dataset.path, offset: first - bestStart };
  }

  updateNav(total) {
    const el = this.anchor && this.entryEl(this.anchor.path);
    const entry = el && this.byPath.get(el.dataset.path);
    if (entry) {
      const span = this.entrySpan(el);
      const pages = span.end - span.start + 1;
      const page = Math.min(this.anchor.offset, pages - 1) + 1;
      const parts = [fmtDate(entry.date), WEEKDAYS[entry.date.getDay()]];
      if (pages > 1) parts.push(`page ${page} of ${pages}`);
      this.navLabel.setText(parts.join(" · "));
    }
    this.prevBtn.disabled = this.spread === 0 && this.firstLoaded === 0;
    this.nextBtn.disabled = this.spread >= total - 1 && this.lastLoaded >= this.entries.length;
  }

  maybeLoadMore(total) {
    if (this.bookLoading) return;
    if (this.spread <= 1 && this.firstLoaded > 0) this.bookLoading = this.loadBook(-1);
    else if (this.spread >= total - 2 && this.lastLoaded < this.entries.length) this.bookLoading = this.loadBook(1);
  }

  async loadBook(dir) {
    const id = this.buildId;
    const size = this.plugin.settings.batchSize;
    if (dir < 0) {
      const to = this.firstLoaded, from = Math.max(0, to - size);
      const els = await this.renderRange(from, to, id);
      if (id !== this.buildId) return;
      this.listEl.prepend(...els);
      this.firstLoaded = from;
    } else {
      const from = this.lastLoaded, to = Math.min(this.entries.length, from + size);
      const els = await this.renderRange(from, to, id);
      if (id !== this.buildId) return;
      this.listEl.append(...els);
      this.lastLoaded = to;
    }
    this.bookLoading = null;
    this.relayout(); // anchor keeps the reader on the same page
  }

  async turn(d) {
    if (this.mode !== MODE_BOOK || !this.book) return;
    if (this.bookLoading) await this.bookLoading;
    if (!this.book) return;
    const s = this.spread + d;
    if (s < 0 && this.firstLoaded > 0) {
      this.bookLoading = this.loadBook(-1);
      await this.bookLoading;
      this.showSpread(this.spread - 1, true, true);
      return;
    }
    if (s >= this.totalSpreads() && this.lastLoaded < this.entries.length) {
      this.bookLoading = this.loadBook(1);
      await this.bookLoading;
    }
    this.showSpread(s, true, true);
  }

  onBookKey(evt) {
    if (this.mode !== MODE_BOOK || evt.ctrlKey || evt.metaKey || evt.altKey) return;
    const t = evt.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    let d = 0;
    if (evt.key === "ArrowRight" || evt.key === "PageDown" || (evt.key === " " && !evt.shiftKey)) d = 1;
    else if (evt.key === "ArrowLeft" || evt.key === "PageUp" || (evt.key === " " && evt.shiftKey)) d = -1;
    if (!d) return;
    evt.preventDefault();
    this.turn(d);
  }

  onBookWheel(evt) {
    if (this.mode !== MODE_BOOK) return;
    const delta = Math.abs(evt.deltaX) > Math.abs(evt.deltaY) ? evt.deltaX : evt.deltaY;
    if (Math.abs(delta) < 10) return;
    // One page per gesture: ignore the rest of a trackpad fling.
    const now = Date.now();
    const quiet = now - this.lastWheel > 300;
    this.lastWheel = now;
    if (quiet) this.turn(delta > 0 ? 1 : -1);
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
    const img = evt.target.closest && evt.target.closest(".journal-scroll-body img");
    if (img) {
      evt.preventDefault();
      evt.stopPropagation();
      this.openLightbox(img);
      return;
    }
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
    delete this.settings.askOnOpen; // retired: the last saved directory always opens directly

    this.registerView(VIEW_TYPE, (leaf) => new JournalScrollView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: "Journal Scroll", defaultMod: true });

    this.addRibbonIcon("book-open", "Open Journal Scroll", () => this.open());
    this.addCommand({ id: "open", name: "Open journal (scrolled to today)", callback: () => this.open() });
    this.addCommand({ id: "open-choose-dir", name: "Open journal from a chosen directory", callback: () => this.promptAndOpen() });
    this.addCommand({
      id: "toggle-view-mode",
      name: "Toggle infinite scroll / book view",
      callback: () => this.setViewMode(this.settings.viewMode === MODE_BOOK ? MODE_SCROLL : MODE_BOOK),
    });

    this.addSettingTab(new JournalScrollSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async setViewMode(mode) {
    this.settings.viewMode = mode;
    await this.saveSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof JournalScrollView) leaf.view.setMode(mode);
    }
  }

  /** Rebuild open journal views on the saved directory, if it is a folder. */
  applyJournalDir() {
    const dir = normalizePath(this.settings.journalDir || "");
    if (!(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
      new Notice(`Journal Scroll: "${dir}" is not a folder`);
      return;
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof JournalScrollView && leaf.view.dir !== dir) leaf.view.build(dir);
    }
  }

  /** Open the last saved directory; prompt only if there is none or it no longer exists. */
  open() {
    const dir = this.settings.journalDir && normalizePath(this.settings.journalDir);
    if (dir && this.app.vault.getAbstractFileByPath(dir) instanceof TFolder) this.openDir(dir);
    else this.promptAndOpen();
  }

  promptAndOpen(leaf) {
    new FolderPromptModal(this.app, this.settings.journalDir, (dir) => this.openDir(dir, leaf)).open();
  }

  async openDir(dir, leaf) {
    if (dir !== this.settings.journalDir) {
      this.settings.journalDir = dir;
      await this.saveSettings();
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
      .setName("Reading mode")
      .setDesc("Infinite scroll shows every entry on one long page. Book view turns page by page "
        + "(arrow keys, Page Up/Down, wheel, swipe or the buttons), with two pages side by side on wide panes.")
      .addDropdown((d) => d
        .addOption(MODE_SCROLL, "Infinite scroll")
        .addOption(MODE_BOOK, "Book (page by page)")
        .setValue(this.plugin.settings.viewMode)
        .onChange((v) => this.plugin.setViewMode(v)));

    new Setting(containerEl)
      .setName("Journal directory")
      .setDesc("Folder holding DD-MM-YYYY - Journal.md files (searched recursively). Remembered from the last "
        + "folder you chose; the journal opens straight into it. Use the folder button in the view to change it.")
      .addText((t) => {
        t.setPlaceholder(DEFAULT_SETTINGS.journalDir)
          .setValue(this.plugin.settings.journalDir)
          .onChange(async (v) => {
            this.plugin.settings.journalDir = v.trim() || DEFAULT_SETTINGS.journalDir;
            await this.plugin.saveSettings();
          });
        // On commit (blur / Enter), point open journal views at the new folder.
        t.inputEl.addEventListener("change", () => this.plugin.applyJournalDir());
      });

    new Setting(containerEl)
      .setName("Entries per batch")
      .setDesc("How many entries to render at a time as you scroll or page through.")
      .addSlider((s) => s
        .setLimits(3, 50, 1)
        .setValue(this.plugin.settings.batchSize)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.batchSize = v;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = JournalScrollPlugin;
