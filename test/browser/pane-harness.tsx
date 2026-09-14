/**
 * Browser harness for the child pane's interaction contract.
 *
 * Mounts two independent panes with a scripted event stream and a scripted
 * interaction channel, and exposes the controls a check needs through
 * `window.__PANE__`. It is bundled on demand by
 * `scripts/browser-pane-check.mjs`; nothing here ships with the plugin.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { ChildConversation } from "../../src/client/ChildConversation.js";
import { createChildViews, type ChildJournalChange } from "../../src/client/child-view.js";

const ADDRESSES = {
  a: { parentSessionId: "parent", childSessionId: "child-a", mode: "continuable" as const },
  b: { parentSessionId: "parent", childSessionId: "child-b", mode: "continuable" as const },
  oneShot: { parentSessionId: "parent", childSessionId: "child-c", mode: "one-shot" as const },
};
const key = (address: { parentSessionId: string; childSessionId: string; mode: string }): string =>
  `${address.parentSessionId}:${address.childSessionId}:${address.mode}`;

const streams = new Map<string, { publish(change: ChildJournalChange): void }>();
const calls: unknown[] = [];
let pendingApprovals: unknown[] = [];
let pendingQuestions: unknown[] = [];
let failNextPrompt = false;

const views = createChildViews({
  create: (address, options) => {
    streams.set(key(address), options);
    return { async open() {}, async prepend(request) { calls.push({ kind: "prepend", address, request }); },
      restart() { calls.push({ kind: "restart", address }); }, async dispose() { calls.push({ kind: "dispose", address }); } };
  },
  prompt: async (address, text, delivery) => {
    calls.push({ kind: "prompt", address, text, delivery });
    if (failNextPrompt) { failNextPrompt = false; throw new Error("parent is unavailable"); }
  },
  stop: async address => { calls.push({ kind: "stop", address }); },
});
const approvals = {
  pending: async () => pendingApprovals,
  decide: async (sessionId: string, requestId: string, decision: string) => {
    calls.push({ kind: "decide", sessionId, requestId, decision });
    pendingApprovals = [];
  },
  questions: async () => pendingQuestions,
  answer: async (sessionId: string, requestId: string, answers: Record<string, readonly string[]>) => {
    calls.push({ kind: "answer", sessionId, requestId, answers });
    pendingQuestions = [];
  },
};

// Stable prop identities: the real slot renderer hands a component its inject
// face and its tab snapshot once, so the harness must not rebuild them per
// render or the pane's own effect dependencies would re-subscribe forever.
const SIGNAL = new AbortController().signal;
const TABS = {
  a: { tab: { navigation: { params: ADDRESSES.a }, signal: SIGNAL } },
  b: { tab: { navigation: { params: ADDRESSES.b }, signal: SIGNAL } },
  oneShot: { tab: { navigation: { params: ADDRESSES.oneShot }, signal: SIGNAL } },
};
const attach = (address: never, listener: never) => views.attach(address, listener);
const openMain = (address: unknown) => { calls.push({ kind: "openMain", address }); };
const translate = (name: string) => name;

function Pane({ which }: { which: "a" | "b" | "oneShot" }) {
  return createElement(ChildConversation, {
    useTabInfo: () => TABS[which],
    openMain,
    attach,
    approvals: approvals as never,
    t: translate,
  });
}

const root = createRoot(document.getElementById("root")!);
const render = (showB: boolean, showOneShot = false): void => root.render(createElement("div", null,
  createElement("div", { id: "pane-a" }, createElement(Pane, { which: "a" })),
  showB ? createElement("div", { id: "pane-b" }, createElement(Pane, { which: "b" })) : null,
  showOneShot ? createElement("div", { id: "pane-oneshot" }, createElement(Pane, { which: "oneShot" })) : null));

render(true);
(globalThis as unknown as { __PANE__: unknown }).__PANE__ = {
  calls,
  publish: (which: "a" | "b", change: ChildJournalChange) => streams.get(key(ADDRESSES[which]))?.publish(change),
  setApprovals: (list: unknown[]) => { pendingApprovals = list; },
  setQuestions: (list: unknown[]) => { pendingQuestions = list; },
  hideB: () => render(false),
  showB: () => render(true),
  showOneShot: () => render(true, true),
  failNextPrompt: () => { failNextPrompt = true; },
};
