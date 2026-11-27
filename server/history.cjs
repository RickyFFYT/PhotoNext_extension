/*
 * The op log behind undo and redo.
 *
 * This closes the audit's "no undo" limit, and it is deliberately the only place
 * that knows how history is ordered. The rules:
 *
 * - An entry is a reversible operation record. The narrative summary is for the
 *   agent; `changes` are what makes the undo real.
 * - `cursor` is how many entries are applied. Undo moves it back, redo forward,
 *   and recording after an undo drops the redo tail — the standard model, so an
 *   agent that branches cannot replay a future that no longer exists.
 * - Two budgets: entry count and bytes. Snapshots are files, so the caller
 *   passes their measured size in `bytes` and the store deletes whatever gets
 *   evicted. The newest entry is never evicted, because a history that cannot
 *   undo the last edit is worse than a short one.
 */
'use strict';

const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;

function createHistory(options) {
  const settings = options || {};
  return {
    maxEntries: Math.max(1, Math.round(Number(settings.maxEntries) || DEFAULT_MAX_ENTRIES)),
    budgetBytes: Math.max(1, Math.round(Number(settings.budgetBytes) || DEFAULT_BUDGET_BYTES)),
    entries: [],
    cursor: 0,
    bytes: 0,
    // The revision of the oldest reachable state. Every applied entry carries
    // its own live `revisionAfter`; together they let `undo_to` name any state
    // a tool has returned, including one produced by an undo or redo.
    baseRevision: 0,
  };
}

/** Snapshot files a history entry owns, for the store to delete on eviction. */
function filesFor(entry) {
  const files = [];
  for (const change of entry.changes || []) {
    if (change.before && change.before.file) files.push(change.before.file);
    if (change.after && change.after.file) files.push(change.after.file);
    // Layer add/remove entries own their snapshot's pixels and mask, or an undo
    // would find the file garbage-collected the moment the layer disappeared.
    for (const file of change.files || []) files.push(file);
    for (const layer of [change.layer, change.after && change.after.layer, change.before && change.before.layer]) {
      if (!layer) continue;
      if (layer.pixels && layer.pixels.file) files.push(layer.pixels.file);
      if (layer.mask && layer.mask.file) files.push(layer.mask.file);
    }
  }
  return files;
}

function prune(history) {
  const evicted = [];
  while (
    history.entries.length > 1 &&
    (history.entries.length > history.maxEntries || history.bytes > history.budgetBytes)
  ) {
    const removed = history.entries.shift();
    history.bytes -= removed.bytes || 0;
    if (history.cursor > 0) history.cursor -= 1;
    evicted.push(removed);
  }
  return evicted;
}

/**
 * Append an entry. Returns the entry plus everything evicted — the redo tail it
 * replaced and any oldest entries the budgets pushed out — so the caller can
 * delete those snapshot files instead of leaking them.
 */
function record(history, entry) {
  const dropped = history.entries.splice(history.cursor);
  for (const gone of dropped) history.bytes -= gone.bytes || 0;
  history.entries.push(entry);
  history.bytes += entry.bytes || 0;
  history.cursor = history.entries.length;
  return { entry: entry, evicted: dropped.concat(prune(history)) };
}

function undo(history) {
  if (history.cursor <= 0) return null;
  history.cursor -= 1;
  return history.entries[history.cursor];
}

function redo(history) {
  if (history.cursor >= history.entries.length) return null;
  const entry = history.entries[history.cursor];
  history.cursor += 1;
  return entry;
}

function canUndo(history) {
  return history.cursor > 0;
}

function canRedo(history) {
  return history.cursor < history.entries.length;
}

/** The list an agent reads: applied entries first, then the redo tail. */
function entriesView(history) {
  return history.entries.map((entry, index) => ({
    index: index + 1,
    tool: entry.tool,
    summary: entry.summary,
    at: entry.at,
    applied: index < history.cursor,
    undoable: index === history.cursor - 1,
    redoable: index === history.cursor,
    bytes: entry.bytes || 0,
    changes: (entry.changes || []).length,
  }));
}

function serialize(history) {
  return {
    maxEntries: history.maxEntries,
    budgetBytes: history.budgetBytes,
    entries: history.entries,
    cursor: history.cursor,
    bytes: history.bytes,
    baseRevision: history.baseRevision || 0,
  };
}

function restore(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return createHistory();
  const history = createHistory(raw);
  history.entries = raw.entries.filter((entry) => entry && typeof entry === 'object');
  history.cursor = Math.max(0, Math.min(history.entries.length, Math.round(Number(raw.cursor)) || 0));
  history.bytes = history.entries.reduce((total, entry) => total + (entry.bytes || 0), 0);
  history.baseRevision = Math.max(0, Math.round(Number(raw.baseRevision)) || 0);
  return history;
}

module.exports = {
  DEFAULT_BUDGET_BYTES: DEFAULT_BUDGET_BYTES,
  DEFAULT_MAX_ENTRIES: DEFAULT_MAX_ENTRIES,
  canRedo: canRedo,
  canUndo: canUndo,
  createHistory: createHistory,
  entriesView: entriesView,
  filesFor: filesFor,
  record: record,
  redo: redo,
  restore: restore,
  serialize: serialize,
  undo: undo,
};
