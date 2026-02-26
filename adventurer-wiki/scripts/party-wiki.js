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
 */

const MODULE_ID    = "adventurer-wiki";
const SETTING_KEY  = "wikiEntries";
const SOCKET_EVENT = `module.${MODULE_ID}`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const DEFAULT_CATEGORIES = [
  { id: "lore",      label: "Lore",          icon: "fa-book-open"    },
  { id: "locations", label: "Locations",     icon: "fa-map-location-dot" },
  { id: "npcs",      label: "NPCs",          icon: "fa-person"       },
  { id: "factions",  label: "Factions",      icon: "fa-shield-halved"},
  { id: "quests",    label: "Quests",        icon: "fa-map-pin"      },
  { id: "items",     label: "Items",         icon: "fa-gem"          },
  { id: "notes",     label: "Session Notes", icon: "fa-scroll"       },
];

const CATS_SETTING_KEY = "wikiCategories";

// Ephemeral map of entryId → { userName, userId } for the soft-lock indicator.
const activeEditors = new Map();

// Tracks all open PartyWikiApp instances so we can refresh them reliably.
// (ApplicationV2 is not registered in ui.windows like V1 apps are.)
const openWikiApps = new Set();

// The currently open WikiEntryEditor, if any. Kept so refreshAllWikiApps()
// can restore it to the front after a wiki re-render steals focus.
let activeEditorApp = null;

// ─── Settings ─────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name:    "Wiki Entries",
    scope:   "world",
    config:  false,
    // No `type` field – Foundry stores and returns the value as raw JSON.
    // Specifying `type: Array` in v13 causes the loaded value to be wrapped
    // in a second array (Array([...]) === [[...]]), breaking getEntries().
    default: [],
  });

  game.settings.register(MODULE_ID, CATS_SETTING_KEY, {
    name:    "Wiki Categories",
    scope:   "world",
    config:  false,
    default: DEFAULT_CATEGORIES,
  });
});

// ─── Sockets ──────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  console.log("Adventurer Wiki | Module loaded successfully.");

  game.socket.on(SOCKET_EVENT, async (payload) => {
    switch (payload.action) {

      case "requestSave": {
        if (!game.user.isGM) return;
        await game.settings.set(MODULE_ID, SETTING_KEY, payload.entries);
        // Explicitly notify other clients and refresh locally.
        // updateSetting is a backup; the socket is the guaranteed immediate path.
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

  // Re-render all open wikis on every client the moment the entries setting changes.
  // Foundry fires this hook locally on the writer AND broadcasts it to all other
  // connected clients, so it's far more reliable than manual socket-based refresh.
  Hooks.on("updateSetting", (setting) => {
    // Foundry v12 uses _id; v13 may expose .id or .key — check all three.
    const id = setting.id ?? setting._id ?? setting.key ?? "";
    if (id === `${MODULE_ID}.${SETTING_KEY}`) refreshAllWikiApps();
  });

  Hooks.on("userConnected", (user, connected) => {
    if (!connected) {
      // User disconnected – release any soft-lock they held.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Replace [[Entry Title]] patterns in rendered HTML with clickable anchor tags.
 * Matched entries get a data-id attribute; unmatched get the "missing" class.
 * The regex only matches in text — it won't touch existing HTML attributes.
 */
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
  // Always return a deep clone so callers can push/mutate freely without
  // accidentally dirtying the in-memory settings object. Without this,
  // a failed save (e.g. no GM online) that pushed to the local array would
  // cause the phantom entry to appear on the next re-render.
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

/**
 * Persist entries to the world setting.
 * Returns true on success, false if blocked (no GM online).
 * The editor checks the return value and stays open if false.
 */
async function saveEntries(entries) {
  if (game.user.isGM) {
    await game.settings.set(MODULE_ID, SETTING_KEY, entries);
    game.socket.emit(SOCKET_EVENT, { action: "refresh" });
    refreshAllWikiApps();
    return true;
  }

  // Players relay saves through the GM via socket.
  const activeGM = game.users.find(u => u.isGM && u.active);
  if (!activeGM) {
    // No GM online — block the save to prevent data loss.
    // (A local-queue approach risks overwriting other players' changes
    //  or losing data if the GM edits before the queue flushes.)
    ui.notifications.warn(
      "Adventurer Wiki: A GM must be connected to save. " +
      "Your work is still in the editor — please try again once a GM joins."
    );
    return false; // caller should keep editor open
  }

  // GM is online — relay immediately.
  game.socket.emit(SOCKET_EVENT, { action: "requestSave", entries });
  return true;
}

function generateId() {
  return `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function refreshAllWikiApps() {
  // Collect the render promises so we can wait for every wiki window to
  // finish its async render cycle (which internally calls bringToFront on
  // itself) before we restore the editor to the front.
  const renders = Array.from(openWikiApps).map(app => app.render({ force: true }));
  if (activeEditorApp) {
    const editor = activeEditorApp;
    // bringToFront is the v13 name; fall back to bringToTop for v12 compatibility.
    Promise.all(renders).then(() => (editor.bringToFront ?? editor.bringToTop)?.call(editor));
  }
}

// ─── Toolbar Button ────────────────────────────────────────────────────────────

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

  const li  = document.createElement("li");
  const isV12 = !!document.querySelector("#scene-controls-layers");

  if (isV12) {
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = "control ui-control layer icon fa-solid fa-book-open party-wiki-control-btn";
    btn.setAttribute("data-tooltip", "Adventurer Wiki");
    btn.setAttribute("aria-label",   "Adventurer Wiki");
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      new PartyWikiApp().render(true);
    });
    li.appendChild(btn);
  } else {
    li.className = "scene-control party-wiki-control-btn";
    li.setAttribute("title", "Adventurer Wiki");
    li.style.color = "#c0392b";
    li.innerHTML = '<i class="fas fa-book-open"></i>';
    li.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      new PartyWikiApp().render(true);
    });
  }

  list.appendChild(li);
  console.log("Adventurer Wiki | Button added to scene controls.");
}

// ─── Main Wiki Application (ApplicationV2) ────────────────────────────────────

class PartyWikiApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id:       "party-wiki-app",
    classes:  ["party-wiki"],
    window:   { title: "Adventurer Wiki", resizable: true },
    position: { width: 820, height: 620 },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/wiki.html` },
  };

  _activeCat     = DEFAULT_CATEGORIES[0].id;
  _selectedEntry = null;
  _searchQuery   = "";

  async _prepareContext(_options) {
    const entries = getEntries();
    const isGM    = game.user.isGM;

    const q = this._searchQuery.toLowerCase();

    // Filter rules:
    //  • Hidden entries are invisible to non-GMs in every view.
    //  • Search mode: match title OR stripped body text, across all categories.
    //  • Default: active category only.
    const filtered = entries.filter(e => {
      if (e.hidden && !isGM) return false;
      if (q) {
        const titleHit = e.title.toLowerCase().includes(q);
        const bodyText = e.content ? e.content.replace(/<[^>]*>/g, " ").toLowerCase() : "";
        return titleHit || bodyText.includes(q);
      }
      return e.category === this._activeCat;
    });

    // Clear selected entry if it no longer exists or is now hidden from this user.
    if (this._selectedEntry) {
      const sel = entries.find(e => e.id === this._selectedEntry);
      if (!sel || (sel.hidden && !isGM)) this._selectedEntry = null;
    }
    const current = this._selectedEntry
      ? (entries.find(e => e.id === this._selectedEntry) ?? null)
      : null;

    // Support both v12 (global TextEditor) and v13+ (namespaced)
    const _TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    const enrichedContent = current?.content
      ? await _TextEditor.enrichHTML(current.content, { async: true })
      : null;

    const pendingDeletions = entries.filter(e => e.pendingDelete).length;

    const entriesWithStatus = filtered.map(e => {
      // bodyMatch: true only when the query matched in body text but NOT in title,
      // so the sidebar can show a small "in text" indicator.
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
        beingEditedBy: activeEditors.get(e.id)?.userName ?? null,
        // Category badge when search results span multiple categories.
        categoryLabel: q
          ? (cats.find(c => c.id === e.category)?.label ?? e.category)
          : null,
        bodyMatch,
      };
    });

    const currentEditor = current ? (activeEditors.get(current.id)?.userName ?? null) : null;

    const cats = getCategories();
    if (!cats.find(c => c.id === this._activeCat)) {
      this._activeCat = cats[0]?.id ?? null;
    }

    // Per-category counts.
    const categoriesWithCount = cats.map(cat => ({
      ...cat,
      count: entries.filter(e => e.category === cat.id).length,
    }));

    // Format updatedAt as a human-readable local timestamp for the viewer.
    const updatedAtFormatted = current?.updatedAt
      ? new Date(current.updatedAt).toLocaleString(undefined, {
          month: "short", day: "numeric", year: "numeric",
          hour: "numeric", minute: "2-digit",
        })
      : null;

    // Process [[Entry Title]] links in the main content.
    const enrichedContentLinked = processEntryLinks(enrichedContent, entries);

    // GM-only notes (plain text; only passed to GM clients).
    const gmNotes = isGM ? (current?.gmNotes ?? null) : null;

    // Format each comment's timestamp and compute per-comment delete permission.
    // Players can delete their own comments; the GM can delete any comment.
    const formattedComments = (current?.comments ?? []).map(c => ({
      ...c,
      createdAtFormatted: new Date(c.createdAt).toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      }),
      canDelete: isGM || c.userId === game.user.id,
    }));

    // Show a banner when no GM is online so players know saves are blocked.
    const gmOnline = game.user.isGM || !!game.users.find(u => u.isGM && u.active);

    return {
      categories:         categoriesWithCount,
      activeCat:          this._activeCat,
      entries:            entriesWithStatus,
      current,
      currentEditor,
      enrichedContent:    enrichedContentLinked,
      gmNotes,
      formattedComments,
      hasComments:        formattedComments.length > 0,
      isGM,
      gmOnline,
      searchQuery:        this._searchQuery,
      isSearching:        !!this._searchQuery,
      noEntries:          filtered.length === 0,
      pendingDeletions,
      updatedAtFormatted,
    };
  }

  _onRender(_context, _options) {
    openWikiApps.add(this);

    // Attach all interaction handlers via delegation once per lifecycle.
    // Delegation on this.element is the key: this.element is the persistent
    // window container and survives every DOM replacement triggered by re-renders.
    // querySelector-based listeners attached here would be thrown away with the
    // old DOM; delegated listeners on this.element are never thrown away.
    this._attachDelegatedListeners();

    // Restore search-bar focus and cursor position after every re-render.
    if (this._searchQuery) {
      const searchEl = this.element.querySelector(".wiki-search");
      if (searchEl) {
        searchEl.focus();
        const len = searchEl.value.length;
        searchEl.setSelectionRange(len, len);
      }
    }
  }

  /**
   * Set up all click / input / keydown listeners via document-level capture.
   *
   * WHY capture phase on document?
   * ApplicationV2 in Foundry v13 intercepts certain events in its own pipeline
   * before they can bubble up to this.element.  Attaching to `document` in the
   * *capture* phase fires our handler BEFORE anything else in the page,
   * guaranteeing we always see every event.  We then immediately bail out if
   * the event did not originate inside our application window.
   *
   * The _listenersReady guard ensures the three document listeners are attached
   * exactly ONCE per application lifetime.  They are removed in close().
   */
  _attachDelegatedListeners() {
    if (this._listenersReady) return;
    this._listenersReady = true;

    // Helper: is the event target inside our application element?
    const inApp = (e) => !!(this.element?.contains(e.target));

    // ── Click ─────────────────────────────────────────────────────────────────
    const _click = async (e) => {
      if (!inApp(e)) return;

      // Category tabs.
      const catTab = e.target.closest(".wiki-cat-tab");
      if (catTab) {
        this._activeCat     = catTab.dataset.cat;
        this._selectedEntry = null;
        this.render({ force: true });
        return;
      }

      // Sidebar entry items.
      const entryItem = e.target.closest(".wiki-entry-item");
      if (entryItem) {
        this._selectedEntry = entryItem.dataset.id;
        this.render({ force: true });
        return;
      }

      // Hidden toggle in the entry header (GM only, real-time save).
      if (e.target.closest(".wiki-btn-toggle-hidden")) {
        if (!this._selectedEntry || !game.user.isGM) return;
        const entries = getEntries();
        const idx     = entries.findIndex(en => en.id === this._selectedEntry);
        if (idx === -1) return;
        entries[idx] = { ...entries[idx], hidden: !entries[idx].hidden };
        await saveEntries(entries);
        return;
      }

      // New entry button.
      if (e.target.closest(".wiki-btn-new")) {
        new WikiEntryEditor({ category: this._activeCat }, this).render(true);
        return;
      }

      // Settings button (GM only)
      if (e.target.closest(".wiki-btn-settings")) {
        new WikiCategorySettings().render(true);
        return;
      }

      // Edit entry button.
      if (e.target.closest(".wiki-btn-edit")) {
        if (!this._selectedEntry) return;
        const entry = getEntries().find(en => en.id === this._selectedEntry);
        if (entry) new WikiEntryEditor(entry, this).render(true);
        return;
      }

      // Player: request deletion flag.
      if (e.target.closest(".wiki-btn-request-delete")) {
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
        return;
      }

      // GM: clear deletion flag.
      if (e.target.closest(".wiki-btn-cancel-delete")) {
        if (!this._selectedEntry) return;
        const entries = getEntries().map(en =>
          en.id === this._selectedEntry ? { ...en, pendingDelete: false } : en
        );
        await saveEntries(entries);
        return;
      }

      // GM: permanently delete entry.
      if (e.target.closest(".wiki-btn-delete")) {
        if (!this._selectedEntry) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
          window:  { title: "Delete Entry" },
          content: "<p>Permanently delete this entry? This cannot be undone.</p>",
        });
        if (!ok) return;
        const entries = getEntries().filter(en => en.id !== this._selectedEntry);
        this._selectedEntry = null;
        await saveEntries(entries);
        return;
      }

      // Entry cross-reference link navigation.
      const entryLink = e.target.closest(".wiki-entry-link[data-id]");
      if (entryLink) {
        e.preventDefault();
        this._selectedEntry = entryLink.dataset.id;
        this.render({ force: true });
        return;
      }

      // Broken entry link — warn the user.
      const missingLink = e.target.closest(".wiki-entry-link-missing");
      if (missingLink) {
        e.preventDefault();
        ui.notifications.warn(
          `Adventurer Wiki: No entry found named "${missingLink.textContent}".`
        );
        return;
      }

      // Post comment button.
      if (e.target.closest(".wiki-comment-submit")) {
        await this._submitComment();
        return;
      }

      // Delete comment button.
      const commentDelBtn = e.target.closest(".wiki-comment-delete");
      if (commentDelBtn) {
        await this._deleteComment(commentDelBtn.dataset.commentId);
        return;
      }
    };

    // ── Input — search bar ────────────────────────────────────────────────────
    const _input = (e) => {
      if (!inApp(e)) return;
      if (!e.target.matches(".wiki-search")) return;
      this._searchQuery = e.target.value;
      this.render({ force: true });
    };

    // ── Keydown — Ctrl+Enter in comment textarea ──────────────────────────────
    const _keydown = (e) => {
      if (!inApp(e)) return;
      if (!e.target.matches(".wiki-comment-input")) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this._submitComment();
      }
    };

    // Register on document in capture phase so Foundry's own pipeline cannot
    // swallow the events before we see them.
    document.addEventListener("click",   _click,   { capture: true });
    document.addEventListener("input",   _input,   { capture: true });
    document.addEventListener("keydown", _keydown, { capture: true });

    // Store references so close() can remove them cleanly.
    this._docListeners = { _click, _input, _keydown };
  }

  /** Post a new comment on the currently selected entry. */
  async _submitComment() {
    if (!this._selectedEntry) return;
    const commentInput = this.element?.querySelector(".wiki-comment-input");
    const text = commentInput?.value?.trim();
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

  /** Delete a single comment from the currently selected entry. */
  async _deleteComment(commentId) {
    if (!this._selectedEntry) return;
    const entries  = getEntries();
    const entryIdx = entries.findIndex(e => e.id === this._selectedEntry);
    if (entryIdx === -1) return;
    entries[entryIdx].comments = (entries[entryIdx].comments ?? [])
      .filter(c => c.id !== commentId);
    await saveEntries(entries);
  }

  async close(options) {
    // Remove the document-level capture listeners we attached in
    // _attachDelegatedListeners() to prevent memory / handler leaks.
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

// ─── Entry Editor (ApplicationV2) ─────────────────────────────────────────────

class WikiEntryEditor extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id:       "party-wiki-editor",
    classes:  ["party-wiki", "party-wiki-editor"],
    window:   { title: "Adventurer Wiki – Edit Entry", resizable: true },
    position: { width: 680, height: 580 },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/editor.html` },
  };

  constructor(entry, wikiApp, options = {}) {
    super(options);
    this._entry            = entry;
    this._wikiApp          = wikiApp;
    this._broadcastedStart = false;
    this._pmEditor         = null;
  }

  async _prepareContext(_options) {
    const entry = this._entry ?? { title: "", category: "lore", content: "" };
    return {
      entry,
      categories: getCategories(),
      isNew:      !entry.id,
      isGM:       game.user.isGM,
    };
  }

  async _onRender(context, options) {
    const el = this.element;

    // Register as the active editor so refreshAllWikiApps() can keep it on top.
    activeEditorApp = this;

    // On the very first render, bring the editor to the front immediately.
    // This covers the initial open before any soft-lock broadcast fires.
    // bringToFront is the v13 name; fall back to bringToTop for v12 compatibility.
    if (!this._hasOpened) {
      this._hasOpened = true;
      (this.bringToFront ?? this.bringToTop)?.call(this);
    }

    // ── Broadcast soft-lock on first open (existing entries only)
    if (!this._broadcastedStart && this._entry?.id) {
      this._broadcastedStart = true;
      activeEditors.set(this._entry.id, {
        userName: game.user.name,
        userId:   game.user.id,
      });
      game.socket.emit(SOCKET_EVENT, {
        action:   "editingStart",
        entryId:  this._entry.id,
        userName: game.user.name,
        userId:   game.user.id,
      });
      refreshAllWikiApps();
    }

    // ── Rich-text editor setup (contenteditable, execCommand-based)
    // Only initialise once per window lifecycle.
    if (!this._editorReady) {
      this._editorReady = true;
      const editorDiv   = el.querySelector(".wiki-rich-editor");
      const textarea    = el.querySelector("textarea[name='content']");
      const initContent = this._entry?.content ?? "";

      if (editorDiv && textarea) {
        // Populate the contenteditable area with existing HTML
        editorDiv.innerHTML = initContent;

        // Toolbar buttons — each carries a data-cmd (execCommand) value.
        // Heading buttons (H2/H3/H4) toggle: clicking an already-active heading
        // reverts the block to a normal paragraph instead of re-applying it.
        el.querySelectorAll(".wiki-toolbar-btn[data-cmd]").forEach(btn => {
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault(); // keep focus in editor
            const cmd   = btn.dataset.cmd;
            const value = btn.dataset.value ?? null;
            if (cmd === "formatBlock" && value && value !== "p") {
              // queryCommandValue returns the tag name, possibly with angle-brackets
              const cur = document.queryCommandValue("formatBlock")
                .toLowerCase().replace(/[<>]/g, "");
              if (cur === value.toLowerCase()) {
                // Already this heading — revert to paragraph
                document.execCommand("formatBlock", false, "p");
                editorDiv.focus();
                return;
              }
            }
            document.execCommand(cmd, false, value);
            editorDiv.focus();
          });
        });

        // ── Insert [[Entry Title]] link at the cursor position
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
          // Select the title portion so the user can type the real name straight away
          const start = 2; // skip [[
          range.setStart(node, start);
          range.setEnd(node, start + label.length);
          sel.removeAllRanges();
          sel.addRange(range);
          editorDiv.focus();
        });

        // Ctrl+Enter saves
        editorDiv.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this._handleSave(el.querySelector("form"));
          }
        });
      }

      // ── GM Notes and hidden checkbox — only visible/editable by the GM
      if (game.user.isGM) {
        const gmNotesEl = el.querySelector(".wiki-gm-notes-input");
        if (gmNotesEl && !this._gmNotesReady) {
          this._gmNotesReady = true;
          gmNotesEl.value = this._entry?.gmNotes ?? "";
        }
        // Populate the hidden checkbox from the stored entry value.
        // Must use element.checked — FormData omits unchecked checkboxes.
        const hiddenEl = el.querySelector(".wiki-hidden-checkbox");
        if (hiddenEl) hiddenEl.checked = this._entry?.hidden ?? false;
      }
    }

    // ── Form submission
    el.querySelector("form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this._handleSave(el.querySelector("form"));
    });

    el.querySelector(".wiki-btn-save")?.addEventListener("click", async (e) => {
      e.preventDefault();
      await this._handleSave(el.querySelector("form"));
    });
  }

  /** Extract form values + rich-text content, then save. */
  async _handleSave(form) {
    const fd      = new FormData(form);
    const title   = fd.get("title")?.trim();
    const category = fd.get("category");

    // Read HTML from the contenteditable editor div
    const editorDiv = this.element?.querySelector(".wiki-rich-editor");
    const content   = editorDiv ? editorDiv.innerHTML : (fd.get("content") ?? "");

    if (!title) {
      ui.notifications.warn("Please enter a title for the entry.");
      return;
    }

    // GM-only fields — read directly from DOM elements, not FormData.
    // (FormData omits unchecked checkboxes, making it unreliable for booleans.)
    const gmNotesEl = this.element?.querySelector(".wiki-gm-notes-input");
    const hiddenEl  = this.element?.querySelector(".wiki-hidden-checkbox");
    const gmNotes   = game.user.isGM ? (gmNotesEl?.value ?? this._entry?.gmNotes ?? "") : undefined;
    const hidden    = game.user.isGM ? (hiddenEl?.checked ?? false) : undefined;

    const entries = getEntries();
    const now     = Date.now();

    if (this._entry?.id) {
      const idx = entries.findIndex(e => e.id === this._entry.id);
      if (idx !== -1) {
        entries[idx] = {
          ...entries[idx],   // preserves hidden, gmNotes, comments for non-GM editors
          title, category, content,
          updatedAt:     now,
          updatedBy:     game.user.name,
          pendingDelete: false,
          comments:      entries[idx].comments ?? [],
          ...(game.user.isGM ? { gmNotes, hidden } : {}),
        };
      }
    } else {
      entries.push({
        id:            generateId(),
        title, category, content,
        createdAt:     now,
        updatedAt:     now,
        createdBy:     game.user.name,
        updatedBy:     game.user.name,
        pendingDelete: false,
        hidden:        hidden ?? false,  // default visible; GM can set at creation
        comments:      [],
        ...(game.user.isGM ? { gmNotes } : {}),
      });
    }

    const saved = await saveEntries(entries);
    if (saved === false) return; // no GM online — keep editor open so work isn't lost
    this._wikiApp.render();
    this.close();
  }

  /** Release the soft-lock when the editor closes. */
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

// ─── Category Settings (GM only) ─────────────────────────────────────────────

class WikiCategorySettings extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id:       "party-wiki-cat-settings",
    classes:  ["party-wiki", "party-wiki-settings"],
    window:   { title: "Adventurer Wiki – Category Settings", resizable: false },
    position: { width: 540, height: 520 },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/category-settings.html` },
  };

  constructor(options = {}) {
    super(options);
    this._working = foundry.utils.deepClone(getCategories());
  }

  async _prepareContext() {
    const entries = getEntries();
    const categories = this._working.map((cat, idx) => ({
      ...cat,
      count:   entries.filter(e => e.category === cat.id).length,
      isFirst: idx === 0,
      isLast:  idx === this._working.length - 1,
    }));
    return { categories };
  }

  _onRender(_context, _options) {
    this._attachListeners();
  }

  _attachListeners() {
    if (this._listenersReady) return;
    this._listenersReady = true;
    const inApp = (e) => !!(this.element?.contains(e.target));

    const _click = async (e) => {
      if (!inApp(e)) return;

      // Delete category
      const deleteBtn = e.target.closest(".wiki-cat-delete-btn:not([disabled])");
      if (deleteBtn) {
        const catId = deleteBtn.dataset.catId;
        const row   = this.element.querySelector(`.wiki-cat-row[data-id="${catId}"]`);
        const label = row?.querySelector(".wiki-cat-label-input")?.value?.trim() ?? catId;
        const ok = await foundry.applications.api.DialogV2.confirm({
          window:  { title: "Delete Category" },
          content: `<p>Remove the category "<strong>${label}</strong>"? This cannot be undone.</p>`,
        });
        if (!ok) return;
        this._syncFromDOM();
        this._working = this._working.filter(c => c.id !== catId);
        this.render({ force: true });
        return;
      }

      // Move up
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

      // Move down
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

      // Add category
      if (e.target.closest(".wiki-cat-add-btn")) {
        const labelInput = this.element.querySelector(".wiki-cat-new-label");
        const iconInput  = this.element.querySelector(".wiki-cat-new-icon");
        const label = labelInput?.value?.trim();
        const icon  = iconInput?.value?.trim()  || "fa-tag";
        if (!label) {
          ui.notifications.warn("Adventurer Wiki: Please enter a category name.");
          return;
        }
        const id = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "") || `cat-${Date.now()}`;
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

      // Save
      if (e.target.closest(".wiki-cat-save-btn")) {
        await this._save();
        return;
      }

      // Cancel
      if (e.target.closest(".wiki-cat-cancel-btn")) {
        this.close();
        return;
      }
    };

    // Live icon preview
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

  /** Read label/icon values from current DOM inputs into this._working. */
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

// ─── Global exposure (for macros) ─────────────────────────────────────────────
globalThis.AdventurerWikiApp = PartyWikiApp;

