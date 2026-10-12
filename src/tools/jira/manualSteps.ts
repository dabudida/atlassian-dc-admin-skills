/**
 * Manual (UI-only) changes with explicit steps.
 *
 * Some Jira DC administration has no REST write at all (creating priorities and resolutions,
 * editing notification schemes and issue security levels): only admin forms behind websudo, which a
 * personal access token cannot pass. Such a change is reported as a plan item with
 * `request.method: "MANUAL"`, the admin page and the steps to take there. Nothing is sent; executing
 * it is refused, and re-running the tool afterwards verifies the result where Jira lets us read it.
 */

import type { AtlassianClient, Params } from "../../client.js";
import { UnsupportedError } from "../../errors.js";

export const WEBSUDO_ONLY = "Jira DC offers no REST write for this; only an admin form behind websudo re-authentication, which a personal access token cannot pass";

export interface ManualStep {
  summary: string;
  reason: string;
  /** Admin page path relative to the base URL, with its query parameters. */
  page: string;
  params?: Params;
  steps: string[];
  identity: Record<string, unknown>;
  state: unknown;
  /** True when no REST read can confirm the result, so a re-run cannot verify it. */
  unverifiable?: boolean;
  extra?: Record<string, unknown>;
}

export function manualStep(client: AtlassianClient, args: { dry_run?: boolean }, m: ManualStep) {
  const editUrl = client.url(m.page, m.params);
  if (args.dry_run === false) {
    throw new UnsupportedError(`${m.summary} cannot be done through the API: ${m.reason}. At ${editUrl}: ${m.steps.join("; ")}`, { editUrl, steps: m.steps });
  }
  return {
    dry_run: true,
    product: client.product,
    summary: `${m.summary} (in the Jira UI)`,
    request: { method: "MANUAL", url: editUrl, body: { steps: m.steps } },
    manual: { reason: m.reason, editUrl },
    ...m.extra,
    identity: m.identity,
    state: m.state,
    note: m.unverifiable
      ? "Nothing is sent. Make the change at the link; Jira has no REST read of the result, so check it in the UI."
      : "Nothing is sent. Make the change at the link, then run the tool again to verify.",
  };
}
