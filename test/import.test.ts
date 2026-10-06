import { test } from "node:test";
import assert from "node:assert/strict";
import { StepIndex, StepParseError } from "../src/index.js";
import { dumpAll, importText, irregularChunks, tempDbPath } from "./helpers.js";

const BIG = "9223372036854775807";

/** A legal document exercising every feature. */
const DOC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('header "record" with #9 and ENDSEC; inside'),'2;1');
FILE_NAME('n','t',('a'),('b'),'c','d','e');
FILE_SCHEMA(('TEST'));
ENDSEC;
DATA;
#1=PART('bolt',#2,(1.,-.5,1.E-3,+7,$,*,.T.));
#2=(A(1)B((#1,$),'x''y'));
#3=SELFREF(#3);
#00000000000000000000008=LEADING('zeros');
#${BIG}=BIGONE('max');
#4=STRS('hash #1 and ENDSEC; and /* not comment */ and END-ISO-10303-21;','emoji \u{1F600}','\\X2\\D83DDE00\\X0\\','\\X4\\0001F600\\X0\\','back \\\\ slash','q''q');
#5=NEST(ONE(TWO(THREE('deep'))));
ENDSEC;
END-ISO-10303-21;
/* trailing comment */
`;

const IDS = ["1", "2", "3", "8", BIG, "4", "5"];

test("single-byte and irregular chunking produce identical results", () => {
  const whole = importText(DOC, 1 << 20);
  const bytewise = importText(DOC, 1);
  const irregular = importText(DOC, irregularChunks(42));
  const expected = dumpAll(whole, IDS);
  assert.deepEqual(dumpAll(bytewise, IDS), expected);
  assert.deepEqual(dumpAll(irregular, IDS), expected);
  whole.close();
  bytewise.close();
  irregular.close();
});

test("complex entity keeps component order and types", () => {
  const idx = importText(DOC, 1);
  const e = idx.getEntity(2)!;
  assert.equal(e.complex, true);
  assert.deepEqual(
    e.components.map((c) => c.name),
    ["A", "B"],
  );
  assert.deepEqual(e.components[0].params, [{ t: "num", raw: "1" }]);
  assert.deepEqual(e.components[1].params, [
    { t: "list", items: [{ t: "ref", id: "1" }, { t: "unset" }] },
    { t: "str", v: "x'y" },
  ]);
  idx.close();
});

test("references: cycle, self-ref, forward and backward", () => {
  const idx = importText(DOC, 7);
  assert.deepEqual(idx.getEntity(1)!.forwardRefs, ["2"]);
  assert.deepEqual(idx.getEntity(2)!.forwardRefs, ["1"]);
  assert.deepEqual(idx.getEntity(1)!.backwardRefs, ["2"]);
  assert.deepEqual(idx.getEntity(2)!.backwardRefs, ["1"]);
  assert.deepEqual(idx.getEntity(3)!.forwardRefs, ["3"]);
  assert.deepEqual(idx.getEntity(3)!.backwardRefs, ["3"]);
  idx.close();
});

test("big ids and leading zeros", () => {
  const idx = importText(DOC, 13);
  assert.equal(idx.getEntity(BIG)!.id, BIG);
  assert.equal(idx.getEntity(8)!.id, "8");
  assert.equal(idx.getEntity("00000000000000000000008")!.id, "8");
  assert.equal(idx.getEntity(8n)!.components[0].name, "LEADING");
  idx.close();
});

test("numbers keep raw text; placeholders and enums distinct", () => {
  const idx = importText(DOC, 3);
  const params = idx.getEntity(1)!.components[0].params;
  const list = params[2] as { t: "list"; items: unknown[] };
  assert.deepEqual(list.items, [
    { t: "num", raw: "1." },
    { t: "num", raw: "-.5" },
    { t: "num", raw: "1.E-3" },
    { t: "num", raw: "+7" },
    { t: "unset" },
    { t: "derived" },
    { t: "enum", v: "T" },
  ]);
  idx.close();
});

test("strings: escapes, X2/X4, pseudo-refs and fake end markers", () => {
  const idx = importText(DOC, 1);
  const params = idx.getEntity(4)!.components[0].params;
  assert.deepEqual(params[0], {
    t: "str",
    v: "hash #1 and ENDSEC; and /* not comment */ and END-ISO-10303-21;",
  });
  assert.deepEqual(params[1], { t: "str", v: "emoji \u{1F600}" });
  assert.deepEqual(params[2], { t: "str", v: "\u{1F600}" });
  assert.deepEqual(params[3], { t: "str", v: "\u{1F600}" });
  assert.deepEqual(params[4], { t: "str", v: "back \\ slash" });
  assert.deepEqual(params[5], { t: "str", v: "q'q" });
  // '#1' inside the string must not create a reference.
  assert.deepEqual(idx.getEntity(4)!.forwardRefs, []);
  assert.deepEqual(idx.getEntity(1)!.backwardRefs, ["2"]);
  idx.close();
});

test("nested typed values preserved", () => {
  const idx = importText(DOC, 5);
  assert.deepEqual(idx.getEntity(5)!.components[0].params, [
    {
      t: "typed",
      name: "ONE",
      items: [
        {
          t: "typed",
          name: "TWO",
          items: [{ t: "typed", name: "THREE", items: [{ t: "str", v: "deep" }] }],
        },
      ],
    },
  ]);
  idx.close();
});

const BAD_DOCS: Record<string, string> = {
  "duplicate id": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A();#01=B();ENDSEC;END-ISO-10303-21;`,
  "undefined ref": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A(#2);ENDSEC;END-ISO-10303-21;`,
  "missing final ENDSEC": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A();ENDSEC;`,
  "truncated record": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A('x'`,
  "junk after end": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A();ENDSEC;END-ISO-10303-21;#2=B();`,
  "zero id": `ISO-10303-21;HEADER;ENDSEC;DATA;#0=A();ENDSEC;END-ISO-10303-21;`,
  "id too large": `ISO-10303-21;HEADER;ENDSEC;DATA;#9223372036854775808=A();ENDSEC;END-ISO-10303-21;`,
  "bad escape": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A('a\\nb');ENDSEC;END-ISO-10303-21;`,
  "lone surrogate X2": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A('\\X2\\D83D\\X0\\');ENDSEC;END-ISO-10303-21;`,
  "surrogate in X4": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A('\\X4\\0000D83D\\X0\\');ENDSEC;END-ISO-10303-21;`,
  "code point too large": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A('\\X4\\00110000\\X0\\');ENDSEC;END-ISO-10303-21;`,
  "depth 65": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A(${"(".repeat(64)}${")".repeat(64)});ENDSEC;END-ISO-10303-21;`,
  "record too large": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A('${"x".repeat(70 * 1024)}');ENDSEC;END-ISO-10303-21;`,
  "unterminated comment": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=A();/*`,
  "bad type name": `ISO-10303-21;HEADER;ENDSEC;DATA;#1=a();ENDSEC;END-ISO-10303-21;`,
};

for (const [name, doc] of Object.entries(BAD_DOCS)) {
  test(`rejects: ${name}`, () => {
    const idx = StepIndex.open(tempDbPath());
    const imp = idx.beginImport();
    const bytes = new TextEncoder().encode(doc);
    assert.throws(() => {
      for (let off = 0; off < bytes.length; off += 64) {
        imp.write(bytes.subarray(off, Math.min(off + 64, bytes.length)));
      }
      imp.finish();
    }, StepParseError);
    idx.close();
  });
}

test("depth 64 nesting is accepted", () => {
  const inner = `${"A(".repeat(63)}1${")".repeat(63)}`;
  const doc = `ISO-10303-21;HEADER;ENDSEC;DATA;#1=T(${inner});ENDSEC;END-ISO-10303-21;`;
  const idx = importText(doc, 1);
  assert.equal(idx.getEntity(1)!.id, "1");
  idx.close();
});

test("failed import preserves the previous index", () => {
  const db = tempDbPath();
  const idx = importText(DOC, 11, db);
  const before = dumpAll(idx, IDS);
  const imp = idx.beginImport();
  assert.throws(() => {
    imp.write(new TextEncoder().encode(BAD_DOCS["duplicate id"]!));
    imp.finish();
  }, StepParseError);
  assert.deepEqual(dumpAll(idx, IDS), before);
  // And a second failed import attempt (undefined ref) also keeps data.
  const imp2 = idx.beginImport();
  assert.throws(() => {
    imp2.write(new TextEncoder().encode(BAD_DOCS["undefined ref"]!));
    imp2.finish();
  }, StepParseError);
  assert.deepEqual(dumpAll(idx, IDS), before);
  idx.close();
});

test("index persists after source file is gone", () => {
  const db = tempDbPath();
  const idx = importText(DOC, 1 << 20, db);
  idx.close();
  // Reopen from SQLite only; no source text involved.
  const reopened = StepIndex.open(db);
  assert.deepEqual(dumpAll(reopened, IDS).map((e) => e!.id), IDS);
  reopened.close();
});
