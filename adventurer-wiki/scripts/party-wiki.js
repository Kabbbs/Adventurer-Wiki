// FILE: adventurer-wiki/scripts/party-wiki.js
/**
 * Adventurer Wiki — Foundry VTT Module
 * All players can create and edit entries.
 * Players can flag entries for deletion; only the GM can permanently delete.
 * Real-time updates via sockets. Soft-lock indicators show who is editing.
 * Uses ApplicationV2 (Foundry v12+).
 *
 * NOTE: World-scoped settings require a GM to write. If no GM is connected,
 * saves are blocked and the editor stays open with a clear warning. This
 * prevents data loss that would occur with a local-queue approach.
 *
 * v2 additions:
 *   - Image upload via Foundry FilePicker (toolbar button)
 *   - Hand-drawn doodle editor (WikiDoodleEditor) with save-to-disk
 *   - Responsive image display (max-width: 100%, height: auto)
 */

const MODULE_ID    = "adventurer-wiki";
const SETTING_KEY  = "wikiEntries";
const SOCKET_EVENT = `module.${MODULE_ID}`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const DEFAULT_CATEGORIES = [
  { id: "lore",      label: "Lore",          icon: "fa-book-open"        },
  { id: "locations", label: "Locations",     icon: "fa-map-location-dot" },
  { id: "npcs",      label: "NPCs",          icon: "fa-person"           },
  { id: "factions",  label: "Factions",      icon: "fa-shield-halved"    },
  { id: "quests",    label: "Quests",        icon: "fa-map-pin"          },
  { id: "items",     label: "Items",         icon: "fa-gem"              },
  { id: "notes",     label: "Session Notes", icon: "fa-scroll"           },
];

const CATS_SETTING_KEY = "wikiCategories";

const activeEditors = new Map();
const openWikiApps  = new Set();
let activeEditorApp = null;

// ─────────────────────────────────────────────────────────────────────────────
// Hooks — init & ready
// ─────────────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name:    "Wiki Entries",
    scope:   "world",
    config:  false,
    default: [],
  });

  game.settings.register(MODULE_ID, CATS_SETTING_KEY, {
    name:    "Wiki Categories",
    scope:   "world",
    config:  false,
    default: DEFAULT_CATEGORIES,
  });
});

Hooks.once("ready", () => {
  console.log("Adventurer Wiki | Module loaded successfully.");

  game.socket.on(SOCKET_EVENT, async (payload) => {
    switch (payload.action) {
      case "requestSave": {
        if (!game.user.isGM) return;
        await game.settings.set(MODULE_ID, SETTING_KEY, payload.entries);
        game.socket.emit(SOCKET_EVENT, { action: "refresh" });
        refreshAllWikiApps();
        break;
      }
      case "refresh": {
        refreshAllWikiApps();
        break;
      }
      case "categoriesChanged": {
        refreshAllWikiApps();
        break;
      }
      case "editingStart": {
        activeEditors.set(payload.entryId, {
          userName: payload.userName,
          userId:   payload.userId,
        });
        refreshAllWikiApps();
        break;
      }
      case "editingStop": {
        const cur = activeEditors.get(payload.entryId);
        if (cur?.userId === payload.userId) {
          activeEditors.delete(payload.entryId);
          refreshAllWikiApps();
        }
        break;
      }
    }
  });

  Hooks.on("updateSetting", (setting) => {
    const id = setting.id ?? setting._id ?? setting.key ?? "";
    if (id === `${MODULE_ID}.${SETTING_KEY}`) refreshAllWikiApps();
  });

  Hooks.on("userConnected", (user, connected) => {
    if (!connected) {
      for (const [id, session] of activeEditors) {
        if (session.userId === user.id) activeEditors.delete(id);
      }
      refreshAllWikiApps();
    }
  });

  addWikiButton();
  setTimeout(addWikiButton, 300);
  setTimeout(addWikiButton, 1000);
});

Hooks.on("renderSceneControls", () => addWikiButton());

// ─────────────────────────────────────────────────────────────────────────────
// Module-level utility functions
// ─────────────────────────────────────────────────────────────────────────────

function processEntryLinks(html, allEntries) {
  if (!html) return html;
  return html.replace(/\[\[([^\]]+)\]\]/g, (_match, rawTitle) => {
    const title  = rawTitle.trim();
    const linked = allEntries.find(e => e.title.toLowerCase() === title.toLowerCase());
    if (linked) {
      return `<a class="wiki-entry-link" data-id="${linked.id}">${title}</a>`;
    }
    return `<a class="wiki-entry-link wiki-entry-link-missing" title="No entry found: ${title}">${title}</a>`;
  });
}

function getEntries() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_KEY) || []);
}

function getCategories() {
  try {
    const stored = game.settings.get(MODULE_ID, CATS_SETTING_KEY);
    return (Array.isArray(stored) && stored.length) ? stored : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

async function saveEntries(entries) {
  if (game.user.isGM) {
    await game.settings.set(MODULE_ID, SETTING_KEY, entries);
    game.socket.emit(SOCKET_EVENT, { action: "refresh" });
    refreshAllWikiApps();
    return true;
  }

  const activeGM = game.users.find(u => u.isGM && u.active);
  if (!activeGM) {
    ui.notifications.warn(
      "Adventurer Wiki: A GM must be connected to save. " +
      "Your work is still in the editor — please try again once a GM joins."
    );
    return false;
  }

  game.socket.emit(SOCKET_EVENT, { action: "requestSave", entries });
  return true;
}

function generateId() {
  return `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function refreshAllWikiApps() {
  const renders = Array.from(openWikiApps).map(app => app.render({ force: true }));
  if (activeEditorApp) {
    const editor = activeEditorApp;
    Promise.all(renders).then(() => (editor.bringToFront ?? editor.bringToTop)?.call(editor));
  }
}

function addWikiButton() {
  if (document.querySelector(".party-wiki-control-btn")) return;

  const list =
    document.querySelector("#scene-controls-layers") ??
    document.querySelector("#controls ol.main-controls") ??
    document.querySelector("ol.main-controls");

  if (!list) {
    console.log("Adventurer Wiki | Controls list not found in DOM yet.");
    return;
  }

  const li    = document.createElement("li");
  const isV12 = !!document.querySelector("#scene-controls-layers");

  if (isV12) {
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = "control ui-control layer icon fa-solid fa-book-open party-wiki-control-btn";
    btn.setAttribute("data-tooltip", "Adventurer Wiki");
    btn.setAttribute("aria-label",   "Adventurer Wiki");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      new PartyWikiApp().render(true);
    });
    li.appendChild(btn);
  } else {
    li.className = "scene-control party-wiki-control-btn";
    li.setAttribute("title", "Adventurer Wiki");
    li.style.color = "#c0392b";
    li.innerHTML = '<i class="fas fa-book-open"></i>';
    li.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      new PartyWikiApp().render(true);
    });
  }

  list.appendChild(li);
  console.log("Adventurer Wiki | Button added to scene controls.");
}

// ─────────────────────────────────────────────────────────────────────────────
// PartyWikiApp — main viewer
// ─────────────────────────────────────────────────────────────────────────────

class PartyWikiApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id:       "party-wiki-app",
    classes:  ["party-wiki"],
    window:   { title: "Adventurer Wiki", resizable: true },
    position: { width: 820, height: 620 },
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/wiki.html` } };

  _activeCat     = DEFAULT_CATEGORIES[0].id;
  _selectedEntry = null;
  _searchQuery   = "";

  // ── Context helpers ──────────────────────────────────────────────────────

  /**
   * Filter entries by visibility, search query, or active category.
   * @param {object[]} entries  All raw entries from settings.
   * @param {boolean}  isGM     Whether the current user is a GM.
   * @returns {object[]}
   */
  _filterEntries(entries, isGM) {
    const q = this._searchQuery.toLowerCase();
    return entries.filter(e => {
      if (e.hidden && !isGM) return false;
      if (q) {
        const titleHit = e.title.toLowerCase().includes(q);
        const bodyText = e.content ? e.content.replace(/<[^>]*>/g, " ").toLowerCase() : "";
        return titleHit || bodyText.includes(q);
      }
      return e.category === this._activeCat;
    });
  }

  /**
   * Map raw comment objects to display-ready format.
   * @param {object[]} comments  Raw comment array from an entry.
   * @param {boolean}  isGM      Whether the current user is a GM.
   * @returns {object[]}
   */
  _formatComments(comments, isGM) {
    return comments.map(c => ({
      ...c,
      createdAtFormatted: new Date(c.createdAt).toLocaleString(undefined, {
        month:  "short",
        day:    "numeric",
        year:   "numeric",
        hour:   "numeric",
        minute: "2-digit",
      }),
      canDelete: isGM || c.userId === game.user.id,
    }));
  }

  // ── _prepareContext ──────────────────────────────────────────────────────

  async _prepareContext(_options) {
    const entries = getEntries();
    const isGM    = game.user.isGM;
    const q       = this._searchQuery.toLowerCase();
    const cats    = getCategories();

    // ── Validate active category ─────
    if (!cats.find(c => c.id === this._activeCat)) {
      this._activeCat = cats[0]?.id ?? null;
    }

    // ── Filter entries ───────────────
    const filtered = this._filterEntries(entries, isGM);

    // ── Validate selected entry ──────
    if (this._selectedEntry) {
      const sel = entries.find(e => e.id === this._selectedEntry);
      if (!sel || (sel.hidden && !isGM)) this._selectedEntry = null;
    }

    // ── Resolve current entry ────────
    const current = this._selectedEntry
      ? (entries.find(e => e.id === this._selectedEntry) ?? null)
      : null;

    // ── Enrich HTML content ──────────
    const _TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    const enrichedContent = current?.content
      ? await _TextEditor.enrichHTML(current.content, { async: true })
      : null;

    const enrichedContentLinked = processEntryLinks(enrichedContent, entries);

    // ── Annotate filtered entries ────
    const entriesWithStatus = filtered.map(e => {
      let bodyMatch = false;
      if (q) {
        const titleHit = e.title.toLowerCase().includes(q);
        if (!titleHit) {
          const bodyText = e.content ? e.content.replace(/<[^>]*>/g, " ").toLowerCase() : "";
          bodyMatch = bodyText.includes(q);
        }
      }
      return {
        ...e,
        beingEditedBy:  activeEditors.get(e.id)?.userName ?? null,
        categoryLabel:  q ? (cats.find(c => c.id === e.category)?.label ?? e.category) : null,
        bodyMatch,
      };
    });

    // ── Category counts ──────────────
    const categoriesWithCount = cats.map(cat => ({
      ...cat,
      count: entries.filter(e => e.category === cat.id).length,
    }));

    // ── Current-entry metadata ───────
    const currentEditor = current
      ? (activeEditors.get(current.id)?.userName ?? null)
      : null;

    const updatedAtFormatted = current?.updatedAt
      ? new Date(current.updatedAt).toLocaleString(undefined, {
          month:  "short",
          day:    "numeric",
          year:   "numeric",
          hour:   "numeric",
          minute: "2-digit",
        })
      : null;

    const gmNotes = isGM ? (current?.gmNotes ?? null) : null;

    const formattedComments = this._formatComments(current?.comments ?? [], isGM);

    const pendingDeletions = entries.filter(e => e.pendingDelete).length;

    const gmOnline = game.user.isGM || !!game.users.find(u => u.isGM && u.active);

    // ── Assemble context ─────────────
    return {
      categories:       categoriesWithCount,
      activeCat:        this._activeCat,
      entries:          entriesWithStatus,
      current,
      currentEditor,
      enrichedContent:  enrichedContentLinked,
      gmNotes,
      formattedComments,
      hasComments:      formattedComments.length > 0,
      isGM,
      gmOnline,
      searchQuery:      this._searchQuery,
      isSearching:      !!this._searchQuery,
      noEntries:        filtered.length === 0,
      pendingDeletions,
      updatedAtFormatted,
    };
  }

  // ── Render lifecycle ─────────────────────────────────────────────────────

  _onRender(_context, _options) {
    openWikiApps.add(this);
    this._attachDelegatedListeners();

    if (this._searchQuery) {
      const searchEl = this.element.querySelector(".wiki-search");
      if (searchEl) {
        searchEl.focus();
        const len = searchEl.value.length;
        searchEl.setSelectionRange(len, len);
      }
    }
  }

  // ── Click handler helpers ────────────────────────────────────────────────

  async _onClickCatTab(el) {
    this._activeCat    = el.dataset.cat;
    this._selectedEntry = null;
    this.render({ force: true });
  }

  async _onClickEntryItem(el) {
    this._selectedEntry = el.dataset.id;
    this.render({ force: true });
  }

  async _onClickToggleHidden() {
    if (!this._selectedEntry || !game.user.isGM) return;
    const entries = getEntries();
    const idx     = entries.findIndex(en => en.id === this._selectedEntry);
    if (idx === -1) return;
    entries[idx] = { ...entries[idx], hidden: !entries[idx].hidden };
    await saveEntries(entries);
  }

  async _onClickNew() {
    new WikiEntryEditor({ category: this._activeCat }, this).render(true);
  }

  async _onClickEdit() {
    if (!this._selectedEntry) return;
    const entry = getEntries().find(en => en.id === this._selectedEntry);
    if (entry) new WikiEntryEditor(entry, this).render(true);
  }

  async _onClickRequestDelete() {
    if (!this._selectedEntry) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window:  { title: "Request Deletion" },
      content: "<p>Flag this entry for deletion? The GM will need to approve it.</p>",
    });
    if (!ok) return;
    const entries = getEntries().map(en =>
      en.id === this._selectedEntry ? { ...en, pendingDelete: true } : en
    );
    await saveEntries(entries);
  }

  async _onClickCancelDelete() {
    if (!this._selectedEntry) return;
    const entries = getEntries().map(en =>
      en.id === this._selectedEntry ? { ...en, pendingDelete: false } : en
    );
    await saveEntries(entries);
  }

  async _onClickGmDelete() {
    if (!this._selectedEntry) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window:  { title: "Delete Entry" },
      content: "<p>Permanently delete this entry? This cannot be undone.</p>",
    });
    if (!ok) return;
    const entries = getEntries().filter(en => en.id !== this._selectedEntry);
    this._selectedEntry = null;
    await saveEntries(entries);
  }

  async _onClickEntryLink(el) {
    this._selectedEntry = el.dataset.id;
    this.render({ force: true });
  }

  // ── Delegated listener setup ─────────────────────────────────────────────

  _attachDelegatedListeners() {
    if (this._listenersReady) return;
    this._listenersReady = true;

    const inApp = (e) => !!(this.element?.contains(e.target));

    const _click = async (e) => {
      if (!inApp(e)) return;

      const catTab = e.target.closest(".wiki-cat-tab");
      if (catTab) return this._onClickCatTab(catTab);

      const entryItem = e.target.closest(".wiki-entry-item");
      if (entryItem) return this._onClickEntryItem(entryItem);

      if (e.target.closest(".wiki-btn-toggle-hidden")) return this._onClickToggleHidden();

      if (e.target.closest(".wiki-btn-new")) return this._onClickNew();

      if (e.target.closest(".wiki-btn-settings")) {
        new WikiCategorySettings().render(true);
        return;
      }

      if (e.target.closest(".wiki-btn-edit")) return this._onClickEdit();

      if (e.target.closest(".wiki-btn-request-delete")) return this._onClickRequestDelete();

      if (e.target.closest(".wiki-btn-cancel-delete")) return this._onClickCancelDelete();

      if (e.target.closest(".wiki-btn-delete")) return this._onClickGmDelete();

      const entryLink = e.target.closest(".wiki-entry-link[data-id]");
      if (entryLink) {
        e.preventDefault();
        return this._onClickEntryLink(entryLink);
      }

      const missingLink = e.target.closest(".wiki-entry-link-missing");
      if (missingLink) {
        e.preventDefault();
        ui.notifications.warn(`Adventurer Wiki: No entry found named "${missingLink.textContent}".`);
        return;
      }

      if (e.target.closest(".wiki-comment-submit")) {
        await this._submitComment();
        return;
      }

      const commentDelBtn = e.target.closest(".wiki-comment-delete");
      if (commentDelBtn) {
        await this._deleteComment(commentDelBtn.dataset.commentId);
        return;
      }
    };

    const _input = (e) => {
      if (!inApp(e)) return;
      if (!e.target.matches(".wiki-search")) return;
      this._searchQuery = e.target.value;
      this.render({ force: true });
    };

    const _keydown = (e) => {
      if (!inApp(e)) return;
      if (!e.target.matches(".wiki-comment-input")) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this._submitComment();
      }
    };

    document.addEventListener("click",   _click,   { capture: true });
    document.addEventListener("input",   _input,   { capture: true });
    document.addEventListener("keydown", _keydown, { capture: true });
    this._docListeners = { _click, _input, _keydown };
  }

  // ── Comment actions ──────────────────────────────────────────────────────

  async _submitComment() {
    if (!this._selectedEntry) return;

    const commentInput = this.element?.querySelector(".wiki-comment-input");
    const text         = commentInput?.value?.trim();
    if (!text) return;

    const entries  = getEntries();
    const entryIdx = entries.findIndex(e => e.id === this._selectedEntry);
    if (entryIdx === -1) return;

    const comment = {
      id:         generateId(),
      authorName: game.user.name,
      userId:     game.user.id,
      text,
      createdAt:  Date.now(),
    };

    if (!entries[entryIdx].comments) entries[entryIdx].comments = [];
    entries[entryIdx].comments.push(comment);

    const saved = await saveEntries(entries);
    if (saved !== false && commentInput) commentInput.value = "";
  }

  async _deleteComment(commentId) {
    if (!this._selectedEntry) return;

    const entries  = getEntries();
    const entryIdx = entries.findIndex(e => e.id === this._selectedEntry);
    if (entryIdx === -1) return;

    entries[entryIdx].comments = (entries[entryIdx].comments ?? []).filter(c => c.id !== commentId);
    await saveEntries(entries);
  }

  // ── Close ────────────────────────────────────────────────────────────────

  async close(options) {
    if (this._docListeners) {
      const { _click, _input, _keydown } = this._docListeners;
      document.removeEventListener("click",   _click,   { capture: true });
      document.removeEventListener("input",   _input,   { capture: true });
      document.removeEventListener("keydown", _keydown, { capture: true });
      this._docListeners    = null;
      this._listenersReady  = false;
    }
    openWikiApps.delete(this);
    return super.close(options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WikiEntryEditor — creates / edits wiki entries
// ─────────────────────────────────────────────────────────────────────────────

class WikiEntryEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id:       "party-wiki-editor",
    classes:  ["party-wiki", "party-wiki-editor"],
    window:   { title: "Adventurer Wiki – Edit Entry", resizable: true },
    position: { width: 680, height: 580 },
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/editor.html` } };

  constructor(entry, wikiApp, options = {}) {
    super(options);
    this._entry             = entry;
    this._wikiApp           = wikiApp;
    this._broadcastedStart  = false;
    this._pmEditor          = null;
  }

  // ── Context ──────────────────────────────────────────────────────────────

  async _prepareContext(_options) {
    const entry = this._entry ?? { title: "", category: "lore", content: "" };
    return {
      entry,
      categories: getCategories(),
      isNew:      !entry.id,
      isGM:       game.user.isGM,
    };
  }

  // ── Render lifecycle ─────────────────────────────────────────────────────

  async _onRender(context, options) {
    const el = this.element;
    activeEditorApp = this;

    if (!this._hasOpened) {
      this._hasOpened = true;
      (this.bringToFront ?? this.bringToTop)?.call(this);
    }

    // ── Broadcast editing start ──────
    if (!this._broadcastedStart && this._entry?.id) {
      this._broadcastedStart = true;
      activeEditors.set(this._entry.id, { userName: game.user.name, userId: game.user.id });
      game.socket.emit(SOCKET_EVENT, {
        action:   "editingStart",
        entryId:  this._entry.id,
        userName: game.user.name,
        userId:   game.user.id,
      });
      refreshAllWikiApps();
    }

    // ── One-time editor setup ────────
    if (!this._editorReady) {
      this._editorReady = true;

      const editorDiv   = el.querySelector(".wiki-rich-editor");
      const textarea    = el.querySelector("textarea[name='content']");
      const initContent = this._entry?.content ?? "";

      if (editorDiv && textarea) {
        editorDiv.innerHTML = initContent;

        // ── Standard format toolbar buttons ──────────────────────────────
        el.querySelectorAll(".wiki-toolbar-btn[data-cmd]").forEach(btn => {
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const cmd   = btn.dataset.cmd;
            const value = btn.dataset.value ?? null;
            if (cmd === "formatBlock" && value && value !== "p") {
              const cur = document.queryCommandValue("formatBlock").toLowerCase().replace(/[<>]/g, "");
              if (cur === value.toLowerCase()) {
                document.execCommand("formatBlock", false, "p");
                editorDiv.focus();
                return;
              }
            }
            document.execCommand(cmd, false, value);
            editorDiv.focus();
          });
        });

        // ── [[Link]] button ───────────────────────────────────────────────
        el.querySelector(".wiki-toolbar-btn-link")?.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const sel = window.getSelection();
          if (!sel?.rangeCount) { editorDiv.focus(); return; }

          const range    = sel.getRangeAt(0);
          const selected = range.toString();
          const label    = selected || "Entry Title";

          range.deleteContents();
          const node = document.createTextNode(`[[${label}]]`);
          range.insertNode(node);

          const start = 2;
          range.setStart(node, start);
          range.setEnd(node, start + label.length);
          sel.removeAllRanges();
          sel.addRange(range);
          editorDiv.focus();
        });

        // ── Image upload button ───────────────────────────────────────────
        // Uses mousedown + preventDefault to keep editor focus, saves the
        // cursor range before FilePicker opens, then restores it in callback.
        el.querySelector(".wiki-toolbar-btn-image")?.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (!game.user.can("FILES_UPLOAD")) {
            ui.notifications.warn(
              "Adventurer Wiki: You need file upload permissions to insert images. " +
              "Ask your GM to enable this in world settings."
            );
            return;
          }

          // Resolve FilePicker — global deprecated in v13, removed in v15
          const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;

          // Capture the current selection range before focus leaves the editor
          const sel = window.getSelection();
          let savedRange = null;
          if (sel?.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();

          new FP({
            type: "image",
            callback: (path) => {
              // Restore caret position in the editor
              editorDiv.focus();
              if (savedRange) {
                const newSel = window.getSelection();
                newSel.removeAllRanges();
                newSel.addRange(savedRange);
              }
              const imgHtml = `<img src="${path}" class="wiki-inserted-image" alt="">`;
              document.execCommand("insertHTML", false, imgHtml);
              editorDiv.focus();
            },
          }).render(true);
        });

        // ── Doodle button ─────────────────────────────────────────────────
        el.querySelector(".wiki-toolbar-btn-doodle")?.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (!game.user.can("FILES_UPLOAD")) {
            ui.notifications.warn(
              "Adventurer Wiki: You need file upload permissions to insert doodles. " +
              "Ask your GM to enable this in world settings."
            );
            return;
          }
          new WikiDoodleEditor(editorDiv).render(true);
        });

        // ── Ctrl+Enter to save ────────────────────────────────────────────
        editorDiv.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this._handleSave(el.querySelector("form"));
          }
        });
      }

      // ── GM-only fields ───────────────
      if (game.user.isGM) {
        const gmNotesEl = el.querySelector(".wiki-gm-notes-input");
        if (gmNotesEl && !this._gmNotesReady) {
          this._gmNotesReady = true;
          gmNotesEl.value = this._entry?.gmNotes ?? "";
        }

        const hiddenEl = el.querySelector(".wiki-hidden-checkbox");
        if (hiddenEl) hiddenEl.checked = this._entry?.hidden ?? false;
      }
    }

    // ── Form submission wiring ───────
    el.querySelector("form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this._handleSave(el.querySelector("form"));
    });

    el.querySelector(".wiki-btn-save")?.addEventListener("click", async (e) => {
      e.preventDefault();
      await this._handleSave(el.querySelector("form"));
    });
  }

  // ── Save logic ───────────────────────────────────────────────────────────

  async _handleSave(form) {
    const fd       = new FormData(form);
    const title    = fd.get("title")?.trim();
    const category = fd.get("category");

    const editorDiv = this.element?.querySelector(".wiki-rich-editor");
    const content   = editorDiv ? editorDiv.innerHTML : (fd.get("content") ?? "");

    if (!title) {
      ui.notifications.warn("Please enter a title for the entry.");
      return;
    }

    const gmNotesEl = this.element?.querySelector(".wiki-gm-notes-input");
    const hiddenEl  = this.element?.querySelector(".wiki-hidden-checkbox");
    const gmNotes   = game.user.isGM ? (gmNotesEl?.value ?? this._entry?.gmNotes ?? "") : undefined;
    const hidden    = game.user.isGM ? (hiddenEl?.checked ?? false) : undefined;

    const entries = getEntries();
    const now     = Date.now();

    if (this._entry?.id) {
      // ── Update existing entry ────────
      const idx = entries.findIndex(e => e.id === this._entry.id);
      if (idx !== -1) {
        entries[idx] = {
          ...entries[idx],
          title,
          category,
          content,
          updatedAt:     now,
          updatedBy:     game.user.name,
          pendingDelete: false,
          comments:      entries[idx].comments ?? [],
          ...(game.user.isGM ? { gmNotes, hidden } : {}),
        };
      }
    } else {
      // ── Create new entry ─────────────
      entries.push({
        id:            generateId(),
        title,
        category,
        content,
        createdAt:     now,
        updatedAt:     now,
        createdBy:     game.user.name,
        updatedBy:     game.user.name,
        pendingDelete: false,
        hidden:        hidden ?? false,
        comments:      [],
        ...(game.user.isGM ? { gmNotes } : {}),
      });
    }

    const saved = await saveEntries(entries);
    if (saved === false) return;

    this._wikiApp.render();
    this.close();
  }

  // ── Editing broadcast ────────────────────────────────────────────────────

  _broadcastEditingStop() {
    if (this._broadcastedStart && this._entry?.id) {
      this._broadcastedStart = false;
      activeEditors.delete(this._entry.id);
      game.socket.emit(SOCKET_EVENT, {
        action:  "editingStop",
        entryId: this._entry.id,
        userId:  game.user.id,
      });
      refreshAllWikiApps();
    }
  }

  async close(options) {
    this._broadcastEditingStop();
    this._editorReady = false;
    if (activeEditorApp === this) activeEditorApp = null;
    return super.close(options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WikiDoodleEditor — canvas-based hand-drawn image editor
// Saves doodle as PNG to worlds/{worldId}/adventurer-wiki/images/ via
// Foundry's FilePicker.upload(), then inserts an <img> tag at the editor cursor.
// ─────────────────────────────────────────────────────────────────────────────

class WikiDoodleEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id:       "party-wiki-doodle",
    classes:  ["party-wiki", "party-wiki-doodle"],
    window:   { title: "Adventurer Wiki – Doodle", resizable: true },
    position: { width: 860, height: 560 },
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/doodle-editor.html` } };

  /**
   * @param {HTMLElement} editorDiv  The .wiki-rich-editor contenteditable element
   *                                  from the parent WikiEntryEditor. The doodle
   *                                  will be inserted here when the user clicks Insert.
   */
  constructor(editorDiv, options = {}) {
    super(options);
    this._editorDiv  = editorDiv;
    this._isDrawing  = false;
    this._tool       = "pen";     // "pen" | "eraser"
    this._color      = "#1a1a1a";
    this._strokeSize = 4;
    this._lastX      = 0;
    this._lastY      = 0;
    this._canvas     = null;
    this._ctx        = null;
  }

  async _prepareContext() { return {}; }

  // ── Render lifecycle ─────────────────────────────────────────────────────

  async _onRender(_context, _options) {
    const el     = this.element;
    const canvas = el.querySelector(".wiki-doodle-canvas");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    this._canvas = canvas;
    this._ctx    = ctx;

    // Paint a white background so the canvas isn't transparent
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ── Tool buttons ──────────────────────────────────────────────────────
    const penBtn    = el.querySelector(".wiki-doodle-pen");
    const eraserBtn = el.querySelector(".wiki-doodle-eraser");

    penBtn?.addEventListener("click", () => {
      this._tool = "pen";
      penBtn.classList.add("active");
      eraserBtn?.classList.remove("active");
    });

    eraserBtn?.addEventListener("click", () => {
      this._tool = "eraser";
      eraserBtn.classList.add("active");
      penBtn?.classList.remove("active");
    });

    // ── Color picker ──────────────────────────────────────────────────────
    el.querySelector(".wiki-doodle-color")?.addEventListener("input", (e) => {
      this._color = e.target.value;
    });

    // ── Stroke size slider ────────────────────────────────────────────────
    el.querySelector(".wiki-doodle-size")?.addEventListener("input", (e) => {
      this._strokeSize = parseInt(e.target.value, 10);
    });

    // ── Clear button ──────────────────────────────────────────────────────
    el.querySelector(".wiki-doodle-clear")?.addEventListener("click", () => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    });

    // ── Insert button ─────────────────────────────────────────────────────
    el.querySelector(".wiki-doodle-insert")?.addEventListener("click", () => {
      this._insertDoodle();
    });

    // ── Cancel button ─────────────────────────────────────────────────────
    el.querySelector(".wiki-doodle-cancel")?.addEventListener("click", () => {
      this.close();
    });

    // ── Mouse drawing ─────────────────────────────────────────────────────
    canvas.addEventListener("mousedown",  (e) => this._startDrawing(e));
    canvas.addEventListener("mousemove",  (e) => this._continueDrawing(e));
    canvas.addEventListener("mouseup",    ()  => { this._isDrawing = false; });
    canvas.addEventListener("mouseleave", ()  => { this._isDrawing = false; });

    // ── Touch drawing (tablets / touch screens) ───────────────────────────
    canvas.addEventListener("touchstart", (e) => { e.preventDefault(); this._startDrawing(e.touches[0]); },  { passive: false });
    canvas.addEventListener("touchmove",  (e) => { e.preventDefault(); this._continueDrawing(e.touches[0]); }, { passive: false });
    canvas.addEventListener("touchend",   ()  => { this._isDrawing = false; });
  }

  // ── Drawing helpers ──────────────────────────────────────────────────────

  /** Convert a pointer/touch event into canvas-space coordinates. */
  _getCanvasPos(e) {
    const rect   = this._canvas.getBoundingClientRect();
    const scaleX = this._canvas.width  / rect.width;
    const scaleY = this._canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  }

  _startDrawing(e) {
    this._isDrawing = true;
    const pos = this._getCanvasPos(e);
    this._lastX = pos.x;
    this._lastY = pos.y;

    // Draw a dot at the click position so single clicks leave a mark
    const ctx    = this._ctx;
    const radius = this._tool === "eraser"
      ? this._strokeSize * 1.5
      : this._strokeSize / 2;

    ctx.save();
    if (this._tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = this._color;
    }
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(radius, 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _continueDrawing(e) {
    if (!this._isDrawing) return;
    const pos = this._getCanvasPos(e);
    const ctx = this._ctx;

    ctx.save();
    ctx.lineCap  = "round";
    ctx.lineJoin = "round";

    if (this._tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth   = this._strokeSize * 3;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = this._color;
      ctx.lineWidth   = this._strokeSize;
    }

    ctx.beginPath();
    ctx.moveTo(this._lastX, this._lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.restore();

    this._lastX = pos.x;
    this._lastY = pos.y;
  }

  /**
   * Export the canvas as PNG, upload to Foundry data folder, then insert an
   * <img> tag at the current cursor position in the parent editor div.
   */
  async _insertDoodle() {
    if (!game.user.can("FILES_UPLOAD")) {
      ui.notifications.warn(
        "Adventurer Wiki: You need file upload permissions to save doodles. " +
        "Ask your GM to enable this in world settings."
      );
      return;
    }

    // Resolve FilePicker — global deprecated in v13, removed in v15
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;

    const parentPath = `worlds/${game.world.id}/adventurer-wiki`;
    const folderPath = `worlds/${game.world.id}/adventurer-wiki/images`;

    // Ensure the directory hierarchy exists. Foundry returns an error if a
    // directory already exists, so we catch those silently. We create the
    // parent first, then the images subfolder.
    try {
      await FP.createDirectory("data", parentPath);
    } catch (e) {
      if (!e?.message?.toLowerCase().includes("already")) {
        console.warn("Adventurer Wiki | Could not create parent dir:", e);
      }
    }
    try {
      await FP.createDirectory("data", folderPath);
    } catch (e) {
      if (!e?.message?.toLowerCase().includes("already")) {
        console.warn("Adventurer Wiki | Could not create images dir:", e);
      }
    }

    // Composite onto a white background before exporting so eraser strokes
    // appear white rather than transparent in the final PNG.
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width  = this._canvas.width;
    exportCanvas.height = this._canvas.height;

    const exportCtx = exportCanvas.getContext("2d");
    exportCtx.fillStyle = "#ffffff";
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    exportCtx.drawImage(this._canvas, 0, 0);

    exportCanvas.toBlob(async (blob) => {
      if (!blob) {
        ui.notifications.error("Adventurer Wiki: Failed to create doodle image.");
        return;
      }

      const filename = `doodle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`;
      const file     = new File([blob], filename, { type: "image/png" });

      try {
        const result = await FP.upload("data", folderPath, file, {});

        if (!result?.path) throw new Error("Upload returned no path");

        const imgHtml = `<img src="${result.path}" class="wiki-inserted-image" alt="doodle">`;

        // Restore focus to the entry editor and insert the image at the cursor
        if (this._editorDiv) {
          this._editorDiv.focus();
          document.execCommand("insertHTML", false, imgHtml);
        }

        ui.notifications.info("Adventurer Wiki: Doodle inserted!");
        this.close();
      } catch (err) {
        console.error("Adventurer Wiki | Doodle upload failed:", err);
        ui.notifications.error(
          "Adventurer Wiki: Failed to upload doodle. Check your file permissions and try again."
        );
      }
    }, "image/png");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WikiCategorySettings — manage custom categories
// ─────────────────────────────────────────────────────────────────────────────

class WikiCategorySettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id:       "party-wiki-cat-settings",
    classes:  ["party-wiki", "party-wiki-settings"],
    window:   { title: "Adventurer Wiki – Category Settings", resizable: false },
    position: { width: 540, height: 520 },
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/category-settings.html` } };

  constructor(options = {}) {
    super(options);
    this._working = foundry.utils.deepClone(getCategories());
  }

  // ── Context ──────────────────────────────────────────────────────────────

  async _prepareContext() {
    const entries    = getEntries();
    const categories = this._working.map((cat, idx) => ({
      ...cat,
      count:   entries.filter(e => e.category === cat.id).length,
      isFirst: idx === 0,
      isLast:  idx === this._working.length - 1,
    }));
    return { categories };
  }

  // ── Render lifecycle ─────────────────────────────────────────────────────

  _onRender(_context, _options) { this._attachListeners(); }

  // ── Listener setup ───────────────────────────────────────────────────────

  _attachListeners() {
    if (this._listenersReady) return;
    this._listenersReady = true;

    const inApp = (e) => !!(this.element?.contains(e.target));

    const _click = async (e) => {
      if (!inApp(e)) return;

      // ── Delete category button ───────
      const deleteBtn = e.target.closest(".wiki-cat-delete-btn:not([disabled])");
      if (deleteBtn) {
        const catId = deleteBtn.dataset.catId;
        const row   = this.element.querySelector(`.wiki-cat-row[data-id="${catId}"]`);
        const label = row?.querySelector(".wiki-cat-label-input")?.value?.trim() ?? catId;
        const ok    = await foundry.applications.api.DialogV2.confirm({
          window:  { title: "Delete Category" },
          content: `<p>Remove the category "<strong>${label}</strong>"? This cannot be undone.</p>`,
        });
        if (!ok) return;
        this._syncFromDOM();
        this._working = this._working.filter(c => c.id !== catId);
        this.render({ force: true });
        return;
      }

      // ── Move up button ───────────────
      const upBtn = e.target.closest(".wiki-cat-move-up");
      if (upBtn) {
        this._syncFromDOM();
        const catId = upBtn.dataset.catId;
        const idx   = this._working.findIndex(c => c.id === catId);
        if (idx > 0) {
          [this._working[idx - 1], this._working[idx]] = [this._working[idx], this._working[idx - 1]];
          this.render({ force: true });
        }
        return;
      }

      // ── Move down button ─────────────
      const downBtn = e.target.closest(".wiki-cat-move-down");
      if (downBtn) {
        this._syncFromDOM();
        const catId = downBtn.dataset.catId;
        const idx   = this._working.findIndex(c => c.id === catId);
        if (idx < this._working.length - 1) {
          [this._working[idx], this._working[idx + 1]] = [this._working[idx + 1], this._working[idx]];
          this.render({ force: true });
        }
        return;
      }

      // ── Add new category button ──────
      if (e.target.closest(".wiki-cat-add-btn")) {
        const labelInput = this.element.querySelector(".wiki-cat-new-label");
        const iconInput  = this.element.querySelector(".wiki-cat-new-icon");
        const label      = labelInput?.value?.trim();
        const icon       = iconInput?.value?.trim() || "fa-tag";

        if (!label) {
          ui.notifications.warn("Adventurer Wiki: Please enter a category name.");
          return;
        }

        const id = label
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || `cat-${Date.now()}`;

        if (this._working.find(c => c.id === id)) {
          ui.notifications.warn(`Adventurer Wiki: A category named "${label}" already exists.`);
          return;
        }

        this._syncFromDOM();
        this._working.push({ id, label, icon });
        if (labelInput) labelInput.value = "";
        if (iconInput)  iconInput.value  = "";
        this.render({ force: true });
        return;
      }

      if (e.target.closest(".wiki-cat-save-btn")) { await this._save(); return; }

      if (e.target.closest(".wiki-cat-cancel-btn")) { this.close(); return; }
    };

    const _input = (e) => {
      if (!inApp(e)) return;
      if (e.target.matches(".wiki-cat-icon-input")) {
        const row    = e.target.closest(".wiki-cat-row");
        const iconEl = row?.querySelector(".wiki-cat-preview-icon");
        if (iconEl) iconEl.className = `fas ${e.target.value.trim() || "fa-tag"} wiki-cat-preview-icon`;
      }
    };

    document.addEventListener("click", _click, { capture: true });
    document.addEventListener("input", _input, { capture: true });
    this._docListeners = { _click, _input };
  }

  // ── DOM sync ─────────────────────────────────────────────────────────────

  _syncFromDOM() {
    const rows = this.element?.querySelectorAll(".wiki-cat-row") ?? [];
    for (const row of rows) {
      const catId = row.dataset.id;
      const cat   = this._working.find(c => c.id === catId);
      if (!cat) continue;

      const label = row.querySelector(".wiki-cat-label-input")?.value?.trim();
      const icon  = row.querySelector(".wiki-cat-icon-input")?.value?.trim();

      if (label) cat.label = label;
      if (icon)  cat.icon  = icon;
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  async _save() {
    this._syncFromDOM();

    if (this._working.length === 0) {
      ui.notifications.warn("Adventurer Wiki: You must keep at least one category.");
      return;
    }

    for (const cat of this._working) {
      if (!cat.label?.trim()) {
        ui.notifications.warn("Adventurer Wiki: All categories must have a name.");
        return;
      }
    }

    await game.settings.set(MODULE_ID, CATS_SETTING_KEY, this._working);
    game.socket.emit(SOCKET_EVENT, { action: "categoriesChanged" });
    refreshAllWikiApps();
    ui.notifications.info("Adventurer Wiki: Categories saved.");
    this.close();
  }

  // ── Close ────────────────────────────────────────────────────────────────

  async close(options) {
    if (this._docListeners) {
      const { _click, _input } = this._docListeners;
      document.removeEventListener("click", _click, { capture: true });
      document.removeEventListener("input", _input, { capture: true });
      this._docListeners   = null;
      this._listenersReady = false;
    }
    return super.close(options);
  }
}

globalThis.AdventurerWikiApp = PartyWikiApp;
