/**
 * The Lite page budget (#1918).
 *
 * Lite syncs up to 100 distinct pages per vault, for the life of the vault. Past
 * that, genuinely new pages are refused and the run reports honestly.
 *
 * Three rules, all deliberate:
 *
 * - **Every note counts, database rows included.** A row in a Notion database is
 *   a page in Notion's own model and lands in the vault as a note exactly like a
 *   standalone page. 1.0.5 shipped with rows exempt, which meant one database
 *   could carry an entire workspace past the cap. Containers are still exempt -
 *   a database is a folder, a linked view is bookkeeping, neither is a note.
 * - **Existing vaults are grandfathered.** A page already in `sync_records`
 *   keeps syncing forever. Only pages that are new AND past the cap are refused,
 *   so no working vault breaks on a version update.
 * - **Client-side only.** Counted locally with no server round trip, so the
 *   network disclosure stays true.
 *
 * Not an anti-piracy measure. Lite is MIT (#1970) and anyone may delete this
 * file and rebuild; that is a licence we chose on purpose. This exists to keep
 * Lite a discovery edition, so do not add enforcement, obfuscation or
 * attestation to it - all three would be theatre, and the last two would break
 * the network-purity promise.
 *
 * @module
 */

/** Notes a vault may sync on Lite. Every note counts, database rows included. */
export const LITE_PAGE_LIMIT = 100;

export class PageBudget {
  private used: number;
  /** Pages claimed during THIS run, so a retry of the same page is idempotent. */
  private readonly claimedThisRun = new Set<string>();

  /**
   * @param existingPageCount - distinct `item_type = 'page'` rows already in
   *   sync_records for this workspace. These are grandfathered: they consume
   *   budget, but they are never refused.
   */
  constructor(
    private readonly limit: number,
    existingPageCount: number,
  ) {
    this.used = existingPageCount;
  }

  /**
   * Ask for permission to write a page, and take the budget if granted.
   *
   * MUST stay synchronous. The check and the increment have to happen in one
   * uninterrupted step: the apply phase runs up to 20 pages concurrently
   * (a fixed 5, see pull-diff-phase), and an `await` between reading `used` and
   * bumping it
   * would let every in-flight page read the same pre-increment value and sail
   * past the cap together. Single-threaded JS makes this safe only for as long
   * as nothing suspends in the middle, so do not make this async.
   *
   * @param isAlreadyTracked - true when the page already has a sync record.
   *   Grandfathered pages are always allowed and never re-charged.
   */
  claim(notionId: string, isAlreadyTracked: boolean): boolean {
    if (isAlreadyTracked) return true;
    if (this.claimedThisRun.has(notionId)) return true;
    if (this.used >= this.limit) return false;
    this.used++;
    this.claimedThisRun.add(notionId);
    return true;
  }

  /** Pages claimed in this run. The "synced" half of an honest truncation report. */
  get claimedCount(): number {
    return this.claimedThisRun.size;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get isFull(): boolean {
    return this.used >= this.limit;
  }
}
