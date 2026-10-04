/**
 * The opt-in guarded, unsupported follow import (group 12).
 *
 * Some platforms publish no followed-channel API. An importer may use their
 * undocumented website endpoint instead, but only as an explicit, reversible
 * extra: it can break at any time, so it lives in its own module and is guarded by
 * a user opt-in rather than being wired into the detection path.
 */

export type UnofficialImportReason =
  | 'not_enabled'
  | 'unavailable'
  | 'unrecognized'
  | 'permission_missing';

/**
 * Every way an unofficial import can fail, as one type.
 *
 * A caller that receives this can tell the user the import is unavailable without
 * having to guess whether it saw an empty follow list, a network error or a
 * response it did not recognise.
 */
export class UnofficialImportUnavailableError extends Error {
  constructor(
    readonly reason: UnofficialImportReason,
    message: string,
  ) {
    super(message);
    this.name = 'UnofficialImportUnavailableError';
  }
}

export const UNAVAILABLE_MESSAGE =
  'The unofficial follow import is unavailable. Tracked channels were not changed.';

/** The user-facing text for a failure, chosen by reason. */
export const messageForUnofficialImport = (reason: UnofficialImportReason): string => {
  switch (reason) {
    case 'not_enabled':
      return 'The unofficial follow import is turned off';
    case 'permission_missing':
      return 'The unofficial follow import needs Kick access before it can run';
    default:
      return UNAVAILABLE_MESSAGE;
  }
};
