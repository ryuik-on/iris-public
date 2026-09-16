import { execFile } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * How long it would take to get there, from here, now.
 *
 * The band could already say "明日の予定は 15:30 から「ガウス」" and stop, which
 * is a diary entry read aloud. The question a person actually has at 14:40 is
 * whether to leave, and that depends on traffic — which is not in the calendar
 * and not on this machine.
 *
 * `移動時間を取得` is, and it is the only route: MapKit has no command-line
 * face, and routing against a third-party service would mean sending the
 * user's whereabouts to one. This asks Apple's own action, on the user's own
 * machine, and the coordinates never leave it.
 *
 * The destination is passed in rather than written into the shortcut, so one
 * shortcut serves every place and the addresses stay here, in a file that is
 * not in the repository.
 */

export interface Place {
  /** Matched against the event title, case-insensitively, as a substring. */
  match: string;
  address: string;
}

export interface TravelRead {
  /** Whatever the shortcut said, verbatim. */
  text: string | null;
  /** Where it was measured to, so a wrong answer is traceable to a wrong map. */
  to: string | null;
  reason: string | null;
  at: string;
}

const SHORTCUT = process.env.IRIS_TRAVEL_SHORTCUT?.trim() || '移動時間';

/**
 * The calendar says 「ガウス」. Maps needs an address.
 *
 * A file rather than a constant, and an ignored file rather than a tracked
 * one. These are the places one person goes on a schedule, which is not
 * something to publish with the source, and it is also the part most likely to
 * change without any code changing with it.
 */
export function readPlaces(root: string): { places: Place[]; reason: string | null } {
  const path = join(root, '.iris', 'places.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { places: [], reason: `${path} がありません。` };
  }
  try {
    const parsed = JSON.parse(raw);
    const places = Array.isArray(parsed?.places) ? parsed.places : [];
    const usable = places.filter(
      (p: any) => typeof p?.match === 'string' && p.match && typeof p?.address === 'string' && p.address
    );
    // Counted, not silently dropped: a typo in one entry is the difference
    // between a place that is known and one that quietly is not.
    const skipped = places.length - usable.length;
    return {
      places: usable,
      reason: skipped > 0 ? `${skipped}件は match/address が欠けているため使えません。` : null,
    };
  } catch {
    return { places: [], reason: `${path} を読めません（JSON が壊れています）。` };
  }
}

/** The first place whose `match` appears in the title, or nothing. */
export function resolveAddress(title: string, places: Place[]): Place | null {
  const haystack = title.toLowerCase();
  return places.find((p) => haystack.includes(p.match.toLowerCase())) ?? null;
}

/**
 * Nothing here measures anything.
 *
 * It did, through `移動時間を取得`, and that action returns nothing on this
 * Mac. Measured 2026-08-22: 現在地 to a geocodable address, 現在地 to 現在地,
 * by car and on foot — every one produced an empty file and an empty result
 * box in the editor, with no error and no permission prompt, while the
 * weather shortcut built the same way worked every time. The action is listed
 * on macOS and does not do anything.
 *
 * So the route is computed with MapKit inside the menu bar app, which is the
 * only part of IRIS that can hold a location permission. This side answers
 * the question that needs the calendar and the place map — where is the next
 * appointment — and stops there.
 */
