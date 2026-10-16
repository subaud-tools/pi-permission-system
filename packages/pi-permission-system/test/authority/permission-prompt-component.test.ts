import { visibleWidth } from "@earendil-works/pi-tui";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
  UnattributedDecision,
} from "#src/authority/permission-dialog";
import {
  type PermissionPromptUi,
  type PermissionPromptView,
  type PromptPreferences,
  presentInlinePermissionPrompt,
  type RemotePromptControl,
  requestPermissionDecision,
} from "#src/authority/permission-prompt-component";
import { DEFAULT_DIALOG_KEYS } from "#src/config/dialog-keys";
import { DEFAULT_RENDER_BUDGET } from "#src/presentation/dialog-renderer";
import type { PromptNotice } from "#src/presentation/prompt-notification";
import type { PromptPayload } from "#src/presentation/prompt-payload";
import { makePromptPayload } from "#test/helpers/prompt-details-fixtures";
import {
  makePromptNotice,
  makePromptPreferences,
} from "#test/helpers/prompt-view-fixtures";

// ── Fake TUI view harness ────────────────────────────────────────────────────

function plainTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return text;
    },
  };
}

interface CapturedComponent {
  render(width: number): string[];
  handleInput(data: string): void;
}

type PromptFactory = (
  tui: {
    requestRender: () => void;
    terminal: { write(data: string): void };
  },
  theme: ReturnType<typeof plainTheme>,
  keybindings: { matches(data: string, action: string): boolean },
  done: (decision: UnattributedDecision | undefined) => void,
) => CapturedComponent;

/** Pi's default binding for the `app.tools.expand` action. */
const CTRL_O = "\u000f";

/** The preferences a fake view overrides, plus the key bound to tool expansion. */
interface FakeViewOptions extends Partial<PromptPreferences> {
  expandKey?: string;
  notice?: PromptNotice;
}

function makeFakeView(
  doublePressToConfirm: boolean,
  options: FakeViewOptions = {},
) {
  const { expandKey = CTRL_O, notice, ...preferences } = options;
  const terminalWrite = vi.fn<(data: string) => void>();
  const captured: {
    component?: CapturedComponent;
    options?: unknown;
    /** The host's `done`, as the dialog received it. */
    done?: Mock<(decision: UnattributedDecision | undefined) => void>;
  } = {};
  let toolsExpanded = false;
  const getToolsExpanded = vi.fn(() => toolsExpanded);
  const setToolsExpanded = vi.fn((expanded: boolean) => {
    toolsExpanded = expanded;
  });
  const custom = (
    factory: PromptFactory,
    options: unknown,
  ): Promise<UnattributedDecision | undefined> => {
    captured.options = options;
    return new Promise<UnattributedDecision | undefined>((resolve) => {
      const done = vi.fn((decision: UnattributedDecision | undefined) => {
        resolve(decision);
      });
      captured.done = done;
      captured.component = factory(
        { requestRender: vi.fn(), terminal: { write: terminalWrite } },
        plainTheme(),
        {
          matches: (data, action) =>
            action === "app.tools.expand" && data === expandKey,
        },
        done,
      );
    });
  };
  const view = makeView(
    "tui",
    {
      select: vi.fn(),
      input: vi.fn(),
      custom,
      getToolsExpanded,
      setToolsExpanded,
    },
    { doublePressToConfirm, ...preferences },
    notice,
  );
  return { view, captured, getToolsExpanded, setToolsExpanded, terminalWrite };
}

/**
 * The view the dispatcher and the inline component take.
 *
 * Typed as `PermissionPromptView` so a field added to it is a compile error
 * here; the cast is confined to the `ui` double, whose generic `custom` a
 * plain `vi.fn()` cannot satisfy.
 */
function makeView(
  mode: PermissionPromptView["mode"],
  ui: unknown,
  preferences: Partial<PromptPreferences> = {},
  notice: PromptNotice = makePromptNotice(),
): PermissionPromptView {
  return {
    mode,
    ui: ui as PermissionPromptUi,
    ...makePromptPreferences(preferences),
    notice,
  };
}

const ARROW_DOWN = "\u001b[B";
const ENTER = "\r";
const ESCAPE = "\u001b";

/** How the terminal delivers a paste: one chunk, markers included. */
function paste(content: string): string {
  return `\u001b[200~${content}\u001b[201~`;
}

/** A path ask; `path : /repo/secret.txt` is its decision-relevant line. */
function makeAsk(value = "/repo/secret.txt"): PromptPayload {
  return makePromptPayload({
    kind: "path",
    request: {
      ...makePromptPayload().request,
      surface: "path",
      toolName: "read",
      value,
      matchedPattern: null,
    },
  });
}

const ASK = makeAsk();

/** Title, blank separator, four decision options, blank, hint. */
const DECISION_CHROME_ROWS = 8;

async function runPrompt(
  doublePressToConfirm: boolean,
  keys: string[],
  options?: RequestPermissionOptions,
): Promise<UnattributedDecision | undefined> {
  const { view, captured } = makeFakeView(doublePressToConfirm);
  const promise = presentInlinePermissionPrompt(
    view,
    "Permission Required",
    ASK,
    options,
  );
  for (const key of keys) {
    captured.component?.handleInput(key);
  }
  return promise;
}

/** The hotkeys of the decision step's option rows, in rendered order. */
function decisionOptionKeys(captured: { component?: CapturedComponent }) {
  return (captured.component?.render(80) ?? [])
    .map((line) => /^[ ▶] \((\w)\) /.exec(line)?.[1])
    .filter((key) => key !== undefined);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("presentInlinePermissionPrompt", () => {
  it("renders inline (not as an overlay) with the request facts and hotkey labels", () => {
    const { view, captured } = makeFakeView(true);
    void presentInlinePermissionPrompt(view, "Permission Required", ASK);
    expect(captured.options).toEqual({ overlay: false });
    const text = captured.component?.render(80).join("\n") ?? "";
    expect(text).toContain("tool : read");
    expect(text).toContain("path : /repo/secret.txt");
    expect(text).toContain("Yes");
    expect(text).toContain("No, provide reason");
    expect(text).toContain("y");
    expect(text).toContain("r");
  });

  it("renders the decision options in the model's display order", () => {
    const { view, captured } = makeFakeView(true);
    void presentInlinePermissionPrompt(view, "Permission Required", ASK);
    expect(decisionOptionKeys(captured)).toEqual(["y", "s", "n", "r"]);
  });

  it("clips every rendered line to the terminal width", () => {
    const { view, captured } = makeFakeView(true);
    void presentInlinePermissionPrompt(
      view,
      "Permission Required",
      makeAsk(`~/.pi/agent/sessions/${"a".repeat(300)}`),
    );
    const width = 40;
    const lines = captured.component?.render(width) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  describe("double-press to confirm (enabled)", () => {
    it("resolves approved on y, y", async () => {
      expect(await runPrompt(true, ["y", "y"])).toEqual({
        approved: true,
        state: "approved",
      });
    });

    it("does not resolve on a single armed press", async () => {
      const { view, captured } = makeFakeView(true);
      const promise = presentInlinePermissionPrompt(
        view,
        "Permission Required",
        ASK,
      );
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      captured.component?.handleInput("y");
      await Promise.resolve();
      expect(settled).toBe(false);
      const text = captured.component?.render(80).join("\n") ?? "";
      expect(text).toContain("Press y again to approve.");
    });

    it("resolves denied on n, n", async () => {
      expect(await runPrompt(true, ["n", "n"])).toEqual({
        approved: false,
        state: "denied",
      });
    });
  });

  describe("configured hotkey bindings", () => {
    const DIGITS = {
      approve: "1",
      approveSession: "2",
      approveSessionBoth: "3",
      deny: "4",
      denyWithReason: "5",
    } as const;
    /** Approve and deny traded, so a character alone cannot predict the outcome. */
    const SWAPPED = {
      ...DEFAULT_DIALOG_KEYS,
      approve: "n",
      deny: "y",
    } as const;

    it("renders each decision row with its configured binding", () => {
      const { view, captured } = makeFakeView(true, { dialogKeys: DIGITS });
      void presentInlinePermissionPrompt(view, "Permission Required", ASK);
      expect(decisionOptionKeys(captured)).toEqual(["1", "2", "4", "5"]);
    });

    it("commits the decision whose configured binding was pressed", async () => {
      const { view, captured } = makeFakeView(true, { dialogKeys: DIGITS });
      const promise = presentInlinePermissionPrompt(
        view,
        "Permission Required",
        ASK,
      );
      captured.component?.handleInput("4");
      captured.component?.handleInput("4");
      expect(await promise).toEqual({ approved: false, state: "denied" });
    });

    it("routes a keystroke by the action it is bound to, not by its letter", async () => {
      const { view, captured } = makeFakeView(false, { dialogKeys: SWAPPED });
      const promise = presentInlinePermissionPrompt(
        view,
        "Permission Required",
        ASK,
      );
      captured.component?.handleInput("y");
      expect(await promise).toEqual({ approved: false, state: "denied" });
    });
  });

  describe("terminal notification on open", () => {
    it("writes the configured channels once, before any keystroke", () => {
      const { view, terminalWrite } = makeFakeView(true, {
        promptNotifications: ["bell", "osc777"],
        notice: { title: "the notice title", body: "the notice body" },
      });
      void presentInlinePermissionPrompt(view, "Permission Required", ASK);

      // The view's notice, not the dialog title: the notice is composed from
      // labels only, so the path being decided never reaches the terminal's
      // notification history.
      expect(terminalWrite).toHaveBeenCalledExactlyOnceWith(
        "\x07\x1b]777;notify;the notice title;the notice body\x07",
      );
    });

    it("does not signal again when the dialog re-renders", () => {
      const { view, captured, terminalWrite } = makeFakeView(true, {
        promptNotifications: ["bell"],
      });
      void presentInlinePermissionPrompt(view, "Permission Required", ASK);

      captured.component?.handleInput("y"); // arms, and re-renders
      captured.component?.render(80);

      expect(terminalWrite).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when no channel is configured", () => {
      const { view, terminalWrite } = makeFakeView(true, {
        promptNotifications: [],
      });
      void presentInlinePermissionPrompt(view, "Permission Required", ASK);

      expect(terminalWrite).not.toHaveBeenCalled();
    });
  });

  describe("double-press to confirm (disabled)", () => {
    it("resolves approved on a single y", async () => {
      expect(await runPrompt(false, ["y"])).toEqual({
        approved: true,
        state: "approved",
      });
    });
  });

  describe("navigation and escape", () => {
    it("resolves the highlighted option on enter", async () => {
      // y -> s -> n, then enter
      expect(await runPrompt(true, [ARROW_DOWN, ARROW_DOWN, ENTER])).toEqual({
        approved: false,
        state: "denied",
      });
    });

    it("denies on escape at the decision step", async () => {
      expect(await runPrompt(true, [ESCAPE])).toEqual({
        approved: false,
        state: "denied",
      });
    });

    it("never decides on a stray paste at the decision step", async () => {
      const { view, captured } = makeFakeView(false);
      const promise = presentInlinePermissionPrompt(view, "Title", ASK);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      captured.component?.handleInput(paste("y"));
      captured.component?.handleInput(paste("some copied text"));
      await Promise.resolve();

      expect(settled).toBe(false);
      captured.component?.handleInput("n");
      expect(await promise).toEqual({ approved: false, state: "denied" });
    });
  });

  describe("deny with reason", () => {
    it("collects a typed reason and resolves denied_with_reason", async () => {
      const decision = await runPrompt(false, ["r", "n", "o", "p", "e", ENTER]);
      expect(decision).toEqual({
        approved: false,
        state: "denied_with_reason",
        denialReason: "nope",
      });
    });

    it("rejects an empty reason and shows an error, then accepts a real one", async () => {
      const { view, captured } = makeFakeView(false);
      const promise = presentInlinePermissionPrompt(view, "T", ASK);
      captured.component?.handleInput("r"); // opens reason step
      captured.component?.handleInput(ENTER); // empty submit -> rejected
      const text = captured.component?.render(80).join("\n") ?? "";
      expect(text).toContain("A reason is required.");
      captured.component?.handleInput("x");
      captured.component?.handleInput(ENTER);
      expect(await promise).toEqual({
        approved: false,
        state: "denied_with_reason",
        denialReason: "x",
      });
    });

    it("supports backspace while editing the reason", async () => {
      const decision = await runPrompt(false, [
        "r",
        "a",
        "b",
        "\u007f", // backspace removes "b"
        ENTER,
      ]);
      expect(decision).toEqual({
        approved: false,
        state: "denied_with_reason",
        denialReason: "a",
      });
    });

    it("accepts pasted text into the reason", async () => {
      expect(
        await runPrompt(false, ["r", paste("pasted text"), ENTER]),
      ).toEqual({
        approved: false,
        state: "denied_with_reason",
        denialReason: "pasted text",
      });
    });

    it("flattens a multi-line paste into one readable line", async () => {
      expect(
        await runPrompt(false, [
          "r",
          paste("denied because it touches\n~/.ssh"),
          ENTER,
        ]),
      ).toEqual({
        approved: false,
        state: "denied_with_reason",
        denialReason: "denied because it touches ~/.ssh",
      });
    });

    it("keeps a pasted reason on one row, however long it is", () => {
      const { view, captured } = makeFakeView(false);
      void presentInlinePermissionPrompt(view, "Title", ASK);
      captured.component?.handleInput("r");
      const before = captured.component?.render(40) ?? [];

      // "q" appears nowhere else in this render; "x" would match `secret.txt`.
      captured.component?.handleInput(paste("q".repeat(500)));
      const after = captured.component?.render(40) ?? [];

      expect(after).toHaveLength(before.length);
      expect(after.join("\n")).toContain("qqq");
      for (const line of after) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(40);
      }
    });

    it("drops the expand key instead of typing it into the reason", async () => {
      const { view, captured, setToolsExpanded } = makeFakeView(false);
      const promise = presentInlinePermissionPrompt(view, "Title", ASK);

      captured.component?.handleInput("r");
      captured.component?.handleInput("a");
      captured.component?.handleInput(CTRL_O);
      captured.component?.handleInput(ENTER);

      expect(await promise).toEqual({
        approved: false,
        state: "denied_with_reason",
        denialReason: "a",
      });
      expect(setToolsExpanded).not.toHaveBeenCalled();
    });

    it("navigates back to the decision step on escape from the reason step", async () => {
      // r opens reason, esc returns to decision, then n deny
      expect(await runPrompt(false, ["r", ESCAPE, "n"])).toEqual({
        approved: false,
        state: "denied",
      });
    });
  });

  describe("requestPermissionDecision dispatch", () => {
    it("renders the inline dialog in TUI mode", async () => {
      const { view, captured } = makeFakeView(true);
      const promise = requestPermissionDecision(view, "Title", ASK);
      expect(captured.component).toBeDefined();
      captured.component?.handleInput("y");
      captured.component?.handleInput("y");
      expect(await promise).toEqual({
        approved: true,
        state: "approved",
        decidedBy: { kind: "user", via: "dialog" },
      });
    });

    it("bounds a pathological forwarded ask instead of filling the viewport", () => {
      const { view, captured } = makeFakeView(true);
      const body = Array.from(
        { length: 200 },
        () => "- a finding line about some module in the codebase",
      ).join("\n");
      const command = `@'\n${body}\n'@ | Out-File -FilePath report.md`;

      void presentInlinePermissionPrompt(
        view,
        "Permission Required (Subagent)",
        makePromptPayload({
          kind: "forwarded",
          request: {
            ...makePromptPayload().request,
            requester: {
              agentName: "scout",
              forwarded: true,
              sessionId: "abc123",
            },
            surface: "bash",
            toolName: null,
            value: command,
            matchedPattern: null,
          },
          evidence: [{ label: "requested", text: command, detail: null }],
        }),
      );
      const lines = captured.component?.render(120) ?? [];

      // The same ask renders 205 rows through the unbounded flat message.
      expect(lines.length).toBeLessThanOrEqual(
        DEFAULT_RENDER_BUDGET.maxRows + DECISION_CHROME_ROWS,
      );
      expect(lines).toContain("subagent  : scout · session abc123");
    });

    it("falls back to the select flow outside TUI mode", async () => {
      const custom = vi.fn();
      const select = vi.fn().mockResolvedValue("Yes");
      const view = makeView("rpc", {
        select,
        input: vi.fn(),
        custom,
      });

      const decision = await requestPermissionDecision(view, "Title", ASK);

      expect(custom).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledWith(
        "Title\ntool : read\npath : /repo/secret.txt",
        expect.any(Array),
        { signal: undefined },
      );
      expect(decision).toEqual({
        approved: true,
        state: "approved",
        decidedBy: { kind: "user", via: "select" },
      });
    });

    it("attributes a denial to the surface the human answered on", async () => {
      const select = vi.fn().mockResolvedValue("No");
      const view = makeView("rpc", {
        select,
        input: vi.fn(),
        custom: vi.fn(),
      });

      const decision = await requestPermissionDecision(view, "Title", ASK);

      // The denial is the human's, and which surface they used is what
      // separates "the operator declined" from "a prompt they never saw".
      expect(decision).toEqual({
        approved: false,
        state: "denied",
        decidedBy: { kind: "user", via: "select" },
      });
    });
  });

  describe("answer window", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const UNANSWERED = {
      approved: false,
      state: "denied",
      confirmationUnavailable: true,
      decidedBy: { kind: "unanswered", timeoutMs: 60_000 },
    };

    /** Track whether a promise has settled, without awaiting it. */
    function settlement<T>(promise: Promise<T>) {
      const state = { settled: false };
      void promise.then(() => {
        state.settled = true;
      });
      return state;
    }

    it("dismisses an inline prompt nobody answered and denies it as unanswered", async () => {
      const { view, captured } = makeFakeView(true, {
        promptTimeoutMs: 60_000,
      });
      const promise = requestPermissionDecision(view, "Title", ASK);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(await promise).toStrictEqual(UNANSWERED);
      expect(captured.done).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it("keeps a human answer given inside the window, and never dismisses afterwards", async () => {
      const { view, captured } = makeFakeView(true, {
        promptTimeoutMs: 60_000,
      });
      const promise = requestPermissionDecision(view, "Title", ASK);

      await vi.advanceTimersByTimeAsync(30_000);
      captured.component?.handleInput("y");
      captured.component?.handleInput("y");
      const decision = await promise;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(decision).toEqual({
        approved: true,
        state: "approved",
        decidedBy: { kind: "user", via: "dialog" },
      });
      expect(captured.done).toHaveBeenCalledOnce();
    });

    it("stops the clock once the human presses a key, then waits for the answer", async () => {
      const { view, captured } = makeFakeView(true, {
        promptTimeoutMs: 60_000,
      });
      const promise = requestPermissionDecision(view, "Title", ASK);
      const state = settlement(promise);

      await vi.advanceTimersByTimeAsync(30_000);
      captured.component?.handleInput(ARROW_DOWN);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(state.settled).toBe(false);

      captured.component?.handleInput("y");
      captured.component?.handleInput("y");
      expect(await promise).toEqual({
        approved: true,
        state: "approved",
        decidedBy: { kind: "user", via: "dialog" },
      });
    });

    it("names the window in the hint while the clock runs", () => {
      const { view, captured } = makeFakeView(true, {
        promptTimeoutMs: 60_000,
      });
      void requestPermissionDecision(view, "Title", ASK);

      expect(captured.component?.render(200).at(-1)).toBe(
        "↑/↓ move · enter confirm · esc deny · press a letter, then again to confirm · unanswered, denies in 60s",
      );
    });

    it("drops the window from the hint once the human engages", () => {
      const { view, captured } = makeFakeView(true, {
        promptTimeoutMs: 60_000,
      });
      void requestPermissionDecision(view, "Title", ASK);

      captured.component?.handleInput(ARROW_DOWN);

      expect(captured.component?.render(200).at(-1)).toBe(
        "↑/↓ move · enter confirm · esc deny · press a letter, then again to confirm",
      );
    });

    it("names no window in the hint when none is configured", () => {
      const { view, captured } = makeFakeView(true);
      void requestPermissionDecision(view, "Title", ASK);

      expect(captured.component?.render(200).at(-1)).toBe(
        "↑/↓ move · enter confirm · esc deny · press a letter, then again to confirm",
      );
    });

    it("leaves a prompt open indefinitely when no window is configured", async () => {
      const { view, captured } = makeFakeView(true);
      const state = settlement(requestPermissionDecision(view, "Title", ASK));

      await vi.advanceTimersByTimeAsync(600_000);

      expect(state.settled).toBe(false);
      expect(captured.done).not.toHaveBeenCalled();
    });

    it("dismisses a fallback prompt nobody answered and denies it as unanswered", async () => {
      const select = vi.fn(
        (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
          new Promise<string | undefined>((resolve) => {
            opts?.signal?.addEventListener(
              "abort",
              () => {
                resolve(undefined);
              },
              { once: true },
            );
          }),
      );
      const view = makeView(
        "rpc",
        { select, input: vi.fn(), custom: vi.fn() },
        { promptTimeoutMs: 60_000 },
      );
      const promise = requestPermissionDecision(view, "Title", ASK);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(await promise).toStrictEqual(UNANSWERED);
    });

    it("still attributes a fallback cancel inside the window to the human", async () => {
      const select = vi.fn().mockResolvedValue(undefined);
      const view = makeView(
        "rpc",
        { select, input: vi.fn(), custom: vi.fn() },
        { promptTimeoutMs: 60_000 },
      );

      expect(await requestPermissionDecision(view, "Title", ASK)).toEqual({
        approved: false,
        state: "denied",
        decidedBy: { kind: "user", via: "select" },
      });
    });
  });

  describe("prompt-answer seam", () => {
    const answererApproval: PermissionPromptDecision = {
      approved: true,
      state: "approved",
      decidedBy: { kind: "answerer", name: "pi-hail" },
    };
    const answererDenial: PermissionPromptDecision = {
      approved: false,
      state: "denied",
      decidedBy: { kind: "answerer", name: "pi-hail" },
    };

    /** Capture the control the dispatcher hands the seam. */
    function captureSeam() {
      const seam: { control?: RemotePromptControl } = {};
      return {
        seam,
        onPrompt: (control: RemotePromptControl) => {
          seam.control = control;
        },
      };
    }

    it("settles the TUI dialog remotely and dismisses the dialog", async () => {
      const { view, captured } = makeFakeView(true);
      const { seam, onPrompt } = captureSeam();
      const promise = requestPermissionDecision(view, "Title", ASK, undefined, {
        onPrompt,
      });

      expect(captured.component).toBeDefined();
      seam.control?.settleRemotely(answererApproval);

      expect(await promise).toEqual(answererApproval);
      // The inline dialog is dismissed: its `done` ran so `ui.custom` cannot strand.
      expect(captured.done).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it("offers the seam its control only once the dialog is on screen", () => {
      const { view, captured } = makeFakeView(true);
      let mountedWhenOffered: boolean | undefined;
      void requestPermissionDecision(view, "Title", ASK, undefined, {
        onPrompt: () => {
          mountedWhenOffered = captured.component !== undefined;
        },
      });

      expect(mountedWhenOffered).toBe(true);
    });

    it("aborts the select fallback on a remote answer and resolves with it", async () => {
      let capturedOpts: { signal?: AbortSignal } | undefined;
      const select = vi.fn(
        (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
          new Promise<string | undefined>((resolve) => {
            capturedOpts = opts;
            opts?.signal?.addEventListener(
              "abort",
              () => {
                resolve(undefined);
              },
              { once: true },
            );
          }),
      );
      const view = makeView("rpc", { select, input: vi.fn(), custom: vi.fn() });
      const { seam, onPrompt } = captureSeam();
      const promise = requestPermissionDecision(view, "Title", ASK, undefined, {
        onPrompt,
      });

      seam.control?.settleRemotely(answererDenial);

      expect(await promise).toEqual(answererDenial);
      expect(capturedOpts?.signal?.aborted).toBe(true);
    });

    it("resolves with the remote answer even when the host ignores the abort", async () => {
      const select = vi.fn(
        () => new Promise<string | undefined>(() => undefined),
      );
      const view = makeView("rpc", { select, input: vi.fn(), custom: vi.fn() });
      const { seam, onPrompt } = captureSeam();
      const promise = requestPermissionDecision(view, "Title", ASK, undefined, {
        onPrompt,
      });

      seam.control?.settleRemotely(answererDenial);

      expect(await promise).toEqual(answererDenial);
    });

    it("resolves with the remote answer when the aborted fallback rejects", async () => {
      const select = vi.fn(
        (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
          new Promise<string | undefined>((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      );
      const view = makeView("rpc", { select, input: vi.fn(), custom: vi.fn() });
      const { seam, onPrompt } = captureSeam();
      const promise = requestPermissionDecision(view, "Title", ASK, undefined, {
        onPrompt,
      });

      seam.control?.settleRemotely(answererDenial);

      expect(await promise).toEqual(answererDenial);
    });

    describe("first settle wins", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      type Step =
        | "human:yes"
        | "human:no"
        | "human:cancel"
        | "phone:allow"
        | "phone:deny"
        | "timeout"
        /** One microtask. */
        | "tick"
        /** Long enough for every pending continuation to run. */
        | "later";

      const TIMEOUT_MS = 60_000;
      const humanYes = (via: string) => ({
        approved: true,
        state: "approved",
        decidedBy: { kind: "user", via },
      });
      const humanNo = (via: string) => ({
        approved: false,
        state: "denied",
        decidedBy: { kind: "user", via },
      });
      const unanswered = {
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
        decidedBy: { kind: "unanswered", timeoutMs: TIMEOUT_MS },
      };

      // Each row: the surface, the steps in order, and the decision. The first
      // source to settle wins with its own verdict; nothing later changes it.
      const rows: Array<{
        name: string;
        surface: "dialog" | "select";
        steps: Step[];
        expected: unknown;
      }> = [
        {
          name: "dialog: human yes, then phone allow",
          surface: "dialog",
          steps: ["human:yes", "phone:allow"],
          expected: humanYes("dialog"),
        },
        {
          name: "dialog: human cancel, then phone allow",
          surface: "dialog",
          steps: ["human:cancel", "phone:allow"],
          expected: humanNo("dialog"),
        },
        {
          name: "dialog: phone allow, then human no",
          surface: "dialog",
          steps: ["phone:allow", "human:no"],
          expected: answererApproval,
        },
        {
          name: "dialog: timeout, then phone allow",
          surface: "dialog",
          steps: ["timeout", "phone:allow"],
          expected: unanswered,
        },
        {
          name: "dialog: phone deny, then timeout",
          surface: "dialog",
          steps: ["phone:deny", "timeout"],
          expected: answererDenial,
        },
        {
          name: "review 1: dialog human no, phone allow one microtask later",
          surface: "dialog",
          steps: ["human:no", "tick", "phone:allow"],
          expected: humanNo("dialog"),
        },
        {
          name: "select: human yes, then phone allow",
          surface: "select",
          steps: ["human:yes", "later", "phone:allow"],
          expected: humanYes("select"),
        },
        {
          name: "select: phone deny, then human yes",
          surface: "select",
          steps: ["phone:deny", "human:yes"],
          expected: answererDenial,
        },
        {
          name: "select: timeout, then phone allow",
          surface: "select",
          steps: ["timeout", "phone:allow"],
          expected: unanswered,
        },
        {
          name: "select: phone allow, then timeout",
          surface: "select",
          steps: ["phone:allow", "timeout"],
          expected: answererApproval,
        },
        {
          name: "review 2: select human no, phone allow one microtask later",
          surface: "select",
          steps: ["human:no", "tick", "phone:allow"],
          expected: humanNo("select"),
        },
        {
          name: "review 3: select human cancel, phone allow one microtask later",
          surface: "select",
          steps: ["human:cancel", "tick", "phone:allow"],
          expected: humanNo("select"),
        },
        // Phone called settle first; the real host can't produce this order
        // (rpc-mode.js createDialogPromise resolves from a stdin message).
        {
          name: "review 3 repro: select human cancel, phone allow same tick",
          surface: "select",
          steps: ["human:cancel", "phone:allow"],
          expected: answererApproval,
        },
        {
          name: "fix 2: select human no, phone allow same tick",
          surface: "select",
          steps: ["human:no", "phone:allow"],
          expected: answererApproval,
        },
      ];

      /** A fallback whose `select` the test answers, and which a dismissal resolves `undefined`. */
      function makeFallback() {
        const host: { answer?: (choice: string | undefined) => void } = {};
        const select = vi.fn(
          (
            _title: string,
            _options: string[],
            opts?: { signal?: AbortSignal },
          ) =>
            new Promise<string | undefined>((resolve) => {
              host.answer = resolve;
              opts?.signal?.addEventListener("abort", () => {
                resolve(undefined);
              });
            }),
        );
        const view = makeView(
          "rpc",
          { select, input: vi.fn(), custom: vi.fn() },
          { promptTimeoutMs: TIMEOUT_MS },
        );
        const keys = { "human:yes": "Yes", "human:no": "No" } as const;
        return {
          view,
          human: (step: "human:yes" | "human:no" | "human:cancel") => {
            host.answer?.(step === "human:cancel" ? undefined : keys[step]);
          },
        };
      }

      function makeDialog() {
        const { view, captured } = makeFakeView(true, {
          promptTimeoutMs: TIMEOUT_MS,
        });
        const keys = { "human:yes": "y", "human:no": "n" } as const;
        return {
          view,
          human: (step: "human:yes" | "human:no" | "human:cancel") => {
            if (step === "human:cancel") {
              captured.component?.handleInput("\u001b");
              return;
            }
            captured.component?.handleInput(keys[step]);
            captured.component?.handleInput(keys[step]);
          },
        };
      }

      it.each(rows)("$name", async ({ surface, steps, expected }) => {
        const { view, human } =
          surface === "dialog" ? makeDialog() : makeFallback();
        const { seam, onPrompt } = captureSeam();
        const promise = requestPermissionDecision(
          view,
          "Title",
          ASK,
          undefined,
          {
            onPrompt,
          },
        );

        for (const step of steps) {
          if (step === "tick") {
            await Promise.resolve();
          } else if (step === "later") {
            await vi.advanceTimersByTimeAsync(0);
          } else if (step === "timeout") {
            await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
          } else if (step === "phone:allow") {
            seam.control?.settleRemotely(answererApproval);
          } else if (step === "phone:deny") {
            seam.control?.settleRemotely(answererDenial);
          } else {
            human(step);
          }
        }

        expect(await promise).toStrictEqual(expected);
      });

      it("tells the phone whether its settle won", () => {
        const won = captureSeam();
        void requestPermissionDecision(
          makeDialog().view,
          "Title",
          ASK,
          undefined,
          {
            onPrompt: won.onPrompt,
          },
        );
        expect(won.seam.control?.settleRemotely(answererApproval)).toBe(true);
        expect(won.seam.control?.settleRemotely(answererDenial)).toBe(false);

        const lost = captureSeam();
        const dialog = makeDialog();
        void requestPermissionDecision(dialog.view, "Title", ASK, undefined, {
          onPrompt: lost.onPrompt,
        });
        dialog.human("human:no");
        expect(lost.seam.control?.settleRemotely(answererApproval)).toBe(false);
      });
    });
  });

  describe("both-directions session grant (#813)", () => {
    const sessionWidth = {
      label: 'Yes, allow reads and writes to "/tmp/*" for this session',
    };

    it("renders the width row after the session row when the ask is widenable", () => {
      const { view, captured } = makeFakeView(true);
      void presentInlinePermissionPrompt(view, "Permission Required", ASK, {
        sessionLabel: 'Yes, allow writes to "/tmp/*" for this session',
        sessionWidth,
      });
      expect(decisionOptionKeys(captured)).toEqual(["y", "s", "b", "n", "r"]);
      expect(captured.component?.render(120).join("\n")).toContain(
        sessionWidth.label,
      );
    });

    it("renders no width row for an ask that is not widenable", () => {
      const { view, captured } = makeFakeView(true);
      void presentInlinePermissionPrompt(view, "Permission Required", ASK);
      expect(decisionOptionKeys(captured)).toEqual(["y", "s", "n", "r"]);
    });

    it("commits the family width on the b hotkey", async () => {
      expect(await runPrompt(false, ["b"], { sessionWidth })).toEqual({
        approved: true,
        state: "approved_for_session",
        sessionGrantWidth: "family",
      });
    });

    it("leaves the s hotkey at the proven width", async () => {
      expect(await runPrompt(false, ["s"], { sessionWidth })).toEqual({
        approved: true,
        state: "approved_for_session",
      });
    });
  });

  describe("approve-for-session scope (forwarded asks)", () => {
    const options: RequestPermissionOptions = {
      sessionScope: {
        subagentLabel: "This subagent only",
        servingSessionLabel: "The whole session",
      },
    };

    it("commits the subagent scope by default", async () => {
      expect(await runPrompt(false, ["s", ENTER], options)).toEqual({
        approved: true,
        state: "approved_for_session",
      });
    });

    it("commits the serving-session scope when the second option is chosen", async () => {
      expect(await runPrompt(false, ["s", ARROW_DOWN, ENTER], options)).toEqual(
        { approved: true, state: "approved_for_serving_session" },
      );
    });
  });

  describe("tool expansion", () => {
    const scopeOptions: RequestPermissionOptions = {
      sessionScope: {
        subagentLabel: "This subagent only",
        servingSessionLabel: "The whole session",
      },
    };

    it("toggles tool expansion without settling the decision", async () => {
      const { view, captured, getToolsExpanded, setToolsExpanded } =
        makeFakeView(true);
      const promise = presentInlinePermissionPrompt(view, "Title", ASK);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      captured.component?.handleInput(CTRL_O);
      await Promise.resolve();
      expect(setToolsExpanded).toHaveBeenNthCalledWith(1, true);
      expect(settled).toBe(false);

      captured.component?.handleInput(CTRL_O);
      await Promise.resolve();
      expect(setToolsExpanded).toHaveBeenNthCalledWith(2, false);
      expect(settled).toBe(false);
      expect(getToolsExpanded).toHaveBeenCalledTimes(2);

      captured.component?.handleInput("y");
      captured.component?.handleInput("y");
      // Unattributed: the inline component states the outcome, and the
      // dispatcher above it names the surface the human answered on.
      expect(await promise).toEqual({ approved: true, state: "approved" });
    });

    it("toggles during the scope step without committing the grant", async () => {
      const { view, captured, setToolsExpanded } = makeFakeView(false);
      const promise = presentInlinePermissionPrompt(
        view,
        "Title",
        ASK,
        scopeOptions,
      );

      captured.component?.handleInput("s"); // decision -> scope
      captured.component?.handleInput(CTRL_O);
      expect(setToolsExpanded).toHaveBeenNthCalledWith(1, true);

      captured.component?.handleInput(ENTER);
      expect(await promise).toEqual({
        approved: true,
        state: "approved_for_session",
      });
    });

    it("expands the dialog to the complete request and back", () => {
      const { view, captured, setToolsExpanded } = makeFakeView(true, {
        budget: { maxRows: 24, fieldMaxWidth: 10 },
      });
      void presentInlinePermissionPrompt(
        view,
        "Title",
        makeAsk("/repo/a/very/long/secret.txt"),
      );
      const bounded = captured.component?.render(120) ?? [];
      expect(bounded).toContain("path : /repo/a/ve…");
      expect(bounded.at(-1)).toContain("ctrl+o full request");

      captured.component?.handleInput(CTRL_O);
      const expanded = captured.component?.render(120) ?? [];
      expect(expanded).toContain("path : /repo/a/very/long/secret.txt");
      expect(expanded.at(-1)).toContain("ctrl+o collapse");
      // The host's own tool expansion still follows the same keystroke (#642).
      expect(setToolsExpanded).toHaveBeenCalledWith(true);

      captured.component?.handleInput(CTRL_O);
      expect(captured.component?.render(120)).toEqual(bounded);
    });

    it("advertises the affordance only when the render left something out", () => {
      const { view, captured } = makeFakeView(true);
      void presentInlinePermissionPrompt(view, "Title", ASK);

      expect(captured.component?.render(120).at(-1)).not.toContain("ctrl+o");
    });

    it("does not intercept the expand key while a denial reason is typed", async () => {
      // Bound to a printable key on purpose: the default Ctrl+O is a control
      // character the reason editor rejects anyway, so it cannot discriminate.
      const { view, captured, setToolsExpanded } = makeFakeView(false, {
        expandKey: "e",
      });
      const promise = presentInlinePermissionPrompt(view, "Title", ASK);

      captured.component?.handleInput("r"); // decision -> reason
      captured.component?.handleInput("e"); // typed literally, not an app action
      captured.component?.handleInput(ENTER);

      expect(await promise).toEqual({
        approved: false,
        state: "denied_with_reason",
        denialReason: "e",
      });
      expect(setToolsExpanded).not.toHaveBeenCalled();
    });
  });
});
