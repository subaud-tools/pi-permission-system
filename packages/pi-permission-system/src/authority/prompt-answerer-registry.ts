/**
 * The remote verdict a prompt answerer settles a showing prompt with, and the
 * answerer's registered name — the name that lands on the decision's
 * `{ kind: "answerer", name }` provenance. Returns whether the answer won the
 * prompt's settlement latch.
 */
export type PromptSettle = (
  verdict: "allow" | "deny",
  answererName: string,
) => boolean;

/**
 * The prompts one session node currently has on screen, keyed by request id,
 * so a remote answerer (the phone, via `registerPromptAnswerer`) can settle the
 * exact prompt the permission system already showed.
 *
 * One instance per factory invocation, like {@link AskDialogQueue}: it is
 * rebuilt with the session rather than outliving it, and only the node's own
 * `LocalUserAuthorizer` registers into it. A prompt is registered once it is
 * actually on screen (right where `permissions:ui_prompt` is emitted) and
 * unregistered on every resolution path, so a queued-not-yet-shown ask has no
 * entry and cannot be answered remotely (§4 of the design).
 *
 * {@link settle} reports the prompt's latch result — `false` for an answer
 * that lost to an earlier one — and `false` for an unknown id or a disposed
 * entry: the `boolean` the public `PromptAnswerer.answer` returns.
 */
export class OpenPromptRegistry {
  private readonly open = new Map<string, PromptSettle>();

  /**
   * Record that `requestId` is showing, returning a disposer that removes it.
   *
   * The disposer is compare-and-delete: it removes the entry only when it is
   * still the one this call registered, so a stale disposer cannot evict a
   * later registration that reused the id.
   */
  register(requestId: string, settle: PromptSettle): () => void {
    // A fresh closure per registration, so the identity check below holds
    // even if one callback is registered twice.
    const entry: PromptSettle = (verdict, name) => settle(verdict, name);
    this.open.set(requestId, entry);
    return () => {
      if (this.open.get(requestId) === entry) {
        this.open.delete(requestId);
      }
    };
  }

  /**
   * Settle the showing prompt `requestId` with a remote verdict.
   *
   * Returns `false` when the prompt was already settled, or when no prompt
   * has that id (never shown, or disposed), so the caller can report the
   * answer as a no-op.
   */
  settle(
    requestId: string,
    verdict: "allow" | "deny",
    answererName: string,
  ): boolean {
    return this.open.get(requestId)?.(verdict, answererName) ?? false;
  }
}
