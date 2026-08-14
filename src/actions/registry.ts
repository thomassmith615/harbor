/**
 * Action registry.
 *
 * Same shape as the connector registry: one line to add a capability, and
 * nothing else in Harbor learns its name. The scopes declared here are unioned
 * into what `harbor auth` requests, so adding a write action makes the
 * consequent permission increase visible in one place.
 */
import { CALENDAR_ACTIONS } from "./calendar.js";
import type { ActionSpec } from "./types.js";

export const ACTIONS: readonly ActionSpec[] = [...CALENDAR_ACTIONS];

export function actionById(id: string): ActionSpec | null {
  return ACTIONS.find((action) => action.id === id) ?? null;
}

export function actionScopes(): readonly string[] {
  const scopes = new Set<string>();

  for (const action of ACTIONS) {
    for (const scope of action.scopes) {
      scopes.add(scope);
    }
  }

  return [...scopes];
}
