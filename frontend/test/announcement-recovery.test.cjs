const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let recovery;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/announcementRecovery.js"), "utf8");
  recovery = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
});

const NOW = Date.parse("2026-10-19T01:00:00.000Z");

function memoryStorage(value) {
  const values = new Map();
  if (value !== undefined) values.set(recovery.ANNOUNCEMENT_RECOVERY_STORAGE_KEY, value);
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, next) { values.set(key, String(next)); },
    removeItem(key) { values.delete(key); }
  };
}

function saved(overrides = {}) {
  return JSON.stringify({ sinceMs: NOW - 20000, updatedAtMs: NOW - 1000, version: 1, ...overrides });
}

test("a missing recovery cursor keeps the first-visit cutoff", () => {
  assert.equal(recovery.readAnnouncementRecovery(memoryStorage(), NOW), NOW);
});

test("a recent same-tab cursor keeps its inclusive timestamp boundary", () => {
  const storage = memoryStorage();
  assert.equal(recovery.writeAnnouncementRecovery(storage, NOW - 20000, NOW - 1000), true);
  assert.equal(recovery.readAnnouncementRecovery(storage, NOW), NOW - 20000);
  assert.equal(recovery.readAnnouncementRecovery(storage, NOW - 1000), NOW - 20000);
});

test("write bounds recovery to two minutes and clamps a future frontier to now", () => {
  const storage = memoryStorage();
  const windowMs = recovery.ANNOUNCEMENT_RECOVERY_WINDOW_MS;
  assert.equal(windowMs, 120000);
  recovery.writeAnnouncementRecovery(storage, NOW - windowMs - 1, NOW);
  assert.equal(recovery.readAnnouncementRecovery(storage, NOW), NOW - windowMs);
  recovery.writeAnnouncementRecovery(storage, NOW - windowMs, NOW);
  assert.equal(recovery.readAnnouncementRecovery(storage, NOW), NOW - windowMs);
  recovery.writeAnnouncementRecovery(storage, NOW + 1, NOW);
  assert.equal(recovery.readAnnouncementRecovery(storage, NOW), NOW);
});

test("read expires a cursor after two minutes and clamps its older frontier", () => {
  const windowMs = recovery.ANNOUNCEMENT_RECOVERY_WINDOW_MS;
  const boundary = memoryStorage(saved({ sinceMs: NOW - windowMs - 5000, updatedAtMs: NOW - windowMs }));
  assert.equal(recovery.readAnnouncementRecovery(boundary, NOW), NOW - windowMs);
  const expired = memoryStorage(saved({ sinceMs: NOW - windowMs - 5000, updatedAtMs: NOW - windowMs - 1 }));
  assert.equal(recovery.readAnnouncementRecovery(expired, NOW), NOW);
});

test("malformed, future, inconsistent and nonnumeric cursors fail closed", () => {
  const invalid = [
    "", "{", "null", "[]", "1", "true",
    saved({ version: 2 }), saved({ version: "1" }),
    saved({ updatedAtMs: NOW + 1 }),
    saved({ sinceMs: NOW, updatedAtMs: NOW - 1 }),
    saved({ sinceMs: null }), saved({ updatedAtMs: null }),
    saved({ sinceMs: String(NOW - 20000) }), saved({ updatedAtMs: String(NOW - 1000) }),
    saved({ sinceMs: false }), saved({ updatedAtMs: {} }),
    saved({ sinceMs: Number.NaN }), saved({ updatedAtMs: Number.POSITIVE_INFINITY }),
    JSON.stringify({ version: 1, sinceMs: NOW - 1000 }),
    JSON.stringify({ version: 1, updatedAtMs: NOW - 1000 })
  ];
  for (const raw of invalid) {
    assert.equal(recovery.readAnnouncementRecovery(memoryStorage(raw), NOW), NOW, raw);
  }
});

test("unavailable or blocked browser storage never interrupts announcement startup", () => {
  const blocked = {
    getItem() { throw new Error("Storage is blocked"); },
    setItem() { throw new Error("Storage is blocked"); },
    removeItem() { throw new Error("Storage is blocked"); }
  };
  for (const storage of [undefined, null, {}, blocked]) {
    assert.equal(recovery.readAnnouncementRecovery(storage, NOW), NOW);
    assert.equal(recovery.writeAnnouncementRecovery(storage, NOW - 1000, NOW), false);
    assert.equal(recovery.clearAnnouncementRecovery(storage), false);
  }
});

test("writes persist only numeric timestamps and a schema version", () => {
  const storage = memoryStorage();
  recovery.writeAnnouncementRecovery(storage, NOW - 1000, NOW);
  const raw = storage.getItem(recovery.ANNOUNCEMENT_RECOVERY_STORAGE_KEY);
  assert.deepEqual(JSON.parse(raw), { sinceMs: NOW - 1000, updatedAtMs: NOW, version: 1 });
  assert.deepEqual([...storage.values.keys()], [recovery.ANNOUNCEMENT_RECOVERY_STORAGE_KEY]);
  for (const invalidSince of [undefined, null, "123", {}, { patient: "Private Patient", key: "private-event" }, NaN, Infinity]) {
    assert.equal(recovery.writeAnnouncementRecovery(storage, invalidSince, NOW), false);
    assert.equal(storage.getItem(recovery.ANNOUNCEMENT_RECOVERY_STORAGE_KEY), raw);
  }
  assert.equal(recovery.clearAnnouncementRecovery(storage), true);
  assert.equal(storage.values.size, 0);
  assert.equal(recovery.readAnnouncementRecovery(storage, NOW), NOW);
});
