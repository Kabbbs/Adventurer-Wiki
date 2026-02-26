# Adventurer Wiki

A [Foundry VTT](https://foundryvtt.com/) module that gives your party a shared, in-game wiki. Players can create, read, and edit entries across categories. The GM controls visibility, deletion approval, and has access to private GM notes per entry.

---

## Requirements

- Foundry VTT **v13+**

---

## Installation

Install via manifest URL in Foundry's module manager:

```
https://raw.githubusercontent.com/Kabbbs/Adventurer-Wiki/main/adventurer-wiki/module.json
```

---

## Features

- 📚 **Categorized entries** — Lore, Locations, NPCs, Factions, Quests, Items, Session Notes
- ✏️ **Rich-text editor** — formatting toolbar with headings, bold, italic, lists
- 🔗 **Cross-reference links** — `[[Entry Title]]` syntax links entries together
- 🔍 **Full-text search** — searches across all categories, highlights body matches
- 👁️ **Hidden entries** — GM can hide entries from players entirely
- 🗑️ **Deletion approval flow** — players flag entries; GM approves or clears
- 💬 **Comments** — per-entry comments; players manage their own, GM manages all
- 🔒 **Soft-lock indicators** — shows when another user is editing an entry
- 📝 **GM Notes** — private per-entry notes visible only to the GM
- 🔄 **Real-time sync** — all changes propagate live to every connected client
- 🖼️ **Image upload** — insert images from the Foundry file picker directly into entries; stored locally on the Foundry server
- 🎨 **Doodle editor** — draw freehand sketches in a canvas window and embed them inline; saved as PNG to the world's data folder

---

## Usage

A wiki button is injected into Foundry's scene controls sidebar. Click it to open the wiki window.

**Macro access:**
```js
new AdventurerWikiApp().render(true);
```

---

## Development

See [`docs/PROJECT_NOTES.md`](docs/PROJECT_NOTES.md) for full architecture notes, known gotchas, and development guidance.

---

## Author

Kabs
