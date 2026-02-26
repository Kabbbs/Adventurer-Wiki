# Adventurer Wiki — Project Notes
_Last updated: February 2026_

---

## What This Is

A Foundry VTT module called **Adventurer Wiki** (module ID: `adventurer-wiki`). It provides an in-game wiki window that all players can read and write to, with GM-controlled permissions for deletion and entry visibility. Real-time multi-client sync is handled via Foundry's socket system.

**Installation:** Via manifest URL in Foundry's module manager (see README).

---

## File Structure

```
adventurer-wiki/
├── module.json
├── scripts/
│   └── party-wiki.js          ← ALL application logic (single file)
├── styles/
│   └── party-wiki.css         ← All styles
└── templates/
    ├── wiki.html              ← Main wiki viewer (Handlebars)
    └── editor.html            ← Entry editor window (Handlebars)
```

> ⚠️ **Note on filenames:** The canonical files are `party-wiki.js` and `party-wiki.css`. An older stale pair named `adventurer-wiki.js` / `adventurer-wiki.css` previously existed but has been deleted. If `module.json` ever reverts to pointing at `adventurer-wiki.js`, the module will silently fail to load.

---

## Architecture Overview

### Framework
- `ApplicationV2` + `HandlebarsApplicationMixin` — Foundry v13 API
- Two application classes: `PartyWikiApp` (viewer) and `WikiEntryEditor` (editor)
- Targets Foundry v13+

### Data Storage
- All wiki entries stored in a single **world-scoped game setting**: `adventurer-wiki.wikiEntries`
- Value is a plain JSON array of entry objects — no `type:` field in the registration (specifying `type: Array` in v13 double-wraps the value, breaking reads)
- Always call `foundry.utils.deepClone(game.settings.get(...))` before mutating — mutating in place causes phantom entries on failed saves

### Save Flow
- **GM clients** write directly via `game.settings.set()`
- **Player clients** relay saves through the GM via socket (`requestSave` action)
- If no GM is online, saves are **hard-blocked** with a warning notification — this is intentional to prevent data loss from race conditions
- `saveEntries()` returns `true` on success, `false` when blocked; callers must check the return value and keep the editor open if `false`

### Real-Time Sync
- Socket event: `module.adventurer-wiki`
- Actions: `requestSave`, `refresh`, `editingStart`, `editingStop`
- `Hooks.on("updateSetting")` also triggers refreshes as a reliable fallback
- `refreshAllWikiApps()` re-renders every open `PartyWikiApp` instance tracked in the `openWikiApps` Set

### Event Handling — Critical Workaround
Foundry v13's `ApplicationV2` intercepts click events in its internal pipeline **before they bubble to `this.element`**. Any button that only exists inside a `{{#if}}` block (i.e., only rendered after an entry is selected) will have its clicks silently swallowed if listeners are attached to `this.element`.

**The fix:** All interaction listeners are registered on `document` in the **capture phase** (`{ capture: true }`), which fires before Foundry's pipeline can intercept anything. Each handler immediately checks `this.element?.contains(e.target)` and returns if the event originated outside the app.

```js
// _attachDelegatedListeners() — runs ONCE per app lifetime
document.addEventListener("click",   _click,   { capture: true });
document.addEventListener("input",   _input,   { capture: true });
document.addEventListener("keydown", _keydown, { capture: true });
this._docListeners = { _click, _input, _keydown };
```

Listeners are removed in `close()` via stored references in `this._docListeners`. The `_listenersReady` guard prevents duplicate registration across re-renders. **Do not revert this to `this.element.addEventListener` — it will break buttons that appear conditionally.**

---

## Entry Data Schema

```js
{
  id:            "entry_1234567890_abc12",  // generateId()
  title:         "The Dragon of Ashclaw",
  category:      "npcs",                   // must match a CATEGORIES id
  content:       "<p>Rich HTML content…</p>",
  hidden:        false,                     // GM-only; true = invisible to players
  pendingDelete: false,                     // player flagged for GM review
  createdAt:     1700000000000,             // Date.now()
  updatedAt:     1700000000000,
  createdBy:     "PlayerName",
  updatedBy:     "PlayerName",
  gmNotes:       "Private GM text…",       // only written/read by GM clients
  comments: [
    {
      id:         "entry_…",
      authorName: "PlayerName",
      userId:     "foundry-user-id",
      text:       "Comment body",
      createdAt:  1700000000000,
    }
  ]
}
```

---

## Categories

Defined as a constant array `CATEGORIES` at the top of `party-wiki.js`. Changing categories here is the only thing needed — no other code references category IDs directly except the filter in `_prepareContext`.

```js
const CATEGORIES = [
  { id: "lore",      label: "Lore",          icon: "fa-book-open"       },
  { id: "locations", label: "Locations",     icon: "fa-map-location-dot"},
  { id: "npcs",      label: "NPCs",          icon: "fa-person"          },
  { id: "factions",  label: "Factions",      icon: "fa-shield-halved"   },
  { id: "quests",    label: "Quests",        icon: "fa-map-pin"         },
  { id: "items",     label: "Items",         icon: "fa-gem"             },
  { id: "notes",     label: "Session Notes", icon: "fa-scroll"          },
];
```

---

## Features Implemented

| Feature | Status | Notes |
|---|---|---|
| Category tabs with entry counts | ✅ Working | |
| Sidebar entry list | ✅ Working | |
| Rich-text editor (contenteditable) | ✅ Working | execCommand-based toolbar |
| `[[Entry Title]]` cross-reference links | ✅ Working | Processed by `processEntryLinks()` |
| Body-text search (cross-category) | ✅ Working | Strips HTML tags for matching |
| Category badge in search results | ✅ Working | Shows source category when searching |
| "≡" body-match badge in sidebar | ✅ Working | Shown when hit is in body, not title |
| Soft-lock indicator (editing badge) | ✅ Working | Pulses while another user is in editor |
| GM Notes (private per-entry notes) | ✅ Working | Stored in `entry.gmNotes`, GM only |
| Comments system | ✅ Working | Players delete own; GM deletes any |
| Player "flag for deletion" | ✅ Working | Sets `pendingDelete: true` |
| GM delete approval flow | ✅ Working | Clear flag or permanently delete |
| Pending deletion banner | ✅ Working | GM sees count badge in sidebar |
| No-GM warning banner | ✅ Working | Shown to players when GM offline |
| Timestamp + "last edited by" | ✅ Working | Displayed in entry header |
| Hidden entries (GM toggle) | ✅ Working | See details below |
| Bookmarks | ❌ Removed | Planned for future re-implementation |
| `bringToFront` compat | ✅ Fixed | Uses `bringToFront ?? bringToTop` |

---

## Hidden Entries — How It Works

Hidden entries are completely invisible to non-GM players. The GM sees them dimmed (50% opacity, italic) with an eye-slash icon in the sidebar.

**Two ways to toggle:**

1. **In the editor:** A "Hide from players" checkbox appears in the GM-only section (below GM Notes). It saves with the entry when the Save button is clicked.

2. **In the viewer:** An eye/eye-slash icon button appears to the right of the entry title (GM only). Clicking it saves immediately — no editor needed.

**Critical implementation note:** The hidden checkbox value is read via `element.checked`, NOT `FormData`. FormData omits unchecked checkboxes entirely, making it unreliable for boolean toggles. This was the root cause of the original broken implementation.

```js
// CORRECT — reads DOM directly
const hiddenEl = this.element?.querySelector(".wiki-hidden-checkbox");
const hidden   = game.user.isGM ? (hiddenEl?.checked ?? false) : undefined;

// WRONG — FormData omits unchecked checkboxes
const hidden = !!fd.get("hidden"); // always false when unchecked
```

When a player has a hidden entry selected and the GM hides it, the player's selection is cleared automatically on the next re-render.

---

## Rich-Text Editor Notes

- Uses native `document.execCommand()` — deprecated by browsers but still functional in Electron (which Foundry runs in)
- Content lives in a `contenteditable` div (`.wiki-rich-editor`); a hidden `<textarea name="content">` is a decoy for FormData and is never actually used — content is read from `editorDiv.innerHTML`
- Heading buttons (H2/H3/H4) toggle: clicking an already-active heading reverts to a paragraph
- `[[Entry Title]]` links are inserted as plain text and processed at render time by `processEntryLinks()`, which converts them to `<a class="wiki-entry-link" data-id="…">` tags

---

## Soft-Lock System

- When a user opens the editor for an existing entry, an `editingStart` socket event broadcasts their name/userId
- `activeEditors` Map (`entryId → { userName, userId }`) is updated on all clients
- A pulsing pencil badge appears in the sidebar, and a notice bar appears in the main view
- On editor close, `editingStop` is broadcast and the lock is cleared
- If a user disconnects (`userConnected` hook), their lock is automatically released

---

## Toolbar Button

The wiki is opened via a button injected into Foundry's scene controls sidebar. `addWikiButton()` is called on `ready`, and again on `renderSceneControls` (with two `setTimeout` retries) to handle cases where the controls DOM isn't ready immediately. The button checks for its own presence before injecting to avoid duplicates.

---

## Global Macro Access

```js
globalThis.AdventurerWikiApp = PartyWikiApp;
// Usage in a macro:
new AdventurerWikiApp().render(true);
```

---

## Known Issues / Things to Watch

1. **Bookmarks removed:** Bookmarks were partially implemented across multiple sessions but repeatedly failed to function reliably due to the Foundry event-interception issue described above. The feature was fully removed to start clean. The document-capture delegation fix is now proven to work (the hidden toggle button uses it successfully), so a future re-implementation should be straightforward.

2. **`document.execCommand` deprecation:** The rich-text editor uses `execCommand`, which is deprecated. It currently works in Foundry's Electron shell. If it ever breaks, the preferred replacement is Foundry's built-in ProseMirror integration.

3. **No entry ordering / drag-to-sort:** Entries are displayed in insertion order within each category. Indefinitely deferred.

4. **Single editor instance:** The `WikiEntryEditor` uses a static `id: "party-wiki-editor"` — only one editor window open at a time. Intentional design choice.

5. **Two-GM race condition:** Two GMs editing different entries simultaneously is an unprotected last-write-wins race. Acceptable known limitation for typical party sizes.

6. **No player notification on pendingDelete clear:** When a GM clears a player's deletion flag without deleting, the player gets no feedback — their flag icon just disappears on re-render. Known UX gap; fix via `ui.notifications.info()` broadcast to the flagging player via socket.

7. **No comment character limit:** No length enforcement exists on comments. A soft cap of ~1000–2000 chars enforced in `_submitComment` would be sensible.

---

## Where to Continue

The next planned feature is **Bookmarks** — a per-user, per-world list of starred entries stored in `localStorage`.

**Spec:**
- `localStorage` key: `adventurer-wiki-bm-{worldId}-{userId}`
- Star button in the entry title header row (alongside the hidden toggle for GMs)
- Bookmarks tab at the bottom of the category nav, visually identical to other tabs with a thin separator line above it, using `data-cat="__bookmarks__"` as a sentinel in `_activeCat`
- Clicking the tab filters the entry list to bookmarked entries only, with the cross-category label badge on each result
- Star toggles immediately on click with no save prompt — just a re-render
- Per-user only, private — no GM visibility into other users' bookmarks
