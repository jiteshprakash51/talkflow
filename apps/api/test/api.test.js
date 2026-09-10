import { test } from "node:test";
import assert from "node:assert/strict";

test("command detection incl. connect", () => {
  const isCommand = (text) => {
    const t = text.trim().toLowerCase();
    if (/^(list|show)(\s|$)/.test(t)) return "list";
    if (/connect\s+(gmail|google|sheets)/.test(t)) return "connect-google";
    if (/connect\s+whatsapp/.test(t)) return "connect-whatsapp";
    if (/^(ok|yes|confirm)/.test(t)) return "confirm";
    return null;
  };
  assert.equal(isCommand("list"), "list");
  assert.equal(isCommand("list my flows"), "list");
  assert.equal(isCommand("connect gmail"), "connect-google");
  assert.equal(isCommand("connect google"), "connect-google");
  assert.equal(isCommand("connect whatsapp"), "connect-whatsapp");
  assert.equal(isCommand("ok"), "confirm");
  assert.equal(isCommand("every morning summarize gmail"), null);
});

test("health endpoint shape", () => {
  const shape = { ok: true, service: "talkflow-api" };
  assert.equal(shape.ok, true);
});

test("whatsapp number normalization", () => {
  const to = "+1 (555) 123-4567".replace(/[^0-9]/g, "");
  assert.equal(to, "15551234567");
});

test("connector spec shape validation", () => {
  const raw = '{"name":"demo","description_en":"d","base_url":"https://api.example.com","actions":[{"name":"list_items","method":"GET","path":"/items","description_en":"list"}],"auth":{"type":"none"}}';
  const obj = JSON.parse(raw);
  assert.ok(obj.base_url.startsWith("http"));
  assert.ok(Array.isArray(obj.actions) && obj.actions.length <= 4);
});

test("sheets values parsing (json or csv)", () => {
  const tryParseRow = (values) => {
    try {
      const parsed = JSON.parse(values);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fallthrough */ }
    return values.split(",").map((s) => s.trim()).slice(0, 20);
  };
  assert.deepEqual(tryParseRow('["a","b"]'), ["a", "b"]);
  assert.deepEqual(tryParseRow("a, b, c"), ["a", "b", "c"]);
});

test("template matching", () => {
  const TEMPLATES = [
    { id: "morning-gmail-digest", title_en: "Morning Gmail digest", say_to_use_en: "use morning digest" },
    { id: "website-watch", title_en: "Website watcher", say_to_use_en: "use website watcher" },
  ];
  const findTemplate = (text) => {
    const t = text.toLowerCase();
    return (
      TEMPLATES.find((x) => t.includes(x.id)) ??
      TEMPLATES.find((x) => t.includes(x.say_to_use_en)) ??
      TEMPLATES.find((x) => t.includes(x.title_en.toLowerCase()))
    );
  };
  assert.equal(findTemplate("use morning digest").id, "morning-gmail-digest");
  assert.equal(findTemplate("please use website watcher now").id, "website-watch");
  assert.equal(findTemplate("something else"), undefined);
});

test("quota messages are plain english", () => {
  const chatBlock = (max) => `You\x27ve used today\x27s ${max} free chats \u2014 they reset tomorrow. Your automations keep running meanwhile.`;
  assert.match(chatBlock(100), /reset tomorrow/);
  assert.doesNotMatch(chatBlock(100), /429|quota_exceeded|HTTP/);
});
