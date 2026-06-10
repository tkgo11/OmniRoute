import test from "node:test";
import assert from "node:assert/strict";

// Regression guard for the gating between the standard-Gemini path and the
// Antigravity/CLI bypass path (#3414/#3560 review). Standard Gemini (direct API,
// the registered FORMATS.GEMINI translator uses mode "text") rejects the
// thoughtSignature field AND signature-less native tool parts, so signature-less
// historical tool calls/responses must be represented as inert TEXT (#3358).
// Only the Antigravity/CLI bypass path emits native parts + the
// skip_thought_signature_validator sentinel.
const { openaiToGeminiRequest } = await import(
  "../../open-sse/translator/request/openai-to-gemini.ts"
);

const MESSAGES = [
  { role: "user", content: "list files" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "file_a\nfile_b" },
  { role: "user", content: "thanks" },
];
const TOOLS = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];

type GP = {
  functionCall?: unknown;
  functionResponse?: unknown;
  thoughtSignature?: unknown;
};
type GContent = { role?: string; parts?: GP[] };

function translate(mode: "native" | "text" | "context") {
  return openaiToGeminiRequest(
    "gemini-2.5-flash",
    { model: "gemini-2.5-flash", messages: MESSAGES, tools: TOOLS, stream: false },
    false,
    null,
    { signaturelessToolCallMode: mode }
  );
}

test('standard Gemini "text" mode: signature-less tool call/response stay as text (no native parts, no sentinel)', () => {
  const result = translate("text");
  const allParts = (result.contents as GContent[]).flatMap((c) => c.parts ?? []);

  assert.equal(
    allParts.some((p) => p.functionCall),
    false,
    "no native functionCall on the text-mode standard-Gemini path"
  );
  assert.equal(
    allParts.some((p) => p.functionResponse),
    false,
    "no native functionResponse on the text-mode standard-Gemini path"
  );
  assert.equal(
    allParts.some((p) => p.thoughtSignature === "skip_thought_signature_validator"),
    false,
    "the bypass sentinel must never be injected on the standard-Gemini path"
  );
});

test('standard Gemini "native" mode: native functionCall with no fake signature', () => {
  const result = translate("native");
  const modelTurn = (result.contents as GContent[]).find(
    (c) => c.role === "model" && (c.parts ?? []).some((p) => p.functionCall)
  );
  assert.ok(modelTurn, "native mode emits a native functionCall");
  const fc = (modelTurn.parts ?? []).find((p) => p.functionCall);
  assert.equal(fc?.thoughtSignature, undefined, "no fake signature injected in native mode");
});
